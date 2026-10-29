/* 색 정렬 표시 규칙 테스트 — 브라우저 없이 돈다.
 *   실행: node --test tests/color-rules.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bestVar, deLabel, baseVid, badgeFor } from "../web/js/color-rules.js";

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

/* --- 카드 사진과 배지가 같은 컬러를 가리키게 (2차 지적) --------------------- */
test("baseVid — sel → best → first 우선순위", () => {
  const best = { vid: "v02", de: 2.3 };
  assert.equal(baseVid({ sel: "v03", best, first: "v01" }), "v03", "고른 컬러가 최우선");
  assert.equal(baseVid({ best, first: "v01" }), "v02", "색 정렬이면 가장 가까운 컬러");
  assert.equal(baseVid({ first: "v01" }), "v01", "평소에는 첫 컬러");
  assert.equal(baseVid({}), null);
});

test("badgeFor — 가장 가까운 컬러면 isBest, 다른 컬러면 그 컬러의 ΔE", () => {
  const best = { vid: "v02", de: 2.3 };
  assert.deepEqual(badgeFor("P1", "v02", de, best), { de: 2.3, label: "비슷", isBest: true });
  assert.deepEqual(badgeFor("P1", "v01", de, best), { de: 8.4, label: "8.4", isBest: false });
});

test("badgeFor — 그 컬러의 ΔE 가 없으면 null(배지를 숨긴다)", () => {
  const best = { vid: "v02", de: 2.3 };
  assert.equal(badgeFor("P1", "v99", de, best), null);
  assert.equal(badgeFor("P9", "v01", de, best), null, "다른 시편");
  assert.equal(badgeFor("P1", "", de, best), null);
  assert.equal(badgeFor("P1", "v01", null, best), null);
});
