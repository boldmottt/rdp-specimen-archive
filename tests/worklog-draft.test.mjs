/* 작업일지 → 새 시편 초안 합치기 테스트 — 실행: node --test tests/worklog-draft.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { applyWorklogDraft, jobMatches } from "../web/js/worklog-draft.js";

const base = () => ({
  project: "", client: "", pattern: { code: "", name: "", tags: [] }, label: { item: "Design Sample" },
  work: { place: "", worker: "", machine: "", plate: [], emboss: "", pad: "" },
  variations: [{ id: "v01", date: "2026-10-31", images: [], mixes: [], note: "" }],
});

test("일지 값을 새 시편에 얹는다", () => {
  const d = applyWorklogDraft(base(), {
    project: "DEMO", client: "Sample Motors", pattern: { code: "W1" },
    work: { place: "API 산업", worker: "홍길동", pad: "", plate: ["DEMO_001"] },
    variation: { date: "2026-01-10", layerPlates: { "1도": "DEMO_001" }, note: "작업일지 2026-01-10 #1",
      mixes: [{ layer: "1도", batch: "A", plate: "DEMO_001", inks: { MT: 60 }, thinnerG: 18 }] },
  });
  assert.equal(d.project, "DEMO");
  assert.equal(d.pattern.code, "W1");
  assert.deepEqual(d.work.plate, ["DEMO_001"]);
  assert.equal(d.work.place, "API 산업");
  assert.equal(d.variations[0].date, "2026-01-10");
  assert.equal(d.variations[0].mixes[0].inks.MT, 60);
  assert.equal(d.label.item, "Design Sample", "일지에 없는 칸은 기본값 그대로");
});

test("빈 값으로 기본값을 덮지 않는다", () => {
  const b = base(); b.work.pad = "기본 패드"; b.variations[0].date = "2026-10-31";
  const d = applyWorklogDraft(b, { project: "", work: { pad: "", plate: [] }, variation: { date: "", mixes: [] } });
  assert.equal(d.work.pad, "기본 패드");
  assert.equal(d.variations[0].date, "2026-10-31");
  assert.deepEqual(d.work.plate, []);
});

test("원본 응답과 배합 객체를 공유하지 않는다", () => {
  const src = { variation: { mixes: [{ layer: "1도", inks: { MT: 1 } }] } };
  const d = applyWorklogDraft(base(), src);
  d.variations[0].mixes[0].inks.MT = 9;
  assert.equal(src.variation.mixes[0].inks.MT, 1);
});

test("작업 검색", () => {
  const j = { date: "2026-01-10", title: "신규 컬러 3종", code: "DEMO-W1", lot: "DEMO_001", customer: "Sample Motors" };
  assert.ok(jobMatches(j, "w1"));
  assert.ok(jobMatches(j, "demo_001"));
  assert.ok(jobMatches(j, "신규"));
  assert.ok(!jobMatches(j, "E2"));
  assert.ok(jobMatches(j, ""));
});
