/* 컬러별 작업정보 규칙 테스트 — node --test tests/work.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { workOf, workSource, cleanVarWork, overrides, WORK_VAR_KEYS } from "../web/js/work.js";

const p = { work: { place: "미성통상", worker: "김동훈 부장", machine: "1호기", sop: "2027-01", emboss: "평엠보", volume: "10" } };
const v = { id: "v02", work: { place: "API", worker: "  " } };   // 작업자 빈 값 = 상속

test("workOf — 덮어쓴 값이 이기고, 빈 값은 공통값을 물려받는다", () => {
  const w = workOf(p, v);
  assert.equal(w.place, "API");
  assert.equal(w.worker, "김동훈 부장");
  assert.equal(w.machine, "1호기");
});

test("workOf — v.work 가 없으면 공통값 그대로", () => {
  assert.deepEqual(workOf(p, { id: "v01" }), p.work);
});

test("패턴 공통 키는 v.work 에 있어도 무시된다", () => {
  const w = workOf(p, { id: "v03", work: { sop: "2099-09", emboss: "무시됨", plate: ["26_999"] } });
  assert.equal(w.sop, "2027-01");
  assert.equal(w.emboss, "평엠보");
  assert.deepEqual(w.plate, undefined);
});

test("workSource — 컬러 덮어쓰기인지 공통값인지", () => {
  assert.equal(workSource(p, v, "place"), "color");
  assert.equal(workSource(p, v, "worker"), "pattern");
  assert.equal(workSource(p, v, "sop"), "pattern");
});

test("cleanVarWork — 빈 값·공통값과 같은 값은 지운다", () => {
  assert.deepEqual(cleanVarWork({ place: "API", worker: "김동훈 부장", machine: "" }, p.work), { place: "API" });
});

test("cleanVarWork — 남는 게 없으면 null", () => {
  assert.equal(cleanVarWork({ place: "", worker: "김동훈 부장" }, p.work), null);
  assert.equal(cleanVarWork(null, p.work), null);
});

test("overrides — 그 키를 덮어쓴 컬러 수", () => {
  const pats = [{ variations: [{ work: { place: "API" } }, { work: {} }, { work: { place: "미성통상" } }] }];
  assert.equal(overrides(pats, "place"), 2);
  assert.equal(overrides(pats, "worker"), 0);
});

test("WORK_VAR_KEYS 는 p.work 실제 키와 맞는다", () => {
  WORK_VAR_KEYS.forEach((k) => assert.ok(k in p.work, k));
});
