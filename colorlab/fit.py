"""보정 프로필 — 은폐 도막 + 전사 시료(망점 패치)로 잉크와 동판을 함께 맞춘다.

왜 따로 있나: 예전 구조는 '잉크 보정(100% 얇게 찍은 값 필요) → 동판 맞추기' 순서였는데,
100% 동판은 만들 수 없어서 잉크 보정이 끝나지 않았다. 여기서는 순방향 계산에 잉크 값을 직접 넘겨
(Library.ink_params를 거치지 않고) 잉크 산란 · 망점 곡선 · (필요하면) 막두께를 한꺼번에 맞춘다.

1차 범위 (그 밖의 시료는 이유와 함께 제외):
  - 동판 하나 (그 동판이 막두께 기준 ×1.00)
  - 1도, 유색 잉크 하나 (투명 잉크·경화제·신나는 섞여도 됨)
  - SCI 또는 SCE 중 고른 모드 하나

모델 (가정은 결과의 'assumptions'에 그대로 남긴다):
  - 패치 = 바탕과 '연속 전사막'을 실효 덮임 c로 섞은 평균 (Yule–Nielsen n, 기본 1)
  - 연속 전사막 = 바탕 위 Kubelka–Munk 막. 흡수/산란 비율 K/S는 은폐 도막(R∞)에서 정해진다
  - 산란 S: 3채널이면 채널마다 따로 두되 공통 값에서 벗어날수록 벌점(SCATTER_PRIOR)을 준다 —
    데이터가 요구하는 만큼만 벗어난다. 분광이면 파장에 따라 로그-직선으로 변한다고 가정
  - 망점 곡선: 잰 설계 망점마다 실효 덮임을 따로 맞춘다 (커지기만 하게). 그 사이는 직선, 밖은 (0,0)·(1,1)까지 직선(외삽)
"""
import hashlib
import json
import math
import time

from . import colormath as cm
from . import km
from . import model

MODEL_VERSION = "colorlab-profile/1"
LOG_S = (-9.0, 7.0)          # 잉크 1단위 산란의 탐색 범위 (로그)
ANGLE_WARN = 4.0             # 같은 막의 망점 패치 방향이 이 각도(°) 넘게 벌어지면 '한 막으로 설명 어려움'
SCATTER_PRIOR = 1e-4         # 3채널: 채널별 산란(로그)이 공통 값에서 벗어나는 만큼 주는 벌점의 세기
MISFIT_WARN, MISFIT_ERROR = 1.5, 3.0   # 맞춘 뒤에도 평균 ΔE00가 이보다 크면 '모델이 데이터를 설명 못함'


def fingerprint(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]


def channel_names(space):
    if space == "spec":
        return [f"{w}nm" for w in cm.WAVELENGTHS]
    return list("XYZ") if space == "xyz" else list("RGB")


# ---------------------------------------------------------------- 측정 진단
def diagnose_measurement(m, mode, space, label):
    """측정 하나가 계산에 그대로 쓰일 수 있는지. 표시 문제와 계산 문제를 나눠서 알린다."""
    out = []
    lab = model.meas_lab(m, mode)
    if lab is not None and not cm.in_gamut(lab):
        out.append({"kind": "display_gamut_outside", "level": "info", "what": label,
                    "msg": "화면(sRGB)으로는 정확히 보여 줄 수 없는 진한 색입니다 (견본색만 근사, 계산과는 무관)"})
    try:
        raw = model.raw_channels(m, mode, space)
    except model.ModelError:
        return out
    names = channel_names(space)
    bad = [names[i] for i, v in enumerate(raw) if v < 0 or v > 1]
    if bad:
        out.append({"kind": "channel_model_invalid", "level": "error", "what": label, "channels": bad,
                    "msg": f"{'·'.join(bad[:6])} 채널이 0~1 밖이라 반사율로 쓸 수 없어 잘립니다"
                           + (" — sRGB 기저의 한계입니다 (XYZ 기저나 분광을 쓰세요)" if space == "srgb" else "")})
    k1, k2 = km.K1[mode], km.K2
    inner = [(r - k1) / (1 - k1 - k2 + k2 * r) for r in raw]
    low = [names[i] for i, v in enumerate(inner) if v < 0]
    if low:
        out.append({"kind": "surface_model_incompatible", "level": "warn", "what": label, "channels": low,
                    "msg": f"{mode.upper()} 반사율이 표면 정반사 가정({k1 * 100:g}%)보다 낮은 채널이 있습니다"
                           f" ({'·'.join(low[:6])}) — 광택이 가정과 다를 수 있어요. 이 채널은 0으로 잘려 계산됩니다"})
    return out


