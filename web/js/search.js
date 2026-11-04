/* RDP 시편 아카이브 — 목차 검색 문법 · 태그 도우미
 *
 * 왜 따로 뺐나
 *   검색 규칙(문법 해석, 어떤 시편·컬러가 걸리는지)을 화면 그리기 코드와 섞으면 고치기 어렵다.
 *   그래서 규칙만 이 파일에 모으고 catalog.js가 가져다 쓴다.
 *   parseQuery·matchVars·patternHay·tokenize 는 DOM을 쓰지 않는 순수 함수다 →
 *   tests/search.test.mjs 가 브라우저 없이 그대로 검사한다(web/js/package.json 의 type:module 참고).
 *
 * 문법 (검색창에 그대로 입력)
 *   #태그           태그가 같은 시편           예) #컬러세미나
 *   @프로젝트        프로젝트가 같은 시편       예) @MQ5
 *   plate:26_015    동판(작업·도수별·배합) 포함
 *   color:E3940     컬러 코드·이름 포함
 *   status:가승인    상태가 같은 베리에이션만 남긴다
 *   client:현대자동차  고객사(대소문자 무시, 완전 일치)
 *   code:G          패턴 코드 앞부분 일치(계열 묶음용)
 *   place:API       작업장소(컬러별 유효값 기준, 완전 일치)
 *   layers:2        인쇄 도수가 2도인 컬러만
 *   앞에 -          제외                      예) #컬러세미나 -@MQ5
 *   "따옴표"         공백 포함                  예) #"메탈 브라운"
 *   그 밖의 단어     예전과 똑같이 부분 문자열 하나로 검색(대소문자 무시)
 *
 * 되돌리기(실수했을 때)
 *   이 파일을 지우고 catalog.js 의 filtered() 를 예전 모양으로 되돌리면 끝난다.
 *   검색 상태는 App.q 하나뿐이라 저장된 데이터는 건드리지 않는다 — 데이터 되돌리기가 필요 없다.
 */

import { workOf } from "./work.js";
import { layersOf } from "./facets.js";
import { devInfo } from "./report-rules.js";

/* 한글 접두 → 영문 키. '상태:보류'처럼 한글로 쓴 조건도 같은 뜻으로 읽는다(예전엔 status: 만 됐다) */
const ALIAS = {
  있음: "has", 날짜: "date", 작업일: "date", 수정: "updated", 별점: "rating", 깃발: "flag",
  상태: "status", 고객: "client", 고객사: "client", 동판: "plate", 컬러: "color", 색: "color",
  장소: "place", 작업장소: "place", 차종: "project", 제안차종: "project",
  개발년도: "devyear", 개발: "devyear", 담당자: "developer", 도장: "coat", 도장컬러: "coat", 코드: "code", 계열: "code", 도수: "layers", 태그: "tag", 프로젝트: "project",
};
const KEYED = new RegExp(`^(tag|project|plate|color|status|client|place|code|layers|has|date|updated|rating|flag|devyear|developer|coat|${Object.keys(ALIAS).join("|")}):([\\s\\S]*)$`, "i");
const low = (s) => String(s == null ? "" : s).toLowerCase().trim();

/** 컬러(베리에이션) 단위로만 판정되는 문법 — 나머지(tag·project)는 시편 단위 */
export const VAR_KEYS = new Set(["plate", "color", "status", "place", "layers", "has", "date", "rating", "flag", "coat"]);

/* 토큰 자르기. -제외 / #태그 / @프로젝트 / "따옴표" 를 붙여 쓸 수 있다.
   raw 는 토큰을 다시 지울 때(칩 토글) 원문을 그대로 되살리기 위해 남긴다. */
