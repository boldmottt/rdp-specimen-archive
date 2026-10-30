/* 동판 대장 규칙 테스트 — 실행: node --test tests/plates.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { archivePlateUse, mergePlates, plateMatches } from "../web/js/plate-rules.js";

const pats = [
  { id: "P-W01", project: "P", pattern: { code: "W01" }, work: { plate: ["26_001"] },
    variations: [{ id: "v01", colorName: "브라운", layerPlates: { "1도": "26_001", "2도": "26_002" },
      mixes: [{ layer: "2도", plate: "26_009" }] }] },
  { id: "P-M01", project: "P", pattern: { code: "M01" }, work: {}, variations: [{ id: "v01", colorCode: "K-1", layerPlates: { "1도": "26_001" } }] },
];

test("아카이브 사용: 작업 동판·도수별 동판·배합 줄 동판을 모두 센다", () => {
  const m = archivePlateUse(pats);
  assert.deepEqual([...m.keys()].sort(), ["26_001", "26_002", "26_009"]);
  assert.deepEqual(m.get("26_001").map((e) => [e.code, e.layers, e.colors]), [["M01", ["1도"], ["K-1"]], ["W01", ["1도"], ["브라운"]]]);
  assert.deepEqual(m.get("26_009")[0].layers, ["2도"], "배합 줄의 예외 동판도");
});

test("세 곳을 동판 하나로 — 최근 활동 먼저, DB 미등록·미사용 표시", () => {
  const db = [{ lot: "26_001", type: "부식", created: "2026-01-02", usedBy: [] }, { lot: "25_100", created: "2025-05-01", usedBy: [] }];
  const wl = [{ lot: "26_002", first: "2026-02-01", last: "2026-03-01", days: 2, patterns: ["P-W01"] }];
  const rows = mergePlates(db, pats, wl);
  assert.deepEqual(rows.map((r) => r.lot), ["26_002", "26_001", "25_100", "26_009"]);
  const r2 = rows.find((r) => r.lot === "26_002");
  assert.equal(r2.flags.notInDb, true);
  assert.equal(r2.worklog.days, 2);
  assert.equal(rows.find((r) => r.lot === "25_100").flags.unused, true);
  assert.equal(rows.find((r) => r.lot === "26_001").flags.notInDb, false);
});

test("DB 를 못 읽었으면(빈 목록) 'DB 미등록'이라고 하지 않는다", () => {
  const rows = mergePlates([], pats, []);
  assert.ok(rows.every((r) => !r.flags.notInDb));
});

test("검색 — 동판·종류·패턴 코드·컬러", () => {
  const rows = mergePlates([{ lot: "26_001", type: "부식", usedBy: [] }], pats, []);
  const lots = (q) => rows.filter((r) => plateMatches(r, q)).map((r) => r.lot).sort();
  assert.deepEqual(lots("부식"), ["26_001"]);
  assert.deepEqual(lots("m01"), ["26_001"]);
  assert.deepEqual(lots("브라운"), ["26_001", "26_002", "26_009"]);
  assert.equal(lots("").length, 3);
});
