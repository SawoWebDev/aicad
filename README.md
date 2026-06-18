# SAWO CAD CMS

Role-based CMS + secure API layer for the SAWO sauna CAD generator. Plain HTML +
vanilla JS with Node serverless functions — **no build step**. Deploys to Vercel as-is.

- **Sales** — view conversation logs.
- **Admin** — logs + user management + settings (OpenRouter key/model config, sales email).
- **Public API** — server-side OpenRouter proxy + conversation logging used by the
  standalone generator (`conversation.html`), so the OpenRouter key never reaches the browser.

## Deploy on Vercel

1. Import this repo in Vercel (framework preset: **Other** — no build).
2. Set environment variables (Project → Settings → Environment Variables):

   | Var | Value |
   |-----|-------|
   | `SUPABASE_URL` | `https://jhymuevfcrqofyqtbkrs.supabase.co` |
   | `SUPABASE_ANON_KEY` | Supabase anon (JWT) key — server-side, Auth only |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role (JWT) key — server-only, never shipped |
   | `APP_URL` | the deployed CMS URL, e.g. `https://aicad.vercel.app` |

3. Run [`migration.sql`](migration.sql) once in the Supabase SQL editor.
4. Visit the deployment → **Create User** (first admin) → reload → **Login**.
5. In the admin **Settings** page, store the (rotated) OpenRouter key.

## Local dev

```bash
npm install
npx vercel dev   # reads .env.local
```

See [SETUP-NOTES.md](SETUP-NOTES.md) for the bootstrap behavior, routes, and operations notes.

> The OpenRouter API key is **not** an env var — it lives in the `settings` table and is
> edited from the admin Settings page.
