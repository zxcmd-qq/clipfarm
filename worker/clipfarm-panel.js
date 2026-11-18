// ClipFarm — панель + автопостинг на Cloudflare Workers.
//
// Переменные/секреты воркера:
//   GH_REPO        "zxcmd-qq/clipfarm"
//   GH_PAT         токен GitHub на это репо (Actions + Contents: Read and write)
//   USERS          JSON с паролями: {"tim":"пароль1","kent":"пароль2"}  (старый PANEL_PASS = пароль для tim)
//   YT_CLIENT_ID, YT_CLIENT_SECRET   OAuth-клиент Google (проект ClipFarm)
//   TT_CLIENT_KEY, TT_CLIENT_SECRET  приложение TikTok
//   GEMINI_KEY     (необязательно) — заголовки и хештеги
//   TG_BOT_TOKEN   (необязательно) — бот ClipFarm: шлёт описание после каждой публикации
// Привязка KV: KV  — здесь хранятся подключённые аккаунты и журнал публикаций.
// Cron (Triggers): 5 раз в день, напр. "0 7,10,13,16,19 * * *" (UTC) — по 1 клипу каждому пользователю.
//
// Клипы в GitHub-релизе "clips":  <user>__<tag>.mp4 → ✅ ok_<user>__<tag>.mp4 → опубликован done_<user>__<tag>.mp4

const WF = 'clip.yml';
const BASE = 'https://clipfarm.osttima.workers.dev';

