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


# 아카이브와 컬러연구소가 함께 사용하는 이름/DB 연결 규칙. 별칭은 제품을 추측하지 않는다.
DB_INK_CODES = ("MT", "BK", "WH", "YE", "RD", "CL", "YE-D")


def ink_key(value):
    return str(value).strip().lower()


class InkRegistry:
    """정식명·표시 약칭·입력 별칭을 한 제품으로 해석. 원본 배합은 변경하지 않는다."""

    def __init__(self, inks=()):
        self.inks, self.lookup, self.db_owners = {}, {}, {}
        for ink in inks:
            if not isinstance(ink, dict):
                raise ModelError("잉크는 객체여야 합니다")
            name = self._label(ink.get("name"), "잉크 이름")
            short = self._label(ink.get("short_name", ""), f"{name} 표시 약칭", optional=True)
            aliases = ink.get("aliases") or []
            if not isinstance(aliases, list) or len(aliases) > 30:
                raise ModelError(f"{name}: 입력 별칭은 최대 30개 문자열 배열")
            if name in self.inks:
                raise ModelError(f"잉크 이름 중복: {name}")
            self.inks[name] = ink
            for label in [name, short] + aliases:
                label = self._label(label, f"{name} 별칭", optional=True)
                if not label:
                    continue
                key = ink_key(label)
                if key in self.lookup and self.lookup[key] != name:
                    raise ModelError(f"잉크 이름/별칭 중복: {label} ({self.lookup[key]} / {name})")
                self.lookup[key] = name
            # 기존 7종 정식명은 호환 유지. 등록된 다른 제품의 별칭만으로 DB 연결하지 않는다.
            code = ink.get("db_ink", name if name in DB_INK_CODES else "")
            if not isinstance(code, str) or (code and code not in DB_INK_CODES):
                raise ModelError(f"{name}: DB 연결은 {' / '.join(DB_INK_CODES)} 중 하나")
            if code:
                if code in self.db_owners:
                    raise ModelError(f"DB 연결 중복: {code} ({self.db_owners[code]} / {name})")
                self.db_owners[code] = name

    @staticmethod
    def _label(value, what, optional=False):
        if not isinstance(value, str):
            raise ModelError(f"{what}: 문자열이 필요합니다")
        value = value.strip()
        if (not value and not optional) or len(value) > 80 or any(c in value for c in "\n\r\t,;+"):
            raise ModelError(f"{what}: 1~80자, 줄바꿈·쉼표·세미콜론·+ 없이 입력하세요")
        return value

    def resolve(self, name, strict=False):
        canonical = self.lookup.get(ink_key(name))
        if canonical is None and strict:
            raise ModelError(f"라이브러리에 없는 잉크: {name} — 정식명 또는 별칭을 등록하세요")
        return canonical or str(name).strip()

    def normalize(self, amounts, strict=False):
        if not isinstance(amounts, dict):
            raise ModelError("배합 잉크는 {이름: g} 객체여야 합니다")
        out = {}
        for name, value in amounts.items():
            try:
                grams = float(value)
            except (TypeError, ValueError):
                raise ModelError(f"{name}: 잉크량은 숫자여야 합니다")
            if isinstance(value, bool) or not math.isfinite(grams) or grams < 0:
                raise ModelError(f"{name}: 잉크량은 유한한 0 이상 숫자여야 합니다")
            if grams == 0:
                continue
            canonical = self.resolve(name, strict)
            out[canonical] = out.get(canonical, 0.0) + grams
            if not math.isfinite(out[canonical]):
                raise ModelError(f"{name}: 합산 잉크량이 너무 큽니다")
        return out

    def db_code(self, name):
        canonical = self.resolve(name)
        ink = self.inks.get(canonical)
        if ink is not None:
            return ink.get("db_ink", canonical if canonical in DB_INK_CODES else "")
        legacy = str(name).strip().upper()
        return legacy if legacy in DB_INK_CODES else ""

    def to_db(self, amounts):
        out, owners, errors = {}, {}, []
        for name, grams in self.normalize(amounts).items():
            code = self.db_code(name)
            if not code:
                errors.append(f"{name} {grams:g}g: DB 연결 없음")
            elif code in owners and owners[code] != name:
                errors.append(f"{owners[code]} / {name}: 같은 DB 칸 {code}로 합칠 수 없습니다 (별칭 확인)")
            else:
                owners[code] = name
                out[code] = out.get(code, 0.0) + grams
        if errors:
            raise ModelError(" / ".join(errors))
        return out

    def from_db(self, amounts):
        return {self.db_owners.get(code, code): grams for code, grams in amounts.items()}


