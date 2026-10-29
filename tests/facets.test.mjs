/* 값 집계·표기 정리 테스트 — node --test tests/facets.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { valueCounts, canonical, isNewValue } from "../web/js/facets.js";

const pats = [
  { client: "현대자동차" }, { client: "현대자동차" }, { client: "기아자동차" },
  { client: "  " }, { client: "" }, { client: null },
];

test("valueCounts — 많은 순, 빈 값 제외", () => {
  assert.deepEqual(valueCounts(pats, (p) => p.client), [
    { val: "현대자동차", n: 2 }, { val: "기아자동차", n: 1 },
  ]);
});

test("valueCounts — 배열 값도 센다", () => {
  assert.deepEqual(valueCounts([{ tags: ["a", "b"] }, { tags: ["b"] }], (p) => p.tags), [
    { val: "b", n: 2 }, { val: "a", n: 1 },
  ]);
});

test("canonical — 공백·NFC 정리", () => {
  assert.equal(canonical("  현대   자동차 ", ["현대자동차"]), "현대 자동차");  // 공백 하나로
  assert.equal(canonical("현대자동차", []), "현대자동차");
  assert.equal(canonical("", ["x"]), "");
});

test("canonical — 대소문자만 다르면 기존 표기로 맞춘다", () => {
  assert.equal(canonical("hyundai", ["HYUNDAI"]), "HYUNDAI");
  assert.equal(canonical("HYUNDAI", ["현대자동차", "HYUNDAI"]), "HYUNDAI");
});

test("isNewValue — 기존 값에 없으면 true(저장은 막지 않음)", () => {
  assert.equal(isNewValue("현대", ["현대자동차"]), true);
  assert.equal(isNewValue("hyundai", ["HYUNDAI"]), false);
  assert.equal(isNewValue("", ["HYUNDAI"]), false);
});
