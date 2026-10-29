/* RDP 시편 아카이브 — 색 정렬 표시 규칙 (화면을 모르는 순수 함수)
 *
 * 왜 있나
 *   '색 가까운 순'은 카드를 ΔE 로 줄 세우지만, 카드 사진은 그 시편의 첫 컬러라서
 *   사용자가 "무슨 색이 비슷한 건지" 하나하나 열어 봐야 했다. 정렬에 쓴 그 컬러를
 *   카드에도 그대로 보여 주려고, 정렬 키와 화면 표시가 **같은 함수**를 쓰게 만든다.
 *
 * 되돌리기: catalog.js 가 예전처럼 첫 컬러를 보여 주고 정렬 키를 직접 계산하면 된다(이 파일 삭제).
 */

/**
 * 그 시편에서 기준색과 가장 가까운 컬러.
 * @param pid     시편 id
 * @param hitVids 지금 검색에 걸린 컬러 id 배열(HITS)
 * @param de      Map<"pid/vid", ΔE>
 * @returns {vid, de} | null  (ΔE 가 하나도 없으면 null)
 */
export function bestVar(pid, hitVids, de) {
  if (!de || !Array.isArray(hitVids)) return null;
  let best = null;
  for (const vid of hitVids) {
    const d = de.get(pid + "/" + vid);
    if (typeof d !== "number" || !Number.isFinite(d)) continue;   // ΔE 가 없는 컬러는 건너뛴다
    if (!best || d < best.de) best = { vid, de: d };
  }
  return best;
}

/** 배지에 쓸 짧은 설명 — 아주 가까우면 숫자보다 말이 빠르다 */
export function deLabel(de) {
  if (typeof de !== "number" || !Number.isFinite(de)) return "";
  if (de <= 2) return "거의 같음";
  if (de <= 5) return "비슷";
  return de.toFixed(1);
}

/**
 * 카드가 기본으로 보여 줄 컬러.
 *   sel   사용자가 이 카드에서 칩을 눌러 고른 컬러(p._sel) — 있으면 최우선
 *   best  기준색과 가장 가까운 컬러(색 정렬 중에만)
 *   first 그 시편의 첫 컬러(최근순·코드순)
 */
export function baseVid({ sel, best, first }) {
  return (sel && String(sel)) || (best && best.vid) || (first && String(first)) || null;
}

/**
 * 지금 보이는 컬러의 배지 값. 사진과 배지가 **항상 같은 컬러**를 가리키게 하려고
 * vid 를 반드시 받는다(예전에는 배지가 best 를, 사진이 다른 컬러를 가리킬 수 있었다).
 * @returns {de, label, isBest} | null  (그 컬러의 ΔE 가 없으면 null)
 */
export function badgeFor(pid, vid, de, best) {
  if (!de || !vid) return null;
  const d = de.get(pid + "/" + vid);
  if (typeof d !== "number" || !Number.isFinite(d)) return null;
  return { de: d, label: deLabel(d), isBest: !!(best && best.vid === vid) };
}
