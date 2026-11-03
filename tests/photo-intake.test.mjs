/* 사진 파일명 → 시편 정보 읽기 (photo-intake.js) 단위 테스트 */
import test from "node:test";
import assert from "node:assert/strict";
import { parsePhotoName, baseName, describeParse } from "../web/js/photo-intake.js";

const P = [
  { id: "NKO-G-60813-L1", project: "NKO", pattern: { code: "G-60813-L1" },
    variations: [{ colorName: "실버" }, { colorName: "메탈 브라운" }] },
  { id: "TAMPE3-M-51121-F2", project: "TAMPE3", pattern: { code: "M-51121-F2" },
    variations: [{ colorName: "매트 블랙" }] },
];

test("기존 시편 코드가 파일명에 있으면 그 시편으로 연결한다", () => {
  const r = parsePhotoName("G-60813-L1_실버_26_136.jpg", P);
  assert.equal(r.matchId, "NKO-G-60813-L1");
  assert.equal(r.colorName, "실버");
  assert.equal(r.plate, "26_136");
});

test("ID 전체가 들어 있어도 연결 · 대소문자/공백/밑줄 무시", () => {
  assert.equal(parsePhotoName("nko g 60813 l1.png", P).matchId, "NKO-G-60813-L1");
  assert.equal(parsePhotoName("TAMPE3-M-51121-F2_매트블랙.jpg", P).matchId, "TAMPE3-M-51121-F2");
});

test("새 시편이면 코드 후보·컬러코드를 읽는다", () => {
  const r = parsePhotoName("G-99999-A1 E3940 사진.jpg", P);
  assert.equal(r.matchId, "");
  assert.equal(r.code, "G-99999-A1");
  assert.equal(r.colorCode, "E3940");
});

test("정보가 없는 파일명은 아무것도 채우지 않는다", () => {
  const r = parsePhotoName("IMG_2345.HEIC", P);
  assert.deepEqual({ m: r.matchId, c: r.code, cc: r.colorCode, n: r.colorName, p: r.plate },
    { m: "", c: "", cc: "", n: "", p: "" });
});

test("기존에 없는 컬러명은 지어내지 않는다", () => {
  const r = parsePhotoName("G-60813-L1_형광핑크.jpg", P);
  assert.equal(r.colorName, "");
  assert.equal(r.matchId, "NKO-G-60813-L1");
});

test("확장자 떼기 · 요약문", () => {
  assert.equal(baseName("a.b-c.jpg"), "a.b-c");
  assert.equal(describeParse(parsePhotoName("G-60813-L1_실버.jpg", P)), "기존 시편 NKO-G-60813-L1 · 컬러 실버");
});

test("밑줄로 붙은 컬러코드·동판도 읽고, 코드 끝 구분자는 떼어낸다", () => {
  const r = parsePhotoName("G-55555-A1_실버_E3940_26_136.png", P);
  assert.equal(r.code, "G-55555-A1");     // 끝 _ 제거
  assert.equal(r.colorCode, "E3940");     // _E3940_ 도 인식
  assert.equal(r.plate, "26_136");
});

test("ID 가 아니라 코드만 있어도 기존 시편으로 연결한다", () => {
  const r = parsePhotoName("작업후_G-60813-L1_확대.jpg", P);
  assert.equal(r.matchId, "NKO-G-60813-L1");
});
