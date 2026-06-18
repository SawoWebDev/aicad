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
  'openrouter_api_key', 'chat_model', 'image_model', 'image_size', 'image_aspect_ratio',
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

    // ── MAGIC LINK ──
    if (resource === 'magic-link') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id } = await readJsonBody(req);
      if (!id) return res.status(400).json({ error: 'User ID is required.' });

      const { data: userData, error: userErr } = await svc.auth.admin.getUserById(id);
      if (userErr || !userData?.user?.email) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const { data: profile } = await svc.from('profiles').select('active').eq('id', id).maybeSingle();
      if (!profile || profile.active === false) {
        return res.status(400).json({ error: 'Cannot generate link for an inactive user.' });
      }

      const appUrl = APP_URL || 'https://sawoaicad.vercel.app';
      const { data: linkData, error: linkErr } = await svc.auth.admin.generateLink({
        type: 'magiclink',
        email: userData.user.email,
        options: { redirectTo: appUrl + '/auth-callback' },
      });

      if (linkErr || !linkData?.properties?.action_link) {
        return res.status(500).json({ error: linkErr?.message || 'Could not generate magic link.' });
      }

      return res.status(200).json({ ok: true, link: linkData.properties.action_link });
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
