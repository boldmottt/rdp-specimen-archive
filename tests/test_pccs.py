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
