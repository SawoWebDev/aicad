// ─────────────────────────────────────────────────────────────────────────
// Local dev server (no Vercel needed). Runs the same /api functions, static
// pages, clean URLs, and the auth-redirect that Vercel does in production.
//
//   npm start         → http://localhost:3000
//
// On Vercel this file is ignored (see .vercelignore); the platform runs the
// api/*.js as serverless functions and middleware.js as edge middleware. This
// server just emulates that locally so you can test before deploying.
// ─────────────────────────────────────────────────────────────────────────
import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env the same way vercel dev would: .env.local first, then .env.
dotenv.config({ path: join(__dirname, '.env.local') });
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
// Image/chat payloads can be sizeable; give the body parser generous headroom.
app.use(express.json({ limit: '25mb' }));

// ── Mount each Vercel function at /api/<name> (all HTTP methods) ──
async function mount(route, file) {
  const mod = await import('./api/' + file);
  app.all(route, (req, res) => Promise.resolve(mod.default(req, res)).catch((e) => {
    console.error(`[${route}]`, e);
    if (!res.headersSent) res.status(500).json({ error: e?.message || 'Server error' });
  }));
}
await mount('/api/auth', 'auth.js');
await mount('/api/conversations', 'conversations.js');
await mount('/api/openrouter', 'openrouter.js');
await mount('/api/admin', 'admin.js');

// ── Same auth gate as middleware.js: unauthenticated shell/permalink → login ──
function authGate(req, res, next) {
  const hasSession = /(?:^|;\s*)sb-access-token=/.test(req.headers.cookie || '');
  if (!hasSession) {
    return res.redirect(302, '/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

// ── Clean-URL routes / rewrites (mirror vercel.json) ──
app.get('/', (req, res) => res.sendFile(join(__dirname, 'login.html')));
app.get('/login', (req, res) => res.sendFile(join(__dirname, 'login.html')));
app.get('/app', authGate, (req, res) => res.sendFile(join(__dirname, 'app.html')));
app.get('/cms/conversations/:id', authGate, (req, res) =>
  res.redirect(302, '/app?conversation=' + encodeURIComponent(req.params.id)));

// ── Everything else: static files (cms.js, sales.html, admin.html, …) ──
// dotfiles like .env.local are ignored by default, so they are never served.
app.use(express.static(__dirname, { extensions: ['html'] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  SAWO CAD CMS (local)  →  http://localhost:${PORT}\n`);
});
