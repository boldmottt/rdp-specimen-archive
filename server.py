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
import sqlite3
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


RDP_RESULT = {"✅": "ok", "⚠️": "warn", "❌": "ng"}


def rdp_db_path() -> str:
    raw = CFG.get("rdpDbPath") or ""
    return os.path.abspath(os.path.expanduser(raw)) if raw else ""


def read_rdp_mixes(project: str, code: str):
    path = rdp_db_path()
    if not path or not os.path.isfile(path):
        raise ValueError(f"rdp.db를 찾을 수 없습니다: {path or '(경로 미설정)'}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT * FROM rdp_mixes WHERE project=? AND pattern_code=? ORDER BY layer, date, id",
            (project, code)).fetchall()
    finally:
        con.close()
    out = []
    for r in rows:
        res = (r["result"] or "").strip()
        code_enum = next((v for k, v in RDP_RESULT.items() if k in res), "")
        if not code_enum and "예정" in res:
            code_enum = "planned"
        inks = {}
        for k, col in (("MT", "mt"), ("BK", "bk"), ("WH", "wh"), ("YE", "ye"), ("RD", "rd"), ("CL", "cl"), ("YE-D", "ye_d")):
            v = r[col]
            if v not in (None, 0, 0.0):
                inks[k] = v
        out.append({
            "layer": r["layer"] or "", "batch": r["batch_no"] or "",
            "inks": inks,
            "mattingPct": r["matting_agent_pct"], "mattingG": r["matting_agent_g"],
            "thinnerPct": r["thinner_pct"], "thinnerG": r["thinner_g"],
            "hardenerPct": r["hardener_pct"], "hardenerG": r["hardener_g"],
            "result": code_enum, "isReference": bool(r["is_base"]),
            "change": (r["change_summary"] or "").strip(),
            "note": "", "date": r["date"] or "",
            "_notes": (r["notes"] or "").strip(),
            "_coating": (r["coating_code"] or "").strip(),
        })
    return out


def pick_variation(doc, db_mixes):
    vars_ = doc.get("variations") or []
    if len(vars_) <= 1:
        return vars_[0] if vars_ else None
    codes = {b["_coating"] for b in db_mixes if b.get("_coating")}
    for v in vars_:
        if v.get("colorCode") and v["colorCode"] in codes:
            return v
    return vars_[0]


