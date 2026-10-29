/* 색 정렬 표시 규칙 테스트 — 브라우저 없이 돈다.
 *   실행: node --test tests/color-rules.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bestVar, deLabel } from "../web/js/color-rules.js";

const de = new Map([["P1/v01", 8.4], ["P1/v02", 2.3], ["P1/v03", 5.0], ["P2/v01", 1.0]]);

test("bestVar — 걸린 컬러 중 ΔE 최솟값을 고른다", () => {
  assert.deepEqual(bestVar("P1", ["v01", "v02", "v03"], de), { vid: "v02", de: 2.3 });
  assert.deepEqual(bestVar("P1", ["v01", "v03"], de), { vid: "v03", de: 5 });
});

test("bestVar — ΔE 가 없는 컬러는 건너뛴다", () => {
  // v02 는 de 에 없음(사진 없음·계산 실패 등) → v01
  assert.deepEqual(bestVar("P1", ["v02", "v01"], new Map([["P1/v01", 8.4]])), { vid: "v01", de: 8.4 });
});

test("bestVar — 전부 없거나 입력이 비면 null", () => {
  assert.equal(bestVar("P9", ["v01"], de), null, "다른 시편");
  assert.equal(bestVar("P1", [], de), null, "걸린 컬러 없음");
  assert.equal(bestVar("P1", ["v01"], null), null, "ΔE 표 없음");
  assert.equal(bestVar("P1", null, de), null);
});

test("deLabel — 2 이하 거의 같음, 5 이하 비슷, 그 외 숫자", () => {
  assert.equal(deLabel(1.2), "거의 같음");
  assert.equal(deLabel(2), "거의 같음");
  assert.equal(deLabel(3.4), "비슷");
  assert.equal(deLabel(5), "비슷");
  assert.equal(deLabel(8.44), "8.4");
  assert.equal(deLabel(undefined), "");
});
