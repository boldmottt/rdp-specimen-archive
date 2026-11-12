"""실물 크기 시편 사진 만들기 — 계산 핵심 (화면 없이 검사 가능)

무엇을 하나
  · 사진에서 기준 사각형(시편 외곽 또는 A4 용지) 네 귀퉁이를 받아 **원근(투시)을 펴고**
  · 그 사각형의 실물 크기(mm)로 **mm당 픽셀(ppi)을 계산**한 뒤
  · 원하는 실물 크기(기본 170×70mm)로 잘라 **픽셀과 DPI 메타데이터를 함께** 저장한다.

원칙
  1. **업스케일하지 않는다** — 원본 해상도가 모자라면 경고만 하고, 기본은 원본 픽셀을 그대로 쓴다.
  2. mm↔px 환산은 가로·세로를 따로 계산한다(사진이 미세하게 찌그러진 경우까지 맞춤).
  3. 반환하는 이미지는 자르기만 하고 리샘플하지 않는다(원근 변환 1회만 보간).
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

from PIL import Image

Point = tuple[float, float]
Quad = Sequence[Point]


# ---------------------------------------------------------------- 기하
def quad_edges(quad: Quad) -> dict:
    """네 귀퉁이 → 위/아래/왼/오른 변 길이(px). quad 순서는 좌상·우상·우하·좌하."""
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = quad
    dist = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
    return {
        "top": dist((x0, y0), (x1, y1)),
        "right": dist((x1, y1), (x2, y2)),
        "bottom": dist((x3, y3), (x2, y2)),
        "left": dist((x0, y0), (x3, y3)),
    }


def warp_size(quad: Quad) -> tuple[int, int]:
    """원근을 폈을 때의 캔버스 크기(px) — 마주 보는 변의 평균(참고용)."""
    e = quad_edges(quad)
    return (max(1, int(round((e["top"] + e["bottom"]) / 2))),
            max(1, int(round((e["left"] + e["right"]) / 2))))


def warp_plan(quad: Quad, ref_mm: tuple[float, float]) -> dict:
    """원근을 편 캔버스의 크기와 mm당 픽셀.

    기준 사각형의 **실물 비율을 지키는 것**이 핵심이다. 사진에서 잰 가로·세로 픽셀을
    각각 mm 로 나누면 값이 조금씩 다른데(렌즈 왜곡·귀퉁이 오차), 그대로 쓰면 펴진 결과의
    비율이 실물과 어긋나 170×70 으로 잘라도 정확한 170:70 이 되지 않는다.
    그래서 두 값을 평균한 **하나의 px/mm** 로 캔버스를 만든다.
    """
    e = quad_edges(quad)
    wpx = (e["top"] + e["bottom"]) / 2
    hpx = (e["left"] + e["right"]) / 2
    ppm_x = wpx / ref_mm[0] if ref_mm[0] else 0
    ppm_y = hpx / ref_mm[1] if ref_mm[1] else 0
    if ppm_x <= 0 or ppm_y <= 0:
        raise ValueError("기준 실물 크기는 0보다 커야 합니다")
    ppm = (ppm_x + ppm_y) / 2
    return {
        "size": (max(1, int(round(ref_mm[0] * ppm))), max(1, int(round(ref_mm[1] * ppm)))),
        "px_per_mm": ppm,
        "anisotropy": abs(ppm_x - ppm_y) / ppm,   # 0에 가까울수록 좋다(찍힌 비율과 실물 비율이 일치)
    }


def perspective_coeffs(dst_quad: Quad, src_quad: Quad) -> tuple[float, ...]:
    """Pillow PERSPECTIVE 계수 8개.

    Pillow 의 transform 은 **출력 좌표 → 입력 좌표**로 사상하므로
    dst(펴진 사각형)를 src(사진 속 네 귀퉁이)로 보내는 계수를 만든다.
    """
    m = []
    for (dx, dy), (sx, sy) in zip(dst_quad, src_quad):
        m.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        m.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
    b = [c for (_, _), (sx, sy) in zip(dst_quad, src_quad) for c in (sx, sy)]
    # 가우스 소거(8x8) — 표준 라이브러리만 사용
    n = 8
    a = [row[:] + [b[i]] for i, row in enumerate(m)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            raise ValueError("네 점이 한 직선에 가깝습니다 — 귀퉁이를 다시 찍어 주세요")
        a[col], a[piv] = a[piv], a[col]
        pv = a[col][col]
        a[col] = [v / pv for v in a[col]]
        for r in range(n):
            if r == col:
                continue
            f = a[r][col]
            if f:
                a[r] = [rv - f * cv for rv, cv in zip(a[r], a[col])]
    return tuple(a[i][n] for i in range(n))


# ---------------------------------------------------------------- 크기 계산
def plan_crop(quad_px: tuple[int, int], ref_mm: tuple[float, float],
              target_mm: tuple[float, float], offset_mm: tuple[float, float] = (0.0, 0.0),
              center: bool = True) -> dict:
    """원근을 편 캔버스에서 '실물 target_mm' 만큼 잘라 낼 계획.

    반환: out(자를 픽셀 사각형) · ppi · upscale 여부 · 경고
    """
    W, H = quad_px
    # 캔버스가 기준 실물 비율로 만들어졌으므로 px/mm 는 하나 — 여기에 25.4를 곱하면 dpi
    ppm_x = W / float(ref_mm[0]) if ref_mm[0] else 0.0
    ppm_y = H / float(ref_mm[1]) if ref_mm[1] else 0.0
    need_w = target_mm[0] * ppm_x
    need_h = target_mm[1] * ppm_y

    if center:
        x = (W - need_w) / 2 + offset_mm[0] * ppm_x
        y = (H - need_h) / 2 + offset_mm[1] * ppm_y
    else:
        x = offset_mm[0] * ppm_x
        y = offset_mm[1] * ppm_y

    x = max(0.0, min(x, max(0.0, W - need_w)))
    y = max(0.0, min(y, max(0.0, H - need_h)))
    up = need_w > W + 0.5 or need_h > H + 0.5

    warn = []
    if up:
        warn.append(f"해상도 부족 — 필요 {int(round(need_w))}×{int(round(need_h))}px, "
                    f"사진에서 확보 가능한 크기 {W}×{H}px. 확대하면 흐려집니다")
    dpi_x = ppm_x * 25.4
    if 0 < dpi_x < 300:
        warn.append(f"사진 해상도가 낮습니다 (약 {dpi_x:.0f}dpi) — 300dpi 이상을 권장")

    box = (int(round(x)), int(round(y)),
           int(round(x + need_w)), int(round(y + need_h)))
    return {
        "out": box,
        "px": (box[2] - box[0], box[3] - box[1]),
        "px_per_mm": (round(ppm_x, 3), round(ppm_y, 3)),
        "dpi": (round(ppm_x * 25.4, 1), round(ppm_y * 25.4, 1)),
        "upscale": up,
        "warn": warn,
    }


# ---------------------------------------------------------------- 처리
def process(image: Image.Image, quad: Quad, ref_mm: tuple[float, float],
            target_mm: tuple[float, float], offset_mm: tuple[float, float] = (0.0, 0.0),
            allow_upscale: bool = False) -> tuple[Image.Image, dict]:
    """사진 + 네 귀퉁이 → 실물 크기로 자른 이미지(자르기만, 리샘플 없음)."""
    quad = [(float(x), float(y)) for x, y in quad]
    if len(quad) != 4:
        raise ValueError("귀퉁이는 네 점이어야 합니다")

    wp = warp_plan(quad, ref_mm)
    W, H = wp["size"]
    dst = [(0.0, 0.0), (float(W - 1), 0.0), (float(W - 1), float(H - 1)), (0.0, float(H - 1))]
    coeffs = perspective_coeffs(dst, quad)
    src = image.convert("RGB") if image.mode not in ("RGB", "L") else image
    flat = src.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC,
                         fillcolor=(255, 255, 255))

    plan = plan_crop((W, H), ref_mm, target_mm, offset_mm)
    x0, y0, x1, y1 = plan["out"]
    if plan["upscale"] and not allow_upscale:
        cropped = flat.crop((max(0, x0), max(0, y0), min(W, x1), min(H, y1)))
        plan["warn"].append("확대하지 않고 가능한 만큼만 잘랐습니다 — '확대 허용'을 켜면 요청한 크기로 만듭니다")
    elif plan["upscale"]:
        cropped = flat.resize(plan["px"], Image.LANCZOS)
    else:
        cropped = flat.crop((x0, y0, x1, y1))

    plan["px"] = cropped.size
    plan["mm"] = target_mm
    plan["warp"] = {"size": (W, H), "px_per_mm": round(wp["px_per_mm"], 3)}
    if wp["anisotropy"] > 0.04:
        plan["warn"].append(
            f"찍힌 사각형의 가로·세로 비율이 실물과 {wp['anisotropy'] * 100:.0f}% 다릅니다 — "
            "귀퉁이를 다시 찍거나 렌즈 왜곡(광각)을 확인하세요")
    return cropped, plan


def save_with_dpi(img: Image.Image, path: str, dpi: float, fmt: str = "PNG") -> None:
    """DPI 메타데이터를 넣어 저장 — 인디자인/일러스트에서 mm 크기로 바로 놓인다."""
    d = (round(dpi), round(dpi))
    if fmt.upper() == "TIFF":
        img.save(path, format="TIFF", dpi=d, compression="tiff_lzw")
    else:
        img.save(path, format="PNG", dpi=d)


def quad_from_frame(w: int, h: int) -> list[Point]:
    """자동 인식 실패 시 기본값 — 사진 전체."""
    return [(0.0, 0.0), (float(w - 1), 0.0), (float(w - 1), float(h - 1)), (0.0, float(h - 1))]


def suggest_quad(image: Image.Image) -> tuple[list[Point], str]:
    """사진에서 가장 큰 사각형(시편/용지) 귀퉁이를 대충 제안한다.

    numpy 가 있으면 Otsu 임계값으로 배경/피사체를 나눈 뒤 영역의 극점 4개를 쓴다.
    없거나 애매하면 사진 전체를 돌려주고 이유를 함께 알려 준다(사용자가 확인·조정).
    """
    try:
        import numpy as np
    except Exception:
        return quad_from_frame(*image.size), "자동 인식 없음(numpy 미설치) — 네 귀퉁이를 찍어 주세요"

    im = image.convert("L")
    scale = 700 / max(im.size)
    small = im.resize((max(8, int(im.width * scale)), max(8, int(im.height * scale))), Image.BILINEAR)
    a = np.asarray(small, dtype=np.float32)

    # Otsu
    hist, _ = np.histogram(a, bins=256, range=(0, 255))
    total = a.size
    sum_all = float((np.arange(256) * hist).sum())
    sum_b = 0.0
    w_b = 0.0
    best = (-1.0, 128)
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
        if between > best[0]:
            best = (between, t)
    thr = best[1]
    mask = a > thr
    if mask.mean() < 0.02 or mask.mean() > 0.98:
        return quad_from_frame(*image.size), "자동 인식 애매 — 사진 전체로 두었습니다(직접 찍어 주세요)"

    ys, xs = np.nonzero(mask)
    if len(xs) < 30:
        return quad_from_frame(*image.size), "자동 인식 애매 — 사진 전체로 두었습니다"

    pts = np.stack([xs, ys], axis=1).astype(np.float32)
    s = pts.sum(axis=1)
    d = pts[:, 0] - pts[:, 1]
    corners = [pts[np.argmin(s)], pts[np.argmax(d)], pts[np.argmax(s)], pts[np.argmin(d)]]
    inv = 1 / scale if scale else 1
    quad = [(float(px) * inv, float(py) * inv) for px, py in corners]
    return quad, "자동 제안 — 네 귀퉁이를 확인하고 필요하면 끌어서 맞추세요"