# ---------------------------------------------------------------- 측정값 ↔ 채널
# 계산 공간(space): "spec"(분광 31채널) 또는 3채널 기저 이름(colormath.BASES — "xyz" 기본, "srgb" 예전 방식)
def n_channels(space):
    return len(cm.WAVELENGTHS) if space == "spec" else 3


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


def raw_channels(m, mode, space):
    """측정값 → 채널별 '측정 반사율' (자르지 않은 값 — 진단용)."""
    if space == "spec":
        s = _spec(m, mode)
        if s is None:
            raise ModelError("분광 데이터가 없습니다")
        return list(s)
    lab = meas_lab(m, mode)
    if lab is None:
        raise ModelError(f"{mode.upper()} 측정값이 없습니다")
    return list(cm.lab_to_tri(lab, space))


def channels(m, mode, space):
    """계산에 쓰는 채널 반사율 (0~1 밖은 잘라냄 — 잘린 값은 fit.diagnose_measurement가 알려 준다)."""
    return [km.clamp(x) for x in raw_channels(m, mode, space)]


def channels_to_lab(rs, space):
    if space == "spec":
        return cm.spectrum_to_lab(rs)
    return cm.tri_to_lab(rs, space)


def has(m, mode, space):
    if space == "spec":
        return _spec(m, mode) is not None
    return meas_lab(m, mode) is not None


def interp_tone(curve, c):
    """보정 프로필의 망점 곡선 [[설계, 실효], …] (0~1)으로 실효 덮임 계산. (0,0)·(1,1) 사이를 직선으로 잇는다."""
    pts = [(0.0, 0.0)] + [(float(d), float(e)) for d, e in curve] + [(1.0, 1.0)]
    pts.sort()
    c = min(1.0, max(0.0, float(c)))
    for (d0, e0), (d1, e1) in zip(pts, pts[1:]):
        if d0 <= c <= d1:
            return e0 if d1 == d0 else e0 + (e1 - e0) * (c - d0) / (d1 - d0)
    return c


