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
from . import fit as fitmod
from . import model

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
STATIC = {"index.html": "text/html; charset=utf-8",
          "app.js": "application/javascript; charset=utf-8",
          "lab.css": "text/css; charset=utf-8"}
SURFACES = ("경면", "패브릭엠보", "엠보사출", "무도장", "기타")
MEAS_KEYS = ("solid", "white_bg", "black_bg", "on_white", "on_black")
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
            out[f"{mode}_spec"] = model.normalize_spectrum([_num(v, f"{what} 분광") for v in sp], out.get(mode))
    return out


def validate(doc):
    """저장 전에 형식을 검사하고 정리한 문서를 돌려준다."""
    if not isinstance(doc, dict):
        raise model.ModelError("라이브러리 형식 오류")
    for key in ("inks", "substrates", "plates", "transfers"):
        if doc.get(key) is not None and not isinstance(doc[key], list):
            raise model.ModelError(f"{key}는 목록이어야 합니다")
    for key in ("settings", "fits"):
        if doc.get(key) is not None and not isinstance(doc[key], dict):
            raise model.ModelError(f"{key}는 객체여야 합니다")
    model.InkRegistry(doc.get("inks") or [])  # 이름·약칭·별칭·DB 연결의 전역 충돌 검사
    inks, names = [], set()
    for i in doc.get("inks") or []:
        name = str((i or {}).get("name") or "").strip()
        if not name:
            raise model.ModelError("이름 없는 잉크가 있습니다")
        if name in names:
            raise model.ModelError(f"잉크 이름 중복: {name}")
        names.add(name)
        ink = {"name": name, "clear": bool(i.get("clear")), "note": str(i.get("note") or ""), "lot": str(i.get("lot") or "").strip()}
        ink["short_name"] = str(i.get("short_name") or "").strip()
        ink["aliases"] = list(dict.fromkeys(a.strip() for a in (i.get("aliases") or []) if a.strip()))
        ink["db_ink"] = i.get("db_ink", name if name in model.DB_INK_CODES else "")
        cal = i.get("cal") or {}
        if not isinstance(cal, dict):
            raise model.ModelError(f"{name}: 측정값(cal) 형식 오류")
        if not ink["clear"]:
            c = {"hardener_pct": _num(cal.get("hardener_pct", 20), f"{name} 경화제%"),
                 "thinner_pct": _num(cal.get("thinner_pct", 30), f"{name} 신나%"),
                 "method": str(cal.get("method") or ""), "measured_on": str(cal.get("measured_on") or ""),
                 "plate": str(cal.get("plate") or "")}
            for k in MEAS_KEYS:
                c[k] = _check_meas(cal.get(k), f"{name} {k}")
            ink["cal"] = c
        inks.append(ink)
    subs, keys = [], set()
    for s in doc.get("substrates") or []:
        if not isinstance(s, dict):
            raise model.ModelError("도장 시편 형식 오류")
        code = str(s.get("code") or "").strip()
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
        fin = str(s.get("finish") or "").strip()
        if fin and fin not in model.FINISHES:
            raise model.ModelError(f"{code}: 도장 종류는 {' / '.join(model.FINISHES)} 중 하나")
        d["finish"] = fin
        if s.get("gloss") not in (None, ""):
            g = _num(s["gloss"], f"{code} 광택")
            if not 0 <= g <= 200:
                raise model.ModelError(f"{code}: 광택(GU)은 0~200")
            d["gloss"] = g
        d.update(_check_meas({k: s.get(k) for k in ("sci", "sce", "sci_spec", "sce_spec")}, code))
        if "sci" not in d and "sce" not in d and "sci_spec" not in d and "sce_spec" not in d:
            raise model.ModelError(f"{code}: SCI 또는 SCE 측정값이 필요합니다")
        subs.append(d)
    plates, lots = [], set()
    for p in doc.get("plates") or []:
        if not isinstance(p, dict):
            raise model.ModelError("동판 형식 오류")
        lot = str(p.get("lot") or "").strip()
        if not lot:
            raise model.ModelError("lot 없는 동판이 있습니다")
        if lot in lots:
            raise model.ModelError(f"동판 중복: {lot}")
        lots.add(lot)
        d = {"lot": lot}
        for key, what, lo, hi in (("thickness", "막두께 계수", 0.05, 20), ("lpi", "LPI", 1, 2000),
                                  ("depth_um", "부식 깊이(µm)", 0.1, 500), ("dot50", "50% 망점의 실제 비율", 0.05, 0.99)):
            if p.get(key) in (None, ""):
                continue                       # 비우면 다른 동판에서 추정
            v = _num(p[key], f"{lot} {what}")
            if not lo <= v <= hi:
                raise model.ModelError(f"{lot}: {what}은(는) {lo:g}~{hi:g}")
            d[key] = v
        cov = {}
        if not isinstance(p.get("coverage") or {}, dict):
            raise model.ModelError(f"{lot}: 망점(coverage) 형식 오류")
        for k, v in (p.get("coverage") or {}).items():
            if v in (None, ""):
                continue
            c = _num(v, f"{lot} 망점")
            if not 0 <= c <= 1:
                raise model.ModelError(f"{lot} {k} 망점은 0~1 (예: 60% → 0.6)")
            cov[str(k)] = c
        d.update({"coverage": cov, "note": str(p.get("note") or "")})
        plates.append(d)
    transfers = [_check_transfer(t, i + 1) for i, t in enumerate(doc.get("transfers") or [])]
    registry = model.InkRegistry(inks)
    for t in transfers:
        for layer in (t.get("layer1"), t.get("layer2")):
            if layer:
                layer["inks"] = registry.normalize(layer["inks"])
    st = doc.get("settings") or {}
    if not isinstance(st.get("cards") or {}, dict):
        raise model.ModelError("기본 카드값(settings.cards) 형식 오류")
    yn = _num(st.get("yn", 1.0), "Yule–Nielsen n")
    if not 1 <= yn <= 10:
        raise model.ModelError("Yule–Nielsen n은 1~10")
    cards = {k: _check_meas((st.get("cards") or {}).get(k), f"기본 {t}") for k, t in (("white", "흰 카드"), ("black", "검정 카드"))}
    settings = {"yn": yn}
    if st.get("observer") not in (None, ""):
        if str(st["observer"]) not in cm.OBSERVERS:
            raise model.ModelError("관찰자는 2 또는 10 (°)")
        settings["observer"] = str(st["observer"])
    settings["tolerance"] = _check_tolerance(st.get("tolerance"))
    if st.get("basis") not in (None, ""):
        if st["basis"] not in cm.BASES:
            raise model.ModelError(f"3채널 기저는 {' / '.join(cm.BASES)} 중 하나")
        settings["basis"] = st["basis"]
    for k in ("instrument", "aperture"):        # 측색기 이름 · 측정 구경 (기록용)
        if str(st.get(k) or "").strip():
            settings[k] = str(st[k]).strip()[:80]
    if any(cards.values()):
        settings["cards"] = {k: v for k, v in cards.items() if v}
    return {"schema": "colorlab/v1", "inks": inks, "substrates": subs, "plates": plates, "transfers": transfers,
            "settings": settings, "fits": _check_fits(doc.get("fits"))}


