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
  // 작업장소는 컬러마다 판정하지만 칩 숫자는 '장(시편)' — 눌렀을 때 결과의 N장과 같다.
  // A 는 두 컬러 모두 미성통상 → 1장 · 컬러 2개
  assert.deepEqual(byKind.place.values.map((v) => `${v.val}:${v.n}`).sort(), ["API:1", "미성통상:1"]);
  assert.equal(byKind.place.values.find((v) => v.val === "미성통상").colors, 2);
  assert.deepEqual(byKind.layers.values.map((v) => `${v.val}:${v.n}`), ["1도:2", "2도:1"]);
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

test("자동 태그 도수 — layerPlates 가 비어도 배합 도수를 센다", () => {
  const p1 = { pattern: { code: "G-1" }, variations: [
    { id: "v01", layerPlates: { "2도": "26_012" }, mixes: [{ layer: "1도" }, { layer: "2도" }] }] };
  const p2 = { pattern: { code: "G-2" }, variations: [
    { id: "v01", layerPlates: { "1도": "26_012" }, mixes: [{ layer: "1도" }] }] };
  const rows = autoFacets([p1, p2], null, 6).filter((r) => r.kind === "layers");
  const vals = rows[0].values.map((v) => v.val).sort();
  assert.deepEqual(vals, ["1도", "2도"]);      // p1 이 1도로 새지 않는다
  const one = rows[0].values.find((v) => v.val === "1도");
  assert.equal(one.n, 1);
});

test("자동 태그 — 개발년도(최근 순) · 담당자 · 제안차종(프로젝트+제안 차종) · 도장 컬러", async () => {
  const { autoFacets } = await import("../web/js/facets.js");
  const ps = [
    { project: "HX5", pattern: { code: "M-60213-F2", developer: "담당자A", vehicles: ["KQ2"] }, variations: [{ coating: [{ code: "C-1" }] }] },
    { project: "KQ2", pattern: { code: "G-51104-T1", developer: "담당자B" }, variations: [{ coating: [{ code: "C-2" }, { code: "C-2" }] }] },
    { project: "HX5", pattern: { code: "G-50301-F1", developer: "담당자A" }, variations: [{ coating: [{ code: "C-1" }] }] },
  ];
  const rows = Object.fromEntries(autoFacets(ps, null, 6).map((r) => [r.kind, r.values.map((v) => `${v.val}:${v.n}`)]));
  assert.deepEqual(rows.devyear, ["2026:1", "2025:2"]);
  assert.deepEqual(rows.developer, ["담당자A:2", "담당자B:1"]);
  assert.deepEqual(rows.project, ["HX5:2", "KQ2:2"]);
  assert.deepEqual(rows.coat, ["C-1:2", "C-2:1"]);
});

test("도장 컬러 칩 숫자 = 걸리는 시편 수 (컬러 수는 따로)", async () => {
  const { autoFacets } = await import("../web/js/facets.js");
  const ps = [
    { pattern: { code: "G-1" }, variations: [{ id: "v1", coating: [{ code: "DC-1" }] }, { id: "v2", coating: [{ code: "DC-1" }] }, { id: "v3", coating: [{ code: "DC-2" }] }] },
    { pattern: { code: "G-2" }, variations: [{ id: "v1", coating: [{ code: "DC-1" }] }] },
  ];
  const coat = autoFacets(ps, null, 6).find((r) => r.kind === "coat");
  const dc1 = coat.values.find((v) => v.val === "DC-1");
  assert.deepEqual([dc1.n, dc1.colors], [2, 3]);   // 2장 · 컬러 3개
});

test("자동 태그 — 추가 제안차종이 하나도 없으면 '제안차종 (추가 포함)'은 숨긴다(대표 목록과 같아서)", async () => {
  const { autoFacets } = await import("../web/js/facets.js");
  const ps = [{ project: "HX5", pattern: { code: "A" }, variations: [{}] }, { project: "KQ2", pattern: { code: "B" }, variations: [{}] }];
  assert.equal(autoFacets(ps, () => ({})).some((r) => r.kind === "project"), false);
  ps[0].pattern.vehicles = ["NQ5"];
  const row = autoFacets(ps, () => ({})).find((r) => r.kind === "project");
  assert.equal(row.label, "제안차종 (추가 포함)");
  assert.deepEqual(row.values.map((v) => v.val).sort(), ["HX5", "KQ2", "NQ5"]);
});