# ---------------------------------------------------------------- 라이브러리
class Library:
    """{'inks': [...], 'substrates': [...], 'plates': [...], 'settings': {...}, 'fits': {'active': 보정 프로필}}"""

    def __init__(self, data=None):
        data = data or {}
        self.registry = InkRegistry(data.get("inks") or [])
        self.inks = self.registry.inks
        self.substrates = list(data.get("substrates") or [])
        self.plates = {str(p["lot"]): p for p in data.get("plates") or [] if p.get("lot")}
        self.settings = dict(data.get("settings") or {})
        self.basis = self.settings.get("basis") if self.settings.get("basis") in cm.BASES else "xyz"
        self.profile = (data.get("fits") or {}).get("active") or None
        self._cal = {}

    def recipe(self, recipe):
        out = normalize_recipe(recipe)
        out["inks"] = self.registry.normalize(out["inks"], strict=True)
        return out

    def _profile_for(self, mode, space):
        p = self.profile
        return p if p and p.get("mode") == mode and p.get("space") == space else None

    # --- 잉크 역산
    def ink_params(self, name, mode, space):
        """잉크 1 단위(=막 고형분 100%가 이 잉크, 기준 두께)의 채널별 (k, s).
        출처(source): 'profile'(적용한 보정 프로필) · 'measured'(얇게 찍은 측정에서 역산) · 'clear'(투명)."""
        name = self.registry.resolve(name, strict=True)
        key = (name, mode, space)
        if key in self._cal:
            return self._cal[key]
        ink = self.inks.get(name)
        if ink is None:
            raise ModelError(f"라이브러리에 없는 잉크: {name}")
        n = n_channels(space)
        if ink.get("clear"):
            out = {"k": [0.0] * n, "s": [0.0] * n, "residual": 0.0, "source": "clear", "used": []}
            self._cal[key] = out
            return out
        prof = self._profile_for(mode, space)
        if prof and name in (prof.get("inks") or {}):
            p = prof["inks"][name]
            out = {"k": [float(x) for x in p["k"]], "s": [float(x) for x in p["s"]], "residual": 0.0,
                   "source": "profile", "used": ["solid", f"전사 시료 {p.get('samples', 0)}개"]}
            self._cal[key] = out
            return out
        cal = ink.get("cal") or {}
        prints = [(b, q) for b, q in (("white_bg", "on_white"), ("black_bg", "on_black"))
                  if has(cal.get(b), mode, space) and has(cal.get(q), mode, space)]
        solid = has(cal.get("solid"), mode, space)
        if not prints:
            raise ModelError(f"잉크 {name}: {mode.upper()} 얇게 찍은 측정(바탕 + 그 위 잉크)이 없습니다"
                             + (" — 은폐 도막만으로는 막 두께를 알 수 없어요. 이 잉크의 전사 시료(망점 패치)를 넣고"
                                " '보정 프로필'을 계산·적용하면 계산됩니다" if solid else ""))
        if len(prints) == 1 and not solid:
            raise ModelError(f"잉크 {name}: {mode.upper()} 측정이 하나 더 필요합니다 (은폐 도막 또는 다른 바탕 위 전사)")

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
        out = {"k": ks, "s": ss, "residual": res, "source": "measured",
               "used": [q for _, q in prints] + (["solid"] if solid else [])}
        self._cal[key] = out
        return out

    def ink_ready(self, name, mode, space):
        try:
            self.ink_params(name, mode, space)
            return True
        except ModelError:
            return False

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
    def plate_info(self, lot, mode=None, space=None):
        """동판의 막두께 계수 · 망점 곡선. 우선순위: 적용한 보정 프로필 → 입력값 → 다른 동판에서 추정
        (막두께는 부식 깊이에 비례, 망점 퍼짐은 같은 LPI 동판의 평균)."""
        out = {"lot": lot, "thickness": 1.0, "thickness_src": "기본값", "gamma": 1.0, "dot50": 0.5,
               "gain_src": "퍼짐 없음", "tone_curve": None}
        p = self.plates.get(str(lot)) if lot else None
        if not p:
            return out
        prof = self.profile
        pp = ((prof or {}).get("plates") or {}).get(str(lot))
        if pp and (mode is None or (prof.get("mode") == mode and prof.get("space") == space)):
            out.update(thickness=float(pp["thickness"]), thickness_src="보정 프로필 (기준 동판 대비 상대값)",
                       tone_curve=[list(x) for x in pp.get("tone_curve") or []], gain_src="보정 프로필 망점 곡선")
            out["dot50"] = interp_tone(out["tone_curve"], 0.5)
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
            v = float(x or 0)
            if isinstance(x, bool) or not math.isfinite(v) or v < 0:
                raise ValueError()
            return v
        except (TypeError, ValueError):
            raise ModelError(f"숫자가 아닌 값: {x}")
    if not isinstance(r, dict) or not isinstance(r.get("inks"), dict):
        raise ModelError("배합은 inks 객체가 필요합니다")
    inks = {str(k): g(v) for k, v in r["inks"].items() if g(v) > 0}
    if not inks:
        raise ModelError("잉크가 없는 배합입니다")
    return {"inks": inks, "matting": g(r.get("matting")), "thinner": g(r.get("thinner")),
            "hardener": g(r.get("hardener"))}