// ---------------------------------------------------------------- helpers
const gh = (env, path, init = {}) => fetch(path.startsWith('http') ? path : `https://api.github.com/repos/${env.GH_REPO}${path}`, {
  ...init,
  headers: {
    Authorization: `Bearer ${env.GH_PAT}`, Accept: 'application/vnd.github+json',
    'User-Agent': 'clipfarm-panel', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}),
  },
});
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const html = (s, status = 200, headers = {}) => new Response(s, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

function users(env) {
  try { if (env.USERS) return JSON.parse(env.USERS); } catch (e) {}
  return env.PANEL_PASS ? { tim: env.PANEL_PASS } : {};
}
const firstUser = env => Object.keys(users(env))[0] || 'tim';

// постоянный секрет подписи (в KV), чтобы смена USERS/токенов не разлогинивала всех
let SECRET = null;
async function secret(env) {
  if (SECRET) return SECRET;
  if (!env.KV) return (SECRET = 'cf:' + (env.GH_PAT || ''));
  let v = await env.KV.get('secret:hmac');
  if (!v) { v = crypto.randomUUID() + crypto.randomUUID(); await env.KV.put('secret:hmac', v); }
  return (SECRET = v);
}
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(await secret(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
// учётки: id пользователя (tim, kent…) не меняется; логин и пароль можно сменить в настройках
const cred = (env, id) => kvGet(env, `cred:${id}`);
async function checkLogin(env, login, pass) {
  login = String(login || '').trim().toLowerCase();
  const id = env.KV ? await env.KV.get(`login:${login}`) : null;
  if (id) {
    const c = await cred(env, id);
    return c && c.hash === await sha(c.salt + ':' + pass) ? id : null;
  }
  // ещё не менял логин/пароль — берём из секрета USERS
  if (users(env)[login] && !(await cred(env, login)) && users(env)[login] === pass) return login;
  return null;
}
const cookieFor = async (env, id) => {
  const c = await cred(env, id);
  return `cf_auth=${id}.${await hmac(env, 'u:' + id + ':' + (c?.v || 0))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
};
async function whoami(env, req) {
  const m = (req.headers.get('Cookie') || '').match(/cf_auth=([a-z0-9_]+)\.([0-9a-f]{32})/);
  if (!m || !users(env)[m[1]]) return null;
  const c = await cred(env, m[1]);
  return (await hmac(env, 'u:' + m[1] + ':' + (c?.v || 0))) === m[2] ? m[1] : null;
}
async function changeAccount(env, me, b) {
  if (!env.KV) return { error: 'Нет KV' };
  const c = await cred(env, me);
  const curLogin = c?.login || me;
  if (!(await checkLogin(env, curLogin, b.current || ''))) return { error: 'Текущий пароль неверный' };
  const login = String(b.login || curLogin).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,24}$/.test(login)) return { error: 'Логин: 3–24 символа, латиница, цифры, _ . -' };
  const other = await env.KV.get(`login:${login}`);
  if ((other && other !== me) || (users(env)[login] && login !== me)) return { error: 'Такой логин уже занят' };
  const pass = b.password ? String(b.password) : null;
  if (pass !== null && pass.length < 6) return { error: 'Пароль — минимум 6 символов' };
  const salt = c?.salt && !pass ? c.salt : crypto.randomUUID();
  const hash = pass ? await sha(salt + ':' + pass) : (c?.hash || await sha(salt + ':' + (b.current || '')));
  if (c?.login && c.login !== login) await env.KV.delete(`login:${c.login}`);
  await env.KV.put(`login:${login}`, me);
  await kvPut(env, `cred:${me}`, { login, salt, hash, v: (c?.v || 0) + 1 });
  return { ok: true, login };
}

function channelFrom(s) {
  s = String(s || '').trim();
  const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{3,25})/);
  const n = (m ? m[1] : s.replace(/^@/, ''));
  return /^[A-Za-z0-9_]{3,25}$/.test(n) ? n.toLowerCase() : null;
}

// имя файла → {stage, owner, base, streamer}
function parseName(env, name) {
  const stage = name.startsWith('ok_') ? 'approved' : name.startsWith('done_') ? 'posted' : 'fresh';
  const base = name.replace(/^(ok_|done_)/, '');
  const m = base.match(/^([a-z0-9_]+?)__(.+)$/);
  const owner = m ? m[1] : firstUser(env);
  const rest = m ? m[2] : base;
  const streamer = rest.replace(/_\d{8}_\d{6}\.mp4$/, '');
  return { stage, owner, base, streamer };
}

async function allAssets(env) {
  const r = await gh(env, '/releases/tags/clips');
  if (!r.ok) return [];
  const rel = await r.json();
  const assets = rel.assets || [];
  for (let page = 2; assets.length === (page - 1) * 100 && page < 20; page++) {
    const p = await gh(env, `/releases/${rel.id}/assets?per_page=100&page=${page}`);
    if (!p.ok) break;
    const more = await p.json(); if (!more.length) break; assets.push(...more);
  }
  return assets.filter(a => a.name.endsWith('.mp4'));
}

const kvGet = async (env, k) => env.KV ? env.KV.get(k, 'json') : null;
const kvPut = (env, k, v) => env.KV ? env.KV.put(k, JSON.stringify(v)) : null;

// ---------------------------------------------------------------- state
async function state(env, me) {
  if (env.KV && env.TG_BOT_TOKEN) await ensureHook(env);
  const [runsR, assets, yt, tt, log, tgc, banner] = await Promise.all([
    gh(env, `/actions/workflows/${WF}/runs?per_page=40`),
    allAssets(env),
    kvGet(env, `acct:${me}:youtube`), kvGet(env, `acct:${me}:tiktok`), kvGet(env, `log:${me}`), kvGet(env, `tg:${me}`),
    env.KV ? env.KV.get(`banner:${me}`) : null,
  ]);
  const runs = (runsR.ok ? (await runsR.json()).workflow_runs : [])
    .filter(r => (r.display_title || '').includes(`· ${me} `) || (me === firstUser(env) && !(r.display_title || '').includes(' · ')));
  const active = runs.filter(r => r.status !== 'completed').map(r => ({
    id: r.id, title: r.display_title.replace(` · ${me}`, ''), status: r.status, url: r.html_url, started: r.run_started_at }));
  const recent = runs.filter(r => r.status === 'completed').slice(0, 20).map(r => ({
    id: r.id, title: r.display_title.replace(` · ${me}`, ''), conclusion: r.conclusion, url: r.html_url,
    started: r.run_started_at, ended: r.updated_at }));
  const clips = assets.map(a => ({ id: a.id, name: a.name, label: a.label || '', size: a.size, created: a.created_at, ...parseName(env, a.name) }))
    .filter(c => c.owner === me).sort((a, b) => b.created.localeCompare(a.created));
  return {
    me, login: (await cred(env, me))?.login || me, active, recent, banner,
    fresh: clips.filter(c => c.stage === 'fresh'),
    approved: clips.filter(c => c.stage === 'approved').reverse(),       // очередь: старые первыми
    posted: clips.filter(c => c.stage === 'posted').slice(0, 30),
    accounts: { youtube: yt ? { name: yt.name } : null, tiktok: tt ? { name: tt.name, stats: /video\.list/.test(tt.scope || '') } : null,
      telegram: tgc ? { name: tgc.name ? '@' + tgc.name : 'подключён' } : null },
    log: (log || []).slice(0, 30),
    kv: !!env.KV,
    oauth: { youtube: !!(env.YT_CLIENT_ID && env.YT_CLIENT_SECRET), tiktok: !!(env.TT_CLIENT_KEY && env.TT_CLIENT_SECRET), telegram: !!env.TG_BOT_TOKEN },
  };
}

// ---------------------------------------------------------------- video proxy
async function video(env, id, req) {
  const headers = { Accept: 'application/octet-stream' };
  const range = req.headers.get('Range');
  if (range) headers.Range = range;
  const r = await gh(env, `/releases/assets/${id}`, { headers });
  const h = new Headers({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
  for (const k of ['Content-Length', 'Content-Range']) if (r.headers.get(k)) h.set(k, r.headers.get(k));
  return new Response(r.body, { status: r.status, headers: h });
}

// ---------------------------------------------------------------- OAuth
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

async function oauthStart(env, me, prov, stats) {
  const state = `${me}.${await hmac(env, 'o:' + me + prov)}`;
  if (prov === 'youtube') {
    const q = new URLSearchParams({ client_id: env.YT_CLIENT_ID, redirect_uri: `${BASE}/oauth/youtube/cb`, response_type: 'code',
      scope: YT_SCOPES, access_type: 'offline', prompt: 'consent select_account', state });
    return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
  }
  const q = new URLSearchParams({ client_key: env.TT_CLIENT_KEY, redirect_uri: `${BASE}/oauth/tiktok/cb`, response_type: 'code',
    scope: stats ? 'user.info.basic,video.upload,user.info.stats,video.list' : 'user.info.basic,video.upload', state });
  return Response.redirect('https://www.tiktok.com/v2/auth/authorize/?' + q, 302);
}

async function oauthCallback(env, prov, url) {
  const [owner, sig] = (url.searchParams.get('state') || '').split('.');
  if (!owner || sig !== await hmac(env, 'o:' + owner + prov)) return html(msgPage('❌ Ссылка устарела, попробуй ещё раз'), 400);
  const code = url.searchParams.get('code');
  if (!code) return html(msgPage('❌ Доступ не выдан: ' + (url.searchParams.get('error_description') || url.searchParams.get('error') || '')), 400);
  if (prov === 'youtube') {
    const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      code, client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, redirect_uri: `${BASE}/oauth/youtube/cb`, grant_type: 'authorization_code' }) }).then(r => r.json());
    if (!t.refresh_token) return html(msgPage('❌ Google не дал токен: ' + JSON.stringify(t).slice(0, 300)), 400);
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: 'Bearer ' + t.access_token } }).then(r => r.json()).catch(() => ({}));
    const name = ch.items?.[0]?.snippet?.title || 'YouTube';
    await kvPut(env, `acct:${owner}:youtube`, { refresh: t.refresh_token, name });
    return html(msgPage(`✅ YouTube подключён: ${name}`));
  }
  const t = await fetch('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_key: env.TT_CLIENT_KEY, client_secret: env.TT_CLIENT_SECRET, code, grant_type: 'authorization_code',
      redirect_uri: `${BASE}/oauth/tiktok/cb` }) }).then(r => r.json());
  if (!t.refresh_token) return html(msgPage('❌ TikTok не дал токен: ' + JSON.stringify(t).slice(0, 300)), 400);
  const u = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name', {
    headers: { Authorization: 'Bearer ' + t.access_token } }).then(r => r.json()).catch(() => ({}));
  const name = u.data?.user?.display_name || 'TikTok';
  await kvPut(env, `acct:${owner}:tiktok`, { refresh: t.refresh_token, open_id: t.open_id, name, scope: t.scope || '' });
  return html(msgPage(`✅ TikTok подключён: ${name}`));
}

// ---------------------------------------------------------------- telegram
const tg = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({}));
const tgEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tgConnect(env, me) {
  if (!env.TG_BOT_TOKEN) return html(msgPage('❌ В воркере нет TG_BOT_TOKEN'), 500);
  // вебхук ставим каждый раз — это безопасно и чинит его, если сбился
  await tg(env, 'setWebhook', { url: `${BASE}/tg/hook`, secret_token: await hmac(env, 'tghook'), allowed_updates: ['message', 'callback_query'] });
  const bot = await tg(env, 'getMe', {});
  const name = bot.result?.username;
  if (!name) return html(msgPage('❌ Telegram не принял токен бота'), 500);
  return Response.redirect(`https://t.me/${name}?start=${me}-${(await hmac(env, 'tg:' + me)).slice(0, 16)}`, 302);
}

async function ownerByChat(env, chat) {
  const direct = env.KV ? await env.KV.get(`tgchat:${chat}`) : null;
  if (direct) return direct;
  for (const u of Object.keys(users(env))) {                       // подключившиеся до этой версии
    const t = await kvGet(env, `tg:${u}`);
    if (t && String(t.chat) === String(chat)) { await env.KV.put(`tgchat:${chat}`, u); return u; }
  }
  return null;
}

// ---------------- баннеры: релиз "banners", файлы <user>__<Name>.mp4, активный — KV banner:<user>
const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const bannerName = s => String(s || '').trim().split('').map(ch => { const l = ch.toLowerCase(); return TR[l] !== undefined ? (ch === l ? TR[l] : TR[l].charAt(0).toUpperCase() + TR[l].slice(1)) : ch; })
  .join('').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

async function bannerRelease(env) {
  let r = await gh(env, '/releases/tags/banners');
  if (r.status === 404) r = await gh(env, '/releases', { method: 'POST', body: JSON.stringify({ tag_name: 'banners', name: 'Баннеры', body: 'Библиотеки баннеров пользователей ClipFarm' }) });
  return r.ok ? r.json() : null;
}
async function myBanners(env, owner) {
  const rel = await bannerRelease(env);
  return rel ? (rel.assets || []).filter(a => a.name.startsWith(owner + '__')).map(a => ({ id: a.id, file: a.name, size: a.size,
    name: a.name.slice(owner.length + 2).replace(/\.mp4$/, '') })) : [];
}
async function saveBanner(env, owner, m) {
  const f = m.video || m.animation || (m.document && /video/.test(m.document.mime_type || '') ? m.document : null);
  if (!f) return 'Пришли видео баннера (на зелёном фоне, со звуком).';
  if ((f.file_size || 0) > 20e6) return '❌ Telegram отдаёт ботам файлы только до 20 МБ — сожми баннер.';
  if (!bannerName(m.caption)) {                        // без подписи — спросим название
    await kvPut(env, `pending:${owner}`, { file_id: f.file_id, file_size: f.file_size });
    return '📝 Как назвать баннер? Напиши название (например RubUp).';
  }
  return storeBanner(env, owner, f, m.caption);
}
async function storeBanner(env, owner, f, caption) {
  const base = bannerName(caption);
  if (!base) return '❌ Название должно содержать буквы или цифры. Напиши ещё раз.';
  const have = new Set((await myBanners(env, owner)).map(b => b.name.toLowerCase()));
  let name = base;
  for (let i = 1; have.has(name.toLowerCase()); i++) name = `${base}_${i}`;
  const fi = await tg(env, 'getFile', { file_id: f.file_id });
  if (!fi.result?.file_path) return '❌ Не смог скачать файл из Telegram.';
  const dl = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${fi.result.file_path}`);
  const size = Number(dl.headers.get('Content-Length')) || f.file_size;
  const rel = await bannerRelease(env);
  if (!rel) return '❌ Нет доступа к релизу banners на GitHub.';
  const { readable, writable } = new FixedLengthStream(size);
  dl.body.pipeTo(writable);
  const up = await gh(env, `https://uploads.github.com/repos/${env.GH_REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(owner + '__' + name + '.mp4')}`,
    { method: 'POST', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: readable });
  if (!up.ok) return '❌ Не залился на GitHub: ' + up.status;
  return `✅ Баннер «${name}» добавлен в твою библиотеку.\nВключить: /banner ${name}`;
}
async function bannerCmd(env, owner, arg) {
  const list = await myBanners(env, owner);
  const cur = await env.KV.get(`banner:${owner}`);
  if (!arg) return (list.length ? '🎞 Твои баннеры:\n' + list.map(b => (b.name === cur ? '▶️ ' : '• ') + b.name).join('\n') : 'Библиотека пуста. Пришли видео баннера с подписью-названием.')
    + `\n\nСейчас: ${cur || 'выключен'}\n/banner Имя — включить\n/banner stop — выключить\n/banner del Имя — удалить`;
  if (/^(stop|стоп|off)$/i.test(arg)) { await env.KV.delete(`banner:${owner}`); return '⏹ Баннеры выключены.'; }
  const del = arg.match(/^(?:del|delete|удалить)\s+(.+)$/i);
  const find = n => list.find(b => b.name.toLowerCase() === bannerName(n).toLowerCase());
  if (del) {
    const b = find(del[1]); if (!b) return `Нет баннера «${del[1]}».`;
    await gh(env, `/releases/assets/${b.id}`, { method: 'DELETE' });
    if (cur === b.name) await env.KV.delete(`banner:${owner}`);
    return `🗑 «${b.name}» удалён.`;
  }
  const b = find(arg);
  if (!b) return `Нет баннера «${arg}». Твои: ${list.map(x => x.name).join(', ') || 'пусто'}`;
  await env.KV.put(`banner:${owner}`, b.name);
  return `▶️ Баннер «${b.name}» включён — он будет посередине всех следующих клипов.\nВыключить: /banner stop`;
}

// ---------------- групповые чаты: бот молчит, но умеет пару приколов
const pick = a => a[Math.floor(Math.random() * a.length)];
const who = u => u?.username ? '@' + u.username : (u?.first_name || 'боец');
async function botName(env) {
  let n = await env.KV.get('bot:name');
  if (!n) { n = (await tg(env, 'getMe', {})).result?.username || ''; if (n) await env.KV.put('bot:name', n, { expirationTtl: 86400 }); }
  return n;
}
function clutch(u) {
  const n = 1 + Math.floor(Math.random() * 5), win = Math.random() < 0.42;
  const gun = pick(['диглом', 'AWP', 'ножом', 'калашом', 'зевсом ⚡', 'скаутом', 'P90 как настоящий сильвер', 'дефьюз-китом', 'одной гранатой']);
  const map = pick(['Mirage', 'Inferno', 'Dust 2', 'Nuke', 'Ancient', 'Anubis', 'Vertigo']);
  return win
    ? `🔫 ${who(u)} затащил клатч 1v${n} ${gun} на ${map}. ${pick(['Чат: W W W', 'Это ЗАВОЗИК 🔥', 'Стример плачет от зависти 😭', 'Имба, база, эйс 💀', 'Клип уже режется 🎬'])}`
    : `💀 ${who(u)} слил клатч 1v${n} ${gun} на ${map}. ${pick(['Чат: L L L', 'Тильт обеспечен 😭', 'Тиммейты молча вышли из лобби', 'Даже бот бы затащил', 'Это попадёт в нарезку… в рубрику «кринж»'])}`;
}
function rate(target) {
  const n = Math.floor(Math.random() * 11);
  const verdict = n >= 9 ? pick(['ЭЙС 🔥', 'чистый завозик', 'база базовая', 'дабл ю']) : n >= 6 ? pick(['норм раунд', 'жиза', 'пойдёт в нарезку']) :
    n >= 3 ? pick(['эко-раунд какой-то', 'сомнительно, но окэй', 'тильт подкрадывается']) : pick(['L', 'кринж 💀', 'сразу в отклонённые клипы ❌']);
  return `📊 Этот тейк от ${who(target)}: ${n}/10 — ${verdict}`;
}
const CANNED = ['Это база, без вопросов 🗿', 'W тейк, L грамматика', 'Слишком сильно для эко-раунда', 'Тильт детектед, иди попей водички',
  'Чат в отлёте, я тоже', 'Имба мысль, но ты на эко', 'Раунд проигран, но вайб засчитан', 'Скажи это ещё раз, только с AWP в руках',
  'Жиза, брат', 'Кринж, но я уважаю', 'Пон. Ничего не пон, но пон', 'Сигма-ответ, без комментариев 💀', 'Рофл засчитан', 'Изи катка, изи жизнь']
async function gemini(env, prompt, model) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_KEY, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12000),
    body: JSON.stringify({ generationConfig: { temperature: 1.05, maxOutputTokens: 2048 }, contents: [{ parts: [{ text: prompt }] }] }) }).then(r => r.json());
  if (r.error) console.log('gemini', model, r.error.message);
  // у «думающих» моделей бывает несколько частей — берём текст, не мысли
  const parts = r.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.text && !p.thought).map(p => p.text).join(' ').trim();
}
async function roast(env, m, name) {
  const chat = m.chat.id, key = `chat:${chat}`;
  const hist = (await kvGet(env, key)) || [];
  const me = who(m.from), text = (m.text || m.caption || '').replace(new RegExp('@' + name, 'ig'), '').trim();
  const replied = m.reply_to_message && m.reply_to_message.from?.username?.toLowerCase() !== name.toLowerCase()
    ? `${who(m.reply_to_message.from)}: ${(m.reply_to_message.text || m.reply_to_message.caption || '[медиа]').slice(0, 200)}` : '';
  let answer = '';
  if (env.GEMINI_KEY) {
    const prompt = `Ты — просто свой пацан в чате друзей, зумер, который шарит в CS2 и стримах. Не ассистент и не бот-помощник.
Как общаешься:
- просто болтаешь: отвечаешь по сути на последнее сообщение, подкалываешь, шутишь, споришь, соглашаешься — как друг в чате;
- зумерский сленг естественно, по ситуации: завозик, дабл ю / W, L, имба, база, кринж, рофл, тильт, жиза, вайб, пон, сигма, изи, клатч, эко, катка;
- коротко: 1–2 предложения (до 25 слов), иногда один эмодзи;
- учитывай историю ниже и не повторяй свои прошлые фразы;
НЕЛЬЗЯ:
- предлагать помощь, задавать уточняющие вопросы «по делу», просить таймкоды, ссылки, видео;
- говорить про нарезки, клипы, хайлайты, монтаж, постинг, подписки — не призывай ничего клипать или постить;
- мат, оскорбления внешности/национальности/семьи, политика, 18+;
- писать своё имя или начинать с «Ну».

История чата (старые сверху):
${hist.map(h => `${h.u}: ${h.t}`).join('\n') || '(пусто)'}
${replied ? `\n${me} отвечает на сообщение: «${replied}»` : ''}
Последнее сообщение — ${me}: ${text || '[без текста]'}
Твой ответ:`;
    for (const model of ['gemini-flash-lite-latest', 'gemini-flash-latest']) {
      try { answer = await gemini(env, prompt, model); } catch (e) { console.log('gemini fail', model, e.message); }
      if (answer) break;
    }
    answer = answer.replace(/^(ClipFarm|Бот)\s*:\s*/i, '').replace(/^["«]|["»]$/g, '').slice(0, 400);
  }
  if (!answer) {                                   // запасные фразы — без повторов подряд
    const used = new Set(hist.filter(h => h.u === 'бот').map(h => h.t));
    const fresh = CANNED.filter(x => !used.has(x));
    answer = pick(fresh.length ? fresh : CANNED);
  }
  const next = [...hist, { u: me, t: text.slice(0, 200) }, { u: 'бот', t: answer.slice(0, 200) }].slice(-16);
  await kvPut(env, key, next);
  return answer;
}
async function groupMessage(env, m) {
  const text = (m.text || '').trim(), name = await botName(env);
  const reply = t => tg(env, 'sendMessage', { chat_id: m.chat.id, text: t, reply_to_message_id: m.message_id });
  const cmd = text.match(/^\/([a-zа-яё]+)(?:@(\w+))?/i);
  if (cmd && cmd[2] && name && cmd[2].toLowerCase() !== name.toLowerCase()) return;     // команда другому боту
  const c = cmd ? cmd[1].toLowerCase() : '';
  if (['clutch', 'клатч'].includes(c)) return reply(clutch(m.from));
  if (['rate', 'оцени', 'рейт'].includes(c)) {
    // кого оцениваем: ответ на сообщение → чужой ответ из другого чата → @ник в тексте → сам автор
    const r = m.reply_to_message;
    const topicRoot = r && m.is_topic_message && r.message_id === m.message_thread_id;   // в группах с темами «ответ» на корень темы
    let target = r && !topicRoot && !r.forum_topic_created ? (r.sender_chat ? { first_name: r.sender_chat.title } : r.from) : null;
    if (!target && m.external_reply?.origin) target = m.external_reply.origin.sender_user || { first_name: m.external_reply.origin.sender_user_name || m.external_reply.origin.chat?.title };
    const at = text.match(/@(\w{3,})/g)?.map(x => x.slice(1)).find(x => !name || x.toLowerCase() !== name.toLowerCase());
    if (!target && at) target = { username: at };
    if (!target) return reply(rate(m.from).replace('Этот тейк от', 'Ни на что не ответил, поэтому оцениваю тебя,'));
    return reply(rate(target));
  }
  if (['help', 'start', 'помощь'].includes(c)) return reply('Я тут просто тусуюсь 😎 Умею:\n/clutch — сыграть клатч\n/rate — ответом на сообщение: оценю тейк\nТегни меня — отвечу.\nНастройки и баннеры — в личке со мной.');
  if (c) return;                                                      // прочие команды в группе игнорим
  const mentioned = name && text.toLowerCase().includes('@' + name.toLowerCase());
  const repliedToMe = m.reply_to_message?.from?.username && name && m.reply_to_message.from.username.toLowerCase() === name.toLowerCase();
  if (mentioned || repliedToMe) {
    // на «ахах», «)))», «ок» в ответ боту не болтаем — просто реакция
    if (!mentioned && /^(а?[хx][аaеэ]+[хx]*.*|лол|ору+|кек|lol|ok|ок|да|нет|\)+|[😂🤣💀😭👍🔥]+)$/i.test(text))
      return tg(env, 'setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: pick(['🤣', '😁', '🔥', '🗿']) }] });
    await tg(env, 'sendChatAction', { chat_id: m.chat.id, action: 'typing' });
    return reply(await roast(env, m, name));
  }
  // реакции на сленг — иногда
  if (/(^|\s)(w|дабл ю|завозик|имба|эйс|ace|клатч)(\s|$|!)/i.test(text) && Math.random() < 0.3)
    return tg(env, 'setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: pick(['🔥', '🏆', '⚡', '👏']) }] });
  if (/(^|\s)(l|тильт|кринж|слил)(\s|$|!)/i.test(text) && Math.random() < 0.3)
    return tg(env, 'setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: pick(['😭', '🤡', '💔', '🙈']) }] });
}

async function tgHook(env, req, ctx) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await hmac(env, 'tghook')) return new Response('no', { status: 403 });
  const u = await req.json().catch(() => ({}));
  if (u.callback_query) return clipButton(env, u.callback_query);
  const m = u.message;
  if (!m) return new Response('ok');
  if (m.chat?.type && m.chat.type !== 'private') {
    // отвечаем Telegram сразу, а думаем в фоне — иначе Telegram обрывает запрос и ответ теряется
    ctx.waitUntil(groupMessage(env, m).catch(e => console.log('group error', e.message)));
    return new Response('ok');
  }
  const say = text => tg(env, 'sendMessage', { chat_id: m.chat.id, text });
  const text = (m.text || '').trim();
  const p = text.match(/^\/start ([a-z0-9_]+)-([0-9a-f]{16})$/);
  if (p && users(env)[p[1]] && (await hmac(env, 'tg:' + p[1])).slice(0, 16) === p[2]) {
    await kvPut(env, `tg:${p[1]}`, { chat: m.chat.id, name: m.from?.username || m.from?.first_name || '' });
    await env.KV.put(`tgchat:${m.chat.id}`, p[1]);
    await say(`✅ Готово, ${p[1]}! Сюда будут приходить описания после каждой публикации.\n\nБаннеры: пришли видео на зелёном фоне с подписью-названием, потом /banner Имя.`);
    return new Response('ok');
  }
  const owner = await ownerByChat(env, m.chat.id);
  if (!owner) { await say('Подключи бота из панели ClipFarm: «Мои аккаунты» → Telegram → Подключить.'); return new Response('ok'); }
  try {
    if (m.video || m.animation || m.document) await say(await saveBanner(env, owner, m));
    else if (/^\/banners?\b/i.test(text)) await say(await bannerCmd(env, owner, text.replace(/^\/banners?(@\w+)?/i, '').trim()));
    else if (text && !text.startsWith('/') && await kvGet(env, `pending:${owner}`)) {   // ответ на «как назвать?»
      const f = await kvGet(env, `pending:${owner}`);
      const r = await storeBanner(env, owner, f, text);
      if (r.startsWith('✅')) await env.KV.delete(`pending:${owner}`);
      await say(r);
    }
    else await say('Команды:\n/banner — мои баннеры\n/banner Имя — включить\n/banner stop — выключить\n/banner del Имя — удалить\n\nНовый баннер: пришли видео с подписью-названием.');
  } catch (e) { await say('⚠️ Ошибка: ' + e.message); }
  return new Response('ok');
}

