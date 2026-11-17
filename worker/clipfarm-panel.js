// ClipFarm — панель на Cloudflare Workers.
// Секреты воркера: GH_PAT (доступ к репо: Actions + Contents), GH_REPO ("owner/clipfarm"), PANEL_PASS (пароль панели)
//
// Клипы лежат в GitHub-релизе "clips":
//   <tag>.mp4        — новый, ждёт решения
//   ok_<tag>.mp4     — одобрен (отсюда потом заберёт автопостинг)
//   ❌               — удаляется

const WF = 'clip.yml';

const gh = (env, path, init = {}) => fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
  ...init,
  headers: {
    Authorization: `Bearer ${env.GH_PAT}`, Accept: 'application/vnd.github+json',
    'User-Agent': 'clipfarm-panel', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}),
  },
});

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('clipfarm:' + s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function channelFrom(s) {
  s = String(s || '').trim();
  const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{3,25})/);
  const n = (m ? m[1] : s.replace(/^@/, ''));
  return /^[A-Za-z0-9_]{3,25}$/.test(n) ? n.toLowerCase() : null;
}

async function state(env) {
  const [runsR, relR] = await Promise.all([
    gh(env, `/actions/workflows/${WF}/runs?per_page=30`),
    gh(env, '/releases/tags/clips'),
  ]);
  const runs = runsR.ok ? (await runsR.json()).workflow_runs : [];
  const active = runs.filter(r => r.status !== 'completed').map(r => ({
    id: r.id, title: r.display_title, status: r.status, url: r.html_url, started: r.run_started_at,
  }));
  const recent = runs.filter(r => r.status === 'completed').slice(0, 5).map(r => ({
    id: r.id, title: r.display_title, conclusion: r.conclusion, url: r.html_url, ended: r.updated_at,
  }));
  let assets = [];
  if (relR.ok) {
    // в релизе может быть много файлов — дочитываем страницы
    const rel = await relR.json();
    assets = rel.assets || [];
    for (let page = 2; assets.length === (page - 1) * 100 && page < 10; page++) {
      const r = await gh(env, `/releases/${rel.id}/assets?per_page=100&page=${page}`);
      if (!r.ok) break;
      const more = await r.json(); if (!more.length) break; assets.push(...more);
    }
  }
  const clips = assets.filter(a => a.name.endsWith('.mp4'))
    .map(a => ({ id: a.id, name: a.name, label: a.label || '', size: a.size, created: a.created_at }))
    .sort((a, b) => b.created.localeCompare(a.created));
  return {
    active, recent,
    fresh: clips.filter(c => !c.name.startsWith('ok_')),
    approved: clips.filter(c => c.name.startsWith('ok_')),
    repo: env.GH_REPO,
  };
}

