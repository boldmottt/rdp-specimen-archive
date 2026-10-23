#!/usr/bin/env python3
"""server.py 회귀 테스트 (표준 라이브러리 unittest).

    python3 -m unittest discover -s tests -v

임시 데이터 폴더와 가짜 rdp.db로 실제 HTTP 서버를 띄워서 확인한다.
"""
import base64
import hashlib
import http.client
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

SCHEMA = """CREATE TABLE rdp_mixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, project TEXT, pattern_code TEXT,
  plate TEXT, layer TEXT, batch_no TEXT, is_base INTEGER DEFAULT 0,
  mt REAL, bk REAL, wh REAL, ye REAL, rd REAL, cl REAL, ye_d REAL,
  matting_agent_pct REAL, matting_agent_g REAL, thinner_pct REAL, thinner_g REAL,
  hardener_pct REAL, hardener_g REAL,
  result TEXT, change_summary TEXT, notes TEXT, coating_code TEXT,
  UNIQUE(project, pattern_code, plate, layer, batch_no))"""   # 실제 rdp.db와 같은 제약


def mix(layer, batch, plate, bk=10.0, **kw):
    m = {"layer": layer, "batch": batch, "plate": plate, "inks": {"BK": bk}, "result": "", "isReference": False}
    m.update(kw)
    return m


def pattern(pid, project, code, variations, rev="2026-10-01T10:00:00"):
    d = {"schemaVersion": 2, "id": pid, "project": project, "pattern": {"code": code, "name": ""},
         "label": {"item": "Design Sample", "type": "Padprint Layer 1"}, "work": {},
         "variations": variations}
    if rev is not None:
        d["updatedAt"] = rev
    return d