// ---------------- уведомление о новом клипе с кнопками ✅/❌
async function ensureHook(env) {
  if (await env.KV.get('hook:v3')) return;
  await tg(env, 'setWebhook', { url: `${BASE}/tg/hook`, secret_token: await hmac(env, 'tghook'), allowed_updates: ['message', 'callback_query'] });
  await env.KV.put('hook:v3', '1');
}

async function notifyClip(env, name) {
  if (!/^[a-z0-9_]+__[\w-]+\.mp4$/.test(name || '')) return { error: 'name' };
  if (await env.KV.get(`notified:${name}`)) return { ok: true, dup: true };
  const a = (await allAssets(env)).find(x => x.name === name);       // клип должен реально лежать в релизе
  if (!a) return { error: 'нет такого клипа' };
  const p = parseName(env, a.name);
  await env.KV.put(`notified:${name}`, '1', { expirationTtl: 7 * 86400 });
  const t = await kvGet(env, `tg:${p.owner}`);
  if (!t || !env.TG_BOT_TOKEN) return { ok: true, skipped: 'tg не подключён' };
  await ensureHook(env);
  const caption = `🎬 Новый клип: ${p.streamer}\n${a.label || ''}`.trim();
  const reply_markup = { inline_keyboard: [[{ text: '✅ Постить', callback_data: `ok:${a.id}` }, { text: '❌ Нет', callback_data: `no:${a.id}` }]] };
  let r = await tg(env, 'sendVideo', { chat_id: t.chat, video: a.browser_download_url, caption, reply_markup, supports_streaming: true });
  if (!r.ok) r = await tg(env, 'sendMessage', { chat_id: t.chat, text: caption + `\n${BASE}`, reply_markup });
  return { ok: !!r.ok };
}

async function clipButton(env, q) {
  const owner = await ownerByChat(env, q.message?.chat?.id);
  const [act, id] = String(q.data || '').split(':');
  const done = text => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text });
  const a = await gh(env, `/releases/assets/${Number(id)}`).then(r => r.json()).catch(() => ({}));
  if (!a.name) { await done('Клипа уже нет'); return new Response('ok'); }
  const p = parseName(env, a.name);
  if (!owner || p.owner !== owner) { await done('Это не твой клип'); return new Response('ok'); }
  let note;
  if (p.stage !== 'fresh') note = p.stage === 'approved' ? '✅ уже в очереди' : '🚀 уже опубликован';
  else if (act === 'ok') {
    await gh(env, `/releases/assets/${a.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'ok_' + p.base, label: a.label || '' }) });
    note = '✅ В очереди на постинг';
  } else {
    await gh(env, `/releases/assets/${a.id}`, { method: 'DELETE' });
    note = '❌ Удалён';
  }
  await done(note);
  const cap = (q.message.caption || q.message.text || '') + `\n\n${note}`;
  await tg(env, q.message.caption !== undefined ? 'editMessageCaption' : 'editMessageText', {
    chat_id: q.message.chat.id, message_id: q.message.message_id, [q.message.caption !== undefined ? 'caption' : 'text']: cap, reply_markup: { inline_keyboard: [] } });
  return new Response('ok');
}

async function tgReport(env, owner, entry) {
  const t = await kvGet(env, `tg:${owner}`);
  if (!t || !env.TG_BOT_TOKEN) return;
  const text_ = entry.title + ' ' + (entry.tags || []).map(x => '#' + x).join(' ');
  const lines = Object.entries(entry.res || {}).map(([k, v]) =>
    `${k === 'youtube' ? '▶️ YouTube' : '🎵 TikTok'}: ${String(v).startsWith('http') ? v : tgEsc(v === 'черновик' ? 'черновик во «Входящих» — вставь текст ниже' : v)}`);
  await tg(env, 'sendMessage', { chat_id: t.chat, parse_mode: 'HTML', disable_web_page_preview: true,
    text: `🚀 <b>Опубликовано</b> · ${tgEsc(entry.streamer || '')}\n${lines.join('\n')}\n\n📋 Текст (нажми, чтобы скопировать):\n<code>${tgEsc(text_)}</code>` });
}

// ---------------------------------------------------------------- publishing
async function caption(env, c) {
  const streamer = c.streamer;
  const fallback = { title: `${streamer} выдал завозик 😳`, tags: [streamer, 'cs2', 'counterstrike', 'нарезки'] };
  if (!env.GEMINI_KEY) return fallback;
  const prompt = `Ты админ молодёжного паблика с нарезками со стримов (TikTok и YouTube Shorts, зрители 14–25 лет, Россия/СНГ).
Стример: ${streamer}. Что спамил чат в момент клипа: ${c.label.replace(/^чат:\s*/, '') || 'нет данных'}.

Напиши заголовок так, как его написал бы зумер в тиктоке:
- молодёжный сленг стримерской тусовки: «завозик», «дабл ю» / «W», «L», «имба», «база», «жиза», «кринж», «рофл», «вайб», «пон», «сигма», «ауф», «изи», «тильт», «катка», «чат в шоке» — 1–3 слова на заголовок, по смыслу, не все сразу;
- можно капс на одном слове для эмоции, 1–2 эмодзи (😭💀🔥😳🤯);
- до 70 символов, без кавычек, без мата (можно ж*па-стиль со звёздочкой, но лучше без), без слов про насилие, криминал, кровь, «шок», «жесть»;
- не выдумывай конкретные события, которых нет в данных, — играй на эмоции чата и ник стримера;
- ник стримера пиши как есть;
- тематика — Counter-Strike 2: можно «катка», «клатч», «эйс», «раунд», «AWP», если уместно;
- НЕЛЬЗЯ упоминать или рекламировать другие проекты, сайты, казино, кейс-сайты, промокоды, бренды и ссылки.
Примеры стиля: «${streamer} выдал ЗАВОЗИК, чат в отлёте 💀», «это просто дабл ю от ${streamer} 🔥», «${streamer} словил тильт 😭 жиза».

Ещё 5 хештегов без # латиницей или кириллицей, без пробелов: ник стримера, cs2, нарезки + 2 по теме (без брендов и других проектов).
Ответ строго JSON: {"title":"...","tags":["..."]}`;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ generationConfig: { responseMimeType: 'application/json', temperature: 1 }, contents: [{ parts: [{ text: prompt }] }] }) }).then(r => r.json());
    const o = JSON.parse(r.candidates[0].content.parts[0].text);
    if (o.title) return { title: String(o.title).slice(0, 95), tags: (o.tags || []).map(t => String(t).replace(/^#/, '').replace(/\s+/g, '')).slice(0, 6) };
  } catch (e) {}
  return fallback;
}

async function streamAsset(env, id, size) {
  const r = await gh(env, `/releases/assets/${id}`, { headers: { Accept: 'application/octet-stream' } });
  if (!r.ok) throw new Error('GitHub не отдал файл: ' + r.status);
  const { readable, writable } = new FixedLengthStream(size);
  r.body.pipeTo(writable);
  return readable;
}

async function postYouTube(env, acct, c, cap) {
  const tok = await ytToken(env, acct);
  const meta = { snippet: { title: (cap.title + ' #shorts').slice(0, 100),
      description: `${cap.title}\n\nСтример: twitch.tv/${c.streamer}\n\n` + cap.tags.map(t => '#' + t).join(' ') + ' #shorts',
      tags: cap.tags, categoryId: '20' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST',
    headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(c.size) }, body: JSON.stringify(meta) });
  const loc = init.headers.get('Location');
  if (!loc) throw new Error('YouTube init: ' + init.status + ' ' + (await init.text()).slice(0, 200));
  const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: await streamAsset(env, c.id, c.size) });
  const v = await up.json().catch(() => ({}));
  if (!v.id) throw new Error('YouTube upload: ' + up.status + ' ' + JSON.stringify(v).slice(0, 200));
  return 'https://youtube.com/shorts/' + v.id;
}

async function ttToken(env, owner, acct) {
  const tok = await fetch('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_key: env.TT_CLIENT_KEY, client_secret: env.TT_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: acct.refresh }) }).then(r => r.json());
  if (!tok.access_token) throw new Error('токен TikTok: ' + JSON.stringify(tok).slice(0, 200));
  if (tok.refresh_token && tok.refresh_token !== acct.refresh) await kvPut(env, `acct:${owner}:tiktok`, { ...acct, refresh: tok.refresh_token, scope: tok.scope || acct.scope });
  return tok;
}
async function ytToken(env, acct) {
  const tok = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: acct.refresh, grant_type: 'refresh_token' }) }).then(r => r.json());
  if (!tok.access_token) throw new Error('токен YouTube: ' + JSON.stringify(tok).slice(0, 200));
  return tok;
}

// ---------------- статистика: снимок раз в несколько часов, история по дням в KV stats:<user>
async function refreshStats(env, owner) {
  const [yt, tt, log] = await Promise.all([kvGet(env, `acct:${owner}:youtube`), kvGet(env, `acct:${owner}:tiktok`), kvGet(env, `log:${owner}`)]);
  const st = (await kvGet(env, `stats:${owner}`)) || { days: {}, top: [] };
  const day = new Date().toISOString().slice(0, 10);
  const snap = st.days[day] || {};
  const top = {};                                              // ключ — заголовок клипа
  const errors = [];
  if (yt) {
    try {
      const tok = await ytToken(env, yt);
      const H = { headers: { Authorization: 'Bearer ' + tok.access_token } };
      const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', H).then(r => r.json());
      const s = ch.items?.[0]?.statistics || {};
      snap.yt = Number(s.viewCount || 0); snap.ytSubs = Number(s.subscriberCount || 0);
      const ids = (log || []).map(e => String(e.res?.youtube || '').match(/shorts\/([\w-]{6,})/)?.[1]).filter(Boolean).slice(0, 50);
      if (ids.length) {
        const v = await fetch('https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=' + ids.join(','), H).then(r => r.json());
        for (const it of v.items || []) {
          const k = it.snippet.title.replace(/\s*#shorts$/i, '');
          top[k] = { ...(top[k] || { title: k }), yt: Number(it.statistics.viewCount || 0), ytLikes: Number(it.statistics.likeCount || 0), ytUrl: 'https://youtube.com/shorts/' + it.id, t: it.snippet.publishedAt };
        }
      }
    } catch (e) { errors.push('YouTube: ' + e.message); }
  }
  if (tt && /video\.list/.test(tt.scope || '')) {
    try {
      const tok = await ttToken(env, owner, tt);
      const H = { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' };
      const u = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count,video_count', { headers: H }).then(r => r.json());
      snap.ttSubs = Number(u.data?.user?.follower_count || 0);
      let views = 0, cursor = 0, more = true, pages = 0;
      while (more && pages++ < 5) {
        const l = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,like_count,share_url,create_time', {
          method: 'POST', headers: H, body: JSON.stringify({ max_count: 20, cursor }) }).then(r => r.json());
        for (const vd of l.data?.videos || []) {
          views += Number(vd.view_count || 0);
          const k = (vd.title || '').replace(/\s#.*$/, '').trim() || 'TikTok ' + vd.id;
          top[k] = { ...(top[k] || { title: k }), tt: Number(vd.view_count || 0), ttLikes: Number(vd.like_count || 0), ttUrl: vd.share_url,
            t: top[k]?.t || new Date(vd.create_time * 1000).toISOString() };
        }
        more = l.data?.has_more; cursor = l.data?.cursor;
      }
      snap.tt = views;
    } catch (e) { errors.push('TikTok: ' + e.message); }
  }
  st.days[day] = snap;
  const keep = Object.keys(st.days).sort().slice(-120);
  st.days = Object.fromEntries(keep.map(k => [k, st.days[k]]));
  st.top = Object.values(top).sort((a, b) => ((b.yt || 0) + (b.tt || 0)) - ((a.yt || 0) + (a.tt || 0))).slice(0, 30);
  st.updated = new Date().toISOString(); st.errors = errors;
  await kvPut(env, `stats:${owner}`, st);
  return st;
}

async function postTikTok(env, owner, acct, c) {
  const tok = await ttToken(env, owner, acct);
  const init = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', { method: 'POST',
    headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: c.size, chunk_size: c.size, total_chunk_count: 1 } }) }).then(r => r.json());
  const url = init.data?.upload_url;
  if (!url) throw new Error('TikTok init: ' + JSON.stringify(init.error || init).slice(0, 200));
  const up = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4',
    'Content-Range': `bytes 0-${c.size - 1}/${c.size}` }, body: await streamAsset(env, c.id, c.size) });
  if (!up.ok) throw new Error('TikTok upload: ' + up.status + ' ' + (await up.text()).slice(0, 200));
  return 'черновик';
}

async function publishNext(env, owner) {
  const [yt, tt] = await Promise.all([kvGet(env, `acct:${owner}:youtube`), kvGet(env, `acct:${owner}:tiktok`)]);
  if (!yt && !tt) return { owner, skipped: 'нет подключённых аккаунтов' };
  const queue = (await allAssets(env)).map(a => ({ id: a.id, name: a.name, label: a.label || '', size: a.size, created: a.created_at, ...parseName(env, a.name) }))
    .filter(c => c.owner === owner && c.stage === 'approved').sort((a, b) => a.created.localeCompare(b.created));
  const c = queue[0];
  if (!c) return { owner, skipped: 'очередь пуста' };
  const cap = await caption(env, c);
  const res = {};
  if (yt) { try { res.youtube = await postYouTube(env, yt, c, cap); } catch (e) { res.youtube = '⚠️ ' + e.message; } }
  if (tt) { try { res.tiktok = await postTikTok(env, owner, tt, c); } catch (e) { res.tiktok = '⚠️ ' + e.message; } }
  const ok = Object.values(res).some(v => !String(v).startsWith('⚠️'));
  if (ok) await gh(env, `/releases/assets/${c.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'done_' + c.base, label: c.label }) });
  const entry = { t: new Date().toISOString(), clip: c.base, streamer: c.streamer, title: cap.title, tags: cap.tags, res };
  const log = (await kvGet(env, `log:${owner}`)) || [];
  await kvPut(env, `log:${owner}`, [entry, ...log].slice(0, 50));
  await tgReport(env, owner, entry);
  return { owner, ...entry, left: queue.length - (ok ? 1 : 0) };
}

