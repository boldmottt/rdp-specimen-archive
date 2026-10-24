"""측색 라이브러리 + 배합 → 막 → 색 예측 · 배합 추천 · 보정 추천 · 동판 막두께 맞추기.

측정값 하나(measurement)의 형식 — 측색기가 주는 대로:
    {"sci": [L, a, b], "sce": [L, a, b], "sci_spec": [31개], "sce_spec": [31개]}
LAB만 있어도 되고, 분광(400~700 nm, 10 nm, 반사율 0~1 또는 %)이 있으면 더 정확하다.

배합(recipe) 형식 — 작업일지 v3와 같은 뜻:
    {"inks": {"MT": 35, "BK": 10}, "matting": {"g": 0.7}, "thinner": {"g": 21}, "hardener": {"g": 14}}
  - 신나는 증발한다 → 막 성분에서 빠지고, 고형분 비율(=막 두께)만 바꾼다
  - 경화제는 투명 수지로 막에 남는다 (색을 묽게 한다)
  - 소광제는 라이브러리에 '소광제' 잉크가 있으면 그 값, 없으면 투명으로 본다
"""
import itertools
import math

from . import colormath as cm
from . import km

MODES = ("sci", "sce")
MATTING = "소광제"
CARDS = {"흰 카드": "white", "검정 카드": "black"}   # 바탕으로 고를 수 있는 기본 카드값
DEFAULT_CAL = {"hardener_pct": 20.0, "thinner_pct": 30.0}


class ModelError(ValueError):
    pass


# ---------------------------------------------------------------- 측정값 ↔ 채널
def _spec(m, mode):
    s = (m or {}).get(f"{mode}_spec")
    if not s:
        return None
    s = [float(x) for x in s]
    if len(s) != len(cm.WAVELENGTHS):
        raise ModelError(f"분광값은 {len(cm.WAVELENGTHS)}개(400~700 nm, 10 nm)여야 합니다")
    if max(s) > 1.5:            # % 단위로 들어온 값
        s = [x / 100.0 for x in s]
    return s


def meas_lab(m, mode):
    """측정값의 LAB (측색기 LAB 우선, 없으면 분광으로 계산)."""
    lab = (m or {}).get(mode)
    if lab:
        return tuple(float(x) for x in lab)
    s = _spec(m, mode)
    if s:
        return cm.spectrum_to_lab(s)
    return None


def channels(m, mode, space):
    """측정값 → 채널별 '측정 반사율'. space: 'spec'(31) 또는 'rgb'(3)."""
    if space == "spec":
        s = _spec(m, mode)
        if s is None:
            raise ModelError("분광 데이터가 없습니다")
        return [km.clamp(x) for x in s]
    lab = meas_lab(m, mode)
    if lab is None:
        raise ModelError(f"{mode.upper()} 측정값이 없습니다")
    return [km.clamp(x) for x in cm.lab_to_rgb_lin(lab)]


def channels_to_lab(rs, space):
    if space == "spec":
        return cm.spectrum_to_lab(rs)
    return cm.rgb_lin_to_lab(rs)


def has(m, mode, space):
    if space == "spec":
        return _spec(m, mode) is not None
    return meas_lab(m, mode) is not None


