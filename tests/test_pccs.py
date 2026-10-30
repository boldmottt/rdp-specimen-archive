#!/usr/bin/env python3
"""PCCS3 작업일지 검사기 테스트.  python3 -m unittest discover -s tests -v"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402
from pccs import api, worklog  # noqa: E402

SAMPLES = os.path.join(ROOT, "pccs", "sample-worklogs")
GOOD = "2026-01-10_API-DEMO-신규컬러-샘플제작.md"
LATER = "2026-01-15_API-DEMO_001-재시험.md"
BAD = "2026-01-20_API-DEMO-오류예시.md"
V2 = "2025-12-20_API-DEMO-v2-예전형식.md"


def msgs(result, kind="errors"):
    return [m["msg"] for m in result[kind]]


class Folder(unittest.TestCase):
    """예시 일지를 임시 폴더에 복사해 놓고, 필요하면 파일을 고쳐 가며 검사한다."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pccs-test-")
        for n in os.listdir(SAMPLES):
            shutil.copy(os.path.join(SAMPLES, n), self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def edit(self, name, old, new):
        p = os.path.join(self.dir, name)
        t = open(p, encoding="utf-8").read()
        self.assertIn(old, t, f"테스트 준비 실패: {old!r} 없음")
        open(p, "w", encoding="utf-8").write(t.replace(old, new, 1))

    def run_check(self, name):
        idx = worklog.load_folder(self.dir)
        w = next(x for x in idx.logs if x.name == name)
        return worklog.check(w, idx)


class SampleTests(Folder):
    def test_good_samples_pass(self):
        for n in (GOOD, LATER):
            r = self.run_check(n)
            self.assertEqual(r["errors"], [], n)
            self.assertEqual(r["warnings"], [], n)
        self.assertEqual(self.run_check(GOOD)["stats"], {"jobs": 2, "batches": 5, "samples": 5, "qty": 12})

    def test_bad_sample_catches_everything(self):
        e = " | ".join(msgs(self.run_check(BAD)))
        for want in ("'no:' 2곳", "NIFCO", "도장일 2026-02-01", "값도 함께 적어야", "total 80 ≠ 계산 84",
                     "잉크합 60의 20.0%", "substrates 2줄", "eval 값이 규칙 밖: 작업진행", "DEMO-E1/E2", "본문 총계 4장"):
            self.assertIn(want, e)

    def test_kinds(self):
        idx = worklog.load_folder(self.dir)
        open(os.path.join(self.dir, "메일초안.md"), "w", encoding="utf-8").write("frontmatter 없음\n")
        open(os.path.join(self.dir, "깨짐.md"), "w", encoding="utf-8").write("---\na: [1, 2\n---\n")
        idx = worklog.load_folder(self.dir)
        kinds = {w.name: w.kind for w in idx.logs}
        self.assertEqual((kinds[GOOD], kinds[V2], kinds["메일초안.md"], kinds["깨짐.md"]), ("v3", "v2", "none", "broken"))
        self.assertIn("YAML 오류", msgs(worklog.check(next(w for w in idx.logs if w.name == "깨짐.md")))[0])


class RuleTests(Folder):
    def test_yaml_no_key_is_reported_once(self):
        self.edit(GOOD, "  - seq: 1\n", "  - no: 1\n")
        self.assertIn("'no:' 1곳", msgs(self.run_check(GOOD))[0])

    def test_unquoted_batch_code_no_becomes_bool(self):
        self.edit(GOOD, "code: 'A', inks: {MT: 60}", "code: no, inks: {MT: 60}")
        self.assertTrue(any("배치 코드가 문자열이 아님" in m for m in msgs(self.run_check(GOOD))))

    def test_same_as_across_files_needs_values(self):
        # 다른 날짜 원본을 값 없이 가리키면 오류, 값이 다르면 오류
        self.edit(LATER, "same_as: 'DEMO_001/2도/나', inks: {MT: 35, CL: 15, BK: 10, WH: 10},",
                  "same_as: 'DEMO_001/2도/나', inks: {MT: 35, CL: 15, BK: 11, WH: 9},")
        self.assertTrue(any("원본" in m and "값이 다름" in m for m in msgs(self.run_check(LATER))))

    def test_same_as_missing_everywhere(self):
        self.edit(GOOD, "same_as: 'DEMO_001/2도/나'", "same_as: 'DEMO_999/2도/나'")
        self.assertTrue(any("일지 전체에서 찾지 못함" in m for m in msgs(self.run_check(GOOD))))

    def test_reused_code_with_different_values_warns(self):
        self.edit(LATER, "same_as: 'DEMO_001/2도/나', inks: {MT: 35, CL: 15, BK: 10, WH: 10},",
                  "inks: {MT: 35, CL: 15, BK: 12, WH: 8},")
        w = msgs(self.run_check(LATER), "warnings")
        self.assertTrue(any("2026-01-10 일지" in m and "코드를 바꾸세요" in m for m in w), w)

    def test_merged_patterns_for_two_pattern_plate(self):
        self.edit(GOOD, """  - code: DEMO-E2
    plates:
      - {lot: 'DEMO_002', layers: [1도], batches: ['나']}
  - code: DEMO-E1
    plates:
      - {lot: 'DEMO_002', layers: [2도], batches: ['B']}""", """  - code: DEMO-E1/E2
    plates:
      - {lot: 'DEMO_002', layers: [1도, 2도], batches: ['나', 'B']}""")
        self.assertTrue(any("패턴 코드별로" in m for m in msgs(self.run_check(GOOD))))

    def test_substrate_surface_qualifier(self):
        self.edit(GOOD, "substrate: 'D 2000@경면'", "substrate: 'D 2000'")
        self.assertTrue(any("2줄과 맞음" in m for m in msgs(self.run_check(GOOD))))
        self.edit(GOOD, "substrate: 'D 2000'", "substrate: 'D 2000@샘플도장 A@경면'")
        self.assertEqual(msgs(self.run_check(GOOD)), [])

    def test_matting_pct_is_on_ink_total(self):
        self.edit(LATER, "matting: {g: 0.7, pct: 1}", "matting: {g: 0.7, pct: 2}")
        self.assertTrue(any("소광제 0.7g" in m for m in msgs(self.run_check(LATER))))


class TimelineTests(Folder):
    def test_plate_timeline_includes_v2_and_is_sorted(self):
        idx = worklog.load_folder(self.dir)
        ents = idx.timeline_entries("DEMO_001")
        self.assertEqual([(e["date"], e["kind"]) for e in ents],
                         [("2025-12-20", "v2"), ("2026-01-10", "v3"), ("2026-01-15", "v3")])
        self.assertEqual(ents[2]["samples"][0]["eval"], "채택")

    def test_two_pattern_plate_lists_both_codes(self):
        p = {x["lot"]: x for x in worklog.load_folder(self.dir).plates()}
        self.assertEqual(p["DEMO_002"]["patterns"], ["DEMO-E1", "DEMO-E2"])


class RelatedTests(Folder):
    """아카이브 상세 화면용 — 시편(코드·동판)과 관련된 작업 기록."""

    def test_norm_code_ignores_case_symbols_and_leading_zeros(self):
        self.assertEqual(worklog.norm_code("DEMO-W1"), worklog.norm_code("demo_w01"))
        self.assertNotEqual(worklog.norm_code("W1"), worklog.norm_code("W11"))
        self.assertEqual(worklog.norm_code(""), "")

    def test_code_match_newest_first(self):
        idx = worklog.load_folder(self.dir)
        ents = worklog.related_entries(idx, ["W01", "DEMO-W01"], [])
        self.assertEqual([(e["date"], e["match"]) for e in ents],
                         [("2026-01-15", "code"), ("2026-01-10", "code"), ("2025-12-20", "code")])
        self.assertEqual(ents[1]["place"], "API 산업")
        self.assertEqual(ents[1]["samples"]["qty"], 9)

    def test_two_pattern_plate_only_shows_matching_layer_batches(self):
        idx = worklog.load_folder(self.dir)
        ents = [e for e in worklog.related_entries(idx, ["DEMO-E2"], []) if e["kind"] == "v3"]
        self.assertTrue(ents)
        for e in ents:
            self.assertEqual(e["matchedLayers"], ["1도"])
            self.assertTrue(all(b["layer"] in (None, "1도") for b in e["batches"]), e["batches"])

    def test_plate_only_match_is_marked(self):
        idx = worklog.load_folder(self.dir)
        ents = worklog.related_entries(idx, ["NOPE"], ["DEMO_002"])
        self.assertTrue(ents)
        self.assertTrue(all(e["match"] == "plate" and e["lot"] == "DEMO_002" for e in ents))
        self.assertEqual(worklog.related_entries(idx, [], []), [])

    def test_api_route(self):
        st, r = api.handle("/api/pccs/related", {"code": ["DEMO-W1"], "lot": []}, {"worklogDir": self.dir})
        self.assertEqual(st, 200)
        self.assertEqual(len(r["entries"]), 3)


class ApiTests(Folder):
    def test_files_and_file(self):
        cfg = {"worklogDir": self.dir}
        st, r = api.handle("/api/pccs/files", {}, cfg)
        self.assertEqual(st, 200)
        self.assertEqual(r["files"][0]["name"], BAD)          # 최근 날짜가 위
        st, r = api.handle("/api/pccs/file", {"name": [GOOD]}, cfg)
        self.assertEqual((st, r["errors"], r["kind"]), (200, 0, "v3"))

    def test_file_name_cannot_escape_folder(self):
        cfg = {"worklogDir": self.dir}
        for bad in ("../server.py", "/etc/passwd", "..%2fserver.py", ""):
            st, _ = api.handle("/api/pccs/file", {"name": [bad]}, cfg)
            self.assertEqual(st, 404, bad)

    def test_missing_folder_and_static_whitelist(self):
        st, r = api.handle("/api/pccs/files", {}, {"worklogDir": os.path.join(self.dir, "없음")})
        self.assertEqual(st, 404)
        self.assertIsNone(api.static_file("../api.py"))
        self.assertIsNotNone(api.static_file(""))

    def test_cache_refreshes_when_file_changes(self):
        cfg = {"worklogDir": self.dir}
        api.handle("/api/pccs/files", {}, cfg)
        p = os.path.join(self.dir, GOOD)
        self.edit(GOOD, "eval: 대기중}\n---", "eval: 엉망}\n---")
        os.utime(p, (os.path.getmtime(p) + 5, os.path.getmtime(p) + 5))
        st, r = api.handle("/api/pccs/file", {"name": [GOOD]}, cfg)
        self.assertEqual(r["errors"], 1)


HEAD = """---
schema: worklog/v3
date: "2026-02-0{n}"
category: 작업일지
tags: {tags}
place: x
worker: y
"""
OKJOB = """  - seq: 1
    customer: c
    project: p
    stage: 선행연구
    type: 샘플제작
    plate: {lot: "A1", layers: {"1도": "P1"}}
"""


class RobustTests(Folder):
    """손으로 쓴 일지의 모양이 틀려도 폴더 전체·화면이 멈추지 않고, 그 일지에 오류로 나와야 한다."""

    def put(self, n, body, tags="[NIFCO]"):
        name = f"2026-02-0{n}_틀린모양{n}.md"
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
            f.write(HEAD.format(n=n, tags=tags) + body + "---\n본문\n")
        return name

    def test_bad_shapes_are_reported_not_crashing(self):
        cases = {
            self.put(1, "jobs:\n  - seq: 1\n    plate: \"A1\"\n"): "plate가 {lot:, layers:} 형식이 아님",
            self.put(2, "jobs:\n" + OKJOB + "    batches:\n      - {layer: \"1도\", code: \"1\", inks: {WH: 10}, thinner: 3, total: 13}\n"):
                "신나는 {g:, pct:} 형식",
            self.put(3, "jobs:\n" + OKJOB + "    batches:\n      - {layer: \"1도\", code: \"2\", inks: [WH, 10], total: 13}\n"):
                "inks는 {잉크: g} 형식",
            self.put(4, "jobs:\n" + OKJOB + "    samples:\n      - {seq: 1, substrate: S, qty: \"3장\", eval: 채택, layers: [\"1도\"]}\n"):
                "qty가 양의 정수가 아님",
            self.put(5, "jobs: 5\n", tags="NIFCO"): "jobs가 목록이 아님",
            self.put(6, "jobs:\n" + OKJOB + "    samples: {a: 1}\n    batches: 3\n"): "samples가 목록이 아님",
        }
        cfg = {"worklogDir": self.dir}
        for path in ("/api/pccs/status", "/api/pccs/files", "/api/pccs/plates"):
            st, r = api.handle(path, {}, cfg)
            self.assertEqual(st, 200, (path, r))
        st, r = api.handle("/api/pccs/files", {}, cfg)
        errs = {f["name"]: f["errors"] for f in r["files"]}
        for name, want in cases.items():
            self.assertGreaterEqual(errs[name], 1, name)
            st, one = api.handle("/api/pccs/file", {"name": [name]}, cfg)
            self.assertEqual(st, 200, name)
            self.assertIn(want, " | ".join(msgs(one["result"])), name)
        st, r = api.handle("/api/pccs/plate", {"lot": ["A1"]}, cfg)
        self.assertEqual(st, 200)
        # 예시 일지 검사 결과는 그대로
        self.assertEqual(self.run_check(GOOD)["errors"], [])
        self.assertIn("tags가 목록이 아님", " | ".join(msgs(self.run_check("2026-02-05_틀린모양5.md"))))

    def test_sample_layers_list_and_qty_text_in_timeline(self):
        self.put(7, "jobs:\n" + OKJOB + "    samples:\n      - {seq: 1, substrate: S, qty: \"3장\", eval: 채택, layers: [\"1도\"]}\n")
        idx = worklog.load_folder(self.dir)
        self.assertTrue(any(p["lot"] == "A1" for p in idx.plates()))
        self.assertTrue(idx.timeline_entries("A1"))

    def test_colorlab_similar_survives_bad_worklog(self):
        from colorlab import api as lab_api
        self.put(8, "jobs:\n  - seq: 1\n    plate: \"A1\"\n    samples: {a: 1}\n")
        idx = worklog.load_folder(self.dir)
        items = lab_api.similar([50, 0, 0], "sci", [], idx)
        self.assertIsInstance(items, list)


class HttpTests(Folder):
    """/pccs·/api/pccs도 아카이브와 같은 Cloudflare Access 검사를 거친다."""

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
        super().setUp()
        self.cfg = dict(server.CFG)
        server.CFG["worklogDir"] = self.dir
        server.CFG.pop("requireCfAccess", None)

    def tearDown(self):
        server.CFG.clear()
        server.CFG.update(self.cfg)
        super().tearDown()

    def get(self, path, host="localhost", extra=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers=dict({"Host": host}, **(extra or {})))
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, body, r.getheader("Location")

    def test_routes(self):
        st, _, loc = self.get("/pccs")
        self.assertEqual((st, loc), (301, "/pccs/"))
        st, body, _ = self.get("/pccs/")
        self.assertEqual(st, 200)
        self.assertIn(b"PCCS3", body)
        st, body, _ = self.get("/api/pccs/files")
        self.assertEqual(st, 200)
        self.assertEqual(len(json.loads(body)["files"]), 4)

    def test_access_required_through_tunnel(self):
        server.CFG.update(requireCfAccess=True, cfAccessTeamDomain="myteam", allowHosts=["rdp.example.com"])
        server.SAFE_HOSTS.add("rdp.example.com")
        st, _, _ = self.get("/api/pccs/files", host="rdp.example.com", extra={"Cf-Ray": "x"})
        self.assertEqual(st, 403)
        st, _, _ = self.get("/pccs/", host="rdp.example.com", extra={"Cf-Ray": "x"})
        self.assertEqual(st, 403)


if __name__ == "__main__":
    unittest.main()
