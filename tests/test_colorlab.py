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
from colorlab import api, colormath as cm, km, model, synth  # noqa: E402

PCT = {"hardener_pct": 20, "thinner_pct": 30, "matting_pct": 0}


def recipe(inks, h=20, t=30):
    tot = sum(inks.values())
    return {"inks": inks, "hardener": {"g": tot * h / 100}, "thinner": {"g": tot * t / 100}}


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
            self.assertEqual(r["space"], "rgb")
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

    def test_fit_plate(self):
        samples = []
        for inks in ({"WH": 20, "YE": 6}, {"BK": 3, "MT": 30}, {"RD": 5, "WH": 10}):
            samples.append({"substrate": "C 1000", "layer1": recipe(inks),
                            "measured": synth.true_color((38.0, -0.6, -2.5), recipe(inks), thick=1.3)})
        r = model.fit_plate(self.lib, samples)
        self.assertAlmostEqual(r["thickness"], 1.3, delta=0.02)
        self.assertLess(r["dE_after"], r["dE_before"])
        self.assertLess(r["dE_after"], 0.1)
        # 이미 맞는 시료면 1.0 그대로
        same = [{"substrate": "C 1000", "layer1": recipe({"WH": 20}),
                 "measured": synth.true_color((38.0, -0.6, -2.5), recipe({"WH": 20}))}]
        self.assertEqual(model.fit_plate(self.lib, same)["thickness"], 1.0)

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
        self.assertEqual(len(doc["inks"]), 7)
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
        ]
        for doc, want in bad_cases:
            with self.assertRaises(model.ModelError) as cx:
                api.validate(doc)
            self.assertIn(want, str(cx.exception))
        clean = api.validate(good)
        self.assertEqual(len(clean["substrates"]), 4)
        self.assertIn("cards", clean["settings"])

    def test_describe_library_refs(self):
        info = api.describe_library(synth.library())
        self.assertEqual([s["ref"] for s in info["substrates"]], ["C 1000", "D 2000@경면", "D 2000@패브릭엠보", "BK-1"])
        wh = next(i for i in info["inks"] if i["name"] == "WH")
        self.assertTrue(wh["status"]["sci_rgb"]["ok"])
        self.assertFalse(wh["status"]["sci_spec"]["ok"])

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
        self.assertEqual((st, j["items"]), (200, []))
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
