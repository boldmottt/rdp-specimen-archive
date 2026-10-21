# server part 1 (lines 1-328 of 656)

```
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
import io
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
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SAFE_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


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
UI_STATE = os.path.join(DATA, "_ui", "state.json")


def ensure_dirs():
    for d in (PATTERNS, IMAGES, ORIG, BACKUP, TRASH, PROPOSALS, os.path.dirname(UI_STATE)):
        os.makedirs(d, exist_ok=True)


# ---------------------------------------------------------------- helpers
_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


def pid_lock(pid: str) -> threading.Lock:
    with _LOCKS_GUARD:
        lk = _LOCKS.get(pid)
        if lk is None:
            lk = threading.Lock()
            _LOCKS[pid] = lk
        return lk


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def safe_id(seg: str) -> str:
    if not ID_RE.match(seg or ""):
        raise ValueError(f"invalid id: {seg!r}")
    return seg


def safe_join(base: str, *parts: str) -> str:
    root = os.path.realpath(base)
    p = os.path.realpath(os.path.join(root, *parts))
    if os.path.commonpath([p, root]) != root:
        raise ValueError("path escape")
    return p


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
    base = f"{now_stamp()}_{label or os.path.basename(path)}"
    dest = os.path.join(TRASH, base)
    n = 1
    while os.path.exists(dest):
        n += 1
        dest = os.path.join(TRASH, f"{base}~{n}")
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


def load_all():
    out, errors = [], []
    if not os.path.isdir(PATTERNS):
        return out, errors
    for name in sorted(os.listdir(PATTERNS)):
        if not name.endswith(".json") or name.startswith("."):
            continue
        path = os.path.join(PATTERNS, name)
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            stem = name[:-5]
            if doc.get("id") != stem:
                errors.append(f"{name}: 파일명과 id가 다름 (id={doc.get('id')}) — 동기화 충돌 사본일 수 있음, 건너뜀")
                continue
            doc["_file"] = name
            doc["_mtime"] = os.path.getmtime(path)
            out.append(doc)
        except Exception as e:
            errors.append(f"{name}: 읽기 실패 — {e}")
    return out, errors


def gc_images(pid: str, doc: dict) -> list:
    """JSON에서 참조하지 않는 이미지 파일을 _trash로 이동."""
    ref = set()
    for v in doc.get("variations", []):
        for name in (v.get("images") or []):
            if name:
                ref.add(os.path.basename(str(name)))
    moved = []
    pdir = os.path.join(IMAGES, pid)
    if not os.path.isdir(pdir):
        return moved
    now = time.time()
    for f in sorted(os.listdir(pdir)):
        if not f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            continue
        fp = os.path.join(pdir, f)
        try:
            if now - os.path.getmtime(fp) < 600:   # 10분 이내 업로드는 보존
                continue
        except OSError:
            continue
        if f not in ref:
            move_to_trash(os.path.join(pdir, f), f"{pid}_{f}")
            moved.append(f)
    return moved


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


def sniff_ext(raw: bytes) -> str:
    if raw[:2] == b"\xff\xd8":
        return ".jpg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[4:12] in (b"ftypheic", b"ftypheix", b"ftyphevc", b"ftypmif1"):
        return ".heic"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    return ".bin"


def process_upload(pid: str, vid: str, slot: int, raw: bytes, crop: dict):
    im = open_image(raw)
    W, H = im.size
    has_crop = bool(crop) and all(crop.get(k) not in (None, "", "None") for k in ("x", "y", "w", "h"))
    if has_crop:
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

    name = f"{vid}-{slot}-{datetime.now().strftime('%H%M%S%f')[:9]}.jpg"
    out_dir = os.path.join(IMAGES, pid)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, name)

    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85, optimize=True)
    tmp_path = out_path + ".part"
    with open(tmp_path, "wb") as f:
        f.write(buf.getvalue())
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(out_path):
        move_to_trash(out_path, f"{pid}_{name}")
    os.replace(tmp_path, out_path)

    # 원본 바이트 그대로 보관 (HEIC/EXIF/ICC 보존)
    o_dir = os.path.join(ORIG, pid)
    os.makedirs(o_dir, exist_ok=True)
    ext = sniff_ext(raw)
    src_path = os.path.join(o_dir, f"{vid}-{slot}_{now_stamp()}{ext}")
    atomic_write(src_path, raw)

    return {"file": name, "w": im.width, "h": im.height,
            "sourceWidth": src_w, "lowRes": low_res, "original": os.path.basename(src_path)}

```
