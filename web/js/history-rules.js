/* RDP 시편 아카이브 — 이전 버전 비교 규칙 (화면을 모르는 순수 함수)
 *
 * 왜 있나
 *   서버는 저장할 때마다 바뀌기 전 파일을 _backup 에 남긴다. 화면의 '변경 이력'이 두 버전 사이에
 *   무엇이 바뀌었는지 사람 말로 보여 주려고 비교 규칙을 여기 모은다(tests/history.test.mjs 가 검사).
 *
 * 되돌리기: 상세 화면의 '이력' 버튼과 이 파일을 지우면 된다. 데이터는 건드리지 않는다.
 */

const s = (v) => (v == null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)).trim();
const short = (v) => { const t = s(v); return t ? (t.length > 40 ? t.slice(0, 39) + "…" : t) : "—"; };

const TOP = [["project", "프로젝트"], ["projectName", "차종명"], ["client", "고객"]];
const PATTERN = [["code", "패턴 코드"], ["name", "영문명"], ["nameKo", "한글명"], ["tags", "태그"]];
const LABEL = [["item", "품목"], ["type", "구분"], ["supplier", "공급사"], ["company", "고객사(라벨)"], ["remark", "비고"]];
const WORK = [["place", "작업 장소"], ["worker", "작업자"], ["machine", "설비"], ["plate", "동판"], ["emboss", "엠보"],
  ["pad", "패드"], ["sop", "양산 일정"], ["volume", "생산 수량"]];
const VAR = [["colorName", "컬러명"], ["colorCode", "컬러코드"], ["status", "상태"], ["date", "작업일"], ["rev", "Rev"], ["note", "메모"]];
const MIX_NUM = [["mattingPct", "소광제%"], ["mattingG", "소광제g"], ["thinnerPct", "신나%"], ["thinnerG", "신나g"],
  ["hardenerPct", "경화제%"], ["hardenerG", "경화제g"]];

function fields(out, prefix, a, b, list) {
  list.forEach(([k, label]) => {
    if (s((a || {})[k]) !== s((b || {})[k])) out.push(`${prefix}${label}: ${short((a || {})[k])} → ${short((b || {})[k])}`);
  });
}

const vLabel = (v) => s(v.colorName) || s(v.colorCode) || s(v.id) || "컬러";
const mixKey = (m) => `${s(m.layer)}|${s(m.batch)}|${s(m.plate)}`;
const mixName = (m) => [s(m.layer), s(m.batch), s(m.plate) && `(${s(m.plate)})`].filter(Boolean).join(" ") || "배합";

/** 배합 한 줄의 값이 바뀌었는가 — 잉크·첨가제·결과·기준 */
function mixChanged(a, b) {
  const ink = (m) => JSON.stringify(Object.entries(m.inks || {}).filter(([, g]) => Number(g)).map(([k, g]) => [k, Number(g)]).sort());
  if (ink(a) !== ink(b)) return "잉크";
  for (const [k, label] of MIX_NUM) if (s(a[k]) !== s(b[k])) return label;
  if (s(a.result) !== s(b.result)) return "결과";
  if (!!a.isReference !== !!b.isReference) return "기준 배합";
  if (s(a.change) !== s(b.change) || s(a.note) !== s(b.note)) return "메모";
  return "";
}

/**
 * older → newer 사이 바뀐 것을 사람 말로.
 * @returns string[] (바뀐 게 없으면 빈 배열)
 */
export function docChanges(older, newer) {
  const a = older || {}, b = newer || {};
  const out = [];
  fields(out, "", a, b, TOP);
  fields(out, "", a.pattern, b.pattern, PATTERN);
  fields(out, "라벨 ", a.label, b.label, LABEL);
  fields(out, "", a.work, b.work, WORK);

  const va = new Map((a.variations || []).filter(Boolean).map((v) => [v.id, v]));
  const vb = new Map((b.variations || []).filter(Boolean).map((v) => [v.id, v]));
  vb.forEach((v, id) => { if (!va.has(id)) out.push(`컬러 추가: ${vLabel(v)}`); });
  va.forEach((v, id) => { if (!vb.has(id)) out.push(`컬러 삭제: ${vLabel(v)}`); });
  vb.forEach((v2, id) => {
    const v1 = va.get(id);
    if (!v1) return;
    const p = `[${vLabel(v2)}] `;
    fields(out, p, v1, v2, VAR);
    fields(out, p + "라벨 ", v1.label, v2.label, LABEL);
    fields(out, p, v1.work, v2.work, WORK.filter(([k]) => ["place", "worker", "machine", "volume"].includes(k)));
    if (s(v1.layerPlates) !== s(v2.layerPlates)) out.push(`${p}도수별 동판 변경`);
    const i1 = (v1.images || []).length, i2 = (v2.images || []).length;
    if (i1 !== i2) out.push(`${p}사진 ${i1} → ${i2}장`);
    else if (s(v1.images) !== s(v2.images)) out.push(`${p}사진 순서·교체`);
    const m1 = new Map((v1.mixes || []).filter(Boolean).map((m) => [mixKey(m), m]));
    const m2 = new Map((v2.mixes || []).filter(Boolean).map((m) => [mixKey(m), m]));
    m2.forEach((m, k) => { if (!m1.has(k)) out.push(`${p}배합 추가: ${mixName(m)}`); });
    m1.forEach((m, k) => { if (!m2.has(k)) out.push(`${p}배합 삭제: ${mixName(m)}`); });
    m2.forEach((m, k) => {
      const o = m1.get(k);
      const what = o && mixChanged(o, m);
      if (what) out.push(`${p}배합 ${mixName(m)} — ${what} 변경`);
    });
  });
  return out;
}

/**
 * 서버 목록(최근 것부터)과 지금 문서로 '저장 한 번 = 한 줄' 목록을 만든다.
 * 줄 k: 백업 k(그 저장 직전 상태) → 그다음 상태(더 최근 백업 또는 지금 문서)
 * @returns [{stamp, before, after, savedAt, changes, error}]
 */
export function historyRows(items, current) {
  const rows = [];
  (items || []).forEach((it, i) => {
    if (it.error || !it.doc) { rows.push({ stamp: it.stamp, error: it.error || "읽지 못함" }); return; }
    // 바로 다음(더 최근) 상태: 앞쪽에서 읽을 수 있는 가장 가까운 백업, 없으면 지금 문서
    let after = current;
    for (let j = i - 1; j >= 0; j--) if (items[j] && items[j].doc) { after = items[j].doc; break; }
    rows.push({ stamp: it.stamp, before: it.doc, after, savedAt: (after && after.updatedAt) || "",
      changes: docChanges(it.doc, after), missingImages: it.missingImages || [] });
  });
  return rows;
}

/** "20261030-101010-123" → "2026.10.30 10:10" */
export function stampText(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(String(stamp || ""));
  return m ? `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}` : String(stamp || "");
}
