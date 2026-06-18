-- ═══════════════════════════════════════════════════════════════════════
-- SAWO CAD CMS — Supabase migration
-- Run this ONCE in the SQL editor of the app's Supabase project
-- (ref: jhymuevfcrqofyqtbkrs). Server functions use the service-role key and
-- bypass RLS; no anon policies are added (the anon key is used only for Auth).
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Extend the existing conversation table for the sales handoff ----------
alter table public.cad_conversations
  add column if not exists sent_to_sales boolean not null default false,
  add column if not exists sent_to_sales_at timestamptz;

-- 2. Profiles — role lives here (Supabase Auth carries no custom role) ------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','sales')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3. Settings — single row (id = 1), managed from the admin Settings page ---
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  openrouter_api_key text,
  chat_model text default 'anthropic/claude-opus-4.6',
  image_model text default 'google/gemini-3-pro-image-preview',
  image_size text default '2K',
  image_aspect_ratio text default '16:9',
  sales_notification_email text,
  mail_smtp_host text,
  mail_smtp_port text,
  mail_smtp_user text,
  mail_smtp_pass text,
  mail_from_address text,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- 4. Lock down RLS: enable + drop the old open policies ---------------------
--    (no new anon policies — all access is server-side via the service role)
alter table public.cad_conversations enable row level security;
alter table public.profiles          enable row level security;
alter table public.settings          enable row level security;

drop policy if exists "anon read" on public.cad_conversations;
-- If the old client-side logSession upsert relied on an open INSERT/UPDATE
-- policy, drop it too. Inspect existing policies first with:
--   select policyname, cmd, roles from pg_policies where tablename = 'cad_conversations';
-- then drop any that grant anon/public write, e.g.:
--   drop policy if exists "anon insert" on public.cad_conversations;
--   drop policy if exists "anon update" on public.cad_conversations;

-- 5. AFTER migrating: store the ROTATED OpenRouter key (via the admin
--    Settings page, or here). Replace the placeholder below.
-- update public.settings set openrouter_api_key = 'sk-or-v1-NEW-ROTATED-KEY' where id = 1;
