#!/usr/bin/env python3
"""컬러연구소 테스트 — 색 계산 · K-M 엔진 · 라이브러리 저장 · API.  python3 -m unittest discover -s tests -v

합성 데이터(colorlab/synth.py)는 '진짜' 잉크값을 알고 있으므로, 엔진이 측색 LAB만 보고
그 값을 되찾는지 확인한다.
"""
import http.client
import json
import math
import os
import shutil
import sys
import tempfile
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402
from colorlab import api, colormath as cm, fit, km, model, synth  # noqa: E402

PCT = {"hardener_pct": 20, "thinner_pct": 30, "matting_pct": 0}


def recipe(inks, h=20, t=30):
    tot = sum(inks.values())
    return {"inks": inks, "hardener": {"g": tot * h / 100}, "thinner": {"g": tot * t / 100}}


class InkIdentityTests(unittest.TestCase):
    def registry(self, **fields):
        return model.InkRegistry([dict(name="200YE-D", short_name="YE-D",
                                       aliases=["Yellow D"], **fields)])

    def test_alias_resolution_and_sum(self):
        r = self.registry()
        self.assertEqual(r.resolve(" yellow d ", True), "200YE-D")
        self.assertEqual(r.normalize({"ye-d": 10, "200YE-D": 5}, True), {"200YE-D": 15})
        with self.assertRaises(model.ModelError):
            r.resolve("200YE", True)

    def test_identity_collisions(self):
        for other in ({"name": "ye-d"}, {"name": "B", "short_name": "YE-D"},
                      {"name": "B", "aliases": ["yellow D"]}):
            with self.subTest(other=other), self.assertRaises(model.ModelError):
                model.InkRegistry([{"name": "200YE-D", "short_name": "YE-D", "aliases": ["Yellow D"]}, other])
        with self.assertRaises(model.ModelError):
            model.InkRegistry([{"name": "A", "db_ink": "YE-D"}, {"name": "B", "db_ink": "YE-D"}])

    def test_db_mapping_is_explicit(self):
        with self.assertRaises(model.ModelError):
            self.registry().to_db({"YE-D": 10})
        r = self.registry(db_ink="YE-D")
        self.assertEqual(r.to_db({"YE-D": 10, "200YE-D": 5}), {"YE-D": 15})
        self.assertEqual(r.from_db({"YE-D": 15}), {"200YE-D": 15})
        self.assertEqual(model.InkRegistry().to_db({"BK": 10}), {"BK": 10})
        with self.assertRaises(model.ModelError):
            model.InkRegistry([{"name": "BK", "db_ink": ""}]).to_db({"BK": 10})

    def test_bad_quantities(self):
        for value in (-1, float("nan"), float("inf"), True, "bad"):
            with self.subTest(value=value), self.assertRaises(model.ModelError):
                self.registry().normalize({"YE-D": value})
        self.assertEqual(self.registry().normalize({"unknown": 0}, True), {})

    def test_library_roundtrip_and_catalog(self):
        doc = {"inks": [{"name": "200YE-D", "short_name": "YE-D", "aliases": ["Yellow D"],
                         "db_ink": "YE-D", "cal": {"solid": {"sci": [80, 1, 70], "sce": [75, 2, 65]}}}]}
        with tempfile.TemporaryDirectory() as root:
            status, _ = api.save_library(root, os.path.join(root, "backup"), doc, "")
            self.assertEqual(status, 200)
            loaded = api.load_library(root)
            self.assertEqual(loaded["inks"][0]["aliases"], ["Yellow D"])
            cat = api.ink_catalog(loaded)
            self.assertEqual(cat["lookup"]["ye-d"], "200YE-D")
            self.assertEqual(cat["inks"][0]["swatches"]["sce"]["lab"], [75, 2, 65])
            self.assertEqual(cat["inks"][0]["db_ink"], "YE-D")

    def test_preview_alias_equivalence_and_no_mutation(self):
        doc = synth.library()
        next(i for i in doc["inks"] if i["name"] == "YE").update(short_name="Y", aliases=["Yellow"])
        lib = model.Library(doc)
        a = {"recipe": recipe({"Y": 10, "YE": 5}), "substrate": "C 1000", "tone": 70}
        before = json.dumps(a, sort_keys=True)
        for mode in ("sci", "sce"):
            out = api.recipe_preview(lib, doc, a, mode)
            expected = model.predict(lib, "C 1000", recipe({"YE": 15}), mode=mode, coverage={"1도": .7})
            self.assertEqual(out["average"]["lab"], expected["average"]["lab"])
            self.assertEqual(out["ingredients"], [{"name": "YE", "g": 15, "pct": 100}])
        self.assertEqual(json.dumps(a, sort_keys=True), before)

    def test_preview_requires_calibration_and_conditions(self):
        doc = synth.library()
        lib = model.Library(doc)
        body = {"recipe": recipe({"Y2": 10}), "substrate": "흰 카드", "tone": 70}
        with self.assertRaisesRegex(model.ModelError, "계산 준비 안 됨"):
            api.recipe_preview(lib, doc, body, "sci")
        body["recipe"] = recipe({"YE": 10})
        for key in ("tone", "substrate"):
            with self.subTest(key=key), self.assertRaises(model.ModelError):
                api.recipe_preview(lib, doc, {k: v for k, v in body.items() if k != key}, "sci")
        with self.assertRaises(model.ModelError):
            api.recipe_preview(lib, doc, dict(body, recipe={"inks": {"YE": 10}}), "sci")
        with self.assertRaises(model.ModelError):
            api.recipe_preview(lib, doc, dict(body, plate="unknown"), "sci")

    def test_profile_collect_resolves_split_aliases(self):
        doc = synth.library()
        samples, excluded, inks = fit.collect(doc, "sci", "DEMO_002", "xyz")
        next(i for i in doc["inks"] if i["name"] == "Y2")["short_name"] = "Y-two"
        for t in doc["transfers"]:
            amounts = t["layer1"]["inks"]
            if "Y2" in amounts:
                amounts["Y-two"] = amounts["Y2"] / 2
                amounts["Y2"] /= 2
        got, skipped, resolved = fit.collect(doc, "sci", "DEMO_002", "xyz")
        self.assertEqual(got, samples)
        self.assertEqual(skipped, excluded)
        self.assertEqual(resolved, inks)


