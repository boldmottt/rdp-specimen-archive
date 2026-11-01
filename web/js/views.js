/* RDP 시편 아카이브 — 목차 보기 방식: 카드 · 표 (+ 밀도 · 묶어 보기 · 칸반은 같은 파일)
 *
 * 표: 한 줄 = 컬러. 머리 칸을 누르면 정렬(오름 → 내림 → 끔), '열 ▾'로 열 숨기기.
 *     고칠 수 있는 칸을 누르면 그 자리에서 고친다 — Enter 저장 후 아래 줄, Tab 다음 칸, Esc 취소.
 *     저장은 saveMany(평소 PUT · rev 검사 · 이력). 규칙은 table-rules.js.
 * 보기 설정은 이 브라우저(localStorage)에만 둔다.
 *
 * 되돌리기: catalog.js 의 보기 전환 버튼·renderBody/bindBody 호출과 이 파일을 지우면 카드만 남는다.
 */
import { $, $$, byId, esc, thumbUrl, toast, vName } from "./core.js";
import { COLUMNS, COL, DEFAULT_HIDDEN, tableRows, sortRows, applyCell } from "./table-rules.js";
import { saveMany } from "./save-many.js";
import { bindRate, rateHTML } from "./rating.js";

const LS = { view: "rdp.view", sort: "rdp.tableSort", hidden: "rdp.tableHidden" };
const load = (k, d) => { try { const x = JSON.parse(localStorage.getItem(k)); return x == null ? d : x; } catch (e) { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

export const VIEW = {
  mode: load(LS.view, "card"),                  // "card" | "table" (| "kanban" 은 D8)
  sort: load(LS.sort, null),                    // {key, dir} | null
  hidden: new Set(load(LS.hidden, DEFAULT_HIDDEN)),
};
export function setView(mode) { VIEW.mode = mode; keep(LS.view, mode); }

/** 결과 줄의 보기 전환 버튼 */
export function viewSwitchHTML() {
  return `<div class="seg viewseg" role="radiogroup" aria-label="보기">
    ${[["card", "카드"], ["table", "표"]].map(([m, l]) => `<label class="segbtn${VIEW.mode === m ? " on" : ""}">
      <input type="radio" name="viewmode" value="${m}"${VIEW.mode === m ? " checked" : ""}>${l}</label>`).join("")}</div>`;
}

const visibleCols = () => COLUMNS.filter((c) => !VIEW.hidden.has(c.key));

function cellHTML(c, p, v) {
  if (c.key === "rating") return `<td data-col="rating" class="c-rate">${rateHTML(p.id, v.id, true)}</td>`;
  const val = c.get(p, v);
  if (c.key === "code") return `<td data-col="code"><a href="#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(v.id)}">${esc(val)}</a></td>`;
  return `<td data-col="${c.key}"${c.edit ? ' class="ed" tabindex="0"' : ""}>${esc(val)}</td>`;
}

function rowHTML(p, v) {
  const img = v.images && v.images[0];
  return `<tr data-pid="${esc(p.id)}" data-vid="${esc(v.id)}">
      <td class="c-th">${img ? `<img src="${thumbUrl(p.id, img, 120)}" alt="" loading="lazy">` : ""}</td>
      ${visibleCols().map((c) => cellHTML(c, p, v)).join("")}</tr>`;
}

/** 표 HTML. groups 가 있으면 묶음 머리 줄을 넣는다(D8) */
export function tableHTML(list, hitsOf) {
  let rows = tableRows(list, hitsOf);
  if (VIEW.sort && COL[VIEW.sort.key]) rows = sortRows(rows, VIEW.sort.key, VIEW.sort.dir);
  const cols = visibleCols();
  const arrow = (k) => (VIEW.sort && VIEW.sort.key === k ? (VIEW.sort.dir === "desc" ? " ↓" : " ↑") : "");
  return `<div class="dt-tools">
      <span class="dt-n">${rows.length}줄</span>
      <div class="more"><button type="button" class="tool" id="dt-colsbtn" aria-haspopup="true">열 ▾</button>
        <div class="menu dt-cols" id="dt-cols" hidden>${COLUMNS.map((c) => `<label><input type="checkbox" data-colvis="${c.key}"${VIEW.hidden.has(c.key) ? "" : " checked"}> ${esc(c.label)}</label>`).join("")}</div></div>
      <span class="dt-hint">칸을 눌러 고치기 · Enter 저장 · Tab 다음 칸 · Esc 취소</span>
    </div>
    <div class="tbl-wrap dt-wrap"><table class="dtable">
      <thead><tr><th class="c-th"></th>${cols.map((c) => `<th data-sortkey="${c.key}" title="눌러서 정렬">${esc(c.label)}${arrow(c.key)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => rowHTML(r.p, r.v)).join("")}</tbody>
    </table></div>`;
}

/* ---------- 칸 편집 ---------- */
function refreshPatternRows(root, pid) {
  const p = byId(pid);
  if (!p) return;
  $$(`tr[data-pid="${CSS.escape(pid)}"]`, root).forEach((tr) => {
    const v = (p.variations || []).find((x) => x.id === tr.dataset.vid);
    if (!v) return;
    tr.querySelectorAll("td[data-col]").forEach((td) => {
      const c = COL[td.dataset.col];
      if (c && c.key !== "rating" && c.key !== "code" && !td.querySelector("input")) td.textContent = c.get(p, v);
    });
  });
}

function editCell(td, root, move) {
  if (td.querySelector("input")) return;
  const tr = td.closest("tr");
  const pid = tr.dataset.pid, vid = tr.dataset.vid, key = td.dataset.col;
  const c = COL[key];
  const p = byId(pid), v = p && (p.variations || []).find((x) => x.id === vid);
  if (!c || !c.edit || !v) return;
  const before = c.get(p, v) || "";
  const inp = document.createElement("input");
  inp.className = "dt-in";
  inp.type = c.type === "date" ? "date" : "text";
  inp.value = c.type === "date" ? String(before).replace(/\./g, "-").slice(0, 10) : before;
  td.textContent = "";
  td.appendChild(inp);
  inp.focus();
  if (inp.select && inp.type === "text") inp.select();
  let done = false;
  const finish = async (save, next) => {
    if (done) return;
    done = true;
    const val = inp.value;
    td.textContent = before;
    if (save && val.trim() !== String(before).trim()) {
      td.classList.add("saving");
      td.textContent = val;
      const res = await saveMany([{ pid, label: `${p.pattern.code} ${vName(v)}`, mutate: (d) => applyCell(d, vid, key, val) }]);
      td.classList.remove("saving");
      if (res.fails.length) { td.textContent = before; toast("저장 실패: " + res.fails[0].msg, 3500); }
      else { refreshPatternRows(root, pid); td.classList.add("saved"); setTimeout(() => td.classList.remove("saved"), 900); }
    }
    if (next) move(td, next);
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();                       // 칸(td)의 Enter 처리로 올라가 편집기가 다시 열리지 않게
    if (e.key === "Enter") { e.preventDefault(); finish(true, "down"); }
    else if (e.key === "Tab") { e.preventDefault(); finish(true, e.shiftKey ? "left" : "right"); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); td.focus(); }
  };
  inp.onblur = () => finish(true);
}

/** 표 이벤트 — rerender 는 정렬·열 바꿈 뒤 다시 그리기 */
export function bindTable(root, rerender) {
  const move = (td, dir) => {
    const tr = td.closest("tr");
    let target = null;
    if (dir === "down" || dir === "up") {
      let row = dir === "down" ? tr.nextElementSibling : tr.previousElementSibling;
      while (row && !row.querySelector(`td[data-col="${td.dataset.col}"]`)) row = dir === "down" ? row.nextElementSibling : row.previousElementSibling;
      target = row && row.querySelector(`td[data-col="${td.dataset.col}"]`);
    } else {
      const eds = $$("td.ed", root);
      const i = eds.indexOf(td);
      target = eds[i + (dir === "right" ? 1 : -1)];
    }
    if (target) editCell(target, root, move);
  };
  $$("td.ed", root).forEach((td) => {
    td.onclick = () => editCell(td, root, move);
    td.onkeydown = (e) => { if (e.target !== td) return; if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); editCell(td, root, move); } };
  });
  $$("th[data-sortkey]", root).forEach((th) => (th.onclick = () => {
    const k = th.dataset.sortkey;
    const cur = VIEW.sort && VIEW.sort.key === k ? VIEW.sort.dir : null;
    VIEW.sort = cur === null ? { key: k, dir: "asc" } : cur === "asc" ? { key: k, dir: "desc" } : null;
    keep(LS.sort, VIEW.sort);
    rerender();
  }));
  if (!document._dtColsBound) {                // 바깥을 누르면 열 메뉴가 닫힌다(한 번만 등록)
    document._dtColsBound = true;
    document.addEventListener("click", () => { const m = document.getElementById("dt-cols"); if (m) m.hidden = true; });
  }
  const cb = $("#dt-colsbtn"), menu = $("#dt-cols");
  if (cb && menu) {
    cb.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    menu.onclick = (e) => e.stopPropagation();
    $$("[data-colvis]", menu).forEach((x) => (x.onchange = () => {
      if (x.checked) VIEW.hidden.delete(x.dataset.colvis); else VIEW.hidden.add(x.dataset.colvis);
      keep(LS.hidden, [...VIEW.hidden]);
      rerender();
      const m = $("#dt-cols"); if (m) m.hidden = false;
    }));
  }
  bindRate(root);
}
