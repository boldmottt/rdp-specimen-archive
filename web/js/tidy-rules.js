/* RDP 시편 아카이브 — 정리 도구 규칙 (화면을 모르는 순수 함수)
 *
 * 찾아 바꾸기 · 비슷한 값 통일 · 태그 관리 · 정리할 것 이 같은 '값 자리(slot)' 목록을 쓴다.
 * 자리 = 시편 문서 안의 글자 칸 하나(컬러명·상태·고객·작업자·태그 하나 …). get/set 으로 읽고 쓴다.
 * 같은 함수를 화면 데이터(미리보기)와 저장 직전 문서(saveMany 의 mutate) 양쪽에 써서 미리보기 = 저장 결과가 된다.
 * tests/tidy.test.mjs 가 검사한다.
 */

const t = (x) => (x == null ? "" : String(x));

/** 고칠 수 있는 글자 칸 */
export const FIELDS = [
  { key: "colorName", label: "컬러명", scope: "v" },
  { key: "colorCode", label: "컬러코드", scope: "v" },
  { key: "status", label: "상태", scope: "v" },
  { key: "note", label: "컬러 메모", scope: "v", multiline: true },
  { key: "client", label: "고객", scope: "p" },
  { key: "name", label: "패턴명", scope: "pattern" },
  { key: "nameKo", label: "패턴 한글명", scope: "pattern" },
  { key: "worker", label: "작업자", scope: "work" },
  { key: "place", label: "작업 장소", scope: "work" },
  { key: "machine", label: "설비", scope: "work" },
  { key: "tags", label: "태그", scope: "tags" },
];
export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/**
 * 문서 하나의 값 자리 목록. id 는 같은 문서를 다시 읽어도 같다(미리보기 → 저장 연결).
 * 비어 있는 칸은 빼고(찾을 것이 없다), 작업 정보는 공통값과 컬러별 값을 각각 자리로 센다.
 */
export function slotsOf(doc, fieldKey) {
  const f = FIELD[fieldKey];
  if (!f) return [];
  const out = [];
  const add = (id, vid, obj, k) => { if (obj && t(obj[k]).trim() !== "") out.push({ id, field: f.key, vid, get: () => t(obj[k]), set: (x) => { obj[k] = x; } }); };
  const vars = doc.variations || [];
  if (f.scope === "v") vars.forEach((v) => add(`${f.key}|${v.id}`, v.id, v, f.key));
  else if (f.scope === "p") add(`${f.key}|`, "", doc, f.key);
  else if (f.scope === "pattern") add(`${f.key}|`, "", doc.pattern, f.key);
  else if (f.scope === "work") {
    add(`${f.key}|`, "", doc.work, f.key);
    vars.forEach((v) => add(`${f.key}|${v.id}`, v.id, v.work, f.key));
  } else if (f.scope === "tags") {
    const tags = (doc.pattern && doc.pattern.tags) || [];
    tags.forEach((x, i) => out.push({ id: `tags|${t(x)}`, field: "tags", vid: "", get: () => t(tags[i]), set: (y) => { tags[i] = y; } }));
  }
  return out;
}

/** 태그 목록 정리 — 빈 것 빼고 중복 하나로 (순서 유지) */
export function cleanTags(doc) {
  if (!doc.pattern || !Array.isArray(doc.pattern.tags)) return;
  const seen = new Set();
  doc.pattern.tags = doc.pattern.tags.map((x) => t(x).trim()).filter((x) => x && !seen.has(x) && seen.add(x));
}

/* ---------- 찾아 바꾸기 ---------- */

/** 찾기 정규식. 잘못된 정규식이면 Error */
export function makeFinder({ find, regex = false, caseSensitive = false, whole = false }) {
  if (!t(find)) return null;
  let src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (whole) src = `(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`;
  try { return new RegExp(src, "gu" + (caseSensitive ? "" : "i")); }
  catch (e) { throw new Error("정규식이 올바르지 않습니다: " + e.message); }
}

/**
 * 바꾼 글자 (바뀐 게 없으면 원래 글자).
 * 한 줄 칸은 바꾸다 생긴 겹친 공백·앞뒤 공백을 다듬는다. 여러 줄 칸(메모)은 줄바꿈·빈 줄을 그대로 둔다
 * (예전엔 메모의 빈 줄까지 공백 하나로 합쳐 버렸다).
 */
export function replaceText(s, finder, repl, multiline = false) {
  if (!finder) return s;
  finder.lastIndex = 0;
  if (!finder.test(s)) return s;
  finder.lastIndex = 0;
  const out = s.replace(finder, repl);
  return multiline ? out : out.replace(/\s{2,}/g, " ").trim();
}

