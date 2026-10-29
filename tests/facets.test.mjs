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

/* --- 자동 태그(파생) --- */
import { autoFacets } from "../web/js/facets.js";

const pats2 = () => ([
  { id: "A", client: "현대자동차", pattern: { code: "G-1" }, work: { place: "미성통상" },
    variations: [{ id: "v1", layerPlates: { "1도": "x", "2도": "y" } }, { id: "v2", layerPlates: { "1도": "x" } }] },
  { id: "B", client: "HYUNDAI", pattern: { code: "M-2" }, work: {},
    variations: [{ id: "v1", layerPlates: { "1도": "x" }, work: { place: "API" } }] },
  { id: "C", client: "미정", pattern: { code: "M-3" }, work: {}, variations: [{ id: "v1" }] },
]);
const wf = (p, v) => ({ ...(p.work || {}), ...((v || {}).work || {}) });

test("autoFacets — 종류별 값과 개수", () => {
  const f = autoFacets(pats2(), wf);
  const byKind = Object.fromEntries(f.map((x) => [x.kind, x]));
  assert.deepEqual(byKind.code.values.map((v) => `${v.val}:${v.n}`), ["M:2", "G:1"]);
  assert.deepEqual(byKind.client.values.map((v) => `${v.val}:${v.n}`), ["현대자동차:1", "HYUNDAI:1"]);
  // 작업장소는 컬러 단위로 센다(A 는 두 컬러 모두 공통값 미성통상 → 2)
  assert.deepEqual(byKind.place.values.map((v) => `${v.val}:${v.n}`), ["미성통상:2", "API:1"]);
  assert.deepEqual(byKind.layers.values.map((v) => v.val), ["1도"]);
});

test("autoFacets — 빈 값과 미정은 칩을 만들지 않는다", () => {
  const f = autoFacets(pats2(), wf);
  const clients = f.find((x) => x.kind === "client").values.map((v) => v.val);
  assert.ok(!clients.includes("미정"));
});

test("autoFacets — 값이 1종류뿐인 종류는 숨긴다", () => {
  const one = [{ client: "현대자동차", pattern: { code: "G-1" }, variations: [{ id: "v1", layerPlates: { "1도": "x" } }] }];
  const kinds = autoFacets(one, wf).map((x) => x.kind);
  assert.ok(!kinds.includes("code"), "전부 G 하나면 계열은 숨김");
  assert.ok(!kinds.includes("client"));
  assert.ok(!kinds.includes("layers"));
});

test("autoFacets — 종류별 상한(topPerKind)", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ client: `고객${i}`, pattern: { code: `G-${i}` }, variations: [{ id: "v1" }] }));
  const f = autoFacets(many, wf, 6).find((x) => x.kind === "client");
  assert.equal(f.values.length, 6);
});
