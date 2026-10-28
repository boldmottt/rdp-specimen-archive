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
import base64
import contextlib
import copy
import hashlib
import io
import json
import math
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
import unicodedata
import urllib.request
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from pccs import api as pccs_api   # 작업일지(PCCS3) — PyYAML이 없어도 import는 된다
from colorlab import api as lab_api   # 컬러연구소 — 측색 라이브러리 · 색 예측

try:
    from PIL import Image, ImageOps
except ImportError:
    print("Pillow가 필요합니다:  python3 -m pip install --user pillow")
    raise

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CONFIG_PATH = os.path.join(HERE, "config.json")
_CFG_MTIME = None
_CFG_GUARD = threading.Lock()
try:
    _CFG_MTIME = os.path.getmtime(CONFIG_PATH)
except Exception:
    pass

RATIO_W, RATIO_H = 170, 70
TARGET_W, TARGET_H = 2400, 988
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
BASE_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
LAN_HOSTS = set()
SAFE_HOSTS = set(BASE_HOSTS)


# ---------------------------------------------------------------- config
def default_data_root() -> str:
    home = os.path.expanduser("~")
    cloud = os.path.join(home, "Library", "CloudStorage")
    if os.path.isdir(cloud):
        for name in sorted(os.listdir(cloud)):
            if name.startswith("GoogleDrive-"):
                return os.path.join(cloud, name, "내 드라이브", "RDP-Archive")
    return os.path.join(home, "RDP-Archive")


def read_config_file() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("최상위가 객체가 아닙니다")
    return data


def load_config() -> dict:
    cfg = {"dataRoot": default_data_root(), "port": 8791}
    if os.path.exists(CONFIG_PATH):
        try:
            cfg.update(read_config_file())
        except Exception as e:
            # 깨진 설정 때문에 인증이 꺼지면 안 된다 → 외부 접속은 막고(localhost만) 시작
            cfg["requireCfAccess"] = True
            cfg["_cfgBroken"] = True
            print(f"[warn] config.json을 읽지 못했습니다: {e}\n"
                   "       기본값으로 시작하며, 고칠 때까지 외부(터널) 접속은 모두 거절합니다.")
    return cfg


CFG = load_config()
SAFE_HOSTS.update(str(h).lower() for h in (CFG.get("allowHosts") or []) if h)
DATA = os.path.abspath(os.path.expanduser(CFG["dataRoot"]))
PATTERNS = os.path.join(DATA, "patterns")
IMAGES = os.path.join(DATA, "images")
ORIG = os.path.join(DATA, "_orig")
BACKUP = os.path.join(DATA, "_backup")
TRASH = os.path.join(DATA, "_trash")
PROPOSALS = os.path.join(DATA, "proposals")
THUMBS = os.path.join(DATA, "_thumb")
UI_STATE = os.path.join(DATA, "_ui", "state.json")


def ensure_dirs():
    for d in (PATTERNS, IMAGES, ORIG, BACKUP, TRASH, PROPOSALS, THUMBS, os.path.dirname(UI_STATE)):
        os.makedirs(d, exist_ok=True)


# 실행하는 동안 고정할 설정 (데모 모드). config.json을 다시 읽어도 이 값이 이긴다.
CFG_OVERRIDES = {}

# rdp.db의 rdp_mixes 표 (서버가 읽고 쓰는 칸만, 실제 DB와 같은 UNIQUE 제약) — 데모용 빈 DB를 만들 때 쓴다
RDP_SCHEMA = """CREATE TABLE IF NOT EXISTS rdp_mixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, project TEXT, pattern_code TEXT,
  plate TEXT, layer TEXT, batch_no TEXT, is_base INTEGER DEFAULT 0,
  mt REAL, bk REAL, wh REAL, ye REAL, rd REAL, cl REAL, ye_d REAL,
  matting_agent_pct REAL, matting_agent_g REAL, thinner_pct REAL, thinner_g REAL,
  hardener_pct REAL, hardener_g REAL,
  result TEXT, change_summary TEXT, notes TEXT, coating_code TEXT,
  UNIQUE(project, pattern_code, plate, layer, batch_no))"""


def enter_demo_mode() -> str:
    """sample-data를 임시 폴더에 복사해서 그곳만 쓴다.
    실제 데이터 폴더(썸네일 포함)·회사 rdp.db·작업일지는 건드리지 않는다 — DB 전송은 데모용 빈 DB로."""
    global DATA, PATTERNS, IMAGES, ORIG, BACKUP, TRASH, PROPOSALS, THUMBS, UI_STATE
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
    THUMBS = os.path.join(DATA, "_thumb")
    UI_STATE = os.path.join(DATA, "_ui", "state.json")
    db = os.path.join(DATA, "rdp-demo.db")
    con = sqlite3.connect(db)
    try:
        con.execute(RDP_SCHEMA)
        con.commit()
    finally:
        con.close()
    CFG_OVERRIDES.update({"rdpDbPath": db,
                          "worklogDir": os.path.join(HERE, "pccs", "sample-worklogs")})   # 익명 예시 일지
    CFG.update(CFG_OVERRIDES)
    from colorlab import synth   # 컬러연구소 합성 데모 라이브러리 (실측값 아님)
    lab_api.save_library(DATA, BACKUP, synth.library(), "")
    return tmp


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


def new_rev() -> str:
    """저장할 때마다 새로 발급하는 버전 토큰. updatedAt(초 단위, 표시용)과 달리 같은 초에도 겹치지 않는다."""
    return uuid.uuid4().hex[:16]


def doc_rev(doc) -> str:
    """충돌 검사용 버전. rev가 없는 예전 파일은 updatedAt으로 비교한다."""
    if not isinstance(doc, dict):
        return ""
    return str(doc.get("rev") or doc.get("updatedAt") or "")


