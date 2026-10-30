/* 이전 버전 비교 규칙 테스트 — 실행: node --test tests/history.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { docChanges, historyRows, stampText } from "../web/js/history-rules.js";

const base = () => ({
  project: "P", client: "A사", pattern: { code: "W01", name: "Wood", tags: ["우드"] }, label: { type: "1도" }, work: { worker: "김" },
  variations: [{ id: "v01", colorName: "브라운", status: "검토", images: ["a.jpg"],
    mixes: [{ layer: "1도", batch: "B1", plate: "26_001", inks: { MT: 10, BK: 2 }, result: "" }] }],
});

test("바뀐 게 없으면 빈 배열", () => {
  assert.deepEqual(docChanges(base(), base()), []);
});

test("패턴·라벨·작업·컬러 칸 변경을 사람 말로", () => {
  const a = base(), b = base();
  b.client = "B사"; b.pattern.tags = ["우드", "엠보"]; b.work.worker = "박"; b.variations[0].status = "가승인";
  assert.deepEqual(docChanges(a, b), [
    "고객: A사 → B사", "태그: 우드 → 우드, 엠보", "작업자: 김 → 박", "[브라운] 상태: 검토 → 가승인",
  ]);
});

test("컬러 추가·삭제, 사진 수, 배합 추가·삭제·값 변경", () => {
  const a = base(), b = base();
  b.variations[0].images.push("b.jpg");
  b.variations[0].mixes[0].inks.BK = 3;                                     // 값 변경
  b.variations[0].mixes.push({ layer: "1도", batch: "B2", plate: "26_001", inks: { MT: 9 } });
  b.variations.push({ id: "v02", colorCode: "K-2" });
  const out = docChanges(a, b);
  assert.ok(out.includes("컬러 추가: K-2"), out);
  assert.ok(out.includes("[브라운] 사진 1 → 2장"), out);
  assert.ok(out.includes("[브라운] 배합 추가: 1도 B2 (26_001)"), out);
  assert.ok(out.includes("[브라운] 배합 1도 B1 (26_001) — 잉크 변경"), out);
  assert.deepEqual(docChanges(b, a).filter((x) => x.startsWith("컬러 삭제")), ["컬러 삭제: K-2"]);
});

test("잉크 0g 과 없는 잉크는 같은 것으로 본다", () => {
  const a = base(), b = base();
  b.variations[0].mixes[0].inks.YE = 0;
  assert.deepEqual(docChanges(a, b), []);
});

test("historyRows — 저장 한 번 = 한 줄, 다음 상태와 비교", () => {
  const v1 = base(), v2 = base(), cur = base();
  v2.variations[0].status = "가승인"; cur.variations[0].status = "승인"; cur.updatedAt = "2026-10-30T10:00:00";
  v2.updatedAt = "2026-10-29T10:00:00";
  const rows = historyRows([{ stamp: "20261030-100000-000", doc: v2 }, { stamp: "20261029-100000-000", doc: v1 }], cur);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].changes, ["[브라운] 상태: 가승인 → 승인"]);
  assert.equal(rows[0].savedAt, "2026-10-30T10:00:00");
  assert.deepEqual(rows[1].changes, ["[브라운] 상태: 검토 → 가승인"]);
  assert.equal(rows[1].savedAt, "2026-10-29T10:00:00");
});

test("historyRows — 읽지 못한 백업은 건너뛰고 그 앞뒤를 잇는다", () => {
  const v1 = base(), cur = base();
  cur.variations[0].status = "승인";
  const rows = historyRows([{ stamp: "b", error: "깨짐" }, { stamp: "a", doc: v1 }], cur);
  assert.equal(rows[0].error, "깨짐");
  assert.deepEqual(rows[1].changes, ["[브라운] 상태: 검토 → 승인"]);
});

test("stampText", () => {
  assert.equal(stampText("20261030-101112-123"), "2026.10.30 10:11");
});
