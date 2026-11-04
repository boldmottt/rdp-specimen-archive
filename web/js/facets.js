/* RDP 시편 아카이브 — 값 집계 · 표기 정리 (화면을 모르는 순수 함수)
 *
 * 쓰는 곳
 *   1) 고객사 입력 자동완성 (기존 값이 많이 쓴 순으로 후보)
 *   2) 저장할 때 표기 맞춤 (앞뒤 공백·연속 공백·NFC·대소문자만 다른 기존 표기)
 *   3) 자동 태그(autoFacets) 집계
 *
 * 되돌리기: 편집기·목차가 이 파일을 안 쓰게 되돌리고 지우면 된다.
 */

import { devInfo, vehiclesOf } from "./report-rules.js";

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
 * 프로젝트 칩은 따로 있지만, '제안차종'은 등록 프로젝트 + 제안 차종(여러 개)을 모아 보여 준다.
 * 개발년도는 패턴 코드(M-60213-F2 → 2026)에서 읽는다(report-rules.js).
 */
const EMPTY_VALS = ["", "미정", "-", "—"];

/** 도수 개수 → 표시 이름 */
const layerLabel = (n) => `${n}도`;

/**
 * 이 컬러의 도수 목록.
 *   layerPlates(동판 지정)와 배합의 layer 를 **합집합**으로 본다.
 *   동판을 아직 안 채운 컬러(예: 2도 배합만 있고 1도 동판이 빈 경우)가
 *   실제보다 적은 도수로 묶이던 문제를 막는다.
 */
export function layersOf(v) {
  const out = new Set();
  Object.keys((v && v.layerPlates) || {}).forEach((k) => {
    const t = String(k == null ? "" : k).trim();
    if (t) out.add(t);
  });
  ((v && v.mixes) || []).forEach((m) => {
    const t = String((m && m.layer) || "").trim();
    if (t) out.add(t);
  });
  return [...out].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
}

/**
 * @returns [{kind, label, values:[{val, n, token}]}] — 빈 값 제외, 값이 1종류뿐인 종류는 숨김
 */
export function autoFacets(patterns, workOf, topPerKind = 6) {
  const kinds = [
    { kind: "devyear", label: "개발년도", unit: "pattern", byValue: true },
    { kind: "developer", label: "담당자", unit: "pattern" },
    { kind: "project", label: "제안차종", unit: "pattern" },
    { kind: "code", label: "계열", unit: "pattern" },
    { kind: "client", label: "고객사", unit: "pattern" },
    { kind: "place", label: "작업장소", unit: "color" },
    { kind: "layers", label: "도수", unit: "color" },
    { kind: "coat", label: "도장 컬러", unit: "color" },
  ];
  const out = [];
  kinds.forEach(({ kind, label, unit, byValue }) => {
    const cnt = new Map();
    const add = (val) => { val = String(val == null ? "" : val).trim(); if (!EMPTY_VALS.includes(val)) cnt.set(val, (cnt.get(val) || 0) + 1); };
    (patterns || []).forEach((p) => {
      if (kind === "devyear") { add(devInfo(p).year || ""); return; }
      if (kind === "developer") { add((p.pattern || {}).developer); return; }
      if (kind === "project") { vehiclesOf(p).forEach(add); return; }      // 등록 프로젝트 + 제안 차종
      if (kind === "coat") {                                               // 컬러마다 도장 코드(한 컬러에 같은 코드는 한 번)
        (p.variations || []).forEach((v) => new Set((v.coating || []).map((c) => String((c && c.code) || "").trim())).forEach(add));
        return;
      }
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
          const n = layersOf(v).length;
          val = n ? layerLabel(n) : "";
        }
        if (!EMPTY_VALS.includes(val)) cnt.set(val, (cnt.get(val) || 0) + 1);
      });
    });
    if (cnt.size < 2) return;                       // 한 종류뿐이면 걸러낼 의미가 없다
    const values = [...cnt].map(([val, n]) => ({ val, n }))
      .sort(byValue ? (a, b) => b.val.localeCompare(a.val, "ko", { numeric: true })   // 연도는 최근 순으로 전부
        : (a, b) => b.n - a.n || a.val.localeCompare(b.val, "ko"))
      .slice(0, byValue ? 30 : topPerKind);
    out.push({ kind, label, values });
  });
  return out;
}