def stamp_doc(doc):
    doc["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    doc["rev"] = new_rev()


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


def clear_leftovers(pid: str):
    """시편 JSON도 이미지 폴더도 없는데 _orig/<id>만 남아 있으면(예전에 지운 시편의 찌꺼기) 휴지통으로 옮긴다.
    — 그 이름으로 바꾸기가 '_orig/... 이미 쓰임'으로 막히거나, 새 시편에 옛 원본 사진이 섞이지 않게.
    이미지 폴더가 있으면(새 시편을 저장하기 전에 올린 사진) 건드리지 않는다. 썸네일 캐시는 지운다."""
    if os.path.exists(safe_join(PATTERNS, pid + ".json")) or os.path.isdir(os.path.join(IMAGES, pid)):
        return
    if os.path.isdir(os.path.join(ORIG, pid)):
        move_to_trash(os.path.join(ORIG, pid), f"{pid}_orig-leftover")
    shutil.rmtree(os.path.join(THUMBS, pid), ignore_errors=True)


def rename_pattern(old_id: str, new_id: str, data: bytes):
    """이미지 → 원본 → 새 JSON → 옛 JSON(_trash) 순서로 옮긴다.
    중간에 실패하면 이미 옮긴 것을 역순으로 되돌린다. (호출 전에 대상이 비어 있는지 확인할 것)"""
    old_path = safe_join(PATTERNS, old_id + ".json")
    new_path = safe_join(PATTERNS, new_id + ".json")
    undo = []
    try:
        for base in (IMAGES, ORIG):
            src = os.path.join(base, old_id)
            dst = os.path.join(base, new_id)
            if os.path.isdir(src):
                if os.path.exists(dst):
                    raise FileExistsError(dst)
                os.rename(src, dst)   # shutil.move와 달리 기존 폴더 '안으로' 들어가지 않는다
                undo.append(lambda s=src, d=dst: os.rename(d, s))
        if os.path.exists(new_path):
            raise FileExistsError(new_path)
        atomic_write(new_path, data)
        undo.append(lambda: os.unlink(new_path))
        move_to_trash(old_path, f"renamed-{new_id}.json")
    except Exception:
        for fn in reversed(undo):
            try:
                fn()
            except Exception as e2:
                print(f"[warn] 되돌리기 실패 ({old_id} → {new_id}): {e2}")
        raise

MIX_NUM_FIELDS = ("mattingPct", "mattingG", "thinnerPct", "thinnerG", "hardenerPct", "hardenerG")


def _num(val, where, errors, allow_negative=False):
    """숫자 칸 정규화: 숫자 문자열은 숫자로, 빈 값은 None. 유한한 수가 아니거나 음수면 오류."""
    if val is None:
        return None
    if isinstance(val, bool):
        errors.append(f"{where}: 숫자가 아닙니다 ({val})")
        return val
    if isinstance(val, str):
        t = val.strip()
        if t == "":
            return None
        try:
            val = float(t)
        except ValueError:
            errors.append(f"{where}: 숫자가 아닙니다 ({t})")
            return val
    if not isinstance(val, (int, float)) or not math.isfinite(val):
        errors.append(f"{where}: 숫자가 아닙니다 ({val})")
        return val
    if val < 0 and not allow_negative:
        errors.append(f"{where}: 0 이상이어야 합니다 ({val})")
    return val


def _str_list(x):
    """동판·태그 목록: 쉼표로 쓴 글자는 목록으로 바꾼다. (목록, 형식 오류 여부)"""
    if x is None:
        return [], False
    if isinstance(x, str):
        return [s.strip() for s in x.split(",") if s.strip()], False
    if isinstance(x, list) and all(isinstance(s, (str, int, float)) and not isinstance(s, bool) for s in x):
        return [str(s).strip() for s in x if str(s).strip()], False
    return x, True


def normalize_shape(doc: dict, coerce: bool = False) -> list:
    """화면이 기대하는 뼈대를 맞춘다: label·work는 객체, 동판·태그·도장은 목록.
    빠진 칸은 빈 값으로 채우고(doc을 바꿈), 형식이 틀린 칸은 목록으로 돌려준다.
    coerce=True(읽기)면 틀린 칸도 빈 값으로 바꿔서 화면이 그릴 수 있게 한다 — 저장 전에는 오류로 막는다.
    (label 없는 문서 하나가 목차 전체를 멈추게 하던 문제)"""
    problems = []

    def bad(obj, key, msg, empty):
        problems.append(msg)
        if coerce:
            obj[key] = empty

    for key in ("label", "work"):
        if doc.get(key) is None:
            doc[key] = {}
        elif not isinstance(doc[key], dict):
            bad(doc, key, f"{key}가 객체가 아닙니다", {})
    work, pat = doc.get("work"), doc.get("pattern")
    if isinstance(work, dict) and "plate" in work:
        plates, wrong = _str_list(work["plate"])
        if wrong:
            bad(work, "plate", "work.plate는 동판 목록이어야 합니다", [])
        else:
            work["plate"] = plates
    if isinstance(pat, dict) and "tags" in pat:
        tags, wrong = _str_list(pat["tags"])
        if wrong:
            bad(pat, "tags", "pattern.tags는 태그 목록이어야 합니다", [])
        else:
            pat["tags"] = tags
    hist = doc.get("history")
    if hist is not None and (not isinstance(hist, list) or not all(isinstance(h, dict) for h in hist)):
        bad(doc, "history", "history는 객체 목록이어야 합니다", [])
    vars_ = doc.get("variations") if isinstance(doc.get("variations"), list) else []
    if coerce and not all(isinstance(v, dict) for v in vars_):
        problems.append("객체가 아닌 베리에이션은 빼고 읽습니다")
        vars_[:] = [v for v in vars_ if isinstance(v, dict)]
    for i, v in enumerate(vars_):
        if not isinstance(v, dict):
            continue      # 저장 검사(validate_pattern)가 따로 오류로 알린다
        where = v.get("id") or f"variations[{i}]"
        if v.get("coating") is None:
            v["coating"] = []
        elif not isinstance(v["coating"], list) or not all(isinstance(c, dict) for c in v["coating"]):
            bad(v, "coating", f"{where}: coating은 객체 목록이어야 합니다", [])
        for key in ("label", "layerPlates", "layerPatterns"):
            if key in v and v[key] is None:
                del v[key]
            elif key in v and not isinstance(v[key], dict):
                bad(v, key, f"{where}: {key}가 객체가 아닙니다", {})
    return problems


def validate_pattern(doc: dict):
    """저장 전 구조 검사. 숫자 문자열 같은 가벼운 형식 차이는 그 자리에서 고친다(doc을 바꿈).
    오류가 하나라도 있으면 저장하지 않는다."""
    errors = []
    if not isinstance(doc, dict):
        return ["JSON 최상위가 객체가 아닙니다"]
    errors += normalize_shape(doc)
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
        if not isinstance(v, dict):
            errors.append(f"variations[{i}]가 객체가 아닙니다")
            continue
        vid = v.get("id") or ""
        if not ID_RE.match(vid):
            errors.append(f"variations[{i}].id가 올바르지 않습니다")
        if vid in seen:
            errors.append(f"variation id 중복: {vid}")
        seen.add(vid)
        imgs = v.get("images", [])
        if not isinstance(imgs, list) or any(not isinstance(n, str) or not n or "/" in n or "\\" in n or n.startswith(".")
                                             for n in imgs):
            errors.append(f"{vid or i}: images는 파일 이름 목록이어야 합니다")
        mixes = v.get("mixes", [])
        if not isinstance(mixes, list):
            errors.append(f"variations[{i}].mixes가 배열이 아닙니다")
            continue
        for j, m in enumerate(mixes):
            where = f"{vid or i} 배합 {j + 1}"
            if not isinstance(m, dict):
                errors.append(f"{where}: 객체가 아닙니다")
                continue
            inks = m.get("inks")
            if inks is None:
                m["inks"] = {}
            elif not isinstance(inks, dict):
                errors.append(f"{where}: inks가 객체가 아닙니다")
            else:
                for k in list(inks):
                    val = _num(inks[k], f"{where} 잉크 {k}", errors)
                    if val is None:
                        del inks[k]
                    else:
                        inks[k] = val
            for k in MIX_NUM_FIELDS:
                if k in m:
                    m[k] = _num(m[k], f"{where} {k}", errors)
            for k in ("labSce", "labSci"):
                lab = m.get(k)
                if lab is None:
                    continue
                if not isinstance(lab, dict):
                    errors.append(f"{where} {k}: 객체가 아닙니다")
                    continue
                for c in ("L", "a", "b"):
                    if c in lab:
                        lab[c] = _num(lab[c], f"{where} {k}.{c}", errors, allow_negative=True)
            for k in ("layer", "batch", "plate"):
                if m.get(k) is not None and not isinstance(m[k], (str, int, float)):
                    errors.append(f"{where}: {k} 형식이 올바르지 않습니다")
    for v in vars_:
        if isinstance(v, dict) and v.get("sameAs"):
            if v["sameAs"] == v.get("id") or v["sameAs"] not in seen:
                errors.append(f"{v.get('id')}: '같은 배합' 대상({v['sameAs']}) 컬러가 없습니다")
    return errors


def reference_warnings(doc) -> list:
    warns = []
    for v in doc.get("variations", []):
        per = {}
        for m in v.get("mixes", []):
            if m.get("isReference"):
                per[m.get("layer")] = per.get(m.get("layer"), 0) + 1
        for layer, cnt in per.items():
            if cnt > 1:
                warns.append(f"{v.get('id')} {layer}에 기준 배합이 {cnt}개")
    return warns


# ---------------------------------------------------------------- Cloudflare Access JWT
# 서명까지 검증한다 (페이로드만 읽으면 누구나 위조 토큰을 만들 수 있음).
# 외부 라이브러리 없이 RS256(PKCS#1 v1.5 + SHA-256)을 직접 검증한다.
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")
_JWKS = {"team": "", "keys": {}, "fetched": 0.0, "tried": 0.0}
_JWKS_GUARD = threading.Lock()
JWKS_TTL = 3600
JWKS_RETRY = 60


def b64url_decode(s: str) -> bytes:
    s = (s or "").strip()
    return base64.urlsafe_b64decode((s + "=" * (-len(s) % 4)).encode("ascii"))


def cf_team_domain() -> str:
    raw = str(CFG.get("cfAccessTeamDomain") or "").strip().lower()
    raw = re.sub(r"^https?://", "", raw).strip("/")
    if not raw:
        return ""
    if "." not in raw:
        raw += ".cloudflareaccess.com"
    return raw if re.fullmatch(r"[a-z0-9.-]+", raw) else ""


def fetch_jwks(team: str) -> dict:
    url = f"https://{team}/cdn-cgi/access/certs"
    with urllib.request.urlopen(url, timeout=5) as r:
        data = json.loads(r.read().decode("utf-8"))
    keys = {}
    for k in data.get("keys") or []:
        if k.get("kty") == "RSA" and k.get("kid") and k.get("n") and k.get("e"):
            keys[k["kid"]] = (int.from_bytes(b64url_decode(k["n"]), "big"),
                              int.from_bytes(b64url_decode(k["e"]), "big"))
    return keys


def jwks_key(team: str, kid: str):
    with _JWKS_GUARD:
        now = time.time()
        stale = _JWKS["team"] != team or now - _JWKS["fetched"] > JWKS_TTL
        unknown = kid not in _JWKS["keys"]
        if (stale or unknown) and now - _JWKS["tried"] > JWKS_RETRY:
            _JWKS["tried"] = now
            try:
                keys = fetch_jwks(team)
                _JWKS.update(team=team, keys=keys, fetched=now)
            except Exception as e:
                print(f"[warn] Cloudflare Access 공개키를 받지 못했습니다: {e}")
        if _JWKS["team"] != team:
            return None
        return _JWKS["keys"].get(kid)


def rs256_verify(signing_input: bytes, sig: bytes, n: int, e: int) -> bool:
    import hashlib
    import hmac
    k = (n.bit_length() + 7) // 8
    if len(sig) != k:
        return False
    s = int.from_bytes(sig, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    t = _SHA256_PREFIX + hashlib.sha256(signing_input).digest()
    if k < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


def verify_cf_jwt(token: str, team: str, key_lookup=None):
    """검증에 성공하면 payload, 아니면 None."""
    try:
        h64, p64, s64 = token.split(".")
        header = json.loads(b64url_decode(h64))
        payload = json.loads(b64url_decode(p64))
        sig = b64url_decode(s64)
    except Exception:
        return None
    if not isinstance(header, dict) or not isinstance(payload, dict):
        return None
    if header.get("alg") != "RS256" or not header.get("kid"):
        return None
    key = (key_lookup or jwks_key)(team, header["kid"])
    if not key:
        return None
    if not rs256_verify(f"{h64}.{p64}".encode("ascii"), sig, *key):
        return None
    now = time.time()
    try:
        if float(payload.get("exp") or 0) < now:
            return None
        if payload.get("nbf") is not None and float(payload["nbf"]) > now + 60:
            return None
    except (TypeError, ValueError):
        return None
    iss = str(payload.get("iss") or "").rstrip("/")
    if iss != f"https://{team}":
        return None
    return payload


RDP_RESULT = {"✅": "ok", "⚠️": "warn", "❌": "ng"}
PLAN_LABEL = "테스트예정"


def norm_symbol(txt: str) -> str:
    """이모지 변형선택자/공백 제거 후 비교용 문자열로."""
    return (txt or "").replace("\ufe0f", "").replace("\ufe0e", "").strip()


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
        res_n = norm_symbol(res)
        code_enum = next((v for k, v in RDP_RESULT.items() if norm_symbol(k) and norm_symbol(k) in res_n), "")
        if not code_enum and "예정" in res:
            code_enum = "plan"
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
            "_id": r["id"],
            "_code": code,
            "plate": (r["plate"] or "").strip(),
        })
    return out


def apply_db_mix(m, dm, registry=None):
    """DB 행 값을 m에 반영. 실제로 바뀐 게 있으면 True."""
    registry = registry or ink_registry()
    changed = False
    if dm.get("plate") and m.get("plate") != dm["plate"]:
        m["plate"] = dm["plate"]; changed = True
    if dm.get("inks"):
        # 명시적으로 연결한 제품은 DB 값으로 교체, 미지원 커스텀 잉크는 보존한다.
        # DB 행에 잉크가 하나도 없으면(미입력과 삭제를 DB에서 구분할 수 없음) 아카이브 값을 그대로 둔다
        # — 'DB 동기화'가 모든 시편에 돌기 때문에, 빈 행 하나가 배합을 지우면 안 된다.
        cur = m.get("inks") or {}
        normalized = registry.normalize(cur)
        merged = {k: x for k, x in normalized.items() if not registry.db_code(k)}
        merged.update(registry.from_db(dm["inks"]))
        if merged != cur:
            m["inks"] = merged; changed = True
    for f in ("mattingPct", "mattingG", "thinnerPct", "thinnerG", "hardenerPct", "hardenerG"):
        if dm.get(f) is not None and m.get(f) != dm[f]:
            m[f] = dm[f]; changed = True
    if dm.get("result") and m.get("result") != dm["result"]:
        m["result"] = dm["result"]; changed = True
    if dm.get("date") and m.get("date") != dm["date"]:
        m["date"] = dm["date"]; changed = True
    if not m.get("change") and dm.get("change"):
        m["change"] = dm["change"]; changed = True
    return changed


def merge_mixes(v, db_mixes):
    """(도수, 배치) 키로 병합. 같은 키가 동판별로 여러 개면 동판까지 본다."""
    registry = ink_registry()
    cur = v.setdefault("mixes", [])
    groups = {}
    for dm in db_mixes:
        dm = dict(dm)
        groups.setdefault((dm["layer"], dm["batch"]), []).append(dm)

    idx = {}
    for i, m in enumerate(cur):
        idx.setdefault((m.get("layer"), m.get("batch")), []).append(i)

    added = updated = 0
    for key, rows in groups.items():
        rows.sort(key=lambda r: (r.get("plate") or ""))
        used = set()
        for dm in rows:
            dm.pop("_notes", None)
            dm.pop("_coating", None)
            dm.pop("_id", None)
            dm.pop("_code", None)
            cands = [i for i in idx.get(key, []) if i not in used]
            pick = next((i for i in cands if cur[i].get("plate") == dm.get("plate")), None)
            if pick is None and len(cands) == 1:
                pick = cands[0]
            if pick is None:
                dm["inks"] = registry.from_db(dm.get("inks") or {})
                cur.append(dm)
                new_i = len(cur) - 1
                idx.setdefault(key, []).append(new_i)
                used.add(new_i)
                added += 1
            else:
                used.add(pick)
                if apply_db_mix(cur[pick], dm, registry):
                    updated += 1

    cur.sort(key=lambda m: (m.get("layer") or "", m.get("date") or "", m.get("batch") or "", m.get("plate") or ""))
    return added, updated


RESULT_TO_DB = {"ok": "✅", "warn": "⚠️", "ng": "❌", "plan": PLAN_LABEL, "planned": PLAN_LABEL, "": ""}
INK_COLS = (("MT", "mt"), ("BK", "bk"), ("WH", "wh"), ("YE", "ye"), ("RD", "rd"), ("CL", "cl"), ("YE-D", "ye_d"))
PCT_COLS = (("mattingPct", "matting_agent_pct"), ("mattingG", "matting_agent_g"),
            ("thinnerPct", "thinner_pct"), ("thinnerG", "thinner_g"),
            ("hardenerPct", "hardener_pct"), ("hardenerG", "hardener_g"))


DB_INKS = {k for k, _ in INK_COLS}


