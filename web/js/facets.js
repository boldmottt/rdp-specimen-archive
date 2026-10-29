/* RDP 시편 아카이브 — 값 집계 · 표기 정리 (화면을 모르는 순수 함수)
 *
 * 쓰는 곳
 *   1) 고객사 입력 자동완성 (기존 값이 많이 쓴 순으로 후보)
 *   2) 저장할 때 표기 맞춤 (앞뒤 공백·연속 공백·NFC·대소문자만 다른 기존 표기)
 *   3) 자동 태그(autoFacets) 집계
 *
 * 되돌리기: 편집기·목차가 이 파일을 안 쓰게 되돌리고 지우면 된다.
 */

/** 값별 개수 — [{val, n}] 많은 순, 빈 값 제외 */
export function valueCounts(patterns, get) {
  const cnt = new Map();
  (patterns || []).forEach((p) => {
    const raw = get(p);
    const vals = Array.isArray(raw) ? raw : [raw];
    vals.forEach((v) => {
      const s = String(v == null ? "" : v).trim();
      if (!s) return;
      cnt.set(s, (cnt.get(s) || 0) + 1);
    });
  });
  return [...cnt].map(([val, n]) => ({ val, n }))
    .sort((a, b) => b.n - a.n || a.val.localeCompare(b.val, "ko"));
}

/**
 * 저장 직전 표기 정리.
 *   앞뒤 공백 제거 → 연속 공백 하나 → NFC 정규화 → 대소문자만 다른 기존 값이 있으면 그 표기로.
 * @param known 기존 값 목록(valueCounts 결과의 val 배열 등)
 */
export function canonical(value, known) {
  let s = String(value == null ? "" : value);
  s = s.replace(/\s+/g, " ").trim();
  if (s.normalize) s = s.normalize("NFC");
  if (!s) return "";
  const hit = (known || []).find((k) => String(k).toLowerCase() === s.toLowerCase());
  return hit != null ? hit : s;
}

/** 기존 값에 없는 새 표기인가(입력 칸 아래 안내에 쓴다) */
export function isNewValue(value, known) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return false;
  return !(known || []).some((k) => String(k).toLowerCase() === s.toLowerCase());
}