# ---------------------------------------------------------------- 시료 모으기
def _solid_rho(cal, mode, space):
    """은폐 도막(R∞)에서 채널별 K/S."""
    rinf = [km.to_internal(r, mode) for r in model.channels(cal["solid"], mode, space)]
    return [(1 - r) ** 2 / (2 * r) for r in rinf], rinf


def choose_space(doc, mode, plate, basis):
    """이 동판 시료·바탕·은폐 도막이 모두 분광을 가지면 분광, 아니면 3채널 기저."""
    lib = model.Library({**doc, "fits": None})
    rows = [t for t in doc.get("transfers") or [] if t.get("plate") == plate]
    if not rows:
        return basis
    for t in rows:
        if not model.has(t.get("measured"), mode, "spec"):
            return basis
        try:
            sub = lib.find_substrate(t["substrate"]) if isinstance(t["substrate"], str) else t["substrate"]
        except model.ModelError:
            continue
        if not model.has(sub, mode, "spec"):
            return basis
        for n in (t.get("layer1") or {}).get("inks") or {}:
            ink = lib.inks.get(lib.registry.resolve(n)) or {}
            if not ink.get("clear") and not (model.has((ink.get("cal") or {}).get("solid"), mode, "spec")
                                             or lib.ink_ready(n, mode, "spec")):
                return basis
    return "spec"


def collect(doc, mode, plate, space):
    """이 동판의 전사 시료를 계산용으로 정리하고, 못 쓰는 시료는 이유를 남긴다."""
    base = model.Library({**doc, "fits": None})      # 측정 경로만 (적용된 프로필은 무시)
    samples, excluded, inks = [], [], {}
    for i, t in enumerate(doc.get("transfers") or []):
        no = i + 1
        if t.get("plate") != plate:
            continue

        def skip(reason):
            excluded.append({"no": no, "reason": reason})

        meas = t.get("measured") or {}
        if not model.has(meas, mode, space):
            skip(f"{mode.upper()} {'분광' if space == 'spec' else '값'} 없음")
            continue
        if t.get("layer2"):
            skip("2도 시료 (1차 범위 밖)")
            continue
        layer = dict(t.get("layer1") or {})
        layer["inks"] = base.registry.normalize(layer.get("inks") or {})
        names = list((layer.get("inks") or {}).keys())
        unknown = [n for n in names if n not in base.inks]
        if unknown:
            skip(f"라이브러리에 없는 잉크: {', '.join(unknown)}")
            continue
        colored = [n for n in names if not base.inks[n].get("clear")]
        if float(t.get("matting_pct") or 0) > 0 and model.MATTING in base.inks and not base.inks[model.MATTING].get("clear"):
            colored.append(model.MATTING)
        if not colored:
            skip("유색 잉크가 없음")
            continue
        try:
            sub = base.find_substrate(t["substrate"]) if isinstance(t["substrate"], str) else t["substrate"]
            rb = model.channels(sub, mode, space)
        except model.ModelError as e:
            skip(f"바탕: {e}")
            continue
        for ink in colored:
            if ink not in inks:
                cal = base.inks[ink].get("cal") or {}
                if base.ink_ready(ink, mode, space):
                    p = base.ink_params(ink, mode, space)
                    inks[ink] = {"kind": "fixed", "k": p["k"], "s": p["s"]}
                elif model.has(cal.get("solid"), mode, space):
                    rho, rinf = _solid_rho(cal, mode, space)
                    inks[ink] = {"kind": "free", "rho": rho, "rinf": rinf}
                else:
                    inks[ink] = {"kind": "none"}
        missing = [n for n in colored if inks[n]["kind"] == "none"]
        if missing:
            skip(f"{', '.join(missing)}: 은폐 도막도, 얇게 찍은 측정도 없음")
            continue
        free = [n for n in colored if inks[n]["kind"] == "free"]
        if len(free) > 1:
            skip(f"혼합 ({' + '.join(free)}) — 은폐 도막만 있는 잉크가 둘 이상이라 1차 범위 밖")
            continue
        tot = sum(float(v) for v in layer["inks"].values())
        rec = {"inks": layer["inks"], **{k: {"g": tot * float(t.get(f"{k}_pct") or 0) / 100}
                                         for k in ("thinner", "hardener", "matting")}}
        weights, rel = model.film_weights(base, rec)
        samples.append({
            "no": no, "ink": " + ".join(colored), "free": free[0] if free else None,
            "single": len(colored) == 1, "comps": {n: weights[n] for n in colored},
            "design": float(layer.get("tone", 100)) / 100.0, "substrate": t["substrate"],
            "sub_fp": fingerprint(sub), "cond": fingerprint([t.get("thinner_pct"), t.get("hardener_pct"), t.get("matting_pct")]),
            "rb": rb, "m": model.channels(meas, mode, space), "lab": list(model.meas_lab(meas, mode)),
            "rel": rel, "measured": meas,
        })
    return samples, excluded, inks