const TOK_RE = /(-?)([#@]?)([A-Za-z_]+:)?("[^"]*"|\S+)/g;
export function tokenize(raw) {
  const s = String(raw == null ? "" : raw);
  const out = [];
  TOK_RE.lastIndex = 0;
  let m;
  while ((m = TOK_RE.exec(s)) !== null) {
    if (!m[0]) break;                       // 0길이 매치 방어
    let body = m[4];
    if (body.length > 1 && body[0] === '"' && body[body.length - 1] === '"') body = body.slice(1, -1);
    const prefix = m[3] ? m[3].slice(0, -1).toLowerCase() : "";   // client: 같은 접두
    out.push({ neg: m[1] === "-", sigil: m[2] || "", prefix, text: body, raw: m[0] });
  }
  return out;
}

/**
 * 검색어 → { terms, notText, text, tagMode }
 *   opts.tagMode = "and"(기본) | "or" — 태그를 여러 개 골랐을 때 모두 만족할지, 하나라도 만족할지.
 *   "or" 여도 terms 안의 tag 항목은 그대로 둔다(칩 강조·필터 수 표시가 이 목록을 읽는다).
 *   실제 판정은 matchVars 가 tagMode 를 보고 한꺼번에 처리한다.
 */
export function parseQuery(raw, opts) {
  const terms = [], notText = [], words = [];
  tokenize(raw).forEach((t) => {
    let key = "", val = t.text;
    const KNOWN = ["tag", "project", "plate", "color", "status", "client", "place", "code", "layers", "has", "date", "updated", "rating", "flag", "devyear", "developer", "coat"];
    if (t.prefix && KNOWN.includes(t.prefix)) key = t.prefix;   // 아는 키일 때만 접두로 인정
    else if (!t.prefix && !t.sigil && /^★/.test(t.text)) { key = "rating"; val = t.text.slice(1); }   // ★3 · ★3+
    else if (t.sigil === "#") { key = "tag"; if (t.prefix) val = `${t.prefix}:${t.text}`; }   // #finish:matte 도 그룹 태그
    else if (t.prefix) { val = `${t.prefix}:${t.text}`; }        // RAL:9005 같은 건 그냥 단어로
    else if (t.sigil === "@") key = "project";
    else {
      const m = KEYED.exec(t.text);
      if (m) { key = ALIAS[m[1]] || m[1].toLowerCase(); val = m[2]; }
    }
    val = low(val);
    if (key && val) terms.push({ key, val, neg: t.neg });
    else if (t.neg) { if (val) notText.push(val); }
    else if (val) words.push(val);
  });
  const tagMode = (opts && opts.tagMode) === "or" ? "or" : "and";
  return { terms, notText, text: words.join(" "), tagMode };
}

/** 시편 하나를 부분 문자열로 훑을 때 쓰는 텍스트 (예전 검색과 같은 범위 + 태그·도수 패턴·배합 동판) */
export function patternHay(p) {
  const a = (p && p.pattern) || {}, w = (p && p.work) || {}, lb = (p && p.label) || {};
  return [a.code, a.name, a.nameKo, p.projectName, p.client, lb.type,
    (a.tags || []).join(" "), (w.plate || []).join(" "), (a.vehicles || []).join(" "), a.developer,
    (p.variations || []).map((v) => [v.colorName, v.colorCode,
      (v.coating || []).map((c) => c.code).join(" "),
      Object.values(v.layerPlates || {}).join(" "),
      Object.values(v.layerPatterns || {}).join(" "),
      (v.mixes || []).map((m) => m.plate || "").join(" "), (v.vehicles || []).join(" ")].join(" ")).join(" ")]
    .join(" ").toLowerCase();
}

/* has: 값 → 판정 (사진·배합·동판·메모·태그·작업일·상태·고객) */
const HAS = {
  사진: (p, v) => (v.images || []).length > 0, photo: (p, v) => (v.images || []).length > 0,
  배합: (p, v) => (v.mixes || []).length > 0, mix: (p, v) => (v.mixes || []).length > 0,
  동판: (p, v) => Object.values(v.layerPlates || {}).some(Boolean) || ((p.work || {}).plate || []).length > 0
    || (v.mixes || []).some((m) => m && m.plate),
  메모: (p, v) => !!String(v.note || "").trim(), note: (p, v) => !!String(v.note || "").trim(),
  태그: (p) => ((p.pattern || {}).tags || []).length > 0, tag: (p) => ((p.pattern || {}).tags || []).length > 0,
  작업일: (p, v) => !!String(v.date || "").trim(), date: (p, v) => !!String(v.date || "").trim(),
  상태: (p, v) => !!String(v.status || "").trim(), status: (p, v) => !!String(v.status || "").trim(),
  고객: (p) => !!String(p.client || "").trim(), client: (p) => !!String(p.client || "").trim(),
};
HAS.plate = HAS.동판;

/** date: 값 — '2026-10'(앞부분) · '>2026-09-01' · '<=2026.10' */
function testDate(d, val) {
  const m = /^(>=|<=|>|<)?(.*)$/.exec(String(val).replace(/\./g, "-").replace(/\//g, "-"));
  const op = m[1] || "", x = m[2];
  const day = String(d || "").slice(0, 10);
  if (!day) return false;                    // 날짜 없는 컬러는 비교에서 빠진다
  if (!op) return day.startsWith(x);
  if (op === ">") return day > x && !day.startsWith(x);
  if (op === ">=") return day >= x;
  if (op === "<") return day < x;
  return day <= x || day.startsWith(x);
}

/** rating: 값 — '3'(정확히) · '3+'(이상) · '0'(없음) */
function testRating(r, val) {
  const m = /^(\d)(\+)?$/.exec(String(val));
  if (!m) return false;
  const n = Number(m[1]), have = Number(r || 0);
  return m[2] ? have >= n : have === n;
}

/** 컬러(베리에이션)가 조건에 맞는가 */
function testVar(p, v, t) {
  if (t.key === "has") { const f = HAS[t.val]; return f ? f(p, v) : false; }
  if (t.key === "date") return testDate(v.date, t.val);
  if (t.key === "rating") return testRating(v.rating, t.val);
  if (t.key === "flag") return ["on", "있음", "1", "true", "y"].includes(t.val) ? !!v.flag : !v.flag;
  if (t.key === "coat") return (v.coating || []).some((c) => low(c && c.code) === t.val);   // 도장 컬러(도장 코드)
  if (t.key === "color") return low(v.colorCode).includes(t.val) || low(v.colorName).includes(t.val);
  if (t.key === "status") return low(v.status) === t.val;
  // 작업장소는 컬러별 유효값(workOf)으로 판정 — 같은 패턴의 다른 컬러는 걸리지 않는다
  if (t.key === "place") return low(workOf(p, v).place) === t.val;
  // 도수 개수(1도/2도…) — layerPlates 의 키 수
  if (t.key === "layers") {
    // 칩은 "2도"를 넣고 사용자는 layers:2 로도 쓴다 — 둘 다 받는다
    const n = String(t.val).replace(/도$/, "");
    return String(layersOf(v).length) === n;
  }
  if (t.key === "plate") {
    const plates = [...((p.work || {}).plate || []), ...Object.values(v.layerPlates || {}),
      ...(v.mixes || []).map((m) => m.plate || "")].map(low);
    return plates.some((x) => x && x.includes(t.val));
  }
  return true;
}

/** 수정: N일 이내 — 패턴 updatedAt 기준 (now 는 테스트용) */
function updatedWithin(p, val, now) {
  const n = parseInt(String(val), 10);
  const t = Date.parse(String(p.updatedAt || ""));
  if (!Number.isFinite(n) || !Number.isFinite(t)) return false;
  return (now || Date.now()) - t <= n * 86400000;
}

/**
 * 시편이 검색에 걸리는가. 걸리면 "남는 컬러 id 배열", 안 걸리면 null.
 * 컬러 문법(color:·status:·plate:)이 없으면 컬러는 전부 남는다.
 * 부르는 쪽(catalog.js)이 이 배열을 그대로 담기(#selall)·CSV에 쓴다 → "걸린 컬러만" 동작이 여기서 결정된다.
 */
/** 시편(패턴) 단위 조건 하나 — 태그·프로젝트·고객사·계열·수정일 */
function testPattern(p, t) {
  if (t.key === "tag") return (p.pattern.tags || []).some((x) => low(x) === t.val);
  // 프로젝트 = 등록한 프로젝트 · 차종명 · 제안 차종(패턴과 컬러) — 한 패턴을 여러 차종에 제안하므로
  if (t.key === "project") return low(p.project) === t.val || low(p.projectName) === t.val
    || ((p.pattern || {}).vehicles || []).some((x) => low(x) === t.val)
    || (p.variations || []).some((v) => (v.vehicles || []).some((x) => low(x) === t.val));
  if (t.key === "client") return low(p.client || (p.label || {}).company) === t.val;
  if (t.key === "code") {
    return /^[a-z]+$/.test(t.val)
      ? (String(p.pattern.code).match(/^[A-Za-z]+/) || [""])[0].toLowerCase() === t.val
      : low(p.pattern.code).startsWith(t.val);
  }
  if (t.key === "updated") return updatedWithin(p, t.val, Q_NOW);
  // 개발년도 — 패턴 코드(M-60213-F2 → 2026)에서, 안 되면 개발 년월·가장 이른 작업일 (report-rules.js 와 같은 규칙)
  if (t.key === "devyear") return String(devInfo(p).year || "") === t.val.replace(/년$/, "");
  if (t.key === "developer") return low((p.pattern || {}).developer) === t.val;
  return true;
}
let Q_NOW;   // matchVars 호출 시 채운다(테스트가 now 를 넘길 수 있게)

/**
 * 조건 묶음을 판정한다.
 *   orKeys 에 든 키는 **같은 키끼리 '하나라도'(OR)**, 서로 다른 키끼리는 '모두'(AND).
 *   예) 고객사 2개 + 계열 1개 → (고객사 A 또는 B) 이고 계열 G.
 *   제외(-) 조건은 언제나 개별로 '걸리면 안 됨'.
 */
function evalTerms(list, orKeys, ok) {
  const groups = new Map();
  for (const t of list) {
    if (!t.neg && orKeys.has(t.key)) {
      if (!groups.has(t.key)) groups.set(t.key, []);
      groups.get(t.key).push(t);
    } else if (!ok(t)) return false;
  }
  for (const arr of groups.values()) if (!arr.some(ok)) return false;
  return true;
}

/**
 * 시편이 검색에 걸리는가. 걸리면 "남는 컬러 id 배열", 안 걸리면 null.
 * 컬러 문법(color:·status:·plate:)이 없으면 컬러는 전부 남는다.
 * 부르는 쪽(catalog.js)이 이 배열을 그대로 담기(#selall)·CSV에 쓴다 → "걸린 컬러만" 동작이 여기서 결정된다.
 */
export function matchVars(p, Q) {
  Q_NOW = Q.now;
  const hay = patternHay(p);
  // '하나라도' 모드에서 같은 종류를 2개 이상 골랐으면 그 종류만 OR 로 묶는다(다른 종류는 그대로 AND)
  const orKeys = new Set();
  if (Q.tagMode === "or") {
    const seen = new Map();
    Q.terms.forEach((t) => { if (!t.neg) seen.set(t.key, (seen.get(t.key) || 0) + 1); });
    seen.forEach((n, k) => { if (n > 1) orKeys.add(k); });
  }

  const pt = Q.terms.filter((t) => !VAR_KEYS.has(t.key));
  if (!evalTerms(pt, orKeys, (t) => testPattern(p, t) !== t.neg)) return null;

  if (Q.text && hay.indexOf(Q.text) < 0) return null;
  if (Q.notText.some((w) => hay.indexOf(w) >= 0)) return null;

  const vt = Q.terms.filter((t) => VAR_KEYS.has(t.key));
  const vars = p.variations || [];
  if (!vt.length) return vars.map((v) => v.id);
  const vids = vars.filter((v) => evalTerms(vt, orKeys, (t) => testVar(p, v, t) !== t.neg)).map((v) => v.id);
  return vids.length ? vids : null;
}

/** 태그를 검색창에 넣을 때의 표기 — 공백이 있으면 따옴표로 감싼다 */
export function tagToken(tag) {
  const t = String(tag == null ? "" : tag).replace(/"/g, "").trim();
  return /[\s]/.test(t) ? '#"' + t + '"' : "#" + t;
}

/** 조건에 맞는 토큰만 지운 검색어 (태그 칩을 다시 누를 때) */
export function withoutToken(raw, pred) {
  return tokenize(raw).filter((t) => !pred(t)).map((t) => t.raw).join(" ").trim();
}

/** 자동 태그 칩이 검색어에 넣을 토큰 — 값에 공백이 있으면 따옴표 */
export function fieldToken(key, val) {
  const v = String(val == null ? "" : val).replace(/"/g, "").trim();
  return /\s/.test(v) ? `${key}:"${v}"` : `${key}:${v}`;
}

/** 그 토큰이 검색어에 들어 있는가(칩 강조용) */
export function hasToken(raw, token) {
  return tokenize(raw).some((t) => t.raw === token);
}

export const QUERY_HELP =
  "검색 문법 — #태그  @프로젝트  plate:26_015  color:E3940  status:가승인\n" +
  "고객사 client:현대자동차 · 계열 code:G · 작업장소 place:API · 도수 layers:2\n" +
  "있음 has:사진/배합/동판/메모/태그/상태/고객 · 날짜 date:2026-10 / date:>2026-09-01 · 수정:7 (7일 이내)\n" +
  "개발년도 개발년도:2026 · 담당자 담당자:이름 · 제안 차종 차종:HX5 · 도장 컬러 도장:C-1001\n" +
  "한글로도: 상태:보류 · 고객:가온 · 동판:26_015 · 컬러:블랙 · 장소:1공장 · 계열:G · 도수:2 · 태그:우드 · 프로젝트:HX5\n" +
  "별점 ★3 · ★3+ · rating:0(없음) · 깃발 flag:on/off\n" +
  "앞에 - 를 붙이면 제외 (예: #컬러세미나 -@MQ5) · 공백이 있는 태그는 #\"메탈 브라운\"";

/* ---------- 화면 도우미 (DOM 사용) ---------- */

/**
 * 태그 그룹: '질감:우드'처럼 '그룹:값'으로 쓴 태그를 그룹별로 나눈다(Lightroom 키워드 계층·DAM 네임스페이스).
 * @param counts tagCounts 결과 [["태그", n], ...] (순서 유지)
 * @returns {plain:[["태그", n]], groups:[{name, items:[{tag, value, n}]}]}  그룹은 처음 나온 순서
 */
export function splitTagGroups(counts) {
  const plain = [], groups = new Map();
  (counts || []).forEach(([tag, n]) => {
    const i = String(tag).indexOf(":");
    const name = i > 0 ? String(tag).slice(0, i).trim() : "", value = i > 0 ? String(tag).slice(i + 1).trim() : "";
    if (!name || !value) { plain.push([tag, n]); return; }
    if (!groups.has(name)) groups.set(name, { name, items: [] });
    groups.get(name).items.push({ tag, value, n });
  });
  return { plain, groups: [...groups.values()] };
}

/** 프로젝트 범위 안 태그 사용 수 → [["태그", 개수], ...] 많은 순 */
export function tagCounts(patterns, project) {
  const cnt = new Map();
  (patterns || []).forEach((p) => {
    if (project && project !== "all" && p.project !== project) return;
    new Set((p.pattern.tags || []).map((t) => String(t).trim()).filter(Boolean))
      .forEach((t) => cnt.set(t, (cnt.get(t) || 0) + 1));
  });
  return [...cnt].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
}

/**
 * 편집기의 태그 입력칸에 자동완성을 붙인다.
 * datalist 는 "입력칸 전체 값"과 비교하므로, "멜란지, " 처럼 쉼표를 친 뒤에는 후보가 사라진다.
 * 그래서 입력할 때마다 옵션 값을 "이미 친 앞부분 + 태그" 로 다시 만든다.
 * 같은 입력칸에 두 번 붙지 않도록 input._tagBound 로 막는다(드로어가 다시 그려져도 안전).
 */
export function bindTagInput(input, patterns) {
  if (!input || input._tagBound) return;
  input._tagBound = true;
  let dl = document.getElementById("tag-list");
  if (!dl) { dl = document.createElement("datalist"); dl.id = "tag-list"; document.body.appendChild(dl); }
  input.setAttribute("list", "tag-list");
  const refresh = () => {
    const head = input.value.split(",").slice(0, -1).map((s) => s.trim()).filter(Boolean);
    const used = new Set(head.map(low));
    const prefix = head.length ? head.join(", ") + ", " : "";
    dl.replaceChildren(...tagCounts(patterns, "all")
      .filter(([t]) => !used.has(low(t)))
      .map(([t]) => { const o = document.createElement("option"); o.value = prefix + t; return o; }));
  };
  input.addEventListener("input", refresh);
  input.addEventListener("focus", refresh);
}
