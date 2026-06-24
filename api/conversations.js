// ─────────────────────────────────────────────────────────────────────────
// /api/conversations — conversation logs + sales handoff.
//   ?action=list        GET   (auth: sales|admin)  -> all sessions
//   ?action=get&id=…     GET   (auth: sales|admin)  -> one session by session_id
//   ?action=log         POST  (PUBLIC)              -> upsert a session row
//   ?action=sendToSales POST  (PUBLIC) {sessionId}  -> flag + notifySales() stub
//
// The PUBLIC actions are what the standalone public generator (conversation.html)
// calls; they use the service-role key server-side so the browser needs no DB key.
// ─────────────────────────────────────────────────────────────────────────
import {
  serviceClient, requireSession, requireRole, notifySales, applyCors, readJsonBody,
  aggregateUsage,
} from './_lib.js';

const TABLE = 'cad_conversations';

// A session is only worth recording once the client has actually said something.
function hasClientMessage(messages) {
  return Array.isArray(messages) && messages.some(
    (m) => m && m.role === 'user' && String(m.content || '').trim().length > 0
  );
}

export default async function handler(req, res) {
  const action = (req.query.action || '').toString();

  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end(); }

  try {
    // ── PUBLIC: lightweight connectivity check (writes nothing) ──
    if (action === 'ping') {
      applyCors(res);
      return res.status(200).json({ ok: true });
    }

    // ── PUBLIC: upsert a session row (replaces the old client-side anon upsert) ──
    if (action === 'log') {
      applyCors(res);
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const b = await readJsonBody(req);
      if (!b.session_id) return res.status(400).json({ error: 'session_id is required' });

      // Don't create rows for sessions the client never interacted with — these
      // showed up as empty "(no client message yet)" logs. Ack without writing.
      if (!hasClientMessage(b.messages)) return res.status(200).json({ ok: true, skipped: true });

      // Lead contact details captured by the widget before the sauna chat.
      const lead = b.lead && typeof b.lead === 'object' ? b.lead : {};
      const blank = (v) => (v && String(v).trim() ? String(v).trim() : null);
      const row = {
        session_id: b.session_id,
        updated_at: new Date().toISOString(),
        messages: b.messages ?? [],
        txt_block: b.txt_block ?? null,
        user_agent: b.user_agent ?? null,
        client_name: blank(lead.name),
        client_email: blank(lead.email),
        client_phone: blank(lead.phone),
        client_location: blank(lead.location),
      };
      // The generated image (a multi-MB base64 data URL) is persisted SERVER-SIDE
      // by /api/openrouter?type=image — it never travels through this public log
      // POST, whose request body is capped (~4.5 MB on Vercel) and would silently
      // 413 with a large drawing inline, dropping the image from the logs. So we
      // only touch image columns here when a caller explicitly supplies them
      // (legacy small-image clients); omitting them leaves the server-written
      // values untouched on conflict instead of clobbering them to null/false.
      if (b.image_url) row.image_url = b.image_url;
      if (b.image_generated) row.image_generated = true;
      const svc = serviceClient();
      const { error } = await svc.from(TABLE).upsert(row, { onConflict: 'session_id' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ── PUBLIC: flag a session for sales + prepare the (stubbed) notification ──
    if (action === 'sendToSales') {
      applyCors(res);
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { sessionId } = await readJsonBody(req);
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

      const svc = serviceClient();
      const { error } = await svc
        .from(TABLE)
        .update({ sent_to_sales: true, sent_to_sales_at: new Date().toISOString() })
        .eq('session_id', sessionId);
      if (error) return res.status(500).json({ error: error.message });

      const notification = await notifySales(sessionId);
      return res.status(200).json({ ok: true, notification });
    }

    // ── AUTH (sales|admin): list all sessions ──
    if (action === 'list') {
      const session = await requireSession(req, res);
      if (!session) return;
      const svc = serviceClient();
      const { data, error } = await svc.from(TABLE).select('*').order('updated_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      // Hide sessions with no actual client message (incl. legacy empty rows).
      const sessions = (data || []).filter((s) => hasClientMessage(s.messages));
      // Enrich each session with the pipeline mode(s) recorded for its AI calls so
      // the compare picker can preview "Pipeline 1/2" without an extra fetch per row.
      // One grouped query for all listed sessions; best-effort (usage_events may not
      // be migrated yet, in which case sessions just carry no `modes`).
      try {
        const ids = sessions.map((s) => s.session_id).filter(Boolean);
        if (ids.length) {
          const { data: rows, error: uErr } = await svc
            .from('usage_events')
            .select('session_id, mode')
            .in('session_id', ids);
          if (!uErr && rows) {
            const map = {};
            for (const r of rows) {
              if (r.mode == null || !r.session_id) continue;
              (map[r.session_id] ||= new Set()).add(Number(r.mode));
            }
            for (const s of sessions) {
              const set = map[s.session_id];
              s.modes = set ? Array.from(set).sort((a, b) => a - b) : [];
            }
          }
        }
      } catch (e) {
        console.error('[list] modes enrich failed:', e?.message || e);
      }
      return res.status(200).json({ sessions });
    }

    // ── AUTH (sales|admin): one session by session_id (conversation permalink) ──
    if (action === 'get') {
      const session = await requireSession(req, res);
      if (!session) return;
      const id = (req.query.id || '').toString();
      if (!id) return res.status(400).json({ error: 'id is required' });
      const svc = serviceClient();
      const { data, error } = await svc.from(TABLE).select('*').eq('session_id', id).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Conversation not found' });
      return res.status(200).json({ session: data });
    }

    // ── AUTH (sales|admin): per-conversation usage analytics ──
    // Aggregates usage_events for ONE session (every AI call carries the same
    // session_id the conversation logger uses). Powers the Analytics drawer.
    if (action === 'analytics') {
      const session = await requireSession(req, res);
      if (!session) return;
      const id = (req.query.id || '').toString();
      if (!id) return res.status(400).json({ error: 'id is required' });

      const svc = serviceClient();
      const { data: rows, error } = await svc
        .from('usage_events')
        .select('id, created_at, model, provider, phase, mode, prompt_tokens, completion_tokens, total_tokens, cost, latency_ms, finish_reason')
        .eq('session_id', id)
        .order('created_at', { ascending: true });
      if (error) {
        // Same hint the admin dashboard uses when the table/columns aren't migrated.
        const missing = /relation .*usage_events.* does not exist|could not find the table|column .* does not exist/i.test(error.message || '');
        if (missing) {
          return res.status(200).json({
            sessionId: id, needsMigration: true,
            total: {}, byModel: [], byProvider: [], byPhase: [], performance: {},
            duration: null, peak: null, events: [],
          });
        }
        return res.status(500).json({ error: error.message });
      }

      const events = rows || [];
      const agg = aggregateUsage(events);
      // Duration = first → last call; peak = the single highest-token call.
      let duration = null, peak = null;
      if (events.length) {
        const first = events[0].created_at;
        const last = events[events.length - 1].created_at;
        duration = { first, last, ms: Math.max(0, new Date(last) - new Date(first)) };
        peak = events.reduce((best, r) => {
          const t = Number(r.total_tokens) || (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0);
          return (!best || t > best.tokens) ? { created_at: r.created_at, tokens: t } : best;
        }, null);
      }

      return res.status(200).json({
        sessionId: id,
        total: agg.total,
        duration,
        peak,
        byModel: agg.byModel,
        byProvider: agg.byProvider,
        byPhase: agg.byPhase,
        performance: agg.performance,
        events,
      });
    }

    // ── AUTH (admin only): delete one or more sessions ──
    if (action === 'delete') {
      const session = await requireRole(req, res, 'admin');
      if (!session) return;
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const b = await readJsonBody(req);
      const ids = Array.isArray(b.sessionIds)
        ? b.sessionIds.filter(Boolean)
        : (b.sessionId ? [b.sessionId] : []);
      if (!ids.length) return res.status(400).json({ error: 'sessionIds[] (or sessionId) is required' });
      const svc = serviceClient();
      const { error } = await svc.from(TABLE).delete().in('session_id', ids);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, deleted: ids.length });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