def doc_code(doc) -> str:
    return ((doc.get("pattern") or {}).get("code") or "").strip()


def layer_code(doc, v, layer) -> str:
    """배합이 속하는 패턴 코드: 그 컬러의 도수별 패턴(layerPatterns)이 있으면 그것, 없으면 시편 코드."""
    lp = str(((v or {}).get("layerPatterns") or {}).get(layer) or "").strip()
    return lp or doc_code(doc)


def bad_code(code: str) -> bool:
    return not code or any(ch in code for ch in "·,/")


def layer_codes_from(v, layer) -> list:
    """그 도수에서 예전에 쓰던 패턴 코드들 (서버가 저장할 때 기록, layerPatternsFrom)."""
    return [str(c) for c in (((v or {}).get("layerPatternsFrom") or {}).get(layer) or []) if str(c).strip()]


def track_layer_code_changes(prev, doc):
    """도수 패턴 코드가 바뀌면 옛 코드를 layerPatternsFrom에 남긴다 (DB 행을 옮기기 위해).
    클라이언트가 보낸 값은 쓰지 않고, 이전 파일 값을 이어받는다."""
    prev_vs = {pv.get("id"): pv for pv in (prev or {}).get("variations") or [] if isinstance(pv, dict)}
    for v in doc.get("variations") or []:
        if not isinstance(v, dict):
            continue
        v.pop("layerPatternsFrom", None)
        pv = prev_vs.get(v.get("id"))
        if not pv:
            continue
        hist = {k: list(x) for k, x in ((pv.get("layerPatternsFrom") or {}).items()) if isinstance(x, list)}
        layers = set((pv.get("layerPatterns") or {})) | set((v.get("layerPatterns") or {}))
        for layer in layers:
            old, new = layer_code(prev, pv, layer), layer_code(doc, v, layer)
            if old != new and old != doc_code(doc) and not bad_code(old):
                hist.setdefault(layer, [])
                if old not in hist[layer]:
                    hist[layer].append(old)
        for layer in list(hist):
            hist[layer] = [c for c in hist[layer] if c != layer_code(doc, v, layer)]
            if not hist[layer]:
                del hist[layer]
        if hist:
            v["layerPatternsFrom"] = hist


def _mplate(m) -> str:
    return str(m.get("plate") or "").strip()


def plate_from(m) -> list:
    """그 배합이 예전에 있던 동판들, 오래된 것부터 (서버가 저장할 때 기록, plateFrom)."""
    return [str(p).strip() for p in (m.get("plateFrom") or []) if isinstance(p, (str, int, float)) and str(p).strip()]


def track_plate_changes(prev, doc):
    """배합의 동판이 바뀌면 옛 동판을 plateFrom에 남긴다 — DB에 새 행을 넣지 않고 옛 동판 행을 옮기기 위해
    (DB 키에 동판이 들어가서, 그냥 넣으면 같은 배합이 옛 동판·새 동판 두 줄로 남는다).
    클라이언트가 보낸 값은 쓰지 않고 이전 파일에서 이어받는다 (layerPatternsFrom과 같은 방식).
    짝은 같은 컬러·(도수, 배치)로 찾고, 같은 동판끼리 먼저, 남은 것이 한 쌍일 때만 '동판이 바뀌었다'고 본다."""
    prev_vs = {pv.get("id"): pv for pv in (prev or {}).get("variations") or [] if isinstance(pv, dict)}
    for v in doc.get("variations") or []:
        if not isinstance(v, dict):
            continue
        mixes = [m for m in v.get("mixes") or [] if isinstance(m, dict)]
        for m in mixes:
            m.pop("plateFrom", None)
        pv = prev_vs.get(v.get("id"))
        if not pv:
            continue
        key = lambda m: (str(m.get("layer") or ""), str(m.get("batch") or "").strip())   # noqa: E731
        olds = {}
        for o in pv.get("mixes") or []:
            if isinstance(o, dict):
                olds.setdefault(key(o), []).append(o)

        def inherit(m, o):
            hist = [x for x in plate_from(o) if x != _mplate(o)]
            if _mplate(o) and _mplate(o) != _mplate(m):
                hist.append(_mplate(o))
            hist = [x for x in dict.fromkeys(hist) if x != _mplate(m)][-10:]   # 최근 10개면 충분
            if hist:
                m["plateFrom"] = hist

        news = {}
        for m in mixes:
            news.setdefault(key(m), []).append(m)
        for k, group in news.items():
            cands, rest = list(olds.get(k, [])), []
            for m in group:
                same = next((o for o in cands if _mplate(o) == _mplate(m)), None)
                if same is None:
                    rest.append(m)
                else:
                    cands.remove(same)
                    inherit(m, same)
            if len(rest) == 1 and len(cands) == 1:
                inherit(rest[0], cands[0])


def foreign_claims(doc, others):
    """다른 시편이 '도수별 패턴'으로 이 시편 코드를 쓰는 (도수, 도장코드) 조합.
    그 시편이 이 코드로 보낸 행은 이 시편 것이 아니다."""
    me, proj = doc_code(doc), doc.get("project") or ""
    claims = set()
    for o in others or []:
        if o.get("id") == doc.get("id") or (o.get("project") or "") != proj:
            continue
        for v in o.get("variations") or []:
            coat = (v.get("colorCode") or "").strip()
            for layer in set(v.get("layerPatterns") or {}) | set(v.get("layerPatternsFrom") or {}):
                if coat and (layer_code(o, v, layer) == me or me in layer_codes_from(v, layer)):
                    claims.add((layer, coat))
    return claims


def load_doc_rows(doc, others=None):
    """이 시편에 속하는 DB 행을 베리에이션별로 나눈다 → [(v, rows)].
    - 시편 코드 행: 도장코드 == 컬러코드인 첫 베리에이션, 없으면 첫 베리에이션 (기존 규칙)
      단, 다른 시편이 도수별 패턴으로 이 코드를 쓰며 보낸 행은 뺀다
    - 도수별 패턴 코드(다른 코드) 행: 그 도수 + 도장코드 == 컬러코드가 정확히 맞을 때만"""
    vs = doc.get("variations") or []
    out = [(v, []) for v in vs]
    if not vs:
        return out
    project, main = doc.get("project"), doc_code(doc)
    own = {(v.get("colorCode") or "").strip() for v in vs} - {""}
    claims = foreign_claims(doc, load_all()[0] if others is None else others)
    for dm in read_rdp_mixes(project, main):
        c = (dm.get("_coating") or "").strip()
        if (dm["layer"], c) in claims and c not in own:
            continue
        i = next((j for j, v in enumerate(vs) if c and (v.get("colorCode") or "").strip() == c), 0)
        out[i][1].append(dm)
    uses = {}
    for j, v in enumerate(vs):
        for layer in set(v.get("layerPatterns") or {}) | set(v.get("layerPatternsFrom") or {}):
            for code in [layer_code(doc, v, layer)] + layer_codes_from(v, layer):
                if code != main and not bad_code(code):
                    uses.setdefault(code, set()).add((j, layer))
    for code, pairs in uses.items():
        for dm in read_rdp_mixes(project, code):
            c = (dm.get("_coating") or "").strip()
            j = next((j for j, layer in sorted(pairs)
                      if layer == dm["layer"] and c and (vs[j].get("colorCode") or "").strip() == c), None)
            if j is not None:
                out[j][1].append(dm)
    return out


def renamed_from_rows(doc):
    """코드/프로젝트가 바뀐 시편이면 옛 키로 DB에 남아 있는 행 수와 옛 키를 돌려준다."""
    rf = doc.get("renamedFrom") or {}
    old = (rf.get("project") or "", rf.get("code") or "")
    cur = (doc.get("project") or "", (doc.get("pattern") or {}).get("code") or "")
    if not old[1] or old == cur:
        return 0, old
    return len(read_rdp_mixes(*old)), old


def mix_values(m):
    """DB로 가는 값만 비교용으로 (같은 배합인지 판단)."""
    inks = tuple(round(float((m.get("inks") or {}).get(k) or 0), 6) for k, _ in INK_COLS)
    pct = tuple(None if m.get(f) is None else round(float(m[f]), 6) for f, _ in PCT_COLS)
    return inks + pct


def db_taken_keys(doc):
    """이 시편이 쓰는 코드(시편 코드 + 도수 패턴 + 예전 도수 패턴)로 DB에 이미 있는 키 → id.
    컬러로 나누지 않은 전체 — rdp.db는 (프로젝트, 패턴 코드, 동판, 도수, 배치)가 UNIQUE."""
    codes = {doc_code(doc)}
    for v in doc.get("variations") or []:
        for layer in set(v.get("layerPatterns") or {}) | set(v.get("layerPatternsFrom") or {}):
            codes.add(layer_code(doc, v, layer))
            codes.update(layer_codes_from(v, layer))
    taken = {}
    for c in codes:
        if c and not bad_code(c):
            for d in read_rdp_mixes(doc.get("project"), c):
                taken[(c, d["layer"], d["batch"], d["plate"])] = d.get("_id")
    return taken


def ink_registry():
    return lab_api.model.InkRegistry(lab_api.load_library(DATA).get("inks") or [])


def db_document(doc):
    """DB 전송용 사본만 7개 코드로 변환. 일부 성분을 버린 배합은 절대 보내지 않는다."""
    registry = ink_registry()
    prepared = copy.deepcopy(doc)
    issues = []
    for v in prepared.get("variations") or []:
        for m in v.get("mixes") or []:
            try:
                m["inks"] = registry.to_db(m.get("inks") or {})
            except lab_api.model.ModelError as e:
                issues.append({"vid": v.get("id"), "layer": m.get("layer"), "batch": m.get("batch"),
                               "plate": m.get("plate"), "reason": str(e)})
    return prepared, issues


