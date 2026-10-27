"""Kubelka–Munk 2상수 모델 — 바탕 위 얇은 잉크 막 (패드 인쇄의 비침).

채널(분광 31개 또는 선형 RGB 3개)마다 독립으로 계산한다.
  - 표면 반사: Saunderson 보정 (SCI는 정반사 포함 k1=0.04, SCE는 k1=0)
  - 막: 흡수 KX · 산란 SX (X = 막 두께가 곱해진 값)
  - 바탕 위 유한 두께 막의 반사율 (Kubelka 1948)
외부 라이브러리 없이 math만 쓴다.
"""
import math

K2 = 0.6                      # 내부 반사 (Saunderson k2)
K1 = {"sci": 0.04, "sce": 0.0}  # 외부 정반사 (SCI는 포함, SCE는 제외)
R_MIN, R_MAX = 1e-4, 0.9995


def clamp(r, lo=R_MIN, hi=R_MAX):
    return lo if r < lo else hi if r > hi else r


def to_internal(rm, mode="sci", k2=K2):
    """측정 반사율 → 막 내부 반사율."""
    k1 = K1[mode]
    rm = clamp(rm)
    return clamp((rm - k1) / (1 - k1 - k2 + k2 * rm))


def to_measured(ri, mode="sci", k2=K2):
    k1 = K1[mode]
    ri = clamp(ri)
    return k1 + (1 - k1) * (1 - k2) * ri / (1 - k2 * ri)


def layer(rg, kx, sx):
    """바탕(내부 반사율 rg) 위에 흡수 kx · 산란 sx인 막을 올렸을 때의 내부 반사율."""
    kx = max(kx, 0.0)
    sx = max(sx, 0.0)
    if sx < 1e-9:                                   # 순수 흡수 막 (투명 착색)
        return clamp(rg * math.exp(-2.0 * kx))
    a = 1.0 + kx / sx
    b = math.sqrt(max(a * a - 1.0, 0.0))
    x = b * sx
    if x < 1e-4:                                    # b·SX → 0 극한 (coth ≈ 1/x + x/3)
        bcoth = 1.0 / sx + b * b * sx / 3.0
    elif x > 20:
        bcoth = b
    else:
        bcoth = b / math.tanh(x)
    return clamp((1.0 - rg * (a - bcoth)) / (a - rg + bcoth))


def r_inf(kx, sx):
    """무한히 두꺼운 막의 반사율 (은폐 완전)."""
    if sx < 1e-12:
        return R_MIN
    a = 1.0 + kx / sx
    return clamp(a - math.sqrt(max(a * a - 1.0, 0.0)))


# ---------------------------------------------------------------- 최적화 (Nelder–Mead)
def nelder_mead(f, x0, step=0.5, iters=400, tol=1e-10, xtol=1e-6):
    """멈춤 조건: 꼭짓점들의 값 차이 < tol 이면서 꼭짓점들이 xtol 안으로 모였을 때.
    (값만 보면 시작 꼭짓점들의 값이 우연히 같을 때 곧바로 멈춰 버린다)"""
    n = len(x0)
    pts = [list(x0)]
    for i in range(n):
        p = list(x0)
        p[i] += step if isinstance(step, (int, float)) else step[i]
        pts.append(p)
    vals = [f(p) for p in pts]
    for _ in range(iters):
        order = sorted(range(n + 1), key=lambda i: vals[i])
        pts = [pts[i] for i in order]
        vals = [vals[i] for i in order]
        if abs(vals[-1] - vals[0]) < tol and max(abs(p[j] - pts[0][j]) for p in pts[1:] for j in range(n)) < xtol:
            break
        cen = [sum(p[j] for p in pts[:-1]) / n for j in range(n)]
        xr = [cen[j] + (cen[j] - pts[-1][j]) for j in range(n)]
        fr = f(xr)
        if fr < vals[0]:
            xe = [cen[j] + 2 * (cen[j] - pts[-1][j]) for j in range(n)]
            fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = [cen[j] + 0.5 * (pts[-1][j] - cen[j]) for j in range(n)]
            fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                for i in range(1, n + 1):
                    pts[i] = [pts[0][j] + 0.5 * (pts[i][j] - pts[0][j]) for j in range(n)]
                    vals[i] = f(pts[i])
    i = min(range(n + 1), key=lambda i: vals[i])
    return pts[i], vals[i]


def golden(f, lo, hi, iters=60):
    g = (math.sqrt(5) - 1) / 2
    a, b = lo, hi
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = f(c), f(d)
    for _ in range(iters):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = f(d)
    return (a + b) / 2


# ---------------------------------------------------------------- 잉크 막 역산
def fit_channel(prints, rinf=None):
    """한 채널: 바탕 위에 같은 막을 찍어 잰 값들 [(바탕 내부 반사율, 찍은 곳 내부 반사율), …]과
    솔리드(은폐, 내부 반사율 R∞ — 흡수/산란 비율만 알려 줌)로 막의 (kx, sx)를 역산한다.
    얇게 찍은 것 1개 + 솔리드, 또는 서로 다른 바탕 2개 이상이 있어야 둘 다 정해진다.
    반환: (kx, sx, 잔차)."""
    def err(p):
        kx, sx = math.exp(p[0]), math.exp(p[1])
        e = sum((layer(g, kx, sx) - r) ** 2 for g, r in prints)
        if rinf is not None:
            e += (r_inf(kx, sx) - rinf) ** 2
        return e

    best = None
    for s0 in (0.02, 0.2, 1.0, 5.0):
        for k0 in (0.005, 0.1, 1.0, 5.0):
            p, v = nelder_mead(err, [math.log(k0), math.log(s0)], step=1.0, iters=300, tol=1e-16)
            if best is None or v < best[1]:
                best = (p, v)
    kx, sx = math.exp(best[0][0]), math.exp(best[0][1])
    m = len(prints) + (rinf is not None)
    return kx, sx, math.sqrt(best[1] / m)


def calibrate_channel(rg_w, rg_b, r_w, r_b):
    """흰 바탕(rg_w)·검정 바탕(rg_b) 위에 같은 막을 찍어 잰 값(r_w, r_b) → (kx, sx, 잔차)."""
    return fit_channel([(rg_w, r_w), (rg_b, r_b)])


# ---------------------------------------------------------------- 망점
def dot_gamma(dot50):
    """'50% 망점이 실제로 덮는 비율' → 퍼짐 곡선 지수 (실효 = 1 − (1 − 설계)^γ)."""
    return math.log(1.0 - dot50) / math.log(0.5)


def effective_tone(c, gamma=1.0):
    """설계 망점 비율 c(0~1) → 실제로 덮는 비율 (0%·100%는 그대로, 중간이 퍼진다)."""
    c = min(1.0, max(0.0, float(c)))
    return 1.0 - (1.0 - c) ** gamma