# ---------------------------------------------------------------- 라이브러리
class Library:
    """{'inks': [...], 'substrates': [...], 'plates': [...], 'settings': {...}}"""

    def __init__(self, data=None):
        data = data or {}
        self.inks = {str(i["name"]): i for i in data.get("inks") or [] if i.get("name")}
        self.substrates = list(data.get("substrates") or [])
        self.plates = {str(p["lot"]): p for p in data.get("plates") or [] if p.get("lot")}
        self.settings = dict(data.get("settings") or {})
        self._cal = {}

    # --- 잉크 역산
    def ink_params(self, name, mode, space):
        """잉크 1 단위(=막 고형분 100%가 이 잉크, 기준 두께)의 채널별 (k, s)."""
        key = (name, mode, space)
        if key in self._cal:
            return self._cal[key]
        ink = self.inks.get(name)
        if ink is None:
            raise ModelError(f"라이브러리에 없는 잉크: {name}")
        n = len(cm.WAVELENGTHS) if space == "spec" else 3
        if ink.get("clear"):
            out = {"k": [0.0] * n, "s": [0.0] * n, "residual": 0.0}
            self._cal[key] = out
            return out
        cal = ink.get("cal") or {}
        prints = [(b, q) for b, q in (("white_bg", "on_white"), ("black_bg", "on_black"))
                  if has(cal.get(b), mode, space) and has(cal.get(q), mode, space)]
        solid = has(cal.get("solid"), mode, space)
        if not prints:
            raise ModelError(f"잉크 {name}: {mode.upper()} 얇게 찍은 측정(바탕 + 그 위 잉크)이 없습니다"
                             + (" — 솔리드만으로는 막 두께를 알 수 없어요" if solid else ""))
        if len(prints) == 1 and not solid:
            raise ModelError(f"잉크 {name}: {mode.upper()} 측정이 하나 더 필요합니다 (솔리드 또는 다른 바탕 위 전사)")

        def internal(key):
            return [km.to_internal(r, mode) for r in channels(cal[key], mode, space)]

        pairs = [(internal(b), internal(q)) for b, q in prints]
        rinf = internal("solid") if solid else None
        h = float(cal.get("hardener_pct", DEFAULT_CAL["hardener_pct"])) / 100.0
        t = float(cal.get("thinner_pct", DEFAULT_CAL["thinner_pct"])) / 100.0
        f_ink = 1.0 / (1.0 + h)                      # 보정 막에서 잉크가 차지한 비율
        thick = film_thickness(1.0 + h, t)           # 보정 막의 상대 두께 (보정에 쓴 동판 = 기준 1.0)
        ks, ss, res = [], [], 0.0
        for i in range(n):
            kx, sx, r = km.fit_channel([(g[i], q[i]) for g, q in pairs], rinf[i] if rinf else None)
            ks.append(kx / (f_ink * thick))
            ss.append(sx / (f_ink * thick))
            res = max(res, r)
        out = {"k": ks, "s": ss, "residual": res, "used": [q for _, q in prints] + (["solid"] if solid else [])}
        self._cal[key] = out
        return out

    def find_substrate(self, ref):
        """'코드' / '코드@도장처' / '코드@표면' (작업일지 v3와 같은 규칙). '흰 카드'·'검정 카드'는 기본 카드값."""
        card = CARDS.get(str(ref))
        if card:
            m = (self.settings.get("cards") or {}).get(card)
            if not m:
                raise ModelError(f"{ref} 값이 없습니다 (라이브러리 › 잉크 › 기본 카드값)")
            return m
        code, *quals = str(ref).split("@")
        c = [s for s in self.substrates if str(s.get("code")) == code]
        for q in quals:
            c = [s for s in c if q in (s.get("maker"), s.get("surface"))]
        if not c:
            raise ModelError(f"라이브러리에 없는 도장 시편: {ref}")
        if len(c) > 1:
            c.sort(key=lambda s: str(s.get("measured_on") or ""), reverse=True)   # 가장 최근 측정
        return c[0]

    # --- 동판
    def plate_info(self, lot):
        """동판의 막두께 계수 · 망점 퍼짐. 값이 없으면 다른 동판에서 추정한다:
        막두께는 부식 깊이에 비례한다고 보고, 망점 퍼짐은 같은 LPI 동판의 평균을 쓴다."""
        out = {"lot": lot, "thickness": 1.0, "thickness_src": "기본값", "gamma": 1.0, "dot50": 0.5, "gain_src": "퍼짐 없음"}
        p = self.plates.get(str(lot)) if lot else None
        if not p:
            return out
        others = [q for q in self.plates.values() if q is not p]
        if _given(p.get("thickness")):
            out.update(thickness=float(p["thickness"]), thickness_src="입력값")
        elif _given(p.get("depth_um")):
            ref = [float(q["thickness"]) / float(q["depth_um"]) for q in others
                   if _given(q.get("thickness")) and _given(q.get("depth_um")) and float(q["depth_um"]) > 0]
            if ref:
                out.update(thickness=sum(ref) / len(ref) * float(p["depth_um"]),
                           thickness_src=f"부식 깊이로 추정 · 동판 {len(ref)}개 기준")
        if _given(p.get("dot50")):
            out.update(gamma=km.dot_gamma(float(p["dot50"])), gain_src="입력값")
        elif _given(p.get("lpi")):
            ref = [km.dot_gamma(float(q["dot50"])) for q in others
                   if _given(q.get("dot50")) and _given(q.get("lpi")) and float(q["lpi"]) == float(p["lpi"])]
            if ref:
                out.update(gamma=sum(ref) / len(ref), gain_src=f"같은 LPI {float(p['lpi']):g} 동판 {len(ref)}개 평균")
        out["dot50"] = km.effective_tone(0.5, out["gamma"])
        return out

    def plate_factor(self, lot):
        return self.plate_info(lot)["thickness"]


