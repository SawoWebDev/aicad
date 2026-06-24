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

const SECRET_FIELDS = ['openrouter_api_key', 'mail_smtp_pass', 'mail_relay_secret'];
const GET_MASK_FIELDS = ['mail_smtp_pass', 'mail_relay_secret'];
const SETTING_FIELDS = [
  'openrouter_api_key', 'pipeline_mode', 'chat_model', 'convo_model', 'image_model',
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
    // Reads raw usage_events for the last 30 days and aggregates in-process
    // (low row volume: one row per AI call). Returns OpenRouter-style breakdowns:
    // spend per window, per-model totals, per-phase totals, and a daily series.
    if (resource === 'analytics') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

      const DAY_MS = 24 * 60 * 60 * 1000;
      const now = new Date();
      // Bucket today/yesterday/daily by the admin's LOCAL calendar day. The browser
      // sends its IANA zone (?tz=America/New_York); fall back to UTC if absent/invalid.
      const tz = (req.query.tz || '').toString() || 'UTC';
      let dayKey;
      try {
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        // en-CA yields YYYY-MM-DD; verify it actually works for this zone.
        fmt.format(now);
        dayKey = (d) => fmt.format(d instanceof Date ? d : new Date(d)); // -> 'YYYY-MM-DD'
      } catch {
        dayKey = (d) => new Date(d).toISOString().slice(0, 10);
      }
      // Fetch a touch wider than 30 days so no local-day row near the edge is clipped.
      const since = new Date(now.getTime() - 32 * DAY_MS).toISOString();

      const { data: rows, error } = await svc
        .from('usage_events')
        .select('created_at, model, phase, prompt_tokens, completion_tokens, total_tokens, cost')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(100000);
      if (error) {
        // Surface a clear hint when the table hasn't been migrated yet.
        const missing = /relation .*usage_events.* does not exist|could not find the table/i.test(error.message || '');
        return res.status(missing ? 200 : 500).json(
          missing
            ? { needsMigration: true, totals: {}, byModel: [], byPhase: [], daily: [] }
            : { error: error.message }
        );
      }

      // Local-day keys for today/yesterday; rolling windows for 7/30-day totals.
      const todayKey = dayKey(now);
      const [ty, tm, td] = todayKey.split('-').map(Number);
      const todayUTC = Date.UTC(ty, tm - 1, td); // midnight UTC of the local "today" date
      const yesterdayKey = new Date(todayUTC - DAY_MS).toISOString().slice(0, 10);
      const start7 = now.getTime() - 7 * DAY_MS;
      const start30 = now.getTime() - 30 * DAY_MS;

      const blank = () => ({ cost: 0, tokens: 0, calls: 0 });
      const totals = { today: blank(), yesterday: blank(), last7: blank(), last30: blank() };
      const modelMap = {};
      const phaseMap = {};
      const dailyMap = {};

      for (const r of rows || []) {
        const t = new Date(r.created_at).getTime();
        const cost = Number(r.cost) || 0;
        const tokens = Number(r.total_tokens) || ((Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0));
        const dk = dayKey(r.created_at);

        const add = (b) => { b.cost += cost; b.tokens += tokens; b.calls += 1; };
        if (t >= start30) add(totals.last30);
        if (t >= start7) add(totals.last7);
        if (dk === todayKey) add(totals.today);
        else if (dk === yesterdayKey) add(totals.yesterday);

        const mk = r.model || 'unknown';
        (modelMap[mk] ||= { model: mk, cost: 0, tokens: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 });
        modelMap[mk].cost += cost;
        modelMap[mk].tokens += tokens;
        modelMap[mk].prompt_tokens += Number(r.prompt_tokens) || 0;
        modelMap[mk].completion_tokens += Number(r.completion_tokens) || 0;
        modelMap[mk].calls += 1;

        const pk = r.phase || 'other';
        (phaseMap[pk] ||= { phase: pk, cost: 0, tokens: 0, calls: 0 });
        phaseMap[pk].cost += cost;
        phaseMap[pk].tokens += tokens;
        phaseMap[pk].calls += 1;

        (dailyMap[dk] ||= { day: dk, cost: 0, tokens: 0, calls: 0 });
        dailyMap[dk].cost += cost;
        dailyMap[dk].tokens += tokens;
        dailyMap[dk].calls += 1;
      }

      // Dense 30-day daily series (fill gaps with zeros), oldest → newest. Keys are
      // calendar dates anchored on the local "today", decremented in UTC (no DST drift).
      const daily = [];
      for (let i = 29; i >= 0; i--) {
        const k = new Date(todayUTC - i * DAY_MS).toISOString().slice(0, 10);
        daily.push(dailyMap[k] || { day: k, cost: 0, tokens: 0, calls: 0 });
      }

      return res.status(200).json({
        totals,
        byModel: Object.values(modelMap).sort((a, b) => b.cost - a.cost),
        byPhase: Object.values(phaseMap).sort((a, b) => b.cost - a.cost),
        daily,
      });
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