// ---------------- стримеры: избранное, лайв-статусы, витрина CS2, автозапуск
// платформа + ник из ссылки: twitch.tv/x, kick.com/x, просто ник (= Twitch)
function streamFrom(s) {
  s = String(s || '').trim();
  let m = s.match(/kick\.com\/([A-Za-z0-9_-]{2,30})/i);
  if (m) return { p: 'kick', ch: m[1].toLowerCase() };
  m = s.match(/twitch\.tv\/([A-Za-z0-9_]{3,25})/i);
  const n = (m ? m[1] : s.replace(/^@/, ''));
  return /^[A-Za-z0-9_]{3,25}$/.test(n) ? { p: 'twitch', ch: n.toLowerCase() } : null;
}
const GQL = q => fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q }) }).then(r => r.json()).catch(() => ({}));

async function twitchLive(logins) {
  if (!logins.length) return {};
  const d = await GQL(`query{users(logins:${JSON.stringify(logins)}){login displayName profileImageURL(width:70) stream{viewersCount title game{name} previewImageURL(width:320,height:180)}}}`);
  const out = {};
  for (const u of d.data?.users || []) if (u) out[u.login.toLowerCase()] = { name: u.displayName, avatar: u.profileImageURL,
    live: !!u.stream, viewers: u.stream?.viewersCount || 0, title: u.stream?.title || '', game: u.stream?.game?.name || '', preview: u.stream?.previewImageURL || '' };
  return out;
}
async function kickLive(slug) {
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', Accept: 'application/json' } });
    if (!r.ok) return { unknown: true };
    const d = await r.json(), ls = d.livestream;
    return { name: d.user?.username || slug, avatar: d.user?.profile_pic || '', live: !!ls?.is_live, viewers: ls?.viewer_count || 0, title: ls?.session_title || '',
      game: (ls?.categories || []).map(c => c.name).join(', '), preview: ls?.thumbnail?.url || '' };
  } catch (e) { return { unknown: true }; }
}
async function discover() {
  const cached = await kvGet(env_global, 'discover');
  if (cached && Date.now() - cached.t < 120e3) return cached.list;
  const d = await GQL(`query{game(name:"Counter-Strike"){streams(first:100){edges{node{viewersCount title previewImageURL(width:320,height:180) broadcaster{login displayName profileImageURL(width:70) broadcastSettings{language}}}}}}}`);
  const all = (d.data?.game?.streams?.edges || []).map(e => e.node).filter(n => n?.broadcaster);
  const ru = all.filter(n => String(n.broadcaster.broadcastSettings?.language || '').toUpperCase() === 'RU');
  const list = (ru.length ? ru : all).slice(0, 15).map(n => ({ p: 'twitch', ch: n.broadcaster.login.toLowerCase(), name: n.broadcaster.displayName, avatar: n.broadcaster.profileImageURL,
    viewers: n.viewersCount, title: n.title, preview: n.previewImageURL, live: true, game: 'Counter-Strike' }));
  await kvPut(env_global, 'discover', { t: Date.now(), list });
  return list;
}
let env_global = null;

async function activeRuns(env) {
  const r = await gh(env, `/actions/workflows/${WF}/runs?per_page=50`);
  return r.ok ? (await r.json()).workflow_runs.filter(x => x.status !== 'completed') : [];
}
const runKey = (owner, p, ch) => `🎬 ${ch}${p === 'kick' ? ' [Kick]' : ''} · ${owner} `;

async function liveState(env, me) {
  const favs = (await kvGet(env, `fav:${me}`)) || [];
  const [tw, runs, disc, ...kk] = await Promise.all([
    twitchLive(favs.filter(f => f.p === 'twitch').map(f => f.ch)), activeRuns(env), discover(),
    ...favs.filter(f => f.p === 'kick').map(f => kickLive(f.ch)) ]);
  const kmap = {}; favs.filter(f => f.p === 'kick').forEach((f, i) => kmap[f.ch] = kk[i]);
  const running = new Set(runs.map(r => r.display_title || '').filter(t => t.includes(`· ${me} `)));
  const isRun = (p, ch) => [...running].some(t => t.startsWith(runKey(me, p, ch).replace(/ $/, '')));
  const list = favs.map(f => ({ ...f, ...(f.p === 'twitch' ? (tw[f.ch] || { name: f.ch }) : (kmap[f.ch] || { name: f.ch, unknown: true })), running: isRun(f.p, f.ch) }))
    .sort((a, b) => (b.live - a.live) || (b.viewers - a.viewers));
  return { favs: list, discover: disc.map(d => ({ ...d, fav: favs.some(f => f.p === d.p && f.ch === d.ch), running: isRun(d.p, d.ch) })) };
}

async function dispatchClip(env, owner, p, ch, opts = {}) {
  return gh(env, `/actions/workflows/${WF}/dispatches`, { method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { channel: ch, platform: p, owner, model: opts.model || 'medium', mult: String(opts.mult || '2.5'),
      only_game: opts.game ?? 'Counter-Strike', part: '1' } }) });
}

// крон каждые 5 минут: у кого включено «Авто» и стример вышел в эфир с CS2 — запускаем нарезку
async function autoStart(env) {
  const runs = await activeRuns(env);
  const titles = runs.map(r => r.display_title || '');
  for (const u of Object.keys(users(env))) {
    const favs = ((await kvGet(env, `fav:${u}`)) || []).filter(f => f.auto);
    if (!favs.length) continue;
    const tw = await twitchLive(favs.filter(f => f.p === 'twitch').map(f => f.ch));
    for (const f of favs) {
      const st = f.p === 'twitch' ? tw[f.ch] : await kickLive(f.ch);
      if (!st?.live || !/counter-strike/i.test(st.game || '')) continue;
      if (titles.some(t => t.startsWith(runKey(u, f.p, f.ch).replace(/ $/, '')))) continue;
      if (await env.KV.get(`nostart:${u}:${f.p}:${f.ch}`)) continue;                // вручную остановил — не лезем до конца стрима
      const r = await dispatchClip(env, u, f.p, f.ch);
      if (r.status === 204) {
        await env.KV.put(`nostart:${u}:${f.p}:${f.ch}`, 'auto', { expirationTtl: 20 * 60 });   // не дёргать повторно, пока раннер стартует
        const t = await kvGet(env, `tg:${u}`);
        if (t && env.TG_BOT_TOKEN) await tg(env, 'sendMessage', { chat_id: t.chat, text: `🔴 ${st.name || f.ch} в эфире (${st.game}, ${st.viewers} зрителей) — начал резать автоматически.` });
      }
    }
  }
}

