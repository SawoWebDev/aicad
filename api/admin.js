// ─────────────────────────────────────────────────────────────────────────
// /api/admin — admin-only management. Every action requires the 'admin' role.
//   ?resource=users     GET    -> list users (auth.users joined with profiles)
//                       POST   {email,password,role} -> create user + profile
//                       PATCH  {id, role?, active?}  -> edit role / deactivate
//   ?resource=settings  GET    -> settings (secrets masked)
//                       PUT    {…fields}             -> update settings
// ─────────────────────────────────────────────────────────────────────────
import { serviceClient, requireRole, readJsonBody } from './_lib.js';

const SECRET_FIELDS = ['openrouter_api_key', 'mail_smtp_pass'];
const SETTING_FIELDS = [
  'openrouter_api_key', 'chat_model', 'image_model', 'image_size', 'image_aspect_ratio',
  'sales_notification_email', 'mail_smtp_host', 'mail_smtp_port', 'mail_smtp_user',
  'mail_smtp_pass', 'mail_from_address',
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
        const { data: profiles } = await svc.from('profiles').select('id, role, active, created_at');
        const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
        const users = (list?.users || []).map((u) => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          role: byId[u.id]?.role || null,
          active: byId[u.id]?.active ?? null,
        }));
        return res.status(200).json({ users });
      }

      if (req.method === 'POST') {
        const { email, password, role } = await readJsonBody(req);
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
        if (!['admin', 'sales'].includes(role)) return res.status(400).json({ error: 'role must be admin or sales.' });
        if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

        const { data: created, error: cErr } = await svc.auth.admin.createUser({
          email, password, email_confirm: true,
        });
        if (cErr || !created?.user) return res.status(400).json({ error: cErr?.message || 'Could not create user.' });

        const { error: pErr } = await svc.from('profiles')
          .insert({ id: created.user.id, role, active: true });
        if (pErr) {
          await svc.auth.admin.deleteUser(created.user.id);
          return res.status(400).json({ error: 'Could not create profile: ' + pErr.message });
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
        // Mask secrets: never return their values; expose only whether they're set.
        for (const f of SECRET_FIELDS) {
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

    return res.status(400).json({ error: 'Unknown resource' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