def _given(v):
    return v not in (None, "")


def film_thickness(solids, thinner):
    """신나가 증발한 뒤 남는 고형분 비율 → 상대 막 두께 (같은 양을 옮긴다고 볼 때)."""
    return solids / (solids + thinner) if solids + thinner > 0 else 0.0


def normalize_recipe(r):
    """작업일지 형식·간단 형식 모두 받아 {'inks':{}, 'matting':g, 'thinner':g, 'hardener':g}로."""
    r = r or {}
    def g(x):
        if isinstance(x, dict):
            x = x.get("g")
        try:
            return max(0.0, float(x or 0))
        except (TypeError, ValueError):
            raise ModelError(f"숫자가 아닌 값: {x}")
    inks = {str(k): g(v) for k, v in (r.get("inks") or {}).items() if g(v) > 0}
    if not inks:
        raise ModelError("잉크가 없는 배합입니다")
    return {"inks": inks, "matting": g(r.get("matting")), "thinner": g(r.get("thinner")),
            "hardener": g(r.get("hardener"))}


def recipe_film(lib, recipe, mode, space, plate=1.0):
    """배합 → 채널별 막 (KX, SX)."""
    r = normalize_recipe(recipe)
    ink_g = sum(r["inks"].values())
    matting_ink = MATTING in lib.inks
    solids = ink_g + r["hardener"] + r["matting"]
    rel = film_thickness(solids / ink_g, r["thinner"] / ink_g) * plate
    n = len(cm.WAVELENGTHS) if space == "spec" else 3
    kx, sx = [0.0] * n, [0.0] * n
    comps = list(r["inks"].items()) + ([(MATTING, r["matting"])] if matting_ink and r["matting"] else [])
    for name, grams in comps:
        p = lib.ink_params(name, mode, space)
        w = grams / solids
        for i in range(n):
            kx[i] += w * p["k"][i] * rel
            sx[i] += w * p["s"][i] * rel
    return kx, sx


def pick_space(lib, mode, inks, substrate_meas):
    """쓰는 잉크와 바탕이 모두 분광을 가지면 분광, 아니면 3채널."""
    ok = has(substrate_meas, mode, "spec")
    for name in inks:
        ink = lib.inks.get(name) or {}
        if ink.get("clear"):
            continue
        cal = ink.get("cal") or {}
        ok = ok and all(has(cal.get(x), mode, "spec") for x in ("white_bg", "black_bg", "on_white", "on_black"))
    return "spec" if ok else "rgb"