# ---------------------------------------------------------------- 순방향 계산 (잉크 값을 직접 받는다)
def ink_ks(ink, theta, space):
    """잉크 상태 + 파라미터 → 채널별 1단위 (k, s)."""
    if ink["kind"] == "fixed":
        return ink["k"], ink["s"]
    n = model.n_channels(space)
    if space == "spec":
        a, b = theta
        s = [math.exp(a + b * (w - 550) / 150.0) for w in cm.WAVELENGTHS]
    else:
        th = list(theta) * n if len(theta) == 1 else list(theta)
        s = [math.exp(x) for x in th[:n]]
    return [r * x for r, x in zip(ink["rho"], s)], s


def prior_penalty(theta, space):
    """3채널 산란이 채널끼리 벌어진 만큼의 벌점 (분광은 0 — 매끈함은 모양으로 가정)."""
    if space == "spec" or not theta or len(theta) < 2:
        return 0.0
    m = sum(theta) / len(theta)
    return SCATTER_PRIOR * sum((x - m) ** 2 for x in theta)


def ink_table(inks, theta, space):
    """잉크마다 채널별 1단위 (k, s)."""
    return {n: ink_ks(v, theta.get(n), space) for n, v in inks.items()}


def film(sample, params, t, mode):
    """연속 전사막(덮임 100%)의 측정 반사율. params: {잉크: (k, s)}."""
    n = len(sample["rb"])
    kx, sx = [0.0] * n, [0.0] * n
    for name, w in sample["comps"].items():
        k, s = params[name]
        f = w * sample["rel"] * t
        for i in range(n):
            kx[i] += k[i] * f
            sx[i] += s[i] * f
    return [km.to_measured(km.layer(km.to_internal(sample["rb"][i], mode), kx[i], sx[i]), mode) for i in range(n)]


def patch(sample, fm, c, yn):
    return model._mix([(1 - c, sample["rb"]), (c, fm)], yn)


def _sse(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b))


# ---------------------------------------------------------------- 맞추기
def _isotonic(pairs):
    """[(설계, 값, 가중치)] → 설계가 커질수록 줄지 않게 (pool adjacent violators)."""
    blocks = []
    for d, v, w in sorted(pairs):
        blocks.append([v * w, w, [d]])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            a = blocks.pop()
            blocks[-1][0] += a[0]
            blocks[-1][1] += a[1]
            blocks[-1][2] += a[2]
    out = {}
    for s, w, ds in blocks:
        for d in ds:
            out[d] = min(1.0, max(0.0, s / w))
    return out


