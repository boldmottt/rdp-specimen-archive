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
import urllib.request
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
            "plate": (r["plate"] or "").strip(),
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


def apply_db_mix(m, dm):
    """DB 행 값을 m에 반영. 실제로 바뀐 게 있으면 True."""
    changed = False
    if dm.get("plate") and m.get("plate") != dm["plate"]:
        m["plate"] = dm["plate"]; changed = True
    if dm.get("inks"):
        # DB에는 7종(INK_COLS)만 있다 → 그 외 커스텀 잉크는 아카이브 값을 그대로 둔다
        cur = m.get("inks") or {}
        merged = {k: x for k, x in cur.items() if k not in DB_INKS}
        merged.update(dm["inks"])
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
            cands = [i for i in idx.get(key, []) if i not in used]
            pick = next((i for i in cands if cur[i].get("plate") == dm.get("plate")), None)
            if pick is None and len(cands) == 1:
                pick = cands[0]
            if pick is None:
                cur.append(dm)
                new_i = len(cur) - 1
                idx.setdefault(key, []).append(new_i)
                used.add(new_i)
                added += 1
            else:
                used.add(pick)
                if apply_db_mix(cur[pick], dm):
                    updated += 1

    cur.sort(key=lambda m: (m.get("layer") or "", m.get("date") or "", m.get("batch") or "", m.get("plate") or ""))
    return added, updated


RESULT_TO_DB = {"ok": "✅", "warn": "⚠️", "ng": "❌", "plan": PLAN_LABEL, "planned": PLAN_LABEL, "": ""}
INK_COLS = (("MT", "mt"), ("BK", "bk"), ("WH", "wh"), ("YE", "ye"), ("RD", "rd"), ("CL", "cl"), ("YE-D", "ye_d"))
PCT_COLS = (("mattingPct", "matting_agent_pct"), ("mattingG", "matting_agent_g"),
            ("thinnerPct", "thinner_pct"), ("thinnerG", "thinner_g"),
            ("hardenerPct", "hardener_pct"), ("hardenerG", "hardener_g"))


DB_INKS = {k for k, _ in INK_COLS}


def split_by_variation(vs, db_mixes):
    """sync_one과 같은 규칙: 도장코드 == 컬러코드인 첫 베리에이션, 없으면 첫 베리에이션."""
    out = [(v, []) for v in vs]
    for dm in db_mixes:
        c = (dm.get("_coating") or "").strip()
        i = next((j for j, v in enumerate(vs) if c and (v.get("colorCode") or "").strip() == c), 0)
        out[i][1].append(dm)
    return out


def renamed_from_rows(doc):
    """코드/프로젝트가 바뀐 시편이면 옛 키로 DB에 남아 있는 행 수와 옛 키를 돌려준다."""
    rf = doc.get("renamedFrom") or {}
    old = (rf.get("project") or "", rf.get("code") or "")
    cur = (doc.get("project") or "", (doc.get("pattern") or {}).get("code") or "")
    if not old[1] or old == cur:
        return 0, old
    return len(read_rdp_mixes(*old)), old