def _check_tolerance(t):
    """허용 기준: 공식(ΔE00 / ΔE*ab / CMC 2:1) · 한도 · (선택) 축별 한도 |ΔL| |Δa| |Δb|."""
    t = t if isinstance(t, dict) else {}
    formula = str(t.get("formula") or "de00")
    if formula not in cm.FORMULAS:
        raise model.ModelError("허용 공식은 de00 / de76 / cmc 중 하나")
    limit = _num(t.get("limit", 1.0), "허용 한도")
    if not 0 < limit <= 50:
        raise model.ModelError("허용 한도는 0 초과 50 이하")
    axes = {}
    for k in ("dL", "da", "db"):
        v = (t.get("axes") or {}).get(k) if isinstance(t.get("axes"), dict) else None
        if v not in (None, ""):
            v = _num(v, f"{k} 한도")
            if v <= 0:
                raise model.ModelError(f"{k} 한도는 0보다 커야 합니다")
            axes[k] = v
    return {"formula": formula, "limit": limit, **({"axes": axes} if axes else {})}


def tolerance(doc_or_lib):
    st = doc_or_lib.settings if hasattr(doc_or_lib, "settings") else (doc_or_lib.get("settings") or {})
    try:
        return _check_tolerance(st.get("tolerance"))
    except model.ModelError:
        return {"formula": "de00", "limit": 1.0}


def judge(tol, target, lab):
    """고객 규격으로 판정: {공식, 값, 한도, 합격, 넘은 축}."""
    label, fn = cm.FORMULAS[tol["formula"]]
    v = fn(tuple(target), tuple(lab))
    parts = cm.lab_parts(tuple(target), tuple(lab))
    over = [k for k, lim in (tol.get("axes") or {}).items() if abs(parts[k]) > lim]
    return {"formula": label, "value": round(v, 2), "limit": tol["limit"], "ok": v <= tol["limit"] and not over,
            "over": over}


def _check_fits(fits):
    """보정 프로필 목록 — 동판 × 모드 × 계산 공간마다 하나. 예전 형식 {'active', 'previous'}도 받아 바꾼다."""
    fits = fits or {}
    if not isinstance(fits, dict):
        raise model.ModelError("fits는 객체여야 합니다")
    runs = {}
    for r in model.fits_runs(fits):
        r = _check_run(r)
        runs[model.run_key(r)] = r                     # 같은 키가 둘이면 나중 것
    prev = {}
    old = fits.get("previous")
    if isinstance(old, dict) and "mode" in old:        # 예전 형식: 바로 전 프로필 하나
        old = {model.run_key(old): old}
    for k, r in (old or {}).items() if isinstance(old, dict) else []:
        if r:
            prev[str(k)] = _check_run(r)
    return {"runs": list(runs.values()), "previous": prev}


def _check_run(run):
    """저장된 보정 프로필의 계산에 쓰이는 부분만 형식 검사 (나머지 진단 기록은 그대로 둔다)."""
    if not run:
        return None
    if not isinstance(run, dict) or run.get("mode") not in model.MODES or not isinstance(run.get("plates"), dict):
        raise model.ModelError("보정 프로필 형식 오류")
    n = model.n_channels(run.get("space"))
    if run.get("space") not in ("spec",) + cm.BASES:
        raise model.ModelError("보정 프로필 계산 공간 오류")
    for name, v in (run.get("inks") or {}).items():
        if not isinstance(v, dict) or len(v.get("k") or []) != n or len(v.get("s") or []) != n:
            raise model.ModelError(f"보정 프로필 잉크 {name} 형식 오류")
        for x in list(v["k"]) + list(v["s"]):
            if _num(x, f"보정 프로필 {name}") < 0:
                raise model.ModelError(f"보정 프로필 잉크 {name}: 음수")
    for lot, v in run["plates"].items():
        if not isinstance(v, dict) or _num(v.get("thickness"), f"보정 프로필 {lot} 막두께") <= 0:
            raise model.ModelError(f"보정 프로필 {lot} 막두께 오류")
        curve = v.get("tone_curve") or []
        if not isinstance(curve, list) or not all(isinstance(x, (list, tuple)) and len(x) == 2 for x in curve):
            raise model.ModelError(f"보정 프로필 {lot} 망점 곡선 형식 오류")
        for d, e in curve:
            if not (0 <= _num(d, "망점") <= 1 and 0 <= _num(e, "망점") <= 1):
                raise model.ModelError(f"보정 프로필 {lot} 망점 곡선 오류")
    return run


def _check_layer(x, what):
    if not isinstance(x, dict):
        raise model.ModelError(f"{what}: 형식 오류")
    inks = {}
    for k, v in (x.get("inks") or {}).items():
        g = _num(v, f"{what} {k}")
        if g < 0:
            raise model.ModelError(f"{what} {k}: g은 0 이상")
        if g > 0:
            inks[str(k).strip()] = g
    if not inks:
        raise model.ModelError(f"{what}: 잉크 g이 없습니다")
    tone = _num(x.get("tone", 100), f"{what} 망점 %")
    if not 0 < tone <= 100:
        raise model.ModelError(f"{what}: 망점 %는 0 초과 100 이하")
    return {"inks": inks, "tone": tone}


