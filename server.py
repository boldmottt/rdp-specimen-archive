#!/usr/bin/env python3
"""
RDP 시편 아카이브 v2 — 로컬 서버
- 정적 파일(web/) 서빙
- 구글 드라이브 동기화 폴더의 JSON/이미지 읽기·쓰기 API
- 이미지 업로드 시 170:70 크롭 → 2400x988 JPEG 변환

실행:  python3 server.py            (기본 포트 8791)
       python3 server.py --port 9000
"""
import argparse
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

try:
    from PIL import Image, ImageOps
except ImportError:
    print("Pillow가 필요합니다:  python3 -m pip install --user pillow")
    raise

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CONFIG_PATH = os.path.join(HERE, "config.json")

RATIO_W, RATIO_H = 170, 70
TARGET_W, TARGET_H = 2400, 988
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


# ---------------------------------------------------------------- config
def default_data_root() -> str:
    home = os.path.expanduser("~")
    cloud = os.path.join(home, "Library", "CloudStorage")
    if os.path.isdir(cloud):
        for name in sorted(os.listdir(cloud)):
            if name.startswith("GoogleDrive-"):
                return os.path.join(cloud, name, "내 드라이브", "RDP-Archive")
    return os.path.join(home, "RDP-Archive")


def load_config() -> dict:
    cfg = {"dataRoot": default_data_root(), "port": 8791}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    return cfg


CFG = load_config()
DATA = os.path.abspath(os.path.expanduser(CFG["dataRoot"]))
PATTERNS = os.path.join(DATA, "patterns")
IMAGES = os.path.join(DATA, "images")
ORIG = os.path.join(DATA, "_orig")
BACKUP = os.path.join(DATA, "_backup")
TRASH = os.path.join(DATA, "_trash")
PROPOSALS = os.path.join(DATA, "proposals")


def ensure_dirs():
    for d in (PATTERNS, IMAGES, ORIG, BACKUP, TRASH, PROPOSALS):
        os.makedirs(d, exist_ok=True)


# ---------------------------------------------------------------- helpers
def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def atomic_write(path: str, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def move_to_trash(path: str, label: str = ""):
    if not os.path.exists(path):
        return
    dest = os.path.join(TRASH, f"{now_stamp()}_{label or os.path.basename(path)}")
    os.makedirs(TRASH, exist_ok=True)
    shutil.move(path, dest)


def validate_pattern(doc: dict):
    errors = []
    if not isinstance(doc, dict):
        return ["JSON 최상위가 객체가 아닙니다"]
    pid = doc.get("id") or ""
    if not ID_RE.match(pid):
        errors.append("id가 올바르지 않습니다")
    if not isinstance(doc.get("pattern"), dict) or not doc["pattern"].get("code"):
        errors.append("pattern.code가 없습니다")
    vars_ = doc.get("variations")
    if not isinstance(vars_, list) or not vars_:
        errors.append("variations가 비어 있습니다")
        return errors
    seen = set()
    for i, v in enumerate(vars_):
        vid = v.get("id") or ""
        if not ID_RE.match(vid):
            errors.append(f"variations[{i}].id가 올바르지 않습니다")
        if vid in seen:
            errors.append(f"variation id 중복: {vid}")
        seen.add(vid)
        if not isinstance(v.get("mixes", []), list):
            errors.append(f"variations[{i}].mixes가 배열이 아닙니다")
    return errors


def load_all() -> list:
    out = []
    if not os.path.isdir(PATTERNS):
        return out
    for name in sorted(os.listdir(PATTERNS)):
        if not name.endswith(".json") or name.startswith("."):
            continue
        path = os.path.join(PATTERNS, name)
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            doc["_file"] = name
            doc["_mtime"] = os.path.getmtime(path)
            out.append(doc)
        except Exception as e:
            print(f"[warn] 읽기 실패 {name}: {e}")
    return out


def image_meta(pid: str) -> dict:
    d = {}
    pdir = os.path.join(IMAGES, pid)
    if os.path.isdir(pdir):
        for f in sorted(os.listdir(pdir)):
            p = os.path.join(pdir, f)
            d[f] = {"size": os.path.getsize(p), "mtime": os.path.getmtime(p)}
    return d


def open_image(raw: bytes):
    """바이트 -> PIL. HEIC 등 Pillow 미지원이면 sips로 변환 시도."""
    tmp = tempfile.NamedTemporaryFile(suffix=".bin", delete=False)
    tmp.write(raw)
    tmp.close()
    try:
        im = Image.open(tmp.name)
        im.load()
        return ImageOps.exif_transpose(im)
    except Exception:
        conv = tmp.name + ".jpg"
        try:
            subprocess.run(["sips", "-s", "format", "jpeg", tmp.name, "--out", conv],
                           check=True, capture_output=True)
            im = Image.open(conv)
            im.load()
            return ImageOps.exif_transpose(im)
        except Exception as e:
            raise ValueError(f"이미지를 열 수 없습니다: {e}")
        finally:
            if os.path.exists(conv):
                os.unlink(conv)
    finally:
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)


