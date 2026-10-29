/* RDP 시편 아카이브 — 일괄 편집 규칙 · CSV 만들기 (화면을 모르는 순수 함수)
 *
 * 왜 따로 있나
 *   "무엇이 바뀌는가"를 화면 없이 검사하려고. tests/bulk.test.mjs 가 이 파일만 읽어 검사한다.
 *   bulk.js(화면)는 이 규칙을 부르기만 한다.
 *
 * 지켜야 할 규칙
 *   1) 비운 칸은 "변경 안 함". 사용자가 적은 칸만 바뀐다.
 *   2) 일괄 편집에서 동판(layerPlates)은 바꾸지 않는다 — 일부러 뺐다.
 *      배합 줄(m.plate)과 도수가 어긋나면 DB 키(동판 포함)가 달라져 같은 배합이 두 줄로 남을 수 있다.
 *      서버의 track_plate_changes 는 "같은 컬러·(도수,배치) 짝이 하나일 때만" 옮기므로,
 *      여러 배합을 한꺼번에 옮기는 일괄 편집은 안전하지 않다. 동판은 상세 화면에서 하나씩 바꾼다.
 *   3) CSV 는 엑셀에서 열리도록 UTF-8 BOM + CRLF. 수식 주입(=,+,-,@,탭,CR)은 앞에 ' 를 붙인다
 *      (OWASP 기준. - 도 포함해야 한다 — 코드가 -T1 로 시작하는 값이 있다).
 */

/**
 * 컬러 단위 항목을 적용할 컬러 범위.
 *   scope="all"  → null (모든 컬러)
 *   scope="hits" → 지금 검색에 걸린 컬러만. **목록에 없는 시편이면 빈 집합** —
 *                  예전에는 null(전체)을 돌려줘서, 검색으로 숨긴 시편의 모든 컬러가 바뀌었다.
 */
export function scopeVids(scope, hitIds) {
  if (scope !== "hits") return null;
  return new Set(Array.isArray(hitIds) ? hitIds : []);
}

export const BULK_HINT =
  "비운 칸은 바꾸지 않습니다. 동판은 여기서 바꾸지 않습니다(배합·DB 가 어긋날 수 있어 상세 화면에서 하나씩) — ";

const s = (v) => String(v == null ? "" : v).trim();
const low = (v) => s(v).toLowerCase();

/**
 * 문서 하나에 일괄 편집을 적용한다(문서를 고친다).
 * @param doc   패턴 JSON (clone 해서 넘길 것)
 * @param spec  {status, worker, sop, rev, tagsAdd:[], tagsRemove:[]} — 빈 문자열/빈 배열은 "변경 안 함"
 * @param vids  null = 모든 컬러, Set = 그 컬러 id 만 (컬러 단위 항목에만 적용)
 * @returns 바뀐 칸 수 (0이면 저장할 필요 없음)
 */
export function applySpec(doc, spec, vids) {
  let n = 0;
  if (!doc) return 0;
  doc.work = doc.work || {};
  doc.pattern = doc.pattern || {};

  const set = (o, k, val) => {
    if (!val) return;                 // 빈 칸 = 변경 안 함
    if (o[k] !== val) { o[k] = val; n++; }
  };
  set(doc.work, "worker", s(spec.worker));
  set(doc.work, "sop", s(spec.sop));

  const add = (spec.tagsAdd || []).map(s).filter(Boolean);
  const del = new Set((spec.tagsRemove || []).map(low).filter(Boolean));
  if (add.length || del.size) {
    const cur = Array.isArray(doc.pattern.tags) ? doc.pattern.tags.slice() : [];
    const next = cur.filter((t) => !del.has(low(t)));
    add.forEach((t) => { if (!next.some((x) => low(x) === low(t))) next.push(t); });
    if (next.join("\u0001") !== cur.join("\u0001")) { doc.pattern.tags = next; n++; }
  }

  const st = s(spec.status);
  const rv = spec.rev == null ? "" : String(spec.rev).trim();   // "0" 도 값이다
  (doc.variations || []).forEach((v) => {
    if (!v || typeof v !== "object") return;
    if (vids && !vids.has(v.id)) return;
    if (st && v.status !== st) { v.status = st; n++; }
    if (rv !== "" && String(v.rev == null ? "" : v.rev) !== rv) { v.rev = rv; n++; }
  });
  return n;
}

/** CSV 한 칸 — 쉼표·따옴표·줄바꿈은 감싸고, 수식으로 시작하면 ' 를 붙인다 */
export function csvCell(v) {
  let t = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export const CSV_HEAD = ["프로젝트", "패턴코드", "패턴명", "컬러코드", "컬러명", "상태", "작업일", "Rev",
  "동판(도수별)", "배합수", "태그", "비고"];

/**
 * 표 행 만들기. vidsOf(pid) 는 "지금 걸린 컬러 id 배열" — 담기와 같은 범위를 쓴다.
 * vName 은 컬러 표시 이름(코드 or 이름)을 만드는 함수(core.js 의 vName)를 넘긴다.
 */
export function csvRows(patterns, vidsOf, vName, workOf) {
  // workOf 를 넘기면 작업정보 4열이 뒤에 붙는다(컬러별 유효값). 안 넘기면 예전과 완전히 같다.
  const head = workOf ? CSV_HEAD.concat(["작업장소", "작업자", "설비", "수량"]) : CSV_HEAD.slice();
  const rows = [head];
  (patterns || []).forEach((p) => {
    const hit = new Set((vidsOf ? vidsOf(p.id) : null) || (p.variations || []).map((v) => v.id));
    (p.variations || []).forEach((v) => {
      if (!hit.has(v.id)) return;
      const plates = Object.entries(v.layerPlates || {}).map(([k, x]) => `${k}=${x}`).join(" / ")
        || (p.work.plate || []).join(" / ");
      const base = [
        p.project, p.pattern.code, [p.pattern.name, p.pattern.nameKo].filter(Boolean).join(" "),
        v.colorCode, vName ? vName(v) : (v.colorName || v.colorCode), v.status, v.date, v.rev,
        plates, (v.mixes || []).length, (p.pattern.tags || []).join(", "), v.note,
      ];
      if (workOf) {
        const w = workOf(p, v) || {};
        base.push(w.place || "", w.worker || "", w.machine || "", w.volume || "");
      }
      rows.push(base);
    });
  });
  return rows;
}

/** CSV 본문 — 엑셀이 한글을 바로 읽도록 BOM + CRLF */
export function csvText(rows) {
  return "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
