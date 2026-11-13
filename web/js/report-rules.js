/* RDP 시편 아카이브 — 패턴 개발 실적 규칙 (화면을 모르는 순수 함수)
 *
 * 패턴 코드 규칙 (회사 전체에서 하나뿐인 코드)
 *   M-60213-F2  (하이픈은 있어도 없어도 된다: M60213F2)
 *   G 50223 F1
 *   │ │└┬┘└┬┘│└ 그날 같은 분류로 만든 순번 (F1, F2 …)
 *   │ │ │  │ └── 이미지 분류 첫 글자 (F=패브릭, T=테크니컬 … 만든 사람 마음)
 *   │ │ │  └──── 일
 *   │ │ └─────── 월
 *   │ └───────── 202x 의 x (5 → 2025)
 *   └─────────── G=지오메트릭 · M=메테리얼
 *
 * 한 패턴을 여러 차종에 제안하므로 실적은 '패턴 코드' 하나당 한 줄이다. 같은 코드를 차종마다 따로
 * 등록해 둔 예전 데이터도 한 줄로 합치고, 제안 차종은 프로젝트 + pattern.vehicles + 컬러별 vehicles 를 모은다.
 * tests/report.test.mjs 가 검사한다.
 */

const t = (x) => (x == null ? "" : String(x).trim());
export const KIND_LABEL = { G: "지오메트릭", M: "메테리얼" };

/** 패턴 코드 → {kind, year, month, day, cat, seq} (규칙에 안 맞으면 null) */
export function parsePatternCode(code) {
  const s = t(code).toUpperCase().replace(/[\s_-]+/g, "");
  const m = /^([GM])(\d)(\d{2})(\d{2})([A-Z]*)(\d*)$/.exec(s);
  if (!m) return null;
  const year = 2020 + Number(m[2]), month = Number(m[3]), day = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { kind: m[1], year, month, day, cat: m[5] || "", seq: m[6] ? Number(m[6]) : null };
}

/** 개발 시점 — 코드에서 읽고, 안 되면 pattern.devDate('2025-02'), 그것도 없으면 컬러 작업일 중 가장 이른 날 */
export function devInfo(p) {
  const pat = (p && p.pattern) || {};
  const c = parsePatternCode(pat.code);
  if (c) return { year: c.year, month: c.month, day: c.day, kind: c.kind, cat: c.cat, source: "code" };
  const kind = /^[GM]/i.test(t(pat.code)) ? t(pat.code)[0].toUpperCase() : "";
  const dd = /^(\d{4})[-./](\d{1,2})/.exec(t(pat.devDate));
  if (dd) return { year: Number(dd[1]), month: Number(dd[2]), day: null, kind, cat: "", source: "devDate" };
  const dates = ((p && p.variations) || []).map((v) => t(v.date).replace(/[./]/g, "-")).filter((x) => /^\d{4}-\d{1,2}/.test(x)).sort();
  if (dates.length) {
    const [y, mo] = dates[0].split("-");
    return { year: Number(y), month: Number(mo), day: null, kind, cat: "", source: "date" };
  }
  return { year: null, month: null, day: null, kind, cat: "", source: "" };
}

const uniq = (xs) => [...new Set(xs.map(t).filter(Boolean))];

/** 이 시편이 제안된 차종 — 등록한 프로젝트 + 패턴의 제안 차종 + 컬러별 제안 차종 */
export function vehiclesOf(p) {
  const pat = (p && p.pattern) || {};
  return uniq([p && p.project, ...(pat.vehicles || []), ...((p && p.variations) || []).flatMap((v) => v.vehicles || [])]);
}

/* ---- 차종 · 사람 칸의 교통정리 ----
 * 차종을 적는 칸이 여럿이라 화면마다 이름과 조합이 달랐다. 이름은 FIELD_LABEL, 조합은 vehicleInfo 한 곳에서만 정한다.
 *   project            대표 제안차종 — 차종 코드 1개. 파일 ID · 라벨에 쓰인다(필수)
 *   projectName        차종명 — 대표 제안차종의 이름(코드와 다른 내용)
 *   pattern.vehicles   추가 제안차종 — 대표 말고도 제안한 차종(여러 개)
 *   variation.vehicles 추가 제안차종(이 컬러만)
 *   pattern.developer  개발 담당자 — 패턴을 맡은 사람(개발 실적 보고서)
 *   work.worker        작업자 — 실제 인쇄한 사람(컬러마다 다를 수 있다)
 */
export const FIELD_LABEL = { project: "대표 제안차종", projectName: "차종명", vehicles: "추가 제안차종", developer: "개발 담당자", worker: "작업자" };