def _check_transfer(t, no):
    """전사 시료 한 줄: 동판으로 네모 패치를 찍어 잰 값."""
    what = f"전사 시료 {no}번"
    if not isinstance(t, dict):
        raise model.ModelError(f"{what}: 형식 오류")
    sub = t.get("substrate")
    if isinstance(sub, dict):
        sub = _check_meas(sub, f"{what} 바탕") or None
    else:
        sub = str(sub or "").strip() or None
    if not sub:
        raise model.ModelError(f"{what}: 바탕을 고르세요")
    d = {"date": str(t.get("date") or ""), "plate": str(t.get("plate") or "").strip(), "substrate": sub,
         "layer1": _check_layer(t.get("layer1"), f"{what} 1도")}
    if t.get("layer2") and (not isinstance(t["layer2"], dict) or t["layer2"].get("inks")):
        d["layer2"] = _check_layer(t["layer2"], f"{what} 2도")
    for k, label in (("thinner_pct", "신나 %"), ("hardener_pct", "경화제 %"), ("matting_pct", "소광제 %")):
        v = _num(t.get(k, {"thinner_pct": 30, "hardener_pct": 20}.get(k, 0)), f"{what} {label}")
        if v < 0:
            raise model.ModelError(f"{what}: {label}는 0 이상")
        d[k] = v
    d["measured"] = _check_meas(t.get("measured"), f"{what} 측정")
    if t.get("validation"):
        d["validation"] = True       # 검증용: 보정에 쓰지 않음 · 아직 안 쟀으면 빈 채로 둘 수 있음 ('잴 예정')
    elif not d["measured"]:
        raise model.ModelError(f"{what}: 잰 값(SCI 또는 SCE)이 필요합니다 (검증용으로 표시하면 나중에 재도 됩니다)")
    d["note"] = str(t.get("note") or "")
    for k in TRANSFER_META:              # 공정·측정 조건 (같은 배합인데 색이 다른 이유를 남긴다)
        v = str(t.get(k) or "").strip()
        if v:
            d[k] = v[:80]
    for k, lo, hi, label in (("temp", -10, 60, "온도 °C"), ("humidity", 0, 100, "습도 %")):
        if t.get(k) not in (None, ""):
            v = _num(t[k], f"{what} {label}")
            if not lo <= v <= hi:
                raise model.ModelError(f"{what}: {label}는 {lo}~{hi}")
            d[k] = v
    return d


TRANSFER_META = ("machine", "pad", "cure", "instrument")   # 설비 · 패드 · 측정 시점(경화) · 측색기


def transfer_sample(t, mode):
    """저장된 전사 시료 → 엔진 시료 형식 (이 mode의 잰 값이 없으면 None)."""
    lab = model.meas_lab(t.get("measured"), mode)
    if lab is None:
        return None

    def rec(layer):
        tot = sum(layer["inks"].values())
        return {"inks": layer["inks"], **{k: {"g": tot * float(t.get(f"{k}_pct") or 0) / 100}
                                          for k in ("thinner", "hardener", "matting")}}

    s = {"substrate": t["substrate"], "layer1": rec(t["layer1"]), "coverage": {"1도": float(t["layer1"].get("tone", 100)) / 100},
         "measured": t.get("measured"), "measured_lab": list(lab)}      # 원본 측정(분광 포함)도 그대로
    if t.get("layer2"):
        s["layer2"] = rec(t["layer2"])
        s["coverage"]["2도"] = float(t["layer2"].get("tone", 100)) / 100
    return s


def save_library(data_root, backup_dir, doc, base_rev):
    with _guard:
        cur = load_library(data_root)
        if (cur.get("updatedAt") or "") != (base_rev or ""):
            return 409, {"ok": False, "conflict": True, "message": "다른 곳에서 먼저 저장되었습니다", "current": cur}
        clean = validate(doc)
        fixed = _requalify(clean, cur)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        p = lib_path(data_root)
        if os.path.exists(p):
            with open(p, "rb") as f:
                _atomic_write(os.path.join(backup_dir, f"lab-library.{stamp}.json"), f.read())
        clean["updatedAt"] = datetime.now().isoformat(timespec="microseconds")
        _atomic_write(p, json.dumps(clean, ensure_ascii=False, indent=2).encode("utf-8"))
        return 200, {"ok": True, "savedAt": clean["updatedAt"], "requalified": fixed}


def _requalify(clean, prev):
    """새 도장 시편 줄 때문에 전사 시료의 바탕 이름이 여러 줄에 걸리게 되면, 저장 전 판에서 가리키던 줄의
    구체적인 이름(코드@도장처 / 코드@표면)으로 바꿔 둔다 — 시료의 바탕이 몰래 다른 값으로 바뀌지 않게."""
    try:
        old = model.Library({"substrates": prev.get("substrates") or [], "settings": prev.get("settings") or {}})
    except model.ModelError:
        return []
    new = model.Library({"substrates": clean["substrates"], "settings": clean["settings"]})
    fixed = []
    for no, t in enumerate(clean.get("transfers") or [], 1):
        ref = t.get("substrate")
        if not isinstance(ref, str) or ref in model.CARDS:
            continue
        try:
            new.find_substrate(ref)
            continue
        except model.AmbiguousSubstrate:
            pass
        except model.ModelError:
            continue
        try:
            was = old.find_substrate(ref)
        except model.ModelError:
            continue
        same = [s for s in clean["substrates"] if (s.get("code"), s.get("maker"), s.get("surface"))
                == (was.get("code"), was.get("maker"), was.get("surface"))]
        if not same:
            continue
        t["substrate"] = _sub_ref(clean, same[0])
        fixed.append(f"{no}번: {ref} → {t['substrate']}")
    return fixed


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


def ink_catalog(doc):
    """아카이브용 가벼운 공통 잉크 목록. 보정 최적화를 실행하지 않는다."""
    registry = model.InkRegistry(doc.get("inks") or [])
    rows = []
    for name, ink in registry.inks.items():
        solid = (ink.get("cal") or {}).get("solid")
        swatches = {}
        for mode in model.MODES:
            swatch = _swatch(solid, mode)
            if swatch:
                swatch["in_gamut"] = cm.in_gamut(swatch["lab"])
            swatches[mode] = swatch
        rows.append({"name": name, "short_name": ink.get("short_name") or name,
                     "aliases": ink.get("aliases") or [], "db_ink": registry.db_code(name),
                     "clear": bool(ink.get("clear")), "swatches": swatches})
    subs = [{"ref": _sub_ref(doc, s), "modes": [m for m in model.MODES if model.has(s, m, "xyz")]}
            for s in doc.get("substrates") or []]
    cards = (doc.get("settings") or {}).get("cards") or {}
    subs += [{"ref": name, "modes": [m for m in model.MODES if model.has(cards[key], m, "xyz")]}
             for name, key in model.CARDS.items() if cards.get(key)]
    return {"inks": rows, "lookup": registry.lookup, "db_codes": list(model.DB_INK_CODES),
            "substrates": subs, "plates": [p["lot"] for p in doc.get("plates") or []],
            "updatedAt": doc.get("updatedAt") or ""}


