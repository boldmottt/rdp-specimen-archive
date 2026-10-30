/* RDP 시편 아카이브 — 시편 나란히 비교 규칙 (화면을 모르는 순수 함수)
 *
 * 2~4개 컬러를 열로 놓고 같은 항목을 행으로 맞춘다. 열마다 값이 다르면 그 행을 '다름'으로 표시한다.
 * 배합은 도수별로 '기준 배합(*)이 있으면 그것, 없으면 마지막 배치'를 대표로 보여 준다.
 * tests/compare.test.mjs 가 검사한다.
 *
 * 되돌리기: #/compare 화면(compare-page.js)과 이 파일을 지우면 된다. 데이터는 읽기만 한다.
 */

export const COMPARE_MAX = 4;

const t = (x) => (x == null ? "" : Array.isArray(x) ? x.join(", ") : String(x)).trim();
const n = (x) => { const v = Number(x); return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : t(x); };

/** 도수별 대표 배합: 기준(*) → 없으면 마지막 줄 */
export function layerRecipe(mixes, layer, inkOrder) {
  const rows = (mixes || []).filter((m) => m && t(m.layer) === layer);
  if (!rows.length) return "";
  const m = rows.find((x) => x.isReference) || rows[rows.length - 1];
  const names = Object.keys(m.inks || {}).filter((k) => Number(m.inks[k]));
  const ordered = inkOrder ? inkOrder(names) : names;
  const inks = ordered.map((k) => `${k} ${n(m.inks[k])}`).join(" · ");
  const add = [["thinner", "신나"], ["hardener", "경화"], ["matting", "소광"]]
    .map(([k, l]) => (m[k + "G"] != null ? `${l} ${n(m[k + "G"])}g` : m[k + "Pct"] != null ? `${l} ${n(m[k + "Pct"])}%` : ""))
    .filter(Boolean).join(" · ");
  return `${t(m.batch)}${m.isReference ? "*" : ""}: ${inks || "—"}${add ? " / " + add : ""}${rows.length > 1 ? ` (배치 ${rows.length})` : ""}`;
}

/**
 * @param items [{p, v}] — 열 순서
 * @param opt   {workOf(p,v), inkOrder(names), vName(v)}
 * @returns [{key, label, group, values:[string], differ}]
 */
export function compareRows(items, opt = {}) {
  const work = (p, v) => (opt.workOf ? opt.workOf(p, v) : (p.work || {}));
  const lab = (p, v, k) => t(((v.label || {})[k]) || ((p.label || {})[k]));
  const rows = [];
  const add = (group, key, label, get) => {
    const values = items.map(({ p, v }) => t(get(p, v)));
    if (values.every((x) => !x)) return;                         // 모두 비면 행을 만들지 않는다
    rows.push({ key, label, group, values, differ: new Set(values).size > 1 });
  };
  add("기본", "code", "패턴", (p) => [t((p.pattern || {}).code), t((p.pattern || {}).nameKo || (p.pattern || {}).name)].filter(Boolean).join(" · "));
  add("기본", "color", "컬러", (p, v) => (opt.vName ? opt.vName(v) : t(v.colorName || v.colorCode)));
  add("기본", "colorCode", "컬러코드", (p, v) => v.colorCode);
  add("기본", "project", "프로젝트", (p) => [p.project, p.projectName].map(t).filter(Boolean).join(" · "));
  add("기본", "client", "고객", (p) => p.client);
  add("기본", "status", "상태", (p, v) => v.status);
  add("기본", "date", "작업일", (p, v) => v.date);
  add("기본", "rev", "Rev", (p, v) => v.rev);
  add("기본", "tags", "태그", (p) => (p.pattern || {}).tags);
  [["item", "품목"], ["type", "구분"], ["supplier", "공급사"], ["remark", "비고"]]
    .forEach(([k, l]) => add("라벨", "label." + k, l, (p, v) => lab(p, v, k)));
  [["place", "작업 장소"], ["worker", "작업자"], ["machine", "설비"], ["emboss", "엠보"], ["pad", "패드"], ["sop", "양산 일정"], ["volume", "생산 수량"]]
    .forEach(([k, l]) => add("작업", "work." + k, l, (p, v) => work(p, v)[k]));
  const layers = Array.from(new Set(items.flatMap(({ v }) => [
    ...Object.keys(v.layerPlates || {}), ...(v.mixes || []).map((m) => t(m && m.layer)).filter(Boolean)])))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b));
  layers.forEach((L) => {
    add("동판·배합", "plate." + L, `${L} 동판`, (p, v) => (v.layerPlates || {})[L]);
    add("동판·배합", "mix." + L, `${L} 배합`, (p, v) => layerRecipe(v.mixes, L, opt.inkOrder));
  });
  add("기타", "note", "메모", (p, v) => v.note);
  return rows;
}

/** 비교 목록에 넣기/빼기 — 같은 컬러는 한 번만, 최대 COMPARE_MAX. 넘치면 {list, full:true} */
export function toggleCompare(list, pid, vid) {
  const cur = (list || []).filter((x) => x && x.pid && x.vid);
  const i = cur.findIndex((x) => x.pid === pid && x.vid === vid);
  if (i >= 0) return { list: cur.filter((_, k) => k !== i), added: false, full: false };
  if (cur.length >= COMPARE_MAX) return { list: cur, added: false, full: true };
  return { list: cur.concat({ pid, vid }), added: true, full: false };
}