def _fit(samples, inks, space, mode, yn, warm=None, outer=40):
    """잉크 산란(자유 잉크) · 망점별 실효 덮임 · (자유 잉크가 없으면) 막두께를 맞춘다.
    덮임은 산란이 정해지면 최소제곱으로 바로 풀리므로, 산란을 고를 때마다 덮임을 다시 풀어(프로파일)
    덮임↔산란이 서로 섞이는 골짜기에서도 한 번에 바닥을 찾는다."""
    free = [n for n, v in inks.items() if v["kind"] == "free" and any(s["free"] == n for s in samples)]
    theta = {n: list(v) for n, v in ((warm or {}).get("theta") or {}).items()}
    for n in free:
        theta.setdefault(n, [0.0, 0.0] if space == "spec" else [0.0, 0.0, 0.0])
        if space != "spec" and len(theta[n]) == 1:
            theta[n] = theta[n] * 3
    designs = sorted({s["design"] for s in samples})
    T = (lambda x: x) if yn == 1 else (lambda x: x ** (1 / yn))

    def solve_c(th, t):
        params = ink_table(inks, th, space)
        films = {id(smp): film(smp, params, t, mode) for smp in samples}
        num, den = {d: 0.0 for d in designs}, {d: 0.0 for d in designs}
        for smp in samples:
            for rb, f, m in zip(smp["rb"], films[id(smp)], smp["m"]):
                u, v = T(f) - T(rb), T(m) - T(rb)
                num[smp["design"]] += u * v
                den[smp["design"]] += u * u
        c = _isotonic([(d, num[d] / den[d] if den[d] > 1e-12 else d, max(den[d], 1e-12)) for d in designs])
        sse = sum(_sse(patch(smp, films[id(smp)], c[smp["design"]], yn), smp["m"]) for smp in samples)
        return c, sse

    t = 1.0 if free else float((warm or {}).get("t") or 1.0)
    prev = None
    for _ in range(outer):
        for n in free:
            def err(th_n, n=n):
                if any(x < LOG_S[0] or x > LOG_S[1] for x in th_n[:1 if space == "spec" else 3]):
                    return 1e9
                return solve_c({**theta, n: th_n}, t)[1] + prior_penalty(th_n, space)

            if space == "spec":
                best = km.nelder_mead(err, theta[n], step=0.5, iters=300, tol=1e-15, xtol=1e-6)[0]
                theta[n] = [best[0], max(-6.0, min(6.0, best[1]))]
            else:
                # 공통 산란에서 바닥을 먼저 찾고(1차원), 거기서 채널별로 풀어 준다
                u = km.golden(lambda v: err([v, v, v]), *LOG_S, iters=60)
                cands = [[u, u, u], list(theta[n])]
                best = min((km.nelder_mead(err, c0, step=0.4, iters=600, tol=1e-16, xtol=1e-7) for c0 in cands),
                           key=lambda r: r[1])
                theta[n] = list(best[0])
        if not free:
            t = math.exp(km.golden(lambda u: solve_c(theta, math.exp(u))[1], math.log(0.2), math.log(5.0), iters=60))
        c, cur = solve_c(theta, t)
        if len(free) <= 1 and space != "spec" or (prev is not None and abs(prev - cur) <= 1e-14 + 1e-9 * prev):
            break
        prev = cur
    return {"theta": theta, "c": c, "t": t, "free": free, "sse": cur,
            "penalty": sum(prior_penalty(theta[n], space) for n in free)}


def predict_sample(smp, inks, fit, space, mode, yn, curve=None):
    """맞춘 값으로 시료 하나 예측. curve가 있으면 그 곡선으로 덮임을 정한다(빠진 망점 예측용)."""
    fm = film(smp, ink_table(inks, fit["theta"], space), fit["t"], mode)
    cov = model.interp_tone(curve, smp["design"]) if curve is not None else fit["c"][smp["design"]]
    return model.channels_to_lab(patch(smp, fm, cov, yn), space), fm, cov


def _curve(c):
    return [[d, v] for d, v in sorted(c.items())]


# ---------------------------------------------------------------- 적합성 · 식별성 진단
def _angle(u, v):
    nu, nv = math.sqrt(sum(x * x for x in u)), math.sqrt(sum(x * x for x in v))
    if nu < 1e-9 or nv < 1e-9:
        return 0.0
    cosv = max(-1.0, min(1.0, sum(a * b for a, b in zip(u, v)) / (nu * nv)))
    return math.degrees(math.acos(cosv))


def _feasible_cmax(smp, rinf_m):
    """가장 진한 패치에서, 끝점(연속 전사막)이 바탕과 은폐 도막 사이에 있으려면 실효 덮임이 최소 얼마여야 하나.
    (n=1: 패치 = 바탕 + c·(막 − 바탕) → 막 = 바탕 + (패치 − 바탕)/c)"""
    lo = 0.0
    for rb, m, ri in zip(smp["rb"], smp["m"], rinf_m):
        v = m - rb
        span = ri - rb
        if abs(v) < 1e-6:
            continue
        if span == 0 or (v > 0) != (span > 0):
            return None                      # 은폐 도막과 반대 방향으로 변함 → 한 막으로 설명 불가
        lo = max(lo, v / span)
    return lo


