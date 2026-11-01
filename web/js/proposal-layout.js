/* 제안서 — 보여줄 항목 · 레이아웃 프리셋 (순수 함수, 화면 없이 테스트한다)
 *
 * 보여줄 항목(fields): 컬러명(COLOR)은 항상 보이고, 나머지는 고객사마다 켜고 끈다.
 *   기본값 = 예전 제안서와 같은 ITEM · TYPE · REMARK. 기본값이면 모델에 fields 를 넣지 않는다
 *   → 예전에 확정한 제안서의 지문(signature)이 그대로라 '확정 후 수정됨'이 뜨지 않는다.
 * 레이아웃(layout): "detail" = 1장 1패턴(실물 크기 170×70) · "board" = 한 장에 여러 컬러를 모은 보드(축소).
 *   기본값(detail)이면 모델에 layout 을 넣지 않는다(같은 이유).
 *
 * 되돌리기: 이 파일과 proposal.js 의 fields/layout 사용처를 지우면 예전 제안서로 돌아간다.
 */

/** 켜고 끌 수 있는 항목 — 화면에 보이는 순서 */
export const FIELDS = [
  { key: "colorCode", label: "COLOR CODE", ko: "컬러코드" },
  { key: "item", label: "ITEM", ko: "적용 부위" },
  { key: "type", label: "TYPE", ko: "공법" },
  { key: "coating", label: "COATING", ko: "도장" },
  { key: "status", label: "STATUS", ko: "상태" },
  { key: "remark", label: "REMARK", ko: "비고(동판·배치)" },
];
export const DEFAULT_FIELDS = ["item", "type", "remark"];
export const LAYOUTS = [
  { key: "detail", label: "상세", hint: "1장에 1패턴 · 사진 실물 크기(170×70mm)" },
  { key: "board", label: "보드", hint: "한 장에 컬러 8개 · 사진 축소" },
];
/** 보드 한 장에 넣는 컬러 수 (2칸 × 4줄) */
export const BOARD_PER_PAGE = 8;

const KEYS = new Set(FIELDS.map((f) => f.key));

/** 저장된 값(없거나 엉망이어도)을 순서가 맞는 항목 키 목록으로 */
export function cleanFields(raw) {
  if (!Array.isArray(raw)) return DEFAULT_FIELDS.slice();
  const on = new Set(raw.filter((k) => KEYS.has(k)));
  return FIELDS.map((f) => f.key).filter((k) => on.has(k));
}

export const isDefaultFields = (keys) => {
  const a = cleanFields(keys);
  return a.length === DEFAULT_FIELDS.length && a.every((k, i) => k === DEFAULT_FIELDS[i]);
};

export const cleanLayout = (raw) => (raw === "board" ? "board" : "detail");

/** 모델에 덧붙일 설정 — 기본값이면 빈 객체(지문 유지) */
export function modelSettings(prop) {
  const out = {};
  const layout = cleanLayout(prop && prop.layout);
  if (layout !== "detail") out.layout = layout;
  const fields = cleanFields(prop && prop.fields);
  if (!isDefaultFields(fields)) out.fields = fields;
  return out;
}

/** 모델(작성 중 · 확정본)에서 쓸 항목 키 */
export const fieldsOf = (m) => cleanFields(m && m.fields);
export const layoutOf = (m) => cleanLayout(m && m.layout);

/** 도장 목록 → 한 줄 ("Sample Coating C-2001, …") */
export function coatingLine(coating) {
  return (Array.isArray(coating) ? coating : [])
    .map((c) => [c && c.maker, c && c.code].filter(Boolean).join(" "))
    .filter(Boolean).join(", ");
}

/** 한 컬러의 항목 값 (없으면 "") */
export function fieldValue(v, key) {
  if (!v) return "";
  const x = v[key];
  if (key === "remark") return x && x !== "—" ? String(x) : "";
  return x == null ? "" : String(x).trim();
}

/** 모델에 넣을 컬러별 추가 값 — 켠 항목만(끈 항목의 값은 확정본에도 남기지 않는다) */
export function extraVarValues(keys, raw) {
  const on = new Set(cleanFields(keys));
  const out = {};
  if (on.has("status")) out.status = String((raw && raw.status) || "");
  if (on.has("coating")) out.coating = coatingLine(raw && raw.coating);
  return out;
}

/** 보드: 모든 컬러를 담은 순서대로 펼쳐 BOARD_PER_PAGE 개씩 자른다 */
export function boardPages(items, per = BOARD_PER_PAGE) {
  const flat = [];
  (items || []).forEach((it) => (it.variations || []).forEach((v) => flat.push({ it, v })));
  const out = [];
  for (let i = 0; i < flat.length; i += per) out.push(flat.slice(i, i + per));
  return out;
}
