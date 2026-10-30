/* RDP 시편 아카이브 — 상세 화면의 '작업일지(PCCS3)' 칸
 *
 * 작업일지 폴더(config.worklogDir)에서 이 시편과 관련된 작업을 찾아 보여 준다(읽기 전용).
 *   · 이 패턴: 동판 도수의 패턴 코드가 이 시편 코드와 같은 작업(대소문자·기호·숫자 앞 0 무시)
 *   · 같은 동판: 코드는 다르지만 이 시편이 쓰는 동판으로 한 작업(2패턴 동판의 다른 패턴일 수 있다)
 * 일지 폴더가 없거나 PyYAML 이 없으면 칸을 숨긴다. 미팅 모드에서는 CSS(.sec-hist)가 숨긴다.
 *
 * 되돌리기: detail.js 의 #wl-sec 자리와 loadWorklogs 호출, 이 파일을 지우면 된다.
 */
import { $, apiGet, esc, fmtDate } from "./core.js";

const cache = new Map();          // 같은 시편을 다시 그릴 때(인라인 저장 등) 다시 묻지 않게 — 1분
const TTL = 60000;

/** 이 시편의 코드 후보와 동판 */
export function worklogKeys(p) {
  const code = (p.pattern || {}).code || "";
  const codes = new Set([code, p.project && code ? `${p.project}-${code}` : "", p.id]);
  const lots = new Set((p.work || {}).plate || []);
  (p.variations || []).forEach((v) => {
    Object.values(v.layerPatterns || {}).forEach((c) => { codes.add(c); if (p.project) codes.add(`${p.project}-${c}`); });
    Object.values(v.layerPlates || {}).forEach((x) => lots.add(x));
    (v.mixes || []).forEach((m) => { if (m && m.plate) lots.add(m.plate); });
  });
  return { codes: [...codes].filter(Boolean), lots: [...lots].filter(Boolean) };
}

function entryHTML(e) {
  const layers = Object.entries(e.layers || {}).map(([k, c]) => `${k} ${c}`).join(" · ");
  const batches = (e.batches || []).map((b) => `${b.layer ? b.layer + " " : ""}${b.code}`).join(", ");
  const smp = e.samples && e.samples.n ? `시편 ${e.samples.n}종 ${e.samples.qty}장${e.samples.evals.length ? " · " + e.samples.evals.join("/") : ""}` : "";
  const who = [e.place, e.worker].filter(Boolean).join(" · ");
  const meta = [e.stage, e.status].filter(Boolean).join(" · ");
  return `<li><span class="d">${esc(fmtDate(e.date))}</span><div>
      <div>${esc(e.title || e.file)}${meta ? ` <span class="wl-meta">${esc(meta)}</span>` : ""}</div>
      <div class="wl-sub">동판 ${esc(e.lot)}${layers ? ` (${esc(layers)})` : ""}${batches ? ` · 배치 ${esc(batches)}` : ""}${smp ? ` · ${esc(smp)}` : ""}${who ? ` · ${esc(who)}` : ""}</div>
      <a class="wl-open" href="/pccs/#/file/${encodeURIComponent(e.file)}" target="_blank" rel="noopener">일지 열기 ↗</a>
    </div></li>`;
}

/** 상세 화면이 그려진 뒤 부른다. pid 가 바뀌었으면(그사이 다른 시편으로 이동) 그리지 않는다. */
export async function loadWorklogs(p) {
  const sec = $("#wl-sec");
  if (!sec) return;
  const { codes, lots } = worklogKeys(p);
  if (!codes.length && !lots.length) return;
  const qs = codes.map((c) => "code=" + encodeURIComponent(c)).concat(lots.map((l) => "lot=" + encodeURIComponent(l))).join("&");
  let entries;
  const hit = cache.get(qs);
  if (hit && Date.now() - hit.t < TTL) entries = hit.entries;
  else {
    try { entries = (await apiGet("/api/pccs/related?" + qs)).entries || []; }
    catch (e) { return; }            // 일지 폴더 없음·PyYAML 없음 → 칸을 숨긴 채로 둔다
    cache.set(qs, { t: Date.now(), entries });
  }
  const now = $("#wl-sec");
  if (!now || now.dataset.pid !== p.id || !entries.length) return;
  const mine = entries.filter((e) => e.match === "code");
  const plate = entries.filter((e) => e.match !== "code");
  now.innerHTML = `<h3>작업일지 <span class="cnt">PCCS3 · ${mine.length}건${plate.length ? ` + 같은 동판 ${plate.length}건` : ""}</span></h3>
    ${mine.length ? `<ul class="timeline">${mine.map(entryHTML).join("")}</ul>` : `<p class="wl-none">이 패턴 코드로 적힌 작업은 없습니다.</p>`}
    ${plate.length ? `<details class="wl-plate"><summary>같은 동판으로 한 다른 작업 ${plate.length}건 <small>(2패턴 동판의 다른 패턴일 수 있어요)</small></summary>
      <ul class="timeline">${plate.map(entryHTML).join("")}</ul></details>` : ""}`;
  now.hidden = false;
}
