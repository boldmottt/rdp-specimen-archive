/* 패턴 개발 실적 규칙 테스트 — 실행: node --test tests/report.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { parsePatternCode, devInfo, vehiclesOf, reportRows, summarize, reportOptions } from "../web/js/report-rules.js";

test("패턴 코드 읽기 — G50223F1 = 지오메트릭 · 2025-02-23 · 패브릭 1번", () => {
  assert.deepEqual(parsePatternCode("G50223F1"), { kind: "G", year: 2025, month: 2, day: 23, cat: "F", seq: 1 });
  assert.deepEqual(parsePatternCode("m61104t2"), { kind: "M", year: 2026, month: 11, day: 4, cat: "T", seq: 2 });
  assert.deepEqual(parsePatternCode("G-10305"), { kind: "G", year: 2021, month: 3, day: 5, cat: "", seq: null });
  assert.equal(parsePatternCode("W01"), null);
  assert.equal(parsePatternCode("G51323F1"), null);      // 13월
  assert.equal(parsePatternCode("X50223F1"), null);
});

test("개발 시점 — 코드 → devDate → 가장 이른 작업일 순", () => {
  assert.equal(devInfo({ pattern: { code: "G50223F1" } }).source, "code");
  const d = devInfo({ pattern: { code: "W01", devDate: "2024-07" } });
  assert.deepEqual([d.year, d.month, d.source], [2024, 7, "devDate"]);
  const e = devInfo({ pattern: { code: "W01" }, variations: [{ date: "2026.3.9" }, { date: "2025-12-01" }] });
  assert.deepEqual([e.year, e.month, e.source], [2025, 12, "date"]);
  assert.equal(devInfo({ pattern: { code: "W01" }, variations: [] }).year, null);
});

const P = (id, project, code, extra = {}) => ({ id, project, pattern: { code, ...(extra.pattern || {}) }, label: extra.label || {},
  variations: extra.variations || [{ id: "v01", images: [] }] });

test("실적 줄 — 같은 코드를 차종마다 따로 등록했어도 한 줄, 제안 차종은 모두 모음", () => {
  const ps = [
    P("HX5-G50223F1", "HX5", "G50223F1", { pattern: { nameKo: "패브릭 체크", developer: "담당자A", vehicles: ["NQ5"] },
      variations: [{ id: "v01", images: ["a.jpg"], vehicles: ["SP3"] }] }),
    P("KQ2-G50223F1", "KQ2", "G50223F1"),
    P("HX5-M50301T1", "HX5", "M50301T1", { pattern: { developer: "담당자B" }, label: { remark: "선행" } }),
    P("HX5-W01", "HX5", "W01", { variations: [{ id: "v01", date: "2024-05-02" }] }),
  ];
  const rows = reportRows(ps);
  assert.deepEqual(rows.map((r) => r.code), ["W01", "G50223F1", "M50301T1"]);
  const g = rows[1];
  assert.deepEqual(g.vehicles, ["HX5", "NQ5", "SP3", "KQ2"]);
  assert.deepEqual(g.ids, ["HX5-G50223F1", "KQ2-G50223F1"]);
  assert.deepEqual(g.image, { pid: "HX5-G50223F1", file: "a.jpg" });
  assert.deepEqual([g.developer, g.name, g.kind, g.cat], ["담당자A", "패브릭 체크", "G", "F"]);
  assert.equal(rows[2].remark, "선행");
  assert.deepEqual(reportRows(ps, { year: 2025 }).map((r) => r.code), ["G50223F1", "M50301T1"]);
  assert.deepEqual(reportRows(ps, { kind: "M" }).map((r) => r.code), ["M50301T1"]);
  assert.deepEqual(reportRows(ps, { vehicle: "KQ2" }).map((r) => r.code), ["G50223F1"]);
  assert.deepEqual(reportRows(ps, { developer: "담당자B" }).map((r) => r.code), ["M50301T1"]);
  assert.deepEqual(vehiclesOf(ps[0]), ["HX5", "NQ5", "SP3"]);
});

test("요약 — 월별 · 분류 · 담당자 · 차종", () => {
  const rows = reportRows([
    P("A", "HX5", "G50223F1", { pattern: { developer: "담당자A" } }),
    P("B", "HX5", "G50224T1", { pattern: { developer: "담당자A" } }),
    P("C", "KQ2", "M50301F1"),
  ], { year: 2025 });
  const s = summarize(rows);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byMonth.slice(0, 3), [0, 2, 1]);
  assert.deepEqual(s.byKind, [["지오메트릭", 2], ["메테리얼", 1]]);
  assert.deepEqual(s.byCat, [["F", 2], ["T", 1]]);
  assert.deepEqual(s.byDeveloper, [["담당자A", 2], ["담당자 미입력", 1]]);
  assert.deepEqual(s.byVehicle, [["HX5", 2], ["KQ2", 1]]);
  const o = reportOptions([P("A", "HX5", "G50223F1"), P("B", "HX5", "G61001F1")]);
  assert.deepEqual(o.years, [2026, 2025]);
});

test("실제 양식 M-60213-F2 — 하이픈이 있어도 같은 코드", () => {
  assert.deepEqual(parsePatternCode("M-60213-F2"), { kind: "M", year: 2026, month: 2, day: 13, cat: "F", seq: 2 });
  assert.deepEqual(parsePatternCode("G-51104-T1"), { kind: "G", year: 2025, month: 11, day: 4, cat: "T", seq: 1 });
  const rows = reportRows([P("A", "HX5", "M-60213-F2"), P("B", "KQ2", "M60213F2")]);
  assert.equal(rows.length, 1);                                  // 하이픈만 다른 같은 코드는 한 줄
  assert.deepEqual(rows[0].vehicles, ["HX5", "KQ2"]);
});
