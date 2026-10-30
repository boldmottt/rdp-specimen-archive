/* RDP 시편 아카이브 — 동판 대장 규칙 (화면을 모르는 순수 함수)
 *
 * 세 곳에 흩어진 동판 정보를 동판 번호(lot) 하나로 모은다.
 *   · rdp.db  : 동판 표(규격·종류·메모·만든 날) + 그 동판에 등록된 패턴
 *   · 아카이브 : 시편이 실제로 쓰는 동판(작업 정보 동판 · 도수별 동판 · 배합 줄의 동판)
 *   · 작업일지 : 그 동판으로 작업한 날(처음·마지막·일수)
 * tests/plates.test.mjs 가 검사한다.
 *
 * 되돌리기: #/plates 화면(plates-page.js)과 이 파일을 지우면 된다. 데이터는 읽기만 한다.
 */

const t = (x) => String(x == null ? "" : x).trim();

/** 아카이브에서 lot → [{pid, project, code, layers:[], colors:[]}] */
export function archivePlateUse(patterns, colorName) {
  const out = new Map();
  const use = (lot, p, layer, color) => {
    lot = t(lot);
    if (!lot) return;
    if (!out.has(lot)) out.set(lot, new Map());
    const m = out.get(lot);
    if (!m.has(p.id)) m.set(p.id, { pid: p.id, project: t(p.project), code: t((p.pattern || {}).code), layers: new Set(), colors: new Set() });
    const e = m.get(p.id);
    if (layer) e.layers.add(t(layer));
    if (color) e.colors.add(color);
  };
  (patterns || []).forEach((p) => {
    ((p.work || {}).plate || []).forEach((lot) => use(lot, p, "", ""));
    (p.variations || []).forEach((v) => {
      const nm = colorName ? colorName(v) : t(v.colorName || v.colorCode || v.id);
      Object.entries(v.layerPlates || {}).forEach(([layer, lot]) => use(lot, p, layer, nm));
      (v.mixes || []).forEach((mx) => { if (mx && mx.plate) use(mx.plate, p, mx.layer, nm); });
    });
  });
  const res = new Map();
  out.forEach((m, lot) => res.set(lot, [...m.values()].map((e) => ({ ...e, layers: [...e.layers].sort(), colors: [...e.colors] }))
    .sort((a, b) => (a.project + a.code).localeCompare(b.project + b.code))));
  return res;
}

/**
 * @param dbPlates      /api/plates 의 plates
 * @param patterns      App.patterns
 * @param worklogPlates /api/pccs/plates 의 plates ({lot, first, last, days, patterns})
 * @returns [{lot, db, archive, worklog, last, flags:{notInDb, unused}}] — 최근 활동 먼저
 */
export function mergePlates(dbPlates, patterns, worklogPlates, colorName) {
  const rows = new Map();
  const row = (lot) => {
    lot = t(lot);
    if (!rows.has(lot)) rows.set(lot, { lot, db: null, archive: [], worklog: null });
    return rows.get(lot);
  };
  (dbPlates || []).forEach((d) => { if (t(d.lot)) row(d.lot).db = d; });
  archivePlateUse(patterns, colorName).forEach((list, lot) => { row(lot).archive = list; });
  (worklogPlates || []).forEach((w) => { if (t(w.lot)) row(w.lot).worklog = w; });
  const out = [...rows.values()].map((r) => ({
    ...r,
    // 최근 활동: 작업일지 마지막 날 · DB 만든 날 중 늦은 것
    last: [r.worklog && r.worklog.last, r.db && r.db.created].map(t).filter(Boolean).sort().pop() || "",
    flags: { notInDb: !r.db && !!(dbPlates && dbPlates.length) && r.archive.length > 0, unused: !r.archive.length },
  }));
  return out.sort((a, b) => b.last.localeCompare(a.last) || b.lot.localeCompare(a.lot));
}

/** 검색: 동판 번호·종류·메모·패턴 코드·프로젝트 (대소문자 무시) */
export function plateMatches(r, q) {
  const s = t(q).toLowerCase();
  if (!s) return true;
  const hay = [r.lot, r.db && r.db.type, r.db && r.db.size, r.db && r.db.note,
    ...(r.db ? r.db.usedBy || [] : []).map((u) => `${u.project} ${u.code}`),
    ...r.archive.map((a) => `${a.project} ${a.code} ${a.colors.join(" ")}`),
    ...(r.worklog ? r.worklog.patterns || [] : [])].join(" ").toLowerCase();
  return hay.includes(s);
}
