/* RDP 시편 아카이브 — 같은 도수 배치끼리 배합 비교 (화면을 모르는 순수 함수)
 *
 * 왜 있나: "B2 에서 B3 로 무엇을 바꿨더니 합격했나"를 표 하나로 보려고.
 *   배치를 열로, 잉크·첨가제를 행으로 놓고 바로 앞 배치와의 차이(Δ)를 계산한다.
 *   tests/mix-compare.test.mjs 가 검사한다.
 *
 * 되돌리기: 상세 화면의 [배치 비교] 버튼과 이 파일을 지우면 된다(데이터는 건드리지 않는다).
 */

const num = (x) => (x === "" || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
const round = (x) => Math.round(x * 1000) / 1000;

/** 한 행: 배치별 값과 앞 배치와의 차이 */
function row(key, label, values, unit) {
  let prev;
  const cells = values.map((v, i) => {
    const cell = { v, d: null, changed: false };
    if (i > 0) {
      if (v != null && prev != null) { cell.d = round(v - prev); cell.changed = cell.d !== 0; }
      else cell.changed = (v == null) !== (prev == null);   // 생기거나 없어짐
    }
    prev = v;
    return cell;
  });
  return { key, label, unit, cells, changedAny: cells.some((c) => c.changed) };
}

/**
 * @param mixes  같은 도수의 배합들(화면 표와 같은 순서)
 * @param order  잉크 이름 배열을 화면 순서로 정렬하는 함수(detail.js 의 inkOrder) — 없으면 이름순
 * @returns {batches:[{batch, plate, date, result, isReference, change}], rows:[{key,label,unit,cells,changedAny}]}
 */
export function batchCompare(mixes, order) {
  const ms = (mixes || []).filter((m) => m && typeof m === "object");
  const inkNames = Array.from(new Set(ms.flatMap((m) => Object.keys(m.inks || {}))));
  const inks = order ? order(inkNames) : inkNames.sort();
  const rows = inks.map((k) => row("ink:" + k, k, ms.map((m) => num((m.inks || {})[k]) ?? null), "g"));
  rows.push(row("total", "잉크 합", ms.map((m) => {
    const vals = Object.values(m.inks || {}).map(num).filter((x) => x != null);
    return vals.length ? round(vals.reduce((a, b) => a + b, 0)) : null;
  }), "g"));
  [["matting", "소광제"], ["thinner", "신나"], ["hardener", "경화제"]].forEach(([k, label]) => {
    [["G", "g"], ["Pct", "%"]].forEach(([suf, unit]) => {
      const vals = ms.map((m) => num(m[k + suf]));
      if (vals.some((x) => x != null)) rows.push(row(k + suf, `${label} ${unit}`, vals, unit));
    });
  });
  const batches = ms.map((m) => ({
    batch: String(m.batch || "—"), plate: String(m.plate || ""), date: String(m.date || ""),
    result: m.result || "", isReference: !!m.isReference, change: String(m.change || m.note || "").trim(),
  }));
  return { batches, rows };
}

/** Δ 표기: +0.5 / −1 (0 이면 빈 문자열) */
export function deltaText(d) {
  if (d == null || d === 0) return "";
  return (d > 0 ? "+" : "−") + String(Math.abs(d));
}