def recipe_preview(lib, doc, body, mode):
    """아카이브의 미저장 배합도 계산. 실측값을 덮어쓰거나 LAB 평균으로 대체하지 않는다."""
    raw = body.get("recipe")
    if not isinstance(raw, dict):
        raise model.ModelError("배합을 입력하세요")
    if "tone" not in body:
        raise model.ModelError("설계 망점 %를 입력하세요")
    for key, label in (("thinner", "신나"), ("hardener", "경화제")):
        value = raw.get(key)
        if not isinstance(value, dict) or value.get("g") is None:
            raise model.ModelError(f"{label} 사용량(g)을 입력하세요 (미사용이면 0)")
    recipe = lib.recipe(raw)
    substrate = _substrate(body)
    if not substrate:
        raise model.ModelError("예상색을 계산할 바탕을 선택하세요")
    tone = _tone(body)
    plate = body.get("plate") or None
    if plate and plate not in lib.plates:
        raise model.ModelError(f"라이브러리에 없는 동판: {plate}")
    sub = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    space = model.pick_space(lib, mode, recipe["inks"], sub)
    errors = []
    for name in recipe["inks"]:
        try:
            lib.ink_params(name, mode, space)
        except model.ModelError as e:
            errors.append(str(e))
    if errors:
        raise model.ModelError("계산 준비 안 됨: " + " / ".join(errors))
    result = model.predict(lib, substrate, recipe, mode=mode, plate=plate, coverage={"1도": tone})
    total = sum(recipe["inks"].values())
    ingredients = [{"name": n, "g": g, "pct": g / total * 100} for n, g in recipe["inks"].items()]
    warnings = ["모델 예상색이며 실측값이 아닙니다. 혼합·새 바탕은 실측 검증이 필요합니다.",
                f"분광으로 계산한 LAB는 D65·{lib.observer}° 기준입니다 (라이브러리 › 계산 설정). 측정 조건과 다르면 비교할 수 없습니다."]
    if not plate:
        warnings.append("동판 미지정: 상대 두께 ×1.00, 퍼짐 없음 가정")
    if len(ingredients) < len([v for v in (body.get("recipe") or {}).get("inks", {}).values() if float(v) > 0]):
        warnings.append("정식명과 별칭으로 입력한 같은 잉크의 중량을 합산했습니다.")
    for n in recipe["inks"]:
        solid = (lib.inks[n].get("cal") or {}).get("solid")
        if solid:
            warnings += [x["msg"] for x in fitmod.diagnose_measurement(solid, mode, space, n)]
    runs = [lib.plate_run(plate, mode, space)] if plate else []
    runs += [lib.ink_run(n, mode, space) for n in recipe["inks"]]
    for run in [r for i, r in enumerate(runs) if r and r not in runs[:i]]:
        bounds = (run.get("applicability") or {}).get("tones")
        if bounds and not bounds[0] <= tone <= bounds[1]:
            warnings.append(f"망점 {tone * 100:g}%는 동판 {run.get('plate')} 보정 시료 범위 {bounds[0] * 100:g}~{bounds[1] * 100:g}% 밖: 외삽 가정입니다.")
        warnings += [f"동판 {run.get('plate')} 보정 프로필 재맞추기 필요: " + x for x in fitmod.stale_reasons(run, doc)]
        confidence = (run.get("confidence") or {}).get("level")
        if confidence:
            warnings.append(f"동판 {run.get('plate')} 보정 프로필 신뢰도: {confidence} (현재 배합의 검증 결과는 아님)")
    return {**result, "ingredients": ingredients, "warnings": list(dict.fromkeys(warnings))}


def describe_library(doc, lib=None):
    """화면용 정보: 잉크별 보정 상태(SCI/SCE·분광) · 견본색 · 동판 추정값 · 전사 시료 예측 오차."""
    lib = lib or model.Library(doc)
    inks = []
    for ink in doc.get("inks") or []:
        info = {"name": ink["name"], "clear": bool(ink.get("clear")), "status": {}}
        for mode in model.MODES:
            for key, space in (("tri", lib.basis), ("spec", "spec")):
                try:
                    p = lib.ink_params(ink["name"], mode, space)
                    info["status"][f"{mode}_{key}"] = {"ok": True, "residual": round(p["residual"], 5),
                                                       "used": p.get("used", []), "source": p.get("source")}
                except model.ModelError as e:
                    info["status"][f"{mode}_{key}"] = {"ok": False, "msg": str(e)}
        cal = ink.get("cal") or {}
        info["swatch"] = {k: _swatch(cal.get(k)) for k in MEAS_KEYS}
        inks.append(info)
    subs = [{"ref": _sub_ref(doc, s), "swatch": _swatch(s) or _swatch(s, "sce")} for s in doc.get("substrates") or []]
    cards = (doc.get("settings") or {}).get("cards") or {}
    subs += [{"ref": name, "swatch": _swatch(cards[key]) or _swatch(cards[key], "sce"), "card": True}
             for name, key in model.CARDS.items() if cards.get(key)]
    # 전사 시료: 지금 라이브러리로 예측했을 때의 오차 → 동판별 신뢰도
    trs, per_plate = [], {}
    for t in doc.get("transfers") or []:
        row = {}
        for mode in model.MODES:
            smp = transfer_sample(t, mode)
            if smp is None:
                continue
            try:
                lab = model.sample_color(lib, smp, mode, t.get("plate") or None)
                de = cm.delta_e2000(lab, smp["measured_lab"])
                row[mode] = {"dE": round(de, 2), "hex": cm.lab_to_hex(lab), "lab": [round(x, 2) for x in lab],
                             "diff": cm.describe(cm.lab_parts(smp["measured_lab"], lab))}
                per_plate.setdefault((t.get("plate") or "", mode), []).append(de)
            except model.ModelError as e:
                row[mode] = {"error": str(e)}
        trs.append(row)
    plates = {}
    for p in doc.get("plates") or []:
        info = lib.plate_info(p["lot"])
        acc = {m: {"dE": round(sum(v) / len(v), 2), "n": len(v)}
               for m in model.MODES for v in [per_plate.get((p["lot"], m))] if v}
        plates[p["lot"]] = {"thickness": round(info["thickness"], 3), "thickness_src": info["thickness_src"],
                            "dot50": round(info["dot50"], 4), "gain_src": info["gain_src"], "accuracy": acc,
                            "samples": sum(1 for t in doc.get("transfers") or [] if t.get("plate") == p["lot"])}
    fits = doc.get("fits") or {}
    runs = sorted(model.fits_runs(fits), key=lambda r: (str(r.get("plate")), r.get("mode") or ""))
    prev = fits.get("previous") if isinstance(fits.get("previous"), dict) and "mode" not in fits.get("previous", {}) else (
        {model.run_key(fits["previous"]): fits["previous"]} if isinstance(fits.get("previous"), dict) else {})
    profile = {"runs": [dict(_run_summary(r, doc), key=model.run_key(r)) for r in runs],
               "previous": {k: _run_summary(v, None) for k, v in (prev or {}).items() if v},
               "basis": lib.basis, "observer": lib.observer}
    return {"inks": inks, "substrates": subs, "plates": plates, "transfers": trs, "profile": profile,
            "db_codes": list(model.DB_INK_CODES), "tolerance": tolerance(doc),
            "formulas": {k: v[0] for k, v in cm.FORMULAS.items()}}