# ---------------------------------------------------------------- 예측
def _plate(lib, plate, gamma=None):
    """동판 lot 문자열 또는 막두께 숫자 → (막두께 계수, 망점 퍼짐 γ, 동판 정보|None)."""
    if isinstance(plate, (int, float)):
        return float(plate), float(gamma if gamma is not None else 1.0), None
    info = lib.plate_info(plate)
    return info["thickness"], float(gamma if gamma is not None else info["gamma"]), info


def _mix(parts, yn):
    """[(비율, 측정 반사율 채널들), …] → 측색기 구멍 안의 평균 (Yule–Nielsen)."""
    n = len(parts[0][1])
    return [sum(w * r[i] ** (1 / yn) for w, r in parts) ** yn for i in range(n)]


def predict(lib, substrate, layer1, layer2=None, mode="sci", plate=None, coverage=None, yn=None, gamma=None):
    """도장 시편 위 1도(·2도) 인쇄의 색.
    substrate: 라이브러리 코드 문자열 또는 측정값 dict (LAB 직접 입력).
    coverage: 설계 망점 비율 {"1도": 0.6, "2도": 0.4} — 동판의 망점 퍼짐을 적용해 측색기에 잡히는 평균색도 계산.
              없으면 동판에 적어 둔 값을 쓴다.
    반환: 영역별 LAB · 견본색 · 사용한 채널 방식."""
    if mode not in MODES:
        raise ModelError("mode는 sci 또는 sce")
    sub_meas = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    if not has(sub_meas, mode, "rgb") and not has(sub_meas, mode, "spec"):
        raise ModelError(f"바탕의 {mode.upper()} 값이 없습니다")
    inks = set(normalize_recipe(layer1)["inks"]) | (set(normalize_recipe(layer2)["inks"]) if layer2 else set())
    space = pick_space(lib, mode, inks, sub_meas)
    t, gam, info = _plate(lib, plate, gamma)
    if coverage is None and isinstance(plate, str):      # 동판에 적어 둔 설계 망점
        coverage = (lib.plates.get(plate) or {}).get("coverage") or None
    yn = float(yn if yn is not None else lib.settings.get("yn", 1.0))

    rs_m = channels(sub_meas, mode, space)
    rs = [km.to_internal(r, mode) for r in rs_m]
    k1, s1 = recipe_film(lib, layer1, mode, space, t)
    ra = [km.layer(rs[i], k1[i], s1[i]) for i in range(len(rs))]
    regions = {"substrate": rs, "layer1": ra}
    if layer2:
        k2, s2 = recipe_film(lib, layer2, mode, space, t)
        regions["layer2"] = [km.layer(rs[i], k2[i], s2[i]) for i in range(len(rs))]
        regions["overlap"] = [km.layer(ra[i], k2[i], s2[i]) for i in range(len(rs))]
    meas = {k: [km.to_measured(x, mode) for x in v] for k, v in regions.items()}
    out = {"mode": mode, "space": space, "plate": t, "regions": {}}
    if info:
        out["plate_info"] = {k: info[k] for k in ("thickness_src", "dot50", "gain_src")}
    for k, v in meas.items():
        lab = channels_to_lab(v, space)
        out["regions"][k] = {"lab": [round(x, 2) for x in lab], "hex": cm.lab_to_hex(lab)}
    if coverage:
        d1 = float(coverage.get("1도") or 0)
        d2 = float(coverage.get("2도") or 0) if layer2 else 0.0
        c1, c2 = km.effective_tone(d1, gam), km.effective_tone(d2, gam)
        w = {"substrate": (1 - c1) * (1 - c2), "layer1": c1 * (1 - c2)}
        if layer2:
            w.update({"layer2": (1 - c1) * c2, "overlap": c1 * c2})
        avg = _mix([(w[k], meas[k]) for k in w], yn)
        lab = channels_to_lab(avg, space)
        out["average"] = {"lab": [round(x, 2) for x in lab], "hex": cm.lab_to_hex(lab), "weights": w,
                          "tone": {"1도": [d1, round(c1, 4)], **({"2도": [d2, round(c2, 4)]} if layer2 else {})}}
    if space == "rgb":
        out["note"] = "LAB 3채널 근사 — 분광 데이터를 넣으면 더 정확해집니다"
        labs = [meas_lab(sub_meas, mode)] + [tuple(x["lab"]) for x in out["regions"].values()]
        if not all(cm.in_gamut(l) for l in labs if l):
            out["note"] += " · sRGB 밖의 진한 색이 있어 오차가 커질 수 있습니다"
    return out


