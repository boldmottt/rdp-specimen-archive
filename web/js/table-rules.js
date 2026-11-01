/* RDP 시편 아카이브 — 표 보기 규칙 (화면을 모르는 순수 함수)
 *
 * 한 줄 = 컬러 하나. 열 정의(보이는 값 · 정렬 키 · 고칠 수 있는지)와 칸 수정 규칙을 모은다.
 * 프로젝트·패턴 코드는 파일 ID 와 묶여 있어 표에서 고치지 않는다(편집기에서 ID 변경 흐름으로).
 * 작업 정보(장소·작업자)는 컬러가 따로 적은 값이 있으면 그 컬러 값을, 없으면 공통값을 고친다(work.js 규칙).
 * tests/table.test.mjs 가 검사한다.
 */

const t = (x) => (x == null ? "" : Array.isArray(x) ? x.join(", ") : String(x)).trim();

/** v.work 에 이 컬러만의 값이 있는가 */
const own = (v, k) => t(((v && v.work) || {})[k]) !== "";

/**
 * 열 정의. get: 보이는 값, sort: 정렬 키(없으면 get), edit: 'v.x' | 'p.x' | 'work.x' | 'tags'
 */
export const COLUMNS = [
  { key: "project", label: "프로젝트", get: (p) => p.project },
  { key: "code", label: "패턴", get: (p) => (p.pattern || {}).code },
  { key: "colorCode", label: "컬러코드", get: (p, v) => v.colorCode, edit: "v.colorCode" },
  { key: "colorName", label: "컬러명", get: (p, v) => v.colorName, edit: "v.colorName" },
  { key: "status", label: "상태", get: (p, v) => v.status, edit: "v.status" },
  { key: "date", label: "작업일", get: (p, v) => v.date, edit: "v.date", type: "date" },
  { key: "rev", label: "Rev", get: (p, v) => v.rev, edit: "v.rev" },
  { key: "rating", label: "별점", get: (p, v) => (v.rating ? "★".repeat(v.rating) : ""), sort: (p, v) => Number(v.rating || 0) },
  { key: "client", label: "고객", get: (p) => p.client, edit: "p.client" },
  { key: "worker", label: "작업자", get: (p, v) => (own(v, "worker") ? v.work.worker : (p.work || {}).worker), edit: "work.worker" },
  { key: "place", label: "작업 장소", get: (p, v) => (own(v, "place") ? v.work.place : (p.work || {}).place), edit: "work.place" },
  { key: "plates", label: "동판", get: (p, v) => Object.entries(v.layerPlates || {}).map(([k, x]) => `${k}=${x}`).join(" ") || t((p.work || {}).plate) },
  { key: "photos", label: "사진", get: (p, v) => String((v.images || []).length), sort: (p, v) => (v.images || []).length },
  { key: "mixes", label: "배합", get: (p, v) => String((v.mixes || []).length), sort: (p, v) => (v.mixes || []).length },
  { key: "tags", label: "태그", get: (p) => t((p.pattern || {}).tags), edit: "tags" },
  { key: "note", label: "메모", get: (p, v) => v.note, edit: "v.note" },
  { key: "updated", label: "수정", get: (p) => t(p.updatedAt).slice(0, 10) },
];
export const COL = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
export const DEFAULT_HIDDEN = ["rev", "place", "note", "updated"];

/** 표 줄: 검색에 걸린 컬러만, 화면 순서 그대로 */
export function tableRows(list, hitsOf) {
  const out = [];
  (list || []).forEach((p) => {
    const hits = hitsOf ? hitsOf(p.id) : null;
    (p.variations || []).forEach((v) => { if (!hits || hits.includes(v.id)) out.push({ p, v }); });
  });
  return out;
}

/** 정렬 — 같은 값은 원래 순서 유지(안정 정렬), 빈 값은 항상 뒤로 */
export function sortRows(rows, key, dir) {
  const c = COL[key];
  if (!c) return rows.slice();
  const val = (r) => (c.sort ? c.sort(r.p, r.v) : t(c.get(r.p, r.v)));
  const sign = dir === "desc" ? -1 : 1;
  return rows.map((r, i) => ({ r, i, k: val(r) })).sort((a, b) => {
    const ea = a.k === "" || a.k == null, eb = b.k === "" || b.k == null;
    if (ea !== eb) return ea ? 1 : -1;
    const d = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k), "ko", { numeric: true });
    return d * sign || a.i - b.i;
  }).map((x) => x.r);
}

/**
 * 칸 하나 고치기 — 문서(doc)를 바꾸고 바뀌었는지 돌려준다(saveMany 의 mutate 로 쓴다).
 * 빈 값은 '비우기'다(태그는 빈 목록).
 */
export function applyCell(doc, vid, key, value) {
  const c = COL[key];
  if (!c || !c.edit) throw new Error("고칠 수 없는 칸입니다");
  const val = t(value);
  const v = (doc.variations || []).find((x) => x.id === vid);
  if (!v) throw new Error("컬러를 찾지 못했습니다");
  if (c.edit === "tags") {
    const next = val ? val.split(/\s*,\s*/).filter(Boolean) : [];
    const cur = (doc.pattern || {}).tags || [];
    if (next.join("\u0001") === cur.join("\u0001")) return false;
    doc.pattern.tags = next;
    return true;
  }
  if (c.edit.startsWith("work.")) {
    const k = c.edit.slice(5);
    if (own(v, k)) { if (t(v.work[k]) === val) return false; v.work[k] = val; return true; }
    doc.work = doc.work || {};
    if (t(doc.work[k]) === val) return false;
    doc.work[k] = val;
    return true;
  }
  const [scope, k] = c.edit.split(".");
  const target = scope === "v" ? v : doc;
  if (t(target[k]) === val) return false;
  if (val === "" && scope === "v" && k === "rev") delete target[k];
  else target[k] = val;
  return true;
}