class ColorMathTests(unittest.TestCase):
    def test_ciede2000_sharma_pairs(self):
        pairs = [((50, 2.6772, -79.7751), (50, 0, -82.7485), 2.0425),
                 ((50, 3.1571, -77.2803), (50, 0, -82.7485), 2.8615),
                 ((50, 2.5, 0), (50, 0, -2.5), 4.3065),
                 ((50, 2.5, 0), (56, -27, -3), 31.9030),
                 ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
                 ((22.7233, 20.0904, -46.694), (23.0331, 14.973, -42.5619), 2.0373),
                 ((2.0776, 0.0795, -1.135), (0.9033, -0.0636, -0.5514), 0.9082)]
        for a, b, want in pairs:
            self.assertAlmostEqual(cm.delta_e2000(a, b), want, places=3)

    def test_lab_rgb_round_trip_and_gray_spectrum(self):
        for lab in ((50, 10, -20), (80, -5, 30), (30, 0, 0)):
            back = cm.rgb_lin_to_lab(cm.lab_to_rgb_lin(lab))
            self.assertLess(cm.delta_e76(lab, back), 1e-4)   # 행렬 유효숫자 7자리
        L, a, b = cm.spectrum_to_lab([0.5] * 31)
        self.assertAlmostEqual(L, 76.0693, places=3)
        self.assertLess(abs(a) + abs(b), 1e-6)

    def test_describe(self):
        self.assertEqual(cm.describe(cm.lab_parts((50, 0, 0), (51.2, 0.1, -0.8))), "밝음 1.2 · 푸름 0.8")
        self.assertEqual(cm.describe(cm.lab_parts((50, 0, 0), (50, 0, 0))), "거의 같음")


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lib = model.Library(synth.library())

    def test_calibration_recovers_truth(self):
        kx, sx = 0.8, 1.7
        rw, rb = 0.85, 0.05
        k, s, res = km.calibrate_channel(rw, rb, km.layer(rw, kx, sx), km.layer(rb, kx, sx))
        self.assertAlmostEqual(k, kx, places=4)
        self.assertAlmostEqual(s, sx, places=4)
        self.assertLess(res, 1e-6)

    def test_predict_matches_truth_sci_and_sce(self):
        rec = recipe({"WH": 20, "YE": 6, "RD": 3})
        for mode in ("sci", "sce"):
            sub = synth._lab_mode((38.0, -0.6, -2.5), mode)
            r = model.predict(self.lib, "C 1000", rec, mode=mode)
            self.assertEqual(r["space"], "xyz")
            self.assertLess(cm.delta_e2000(r["regions"]["layer1"]["lab"], synth.true_color(sub, rec, mode)), 0.05)

    def test_two_layers_and_coverage(self):
        r = model.predict(self.lib, "C 1000", recipe({"WH": 30}), recipe({"BK": 5, "MT": 30}), plate="DEMO_001")
        self.assertEqual(set(r["regions"]), {"substrate", "layer1", "layer2", "overlap"})
        self.assertAlmostEqual(sum(r["average"]["weights"].values()), 1.0)
        # 흰 1도 위의 겹침은 바탕 위 2도 단독보다 밝다
        self.assertGreater(r["regions"]["overlap"]["lab"][0], r["regions"]["layer2"]["lab"][0])

    def test_direct_substrate_lab(self):
        a = model.predict(self.lib, "C 1000", recipe({"WH": 20}))
        b = model.predict(self.lib, {"sci": [38.0, -0.6, -2.5]}, recipe({"WH": 20}))
        self.assertEqual(a["regions"]["layer1"]["lab"], b["regions"]["layer1"]["lab"])

    def test_recommend_finds_truth(self):
        rec = recipe({"WH": 20, "YE": 6, "RD": 3})
        target = synth.true_color((72.0, -0.8, 1.5), rec)
        r = model.recommend(self.lib, target, "D 2000@경면", ["WH", "YE", "RD", "BK", "BL"], ink_total=29)
        best = r["candidates"][0]
        self.assertLess(best["dE"], 0.1)
        self.assertEqual(set(best["inks"]), {"WH", "YE", "RD"})
        self.assertAlmostEqual(best["inks"]["YE"], 6, delta=0.3)

    def test_correct_with_thickness_mismatch(self):
        cur = recipe({"WH": 20, "YE": 6, "RD": 3})
        goal = recipe({"WH": 20, "YE": 7, "RD": 2.5})
        thick = 1.3                       # 실제 동판은 모델보다 30% 두껍게 찍힌다
        measured = synth.true_color((72.0, -0.8, 1.5), cur, thick=thick)
        target = synth.true_color((72.0, -0.8, 1.5), goal, thick=thick)
        r = model.correct(self.lib, cur, measured, target, "D 2000@경면", change_weight=0.05)
        self.assertGreater(r["now"]["dE"], 1.0)
        after = synth.true_color((72.0, -0.8, 1.5), recipe(r["inks"]), thick=thick)
        self.assertLess(cm.delta_e2000(after, target), 0.5)
        self.assertIn("YE +", r["change_text"])

    def test_errors_are_model_errors(self):
        with self.assertRaises(model.ModelError):
            model.predict(self.lib, "없는코드", recipe({"WH": 1}))
        with self.assertRaises(model.ModelError):
            model.predict(self.lib, "C 1000", recipe({"없는잉크": 1}))
        with self.assertRaises(model.ModelError):
            model.predict(self.lib, "C 1000", {"inks": {}})


