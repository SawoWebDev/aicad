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
  function toast(message, type){
    type = type || 'ok';
    var ctr = document.getElementById('cms-toast-ctr');
    if(!ctr){
      ctr = document.createElement('div'); ctr.id = 'cms-toast-ctr';
      var s = ctr.style;
      s.position='fixed'; s.top='18px'; s.right='18px'; s.zIndex='99999';
      s.display='flex'; s.flexDirection='column'; s.gap='8px'; s.pointerEvents='none';
      document.body.appendChild(ctr);
      var st = document.createElement('style');
      st.textContent =
        '#cms-toast-ctr .cms-toast{pointer-events:auto;font-family:Montserrat,sans-serif;font-size:.82rem;font-weight:600;padding:11px 18px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.12);opacity:0;transform:translateX(30px);transition:opacity .3s,transform .3s;}'+
        '#cms-toast-ctr .cms-toast.show{opacity:1;transform:translateX(0);}'+
        '#cms-toast-ctr .cms-toast.ok{background:#fff;color:#4A9D4A;border-left:4px solid #4A9D4A;}'+
        '#cms-toast-ctr .cms-toast.err{background:#fff;color:#C9302C;border-left:4px solid #C9302C;}';
      document.head.appendChild(st);
    }
    var t = document.createElement('div');
    t.className = 'cms-toast ' + type;
    t.textContent = message;
    ctr.appendChild(t);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ t.classList.add('show'); }); });
    setTimeout(function(){
      t.classList.remove('show');
      setTimeout(function(){ t.remove(); }, 350);
    }, 2500);
  }
  return { esc, fmt, session, get, send, logout, toast };
})();
