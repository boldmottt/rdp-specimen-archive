"""컬러연구소 API — 시편 아카이브 서버(server.py)가 /api/lab/* 요청을 넘긴다.

저장하는 것은 측색 라이브러리 하나뿐이다: <dataRoot>/_lab/library.json
아카이브 시편 · 작업일지 · rdp.db는 읽기만 한다.
"""
import json
import math
import os
import tempfile
import threading
from datetime import datetime

from . import colormath as cm
from . import model

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
STATIC = {"index.html": "text/html; charset=utf-8",
          "app.js": "application/javascript; charset=utf-8",
          "lab.css": "text/css; charset=utf-8"}
SURFACES = ("경면", "패브릭엠보", "엠보사출", "무도장", "기타")
MEAS_KEYS = ("white_bg", "black_bg", "on_white", "on_black")
_guard = threading.Lock()
_lib_cache = {"key": None, "lib": None}     # 잉크 역산 결과를 저장 시점(updatedAt)까지 재사용


# ---------------------------------------------------------------- 저장
def lib_path(data_root):
    return os.path.join(data_root, "_lab", "library.json")


def load_library(data_root):
    p = lib_path(data_root)
    if not os.path.exists(p):
        return {"schema": "colorlab/v1", "inks": [], "substrates": [], "plates": [], "settings": {}, "updatedAt": ""}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _atomic_write(path, data):
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


def _num(x, what):
    try:
        v = float(x)
    except (TypeError, ValueError):
        raise model.ModelError(f"{what}: 숫자가 아님 ({x})")
    if math.isnan(v) or math.isinf(v):
        raise model.ModelError(f"{what}: 숫자가 아님 ({x})")
    return v


def _check_meas(m, what):
    """측정값 하나: sci/sce = [L,a,b], sci_spec/sce_spec = 31개."""
    if m in (None, {}):
        return {}
    if not isinstance(m, dict):
        raise model.ModelError(f"{what}: 형식 오류")
    out = {}
    for mode in model.MODES:
        if m.get(mode) not in (None, "", []):
            lab = m[mode]
            if not isinstance(lab, (list, tuple)) or len(lab) != 3:
                raise model.ModelError(f"{what} {mode.upper()}: L, a, b 세 값이 필요합니다")
            L, a, b = (_num(v, f"{what} {mode.upper()}") for v in lab)
            if not 0 <= L <= 100:
                raise model.ModelError(f"{what} {mode.upper()}: L은 0~100")
            out[mode] = [L, a, b]
        sp = m.get(f"{mode}_spec")
        if sp not in (None, "", []):
            if not isinstance(sp, (list, tuple)) or len(sp) != len(cm.WAVELENGTHS):
                raise model.ModelError(f"{what} {mode.upper()} 분광: {len(cm.WAVELENGTHS)}개(400~700 nm, 10 nm)가 필요합니다")
            out[f"{mode}_spec"] = [_num(v, f"{what} 분광") for v in sp]
    return out