def _run_summary(run, doc):
    if not run:
        return None
    out = {k: run.get(k) for k in ("id", "created", "mode", "space", "plate", "confidence", "assumptions", "applicability")}
    out["inks"] = sorted((run.get("inks") or {}).keys())
    out["tone_curve"] = ((run.get("plates") or {}).get(run.get("plate")) or {}).get("tone_curve")
    if doc is not None:
        out["stale"] = fitmod.stale_reasons(run, doc)
    return out


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


def _pct_of(m, key, total):
    """아카이브 배합의 첨가량 % (pct가 있으면 그대로, g만 있으면 잉크 합 대비)."""
    if m.get(f"{key}Pct") not in (None, ""):
        try:
            return float(m[f"{key}Pct"])
        except (TypeError, ValueError):
            return 0.0
    try:
        return float(m.get(f"{key}G") or 0) / total * 100 if total else 0.0
    except (TypeError, ValueError):
        return 0.0


def similar(target, mode, patterns, worklog_index=None, limit=12, transfers=None, substrate=None, plate=None):
    """목표 LAB에 가까운 과거 측정값: 아카이브 배합의 LAB + 작업일지 시료의 lab + 컬러연구소 전사 시료.
    substrate · plate를 주면 그 바탕(도장 컬러 코드) · 동판 기록만. 배합이 있는 기록은 'recipe'로 보정 추천에 넘길 수 있다."""
    key = "labSce" if mode == "sce" else "labSci"
    want_sub, want_plate = substrate, plate        # 아래 반복문의 같은 이름 변수와 섞이지 않게
    out = []
    for i, t in enumerate(transfers or []):
        lab = model.meas_lab(t.get("measured"), mode)
        if lab is None:
            continue
        layers = [("1도", t.get("layer1"))] + ([("2도", t["layer2"])] if t.get("layer2") else [])
        sub = t["substrate"] if isinstance(t.get("substrate"), str) else "직접 입력 바탕"
        rec = None
        if not t.get("layer2"):
            rec = {"inks": (t.get("layer1") or {}).get("inks") or {}, "tone": float((t.get("layer1") or {}).get("tone", 100)),
                   **{k: float(t.get(f"{k}_pct") or 0) for k in ("thinner", "hardener", "matting")}}
        out.append({"source": "전사 시료", "id": i + 1, "title": f"{t.get('date') or ''} · 동판 {t.get('plate') or '-'}",
                    "detail": f"{sub} · " + " / ".join(f"{n} 망점 {float(l.get('tone', 100)):g}%" for n, l in layers),
                    "inks": (t.get("layer1") or {}).get("inks") or {}, "lab": [round(x, 2) for x in lab],
                    "hex": cm.lab_to_hex(lab), "dE": round(cm.delta_e2000(lab, target), 2), "link": "/lab/#/library",
                    "substrate": t["substrate"] if isinstance(t.get("substrate"), str) else None, "plate": t.get("plate") or None,
                    "recipe": rec})
    for p in patterns or []:
        for v in p.get("variations") or []:
            for m in v.get("mixes") or []:
                L = _full_lab(m.get(key))
                if L is None:
                    continue
                lot = (v.get("layerPlates") or {}).get(m.get("layer")) or m.get("plate") or "-"
                inks = {k: float(g) for k, g in (m.get("inks") or {}).items() if _isnum(g) and float(g) > 0}
                tot = sum(inks.values())
                coat = next((str(c.get("code")) for c in v.get("coating") or [] if isinstance(c, dict) and c.get("code")), None)
                out.append({"source": "아카이브", "id": p.get("id"), "title": f"{(p.get('pattern') or {}).get('code', '')} · {v.get('colorName') or v.get('colorCode') or v.get('id')}",
                            "detail": f"{m.get('layer') or ''} {m.get('batch') or ''}차 · 동판 {lot}" + (f" · 도장 {coat}" if coat else ""),
                            "inks": m.get("inks") or {}, "lab": [round(x, 2) for x in L], "hex": cm.lab_to_hex(L),
                            "dE": round(cm.delta_e2000(L, target), 2), "link": f"/#/p/{p.get('id')}/{v.get('id')}",
                            "substrate": coat, "plate": lot if lot != "-" else None,
                            "recipe": {"inks": inks, "tone": 100.0, **{k: round(_pct_of(m, k, tot), 1) for k in ("thinner", "hardener", "matting")}}
                            if inks else None})
    if worklog_index is not None:
        for w in worklog_index.logs:
            if w.kind != "v3":
                continue
            for j in w.jobs:
                plate = j.get("plate") if isinstance(j.get("plate"), dict) else {}   # 모양이 틀린 일지는 PCCS3가 오류로 알린다
                for s in j.get("samples") if isinstance(j.get("samples"), list) else []:
                    if not isinstance(s, dict) or not isinstance(s.get("lab"), dict):
                        continue
                    L = _full_lab(s["lab"].get(mode))
                    if L is None:
                        continue
                    lot = plate.get("lot")
                    layers = s.get("layers") if isinstance(s.get("layers"), dict) else {}
                    out.append({"source": "작업일지", "id": w.name, "title": f"{w.date} · 동판 {lot}",
                                "detail": f"{s.get('substrate')} · " + " + ".join(f"{k} {v}" for k, v in layers.items()),
                                "inks": {}, "lab": [round(x, 2) for x in L], "hex": cm.lab_to_hex(L),
                                "dE": round(cm.delta_e2000(L, target), 2), "eval": s.get("eval"),
                                "link": f"/pccs/#/file/{w.name}", "substrate": s.get("substrate") or None,
                                "plate": lot or None, "recipe": None})

    def same(a, b):        # 바탕 이름: 'C 1000@경면'과 'C 1000'은 같은 코드로 본다
        return a is not None and str(a).split("@")[0].strip().lower() == str(b).split("@")[0].strip().lower()
    if want_sub:
        out = [r for r in out if same(r.get("substrate"), want_sub)]
    if want_plate:
        out = [r for r in out if str(r.get("plate") or "") == str(want_plate)]
    out.sort(key=lambda r: r["dE"])
    return out[:limit]


def _isnum(x):
    try:
        return x not in (None, "") and math.isfinite(float(x))
    except (TypeError, ValueError):
        return False