def plan_push(doc, db_mixes, old_rows=0, old_key=None):
    """아카이브 -> DB 반영 계획. 실제 쓰기는 하지 않는다.
    모든 베리에이션을 본다 (DB 행은 도장코드=컬러코드로 베리에이션에 나눔)."""
    if old_rows:
        op, oc = old_key or ("", "")
        cp = doc.get("project") or ""
        cc = (doc.get("pattern") or {}).get("code") or ""
        return {"updates": [], "inserts": [], "skipped": [],
                "blocked": (f"DB에 옛 코드({op}-{oc}) 행 {old_rows}개가 있습니다. "
                            f"지금 보내면 {cp}-{cc}로 같은 배합이 새로 생깁니다. "
                            "DB 쪽 코드도 바꿀지 먼저 결정하세요."),
                "renamedFrom": {"project": op, "code": oc, "rows": old_rows}}
    vs = doc.get("variations") or []
    if not vs:
        return {"updates": [], "inserts": [], "skipped": [{"batch": "-", "reason": "베리에이션 없음"}]}
    updates, inserts, skipped = [], [], []
    seen_codes = set()
    for vi, (v, rows) in enumerate(split_by_variation(vs, db_mixes)):
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
        dbmap = {(d["layer"], d["batch"], d["plate"]): d for d in rows}
        seen = set()
        for m in v.get("mixes", []):
            plate = (m.get("plate") or "").strip()
            batch = (m.get("batch") or "").strip()
            if not plate:
                skipped.append({"vid": vid, "batch": m.get("batch"), "reason": "동판 없음"})
                continue
            if not batch:
                skipped.append({"vid": vid, "batch": "-", "layer": m.get("layer"), "reason": "배치번호 필요"})
                continue
            key = (m.get("layer"), m.get("batch"), plate)
            if key in seen:
                skipped.append({"vid": vid, "batch": batch, "reason": "같은 도수·배치·동판 중복"})
                continue
            seen.add(key)
            cur = dbmap.get(key)
            if cur is None:
                inserts.append({"vid": vid, "coating": coat, "batch": m.get("batch"),
                                "layer": m.get("layer"), "plate": plate})
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
            if fields:
                updates.append({"vid": vid, "id": cur.get("_id"), "batch": m.get("batch"),
                                "layer": m.get("layer"), "plate": plate, "fields": fields})
    return {"updates": updates, "inserts": inserts, "skipped": skipped}


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
        n_upd = n_ins = 0
        for u in plan["updates"]:
            m = by_key.get((u["vid"], u["layer"], u["batch"], u["plate"]))
            if not m or u.get("id") is None:
                continue
            sets, vals = [], []
            for f in u["fields"]:
                if f["name"] == "result":
                    sets.append("result=?"); vals.append(f["to"])
                elif f["name"] == "date":
                    sets.append("date=?"); vals.append(f["to"])
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
            cur.execute("""INSERT INTO rdp_mixes
                (date, project, pattern_code, plate, layer, batch_no, is_base,
                 mt, bk, wh, ye, rd, cl, ye_d,
                 matting_agent_pct, matting_agent_g, thinner_pct, thinner_g, hardener_pct, hardener_g,
                 result, change_summary, notes, coating_code)
                VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)""",
                (m.get("date") or datetime.now().strftime("%Y-%m-%d"), project, code, ins["plate"], ins["layer"], ins["batch"],
                 1 if m.get("isReference") else 0,
                 inks["MT"], inks["BK"], inks["WH"], inks["YE"], inks["RD"], inks["CL"], inks["YE-D"],
                 m.get("mattingPct"), m.get("mattingG"), m.get("thinnerPct"), m.get("thinnerG"),
                 m.get("hardenerPct"), m.get("hardenerG"),
                 RESULT_TO_DB.get(m.get("result") or "", ""), m.get("change") or "", m.get("note") or "",
                 ins.get("coating") or ""))
            n_ins += 1
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    return {"updated": n_upd, "inserted": n_ins, "backup": os.path.basename(bpath)}


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