# ---------------------------------------------------------------- 추천 · 보정
def _layer_lab(lib, bg_internal, recipe, mode, space, t, cov=1.0, yn=1.0):
    """바탕 위에 배합을 찍은 색. cov < 1이면 실효 망점 비율만큼 바탕과 섞인 평균색."""
    k, s = recipe_film(lib, recipe, mode, space, t)
    r = [km.to_measured(km.layer(bg_internal[i], k[i], s[i]), mode) for i in range(len(bg_internal))]
    if cov < 1.0:
        r = _mix([(1 - cov, [km.to_measured(x, mode) for x in bg_internal]), (cov, r)], yn)
    return channels_to_lab(r, space)


def _background(lib, substrate, under, mode, space, t):
    sub = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    bg = [km.to_internal(r, mode) for r in channels(sub, mode, space)]
    if under:          # 2도를 고를 때: 1도(솔리드) 위
        k, s = recipe_film(lib, under, mode, space, t)
        bg = [km.layer(bg[i], k[i], s[i]) for i in range(len(bg))]
    return bg


def _with_extras(inks_g, base):
    """잉크 g → 신나·경화제(잉크합 대비 %)를 붙인 배합."""
    tot = sum(inks_g.values())
    return {"inks": inks_g, "hardener": {"g": tot * base["hardener_pct"] / 100.0},
            "thinner": {"g": tot * base["thinner_pct"] / 100.0}, "matting": {"g": tot * base["matting_pct"] / 100.0}}


def _tone_note(tone, cov):
    return None if tone >= 1.0 else f"망점 {tone * 100:g}% → 실효 {cov * 100:.0f}%"


def recommend(lib, target, substrate, inks, mode="sci", max_inks=3, ink_total=60.0, under=None,
              plate=None, hardener_pct=20.0, thinner_pct=30.0, matting_pct=0.0, top=5, tone=1.0):
    """목표색(LAB)에 가장 가까운 배합 후보. inks: 써도 되는 잉크 이름들.
    tone: 목표를 잰 자리의 설계 망점 비율 (1 = 솔리드)."""
    if not inks:
        raise ModelError("쓸 수 있는 잉크를 하나 이상 고르세요")
    target = tuple(float(x) for x in target)
    sub = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    space = pick_space(lib, mode, set(inks) | (set(normalize_recipe(under)["inks"]) if under else set()), sub)
    t, gam, _ = _plate(lib, plate)
    cov = km.effective_tone(tone, gam)
    yn = float(lib.settings.get("yn", 1.0))
    bg = _background(lib, sub, under, mode, space, t)
    base = {"hardener_pct": hardener_pct, "thinner_pct": thinner_pct, "matting_pct": matting_pct}
    for n in inks:
        lib.ink_params(n, mode, space)          # 없는 잉크·측정값을 미리 알린다

    def color(rec):
        return _layer_lab(lib, bg, rec, mode, space, t, cov, yn)

    results = []
    max_inks = max(1, min(int(max_inks), 4, len(inks)))
    for size in range(1, max_inks + 1):
        for combo in itertools.combinations(sorted(inks), size):
            def grams(p):
                e = [math.exp(min(30, max(-30, x))) for x in p]
                tot = sum(e)
                return {n: ink_total * x / tot for n, x in zip(combo, e)}

            def f(p):
                return cm.delta_e2000(color(_with_extras(grams(p), base)), target)

            p, _ = km.nelder_mead(f, [0.0] * size, step=1.0, iters=250, tol=1e-9) if size > 1 else ([0.0], None)
            g = {k: round(v, 1) for k, v in grams(p).items() if round(v, 1) > 0}
            rec = _with_extras(g, base)
            lab = color(rec)
            results.append({"inks": g, "dE": round(cm.delta_e2000(lab, target), 2),
                            "lab": [round(x, 2) for x in lab], "hex": cm.lab_to_hex(lab),
                            "diff": cm.describe(cm.lab_parts(target, lab)),
                            "extras": {k: round(rec[k]["g"], 1) for k in ("hardener", "thinner", "matting") if rec[k]["g"]}})
    results.sort(key=lambda r: (r["dE"], len(r["inks"])))
    out, seen = [], []
    for r in results:          # 같은 잉크 구성은 하나만
        sig = tuple(sorted(r["inks"]))
        if any(sig == s for s in seen):
            continue
        seen.append(sig)
        out.append(r)
        if len(out) >= top:
            break
    res = {"mode": mode, "space": space, "plate": t, "target_hex": cm.lab_to_hex(target), "candidates": out}
    if _tone_note(tone, cov):
        res["note"] = _tone_note(tone, cov)
    return res