/**
 * 차종 정보 한 벌. v 를 주면 그 컬러 기준(패턴의 추가 차종 + 그 컬러만의 추가 차종), 없으면 시편 전체.
 * @returns {{main, name, extra: string[], all: string[]}}  name 은 대표와 같으면 빈 값(같은 말을 두 번 쓰지 않는다)
 */
export function vehicleInfo(p, v) {
  const pat = (p && p.pattern) || {};
  const main = t(p && p.project), nm = t(p && p.projectName);
  const more = v ? (v.vehicles || []) : ((p && p.variations) || []).flatMap((x) => x.vehicles || []);
  const extra = uniq([...(pat.vehicles || []), ...more]).filter((x) => x !== main);
  return { main, name: nm && nm !== main ? nm : "", extra, all: uniq([main, ...extra]) };
}
/** 한 줄로: "CL4PE (차종명) · HX5 · KQ2" */
export const vehicleText = (info) => [[info.main, info.name ? `(${info.name})` : ""].filter(Boolean).join(" "), ...info.extra].filter(Boolean).join(" · ");

const codeKey = (code) => t(code).toUpperCase().replace(/[\s_-]+/g, "");

/**
 * 실적 줄 — 패턴 코드 하나당 한 줄 (엑셀 양식: 개발년도·개발월·이미지·분류·패턴이름·패턴코드·담당자·제안차종·비고)
 * @param filter {year?, kind?, developer?, vehicle?}
 * @returns [{key, code, name, year, month, day, kind, cat, developer, vehicles, remark, ids:[pid], image:{pid,file}|null, colors, source}]
 */
export function reportRows(patterns, filter = {}) {
  const by = new Map();
  (patterns || []).forEach((p) => {
    const pat = p.pattern || {};
    const key = codeKey(pat.code) || p.id;
    const d = devInfo(p);
    let r = by.get(key);
    if (!r) {
      r = { key, code: t(pat.code), name: "", year: d.year, month: d.month, day: d.day, kind: d.kind, cat: d.cat, source: d.source,
        developer: "", vehicles: [], remark: "", ids: [], image: null, colors: 0 };
      by.set(key, r);
    }
    r.ids.push(p.id);
    r.colors += (p.variations || []).length;
    r.name = r.name || [t(pat.nameKo), t(pat.name) !== r.code ? t(pat.name) : ""].filter(Boolean).join(" · ");
    r.developer = r.developer || t(pat.developer);
    r.remark = uniq([r.remark, (p.label || {}).remark]).join(" / ");
    r.vehicles = uniq([...r.vehicles, ...vehiclesOf(p)]);
    if (!r.image) {
      const v = (p.variations || []).find((x) => (x.images || []).length);
      if (v) r.image = { pid: p.id, file: v.images[0] };
    }
    if (r.year == null && d.year != null) Object.assign(r, { year: d.year, month: d.month, day: d.day, source: d.source });
  });
  const f = filter || {};
  return [...by.values()]
    .filter((r) => (!f.year || r.year === Number(f.year))
      && (!f.kind || r.kind === f.kind)
      && (!f.developer || r.developer === f.developer)
      && (!f.vehicle || r.vehicles.includes(f.vehicle)))
    .sort((a, b) => (a.year || 9999) - (b.year || 9999) || (a.month || 99) - (b.month || 99) || (a.day || 99) - (b.day || 99)
      || a.code.localeCompare(b.code, "ko", { numeric: true }));
}

/** 요약 — 월별·분류별·이미지 분류별·담당자별·차종별 건수 */
export function summarize(rows) {
  const count = (fn) => {
    const m = new Map();
    rows.forEach((r) => [].concat(fn(r)).filter(Boolean).forEach((k) => m.set(k, (m.get(k) || 0) + 1)));
    return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "ko"));
  };
  const byMonth = Array(12).fill(0);
  rows.forEach((r) => { if (r.month >= 1 && r.month <= 12) byMonth[r.month - 1] += 1; });
  return {
    total: rows.length,
    colors: rows.reduce((a, r) => a + r.colors, 0),
    byMonth,
    byKind: count((r) => r.kind && (KIND_LABEL[r.kind] || r.kind)),
    byCat: count((r) => r.cat),
    byDeveloper: count((r) => r.developer || "담당자 미입력"),
    byVehicle: count((r) => r.vehicles),
    noDate: rows.filter((r) => r.year == null).length,
  };
}

/** 고를 수 있는 연도·담당자·차종 목록 */
export function reportOptions(patterns) {
  const rows = reportRows(patterns);
  return {
    years: [...new Set(rows.map((r) => r.year).filter((y) => y != null))].sort((a, b) => b - a),
    developers: uniq(rows.map((r) => r.developer)).sort((a, b) => a.localeCompare(b, "ko")),
    vehicles: uniq(rows.flatMap((r) => r.vehicles)).sort((a, b) => a.localeCompare(b, "ko", { numeric: true })),
  };
}