def diff_db(doc, db_mixes):
    """아카이브 JSON과 DB를 비교해 차이만 뽑는다 (쓰기 없음)."""
    v = pick_variation(doc, db_mixes) if db_mixes else ((doc.get("variations") or [None])[0])
    if not v:
        return {"error": "no variation"}
    dbk = {}
    for dm in db_mixes:
        dbk[(dm["layer"], dm["batch"], dm.get("plate") or "")] = dm
    bkey = {}
    for dm in db_mixes:
        bkey.setdefault((dm["layer"], dm["batch"]), []).append(dm)

    new, changed, same, unmatched = [], [], 0, []
    for m in v.get("mixes", []):
        key3 = (m.get("layer"), m.get("batch"), m.get("plate") or "")
        dm = dbk.get(key3)
        if dm is None:
            cands = bkey.get((m.get("layer"), m.get("batch"))) or []
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
        if fields:
            changed.append({"batch": m.get("batch"), "plate": m.get("plate"), "fields": fields})
        else:
            same += 1

    db_keys = set(dbk.keys())
    arc_keys = {(m.get("layer"), m.get("batch"), m.get("plate") or "") for m in v.get("mixes", [])}
    for k in db_keys - arc_keys:
        cands = bkey.get((k[0], k[1])) or []
        if len(cands) == 1:
            continue
        new.append({"batch": k[1], "plate": k[2]})

    return {"variation": v.get("id"), "same": same, "changed": changed,
            "archiveOnly": unmatched, "dbOnly": new}


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

    name = f"{vid}-{slot}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.jpg"
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
                    db_mixes = read_rdp_mixes(doc.get("project"), (doc.get("pattern") or {}).get("code"))
                    old_rows, old_key = renamed_from_rows(doc)
                    plan = plan_push(doc, db_mixes, old_rows, old_key)
                    return self.json({"ok": True, "dbPath": rdp_db_path(), **plan})
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
                    db_mixes = read_rdp_mixes(doc.get("project"), (doc.get("pattern") or {}).get("code"))
                    return self.json({"ok": True, **diff_db(doc, db_mixes)})
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
            if p.startswith("/img/"):
                return self.serve_image(p[len("/img/"):])
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
            vs = doc.get("variations") or []
            if not vs:
                return {"ok": False, "error": "베리에이션 없음"}

            # 도장코드 == 컬러코드 기준으로 베리에이션별 분배, 매칭 안 되면 첫 베리에이션
            groups = {}
            for dm in db_mixes:
                groups.setdefault((dm.get("_coating") or "").strip(), []).append(dm)
            first = vs[0]
            plans = []
            for v in vs:
                code = (v.get("colorCode") or "").strip()
                rows = groups.pop(code, []) if code else []
                if rows:
                    plans.append((v, rows))
            for _code, rows in list(groups.items()):
                plans.append((first, rows))
                groups.pop(_code, None)

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
                doc["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                with open(path, encoding="utf-8") as f:
                    old = f.read()
                atomic_write(os.path.join(BACKUP, f"{pid}.{now_stamp()}.json"), old.encode("utf-8"))
                atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
            return {"ok": True, "added": added, "updated": updated,
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
            if p == "/api/open-folder":
                subprocess.Popen(["open", DATA])
                return self.json({"ok": True})
            if p == "/api/rdp/sync-all":
                if not self._db_write_allowed():
                    return self.error(403, "LAN 모드에서는 DB 동기화가 꺼져 있습니다 (config.allowLanWrite)")
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
            if p.startswith("/api/rdp/push/"):
                if not self._db_write_allowed():
                    return self.error(403, "LAN 모드에서는 DB 쓰기가 꺼져 있습니다 (config.allowLanWrite)")
                pid = p[len("/api/rdp/push/"):].strip("/")
                try:
                    safe_id(pid)
                except ValueError:
                    return self.error(400, "id 형식 오류")
                try:
                    with pid_lock(pid):
                        path = safe_join(PATTERNS, pid + ".json")
                        with open(path, encoding="utf-8") as f:
                            doc = json.load(f)
                        project = doc.get("project")
                        code = (doc.get("pattern") or {}).get("code")
                        db_mixes = read_rdp_mixes(project, code)
                        old_rows, old_key = renamed_from_rows(doc)
                        plan = plan_push(doc, db_mixes, old_rows, old_key)
                        if plan.get("blocked"):
                            return self.json({"ok": False, "blocked": plan["blocked"],
                                              "error": plan["blocked"]}, 409)
                        if not plan["updates"] and not plan["inserts"]:
                            return self.json({"ok": True, "updated": 0, "inserted": 0, "message": "반영할 변경이 없습니다"})
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
                        base_rev = (self.headers.get("X-Base-Rev") or "").strip()
                        if base_rev and base_rev != (doc.get("updatedAt") or ""):
                            return self.json({"ok": False, "conflict": True,
                                              "message": "다른 곳에서 먼저 저장되었습니다", "current": doc}, 409)
                        rf = doc.get("renamedFrom") or {}
                        if not rf.get("code"):
                            return self.error(400, "코드 변경 기록이 없습니다")
                        res = {}
                        if mode == "rename":
                            old_key = (rf.get("project") or "", rf.get("code") or "")
                            new_key = (doc.get("project") or "", (doc.get("pattern") or {}).get("code") or "")
                            res = rename_db_rows(old_key, new_key)
                        doc.pop("renamedFrom", None)
                        doc["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                        with open(path, encoding="utf-8") as f:
                            old = f.read()
                        atomic_write(os.path.join(BACKUP, f"{pid}.{now_stamp()}.json"), old.encode("utf-8"))
                        atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
                        return self.json({"ok": True, "savedAt": doc["updatedAt"], **res})
                except ValueError as e:
                    return self.error(400, str(e))

            if p == "/api/proposals":
                doc = json.loads(self.read_body().decode("utf-8"))
                slug = doc.get("slug") or ("proposal-" + now_stamp())
                slug = re.sub(r"[^0-9A-Za-z가-힣._-]", "-", slug)[:60]
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
            taken = [x for x in (path, os.path.join(IMAGES, pid), os.path.join(ORIG, pid)) if os.path.exists(x)]
            if taken:
                return self.json({"ok": False, "exists": True,
                                  "message": f"'{pid}' 이름이 이미 쓰이고 있습니다 ({', '.join(os.path.relpath(x, DATA) for x in taken)})"}, 409)
        elif (self.headers.get("X-Create") or "").strip() == "1" and os.path.exists(path):
            return self.json({"ok": False, "exists": True,
                              "message": f"'{pid}' 시편이 이미 있습니다"}, 409)

        prev = None
        if os.path.exists(src_path):
            try:
                with open(src_path, encoding="utf-8") as f:
                    prev = json.load(f)
            except Exception as e:
                print(f"[warn] 기존 파일을 읽지 못했습니다 {rename_from or pid}: {e}")
        base_rev = (self.headers.get("X-Base-Rev") or "").strip()
        if prev is not None and (base_rev or rename_from):
            prev_rev = prev.get("updatedAt") or ""
            if prev_rev and base_rev != prev_rev:
                return self.json({"ok": False, "conflict": True,
                                  "message": "다른 곳에서 먼저 저장되었습니다",
                                  "current": prev}, 409)

        # DB(rdp_mixes)는 project+pattern_code로 행을 찾는다 → 키가 바뀌면 옛 키를 기록해 둔다
        # (서버가 관리하는 값: 클라이언트가 보낸 renamedFrom은 무시)
        doc.pop("renamedFrom", None)
        if isinstance(prev, dict):
            prev_key = (prev.get("project") or "", (prev.get("pattern") or {}).get("code") or "")
            new_key = (doc.get("project") or "", (doc.get("pattern") or {}).get("code") or "")
            rf = prev.get("renamedFrom") if isinstance(prev.get("renamedFrom"), dict) else None
            if not rf and prev_key != new_key and prev_key[1]:
                rf = {"project": prev_key[0], "code": prev_key[1]}
            if rf and (rf.get("project") or "", rf.get("code") or "") != new_key:
                doc["renamedFrom"] = rf

        doc["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
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
        else:
            atomic_write(path, data)
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
        return self.json({"ok": True, "id": pid, "savedAt": doc["updatedAt"], "warnings": warns,
                          "removedImages": removed, "renamedFrom": doc.get("renamedFrom")})

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
    s = socket.socket()
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


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