class Base(unittest.TestCase):
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
        self.tmp = tempfile.mkdtemp(prefix="rdp-test-")
        d = self.tmp
        self.patches = [mock.patch.multiple(
            server, DATA=d, PATTERNS=os.path.join(d, "patterns"), IMAGES=os.path.join(d, "images"),
            ORIG=os.path.join(d, "_orig"), BACKUP=os.path.join(d, "_backup"), TRASH=os.path.join(d, "_trash"),
            PROPOSALS=os.path.join(d, "proposals"), UI_STATE=os.path.join(d, "_ui", "state.json"),
            CONFIG_PATH=os.path.join(d, "config.json"))]
        for p in self.patches:
            p.start()
        self.cfg_backup = dict(server.CFG)
        server.ensure_dirs()
        self.db = os.path.join(d, "rdp.db")
        con = sqlite3.connect(self.db)
        con.execute(SCHEMA)
        con.commit()
        con.close()
        server.CFG["rdpDbPath"] = self.db
        server.CFG.pop("requireCfAccess", None)
        # 이 맥의 실제 config.json 값이 테스트에 새지 않게 (import 시 로드됨)
        for k in ("cfAccessEmail", "cfAccessAud", "cfAccessTeamDomain", "allowHosts", "requireCfAccess"):
            server.CFG.pop(k, None)

    def tearDown(self):
        server.CFG.clear()
        server.CFG.update(self.cfg_backup)
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- helpers
    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": "localhost"}
        h.update(headers or {})
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            return r.status, json.loads(raw)
        except Exception:
            return r.status, raw

    def write_pattern(self, doc):
        with open(os.path.join(server.PATTERNS, doc["id"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)

    def read_pattern(self, pid):
        with open(os.path.join(server.PATTERNS, pid + ".json"), encoding="utf-8") as f:
            return json.load(f)

    def add_image(self, pid, name="v01.jpg", base=None):
        d = os.path.join(base or server.IMAGES, pid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "wb") as f:
            f.write(b"\xff\xd8fakejpeg")

    def db_insert(self, project, code, layer, batch, plate, bk=10.0, coating=""):
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO rdp_mixes (date, project, pattern_code, plate, layer, batch_no, bk, result, coating_code)"
                    " VALUES ('2026-10-01',?,?,?,?,?,?, '',?)", (project, code, plate, layer, batch, bk, coating))
        con.commit()
        con.close()

    def db_counts(self):
        con = sqlite3.connect(self.db)
        rows = dict(((a, b), c) for a, b, c in con.execute(
            "SELECT project, pattern_code, COUNT(*) FROM rdp_mixes GROUP BY 1, 2"))
        con.close()
        return rows

    def put(self, pid, doc, rev=None, rename_from=None, create=False):
        h = {}
        if rev:
            h["X-Base-Rev"] = rev
        if rename_from:
            h["X-Rename-From"] = rename_from
        if create:
            h["X-Create"] = "1"
        return self.req("PUT", f"/api/patterns/{pid}", doc, h)


class RenameTests(Base):
    def test_rename_without_updatedAt(self):
        """예전/데모 데이터(updatedAt 없음)도 rename 되고 새 savedAt이 돌아온다."""
        doc = pattern("P-W01", "P", "W01", [{"id": "v01", "mixes": []}], rev=None)
        self.write_pattern(doc)
        self.add_image("P-W01")
        self.add_image("P-W01", "src.heic", base=server.ORIG)
        doc2 = dict(doc, id="P-W05", pattern={"code": "W05"})
        st, r = self.put("P-W05", doc2, rename_from="P-W01")
        self.assertEqual(st, 200, r)
        self.assertTrue(r["savedAt"])
        self.assertFalse(os.path.exists(os.path.join(server.PATTERNS, "P-W01.json")))
        self.assertEqual(self.read_pattern("P-W05")["id"], "P-W05")
        st, _ = self.req("GET", "/img/P-W05/v01.jpg")
        self.assertEqual(st, 200)
        self.assertTrue(os.path.isfile(os.path.join(server.ORIG, "P-W05", "src.heic")))
        self.assertFalse(os.path.exists(os.path.join(server.IMAGES, "P-W01")))

    def test_rename_target_images_exist(self):
        """대상 이미지 폴더가 이미 있으면 409, 원본은 그대로 (폴더 안으로 들어가지 않음)."""
        doc = pattern("P-W01", "P", "W01", [{"id": "v01", "mixes": []}])
        self.write_pattern(doc)
        self.add_image("P-W01")
        os.makedirs(os.path.join(server.IMAGES, "P-W09"))
        st, r = self.put("P-W09", dict(doc, id="P-W09", pattern={"code": "W09"}), rev=doc["updatedAt"], rename_from="P-W01")
        self.assertEqual(st, 409, r)
        self.assertTrue(os.path.isfile(os.path.join(server.PATTERNS, "P-W01.json")))
        self.assertTrue(os.path.isfile(os.path.join(server.IMAGES, "P-W01", "v01.jpg")))
        self.assertEqual(os.listdir(os.path.join(server.IMAGES, "P-W09")), [])

    def test_rename_failure_rolls_back(self):
        """중간에 실패하면 옛 ID의 JSON·이미지·원본이 그대로 남는다."""
        doc = pattern("P-W01", "P", "W01", [{"id": "v01", "mixes": []}])
        self.write_pattern(doc)
        self.add_image("P-W01")
        self.add_image("P-W01", "src.heic", base=server.ORIG)
        with mock.patch.object(server, "move_to_trash", side_effect=OSError("disk full")):
            st, r = self.put("P-W05", dict(doc, id="P-W05", pattern={"code": "W05"}), rev=doc["updatedAt"], rename_from="P-W01")
        self.assertEqual(st, 500, r)
        self.assertTrue(os.path.isfile(os.path.join(server.PATTERNS, "P-W01.json")))
        self.assertFalse(os.path.exists(os.path.join(server.PATTERNS, "P-W05.json")))
        self.assertTrue(os.path.isfile(os.path.join(server.IMAGES, "P-W01", "v01.jpg")))
        self.assertTrue(os.path.isfile(os.path.join(server.ORIG, "P-W01", "src.heic")))
        self.assertFalse(os.path.exists(os.path.join(server.IMAGES, "P-W05")))

    def test_rename_stale_rev(self):
        doc = pattern("P-W01", "P", "W01", [{"id": "v01", "mixes": []}])
        self.write_pattern(doc)
        st, r = self.put("P-W05", dict(doc, id="P-W05", pattern={"code": "W05"}), rev="2020-01-01T00:00:00", rename_from="P-W01")
        self.assertEqual(st, 409)
        self.assertTrue(r.get("conflict"))
        self.assertTrue(os.path.isfile(os.path.join(server.PATTERNS, "P-W01.json")))

    def test_bad_ids_are_400(self):
        doc = pattern("P-W01", "P", "W01", [{"id": "v01", "mixes": []}])
        self.write_pattern(doc)
        st, _ = self.put("P-W05", doc, rename_from="../x")
        self.assertEqual(st, 400)
        st, _ = self.req("PUT", "/api/patterns/", doc)
        self.assertEqual(st, 400)
        st, _ = self.put("P-W05", dict(doc, id="P-W05"), rename_from="P-NONE")
        self.assertEqual(st, 404)


class RenameDbTests(Base):
    def setUp(self):
        super().setUp()
        self.doc = pattern("P-W01", "P", "W01", [{"id": "v01", "mixes": [
            mix("1도", "B1", "26_001"), mix("1도", "B2", "26_001"), mix("2도", "B3", "26_002"),
            mix("2도", "B4", "26_002")]}])
        self.write_pattern(self.doc)
        for m in self.doc["variations"][0]["mixes"]:
            self.db_insert("P", "W01", m["layer"], m["batch"], m["plate"])
        self.db_insert("P", "W01", "3도", "B5", "26_003")
        self.db_insert("P", "W01", "3도", "B6", "26_003")

    def renamed(self):
        doc2 = json.loads(json.dumps(self.doc))
        doc2["id"] = "P-W05"
        doc2["pattern"]["code"] = "W05"
        st, r = self.put("P-W05", doc2, rev=self.doc["updatedAt"], rename_from="P-W01")
        self.assertEqual(st, 200, r)
        self.assertEqual(r["renamedFrom"], {"project": "P", "code": "W01"})
        return r

    def test_preview_blocked_after_rename(self):
        self.renamed()
        st, r = self.req("GET", "/api/rdp/push-preview/P-W05")
        self.assertEqual(st, 200, r)
        self.assertIn("W01", r["blocked"])
        self.assertEqual(r["inserts"], [])

    def test_push_refused_after_rename(self):
        self.renamed()
        before = self.db_counts()
        st, r = self.req("POST", "/api/rdp/push/P-W05")
        self.assertEqual(st, 409, r)
        self.assertEqual(self.db_counts(), before)

    def test_unrenamed_push_still_works(self):
        doc = self.read_pattern("P-W01")
        doc["variations"][0]["mixes"][0]["inks"]["BK"] = 12.5
        doc["variations"][0]["mixes"].append(mix("1도", "B7", "26_001"))
        self.write_pattern(doc)
        st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
        self.assertNotIn("blocked", r)
        self.assertEqual((len(r["updates"]), len(r["inserts"])), (1, 1))
        st, r = self.req("POST", "/api/rdp/push/P-W01")
        self.assertEqual(st, 200, r)
        self.assertEqual((r["updated"], r["inserted"]), (1, 1))
        self.assertEqual(self.db_counts()[("P", "W01")], 7)

    def test_rename_db_rows(self):
        r = self.renamed()
        st, r = self.req("POST", "/api/rdp/rename-db/P-W05", {"mode": "rename"}, {"X-Base-Rev": r["savedAt"]})
        self.assertEqual(st, 200, r)
        self.assertEqual(r["renamed"], 6)
        self.assertEqual(self.db_counts(), {("P", "W05"): 6})
        self.assertNotIn("renamedFrom", self.read_pattern("P-W05"))
        st, r = self.req("GET", "/api/rdp/push-preview/P-W05")
        self.assertNotIn("blocked", r)
        self.assertEqual(r["inserts"], [])

    def test_ignore_old_rows(self):
        r = self.renamed()
        st, r = self.req("POST", "/api/rdp/rename-db/P-W05", {"mode": "ignore"})
        self.assertEqual(st, 200, r)
        self.assertEqual(self.db_counts(), {("P", "W01"): 6})
        st, r = self.req("GET", "/api/rdp/push-preview/P-W05")
        self.assertNotIn("blocked", r)
        self.assertEqual(len(r["inserts"]), 4)

    def test_rename_back_clears_marker(self):
        r = self.renamed()
        doc = self.read_pattern("P-W05")
        doc["id"] = "P-W01"
        doc["pattern"]["code"] = "W01"
        st, r = self.put("P-W01", doc, rev=r["savedAt"], rename_from="P-W05")
        self.assertEqual(st, 200, r)
        self.assertIsNone(r["renamedFrom"])

    def test_client_cannot_clear_marker(self):
        r = self.renamed()
        doc = self.read_pattern("P-W05")
        doc.pop("renamedFrom")
        st, r = self.put("P-W05", doc, rev=r["savedAt"])
        self.assertEqual(st, 200, r)
        self.assertEqual(self.read_pattern("P-W05")["renamedFrom"]["code"], "W01")


class PushTests(Base):
    def test_variation2_edits_are_pushed(self):
        doc = pattern("P-W01", "P", "W01", [
            {"id": "v01", "colorCode": "K-1", "mixes": [mix("1도", "B1", "26_001")]},
            {"id": "v02", "colorCode": "K-2", "mixes": [mix("1도", "B9", "26_001", bk=20.0)]}])
        self.write_pattern(doc)
        self.db_insert("P", "W01", "1도", "B1", "26_001", coating="K-1")
        self.db_insert("P", "W01", "1도", "B9", "26_001", bk=5.0, coating="K-2")
        st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
        self.assertEqual([(u["vid"], u["batch"]) for u in r["updates"]], [("v02", "B9")])
        st, r = self.req("POST", "/api/rdp/push/P-W01")
        self.assertEqual(r["updated"], 1)
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT bk FROM rdp_mixes WHERE batch_no='B9'").fetchone()[0], 20.0)
        con.close()

    def test_insert_keeps_coating_so_sync_round_trips(self):
        doc = pattern("P-W01", "P", "W01", [
            {"id": "v01", "colorCode": "K-1", "mixes": []},
            {"id": "v02", "colorCode": "K-2", "mixes": [mix("1도", "B9", "26_001")]}])
        self.write_pattern(doc)
        st, r = self.req("POST", "/api/rdp/push/P-W01")
        self.assertEqual(r["inserted"], 1)
        st, r = self.req("POST", "/api/rdp/sync/P-W01")
        self.assertEqual(st, 200, r)
        d = self.read_pattern("P-W01")
        self.assertEqual(len(d["variations"][0]["mixes"]), 0)
        self.assertEqual(len(d["variations"][1]["mixes"]), 1)

    def test_copied_mix_without_batch_is_skipped(self):
        doc = pattern("P-W01", "P", "W01", [
            {"id": "v01", "colorCode": "K-1", "mixes": [mix("1도", "B1", "26_001")]},
            {"id": "v02", "colorCode": "K-2", "mixes": [mix("1도", "", "26_001")]},
            {"id": "v03", "colorCode": "", "mixes": [mix("1도", "B3", "26_001")]}])
        self.write_pattern(doc)
        st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
        reasons = {(s["vid"], s["reason"]) for s in r["skipped"]}
        self.assertIn(("v02", "배치번호 필요"), reasons)
        self.assertTrue(any(v == "v03" and "컬러코드" in why for v, why in reasons))
        self.assertEqual([(i["vid"], i["batch"]) for i in r["inserts"]], [("v01", "B1")])

    def test_sync_keeps_custom_inks(self):
        doc = pattern("P-W01", "P", "W01", [{"id": "v01", "mixes": [
            dict(mix("1도", "B1", "26_001"), inks={"BK": 1.0, "GOLD": 3.0})]}])
        self.write_pattern(doc)
        self.db_insert("P", "W01", "1도", "B1", "26_001", bk=2.0)
        st, r = self.req("POST", "/api/rdp/sync/P-W01")
        self.assertEqual(st, 200, r)
        inks = self.read_pattern("P-W01")["variations"][0]["mixes"][0]["inks"]
        self.assertEqual(inks, {"BK": 2.0, "GOLD": 3.0})



class LayerPatternTests(Base):
    """배합은 (도수 패턴 코드, 도수, 동판, 배치)에 속한다. 도수 패턴이 없으면 시편 코드."""

    def w01(self, mixes, layer_patterns=None, coat="K-1"):
        v = {"id": "v01", "colorCode": coat, "mixes": mixes,
             "layerPlates": {"1도": "26_001", "2도": "26_002"}}
        if layer_patterns:
            v["layerPatterns"] = layer_patterns
        doc = pattern("P-W01", "P", "W01", [v])
        self.write_pattern(doc)
        return doc

    def codes(self):
        con = sqlite3.connect(self.db)
        rows = sorted(con.execute("SELECT pattern_code, layer, batch_no FROM rdp_mixes").fetchall())
        con.close()
        return rows

    def test_insert_uses_layer_pattern_code(self):
        self.w01([mix("1도", "B1", "26_001"), mix("2도", "B2", "26_002")], {"2도": "M01"})
        st, r = self.req("POST", "/api/rdp/push/P-W01")
        self.assertEqual(st, 200, r)
        self.assertEqual(self.codes(), [("M01", "2도", "B2"), ("W01", "1도", "B1")])

    def test_legacy_row_is_moved_not_duplicated(self):
        """도수 패턴을 정하기 전에 시편 코드로 들어간 행은 새로 만들지 않고 코드만 옮긴다."""
        self.db_insert("P", "W01", "1도", "B1", "26_001", coating="K-1")
        self.db_insert("P", "W01", "2도", "B2", "26_002", coating="K-1")
        self.w01([mix("1도", "B1", "26_001"), mix("2도", "B2", "26_002", bk=11.0)], {"2도": "M01"})
        st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
        self.assertEqual([(m["from"], m["to"], m["batch"]) for m in r["moves"]], [("W01", "M01", "B2")])
        self.assertEqual(r["inserts"], [])
        self.assertEqual([u["batch"] for u in r["updates"]], ["B2"])
        st, r = self.req("POST", "/api/rdp/push/P-W01")
        self.assertEqual((r["moved"], r["updated"], r["inserted"]), (1, 1, 0))
        self.assertEqual(self.codes(), [("M01", "2도", "B2"), ("W01", "1도", "B1")])
        st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
        self.assertEqual((r["moves"], r["updates"], r["inserts"]), ([], [], []))

    def test_sync_pulls_layer_code_rows_of_same_color_only(self):
        self.w01([], {"2도": "M01"})
        self.db_insert("P", "M01", "2도", "B2", "26_002", coating="K-1")   # 이 컬러
        self.db_insert("P", "M01", "2도", "B9", "26_002", coating="K-9")   # M01 시편의 다른 컬러
        self.db_insert("P", "M01", "1도", "B8", "26_001", coating="K-1")   # 다른 도수
        st, r = self.req("POST", "/api/rdp/sync/P-W01")
        self.assertEqual(st, 200, r)
        got = [(m["layer"], m["batch"]) for m in self.read_pattern("P-W01")["variations"][0]["mixes"]]
        self.assertEqual(got, [("2도", "B2")])

    def test_owner_specimen_does_not_absorb_borrowed_rows(self):
        """W01이 2도를 M01 코드로 보낸 행은 M01 시편으로 딸려 가지 않는다."""
        self.w01([mix("2도", "B2", "26_002")], {"2도": "M01"})
        self.write_pattern(pattern("P-M01", "P", "M01", [{"id": "v01", "colorCode": "K-9", "mixes": []}]))
        self.req("POST", "/api/rdp/push/P-W01")
        self.db_insert("P", "M01", "2도", "B5", "26_002", coating="K-9")
        st, r = self.req("POST", "/api/rdp/sync/P-M01")
        self.assertEqual(st, 200, r)
        got = [m["batch"] for m in self.read_pattern("P-M01")["variations"][0]["mixes"]]
        self.assertEqual(got, ["B5"])

    def test_ambiguous_or_colorless_layer_code_is_skipped(self):
        self.w01([mix("2도", "B2", "26_002")], {"2도": "M01 · W03"})
        st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
        self.assertEqual(r["inserts"], [])
        self.assertIn("코드 하나가 아님", r["skipped"][0]["reason"])
        self.w01([mix("2도", "B2", "26_002")], {"2도": "M01"}, coat="")
        st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
        self.assertEqual(r["inserts"], [])
        self.assertIn("컬러코드가 필요", r["skipped"][0]["reason"])

    def test_changed_layer_code_moves_rows(self):
        """M01로 보낸 뒤 M02로 고치면 M01 행을 옮긴다 (중복 생성 X). 비우면 시편 코드로 되돌린다."""
        doc = self.w01([mix("2도", "B2", "26_002")], {"2도": "M01"})
        self.req("POST", "/api/rdp/push/P-W01")
        self.assertEqual(self.codes(), [("M01", "2도", "B2")])
        rev = self.read_pattern("P-W01").get("updatedAt")
        for want in ("M02", ""):
            d = self.read_pattern("P-W01")
            d["variations"][0]["layerPatterns"] = {"2도": want} if want else {}
            d["variations"][0]["layerPatternsFrom"] = {"2도": ["HACK"]}   # 클라이언트 값은 무시
            st, r = self.put("P-W01", d, rev=rev)
            self.assertEqual(st, 200, r)
            rev = r["savedAt"]
            self.assertNotIn("HACK", json.dumps(self.read_pattern("P-W01")))
            st, r = self.req("GET", "/api/rdp/push-preview/P-W01")
            self.assertEqual(r["inserts"], [], r)
            self.assertEqual([m["to"] for m in r["moves"]], [want or "W01"], r)
            self.req("POST", "/api/rdp/push/P-W01")
            self.assertEqual(self.codes(), [(want or "W01", "2도", "B2")])

    def test_diff_uses_layer_code(self):
        self.db_insert("P", "M01", "2도", "B2", "26_002", coating="K-1")
        self.w01([mix("2도", "B2", "26_002")], {"2도": "M01"})
        st, r = self.req("GET", "/api/rdp/diff/P-W01")
        # M01 코드 행과 같은 배합으로 매칭되어야 한다 (날짜만 달라서 changed로 잡힘)
        self.assertEqual((r["same"] + len(r["changed"]), r["archiveOnly"], r["dbOnly"]), (1, [], []), r)


class SharedBatchTests(Base):
    """rdp.db는 (프로젝트, 패턴 코드, 동판, 도수, 배치)가 UNIQUE — 여러 컬러가 한 배합을 같이 쓴다."""

    def two_colors(self, m1, m2, **v1):
        doc = pattern("P-L1", "P", "L1", [
            dict({"id": "v01", "colorCode": "C 3928", "mixes": m1}, **v1),
            {"id": "v02", "colorCode": "BHY", "mixes": m2}])
        self.write_pattern(doc)

    def test_shared_batch_same_values_goes_once(self):
        self.two_colors([mix("1도", "나", "26_135"), mix("2도", "C", "26_135")],
                        [mix("1도", "다", "26_135"), mix("2도", "C", "26_135")])
        st, r = self.req("GET", "/api/rdp/push-preview/P-L1")
        self.assertEqual(sorted(i["batch"] for i in r["inserts"]), ["C", "나", "다"])
        self.assertEqual([(x["vid"], x["batch"]) for x in r["shared"]], [("v02", "C")])
        self.assertEqual(r["skipped"], [])
        st, r = self.req("POST", "/api/rdp/push/P-L1")
        self.assertEqual((st, r["inserted"], r["failed"]), (200, 3, []))
        st, r = self.req("GET", "/api/rdp/push-preview/P-L1")   # 두 번째 보내기도 실패하지 않는다
        self.assertEqual((r["inserts"], r["updates"]), ([], []))
        st, r = self.req("POST", "/api/rdp/push/P-L1")
        self.assertEqual(st, 200, r)

    def test_shared_batch_different_values_is_flagged(self):
        self.two_colors([mix("2도", "C", "26_135", bk=5)], [mix("2도", "C", "26_135", bk=9)])
        st, r = self.req("GET", "/api/rdp/push-preview/P-L1")
        self.assertEqual(len(r["inserts"]), 1)
        self.assertIn("값이 다름", r["skipped"][0]["reason"])

    def test_preview_matches_push_when_key_already_in_db(self):
        self.db_insert("P", "L1", "2도", "C", "26_135", coating="ZZZ")   # 다른 곳에서 보낸 행
        self.two_colors([mix("2도", "D", "26_135")], [mix("2도", "C", "26_135", bk=7)])
        st, r = self.req("GET", "/api/rdp/push-preview/P-L1")
        self.assertEqual([i["batch"] for i in r["inserts"]], ["D"])
        self.assertIn("이미 있음", r["skipped"][0]["reason"])
        st, r = self.req("POST", "/api/rdp/push/P-L1")
        self.assertEqual((st, r["inserted"], r["failed"]), (200, 1, []))

    def test_code_move_onto_existing_key_does_not_fail_push(self):
        self.db_insert("P", "L1", "2도", "C", "26_135", coating="C 3928")
        self.db_insert("P", "M01", "2도", "C", "26_135", coating="ZZZ")
        self.two_colors([mix("2도", "C", "26_135"), mix("1도", "A", "26_135")], [],
                        layerPatterns={"2도": "M01"})
        st, r = self.req("GET", "/api/rdp/push-preview/P-L1")
        self.assertEqual(r["moves"], [])
        self.assertIn("옮길 코드 M01", r["skipped"][0]["reason"])
        st, r = self.req("POST", "/api/rdp/push/P-L1")
        self.assertEqual((st, r["inserted"]), (200, 1), r)

    def test_apply_push_survives_race_on_move(self):
        """미리보기 뒤 누군가 같은 키를 넣어도 전체 실패 대신 그 행만 failed."""
        self.db_insert("P", "L1", "2도", "C", "26_135", coating="C 3928")
        self.two_colors([mix("2도", "C", "26_135")], [], layerPatterns={"2도": "M01"})
        doc = self.read_pattern("P-L1")
        plan = server.plan_push(doc, server.load_doc_rows(doc, []), taken=server.db_taken_keys(doc))
        self.assertEqual(len(plan["moves"]), 1)
        self.db_insert("P", "M01", "2도", "C", "26_135", coating="ZZZ")    # 그 사이에 생김
        res = server.apply_push("P", "L1", doc, plan)
        self.assertEqual((res["moved"], len(res["failed"])), (0, 1))
        self.assertEqual(self.db_counts(), {("P", "L1"): 1, ("P", "M01"): 1})

# ---- Cloudflare Access JWT
def _keypair():
    # 테스트용 1024bit RSA 키 (고정 시드에서 소수를 찾는다)
    def is_prime(n):
        if n < 2:
            return False
        for sp in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
            if n % sp == 0:
                return n == sp
        d, s = n - 1, 0
        while d % 2 == 0:
            d //= 2; s += 1
        for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
            x = pow(a, d, n)
            if x in (1, n - 1):
                continue
            for _ in range(s - 1):
                x = pow(x, 2, n)
                if x == n - 1:
                    break
            else:
                return False
        return True

    def next_prime(n):
        n |= 1
        while not is_prime(n):
            n += 2
        return n
    p = next_prime(int.from_bytes(hashlib.sha512(b"p").digest(), "big") >> 1 | (1 << 511))
    q = next_prime(int.from_bytes(hashlib.sha512(b"q").digest(), "big") >> 1 | (1 << 511))
    n, e = p * q, 65537
    d = pow(e, -1, (p - 1) * (q - 1))
    return n, e, d


N, E_, D = _keypair()
TEAM = "myteam.cloudflareaccess.com"


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_jwt(payload, d=D, kid="k1", alg="RS256"):
    h = b64u(json.dumps({"alg": alg, "kid": kid}).encode())
    p = b64u(json.dumps(payload).encode())
    k = (N.bit_length() + 7) // 8
    t = server._SHA256_PREFIX + hashlib.sha256(f"{h}.{p}".encode()).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    sig = pow(int.from_bytes(em, "big"), d, N).to_bytes(k, "big")
    return f"{h}.{p}.{b64u(sig)}"


class AccessTests(Base):
    def setUp(self):
        super().setUp()
        server.CFG.update(requireCfAccess=True, cfAccessTeamDomain="myteam", allowHosts=["rdp.example.com"])
        server.SAFE_HOSTS.add("rdp.example.com")
        self.keys = mock.patch.object(server, "jwks_key", lambda team, kid: (N, E_) if (team, kid) == (TEAM, "k1") else None)
        self.keys.start()

    def tearDown(self):
        self.keys.stop()
        super().tearDown()

    def get(self, token=None, host="rdp.example.com", extra=None):
        h = {"Host": host, "Cf-Ray": "abc"}
        if token:
            h["Cf-Access-Jwt-Assertion"] = token
        h.update(extra or {})
        return self.req("GET", "/api/patterns", headers=h)[0]

    def good(self, **kw):
        p = {"iss": f"https://{TEAM}", "exp": time.time() + 600, "email": "me@x.com", "aud": ["A"]}
        p.update(kw)
        return p

    def test_valid_token_passes(self):
        self.assertEqual(self.get(make_jwt(self.good())), 200)

    def test_forged_token_rejected(self):
        self.assertEqual(self.get(make_jwt(self.good(), d=D + 2)), 403)
        unsigned = make_jwt(self.good()).rsplit(".", 1)[0] + ".AAAA"
        self.assertEqual(self.get(unsigned), 403)
        self.assertEqual(self.get(make_jwt(self.good(), alg="none")), 403)

    def test_expired_wrong_issuer_rejected(self):
        self.assertEqual(self.get(make_jwt(self.good(exp=time.time() - 5))), 403)
        self.assertEqual(self.get(make_jwt(self.good(iss="https://evil.cloudflareaccess.com"))), 403)
        self.assertEqual(self.get(), 403)

    def test_email_and_aud(self):
        server.CFG.update(cfAccessEmail="me@x.com", cfAccessAud="A")
        self.assertEqual(self.get(make_jwt(self.good())), 200)
        self.assertEqual(self.get(make_jwt(self.good(email="you@x.com"))), 403)
        self.assertEqual(self.get(make_jwt(self.good(aud=["B"]))), 403)

    def test_no_team_domain_fails_closed(self):
        server.CFG.pop("cfAccessTeamDomain")
        self.assertEqual(self.get(make_jwt(self.good())), 403)

    def test_localhost_via_tunnel_needs_token(self):
        self.assertEqual(self.get(host="localhost"), 403)               # Cf-Ray 있음 = 터널 경유
        self.assertEqual(self.req("GET", "/api/patterns")[0], 200)      # 이 맥에서 직접

    def test_broken_config_keeps_auth(self):
        with open(server.CONFIG_PATH, "w") as f:
            f.write("{ broken")
        server._CFG_MTIME = None
        self.assertEqual(self.get(), 403)
        self.assertTrue(server.CFG.get("requireCfAccess"))
        with open(server.CONFIG_PATH, "w") as f:
            json.dump({"requireCfAccess": False, "allowHosts": ["rdp.example.com"]}, f)
        os.utime(server.CONFIG_PATH, (time.time() + 5, time.time() + 5))
        self.assertEqual(self.get(), 200)   # 정상 config는 그대로 반영된다


if __name__ == "__main__":
    unittest.main()