def db_ink_signature(doc):
    return hashlib.sha256(json.dumps(doc, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def plan_hash(plan, doc) -> str:
    """미리보기에서 본 계획과 전송할 계획이 같은지 확인하는 지문.
    계획(이동·수정·신규) + 잉크 연결이 반영된 DB용 문서 + 시편 버전 — 그사이 시편·잉크 연결·DB가 바뀌면 달라진다."""
    core = {k: plan.get(k) or [] for k in ("updates", "inserts", "moves")}
    core.update(ink=plan.get("ink_signature"), rev=doc_rev(doc))
    return hashlib.sha256(json.dumps(core, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:32]


def plan_push(doc, assigned, old_rows=0, old_key=None, taken=None):
    prepared, issues = db_document(doc)
    if issues:
        return {"updates": [], "inserts": [], "moves": [], "skipped": issues, "ink_errors": issues,
                "blocked": "DB에 연결되지 않은 잉크 또는 중복 연결이 있습니다. 컬러연구소에서 연결을 확인하세요. 전체 전송을 중단합니다."}
    vs = {v["id"]: v for v in prepared.get("variations") or []}
    mapped = [(vs[v["id"]], rows) for v, rows in assigned]
    plan = _plan_push(prepared, mapped, old_rows, old_key, taken)
    plan["ink_signature"] = db_ink_signature(prepared)
    return plan


def _plan_push(doc, assigned, old_rows=0, old_key=None, taken=None):
    """아카이브 -> DB 반영 계획. 실제 쓰기는 하지 않는다.
    assigned: load_doc_rows() 결과. 배합 키 = (도수 패턴 코드, 도수, 배치, 동판)."""
    if old_rows:
        op, oc = old_key or ("", "")
        cp = doc.get("project") or ""
        cc = doc_code(doc)
        return {"updates": [], "inserts": [], "moves": [], "skipped": [],
                "blocked": (f"DB에 옛 코드({op}-{oc}) 행 {old_rows}개가 있습니다. "
                            f"지금 보내면 {cp}-{cc}로 같은 배합이 새로 생깁니다. "
                            "DB 쪽 코드도 바꿀지 먼저 결정하세요."),
                "renamedFrom": {"project": op, "code": oc, "rows": old_rows}}
    vs = doc.get("variations") or []
    if not vs:
        return {"updates": [], "inserts": [], "moves": [], "skipped": [{"batch": "-", "reason": "베리에이션 없음"}]}
    main = doc_code(doc)
    taken = taken or {}
    # 지금 어떤 배합이 정확히 쓰고 있는 키 — 동판 이동은 이 키의 DB 행을 건드리지 않는다
    mix_keys = {(layer_code(doc, v, m.get("layer")), m.get("layer"), m.get("batch"), _mplate(m))
                for v, _rows in assigned for m in v.get("mixes") or [] if isinstance(m, dict)}
    updates, inserts, moves, skipped, shared = [], [], [], [], []
    seen_codes = set()
    seen_keys = {}      # (패턴코드, 도수, 배치, 동판) -> 이미 계획한 컬러 (DB UNIQUE 키와 같음)
    for vi, (v, rows) in enumerate(assigned):
        vid = v.get("id")
        coat = (v.get("colorCode") or "").strip()
        if vi > 0 and not coat:
            if v.get("mixes"):
                skipped.append({"vid": vid, "batch": "-", "reason": "컬러코드 없음 — DB에서 컬러를 구분할 수 없어 건너뜀"})
            continue
        if vi > 0 and coat in seen_codes:
            if v.get("mixes"):
                skipped.append({"vid": vid, "batch": "-", "reason": f"컬러코드 {coat}가 다른 컬러와 같음"})
            continue
        seen_codes.add(coat)
        dbmap = {}
        for d in rows:
            dbmap.setdefault((d.get("_code") or main, d["layer"], d["batch"], d["plate"]), d)
        seen, moved_ids = seen_keys, set()
        for m in v.get("mixes", []):
            plate = (m.get("plate") or "").strip()
            batch = (m.get("batch") or "").strip()
            code = layer_code(doc, v, m.get("layer"))
            base = {"vid": vid, "batch": m.get("batch"), "layer": m.get("layer"), "plate": plate, "code": code}
            if not plate:
                skipped.append(dict(base, reason="동판 없음"))
                continue
            if not batch:
                skipped.append(dict(base, batch="-", reason="배치번호 필요"))
                continue
            if bad_code(code):
                skipped.append(dict(base, reason=f"도수 패턴 '{code}'이 코드 하나가 아님"))
                continue
            if code != main and not coat:
                skipped.append(dict(base, reason="다른 패턴 코드로 보내려면 컬러코드가 필요"))
                continue
            key = (code, m.get("layer"), m.get("batch"), plate)
            if key in seen:
                other, first = seen[key]
                if other == coat:
                    skipped.append(dict(base, reason="같은 패턴·도수·배치·동판 중복"))
                elif mix_values(m) == mix_values(first):
                    # 여러 컬러가 같은 배합을 같이 씀 (작업일지의 2도 C처럼) → DB에는 한 벌
                    shared.append(dict(base, reason=f"{other or '첫 컬러'}와 같은 배합 — DB에는 한 벌만 보냄"))
                else:
                    skipped.append(dict(base, reason=(f"{other or '첫 컬러'}의 같은 배치와 값이 다름 — 같은 배합이면 값을 맞추고, "
                                                      "다른 배합이면 배치 이름을 다르게")))
                continue
            seen[key] = (coat, m)
            cur = dbmap.get(key)
            if cur is None:
                # 예전 키로 들어간 같은 배합 → 새 행을 넣지 않고 그 행을 옮긴다
                #  · 코드: 도수 패턴을 정하기 전의 시편 코드, 또는 바꾸기 전 도수 패턴 (layerPatternsFrom)
                #  · 동판: 저장할 때 남긴 바꾸기 전 동판 (plateFrom, 최근 것부터)
                codes = [code] + [c for c in dict.fromkeys([main] + layer_codes_from(v, m.get("layer"))) if c != code]
                plates = [plate] + [x for x in reversed(plate_from(m)) if x != plate]
                for src_plate in plates:
                    for src in codes:
                        if (src, src_plate) == (code, plate):
                            continue
                        okey = (src, m.get("layer"), m.get("batch"), src_plate)
                        old = dbmap.get(okey)
                        if old is None or old.get("_id") in moved_ids or (src_plate != plate and okey in mix_keys):
                            continue
                        if key in taken:
                            # 옮길 자리에 이미 같은 키 행이 있다 → 옮기면 UNIQUE 위반
                            cur = False
                            where = f"코드 {code}" if src_plate == plate else f"동판 {plate}"
                            skipped.append(dict(base, reason=f"옮길 {where}에 같은 키가 이미 있음 "
                                                             f"({src}·{src_plate} 행과 둘 중 하나 정리 필요)"))
                            break
                        moved_ids.add(old.get("_id"))
                        moves.append(dict(base, id=old.get("_id"), fromPlate=src_plate, toPlate=plate,
                                          **{"from": src, "to": code}))
                        cur = old
                        break
                    if cur is not None:
                        break
            if cur is False:
                continue
            if cur is None:
                if key in taken:
                    skipped.append(dict(base, reason="DB에 같은 키가 이미 있음 (다른 컬러·시편에서 보낸 행) — 확인 필요"))
                    continue
                inserts.append(dict(base, coating=coat))
                continue
            fields = []
            cur_inks = cur.get("inks") or {}
            for k, _col in INK_COLS:
                nv = float((m.get("inks") or {}).get(k) or 0)
                ov = float(cur_inks.get(k) or 0)
                if abs(nv - ov) > 1e-9:
                    fields.append({"name": k, "from": ov, "to": nv})
            for f, _col in PCT_COLS:
                nv = m.get(f)
                if nv is None:
                    continue
                ov = cur.get(f)
                if ov is None or abs(float(nv) - float(ov)) > 1e-9:
                    fields.append({"name": f, "from": ov, "to": float(nv)})
            enum = m.get("result") or ""
            if enum and enum in RESULT_TO_DB and enum != (cur.get("result") or ""):
                fields.append({"name": "result", "from": cur.get("result") or "", "to": RESULT_TO_DB[enum]})
            if m.get("date") and m["date"] != (cur.get("date") or ""):
                fields.append({"name": "date", "from": cur.get("date") or "", "to": m["date"]})
            # 기준 배합 표시는 아카이브가 원본 — 처음 넣을 때만 맞고 그 뒤 바꾼 것이 DB에 안 가던 문제
            if bool(m.get("isReference")) != bool(cur.get("isReference")):
                fields.append({"name": "is_base", "from": int(bool(cur.get("isReference"))), "to": int(bool(m.get("isReference")))})
            if fields:
                updates.append(dict(base, id=cur.get("_id"), fields=fields))
    return {"updates": updates, "inserts": inserts, "moves": moves, "skipped": skipped, "shared": shared}


def backup_rdp_db(path: str) -> str:
    os.makedirs(BACKUP, exist_ok=True)
    bpath = os.path.join(BACKUP, f"rdp.db.{now_stamp()}")
    src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    dst = sqlite3.connect(bpath)
    try:
        with dst:
            src.backup(dst)
    finally:
        dst.close()
        src.close()
    return bpath


def apply_push(project, code, doc, plan):
    doc, issues = db_document(doc)
    if plan.get("blocked") or issues:
        raise ValueError("DB 전송 중단: " + " / ".join(x["reason"] for x in issues or plan.get("ink_errors") or []))
    if plan.get("ink_signature") and plan["ink_signature"] != db_ink_signature(doc):
        raise ValueError("미리보기 이후 배합 또는 잉크 연결이 바뀌었습니다. 다시 미리보기 하세요")
    path = rdp_db_path()
    bpath = backup_rdp_db(path)

    by_key = {}
    for v in doc.get("variations") or []:
        for m in v.get("mixes", []):
            by_key.setdefault((v.get("id"), m.get("layer"), m.get("batch"), (m.get("plate") or "").strip()), m)

    con = sqlite3.connect(path)
    try:
        cur = con.cursor()
        cur.execute("BEGIN IMMEDIATE")
        n_upd = n_ins = n_mov = 0
        failed = []
        bad_ids = set()
        for mv in plan.get("moves") or []:
            if mv.get("id") is None:
                continue
            # 미리보기 뒤에 누가 같은 키를 넣었어도 전체가 실패하지 않게 행 단위로
            cur.execute("SAVEPOINT mv_row")
            try:
                from_plate, to_plate = mv.get("fromPlate", mv["plate"]), mv.get("toPlate", mv["plate"])
                if from_plate != to_plate:
                    cur.execute("UPDATE rdp_mixes SET pattern_code=?, plate=? WHERE id=? AND project=? AND pattern_code=?"
                                " AND TRIM(COALESCE(plate, ''))=?",
                                (mv["to"], to_plate, mv["id"], project, mv["from"], from_plate))
                else:
                    cur.execute("UPDATE rdp_mixes SET pattern_code=? WHERE id=? AND project=? AND pattern_code=?",
                                (mv["to"], mv["id"], project, mv["from"]))
                n_mov += cur.rowcount
                cur.execute("RELEASE mv_row")
            except sqlite3.IntegrityError as e:
                cur.execute("ROLLBACK TO mv_row")
                cur.execute("RELEASE mv_row")
                bad_ids.add(mv["id"])
                failed.append({"layer": mv["layer"], "batch": mv["batch"], "plate": mv["plate"], "code": mv["to"],
                               "reason": "옮길 자리에 같은 키가 이미 있음" if "UNIQUE" in str(e) else str(e)})
        for u in plan["updates"]:
            m = by_key.get((u["vid"], u["layer"], u["batch"], u["plate"]))
            if not m or u.get("id") is None or u["id"] in bad_ids:
                continue
            sets, vals = [], []
            for f in u["fields"]:
                if f["name"] == "result":
                    sets.append("result=?"); vals.append(f["to"])
                elif f["name"] == "date":
                    sets.append("date=?"); vals.append(f["to"])
                elif f["name"] == "is_base":
                    sets.append("is_base=?"); vals.append(1 if f["to"] else 0)
                elif f["name"] in DB_INKS:
                    sets.append(f"{dict(INK_COLS)[f['name']]}=?"); vals.append(f["to"])
                else:
                    sets.append(f"{dict(PCT_COLS)[f['name']]}=?"); vals.append(f["to"])
            vals.append(u["id"])
            cur.execute(f"UPDATE rdp_mixes SET {', '.join(sets)} WHERE id=?", vals)
            n_upd += cur.rowcount
        for ins in plan["inserts"]:
            m = by_key.get((ins["vid"], ins["layer"], ins["batch"], ins["plate"]))
            if not m:
                continue
            inks = {k: float((m.get("inks") or {}).get(k) or 0) for k, _ in INK_COLS}
            cur.execute("SAVEPOINT ins_row")
            try:
                cur.execute("""INSERT INTO rdp_mixes
                (date, project, pattern_code, plate, layer, batch_no, is_base,
                 mt, bk, wh, ye, rd, cl, ye_d,
                 matting_agent_pct, matting_agent_g, thinner_pct, thinner_g, hardener_pct, hardener_g,
                 result, change_summary, notes, coating_code)
                VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)""",
                (m.get("date") or datetime.now().strftime("%Y-%m-%d"), project, ins.get("code") or code, ins["plate"], ins["layer"], ins["batch"],
                 1 if m.get("isReference") else 0,
                 inks["MT"], inks["BK"], inks["WH"], inks["YE"], inks["RD"], inks["CL"], inks["YE-D"],
                 m.get("mattingPct"), m.get("mattingG"), m.get("thinnerPct"), m.get("thinnerG"),
                 m.get("hardenerPct"), m.get("hardenerG"),
                 RESULT_TO_DB.get(m.get("result") or "", ""), m.get("change") or "", m.get("note") or "",
                 ins.get("coating") or ""))
                cur.execute("RELEASE ins_row")
                n_ins += 1
            except sqlite3.IntegrityError as e:
                cur.execute("ROLLBACK TO ins_row")
                cur.execute("RELEASE ins_row")
                failed.append({"layer": ins["layer"], "batch": ins["batch"], "plate": ins["plate"],
                               "code": ins.get("code") or code, "coating": ins.get("coating") or "",
                               "reason": "이미 같은 키가 DB에 있음" if "UNIQUE" in str(e) else str(e)})
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    return {"updated": n_upd, "inserted": n_ins, "moved": n_mov, "failed": failed, "backup": os.path.basename(bpath)}


def rename_db_rows(old_key, new_key):
    """rdp_mixes의 (project, pattern_code)를 옛 키 → 새 키로 바꾼다. 백업 후 실행."""
    path = rdp_db_path()
    if not path or not os.path.isfile(path):
        raise ValueError(f"rdp.db를 찾을 수 없습니다: {path or '(경로 미설정)'}")
    if read_rdp_mixes(*new_key):
        raise ValueError(f"DB에 이미 {new_key[0]}-{new_key[1]} 행이 있어 합칠 수 없습니다")
    bpath = backup_rdp_db(path)
    con = sqlite3.connect(path)
    try:
        cur = con.cursor()
        cur.execute("BEGIN IMMEDIATE")
        cur.execute("UPDATE rdp_mixes SET project=?, pattern_code=? WHERE project=? AND pattern_code=?",
                    (new_key[0], new_key[1], old_key[0], old_key[1]))
        n = cur.rowcount
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    return {"renamed": n, "backup": os.path.basename(bpath)}


def diff_db(doc, assigned):
    prepared, issues = db_document(doc)
    if issues:
        raise ValueError("DB 비교 불가: " + " / ".join(x["reason"] for x in issues))
    vs = {v["id"]: v for v in prepared.get("variations") or []}
    return _diff_db(prepared, [(vs[v["id"]], rows) for v, rows in assigned])


def _diff_db(doc, assigned):
    """아카이브 JSON과 DB를 비교해 차이만 뽑는다 (쓰기 없음). 키 = (도수 패턴 코드, 도수, 배치, 동판)."""
    main = doc_code(doc)
    new, changed, same, unmatched = [], [], 0, []
    for v, rows in assigned:
        dbk, bkey = {}, {}
        for dm in rows:
            code = dm.get("_code") or main
            dbk[(code, dm["layer"], dm["batch"], dm.get("plate") or "")] = dm
            bkey.setdefault((code, dm["layer"], dm["batch"]), []).append(dm)
        arc_keys = set()
        for m in v.get("mixes", []):
            code = layer_code(doc, v, m.get("layer"))
            key = (code, m.get("layer"), m.get("batch"), m.get("plate") or "")
            arc_keys.add(key)
            dm = dbk.get(key)
            if dm is None:
                cands = bkey.get(key[:3]) or []
                if len(cands) == 1 and not m.get("plate"):
                    dm = cands[0]
            if dm is None:
                unmatched.append(m.get("batch"))
                continue
            fields = []
            if dm.get("inks") and {k: x for k, x in (m.get("inks") or {}).items() if k in DB_INKS} != dm["inks"]:
                fields.append("inks")
            for f in ("mattingPct", "mattingG", "thinnerPct", "thinnerG", "hardenerPct", "hardenerG"):
                if dm.get(f) is not None and m.get(f) != dm[f]:
                    fields.append(f)
            if dm.get("result") and m.get("result") != dm["result"]:
                fields.append("result")
            if dm.get("date") and m.get("date") != dm["date"]:
                fields.append("date")
            if bool(m.get("isReference")) != bool(dm.get("isReference")):
                fields.append("is_base")
            if fields:
                changed.append({"vid": v.get("id"), "batch": m.get("batch"), "plate": m.get("plate"), "fields": fields})
            else:
                same += 1
        for k in set(dbk) - arc_keys:
            if len(bkey.get(k[:3]) or []) == 1 and (k[0], k[1], k[2], "") in arc_keys:
                continue
            new.append({"vid": v.get("id"), "code": k[0], "batch": k[2], "plate": k[3]})
    return {"same": same, "changed": changed, "archiveOnly": unmatched, "dbOnly": new}


def read_plate_info(lot: str):
    """rdp.db에서 동판 정보와 그 동판을 쓰는 패턴 목록을 읽는다."""
    path = rdp_db_path()
    if not path or not os.path.isfile(path):
        return None
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        row = con.execute("SELECT * FROM plates WHERE lot_no=?", (lot,)).fetchone()
        if not row:
            return None
        used = con.execute("""
            SELECT pr.code AS project, pa.code AS pattern_code, pp.layer, pa.project_id
            FROM plate_patterns pp
            JOIN plates pl ON pl.id = pp.plate_id
            JOIN patterns pa ON pa.id = pp.pattern_id
            JOIN projects pr ON pr.id = pa.project_id
            WHERE pl.lot_no = ?
            ORDER BY pr.code, pa.code, pp.layer""", (lot,)).fetchall()
    finally:
        con.close()
    return {
        "lot": row["lot_no"], "size": row["size"] or "", "type": row["type"] or "",
        "note": row["note"] or "", "created": row["created_date"] or "",
        "usedBy": [{"id": f"{u['project']}-{u['pattern_code']}",
                    "project": u["project"], "code": u["pattern_code"],
                    "layer": u["layer"] or ""} for u in used],
    }


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
            if not isinstance(doc, dict):
                errors.append(f"{name}: 최상위가 객체가 아님, 건너뜀")
                continue
            if doc.get("id") != stem:
                errors.append(f"{name}: 파일명과 id가 다름 (id={doc.get('id')}) — 동기화 충돌 사본일 수 있음, 건너뜀")
                continue
            # 화면이 그릴 수 없는 문서 하나가 목차 전체를 멈추게 하면 안 된다:
            # 뼈대(pattern·variations)가 없으면 빼고, 나머지 틀린 칸은 빈 값으로 읽고 알린다
            if not isinstance(doc.get("pattern"), dict) or not isinstance(doc.get("variations"), list):
                errors.append(f"{name}: pattern 또는 variations 형식 오류 — 건너뜀")
                continue
            problems = normalize_shape(doc, coerce=True)
            if problems:
                errors.append(f"{name}: 형식 오류를 빈 값으로 읽음 — {' / '.join(problems)} (저장하면 그대로 고쳐집니다)")
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

    # 같은 초에 같은 슬롯으로 올려도 겹치지 않게 고유 꼬리표를 붙인다 (예전 이름은 덮어쓰기 대상이었음)
    name = f"{vid[:40]}-{slot}-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.jpg"
    out_dir = os.path.join(IMAGES, pid)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, name)

    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85, optimize=True)
    tmp_path = f"{out_path}.{uuid.uuid4().hex[:8]}.part"
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


# ---------------------------------------------------------------- 제안서 보관함
PROPOSAL_LOCK = threading.Lock()
SLUG_RE = re.compile(r"^[0-9A-Za-z가-힣_-][0-9A-Za-z가-힣._-]{0,79}$")


def nfc(name: str) -> str:
    return unicodedata.normalize("NFC", name or "")


def proposal_dir(slug: str) -> str:
    """확정본 폴더. 맥(NFD)·윈도우(NFC) 어느 쪽 한글 이름으로 만들어진 폴더도 찾는다."""
    slug = nfc(slug)
    if not SLUG_RE.match(slug):
        raise ValueError("제안서 이름 형식 오류")
    path = safe_join(PROPOSALS, slug)
    if not os.path.exists(path):
        nfd = safe_join(PROPOSALS, unicodedata.normalize("NFD", slug))
        if os.path.exists(nfd):
            return nfd
    return path


def _snap(doc) -> dict:
    return doc.get("_snapshot") if isinstance(doc.get("_snapshot"), dict) else {}


def _proposal_vars(doc):
    """(시편 id, 컬러) 목록 — 모양이 틀린 칸은 건너뛴다 (손으로 고친 확정본 하나가 목록 전체를 멈추지 않게)."""
    out = []
    for it in doc.get("items") if isinstance(doc.get("items"), list) else []:
        if not isinstance(it, dict):
            continue
        pid = (it.get("pattern") if isinstance(it.get("pattern"), dict) else {}).get("id")
        for v in it.get("variations") if isinstance(it.get("variations"), list) else []:
            if isinstance(v, dict):
                out.append((pid, v))
    return out


def load_proposals():
    """확정본 목록 (최신 확정 먼저). 깨진 파일은 건너뛴다. 이름은 NFC로 돌려준다 (맥에서 만든 폴더도 보이게)."""
    out = []
    if not os.path.isdir(PROPOSALS):
        return out
    for name in os.listdir(PROPOSALS):
        slug = nfc(name)
        path = os.path.join(PROPOSALS, name, "proposal.json")
        if not SLUG_RE.match(slug) or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except Exception as e:
            print(f"[warn] 제안서를 읽지 못했습니다 {slug}: {e}")
            continue
        if isinstance(doc, dict):
            out.append((slug, doc))
    out.sort(key=lambda x: str(_snap(x[1]).get("createdAt") or x[1].get("createdAt") or ""), reverse=True)
    return out


def proposal_summary(slug, doc):
    items = doc.get("items") if isinstance(doc.get("items"), list) else []
    vars_ = _proposal_vars(doc)
    thumb = next(({"pid": pid, "name": v["images"][0]} for pid, v in vars_
                  if isinstance(v.get("images"), list) and v["images"] and isinstance(v["images"][0], str) and pid), None)
    snap = _snap(doc)
    return {"slug": slug, "docNo": doc.get("docNo") or "", "rev": str(doc.get("rev") or "0"),
            "title": doc.get("title") or "", "client": doc.get("client") or "", "by": doc.get("by") or "",
            "date": doc.get("date") or "", "createdAt": snap.get("createdAt") or doc.get("createdAt") or "",
            "patterns": len(items), "variations": len(vars_),
            "missing": len(snap.get("missing")) if isinstance(snap.get("missing"), list) else 0,
            "thumb": thumb}


def proposal_shape_error(doc) -> str:
    """확정 저장 요청의 모양 검사 — 틀리면 쓰기 전에 400 (전에는 중간에 500이 나거나 깨진 확정본이 남았다)."""
    items = doc.get("items")
    if not isinstance(items, list) or not items:
        return "담긴 시편이 없습니다"
    for i, it in enumerate(items):
        pat = it.get("pattern") if isinstance(it, dict) else None
        if not isinstance(pat, dict) or not isinstance(pat.get("id"), str) or not ID_RE.match(pat["id"]):
            return f"items[{i}]: 시편(pattern.id) 형식 오류"
        vs = it.get("variations", [])
        if not isinstance(vs, list) or not all(isinstance(v, dict) for v in vs):
            return f"items[{i}]: variations 형식 오류"
        for v in vs:
            imgs = v.get("images", [])
            if not isinstance(imgs, list) or not all(isinstance(n, str) and n for n in imgs):
                return f"items[{i}]: 이미지 목록 형식 오류"
    for k in ("docNo", "rev", "title", "client", "by", "date", "slug"):
        if doc.get(k) is not None and (isinstance(doc[k], bool) or not isinstance(doc[k], (str, int, float))):
            return f"{k} 형식 오류"
    return ""


def next_doc_no(prefix: str, taken) -> str:
    """prefix + 두 자리 번호 중 아직 안 쓴 가장 작은 번호."""
    n = 1
    while f"{prefix}{n:02d}" in taken:
        n += 1
    return f"{prefix}{n:02d}"


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "RDPArchive/2.0"

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s\n" % (fmt % args))

    def _db_write_allowed(self) -> bool:
        if LAN_MODE and not CFG.get("allowLanWrite"):
            return False
        return True

    def _maybe_reload_cfg(self):
        """config.json이 바뀌면 요청 시점에 다시 읽는다 (재시작 없이 주소·인증 설정 반영)."""
        global _CFG_MTIME
        try:
            m = os.path.getmtime(CONFIG_PATH)
        except OSError:
            return  # 파일이 잠깐 사라져도(동기화 중 등) 지금 설정을 유지
        if m == _CFG_MTIME:
            return
        with _CFG_GUARD:
            if m == _CFG_MTIME:
                return
            _CFG_MTIME = m
            try:
                fresh = read_config_file()
            except Exception as e:
                # 새로 읽기에 실패하면 이전 설정을 그대로 둔다 (CFG를 비우지 않는다)
                print(f"[warn] config.json을 다시 읽지 못해 이전 설정을 유지합니다: {e}")
                return
            new = {"dataRoot": CFG.get("dataRoot"), "port": CFG.get("port", 8791)}
            new.update(fresh)
            new.update(CFG_OVERRIDES)   # 데모 모드의 임시 rdp.db·작업일지가 실제 경로로 돌아가지 않게
            # clear() 후 update()하면 다른 스레드가 잠깐 빈 CFG(=인증 꺼짐)를 볼 수 있다
            CFG.update(new)
            for k in [k for k in CFG if k not in new]:
                CFG.pop(k, None)
            SAFE_HOSTS.clear()
            SAFE_HOSTS.update(BASE_HOSTS)
            SAFE_HOSTS.update(LAN_HOSTS)
            SAFE_HOSTS.update(str(h).lower() for h in (CFG.get("allowHosts") or []) if h)

    def _access_ok(self) -> bool:
        """Cloudflare Access 뒤에 있을 때, 인증된 요청만 통과시킨다.
        (Access를 꺼먹거나 잘못 설정해도 앱이 인터넷에 그냥 열리지 않게 하는 안전장치)"""
        if not CFG.get("requireCfAccess"):
            return True
        if self._is_local_direct():
            return True  # 이 맥에서 직접 접속
        jwt = (self.headers.get("Cf-Access-Jwt-Assertion") or "").strip()
        if not jwt:
            return False
        team = cf_team_domain()
        if not team:
            return False  # 팀 도메인이 없으면 서명을 검증할 수 없으므로 거절 (setup_tunnel.py)
        payload = verify_cf_jwt(jwt, team)
        if payload is None:
            return False
        aud = CFG.get("cfAccessAud")
        if aud:
            allowed = aud if isinstance(aud, list) else [aud]
            have = payload.get("aud")
            have = have if isinstance(have, list) else [have]
            if not set(map(str, have)) & set(map(str, allowed)):
                return False
        want_mail = (CFG.get("cfAccessEmail") or "").strip().lower()
        if want_mail and (payload.get("email") or "").strip().lower() != want_mail:
            return False
        return True

    def _is_local_direct(self) -> bool:
        """Host가 localhost이고, 실제로 루프백에서 왔고, Cloudflare를 거치지 않은 요청."""
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        if host not in ("localhost", "127.0.0.1", "[::1]", "::1"):
            return False
        peer = (self.client_address or ("",))[0]
        if not (peer.startswith("127.") or peer in ("::1", "::ffff:127.0.0.1")):
            return False  # LAN 모드에서 Host: localhost 를 위조한 원격 요청
        if self.headers.get("Cf-Ray") or self.headers.get("Cf-Connecting-Ip"):
            return False  # 터널(cloudflared)을 거쳐 온 요청
        return True

    def _write_ok(self) -> bool:
        """상태 변경 요청이 같은 오리진에서 왔는지 확인 (CSRF 방지)."""
        origin = (self.headers.get("Origin") or "").strip()
        if origin:
            host = (urlparse(origin).hostname or "").lower()
            if host not in SAFE_HOSTS:
                return False
        sfs = (self.headers.get("Sec-Fetch-Site") or "").strip()
        if sfs and sfs not in ("same-origin", "none"):
            return False
        return True

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
        self._maybe_reload_cfg()
        if not self._host_ok():
            return self.error(403, "forbidden host")
        if not self._access_ok():
            return self.error(403, "Cloudflare Access 인증이 필요합니다")
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            # PCCS3 (작업일지) — 같은 인증·호스트 검사를 거친 뒤 읽기 전용으로 처리
            if p == "/pccs":
                self.send_response(301)
                self.send_header("Location", "/pccs/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if p.startswith("/pccs/"):
                hit = pccs_api.static_file(p[len("/pccs/"):])
                if hit is None:
                    return self.error(404, "not found")
                return self._send(200, hit[0], hit[1])
            if p.startswith("/api/pccs/"):
                code, obj = pccs_api.handle(p, parse_qs(u.query), CFG)
                return self.json(obj, code)
            # 컬러연구소
            if p == "/lab":
                self.send_response(301)
                self.send_header("Location", "/lab/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if p.startswith("/lab/"):
                hit = lab_api.static_file(p[len("/lab/"):])
                if hit is None:
                    return self.error(404, "not found")
                return self._send(200, hit[0], hit[1])
            if p.startswith("/api/lab/"):
                return self._lab("GET", p, parse_qs(u.query), None)
            if p == "/api/health":
                return self.json({"ok": True, "dataRoot": DATA, "port": PORT,
                                  "brand": CFG.get("brand", "RDP"),
                                  "brandSub": CFG.get("brandSub", "SPECIMEN ARCHIVE"),
                                  "company": CFG.get("company", ""),
                                  "firstPageMax": CFG.get("firstPageMax", 2),
                                  "pageMax": CFG.get("pageMax", 2)})
            if p.startswith("/api/rdp/push-preview/"):
                pid = p[len("/api/rdp/push-preview/"):].strip("/")
                try:
                    safe_id(pid)
                    path = safe_join(PATTERNS, pid + ".json")
                    with open(path, encoding="utf-8") as f:
                        doc = json.load(f)
                    old_rows, old_key = renamed_from_rows(doc)
                    plan = plan_push(doc, load_doc_rows(doc), old_rows, old_key, db_taken_keys(doc))
                    return self.json({"ok": True, "dbPath": rdp_db_path(), **plan, "planHash": plan_hash(plan, doc),
                                      "rev": doc_rev(doc)})
                except Exception as e:
                    return self.error(400, str(e))
            if p.startswith("/api/rdp/diff/"):
                pid = p[len("/api/rdp/diff/"):].strip("/")
                try:
                    safe_id(pid)
                    path = safe_join(PATTERNS, pid + ".json")
                    if not os.path.isfile(path):
                        return self.error(404, "패턴이 없습니다")
                    with open(path, encoding="utf-8") as f:
                        doc = json.load(f)
                    return self.json({"ok": True, **diff_db(doc, load_doc_rows(doc))})
                except Exception as e:
                    return self.error(400, str(e))
            if p.startswith("/api/plate/"):
                lot = p[len("/api/plate/"):].strip("/")
                try:
                    info = read_plate_info(lot)
                    if not info:
                        return self.json({"ok": False, "error": "동판 정보 없음"}, 404)
                    return self.json({"ok": True, **info})
                except Exception as e:
                    return self.error(400, str(e))
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
            if p.startswith("/api/thumb/"):
                tp = p[len("/api/thumb/"):].strip("/").split("/")
                if len(tp) != 2:
                    return self.error(400, "경로 형식 오류")
                q = parse_qs(u.query)
                return self.serve_thumb(tp[0], tp[1], q.get("w", ["480"])[0])
            if p.startswith("/img/"):
                return self.serve_image(p[len("/img/"):])
            if p == "/api/proposals":
                rows = []
                for s_, d_ in load_proposals():
                    try:
                        rows.append(proposal_summary(s_, d_))
                    except Exception as e:   # noqa: BLE001 — 깨진 확정본 하나가 목록 전체를 멈추지 않게
                        print(f"[warn] 제안서 요약 실패 {s_}: {e}")
                return self.json({"ok": True, "proposals": rows})
            if p == "/api/proposals/next-no":
                prefix = (parse_qs(u.query).get("prefix") or [""])[0]
                if not re.match(r"^[0-9A-Za-z._-]{1,40}$", prefix):   # 날짜를 2026.10.28처럼 써도
                    return self.error(400, "prefix 형식 오류")
                taken = {str(d_.get("docNo") or "") for _, d_ in load_proposals()}
                return self.json({"ok": True, "docNo": next_doc_no(prefix, taken)})
            if p.startswith("/api/proposals/"):
                try:
                    d = proposal_dir(p[len("/api/proposals/"):].strip("/"))
                except ValueError as e:
                    return self.error(400, str(e))
                path = os.path.join(d, "proposal.json")
                if not os.path.isfile(path):
                    return self.error(404, "확정본이 없습니다")
                with open(path, encoding="utf-8") as f:
                    return self.json({"ok": True, "slug": nfc(os.path.basename(d)), "proposal": json.load(f)})
            if p.startswith("/proposal-img/"):
                # 확정본에 복사해 둔 이미지 (원본 시편 이미지가 바뀌거나 지워져도 그대로)
                parts = [x for x in p[len("/proposal-img/"):].split("/") if x]
                if len(parts) != 3:
                    return self.error(400, "경로 형식 오류")
                try:
                    pdir = proposal_dir(parts[0])
                except ValueError as e:
                    return self.error(400, str(e))
                w = (parse_qs(u.query).get("w") or [""])[0]
                if w:   # 보관함 목록용 축소본 — 확정본 이미지는 바뀌지 않으므로 오래 캐시
                    return self.serve_thumb(parts[1], parts[2], w, base=os.path.join(pdir, "images"),
                                            cache_dir=os.path.join(THUMBS, "_proposals", nfc(os.path.basename(pdir))),
                                            cache="max-age=31536000, immutable")
                return self.serve_image(f"{parts[1]}/{parts[2]}", os.path.join(pdir, "images"),
                                        cache="max-age=31536000, immutable")
            return self.serve_static(p)
        except BrokenPipeError:
            pass
        except Exception as e:
            self.error(500, str(e))

    def do_PUT(self):
        self._maybe_reload_cfg()
        if not self._host_ok():
            return self.error(403, "forbidden host")
        if not self._access_ok():
            return self.error(403, "Cloudflare Access 인증이 필요합니다")
        if not self._write_ok():
            return self.error(403, "cross-site request blocked")
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p.startswith("/api/lab/"):
                return self._lab("PUT", p, {}, self._lab_body())
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

    def sync_one(self, pid, others=None):
        with pid_lock(pid):
            path = safe_join(PATTERNS, pid + ".json")
            if not os.path.isfile(path):
                return {"ok": False, "error": "패턴 없음"}
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            vs = doc.get("variations") or []
            if not vs:
                return {"ok": False, "error": "베리에이션 없음"}
            # 시편 코드 + 도수별 패턴 코드 행을 베리에이션별로 (load_doc_rows 규칙)
            plans = [(v, rows) for v, rows in load_doc_rows(doc, others) if rows]
            if not plans:
                return {"ok": True, "added": 0, "updated": 0, "variation": None}

            added = updated = 0
            touched = []
            for v, rows in plans:
                a, u = merge_mixes(v, rows)
                added += a
                updated += u
                if a or u:
                    touched.append(v.get("id"))
            v = vs[0]
            if added or updated:
                stamp_doc(doc)
                with open(path, encoding="utf-8") as f:
                    old = f.read()
                atomic_write(os.path.join(BACKUP, f"{pid}.{now_stamp()}.json"), old.encode("utf-8"))
                atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
            return {"ok": True, "added": added, "updated": updated, "rev": doc_rev(doc),
                    "variation": (touched[0] if touched else v.get("id")),
                    "variations": touched,
                    "total": sum(len(x.get("mixes", [])) for x in vs)}

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
        self._maybe_reload_cfg()
        if not self._host_ok():
            return self.error(403, "forbidden host")
        if not self._access_ok():
            return self.error(403, "Cloudflare Access 인증이 필요합니다")
        if not self._write_ok():
            return self.error(403, "cross-site request blocked")
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p.startswith("/api/lab/"):
                return self._lab("POST", p, {}, self._lab_body())
            if p == "/api/open-folder":
                subprocess.Popen(["open", DATA])
                return self.json({"ok": True})
            if p == "/api/rdp/sync-all":
                if not self._db_write_allowed():
                    return self.error(403, "LAN 모드에서는 DB 동기화가 꺼져 있습니다 (config.allowLanWrite)")
                total = {"added": 0, "updated": 0, "patterns": 0, "skipped": []}
                docs = load_all()[0]
                for doc in docs:
                    pid = doc["id"]
                    try:
                        r = self.sync_one(pid, docs)
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
            if p.startswith("/api/rdp/push/"):
                if not self._db_write_allowed():
                    return self.error(403, "LAN 모드에서는 DB 쓰기가 꺼져 있습니다 (config.allowLanWrite)")
                pid = p[len("/api/rdp/push/"):].strip("/")
                try:
                    safe_id(pid)
                    body = json.loads(self.read_body() or b"{}")
                except ValueError:
                    return self.error(400, "id 또는 요청 형식 오류")
                seen_hash = str(body.get("planHash") or "") if isinstance(body, dict) else ""
                try:
                    with pid_lock(pid):
                        path = safe_join(PATTERNS, pid + ".json")
                        with open(path, encoding="utf-8") as f:
                            doc = json.load(f)
                        project = doc.get("project")
                        code = (doc.get("pattern") or {}).get("code")
                        old_rows, old_key = renamed_from_rows(doc)
                        plan = plan_push(doc, load_doc_rows(doc), old_rows, old_key, db_taken_keys(doc))
                        if plan.get("blocked"):
                            return self.json({"ok": False, "blocked": plan["blocked"],
                                              "error": plan["blocked"]}, 409)
                        if not plan["updates"] and not plan["inserts"] and not plan.get("moves"):
                            return self.json({"ok": True, "updated": 0, "inserted": 0, "message": "반영할 변경이 없습니다"})
                        # 사용자가 미리보기에서 본 것과 같은 계획일 때만 쓴다 (그사이 시편·잉크 연결·DB가 바뀌면 다시 보게)
                        if seen_hash != plan_hash(plan, doc):
                            return self.json({"ok": False, "stale": True,
                                              "error": "미리보기 이후 시편·잉크 연결·DB가 바뀌었습니다 — 다시 미리보기 하세요"
                                              if seen_hash else "DB 반영 전에 미리보기를 먼저 확인하세요"}, 409)
                        res = apply_push(project, code, doc, plan)
                        return self.json({"ok": True, **res, "skipped": len(plan["skipped"])})
                except Exception as e:
                    return self.error(500, str(e))
            if p.startswith("/api/rdp/sync/"):
                pid = p[len("/api/rdp/sync/"):].strip("/")
                return self.sync_pattern(pid)
            if p.startswith("/api/rdp/rename-db/"):
                # 시편 코드를 바꾼 뒤: DB 행도 새 코드로 바꾸거나(rename), 옛 행은 두고 표시만 지운다(ignore)
                if not self._db_write_allowed():
                    return self.error(403, "LAN 모드에서는 DB 쓰기가 꺼져 있습니다 (config.allowLanWrite)")
                pid = p[len("/api/rdp/rename-db/"):].strip("/")
                try:
                    safe_id(pid)
                    body = json.loads(self.read_body() or b"{}")
                except ValueError as e:
                    return self.error(400, str(e))
                mode = body.get("mode")
                if mode not in ("rename", "ignore"):
                    return self.error(400, "mode는 rename 또는 ignore")
                try:
                    with pid_lock(pid):
                        path = safe_join(PATTERNS, pid + ".json")
                        if not os.path.isfile(path):
                            return self.error(404, "패턴이 없습니다")
                        with open(path, encoding="utf-8") as f:
                            doc = json.load(f)
                        if self._reject_stale(doc):
                            return
                        rf = doc.get("renamedFrom") or {}
                        if not rf.get("code"):
                            return self.error(400, "코드 변경 기록이 없습니다")
                        res = {}
                        if mode == "rename":
                            old_key = (rf.get("project") or "", rf.get("code") or "")
                            new_key = (doc.get("project") or "", (doc.get("pattern") or {}).get("code") or "")
                            res = rename_db_rows(old_key, new_key)
                        doc.pop("renamedFrom", None)
                        stamp_doc(doc)
                        with open(path, encoding="utf-8") as f:
                            old = f.read()
                        atomic_write(os.path.join(BACKUP, f"{pid}.{now_stamp()}.json"), old.encode("utf-8"))
                        atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
                        return self.json({"ok": True, "savedAt": doc["updatedAt"], "rev": doc["rev"], **res})
                except ValueError as e:
                    return self.error(400, str(e))

            if p == "/api/proposals":
                try:
                    doc = json.loads(self.read_body().decode("utf-8"))
                except ValueError:
                    return self.error(400, "JSON 형식 오류")
                if not isinstance(doc, dict):
                    return self.error(400, "담긴 시편이 없습니다")
                why = proposal_shape_error(doc)
                if why:
                    return self.error(400, why)
                allow_missing = bool(doc.pop("allowMissing", False))
                doc.pop("_snapshot", None)          # 서버가 기록하는 값
                with PROPOSAL_LOCK:
                    # 1) 같은 문서번호·Rev가 이미 확정돼 있으면 쓰지 않는다 (다른 PC에서 같은 번호를 쓴 경우 등)
                    docs = load_proposals()
                    key = (str(doc.get("docNo") or ""), str(doc.get("rev") or "0"))
                    if key[0]:
                        dup = next((s_ for s_, d_ in docs if (str(d_.get("docNo") or ""), str(d_.get("rev") or "0")) == key), None)
                        if dup:
                            m = re.match(r"^(.*-)(\d+)$", key[0])
                            taken = {str(d_.get("docNo") or "") for _, d_ in docs}
                            # 개정본을 만들다 그 Rev가 이미 있으면 다음 Rev도 제안한다 (전에는 새 번호만 → 개정이 막다른 길)
                            revs = [int(r) for d_ in (d_ for _, d_ in docs) if str(d_.get("docNo") or "") == key[0]
                                    for r in [str(d_.get("rev") or "0")] if r.isdigit()]
                            return self.json({"ok": False, "duplicate": True, "existing": dup,
                                              "suggest": next_doc_no(m.group(1), taken) if m else "",
                                              "nextRev": str(max(revs) + 1) if revs else "1"}, 409)
                    # 2) 참조 이미지가 모두 있는지 먼저 확인
                    sources, missing = [], []
                    for item in doc["items"]:
                        pid = (item.get("pattern") or {}).get("id")
                        if not pid:
                            continue
                        safe_id(pid)
                        for v in item.get("variations", []):
                            for name in (v.get("images") or []):
                                src = safe_join(IMAGES, pid, os.path.basename(str(name)))
                                if os.path.isfile(src):
                                    sources.append((pid, src))
                                else:
                                    missing.append(f"{pid}/{name}")
                    if missing and not allow_missing:
                        return self.json({"ok": False, "missing": missing}, 409)
                    if missing:   # 없는 이미지는 확정본에서 뺀다 (깨진 그림 대신 '이미지 없음'으로 보이게)
                        gone = set(missing)
                        for item in doc["items"]:
                            pid = item["pattern"]["id"]
                            for v in item.get("variations", []):
                                v["images"] = [n for n in v.get("images") or [] if f"{pid}/{n}" not in gone]

                    slug = doc.get("slug") or ("proposal-" + now_stamp())
                    slug = re.sub(r"[^0-9A-Za-z가-힣._-]", "-", slug)[:60].lstrip(".") or "proposal"
                    d = os.path.join(PROPOSALS, slug)
                    n = 1
                    while os.path.exists(d):
                        n += 1
                        d = os.path.join(PROPOSALS, f"{slug}-{n:02d}")
                    os.makedirs(d, exist_ok=True)
                    # 스냅샷이 참조하는 이미지를 함께 복사 (나중에 gc가 원본을 지워도 안전)
                    copied = []
                    for pid, src in sources:
                        dst_dir = os.path.join(d, "images", pid)
                        os.makedirs(dst_dir, exist_ok=True)
                        shutil.copy2(src, os.path.join(dst_dir, os.path.basename(src)))
                        copied.append(f"{pid}/{os.path.basename(src)}")
                    doc["_snapshot"] = {"createdAt": now_stamp(), "images": len(copied), "missing": missing}
                    atomic_write(os.path.join(d, "proposal.json"),
                                 json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
                return self.json({"ok": True, "path": os.path.join(d, "proposal.json"),
                                  "slug": os.path.basename(d), "images": len(copied), "missing": missing})
            return self.error(404, "not found")
        except Exception as e:
            self.error(500, str(e))

    def do_DELETE(self):
        self._maybe_reload_cfg()
        if not self._host_ok():
            return self.error(403, "forbidden host")
        if not self._access_ok():
            return self.error(403, "Cloudflare Access 인증이 필요합니다")
        if not self._write_ok():
            return self.error(403, "cross-site request blocked")
        p = unquote(urlparse(self.path).path)
        try:
            if p.startswith("/api/patterns/"):
                pid = p[len("/api/patterns/"):].strip("/")
                try:
                    safe_id(pid)
                except ValueError as e:
                    return self.error(400, str(e))
                with pid_lock(pid):
                    src = safe_join(PATTERNS, pid + ".json")
                    if not os.path.isfile(src):
                        return self.error(404, "시편이 없습니다")
                    try:
                        with open(src, encoding="utf-8") as f:
                            cur = json.load(f)
                    except Exception:
                        cur = None   # 깨진 파일은 버전을 알 수 없으니 휴지통으로만 옮긴다
                    if cur is not None and self._reject_stale(cur):
                        return
                    move_to_trash(src, pid + ".json")
                    move_to_trash(os.path.join(IMAGES, pid), pid + "_images")
                    move_to_trash(os.path.join(ORIG, pid), pid + "_orig")      # 업로드 원본도 함께 (남으면 그 이름을 다시 못 씀)
                    shutil.rmtree(os.path.join(THUMBS, pid), ignore_errors=True)   # 다시 만들 수 있는 캐시
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

    # ---------- 컬러연구소
    def _lab_body(self):
        raw = self.read_body()
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return None

    def _lab(self, method, p, query, body):
        if method != "GET" and not isinstance(body, dict):
            return self.error(400, "JSON 형식 오류")

        def worklog():
            folder = pccs_api.worklog_dir(CFG)
            if not os.path.isdir(folder) or not pccs_api.worklog.yaml_available():
                return None
            return pccs_api.get_index(folder)

        ctx = {"data": DATA, "backup": BACKUP, "patterns": lambda: load_all()[0], "worklog": worklog,
               "rev": (self.headers.get("X-Base-Rev") or "").strip()}
        code, obj = lab_api.handle(method, p, query, body or {}, ctx)
        return self.json(obj, code)

    # ---------- handlers
    MAX_BODY = 40 * 1024 * 1024  # 이미지 1장 상한

    def _reject_stale(self, cur) -> bool:
        """기존 시편을 바꾸거나 지울 때는 화면이 본 버전(X-Base-Rev)이 지금 파일과 같아야 한다.
        다르거나 빠졌으면 409를 보내고 True."""
        cur_rev = doc_rev(cur)
        if not cur_rev:
            return False   # 버전 정보가 전혀 없는 예전/데모 파일
        base_rev = (self.headers.get("X-Base-Rev") or "").strip()
        if base_rev == cur_rev:
            return False
        msg = ("다른 곳에서 먼저 저장되었습니다" if base_rev
               else "버전 정보 없이 기존 시편을 바꿀 수 없습니다 — 새로고침 후 다시 시도하세요")
        self.json({"ok": False, "conflict": True, "message": msg, "current": cur}, 409)
        return True

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
            rename_from = (self.headers.get("X-Rename-From") or "").strip()
            if rename_from:
                safe_id(rename_from)
        except ValueError:
            return self.error(400, "id 형식 오류")
        if rename_from == pid:
            rename_from = ""
        # 두 락은 항상 id 정렬 순서로 잡는다 (A→B / B→A 동시 rename 데드락 방지)
        ids = sorted({pid, rename_from} - {""})
        with contextlib.ExitStack() as st:
            for x in ids:
                st.enter_context(pid_lock(x))
            return self._save_pattern_locked(pid, rename_from)

    def _save_pattern_locked(self, pid, rename_from=""):
        raw = self.read_body()
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self.error(400, f"JSON 파싱 실패: {e}")
        if not isinstance(doc, dict):
            return self.json({"ok": False, "errors": ["JSON 최상위가 객체가 아닙니다"]}, 400)
        doc = {k: v for k, v in doc.items() if not str(k).startswith("_")}
        doc["id"] = pid
        errs = validate_pattern(doc)
        if errs:
            return self.json({"ok": False, "errors": errs}, 400)

        path = safe_join(PATTERNS, pid + ".json")
        src_path = safe_join(PATTERNS, rename_from + ".json") if rename_from else path
        if rename_from:
            if not os.path.isfile(src_path):
                return self.error(404, f"원본 시편({rename_from})이 없습니다")
            clear_leftovers(pid)
            taken = [x for x in (path, os.path.join(IMAGES, pid), os.path.join(ORIG, pid)) if os.path.exists(x)]
            if taken:
                return self.json({"ok": False, "exists": True,
                                  "message": f"'{pid}' 이름이 이미 쓰이고 있습니다 ({', '.join(os.path.relpath(x, DATA) for x in taken)})"}, 409)
        elif (self.headers.get("X-Create") or "").strip() == "1":
            if os.path.exists(path):
                return self.json({"ok": False, "exists": True,
                                  "message": f"'{pid}' 시편이 이미 있습니다"}, 409)
            clear_leftovers(pid)

        prev = None
        if os.path.exists(src_path):
            try:
                with open(src_path, encoding="utf-8") as f:
                    prev = json.load(f)
            except Exception as e:
                print(f"[warn] 기존 파일을 읽지 못했습니다 {rename_from or pid}: {e}")
        if prev is not None and self._reject_stale(prev):
            return

        # DB(rdp_mixes)는 project+pattern_code로 행을 찾는다 → 키가 바뀌면 옛 키를 기록해 둔다
        # (서버가 관리하는 값: 클라이언트가 보낸 renamedFrom은 무시)
        doc.pop("renamedFrom", None)
        track_layer_code_changes(prev if isinstance(prev, dict) else None, doc)
        track_plate_changes(prev if isinstance(prev, dict) else None, doc)
        if isinstance(prev, dict):
            prev_key = (prev.get("project") or "", (prev.get("pattern") or {}).get("code") or "")
            new_key = (doc.get("project") or "", (doc.get("pattern") or {}).get("code") or "")
            rf = prev.get("renamedFrom") if isinstance(prev.get("renamedFrom"), dict) else None
            if not rf and prev_key != new_key and prev_key[1]:
                rf = {"project": prev_key[0], "code": prev_key[1]}
            if rf and (rf.get("project") or "", rf.get("code") or "") != new_key:
                doc["renamedFrom"] = rf

        warns = reference_warnings(doc)   # 디스크를 건드리기 전에 계산 (여기서 실패하면 파일은 그대로)
        stamp_doc(doc)
        if prev is not None or os.path.exists(src_path):
            try:
                with open(src_path, encoding="utf-8") as f:
                    old = f.read()
                atomic_write(os.path.join(BACKUP, f"{rename_from or pid}.{now_stamp()}.json"), old.encode("utf-8"))
            except Exception as e:
                return self.error(500, f"백업 실패로 저장을 중단했습니다: {e}")
        data = json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")
        if rename_from:
            try:
                rename_pattern(rename_from, pid, data)
            except Exception as e:
                return self.error(500, f"이름 변경 실패 — 원래 상태로 되돌렸습니다: {e}")
            shutil.rmtree(os.path.join(THUMBS, rename_from), ignore_errors=True)   # 옛 이름의 썸네일 캐시
        else:
            atomic_write(path, data)
        try:
            removed = gc_images(pid, doc)
        except Exception as e:
            removed = []
            print(f"[warn] gc 실패 {pid}: {e}")
        return self.json({"ok": True, "id": pid, "savedAt": doc["updatedAt"], "rev": doc["rev"], "warnings": warns,
                          "removedImages": removed, "renamedFrom": doc.get("renamedFrom")})

    def serve_thumb(self, pid, name, w, base=None, cache_dir=None, cache="max-age=604800"):
        """카드용 축소본. 큰 원본을 브라우저가 급하게 줄이면 무아레가 생겨서 미리 Lanczos로 줄여 캐시한다.
        base: 원본 폴더 (기본 images, 확정본은 그 제안서의 images) · cache_dir: 축소본 캐시 폴더."""
        try:
            safe_id(pid)
            if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp)$", name, re.I):
                raise ValueError("bad image name")
            w = max(120, min(2000, int(w)))
            src = safe_join(base or IMAGES, pid, name)
            dst_dir = safe_join(cache_dir or THUMBS, pid)
            dst = os.path.join(dst_dir, f"{w}-{name}")
        except ValueError as e:
            return self.error(400, str(e))
        if not os.path.isfile(src):
            return self.error(404, "이미지 없음")
        if not (os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(src)):
            try:
                from PIL import Image
                os.makedirs(dst_dir, exist_ok=True)
                im = Image.open(src).convert("RGB")
                h = max(1, round(w * im.height / im.width))
                im = im.resize((w, h), Image.LANCZOS)
                tmp = f"{dst}.{uuid.uuid4().hex[:8]}.tmp"   # 같은 축소본을 동시에 만들어도 서로의 반쯤 쓴 파일을 옮기지 않게
                im.save(tmp, "JPEG", quality=82, optimize=True)
                os.replace(tmp, dst)
            except Exception:
                return self.serve_image(f"{pid}/{name}", base, cache)
        with open(dst, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def serve_image(self, rel, base=None, cache="no-cache, must-revalidate"):
        try:
            parts = [p for p in rel.split("/") if p]
            if len(parts) != 2:
                raise ValueError("bad image path")
            safe_id(parts[0])
            if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp)$", parts[1], re.I):
                raise ValueError("bad image name")
            path = safe_join(base or IMAGES, parts[0], parts[1])
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
        self.send_header("Cache-Control", cache)
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
        if path.endswith(".js"):
            ctype = "text/javascript"   # 모듈 스크립트는 MIME이 정확해야 실행된다 (OS 레지스트리 값에 기대지 않음)
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            body = f.read()
        self._send(200, body, ctype)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


LAN_MODE = False


def local_ips() -> set:
    ips = set()
    try:
        sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sk.settimeout(0.3)
        sk.connect(("8.8.8.8", 80))
        ips.add(sk.getsockname()[0])
        sk.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    return {ip for ip in ips if ip and not ip.startswith("127.")}


def port_free(port, host="127.0.0.1"):
    """포트를 새로 쓸 수 있는지. 방금 끈 서버의 연결 흔적(TIME_WAIT)만 남은 포트는 '비어 있음'으로 본다
    — 전에는 쓰던 서버를 끄고 바로 다시 켜면(.command) '다른 프로그램이 쓰고 있다'며 멈췄다.
    (서버는 SO_REUSEADDR로 바인드하므로 TIME_WAIT는 막지 않는다. 실제로 듣고 있는 프로그램이 있으면 False)"""
    s = socket.socket()
    try:
        s.bind((host, port))
        return True
    except OSError:
        pass
    finally:
        s.close()
    c = socket.socket()
    c.settimeout(1)
    try:
        c.connect((host, port))
        return False          # 누군가 이 포트에서 듣고 있다
    except OSError:
        return True           # 연결 거부 = 듣는 프로그램 없음, TIME_WAIT 흔적뿐
    finally:
        c.close()


PORT = CFG.get("port", 8791)

if __name__ == "__main__":
    try:  # launchd/파이프로 실행해도 배너가 바로 보이게
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=CFG.get("port", 8791))
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--demo", action="store_true", help="sample-data 로 임시 실행")
    ap.add_argument("--lan", action="store_true", help="같은 네트워크의 다른 기기에서도 접속 허용")
    args = ap.parse_args()
    PORT = args.port

    if args.demo:
        print(f"[demo] {enter_demo_mode()}  (데모용 빈 rdp.db · 예시 작업일지 — 실제 데이터는 건드리지 않음)")

    ensure_dirs()

    if not port_free(PORT):
        # (1) 같은 앱이 이미 떠 있으면 그걸 쓰라고 알려준다 (터널 주소가 바뀌면 안 되므로)
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as r:
                if r.status == 200:
                    print(f"[i] 이미 실행 중입니다 → http://localhost:{PORT}")
                    if not args.no_browser:
                        webbrowser.open(f"http://localhost:{PORT}")
                    sys.exit(0)
        except Exception:
            pass
        # (2) 다른 프로그램이 잡고 있으면 포트를 밀지 않고 멈춘다
        print(f"[!] {PORT} 포트를 다른 프로그램이 쓰고 있습니다.")
        print(f"    확인:  lsof -nP -iTCP:{PORT} -sTCP:LISTEN")
        print(f"    정리:  kill <PID>     (또는 --port 로 다른 번호 지정)")
        sys.exit(1)

    try:
        for doc in load_all()[0]:
            moved = gc_images(doc["id"], doc)
            if moved:
                print(f"[gc] {doc['id']}: {len(moved)}개 정리")
    except Exception as e:
        print(f"[gc] 건너뜀: {e}")

    bind_addr = "127.0.0.1"
    lan_ips = set()
    if args.lan or CFG.get("lan"):
        LAN_MODE = True
        bind_addr = "0.0.0.0"
        lan_ips = local_ips()
        LAN_HOSTS.update(lan_ips)
        LAN_HOSTS.add(socket.gethostname().lower())
        SAFE_HOSTS.update(LAN_HOSTS)

    srv = Server((bind_addr, PORT), Handler)
    tunnel_hosts = [h for h in (CFG.get("allowHosts") or []) if h and h not in ("localhost", "127.0.0.1")]
    print("=" * 54)
    print("  RDP 시편 아카이브 v2")
    print(f"  데이터  {DATA}")
    print(f"  주소    http://localhost:{PORT}")
    if tunnel_hosts:
        mode = "Cloudflare Access 인증 필수" if CFG.get("requireCfAccess") else "인증 없음 (위험)"
        print(f"  터널    https://{tunnel_hosts[0]}   ({mode})")
    if bind_addr == "0.0.0.0":
        for ip in sorted(lan_ips):
            print(f"  외부    http://{ip}:{PORT}   (같은 네트워크에서 접속)")
    else:
        print("  외부    꺼짐  (다른 기기에서 열려면 --lan)")
    print("  종료    Ctrl+C  (또는 이 창을 닫기)")
    print("=" * 54)

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