def diagnose(samples, inks, space, mode, yn, fit):
    """모델 적합성(한 막으로 설명되는가) · 식별성(데이터가 값을 정할 수 있는가)."""
    groups, issues = [], []
    params = ink_table(inks, fit["theta"], space)
    for n in sorted({s["ink"] for s in samples}):
        mine = [s for s in samples if s["ink"] == n]
        single = all(s["single"] for s in mine)
        ink = inks.get(n) if single else {"kind": "free" if mine[0]["free"] else "fixed"}
        g = {"ink": n, "kind": ink["kind"], "mixture": not single, "samples": len(mine),
             "designs": sorted({s["design"] for s in mine})}
        span = g["designs"][-1] - g["designs"][0]
        g["tone_span"] = round(span, 3)
        # 같은 바탕·조건끼리 방향이 같은가 (n=1이면 한 직선 위에 있어야 함)
        if yn == 1:
            by = {}
            for s in mine:
                by.setdefault((s["sub_fp"], s["cond"]), []).append(s)
            worst = 0.0
            for grp in by.values():
                grp.sort(key=lambda s: s["design"])
                ref = [m - rb for m, rb in zip(grp[-1]["m"], grp[-1]["rb"])]
                for s in grp[:-1]:
                    worst = max(worst, _angle([m - rb for m, rb in zip(s["m"], s["rb"])], ref))
                lens = [math.sqrt(sum((m - rb) ** 2 for m, rb in zip(s["m"], s["rb"]))) for s in grp]
                if any(b < a - 1e-4 for a, b in zip(lens, lens[1:])):
                    issues.append({"kind": "tone_order", "level": "warn", "ink": n,
                                   "msg": f"{n}: 망점이 높은데 덜 진한 패치가 있습니다 — 측정·입력을 확인해 주세요"})
            g["max_angle"] = round(worst, 2)
            if worst > ANGLE_WARN:
                issues.append({"kind": "single_film_mismatch", "level": "warn", "ink": n,
                               "msg": f"{n}: 망점 패치들이 한 막으로 설명되지 않습니다 (방향 차이 최대 {worst:.1f}°)"})
            if ink["kind"] == "free" and single:
                top = max(mine, key=lambda s: s["design"])
                rinf_m = [km.to_measured(r, mode) for r in ink["rinf"]]
                lo = _feasible_cmax(top, rinf_m)
                if lo is None or lo > 1.0 + 1e-6:
                    issues.append({"kind": "physical_conflict", "level": "error", "ink": n,
                                   "msg": f"{n}: 가장 진한 패치({top['design'] * 100:g}%)를 바탕과 은폐 도막 사이의 어떤 막으로도"
                                          " 설명할 수 없습니다 — 은폐 도막·바탕·패치 측정 조건(광택·SCI/SCE)이 맞는지 확인해 주세요"})
                    g["c_top_range"] = None
                else:
                    g["c_top_range"] = [round(lo, 4), 1.0]
        # 식별성
        if ink["kind"] == "free" and single:
            rb = mine[0]["rb"]
            rinf_m = [km.to_measured(r, mode) for r in ink["rinf"]]
            if max(abs(a - b) for a, b in zip(rb, rinf_m)) < 0.01:
                issues.append({"kind": "unidentifiable_thickness", "level": "error", "ink": n,
                               "msg": f"{n}: 바탕과 은폐 도막 색이 거의 같아 막 두께·산란을 정할 수 없습니다"})
            fm = film(mine[0], params, fit["t"], mode)
            if max(abs(a - b) for a, b in zip(fm, rinf_m)) < 0.005:
                issues.append({"kind": "nearly_opaque", "level": "warn", "ink": n,
                               "msg": f"{n}: 맞춘 막이 거의 은폐 상태라 두께 변화에 둔감합니다 (산란 값이 불확실)"})
            th = fit["theta"].get(n) or [0.0]
            if any(x <= LOG_S[0] + 0.05 or x >= LOG_S[1] - 0.05 for x in th[:1 if space == "spec" else 3]):
                issues.append({"kind": "bound", "level": "warn", "ink": n,
                               "msg": f"{n}: 산란 값이 탐색 범위 끝에 걸렸습니다 — 데이터가 값을 정하지 못합니다"})
        if ink["kind"] == "free":
            if len(g["designs"]) < 2:
                issues.append({"kind": "single_tone", "level": "warn", "ink": n,
                               "msg": f"{n}: 망점이 한 단계뿐이라 덮임과 산란이 서로 섞입니다 (가정에 크게 의존)"})
            elif span < 0.3:
                issues.append({"kind": "narrow_tones", "level": "warn", "ink": n,
                               "msg": f"{n}: 망점 범위가 {span * 100:.0f}%p로 좁습니다 — 40% 이하 · 95% 패치가 있으면 좋아집니다"})
        groups.append(g)
    return groups, issues


