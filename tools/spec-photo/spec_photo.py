#!/usr/bin/env python3
"""실물 크기 시편 사진 만들기 — 로컬 프로그램.

    python3 tools/spec-photo/spec_photo.py            # http://localhost:8917
    python3 tools/spec-photo/spec_photo.py --port 9000

하는 일
  1) 사진에서 **기준 사각형** 네 귀퉁이를 찍으면 원근(투시)을 펴고
  2) 그 사각형의 **실물 크기(mm)** 로 mm당 픽셀을 계산해
  3) 원하는 실물 크기(기본 170×70mm)로 잘라 **PNG/TIFF + DPI 메타데이터**로 저장한다.

원칙: 업스케일하지 않는다(모자라면 경고만), 자르기만 하고 리샘플하지 않는다.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import sys
import tempfile
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spec_photo_core as core  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
WORK = os.path.join(HERE, "_work")          # 업로드·결과 임시 폴더(시작할 때 비운다)
OUT_NAME = "시편_{idx}_{w}x{h}mm_{px}px.{ext}"

STATE: dict[str, dict] = {}                 # id → {path, name, w, h, kind}
LOCK = threading.Lock()


def fresh_work_dir() -> None:
    if os.path.isdir(WORK):
        shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)


def remember(kind: str, path: str, name: str, extra: dict | None = None) -> str:
    fid = uuid.uuid4().hex[:12]
    with LOCK:
        STATE[fid] = {"path": path, "name": name, "kind": kind, **(extra or {})}
    return fid


class Handler(BaseHTTPRequestHandler):
    server_version = "SpecPhoto/1.0"

    # ---------------------------------------------------------------- util
    def log_message(self, fmt, *args):      # 콘솔 조용히
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, name=None, ctype=None):
        if not os.path.isfile(path):
            return self._json({"ok": False, "error": "파일이 없습니다"}, 404)
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        data = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if name:
            from urllib.parse import quote
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p in ("/", "/index.html"):
            return self._file(os.path.join(WEB, "index.html"), ctype="text/html; charset=utf-8")
        if p.startswith("/web/"):
            return self._file(os.path.join(WEB, p[len("/web/"):]))
        if p.startswith("/api/raw/"):
            item = STATE.get(p.rsplit("/", 1)[-1])
            if not item:
                return self._json({"ok": False, "error": "없음"}, 404)
            return self._file(item["path"])
        if p.startswith("/api/preview/"):
            item = STATE.get(p.rsplit("/", 1)[-1])
            if not item:
                return self._json({"ok": False, "error": "없음"}, 404)
            return self._file(item["path"], ctype="image/png")
        if p.startswith("/api/file/"):
            item = STATE.get(p.rsplit("/", 1)[-1])
            if not item:
                return self._json({"ok": False, "error": "없음"}, 404)
            return self._file(item["path"], name=item["name"])
        return self._json({"ok": False, "error": "not found"}, 404)

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""

        if u.path == "/api/upload":
            name = (q.get("name") or ["image.jpg"])[0]
            ext = os.path.splitext(name)[1].lower() or ".jpg"
            path = os.path.join(WORK, uuid.uuid4().hex + ext)
            with open(path, "wb") as f:
                f.write(raw)
            try:
                im = Image.open(path)
                im = ImageOps.exif_transpose(im)      # 폰 사진 회전 정보 반영
                if ext not in (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"):
                    im = im.convert("RGB")
                im.save(path)
                w, h = im.size
            except Exception as e:
                return self._json({"ok": False, "error": f"이미지를 읽을 수 없습니다: {e}"}, 400)
            fid = remember("src", path, name, {"w": w, "h": h})
            return self._json({"ok": True, "id": fid, "w": w, "h": h, "name": name})

        if u.path == "/api/suggest":
            body = json.loads(raw or b"{}")
            item = STATE.get(body.get("id"))
            if not item:
                return self._json({"ok": False, "error": "사진을 먼저 올려 주세요"}, 400)
            im = Image.open(item["path"])
            quad, why = core.suggest_quad(im)
            return self._json({"ok": True, "quad": [list(p) for p in quad], "why": why})

        if u.path == "/api/process":
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                return self._json({"ok": False, "error": "JSON 형식 오류"}, 400)
            item = STATE.get(body.get("id"))
            if not item:
                return self._json({"ok": False, "error": "사진을 먼저 올려 주세요"}, 400)
            quad = body.get("quad") or []
            if len(quad) != 4:
                return self._json({"ok": False, "error": "귀퉁이 네 점이 필요합니다"}, 400)
            try:
                ref = (float(body["refMm"]["w"]), float(body["refMm"]["h"]))
                tgt = (float(body["targetMm"]["w"]), float(body["targetMm"]["h"]))
                off = (float(body.get("offsetMm", {}).get("x", 0)), float(body.get("offsetMm", {}).get("y", 0)))
            except (KeyError, TypeError, ValueError):
                return self._json({"ok": False, "error": "실물 크기(mm)를 숫자로 넣어 주세요"}, 400)
            fmt = (body.get("format") or "PNG").upper()
            try:
                im = Image.open(item["path"])
                out, plan = core.process(im, quad, ref, tgt, off, bool(body.get("allowUpscale")))
            except ValueError as e:
                return self._json({"ok": False, "error": str(e)}, 400)
            except Exception as e:
                return self._json({"ok": False, "error": f"처리 실패: {e}"}, 500)

            ext = "tif" if fmt == "TIFF" else "png"
            idx = body.get("index") or 1
            name = OUT_NAME.format(idx=idx, w=round(tgt[0]), h=round(tgt[1]), px=out.size[0], ext=ext)
            safe = os.path.join(WORK, uuid.uuid4().hex + "." + ext)
            (core.save_with_dpi(out, safe, plan["dpi"][0], fmt))
            oid = remember("out", safe, name, {"w": out.size[0], "h": out.size[1]})
            return self._json({
                "ok": True, "outId": oid, "name": name,
                "px": list(out.size), "mm": list(tgt), "dpi": list(plan["dpi"]),
                "warp": plan.get("warp"), "upscale": plan["upscale"], "warn": plan["warn"],
                "size" : os.path.getsize(safe),
            })

        return self._json({"ok": False, "error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser(description="실물 크기 시편 사진 만들기")
    ap.add_argument("--port", type=int, default=8917)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    fresh_work_dir()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    print("=" * 58)
    print("  실물 크기 시편 사진 만들기")
    print(f"  주소    {url}")
    print("  종료    Ctrl+C")
    print("=" * 58)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다")
        shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    main()
