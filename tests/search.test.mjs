/* 목차 검색 문법 단위 테스트 — 브라우저 없이 돈다.
 *   실행: node --test tests/search.test.mjs      (CI의 js-syntax 작업에서도 돌린다)
 *
 * 이 테스트가 지키는 것 (여기가 깨지면 검색이 예전과 달라졌다는 뜻)
 *   1. 문법을 안 쓴 검색은 예전과 똑같이 "부분 문자열 하나"로 동작한다
 *   2. #태그 · @프로젝트 · plate: · color: · status: 와 -제외가 의도대로 걸린다
 *   3. 컬러 문법이 있으면 "걸린 컬러만" 남는다 (담기·CSV 범위가 여기서 결정된다)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, matchVars, patternHay, tagToken, withoutToken, tokenize, fieldToken } from "../web/js/search.js";

/* 실제 데이터 모양을 줄인 고정 시편들 */
const mk = (id, code, project, tags, vars) => ({
  id, project, client: "현대자동차", projectName: project,
  pattern: { code, name: "", nameKo: "", tags },
  label: { type: "Padprint Layer 1" },
  work: { plate: ["26_012"] },
  variations: vars,
});
const P1 = mk("G-1", "G-101", "MQ5", ["컬러세미나", "메탈 브라운"], [
  { id: "v01", colorCode: "B3961", colorName: "블랙", status: "가승인", layerPlates: { "1도": "26_015" } },
  { id: "v02", colorCode: "F3024", colorName: "실버", status: "작업중", layerPlates: { "1도": "26_015" } },
]);
const P2 = mk("G-2", "G-202", "GL3", ["멜란지"], [
  { id: "v01", colorCode: "E3940", colorName: "메탈 브라운", status: "가승인", layerPlates: { "1도": "26_103" },
    mixes: [{ plate: "25_188" }] },
]);
const ALL = [P1, P2];
const run = (q) => {
  const Q = parseQuery(q);
  const out = new Map();
  ALL.forEach((p) => { const v = matchVars(p, Q); if (v) out.set(p.id, v); });
  return out;
};

test("문법이 없으면 예전처럼 부분 문자열 하나로 찾는다", () => {
  assert.deepEqual([...run("G-101").keys()], ["G-1"]);
  assert.deepEqual([...run("g-101").keys()], ["G-1"], "대소문자 무시");
  assert.deepEqual([...run("  g-101  ").keys()], ["G-1"], "앞뒤 공백 무시");
  assert.deepEqual([...run("E3940").keys()], ["G-2"], "컬러 코드도 전문 검색에 걸린다");
  assert.deepEqual([...run("없는말").keys()], []);
});

test("여러 단어는 한 덩어리로 이어 붙여 찾는다(예전과 같게)", () => {
  const Q = parseQuery("메탈  브라운");
  assert.equal(Q.text, "메탈 브라운", "공백은 하나로 정리된다");
});

test("#태그", () => {
  assert.deepEqual([...run("#컬러세미나").keys()], ["G-1"]);
  assert.deepEqual([...run("#멜란지").keys()], ["G-2"]);
  assert.deepEqual([...run("#없는태그").keys()], []);
});

test("공백 있는 태그는 따옴표로", () => {
  assert.deepEqual([...run('#"메탈 브라운"').keys()], ["G-1"]);
  assert.equal(tagToken("메탈 브라운"), '#"메탈 브라운"');
  assert.equal(tagToken("멜란지"), "#멜란지");
});

test("@프로젝트 와 -제외", () => {
  assert.deepEqual([...run("@MQ5").keys()], ["G-1"]);
  assert.deepEqual([...run("-@MQ5").keys()], ["G-2"], "제외도 된다");
  assert.deepEqual([...run("#컬러세미나 -@MQ5").keys()], [], "걸리고 제외되면 탈락");
});

test("color: 는 걸린 컬러만 남긴다", () => {
  assert.deepEqual(run("color:E3940").get("G-2"), ["v01"]);
  assert.deepEqual(run("color:실버").get("G-1"), ["v02"], "컬러 이름으로도");
  assert.deepEqual(run("color:B3961").get("G-1"), ["v01"]);
});