// ---------------------------------------------------------------- router
export default {
  async scheduled(event, env, ctx) {
    env_global = env;
    if (event.cron && event.cron.startsWith('*/')) { ctx.waitUntil(autoStart(env).catch(e => console.log('auto', e.message))); return; }
    ctx.waitUntil((async () => { for (const u of Object.keys(users(env))) {
      try { await publishNext(env, u); } catch (e) {}
      try { await refreshStats(env, u); } catch (e) {}
    } })());
  },

  async fetch(req, env, ctx) {
    env_global = env;
    const url = new URL(req.url);

    if (url.pathname === '/login' && req.method === 'POST') {
      const f = await req.formData();
      const user = await checkLogin(env, f.get('login'), f.get('pass') || '');
      if (user) return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': await cookieFor(env, user) } });
      return html(LOGIN.replace('<!--err-->', '<p class="err">Неверный логин или пароль</p>'), 401);
    }
    if (url.pathname === '/logout') return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': 'cf_auth=; Path=/; Max-Age=0' } });

    if (url.pathname === '/tg/hook' && req.method === 'POST') return tgHook(env, req, ctx);
    if (url.pathname === '/pub/newclip' && req.method === 'POST') {   // нарезчик сообщает о новом клипе
      const b = await req.json().catch(() => ({}));
      return json(env.KV ? await notifyClip(env, b.name) : { error: 'kv' });
    }
    const pb = url.pathname.match(/^\/pub\/banner\/([a-z0-9_]+)$/);
    if (pb) {                                           // нарезчик спрашивает, какой баннер вставлять
      const name = env.KV ? await env.KV.get(`banner:${pb[1]}`) : null;
      if (!name) return json({});
      const b = (await myBanners(env, pb[1])).find(x => x.name === name);
      return json(b ? { name, asset: b.file, size: b.size } : {});
    }
    const prov = url.pathname.match(/^\/oauth\/(youtube|tiktok)\/cb$/)?.[1];
    if (prov) return oauthCallback(env, prov, url);

    const me = await whoami(env, req);
    if (!me) {
      if (url.pathname.startsWith('/api') || url.pathname.startsWith('/v/')) return json({ error: 'auth' }, 401);
      return html(LOGIN);
    }

    if (url.pathname === '/') return html(PAGE);
    if (url.pathname.startsWith('/v/')) return video(env, url.pathname.slice(3).replace(/\D/g, ''), req);
    const start = url.pathname.match(/^\/oauth\/(youtube|tiktok)\/start$/)?.[1];
    if (start) {
      if (!env.KV) return html(msgPage('❌ У воркера нет привязки KV'), 500);
      return oauthStart(env, me, start, url.searchParams.get('stats') === '1');
    }
    if (url.pathname === '/tg/connect') return tgConnect(env, me);
    if (url.pathname === '/api/state') return json(await state(env, me));
    if (url.pathname === '/api/live') return json(await liveState(env, me));
    if (url.pathname === '/api/stats') {
      let st = await kvGet(env, `stats:${me}`);
      if (!st || url.searchParams.get('refresh') || Date.now() - new Date(st.updated) > 3 * 3600e3) st = await refreshStats(env, me);
      return json(st);
    }

    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (url.pathname === '/api/start') {
        const st = b.p && b.ch ? { p: b.p, ch: b.ch } : streamFrom(b.url);
        if (!st) return json({ error: 'Не понял ссылку. Пример: twitch.tv/shadowkekw или kick.com/ник' }, 400);
        await env.KV.delete(`nostart:${me}:${st.p}:${st.ch}`);
        const r = await dispatchClip(env, me, st.p, st.ch, b);
        return r.status === 204 ? json({ ok: true, channel: st.ch + (st.p === 'kick' ? ' (Kick)' : '') })
          : json({ error: `GitHub ответил ${r.status}: ${(await r.text()).slice(0, 200)}` }, 500);
      }
      if (url.pathname === '/api/stop') {
        const run = await gh(env, `/actions/runs/${Number(b.id)}`).then(r => r.json());
        if (!(run.display_title || '').includes(`· ${me} `) && me !== firstUser(env)) return json({ error: 'не твой запуск' }, 403);
        const r = await gh(env, `/actions/runs/${Number(b.id)}/cancel`, { method: 'POST' });
        const mm = (run.display_title || '').match(/^🎬 ([\w-]+)( \[Kick\])? ·/);
        if (mm) await env.KV.put(`nostart:${me}:${mm[2] ? 'kick' : 'twitch'}:${mm[1]}`, 'manual', { expirationTtl: 12 * 3600 });
        return json({ ok: r.status === 202 });
      }
      // действия с клипом — только со своими
      if (url.pathname === '/api/decide') {
        const a = await gh(env, `/releases/assets/${Number(b.id)}`).then(r => r.json());
        if (!a.name) return json({ error: 'нет файла' }, 404);
        const p = parseName(env, a.name);
        if (p.owner !== me) return json({ error: 'не твой клип' }, 403);
        if (b.post) {
          const r = await gh(env, `/releases/assets/${a.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'ok_' + p.base, label: a.label || '' }) });
          return json({ ok: r.ok });
        }
        if (b.unqueue) {
          const r = await gh(env, `/releases/assets/${a.id}`, { method: 'PATCH', body: JSON.stringify({ name: p.base, label: a.label || '' }) });
          return json({ ok: r.ok });
        }
        const r = await gh(env, `/releases/assets/${a.id}`, { method: 'DELETE' });
        return json({ ok: r.status === 204 });
      }
      if (url.pathname === '/api/publish') return json(await publishNext(env, me));
      if (url.pathname === '/api/fav') {
        let favs = (await kvGet(env, `fav:${me}`)) || [];
        const st = b.p && b.ch ? { p: b.p, ch: String(b.ch).toLowerCase() } : streamFrom(b.url);
        if (!st) return json({ error: 'Не понял ссылку. Пример: twitch.tv/ник или kick.com/ник' }, 400);
        const i = favs.findIndex(f => f.p === st.p && f.ch === st.ch);
        if (b.action === 'del') favs = favs.filter((_, k) => k !== i);
        else if (b.action === 'auto') { if (i >= 0) favs[i].auto = !!b.auto; }
        else if (i < 0) favs.push({ ...st, auto: false });
        await kvPut(env, `fav:${me}`, favs.slice(0, 60));
        return json({ ok: true });
      }
      if (url.pathname === '/api/account') {
        const r = await changeAccount(env, me, b);
        return r.ok ? new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': await cookieFor(env, me) } }) : json(r, 400);
      }
      if (url.pathname === '/api/disconnect') {
        if (['youtube', 'tiktok'].includes(b.prov) && env.KV) await env.KV.delete(`acct:${me}:${b.prov}`);
        if (b.prov === 'telegram' && env.KV) await env.KV.delete(`tg:${me}`);
        return json({ ok: true });
      }
    }
    return json({ error: '404' }, 404);
  },
};

// ---------------------------------------------------------------- UI
// Дизайн в духе iOS: системные цвета, сгруппированные списки, таб-бар снизу на телефоне, сайдбар на компьютере.
const CSS = `
:root{color-scheme:light dark;
  --bg:#f2f2f7;--card:#fff;--card2:#f2f2f7;--sep:rgba(60,60,67,.18);--label:#000;--label2:rgba(60,60,67,.6);--label3:rgba(60,60,67,.3);
  --tint:#007aff;--green:#34c759;--red:#ff3b30;--orange:#ff9500;--fill:rgba(120,120,128,.12);--bar:rgba(249,249,249,.86);
  --yt:#2a78d6;--tt:#eb6834;--chart:#fff;--grid:rgba(60,60,67,.12)}
@media (prefers-color-scheme:dark){:root{
  --bg:#000;--card:#1c1c1e;--card2:#2c2c2e;--sep:rgba(84,84,88,.5);--label:#fff;--label2:rgba(235,235,245,.6);--label3:rgba(235,235,245,.3);
  --tint:#0a84ff;--green:#30d158;--red:#ff453a;--orange:#ff9f0a;--fill:rgba(120,120,128,.24);--bar:rgba(22,22,24,.86);
  --yt:#3987e5;--tt:#d95926;--chart:#1c1c1e;--grid:rgba(235,235,245,.1)}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--label);font:17px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--tint);text-decoration:none}
button{font:inherit;cursor:pointer;border:0;background:none;color:var(--tint);padding:0}
button:disabled{opacity:.4;cursor:default}
input,select{font:inherit;color:var(--label);background:transparent;border:0;outline:none;width:100%;padding:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:44px;padding:0 18px;border-radius:12px;background:var(--tint);color:#fff;font-weight:600;font-size:17px}
.btn.gray{background:var(--fill);color:var(--tint)}.btn.red{background:var(--red);color:#fff}.btn.green{background:var(--green);color:#fff}
.btn.sm{height:32px;padding:0 12px;border-radius:9px;font-size:15px}.btn.block{width:100%}
.err{color:var(--red);font-size:15px}`;

const msgPage = t => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ClipFarm</title>
<style>${CSS}.box{max-width:380px;margin:22vh auto;padding:28px 22px;background:var(--card);border-radius:20px;text-align:center}.box p{font-size:19px;font-weight:600;word-break:break-word;margin:0 0 20px}</style></head>
<body><div class="box"><p>${t.replace(/</g, '&lt;')}</p><a class="btn block" href="/#settings">Вернуться в ClipFarm</a></div></body></html>`;

const LOGIN = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000"><title>ClipFarm — вход</title><style>${CSS}
.wrap{max-width:360px;margin:0 auto;padding:16vh 20px 40px}
.logo{width:72px;height:72px;border-radius:18px;background:linear-gradient(160deg,#8b5cf6,#5b21b6);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;box-shadow:0 8px 24px rgba(91,33,182,.35)}
h1{font-size:28px;text-align:center;margin:0 0 6px;font-weight:700}.sub{color:var(--label2);text-align:center;font-size:15px;margin:0 0 26px}
.group{background:var(--card);border-radius:12px;overflow:hidden;margin-bottom:16px}
.group label{display:flex;align-items:center;min-height:48px;padding:0 16px}.group label+label{border-top:.5px solid var(--sep)}
.group span{width:84px;color:var(--label)}.group input{flex:1}
/* ===== Liquid Glass ===== */
:root{--glass:rgba(255,255,255,.58);--glass2:rgba(255,255,255,.72);--rim:rgba(255,255,255,.75);--rim2:rgba(255,255,255,.18);--shadow:0 8px 32px rgba(31,38,135,.10),0 1px 2px rgba(0,0,0,.04);--blur:saturate(190%) blur(26px);
  --ease:cubic-bezier(.2,.9,.25,1);--spring:cubic-bezier(.34,1.56,.64,1)}
@media (prefers-color-scheme:dark){:root{--glass:rgba(40,40,46,.52);--glass2:rgba(52,52,58,.66);--rim:rgba(255,255,255,.22);--rim2:rgba(255,255,255,.04);--shadow:0 10px 40px rgba(0,0,0,.45)}}
body{min-height:100vh}
body::before{content:"";position:fixed;inset:-20%;z-index:-1;pointer-events:none;
  background:radial-gradient(40% 35% at 15% 10%,rgba(124,92,255,.38),transparent 70%),radial-gradient(35% 30% at 90% 15%,rgba(0,170,255,.30),transparent 70%),
  radial-gradient(40% 35% at 80% 85%,rgba(255,120,60,.26),transparent 70%),radial-gradient(35% 30% at 10% 90%,rgba(52,199,89,.20),transparent 70%),var(--bg);
  animation:drift 28s ease-in-out infinite alternate}
@keyframes drift{to{transform:translate3d(3%,-2%,0) rotate(4deg) scale(1.05)}}
.group,.tile,.chart,.clip,.toast,.tip{background:var(--glass)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);
  border:1px solid var(--rim2);box-shadow:var(--shadow),inset 0 1px 0 var(--rim),inset 0 -1px 0 rgba(255,255,255,.06)}
.group,.tile,.chart{border-radius:22px}.clip{border-radius:22px}
.group{position:relative}
.group::after,.tile::after,.chart::after,.clip::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(135deg,rgba(255,255,255,.35),rgba(255,255,255,0) 38%,rgba(255,255,255,0) 70%,rgba(255,255,255,.12));mix-blend-mode:soft-light}
.tile,.chart,.clip{position:relative}
.row+.row::before{border-top-color:var(--sep)}
/* навигация — стеклянная капсула */
.nav{background:var(--glass2)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--rim2)!important;
  box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.nav .pill{position:absolute;z-index:0;border-radius:999px;background:var(--fill);box-shadow:inset 0 1px 0 var(--rim),0 2px 10px rgba(0,0,0,.08);
  transition:transform .5s var(--spring),width .5s var(--spring),height .5s var(--spring)}
.nav a{position:relative;z-index:1;transition:color .3s,transform .25s var(--spring)}.nav a:active{transform:scale(.9)}
@media (max-width:899px){
  .nav{left:14px;right:14px;bottom:calc(10px + env(safe-area-inset-bottom));border-radius:32px;padding:6px!important;border-top:1px solid var(--rim2)!important}
  .nav a{padding:6px 0;border-radius:26px}
  main{padding-bottom:calc(110px + env(safe-area-inset-bottom))!important}
  .toast{bottom:calc(100px + env(safe-area-inset-bottom))!important}
}
@media (min-width:900px){
  .nav{top:14px;bottom:14px;left:14px;width:236px;border-radius:26px;border-right:1px solid var(--rim2)!important}
  .nav a.on{background:transparent!important;color:var(--label)!important}.nav a.on svg{color:var(--tint)!important}
  .nav .pill{border-radius:14px;background:var(--glass2);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
  main{margin-left:264px!important}
}
/* сегменты со скользящим «стеклом» */
.seg{position:relative;background:var(--fill);border-radius:12px;padding:3px}
.seg .ind{position:absolute;top:3px;bottom:3px;left:0;border-radius:9px;background:var(--glass2);
  box-shadow:0 3px 10px rgba(0,0,0,.12),inset 0 1px 0 var(--rim);transition:transform .45s var(--spring),width .45s var(--spring)}
.seg button{position:relative;z-index:1;background:transparent!important;box-shadow:none!important;transition:color .25s,transform .2s var(--spring)}
.seg button:active{transform:scale(.94)}
/* кнопки — пружинка */
.btn{transition:transform .25s var(--spring),filter .2s,box-shadow .25s;box-shadow:0 4px 14px color-mix(in srgb,var(--tint) 30%,transparent),inset 0 1px 0 rgba(255,255,255,.35)}
.btn.gray{box-shadow:inset 0 1px 0 var(--rim);background:var(--glass2)}.btn.red{box-shadow:0 4px 14px color-mix(in srgb,var(--red) 30%,transparent),inset 0 1px 0 rgba(255,255,255,.3)}
.btn.green{box-shadow:0 4px 14px color-mix(in srgb,var(--green) 30%,transparent),inset 0 1px 0 rgba(255,255,255,.3)}
.btn:active{transform:scale(.95);filter:brightness(.95)}
@media (hover:hover){.btn:hover{filter:brightness(1.07)}.clip:hover{transform:translateY(-3px)}}
/* появление экранов и элементов */
.enter{animation:enter .55s var(--ease) both}
@keyframes enter{from{opacity:0;transform:translateY(14px) scale(.985);filter:blur(6px)}}
.enter .group,.enter .tile,.enter .chart,.enter .grid>*{animation:pop .6s var(--ease) both}
.enter>*:nth-child(2) {animation-delay:.03s}.enter>*:nth-child(3){animation-delay:.06s}.enter>*:nth-child(4){animation-delay:.09s}
.tiles>*:nth-child(2){animation-delay:.05s!important}.tiles>*:nth-child(3){animation-delay:.1s!important}.tiles>*:nth-child(4){animation-delay:.15s!important}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.97)}}
.clip{transition:transform .35s var(--spring),opacity .3s,box-shadow .3s;animation:pop .5s var(--ease) both}
.clip.out{opacity:0;transform:scale(.85)}
.row{transition:background .2s}a.row:active,.row:active{background:var(--fill)}
.toast{border-radius:999px!important;transition:transform .5s var(--spring),opacity .3s!important;transform:translateX(-50%) translateY(30px) scale(.9)!important}
.toast.on{transform:translateX(-50%) translateY(0) scale(1)!important}
.chart path.line{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:draw 1.2s var(--ease) .15s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
h1.title{animation:enter .6s var(--ease) both}
@media (prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition:none!important}}

.wrap{animation:enter .7s var(--ease) both}.logo{animation:pop .8s var(--spring) both}
</style></head><body><form class="wrap" method="post" action="/login">
<div class="logo"><svg width="38" height="38" viewBox="0 0 24 24" fill="none"><rect x="6" y="2.5" width="12" height="15" rx="2.5" stroke="#fff" stroke-width="2"/><path d="M10.5 7.2v5.6l4.4-2.8z" fill="#fff"/><path d="M4 21.5h2M8 21.5h2M12 20v1.5M16 21.5h2" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></div>
<h1>ClipFarm</h1><p class="sub">Нарезки со стримов на автопилоте</p>
<div class="group"><label><span>Логин</span><input name="login" autocomplete="username" autocapitalize="none" placeholder="tim" required></label>
<label><span>Пароль</span><input name="pass" type="password" autocomplete="current-password" placeholder="••••••" required></label></div>
<button class="btn block">Войти</button><!--err--></form></body></html>`;

const ICONS = {
  status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17"/></svg>',
  clips: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="3"/><path d="M10.5 9v6l5-3z" fill="currentColor"/></svg>',
  stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)">
<title>ClipFarm</title><style>${CSS}
/* навигация */
.nav{position:fixed;z-index:20;background:var(--bar);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px)}
.nav a{display:flex;color:var(--label2)}.nav a.on{color:var(--tint)}.nav svg{width:26px;height:26px}
@media (max-width:899px){
  .nav{left:0;right:0;bottom:0;border-top:.5px solid var(--sep);display:flex;padding:6px 0 calc(6px + env(safe-area-inset-bottom))}
  .nav a{flex:1;flex-direction:column;align-items:center;gap:2px;font-size:10.5px;font-weight:500}
  .nav .brand{display:none}
  main{padding:calc(env(safe-area-inset-top) + 8px) 16px calc(96px + env(safe-area-inset-bottom))}
}
@media (min-width:900px){
  .nav{left:0;top:0;bottom:0;width:250px;border-right:.5px solid var(--sep);padding:22px 12px;display:flex;flex-direction:column;gap:2px}
  .nav .brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;color:var(--label);padding:0 10px 18px}
  .nav a{align-items:center;gap:12px;padding:9px 12px;border-radius:10px;font-size:16px;color:var(--label)}
  .nav a svg{width:22px;height:22px;color:var(--tint)}.nav a.on{background:var(--tint);color:#fff}.nav a.on svg{color:#fff}
  main{margin-left:250px;padding:28px 40px 60px;max-width:1240px}
}
.mini{width:30px;height:30px;border-radius:8px;background:linear-gradient(160deg,#8b5cf6,#5b21b6);display:flex;align-items:center;justify-content:center}
h1.title{font-size:34px;font-weight:700;letter-spacing:.2px;margin:10px 4px 18px}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}.head .btn{margin-bottom:22px}
.sec{font-size:13px;text-transform:uppercase;letter-spacing:.3px;color:var(--label2);margin:26px 16px 7px}
.foot{font-size:13px;color:var(--label2);margin:7px 16px 0;line-height:1.4}
.group{background:var(--card);border-radius:12px;overflow:hidden}
.row{display:flex;align-items:center;gap:12px;min-height:50px;padding:9px 16px;position:relative}
.row+.row::before{content:"";position:absolute;top:0;left:16px;right:0;border-top:.5px solid var(--sep)}
.row.ico+.row.ico::before{left:58px}
.row .main{flex:1;min-width:0}.row .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row .s{font-size:14px;color:var(--label2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .v{color:var(--label2);font-size:16px;white-space:nowrap}
.badge{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;flex:none}
.live{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px color-mix(in srgb,var(--green) 25%,transparent);flex:none;animation:pulse 1.6s infinite}
.live.q{background:var(--orange);box-shadow:0 0 0 4px color-mix(in srgb,var(--orange) 25%,transparent)}
@keyframes pulse{50%{opacity:.45}}
.input-row{display:flex;gap:10px;align-items:center;padding:6px 6px 6px 16px}.input-row input{height:44px}
.seg{display:flex;background:var(--fill);border-radius:9px;padding:2px;gap:2px}
.seg button{flex:1;height:30px;border-radius:7px;color:var(--label);font-size:14px;font-weight:500;white-space:nowrap;padding:0 8px}
.seg button.on{background:var(--card);box-shadow:0 3px 8px rgba(0,0,0,.12),0 1px 1px rgba(0,0,0,.04);font-weight:600}
@media (prefers-color-scheme:dark){.seg button.on{background:#636366}}
.opts{display:grid;grid-template-columns:1fr;gap:12px;padding:12px 16px 14px}.opts label{font-size:13px;color:var(--label2);display:block;margin-bottom:6px}
@media (min-width:700px){.opts{grid-template-columns:1fr 1fr}}
.empty{text-align:center;color:var(--label2);padding:42px 20px;font-size:15px}.empty b{display:block;color:var(--label);font-size:17px;margin-bottom:4px}
/* клипы */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px}
@media (min-width:900px){.grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}}
.clip{background:var(--card);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.clip video{width:100%;aspect-ratio:9/16;background:#000;display:block;object-fit:cover}
.clip .meta{padding:9px 11px 4px;flex:1}.clip .meta b{font-size:15px;display:block}.clip .meta span{font-size:12.5px;color:var(--label2);display:block;margin-top:2px}
.clip .act{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px 10px 11px}.clip .act .btn{height:36px;font-size:15px;padding:0}
/* статистика */
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (min-width:900px){.tiles{grid-template-columns:repeat(4,1fr)}}
.tile{background:var(--card);border-radius:14px;padding:14px 16px}.tile .k{font-size:13px;color:var(--label2);display:flex;align-items:center;gap:6px}
.tile .n{font-size:28px;font-weight:700;letter-spacing:-.3px;margin-top:4px;font-variant-numeric:tabular-nums}.tile .d{font-size:13px;color:var(--green);margin-top:2px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.chart{background:var(--card);border-radius:14px;padding:14px 14px 8px;position:relative}
.chart .top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.legend{display:flex;gap:14px;font-size:13px;color:var(--label2)}.legend span{display:flex;align-items:center;gap:6px}
.chart svg{width:100%;height:240px;display:block;overflow:visible}
.tip{position:absolute;pointer-events:none;background:var(--card2);border-radius:10px;padding:8px 10px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.18);display:none;white-space:nowrap;z-index:2}
.tip b{display:block;margin-bottom:3px}.tip div{display:flex;align-items:center;gap:6px;color:var(--label)}
.toast{position:fixed;left:50%;transform:translateX(-50%) translateY(20px);bottom:calc(90px + env(safe-area-inset-bottom));background:var(--card2);color:var(--label);padding:12px 18px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-size:15px;opacity:0;transition:.25s;z-index:50;max-width:90vw;text-align:center}
.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
@media (min-width:900px){.toast{bottom:30px;left:calc(50% + 125px)}}
.hide{display:none!important}

/* стримеры */
.ava{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:none;background:var(--fill)}
.ava-wrap{position:relative;flex:none}.ava-wrap .pf{position:absolute;right:-3px;bottom:-3px;width:17px;height:17px;border-radius:6px;font-size:10px;font-weight:800;color:#fff;display:flex;align-items:center;justify-content:center;border:2px solid var(--card)}
.pf.twitch{background:#9146ff}.pf.kick{background:#53fc18;color:#000}
.ava-wrap.onair .ava{box-shadow:0 0 0 2px var(--card),0 0 0 4px var(--red)}
.lv{color:var(--red);font-weight:600}
.sw{position:relative;width:46px;height:28px;border-radius:999px;background:var(--fill);flex:none;transition:background .3s}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.25);transition:transform .35s var(--spring)}
.sw.on{background:var(--green)}.sw.on::after{transform:translateX(18px)}
.swl{font-size:11px;color:var(--label2);text-align:center;margin-top:2px}
.x{color:var(--label3);font-size:20px;padding:0 2px;line-height:1}
.shelf{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px 2px 10px;margin:0 -2px;-webkit-overflow-scrolling:touch}
.shelf::-webkit-scrollbar{display:none}
.scard{flex:0 0 220px;scroll-snap-align:start;border-radius:18px;overflow:hidden;position:relative;background:var(--glass)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--rim2);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);animation:pop .5s var(--ease) both}
.scard img.pv{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000}
.scard .vw{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.6);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:#fff;font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px}
.scard .vw::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff3b30;margin-right:5px;vertical-align:1px}
.scard .b{padding:9px 11px 11px;display:flex;align-items:center;gap:9px}.scard .b .main{flex:1;min-width:0}
.scard .t{font-weight:600;font-size:15px}.scard .s{font-size:12px;color:var(--label2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scard .acts{display:flex;gap:6px;padding:0 11px 11px}.scard .acts .btn{flex:1;height:34px;font-size:13.5px;white-space:nowrap;padding:0 8px}
/* ===== Liquid Glass ===== */
:root{--glass:rgba(255,255,255,.58);--glass2:rgba(255,255,255,.72);--rim:rgba(255,255,255,.75);--rim2:rgba(255,255,255,.18);--shadow:0 8px 32px rgba(31,38,135,.10),0 1px 2px rgba(0,0,0,.04);--blur:saturate(190%) blur(26px);
  --ease:cubic-bezier(.2,.9,.25,1);--spring:cubic-bezier(.34,1.56,.64,1)}
@media (prefers-color-scheme:dark){:root{--glass:rgba(40,40,46,.52);--glass2:rgba(52,52,58,.66);--rim:rgba(255,255,255,.22);--rim2:rgba(255,255,255,.04);--shadow:0 10px 40px rgba(0,0,0,.45)}}
body{min-height:100vh;background:transparent!important}
body::before{content:"";position:fixed;inset:-20%;z-index:-1;pointer-events:none;
  background:radial-gradient(40% 35% at 15% 10%,rgba(124,92,255,.38),transparent 70%),radial-gradient(35% 30% at 90% 15%,rgba(0,170,255,.30),transparent 70%),
  radial-gradient(40% 35% at 80% 85%,rgba(255,120,60,.26),transparent 70%),radial-gradient(35% 30% at 10% 90%,rgba(52,199,89,.20),transparent 70%),var(--bg);
  animation:drift 28s ease-in-out infinite alternate}
@keyframes drift{to{transform:translate3d(3%,-2%,0) rotate(4deg) scale(1.05)}}
.group,.tile,.chart,.clip,.toast,.tip{background:var(--glass)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);
  border:1px solid var(--rim2);box-shadow:var(--shadow),inset 0 1px 0 var(--rim),inset 0 -1px 0 rgba(255,255,255,.06)}
.group,.tile,.chart{border-radius:22px}.clip{border-radius:22px}
.group{position:relative}
.group::after,.tile::after,.chart::after,.clip::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(135deg,rgba(255,255,255,.35),rgba(255,255,255,0) 38%,rgba(255,255,255,0) 70%,rgba(255,255,255,.12));mix-blend-mode:soft-light}
.tile,.chart,.clip{position:relative}
.row+.row::before{border-top-color:var(--sep)}
/* навигация — стеклянная капсула */
.nav{background:var(--glass2)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--rim2)!important;
  box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.nav .pill{position:absolute;top:0;left:0;z-index:0;border-radius:999px;background:var(--fill);box-shadow:inset 0 1px 0 var(--rim),0 2px 10px rgba(0,0,0,.08);
  transition:transform .5s var(--spring),width .5s var(--spring),height .5s var(--spring)}
.nav a{position:relative;z-index:1;transition:color .3s,transform .25s var(--spring)}.nav a:active{transform:scale(.9)}
@media (max-width:899px){
  .nav{left:14px;right:14px;bottom:calc(10px + env(safe-area-inset-bottom));border-radius:32px;padding:6px!important;border-top:1px solid var(--rim2)!important}
  .nav a{padding:6px 0;border-radius:26px}
  main{padding-bottom:calc(110px + env(safe-area-inset-bottom))!important}
  .toast{bottom:calc(100px + env(safe-area-inset-bottom))!important}
}
@media (min-width:900px){
  .nav{top:14px;bottom:14px;left:14px;width:236px;border-radius:26px;border-right:1px solid var(--rim2)!important}
  .nav a.on{background:transparent!important;color:var(--label)!important}.nav a.on svg{color:var(--tint)!important}
  .nav .pill{border-radius:14px;background:var(--glass2);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
  main{margin-left:264px!important}
}
/* сегменты со скользящим «стеклом» */
.seg{position:relative;background:var(--fill);border-radius:12px;padding:3px}
.seg .ind{position:absolute;top:3px;bottom:3px;left:0;border-radius:9px;background:var(--glass2);
  box-shadow:0 3px 10px rgba(0,0,0,.12),inset 0 1px 0 var(--rim);transition:transform .45s var(--spring),width .45s var(--spring)}
.seg button{position:relative;z-index:1;background:transparent!important;box-shadow:none!important;transition:color .25s,transform .2s var(--spring)}
.seg button:active{transform:scale(.94)}
/* кнопки — пружинка */
.btn{transition:transform .25s var(--spring),filter .2s,box-shadow .25s;box-shadow:0 4px 14px color-mix(in srgb,var(--tint) 30%,transparent),inset 0 1px 0 rgba(255,255,255,.35)}
.btn.gray{box-shadow:inset 0 1px 0 var(--rim);background:var(--glass2)}.btn.red{box-shadow:0 4px 14px color-mix(in srgb,var(--red) 30%,transparent),inset 0 1px 0 rgba(255,255,255,.3)}
.btn.green{box-shadow:0 4px 14px color-mix(in srgb,var(--green) 30%,transparent),inset 0 1px 0 rgba(255,255,255,.3)}
.btn:active{transform:scale(.95);filter:brightness(.95)}
@media (hover:hover){.btn:hover{filter:brightness(1.07)}.clip:hover{transform:translateY(-3px)}}
/* появление экранов и элементов */
.enter{animation:enter .55s var(--ease) both}
@keyframes enter{from{opacity:0;transform:translateY(14px) scale(.985);filter:blur(6px)}}
.enter .group,.enter .tile,.enter .chart,.enter .grid>*{animation:pop .6s var(--ease) both}
.enter>*:nth-child(2) {animation-delay:.03s}.enter>*:nth-child(3){animation-delay:.06s}.enter>*:nth-child(4){animation-delay:.09s}
.tiles>*:nth-child(2){animation-delay:.05s!important}.tiles>*:nth-child(3){animation-delay:.1s!important}.tiles>*:nth-child(4){animation-delay:.15s!important}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.97)}}
.clip{transition:transform .35s var(--spring),opacity .3s,box-shadow .3s;animation:pop .5s var(--ease) both}
.clip.out{opacity:0;transform:scale(.85)}
.row{transition:background .2s}a.row:active,.row:active{background:var(--fill)}
.toast{border-radius:999px!important;transition:transform .5s var(--spring),opacity .3s!important;transform:translateX(-50%) translateY(30px) scale(.9)!important}
.toast.on{transform:translateX(-50%) translateY(0) scale(1)!important}
.chart path.line{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:draw 1.2s var(--ease) .15s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
h1.title{animation:enter .6s var(--ease) both}
@media (prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition:none!important}}

</style></head><body>
<nav class="nav"><span class="pill" id="pill"></span>
  <div class="brand"><span class="mini"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="6" y="2.5" width="12" height="15" rx="2.5" stroke="#fff" stroke-width="2.4"/><path d="M10.5 7.2v5.6l4.4-2.8z" fill="#fff"/></svg></span>ClipFarm</div>
  <a href="#status" data-t="status">${ICONS.status}<span>Статус</span></a>
  <a href="#clips" data-t="clips">${ICONS.clips}<span>Клипы</span></a>
  <a href="#stats" data-t="stats">${ICONS.stats}<span>Статистика</span></a>
  <a href="#settings" data-t="settings">${ICONS.settings}<span>Настройки</span></a>
</nav>
<main>
<!-- СТАТУС -->
<section id="v-status">
  <h1 class="title">Статус</h1>
  <div class="sec">Новый стрим</div>
  <div class="group">
    <div class="input-row"><input id="url" placeholder="Ссылка на Twitch / Kick или ник" autocapitalize="none" autocomplete="off" inputmode="url">
      <button class="btn sm" id="go" onclick="startCh()">Запустить</button></div>
    <div class="row" style="padding:0 16px"><button id="optbtn" onclick="$('opts').classList.toggle('hide');allInd();this.textContent=$('opts').classList.contains('hide')?'Параметры':'Скрыть параметры'" style="font-size:15px;padding:10px 0">Параметры</button></div>
    <div class="opts hide" id="opts">
      <div><label>Субтитры</label><div class="seg" id="seg-model"><button data-v="small">Быстрые</button><button data-v="medium" class="on">Точные</button><button data-v="large-v3-turbo">Макс.</button></div></div>
      <div><label>Игра</label><div class="seg" id="seg-game"><button data-v="Counter-Strike" class="on">Только CS2</button><button data-v="">Любая</button></div></div>
      <div><label>Сколько клипов</label><div class="seg" id="seg-mult"><button data-v="3.5">Меньше</button><button data-v="2.5" class="on">Норм</button><button data-v="2">Больше</button></div></div>
    </div>
  </div>
  <div class="foot">twitch.tv/ник, kick.com/ник или просто ник (= Twitch). Клипы начнут приходить после первых всплесков чата.</div>
  <div class="sec">Мои стримеры</div>
  <div class="group">
    <div class="input-row"><input id="fav-url" placeholder="Добавить: ссылка Twitch / Kick или ник" autocapitalize="none" autocomplete="off">
      <button class="btn sm gray" onclick="addFav()">＋</button></div>
    <div id="favs"></div>
  </div>
  <div class="foot">«Авто» — сам начну резать, когда стример выйдет в эфир с CS2 (проверка каждые 5 минут), и напишу в Telegram.</div>
  <div class="sec">Сейчас в эфире · CS2</div>
  <div class="shelf" id="discover"><div class="empty" style="width:100%">Загружаю…</div></div>
  <div class="sec">Сейчас режется</div>
  <div class="group" id="active"></div>
  <div class="sec">История запусков</div>
  <div class="group" id="history"></div>
</section>

<!-- КЛИПЫ -->
<section id="v-clips" class="hide">
  <div class="head"><h1 class="title">Клипы</h1></div>
  <div class="seg" id="seg-clips" style="margin-bottom:14px"><button data-v="fresh" class="on">Новые</button><button data-v="approved">В ожидании</button><button data-v="posted">Опубликованы</button></div>
  <div id="queue-bar" class="hide" style="margin-bottom:14px"><div class="group"><div class="row"><div class="main"><div class="t" id="next-slot"></div><div class="s">5 раз в день · по одному клипу</div></div>
    <button class="btn sm" onclick="publishNow(this)">Опубликовать</button></div></div></div>
  <div id="clips"></div>
</section>

<!-- СТАТИСТИКА -->
<section id="v-stats" class="hide">
  <div class="head"><h1 class="title">Статистика</h1><button class="btn sm gray" onclick="loadStats(true,this)">Обновить</button></div>
  <div id="stats-body"><div class="empty">Загружаю…</div></div>
</section>

<!-- НАСТРОЙКИ -->
<section id="v-settings" class="hide">
  <h1 class="title">Настройки</h1>
  <div class="sec">Аккаунты для постинга</div>
  <div class="group" id="accts"></div>
  <div class="foot">TikTok получает клипы в черновики: открой «Входящие» в приложении и опубликуй. Текст для поста приходит в Telegram.</div>
  <div class="sec">Баннер</div>
  <div class="group"><div class="row ico"><span class="badge" style="background:#af52de">🎞</span><div class="main"><div class="t" id="banner-now"></div><div class="s">Управление в боте: /banner</div></div></div></div>
  <div class="foot">Пришли боту видео на зелёном фоне — он спросит название. Потом <b>/banner Имя</b> — и баннер будет посередине каждого нового клипа. <b>/banner stop</b> — выключить.</div>
  <div class="sec">Профиль</div>
  <div class="group">
    <div class="row"><span style="width:110px">Логин</span><input id="f-login" autocapitalize="none" autocomplete="username"></div>
    <div class="row"><span style="width:110px">Новый пароль</span><input id="f-pass" type="password" placeholder="не менять" autocomplete="new-password"></div>
    <div class="row"><span style="width:110px">Текущий</span><input id="f-cur" type="password" placeholder="обязательно" autocomplete="current-password"></div>
  </div>
  <div style="margin:12px 0 0"><button class="btn block" onclick="saveAccount(this)">Сохранить</button></div>
  <div class="foot" id="acc-msg"></div>
  <div class="sec"></div>
  <div class="group"><a class="row" href="/logout" style="color:var(--red);justify-content:center">Выйти</a></div>
</section>
</main>
<div class="toast" id="toast"></div>
<script>
const $=id=>document.getElementById(id);
const api=(p,b)=>fetch(p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}).then(r=>{if(r.status===401)location.reload();return r.json()});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=n=>n>=1e6?(n/1e6).toFixed(n>=1e7?0:1).replace('.',',')+' млн':n>=1e4?Math.round(n/1e3)+' тыс':Number(n||0).toLocaleString('ru');
const ago=t=>{const m=Math.max(0,Math.round((Date.now()-new Date(t))/60000));return m<1?'только что':m<60?m+' мин назад':m<1440?Math.floor(m/60)+' ч назад':Math.floor(m/1440)+' дн назад'};
const dur=(a,b)=>{const m=Math.max(0,Math.round((new Date(b)-new Date(a))/60000));return m<60?m+' мин':Math.floor(m/60)+' ч '+(m%60)+' мин'};
function toast(t){const e=$('toast');e.textContent=t;e.classList.add('on');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('on'),3500)}
let S=null, ST=null, TAB='status', CLIPTAB='fresh', RANGE=30;

// навигация
function movePill(){const a=document.querySelector('.nav a.on'),p=$('pill'),n=document.querySelector('.nav');if(!a)return;
  const r=a.getBoundingClientRect(),nr=n.getBoundingClientRect();p.style.width=r.width+'px';p.style.height=r.height+'px';
  p.style.transform='translate('+(r.left-nr.left-1)+'px,'+(r.top-nr.top-1)+'px)'}
function segInd(el){let i=el.querySelector('.ind');if(!i){i=document.createElement('i');i.className='ind';el.prepend(i)}
  const b=el.querySelector('button.on');if(!b||!b.offsetWidth)return;i.style.width=b.offsetWidth+'px';i.style.transform='translateX('+b.offsetLeft+'px)'}
function allInd(){document.querySelectorAll('.seg').forEach(segInd)}
function show(t){const prev=TAB;TAB=['status','clips','stats','settings'].includes(t)?t:'status';
  document.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('on',a.dataset.t===TAB));movePill();
  document.querySelectorAll('main>section').forEach(s=>{const on=s.id==='v-'+TAB;s.classList.toggle('hide',!on);if(on){s.classList.remove('enter');void s.offsetWidth;s.classList.add('enter')}});
  if(TAB==='stats')loadStats();render();requestAnimationFrame(allInd);window.scrollTo({top:0,behavior:prev===TAB?'smooth':'instant'})}
window.addEventListener('resize',()=>{movePill();allInd()});
window.addEventListener('hashchange',()=>show(location.hash.slice(1)));
function seg(id,cb){const el=$(id);segInd(el);el.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;el.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));segInd(el);cb&&cb(b.dataset.v)})}
const segv=id=>$(id).querySelector('.on').dataset.v;
seg('seg-model');seg('seg-mult');seg('seg-game');seg('seg-clips',v=>{CLIPTAB=v;$('clips').innerHTML='';render()});

// статус
$('url').addEventListener('keydown',e=>{if(e.key==='Enter')startCh()});
async function startCh(){const b=$('go');b.disabled=true;
  const r=await api('/api/start',{url:$('url').value,model:segv('seg-model'),mult:segv('seg-mult'),game:segv('seg-game')});b.disabled=false;
  if(r.error)toast(r.error);else{$('url').value='';toast('▶ '+r.channel+' запускается — пара минут');setTimeout(refresh,3000)}}
async function stopRun(id,btn){btn.disabled=true;btn.textContent='Стоп…';await api('/api/stop',{id});toast('Останавливаю — до минуты');setTimeout(refresh,4000)}
function renderStatus(){
  $('active').innerHTML=S.active.length?S.active.map(r=>'<div class="row"><span class="live '+(r.status==='in_progress'?'':'q')+'"></span><div class="main"><div class="t">'+esc(r.title.replace('🎬 ',''))+'</div><div class="s">'+(r.status==='in_progress'?'идёт '+dur(r.started,Date.now()):'запускается…')+' · <a href="'+r.url+'" target="_blank">лог</a></div></div><button class="btn sm red" onclick="stopRun('+r.id+',this)">Стоп</button></div>').join('')
    :'<div class="empty"><b>Ничего не режется</b>Вставь ссылку на стрим выше</div>';
  const icon=c=>c==='success'?['var(--green)','✓']:c==='cancelled'?['#8e8e93','■']:['var(--orange)','!'];
  $('history').innerHTML=S.recent.length?S.recent.map(r=>{const[bg,ch]=icon(r.conclusion);return '<a class="row ico" href="'+r.url+'" target="_blank" style="color:inherit"><span class="badge" style="background:'+bg+'">'+ch+'</span><div class="main"><div class="t">'+esc(r.title.replace('🎬 ',''))+'</div><div class="s">'+ago(r.ended)+(r.started?' · '+dur(r.started,r.ended):'')+' · '+(r.conclusion==='success'?'завершён':r.conclusion==='cancelled'?'остановлен':'ошибка')+'</div></div><span class="v">›</span></a>'}).join('')
    :'<div class="empty">Запусков пока не было</div>';
}


// стримеры
let LV=null;
const pfb=p=>'<span class="pf '+p+'">'+(p==='kick'?'K':'T')+'</span>';
const avaHtml=(x)=>'<div class="ava-wrap'+(x.live?' onair':'')+'"><img class="ava" src="'+esc(x.avatar||'')+'" alt="" onerror="this.style.visibility=\\'hidden\\'">'+pfb(x.p)+'</div>';
async function loadLive(){LV=await api('/api/live');renderLive()}
function renderLive(){if(!LV)return;
  $('favs').innerHTML=LV.favs.length?LV.favs.map(f=>'<div class="row ico">'+avaHtml(f)+'<div class="main"><div class="t">'+esc(f.name||f.ch)+'</div><div class="s">'+
    (f.unknown?'статус недоступен':f.live?'<span class="lv">● '+fmt(f.viewers)+'</span> · '+esc(f.game||'')+(f.title?' · '+esc(f.title):''):'офлайн')+'</div></div>'+
    (f.running?'<span class="v" style="font-size:14px;color:var(--green)">режется</span>':(f.live||f.unknown?'<button class="btn sm" onclick="startFav(\\''+f.p+'\\',\\''+f.ch+'\\',this)">Резать</button>':''))+
    '<div><div class="sw'+(f.auto?' on':'')+'" onclick="autoFav(\\''+f.p+'\\',\\''+f.ch+'\\',this)"></div><div class="swl">авто</div></div>'+
    '<button class="x" title="Убрать" onclick="delFav(\\''+f.p+'\\',\\''+f.ch+'\\')">×</button></div>').join('')
    :'<div class="empty" style="padding:22px">Добавь стримеров — увижу, кто в эфире</div>';
  $('discover').innerHTML=LV.discover.length?LV.discover.map(d=>'<div class="scard"><img class="pv" src="'+esc(d.preview)+'" alt="" loading="lazy"><span class="vw">'+fmt(d.viewers)+'</span>'+
    '<div class="b">'+avaHtml(d)+'<div class="main"><div class="t">'+esc(d.name)+'</div><div class="s">'+esc(d.title)+'</div></div></div>'+
    '<div class="acts">'+(d.fav?'<button class="btn sm gray" disabled>★ В списке</button>':'<button class="btn sm gray" onclick="favD(\\''+d.p+'\\',\\''+d.ch+'\\',this)">＋ В список</button>')+
    (d.running?'<button class="btn sm green" disabled>Режется</button>':'<button class="btn sm" onclick="startFav(\\''+d.p+'\\',\\''+d.ch+'\\',this)">Резать</button>')+'</div></div>').join('')
    :'<div class="empty" style="width:100%">Сейчас никто не стримит CS2</div>';
}
async function addFav(){const r=await api('/api/fav',{url:$('fav-url').value});if(r.error)return toast(r.error);$('fav-url').value='';toast('★ Добавлен');loadLive()}
$('fav-url').addEventListener('keydown',e=>{if(e.key==='Enter')addFav()});
async function delFav(p,ch){if(!confirm('Убрать '+ch+' из списка?'))return;await api('/api/fav',{p,ch,action:'del'});loadLive()}
async function favD(p,ch,b){b.disabled=true;await api('/api/fav',{p,ch});toast('★ '+ch+' в списке');loadLive()}
async function autoFav(p,ch,el){const on=!el.classList.contains('on');el.classList.toggle('on',on);await api('/api/fav',{p,ch,action:'auto',auto:on});toast(on?'Авто включено для '+ch:'Авто выключено')}
async function startFav(p,ch,b){b.disabled=true;b.textContent='…';const r=await api('/api/start',{p,ch,model:segv('seg-model'),mult:segv('seg-mult'),game:segv('seg-game')});
  if(r.error){b.disabled=false;b.textContent='Резать';return toast(r.error)}toast('▶ '+r.channel+' запускается');setTimeout(()=>{refresh();loadLive()},3000)}

// клипы
async function act(c,body){const el=document.querySelector('[data-id="'+c.id+'"]');if(el){el.querySelector('video')?.pause();el.classList.add('out');setTimeout(()=>el.remove(),300)}
  await api('/api/decide',{id:c.id,...body});toast(body.post?'✅ В очереди на постинг':body.unqueue?'↩ Вернул в новые':'🗑 Удалён');refresh()}
async function publishNow(btn){btn.disabled=true;btn.textContent='Публикую…';const r=await api('/api/publish',{});btn.disabled=false;btn.textContent='Опубликовать';
  toast(r.skipped?('Пропуск: '+r.skipped):'🚀 '+Object.entries(r.res||{}).map(([k,v])=>(k==='youtube'?'YouTube':'TikTok')+': '+(String(v).startsWith('http')?'готово':v)).join(' · '));refresh()}
const SLOTS=[7,10,13,16,19];
function nextSlot(){const d=new Date();for(let i=0;i<48;i++){const x=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCHours())+(i+1)*3600e3);if(SLOTS.includes(x.getUTCHours()))return x}}
function copyText(btn){navigator.clipboard.writeText(btn.dataset.c).then(()=>toast('Скопировано'))}
function renderClips(){
  const seg=$('seg-clips').querySelectorAll('button');seg[0].textContent='Новые'+(S.fresh.length?' '+S.fresh.length:'');seg[1].textContent='В ожидании'+(S.approved.length?' '+S.approved.length:'');
  $('queue-bar').classList.toggle('hide',CLIPTAB!=='approved'||!S.approved.length);
  $('next-slot').textContent='Следующий пост в '+nextSlot().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
  const box=$('clips');
  if(CLIPTAB==='posted'){
    box.innerHTML=S.log.length?'<div class="group">'+S.log.map(e=>{const yt=String(e.res?.youtube||''),tt=String(e.res?.tiktok||'');
      return '<div class="row"><div class="main"><div class="t">'+esc(e.title)+'</div><div class="s">'+esc(e.streamer||'')+' · '+ago(e.t)+
      (yt?' · '+(yt.startsWith('http')?'<a href="'+yt+'" target="_blank">YouTube</a>':'YouTube ⚠️'):'')+(tt?' · TikTok '+(tt.startsWith('⚠️')?'⚠️':'✓'):'')+'</div></div>'+
      '<button class="btn sm gray" onclick="copyText(this)" data-c="'+esc(e.title+' '+(e.tags||[]).map(t=>'#'+t).join(' '))+'">Текст</button></div>'}).join('')+'</div>'
      :'<div class="group"><div class="empty"><b>Пока ничего не опубликовано</b>Посты выходят 5 раз в день из очереди</div></div>';
    return}
  const list=S[CLIPTAB];
  if(!list.length){box.innerHTML='<div class="group"><div class="empty">'+(CLIPTAB==='fresh'?'<b>Новых клипов нет</b>Они появятся после всплесков чата':'<b>Очередь пуста</b>Одобри клипы во вкладке «Новые»')+'</div></div>';return}
  let grid=box.querySelector('.grid');if(!grid){box.innerHTML='<div class="grid"></div>';grid=box.querySelector('.grid')}
  const want=new Set(list.map(c=>String(c.id)));[...grid.children].forEach(e=>{if(!want.has(e.dataset.id))e.remove()});
  const have=new Set([...grid.children].map(e=>e.dataset.id));
  list.slice().reverse().forEach(c=>{if(have.has(String(c.id)))return;
    const d=document.createElement('div');d.className='clip';d.dataset.id=c.id;
    d.innerHTML='<video src="/v/'+c.id+'" controls preload="metadata" playsinline></video><div class="meta"><b>'+esc(c.streamer)+'</b><span>'+esc(c.label.replace(/^чат:\\s*/,'💬 '))+'</span><span>'+ago(c.created)+'</span></div>'+
      '<div class="act">'+(CLIPTAB==='fresh'?'<button class="btn green ok">Постить</button><button class="btn gray no" style="color:var(--red)">Удалить</button>':'<button class="btn gray back">Вернуть</button><button class="btn gray no" style="color:var(--red)">Удалить</button>')+'</div>';
    d.querySelector('.ok')?.addEventListener('click',()=>act(c,{post:true}));
    d.querySelector('.back')?.addEventListener('click',()=>act(c,{unqueue:true}));
    d.querySelector('.no').addEventListener('click',()=>{if(confirm('Удалить клип?'))act(c,{})});
    if(CLIPTAB==='approved')grid.appendChild(d);else grid.prepend(d)});
}

// настройки
async function disc(p){if(!confirm('Отключить?'))return;await api('/api/disconnect',{prov:p});toast('Отключено');refresh()}
function renderSettings(){
  const A=S.accounts, row=(p,name,bg,ico,a,extra)=>'<div class="row ico"><span class="badge" style="background:'+bg+'">'+ico+'</span><div class="main"><div class="t">'+name+'</div><div class="s">'+(a?'✓ '+esc(a.name):'не подключён')+(extra||'')+'</div></div>'+
    (a?'<button style="color:var(--red);font-size:15px" onclick="disc(\\''+p+'\\')">Отключить</button>':(S.oauth[p]&&S.kv?'<a class="btn sm" href="'+(p==='telegram'?'/tg/connect" target="_blank':'/oauth/'+p+'/start')+'">Подключить</a>':'<span class="v" style="font-size:14px">не настроено</span>'))+'</div>';
  $('accts').innerHTML=row('youtube','YouTube Shorts','#ff0000','▶',A.youtube)+row('tiktok','TikTok','#000','♪',A.tiktok,A.tiktok&&!A.tiktok.stats?' · <a href="/oauth/tiktok/start?stats=1">включить статистику</a>':'')+row('telegram','Telegram-бот','#2aabee','✈',A.telegram);
  $('banner-now').textContent=S.banner?'Включён: '+S.banner:'Выключен';
  if(document.activeElement!==$('f-login')&&!$('f-login').value)$('f-login').value=S.login;
}
async function saveAccount(btn){btn.disabled=true;const r=await api('/api/account',{login:$('f-login').value,password:$('f-pass').value,current:$('f-cur').value});btn.disabled=false;
  $('acc-msg').innerHTML=r.ok?'<span style="color:var(--green)">✓ Сохранено. Логин: '+esc(r.login)+'</span>':'<span class="err">'+esc(r.error)+'</span>';if(r.ok){$('f-pass').value='';$('f-cur').value='';refresh()}}

// статистика
async function loadStats(force,btn){if(btn){btn.disabled=true;btn.textContent='Обновляю…'}
  ST=await api('/api/stats'+(force?'?refresh=1':''));if(btn){btn.disabled=false;btn.textContent='Обновить'}renderStats()}
function series(){const days=Object.keys(ST.days||{}).sort().slice(-RANGE);return days.map(d=>({d,yt:ST.days[d].yt,tt:ST.days[d].tt,ytSubs:ST.days[d].ytSubs,ttSubs:ST.days[d].ttSubs}))}
function renderStats(){
  const box=$('stats-body');if(!ST||!S)return;
  const A=S.accounts, pts=series(), last=pts[pts.length-1]||{}, first=pts[0]||{};
  if(!A.youtube&&!A.tiktok){box.innerHTML='<div class="group"><div class="empty"><b>Нет подключённых аккаунтов</b>Подключи YouTube или TikTok в настройках</div></div>';return}
  const delta=(k)=>pts.length>1&&last[k]!=null&&first[k]!=null&&last[k]>first[k]?'+'+fmt(last[k]-first[k])+' за период':'';
  const total=(last.yt||0)+(last.tt||0);
  const tile=(k,n,d,dot)=>'<div class="tile"><div class="k">'+(dot?'<span class="dot" style="background:'+dot+'"></span>':'')+k+'</div><div class="n">'+n+'</div><div class="d">'+(d||'&nbsp;')+'</div></div>';
  let h='<div class="tiles">'+tile('Всего просмотров',fmt(total),'')+tile('YouTube',A.youtube?fmt(last.yt||0):'—',delta('yt'),'var(--yt)')+
    tile('TikTok',A.tiktok?.stats?fmt(last.tt||0):'—',A.tiktok&&!A.tiktok.stats?'<a href="/oauth/tiktok/start?stats=1">включить</a>':delta('tt'),'var(--tt)')+
    tile('Подписчики',fmt((last.ytSubs||0)+(last.ttSubs||0)),'')+'</div>';
  h+='<div class="sec" style="margin-left:4px">Просмотры, всего</div><div class="chart"><div class="top"><div class="legend">'+(A.youtube?'<span><i class="dot" style="background:var(--yt)"></i>YouTube</span>':'')+(A.tiktok?.stats?'<span><i class="dot" style="background:var(--tt)"></i>TikTok</span>':'')+'</div>'+
    '<div class="seg" id="seg-range" style="width:210px"><button data-v="7"'+(RANGE==7?' class="on"':'')+'>7 дн</button><button data-v="30"'+(RANGE==30?' class="on"':'')+'>30 дн</button><button data-v="90"'+(RANGE==90?' class="on"':'')+'>90 дн</button></div></div>'+
    (pts.length<2?'<div class="empty" style="padding:50px 10px"><b>Мало данных</b>График появится, когда накопится хотя бы два дня</div>':'<div id="chart-host"></div><div class="tip" id="tip"></div>')+'</div>';
  h+='<div class="sec" style="margin-left:4px">Лучшие клипы</div><div class="group">'+((ST.top||[]).length?ST.top.slice(0,15).map((v,i)=>'<div class="row"><span style="width:22px;color:var(--label2);font-variant-numeric:tabular-nums">'+(i+1)+'</span><div class="main"><div class="t">'+esc(v.title)+'</div><div class="s">'+
      (v.yt!=null?'<span class="dot" style="background:var(--yt)"></span> '+(v.ytUrl?'<a href="'+v.ytUrl+'" target="_blank">'+fmt(v.yt)+'</a>':fmt(v.yt))+'&nbsp;&nbsp;':'')+(v.tt!=null?'<span class="dot" style="background:var(--tt)"></span> '+(v.ttUrl?'<a href="'+v.ttUrl+'" target="_blank">'+fmt(v.tt)+'</a>':fmt(v.tt)):'')+'</div></div><span class="v">'+fmt((v.yt||0)+(v.tt||0))+'</span></div>').join('')
    :'<div class="empty">Появится после первых публикаций</div>')+'</div>';
  h+='<div class="foot">Обновлено '+(ST.updated?ago(ST.updated):'—')+'. Данные собираются автоматически 5 раз в день.'+((ST.errors||[]).length?'<br><span class="err">'+esc(ST.errors.join(' · '))+'</span>':'')+'</div>';
  box.innerHTML=h;
  box.querySelectorAll('.tile .n').forEach(el=>{const m=el.textContent.match(/^([\d\s ]+)$/);if(!m)return;const to=+m[1].replace(/\D/g,'');if(!to)return;
    const t0=performance.now();const f=t=>{const k=Math.min(1,(t-t0)/900),e=1-Math.pow(1-k,3);el.textContent=Math.round(to*e).toLocaleString('ru');if(k<1)requestAnimationFrame(f)};requestAnimationFrame(f)});
  seg('seg-range',v=>{RANGE=+v;renderStats()});
  if(pts.length>=2)drawChart(pts,A);
}
// линейный график: накопительные просмотры по площадкам; ось одна, подписи прямо на линиях, тултип с перекрестием
function drawChart(pts,A){
  const host=$('chart-host'),W=host.clientWidth||600,H=240,pl=8,pr=60,pt=12,pb=26;
  const keys=[];if(A.youtube)keys.push(['yt','YouTube','var(--yt)']);if(A.tiktok?.stats)keys.push(['tt','TikTok','var(--tt)']);
  const max=Math.max(1,...pts.flatMap(p=>keys.map(k=>p[k[0]]||0)));
  const nice=v=>{const e=Math.pow(10,Math.floor(Math.log10(v))),f=v/e;return [1,1.5,2,2.5,3,4,5,6,8,10].find(x=>x>=f-1e-9)*e};
  const top=nice(max*1.08/4)*4,X=i=>pl+(W-pl-pr)*i/(pts.length-1),Y=v=>pt+(H-pt-pb)*(1-v/top);
  let svg='<svg viewBox="0 0 '+W+' '+H+'" id="csvg">';
  for(let g=0;g<=4;g++){const v=top*g/4,y=Y(v);svg+='<line x1="'+pl+'" x2="'+(W-pr+8)+'" y1="'+y+'" y2="'+y+'" stroke="var(--grid)" stroke-width="1"/><text x="'+(W-pr+12)+'" y="'+(y+4)+'" font-size="11" fill="var(--label2)">'+fmt(v)+'</text>'}
  const step=Math.max(1,Math.ceil(pts.length/Math.max(2,Math.floor(W/80))));
  pts.forEach((p,i)=>{if((i%step===0&&pts.length-1-i>=step*0.7)||i===pts.length-1)svg+='<text x="'+X(i)+'" y="'+(H-6)+'" font-size="11" fill="var(--label2)" text-anchor="'+(i===0?'start':i===pts.length-1?'end':'middle')+'">'+new Date(p.d).toLocaleDateString('ru',{day:'numeric',month:'short'})+'</text>'});
  keys.forEach(([k,n,c])=>{const d=pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[k]||0).toFixed(1)).join(' ');
    svg+='<path class="line" d="'+d+'" fill="none" stroke="'+c+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    const lp=pts[pts.length-1];svg+='<circle cx="'+X(pts.length-1)+'" cy="'+Y(lp[k]||0)+'" r="4" fill="'+c+'" stroke="var(--chart)" stroke-width="2"/>'});
  svg+='<line id="cross" y1="'+pt+'" y2="'+(H-pb)+'" stroke="var(--label3)" stroke-width="1" visibility="hidden"/>';
  keys.forEach(([k,,c])=>svg+='<circle id="hv-'+k+'" r="5" fill="'+c+'" stroke="var(--chart)" stroke-width="2" visibility="hidden"/>');
  svg+='<rect x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent" id="hit"/></svg>';
  host.innerHTML=svg;
  host.querySelectorAll('path.line').forEach(p=>p.style.setProperty('--len',Math.ceil(p.getTotalLength())));
  const tip=$('tip'),hit=$('hit'),cross=$('cross'),svgEl=$('csvg');
  const move=e=>{const r=svgEl.getBoundingClientRect(),cx=((e.touches?e.touches[0].clientX:e.clientX)-r.left)*W/r.width;
    const i=Math.max(0,Math.min(pts.length-1,Math.round((cx-pl)/((W-pl-pr)/(pts.length-1))))),p=pts[i];
    cross.setAttribute('x1',X(i));cross.setAttribute('x2',X(i));cross.setAttribute('visibility','visible');
    keys.forEach(([k])=>{const c=$('hv-'+k);c.setAttribute('cx',X(i));c.setAttribute('cy',Y(p[k]||0));c.setAttribute('visibility','visible')});
    tip.innerHTML='<b>'+new Date(p.d).toLocaleDateString('ru',{day:'numeric',month:'long'})+'</b>'+keys.map(([k,n,c])=>'<div><span class="dot" style="background:'+c+'"></span>'+n+': '+fmt(p[k]||0)+'</div>').join('');
    tip.style.display='block';const px=X(i)*r.width/W+14;tip.style.left=Math.min(px,r.width-tip.offsetWidth)+'px';tip.style.top='54px'};
  const out=()=>{tip.style.display='none';cross.setAttribute('visibility','hidden');keys.forEach(([k])=>$('hv-'+k).setAttribute('visibility','hidden'))};
  hit.addEventListener('mousemove',move);hit.addEventListener('touchmove',move,{passive:true});hit.addEventListener('touchstart',move,{passive:true});
  hit.addEventListener('mouseleave',out);hit.addEventListener('touchend',()=>setTimeout(out,1500));
}

function render(){if(!S)return;renderStatus();renderClips();renderSettings();if(TAB==='stats'&&ST)renderStats()}
async function refresh(){S=await api('/api/state');render()}
show(location.hash.slice(1)||'status');setTimeout(()=>{movePill();allInd()},300);loadLive();setInterval(()=>{if(TAB==='status')loadLive()},60000);refresh();setInterval(refresh,15000);
window.addEventListener('resize',()=>{if(TAB==='stats'&&ST)renderStats()});
</script></body></html>`;
