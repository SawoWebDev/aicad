// ─────────────────────────────────────────────────────────────────────────
// /api/admin — admin-only management. Every action requires the 'admin' role.
//   ?resource=users     GET    -> list users (auth.users joined with profiles)
//                       POST   {email,password,role} -> create user + profile
//                       PATCH  {id, role?, active?}  -> edit role / deactivate
//   ?resource=settings  GET    -> settings (secrets masked)
//                       PUT    {…fields}             -> update settings
//   ?resource=test-email POST  {to}                 -> send a test email via the WP relay
// ─────────────────────────────────────────────────────────────────────────
import { serviceClient, requireRole, readJsonBody, sendMailViaRelay, APP_URL } from './_lib.js';

const SECRET_FIELDS = ['openrouter_api_key', 'openrouter_mgmt_key', 'mail_smtp_pass', 'mail_relay_secret'];
const GET_MASK_FIELDS = ['mail_smtp_pass', 'mail_relay_secret'];
const SETTING_FIELDS = [
  'openrouter_api_key', 'openrouter_mgmt_key', 'pipeline_mode', 'chat_model', 'convo_model', 'image_model',
  'image_size', 'image_aspect_ratio',
  'sales_notification_email', 'mail_smtp_host', 'mail_smtp_port', 'mail_smtp_user',
  'mail_smtp_pass', 'mail_from_address', 'mail_relay_url', 'mail_relay_secret',
];