test("status: 는 상태가 같은 컬러만", () => {
  assert.deepEqual(run("status:가승인").get("G-1"), ["v01"]);
  assert.deepEqual([...run("status:없는상태").keys()], []);
});

test("plate: 는 작업 동판·도수별 동판·배합 동판을 모두 본다", () => {
  assert.deepEqual([...run("plate:26_012").keys()], ["G-1", "G-2"], "work.plate");
  assert.deepEqual(run("plate:26_103").get("G-2"), ["v01"], "layerPlates");
  assert.deepEqual(run("plate:25_188").get("G-2"), ["v01"], "mixes[].plate");
});

test("컬러 문법이 없으면 컬러는 전부 남는다", () => {
  assert.deepEqual(run("#컬러세미나").get("G-1"), ["v01", "v02"]);
});

test("토큰 지우기 — 칩을 다시 누르면 그 태그만 빠진다", () => {
  const q = "#컬러세미나 @MQ5";
  assert.equal(withoutToken(q, (t) => t.sigil === "#"), "@MQ5");
  assert.equal(tokenize("#컬러세미나 @MQ5").length, 2);
});

test("patternHay 는 태그·도수 패턴·배합 동판까지 훑는다", () => {
  const h = patternHay(P2);
  assert.ok(h.includes("멜란지"));
  assert.ok(h.includes("26_103"));
  assert.ok(h.includes("25_188"));
});

/* --- 3차 지적: 고객사 · 계열 · 작업장소 · 도수 축 ------------------------- */
const P3 = {
  id: "G-3", project: "NKO", client: "현대자동차", projectName: "NKO",
  pattern: { code: "G-60813-L1", name: "", nameKo: "", tags: [] },
  work: { place: "미성통상" },
  variations: [
    { id: "v01", colorCode: "A1", status: "가승인", layerPlates: { "1도": "26_1", "2도": "26_2" } },
    { id: "v02", colorCode: "A2", status: "가승인", layerPlates: { "1도": "26_1" }, work: { place: "API" } },
  ],
};
const P4 = {
  id: "M-4", project: "X", client: "HYUNDAI",
  pattern: { code: "M-50527-W6", name: "", nameKo: "", tags: [] },
  work: {}, variations: [{ id: "v01", colorCode: "B1" }],
};
const run2 = (q, list) => {
  const Q = parseQuery(q);
  const out = new Map();
  (list || [P3, P4]).forEach((p) => { const v = matchVars(p, Q); if (v) out.set(p.id, v); });
  return out;
};

test("client: — 대소문자를 무시한다", () => {
  assert.deepEqual([...run2("client:현대자동차").keys()], ["G-3"]);
  assert.equal(run2("client:hyundai").size, 1, "다른 시편(HYUNDAI)도 걸린다");
});

test("-client: — 제외도 된다", () => {
  assert.deepEqual([...run2("-client:현대자동차").keys()], ["M-4"]);
});

test("code: — 앞부분 일치(계열 묶음)", () => {
  assert.deepEqual([...run2("code:G").keys()], ["G-3"]);
  assert.deepEqual([...run2("code:M-50").keys()], ["M-4"]);
});

test("place: — 컬러별 유효값으로 걸러 같은 패턴의 다른 컬러는 남는다", () => {
  assert.deepEqual(run2("place:API").get("G-3"), ["v02"], "덮어쓴 컬러만");
  assert.deepEqual(run2("place:미성통상").get("G-3"), ["v01"], "공통값을 물려받은 컬러만");
});

test("layers: — 인쇄 도수 개수", () => {
  assert.deepEqual(run2("layers:2").get("G-3"), ["v01"]);
  assert.deepEqual(run2("layers:1").get("G-3"), ["v02"]);
});

test("fieldToken — 공백이 있으면 따옴표로 감싼다", () => {
  assert.equal(fieldToken("client", "현대자동차"), "client:현대자동차");
  assert.equal(fieldToken("place", "미성 통상"), 'place:"미성 통상"');
});