# ---------------------------------------------------------------- 검증
def loo(samples, inks, space, mode, yn, fit):
    """하나 빼고 맞춘 뒤 빠진 시료를 예측한다 (그 시료는 잉크·망점 곡선 맞추기에 쓰이지 않는다)."""
    out = []
    for smp in samples:
        rest = [s for s in samples if s is not smp]
        row = {"no": smp["no"], "design": smp["design"]}
        if smp["free"] and not any(s["free"] == smp["free"] for s in rest):
            row.update(status="unevaluable", reason="이 잉크의 다른 시료가 없음")
            out.append(row)
            continue
        if not rest:
            row.update(status="unevaluable", reason="다른 시료가 없음")
            out.append(row)
            continue
        f = _fit(rest, inks, space, mode, yn, warm=fit, outer=30)
        designs = sorted(f["c"])
        lab, _, cov = predict_sample(smp, inks, f, space, mode, yn, curve=_curve(f["c"]))
        row.update(status="ok", dE=round(cm.delta_e2000(lab, smp["lab"]), 3), coverage=round(cov, 4),
                   extrapolated=not (designs[0] <= smp["design"] <= designs[-1]))
        out.append(row)
    return out


def sensitivity(samples, inks, space, mode, yn, fit, groups, target=0.95):
    """가정 민감도: 데이터만으로는 가장 진한 패치의 실효 덮임이 [하한, 1] 어디든 될 수 있다 (산란이 채널마다
    다를 수 있다면). 그 양 끝에서 목표 망점(기본 95%) 패치 예측이 얼마나 달라지나."""
    out = []
    if yn != 1:
        return out
    for g in groups:
        if g["kind"] != "free" or g["mixture"] or not g.get("c_top_range"):
            continue
        mine = sorted([s for s in samples if s["ink"] == g["ink"]], key=lambda s: s["design"])
        top = mine[-1]
        same = [s for s in mine if s["sub_fp"] == top["sub_fp"] and s["cond"] == top["cond"]]
        lens = {s["design"]: math.sqrt(sum((m - rb) ** 2 for m, rb in zip(s["m"], s["rb"]))) for s in same}
        ltop = lens[top["design"]] or 1e-9

        def predict_at(c_top):
            fm = [rb + (m - rb) / c_top for rb, m in zip(top["rb"], top["m"])]
            curve = [[d, min(1.0, c_top * lens[d] / ltop)] for d in sorted(lens)]
            cov = model.interp_tone(curve, target)
            return model.channels_to_lab(patch(top, fm, cov, yn), space)

        lo = g["c_top_range"][0]
        a, b = predict_at(max(lo, 1e-3)), predict_at(1.0)
        best = model.channels_to_lab(patch(top, film(top, ink_table(inks, fit["theta"], space), fit["t"], mode),
                                           model.interp_tone(_curve(fit["c"]), target), yn), space)
        out.append({"ink": g["ink"], "target": target, "c_top_range": g["c_top_range"],
                    "dE_range": round(cm.delta_e2000(a, b), 3),
                    "dE_best_vs_ends": [round(cm.delta_e2000(best, a), 3), round(cm.delta_e2000(best, b), 3)]})
    return out


def _confidence(samples, groups, issues, validation, sens):
    reasons = []
    if any(i["level"] == "error" for i in issues):
        return "부족", [i["msg"] for i in issues if i["level"] == "error"]
    ok = [v["dE"] for v in validation if v.get("status") == "ok"]
    if not ok:
        return "부족", ["하나 빼고 예측할 수 있는 시료가 없습니다 (잉크마다 시료 2개 이상 필요)"]
    mean = sum(ok) / len(ok)
    level = "좋음"
    if mean > 1.0:
        level = "보통"
        reasons.append(f"하나 빼고 예측 오차 평균 ΔE {mean:.2f}")
    if mean > 2.0:
        level = "낮음"
    for g in groups:
        if g["kind"] == "free" and (len(g["designs"]) < 2 or g["tone_span"] < 0.3):
            level = "낮음"
            reasons.append(f"{g['ink']}: 망점 범위 {g['tone_span'] * 100:.0f}%p")
        if g["kind"] == "free" and g["samples"] < 3 and level == "좋음":
            level = "보통"
            reasons.append(f"{g['ink']}: 시료 {g['samples']}개")
    for s in sens:
        if s["dE_range"] > 2.0:
            level = "낮음"
            reasons.append(f"{s['ink']}: 가정에 따라 95% 예측이 ΔE {s['dE_range']:.1f}까지 달라짐")
        elif s["dE_range"] > 1.0 and level == "좋음":
            level = "보통"
            reasons.append(f"{s['ink']}: 가정에 따라 95% 예측이 ΔE {s['dE_range']:.1f} 달라짐")
    if any(v.get("extrapolated") for v in validation if v.get("status") == "ok"):
        reasons.append("일부 검증은 잰 망점 범위 밖 외삽")
    return level, reasons