def correct(lib, current, measured, target, substrate, mode="sci", adjustable=None, under=None,
            plate=None, change_weight=0.5, tone=1.0):
    """보정 추천: 지금 배합(current)을 찍어 잰 색(measured)을 목표(target)에 맞추려면 잉크를 얼마나 바꿀까.
    모델이 지금 배합에서 틀린 만큼(measured - 예측)을 그대로 옮겨 쓴다 (편차 보정).
    change_weight: 바꾸는 양에 주는 벌점 (ΔE 1당 잉크합의 몇 %를 바꿀 가치가 있나).
    tone: 잰 자리의 설계 망점 비율 (1 = 솔리드)."""
    cur = normalize_recipe(current)
    measured = tuple(float(x) for x in measured)
    target = tuple(float(x) for x in target)
    sub = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    names = list(dict.fromkeys(list(cur["inks"]) + list(adjustable or [])))
    space = pick_space(lib, mode, set(names) | (set(normalize_recipe(under)["inks"]) if under else set()), sub)
    t, gam, _ = _plate(lib, plate)
    cov = km.effective_tone(tone, gam)
    yn = float(lib.settings.get("yn", 1.0))
    bg = _background(lib, sub, under, mode, space, t)
    ink_g = sum(cur["inks"].values())
    ratio = {k: cur[k] / ink_g for k in ("hardener", "thinner", "matting")}

    def color(rec):
        return _layer_lab(lib, bg, rec, mode, space, t, cov, yn)

    def build(g):
        tot = sum(g.values())
        return {"inks": g, **{k: {"g": tot * ratio[k]} for k in ratio}}

    pred0 = color(current)
    bias = tuple(m - p for m, p in zip(measured, pred0))

    def grams(p):
        return {n: max(0.0, cur["inks"].get(n, 0.0) + x) for n, x in zip(names, p)}

    def f(p):
        g = grams(p)
        if sum(g.values()) <= 0:
            return 1e9
        lab = tuple(x + b for x, b in zip(color(build(g)), bias))
        change = sum(abs(g[n] - cur["inks"].get(n, 0.0)) for n in names) / ink_g * 100
        return cm.delta_e2000(lab, target) + change_weight * change / 10.0

    p, _ = km.nelder_mead(f, [0.0] * len(names), step=max(0.5, ink_g * 0.05), iters=600, tol=1e-10)
    g = {n: round(v, 1) for n, v in grams(p).items() if round(v, 1) > 0}
    lab = tuple(x + b for x, b in zip(color(build(g)), bias))
    deltas = {n: round(g.get(n, 0.0) - cur["inks"].get(n, 0.0), 1) for n in names}
    res = {
        "mode": mode, "space": space, "plate": t,
        "now": {"dE": round(cm.delta_e2000(measured, target), 2), "diff": cm.describe(cm.lab_parts(target, measured)),
                "hex": cm.lab_to_hex(measured)},
        "model_bias": [round(x, 2) for x in bias],
        "inks": g, "deltas": {k: v for k, v in deltas.items() if v},
        "expected": {"lab": [round(x, 2) for x in lab], "hex": cm.lab_to_hex(lab),
                     "dE": round(cm.delta_e2000(lab, target), 2), "diff": cm.describe(cm.lab_parts(target, lab))},
        "change_text": " · ".join(f"{k} {'+' if v > 0 else ''}{v}g" for k, v in deltas.items() if v) or "변경 없음",
    }
    if _tone_note(tone, cov):
        res["note"] = _tone_note(tone, cov)
    return res


