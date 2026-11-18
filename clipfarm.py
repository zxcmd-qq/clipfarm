#!/usr/bin/env python3
"""
ClipFarm — автонарезка Twitch-стримов по всплескам чата.

  Streamlink  -> пишет стрим в .ts
  Чат Twitch  -> анонимно (без аккаунта и токена), через IRC
  Скрипт      -> каждые 10 с считает сообщения, ищет всплески
  FFmpeg      -> режет вертикальный клип 1080x1920 (размытый фон)
  Whisper     -> субтитры (faster-whisper, работает на M1)

Запуск:
  python3 clipfarm.py --channel kaicenat
  python3 clipfarm.py --channel buster --out ~/autopost/inbox --lang ru
"""
import argparse, json, os, queue, random, re, shutil, signal, socket, statistics
import subprocess, sys, threading, time
from collections import Counter, deque
from pathlib import Path

HYPE = re.compile(
    r"(KEKW|LUL|OMEGALUL|LMAO|POG|Pog|HOLY|W{1,}\b|\bW\b|ахах|ХАХ|жесть|"
    r"ЛОЛ|лол|\?\?\?|!!!|сделал|clip|клип)", re.I)

# ---------------------------------------------------------------- chat
class Chat(threading.Thread):
    """Анонимное подключение к чату Twitch (justinfanNNNN — без логина)."""
    def __init__(self, channel, log_path):
        super().__init__(daemon=True)
        self.channel = channel.lower()
        self.log = open(log_path, "a", encoding="utf-8")
        self.lock = threading.Lock()
        self.buf = []          # (ts, text) с последнего забора

    def take(self):
        with self.lock:
            out, self.buf = self.buf, []
        return out

    def run(self):
        while True:
            try:
                self._loop()
            except Exception as e:
                print(f"[chat] переподключение: {e}")
                time.sleep(5)

    def _loop(self):
        s = socket.create_connection(("irc.chat.twitch.tv", 6667), timeout=300)
        nick = f"justinfan{random.randint(10000, 99999)}"
        s.sendall(f"NICK {nick}\r\nJOIN #{self.channel}\r\n".encode())
        print(f"[chat] подключен к #{self.channel}")
        data = b""
        while True:
            chunk = s.recv(4096)
            if not chunk:
                raise ConnectionError("сокет закрыт")
            data += chunk
            *lines, data = data.split(b"\r\n")
            for raw in lines:
                line = raw.decode("utf-8", "ignore")
                if line.startswith("PING"):
                    s.sendall(b"PONG :tmi.twitch.tv\r\n")
                    continue
                m = re.search(r":(\w+)!\S+ PRIVMSG #\w+ :(.*)", line)
                if m:
                    ts = time.time()
                    with self.lock:
                        self.buf.append((ts, m.group(2)))
                    self.log.write(json.dumps({"t": ts, "u": m.group(1),
                                               "m": m.group(2)},
                                              ensure_ascii=False) + "\n")
                    self.log.flush()

# ----------------------------------------------------------- kick
def kick_info(slug):
    """Данные канала Kick (chatroom id, эфир, категория). Kick за Cloudflare — пробуем «как браузер»."""
    urls = [f"https://kick.com/api/v2/channels/{slug}", f"https://kick.com/api/v1/channels/{slug}"]
    try:
        from curl_cffi import requests as creq            # притворяется Chrome — Cloudflare обычно пускает
        for u in urls:
            r = creq.get(u, impersonate="chrome", timeout=20)
            if r.status_code == 200:
                return r.json()
    except Exception as e:
        print(f"[kick] curl_cffi: {e}", flush=True)
    import urllib.request
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
                                                     "Accept": "application/json"})
            return json.loads(urllib.request.urlopen(req, timeout=20).read())
        except Exception as e:
            print(f"[kick] {u}: {e}", flush=True)
    return None

