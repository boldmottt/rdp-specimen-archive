/* 시편 나란히 비교 규칙 테스트 — 실행: node --test tests/compare.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { compareRows, layerRecipe, toggleCompare, COMPARE_MAX } from "../web/js/compare-rules.js";

const A = { p: { project: "P", client: "A사", pattern: { code: "W01", nameKo: "우드" }, label: { type: "Padprint 2도" }, work: { worker: "김" } },
  v: { id: "v1", colorName: "브라운", status: "가승인", layerPlates: { "1도": "26_001" },
    mixes: [{ layer: "1도", batch: "B1", inks: { MT: 10, BK: 2 } }, { layer: "1도", batch: "B2", inks: { MT: 9.5, BK: 2.5 }, isReference: true, thinnerPct: 20 }] } };
const B = { p: { project: "P", client: "A사", pattern: { code: "W02" }, label: { type: "Padprint 2도" }, work: { worker: "박" } },
  v: { id: "v1", colorName: "그레이", status: "가승인", layerPlates: { "1도": "26_001", "2도": "26_002" },
    mixes: [{ layer: "2도", batch: "1", inks: { WH: 5 } }] } };

test("대표 배합: 기준(*) 우선, 첨가제, 배치 수", () => {
  assert.equal(layerRecipe(A.v.mixes, "1도"), "B2*: MT 9.5 · BK 2.5 / 신나 20% (배치 2)");
  assert.equal(layerRecipe(B.v.mixes, "2도"), "1: WH 5");
  assert.equal(layerRecipe(B.v.mixes, "1도"), "");
});

test("행 맞추기 — 같으면 differ=false, 다르면 true, 모두 빈 행은 없음", () => {
  const rows = compareRows([A, B]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(by.code.values, ["W01 · 우드", "W02"]);
  assert.equal(by.status.differ, false);
  assert.equal(by.client.differ, false);
  assert.equal(by["label.type"].differ, false, "라벨은 컬러 값이 없으면 공통값");
  assert.equal(by["work.worker"].differ, true);
  assert.deepEqual(by["plate.1도"].values, ["26_001", "26_001"]);
  assert.deepEqual(by["plate.2도"].values, ["", "26_002"]);
  assert.equal(by["mix.2도"].differ, true);
  assert.ok(!("work.place" in by), "모두 빈 항목은 행을 만들지 않는다");
  assert.ok(!("note" in by));
});

test("workOf·vName 을 넘기면 그걸 쓴다", () => {
  const rows = compareRows([A, B], { workOf: (p, v) => ({ worker: v.id === "v1" ? "같음" : "" }), vName: (v) => "#" + v.colorName });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by["work.worker"].differ, false);
  assert.deepEqual(by.color.values, ["#브라운", "#그레이"]);
});

test("비교 목록 넣기/빼기 · 최대 개수", () => {
  let r = toggleCompare([], "a", "1");
  assert.deepEqual([r.list, r.added], [[{ pid: "a", vid: "1" }], true]);
  r = toggleCompare(r.list, "a", "1");
  assert.deepEqual([r.list, r.added], [[], false]);
  const full = Array.from({ length: COMPARE_MAX }, (_, i) => ({ pid: "p" + i, vid: "v" }));
  r = toggleCompare(full, "x", "v");
  assert.equal(r.full, true);
  assert.equal(r.list.length, COMPARE_MAX);
});
