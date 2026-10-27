"""색 계산 기초 — CIELAB · XYZ · 선형 RGB · ΔE · 분광 → LAB.

모두 D65 기준이다. 분광 데이터는 400~700 nm, 10 nm 간격(31개 값, 반사율 0~1)을 받는다.
분광 → XYZ는 CIE 1931 2° 관찰자 + D65로 계산한다 (측색기가 10° 관찰자로 LAB를 보여 주면
값이 조금 다를 수 있으므로, 측색기가 준 LAB가 있으면 그 값을 우선한다).
"""
import math

# D65 / 2° 백색점 (XYZ, Y=100)
WHITE = (95.047, 100.0, 108.883)

# 선형 sRGB(D65) ↔ XYZ (Y=1 기준)
_M_RGB2XYZ = ((0.4124564, 0.3575761, 0.1804375),
              (0.2126729, 0.7151522, 0.0721750),
              (0.0193339, 0.1191920, 0.9503041))
_M_XYZ2RGB = ((3.2404542, -1.5371385, -0.4985314),
              (-0.9692660, 1.8760108, 0.0415560),
              (0.0556434, -0.2040259, 1.0572252))

WAVELENGTHS = tuple(range(400, 701, 10))   # 31개

# CIE 1931 2° 등색 함수 (400~700 nm, 10 nm)
_CMF = (
    (0.01431, 0.000396, 0.06785), (0.04351, 0.00121, 0.2074), (0.13438, 0.004, 0.6456),
    (0.2839, 0.0116, 1.3856), (0.34828, 0.023, 1.74706), (0.3362, 0.038, 1.77211),
    (0.2908, 0.06, 1.6692), (0.19536, 0.09098, 1.28764), (0.09564, 0.13902, 0.81295),
    (0.03201, 0.20802, 0.46518), (0.0049, 0.323, 0.272), (0.0093, 0.503, 0.1582),
    (0.06327, 0.71, 0.07825), (0.1655, 0.862, 0.04216), (0.2904, 0.954, 0.0203),
    (0.43345, 0.99495, 0.00875), (0.5945, 0.995, 0.0039), (0.7621, 0.952, 0.0021),
    (0.9163, 0.87, 0.00165), (1.0263, 0.757, 0.0011), (1.0622, 0.631, 0.0008),
    (1.0026, 0.503, 0.00034), (0.85445, 0.381, 0.00019), (0.6424, 0.265, 0.00005),
    (0.4479, 0.175, 0.00002), (0.2835, 0.107, 0.0), (0.1649, 0.061, 0.0),
    (0.0874, 0.032, 0.0), (0.04677, 0.017, 0.0), (0.0227, 0.00821, 0.0),
    (0.011359, 0.004102, 0.0),
)
# CIE 표준광 D65 상대 분광 분포 (400~700 nm, 10 nm)
_D65 = (82.7549, 91.486, 93.4318, 86.6823, 104.865, 117.008, 117.812, 114.861, 115.923, 108.811,
        109.354, 107.802, 104.79, 107.689, 104.405, 104.046, 100.0, 96.3342, 95.788, 88.6856,
        90.0062, 89.5991, 87.6987, 83.2886, 83.6992, 80.0268, 80.2146, 82.2778, 78.2842, 69.7213,
        71.6091)
_K = 100.0 / sum(s * c[1] for s, c in zip(_D65, _CMF))


# ---------------------------------------------------------------- LAB ↔ XYZ
def _f(t):
    d = 6.0 / 29.0
    return t ** (1.0 / 3.0) if t > d ** 3 else t / (3 * d * d) + 4.0 / 29.0


def _finv(t):
    d = 6.0 / 29.0
    return t ** 3 if t > d else 3 * d * d * (t - 4.0 / 29.0)


def xyz_to_lab(xyz, white=WHITE):
    fx, fy, fz = (_f(v / w) for v, w in zip(xyz, white))
    return (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))


