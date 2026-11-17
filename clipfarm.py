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

# ----------------------------------------------------------- recorder
class Recorder(threading.Thread):
    """Streamlink в .ts; если стрим оффлайн — ждёт и пробует снова."""
    def __init__(self, channel, rec_dir, quality, rotate_min=60):
        super().__init__(daemon=True)
        self.channel, self.rec_dir, self.quality = channel, rec_dir, quality
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
                   "-o", str(path), f"https://twitch.tv/{self.channel}",
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
        txt = " ".join(w for _, _, w in chunk).upper().replace("{", "").replace("}", "")
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
        if have - start < 8:
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

def upload(final, args, peak):
    """Облако: клип -> GitHub-релиз (панель берёт его оттуда) + пинг в Telegram."""
    label = ("чат: " + ", ".join(peak))[:180] if peak else args.channel
    r = subprocess.run(["gh", "release", "upload", args.upload, f"{final}#{label}", "--clobber"],
                       capture_output=True, text=True)
    if r.returncode:
        print(f"[up] ошибка загрузки: {r.stderr[-300:]}", flush=True); return
    print(f"[up] ☁️ {final.name} в релизе {args.upload}", flush=True)
    final.unlink(missing_ok=True); final.with_suffix(".txt").unlink(missing_ok=True)
    tok, chat_id = os.environ.get("TG_BOT_TOKEN"), os.environ.get("TG_CHAT_ID")
    if tok and chat_id:
        import urllib.request, urllib.parse
        txt = f"🎬 Новый клип: {args.channel}\n{label}"
        if os.environ.get("PANEL_URL"):
            txt += f"\n{os.environ['PANEL_URL']}"
        try:
            urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/sendMessage",
                urllib.parse.urlencode({"chat_id": chat_id, "text": txt}).encode(), timeout=15)
        except Exception as e:
            print(f"[tg] {e}")

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
    chat = Chat(ch, rec_dir / f"{ch}_chat.jsonl"); chat.start()
    rec = Recorder(ch, rec_dir, args.quality); rec.start()
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
