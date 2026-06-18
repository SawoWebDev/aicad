// ─────────────────────────────────────────────────────────────────────────
// /api/auth — Supabase Auth gateway (server-side; the browser never sees keys).
//   ?action=login       POST {email,password}  -> sets httpOnly session cookies
//   ?action=logout      POST                    -> clears cookies
//   ?action=session     GET                     -> { authenticated, role, email }
//   ?action=setupStatus GET                     -> { needsSetup }  (true when 0 users)
//   ?action=setup       POST {email,password}   -> creates first admin (only if 0 users)
// ─────────────────────────────────────────────────────────────────────────
import {
  anonClient, serviceClient, setSessionCookies, clearSessionCookies,
  getSession, readJsonBody,
} from './_lib.js';

async function userCount() {
  const svc = serviceClient();
  const { count } = await svc
    .from('profiles')
    .select('id', { count: 'exact', head: true });
  return count || 0;
}

export default async function handler(req, res) {
  const action = (req.query.action || '').toString();

  try {
    // ── current session ──
    if (action === 'session') {
      const session = await getSession(req, res);
      if (!session) return res.status(200).json({ authenticated: false });
      return res.status(200).json({ authenticated: true, role: session.role, email: session.email });
    }

    // ── does the deployment still need its first admin? ──
    if (action === 'setupStatus') {
      return res.status(200).json({ needsSetup: (await userCount()) === 0 });
    }

    // ── logout ──
    if (action === 'logout') {
      clearSessionCookies(res);
      return res.status(200).json({ ok: true });
    }

    // ── login ──
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { email, password } = await readJsonBody(req);
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

      const auth = anonClient();
      const { data, error } = await auth.auth.signInWithPassword({ email, password });
      if (error || !data?.session) {
        return res.status(401).json({ error: error?.message || 'Invalid email or password.' });
      }

      // Confirm an active profile / role exists before issuing the session.
      const svc = serviceClient();
      const { data: profile } = await svc
        .from('profiles').select('role, active').eq('id', data.user.id).maybeSingle();
      if (!profile) return res.status(403).json({ error: 'No profile/role assigned to this account.' });
      if (profile.active === false) return res.status(403).json({ error: 'This account is deactivated.' });

      setSessionCookies(res, data.session.access_token, data.session.refresh_token);
      return res.status(200).json({ ok: true, role: profile.role });
    }

    // ── first-run bootstrap: create the initial admin (self-disables once a user exists) ──
    if (action === 'setup') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if ((await userCount()) > 0) {
        return res.status(403).json({ error: 'Setup is closed — a user already exists. Use the admin Users page.' });
      }
      const { email, password } = await readJsonBody(req);
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const svc = serviceClient();
      const { data: created, error: createErr } = await svc.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createErr || !created?.user) {
        return res.status(400).json({ error: createErr?.message || 'Could not create user.' });
      }
      const { error: profErr } = await svc
        .from('profiles')
        .insert({ id: created.user.id, role: 'admin', active: true });
      if (profErr) {
        // Roll back the orphaned auth user so setup can be retried cleanly.
        await svc.auth.admin.deleteUser(created.user.id);
        return res.status(400).json({ error: 'Could not create admin profile: ' + profErr.message });
      }

      // Auto-login the freshly created admin.
      const auth = anonClient();
      const { data: signIn } = await auth.auth.signInWithPassword({ email, password });
      if (signIn?.session) {
        setSessionCookies(res, signIn.session.access_token, signIn.session.refresh_token);
      }
      return res.status(200).json({ ok: true, role: 'admin' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
