"""합성 측정값 — 데모와 테스트용 (실제 측정값이 아니다).

'진짜' 잉크 흡수·산란값(채널별)을 정해 두고, 측색기가 줬을 LAB를 같은 물리로 만들어 낸다.
엔진이 이 LAB만 보고 진짜값을 되찾는지(예측·추천·보정·동판 계수)를 확인하는 데 쓴다.
"""
from . import colormath as cm
from . import km

# 3채널(선형 RGB) 진짜값: 잉크 1 단위의 (k, s) — 순서 R, G, B
TRUTH = {
    "WH": {"k": [0.02, 0.02, 0.03], "s": [2.2, 2.2, 2.1]},
    "BK": {"k": [3.2, 3.2, 3.0], "s": [0.25, 0.25, 0.25]},
    "YE": {"k": [0.05, 0.25, 3.0], "s": [0.6, 0.6, 0.5]},
    "RD": {"k": [0.08, 2.6, 1.8], "s": [0.5, 0.4, 0.4]},
    "BL": {"k": [2.4, 0.9, 0.12], "s": [0.35, 0.4, 0.5]},
    "MT": {"k": [0.01, 0.01, 0.012], "s": [0.08, 0.08, 0.08]},
}
CLEAR = ("CL",)
WHITE_CARD = (94.0, -0.5, 2.0)
BLACK_CARD = (27.0, 0.0, -0.5)
SUBSTRATES = [
    {"code": "C 1000", "maker": "샘플도장 A", "surface": "경면", "desc": "다크그레이 메탈", "lab": (38.0, -0.6, -2.5)},
    {"code": "D 2000", "maker": "샘플도장 A", "surface": "경면", "desc": "실버 메탈", "lab": (72.0, -0.8, 1.5)},
    {"code": "D 2000", "maker": "샘플도장 A", "surface": "패브릭엠보", "desc": "실버 메탈", "lab": (69.5, -0.7, 1.8)},
    {"code": "BK-1", "maker": "샘플도장 B", "surface": "경면", "desc": "매트 블랙", "lab": (24.0, 0.2, -0.4)},
]


def _rgb(lab):
    return [km.clamp(x) for x in cm.lab_to_rgb_lin(lab)]


def _lab(rgb):
    return [round(x, 3) for x in cm.rgb_lin_to_lab(rgb)]


def print_on(bg_lab, k, s, mode="sci", thick=1.0):
    """진짜값 막(k·s·두께)을 bg 위에 찍었을 때 측색기가 줄 LAB."""
    bg = [km.to_internal(r, mode) for r in _rgb(bg_lab)]
    r = [km.to_measured(km.layer(bg[i], k[i] * thick, s[i] * thick), mode) for i in range(3)]
    return _lab(r)


def true_film(recipe, thick=1.0, cal=(20.0, 30.0)):
    """진짜값으로 배합의 막 (k·s, 채널별) — model.recipe_film과 같은 규칙."""
    from .model import normalize_recipe, film_thickness
    r = normalize_recipe(recipe)
    ink = sum(r["inks"].values())
    solids = ink + r["hardener"] + r["matting"]
    rel = film_thickness(solids / ink, r["thinner"] / ink) * thick
    k, s = [0.0] * 3, [0.0] * 3
    for n, g in r["inks"].items():
        if n in CLEAR:
            continue
        for i in range(3):
            k[i] += g / solids * TRUTH[n]["k"][i] * rel
            s[i] += g / solids * TRUTH[n]["s"][i] * rel
    return k, s


def true_color(substrate_lab, recipe, mode="sci", thick=1.0, under=None):
    bg = [km.to_internal(r, mode) for r in _rgb(substrate_lab)]
    if under:
        k, s = true_film(under, thick)
        bg = [km.layer(bg[i], k[i], s[i]) for i in range(3)]
    k, s = true_film(recipe, thick)
    return cm.rgb_lin_to_lab([km.to_measured(km.layer(bg[i], k[i], s[i]), mode) for i in range(3)])


def library(cal_thick=1.0):
    """진짜값으로 만든 '측정' 라이브러리 (흰·검정 카드에 잉크+경화제 20%·신나 30%로 찍은 값)."""
    h, t = 0.20, 0.30
    from .model import film_thickness
    rel = (1.0 / (1.0 + h)) * film_thickness(1.0 + h, t) * cal_thick
    inks = []
    for name, v in TRUTH.items():
        k = [x * rel for x in v["k"]]
        s = [x * rel for x in v["s"]]
        cal = {"hardener_pct": 20, "thinner_pct": 30, "method": "합성", "measured_on": "2026-01-01"}
        for mode in ("sci", "sce"):
            cal.setdefault("white_bg", {})[mode] = list(WHITE_CARD) if mode == "sci" else _lab(
                [km.to_measured(km.to_internal(r, "sci"), "sce") for r in _rgb(WHITE_CARD)])
            cal.setdefault("black_bg", {})[mode] = list(BLACK_CARD) if mode == "sci" else _lab(
                [km.to_measured(km.to_internal(r, "sci"), "sce") for r in _rgb(BLACK_CARD)])
        for mode in ("sci", "sce"):
            cal.setdefault("on_white", {})[mode] = print_on(_lab_mode(WHITE_CARD, mode), k, s, mode)
            cal.setdefault("on_black", {})[mode] = print_on(_lab_mode(BLACK_CARD, mode), k, s, mode)
        inks.append({"name": name, "note": "합성 데모 잉크", "cal": cal})
    inks += [{"name": n, "clear": True, "note": "투명 (색 없음)"} for n in CLEAR]
    subs = []
    for sb in SUBSTRATES:
        d = {k: v for k, v in sb.items() if k != "lab"}
        d.update({"painted": "2026-01-08", "measured_on": "2026-01-10",
                  "sci": list(sb["lab"]), "sce": _lab_mode(sb["lab"], "sce")})
        subs.append(d)
    return {"schema": "colorlab/v1", "inks": inks, "substrates": subs,
            "plates": [{"lot": "DEMO_001", "thickness": 1.0, "coverage": {"1도": 0.35, "2도": 0.25}, "note": "합성"}],
            "settings": {"yn": 1.0, "cards": {"white": {m: _lab_mode(WHITE_CARD, m) for m in ("sci", "sce")},
                                              "black": {m: _lab_mode(BLACK_CARD, m) for m in ("sci", "sce")}}}}


def _lab_mode(sci_lab, mode):
    """SCI로 정한 바탕의 SCE 값 (정반사 4%를 뺀 값)."""
    if mode == "sci":
        return list(sci_lab)
    return _lab([km.to_measured(km.to_internal(r, "sci"), "sce") for r in _rgb(sci_lab)])