class KickChat(threading.Thread):
    """Чат Kick через их публичный Pusher-сокет (без аккаунта)."""
    PUSHER = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false"
    def __init__(self, slug, log_path):
        super().__init__(daemon=True)
        self.slug = slug.lower()
        self.log = open(log_path, "a", encoding="utf-8")
        self.lock = threading.Lock()
        self.buf = []

    def take(self):
        with self.lock:
            out, self.buf = self.buf, []
        return out

    def run(self):
        from websockets.sync.client import connect
        room = None
        while True:
            try:
                if not room:
                    info = kick_info(self.slug) or {}
                    room = (info.get("chatroom") or {}).get("id")
                    if not room:
                        print("[chat] не получил chatroom у Kick, пробую через минуту", flush=True)
                        time.sleep(60); continue
                with connect(self.PUSHER, open_timeout=20) as ws:
                    ws.send(json.dumps({"event": "pusher:subscribe", "data": {"auth": "", "channel": f"chatrooms.{room}.v2"}}))
                    print(f"[chat] подключен к kick/{self.slug}", flush=True)
                    last_ping = time.time()
                    while True:
                        try:
                            raw = ws.recv(timeout=30)
                        except TimeoutError:
                            ws.send(json.dumps({"event": "pusher:ping", "data": {}})); continue
                        ev = json.loads(raw)
                        if ev.get("event") == "pusher:ping":
                            ws.send(json.dumps({"event": "pusher:pong", "data": {}}))
                        if "ChatMessageEvent" in (ev.get("event") or ""):
                            d = json.loads(ev.get("data") or "{}")
                            txt = re.sub(r"\[emote:\d+:([^\]]+)\]", r"\1", d.get("content", ""))   # [emote:123:KEKW] → KEKW
                            ts = time.time()
                            with self.lock:
                                self.buf.append((ts, txt))
                            self.log.write(json.dumps({"t": ts, "u": (d.get("sender") or {}).get("username"), "m": txt}, ensure_ascii=False) + "\n")
                            self.log.flush()
            except Exception as e:
                print(f"[chat] переподключение: {e}", flush=True)
                time.sleep(5)

# ----------------------------------------------------------- recorder
class Recorder(threading.Thread):
    """Streamlink в .ts; если стрим оффлайн — ждёт и пробует снова."""
    def __init__(self, channel, rec_dir, quality, rotate_min=60, platform="twitch"):
        super().__init__(daemon=True)
        self.channel, self.rec_dir, self.quality = channel, rec_dir, quality
        self.url = f"https://kick.com/{channel}" if platform == "kick" else f"https://twitch.tv/{channel}"
        self.rotate = rotate_min * 60       # раз в час новый файл — старые удаляем
        self.pending = Counter()            # файл -> сколько клипов ещё режется
        self.last_live = time.time()
        self.file = None       # текущий .ts
        self.t0 = None         # wall-clock начала записи
        self.proc = None
        self.stopping = False

    def stop(self):
        self.stopping = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def cleanup(self, keep):
        """Удаляем старые .ts, из которых уже ничего не режется."""
        for f in self.rec_dir.glob(f"{self.channel}_*.ts"):
            if f != self.file and f != keep and not self.pending.get(f):
                try: f.unlink()
                except OSError: pass

    def run(self):
        while not self.stopping:
            name = time.strftime(f"{self.channel}_%Y%m%d_%H%M%S.ts")
            path = self.rec_dir / name
            cmd = ["streamlink", "--twitch-disable-ads", "--retry-open", "3",
                   "-o", str(path), self.url,
                   self.quality]
            p = self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                             stderr=subprocess.DEVNULL)
            # ждём, пока появятся первые байты — это и есть t0
            while p.poll() is None and not (path.exists() and path.stat().st_size > 0):
                time.sleep(0.2)
            if path.exists() and path.stat().st_size > 0:
                self.file, self.t0 = path, time.time()
                print(f"[rec] пишу {path.name}", flush=True)
                rotated = False
                while p.poll() is None:
                    self.last_live = time.time()
                    if self.stopping: break
                    if time.time() - self.t0 > self.rotate:
                        rotated = True; p.terminate(); p.wait(); break
                    time.sleep(1)
                self.cleanup(keep=None)
                if rotated:
                    continue                  # сразу новый файл, без паузы
                print("[rec] запись остановилась (стрим закончился?)", flush=True)
            self.file = self.t0 = None
            for _ in range(60):
                if self.stopping: return
                time.sleep(1)

