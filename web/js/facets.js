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

/* ---------------- 자동 태그 (파생) ----------------
 * 필드 값을 태그로 '저장'하지 않고 읽을 때 계산한다. 값이 바뀌면 태그도 저절로 바뀐다.
 * 프로젝트는 여기서 만들지 않는다(A줄 프로젝트 칩과 @가 이미 있다).
 */
const EMPTY_VALS = ["", "미정", "-", "—"];

/** 도수 개수 → 표시 이름 */
const layerLabel = (n) => `${n}도`;

/**
 * @returns [{kind, label, values:[{val, n, token}]}] — 빈 값 제외, 값이 1종류뿐인 종류는 숨김
 */
export function autoFacets(patterns, workOf, topPerKind = 6) {
  const kinds = [
    { kind: "code", label: "계열", unit: "pattern" },
    { kind: "client", label: "고객사", unit: "pattern" },
    { kind: "place", label: "작업장소", unit: "color" },
    { kind: "layers", label: "도수", unit: "color" },
  ];
  const out = [];
  kinds.forEach(({ kind, label, unit }) => {
    const cnt = new Map();
    (patterns || []).forEach((p) => {
      if (unit === "pattern") {
        let val = "";
        if (kind === "code") {
          const code = String((p.pattern || {}).code || "");
          const m = code.match(/^[A-Za-z]+/);        // 앞의 영문자만 = 계열(G/M …)
          val = m ? m[0] : "";
        } else {
          val = (p.client || (p.label || {}).company || "");
        }
        val = String(val).trim();
        if (!EMPTY_VALS.includes(val)) cnt.set(val, (cnt.get(val) || 0) + 1);
        return;
      }
      (p.variations || []).forEach((v) => {
        let val = "";
        if (kind === "place") val = String((workOf ? workOf(p, v) : (p.work || {})).place || "").trim();
        else {
          const n = Object.keys((v || {}).layerPlates || {}).length;
          val = n ? layerLabel(n) : "";
        }
        if (!EMPTY_VALS.includes(val)) cnt.set(val, (cnt.get(val) || 0) + 1);
      });
    });
    if (cnt.size < 2) return;                       // 한 종류뿐이면 걸러낼 의미가 없다
    const values = [...cnt].map(([val, n]) => ({ val, n }))
      .sort((a, b) => b.n - a.n || a.val.localeCompare(b.val, "ko"))
      .slice(0, topPerKind);
    out.push({ kind, label, values });
  });
  return out;
}
