/* RDP 시편 아카이브 — CSV 일괄 등록 규칙 (화면을 모르는 순수 함수)
 *
 * 한 줄 = 컬러 하나. 프로젝트+패턴코드가 같은 줄은 한 시편으로 묶는다.
 * 머리줄은 'CSV로 내보내기'와 같다(내보낸 파일을 고쳐서 다시 올릴 수 있게) + 몇 칸 더(한글명·고객·품목 …).
 * 이미 있는 컬러는 덮어쓰지 않고 건너뛴다(같은 컬러코드, 없으면 같은 컬러명). tests/csv-import.test.mjs 가 검사.
 *
 * 되돌리기: ⋯ 메뉴 'CSV 가져오기'와 이 파일·import-csv.js 를 지우면 된다.
 */

/** RFC 4180 CSV — 따옴표 안 쉼표·줄바꿈·"" 처리, BOM·CRLF 허용 */
export function parseCsv(text) {
  const s = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

/* 머리줄 이름 → 칸. 내보내기 머리줄과 흔한 다른 표기를 함께 받는다 */
const COLS = {
  project: ["프로젝트", "project"], code: ["패턴코드", "패턴 코드", "code"], name: ["패턴명", "영문명", "name"],
  nameKo: ["한글명", "패턴명(한글)"], client: ["고객", "고객사", "client"], projectName: ["차종명", "차종"],
  colorCode: ["컬러코드", "컬러 코드", "colorcode"], colorName: ["컬러명", "컬러 이름", "colorname"],
  status: ["상태", "status"], date: ["작업일", "작업일자", "date"], rev: ["rev"], plates: ["동판(도수별)", "동판", "plate"],
  tags: ["태그", "tags"], note: ["비고", "메모", "note"], place: ["작업장소", "작업 장소"], worker: ["작업자"],
  machine: ["설비"], volume: ["수량", "생산 수량", "생산수량"], emboss: ["엠보"], pad: ["패드"], sop: ["양산 일정", "양산일정"],
  item: ["품목"], type: ["구분"], supplier: ["공급사"],
};
const key = (h) => String(h || "").replace(/\s+/g, "").toLowerCase();
const LOOKUP = Object.fromEntries(Object.entries(COLS).flatMap(([f, names]) => names.map((n) => [key(n), f])));

const clean = (x) => String(x == null ? "" : x).replace(/^'(?=[=+\-@\t\r])/, "").trim();   // 내보내기의 수식 방지 ' 를 뗀다
const low = (x) => clean(x).toLowerCase();

/** 'YYYY-MM-DD' · 'YYYY.MM.DD' · 'YYYY/M/D' → 'YYYY-MM-DD', 빈 값은 "", 틀리면 null */
export function normDate(x) {
  const t = clean(x);
  if (!t) return "";
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** '1도=26_001 / 2도=26_002' → {layerPlates}, '26_001, 26_002' → {plates} */
export function parsePlates(x) {
  const t = clean(x);
  if (!t) return { layerPlates: {}, plates: [] };
  const parts = t.split(/\s*[/,;]\s*/).filter(Boolean);
  if (parts.every((p) => p.includes("="))) {
    return { layerPlates: Object.fromEntries(parts.map((p) => p.split("=").map((s) => s.trim()))), plates: [] };
  }
  return { layerPlates: {}, plates: parts };
}

const HANGUL = /[가-힣]/, LATIN = /[A-Za-z]/;

/**
 * @param rows      parseCsv 결과(첫 줄은 머리줄)
 * @param patterns  지금 아카이브 시편들(App.patterns)
 * @param opt       {deriveId(project, code), newDoc()}
 * @returns {plans:[{id, project, code, isNew, doc?, target?, add:[variation], skipped:[{line, color}]}], errors:[{line, msg}], warnings:[…], unknown:[머리줄]}
 */
export function buildImport(rows, patterns, opt) {
  const errors = [], warnings = [];
  if (!rows || rows.length < 2) return { plans: [], errors: [{ line: 1, msg: "머리줄과 데이터 줄이 필요합니다" }], warnings, unknown: [] };
  const head = rows[0].map((h) => LOOKUP[key(h)] || null);
  const unknown = rows[0].filter((h, i) => !head[i] && clean(h));
  if (!head.includes("project") || !head.includes("code")) {
    return { plans: [], errors: [{ line: 1, msg: "머리줄에 '프로젝트'와 '패턴코드'가 있어야 합니다" }], warnings, unknown };
  }
  const groups = new Map();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const o = {};
    head.forEach((f, k) => { if (f) o[f] = clean(r[k]); });
    if (!o.project || !o.code) { errors.push({ line, msg: "프로젝트·패턴코드는 꼭 있어야 합니다" }); return; }
    if (!o.colorCode && !o.colorName) { errors.push({ line, msg: "컬러코드나 컬러명 중 하나는 있어야 합니다" }); return; }
    const date = normDate(o.date);
    if (date === null) { errors.push({ line, msg: `작업일 형식이 틀립니다: ${o.date} (예: 2026-10-31)` }); return; }
    o.date = date;
    const id = opt.deriveId(o.project, o.code);
    if (!id) { errors.push({ line, msg: "프로젝트·패턴코드에 영문이나 숫자가 하나는 있어야 합니다(파일 이름)" }); return; }
    const gk = low(o.project) + "|" + low(o.code);                 // 대소문자만 다른 코드는 같은 시편
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push({ line, o, id });
  });

  const plans = [];
  groups.forEach((items) => {
    const first = items[0].o;
    const id = items[0].id;
    const existing = (patterns || []).find((p) => p.id === id
      || (low(p.project) === low(first.project) && low((p.pattern || {}).code) === low(first.code)));
    const seen = new Set();
    const known = existing ? (existing.variations || []) : [];
    const plan = { id: existing ? existing.id : id, project: first.project, code: first.code, isNew: !existing, add: [], skipped: [] };
    let seq = Math.max(0, ...known.map((v) => Number((/^v(\d+)$/.exec(v.id || "") || [])[1] || 0)),
      Number(existing && existing.nextVarSeq ? existing.nextVarSeq - 1 : 0));
    items.forEach(({ line, o }) => {
      const ck = low(o.colorCode) || "name:" + low(o.colorName);
      if (seen.has(ck)) { errors.push({ line, msg: `같은 파일에 같은 컬러가 두 번 있습니다 (${o.colorCode || o.colorName})` }); return; }
      seen.add(ck);
      const dup = known.find((v) => (o.colorCode ? low(v.colorCode) === low(o.colorCode) : low(v.colorName) === low(o.colorName)));
      if (dup) { plan.skipped.push({ line, color: o.colorCode || o.colorName }); return; }
      const pl = parsePlates(o.plates);
      seq += 1;
      const v = { id: "v" + String(seq).padStart(2, "0"), colorName: o.colorName || "", colorCode: o.colorCode || "", coating: [],
        status: o.status || "", date: o.date || "", images: [], mixes: [], note: o.note || "" };
      if (o.rev) v.rev = o.rev;
      if (Object.keys(pl.layerPlates).length) v.layerPlates = pl.layerPlates;
      plan.add.push(v);
      // 패턴 공통 칸이 줄마다 다르면 첫 줄 값을 쓰고 알린다
      ["client", "projectName", "name", "nameKo", "tags", "place", "worker", "machine", "item", "type", "supplier"].forEach((f) => {
        if (o[f] && first[f] && o[f] !== first[f]) warnings.push({ line, msg: `${f} 값이 첫 줄(${first[f]})과 달라 첫 줄 값을 씁니다` });
      });
    });
    if (!plan.add.length && !plan.skipped.length) return;
    if (plan.isNew) {
      const d = opt.newDoc();
      d.id = id; d.project = first.project; d.pattern.code = first.code;
      if (first.client) d.client = first.client;
      if (first.projectName) d.projectName = first.projectName;
      let name = first.name || "", nameKo = first.nameKo || "";
      if (name && !nameKo && HANGUL.test(name) && !LATIN.test(name)) { nameKo = name; name = ""; }   // 한글만 적힌 패턴명은 한글명으로
      d.pattern.name = name; d.pattern.nameKo = nameKo;
      if (first.tags) d.pattern.tags = first.tags.split(/\s*,\s*/).filter(Boolean);
      ["place", "worker", "machine", "volume", "emboss", "pad", "sop"].forEach((f) => { if (first[f]) d.work[f] = first[f]; });
      const pl = parsePlates(first.plates);
      if (pl.plates.length) d.work.plate = pl.plates;
      ["item", "type", "supplier"].forEach((f) => { if (first[f]) d.label[f] = first[f]; });
      d.variations = plan.add;
      d.nextVarSeq = seq + 1;
      plan.doc = d;
    } else {
      plan.target = existing;
      plan.nextVarSeq = seq + 1;
    }
    plans.push(plan);
  });
  return { plans, errors, warnings, unknown };
}

/** 양식 파일 — 내보내기와 같은 머리줄 + 몇 칸, 예시 한 줄 */
export const TEMPLATE_HEAD = ["프로젝트", "패턴코드", "패턴명", "한글명", "고객", "컬러코드", "컬러명", "상태", "작업일", "Rev",
  "동판(도수별)", "태그", "비고", "작업장소", "작업자", "설비", "품목", "구분"];
export const TEMPLATE_ROW = ["PJ01", "W01", "Wood", "우드", "고객사", "K-1001", "다크 브라운", "샘플", "2026-10-31", "0",
  "1도=26_001 / 2도=26_002", "우드, 엠보", "", "", "", "", "도어 가니시", "2도 인쇄"];
