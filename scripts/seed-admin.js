// ─────────────────────────────────────────────────────────────────────────
// seed-admin.js — CLI alternative to the first-run "Create User" landing.
//
// Creates one Supabase Auth user + a matching admin profile, using the
// service-role key. Run locally (NEVER ship the service key to the browser):
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/seed-admin.js admin@sawo.com 'StrongPassw0rd'
//
// On Windows PowerShell:
//   $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="...";
//   node scripts/seed-admin.js admin@sawo.com "StrongPassw0rd"
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';

const [, , email, password, roleArg] = process.argv;
const role = roleArg || 'admin';

if (!email || !password) {
  console.error('Usage: node scripts/seed-admin.js <email> <password> [admin|sales]');
  process.exit(1);
}
if (!['admin', 'sales'].includes(role)) {
  console.error('role must be admin or sales');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.');
  process.exit(1);
}

const svc = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
if (error || !data?.user) {
  console.error('Failed to create auth user:', error?.message || 'unknown error');
  process.exit(1);
}

const { error: pErr } = await svc.from('profiles').insert({ id: data.user.id, role, active: true });
if (pErr) {
  await svc.auth.admin.deleteUser(data.user.id);
  console.error('Failed to create profile (rolled back auth user):', pErr.message);
  process.exit(1);
}

console.log(`✓ Created ${role} user: ${email} (id ${data.user.id})`);
