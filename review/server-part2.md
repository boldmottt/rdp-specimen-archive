# server part 2 (lines 329-656 of 656)

```

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

    def do_POST(self):
        if not self._host_ok():
            return self.error(403, "forbidden host")
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
    def read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return b""
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
        base_rev = (self.headers.get("X-Base-Rev") or "").strip()
        if os.path.exists(path) and base_rev:
            try:
                with open(path, encoding="utf-8") as f:
                    prev = json.load(f)
            except Exception:
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
        removed = gc_images(pid, doc)
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

```