def library_accuracy(doc, lib, mode):
    """이 라이브러리로 전사 시료를 예측했을 때의 오차 (ΔE00) — 3채널 근사에서 추천을 얼마나 믿을지의 근거.
    보정 프로필에 쓴 시료도 들어가 낙관적일 수 있다 (검증용 시료는 따로: validation)."""
    single, mix = [], []
    for t in doc.get("transfers") or []:
        smp = transfer_sample(t, mode)
        if smp is None:
            continue
        try:
            de = cm.delta_e2000(model.sample_color(lib, smp, mode, t.get("plate") or None), smp["measured_lab"])
        except model.ModelError:
            continue
        colored = [n for n in (t.get("layer1") or {}).get("inks") or {} if not (lib.inks.get(lib.registry.resolve(n)) or {}).get("clear")]
        (mix if t.get("layer2") or len(colored) > 1 else single).append(de)
    rnd = lambda v: round(sum(v) / len(v), 2) if v else None   # noqa: E731
    return {"n": len(single) + len(mix), "single": rnd(single), "single_n": len(single), "mix": rnd(mix), "mix_n": len(mix)}


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


def _tone(body):
    v = _num(body.get("tone", 100), "망점 %")
    if not 0 < v <= 100:
        raise model.ModelError("망점 %는 0 초과 100 이하")
    return v / 100.0


def _spec31(x, what, lab=None):
    if x in (None, "", []):
        return None
    if not isinstance(x, (list, tuple)) or len(x) != len(cm.WAVELENGTHS):
        raise model.ModelError(f"{what}: 분광 {len(cm.WAVELENGTHS)}개(400~700 nm, 10 nm)가 필요합니다")
    return model.normalize_spectrum([_num(v, what) for v in x], lab)


def _metamerism(body):
    """기준·비교 분광이 다 있으면 광원마다 LAB와 ΔE00 — D65에선 같아도 다른 조명에서 달라지는지."""
    sa, sb = _spec31(body.get("spec_a"), "기준 분광", body.get("a")), _spec31(body.get("spec_b"), "비교 분광", body.get("b"))
    if not (sa and sb):
        return {}
    rows = []
    for il in cm.ILLUMINANTS:
        la, lb = cm.spectrum_to_lab(sa, None, il), cm.spectrum_to_lab(sb, None, il)
        rows.append({"illum": il, "label": cm.ILLUM_LABEL[il], "a": [round(x, 2) for x in la], "b": [round(x, 2) for x in lb],
                     "dE": round(cm.delta_e2000(la, lb), 2)})
    return {"metamerism": rows, "observer": cm.current_observer()}


# ---------------------------------------------------------------- 실측 검증
def _kind(lib, t):
    if t.get("layer2"):
        return "2도"
    colored = [n for n in (t.get("layer1") or {}).get("inks") or {}
               if not (lib.inks.get(lib.registry.resolve(n)) or {}).get("clear")]
    return "혼합" if len(colored) > 1 else "단독"


def _stats(rows):
    v = sorted(r["dE"] for r in rows)
    if not v:
        return None
    return {"n": len(v), "mean": round(sum(v) / len(v), 2), "median": round(v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2, 2),
            "p90": round(v[min(len(v) - 1, int(round(0.9 * (len(v) - 1))))], 2), "max": round(v[-1], 2),
            "pass": round(sum(1 for r in rows if r["judge"]["ok"]) / len(rows) * 100)}


def validation_report(doc, lib, mode):
    """실측 검증: 지금 라이브러리(적용한 프로필 포함)로 전사 시료를 예측해 잰 값과 비교한다.
    '검증용' 시료는 보정에 쓰이지 않았으므로 정직한 오차, 나머지는 보정에 쓴 시료라 낙관적인 참고값."""
    tol = tolerance(doc)
    rows = []
    for i, t in enumerate(doc.get("transfers") or []):
        smp = transfer_sample(t, mode)
        if smp is None:
            continue
        row = {"no": i + 1, "validation": bool(t.get("validation")), "plate": t.get("plate") or "",
               "substrate": t["substrate"] if isinstance(t.get("substrate"), str) else "(직접 입력)",
               "kind": _kind(lib, t), "inks": (t.get("layer1") or {}).get("inks") or {},
               "tone": float((t.get("layer1") or {}).get("tone", 100)), "measured": [round(x, 2) for x in smp["measured_lab"]]}
        try:
            r = model.predict(lib, smp["substrate"], smp["layer1"], smp.get("layer2"), mode=mode, plate=t.get("plate") or None,
                              coverage=smp["coverage"])
            lab = r["average"]["lab"]
            row.update(pred=[round(x, 2) for x in lab], space=r["space"], dE=round(cm.delta_e2000(lab, smp["measured_lab"]), 2),
                       judge=judge(tol, smp["measured_lab"], lab), diff=cm.describe(cm.lab_parts(smp["measured_lab"], lab)))
        except model.ModelError as e:
            row["error"] = str(e)
        rows.append(row)
    ok = [r for r in rows if "dE" in r]

    def groups(sel, key):
        out = {}
        for r in sel:
            out.setdefault(r[key], []).append(r)
        return {k: _stats(v) for k, v in sorted(out.items())}

    val = [r for r in ok if r["validation"]]
    advice = []
    base = val or ok
    by = groups(base, "kind")
    if not val:
        advice.append("검증용 시료가 없습니다 — 아래 '검증 세트'로 보정에 안 쓴 시료를 찍어 재야 정직한 오차를 알 수 있어요")
    for kind, st in by.items():
        if st and st["mean"] > 2.0:
            advice.append(f"{kind} 예측 평균 ΔE {st['mean']:.1f} — 이 경우 예측·추천은 출발점으로만 쓰고 보정 추천으로 맞추세요")
        elif st and st["mean"] <= 1.0:
            advice.append(f"{kind} 예측 평균 ΔE {st['mean']:.1f} — 이 범위에서는 예측을 믿고 시험 횟수를 줄일 수 있어요")
    if any(r.get("space") != "spec" for r in base):
        advice.append("3채널(LAB만) 계산이 섞여 있어요 — 잉크·바탕 분광을 넣으면 혼합 예측이 크게 좋아질 수 있습니다")
    return {"mode": mode, "tolerance": tol, "rows": rows, "errors": [r for r in rows if "error" in r],
            "validation": {"all": _stats(val), "kind": groups(val, "kind"), "plate": groups(val, "plate"), "substrate": groups(val, "substrate")},
            "fitted": {"all": _stats([r for r in ok if not r["validation"]]), "kind": groups([r for r in ok if not r["validation"]], "kind")},
            "advice": advice}