# ----------------------------------------------------------- detector
class Detector:
    def __init__(self, window=30, mult=2.5, min_msgs=15, cooldown=60):
        self.hist = deque(maxlen=window)    # 30 × 10 с = 5 минут истории
        self.mult, self.min_msgs, self.cooldown = mult, min_msgs, cooldown
        self.last = 0

    def feed(self, msgs, now):
        """msgs — сообщения за последние 10 с. Возвращает True на всплеске."""
        hype = sum(1 for _, m in msgs if HYPE.search(m))
        score = len(msgs) + 0.5 * hype
        spike = False
        if len(self.hist) >= 6:
            base = statistics.median(self.hist)
            thr = max(self.min_msgs, base * self.mult + 3)
            spike = score >= thr and now - self.last >= self.cooldown
        self.hist.append(score)
        if spike:
            self.last = now
        return spike, score

# --------------------------------------------------------- subtitles
_whisper = None
def transcribe(wav, model, lang):
    global _whisper
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("[subs] faster-whisper не установлен — клип без субтитров")
        return []
    if _whisper is None:
        print(f"[subs] загружаю модель {model} …")
        _whisper = WhisperModel(model, device="cpu", compute_type="int8")
    # читаем wav сами (numpy), а не через PyAV — новые версии av
    # ломают faster-whisper ("metadata_errors")
    import wave, numpy as np
    with wave.open(str(wav), "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    segs, _ = _whisper.transcribe(
        audio, language=lang or None, word_timestamps=True, beam_size=5,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,     # меньше «галлюцинаций» на шуме игры
        initial_prompt="Стрим на Twitch. Разговорная речь, сленг, мат.")
    return [(w.start, w.end, w.word.strip()) for s in segs for w in s.words]

# ---- цензура мата в субтитрах: ж*па, п*здец (вторая буква — звёздочка)
_PFX = r"(?:за|на|по|от|у|вы|до|пере|раз|рас|съ|въ|об|объ|под|подъ|при|про|из|изъ|недо|о|отъ)?"
_BAD = re.compile("|".join(f"(?:{p})" for p in [
    r"\w*ху[йеёяию]\w*", r"\w*пизд\w*", r"\b" + _PFX + r"[ьъ]?[её]б(?:[аулнитко]|ш|ыв)\w*", r"\b[её]б\b",
    r"\w*долбо[её]б\w*", r"\bбля\w*", r"\bсук(?:а|и|у|е|ой|ам|ами|ах|ин\w*)\b", r"\bмуд(?:ак|ил|о|ач)\w*",
    r"\bпид(?:о|а)?р\w*", r"\bгандон\w*", r"\w*залуп\w*", r"\bшлюх\w*", r"\w*дроч\w*",
    r"\w*ж[оа]п\w*", r"\bговн\w*", r"\bсра[лнтк]\w*", r"\bсрать\w*", r"\b(?:по|на|ни)?хер(?!сон)\w*",
]), re.IGNORECASE)

_ROOT = re.compile(r"ху[йеёяию]|пизд|[её]б|бля|сук|ж[оа]п|говн|сра|хер|муд|пид|гандон|залуп|шлюх|дроч", re.IGNORECASE)

def _mask(m):
    w = m.group(0)
    r = _ROOT.search(w)
    i = (r.start() if r else 0) + 1          # звёздочка на вторую букву корня: ж*па, нах*й
    return w[:i] + "*" + w[i + 1:] if i < len(w) else w

def censor(text):
    return _BAD.sub(_mask, text)

