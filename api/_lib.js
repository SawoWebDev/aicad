// ─────────────────────────────────────────────────────────────────────────
// Shared server-side library for the SAWO CAD CMS serverless functions.
//   • Supabase clients (service-role for data, anon for Auth sign-in)
//   • httpOnly cookie session handling (stateless-safe across invocations)
//   • requireSession / requireRole guards
//   • notifySales() — STUB (no real email this pass)
//   • small CORS + body helpers for the public endpoints
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const APP_URL = process.env.APP_URL || '';

const ACCESS_COOKIE = 'sb-access-token';
const REFRESH_COOKIE = 'sb-refresh-token';

// ── Supabase clients ──────────────────────────────────────────────────────

// Service-role client: full DB access, bypasses RLS. SERVER-ONLY.
export function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Anon client: used only for Supabase Auth (sign-in, token refresh, getUser).
export function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Cookie helpers ──────────────────────────────────────────────────────

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function cookieIsSecure() {
  return APP_URL.startsWith('https://') || process.env.NODE_ENV === 'production';
}

function buildCookie(name, value, maxAgeSec) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (cookieIsSecure()) attrs.push('Secure');
  return attrs.join('; ');
}

export function setSessionCookies(res, accessToken, refreshToken) {
  res.setHeader('Set-Cookie', [
    // access token ~1h; refresh token kept ~30d so sessions survive across invocations
    buildCookie(ACCESS_COOKIE, accessToken, 60 * 60),
    buildCookie(REFRESH_COOKIE, refreshToken, 60 * 60 * 24 * 30),
  ]);
}

export function clearSessionCookies(res) {
  res.setHeader('Set-Cookie', [
    buildCookie(ACCESS_COOKIE, '', 0),
    buildCookie(REFRESH_COOKIE, '', 0),
  ]);
}

// ── Session resolution ──────────────────────────────────────────────────

// Returns { user, role, active, email } or null. Refreshes + rewrites cookies
// transparently when the access token has expired but the refresh token is valid.
export async function getSession(req, res) {
  const cookies = parseCookies(req);
  let accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];
  if (!accessToken && !refreshToken) return null;

  const auth = anonClient();
  let user = null;

  if (accessToken) {
    const { data, error } = await auth.auth.getUser(accessToken);
    if (!error && data?.user) user = data.user;
  }

  // Expired access token → try refresh.
  if (!user && refreshToken) {
    const { data, error } = await auth.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data?.session && data?.user) {
      user = data.user;
      accessToken = data.session.access_token;
      if (res) setSessionCookies(res, data.session.access_token, data.session.refresh_token);
    }
  }

  if (!user) return null;

  // Role lives in profiles (service-role read so RLS can't hide it).
  const svc = serviceClient();
  const { data: profile } = await svc
    .from('profiles')
    .select('role, active, username')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.active === false) return null;
  return {
    user, role: profile.role, active: profile.active,
    username: profile.username || null, email: user.email,
  };
}

// Guard for API endpoints: returns the session or writes a 401/403 and returns null.
export async function requireSession(req, res) {
  const session = await getSession(req, res);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return session;
}

export async function requireRole(req, res, role) {
  const session = await requireSession(req, res);
  if (!session) return null;
  if (session.role !== role) {
    res.status(403).json({ error: 'Forbidden — requires ' + role + ' role' });
    return null;
  }
  return session;
}

// ── notifySales — delivers the "send to sales" notification via the relay ──
// Recipient is the single `sales_notification_email` setting, which MAY hold
// several comma-separated addresses (the relay splits + validates them). Never
// throws: if mail isn't configured or the relay fails, it logs and returns
// sent:false so the sales handoff still completes for the client.
export async function notifySales(sessionId) {
  const svc = serviceClient();
  const { data: settings } = await svc
    .from('settings')
    .select('sales_notification_email')
    .eq('id', 1)
    .maybeSingle();

  const recipient = settings?.sales_notification_email || null;
  const permalink = `${APP_URL}/cms/conversations/${sessionId}`;
  const subject = 'New sauna drawing ready for review';
  const body =
    `A client finished a sauna CAD conversation and flagged it for sales.\n\n` +
    `View the full conversation and generated drawing here:\n${permalink}\n`;

  const notification = { to: recipient, subject, body, permalink, sessionId };

  if (!recipient) {
    console.log('[notifySales] no sales_notification_email configured — not sent.');
    return { queued: false, sent: false, ...notification };
  }

  try {
    await sendMailViaRelay({ to: recipient, subject, message: body });
    return { queued: true, sent: true, ...notification };
  } catch (e) {
    console.error('[notifySales] send failed:', e?.message || e);
    return { queued: true, sent: false, error: e?.message || String(e), ...notification };
  }
}

// ── sendMailViaRelay — deliver mail through the WordPress wp_mail() relay ──
// The CMS has no SMTP of its own; instead it POSTs (server-to-server) to a small
// PHP endpoint on the WP site, which calls wp_mail(). The relay URL + shared
// secret live in the `settings` table (secret masked in the admin API). The
// secret travels only in this server-side request header, never to the browser.
export async function sendMailViaRelay({ to, subject, message, html = false }) {
  const svc = serviceClient();
  const { data: s, error } = await svc
    .from('settings')
    .select('mail_relay_url, mail_relay_secret')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error('Could not load mail settings: ' + error.message);
  if (!s?.mail_relay_url) throw new Error('No mail relay URL configured in Settings.');
  if (!s?.mail_relay_secret) throw new Error('No mail relay secret configured in Settings.');

  let resp;
  try {
    resp = await fetch(s.mail_relay_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sawo-secret': s.mail_relay_secret },
      body: JSON.stringify({ to, subject, message, html }),
    });
  } catch (e) {
    throw new Error('Could not reach the mail relay: ' + (e?.message || 'network error'));
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success) throw new Error(data.error || ('Mail relay responded HTTP ' + resp.status));
  return { sent: true };
}

// ── CORS + body helpers (public endpoints called cross-origin by conversation.html) ──

export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Fallback: manually drain the stream (some runtimes don't pre-parse).
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