def validation_plan(lib, mode, substrate, plate, inks=None, ink_total=20.0, tone=100):
    """검증 세트: 이 바탕·동판으로 찍어 잴 배합 15~20개 — 단독 · 투명 희석 · 2색 · 흰색 섞기 · 3색.
    잰 값을 '검증용' 전사 시료로 넣으면 실측 검증 보고서가 진짜 오차를 알려 준다."""
    names = [n for n in (inks or lib.inks) if n in lib.inks and n != model.MATTING]
    clear = [n for n in names if lib.inks[n].get("clear")]
    space = lib.basis
    colored = [n for n in names if not lib.inks[n].get("clear") and (lib.ink_ready(n, mode, space) or lib.ink_ready(n, mode, "spec"))]
    if not colored:
        raise model.ModelError("계산할 수 있는 유색 잉크가 없습니다 (측정 보정 또는 보정 프로필 필요)")
    white = [n for n in colored if n.upper().startswith("WH") or "흰" in n]
    black = [n for n in colored if n.upper().startswith("BK") or "검" in n]
    chroma = [n for n in colored if n not in white + black]
    plan = []

    def add(why, parts):
        tot = sum(parts.values())
        g = {k: round(ink_total * v / tot, 1) for k, v in parts.items()}
        if g not in [p["inks"] for p in plan]:
            plan.append({"why": why, "inks": g})

    # 종류가 고루 들어가게: 단독 → 흰색 섞기 → 3색·검정 조금 → 2색 1:1 → 투명 희석 → 2색 3:1 (최대 20개)
    for n in colored:
        add("단독", {n: 1})
    for w in white[:1]:
        for n in chroma[:3] + black[:1]:
            add("흰색 섞기 3:1", {w: 3, n: 1})
    if len(chroma) >= 3:
        add("3색", {chroma[0]: 2, chroma[1]: 1, chroma[2]: 1})
    if black and chroma:
        add("검정 조금", {chroma[0]: 9, black[0]: 1})
    pairs = [(a, b) for i, a in enumerate(chroma) for b in chroma[i + 1:]][:6]
    for a, b in pairs:
        add("2색 1:1", {a: 1, b: 1})
    if clear:
        for n in chroma[:3]:
            add("투명 희석 1:1", {n: 1, clear[0]: 1})
    for a, b in pairs:
        add("2색 3:1", {a: 3, b: 1})
    plan = plan[:20]
    rows = []
    for p in plan:
        rec = {"inks": p["inks"], "hardener": {"g": ink_total * 0.2}, "thinner": {"g": ink_total * 0.3}}
        try:
            r = model.predict(lib, substrate, rec, mode=mode, plate=plate or None, coverage={"1도": tone / 100})
            p["pred"] = [round(x, 2) for x in r["average"]["lab"]]
            p["hex"] = r["average"]["hex"]
        except model.ModelError as e:
            p["error"] = str(e)
        rows.append(p)
    return {"substrate": substrate, "plate": plate, "tone": tone, "ink_total": ink_total, "rows": rows}


def apply_profile(data_root, backup_dir, body, base_rev):
    """보정 프로필 적용: 지금 저장된 라이브러리로 다시 계산해서, 미리보기 때와 입력이 같을 때만 저장한다."""
    with _guard:
        doc = load_library(data_root)
    if (doc.get("updatedAt") or "") != (base_rev or ""):
        return 409, {"ok": False, "conflict": True, "message": "라이브러리가 그사이 바뀌었습니다 — 다시 계산해 주세요"}
    run = fitmod.run_profile(doc, mode=body.get("mode") or "sci", plate=body.get("plate"), space=body.get("space"))
    if fitmod.fingerprint(run["snapshot"]) != body.get("snapshot"):
        return 409, {"ok": False, "conflict": True, "message": "미리보기 이후 입력이 바뀌었습니다 — 다시 계산해 주세요"}
    level = run["confidence"]["level"]
    if not run["ok"] or level == "부족":
        raise model.ModelError("적용할 수 없는 결과입니다: " + " / ".join(run["confidence"]["reasons"]))
    if level == "낮음" and not body.get("ack_low"):
        raise model.ModelError("신뢰도가 낮은 결과입니다 — 확인 표시 후 적용해 주세요")
    fits = _check_fits(doc.get("fits"))
    key = model.run_key(run)
    runs = [r for r in fits["runs"] if model.run_key(r) != key]
    old = [r for r in fits["runs"] if model.run_key(r) == key]
    prev = dict(fits["previous"])
    if old:
        prev[key] = old[0]
    doc["fits"] = {"runs": runs + [run], "previous": prev}
    code, r = save_library(data_root, backup_dir, doc, doc.get("updatedAt"))
    return code, {**r, "id": run.get("id")}


def switch_profile(data_root, backup_dir, action, base_rev, key=None):
    """그 동판·모드 프로필(key = '동판|모드|공간')만: revert 바로 전 프로필로 · off 끄기 (끈 것은 '바로 전'으로 남는다).
    key를 안 주면 가장 최근에 적용한 프로필."""
    with _guard:
        doc = load_library(data_root)
    fits = _check_fits(doc.get("fits"))
    runs, prev = list(fits["runs"]), dict(fits["previous"])
    if not key:
        key = model.run_key(sorted(runs, key=lambda r: str(r.get("created") or ""))[-1]) if runs else (next(iter(prev), None))
    cur = [r for r in runs if model.run_key(r) == key]
    rest = [r for r in runs if model.run_key(r) != key]
    if action == "revert":
        if key not in prev:
            raise model.ModelError("되돌릴 이전 프로필이 없습니다")
        back = prev.pop(key)
        if cur:
            prev[key] = cur[0]
        doc["fits"] = {"runs": rest + [back], "previous": prev}
    else:
        if not cur:
            raise model.ModelError("켜져 있는 프로필이 없습니다")
        prev[key] = cur[0]
        doc["fits"] = {"runs": rest, "previous": prev}
    return save_library(data_root, backup_dir, doc, base_rev)


def handle(method, path, query, body, ctx):
    """ctx: {'data': dataRoot, 'backup': 백업 폴더, 'patterns': fn, 'worklog': fn|None, 'rev': X-Base-Rev}
    반환: (HTTP 상태, JSON)."""
    try:
        obs = (load_library(ctx["data"]).get("settings") or {}).get("observer") or "2"
    except (OSError, ValueError, AttributeError):
        obs = "2"
    with cm.use_observer(obs):
        return _handle(method, path, query, body, ctx)


