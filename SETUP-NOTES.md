# SAWO CAD CMS — Setup & Operations Notes

This `vercel/` folder is the **CMS** — a separate deployment from the public
generator (`../conversation.html`). It provides login, conversation logs (Sales),
user management + settings (Admin), conversation permalinks, and the server-side
OpenRouter proxy. Plain HTML + vanilla JS + Node serverless functions; no build step.

---

## 1. First-run bootstrap (READ THIS) — create-user → login auto-switch

> **Login is by USERNAME + password.** The email collected at user creation is used
> only for password reset (the "Forgot password?" link). Each profile has a unique,
> case-insensitive `username`.

There is no user on a fresh deploy, so the landing page adapts itself:

- **While zero users exist**, opening `/` shows a **Create User** form (username, email,
  password + confirm). Submitting it creates the first **admin** (Supabase Auth user +
  `profiles` row with the username) and logs you in.
- **Once at least one user exists**, `/` automatically shows the normal **Login** form,
  and the setup endpoint (`/api/auth?action=setup`) refuses with 403. This switch is
  automatic — there is nothing to flip by hand.
- Create the rest of your users (sales + more admins) from the authenticated admin
  **Users** tab, not from the landing page.

So the order the team experiences:
1. Deploy → visit `/` → **Create first admin** → you're in.
2. Reload `/` later → it's now the **Login** page.

> If you ever need to re-open create-user (e.g. you deleted all users), it re-enables
> itself automatically whenever the user count is back to zero. To hard-disable it
> permanently, remove the `setup` branch in `api/auth.js`.

CLI alternative to the landing-page bootstrap: `npm run seed -- admin@sawo.com 'pw'`
(see `scripts/seed-admin.js`).

---

## 2. Environment variables

Set these in the Vercel project (and `.env.local` for `vercel dev`). See `.env.example`.

| Var | Where used | Notes |
|-----|------------|-------|
| `SUPABASE_URL` | server | Project URL (`https://jhymuevfcrqofyqtbkrs.supabase.co`). |
| `SUPABASE_ANON_KEY` | server (auth.js only) | For Supabase Auth sign-in. Never sent to the browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Full DB access, bypasses RLS. **Never** ship to the browser. |
| `APP_URL` | server | This CMS's public URL; used to build conversation permalinks. |

The **OpenRouter API key is NOT an env var** — it lives in the `settings` table and is
edited from the admin **Settings** page.

---

## 3. Database migration

Run `migration.sql` once in the Supabase SQL editor of project `jhymuevfcrqofyqtbkrs`.
It extends `cad_conversations` (`sent_to_sales`, `sent_to_sales_at`), creates `profiles`
(now including a unique `username`) and `settings`, enables RLS, and drops the old open
`anon read` policy. After migrating, store the **rotated** OpenRouter key via the Settings page.

> **If you already ran the earlier migration** (no `username` column), run this increment:
> ```sql
> alter table public.profiles add column if not exists username text;
> create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));
> -- Any admin created before usernames existed has none yet → give it one so it can log in:
> update public.profiles set username = 'admin' where username is null;
> ```
> Adjust `'admin'` to the username you want. (Login is by username now.)

> NOTE: this Supabase project is not reachable from the assistant's Supabase MCP
> connection, so the migration/seed must be applied manually (or grant MCP access).

---

## 4. ⚠️ Rotate the leaked OpenRouter key

The previous key was hardcoded in `../config.js` and the old `aicad.html`/`conversation.html`
and pasted into chat. Treat it as compromised: **rotate it on https://openrouter.ai/keys**
and put the new key only in the `settings` table (Settings page). Do not commit keys.

---

## 5. Pointing the public generator at the CMS

`../conversation.html` calls this app's public endpoints (`/api/openrouter`,
`/api/conversations`). If the generator is hosted on a different origin, set the
`API_BASE` constant near the top of its script to this CMS's URL
(e.g. `https://sawo-cad-cms.vercel.app`). Same-origin → leave it `''`.

---

## 6. Routes & access

| Route | Who | Notes |
|-------|-----|-------|
| `/` `/login` | public | Login, or first-run Create-User. |
| `/app` | authenticated | Shell; hosts the role frame. Edge middleware redirects anon → login. |
| `/cms/conversations/:id` | authenticated | Permalink; deep-links a session in the logs frame. |
| `sales.html` frame | sales + admin | Conversation logs viewer. |
| `admin.html` frame | admin only | Users + Settings. Enforced by `api/admin.js` (403 for sales). |
| `/api/openrouter`, `/api/conversations?action=log|sendToSales` | public | Used by the generator; key stays server-side. |

Role enforcement is server-side at the API layer; the edge `middleware.js` only does
the unauthenticated→login redirect.
