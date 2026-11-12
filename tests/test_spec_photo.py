#!/usr/bin/env python3
"""실물 크기 시편 사진 도구(tools/spec-photo) 계산 검사.

    python3 -m unittest tests.test_spec_photo -v
"""
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "spec-photo"))
import spec_photo_core as core  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


class GeometryTests(unittest.TestCase):
    def test_warp_plan_keeps_reference_aspect(self):
        # 사진에서 잰 가로·세로가 조금 달라도 결과 캔버스는 실물 비율(210:297)을 지킨다
        quad = [(0, 0), (1000, 0), (1000, 1400), (0, 1400)]
        wp = core.warp_plan(quad, (210, 297))
        w, h = wp["size"]
        self.assertAlmostEqual(w / h, 210 / 297, delta=0.01)
        self.assertGreater(wp["px_per_mm"], 0)

    def test_perspective_coeffs_map_output_back_to_source(self):
        # 사다리꼴(위가 좁은) 사진 → 직사각형으로 펴는 계수
        src = [(100, 0), (900, 0), (1000, 700), (0, 700)]
        W, H = core.warp_size(src)
        dst = [(0, 0), (W - 1, 0), (W - 1, H - 1), (0, H - 1)]
        c = core.perspective_coeffs(dst, src)
        self.assertEqual(len(c), 8)
        # 출력 (W-1,0) 는 입력 (900,0) 근처로 가야 한다
        x, y = W - 1, 0
        den = c[6] * x + c[7] * y + 1
        self.assertAlmostEqual((c[0] * x + c[1] * y + c[2]) / den, 900, delta=1.0)
        self.assertAlmostEqual((c[3] * x + c[4] * y + c[5]) / den, 0, delta=1.0)

    def test_degenerate_quad_raises(self):
        with self.assertRaises(ValueError):
            core.perspective_coeffs([(0, 0), (1, 0), (2, 0), (3, 0)],
                                    [(0, 0), (1, 0), (2, 0), (3, 0)])


class CropPlanTests(unittest.TestCase):
    def test_170x70_from_a4_needs_no_upscale(self):
        # A4(210×297mm)가 2400px 폭으로 찍혔다면 170×70mm 는 약 1943×566px
        quad = [(0, 0), (2400, 0), (2400, 3394), (0, 3394)]
        wp = core.warp_plan(quad, (210, 297))
        plan = core.plan_crop(wp["size"], (210, 297), (170, 70))
        self.assertFalse(plan["upscale"])
        self.assertAlmostEqual(plan["px"][0], 1943, delta=3)
        self.assertAlmostEqual(plan["px"][1], 800, delta=3)
        self.assertAlmostEqual(plan["dpi"][0], 290, delta=2)

    def test_upscale_is_reported_not_hidden(self):
        # 기준(A4)보다 큰 실물(300×120mm)을 요구하면 픽셀이 모자라 확대가 필요하다
        plan = core.plan_crop((400, 400), (210, 297), (300, 120))
        self.assertTrue(plan["upscale"])
        self.assertTrue(any("해상도 부족" in w for w in plan["warn"]))

    def test_170x70_inside_a4_never_needs_upscale(self):
        plan = core.plan_crop((400, 400), (210, 297), (170, 70))
        self.assertFalse(plan["upscale"])

    def test_crop_is_centered_and_clamped(self):
        plan = core.plan_crop((2000, 2000), (200, 200), (100, 100))
        x0, y0, x1, y1 = plan["out"]
        self.assertAlmostEqual(x0, 500, delta=2)
        self.assertAlmostEqual(y0, 500, delta=2)
        self.assertAlmostEqual(x1 - x0, 1000, delta=2)

    def test_offset_moves_window_and_clamps_at_edge(self):
        base = core.plan_crop((2000, 2000), (200, 200), (100, 100))
        moved = core.plan_crop((2000, 2000), (200, 200), (100, 100), offset_mm=(50, 0))
        self.assertGreater(moved["out"][0], base["out"][0])
        far = core.plan_crop((2000, 2000), (200, 200), (100, 100), offset_mm=(999, 999))
        self.assertEqual(far["out"][2], 2000)     # 오른쪽 끝에서 멈춘다


class ProcessTests(unittest.TestCase):
    def _photo(self):
        """가운데에 정확한 사각형을 그린 합성 사진 — 원근 보정 결과를 셀 수 있게."""
        im = Image.new("RGB", (1600, 1200), (250, 250, 250))
        d = ImageDraw.Draw(im)
        d.rectangle([200, 150, 1399, 1049], fill=(30, 30, 30))     # 1200×900 px 검은 사각형
        return im

    def test_rect_survives_warp_and_crop_size(self):
        im = self._photo()
        quad = [(200, 150), (1399, 150), (1399, 1049), (200, 1049)]
        out, plan = core.process(im, quad, (210, 157.5), (170, 70))
        self.assertFalse(plan["upscale"])
        self.assertAlmostEqual(out.size[0], 1200.0 * 170 / 210, delta=3)
        self.assertAlmostEqual(out.size[1], 900.0 * 70 / 157.5, delta=3)
        self.assertEqual(out.getpixel((out.size[0] // 2, out.size[1] // 2)), (30, 30, 30))

    def test_skewed_photo_becomes_rectangle(self):
        """위가 좁은 사다리꼴 사진도 펴면 직사각형이 된다 (검은 영역 비율로 확인)."""
        im = Image.new("RGB", (1600, 1200), (250, 250, 250))
        d = ImageDraw.Draw(im)
        d.polygon([(400, 150), (1200, 150), (1400, 1050), (200, 1050)], fill=(20, 20, 20))
        quad = [(400, 150), (1200, 150), (1400, 1050), (200, 1050)]
        out, plan = core.process(im, quad, (200, 200), (200, 200))   # 정사각 기준 → 정사각 출력
        w, h = out.size
        self.assertAlmostEqual(w / h, 1.0, delta=0.02)
        # 펴진 결과 가장자리도 검정이어야 한다(사다리꼴이 남아 있으면 흰 여백이 생긴다)
        for pt in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]:
            r, g, b = out.getpixel(pt)
            self.assertLess(r, 60, f"{pt} 가 검정이 아님: {(r, g, b)}")

    def test_save_with_dpi_writes_tag(self):
        im = self._photo().crop((0, 0, 300, 120))
        with tempfile.TemporaryDirectory() as td:
            png = os.path.join(td, "a.png")
            tif = os.path.join(td, "a.tif")
            core.save_with_dpi(im, png, 300, "PNG")
            core.save_with_dpi(im, tif, 300, "TIFF")
            self.assertAlmostEqual(Image.open(png).info.get("dpi", (0, 0))[0], 300, delta=1)
            self.assertAlmostEqual(Image.open(tif).info.get("dpi", (0, 0))[0], 300, delta=1)


if __name__ == "__main__":
    unittest.main()