def _handle(method, path, query, body, ctx):
    try:
        if method == "GET" and path == "/api/lab/inks":
            return 200, {"ok": True, **ink_catalog(load_library(ctx["data"]))}
        if method == "GET" and path == "/api/lab/library":
            doc = load_library(ctx["data"])
            return 200, {"ok": True, "library": doc, "info": describe_library(doc, _cached_library(ctx["data"]))}
        if method == "PUT" and path == "/api/lab/library":
            return save_library(ctx["data"], ctx["backup"], body, ctx.get("rev"))
        if method == "GET" and path == "/api/lab/similar":
            mode = (query.get("mode") or ["sci"])[0]
            target = [_num((query.get(k) or [None])[0], f"목표 {k}") for k in ("L", "a", "b")]
            idx = ctx["worklog"]() if ctx.get("worklog") else None
            transfers = load_library(ctx["data"]).get("transfers") or []
            sub = (query.get("substrate") or [""])[0] or None
            lot = (query.get("plate") or [""])[0] or None
            return 200, {"ok": True, "items": similar(target, mode, ctx["patterns"](), idx, transfers=transfers,
                                                      substrate=sub, plate=lot)}
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
                         "dEcmc": round(cm.delta_e_cmc(a, b), 3), "judge": judge(tolerance(lib), a, b),
                         "parts": {k: round(v, 3) for k, v in parts.items()}, "text": cm.describe(parts),
                         "hex": [cm.lab_to_hex(a), cm.lab_to_hex(b)], **_metamerism(body)}
        if path == "/api/lab/recipe-preview":
            # 모델과 진단은 같은 라이브러리 판본으로 계산한다.
            doc = load_library(ctx["data"])
            return 200, {"ok": True, **recipe_preview(model.Library(doc), doc, body, mode)}
        if path == "/api/lab/predict":
            r = model.predict(lib, _substrate(body), body.get("layer1"), body.get("layer2") or None, mode=mode,
                              plate=body.get("plate"), coverage=body.get("coverage") or None,
                              target_spec=_spec31(body.get("target_spec"), "목표 분광", body.get("target")))
            if r["space"] != "spec":
                r["accuracy"] = library_accuracy(load_library(ctx["data"]), lib, mode)
            if body.get("target"):
                t = _lab3(body["target"], "목표")
                r["target"] = {"lab": t, "hex": cm.lab_to_hex(t)}
                tol = tolerance(lib)
                for v in list(r["regions"].values()) + ([r["average"]] if "average" in r else []):
                    v["dE"] = round(cm.delta_e2000(v["lab"], t), 2)
                    v["diff"] = cm.describe(cm.lab_parts(t, v["lab"]))
                    v["judge"] = judge(tol, t, v["lab"])
            return 200, {"ok": True, **r}
        if path == "/api/lab/recommend":
            r = model.recommend(lib, _lab3(body.get("target"), "목표"), _substrate(body), body.get("inks") or [],
                                mode=mode, max_inks=int(body.get("max_inks") or 3),
                                ink_total=_num(body.get("ink_total") or 60, "잉크 합계"), under=body.get("under") or None,
                                plate=body.get("plate"), hardener_pct=_num(body.get("hardener_pct", 20), "경화제%"),
                                thinner_pct=_num(body.get("thinner_pct", 30), "신나%"),
                                matting_pct=_num(body.get("matting_pct", 0), "소광제%"), tone=_tone(body),
                                formula=tolerance(lib)["formula"])
            tol, tgt = tolerance(lib), _lab3(body.get("target"), "목표")
            for c in r["candidates"]:
                c.pop("score", None)
                c["judge"] = judge(tol, tgt, c["lab"])
            if r["space"] != "spec":      # 3채널 근사: 추천은 출발점 — 실제로 얼마나 틀렸는지 근거와 함께
                r["accuracy"] = library_accuracy(load_library(ctx["data"]), lib, mode)
            return 200, {"ok": True, **r, "tolerance": tol}
        if path == "/api/lab/correct":
            r = model.correct(lib, body.get("current"), _lab3(body.get("measured"), "측정"), _lab3(body.get("target"), "목표"),
                              _substrate(body), mode=mode, adjustable=body.get("adjustable") or None,
                              under=body.get("under") or None, plate=body.get("plate"),
                              change_weight=_num(body.get("change_weight", 0.5), "변경 벌점"), tone=_tone(body),
                              formula=tolerance(lib)["formula"],
                              previous=[{"recipe": p.get("recipe"), "measured": _lab3(p.get("measured"), "이전 시도 측정")}
                                        for p in (body.get("previous") or []) if isinstance(p, dict)] or None,
                              add_only=bool(body.get("add_only")),
                              remaining=_num(body["remaining"], "남은 잉크 g") if body.get("remaining") not in (None, "") else None)
            tol, tgt = tolerance(lib), _lab3(body.get("target"), "목표")
            r["now"]["judge"] = judge(tol, tgt, _lab3(body.get("measured"), "측정"))
            r["expected"]["judge"] = judge(tol, tgt, r["expected"]["lab"])
            return 200, {"ok": True, **r, "tolerance": tol}
        if path == "/api/lab/validation":
            doc = load_library(ctx["data"])
            return 200, {"ok": True, **validation_report(doc, lib, mode)}
        if path == "/api/lab/validation/plan":
            sub = _substrate(body)
            if not sub:
                raise model.ModelError("바탕을 고르세요")
            return 200, {"ok": True, **validation_plan(lib, mode, sub, body.get("plate") or None, body.get("inks") or None,
                                                       _num(body.get("ink_total") or 20, "잉크 합계"), _tone(body) * 100)}
        if path == "/api/lab/profile/preview":
            run = fitmod.run_profile(load_library(ctx["data"]), mode=mode, plate=body.get("plate"), space=body.get("space"))
            return 200, {"ok": True, "run": run, "snapshot": fitmod.fingerprint(run["snapshot"])}
        if path == "/api/lab/profile/apply":
            return apply_profile(ctx["data"], ctx["backup"], body, ctx.get("rev"))
        if path in ("/api/lab/profile/revert", "/api/lab/profile/off"):
            return switch_profile(ctx["data"], ctx["backup"], path.rsplit("/", 1)[1], ctx.get("rev"), body.get("key"))
        return 404, {"ok": False, "error": "not found"}
    except model.ModelError as e:
        return 400, {"ok": False, "error": str(e)}
    except (TypeError, AttributeError, KeyError, ValueError) as e:
        # 모양이 틀린 입력(글자 자리에 목록, 숫자 자리에 글자 등)은 서버 오류(500)가 아니라 입력 오류로
        return 400, {"ok": False, "error": f"입력 형식 오류 — {type(e).__name__}: {e}"}


def static_file(rel):
    rel = rel or "index.html"
    if rel not in STATIC:
        return None
    with open(os.path.join(WEB, rel), "rb") as f:
        return f.read(), STATIC[rel]
