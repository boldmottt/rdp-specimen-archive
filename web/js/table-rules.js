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
  { key: "project", label: "대표 제안차종", get: (p) => p.project },
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

/**
 * 이 칸이 '시편 공통값'인가 — 고치면 같은 시편의 다른 컬러에도 똑같이 보인다(고객·태그, 컬러별 값이 없는 작업자·장소).
 * 컬러가 하나뿐인 시편은 공통이어도 헷갈릴 일이 없어 false.
 */
export function isShared(c, p, v) {
  if (!c || !c.edit || (p.variations || []).length < 2) return false;
  if (c.edit === "tags" || c.edit.startsWith("p.")) return true;
  if (c.edit.startsWith("work.")) return !own(v, c.edit.slice(5));
  return false;
}

/** 입력 도우미: 그 칸에 이미 쓰인 값(많이 쓴 순, 최대 limit) — 같은 뜻을 다르게 적어 값이 갈라지는 걸 줄인다 */
export function suggestValues(patterns, key, limit = 40) {
  const c = COL[key];
  if (!c || !c.edit || c.edit === "tags" || c.type === "date") return [];
  const m = new Map();
  (patterns || []).forEach((p) => (p.variations || []).forEach((v) => {
    const x = t(c.get(p, v));
    if (x) m.set(x, (m.get(x) || 0) + 1);
  }));
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko")).slice(0, limit).map(([x]) => x);
}

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

/* ---------- 묶어 보기 · 칸반 ---------- */

/** 상태 칸의 기본 순서 — 여기 없는 값은 가나다순으로 뒤에 붙는다 */
export const STATUS_ORDER = ["의뢰", "작업중", "샘플", "가승인", "승인", "보류", "반려"];

/** 묶을 수 있는 기준. get(p, v) → 묶음 이름('' 은 '없음' 묶음) */
export const GROUPS = [
  { key: "project", label: "대표 제안차종", get: (p) => t(p.project) },
  { key: "status", label: "상태", get: (p, v) => t(v.status) },
  { key: "client", label: "고객", get: (p) => t(p.client) },
  { key: "worker", label: "작업자", get: (p, v) => t(COL.worker.get(p, v)) },
  { key: "place", label: "작업 장소", get: (p, v) => t(COL.place.get(p, v)) },
  { key: "month", label: "작업 월", get: (p, v) => t(v.date).replace(/[./]/g, "-").slice(0, 7) },
  { key: "rating", label: "별점", get: (p, v) => (v.rating ? "★".repeat(v.rating) : "") },
];
export const GROUP = Object.fromEntries(GROUPS.map((g) => [g.key, g]));

const orderIndex = (key, name) => {
  if (key === "status") { const i = STATUS_ORDER.indexOf(name); return i < 0 ? STATUS_ORDER.length : i; }
  return 0;
};

/** 줄을 묶는다 — 묶음 순서: (상태는 기본 순서) → 이름순(월·별점은 최근·높은 순), '없음'은 맨 뒤 */
export function groupRows(rows, key) {
  const g = GROUP[key];
  if (!g) return [{ name: "", label: "", rows: rows.slice() }];
  const m = new Map();
  rows.forEach((r) => { const k = g.get(r.p, r.v); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  const desc = key === "month" || key === "rating";
  return [...m.entries()].sort(([a], [b]) => {
    if ((a === "") !== (b === "")) return a === "" ? 1 : -1;
    const d = orderIndex(key, a) - orderIndex(key, b);
    if (d) return d;
    return (desc ? -1 : 1) * a.localeCompare(b, "ko", { numeric: true });
  }).map(([name, rs]) => ({ name, label: name || `${g.label} 없음`, rows: rs }));
}

/**
 * 칸반 칸 — '상태 없음'을 맨 앞(받은 편지함처럼), 이어서 기본 순서 · 그 밖의 값 · 직접 추가한 칸.
 * 비어 있어도 기본 순서의 칸 중 '샘플·가승인·승인'은 늘 보인다(끌어다 놓을 자리).
 */
export function kanbanColumns(rows, extra = []) {
  const names = new Set(rows.map((r) => t(r.v.status)));
  ["샘플", "가승인", "승인"].forEach((x) => names.add(x));
  (extra || []).forEach((x) => { if (t(x)) names.add(t(x)); });
  const rest = [...names].filter((x) => x !== "");
  rest.sort((a, b) => orderIndex("status", a) - orderIndex("status", b) || a.localeCompare(b, "ko", { numeric: true }));
  const cols = [{ name: "", label: "상태 없음" }, ...rest.map((x) => ({ name: x, label: x }))];
  return cols.map((c) => ({ ...c, rows: rows.filter((r) => t(r.v.status) === c.name) }));
}