def process_upload(pid: str, vid: str, slot: int, raw: bytes, crop: dict):
    im = open_image(raw)
    W, H = im.size
    if crop and all(k in crop for k in ("x", "y", "w", "h")):
        x, y, w, h = (float(crop[k]) for k in ("x", "y", "w", "h"))
        x = max(0.0, min(x, W - 1))
        y = max(0.0, min(y, H - 1))
        w = max(1.0, min(w, W - x))
        h = max(1.0, min(h, H - y))
        im = im.crop((int(x), int(y), int(x + w), int(y + h)))
    else:
        # 비율 강제 크롭
        target = RATIO_W / RATIO_H
        cur = im.width / im.height
        if cur > target:
            nw = int(round(im.height * target))
            left = (im.width - nw) // 2
            im = im.crop((left, 0, left + nw, im.height))
        else:
            nh = int(round(im.width / target))
            top = (im.height - nh) // 2
            im = im.crop((0, top, im.width, top + nh))

    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")

    src_w = im.width
    low_res = src_w < 1700
    im = im.resize((TARGET_W, TARGET_H), Image.LANCZOS)

    name = f"{vid}-{slot}.jpg"
    out_dir = os.path.join(IMAGES, pid)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, name)
    if os.path.exists(out_path):
        move_to_trash(out_path, f"{pid}_{name}")
    im.save(out_path, quality=85, optimize=True)

    o_dir = os.path.join(ORIG, pid)
    os.makedirs(o_dir, exist_ok=True)
    try:
        src = open_image(raw).convert("RGB")
        src.save(os.path.join(o_dir, f"{vid}-{slot}_src.jpg"), quality=92)
    except Exception:
        pass

    return {"file": name, "w": im.width, "h": im.height, "sourceWidth": src_w, "lowRes": low_res}


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "RDPArchive/2.0"

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s\n" % (fmt % args))

    # ---------- responses
    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def error(self, code, msg):
        self.json({"ok": False, "error": msg}, code)

    # ---------- routing
    def do_GET(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p == "/api/health":
                return self.json({"ok": True, "dataRoot": DATA, "port": PORT,
                                  "brand": CFG.get("brand", "RDP"),
                                  "brandSub": CFG.get("brandSub", "SPECIMEN ARCHIVE"),
                                  "company": CFG.get("company", "")})
            if p == "/api/patterns":
                return self.json({"ok": True, "patterns": load_all(), "dataRoot": DATA})
            if p.startswith("/img/"):
                return self.serve_image(p[len("/img/"):])
            if p.startswith("/api/open-folder"):
                subprocess.Popen(["open", DATA])
                return self.json({"ok": True})
            return self.serve_static(p)
        except BrokenPipeError:
            pass
        except Exception as e:
            self.error(500, str(e))

    def do_PUT(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p.startswith("/api/patterns/"):
                pid = p[len("/api/patterns/"):].strip("/")
                return self.save_pattern(pid)
            if p.startswith("/api/image/"):
                parts = p[len("/api/image/"):].strip("/").split("/")
                if len(parts) != 2:
                    return self.error(400, "경로 형식 오류")
                q = parse_qs(u.query)
                slot = int(q.get("slot", ["1"])[0])
                crop = {k: q.get(k, [None])[0] for k in ("x", "y", "w", "h")}
                raw = self.read_body()
                res = process_upload(parts[0], parts[1], slot, raw, crop)
                return self.json({"ok": True, **res})
            return self.error(404, "not found")
        except Exception as e:
            self.error(500, str(e))

    def do_POST(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p == "/api/proposals":
                doc = json.loads(self.read_body().decode("utf-8"))
                slug = doc.get("slug") or ("proposal-" + now_stamp())
                slug = re.sub(r"[^A-Za-z0-9._-]", "-", slug)[:60]
                d = os.path.join(PROPOSALS, slug)
                os.makedirs(d, exist_ok=True)
                atomic_write(os.path.join(d, "proposal.json"),
                             json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
                return self.json({"ok": True, "path": os.path.join(d, "proposal.json")})
            return self.error(404, "not found")
        except Exception as e:
            self.error(500, str(e))

    def do_DELETE(self):
        p = unquote(urlparse(self.path).path)
        try:
            if p.startswith("/api/patterns/"):
                pid = p[len("/api/patterns/"):].strip("/")
                src = os.path.join(PATTERNS, pid + ".json")
                move_to_trash(src, pid + ".json")
                move_to_trash(os.path.join(IMAGES, pid), pid + "_images")
                return self.json({"ok": True})
            if p.startswith("/api/image/"):
                parts = p[len("/api/image/"):].strip("/").split("/")
                if len(parts) == 3:
                    path = os.path.join(IMAGES, parts[0], parts[2])
                    move_to_trash(path, f"{parts[0]}_{parts[2]}")
                    return self.json({"ok": True})
            return self.error(404, "not found")
        except Exception as e:
            self.error(500, str(e))

    # ---------- handlers
    def read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return b""
        return self.rfile.read(n)

    def save_pattern(self, pid):
        if not ID_RE.match(pid):
            return self.error(400, "id 형식 오류")
        raw = self.read_body()
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self.error(400, f"JSON 파싱 실패: {e}")
        doc["id"] = pid
        errs = validate_pattern(doc)
        if errs:
            return self.json({"ok": False, "errors": errs}, 400)
        doc["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        path = os.path.join(PATTERNS, pid + ".json")
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    old = f.read()
                atomic_write(os.path.join(BACKUP, f"{pid}.{now_stamp()}.json"), old.encode("utf-8"))
            except Exception:
                pass
        atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
        warns = []
        for v in doc.get("variations", []):
            per = {}
            for m in v.get("mixes", []):
                if m.get("isReference"):
                    per[m.get("layer")] = per.get(m.get("layer"), 0) + 1
            for layer, cnt in per.items():
                if cnt > 1:
                    warns.append(f"{v.get('id')} {layer}에 기준 배합이 {cnt}개")
        return self.json({"ok": True, "savedAt": doc["updatedAt"], "warnings": warns})

    def serve_image(self, rel):
        rel = rel.replace("..", "")
        path = os.path.join(IMAGES, rel)
        if not os.path.isfile(path):
            return self.error(404, "이미지 없음")
        ctype = mimetypes.guess_type(path)[0] or "image/jpeg"
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, p):
        if p in ("/", ""):
            p = "/index.html"
        p = p.replace("..", "")
        path = os.path.join(WEB, p.lstrip("/"))
        if not os.path.isfile(path):
            path = os.path.join(WEB, "index.html")
        ctype = mimetypes.guess_type(path)[0] or "text/html"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            body = f.read()
        self._send(200, body, ctype)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def port_free(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


PORT = CFG.get("port", 8791)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=CFG.get("port", 8791))
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--demo", action="store_true", help="sample-data 로 임시 실행")
    args = ap.parse_args()
    PORT = args.port

    if args.demo:
        src = os.path.join(HERE, "sample-data")
        tmp = tempfile.mkdtemp(prefix="rdp-demo-")
        if os.path.isdir(src):
            shutil.copytree(src, tmp, dirs_exist_ok=True)
        DATA = tmp
        PATTERNS = os.path.join(DATA, "patterns")
        IMAGES = os.path.join(DATA, "images")
        ORIG = os.path.join(DATA, "_orig")
        BACKUP = os.path.join(DATA, "_backup")
        TRASH = os.path.join(DATA, "_trash")
        PROPOSALS = os.path.join(DATA, "proposals")
        print(f"[demo] {tmp}")

    ensure_dirs()

    if not port_free(PORT):
        print(f"[!] {PORT} 포트가 이미 사용 중입니다. 기존 서버가 떠 있으면 그대로 쓰세요.")
        print(f"    http://localhost:{PORT}")
        sys.exit(0)

    srv = Server(("127.0.0.1", PORT), Handler)
    print("=" * 54)
    print("  RDP 시편 아카이브 v2")
    print(f"  데이터  {DATA}")
    print(f"  주소    http://localhost:{PORT}")
    print("  종료    Ctrl+C  (또는 이 창을 닫기)")
    print("=" * 54)

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
