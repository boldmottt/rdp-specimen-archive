/* CSV 일괄 등록 규칙 테스트 — 실행: node --test tests/csv-import.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, buildImport, normDate, parsePlates } from "../web/js/csv-import.js";
import { csvRows, csvText } from "../web/js/bulk-rules.js";

const deriveId = (p, c) => `${p}-${c}`.replace(/[^\w.-]+/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
const newDoc = () => ({ id: "", project: "", projectName: "", client: "", nextVarSeq: 2, pattern: { code: "", name: "", nameKo: "", tags: [] },
  label: { item: "Design Sample", type: "", supplier: "" }, work: { plate: [] }, variations: [], history: [] });
const opt = { deriveId, newDoc };

test("CSV 파서 — 따옴표·쉼표·줄바꿈·BOM·CRLF", () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","줄\n바꿈"\r\n\r\n1,2,3');
  assert.deepEqual(rows, [["a", "b", "c"], ["x, y", 'say "hi"', "줄\n바꿈"], ["1", "2", "3"]]);
});

test("날짜·동판 칸", () => {
  assert.equal(normDate("2026.1.5"), "2026-01-05");
  assert.equal(normDate(""), "");
  assert.equal(normDate("2026-02-30"), null);
  assert.equal(normDate("내일"), null);
  assert.deepEqual(parsePlates("1도=26_001 / 2도=26_002"), { layerPlates: { "1도": "26_001", "2도": "26_002" }, plates: [] });
  assert.deepEqual(parsePlates("26_001, 26_002"), { layerPlates: {}, plates: ["26_001", "26_002"] });
});

test("같은 프로젝트+코드는 한 시편 — 컬러마다 v01, v02 …", () => {
  const rows = parseCsv("프로젝트,패턴코드,패턴명,컬러코드,컬러명,작업일,동판(도수별),태그\nP,W01,우드,K-1,브라운,2026.10.1,1도=26_001,\"우드, 엠보\"\nP,W01,우드,K-2,베이지,,1도=26_001,");
  const r = buildImport(rows, [], opt);
  assert.deepEqual(r.errors, []);
  assert.equal(r.plans.length, 1);
  const d = r.plans[0].doc;
  assert.equal(r.plans[0].isNew, true);
  assert.equal(d.id, "P-W01");
  assert.deepEqual([d.pattern.name, d.pattern.nameKo], ["", "우드"], "한글만 적힌 패턴명은 한글명으로");
  assert.deepEqual(d.pattern.tags, ["우드", "엠보"]);
  assert.deepEqual(d.variations.map((v) => [v.id, v.colorCode, v.date]), [["v01", "K-1", "2026-10-01"], ["v02", "K-2", ""]]);
  assert.deepEqual(d.variations[0].layerPlates, { "1도": "26_001" });
  assert.equal(d.nextVarSeq, 3);
  assert.equal(d.label.item, "Design Sample", "적지 않은 칸은 기본값");
});

test("이미 있는 시편 — 새 컬러만 더하고 있는 컬러는 건너뛴다(덮어쓰지 않음)", () => {
  const ex = [{ id: "P-W01", project: "P", pattern: { code: "W01" }, nextVarSeq: 4, variations: [{ id: "v01", colorCode: "K-1" }, { id: "v03", colorCode: "K-3" }] }];
  const rows = parseCsv("프로젝트,패턴코드,컬러코드,컬러명\nP,w01,k-1,브라운\nP,W01,K-9,새컬러");
  const r = buildImport(rows, ex, opt);
  const p = r.plans[0];
  assert.equal(p.isNew, false);
  assert.deepEqual(p.skipped, [{ line: 2, color: "k-1" }]);
  assert.deepEqual(p.add.map((v) => v.id), ["v04"], "기존 번호·nextVarSeq 다음부터");
  assert.equal(p.nextVarSeq, 5);
});

test("줄별 오류 — 필수 칸·컬러 없음·날짜·파일 안 중복·머리줄", () => {
  const rows = parseCsv("프로젝트,패턴코드,컬러코드,컬러명,작업일\n,W01,K-1,,\nP,W01,,,\nP,W01,K-1,,2026-13-01\nP,W02,K-1,,\nP,W02,k-1,,\n가,나,K-1,,");
  const r = buildImport(rows, [], opt);
  assert.deepEqual(r.errors.map((e) => e.line).sort((a, b) => a - b), [2, 3, 4, 6, 7]);
  assert.equal(r.plans.length, 1);
  assert.deepEqual(buildImport(parseCsv("이름,값\na,b"), [], opt).errors[0].line, 1);
});

test("내보낸 CSV 를 그대로 다시 올리면 오류 없이 모두 '이미 있음'", () => {
  const pats = [{ id: "P-W01", project: "P", client: "A", pattern: { code: "W01", name: "Wood", nameKo: "우드", tags: ["t"] }, work: { plate: ["26_001"] },
    variations: [{ id: "v01", colorCode: "=K-1", colorName: "브라운", date: "2026-10-01", layerPlates: { "1도": "26_001" }, mixes: [] }] }];
  const text = csvText(csvRows(pats, null, (v) => v.colorName));
  const r = buildImport(parseCsv(text), pats, opt);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.plans[0].skipped.map((s) => s.color), ["=K-1"], "수식 방지 ' 를 떼고 비교");
  assert.equal(r.plans[0].add.length, 0);
});