/**
 * 미리보기 — [{pid, slot, field, vid, before, after}]
 * fields: 찾을 칸 key 목록(비우면 전부)
 */
export function findMatches(patterns, opts, fields) {
  const finder = makeFinder(opts);
  if (!finder) return [];
  const keys = fields && fields.length ? fields : FIELDS.map((f) => f.key);
  const out = [];
  (patterns || []).forEach((p) => keys.forEach((k) => slotsOf(p, k).forEach((s) => {
    const before = s.get(), after = replaceText(before, finder, opts.repl || "", FIELD[k].multiline);
    if (after !== before) out.push({ pid: p.id, slot: s.id, field: k, vid: s.vid, before, after });
  })));
  return out;
}

/** 저장 직전 문서에 고른 자리만 다시 바꾼다 (mutate) */
export function applyReplace(doc, slotIds, opts) {
  const finder = makeFinder(opts);
  const want = new Set(slotIds);
  let changed = false;
  new Set(slotIds.map((id) => id.split("|")[0])).forEach((k) => slotsOf(doc, k).forEach((s) => {
    if (!want.has(s.id)) return;
    const before = s.get(), after = replaceText(before, finder, opts.repl || "", FIELD[k].multiline);
    if (after !== before) { s.set(after); changed = true; }
  }));
  cleanTags(doc);
  return changed;
}

/* ---------- 비슷한 값 통일 ---------- */

/** 지문 — 대소문자·전각·띄어쓰기·기호 차이를 지운다(OpenRefine fingerprint 와 같은 생각).
 *  한글은 띄어쓰기만 다른 경우가 많아 낱말 순서 정렬은 하지 않는다('한빛 가구' = '한빛가구'). */
export function fingerprint(s) {
  return t(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 칸 하나의 값 사용 수 [{value, n}] (컬러·패턴 자리 수) */
export function valueCounts(patterns, fieldKey) {
  const m = new Map();
  (patterns || []).forEach((p) => slotsOf(p, fieldKey).forEach((s) => { const v = s.get().trim(); m.set(v, (m.get(v) || 0) + 1); }));
  return [...m].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value, "ko"));
}

/**
 * 비슷한 값 묶음 — 지문이 같은데 글자가 다른 값들. [{values:[{value,n}], total, suggest}]
 * suggest = 가장 많이 쓴 값(같으면 먼저 나온 값)
 */
export function clusterValues(patterns, fieldKey) {
  const groups = new Map();
  valueCounts(patterns, fieldKey).forEach((x) => {
    const k = fingerprint(x.value);
    if (!k) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  });
  return [...groups.values()].filter((g) => g.length > 1)
    .map((values) => ({ values, total: values.reduce((a, x) => a + x.n, 0), suggest: values[0].value }))
    .sort((a, b) => b.total - a.total);
}

/** 문서 안에서 from 값들을 to 로 바꾼다(정확히 같은 값만, 앞뒤 공백 무시). to 가 '' 이고 태그면 지운다 */
export function mergeValues(doc, fieldKey, from, to) {
  const set = new Set((from || []).map((x) => t(x).trim()));
  let changed = false;
  slotsOf(doc, fieldKey).forEach((s) => {
    const cur = s.get().trim();
    if (set.has(cur) && s.get() !== to) { s.set(to); changed = true; }
  });
  if (fieldKey === "tags") cleanTags(doc);
  return changed;
}

/* ---------- 태그 ---------- */

/** 태그 사용 수 [{tag, n}] (패턴 수, 많은 순) */
export function tagUsage(patterns) {
  return valueCounts(patterns, "tags").map((x) => ({ tag: x.value, n: x.n }));
}

/* ---------- 정리할 것 ---------- */

const SPACE_FIELDS = ["colorName", "colorCode", "status", "client", "name", "nameKo", "worker", "place", "machine", "tags"];
const badSpace = (s) => s !== s.trim() || /\s{2,}/.test(s);
const tidySpace = (s) => s.replace(/\s+/g, " ").trim();

/**
 * 점검 항목. query 가 있으면 목차 검색으로 그 컬러들을 바로 볼 수 있다.
 * level: 'fix' 바로 고칠 수 있음 · 'warn' 확인 필요 · 'info' 채우면 좋음
 */
