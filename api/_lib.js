// ─────────────────────────────────────────────────────────────────────────
// Shared server-side library for the SAWO CAD CMS serverless functions.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

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

// ── notifySales — branded HTML email with inline image + attachments ──
const DEFAULT_APP_URL = 'https://sawoaicad.vercel.app';

async function fetchImageBytes(imageUrl) {
  if (!imageUrl) return null;
  try {
    if (imageUrl.startsWith('data:')) {
      const b64 = imageUrl.split(',')[1];
      if (!b64) return null;
      return Buffer.from(b64, 'base64');
    }
    const resp = await fetch(imageUrl);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch { return null; }
}

// Sniff the real image type from the leading bytes so attachments/PDF embedding
// use the correct codec regardless of what the model labelled the data URL.
function sniffImageType(bytes) {
  if (bytes && bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (bytes && bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  return { ext: 'png', mime: 'image/png' }; // default; embedPng will surface a real failure
}

async function buildPdfFromImage(imgBytes) {
  try {
    const pdf = await PDFDocument.create();
    const { mime } = sniffImageType(imgBytes);
    const img = mime === 'image/jpeg'
      ? await pdf.embedJpg(imgBytes)
      : await pdf.embedPng(imgBytes);
    const { width, height } = img.scale(1);
    const page = pdf.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
    return Buffer.from(await pdf.save());
  } catch { return null; }
}

function buildSalesEmailHtml(permalink, hasCidImage, contact) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const c = contact || {};
  const rows = [
    ['Name', c.client_name],
    ['Email', c.client_email],
    ['Phone', c.client_phone],
    ['Location', c.client_location],
  ].filter(([, v]) => v && String(v).trim());
  const contactBlock = rows.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border:1px solid #e5ddd5;border-radius:8px;border-collapse:separate;overflow:hidden;">
        <tr><td colspan="2" style="background:#f7f2ec;padding:10px 16px;font-size:11px;font-weight:bold;color:#AF8564;letter-spacing:1.5px;text-transform:uppercase;">Client contact</td></tr>
        ${rows.map(([k, v]) => `<tr><td style="padding:9px 16px;font-size:13px;color:#777;width:90px;border-top:1px solid #efe7dd;">${k}</td><td style="padding:9px 16px;font-size:13px;color:#222;font-weight:bold;border-top:1px solid #efe7dd;">${esc(v)}</td></tr>`).join('')}
       </table>`
    : '';
  const imgBlock = hasCidImage
    ? `<div style="text-align:center;margin:24px 0;">
        <img src="cid:drawing" alt="Generated sauna drawing" style="max-width:100%;border-radius:10px;border:1px solid #e5ddd5;box-shadow:0 8px 24px rgba(139,94,60,0.15);" />
       </div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f2efeb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2efeb;">
<tr><td align="center" style="padding:40px 16px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

<tr><td style="background:#AF8564;height:5px;border-radius:10px 10px 0 0;font-size:1px;">&nbsp;</td></tr>
<tr><td style="background:#1a1a1a;padding:32px 36px;">
  <span style="font-size:11px;font-weight:bold;color:#AF8564;letter-spacing:3px;text-transform:uppercase;">SAWO CAD</span><br/>
  <span style="font-size:24px;font-weight:bold;color:#fff;line-height:1.3;">New Sauna Drawing Ready</span><br/>
  <span style="font-size:13px;color:#999;margin-top:8px;display:inline-block;">A client completed a sauna CAD conversation and sent it to sales.</span>
</td></tr>

<tr><td style="background:#fff;padding:32px 36px;">
  ${contactBlock}
  ${imgBlock}
  <p style="font-size:14px;color:#333;line-height:1.6;margin:0 0 24px;">
    A new sauna design has been generated and is ready for your review. Click the button below to view the full conversation, transcript, and drawing in the CMS.
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${permalink}" style="display:inline-block;background:#AF8564;color:#fff;font-size:14px;font-weight:bold;text-decoration:none;padding:14px 32px;border-radius:8px;letter-spacing:0.5px;">View Full Conversation</a>
  </div>
  <p style="font-size:12px;color:#999;text-align:center;margin:20px 0 0;">
    ${hasCidImage ? 'The drawing is also attached as image and PDF files for download.' : 'No drawing was generated in this session.'}
  </p>
</td></tr>

<tr><td style="background:#1a1a1a;padding:24px 36px;border-radius:0 0 10px 10px;">
  <span style="font-size:11px;color:#AF8564;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">SAWO, Inc.</span><br/>
  <span style="font-size:11px;color:#777;line-height:1.6;margin-top:6px;display:inline-block;">This email was automatically generated by the SAWO CAD CMS.</span>
</td></tr>

</table></td></tr></table></body></html>`;
}

export async function notifySales(sessionId) {
  const svc = serviceClient();
  const { data: settings } = await svc
    .from('settings')
    .select('sales_notification_email')
    .eq('id', 1)
    .maybeSingle();

  const recipient = settings?.sales_notification_email || null;
  const base = APP_URL || DEFAULT_APP_URL;
  const permalink = `${base}/cms/conversations/${sessionId}`;
  const subject = 'New sauna drawing ready for review';

  if (!recipient) {
    console.log('[notifySales] no sales_notification_email configured — not sent.');
    return {
      queued: false, sent: false, permalink, sessionId,
      error: 'No sales notification email is configured. Set one in CMS Settings (sales notification email).',
    };
  }

  let imageBytes = null;
  let conv = null;
  try {
    const { data } = await svc
      .from('cad_conversations')
      .select('image_url, client_name, client_email, client_phone, client_location')
      .eq('session_id', sessionId)
      .maybeSingle();
    conv = data;
    imageBytes = await fetchImageBytes(conv?.image_url);
  } catch (e) {
    console.error('[notifySales] image fetch failed:', e?.message || e);
  }

  const hasImage = !!imageBytes;
  const html = buildSalesEmailHtml(permalink, hasImage, conv);
  const attachments = [];

  if (imageBytes) {
    const { ext, mime } = sniffImageType(imageBytes);
    const imgB64 = imageBytes.toString('base64');

    // Inline copy for the email body (cid:drawing). Many clients (e.g. Outlook)
    // block embedded images by default, so this alone is not enough.
    attachments.push({
      filename: `drawing-inline.${ext}`,
      content_base64: imgB64,
      mime,
      cid: 'drawing',
    });
    // Real downloadable image attachment — always present even when the inline
    // copy is blocked. This is the file the previous version was missing.
    attachments.push({
      filename: `sawo-drawing.${ext}`,
      content_base64: imgB64,
      mime,
    });
    const pdfBytes = await buildPdfFromImage(imageBytes);
    if (pdfBytes) {
      attachments.push({
        filename: 'sawo-drawing.pdf',
        content_base64: pdfBytes.toString('base64'),
        mime: 'application/pdf',
      });
    }
  }

  try {
    await sendMailViaRelay({
      to: recipient, subject, message: html, html: true,
      attachments: attachments.length ? attachments : undefined,
    });
    return { queued: true, sent: true, recipient, permalink, sessionId };
  } catch (e) {
    console.error('[notifySales] send failed:', e?.message || e);
    return { queued: true, sent: false, recipient, error: e?.message || String(e), permalink, sessionId };
  }
}

// ── sendMailViaRelay — deliver mail through the WordPress wp_mail() relay ──
// The CMS has no SMTP of its own; instead it POSTs (server-to-server) to a small
// PHP endpoint on the WP site, which calls wp_mail(). The relay URL + shared
// secret are baked in here as defaults (so no admin config is needed); the
// `settings` table can still override them. The secret travels only in this
// server-side request header, never to the browser. NOTE: if you change the
// secret in the WordPress relay snippet, update MAIL_RELAY_SECRET below to match.
const MAIL_RELAY_URL = 'https://www.sawo.com/wp-json/sawo/v1/send-mail';
const MAIL_RELAY_SECRET = 'sawo_relay_0f11023f7f3288bbe1978eff57ce0e8b62c89575978aa168';

export async function sendMailViaRelay({ to, subject, message, html = false, attachments }) {
  const svc = serviceClient();
  const { data: s } = await svc
    .from('settings')
    .select('mail_relay_url, mail_relay_secret')
    .eq('id', 1)
    .maybeSingle();
  const url = s?.mail_relay_url || MAIL_RELAY_URL;
  const secret = s?.mail_relay_secret || MAIL_RELAY_SECRET;

  const payload = { to, subject, message, html };
  if (attachments?.length) payload.attachments = attachments;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sawo-secret': secret },
      body: JSON.stringify(payload),
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