class SpectralTests(unittest.TestCase):
    """31채널 분광만 있는 라이브러리: 분광 계산 경로를 쓰고, 진짜값을 되찾는다."""

    def setUp(self):
        wl = cm.WAVELENGTHS
        bump = lambda c, w, h: [h * math.exp(-((x - c) / w) ** 2) for x in wl]  # noqa: E731
        self.truth = {"YE": ([0.05 + v for v in bump(430, 40, 3.0)], [0.6] * 31),
                      "BL": ([0.1 + v for v in bump(610, 60, 2.5)], [0.4] * 31)}
        white = [0.88] * 31
        black = [0.04] * 31
        self.sub = [0.30 + 0.002 * i for i in range(31)]
        h, t = 0.2, 0.3
        rel = (1 / (1 + h)) * model.film_thickness(1 + h, t)

        def on(bg, k, s):
            return [km.to_measured(km.layer(km.to_internal(bg[i]), k[i] * rel, s[i] * rel)) for i in range(31)]

        inks = []
        for name, (k, s) in self.truth.items():
            inks.append({"name": name, "cal": {"hardener_pct": 20, "thinner_pct": 30,
                                               "white_bg": {"sci_spec": white}, "black_bg": {"sci_spec": black},
                                               "on_white": {"sci_spec": on(white, k, s)},
                                               "on_black": {"sci_spec": on(black, k, s)}}})
        self.lib = model.Library({"inks": inks, "substrates": [{"code": "S", "sci_spec": self.sub}]})

    def test_spectral_predict(self):
        rec = recipe({"YE": 10, "BL": 3})
        r = model.predict(self.lib, "S", rec)
        self.assertEqual(r["space"], "spec")
        self.assertNotIn("note", r)
        # 진짜값으로 같은 막을 계산
        n = model.normalize_recipe(rec)
        solids = 13 + n["hardener"]
        rel = model.film_thickness(solids / 13, n["thinner"] / 13)
        k = [sum(g / solids * self.truth[nm][0][i] * rel for nm, g in n["inks"].items()) for i in range(31)]
        s = [sum(g / solids * self.truth[nm][1][i] * rel for nm, g in n["inks"].items()) for i in range(31)]
        true = [km.to_measured(km.layer(km.to_internal(self.sub[i]), k[i], s[i])) for i in range(31)]
        self.assertLess(cm.delta_e2000(r["regions"]["layer1"]["lab"], cm.spectrum_to_lab(true)), 0.05)

    def test_percent_spectra_are_scaled(self):
        lib = model.Library({"substrates": [{"code": "P", "sci_spec": [x * 100 for x in self.sub]}]})
        self.assertLess(cm.delta_e76(model.meas_lab(lib.find_substrate("P"), "sci"), cm.spectrum_to_lab(self.sub)), 1e-9)


class SolidAndPlateTests(unittest.TestCase):
    """솔리드(은폐) 측정 · 망점 퍼짐 · 동판 추정 · 전사 시료 맞추기."""

    def test_solid_plus_one_print_recovers_truth(self):
        doc = synth.library()
        for ink in doc["inks"]:
            if ink["name"] in synth.TRUTH:
                for k in ("black_bg", "on_black"):
                    ink["cal"].pop(k)
        lib = model.Library(doc)
        for name in ("WH", "YE", "BK", "BL"):
            for mode in ("sci", "sce"):
                p = lib.ink_params(name, mode, "xyz")
                self.assertEqual(p["used"], ["on_white", "solid"])
                for got, want in zip(p["k"] + p["s"], synth.TRUTH[name]["k"] + synth.TRUTH[name]["s"]):
                    self.assertAlmostEqual(got, want, delta=max(1e-3, want * 1e-3))

    def test_missing_measurements_explained(self):
        doc = synth.library()
        cal = doc["inks"][0]["cal"]
        for k in ("black_bg", "on_black", "solid"):
            cal.pop(k)
        with self.assertRaisesRegex(model.ModelError, "하나 더 필요"):
            model.Library(doc).ink_params("WH", "sci", "xyz")
        doc["inks"][0]["cal"] = {"solid": cal["white_bg"]}
        with self.assertRaisesRegex(model.ModelError, "은폐 도막만으로는.*보정 프로필"):
            model.Library(doc).ink_params("WH", "sci", "xyz")

    def test_effective_tone(self):
        self.assertEqual(km.effective_tone(0, 2), 0)
        self.assertEqual(km.effective_tone(1, 2), 1)
        self.assertAlmostEqual(km.effective_tone(0.5, km.dot_gamma(0.67)), 0.67)
        self.assertAlmostEqual(km.effective_tone(0.3, 1.0), 0.3)

    def test_plate_estimates_from_depth_and_lpi(self):
        doc = synth.library()
        doc["plates"][0].update(thickness=1.2, dot50=0.65)      # DEMO_001: 20 µm, 150 LPI
        lib = model.Library(doc)
        info = lib.plate_info("DEMO_002")                       # 25 µm, 150 LPI, 값 없음
        self.assertAlmostEqual(info["thickness"], 1.2 / 20 * 25)
        self.assertAlmostEqual(info["dot50"], 0.65)
        self.assertIn("부식 깊이", info["thickness_src"])
        self.assertIn("LPI 150", info["gain_src"])
        doc["plates"][1]["lpi"] = 200                            # LPI가 다르면 퍼짐은 추정 안 함
        self.assertEqual(model.Library(doc).plate_info("DEMO_002")["gain_src"], "퍼짐 없음")
        self.assertEqual(lib.plate_info("없는동판")["thickness"], 1.0)

    def test_predict_with_tone_matches_truth(self):
        doc = synth.library()
        doc["plates"][0].update(thickness=1.15, dot50=km.effective_tone(0.5, 1.6))
        lib = model.Library(doc)
        rec = recipe({"BL": 8, "WH": 20})
        for mode in ("sci", "sce"):
            r = model.predict(lib, "C 1000", rec, mode=mode, plate="DEMO_001", coverage={"1도": 0.4})
            want = synth.true_tone(synth._lab_mode((38.0, -0.6, -2.5), mode), rec, 0.4, mode, 1.15, 1.6)
            self.assertLess(cm.delta_e2000(r["average"]["lab"], want), 0.05)
            self.assertAlmostEqual(r["average"]["tone"]["1도"][1], km.effective_tone(0.4, 1.6), places=3)

    def test_recommend_and_correct_on_tone_patch(self):
        doc = synth.library()
        doc["plates"][0].update(thickness=1.15, dot50=km.effective_tone(0.5, 1.6))
        lib = model.Library(doc)
        rec = recipe({"WH": 20, "YE": 6, "RD": 3})
        target = synth.true_tone(synth.WHITE_CARD, rec, 0.6, "sci", 1.15, 1.6)
        r = model.recommend(lib, target, "흰 카드", ["WH", "YE", "RD"], ink_total=29, plate="DEMO_001", tone=0.6)
        self.assertLess(r["candidates"][0]["dE"], 0.1)
        self.assertIn("망점 60%", r["note"])
        cur = recipe({"WH": 20, "YE": 5, "RD": 3})
        measured = synth.true_tone(synth.WHITE_CARD, cur, 0.6, "sci", 1.15, 1.6)
        c = model.correct(lib, cur, measured, target, "흰 카드", plate="DEMO_001", tone=0.6, change_weight=0.05)
        self.assertLess(c["expected"]["dE"], 0.3)
        self.assertGreater(c["deltas"].get("YE", 0), 0.5)

    def test_describe_reports_plate_accuracy(self):
        doc = api.validate(synth.library())
        info = api.describe_library(doc)
        acc = info["plates"]["DEMO_001"]["accuracy"]["sci"]
        self.assertEqual(acc["n"], 9)
        self.assertGreater(acc["dE"], 1.0)                      # 아직 맞추기 전
        doc["plates"][0].update(thickness=1.15, dot50=km.effective_tone(0.5, 1.6))
        info = api.describe_library(doc)
        self.assertLess(info["plates"]["DEMO_001"]["accuracy"]["sci"]["dE"], 0.05)
        self.assertEqual(len(info["transfers"]), 13)
        self.assertIn("dE", info["transfers"][0]["sce"])


