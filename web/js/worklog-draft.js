/* RDP 시편 아카이브 — 작업일지 → 새 시편 초안 합치기 (화면을 모르는 순수 함수)
 *
 * 서버(/api/worklog-draft)가 작업일지 작업 하나에서 뽑은 값을 빈 새 시편(newDoc)에 얹는다.
 * 일지에 없는 칸은 새 시편 기본값을 그대로 둔다(빈 값으로 덮지 않는다). tests/worklog-draft.test.mjs 가 검사.
 *
 * 되돌리기: from-worklog.js 와 이 파일을 지우고 ⋯ 메뉴·새 시편 화면의 버튼을 빼면 된다.
 */

const t = (x) => (x == null ? "" : String(x).trim());

/**
 * @param base  newDoc() 결과(바꾼다)
 * @param draft 서버 응답의 draft {project, client, pattern:{code}, work:{…}, variation:{date, layerPlates, mixes, note}}
 * @returns base
 */
export function applyWorklogDraft(base, draft) {
  const d = draft || {};
  if (t(d.project)) base.project = t(d.project);
  if (t(d.client)) base.client = t(d.client);
  if (d.pattern && t(d.pattern.code)) base.pattern.code = t(d.pattern.code);
  Object.entries(d.work || {}).forEach(([k, v]) => {
    if (Array.isArray(v) ? v.length : t(v)) base.work[k] = Array.isArray(v) ? v.slice() : t(v);
  });
  const v = base.variations[0];
  const dv = d.variation || {};
  if (t(dv.date)) v.date = t(dv.date);
  if (dv.layerPlates && Object.keys(dv.layerPlates).length) v.layerPlates = { ...dv.layerPlates };
  if (Array.isArray(dv.mixes)) v.mixes = dv.mixes.map((m) => ({ ...m, inks: { ...(m.inks || {}) } }));
  if (t(dv.note)) v.note = t(dv.note);
  return base;
}

/** 목록 검색: 날짜·제목·코드·동판·고객 (대소문자 무시) */
export function jobMatches(j, q) {
  const s = t(q).toLowerCase();
  if (!s) return true;
  return [j.date, j.title, j.code, j.lot, j.customer, j.project, j.stage].map(t).join(" ").toLowerCase().includes(s);
}