def ass_time(t):
    h, t = divmod(max(t, 0), 3600); m, s = divmod(t, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"

def make_ass(words, path, per_line=3, margin_v=560, font="Arial Black"):
    # margin_v — отступ низа субтитров от низа кадра (выше подписи TikTok)
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,FONT,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,2,2,80,80,MARGIN,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for i in range(0, len(words), per_line):
        chunk = words[i:i + per_line]
        txt = censor(" ".join(w for _, _, w in chunk)).upper().replace("{", "").replace("}", "")
        lines.append(f"Dialogue: 0,{ass_time(chunk[0][0])},{ass_time(chunk[-1][1])},"
                     f"Main,,0,0,0,,{txt}")
    head = head.replace("MARGIN", str(int(margin_v))).replace("FONT", font)
    path.write_text(head + "\n".join(lines) + "\n", encoding="utf-8")

# -------------------------------------------------------------- layout
# Лейаут "cam" (1080x1920):
#   0..620     — вебка стримера
#   620..1430  — игра (центр кадра 4:3)
#   ~1450..1560 — субтитры
#   ниже       — размытый фон (там описание TikTok)
CAM_H, GAME_H = 620, 810

def video_size(p):
    w, h = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height", "-of", "csv=p=0", str(p)], text=True).strip().split(",")[:2]
    return int(w), int(h)

def parse_cam(s):
    """--cam x,y,w,h в долях кадра, напр. 0.72,0.62,0.27,0.36"""
    x, y, w, h = (float(v) for v in s.split(","))
    return x, y, w, h

YUNET_URL = ("https://media.githubusercontent.com/media/opencv/opencv_zoo/main/"
             "models/face_detection_yunet/face_detection_yunet_2023mar.onnx")

def face_detector(cv2):
    """YuNet (нейросеть, точнее) — модель качается один раз ~230 КБ."""
    import urllib.request
    model = Path.home() / ".cache" / "clipfarm" / "yunet.onnx"
    if not model.exists():
        model.parent.mkdir(parents=True, exist_ok=True)
        print("[cam] качаю детектор лиц…")
        urllib.request.urlretrieve(YUNET_URL, model)
    det = cv2.FaceDetectorYN.create(str(model), "", (320, 320), 0.75)
    def find(img):
        det.setInputSize((img.shape[1], img.shape[0]))
        _, faces = det.detect(img)
        return [] if faces is None else [tuple(r[:4]) for r in faces]
    return find

def detect_cam(raw, work, channel):
    """Ищем лицо стримера: оно стоит на одном месте во всех кадрах,
    а лица в игре двигаются. Берём самый «стабильный» кластер."""
    cache = Path("cam_cache") / f"{channel}.json"
    try:
        import cv2
    except ImportError:
        print("[cam] нет opencv: pip3 install opencv-python-headless")
        return json.loads(cache.read_text()) if cache.exists() else None
    fdir = work / "frames"; fdir.mkdir(exist_ok=True)
    run(["ffmpeg", "-y", "-i", str(raw), "-vf", "fps=0.5,scale=960:-2",
         str(fdir / "f%02d.jpg")])
    find_faces = face_detector(cv2)
    boxes, n = [], 0
    for f in sorted(fdir.glob("*.jpg")):
        img = cv2.imread(str(f)); n += 1
        H, W = img.shape[:2]
        for (x, y, w, h) in find_faces(img):
            if w >= W * .03:
                boxes.append(((x + w / 2) / W, (y + h / 2) / H, w / W, h / H))
    best = []
    for b in boxes:
        cl = [o for o in boxes if abs(o[0] - b[0]) < .05 and abs(o[1] - b[1]) < .05]
        if len(cl) > len(best):
            best = cl
    if len(best) < max(2, n // 4):
        print(f"[cam] лицо не найдено ({len(best)}/{n})")
        return json.loads(cache.read_text()) if cache.exists() else None
    cx = statistics.median(b[0] for b in best)
    cy = statistics.median(b[1] for b in best)
    fw = statistics.median(b[2] for b in best)
    # кадр вебки: лицо ×4 по ширине, пропорция 1080:620, лицо чуть выше центра
    ar = (1080 / CAM_H) * (9 / 16)          # в долях кадра 16:9
    w = min(fw * 4.0, 1.0); h = min(w / ar, 1.0); w = h * ar
    x = min(max(cx - w / 2, 0), 1 - w); y = min(max(cy - h * 0.45, 0), 1 - h)
    cam = [round(float(v), 4) for v in (x, y, w, h)]
    cache.parent.mkdir(exist_ok=True); cache.write_text(json.dumps(cam))
    print(f"[cam] вебка: {cam}")
    return cam

def even(v):
    return max(2, int(v) // 2 * 2)

def build_filter(layout, cam, size):
    W, H = size
    bg = ("[b]scale=1080:1920:force_original_aspect_ratio=increase,"
          "crop=1080:1920,boxblur=25:5,eq=brightness=-0.1[bg];")
    if layout == "crop":
        return "[0:v]scale=-2:1920,crop=1080:1920[v0];", "v0", 1360
    if layout == "cam":
        x, y, w, h = cam
        cw, ch = even(w * W), even(h * H)
        cx, cy = even(x * W), even(y * H)
        gw = even(min(W, H * 4 / 3))         # центр 4:3
        vf = ("[0:v]split=3[b][c][g];" + bg +
              f"[c]crop={cw}:{ch}:{cx}:{cy},scale=1080:{CAM_H}:force_original_aspect_ratio=increase,"
              f"crop=1080:{CAM_H}[cam];"
              f"[g]crop={gw}:{H}:{(W - gw) // 2}:0,scale=1080:{GAME_H}[game];"
              f"[bg][cam]overlay=0:0[t];[t][game]overlay=0:{CAM_H}[v0];")
        return vf, "v0", CAM_H + GAME_H + 130
    # blur: картинка по центру, сверху/снизу размытый фон
    vf = ("[0:v]split=2[b][f];" + bg +
          "[f]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2-120[v0];")
    return vf, "v0", 1360

# -------------------------------------------------------------- cutter
def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-600:])

def wait_until_recorded(src, need_sec, timeout=120):
    """Ждём, пока в растущем .ts наберётся нужная длина."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            d = float(subprocess.check_output(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", str(src)], text=True).strip() or 0)
            if d >= need_sec:
                return True
        except Exception:
            pass
        time.sleep(3)
    return False

def make_clip(job, args):
    src, start, dur, chat_lines, tag = job
    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(args.work) / tag; work.mkdir(parents=True, exist_ok=True)
    if not wait_until_recorded(src, start + dur + 2, timeout=90):
        # файл закрылся раньше (ротация / конец стрима) — режем сколько есть
        try:
            have = float(subprocess.check_output(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", str(src)], text=True).strip() or 0)
        except Exception:
            have = 0
        if have - start < 10:
            print(f"[cut] {tag}: запись не догнала, пропуск", flush=True); return
        dur = have - start - 0.5

    raw = work / "raw.mp4"
    run(["ffmpeg", "-y", "-ss", f"{start:.2f}", "-i", str(src), "-t", f"{dur:.2f}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-c:a", "aac", "-b:a", "160k", str(raw)])

    layout, cam = args.layout, None
    if layout == "cam":
        cam = parse_cam(args.cam) if args.cam else detect_cam(raw, work, args.channel)
        if cam is None:
            print(f"[cut] {tag}: вебка не найдена — лейаут blur")
            layout = "blur"
    vf, last, sub_bottom = build_filter(layout, cam, video_size(raw))

    words = []
    if not args.no_subs:
        wav = work / "a.wav"
        run(["ffmpeg", "-y", "-i", str(raw), "-vn", "-ac", "1", "-ar", "16000", str(wav)])
        words = transcribe(wav, args.model, args.lang)
    if words:
        make_ass(words, work / "subs.ass", margin_v=1920 - sub_bottom, font=args.font)
        vf += f"[{last}]ass=subs.ass[v]"
    else:
        vf += f"[{last}]null[v]"

    final = out_dir / f"{tag}.mp4"
    run(["ffmpeg", "-y", "-i", "raw.mp4", "-filter_complex", vf,
         "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast",
         "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
         "-movflags", "+faststart", str(final.resolve())], cwd=work)

    # баннер пользователя (/banner Name в боте) — посередине, видео на паузе
    try:
        bpath = fetch_banner(args)
        if bpath:
            insert_banner(final, bpath, words, work)
    except Exception as e:
        print(f"[banner] пропуск: {e}", flush=True)

    # контекст для описания (можно скормить Gemini в автопосте)
    top = Counter(w for _, m in chat_lines for w in m.split()).most_common(8)
    (out_dir / f"{tag}.txt").write_text(
        f"channel: {args.channel}\nchat peak words: {', '.join(w for w, _ in top)}\n"
        "chat sample:\n" + "\n".join(m for _, m in chat_lines[:25]), encoding="utf-8")
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    print(f"[cut] ✅ {final}", flush=True)
    if args.upload:
        upload(final, args, [w for w, _ in top])

# ---------------------------------------------------------------- game filter
_game = {"t": 0, "name": ""}
def game_ok(channel, want, platform="twitch"):
    """Какая игра сейчас на стриме (Twitch GQL / Kick API, без авторизации). Кэш 2 мин."""
    if platform == "kick":
        if time.time() - _game["t"] > 120:
            info = kick_info(channel)
            if not info:
                return True                      # Kick не ответил — не мешаем
            cats = ((info.get("livestream") or {}).get("categories") or [])
            _game.update(t=time.time(), name=" ".join(c.get("name", "") for c in cats))
        return want.lower() in _game["name"].lower()
    if time.time() - _game["t"] > 120:
        import urllib.request
        try:
            q = json.dumps({"query": 'query{user(login:"%s"){stream{game{name}}}}' % channel}).encode()
            req = urllib.request.Request("https://gql.twitch.tv/gql", data=q, headers={
                "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "application/json"})
            d = json.loads(urllib.request.urlopen(req, timeout=10).read())
            _game.update(t=time.time(), name=(((d.get("data") or {}).get("user") or {}).get("stream") or {}).get("game", {}).get("name", "") or "")
        except Exception as e:
            print(f"[game] не узнал игру: {e}", flush=True)
            return True                      # не знаем — не мешаем
    return want.lower() in _game["name"].lower()

# ---------------------------------------------------------------- banners
API = os.environ.get("CLIPFARM_API", "https://clipfarm.osttima.workers.dev")

def fetch_banner(args):
    """Какой баннер сейчас включён у владельца (спрашиваем панель), качаем из релиза banners."""
    if not args.owner:
        return None
    import urllib.request
    try:
        req = urllib.request.Request(f"{API}/pub/banner/{args.owner}", headers={"User-Agent": "clipfarm-runner"})
        with urllib.request.urlopen(req, timeout=10) as r:
            info = json.loads(r.read() or b"{}")
    except Exception as e:
        print(f"[banner] панель не ответила: {e}", flush=True)
        return None
    asset = info.get("asset")
    if not asset:
        return None
    cache = Path.home() / ".cache" / "clipfarm" / "banners"
    cache.mkdir(parents=True, exist_ok=True)
    local = cache / asset
    if not local.exists() or local.stat().st_size != info.get("size"):
        r = subprocess.run(["gh", "release", "download", "banners", "-p", asset, "-D", str(cache), "--clobber"],
                           capture_output=True, text=True)
        if r.returncode or not local.exists():
            print(f"[banner] не скачался {asset}: {r.stderr[-200:]}", flush=True)
            return None
    print(f"[banner] вставляю {info.get('name')}", flush=True)
    return local

def _dur(p):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                          "-of", "csv=p=0", str(p)], text=True).strip() or 0)

def _green(p):
    """Цвет фона баннера — из угла первого кадра (если он зелёный)."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-vf", "crop=16:16:0:0,scale=1:1", "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    if len(raw) >= 3 and raw[1] > raw[0] + 40 and raw[1] > raw[2] + 40:
        return "0x%02X%02X%02X" % (raw[0], raw[1], raw[2])
    return "0x00FF00"

def banner_points(total, words):
    """Требования рекламодателя: ролик до 60 с — баннер строго посередине;
    длиннее — по одному на каждые 60 с (на 30-й, 90-й, 150-й… секунде)."""
    pts = [total / 2] if total <= 60 else [30 + 60 * k for k in range(int((total - 30) // 60) + 1) if 30 + 60 * k < total - 3]
    gaps = [(words[i][1] + words[i + 1][0]) / 2 for i in range(len(words) - 1)
            if words[i + 1][0] - words[i][1] > 0.15] if words else []
    out = []
    for p in pts:                       # не рвём слово: сдвиг не больше чем на 1 с
        g = min(gaps, key=lambda x: abs(x - p)) if gaps else p
        out.append(g if abs(g - p) <= 1.0 else p)
    return out

def insert_banner(final, banner, words, work):
    """Клип ставится на паузу (стоп-кадр), поверх — баннер без зелени со своим звуком, потом клип продолжается."""
    total, bdur = _dur(final), _dur(banner)
    if total < 10 or bdur <= 0:
        return
    pts = banner_points(total, words)
    has_audio = bool(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                                     "-of", "csv=p=0", str(banner)], capture_output=True, text=True).stdout.strip())
    if not has_audio:
        print("[banner] ⚠️ у баннера нет звука — рекламодатель требует озвучку!", flush=True)
    key = f"chromakey={_green(banner)}:0.2:0.08,despill=type=green"
    n = len(pts)
    cuts = [0] + pts + [total]
    fc = f"[0:v]fps=30,split={2 * n + 1}" + "".join(f"[s{i}]" for i in range(2 * n + 1)) + ";"
    fc += f"[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit={n + 1}" + "".join(f"[t{i}]" for i in range(n + 1)) + ";"
    fc += f"[1:v]fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,{key},split={n}" + "".join(f"[bn{i}]" for i in range(n)) + ";"
    if has_audio:
        fc += f"[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:{bdur},asplit={n}" + "".join(f"[ba{i}]" for i in range(n)) + ";"
    seq = ""
    for i in range(n + 1):
        a, b = cuts[i], cuts[i + 1]
        fc += f"[s{2 * i}]trim={a}:{b},setpts=PTS-STARTPTS[v{i}];[t{i}]atrim={a}:{b},asetpts=PTS-STARTPTS[a{i}];"
        seq += f"[v{i}][a{i}]"
        if i < n:
            T = cuts[i + 1]
            fc += (f"[s{2 * i + 1}]trim=start={T},setpts=PTS-STARTPTS,trim=end_frame=1,loop=loop=-1:size=1,"
                   f"trim=0:{bdur},setpts=PTS-STARTPTS[fz{i}];[fz{i}][bn{i}]overlay=(W-w)/2:(H-h)/2:eof_action=pass,format=yuv420p[bv{i}];")
            if not has_audio:
                fc += f"anullsrc=r=48000:cl=stereo,atrim=0:{bdur}[ba{i}];"
            seq += f"[bv{i}][ba{i}]"
    fc += f"{seq}concat=n={2 * n + 1}:v=1:a=1[v][a]"
    out = work / "with_banner.mp4"
    run(["ffmpeg", "-y", "-i", str(final), "-i", str(banner), "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)])
    shutil.move(str(out), str(final))
    print(f"[banner] вставлен на {', '.join(f'{p:.1f}' for p in pts)} с", flush=True)

def upload(final, args, peak):
    """Облако: клип -> GitHub-релиз (панель берёт его оттуда) + пинг в Telegram."""
    label = ("чат: " + ", ".join(peak))[:180] if peak else args.channel
    if args.owner:                      # чей клип: panel показывает и постит по владельцу
        owned = final.with_name(f"{args.owner}__{final.name}")
        final.rename(owned); final = owned
    r = subprocess.run(["gh", "release", "upload", args.upload, f"{final}#{label}", "--clobber"],
                       capture_output=True, text=True)
    if r.returncode:
        print(f"[up] ошибка загрузки: {r.stderr[-300:]}", flush=True); return
    print(f"[up] ☁️ {final.name} в релизе {args.upload}", flush=True)
    final.unlink(missing_ok=True); final.with_suffix(".txt").unlink(missing_ok=True)
    # панель шлёт владельцу клип в Telegram с кнопками ✅/❌
    try:
        import urllib.request
        req = urllib.request.Request(f"{API}/pub/newclip", data=json.dumps({"name": final.name}).encode(),
                                     headers={"Content-Type": "application/json", "User-Agent": "clipfarm-runner"})
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as e:
        print(f"[tg] уведомление не ушло: {e}", flush=True)

def cutter_worker(q, args, rec):
    while True:
        job = q.get()
        try:
            make_clip(job, args)
        except Exception as e:
            print(f"[cut] ошибка: {e}", flush=True)
        rec.pending[job[0]] -= 1
        rec.cleanup(keep=None)
        q.task_done()

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Автонарезка Twitch по всплескам чата")
    ap.add_argument("--channel", required=True, help="ник стримера на Twitch")
    ap.add_argument("--out", default="clips", help="куда класть готовые клипы")
    ap.add_argument("--work", default="work")
    ap.add_argument("--rec", default="rec", help="папка для записи стрима")
    ap.add_argument("--quality", default="720p60,720p,best")
    ap.add_argument("--bucket", type=int, default=10, help="окно подсчёта, сек")
    ap.add_argument("--mult", type=float, default=2.5, help="во сколько раз выше нормы = всплеск")
    ap.add_argument("--min-msgs", type=int, default=15, help="минимум сообщений за окно")
    ap.add_argument("--pre", type=float, default=25, help="сек ДО всплеска (чат реагирует с задержкой)")
    ap.add_argument("--post", type=float, default=8, help="сек ПОСЛЕ всплеска")
    ap.add_argument("--cooldown", type=int, default=60)
    ap.add_argument("--layout", default="cam", choices=["cam", "blur", "crop"],
                    help="cam: вебка сверху + игра; blur: игра на размытом фоне; crop: кроп по центру")
    ap.add_argument("--cam", default="", help="ручная рамка вебки x,y,w,h в долях кадра")
    ap.add_argument("--no-subs", action="store_true")
    ap.add_argument("--model", default="medium", help="whisper: base/small/medium/large-v3-turbo")
    ap.add_argument("--lang", default="ru", help="язык речи (пусто = авто)")
    ap.add_argument("--keep-work", action="store_true")
    ap.add_argument("--keep-rec", action="store_true", help="не удалять запись стрима после стопа")
    ap.add_argument("--font", default=os.environ.get("SUB_FONT", "Arial Black"))
    ap.add_argument("--platform", default="twitch", choices=["twitch", "kick"])
    ap.add_argument("--only-game", default="", help="резать только когда на стриме эта игра (напр. Counter-Strike)")
    ap.add_argument("--owner", default="", help="владелец клипов (пользователь панели)")
    ap.add_argument("--upload", default="", help="имя GitHub-релиза для заливки клипов (облако)")
    ap.add_argument("--max-hours", type=float, default=0, help="выйти через N часов (код 3, если стрим ещё идёт)")
    ap.add_argument("--offline-min", type=float, default=0, help="выйти, если стрим оффлайн N минут")
    args = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe", "streamlink"):
        if not shutil.which(tool):
            sys.exit(f"Нет {tool}. Поставь: brew install ffmpeg streamlink")
    if args.upload and not shutil.which("gh"):
        sys.exit("Для --upload нужен gh (GitHub CLI)")

    ch = args.channel.lower()
    rec_dir = Path(args.rec); rec_dir.mkdir(exist_ok=True)
    chat = (KickChat if args.platform == "kick" else Chat)(ch, rec_dir / f"{ch}_chat.jsonl"); chat.start()
    rec = Recorder(ch, rec_dir, args.quality, platform=args.platform); rec.start()
    det = Detector(mult=args.mult, min_msgs=args.min_msgs, cooldown=args.cooldown)
    q = queue.Queue(); threading.Thread(target=cutter_worker, args=(q, args, rec), daemon=True).start()
    t_start, exit_code = time.time(), 0
    recent = deque()  # сообщения за последнюю минуту — для .txt

    def _stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _stop)          # кнопка «Стоп» в панели
    signal.signal(signal.SIGINT, _stop)           # Ctrl+C (даже если был игнор)

    print(f"ClipFarm запущен: #{ch}. Ctrl+C — стоп.", flush=True)
    try:
        while True:
            time.sleep(args.bucket)
            now = time.time()
            if args.max_hours and now - t_start > args.max_hours * 3600:
                print("[stop] лимит времени сессии", flush=True)
                exit_code = 3 if rec.file is not None else 0
                break
            if args.offline_min and rec.file is None and now - rec.last_live > args.offline_min * 60:
                print(f"[stop] стрим оффлайн {args.offline_min:.0f} мин — выхожу", flush=True)
                break
            msgs = chat.take()
            recent.extend(msgs)
            while recent and recent[0][0] < now - 60:
                recent.popleft()
            if rec.file is None:
                continue            # стрим оффлайн — не считаем
            spike, score = det.feed(msgs, now)
            print(f"[{time.strftime('%H:%M:%S')}] сообщений за {args.bucket}с: "
                  f"{len(msgs):3d}  score {score:5.1f}" + ("  🔥 ВСПЛЕСК" if spike else ""), flush=True)
            if spike and args.only_game and not game_ok(ch, args.only_game, args.platform):
                print(f"[game] сейчас не {args.only_game} — клип пропущен", flush=True)
                spike = False
            if spike:
                offset = now - rec.t0
                start = max(0, offset - args.bucket - args.pre)
                dur = (offset - start) + args.post
                tag = time.strftime(f"{ch}_%Y%m%d_%H%M%S")
                rec.pending[rec.file] += 1
                q.put((rec.file, start, dur, list(recent), tag))
    except KeyboardInterrupt:
        pass
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    print("\n[stop] останавливаю запись, дорезаю начатые клипы…", flush=True)
    rec.stop()
    end = time.time() + 180
    while q.unfinished_tasks and time.time() < end:
        time.sleep(1)
    # записи стрима большие — удаляем их, клипы уже готовы
    if not args.keep_rec:
        for f in rec_dir.glob(f"{ch}_*.ts"):
            try: f.unlink()
            except OSError: pass
    print("[stop] остановлен ✅", flush=True)
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