def film_weights(lib, recipe, plate=1.0):
    """배합 → (성분별 막 비중 {잉크: w}, 상대 막 두께). 막의 K·S = Σ w·(잉크 1단위 K·S) × 두께."""
    r = lib.recipe(recipe)
    ink_g = sum(r["inks"].values())
    solids = ink_g + r["hardener"] + r["matting"]
    rel = film_thickness(solids / ink_g, r["thinner"] / ink_g) * plate
    comps = dict(r["inks"])
    if MATTING in lib.inks and r["matting"]:
        comps[MATTING] = comps.get(MATTING, 0.0) + r["matting"]
    return {name: grams / solids for name, grams in comps.items()}, rel


def recipe_film(lib, recipe, mode, space, plate=1.0):
    """배합 → 채널별 막 (KX, SX)."""
    weights, rel = film_weights(lib, recipe, plate)
    n = n_channels(space)
    kx, sx = [0.0] * n, [0.0] * n
    for name, w in weights.items():
        p = lib.ink_params(name, mode, space)
        for i in range(n):
            kx[i] += w * p["k"][i] * rel
            sx[i] += w * p["s"][i] * rel
    return kx, sx


def pick_space(lib, mode, inks, substrate_meas):
    """쓰는 잉크와 바탕이 모두 분광으로 계산될 수 있으면 분광, 아니면 3채널(lib.basis)."""
    if has(substrate_meas, mode, "spec") and all(lib.ink_ready(n, mode, "spec") for n in inks):
        return "spec"
    return lib.basis


# ---------------------------------------------------------------- 예측
def _plate(lib, plate, mode=None, space=None, gamma=None):
    """동판 lot 문자열 또는 막두께 숫자 → (막두께 계수, 망점 함수 설계→실효, 동판 정보|None)."""
    if isinstance(plate, (int, float)):
        g = float(gamma if gamma is not None else 1.0)
        return float(plate), (lambda c: km.effective_tone(c, g)), None
    info = lib.plate_info(plate, mode, space)
    if info["tone_curve"] and gamma is None:
        curve = info["tone_curve"]
        return info["thickness"], (lambda c: interp_tone(curve, c)), info
    g = float(gamma if gamma is not None else info["gamma"])
    return info["thickness"], (lambda c: km.effective_tone(c, g)), info


def _mix(parts, yn):
    """[(비율, 측정 반사율 채널들), …] → 측색기 구멍 안의 평균 (Yule–Nielsen)."""
    n = len(parts[0][1])
    return [sum(w * r[i] ** (1 / yn) for w, r in parts) ** yn for i in range(n)]


def _space_note(space):
    if space == "spec":
        return None
    return ("3채널 근사 (XYZ 기저) — 분광 데이터를 넣으면 더 정확해집니다" if space == "xyz"
            else "3채널 근사 (sRGB 기저) — 진한 노랑·파랑은 잘려서 오차가 커집니다")


