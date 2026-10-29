/* 일괄 편집 규칙 · CSV 단위 테스트 — 브라우저 없이 돈다.
 *   실행: node --test tests/bulk.test.mjs
 *
 * 지키는 것
 *   1. 비운 칸은 아무것도 바꾸지 않는다
 *   2. 컬러 범위(vids)를 주면 그 컬러만 바뀐다
 *   3. 동판(layerPlates)은 일괄 편집이 건드리지 않는다 (DB 중복 방지 규칙)
 *   4. CSV 는 수식 주입(=,+,-,@)을 막고, 쉼표·따옴표를 안전하게 감싼다
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applySpec, csvCell, csvRows, csvText, CSV_HEAD, scopeVids } from "../web/js/bulk-rules.js";

const doc = () => ({
  id: "P1", project: "MQ5",
  pattern: { code: "G-1", name: "", nameKo: "", tags: ["컬러세미나"] },
  work: { worker: "이석희", sop: "", plate: ["26_012"] },
  variations: [
    { id: "v01", status: "가승인", rev: "0", layerPlates: { "1도": "26_015" } },
    { id: "v02", status: "작업중", rev: "1", layerPlates: { "1도": "26_015" } },
  ],
});

test("빈 칸은 변경 안 함 — 0칸", () => {
  const d = doc();
  assert.equal(applySpec(d, { status: "", worker: "", sop: " ", rev: "", tagsAdd: [], tagsRemove: [] }, null), 0);
  assert.deepEqual(d, doc());
});

test("작업자·양산 일정은 시편(패턴) 단위", () => {
  const d = doc();
  const n = applySpec(d, { worker: "최현훈", sop: "2027-01" }, null);
  assert.equal(n, 2);
  assert.equal(d.work.worker, "최현훈");
  assert.equal(d.work.sop, "2027-01");
});

test("상태·Rev 는 컬러 범위를 준 컬러에만", () => {
  const d = doc();
  const n = applySpec(d, { status: "합격", rev: "2" }, new Set(["v02"]));
  assert.equal(n, 2);
  assert.equal(d.variations[0].status, "가승인", "범위 밖 컬러는 그대로");
  assert.equal(d.variations[1].status, "합격");
  assert.equal(d.variations[1].rev, "2");
});

test("Rev 0 도 값이다(빈 칸과 구분)", () => {
  const d = doc();
  d.variations[0].rev = "3";
  assert.equal(applySpec(d, { rev: "0" }, new Set(["v01"])), 1);
  assert.equal(d.variations[0].rev, "0");
});

test("태그 추가·삭제 — 대소문자 무시, 중복 없음", () => {
  const d = doc();
  d.pattern.tags = ["컬러세미나", "Melange"];
  const n = applySpec(d, { tagsAdd: ["melange", "북매치", "북매치"], tagsRemove: ["컬러세미나"] }, null);
  assert.equal(n, 1, "한 칸(태그 목록)만 바뀐 것으로 센다");
  assert.deepEqual(d.pattern.tags, ["Melange", "북매치"]);
});

test("동판은 일괄 편집이 건드리지 않는다", () => {
  const d = doc();
  applySpec(d, { status: "합격", worker: "A", tagsAdd: ["x"] }, null);
  assert.deepEqual(d.variations[0].layerPlates, { "1도": "26_015" });
  assert.deepEqual(d.work.plate, ["26_012"]);
});

test("CSV 수식 주입 방지 (=,+,-,@)", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+82"), "'+82");
  assert.equal(csvCell("-T1"), "'-T1");
  assert.equal(csvCell("@user"), "'@user");
  assert.equal(csvCell("정상"), "정상");
  assert.equal(csvCell("26_015"), "26_015", "숫자·밑줄은 그대로");
});

test("CSV 쉼표·따옴표·줄바꿈 감싸기", () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('그는 "좋다"'), '"그는 ""좋다"""');
  assert.equal(csvCell("두\n줄"), '"두\n줄"');
});

test("CSV 행 — 걸린 컬러만, 머리글 포함, BOM+CRLF", () => {
  const p = {
    project: "MQ5", pattern: { code: "G-1", name: "우드", nameKo: "", tags: ["멜란지"] },
    work: { plate: ["26_012"] },
    variations: [
      { id: "v01", colorCode: "B3961", colorName: "블랙", status: "가승인", date: "2026-10-20", rev: "0",
        layerPlates: { "1도": "26_015" }, mixes: [{}, {}], note: "" },
      { id: "v02", colorCode: "F3024", colorName: "실버", status: "작업중", date: "", rev: "1", mixes: [] },
    ],
  };
  const rows = csvRows([p], () => ["v01"], () => "블랙");
  assert.equal(rows.length, 2, "머리글 + 걸린 1행");
  assert.deepEqual(rows[0], CSV_HEAD);
  assert.equal(rows[1][3], "B3961");
  assert.equal(rows[1][8], "1도=26_015", "도수별 동판");
  assert.equal(rows[1][9], 2, "배합수");

  const text = csvText(rows);
  assert.ok(text.startsWith("\ufeff"), "BOM");
  assert.ok(text.includes("\r\n"), "CRLF");
});

test("CSV 행 — 컬러 범위가 없으면 전부", () => {
  const p = { project: "P", pattern: { code: "G-2" }, work: {}, variations: [{ id: "a" }, { id: "b" }] };
  assert.equal(csvRows([p], null, null).length, 3);
});

/* --- 검색으로 숨긴 시편 (리뷰 지적 1번) -------------------------------------
   예전에는 목록에 없는 시편이면 scopeVids 가 null(모든 컬러)을 돌려줘서,
   검색을 바꾼 뒤 예전에 체크해 둔 시편의 모든 컬러가 조용히 바뀌었다. */
test("목록에 없는 시편: 컬러 항목은 아무것도 안 바뀐다", () => {
  const d = doc();
  // hitsOf 가 undefined 를 돌려주는 상황 = 지금 검색 결과에 없는 시편
  const vids = scopeVids("hits", undefined);
  assert.deepEqual([...vids], [], "빈 집합이어야 한다(전체가 아니라)");
  assert.equal(applySpec(d, { status: "합격" }, vids), 0);
  assert.equal(d.variations[0].status, "가승인", "컬러 상태 그대로");
  assert.equal(d.variations[1].status, "작업중", "컬러 상태 그대로");
});

test("목록에 없는 시편이라도 작업자·태그(시편 단위)는 적용된다", () => {
  const d = doc();
  const n = applySpec(d, { worker: "최현훈", tagsAdd: ["북매치"] }, scopeVids("hits", undefined));
  assert.equal(n, 2, "작업자 + 태그");
  assert.equal(d.work.worker, "최현훈");
  assert.deepEqual(d.pattern.tags, ["컬러세미나", "북매치"]);
});

test("모든 컬러 범위는 예전처럼 전체", () => {
  assert.equal(scopeVids("all", undefined), null);
  const d = doc();
  assert.equal(applySpec(d, { status: "합격" }, scopeVids("all", undefined)), 2);
});