def validate(doc):
    """저장 전에 형식을 검사하고 정리한 문서를 돌려준다."""
    if not isinstance(doc, dict):
        raise model.ModelError("라이브러리 형식 오류")
    inks, names = [], set()
    for i in doc.get("inks") or []:
        name = str((i or {}).get("name") or "").strip()
        if not name:
            raise model.ModelError("이름 없는 잉크가 있습니다")
        if name in names:
            raise model.ModelError(f"잉크 이름 중복: {name}")
        names.add(name)
        ink = {"name": name, "clear": bool(i.get("clear")), "note": str(i.get("note") or "")}
        cal = i.get("cal") or {}
        if not ink["clear"]:
            c = {"hardener_pct": _num(cal.get("hardener_pct", 20), f"{name} 경화제%"),
                 "thinner_pct": _num(cal.get("thinner_pct", 30), f"{name} 신나%"),
                 "method": str(cal.get("method") or ""), "measured_on": str(cal.get("measured_on") or "")}
            for k in MEAS_KEYS:
                c[k] = _check_meas(cal.get(k), f"{name} {k}")
            ink["cal"] = c
        inks.append(ink)
    subs, keys = [], set()
    for s in doc.get("substrates") or []:
        code = str((s or {}).get("code") or "").strip()
        if not code:
            raise model.ModelError("컬러코드 없는 도장 시편이 있습니다")
        maker = str(s.get("maker") or "").strip()
        surface = str(s.get("surface") or "").strip()
        if surface and surface not in SURFACES:
            raise model.ModelError(f"{code}: 표면은 {' / '.join(SURFACES)} 중 하나")
        key = (code, maker, surface, str(s.get("measured_on") or ""))
        if key in keys:
            raise model.ModelError(f"같은 도장 시편이 두 번 있습니다: {code} {maker} {surface}")
        keys.add(key)
        d = {"code": code, "maker": maker, "surface": surface, "desc": str(s.get("desc") or ""),
             "painted": str(s.get("painted") or ""), "measured_on": str(s.get("measured_on") or "")}
        d.update(_check_meas({k: s.get(k) for k in ("sci", "sce", "sci_spec", "sce_spec")}, code))
        if "sci" not in d and "sce" not in d and "sci_spec" not in d and "sce_spec" not in d:
            raise model.ModelError(f"{code}: SCI 또는 SCE 측정값이 필요합니다")
        subs.append(d)
    plates, lots = [], set()
    for p in doc.get("plates") or []:
        lot = str((p or {}).get("lot") or "").strip()
        if not lot:
            raise model.ModelError("lot 없는 동판이 있습니다")
        if lot in lots:
            raise model.ModelError(f"동판 중복: {lot}")
        lots.add(lot)
        t = _num(p.get("thickness", 1.0), f"{lot} 막두께 계수")
        if not 0.05 <= t <= 20:
            raise model.ModelError(f"{lot}: 막두께 계수는 0.05~20")
        cov = {}
        for k, v in (p.get("coverage") or {}).items():
            if v in (None, ""):
                continue
            c = _num(v, f"{lot} 면적률")
            if not 0 <= c <= 1:
                raise model.ModelError(f"{lot} {k} 면적률은 0~1 (예: 35% → 0.35)")
            cov[str(k)] = c
        plates.append({"lot": lot, "thickness": t, "coverage": cov, "note": str(p.get("note") or "")})
    st = doc.get("settings") or {}
    yn = _num(st.get("yn", 1.0), "Yule–Nielsen n")
    if not 1 <= yn <= 10:
        raise model.ModelError("Yule–Nielsen n은 1~10")
    cards = {k: _check_meas((st.get("cards") or {}).get(k), f"기본 {t}") for k, t in (("white", "흰 카드"), ("black", "검정 카드"))}
    settings = {"yn": yn}
    if any(cards.values()):
        settings["cards"] = {k: v for k, v in cards.items() if v}
    return {"schema": "colorlab/v1", "inks": inks, "substrates": subs, "plates": plates, "settings": settings}