def predict(lib, substrate, layer1, layer2=None, mode="sci", plate=None, coverage=None, yn=None, gamma=None):
    """도장 시편 위 1도(·2도) 인쇄의 색.
    substrate: 라이브러리 코드 문자열 또는 측정값 dict (LAB 직접 입력).
    coverage: 설계 망점 비율 {"1도": 0.6, "2도": 0.4} — 동판의 망점 곡선을 적용해 측색기에 잡히는 평균색도 계산.
              없으면 동판에 적어 둔 값을 쓴다.
    반환: 영역별 LAB(반올림 없음) · 견본색 · 사용한 계산 공간."""
    if mode not in MODES:
        raise ModelError("mode는 sci 또는 sce")
    layer1 = lib.recipe(layer1)
    layer2 = lib.recipe(layer2) if layer2 else None
    sub_meas = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    if not has(sub_meas, mode, lib.basis) and not has(sub_meas, mode, "spec"):
        raise ModelError(f"바탕의 {mode.upper()} 값이 없습니다")
    inks = set(normalize_recipe(layer1)["inks"]) | (set(normalize_recipe(layer2)["inks"]) if layer2 else set())
    space = pick_space(lib, mode, inks, sub_meas)
    t, tone, info = _plate(lib, plate, mode, space, gamma)
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
    out = {"mode": mode, "space": space, "plate": t, "regions": {},
           "sources": {n: lib.ink_params(n, mode, space)["source"] for n in sorted(inks)}}
    if info:
        out["plate_info"] = {k: info[k] for k in ("thickness_src", "dot50", "gain_src")}
    for k, v in meas.items():
        lab = channels_to_lab(v, space)
        out["regions"][k] = {"lab": list(lab), "hex": cm.lab_to_hex(lab)}
    if coverage:
        d1 = float(coverage.get("1도") or 0)
        d2 = float(coverage.get("2도") or 0) if layer2 else 0.0
        c1, c2 = tone(d1), (tone(d2) if layer2 else 0.0)
        w = {"substrate": (1 - c1) * (1 - c2), "layer1": c1 * (1 - c2)}
        if layer2:
            w.update({"layer2": (1 - c1) * c2, "overlap": c1 * c2})
        avg = _mix([(w[k], meas[k]) for k in w], yn)
        lab = channels_to_lab(avg, space)
        out["average"] = {"lab": list(lab), "hex": cm.lab_to_hex(lab), "weights": w,
                          "tone": {"1도": [d1, round(c1, 4)], **({"2도": [d2, round(c2, 4)]} if layer2 else {})}}
    notes = [x for x in (_space_note(space),) if x]
    if len({v for v in out["sources"].values() if v != "clear"}) > 1:
        notes.append("잉크마다 보정 출처가 다릅니다(프로필/측정) — 기준 동판이 같다고 보고 계산했습니다")
    if notes:
        out["note"] = " · ".join(notes)
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
    inks = list(dict.fromkeys(lib.registry.resolve(n, strict=True) for n in inks))
    under = lib.recipe(under) if under else None
    target = tuple(float(x) for x in target)
    sub = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    space = pick_space(lib, mode, set(inks) | (set(normalize_recipe(under)["inks"]) if under else set()), sub)
    t, tone_of, _ = _plate(lib, plate, mode, space)
    cov = tone_of(tone)
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
    current = lib.recipe(current)
    cur = current
    under = lib.recipe(under) if under else None
    adjustable = [lib.registry.resolve(n, strict=True) for n in (adjustable or [])]
    measured = tuple(float(x) for x in measured)
    target = tuple(float(x) for x in target)
    sub = lib.find_substrate(substrate) if isinstance(substrate, str) else substrate
    names = list(dict.fromkeys(list(cur["inks"]) + list(adjustable or [])))
    space = pick_space(lib, mode, set(names) | (set(normalize_recipe(under)["inks"]) if under else set()), sub)
    t, tone_of, _ = _plate(lib, plate, mode, space)
    cov = tone_of(tone)
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


# ---------------------------------------------------------------- 시료 하나의 예측
def sample_color(lib, s, mode, plate=None):
    """전사 시료 하나의 예측 LAB (반올림 없음).
    s: {"substrate", "layer1", "layer2"?, "coverage": {"1도": 설계, "2도": 설계}}, plate: 동판 lot 또는 막두께 숫자."""
    r = predict(lib, s["substrate"], s["layer1"], s.get("layer2"), mode=mode, plate=plate,
                coverage=s.get("coverage") or {"1도": 1.0, "2도": 1.0})
    return r["average"]["lab"]