class FoundationTests(unittest.TestCase):
    """리뷰 반영: 최적화 조기 종료 · 3채널 기저 · 측정 진단."""

    def test_nelder_mead_equal_start_values(self):
        # 시작 꼭짓점 값이 우연히 모두 같아도 곧바로 멈추면 안 된다
        x, v = km.nelder_mead(lambda p: (p[0] - 0.5) ** 2 + 0.0 * p[1], [0.0, 0.0], step=1.0)
        self.assertAlmostEqual(x[0], 0.5, places=4)

    def test_xyz_basis_keeps_strong_yellow(self):
        yellow = (78.0, 18.0, 88.0)                    # 화면 sRGB 밖의 진한 노랑 (합성값)
        self.assertTrue(any(c < 0 for c in cm.lab_to_tri(yellow, "srgb")))
        t = cm.lab_to_tri(yellow, "xyz")
        self.assertTrue(all(0 <= c <= 1 for c in t))
        self.assertLess(cm.delta_e76(cm.tri_to_lab(t, "xyz"), yellow), 1e-9)

    def test_measurement_diagnosis_separates_display_and_channel(self):
        m = {"sci": [78.0, 18.0, 88.0]}
        kinds = {d["kind"] for d in fit.diagnose_measurement(m, "sci", "xyz", "노랑")}
        self.assertEqual(kinds, {"display_gamut_outside"})          # 표시 문제일 뿐 계산은 정상
        kinds = {d["kind"] for d in fit.diagnose_measurement(m, "sci", "srgb", "노랑")}
        self.assertIn("channel_model_invalid", kinds)               # sRGB 기저에서는 계산 문제
        dark = {"sci": [22.0, 0.5, 0.5]}                            # Y≈3.6% < SCI 정반사 가정 4%
        kinds = {d["kind"] for d in fit.diagnose_measurement(dark, "sci", "xyz", "검정")}
        self.assertIn("surface_model_incompatible", kinds)

    def test_predict_keeps_full_precision(self):
        lib = model.Library(synth.library())
        r = model.predict(lib, "C 1000", recipe({"WH": 20, "YE": 6}))
        self.assertNotEqual(r["regions"]["layer1"]["lab"][0], round(r["regions"]["layer1"]["lab"][0], 2))

    def test_transfer_sample_keeps_spectrum(self):
        t = {"substrate": "흰 카드", "layer1": {"inks": {"Y2": 60}, "tone": 80}, "thinner_pct": 30, "hardener_pct": 20,
             "measured": {"sci": [80, 5, 40], "sci_spec": [0.5] * 31}}
        smp = api.transfer_sample(t, "sci")
        self.assertEqual(smp["measured"]["sci_spec"], [0.5] * 31)
        self.assertEqual(smp["measured_lab"], [80.0, 5.0, 40.0])