# ---------------------------------------------------------------- 스냅샷 (재맞추기 필요 판단)
def snapshot(doc, mode, plate):
    """이 프로필 계산에 영향을 주는 입력의 지문."""
    registry = model.InkRegistry(doc.get("inks") or [])
    rows = {str(i + 1): fingerprint(t) for i, t in enumerate(doc.get("transfers") or []) if t.get("plate") == plate}
    names = {registry.resolve(n) for t in doc.get("transfers") or [] if t.get("plate") == plate
             for n in ((t.get("layer1") or {}).get("inks") or {})}
    inks = {i["name"]: fingerprint([i.get("clear"), i.get("cal")]) for i in doc.get("inks") or [] if i["name"] in names}
    used = {str(t.get("substrate")).split("@")[0] for t in doc.get("transfers") or [] if t.get("plate") == plate}
    subs = {s.get("code", ""): fingerprint([x for x in doc.get("substrates") or [] if x.get("code") == s.get("code")])
            for s in doc.get("substrates") or [] if s.get("code") in used}
    st = doc.get("settings") or {}
    return {"transfers": rows, "inks": inks, "substrates": subs,
            "settings": fingerprint([st.get("yn", 1.0), st.get("basis"), st.get("cards")]), "mode": mode, "plate": plate}


def stale_reasons(run, doc):
    """적용한 프로필 이후 입력이 바뀌었으면 그 이유들."""
    if not run:
        return []
    now = snapshot(doc, run.get("mode"), run.get("plate"))
    old = run.get("snapshot") or {}
    out = []
    a, b = old.get("transfers") or {}, now["transfers"]
    if set(b) - set(a):
        out.append(f"전사 시료 추가 {len(set(b) - set(a))}개")
    if set(a) - set(b):
        out.append(f"전사 시료 삭제 {len(set(a) - set(b))}개")
    if any(a[k] != b[k] for k in set(a) & set(b)):
        out.append("전사 시료 수정")
    if (old.get("inks") or {}) != now["inks"]:
        out.append("잉크(은폐 도막·측정) 변경")
    if (old.get("substrates") or {}) != now["substrates"]:
        out.append("바탕 측정 변경")
    if old.get("settings") != now["settings"]:
        out.append("계산 설정·기본 카드값 변경")
    return out


