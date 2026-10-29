/* RDP 시편 아카이브 — 컬러별 작업정보 (화면을 모르는 순수 함수)
 *
 * 왜 있나
 *   작업정보(장소·작업자·설비·SOP·엠보·패드·수량)가 패턴 공통이라, 같은 패턴의 컬러를 다른 날·다른 곳에서
 *   작업한 것을 표현할 수 없었다. 라벨과 같은 '공통 + 컬러 덮어쓰기' 규칙을 쓴다.
 *
 * 규칙
 *   · p.work = 공통값, v.work = 이 컬러만 다른 값(없거나 빈 문자열이면 공통값 상속)
 *   · 컬러별로 열 필드 = WORK_VAR_KEYS (장소·작업자·설비·수량). 작업일자는 이미 v.date 로 컬러별.
 *   · SOP·엠보·패드·plate 는 패턴 공통으로 남긴다(v.work 에 있어도 무시).
 *   · 저장할 때 공통값과 같아진 값은 v.work 에서 지운다(의미 없는 덮어쓰기가 쌓이지 않게).
 *
 * 되돌리기: 이 파일을 지우고 detail/editor/csv 가 p.work 를 직접 읽게 되돌리면 된다.
 */

/** 컬러별로 열 필드 (p.work 의 실제 키 이름과 맞춘다) */
export const WORK_VAR_KEYS = ["place", "worker", "machine", "volume"];

/** 패턴 공통으로 남기는 필드 */
export const WORK_PATTERN_KEYS = ["sop", "emboss", "pad", "plate"];

const str = (v) => (v == null ? "" : String(v).trim());

/** 유효 작업정보 — 컬러 덮어쓰기가 이긴다 */
export function workOf(p, v) {
  const base = (p && p.work) || {};
  const over = (v && v.work) || {};
  const out = { ...base };
  WORK_VAR_KEYS.forEach((k) => {
    const val = over[k];
    if (str(val) !== "") out[k] = val;
  });
  return out;
}

/** 그 값이 어디서 왔는가 — "color" | "pattern" */
export function workSource(p, v, key) {
  const over = (v && v.work) || {};
  return WORK_VAR_KEYS.includes(key) && str(over[key]) !== "" ? "color" : "pattern";
}

/**
 * 저장 직전 v.work 정리 — 빈 값과 공통값과 같은 값을 지우고, 남는 게 없으면 null.
 * @returns object|null
 */
export function cleanVarWork(vWork, pWork) {
  const over = vWork || {};
  const base = pWork || {};
  const out = {};
  WORK_VAR_KEYS.forEach((k) => {
    const val = over[k];
    if (str(val) === "") return;             // 빈 값 = 상속
    if (str(val) === str(base[k])) return;   // 공통값과 같으면 덮어쓸 이유가 없다
    out[k] = val;
  });
  return Object.keys(out).length ? out : null;
}

/** 그 키를 덮어쓴 컬러 수(일괄 편집 미리보기 안내에 쓴다) */
export function overrides(patterns, key) {
  let n = 0;
  (patterns || []).forEach((p) => (p.variations || []).forEach((v) => {
    if (str(((v || {}).work || {})[key]) !== "") n++;
  }));
  return n;
}