class ProfileTests(unittest.TestCase):
    """보정 프로필: 은폐 도막 + 망점 패치로 잉크·동판을 함께 맞춘다."""

    def setUp(self):
        self.doc = api.validate(synth.library())

    def test_solid_only_ink_recovers_truth(self):
        r = fit.run_profile(self.doc, "sci", "DEMO_002")
        self.assertTrue(r["ok"])
        self.assertEqual(list(r["inks"]), ["Y2"])
        for got, want in zip(r["inks"]["Y2"]["s"], synth.SOLID_ONLY["Y2"]["s"]):
            self.assertAlmostEqual(got, want, delta=0.01)
        truth = dict((d, e) for d, e in synth.DEMO_PROFILE["curve"])
        for d, e in r["plates"]["DEMO_002"]["tone_curve"]:
            self.assertAlmostEqual(e, truth[d], delta=0.003)
        self.assertLess(r["fit_dE_mean"], 0.05)
        self.assertEqual(r["plates"]["DEMO_002"]["thickness"], 1.0)  # 기준 동판
        self.assertIn("상대값", r["assumptions"][0])

    def test_steep_curve_is_not_trusted_blindly(self):
        # 80%를 빼고 맞추면 60%·95% 사이 직선으로는 급하게 메워지는 80%를 못 맞춘다 → 정직하게 크게 나와야 함
        r = fit.run_profile(self.doc, "sci", "DEMO_002")
        v = {x["no"]: x for x in r["validation"]}
        no80 = next(x["no"] for x in r["samples"] if x["design"] == 0.8)
        self.assertGreater(v[no80]["dE"], 2.0)
        self.assertNotEqual(r["confidence"]["level"], "좋음")

    def test_measured_inks_fit_thickness_and_curve(self):
        r = fit.run_profile(self.doc, "sci", "DEMO_001")
        self.assertEqual(r["inks"], {})
        self.assertIn("WH", r["fixed_inks"])
        self.assertAlmostEqual(r["plates"]["DEMO_001"]["thickness"], synth.DEMO_PLATE["thick"], delta=0.01)
        for d, e in r["plates"]["DEMO_001"]["tone_curve"]:
            self.assertAlmostEqual(e, km.effective_tone(d, synth.DEMO_PLATE["gamma"]), delta=0.003)
        self.assertEqual(r["confidence"]["level"], "좋음")

    def test_loo_does_not_use_left_out_sample(self):
        doc = self.doc
        samples, _, inks = fit.collect(doc, "sci", "DEMO_002", "xyz")
        full = fit._fit(samples, inks, "xyz", "sci", 1.0)
        val = fit.loo(samples, inks, "xyz", "sci", 1.0, full)
        j = 1
        rest = samples[:j] + samples[j + 1:]
        f = fit._fit(rest, inks, "xyz", "sci", 1.0, warm=full, outer=30)
        lab, _, _ = fit.predict_sample(samples[j], inks, f, "xyz", "sci", 1.0, curve=fit._curve(f["c"]))
        self.assertAlmostEqual(val[j]["dE"], round(cm.delta_e2000(lab, samples[j]["lab"]), 3), places=3)

    def test_single_sample_ink_is_unevaluable(self):
        doc = self.doc
        doc["transfers"] = [t for t in doc["transfers"] if t["plate"] != "DEMO_002"] + synth.profile_transfers(tones=(80,))
        r = fit.run_profile(doc, "sci", "DEMO_002")
        self.assertEqual(r["validation"][0]["status"], "unevaluable")
        self.assertEqual(r["confidence"]["level"], "부족")
        self.assertIn("single_tone", {i["kind"] for i in r["issues"]})

    def test_physical_conflict_is_reported(self):
        doc = self.doc
        y2 = next(i for i in doc["inks"] if i["name"] == "Y2")
        y2["cal"]["solid"] = {"sci": [93.0, -1.0, 12.0], "sce": [92.0, -1.0, 12.5]}   # 은폐 도막이 패치보다 연함
        r = fit.run_profile(doc, "sci", "DEMO_002")
        self.assertIn("physical_conflict", {i["kind"] for i in r["issues"]})
        self.assertEqual(r["confidence"]["level"], "부족")

    def test_unidentifiable_when_substrate_equals_opaque(self):
        doc = self.doc
        y2 = next(i for i in doc["inks"] if i["name"] == "Y2")
        y2["cal"]["solid"] = json.loads(json.dumps(doc["settings"]["cards"]["white"]))
        r = fit.run_profile(doc, "sci", "DEMO_002")
        self.assertIn("unidentifiable_thickness", {i["kind"] for i in r["issues"]})

    def test_mixtures_and_two_layers_are_excluded_with_reason(self):
        doc = self.doc
        extra = json.loads(json.dumps(doc["transfers"][-1]))
        extra["layer1"]["inks"] = {"Y2": 50, "WH": 10}
        extra2 = json.loads(json.dumps(doc["transfers"][-1]))
        extra2["layer2"] = {"inks": {"BK": 5}, "tone": 100}
        doc["transfers"] += [extra, extra2]
        r = fit.run_profile(doc, "sci", "DEMO_002")
        reasons = {x["no"]: x["reason"] for x in r["excluded"]}
        self.assertEqual(len(r["samples"]), 5)                      # Y2 + WH 혼합: WH는 측정 보정이라 함께 쓸 수 있음
        self.assertIn("2도", reasons[len(doc["transfers"])])

    def test_spectral_profile(self):
        wl = cm.WAVELENGTHS
        k_over_s = [0.02 + 6.0 * math.exp(-((w - 430) / 45) ** 2) for w in wl]
        a, b = math.log(0.5), 0.4
        s_true = [math.exp(a + b * (w - 550) / 150) for w in wl]
        k_true = [r * x for r, x in zip(k_over_s, s_true)]
        paper = [0.86 - 0.0005 * i for i in range(31)]
        rinf = [km.to_measured(km.r_inf(k, s)) for k, s in zip(k_true, s_true)]
        w_, rel = 60 / 72, model.film_thickness(72 / 60, 18 / 60)
        transfers = []
        for tone, cov in ((95, 0.995), (80, 0.95), (60, 0.72), (40, 0.47)):
            f = [km.to_measured(km.layer(km.to_internal(p), k * w_ * rel, s * w_ * rel)) for p, k, s in zip(paper, k_true, s_true)]
            transfers.append({"date": "", "plate": "P", "substrate": "종이", "layer1": {"inks": {"Y": 60}, "tone": tone},
                              "thinner_pct": 30, "hardener_pct": 20, "matting_pct": 0,
                              "measured": {"sci_spec": [(1 - cov) * p + cov * x for p, x in zip(paper, f)]}})
        doc = api.validate({"inks": [{"name": "Y", "cal": {"solid": {"sci_spec": rinf}}}],
                            "substrates": [{"code": "종이", "sci_spec": paper}], "plates": [{"lot": "P"}],
                            "transfers": transfers})
        r = fit.run_profile(doc, "sci", "P")
        self.assertEqual(r["space"], "spec")
        self.assertLess(r["fit_dE_mean"], 0.05)
        self.assertAlmostEqual(r["inks"]["Y"]["s"][0], s_true[0], delta=0.01 * s_true[0])
        self.assertAlmostEqual(r["inks"]["Y"]["s"][-1], s_true[-1], delta=0.01 * s_true[-1])