# ---------------------------------------------------------------- 입구
def run_profile(doc, mode="sci", plate=None, space=None):
    """보정 프로필 후보를 계산한다 (라이브러리는 바꾸지 않는다)."""
    if mode not in model.MODES:
        raise model.ModelError("mode는 sci 또는 sce")
    lots = [p["lot"] for p in doc.get("plates") or []]
    counts = {lot: sum(1 for t in doc.get("transfers") or [] if t.get("plate") == lot) for lot in lots}
    if not plate:
        plate = max(counts, key=counts.get) if counts and max(counts.values()) else None
    if not plate or plate not in lots:
        raise model.ModelError("전사 시료가 있는 동판을 고르세요")
    lib = model.Library({**doc, "fits": None})
    basis = lib.basis
    space = space or choose_space(doc, mode, plate, basis)
    yn = float(lib.settings.get("yn", 1.0))
    samples, excluded, inks = collect(doc, mode, plate, space)
    inks = {n: v for n, v in inks.items() if v["kind"] != "none"}

    meas_issues = []
    seen = set()
    for smp in samples:
        meas_issues += diagnose_measurement(smp["measured"], mode, space, f"전사 시료 {smp['no']}번")
        if smp["sub_fp"] not in seen:
            seen.add(smp["sub_fp"])
            sub = lib.find_substrate(smp["substrate"]) if isinstance(smp["substrate"], str) else smp["substrate"]
            meas_issues += diagnose_measurement(sub, mode, space, f"바탕 {smp['substrate'] if isinstance(smp['substrate'], str) else '(직접 입력)'}")
    for n, v in inks.items():
        if v["kind"] == "free":
            meas_issues += diagnose_measurement(lib.inks[n]["cal"]["solid"], mode, space, f"{n} 은폐 도막")

    base = {"model_version": MODEL_VERSION, "mode": mode, "space": space, "basis": basis, "plate": plate, "yn": yn,
            "excluded": excluded, "measurement_issues": meas_issues,
            "snapshot": snapshot(doc, mode, plate)}
    if not samples:
        return {**base, "ok": False, "fixed_inks": [], "confidence": {"level": "부족", "reasons": ["계산할 수 있는 시료가 없습니다"]},
                "inks": {}, "plates": {}, "samples": [], "validation": [], "groups": [], "issues": [],
                "sensitivity": [], "assumptions": [], "applicability": {}}

    t0 = time.time()
    fit = _fit(samples, inks, space, mode, yn)
    rows = []
    for smp in samples:
        lab, fm, cov = predict_sample(smp, inks, fit, space, mode, yn)
        rows.append({"no": smp["no"], "ink": smp["ink"], "design": smp["design"], "coverage": round(cov, 4),
                     "measured_lab": [round(x, 2) for x in smp["lab"]], "pred_lab": [round(x, 2) for x in lab],
                     "pred_hex": cm.lab_to_hex(lab), "film_hex": cm.lab_to_hex(model.channels_to_lab(fm, space)),
                     "dE": round(cm.delta_e2000(lab, smp["lab"]), 3)})
    groups, issues = diagnose(samples, inks, space, mode, yn, fit)
    mean_fit = sum(r["dE"] for r in rows) / len(rows)
    if mean_fit > MISFIT_WARN:
        issues.append({"kind": "model_misfit", "level": "error" if mean_fit > MISFIT_ERROR else "warn",
                       "msg": f"맞춘 뒤에도 평균 ΔE {mean_fit:.2f} — 지금 모델 가정으로는 이 데이터를 설명하지 못합니다"
                              " (측정 조건·은폐 도막·바탕 값, 또는 모델 가정을 확인해야 함)"})
    validation = loo(samples, inks, space, mode, yn, fit)
    sens = sensitivity(samples, inks, space, mode, yn, fit, groups)
    level, reasons = _confidence(samples, groups, issues, validation, sens)
    fitted = {}
    for n in fit["free"]:
        k, s = ink_ks(inks[n], fit["theta"][n], space)
        fitted[n] = {"k": k, "s": s, "samples": sum(1 for x in samples if x["free"] == n), "theta": fit["theta"][n]}
    designs = sorted(fit["c"])
    assumptions = [
        f"막두께는 동판 {plate} 기준 상대값 (×1.00, µm 아님)" if fit["free"] else f"동판 {plate} 막두께는 측정 보정 잉크로 맞춤",
        "패치 = 바탕과 연속 전사막을 실효 덮임 비율로 섞은 평균" + (" (Yule–Nielsen n=1)" if yn == 1 else f" (Yule–Nielsen n={yn:g})"),
        "흡수/산란 비율은 은폐 도막에서, 산란 크기는 전사 시료에서"
        + (f" — 채널별 산란은 공통 값에서 벗어날수록 벌점 (세기 {SCATTER_PRIOR:g}, 벌점은 색 오차와 따로 표시)"
           if space != "spec" else " — 산란은 파장에 따라 로그-직선으로 변한다고 가정"),
        f"망점 곡선은 잰 망점({', '.join(f'{d * 100:g}%' for d in designs)}) 사이 직선, 그 밖은 0%·100%까지 직선 외삽 (가정)",
        "시료별 오차 가중치는 모두 같음 (반복 측정이 없어서)",
        "결과는 이 바탕·공정 조건에서만 검증됨 (아래 적용 범위)",
    ]
    applicability = {
        "substrates": sorted({s["substrate"] if isinstance(s["substrate"], str) else "(직접 입력)" for s in samples}),
        "tones": [designs[0], designs[-1]],
        "conditions": sorted({json.dumps([doc["transfers"][s["no"] - 1].get(k) for k in ("thinner_pct", "hardener_pct", "matting_pct")])
                              for s in samples}),
    }
    return {**base, "ok": True, "id": fingerprint([base["snapshot"], MODEL_VERSION, round(time.time())]),
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "seconds": round(time.time() - t0, 2),
            "inks": fitted, "fixed_inks": sorted(n for n, v in inks.items() if v["kind"] == "fixed"),
            "plates": {plate: {"thickness": fit["t"], "tone_curve": _curve(fit["c"])}},
            "sse": fit["sse"], "prior_penalty": fit["penalty"], "fit_dE_mean": round(mean_fit, 3), "samples": rows, "validation": validation, "groups": groups, "issues": issues,
            "sensitivity": sens, "confidence": {"level": level, "reasons": reasons},
            "assumptions": assumptions, "applicability": applicability}
