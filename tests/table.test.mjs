/* 표 보기 규칙 테스트 — 실행: node --test tests/table.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { COL, tableRows, sortRows, applyCell } from "../web/js/table-rules.js";

const P1 = { id: "A", project: "P", client: "고객", pattern: { code: "W01", tags: ["우드"] }, work: { worker: "김", place: "1공장" },
  variations: [{ id: "v1", colorCode: "K-2", status: "샘플", date: "2026-10-02", rating: 3, images: ["a"], mixes: [] },
    { id: "v2", colorCode: "K-10", status: "", date: "", work: { worker: "박" }, images: [], mixes: [{}] }] };
const P2 = { id: "B", project: "P", pattern: { code: "M01" }, work: {}, variations: [{ id: "v1", colorCode: "K-1", status: "승인", date: "2026-09-01" }] };
const clone = (o) => JSON.parse(JSON.stringify(o));

test("줄 = 검색에 걸린 컬러, 화면 순서", () => {
  const rows = tableRows([P1, P2], (id) => (id === "A" ? ["v2"] : null));
  assert.deepEqual(rows.map((r) => r.p.id + "/" + r.v.id), ["A/v2", "B/v1"]);
});

test("보이는 값 — 작업자는 컬러 값 우선", () => {
  assert.equal(COL.worker.get(P1, P1.variations[0]), "김");
  assert.equal(COL.worker.get(P1, P1.variations[1]), "박");
  assert.equal(COL.rating.get(P1, P1.variations[0]), "★★★");
});

test("정렬 — 숫자 섞인 코드 자연 정렬 · 빈 값은 뒤 · 내림차순", () => {
  const rows = tableRows([P1, P2]);
  assert.deepEqual(sortRows(rows, "colorCode", "asc").map((r) => r.v.colorCode), ["K-1", "K-2", "K-10"]);
  assert.deepEqual(sortRows(rows, "date", "asc").map((r) => r.v.date), ["2026-09-01", "2026-10-02", ""]);
  assert.deepEqual(sortRows(rows, "date", "desc").map((r) => r.v.date), ["2026-10-02", "2026-09-01", ""]);
  assert.deepEqual(sortRows(rows, "photos", "desc").map((r) => r.v.id + r.p.id), ["v1A", "v2A", "v1B"]);
});

test("칸 고치기 — 컬러 칸·공통 칸·작업자(컬러 값 우선)·태그·바뀐 게 없으면 false", () => {
  let d = clone(P1);
  assert.equal(applyCell(d, "v1", "status", " 승인 "), true);
  assert.equal(d.variations[0].status, "승인");
  assert.equal(applyCell(d, "v1", "status", "승인"), false);
  assert.equal(applyCell(d, "v1", "client", "새고객"), true);
  assert.equal(d.client, "새고객");
  d = clone(P1);
  applyCell(d, "v2", "worker", "최");                     // v2 는 컬러 값이 있다 → 컬러 값을 고친다
  assert.deepEqual([d.work.worker, d.variations[1].work.worker], ["김", "최"]);
  applyCell(d, "v1", "worker", "이");                     // v1 은 공통값을 고친다
  assert.equal(d.work.worker, "이");
  assert.equal(applyCell(d, "v1", "tags", "우드, 엠보"), true);
  assert.deepEqual(d.pattern.tags, ["우드", "엠보"]);
  assert.throws(() => applyCell(d, "v1", "code", "X"));
  assert.throws(() => applyCell(d, "v9", "status", "X"));
});

test("묶기 — 상태는 기본 순서, 없음은 뒤 · 작업 월은 최근 먼저", async () => {
  const { groupRows } = await import("../web/js/table-rules.js");
  const rows = tableRows([P1, P2]);
  assert.deepEqual(groupRows(rows, "status").map((g) => `${g.label}:${g.rows.length}`), ["샘플:1", "승인:1", "상태 없음:1"]);
  assert.deepEqual(groupRows(rows, "month").map((g) => g.label), ["2026-10", "2026-09", "작업 월 없음"]);
  assert.deepEqual(groupRows(rows, "worker").map((g) => g.label), ["김", "박", "작업자 없음"]);
  assert.equal(groupRows(rows, "zz").length, 1);
});

test("칸반 칸 — 상태 없음이 맨 앞, 기본 칸은 비어도 보인다, 직접 추가 칸", async () => {
  const { kanbanColumns } = await import("../web/js/table-rules.js");
  const cols = kanbanColumns(tableRows([P1, P2]), ["재작업"]);
  assert.deepEqual(cols.map((c) => `${c.label}:${c.rows.length}`), ["상태 없음:1", "샘플:1", "가승인:0", "승인:1", "재작업:0"]);
});
