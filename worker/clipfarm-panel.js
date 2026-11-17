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

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('cf:' + (env.GH_PAT || '') + (env.USERS || env.PANEL_PASS || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function whoami(env, req) {
  const m = (req.headers.get('Cookie') || '').match(/cf_auth=([a-z0-9_]+)\.([0-9a-f]{32})/);
  if (!m || !users(env)[m[1]]) return null;
  return (await hmac(env, 'u:' + m[1])) === m[2] ? m[1] : null;
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
  const recent = runs.filter(r => r.status === 'completed').slice(0, 5).map(r => ({
    id: r.id, title: r.display_title.replace(` · ${me}`, ''), conclusion: r.conclusion, url: r.html_url }));
  const clips = assets.map(a => ({ id: a.id, name: a.name, label: a.label || '', size: a.size, created: a.created_at, ...parseName(env, a.name) }))
    .filter(c => c.owner === me).sort((a, b) => b.created.localeCompare(a.created));
  return {
    me, active, recent, banner,
    fresh: clips.filter(c => c.stage === 'fresh'),
    approved: clips.filter(c => c.stage === 'approved').reverse(),       // очередь: старые первыми
    posted: clips.filter(c => c.stage === 'posted').slice(0, 30),
    accounts: { youtube: yt ? { name: yt.name } : null, tiktok: tt ? { name: tt.name } : null,
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

async function oauthStart(env, me, prov) {
  const state = `${me}.${await hmac(env, 'o:' + me + prov)}`;
  if (prov === 'youtube') {
    const q = new URLSearchParams({ client_id: env.YT_CLIENT_ID, redirect_uri: `${BASE}/oauth/youtube/cb`, response_type: 'code',
      scope: YT_SCOPES, access_type: 'offline', prompt: 'consent select_account', state });
    return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
  }
  const q = new URLSearchParams({ client_key: env.TT_CLIENT_KEY, redirect_uri: `${BASE}/oauth/tiktok/cb`, response_type: 'code',
    scope: 'user.info.basic,video.upload', state });
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
  await kvPut(env, `acct:${owner}:tiktok`, { refresh: t.refresh_token, open_id: t.open_id, name });
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

async function tgHook(env, req) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await hmac(env, 'tghook')) return new Response('no', { status: 403 });
  const u = await req.json().catch(() => ({}));
  if (u.callback_query) return clipButton(env, u.callback_query);
  const m = u.message;
  if (!m) return new Response('ok');
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
  if (await env.KV.get('hook:v2')) return;
  await tg(env, 'setWebhook', { url: `${BASE}/tg/hook`, secret_token: await hmac(env, 'tghook'), allowed_updates: ['message', 'callback_query'] });
  await env.KV.put('hook:v2', '1');
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
  const fallback = { title: `${streamer} выдал завозик 😳`, tags: [streamer, 'twitch', 'стрим', 'нарезки'] };
  if (!env.GEMINI_KEY) return fallback;
  const prompt = `Ты админ молодёжного паблика с нарезками со стримов (TikTok и YouTube Shorts, зрители 14–25 лет, Россия/СНГ).
Стример: ${streamer}. Что спамил чат в момент клипа: ${c.label.replace(/^чат:\s*/, '') || 'нет данных'}.

Напиши заголовок так, как его написал бы зумер в тиктоке:
- молодёжный сленг стримерской тусовки: «завозик», «дабл ю» / «W», «L», «имба», «база», «жиза», «кринж», «рофл», «вайб», «пон», «сигма», «ауф», «изи», «тильт», «катка», «чат в шоке» — 1–3 слова на заголовок, по смыслу, не все сразу;
- можно капс на одном слове для эмоции, 1–2 эмодзи (😭💀🔥😳🤯);
- до 70 символов, без кавычек, без мата (можно ж*па-стиль со звёздочкой, но лучше без), без слов про насилие, криминал, кровь, «шок», «жесть»;
- не выдумывай конкретные события, которых нет в данных, — играй на эмоции чата и ник стримера;
- ник стримера пиши как есть.
Примеры стиля: «${streamer} выдал ЗАВОЗИК, чат в отлёте 💀», «это просто дабл ю от ${streamer} 🔥», «${streamer} словил тильт 😭 жиза».

Ещё 5 хештегов без # латиницей или кириллицей, без пробелов: ник стримера, twitch, нарезки + 2 по теме.
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
  const tok = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: acct.refresh, grant_type: 'refresh_token' }) }).then(r => r.json());
  if (!tok.access_token) throw new Error('токен YouTube: ' + JSON.stringify(tok).slice(0, 200));
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

async function postTikTok(env, owner, acct, c) {
  const tok = await fetch('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_key: env.TT_CLIENT_KEY, client_secret: env.TT_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: acct.refresh }) }).then(r => r.json());
  if (!tok.access_token) throw new Error('токен TikTok: ' + JSON.stringify(tok).slice(0, 200));
  if (tok.refresh_token && tok.refresh_token !== acct.refresh) await kvPut(env, `acct:${owner}:tiktok`, { ...acct, refresh: tok.refresh_token });
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

// ---------------------------------------------------------------- router
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { for (const u of Object.keys(users(env))) { try { await publishNext(env, u); } catch (e) {} } })());
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/login' && req.method === 'POST') {
      const f = await req.formData(), pass = f.get('pass');
      const user = Object.entries(users(env)).find(([, p]) => p && p === pass)?.[0];
      if (user) return new Response(null, { status: 302, headers: { Location: '/',
        'Set-Cookie': `cf_auth=${user}.${await hmac(env, 'u:' + user)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` } });
      return html(LOGIN.replace('<!--err-->', '<p class="err">Неверный пароль</p>'), 401);
    }
    if (url.pathname === '/logout') return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': 'cf_auth=; Path=/; Max-Age=0' } });

    if (url.pathname === '/tg/hook' && req.method === 'POST') return tgHook(env, req);
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
      return oauthStart(env, me, start);
    }
    if (url.pathname === '/tg/connect') return tgConnect(env, me);
    if (url.pathname === '/api/state') return json(await state(env, me));

    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (url.pathname === '/api/start') {
        const ch = channelFrom(b.url);
        if (!ch) return json({ error: 'Не понял ссылку. Пример: twitch.tv/shadowkekw' }, 400);
        const r = await gh(env, `/actions/workflows/${WF}/dispatches`, { method: 'POST',
          body: JSON.stringify({ ref: 'main', inputs: { channel: ch, owner: me, model: b.model || 'medium', mult: String(b.mult || '2.5'), part: '1' } }) });
        return r.status === 204 ? json({ ok: true, channel: ch })
          : json({ error: `GitHub ответил ${r.status}: ${(await r.text()).slice(0, 200)}` }, 500);
      }
      if (url.pathname === '/api/stop') {
        const run = await gh(env, `/actions/runs/${Number(b.id)}`).then(r => r.json());
        if (!(run.display_title || '').includes(`· ${me} `) && me !== firstUser(env)) return json({ error: 'не твой запуск' }, 403);
        const r = await gh(env, `/actions/runs/${Number(b.id)}/cancel`, { method: 'POST' });
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
const CSS = `:root{--bg:#0e0f13;--card:#181a21;--line:#262934;--txt:#e9eaf0;--mut:#8b8fa3;--acc:#9146ff;--ok:#22c55e;--no:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.4 -apple-system,system-ui,sans-serif}
input,select{background:var(--card);border:1px solid var(--line);color:var(--txt);padding:10px 12px;border-radius:10px;font-size:14px}
button,.btn{border:0;border-radius:10px;padding:10px 14px;font-weight:600;font-size:14px;cursor:pointer;color:#fff;background:#2a2d38;white-space:nowrap;text-decoration:none;display:inline-block}
button:hover,.btn:hover{filter:brightness(1.15)}button:disabled{opacity:.5;cursor:default}.go{background:var(--acc)}.ok{background:var(--ok)}.no{background:var(--no)}
.err{color:var(--no)}a{color:#b794ff}`;

const msgPage = t => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClipFarm</title>
<style>${CSS}div{max-width:420px;margin:20vh auto;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:16px;text-align:center}p{font-size:16px;word-break:break-word}</style></head>
<body><div><p>${t.replace(/</g, '&lt;')}</p><a class="btn go" href="/">← В панель</a></div></body></html>`;

const LOGIN = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClipFarm</title><style>${CSS}
form{max-width:320px;margin:18vh auto;display:flex;flex-direction:column;gap:12px;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:16px}
h1{margin:0 0 6px;font-size:22px}h1 b{color:var(--acc)}</style></head><body>
<form method="post" action="/login"><h1>Clip<b>Farm</b></h1><input type="password" name="pass" placeholder="Пароль" autofocus>
<button class="go">Войти</button><!--err--></form></body></html>`;

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ClipFarm</title><style>${CSS}
header{position:sticky;top:0;z-index:5;background:rgba(14,15,19,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:12px 18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0 10px 0 0}h1 b{color:var(--acc)}#url{flex:1;min-width:220px;max-width:380px}.sp{flex:1}
main{padding:16px 18px}h2{font-size:15px;margin:22px 0 12px;color:var(--mut);font-weight:600;display:flex;gap:10px;align-items:center}
.runs{display:flex;flex-direction:column;gap:8px}
.row{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row b{flex:1}.dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}.q .dot{background:#eab308;box-shadow:0 0 8px #eab308}
.mut{color:var(--mut);font-size:12.5px}
.accts{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.tabs{display:flex;gap:6px;flex-wrap:wrap}.tabs button{background:transparent;color:var(--mut);padding:6px 10px}.tabs button.on{background:#2a2d38;color:var(--txt)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.clip{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
video{width:100%;aspect-ratio:9/16;background:#000;display:block}
.meta{padding:8px 10px;font-size:12px;color:var(--mut);flex:1}.meta b{color:var(--txt);display:block;font-size:12.5px;word-break:break-all}
.act{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 10px 10px}.act.one{grid-template-columns:1fr}.act button{padding:10px 6px}
.empty{color:var(--mut);padding:30px;text-align:center;border:1px dashed var(--line);border-radius:14px;grid-column:1/-1}
.log{display:flex;flex-direction:column;gap:8px}.log .row{align-items:flex-start}.log .row div{flex:1;min-width:0}.log code{font-size:12px;color:var(--mut);word-break:break-all}
</style></head><body>
<header>
  <h1>Clip<b>Farm</b></h1>
  <input id="url" placeholder="https://twitch.tv/shadowkekw">
  <select id="model"><option value="medium">Субтитры: точные</option><option value="large-v3-turbo">Самые точные (медленнее)</option><option value="small">Быстрые</option></select>
  <select id="mult"><option value="2.5">Порог 2.5×</option><option value="2">2× (больше клипов)</option><option value="3.5">3.5× (меньше клипов)</option></select>
  <button class="go" id="go" onclick="startCh()">▶ Запустить</button><span id="err" class="err"></span>
  <span class="sp"></span><span class="mut" id="me"></span><a class="btn" href="/logout">Выйти</a>
</header>
<main>
  <h2>Мои аккаунты</h2>
  <div class="accts" id="accts"></div>
  <h2>Сейчас режется</h2>
  <div class="runs" id="runs"></div>
  <h2><span class="tabs">
    <button id="t-fresh" class="on" onclick="tab('fresh')">Новые</button>
    <button id="t-approved" onclick="tab('approved')">В очереди</button>
    <button id="t-posted" onclick="tab('posted')">Опубликованы</button>
  </span><span class="sp"></span><span class="mut" id="next"></span></h2>
  <div id="pub" style="margin:-4px 0 12px"></div>
  <div class="grid" id="grid"></div>
</main>
<script>
const $=id=>document.getElementById(id);
const api=(p,b)=>fetch(p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}).then(r=>{if(r.status===401)location.reload();return r.json()});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let S=null, TAB='fresh';
$('url').addEventListener('keydown',e=>{if(e.key==='Enter')startCh()});
async function startCh(){
  $('err').textContent='';$('go').disabled=true;
  const r=await api('/api/start',{url:$('url').value,model:$('model').value,mult:$('mult').value});
  $('go').disabled=false;
  if(r.error)$('err').textContent=r.error;else{$('url').value='';setTimeout(refresh,3000)}
}
async function stopRun(id,btn){btn.disabled=true;btn.textContent='останавливаю…';await api('/api/stop',{id});setTimeout(refresh,4000)}
function tab(t){TAB=t;['fresh','approved','posted'].forEach(x=>$('t-'+x).className=x===t?'on':'');$('grid').innerHTML='';render()}
async function act(c,body){const el=document.querySelector('[data-id="'+c.id+'"]');if(el){el.querySelector('video')?.pause();el.remove()}
  await api('/api/decide',{id:c.id,...body});refresh()}
async function publishNow(btn){btn.disabled=true;btn.textContent='публикую… (до минуты)';
  const r=await api('/api/publish',{});btn.disabled=false;btn.textContent='🚀 Опубликовать следующий сейчас';
  alertBox(r.skipped?('Пропуск: '+r.skipped):('Готово: '+Object.entries(r.res||{}).map(([k,v])=>k+': '+v).join(' · ')));refresh()}
function alertBox(t){$('pub').innerHTML='<div class="row"><span>'+esc(t)+'</span></div>';setTimeout(()=>$('pub').innerHTML='',15000)}
async function disc(p){await api('/api/disconnect',{prov:p});refresh()}
const ago=t=>{const m=Math.round((Date.now()-new Date(t))/60000);return m<60?m+' мин':Math.floor(m/60)+' ч '+(m%60)+' мин'};
const SLOTS=[7,10,13,16,19]; // UTC
function nextSlot(){const d=new Date();for(let i=0;i<48;i++){const x=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),0)+i*3600e3);if(x>d&&SLOTS.includes(x.getUTCHours()))return x}}
function render(){
  if(!S)return;
  $('me').textContent='👤 '+S.me;
  const acc=(p,name,ico)=>{const a=S.accounts[p];return '<div class="row"><span style="font-size:20px">'+ico+'</span><b>'+name+(a?': '+esc(a.name):'')+'</b>'+
    (a?'<span class="mut">✅ подключён</span><button onclick="disc(\\''+p+'\\')">Отключить</button>':
     (S.oauth[p]&&S.kv?'<a class="btn go" href="'+(p==='telegram'?'/tg/connect" target="_blank':'/oauth/'+p+'/start')+'">Подключить</a>':'<span class="mut">не настроено в воркере</span>'))+'</div>'};
  $('accts').innerHTML=acc('youtube','YouTube Shorts','▶️')+acc('tiktok','TikTok (в черновики)','🎵')+acc('telegram','Telegram (описания, баннеры)','✈️')+
    '<div class="row"><span style="font-size:20px">🎞</span><b>Баннер: '+(S.banner?esc(S.banner):'выключен')+'</b><span class="mut">управление в боте: /banner</span></div>';
  $('runs').innerHTML=S.active.length?S.active.map(r=>'<div class="row '+(r.status==='in_progress'?'':'q')+'"><span class="dot"></span><b>'+esc(r.title)+'</b>'+
    '<span class="mut">'+(r.status==='in_progress'?'идёт '+ago(r.started):'запускается…')+'</span><a href="'+r.url+'" target="_blank">лог</a>'+
    '<button class="no" onclick="stopRun('+r.id+',this)">■ Стоп</button></div>').join('')
    :'<div class="mut">Ничего не запущено. Вставь ссылку на стрим и нажми ▶</div>'+(S.recent.length?'<div class="mut" style="margin-top:6px">Последние: '+S.recent.map(r=>'<a href="'+r.url+'" target="_blank">'+esc(r.title)+'</a> '+(r.conclusion==='success'?'✅':r.conclusion==='cancelled'?'■':'⚠️')).join(' · ')+'</div>':'');
  $('t-fresh').textContent='Новые ('+S.fresh.length+')';$('t-approved').textContent='В очереди ('+S.approved.length+')';$('t-posted').textContent='Опубликованы';
  const ns=nextSlot();$('next').textContent='Постинг 5 раз в день · следующий в '+ns.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
  const grid=$('grid');
  if(TAB==='posted'){
    grid.className='log';
    grid.innerHTML=S.log.length?S.log.map(e=>'<div class="row"><div><b>'+esc(e.title)+'</b><br><code>'+esc((e.tags||[]).map(t=>'#'+t).join(' '))+'</code><br>'+
      Object.entries(e.res||{}).map(([k,v])=>'<span class="mut">'+k+': '+(String(v).startsWith('http')?'<a href="'+v+'" target="_blank">'+v+'</a>':esc(v))+'</span>').join('<br>')+
      '</div><span class="mut">'+ago(e.t)+' назад</span><button onclick="navigator.clipboard.writeText(this.dataset.c);this.textContent=\\'Скопировано\\'" data-c="'+esc(e.title+' '+(e.tags||[]).map(t=>'#'+t).join(' '))+'">📋 Текст для TikTok</button></div>').join('')
      :'<div class="empty">Ещё ничего не опубликовано.</div>';
    return;
  }
  grid.className='grid';
  const list=S[TAB];
  $('pub').innerHTML=TAB==='approved'&&list.length&&!$('pub').innerHTML?'<button class="go" onclick="publishNow(this)">🚀 Опубликовать следующий сейчас</button>':($('pub').innerHTML.includes('row')?$('pub').innerHTML:'');
  const want=new Set(list.map(c=>String(c.id)));
  [...grid.children].forEach(e=>{if(!e.dataset.id||!want.has(e.dataset.id))e.remove()});
  const have=new Set([...grid.children].map(e=>e.dataset.id));
  if(!list.length){grid.innerHTML='<div class="empty">'+(TAB==='fresh'?'Новых клипов нет. Они появятся после всплесков чата.':'Очередь пуста — одобри клипы во вкладке «Новые».')+'</div>';return}
  const items=TAB==='approved'?list.slice().reverse():list.slice().reverse();
  items.forEach((c,i)=>{
    if(have.has(String(c.id)))return;
    const d=document.createElement('div');d.className='clip';d.dataset.id=c.id;
    d.innerHTML='<video src="/v/'+c.id+'" controls preload="metadata" playsinline></video>'+
      '<div class="meta"><b>'+esc(c.streamer)+'</b>'+esc(c.label)+'<br>'+(c.size/1048576).toFixed(1)+' МБ · '+ago(c.created)+' назад</div>'+
      '<div class="act">'+(TAB==='fresh'?'<button class="ok">✅ Постить</button><button class="no">❌ Нет</button>':'<button class="back">↩ Убрать</button><button class="no">🗑 Удалить</button>')+'</div>';
    d.querySelector('.ok')?.addEventListener('click',()=>act(c,{post:true}));
    d.querySelector('.back')?.addEventListener('click',()=>act(c,{unqueue:true}));
    d.querySelector('.no').addEventListener('click',()=>act(c,{}));
    grid.prepend(d);
  });
}
async function refresh(){S=await api('/api/state');render()}
refresh();setInterval(refresh,10000);
</script></body></html>`;
