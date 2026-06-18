// ─────────────────────────────────────────────────────────────────────────
// Vercel Edge Middleware — authentication gate for CMS page routes.
//
// This is a CHEAP presence check on the session cookie that redirects clearly
// unauthenticated visitors to the login page before any CMS HTML is served.
// It is NOT the security boundary on its own — hard role/identity enforcement
// happens in the API layer (api/_lib.js -> requireSession / requireRole), which
// re-validates the token against Supabase and looks up the role on every data
// call. A user with a stale/forged cookie that slips past this gate still gets a
// non-functional shell because every API call returns 401/403.
// ─────────────────────────────────────────────────────────────────────────

export const config = {
  // Guard the authenticated shell + permalink routes. Public routes
  // (/, /login, /api/*, static assets) are intentionally excluded.
  matcher: ['/app', '/cms/:path*'],
};

export default function middleware(request) {
  const cookie = request.headers.get('cookie') || '';
  const hasSession = /(?:^|;\s*)sb-access-token=/.test(cookie);

  if (!hasSession) {
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', target);
    return Response.redirect(loginUrl, 302);
  }
  // Authenticated enough to proceed; let the request continue.
  return undefined;
}
