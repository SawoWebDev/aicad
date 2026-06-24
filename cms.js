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
  // ── Usage-analytics formatting + model/provider badges ─────────────────────
  // Shared by the admin Usage Analytics dashboard and the per-conversation
  // Analytics drawer so both render money/tokens/badges identically.
  const money    = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money4   = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  // Full per-call cost — keeps tiny costs precise (e.g. $0.0000715) instead of
  // rounding to $0.0001, matching OpenRouter's activity view.
  const costFull = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 7 });
  const compact  = (n) => {
    n = Number(n) || 0;
    if(n >= 1e9) return (n/1e9).toFixed(2).replace(/\.?0+$/,'') + 'B';
    if(n >= 1e6) return (n/1e6).toFixed(2).replace(/\.?0+$/,'') + 'M';
    if(n >= 1e3) return (n/1e3).toFixed(1).replace(/\.?0+$/,'') + 'K';
    return String(n);
  };
  const shortModel = (m) => String(m || '').split('/').pop();
  const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-US');
  const fmtMs  = (n) => (n == null || n === '') ? '—' : fmtInt(Math.round(n)) + 'ms';

  // ── Model color identity: known patterns first, deterministic fallback after ──
  const COLOR_RULES = [
    [/claude-opus/i, '#A855F7'], [/claude-sonnet/i, '#8B5CF6'], [/claude-haiku/i, '#EC4899'],
    [/gemini.*image/i, '#0EA5E9'], [/gemini[-.]?3|gemini.*pro/i, '#3B82F6'], [/gemini.*flash/i, '#06B6D4'],
    [/deepseek/i, '#92400E'], [/tencent|hy3/i, '#F97316'], [/gpt|openai/i, '#22C55E'],
  ];
  const FALLBACK = ['#84CC16','#EAB308','#EF4444','#F59E0B','#64748B','#14B8A6','#D946EF','#0891B2','#7C3AED','#DB2777'];
  const _colorCache = {};
  function colorFor(slug){
    slug = slug || 'unknown';
    if(_colorCache[slug]) return _colorCache[slug];
    let c = null;
    for(const [re, col] of COLOR_RULES){ if(re.test(slug)){ c = col; break; } }
    if(!c){ let h = 0; for(let i = 0; i < slug.length; i++){ h = (h * 31 + slug.charCodeAt(i)) >>> 0; } c = FALLBACK[h % FALLBACK.length]; }
    return (_colorCache[slug] = c);
  }
  function modelBadge(slug){ return '<span class="mbadge"><span class="dot" style="background:' + colorFor(slug) + '"></span>' + esc(shortModel(slug)) + '</span>'; }
  function providerBadge(name){ if(!name) return '<span style="color:var(--text-dim)">—</span>'; return '<span class="mbadge"><span class="dot" style="background:' + colorFor('prov:' + name) + '"></span>' + esc(name) + '</span>'; }
  const PHASE_LABEL = { converse:'Gather', analyze:'Finalize', image:'Image', other:'Other' };
  // Throughput proxy: output tokens / round-trip seconds (we measure total latency,
  // so this trends a bit under OpenRouter's generation-time figure but is comparable).
  function speedFor(r){ const lat = Number(r.latency_ms); const out = Number(r.completion_tokens) || 0; if(!lat || lat <= 0) return null; return out / (lat / 1000); }

  return {
    esc, fmt, session, get, send, logout, toast,
    money, money4, costFull, compact, shortModel, fmtInt, fmtMs,
    colorFor, modelBadge, providerBadge, speedFor, PHASE_LABEL,
  };
})();