# ---------------------------------------------------------------- 동판 맞추기
def sample_color(lib, s, mode, t, gamma):
    """시료 하나의 예측 LAB. s: {"substrate", "layer1", "layer2"?, "coverage": {"1도": 설계, "2도": 설계}}."""
    r = predict(lib, s["substrate"], s["layer1"], s.get("layer2"), mode=mode, plate=t,
                coverage=s.get("coverage") or {"1도": 1.0, "2도": 1.0}, gamma=gamma)
    return r["average"]["lab"]


def fit_plate(lib, samples, mode="sci", start=(1.0, 1.0), lo=0.2, hi=5.0):
    """측정한 전사 시료들로 동판의 막두께 계수와 망점 퍼짐(γ)을 맞춘다.
    samples: [{"substrate", "layer1", "layer2"?, "coverage"?: {"1도": 0.6}, "measured": [L,a,b]}]
    중간 망점(0~100% 사이)이 있을 때만 퍼짐도 맞춘다. start: 지금 쓰는 (막두께, γ) — '맞추기 전' 비교용."""
    if not samples:
        raise ModelError("측정한 시료가 없습니다")
    tones = {round(float(v), 4) for s in samples for v in (s.get("coverage") or {}).values()}
    with_gain = any(0.0 < v < 1.0 for v in tones)

    def each(t, g):
        return [cm.delta_e2000(sample_color(lib, s, mode, t, g), s["measured"]) for s in samples]

    def mean_de(t, g):
        d = each(t, g)
        return sum(d) / len(d)

    def f(p):
        t, g = math.exp(p[0]), (math.exp(p[1]) if with_gain else 1.0)
        pen = max(0.0, lo - t) + max(0.0, t - hi) + max(0.0, 0.2 - g) + max(0.0, g - 8.0)
        return mean_de(min(hi, max(lo, t)), min(8.0, max(0.2, g))) + 100 * pen

    best = None
    for t0 in (0.6, 1.0, 1.6):
        x0 = [math.log(t0)] + ([0.3] if with_gain else [])
        p, v = km.nelder_mead(f, x0, step=0.3, iters=200, tol=1e-6)
        if best is None or v < best[1]:
            best = (p, v)
    t = min(hi, max(lo, math.exp(best[0][0])))
    g = min(8.0, max(0.2, math.exp(best[0][1]))) if with_gain else float(start[1])
    before = each(*start)
    after = each(t, g)
    if sum(after) >= sum(before):            # 이미 맞으면 그대로 (탐색 오차로 나빠지지 않게)
        t, g, after = float(start[0]), float(start[1]), before
    return {"thickness": round(t, 3), "gamma": round(g, 4), "dot50": round(km.effective_tone(0.5, g), 4),
            "gain_fitted": with_gain, "dE_after": round(sum(after) / len(after), 2),
            "dE_before": round(sum(before) / len(before), 2), "n": len(samples),
            "per_sample": [{"before": round(b, 2), "after": round(a, 2)} for b, a in zip(before, after)]}