def lab_to_xyz(lab, white=WHITE):
    L, a, b = lab
    fy = (L + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0
    return tuple(w * _finv(f) for f, w in zip((fx, fy, fz), white))


# ---------------------------------------------------------------- 선형 RGB (모델용 3채널 반사율)
def _mul(m, v):
    return tuple(sum(m[i][j] * v[j] for j in range(3)) for i in range(3))


def lab_to_rgb_lin(lab):
    """LAB → 선형 sRGB (0~1). 색역 밖이면 0 미만·1 초과가 나올 수 있다."""
    return _mul(_M_XYZ2RGB, tuple(x / 100.0 for x in lab_to_xyz(lab)))


def rgb_lin_to_lab(rgb):
    return xyz_to_lab(tuple(100.0 * x for x in _mul(_M_RGB2XYZ, rgb)))


def lab_to_hex(lab):
    """화면 견본용 sRGB 16진수 (감마 적용, 색역 밖은 잘라냄)."""
    out = []
    for c in lab_to_rgb_lin(lab):
        c = min(1.0, max(0.0, c))
        c = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
        out.append(int(round(c * 255)))
    return "#%02x%02x%02x" % tuple(out)


def in_gamut(lab, tol=0.002):
    return all(-tol <= c <= 1 + tol for c in lab_to_rgb_lin(lab))


# ---------------------------------------------------------------- 3채널 계산 기저
# 분광이 없을 때 반사율을 채널 3개로 근사한다.
#   xyz  — X/Xn, Y/Yn, Z/Zn. 실제 반사율이면 언제나 0 이상이라 진한 노랑·파랑도 잘리지 않는다 (기본).
#   srgb — 선형 sRGB. 화면 색역 밖 색(진한 노랑 등)은 음수가 나와 계산에서 잘린다 (예전 방식).
BASES = ("xyz", "srgb")


def lab_to_tri(lab, basis="xyz"):
    if basis == "srgb":
        return lab_to_rgb_lin(lab)
    return tuple(v / w for v, w in zip(lab_to_xyz(lab), WHITE))


def tri_to_lab(t, basis="xyz"):
    if basis == "srgb":
        return rgb_lin_to_lab(t)
    return xyz_to_lab(tuple(v * w for v, w in zip(t, WHITE)))


# ---------------------------------------------------------------- 분광
def spectrum_to_xyz(refl):
    """반사율 31개(400~700 nm) → XYZ (D65, 2°)."""
    if len(refl) != len(WAVELENGTHS):
        raise ValueError(f"분광값은 {len(WAVELENGTHS)}개(400~700 nm, 10 nm 간격)여야 합니다")
    return tuple(_K * sum(r * s * c[i] for r, s, c in zip(refl, _D65, _CMF)) for i in range(3))


def spectrum_to_lab(refl):
    # 400~700 nm·10 nm 표로 계산한 백색점을 기준으로 해야 무채색이 a=b=0이 된다
    return xyz_to_lab(spectrum_to_xyz(refl), _SPECTRAL_WHITE)


_SPECTRAL_WHITE = None


def white_point_check():
    """등색 함수·광원 표가 맞는지 확인용 (완전 반사 → 백색점)."""
    return spectrum_to_xyz([1.0] * len(WAVELENGTHS))


# ---------------------------------------------------------------- 색차
def delta_e76(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def delta_e2000(lab1, lab2, kL=1.0, kC=1.0, kH=1.0):
    """CIEDE2000 (Sharma, Wu, Dalal 2005 구현)."""
    L1, a1, b1 = lab1
    L2, a2, b2 = lab2
    C1 = math.hypot(a1, b1)
    C2 = math.hypot(a2, b2)
    Cb = (C1 + C2) / 2.0
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25.0 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360 if C1p else 0.0
    h2p = math.degrees(math.atan2(b2, a2p)) % 360 if C2p else 0.0
    dLp = L2 - L1
    dCp = C2p - C1p
    if C1p * C2p == 0:
        dhp = 0.0
    else:
        dhp = h2p - h1p
        if dhp > 180:
            dhp -= 360
        elif dhp < -180:
            dhp += 360
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2))
    Lbp = (L1 + L2) / 2.0
    Cbp = (C1p + C2p) / 2.0
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    elif h1p + h2p < 360:
        hbp = (h1p + h2p + 360) / 2
    else:
        hbp = (h1p + h2p - 360) / 2
    T = (1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp))
         + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63)))
    dtheta = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25.0 ** 7))
    Sl = 1 + (0.015 * (Lbp - 50) ** 2) / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dtheta)) * Rc
    return math.sqrt((dLp / (kL * Sl)) ** 2 + (dCp / (kC * Sc)) ** 2 + (dHp / (kH * Sh)) ** 2
                     + Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)))


def lab_parts(ref, sample):
    """사람이 읽는 차이: dL(밝기) · dC(채도) · dH(색상) · da · db."""
    L1, a1, b1 = ref
    L2, a2, b2 = sample
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    da, db, dL, dC = a2 - a1, b2 - b1, L2 - L1, C2 - C1
    dH2 = max(0.0, da * da + db * db - dC * dC)
    h = (math.degrees(math.atan2(b2, a2)) - math.degrees(math.atan2(b1, a1))) % 360
    sign = 1 if h < 180 else -1
    return {"dL": dL, "da": da, "db": db, "dC": dC, "dH": sign * math.sqrt(dH2)}


def describe(parts, tol=0.3):
    """dL·da·db를 현장 말로: '밝음 1.2 · 붉음 0.4 · 푸름 0.8'."""
    out = []
    for key, pos, neg in (("dL", "밝음", "어두움"), ("da", "붉음", "녹색"), ("db", "노랑", "푸름")):
        v = parts[key]
        if abs(v) >= tol:
            out.append(f"{pos if v > 0 else neg} {abs(v):.1f}")
    return " · ".join(out) or "거의 같음"


_SPECTRAL_WHITE = white_point_check()
