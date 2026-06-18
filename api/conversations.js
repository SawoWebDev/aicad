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
  serviceClient, requireSession, notifySales, applyCors, readJsonBody,
} from './_lib.js';

const TABLE = 'cad_conversations';

export default async function handler(req, res) {
  const action = (req.query.action || '').toString();

  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end(); }

  try {
    // ── PUBLIC: upsert a session row (replaces the old client-side anon upsert) ──
    if (action === 'log') {
      applyCors(res);
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const b = await readJsonBody(req);
      if (!b.session_id) return res.status(400).json({ error: 'session_id is required' });

      const row = {
        session_id: b.session_id,
        updated_at: new Date().toISOString(),
        messages: b.messages ?? [],
        txt_block: b.txt_block ?? null,
        image_generated: !!b.image_generated,
        image_url: b.image_url ?? null,
        user_agent: b.user_agent ?? null,
      };
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
      return res.status(200).json({ sessions: data || [] });
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

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