class ProfileStoreTests(unittest.TestCase):
    """적용 · 재맞추기 필요 · 충돌 · 저장 유지."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lab-prof-")
        self.backup = os.path.join(self.dir, "_backup")
        api.save_library(self.dir, self.backup, synth.library(), "")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def ctx(self):
        return {"data": self.dir, "backup": self.backup, "patterns": lambda: [], "worklog": None,
                "rev": api.load_library(self.dir)["updatedAt"]}

    def preview(self, plate="DEMO_002"):
        st, j = api.handle("POST", "/api/lab/profile/preview", {}, {"mode": "sci", "plate": plate}, self.ctx())
        self.assertEqual(st, 200)
        return j

    def test_preview_does_not_change_predictions(self):
        before = api.load_library(self.dir)
        self.preview()
        self.assertEqual(api.load_library(self.dir), before)
        st, j = api.handle("POST", "/api/lab/predict", {}, {"substrate": "흰 카드", "layer1": recipe({"Y2": 60})}, self.ctx())
        self.assertEqual(st, 400)

    def test_apply_saves_snapshot_and_survives_reload(self):
        j = self.preview()
        st, r = api.handle("POST", "/api/lab/profile/apply", {}, {"mode": "sci", "plate": "DEMO_002", "snapshot": j["snapshot"]}, self.ctx())
        self.assertEqual(st, 200)
        doc = api.load_library(self.dir)
        run = doc["fits"]["active"]
        self.assertEqual(run["id"], r["id"])
        self.assertIn("transfers", run["snapshot"])
        self.assertEqual(fit.stale_reasons(run, doc), [])
        # 시료를 고치면 '재맞추기 필요' (자동으로 다시 계산하지는 않음)
        doc["transfers"][-1]["measured"]["sci"][0] += 1
        self.assertIn("전사 시료 수정", fit.stale_reasons(run, doc))
        doc["transfers"].append(json.loads(json.dumps(doc["transfers"][-1])))
        self.assertTrue(any("추가" in x for x in fit.stale_reasons(run, doc)))
        y2 = next(i for i in doc["inks"] if i["name"] == "Y2")
        y2["cal"]["solid"]["sci"][0] += 1
        self.assertIn("잉크(은폐 도막·측정) 변경", fit.stale_reasons(run, doc))
        # 이 동판 시료와 상관없는 바탕을 고친 건 영향 없음 (DEMO_002 시료는 모두 흰 카드)
        fresh = api.load_library(self.dir)
        fresh["substrates"][0]["sci"][0] += 1
        self.assertEqual(fit.stale_reasons(run, fresh), [])
        fresh["settings"]["cards"]["white"]["sci"][0] += 0.5
        self.assertIn("계산 설정·기본 카드값 변경", fit.stale_reasons(run, fresh))

    def test_apply_refuses_changed_input(self):
        j = self.preview()
        doc = api.load_library(self.dir)
        doc["transfers"][-1]["measured"]["sci"][0] += 2
        api.save_library(self.dir, self.backup, doc, doc["updatedAt"])
        st, r = api.handle("POST", "/api/lab/profile/apply", {}, {"mode": "sci", "plate": "DEMO_002", "snapshot": j["snapshot"]}, self.ctx())
        self.assertEqual(st, 409)
        self.assertIsNone(api.load_library(self.dir)["fits"]["active"])

    def test_low_confidence_needs_ack(self):
        doc = api.load_library(self.dir)
        doc["transfers"] = [t for t in doc["transfers"] if t["plate"] != "DEMO_002"] + synth.profile_transfers(tones=(80, 70, 60))
        api.save_library(self.dir, self.backup, doc, doc["updatedAt"])
        j = self.preview()
        self.assertEqual(j["run"]["confidence"]["level"], "낮음")             # 망점 범위 20%p
        body = {"mode": "sci", "plate": "DEMO_002", "snapshot": j["snapshot"]}
        st, r = api.handle("POST", "/api/lab/profile/apply", {}, body, self.ctx())
        self.assertEqual(st, 400)
        st, r = api.handle("POST", "/api/lab/profile/apply", {}, {**body, "ack_low": True}, self.ctx())
        self.assertEqual(st, 200)


class InputShapeTests(unittest.TestCase):
    """모양이 틀린 입력은 서버 오류(500)가 아니라 입력 오류(400) + 배합 추천 시간 제한."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lab-shape-")
        self.ctx = {"data": self.dir, "backup": os.path.join(self.dir, "_backup"), "patterns": lambda: [], "worklog": None, "rev": ""}

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_bad_library_shapes_are_400(self):
        bad_docs = [
            {"inks": 5}, {"inks": [{"name": "A", "cal": [1]}]}, {"substrates": ["x"]},
            {"plates": [{"lot": "L", "coverage": [1]}]}, {"settings": "x"}, {"settings": {"cards": [1]}},
            {"fits": {"active": {"mode": "sci", "space": "xyz", "plates": {"L": {"thickness": 1, "tone_curve": [1, 2]}}}}},
            {"transfers": [{"substrate": "S", "layer1": {"inks": {"A": 1}}, "layer2": "x", "measured": {"sci": [50, 0, 0]}}]},
        ]
        for doc in bad_docs:
            code, r = api.handle("PUT", "/api/lab/library", {}, doc, self.ctx)
            self.assertEqual(code, 400, (doc, r))
        self.assertFalse(os.path.exists(api.lib_path(self.dir)))     # 아무것도 쓰지 않음

    def test_bad_numbers_in_requests_are_400(self):
        api.save_library(self.dir, self.ctx["backup"], synth.library(), "")
        code, r = api.handle("POST", "/api/lab/recommend", {}, {"target": [50, 0, 0], "inks": ["WH"], "max_inks": "abc",
                                                               "substrate": "D 2000@경면"}, self.ctx)
        self.assertEqual(code, 400, r)

    def test_recommend_stops_at_time_limit_with_partial_results(self):
        lib = model.Library(synth.library())
        rec = recipe({"WH": 20, "YE": 6, "RD": 3})
        target = synth.true_color((72.0, -0.8, 1.5), rec)
        r = model.recommend(lib, target, "D 2000@경면", ["WH", "YE", "RD", "BK", "BL"], ink_total=29, time_limit=0)
        self.assertEqual(r["truncated"]["total"], 5 + 10 + 10)
        self.assertEqual(r["truncated"]["done"], 1)
        self.assertTrue(r["candidates"])
        self.assertIn("시간 제한", r["note"])
        self.assertNotIn("truncated", model.recommend(lib, target, "D 2000@경면", ["WH", "YE"], ink_total=29))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lab-test-")
        self.backup = os.path.join(self.dir, "_backup")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_save_load_conflict_backup(self):
        self.assertEqual(api.load_library(self.dir)["inks"], [])
        code, r = api.save_library(self.dir, self.backup, synth.library(), "")
        self.assertEqual(code, 200)
        doc = api.load_library(self.dir)
        self.assertEqual(doc["updatedAt"], r["savedAt"])
        self.assertEqual(len(doc["inks"]), 8)
        code, r2 = api.save_library(self.dir, self.backup, doc, "옛날값")
        self.assertEqual(code, 409)
        doc["updatedAt"] = "2000-01-01T00:00:00"   # 다음 저장이 다른 시각이 되도록
        with open(api.lib_path(self.dir), "w", encoding="utf-8") as f:
            json.dump(doc, f)
        code, _ = api.save_library(self.dir, self.backup, doc, "2000-01-01T00:00:00")
        self.assertEqual(code, 200)
        self.assertEqual(len([n for n in os.listdir(self.backup) if n.startswith("lab-library.")]), 1)

    def test_validation(self):
        good = synth.library()
        bad_cases = [
            ({"inks": [{"name": "A"}, {"name": "A"}]}, "중복"),
            ({"inks": [{"name": "A", "cal": {"on_white": {"sci": [50, 1]}}}]}, "세 값"),
            ({"inks": [{"name": "A", "cal": {"on_white": {"sci": [150, 1, 1]}}}]}, "L은 0~100"),
            ({"inks": [{"name": "A", "cal": {"on_white": {"sci_spec": [0.5] * 30}}}]}, "31개"),
            ({"substrates": [{"code": "C"}]}, "측정값이 필요"),
            ({"substrates": [{"code": "C", "surface": "반짝", "sci": [50, 0, 0]}]}, "표면은"),
            ({"plates": [{"lot": "1", "thickness": 0}]}, "0.05~20"),
            ({"plates": [{"lot": "1", "coverage": {"1도": 35}}]}, "0~1"),
            ({"settings": {"yn": 0.5}}, "Yule"),
            ({"settings": {"basis": "cmyk"}}, "기저"),
            ({"fits": {"active": {"mode": "sci", "space": "xyz", "plates": {}, "inks": {"A": {"k": [1], "s": [1]}}}}}, "형식"),
            ({"fits": {"active": {"mode": "sci", "space": "xyz", "plates": {"P": {"thickness": 1, "tone_curve": [[0.5, 1.4]]}}}}}, "망점 곡선"),
            ({"plates": [{"lot": "1", "dot50": 1.2}]}, "50% 망점"),
            ({"plates": [{"lot": "1", "lpi": 0}]}, "LPI"),
            ({"transfers": [{"substrate": "C", "layer1": {"inks": {}}, "measured": {"sci": [50, 0, 0]}}]}, "잉크 g이 없습니다"),
            ({"transfers": [{"substrate": "C", "layer1": {"inks": {"WH": 1}, "tone": 0}, "measured": {"sci": [50, 0, 0]}}]}, "망점 %"),
            ({"transfers": [{"substrate": "C", "layer1": {"inks": {"WH": 1}}}]}, "잰 값"),
            ({"transfers": [{"layer1": {"inks": {"WH": 1}}, "measured": {"sci": [50, 0, 0]}}]}, "바탕을 고르세요"),
        ]
        for doc, want in bad_cases:
            with self.assertRaises(model.ModelError) as cx:
                api.validate(doc)
            self.assertIn(want, str(cx.exception))
        clean = api.validate(good)
        self.assertEqual(len(clean["substrates"]), 4)
        self.assertEqual(len(clean["transfers"]), 13)
        self.assertNotIn("thickness", clean["plates"][0])                  # 비운 막두께는 비운 채로 (추정)
        self.assertNotIn("layer2", api.validate({"transfers": [dict(good["transfers"][0], layer2={"inks": {}})]})["transfers"][0])
        self.assertIn("cards", clean["settings"])

    def test_describe_library_refs(self):
        info = api.describe_library(synth.library())
        self.assertEqual([s["ref"] for s in info["substrates"]],
                         ["C 1000", "D 2000@경면", "D 2000@패브릭엠보", "BK-1", "흰 카드", "검정 카드"])
        wh = next(i for i in info["inks"] if i["name"] == "WH")
        self.assertTrue(wh["status"]["sci_tri"]["ok"])
        self.assertEqual(wh["status"]["sci_tri"]["source"], "measured")
        self.assertFalse(wh["status"]["sci_spec"]["ok"])
        y2 = next(i for i in info["inks"] if i["name"] == "Y2")
        self.assertFalse(y2["status"]["sci_tri"]["ok"])                    # 은폐 도막만 — 프로필 전에는 계산 불가

    def test_similar_uses_archive_and_worklog_lab(self):
        patterns = [{"id": "X-1", "pattern": {"code": "W01"}, "variations": [{
            "id": "v1", "colorName": "Beige", "layerPlates": {"1도": "26_001"},
            "mixes": [{"layer": "1도", "batch": "1", "inks": {"WH": 20}, "labSci": {"L": 70, "a": 1, "b": 8}},
                      {"layer": "1도", "batch": "2", "labSci": {"L": 40}},          # L만 → 건너뜀
                      {"layer": "1도", "batch": "3", "labSce": {"L": 70, "a": 1, "b": 8}}]}]}]
        out = api.similar((70, 1, 8), "sci", patterns)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["dE"], 0)
        self.assertIn("동판 26_001", out[0]["detail"])
        self.assertEqual(out[0]["link"], "/#/p/X-1/v1")


