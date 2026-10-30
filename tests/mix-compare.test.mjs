/* 배치 비교 규칙 테스트 — 실행: node --test tests/mix-compare.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { batchCompare, deltaText } from "../web/js/mix-compare.js";

const mixes = [
  { batch: "B1", inks: { MT: 10, BK: 2 }, thinnerPct: 20, result: "ng", change: "첫 배합" },
  { batch: "B2", inks: { MT: 10, BK: 2.5 }, thinnerPct: 20, result: "warn" },
  { batch: "B3", inks: { MT: 9.5, BK: 2.5, WH: 1 }, thinnerPct: 25, result: "ok", isReference: true },
];

test("배치는 열, 잉크·합·첨가제는 행 — 앞 배치와의 차이", () => {
  const r = batchCompare(mixes);
  assert.deepEqual(r.batches.map((b) => b.batch), ["B1", "B2", "B3"]);
  assert.equal(r.batches[2].isReference, true);
  const bk = r.rows.find((x) => x.key === "ink:BK");
  assert.deepEqual(bk.cells.map((c) => c.d), [null, 0.5, 0]);
  assert.deepEqual(bk.cells.map((c) => c.changed), [false, true, false]);
  const wh = r.rows.find((x) => x.key === "ink:WH");
  assert.deepEqual(wh.cells.map((c) => c.v), [null, null, 1]);
  assert.deepEqual(wh.cells.map((c) => c.changed), [false, false, true], "새로 생긴 잉크도 바뀐 것");
  const total = r.rows.find((x) => x.key === "total");
  assert.deepEqual(total.cells.map((c) => c.v), [12, 12.5, 13]);
  const th = r.rows.find((x) => x.key === "thinnerPct");
  assert.deepEqual(th.cells.map((c) => c.d), [null, 0, 5]);
  assert.ok(!r.rows.some((x) => x.key === "thinnerG"), "값이 없는 첨가제 행은 만들지 않는다");
});

test("잉크 순서는 넘겨준 함수를 따른다", () => {
  const r = batchCompare(mixes, (names) => names.slice().sort().reverse());
  assert.deepEqual(r.rows.filter((x) => x.key.startsWith("ink:")).map((x) => x.label), ["WH", "MT", "BK"]);
});

test("부동소수 오차 없이 차이를 낸다", () => {
  const r = batchCompare([{ batch: "A", inks: { MT: 0.1 } }, { batch: "B", inks: { MT: 0.3 } }]);
  assert.equal(r.rows[0].cells[1].d, 0.2);
});

test("deltaText", () => {
  assert.equal(deltaText(0.5), "+0.5");
  assert.equal(deltaText(-1), "−1");
  assert.equal(deltaText(0), "");
  assert.equal(deltaText(null), "");
});