async function video(env, id, req) {
  // проксируем видео: GitHub отдаёт его как "скачать файл", а нам нужен video/mp4 с перемоткой
  const headers = { Accept: 'application/octet-stream' };
  const range = req.headers.get('Range');
  if (range) headers.Range = range;
  const r = await gh(env, `/releases/assets/${id}`, { headers });
  const h = new Headers();
  h.set('Content-Type', 'video/mp4');
  h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', 'private, max-age=3600');
  for (const k of ['Content-Length', 'Content-Range']) if (r.headers.get(k)) h.set(k, r.headers.get(k));
  return new Response(r.body, { status: r.status, headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const token = await sha(env.PANEL_PASS || '');
    const authed = (req.headers.get('Cookie') || '').includes(`cf_auth=${token}`);

    if (url.pathname === '/login' && req.method === 'POST') {
      const f = await req.formData();
      if (env.PANEL_PASS && f.get('pass') === env.PANEL_PASS) {
        return new Response(null, { status: 302, headers: {
          Location: '/', 'Set-Cookie': `cf_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` } });
      }
      return new Response(LOGIN.replace('<!--err-->', '<p class="err">Неверный пароль</p>'),
        { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (!authed) {
      if (url.pathname.startsWith('/api') || url.pathname.startsWith('/v/')) return json({ error: 'auth' }, 401);
      return new Response(LOGIN, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/') return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname.startsWith('/v/')) return video(env, url.pathname.slice(3).replace(/\D/g, ''), req);
    if (url.pathname === '/api/state') return json(await state(env));

    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (url.pathname === '/api/start') {
        const ch = channelFrom(b.url);
        if (!ch) return json({ error: 'Не понял ссылку. Пример: twitch.tv/shadowkekw' }, 400);
        const r = await gh(env, `/actions/workflows/${WF}/dispatches`, { method: 'POST',
          body: JSON.stringify({ ref: 'main', inputs: { channel: ch, model: b.model || 'medium', mult: String(b.mult || '2.5'), part: '1' } }) });
        return r.status === 204 ? json({ ok: true, channel: ch })
          : json({ error: `GitHub ответил ${r.status}: ${(await r.text()).slice(0, 200)}` }, 500);
      }
      if (url.pathname === '/api/stop') {
        const r = await gh(env, `/actions/runs/${Number(b.id)}/cancel`, { method: 'POST' });
        return json({ ok: r.status === 202 });
      }
      if (url.pathname === '/api/decide') {
        const id = Number(b.id), name = String(b.name || '');
        if (b.post) {
          const r = await gh(env, `/releases/assets/${id}`, { method: 'PATCH',
            body: JSON.stringify({ name: name.startsWith('ok_') ? name : 'ok_' + name, label: b.label || '' }) });
          return json({ ok: r.ok });
        }
        const r = await gh(env, `/releases/assets/${id}`, { method: 'DELETE' });
        return json({ ok: r.status === 204 });
      }
    }
    return json({ error: '404' }, 404);
  },
};

const CSS = `:root{--bg:#0e0f13;--card:#181a21;--line:#262934;--txt:#e9eaf0;--mut:#8b8fa3;--acc:#9146ff;--ok:#22c55e;--no:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.4 -apple-system,system-ui,sans-serif}
input,select{background:var(--card);border:1px solid var(--line);color:var(--txt);padding:10px 12px;border-radius:10px;font-size:14px}
button{border:0;border-radius:10px;padding:10px 14px;font-weight:600;font-size:14px;cursor:pointer;color:#fff;background:#2a2d38;white-space:nowrap}
button:hover{filter:brightness(1.15)}button:disabled{opacity:.5;cursor:default}.go{background:var(--acc)}.ok{background:var(--ok)}.no{background:var(--no)}
.err{color:var(--no)}a{color:#b794ff}`;

const LOGIN = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClipFarm</title><style>${CSS}
form{max-width:320px;margin:18vh auto;display:flex;flex-direction:column;gap:12px;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:16px}
h1{margin:0 0 6px;font-size:22px}h1 b{color:var(--acc)}</style></head><body>
<form method="post" action="/login"><h1>Clip<b>Farm</b></h1><input type="password" name="pass" placeholder="Пароль" autofocus>
<button class="go">Войти</button><!--err--></form></body></html>`;

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ClipFarm</title><style>${CSS}
header{position:sticky;top:0;z-index:5;background:rgba(14,15,19,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:12px 18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0 10px 0 0}h1 b{color:var(--acc)}#url{flex:1;min-width:220px;max-width:380px}
main{padding:16px 18px}h2{font-size:15px;margin:22px 0 12px;color:var(--mut);font-weight:600;display:flex;gap:10px;align-items:center}
.runs{display:flex;flex-direction:column;gap:8px}
.run{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:10px}
.run b{flex:1}.dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}.q .dot{background:#eab308;box-shadow:0 0 8px #eab308}
.mut{color:var(--mut);font-size:12.5px}
.tabs{display:flex;gap:6px}.tabs button{background:transparent;color:var(--mut);padding:6px 10px}.tabs button.on{background:#2a2d38;color:var(--txt)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.clip{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
video{width:100%;aspect-ratio:9/16;background:#000;display:block}
.meta{padding:8px 10px;font-size:12px;color:var(--mut);flex:1}.meta b{color:var(--txt);display:block;font-size:12.5px;word-break:break-all}
.act{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 10px 10px}.act.one{grid-template-columns:1fr}
.act button{padding:10px 6px}
.empty{color:var(--mut);padding:30px;text-align:center;border:1px dashed var(--line);border-radius:14px;grid-column:1/-1}
#err{margin-left:4px}
</style></head><body>
<header>
  <h1>Clip<b>Farm</b></h1>
  <input id="url" placeholder="https://twitch.tv/shadowkekw">
  <select id="model" title="Субтитры"><option value="medium">Субтитры: точные (medium)</option><option value="large-v3-turbo">Самые точные (turbo, медленнее)</option><option value="small">Быстрые (small)</option></select>
  <select id="mult" title="Чувствительность"><option value="2.5">Порог 2.5×</option><option value="2">2× (больше клипов)</option><option value="3.5">3.5× (меньше клипов)</option></select>
  <button class="go" id="go" onclick="startCh()">▶ Запустить</button><span id="err" class="err"></span>
</header>
<main>
  <h2>Сейчас режется</h2>
  <div class="runs" id="runs"></div>
  <h2><span class="tabs"><button id="t-fresh" class="on" onclick="tab('fresh')">Новые</button><button id="t-approved" onclick="tab('approved')">Одобренные</button></span></h2>
  <div class="grid" id="grid"></div>
</main>
<script>
const $=id=>document.getElementById(id);
const api=(p,b)=>fetch(p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}).then(r=>{if(r.status===401)location.reload();return r.json()});
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let S=null, TAB='fresh';
$('url').addEventListener('keydown',e=>{if(e.key==='Enter')startCh()});
async function startCh(){
  $('err').textContent='';$('go').disabled=true;
  const r=await api('/api/start',{url:$('url').value,model:$('model').value,mult:$('mult').value});
  $('go').disabled=false;
  if(r.error)$('err').textContent=r.error;else{$('url').value='';setTimeout(refresh,3000)}
}
async function stopRun(id,btn){btn.disabled=true;btn.textContent='останавливаю…';await api('/api/stop',{id});setTimeout(refresh,3000)}
function tab(t){TAB=t;$('t-fresh').className=t==='fresh'?'on':'';$('t-approved').className=t==='approved'?'on':'';$('grid').innerHTML='';render()}
async function decide(c,post){
  const el=document.querySelector('[data-id="'+c.id+'"]');if(el){el.querySelector('video').pause();el.remove()}
  await api('/api/decide',{id:c.id,name:c.name,label:c.label,post});refresh();
}
const ago=t=>{const m=Math.round((Date.now()-new Date(t))/60000);return m<60?m+' мин':Math.floor(m/60)+' ч '+(m%60)+' мин'};
function render(){
  if(!S)return;
  $('runs').innerHTML=S.active.length?S.active.map(r=>\`
    <div class="run \${r.status==='in_progress'?'':'q'}"><span class="dot"></span><b>\${esc(r.title)}</b>
    <span class="mut">\${r.status==='in_progress'?'идёт '+ago(r.started):'в очереди'}</span>
    <a href="\${r.url}" target="_blank">лог</a>
    <button class="no" onclick="stopRun(\${r.id},this)">■ Стоп</button></div>\`).join('')
    :'<div class="mut">Ничего не запущено. Вставь ссылку на стрим и нажми ▶</div>'+(S.recent.length?'<div class="mut" style="margin-top:6px">Последние: '+S.recent.map(r=>\`<a href="\${r.url}" target="_blank">\${esc(r.title)}</a> \${r.conclusion==='success'?'✅':r.conclusion==='cancelled'?'■':'⚠️'}\`).join(' · ')+'</div>':'');
  $('t-fresh').textContent='Новые ('+S.fresh.length+')';$('t-approved').textContent='Одобренные ('+S.approved.length+')';
  const list=S[TAB], grid=$('grid');
  const want=new Set(list.map(c=>String(c.id)));
  [...grid.children].forEach(e=>{if(e.dataset.id&&!want.has(e.dataset.id))e.remove()});
  const have=new Set([...grid.children].map(e=>e.dataset.id));
  if(!list.length){grid.innerHTML='<div class="empty">'+(TAB==='fresh'?'Новых клипов нет. Они появятся здесь после всплесков чата.':'Пока ничего не одобрено.')+'</div>';return}
  grid.querySelector('.empty')?.remove();
  list.slice().reverse().forEach(c=>{
    if(have.has(String(c.id)))return;
    const d=document.createElement('div');d.className='clip';d.dataset.id=c.id;
    d.innerHTML=\`<video src="/v/\${c.id}" controls preload="metadata" playsinline></video>
      <div class="meta"><b>\${esc(c.name.replace(/^ok_/,'').replace('.mp4',''))}</b>\${esc(c.label)}<br>\${(c.size/1048576).toFixed(1)} МБ · \${ago(c.created)} назад</div>
      <div class="act \${TAB==='approved'?'one':''}">\${TAB==='fresh'?'<button class="ok">✅ Постить</button>':''}<button class="no">\${TAB==='fresh'?'❌ Нет':'🗑 Удалить'}</button></div>\`;
    d.querySelector('.ok')?.addEventListener('click',()=>decide(c,true));
    d.querySelector('.no').addEventListener('click',()=>decide(c,false));
    grid.prepend(d);
  });
}
async function refresh(){S=await api('/api/state');render()}
refresh();setInterval(refresh,10000);
</script></body></html>`;