export const CHECKS = [
  { key: "space", label: "앞뒤·겹친 공백", level: "fix", desc: "검색·묶기에서 다른 값으로 갈라집니다 — [공백 정리]로 한 번에 고칩니다" },
  { key: "dupcode", label: "한 패턴 안 같은 컬러코드", level: "warn", desc: "같은 컬러를 두 번 등록했을 수 있습니다" },
  { key: "similar", label: "비슷한 값이 갈라짐", level: "warn", desc: "예: '홍길동' / '홍 길동' — [값 통일] 탭에서 합칩니다" },
  { key: "badDate", label: "작업일 형식", level: "warn", desc: "YYYY-MM-DD 가 아닌 작업일 — 날짜 검색·정렬에서 빠집니다" },
  { key: "noName", label: "컬러 이름·코드 없음", level: "warn", desc: "컬러명과 컬러코드가 둘 다 비었습니다" },
  { key: "noPhoto", label: "사진 없음", level: "info", query: "-있음:사진" },
  { key: "noMix", label: "배합 없음", level: "info", query: "-있음:배합" },
  { key: "noStatus", label: "상태 없음", level: "info", query: "-있음:상태" },
  { key: "noDate", label: "작업일 없음", level: "info", query: "-있음:작업일" },
  { key: "noTag", label: "태그 없음", level: "info", query: "-있음:태그" },
  { key: "noClient", label: "고객 없음", level: "info", query: "-있음:고객" },
];

/** 점검 — {key: [{pid, vid, msg}]} */
export function qualityIssues(patterns) {
  const out = Object.fromEntries(CHECKS.map((c) => [c.key, []]));
  (patterns || []).forEach((p) => {
    const vars = p.variations || [];
    SPACE_FIELDS.forEach((k) => slotsOf(p, k).forEach((s) => {
      if (badSpace(s.get())) out.space.push({ pid: p.id, vid: s.vid, msg: `${FIELD[k].label} "${s.get()}"` });
    }));
    const seen = new Map();
    vars.forEach((v) => {
      const code = t(v.colorCode).trim().toLowerCase();
      if (code) { if (seen.has(code)) out.dupcode.push({ pid: p.id, vid: v.id, msg: `${v.colorCode} (${seen.get(code)}와 같음)` }); else seen.set(code, v.id); }
      const d = t(v.date).trim();
      if (d && !/^\d{4}-\d{2}-\d{2}/.test(d)) out.badDate.push({ pid: p.id, vid: v.id, msg: d });
      if (!t(v.colorName).trim() && !t(v.colorCode).trim()) out.noName.push({ pid: p.id, vid: v.id, msg: "" });
      if (!(v.images || []).length) out.noPhoto.push({ pid: p.id, vid: v.id, msg: "" });
      if (!(v.mixes || []).length) out.noMix.push({ pid: p.id, vid: v.id, msg: "" });
      if (!t(v.status).trim()) out.noStatus.push({ pid: p.id, vid: v.id, msg: "" });
      if (!d) out.noDate.push({ pid: p.id, vid: v.id, msg: "" });
    });
    if (!((p.pattern || {}).tags || []).length) out.noTag.push({ pid: p.id, vid: "", msg: "" });
    if (!t(p.client).trim()) out.noClient.push({ pid: p.id, vid: "", msg: "" });
  });
  ["client", "worker", "place", "status", "tags"].forEach((k) => clusterValues(patterns, k).forEach((c) =>
    out.similar.push({ pid: "", vid: "", field: k, msg: `${FIELD[k].label}: ${c.values.map((x) => `"${x.value}"(${x.n})`).join(" · ")}` })));
  return out;
}

/** 공백 정리 (mutate) */
export function tidySpaces(doc) {
  let changed = false;
  SPACE_FIELDS.forEach((k) => slotsOf(doc, k).forEach((s) => {
    const a = s.get(), b = tidySpace(a);
    if (a !== b) { s.set(b); changed = true; }
  }));
  cleanTags(doc);
  return changed;
}

/* ---------- 방금 바꾼 것 되돌리기 ---------- */

const KEEP = new Set(["id", "rev", "updatedAt"]);
/**
 * 문서 내용을 old(고치기 전 사본)로 되돌린다 (saveMany 의 mutate). id·rev·updatedAt 과 '_' 칸은 지금 것 그대로 —
 * 그래야 평소 저장의 rev 검사를 거친다(그 사이 다른 곳에서 고쳤으면 409 로 막힌다).
 */
export function restoreDoc(doc, old) {
  if (!old) return false;
  const clean = (o) => JSON.stringify(Object.keys(o).filter((k) => !k.startsWith("_") && !KEEP.has(k)).sort().map((k) => [k, o[k]]));
  if (clean(doc) === clean(old)) return false;
  Object.keys(doc).forEach((k) => { if (!k.startsWith("_") && !KEEP.has(k)) delete doc[k]; });
  Object.keys(old).forEach((k) => { if (!k.startsWith("_") && !KEEP.has(k)) doc[k] = JSON.parse(JSON.stringify(old[k])); });
  return true;
}
