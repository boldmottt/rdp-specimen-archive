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
 *   앞에 -          제외                      예) #컬러세미나 -@MQ5
 *   "따옴표"         공백 포함                  예) #"메탈 브라운"
 *   그 밖의 단어     예전과 똑같이 부분 문자열 하나로 검색(대소문자 무시)
 *
 * 되돌리기(실수했을 때)
 *   이 파일을 지우고 catalog.js 의 filtered() 를 예전 모양으로 되돌리면 끝난다.
 *   검색 상태는 App.q 하나뿐이라 저장된 데이터는 건드리지 않는다 — 데이터 되돌리기가 필요 없다.
 */

const KEYED = /^(tag|project|plate|color|status):([\s\S]*)$/i;
const low = (s) => String(s == null ? "" : s).toLowerCase().trim();

/** 컬러(베리에이션) 단위로만 판정되는 문법 — 나머지(tag·project)는 시편 단위 */
export const VAR_KEYS = new Set(["plate", "color", "status"]);

/* 토큰 자르기. -제외 / #태그 / @프로젝트 / "따옴표" 를 붙여 쓸 수 있다.
   raw 는 토큰을 다시 지울 때(칩 토글) 원문을 그대로 되살리기 위해 남긴다. */
const TOK_RE = /(-?)([#@]?)("[^"]*"|\S+)/g;
export function tokenize(raw) {
  const s = String(raw == null ? "" : raw);
  const out = [];
  TOK_RE.lastIndex = 0;
  let m;
  while ((m = TOK_RE.exec(s)) !== null) {
    if (!m[0]) break;                       // 0길이 매치 방어
    let body = m[3];
    if (body.length > 1 && body[0] === '"' && body[body.length - 1] === '"') body = body.slice(1, -1);
    out.push({ neg: m[1] === "-", sigil: m[2] || "", text: body, raw: m[0] });
  }
  return out;
}

/** 검색어 → { terms: 문법 조건들, notText: 제외 단어, text: 나머지 부분 문자열 } */
export function parseQuery(raw) {
  const terms = [], notText = [], words = [];
  tokenize(raw).forEach((t) => {
    let key = "", val = t.text;
    if (t.sigil === "#") key = "tag";
    else if (t.sigil === "@") key = "project";
    else {
      const m = KEYED.exec(t.text);
      if (m) { key = m[1].toLowerCase(); val = m[2]; }
    }
    val = low(val);
    if (key && val) terms.push({ key, val, neg: t.neg });
    else if (t.neg) { if (val) notText.push(val); }
    else if (val) words.push(val);
  });
  return { terms, notText, text: words.join(" ") };
}

/** 시편 하나를 부분 문자열로 훑을 때 쓰는 텍스트 (예전 검색과 같은 범위 + 태그·도수 패턴·배합 동판) */
export function patternHay(p) {
  const a = (p && p.pattern) || {}, w = (p && p.work) || {}, lb = (p && p.label) || {};
  return [a.code, a.name, a.nameKo, p.projectName, p.client, lb.type,
    (a.tags || []).join(" "), (w.plate || []).join(" "),
    (p.variations || []).map((v) => [v.colorName, v.colorCode,
      (v.coating || []).map((c) => c.code).join(" "),
      Object.values(v.layerPlates || {}).join(" "),
      Object.values(v.layerPatterns || {}).join(" "),
      (v.mixes || []).map((m) => m.plate || "").join(" ")].join(" ")).join(" ")]
    .join(" ").toLowerCase();
}

/** 컬러(베리에이션)가 조건에 맞는가 */
function testVar(p, v, t) {
  if (t.key === "color") return low(v.colorCode).includes(t.val) || low(v.colorName).includes(t.val);
  if (t.key === "status") return low(v.status) === t.val;
  if (t.key === "plate") {
    const plates = [...((p.work || {}).plate || []), ...Object.values(v.layerPlates || {}),
      ...(v.mixes || []).map((m) => m.plate || "")].map(low);
    return plates.some((x) => x && x.includes(t.val));
  }
  return true;
}

/**
 * 시편이 검색에 걸리는가. 걸리면 "남는 컬러 id 배열", 안 걸리면 null.
 * 컬러 문법(color:·status:·plate:)이 없으면 컬러는 전부 남는다.
 * 부르는 쪽(catalog.js)이 이 배열을 그대로 담기(#selall)·CSV에 쓴다 → "걸린 컬러만" 동작이 여기서 결정된다.
 */
export function matchVars(p, Q) {
  const hay = patternHay(p);
  for (const t of Q.terms) {
    if (VAR_KEYS.has(t.key)) continue;
    const hit = t.key === "tag" ? (p.pattern.tags || []).some((x) => low(x) === t.val)
      : t.key === "project" ? low(p.project) === t.val || low(p.projectName) === t.val
        : true;
    // neg=false → 걸려야 한다 / neg=true → 걸리면 안 된다. 둘 중 하나만 어긋나도 탈락.
    if (hit === t.neg) return null;
  }
  if (Q.text && hay.indexOf(Q.text) < 0) return null;
  if (Q.notText.some((w) => hay.indexOf(w) >= 0)) return null;

  const vt = Q.terms.filter((t) => VAR_KEYS.has(t.key));
  const vars = p.variations || [];
  if (!vt.length) return vars.map((v) => v.id);
  const vids = vars.filter((v) => vt.every((t) => testVar(p, v, t) !== t.neg)).map((v) => v.id);
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

export const QUERY_HELP =
  "검색 문법 — #태그  @프로젝트  plate:26_015  color:E3940  status:가승인\n" +
  "앞에 - 를 붙이면 제외 (예: #컬러세미나 -@MQ5) · 공백이 있는 태그는 #\"메탈 브라운\"";

/* ---------- 화면 도우미 (DOM 사용) ---------- */

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