def save_library(data_root, backup_dir, doc, base_rev):
    with _guard:
        cur = load_library(data_root)
        if (cur.get("updatedAt") or "") != (base_rev or ""):
            return 409, {"ok": False, "conflict": True, "message": "다른 곳에서 먼저 저장되었습니다", "current": cur}
        clean = validate(doc)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        p = lib_path(data_root)
        if os.path.exists(p):
            with open(p, "rb") as f:
                _atomic_write(os.path.join(backup_dir, f"lab-library.{stamp}.json"), f.read())
        clean["updatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        _atomic_write(p, json.dumps(clean, ensure_ascii=False, indent=2).encode("utf-8"))
        return 200, {"ok": True, "savedAt": clean["updatedAt"]}


def _cached_library(data_root):
    doc = load_library(data_root)
    p = lib_path(data_root)
    key = (p, doc.get("updatedAt"), os.path.getmtime(p) if os.path.exists(p) else 0)
    with _guard:
        if _lib_cache["key"] != key:
            _lib_cache["lib"], _lib_cache["key"] = model.Library(doc), key
        return _lib_cache["lib"]


# ---------------------------------------------------------------- 보기 좋게
def _swatch(m, mode="sci"):
    lab = model.meas_lab(m, mode) if m else None
    return {"lab": [round(x, 2) for x in lab], "hex": cm.lab_to_hex(lab)} if lab else None


def describe_library(doc):
    """화면용 정보: 잉크별 보정 상태(SCI/SCE·분광) · 견본색."""
    lib = model.Library(doc)
    inks = []
    for ink in doc.get("inks") or []:
        info = {"name": ink["name"], "clear": bool(ink.get("clear")), "status": {}}
        for mode in model.MODES:
            for space in ("rgb", "spec"):
                try:
                    p = lib.ink_params(ink["name"], mode, space)
                    info["status"][f"{mode}_{space}"] = {"ok": True, "residual": round(p["residual"], 5)}
                except model.ModelError as e:
                    info["status"][f"{mode}_{space}"] = {"ok": False, "msg": str(e)}
        cal = ink.get("cal") or {}
        info["swatch"] = {k: _swatch(cal.get(k)) for k in MEAS_KEYS}
        inks.append(info)
    subs = [{"ref": _sub_ref(doc, s), "swatch": _swatch(s) or _swatch(s, "sce")} for s in doc.get("substrates") or []]
    return {"inks": inks, "substrates": subs}


def _sub_ref(doc, s):
    """시료에서 가리킬 이름: 같은 코드가 여러 줄이면 @도장처 / @표면을 붙인다 (작업일지 v3와 같은 규칙)."""
    same = [x for x in doc.get("substrates") or [] if x.get("code") == s.get("code")]
    if len(same) <= 1:
        return s["code"]
    if len({x.get("maker") for x in same}) == len(same):
        return f"{s['code']}@{s.get('maker')}"
    if len({x.get("surface") for x in same}) == len(same):
        return f"{s['code']}@{s.get('surface')}"
    return f"{s['code']}@{s.get('maker')}@{s.get('surface')}"


# ---------------------------------------------------------------- 과거 사례
def _full_lab(lab):
    """{L,a,b} 세 값이 다 있을 때만 (L만 적어 둔 기록은 비교하지 않는다)."""
    if not isinstance(lab, dict):
        return None
    try:
        return tuple(float(lab[k]) for k in ("L", "a", "b"))
    except (KeyError, TypeError, ValueError):
        return None


def similar(target, mode, patterns, worklog_index=None, limit=12):
    """목표 LAB에 가까운 과거 측정값: 아카이브 배합의 LAB + 작업일지 시료의 lab."""
    key = "labSce" if mode == "sce" else "labSci"
    out = []
    for p in patterns or []:
        for v in p.get("variations") or []:
            for m in v.get("mixes") or []:
                L = _full_lab(m.get(key))
                if L is None:
                    continue
                plate = (v.get("layerPlates") or {}).get(m.get("layer")) or m.get("plate") or "-"
                out.append({"source": "아카이브", "id": p.get("id"), "title": f"{(p.get('pattern') or {}).get('code', '')} · {v.get('colorName') or v.get('colorCode') or v.get('id')}",
                            "detail": f"{m.get('layer') or ''} {m.get('batch') or ''}차 · 동판 {plate}",
                            "inks": m.get("inks") or {}, "lab": [round(x, 2) for x in L], "hex": cm.lab_to_hex(L),
                            "dE": round(cm.delta_e2000(L, target), 2), "link": f"/#/p/{p.get('id')}/{v.get('id')}"})
    if worklog_index is not None:
        for w in worklog_index.logs:
            if w.kind != "v3":
                continue
            for j in w.jobs:
                for s in j.get("samples") or []:
                    L = _full_lab(((s or {}).get("lab") or {}).get(mode))
                    if L is None:
                        continue
                    lot = (j.get("plate") or {}).get("lot")
                    out.append({"source": "작업일지", "id": w.name, "title": f"{w.date} · 동판 {lot}",
                                "detail": f"{s.get('substrate')} · " + " + ".join(f"{k} {v}" for k, v in (s.get("layers") or {}).items()),
                                "inks": {}, "lab": [round(x, 2) for x in L], "hex": cm.lab_to_hex(L),
                                "dE": round(cm.delta_e2000(L, target), 2), "eval": s.get("eval"),
                                "link": f"/pccs/#/file/{w.name}"})
    out.sort(key=lambda r: r["dE"])
    return out[:limit]


# ---------------------------------------------------------------- 라우팅
def _lab3(x, what):
    if not isinstance(x, (list, tuple)) or len(x) != 3:
        raise model.ModelError(f"{what}: L, a, b 세 값이 필요합니다")
    return [_num(v, what) for v in x]


def _substrate(body, key="substrate"):
    s = body.get(key)
    if isinstance(s, dict):            # 직접 입력: {"sci": [L,a,b]} 등
        return _check_meas(s, "바탕") or None
    return s


def handle(method, path, query, body, ctx):
    """ctx: {'data': dataRoot, 'backup': 백업 폴더, 'patterns': fn, 'worklog': fn|None, 'rev': X-Base-Rev}
    반환: (HTTP 상태, JSON)."""
    try:
        if method == "GET" and path == "/api/lab/library":
            doc = load_library(ctx["data"])
            return 200, {"ok": True, "library": doc, "info": describe_library(doc)}
        if method == "PUT" and path == "/api/lab/library":
            return save_library(ctx["data"], ctx["backup"], body, ctx.get("rev"))
        if method == "GET" and path == "/api/lab/similar":
            mode = (query.get("mode") or ["sci"])[0]
            target = [_num((query.get(k) or [None])[0], f"목표 {k}") for k in ("L", "a", "b")]
            idx = ctx["worklog"]() if ctx.get("worklog") else None
            return 200, {"ok": True, "items": similar(target, mode, ctx["patterns"](), idx)}
        if method != "POST":
            return 404, {"ok": False, "error": "not found"}
        lib = _cached_library(ctx["data"])
        mode = body.get("mode") or "sci"
        if mode not in model.MODES:
            raise model.ModelError("mode는 sci 또는 sce")
        if path == "/api/lab/deltae":
            a, b = _lab3(body.get("a"), "기준"), _lab3(body.get("b"), "비교")
            parts = cm.lab_parts(a, b)
            return 200, {"ok": True, "dE2000": round(cm.delta_e2000(a, b), 3), "dE76": round(cm.delta_e76(a, b), 3),
                         "parts": {k: round(v, 3) for k, v in parts.items()}, "text": cm.describe(parts),
                         "hex": [cm.lab_to_hex(a), cm.lab_to_hex(b)]}
        if path == "/api/lab/predict":
            r = model.predict(lib, _substrate(body), body.get("layer1"), body.get("layer2") or None, mode=mode,
                              plate=body.get("plate"), coverage=body.get("coverage") or None)
            if body.get("target"):
                t = _lab3(body["target"], "목표")
                r["target"] = {"lab": t, "hex": cm.lab_to_hex(t)}
                for v in list(r["regions"].values()) + ([r["average"]] if "average" in r else []):
                    v["dE"] = round(cm.delta_e2000(v["lab"], t), 2)
                    v["diff"] = cm.describe(cm.lab_parts(t, v["lab"]))
            return 200, {"ok": True, **r}
        if path == "/api/lab/recommend":
            r = model.recommend(lib, _lab3(body.get("target"), "목표"), _substrate(body), body.get("inks") or [],
                                mode=mode, max_inks=int(body.get("max_inks") or 3),
                                ink_total=_num(body.get("ink_total") or 60, "잉크 합계"), under=body.get("under") or None,
                                plate=body.get("plate"), hardener_pct=_num(body.get("hardener_pct", 20), "경화제%"),
                                thinner_pct=_num(body.get("thinner_pct", 30), "신나%"),
                                matting_pct=_num(body.get("matting_pct", 0), "소광제%"))
            return 200, {"ok": True, **r}
        if path == "/api/lab/correct":
            r = model.correct(lib, body.get("current"), _lab3(body.get("measured"), "측정"), _lab3(body.get("target"), "목표"),
                              _substrate(body), mode=mode, adjustable=body.get("adjustable") or None,
                              under=body.get("under") or None, plate=body.get("plate"),
                              change_weight=_num(body.get("change_weight", 0.5), "변경 벌점"))
            return 200, {"ok": True, **r}
        if path == "/api/lab/fit":
            return 200, {"ok": True, **model.fit_plate(lib, body.get("samples") or [], mode=mode)}
        return 404, {"ok": False, "error": "not found"}
    except model.ModelError as e:
        return 400, {"ok": False, "error": str(e)}


def static_file(rel):
    rel = rel or "index.html"
    if rel not in STATIC:
        return None
    with open(os.path.join(WEB, rel), "rb") as f:
        return f.read(), STATIC[rel]