export default async function handler(req, res) {
  // Hard server-side role enforcement.
  const session = await requireRole(req, res, 'admin');
  if (!session) return;

  const resource = (req.query.resource || '').toString();
  const svc = serviceClient();

  try {
    // ── USERS ──
    if (resource === 'users') {
      if (req.method === 'GET') {
        const { data: list, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (error) return res.status(500).json({ error: error.message });
        const { data: profiles } = await svc.from('profiles').select('id, username, role, active, created_at');
        const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
        const users = (list?.users || []).map((u) => ({
          id: u.id,
          email: u.email,
          username: byId[u.id]?.username || null,
          created_at: u.created_at,
          role: byId[u.id]?.role || null,
          active: byId[u.id]?.active ?? null,
        }));
        return res.status(200).json({ users });
      }

      if (req.method === 'POST') {
        const { username, email, password, role } = await readJsonBody(req);
        if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, and password are required.' });
        if (!['admin', 'sales'].includes(role)) return res.status(400).json({ error: 'role must be admin or sales.' });
        if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

        const { data: created, error: cErr } = await svc.auth.admin.createUser({
          email, password, email_confirm: true,
        });
        if (cErr || !created?.user) return res.status(400).json({ error: cErr?.message || 'Could not create user.' });

        const { error: pErr } = await svc.from('profiles')
          .insert({ id: created.user.id, username, role, active: true });
        if (pErr) {
          await svc.auth.admin.deleteUser(created.user.id);
          const dup = /duplicate|unique/i.test(pErr.message || '');
          return res.status(400).json({ error: dup ? 'That username is already taken.' : ('Could not create profile: ' + pErr.message) });
        }
        return res.status(200).json({ ok: true, id: created.user.id });
      }

      if (req.method === 'PATCH') {
        const { id, role, active } = await readJsonBody(req);
        if (!id) return res.status(400).json({ error: 'id is required.' });
        if (id === session.user.id && active === false) {
          return res.status(400).json({ error: 'You cannot deactivate your own account.' });
        }
        const patch = {};
        if (role !== undefined) {
          if (!['admin', 'sales'].includes(role)) return res.status(400).json({ error: 'role must be admin or sales.' });
          patch.role = role;
        }
        if (active !== undefined) patch.active = !!active;
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

        const { error } = await svc.from('profiles').update(patch).eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── SETTINGS ──
    if (resource === 'settings') {
      if (req.method === 'GET') {
        const { data, error } = await svc.from('settings').select('*').eq('id', 1).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        const out = { ...(data || {}) };
        for (const f of GET_MASK_FIELDS) {
          out[f + '_set'] = !!out[f];
          out[f] = '';
        }
        return res.status(200).json({ settings: out });
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const patch = { updated_at: new Date().toISOString() };
        for (const f of SETTING_FIELDS) {
          if (!(f in body)) continue;
          const val = body[f];
          // For secret fields, a blank value means "keep existing" (the form shows
          // them masked/empty); only overwrite when a new value is actually typed.
          if (SECRET_FIELDS.includes(f) && (val === '' || val == null)) continue;
          patch[f] = val === '' ? null : val;
        }
        const { error } = await svc.from('settings').update(patch).eq('id', 1);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── ANALYTICS ──
    // Reads raw usage_events over a selectable window and aggregates in-process
    // (low row volume: one row per AI call). Returns OpenRouter-style breakdowns:
    // window totals, per-model / per-phase / per-mode, a daily series, a Mode-1-vs-2
    // breakdown, and recent message rows for the log + export.
    if (resource === 'analytics') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

      const DAY_MS = 24 * 60 * 60 * 1000;
      const now = new Date();
      // Bucket daily by the admin's LOCAL calendar day. The browser sends its IANA
      // zone (?tz=America/New_York); fall back to UTC if absent/invalid.
      const tz = (req.query.tz || '').toString() || 'UTC';
      let dayKey;
      try {
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        fmt.format(now); // verify the zone works
        dayKey = (d) => fmt.format(d instanceof Date ? d : new Date(d)); // -> 'YYYY-MM-DD'
      } catch {
        dayKey = (d) => new Date(d).toISOString().slice(0, 10);
      }

      // Selectable range (days). 'all' → everything. Daily chart caps at 365 buckets.
      const rangeRaw = (req.query.range || '30').toString();
      const isAll = rangeRaw === 'all';
      const rangeDays = isAll ? 4000 : Math.min(Math.max(parseInt(rangeRaw, 10) || 30, 1), 4000);
      // Fetch a touch wider so no local-day row near the edge is clipped.
      const since = new Date(now.getTime() - (rangeDays + 2) * DAY_MS).toISOString();
      const chartDays = Math.min(rangeDays, 365);
      const msgLimit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);

      const { data: rows, error } = await svc
        .from('usage_events')
        .select('id, created_at, model, provider, phase, mode, session_id, prompt_tokens, completion_tokens, total_tokens, cost, latency_ms, finish_reason')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200000);
      if (error) {
        // Surface a clear hint when the table / new columns haven't been migrated yet.
        const missing = /relation .*usage_events.* does not exist|could not find the table|column .* does not exist/i.test(error.message || '');
        return res.status(missing ? 200 : 500).json(
          missing
            ? { needsMigration: true, windowTotal: {}, performance: {}, byModel: [], byPhase: [], byMode: [], modeBreakdown: {}, daily: [], dailyByModel: [], messages: [] }
            : { error: error.message }
        );
      }

      const windowTotal = { calls: 0, cost: 0, tokens: 0, input: 0, output: 0 };
      const modelMap = {};
      const phaseMap = {};
      const modeMap = {};
      const modeAgg = {};         // mode -> { calls, cost, tokens, input, output, models{} }
      const dailyMap = {};
      const dailyModelMap = {};   // day -> { model -> { cost, tokens } }

      let latSum = 0, latCount = 0, fastest = null, slowest = null;

      for (const r of rows || []) {
        const cost = Number(r.cost) || 0;
        const prompt = Number(r.prompt_tokens) || 0;
        const completion = Number(r.completion_tokens) || 0;
        const tokens = Number(r.total_tokens) || (prompt + completion);
        const dk = dayKey(r.created_at);
        const mk = r.model || 'unknown';

        windowTotal.calls += 1; windowTotal.cost += cost; windowTotal.tokens += tokens;
        windowTotal.input += prompt; windowTotal.output += completion;

        (modelMap[mk] ||= { model: mk, cost: 0, tokens: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0, latSum: 0, latCount: 0, lastUsed: r.created_at });
        const m = modelMap[mk];
        m.cost += cost; m.tokens += tokens; m.prompt_tokens += prompt; m.completion_tokens += completion; m.calls += 1;
        if (r.created_at > m.lastUsed) m.lastUsed = r.created_at;

        const pk = r.phase || 'other';
        (phaseMap[pk] ||= { phase: pk, cost: 0, tokens: 0, calls: 0 });
        phaseMap[pk].cost += cost; phaseMap[pk].tokens += tokens; phaseMap[pk].calls += 1;

        const mdk = r.mode == null ? 'unknown' : String(r.mode);
        (modeMap[mdk] ||= { mode: mdk, cost: 0, tokens: 0, calls: 0 });
        modeMap[mdk].cost += cost; modeMap[mdk].tokens += tokens; modeMap[mdk].calls += 1;

        // Per-mode breakdown incl. which models ran under each mode.
        (modeAgg[mdk] ||= { mode: mdk, calls: 0, cost: 0, tokens: 0, input: 0, output: 0, models: {} });
        const ma = modeAgg[mdk];
        ma.calls += 1; ma.cost += cost; ma.tokens += tokens; ma.input += prompt; ma.output += completion;
        (ma.models[mk] ||= { model: mk, calls: 0, cost: 0, tokens: 0 });
        ma.models[mk].calls += 1; ma.models[mk].cost += cost; ma.models[mk].tokens += tokens;

        (dailyMap[dk] ||= { day: dk, cost: 0, tokens: 0, calls: 0 });
        dailyMap[dk].cost += cost; dailyMap[dk].tokens += tokens; dailyMap[dk].calls += 1;

        (dailyModelMap[dk] ||= {});
        (dailyModelMap[dk][mk] ||= { cost: 0, tokens: 0 });
        dailyModelMap[dk][mk].cost += cost; dailyModelMap[dk][mk].tokens += tokens;

        const lat = r.latency_ms == null ? null : Number(r.latency_ms);
        if (lat != null && isFinite(lat)) {
          latSum += lat; latCount += 1;
          m.latSum += lat; m.latCount += 1;
          if (!fastest || lat < fastest.ms) fastest = { model: mk, ms: lat };
          if (!slowest || lat > slowest.ms) slowest = { model: mk, ms: lat };
        }
      }

      // Dense daily series (fill gaps with zeros), oldest → newest. Keys are calendar
      // dates anchored on the local "today", decremented in UTC (no DST drift).
      const todayKey = dayKey(now);
      const [ty, tm, td] = todayKey.split('-').map(Number);
      const todayUTC = Date.UTC(ty, tm - 1, td);
      const daily = [];
      const dailyByModel = [];
      for (let i = chartDays - 1; i >= 0; i--) {
        const k = new Date(todayUTC - i * DAY_MS).toISOString().slice(0, 10);
        daily.push(dailyMap[k] || { day: k, cost: 0, tokens: 0, calls: 0 });
        dailyByModel.push({ day: k, perModel: dailyModelMap[k] || {} });
      }

      const byModel = Object.values(modelMap)
        .map((m) => ({
          model: m.model, calls: m.calls, cost: m.cost, tokens: m.tokens,
          prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens,
          avgLatencyMs: m.latCount ? Math.round(m.latSum / m.latCount) : null,
          lastUsed: m.lastUsed,
        }))
        .sort((a, b) => b.cost - a.cost);

      // Finalize the mode breakdown (models map -> sorted array).
      const modeBreakdown = {};
      for (const k of Object.keys(modeAgg)) {
        const x = modeAgg[k];
        modeBreakdown[k] = {
          mode: k, calls: x.calls, cost: x.cost, tokens: x.tokens, input: x.input, output: x.output,
          models: Object.values(x.models).sort((a, b) => b.cost - a.cost),
        };
      }

      return res.status(200).json({
        range: isAll ? 'all' : rangeDays,
        windowTotal,
        performance: { avgLatencyMs: latCount ? Math.round(latSum / latCount) : null, fastest, slowest },
        byModel,
        byPhase: Object.values(phaseMap).sort((a, b) => b.cost - a.cost),
        byMode: Object.values(modeMap).sort((a, b) => b.cost - a.cost),
        modeBreakdown,
        daily,
        dailyByModel,
        messages: (rows || []).slice(0, msgLimit),
      });
    }

    // ── BALANCE ──
    // Live OpenRouter account credit, fetched server-side so the secret API key
    // never leaves the backend. Kept separate from the analytics aggregation so a
    // slow/failed upstream call can't break the usage dashboard. Returns remaining
    // credit (purchased − used) alongside the raw totals for the Overview card.
    if (resource === 'balance') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

      const { data: cfg, error: cfgErr } = await svc
        .from('settings').select('openrouter_api_key, openrouter_mgmt_key').eq('id', 1).maybeSingle();
      if (cfgErr) return res.status(500).json({ error: cfgErr.message });
      const mgmtKey = (cfg?.openrouter_mgmt_key || '').trim();
      const apiKey = (cfg?.openrouter_api_key || '').trim();
      if (!mgmtKey && !apiKey) return res.status(200).json({ configured: false });

      try {
        // Management key → /api/v1/credits returns actual purchased credits vs used.
        if (mgmtKey) {
          const creditsResp = await fetch('https://openrouter.ai/api/v1/credits', {
            headers: { 'Authorization': 'Bearer ' + mgmtKey },
          });
          if (creditsResp.ok) {
            const cd = await creditsResp.json().catch(() => null);
            const credits = Number(cd?.data?.total_credits) || 0;
            const used = Number(cd?.data?.total_usage) || 0;
            return res.status(200).json({
              configured: true, total_credits: credits, total_usage: used, remaining: credits - used,
            });
          }
          // If the management key failed, surface a clear error rather than
          // silently falling through to the regular key (which can't show credits).
          const err = await creditsResp.json().catch(() => ({}));
          return res.status(200).json({
            configured: true,
            error: 'Management key error: ' + (err?.error?.message || ('HTTP ' + creditsResp.status)),
            needsMgmtKey: false,
          });
        }

        // No management key — fall back to /api/v1/key (any API key).
        // Returns spend-limit info but NOT purchased credits.
        const keyResp = await fetch('https://openrouter.ai/api/v1/key', {
          headers: { 'Authorization': 'Bearer ' + apiKey },
        });
        const kRaw = await keyResp.text();
        let kd; try { kd = JSON.parse(kRaw); } catch { kd = null; }
        if (!keyResp.ok) {
          return res.status(200).json({ configured: true, error: kd?.error?.message || ('HTTP ' + keyResp.status) });
        }
        const d = kd?.data || {};
        const usage = Number(d.usage) || 0;
        const limit = d.limit != null ? Number(d.limit) : null;
        const limitRemaining = d.limit_remaining != null ? Number(d.limit_remaining) : null;
        return res.status(200).json({
          configured: true,
          total_credits: limit,
          total_usage: usage,
          remaining: limitRemaining,
          is_free_tier: !!d.is_free_tier,
          label: d.label || null,
          needsMgmtKey: true,
        });
      } catch (e) {
        return res.status(200).json({ configured: true, error: e?.message || 'Could not reach OpenRouter.' });
      }
    }

    // ── MAGIC LINK ──
    if (resource === 'magic-link') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id, origin } = await readJsonBody(req);
      if (!id) return res.status(400).json({ error: 'User ID is required.' });

      const { data: userData, error: userErr } = await svc.auth.admin.getUserById(id);
      if (userErr || !userData?.user?.email) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const { data: profile } = await svc.from('profiles').select('active').eq('id', id).maybeSingle();
      if (!profile || profile.active === false) {
        return res.status(400).json({ error: 'Cannot generate link for an inactive user.' });
      }

      // Adapt to the domain the admin is actually on. Prefer the browser-sent
      // origin (so a production admin gets production links, a local admin gets
      // local links); fall back to the request host, then APP_URL / default.
      let base = '';
      if (typeof origin === 'string' && /^https?:\/\//.test(origin)) {
        base = origin.replace(/\/$/, '');
      } else if (req.headers.host) {
        const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
        base = `${proto}://${req.headers.host}`;
      } else {
        base = APP_URL || 'https://sawoaicad.vercel.app';
      }
      const redirectTo = base + '/auth-callback';

      const { data: linkData, error: linkErr } = await svc.auth.admin.generateLink({
        type: 'magiclink',
        email: userData.user.email,
        options: { redirectTo },
      });

      if (linkErr || !linkData?.properties?.action_link) {
        return res.status(500).json({ error: linkErr?.message || 'Could not generate magic link.' });
      }

      // Belt-and-suspenders: force the link's redirect_to to our callback so it
      // can't silently fall back to the project's Site URL. (Supabase will only
      // honor this if redirectTo is in the Auth "Redirect URLs" allow-list.)
      let link = linkData.properties.action_link;
      try {
        const u = new URL(link);
        u.searchParams.set('redirect_to', redirectTo);
        link = u.toString();
      } catch { /* leave as-is */ }

      return res.status(200).json({ ok: true, link });
    }

    // ── TEST EMAIL ──
    if (resource === 'test-email') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { to } = await readJsonBody(req);
      if (!to) return res.status(400).json({ error: 'Recipient email is required.' });
      try {
        await sendMailViaRelay({
          to,
          subject: 'SAWO CAD CMS — test email',
          message: 'This is a test email from the SAWO CAD CMS. If you received this, the WordPress mail relay is working.',
        });
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(502).json({ error: e?.message || 'Could not send test email.' });
      }
    }

    return res.status(400).json({ error: 'Unknown resource' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