class HttpTests(unittest.TestCase):
    """/lab · /api/lab도 아카이브와 같은 호스트·Access·CSRF 검사를 거친다."""

    @classmethod
    def setUpClass(cls):
        cls.srv = server.Server(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lab-http-")
        self.saved = {k: getattr(server, k) for k in ("DATA", "BACKUP", "PATTERNS")}
        server.DATA = self.dir
        server.BACKUP = os.path.join(self.dir, "_backup")
        server.PATTERNS = os.path.join(self.dir, "patterns")
        os.makedirs(server.PATTERNS)
        self.cfg = dict(server.CFG)
        server.CFG.pop("requireCfAccess", None)
        server.CFG["worklogDir"] = os.path.join(self.dir, "없음")

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(server, k, v)
        server.CFG.clear()
        server.CFG.update(self.cfg)
        shutil.rmtree(self.dir, ignore_errors=True)

    def req(self, method, path, body=None, host="localhost", extra=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        c.request(method, path, body=data, headers=dict({"Host": host, "Content-Type": "application/json"}, **(extra or {})))
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            return r.status, json.loads(raw)
        except ValueError:
            return r.status, raw

    def test_flow(self):
        st, body = self.req("GET", "/lab/")
        self.assertEqual(st, 200)
        self.assertIn("컬러연구소".encode(), body)
        st, j = self.req("GET", "/api/lab/library")
        self.assertEqual((st, j["library"]["inks"]), (200, []))
        st, j = self.req("PUT", "/api/lab/library", synth.library(), extra={"X-Base-Rev": ""})
        self.assertEqual(st, 200)
        st, j2 = self.req("PUT", "/api/lab/library", synth.library(), extra={"X-Base-Rev": ""})
        self.assertEqual(st, 409)
        st, j = self.req("POST", "/api/lab/predict", {"mode": "sce", "substrate": "C 1000", "layer1": recipe({"WH": 20}),
                                                      "target": [50, 0, 0]})
        self.assertEqual(st, 200)
        self.assertIn("dE", j["regions"]["layer1"])
        st, j = self.req("POST", "/api/lab/recommend", {"target": [70, 0, 5], "substrate": "C 1000", "inks": ["WH", "YE"]})
        self.assertEqual(st, 200)
        self.assertTrue(j["candidates"])
        st, j = self.req("POST", "/api/lab/deltae", {"a": [50, 2.6772, -79.7751], "b": [50, 0, -82.7485]})
        self.assertAlmostEqual(j["dE2000"], 2.042, places=3)
        st, j = self.req("GET", "/api/lab/similar?L=50&a=0&b=0&mode=sci")
        self.assertEqual(st, 200)
        self.assertEqual({x["source"] for x in j["items"]}, {"전사 시료"})     # 아카이브·일지 LAB는 없음
        # 보정 프로필: 미리보기 → 적용 → 예측에 쓰임 → 끄기 · 되돌리기
        st, j = self.req("POST", "/api/lab/predict", {"substrate": "흰 카드", "layer1": recipe({"Y2": 60})})
        self.assertEqual(st, 400)                                            # 은폐 도막만 — 아직 계산 불가
        st, j = self.req("POST", "/api/lab/profile/preview", {"mode": "sci", "plate": "DEMO_002"})
        self.assertEqual(st, 200)
        self.assertTrue(j["run"]["ok"])
        snap = j["snapshot"]
        rev = api.load_library(self.dir)["updatedAt"]
        st, j = self.req("POST", "/api/lab/profile/apply", {"mode": "sci", "plate": "DEMO_002", "snapshot": snap},
                         extra={"X-Base-Rev": rev})
        self.assertEqual(st, 200, j)
        st, j = self.req("POST", "/api/lab/predict", {"substrate": "흰 카드", "layer1": recipe({"Y2": 60}), "plate": "DEMO_002"})
        self.assertEqual((st, j["sources"]), (200, {"Y2": "profile"}))
        st, j = self.req("GET", "/api/lab/library")
        self.assertEqual(j["info"]["profile"]["active"]["inks"], ["Y2"])
        self.assertEqual(j["info"]["profile"]["active"]["stale"], [])
        rev = j["library"]["updatedAt"]
        st, j = self.req("POST", "/api/lab/profile/off", {}, extra={"X-Base-Rev": rev})
        self.assertEqual(st, 200)
        st, j = self.req("POST", "/api/lab/predict", {"substrate": "흰 카드", "layer1": recipe({"Y2": 60})})
        self.assertEqual(st, 400)
        rev = api.load_library(self.dir)["updatedAt"]
        st, j = self.req("POST", "/api/lab/profile/revert", {}, extra={"X-Base-Rev": rev})
        self.assertEqual(st, 200)
        self.assertEqual(api.load_library(self.dir)["fits"]["active"]["plate"], "DEMO_002")
        st, j = self.req("POST", "/api/lab/predict", {"substrate": "없는코드", "layer1": recipe({"WH": 1})})
        self.assertEqual(st, 400)
        st, j = self.req("POST", "/api/lab/predict", b"not json")
        self.assertEqual(st, 400)
        st, _ = self.req("GET", "/lab/app.js")
        self.assertEqual(st, 200)
        st, _ = self.req("GET", "/lab/../../server.py")
        self.assertEqual(st, 404)

    def test_cross_site_write_blocked(self):
        st, _ = self.req("PUT", "/api/lab/library", synth.library(), extra={"Origin": "https://evil.example"})
        self.assertEqual(st, 403)
        st, _ = self.req("POST", "/api/lab/predict", {}, extra={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(st, 403)
        self.assertFalse(os.path.exists(api.lib_path(self.dir)))

    def test_access_required_through_tunnel(self):
        server.CFG.update(requireCfAccess=True, cfAccessTeamDomain="myteam", allowHosts=["rdp.example.com"])
        server.SAFE_HOSTS.add("rdp.example.com")
        for m, p in (("GET", "/api/lab/library"), ("GET", "/lab/"), ("POST", "/api/lab/deltae"), ("PUT", "/api/lab/library")):
            st, _ = self.req(m, p, {} if m != "GET" else None, host="rdp.example.com", extra={"Cf-Ray": "x"})
            self.assertEqual(st, 403, (m, p))


if __name__ == "__main__":
    unittest.main()
