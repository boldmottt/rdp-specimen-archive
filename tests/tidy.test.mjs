/* 정리 도구 규칙 테스트 — 실행: node --test tests/tidy.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { slotsOf, findMatches, applyReplace, makeFinder, fingerprint, clusterValues, mergeValues, tagUsage, qualityIssues, tidySpaces } from "../web/js/tidy-rules.js";

const mk = () => [
  { id: "A", project: "P", client: "한빛 가구", pattern: { code: "W01", name: "Oak", tags: ["우드", "질감:우드"] }, work: { worker: "홍길동", place: "1공장" },
    variations: [
      { id: "v1", colorCode: "K-01", colorName: "Dark Oak", status: "샘플", date: "2026-10-02", images: ["a"], mixes: [{}] },
      { id: "v2", colorCode: "k-01", colorName: "Light  Oak ", status: "", date: "2026.10.3", work: { worker: "홍 길동" } }] },
  { id: "B", project: "P", client: "한빛가구", pattern: { code: "M01", tags: [] }, work: { worker: "홍길동" },
    variations: [{ id: "v1", colorCode: "", colorName: "", status: "승인", date: "" }] },
];
const clone = (o) => JSON.parse(JSON.stringify(o));

test("값 자리 — 빈 칸은 빼고, 작업정보는 공통값과 컬러별 값을 따로", () => {
  const [A] = mk();
  assert.deepEqual(slotsOf(A, "worker").map((s) => s.id + "=" + s.get()), ["worker|=홍길동", "worker|v2=홍 길동"]);
  assert.deepEqual(slotsOf(A, "status").map((s) => s.id), ["status|v1"]);
  assert.deepEqual(slotsOf(A, "tags").map((s) => s.get()), ["우드", "질감:우드"]);
});

test("찾아 바꾸기 — 미리보기와 저장 결과가 같다 · 대소문자 · 단어 단위 · 정규식", () => {
  const ps = mk();
  const opts = { find: "oak", repl: "Walnut" };
  const m = findMatches(ps, opts, ["colorName", "name"]);
  assert.deepEqual(m.map((x) => `${x.pid}:${x.slot}:${x.after}`), ["A:colorName|v1:Dark Walnut", "A:colorName|v2:Light Walnut", "A:name|:Walnut"]);
  const d = clone(ps[0]);
  assert.equal(applyReplace(d, ["colorName|v2"], opts), true);
  assert.deepEqual([d.variations[0].colorName, d.variations[1].colorName], ["Dark Oak", "Light Walnut"]);
  assert.equal(findMatches(ps, { find: "oak", repl: "x", caseSensitive: true }).length, 0);
  assert.equal(findMatches(ps, { find: "우드", repl: "목재", whole: true }, ["tags"]).length, 2);  // '질감:우드' 의 우드도 단어
  assert.deepEqual(findMatches(ps, { find: "^K-(\\d+)$", repl: "KC-$1", regex: true }, ["colorCode"]).map((x) => x.after), ["KC-01", "KC-01"]);
  assert.throws(() => makeFinder({ find: "(", regex: true }), /정규식/);
});

test("태그 바꾸기로 같은 태그가 되면 하나로 합친다", () => {
  const d = clone(mk()[0]);
  applyReplace(d, ["tags|질감:우드"], { find: "질감:", repl: "" });
  assert.deepEqual(d.pattern.tags, ["우드"]);
});

test("비슷한 값 — 띄어쓰기·대소문자 차이를 묶고 많이 쓴 값을 제안", () => {
  const ps = mk();
  assert.equal(fingerprint("한빛 가구"), fingerprint("한빛가구"));
  assert.equal(fingerprint("K-01"), fingerprint("k 01"));
  const w = clusterValues(ps, "worker");
  assert.equal(w.length, 1);
  assert.equal(w[0].suggest, "홍길동");
  assert.deepEqual(w[0].values.map((x) => `${x.value}:${x.n}`), ["홍길동:2", "홍 길동:1"]);
  assert.equal(clusterValues(ps, "client").length, 1);
  const d = clone(ps[0]);
  assert.equal(mergeValues(d, "worker", ["홍 길동"], "홍길동"), true);
  assert.equal(d.variations[1].work.worker, "홍길동");
  assert.equal(mergeValues(d, "worker", ["홍 길동"], "홍길동"), false);
});

test("태그 사용 수 · 태그 지우기", () => {
  assert.deepEqual(tagUsage(mk()).map((x) => x.tag + x.n), ["우드1", "질감:우드1"]);
  const d = clone(mk()[0]);
  mergeValues(d, "tags", ["우드"], "");
  assert.deepEqual(d.pattern.tags, ["질감:우드"]);
});

test("정리할 것 — 공백·코드 중복·날짜 형식·이름 없음·비슷한 값·빈 칸", () => {
  const q = qualityIssues(mk());
  assert.deepEqual(q.space.map((x) => x.msg), ['컬러명 "Light  Oak "']);
  assert.deepEqual(q.dupcode.map((x) => x.pid + x.vid), ["Av2"]);
  assert.deepEqual(q.badDate.map((x) => x.msg), ["2026.10.3"]);
  assert.deepEqual(q.noName.map((x) => x.pid), ["B"]);
  assert.equal(q.similar.length, 2);                        // 고객 · 작업자
  assert.equal(q.noPhoto.length, 2);
  assert.deepEqual(q.noTag.map((x) => x.pid), ["B"]);
  const d = clone(mk()[0]);
  assert.equal(tidySpaces(d), true);
  assert.equal(d.variations[1].colorName, "Light Oak");
  assert.equal(tidySpaces(d), false);
});
