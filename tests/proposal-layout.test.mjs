// 제안서 — 보여줄 항목 · 레이아웃 프리셋 규칙 (web/js/proposal-layout.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFields, isDefaultFields, modelSettings, fieldsOf, layoutOf, fieldValue, extraVarValues, boardPages, coatingLine, DEFAULT_FIELDS } from "../web/js/proposal-layout.js";

test("항목: 없거나 엉망이면 기본값(ITEM·TYPE·REMARK), 순서는 정해진 대로, 모르는 키는 버린다", () => {
  assert.deepEqual(cleanFields(undefined), DEFAULT_FIELDS);
  assert.deepEqual(cleanFields("x"), DEFAULT_FIELDS);
  assert.deepEqual(cleanFields(["remark", "zzz", "colorCode"]), ["colorCode", "remark"]);
  assert.deepEqual(cleanFields([]), []);
});

test("기본값이면 모델에 아무것도 넣지 않는다 — 예전 확정본 지문이 그대로", () => {
  assert.deepEqual(modelSettings({}), {});
  assert.deepEqual(modelSettings({ layout: "detail", fields: ["type", "item", "remark"] }), {});
  assert.ok(isDefaultFields(["remark", "type", "item"]));
  assert.deepEqual(modelSettings({ layout: "board" }), { layout: "board" });
  assert.deepEqual(modelSettings({ fields: ["status"] }), { fields: ["status"] });
  assert.deepEqual(modelSettings({ layout: "weird" }), {});
});

test("모델에서 읽기 — 예전 확정본(설정 없음)은 상세 + 기본 항목", () => {
  assert.equal(layoutOf({}), "detail");
  assert.deepEqual(fieldsOf({}), DEFAULT_FIELDS);
  assert.equal(layoutOf({ layout: "board" }), "board");
});

test("값: 비고의 '—'는 빈 값, 도장은 한 줄로", () => {
  assert.equal(fieldValue({ remark: "—" }, "remark"), "");
  assert.equal(fieldValue({ remark: "00_001 · 1도-1" }, "remark"), "00_001 · 1도-1");
  assert.equal(fieldValue({ colorCode: " C-1 " }, "colorCode"), "C-1");
  assert.equal(fieldValue(null, "item"), "");
  assert.equal(coatingLine([{ maker: "A", code: "C-1" }, { maker: "", code: "" }, { code: "C-2" }]), "A C-1, C-2");
});

test("켠 항목만 컬러 값으로 남긴다 (끈 상태·도장은 확정본에도 안 남김)", () => {
  const raw = { status: "가승인", coating: [{ maker: "A", code: "C-1" }] };
  assert.deepEqual(extraVarValues(undefined, raw), {});
  assert.deepEqual(extraVarValues(["status"], raw), { status: "가승인" });
  assert.deepEqual(extraVarValues(["coating", "status"], raw), { coating: "A C-1", status: "가승인" });
});

test("보드: 담은 순서대로 8개씩", () => {
  const items = [{ variations: [1, 2, 3] }, { variations: [4, 5, 6, 7, 8, 9] }, { variations: [10] }];
  const pages = boardPages(items);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].map((c) => c.v), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(pages[1].map((c) => c.v), [9, 10]);
  assert.deepEqual(boardPages([]), []);
});