def merge_mixes(v, db_mixes):
    cur = v.setdefault("mixes", [])
    idx = {}
    for i, m in enumerate(cur):
        idx[(m.get("layer"), m.get("batch"))] = i
    added = updated = 0
    for dm in db_mixes:
        dm = dict(dm)
        dm.pop("_coating", None)
        dm.pop("_notes", None)
        key = (dm["layer"], dm["batch"])
        if key in idx:
            m = cur[idx[key]]
            if dm.get("inks"):
                m["inks"] = dm["inks"]
            for f in ("mattingPct", "mattingG", "thinnerPct", "thinnerG", "hardenerPct", "hardenerG"):
                if dm.get(f) is not None:
                    m[f] = dm[f]
            if dm.get("result"):
                m["result"] = dm["result"]
            if dm.get("date"):
                m["date"] = dm["date"]
            if not m.get("change") and dm.get("change"):
                m["change"] = dm["change"]
            updated += 1
        else:
            cur.append(dm)
            idx[key] = len(cur) - 1
            added += 1
    cur.sort(key=lambda m: ((m.get("layer") or ""), (m.get("date") or ""), (m.get("batch") or "")))
    return added, updated


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

    # 어떤 경로로 잘렸든 비율을 한 번 더 강제 (클라이언트 스테이지 비율 오차 방지)
    target_ratio = RATIO_W / RATIO_H
    cur = im.width / im.height
    if abs(cur - target_ratio) / target_ratio > 0.005:
        if cur > target_ratio:
            nw = int(round(im.height * target_ratio))
            left = (im.width - nw) // 2
            im = im.crop((left, 0, left + nw, im.height))
        else:
            nh = int(round(im.width / target_ratio))
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


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "RDPArchive/2.0"

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s\n" % (fmt % args))

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        return host in SAFE_HOSTS

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
        if not self._host_ok():
            return self.error(403, "forbidden host")
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p == "/api/health":
                return self.json({"ok": True, "dataRoot": DATA, "port": PORT,
                                  "brand": CFG.get("brand", "RDP"),
                                  "brandSub": CFG.get("brandSub", "SPECIMEN ARCHIVE"),
                                  "company": CFG.get("company", ""),
                                  "firstPageMax": CFG.get("firstPageMax", 2),
                                  "pageMax": CFG.get("pageMax", 2)})
            if p == "/api/rdp/status":
                path = rdp_db_path()
                exists = bool(path) and os.path.isfile(path)
                info = {"ok": True, "path": path, "exists": exists}
                if exists:
                    try:
                        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                        rows = con.execute(
                            "SELECT project, pattern_code, COUNT(*) c FROM rdp_mixes GROUP BY 1,2").fetchall()
                        con.close()
                        info["patterns"] = [{"project": a, "code": b, "rows": c} for a, b, c in rows]
                        info["total"] = sum(r[2] for r in rows)
                    except Exception as e:
                        info["error"] = str(e)
                return self.json(info)
            if p == "/api/ui":
                if os.path.exists(UI_STATE):
                    try:
                        with open(UI_STATE, encoding="utf-8") as f:
                            return self.json({"ok": True, "state": json.load(f)})
                    except Exception as e:
                        return self.json({"ok": True, "state": {}, "error": str(e)})
                return self.json({"ok": True, "state": {}})
            if p == "/api/patterns":
                pats, errs = load_all()
                return self.json({"ok": True, "patterns": pats, "errors": errs, "dataRoot": DATA})
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
        if not self._host_ok():
            return self.error(403, "forbidden host")
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p == "/api/rdp/status":
                path = rdp_db_path()
                exists = bool(path) and os.path.isfile(path)
                info = {"ok": True, "path": path, "exists": exists}
                if exists:
                    try:
                        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                        rows = con.execute(
                            "SELECT project, pattern_code, COUNT(*) c FROM rdp_mixes GROUP BY 1,2").fetchall()
                        con.close()
                        info["patterns"] = [{"project": a, "code": b, "rows": c} for a, b, c in rows]
                        info["total"] = sum(r[2] for r in rows)
                    except Exception as e:
                        info["error"] = str(e)
                return self.json(info)
            if p == "/api/ui":
                raw = self.read_body()
                try:
                    state = json.loads(raw.decode("utf-8"))
                except Exception as e:
                    return self.error(400, f"JSON 파싱 실패: {e}")
                atomic_write(UI_STATE, json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8"))
                return self.json({"ok": True})
            if p.startswith("/api/patterns/"):
                pid = p[len("/api/patterns/"):].strip("/")
                return self.save_pattern(pid)
            if p.startswith("/api/image/"):
                parts = p[len("/api/image/"):].strip("/").split("/")
                if len(parts) != 2:
                    return self.error(400, "경로 형식 오류")
                try:
                    safe_id(parts[0]); safe_id(parts[1])
                except ValueError as e:
                    return self.error(400, str(e))
                q = parse_qs(u.query)
                slot = int(q.get("slot", ["1"])[0])
                crop = {k: q.get(k, [None])[0] for k in ("x", "y", "w", "h")}
                raw = self.read_body()
                res = process_upload(parts[0], parts[1], slot, raw, crop)
                return self.json({"ok": True, **res})
            return self.error(404, "not found")
        except Exception as e:
            self.error(500, str(e))

    def sync_one(self, pid):
        with pid_lock(pid):
            path = safe_join(PATTERNS, pid + ".json")
            if not os.path.isfile(path):
                return {"ok": False, "error": "패턴 없음"}
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            db_mixes = read_rdp_mixes(doc.get("project"), (doc.get("pattern") or {}).get("code"))
            if not db_mixes:
                return {"ok": True, "added": 0, "updated": 0, "variation": None}
            v = pick_variation(doc, db_mixes)
            if not v:
                return {"ok": False, "error": "베리에이션 없음"}
            added, updated = merge_mixes(v, db_mixes)
            if added or updated:
                doc["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                with open(path, encoding="utf-8") as f:
                    old = f.read()
                atomic_write(os.path.join(BACKUP, f"{pid}.{now_stamp()}.json"), old.encode("utf-8"))
                atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
            return {"ok": True, "added": added, "updated": updated,
                    "variation": v.get("id"), "total": len(v.get("mixes", []))}

    def sync_pattern(self, pid):
        try:
            safe_id(pid)
        except ValueError:
            return self.error(400, "id 형식 오류")
        try:
            r = self.sync_one(pid)
        except Exception as e:
            return self.error(400, str(e))
        if not r.get("ok"):
            return self.error(400, r.get("error") or "동기화 실패")
        return self.json(r)

    def do_POST(self):
        if not self._host_ok():
            return self.error(403, "forbidden host")
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p == "/api/rdp/sync-all":
                total = {"added": 0, "updated": 0, "patterns": 0, "skipped": []}
                for doc in load_all()[0]:
                    pid = doc["id"]
                    try:
                        r = self.sync_one(pid)
                        if r.get("ok"):
                            total["added"] += r.get("added", 0)
                            total["updated"] += r.get("updated", 0)
                            if r.get("added") or r.get("updated"):
                                total["patterns"] += 1
                        else:
                            total["skipped"].append(pid)
                    except Exception:
                        total["skipped"].append(pid)
                return self.json({"ok": True, **total})
            if p.startswith("/api/rdp/sync/"):
                pid = p[len("/api/rdp/sync/"):].strip("/")
                return self.sync_pattern(pid)
            if p == "/api/proposals":
                doc = json.loads(self.read_body().decode("utf-8"))
                slug = doc.get("slug") or ("proposal-" + now_stamp())
                slug = re.sub(r"[^A-Za-z0-9._-]", "-", slug)[:60]
                d = os.path.join(PROPOSALS, slug)
                n = 1
                while os.path.exists(d):
                    n += 1
                    d = os.path.join(PROPOSALS, f"{slug}-{n:02d}")
                os.makedirs(d, exist_ok=True)

                # 스냅샷이 참조하는 이미지를 함께 복사 (나중에 gc가 원본을 지워도 안전)
                copied, missing = [], []
                for item in doc.get("items", []):
                    pid = (item.get("pattern") or {}).get("id")
                    if not pid:
                        continue
                    for v in item.get("variations", []):
                        for name in (v.get("images") or []):
                            src = safe_join(IMAGES, pid, os.path.basename(str(name)))
                            if not os.path.isfile(src):
                                missing.append(f"{pid}/{name}")
                                continue
                            dst_dir = os.path.join(d, "images", pid)
                            os.makedirs(dst_dir, exist_ok=True)
                            shutil.copy2(src, os.path.join(dst_dir, os.path.basename(str(name))))
                            copied.append(f"{pid}/{name}")

                doc["_snapshot"] = {"createdAt": now_stamp(), "images": len(copied), "missing": missing}
                atomic_write(os.path.join(d, "proposal.json"),
                             json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
                return self.json({"ok": True, "path": os.path.join(d, "proposal.json"),
                                  "slug": os.path.basename(d), "images": len(copied), "missing": missing})
            return self.error(404, "not found")
        except Exception as e:
            self.error(500, str(e))

    def do_DELETE(self):
        if not self._host_ok():
            return self.error(403, "forbidden host")
        p = unquote(urlparse(self.path).path)
        try:
            if p.startswith("/api/patterns/"):
                pid = p[len("/api/patterns/"):].strip("/")
                try:
                    safe_id(pid)
                except ValueError as e:
                    return self.error(400, str(e))
                src = safe_join(PATTERNS, pid + ".json")
                move_to_trash(src, pid + ".json")
                move_to_trash(os.path.join(IMAGES, pid), pid + "_images")
                return self.json({"ok": True})
            if p.startswith("/api/image/"):
                parts = p[len("/api/image/"):].strip("/").split("/")
                if len(parts) == 3:
                    try:
                        safe_id(parts[0])
                        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp)$", parts[2], re.I):
                            raise ValueError("bad image name")
                    except ValueError as e:
                        return self.error(400, str(e))
                    path = safe_join(IMAGES, parts[0], parts[2])
                    move_to_trash(path, f"{parts[0]}_{parts[2]}")
                    return self.json({"ok": True})
            return self.error(404, "not found")
        except Exception as e:
            self.error(500, str(e))

    # ---------- handlers
    MAX_BODY = 40 * 1024 * 1024  # 이미지 1장 상한

    def read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return b""
        if n > self.MAX_BODY:
            raise ValueError(f"본문이 너무 큽니다 ({n} bytes)")
        return self.rfile.read(n)

    def save_pattern(self, pid):
        try:
            safe_id(pid)
        except ValueError:
            return self.error(400, "id 형식 오류")
        with pid_lock(pid):
            return self._save_pattern_locked(pid)

    def _save_pattern_locked(self, pid):
        raw = self.read_body()
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self.error(400, f"JSON 파싱 실패: {e}")
        doc = {k: v for k, v in doc.items() if not str(k).startswith("_")}
        doc["id"] = pid
        errs = validate_pattern(doc)
        if errs:
            return self.json({"ok": False, "errors": errs}, 400)

        path = safe_join(PATTERNS, pid + ".json")
        if (self.headers.get("X-Create") or "").strip() == "1" and os.path.exists(path):
            return self.json({"ok": False, "exists": True,
                              "message": f"'{pid}' 시편이 이미 있습니다"}, 409)
        base_rev = (self.headers.get("X-Base-Rev") or "").strip()
        if os.path.exists(path) and base_rev:
            try:
                with open(path, encoding="utf-8") as f:
                    prev = json.load(f)
            except Exception as e:
                print(f"[warn] 기존 파일을 읽지 못했습니다 {pid}: {e}")
                prev = None
            prev_rev = (prev or {}).get("updatedAt") or ""
            if prev_rev and base_rev != prev_rev:
                return self.json({"ok": False, "conflict": True,
                                  "message": "다른 곳에서 먼저 저장되었습니다",
                                  "current": prev}, 409)
        doc["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    old = f.read()
                atomic_write(os.path.join(BACKUP, f"{pid}.{now_stamp()}.json"), old.encode("utf-8"))
            except Exception as e:
                return self.error(500, f"백업 실패로 저장을 중단했습니다: {e}")
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
        try:
            removed = gc_images(pid, doc)
        except Exception as e:
            removed = []
            print(f"[warn] gc 실패 {pid}: {e}")
        return self.json({"ok": True, "savedAt": doc["updatedAt"], "warnings": warns, "removedImages": removed})

    def serve_image(self, rel):
        try:
            parts = [p for p in rel.split("/") if p]
            if len(parts) != 2:
                raise ValueError("bad image path")
            safe_id(parts[0])
            if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp)$", parts[1], re.I):
                raise ValueError("bad image name")
            path = safe_join(IMAGES, parts[0], parts[1])
        except ValueError as e:
            return self.error(400, str(e))
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
        UI_STATE = os.path.join(DATA, "_ui", "state.json")
        print(f"[demo] {tmp}")

    ensure_dirs()

    if not port_free(PORT):
        for cand in range(PORT + 1, PORT + 21):
            if port_free(cand):
                PORT = cand
                break
        else:
            print(f"[!] {PORT} 근처에 빈 포트가 없습니다. --port 로 지정하세요.")
            sys.exit(1)
        print(f"[i] 기본 포트가 사용 중이라 {PORT} 로 엽니다.")

    try:
        for doc in load_all()[0]:
            moved = gc_images(doc["id"], doc)
            if moved:
                print(f"[gc] {doc['id']}: {len(moved)}개 정리")
    except Exception as e:
        print(f"[gc] 건너뜀: {e}")

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
