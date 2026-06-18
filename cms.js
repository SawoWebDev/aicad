// ─────────────────────────────────────────────────────────────────────────
// Shared client helpers for the SAWO CAD CMS pages (app / sales / admin).
// No secrets here — all data goes through the role-guarded /api endpoints.
// ─────────────────────────────────────────────────────────────────────────
window.CMS = (function(){
  function esc(s){
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmt(ts){
    if(!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? ts : d.toLocaleString();
  }
  async function session(){
    try{ return await fetch('/api/auth?action=session').then(r=>r.json()); }
    catch(e){ return { authenticated:false }; }
  }
  // GET JSON; throws Error(message) on non-2xx (incl. 401/403 from the guards).
  async function get(url){
    const r = await fetch(url, { headers:{ 'Accept':'application/json' } });
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }
  async function send(method, url, body){
    const r = await fetch(url, {
      method,
      headers:{ 'Content-Type':'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }
  async function logout(){
    try{ await fetch('/api/auth?action=logout', { method:'POST' }); }catch(e){}
    location.replace('/login');
  }
  return { esc, fmt, session, get, send, logout };
})();
