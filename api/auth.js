// ─────────────────────────────────────────────────────────────────────────
// /api/auth — Supabase Auth gateway (server-side; the browser never sees keys).
//   Login is by USERNAME + password. The email on the account is used ONLY for
//   password reset, not for signing in.
//
//   ?action=login         POST {username,password}      -> sets httpOnly session cookies
//   ?action=logout        POST                           -> clears cookies
//   ?action=session       GET                            -> { authenticated, role, username, email }
//   ?action=setupStatus   GET                            -> { needsSetup }  (true when 0 users)
//   ?action=setup         POST {username,email,password} -> creates first admin (only if 0 users)
//   ?action=requestReset  POST {username}                -> emails a password-reset link
//   ?action=completeReset POST {access_token,password}   -> sets a new password from a reset link
// ─────────────────────────────────────────────────────────────────────────
import {
  anonClient, serviceClient, setSessionCookies, clearSessionCookies,
  getSession, readJsonBody, APP_URL,
} from './_lib.js';

async function userCount() {
  const svc = serviceClient();
  const { count } = await svc
    .from('profiles')
    .select('id', { count: 'exact', head: true });
  return count || 0;
}

// Resolve a username (case-insensitive) to its profile + auth email.
async function lookupByUsername(username) {
  const svc = serviceClient();
  const { data: prof } = await svc
    .from('profiles')
    .select('id, role, active, username')
    .ilike('username', username)
    .maybeSingle();
  if (!prof) return null;
  const { data: udata } = await svc.auth.admin.getUserById(prof.id);
  return { profile: prof, email: udata?.user?.email || null };
}

export default async function handler(req, res) {
  const action = (req.query.action || '').toString();

  try {
    // ── current session ──
    if (action === 'session') {
      const session = await getSession(req, res);
      if (!session) return res.status(200).json({ authenticated: false });
      return res.status(200).json({
        authenticated: true, role: session.role,
        username: session.username, email: session.email,
      });
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

    // ── login (by username) ──
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { username, password } = await readJsonBody(req);
      if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

      const found = await lookupByUsername(username);
      if (!found || !found.email) return res.status(401).json({ error: 'Invalid username or password.' });

      const auth = anonClient();
      const { data, error } = await auth.auth.signInWithPassword({ email: found.email, password });
      if (error || !data?.session) return res.status(401).json({ error: 'Invalid username or password.' });
      if (found.profile.active === false) return res.status(403).json({ error: 'This account is deactivated.' });

      setSessionCookies(res, data.session.access_token, data.session.refresh_token);
      return res.status(200).json({ ok: true, role: found.profile.role });
    }

    // ── first-run bootstrap: create the initial admin (self-disables once a user exists) ──
    if (action === 'setup') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if ((await userCount()) > 0) {
        return res.status(403).json({ error: 'Setup is closed — a user already exists. Use the admin Users page.' });
      }
      const { username, email, password } = await readJsonBody(req);
      if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, and password are required.' });
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
        .insert({ id: created.user.id, username, role: 'admin', active: true });
      if (profErr) {
        // Roll back the orphaned auth user so setup can be retried cleanly.
        await svc.auth.admin.deleteUser(created.user.id);
        const dup = /duplicate|unique/i.test(profErr.message || '');
        return res.status(400).json({ error: dup ? 'That username is already taken.' : ('Could not create admin profile: ' + profErr.message) });
      }

      // Auto-login the freshly created admin.
      const auth = anonClient();
      const { data: signIn } = await auth.auth.signInWithPassword({ email, password });
      if (signIn?.session) {
        setSessionCookies(res, signIn.session.access_token, signIn.session.refresh_token);
      }
      return res.status(200).json({ ok: true, role: 'admin' });
    }

    // ── magic-link callback: exchange tokens from Supabase redirect for httpOnly cookies ──
    if (action === 'magic-callback') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { access_token, refresh_token } = await readJsonBody(req);
      if (!access_token || !refresh_token) {
        return res.status(400).json({ error: 'Tokens are required.' });
      }

      const auth = anonClient();
      const { data, error } = await auth.auth.getUser(access_token);
      if (error || !data?.user) {
        return res.status(401).json({ error: 'Invalid or expired magic link.' });
      }

      const svc = serviceClient();
      const { data: profile } = await svc
        .from('profiles')
        .select('role, active')
        .eq('id', data.user.id)
        .maybeSingle();
      if (!profile || profile.active === false) {
        return res.status(403).json({ error: 'This account is deactivated.' });
      }

      setSessionCookies(res, access_token, refresh_token);
      return res.status(200).json({ ok: true, role: profile.role });
    }

    // ── request a password-reset email (email is used only for this) ──
    if (action === 'requestReset') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { username } = await readJsonBody(req);
      if (!username) return res.status(400).json({ error: 'Username is required.' });

      // Resolve + send, but always answer ok so usernames can't be enumerated.
      const found = await lookupByUsername(username);
      if (found?.email) {
        const auth = anonClient();
        await auth.auth.resetPasswordForEmail(found.email, { redirectTo: (APP_URL || '') + '/reset' });
      }
      return res.status(200).json({ ok: true });
    }

    // ── complete a password reset from the emailed link ──
    if (action === 'completeReset') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { access_token, password } = await readJsonBody(req);
      if (!access_token || !password) return res.status(400).json({ error: 'Reset token and new password are required.' });
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const auth = anonClient();
      const { data, error } = await auth.auth.getUser(access_token);
      if (error || !data?.user) return res.status(401).json({ error: 'This reset link is invalid or has expired.' });

      const svc = serviceClient();
      const { error: uErr } = await svc.auth.admin.updateUserById(data.user.id, { password });
      if (uErr) return res.status(400).json({ error: uErr.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
