/* RDP 시편 아카이브 — 시편 나란히 비교 (#/compare)
 *
 * 컬러 2~4개를 열로 놓고 사진·라벨·작업·동판·배합을 행으로 맞춘다. 다른 칸은 색으로 표시하고
 * '다른 칸만'으로 같은 행을 숨길 수 있다. 인쇄는 가로 A4.
 * 담는 곳: 상세 [비교 +] · 목차 선택 바 [나란히 비교]. 목록은 이 브라우저(localStorage)에만 둔다.
 *
 * 되돌리기: main.js 의 #/compare, 상세·목차 버튼, 이 파일과 compare-rules.js 를 지우면 된다.
 */
import { $, $$, App, byId, esc, imgUrl, thumbUrl, toast, vName } from "./core.js";
import { compareRows, toggleCompare, COMPARE_MAX } from "./compare-rules.js";
import { workOf } from "./work.js";
import { inkOrder } from "./detail.js";

const LS = "rdp2-compare";
let onlyDiff = false;

export function compareList() {
  try { const x = JSON.parse(localStorage.getItem(LS)); return Array.isArray(x) ? x : []; } catch (e) { return []; }
}
export function saveCompare(list) {
  try { localStorage.setItem(LS, JSON.stringify(list.slice(0, COMPARE_MAX))); } catch (e) {}
}
export const inCompare = (pid, vid) => compareList().some((x) => x.pid === pid && x.vid === vid);

/** 상세 [비교 +] — 넣거나 빼고 안내한다. 바뀐 목록 길이를 돌려준다 */
export function toggleCompareItem(pid, vid) {
  const r = toggleCompare(compareList(), pid, vid);
  if (r.full) { toast(`비교는 ${COMPARE_MAX}개까지예요 — 비교 화면에서 하나를 빼 주세요`, 3500); return r.list.length; }
  saveCompare(r.list);
  toast(r.added ? `비교에 담았어요 (${r.list.length}/${COMPARE_MAX})` : "비교에서 뺐어요");
  return r.list.length;
}

function resolve() {
  return compareList().map(({ pid, vid }) => {
    const p = byId(pid);
    const v = p && (p.variations || []).find((x) => x.id === vid);
    return p && v ? { p, v } : null;
  }).filter(Boolean);
}

export function renderCompare() {
  document.body.classList.remove("prop-mode");
  document.body.classList.add("compare-mode");
  const items = resolve();
  if (items.length !== compareList().length) saveCompare(items.map(({ p, v }) => ({ pid: p.id, vid: v.id })));   // 지워진 시편 정리
  if (!items.length) {
    $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><h2>비교할 컬러가 없습니다</h2>
      <p>시편 상세의 <b>[비교 +]</b> 또는 목차에서 카드를 체크한 뒤 선택 바의 <b>[나란히 비교]</b>로 담으세요 (최대 ${COMPARE_MAX}개).</p>
      <button class="btn-line" id="cmp-back">← 목차</button></div></div>`;
    $("#cmp-back").onclick = () => (location.hash = "");
    return;
  }
  const rows = compareRows(items, { workOf, inkOrder, vName });
  const diffN = rows.filter((r) => r.differ).length;
  let group = "";
  const body = rows.filter((r) => !onlyDiff || r.differ).map((r) => {
    const head = r.group !== group ? `<tr class="cmp-group"><th colspan="${items.length + 1}">${esc(r.group)}</th></tr>` : "";
    group = r.group;
    return `${head}<tr class="${r.differ ? "cmp-diff" : ""}"><th>${esc(r.label)}</th>${r.values.map((x) => `<td>${esc(x) || "—"}</td>`).join("")}</tr>`;
  }).join("");
  $("#view").innerHTML = `<div class="wrap compare-page">
      <div class="cmp-tools noprint">
        <button class="btn-line" id="cmp-back">← 목차</button>
        <h1>나란히 비교 <small>${items.length}개 컬러 · 다른 항목 ${diffN}개</small></h1>
        <label class="chk-inline"><input type="checkbox" id="cmp-diff"${onlyDiff ? " checked" : ""}> 다른 칸만</label>
        <button class="btn-line" id="cmp-clear">비우기</button>
        <button class="btn-dark" id="cmp-print">인쇄 / PDF</button>
      </div>
      <h1 class="cmp-print-title">시편 비교 — ${esc(items.map(({ p, v }) => `${p.pattern.code} ${vName(v)}`).join(" / "))}</h1>
      <div class="tbl-wrap"><table class="cmp-table">
        <tr class="cmp-photo"><th></th>${items.map(({ p, v }) => `<td>
            <a href="#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(v.id)}" title="상세 보기">${v.images && v.images[0]
              ? `<img src="${thumbUrl(p.id, v.images[0], 480)}" onerror="this.onerror=null;this.src='${imgUrl(p.id, v.images[0])}'" alt="${esc(p.pattern.code + " " + vName(v))}">`
              : `<span class="cmp-noimg">IMAGE N/A</span>`}</a>
            <div class="cmp-name"><b>${esc(p.pattern.code)}</b> ${esc(vName(v))}
              <button type="button" class="cmp-rm noprint" data-rm="${esc(p.id)}::${esc(v.id)}" aria-label="${esc(p.pattern.code + " " + vName(v))} 빼기">×</button></div>
          </td>`).join("")}</tr>
        ${body}
      </table></div>
    </div>`;
  $("#cmp-back").onclick = () => (location.hash = "");
  $("#cmp-print").onclick = () => window.print();
  $("#cmp-diff").onchange = (e) => { onlyDiff = e.target.checked; renderCompare(); };
  $("#cmp-clear").onclick = () => { saveCompare([]); renderCompare(); };
  $$("[data-rm]").forEach((b) => (b.onclick = () => {
    const [pid, vid] = b.dataset.rm.split("::");
    saveCompare(compareList().filter((x) => !(x.pid === pid && x.vid === vid)));
    renderCompare();
  }));
}

/** 목차 선택 바 [나란히 비교] — 고른 시편들의 '검색에 걸린 컬러'를 화면 순서대로 최대 4개 */
export function compareFromSelection(orderedPids, hitsOf) {
  const list = [];
  orderedPids.filter((pid) => App.sel.has(pid)).forEach((pid) => {
    (hitsOf(pid) || []).forEach((vid) => { if (list.length < COMPARE_MAX) list.push({ pid, vid }); });
  });
  if (!list.length) { toast("비교할 컬러가 없습니다"); return; }
  const total = orderedPids.filter((pid) => App.sel.has(pid)).reduce((a, pid) => a + (hitsOf(pid) || []).length, 0);
  saveCompare(list);
  if (total > COMPARE_MAX) toast(`컬러가 ${total}개라 앞의 ${COMPARE_MAX}개만 비교합니다`, 3500);
  location.hash = "#/compare";
}
