"""PCCS3 API — 시편 아카이브 서버(server.py)가 /api/pccs/* 요청을 넘긴다.

읽기 전용이다. 일지 폴더는 config.json의 worklogDir (없으면 기본 경로).
"""
import os
import threading

from . import worklog

DEFAULT_DIR = "~/MySecondBrain/Areas/NIFCO/작업일지"
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
STATIC = {"index.html": "text/html; charset=utf-8",
          "app.js": "application/javascript; charset=utf-8",
          "pccs.css": "text/css; charset=utf-8"}

_cache = {"key": None, "index": None}
_guard = threading.Lock()


def worklog_dir(cfg) -> str:
    return os.path.abspath(os.path.expanduser(str(cfg.get("worklogDir") or DEFAULT_DIR)))


def _listing_key(folder):
    try:
        return tuple(sorted((n, os.path.getmtime(os.path.join(folder, n)))
                            for n in os.listdir(folder) if n.endswith(".md") and not n.startswith(".")))
    except OSError:
        return None


def get_index(folder):
    """폴더가 바뀌지 않았으면(파일명·수정시각) 지난 색인을 그대로 쓴다."""
    key = (folder, _listing_key(folder))
    with _guard:
        if _cache["key"] != key or _cache["index"] is None:
            _cache["index"] = worklog.load_folder(folder)
            _cache["key"] = key
        return _cache["index"]


def _check(w, idx):
    """일지 하나 검사. 검사기 자체가 실패해도 그 일지만 오류로 보이고 목록은 살아 있게 한다."""
    try:
        return worklog.check(w, idx)
    except Exception as e:   # noqa: BLE001 — 어떤 모양의 일지가 와도 화면 전체가 500이 되면 안 된다
        return {"errors": [{"where": "검사", "msg": f"이 일지를 검사하지 못했습니다 ({type(e).__name__}: {e}) — 형식을 확인하세요"}],
                "warnings": [], "stats": {}}


def _summary(w, res):
    try:
        return worklog.summary(w, res)
    except Exception:   # noqa: BLE001
        return {"name": w.name, "date": w.date, "kind": w.kind, "category": "", "titles": [], "lots": [],
                "errors": len(res["errors"]) or 1, "warnings": len(res["warnings"]), "stats": {}}


def handle(path, query, cfg):
    """(HTTP 상태, JSON 객체)를 돌려준다."""
    folder = worklog_dir(cfg)
    if path == "/api/pccs/status":
        exists = os.path.isdir(folder)
        out = {"ok": True, "dir": folder, "exists": exists, "yaml": worklog.yaml_available()}
        if exists and worklog.yaml_available():
            idx = get_index(folder)
            out["counts"] = {k: sum(w.kind == k for w in idx.logs) for k in ("v3", "v2", "none", "broken")}
        return 200, out
    if not worklog.yaml_available():
        return 503, {"ok": False, "error": "PyYAML이 필요합니다 — 터미널에서: python3 -m pip install --user pyyaml"}
    if not os.path.isdir(folder):
        return 404, {"ok": False, "error": f"작업일지 폴더가 없습니다: {folder} (config.json의 worklogDir)"}
    idx = get_index(folder)

    if path == "/api/pccs/files":
        files = []
        for w in reversed(idx.logs):
            files.append(_summary(w, _check(w, idx)))
        return 200, {"ok": True, "dir": folder, "files": files}

    if path == "/api/pccs/file":
        name = (query.get("name") or [""])[0]
        w = next((x for x in idx.logs if x.name == name), None)   # 색인에 있는 이름만 (경로 조작 불가)
        if w is None:
            return 404, {"ok": False, "error": "일지를 찾을 수 없습니다"}
        res = _check(w, idx)
        return 200, {"ok": True, **_summary(w, res), "result": res,
                     "frontmatter": w.fm if w.kind in ("v3", "v2") else None,
                     "error": w.error}

    if path == "/api/pccs/related":
        # 아카이브 상세 화면 — 이 시편(코드·동판)과 관련된 작업 기록
        return 200, {"ok": True, "entries": worklog.related_entries(idx, query.get("code") or [], query.get("lot") or [])}

    if path == "/api/pccs/plates":
        return 200, {"ok": True, "plates": idx.plates()}

    if path == "/api/pccs/plate":
        lot = (query.get("lot") or [""])[0]
        entries = idx.timeline_entries(lot) if lot else []
        if not entries:
            return 404, {"ok": False, "error": f"동판 {lot} 기록이 없습니다"}
        return 200, {"ok": True, "lot": lot, "entries": entries}

    return 404, {"ok": False, "error": "not found"}


def static_file(rel):
    """/pccs/<rel> → (본문, content-type) 또는 None. 정해진 파일만 서빙한다."""
    rel = rel or "index.html"
    if rel not in STATIC:
        return None
    with open(os.path.join(WEB, rel), "rb") as f:
        return f.read(), STATIC[rel]
