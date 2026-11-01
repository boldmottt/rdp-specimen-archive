/* RDP 시편 아카이브 — 목차 보기 방식: 카드 · 표 · 칸반 (+ 카드 크기 · 묶어 보기)
 *
 * 카드: 크기(작게 · 보통 · 크게)와 묶기를 고를 수 있다. 묶기는 카드의 첫 검색 컬러 기준.
 * 표: 한 줄 = 컬러. 머리 칸을 누르면 정렬(오름 → 내림 → 끔), '열 ▾'로 열 숨기기.
 *     고칠 수 있는 칸을 누르면 그 자리에서 고친다 — Enter 저장 후 아래 줄, Tab 다음 칸, Esc 취소.
 *     저장은 saveMany(평소 PUT · rev 검사 · 이력). 규칙은 table-rules.js.
 * 칸반: 상태별 칸, 컬러 카드를 다른 칸으로 끌어다 놓으면 상태가 바뀐다(평소 저장).
 * 보기 설정은 이 브라우저(localStorage)에만 둔다.
 *
 * 되돌리기: catalog.js 의 viewSwitchHTML · bodyHTML · bindBody 호출과 이 파일을 지우면 카드만 남는다.
 */
import { $, $$, byId, esc, thumbUrl, toast, vName } from "./core.js";
import { COLUMNS, COL, DEFAULT_HIDDEN, GROUPS, GROUP, tableRows, sortRows, applyCell, groupRows, kanbanColumns } from "./table-rules.js";
import { saveMany } from "./save-many.js";
import { rateHTML } from "./rating.js";

const LS = { view: "rdp.view", sort: "rdp.tableSort", hidden: "rdp.tableHidden", dens: "rdp.density", group: "rdp.groupBy", kcols: "rdp.kanbanCols" };
const load = (k, d) => { try { const x = JSON.parse(localStorage.getItem(k)); return x == null ? d : x; } catch (e) { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

export const VIEW = {
  mode: load(LS.view, "card"),                  // "card" | "table" | "kanban"
  sort: load(LS.sort, null),                    // {key, dir} | null
  hidden: new Set(load(LS.hidden, DEFAULT_HIDDEN)),
  dens: load(LS.dens, "m"),                     // "s" | "m" | "l" (카드 크기)
  group: load(LS.group, ""),                    // GROUPS 의 key | ""
  kcols: load(LS.kcols, []),                    // 칸반에 직접 추가한 칸
};
export function setView(mode) { VIEW.mode = mode; keep(LS.view, mode); }

/** 결과 줄의 보기 전환 버튼 */
export function viewSwitchHTML() {
  return `<div class="seg viewseg" role="radiogroup" aria-label="보기">
    ${[["card", "카드"], ["table", "표"], ["kanban", "칸반"]].map(([m, l]) => `<label class="segbtn${VIEW.mode === m ? " on" : ""}">
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

/* ---------- 보기 도구 줄 (모든 보기 공통) ---------- */
function toolsHTML(n, unit) {
  const m = VIEW.mode;
  const groupSel = m === "kanban" ? "" : `<label class="vt-group">묶기
      <select id="vt-group"><option value="">없음</option>${GROUPS.map((g) => `<option value="${g.key}"${VIEW.group === g.key ? " selected" : ""}>${esc(g.label)}</option>`).join("")}</select></label>`;
  const dens = m !== "card" ? "" : `<div class="seg vt-dens" role="radiogroup" aria-label="카드 크기">${[["s", "작게"], ["m", "보통"], ["l", "크게"]].map(([k, l]) =>
      `<label class="segbtn${VIEW.dens === k ? " on" : ""}"><input type="radio" name="vtdens" value="${k}"${VIEW.dens === k ? " checked" : ""}>${l}</label>`).join("")}</div>`;
  const cols = m !== "table" ? "" : `<div class="more"><button type="button" class="tool" id="dt-colsbtn" aria-haspopup="true">열 ▾</button>
        <div class="menu dt-cols" id="dt-cols" hidden>${COLUMNS.map((c) => `<label><input type="checkbox" data-colvis="${c.key}"${VIEW.hidden.has(c.key) ? "" : " checked"}> ${esc(c.label)}</label>`).join("")}</div></div>`;
  const hint = m === "table" ? "칸을 눌러 고치기 · Enter 저장 · Tab 다음 칸 · Esc 취소"
    : m === "kanban" ? "카드를 다른 칸으로 끌어다 놓으면 상태가 바뀝니다" : "";
  const addCol = m !== "kanban" ? "" : `<form id="kb-add" class="kb-add"><input id="kb-addname" placeholder="+ 상태 칸 추가" maxlength="20"></form>`;
  return `<div class="vt-tools"><span class="dt-n">${n}${unit}</span>${groupSel}${dens}${cols}${addCol}<span class="dt-hint">${hint}</span></div>`;
}

/* ---------- 표 ---------- */
export function tableHTML(list, hitsOf) {
  let rows = tableRows(list, hitsOf);
  if (VIEW.sort && COL[VIEW.sort.key]) rows = sortRows(rows, VIEW.sort.key, VIEW.sort.dir);
  const cols = visibleCols();
  const arrow = (k) => (VIEW.sort && VIEW.sort.key === k ? (VIEW.sort.dir === "desc" ? " ↓" : " ↑") : "");
  const groups = VIEW.group && GROUP[VIEW.group] ? groupRows(rows, VIEW.group) : [{ label: "", rows }];
  const body = groups.map((g) => (g.label ? `<tr class="grp-row"><th colspan="${cols.length + 1}">${esc(g.label)} <span>${g.rows.length}</span></th></tr>` : "")
    + g.rows.map((r) => rowHTML(r.p, r.v)).join("")).join("");
  return `${toolsHTML(rows.length, "줄")}
    <div class="tbl-wrap dt-wrap"><table class="dtable">
      <thead><tr><th class="c-th"></th>${cols.map((c) => `<th data-sortkey="${c.key}" title="눌러서 정렬">${esc(c.label)}${arrow(c.key)}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

/* ---------- 카드 (크기 · 묶기) ---------- */
function cardsHTML(list, hitsOf, cardHTML) {
  const grid = (ps) => `<div class="grid dens-${VIEW.dens}">${ps.map(cardHTML).join("")}</div>`;
  if (!VIEW.group || !GROUP[VIEW.group]) return toolsHTML(list.length, "장") + grid(list);
  // 패턴 하나 = 카드 하나 → 첫 검색 컬러로 묶는다
  const rows = list.map((p) => {
    const hits = hitsOf(p.id);
    const v = (p.variations || []).find((x) => !hits || hits.includes(x.id)) || (p.variations || [])[0] || {};
    return { p, v };
  });
  return toolsHTML(list.length, "장") + groupRows(rows, VIEW.group).map((g) =>
    `<section class="grp"><h3 class="grp-h">${esc(g.label)} <span>${g.rows.length}</span></h3>${grid(g.rows.map((r) => r.p))}</section>`).join("");
}

/* ---------- 칸반 (상태) ---------- */
function kcardHTML(p, v) {
  const img = v.images && v.images[0];
  return `<div class="kcard" draggable="true" data-pid="${esc(p.id)}" data-vid="${esc(v.id)}">
      ${img ? `<img src="${thumbUrl(p.id, img, 240)}" alt="" loading="lazy" draggable="false">` : `<div class="kc-noimg"></div>`}
      <a class="kc-t" href="#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(v.id)}" draggable="false"><b>${esc(p.pattern.code)}</b> ${esc(vName(v))}</a>
      <div class="kc-m">${esc([p.project, v.date].filter(Boolean).join(" · "))}</div>
      ${rateHTML(p.id, v.id, true)}
    </div>`;
}
function kanbanHTML(list, hitsOf) {
  const rows = tableRows(list, hitsOf);
  const cols = kanbanColumns(rows, VIEW.kcols);
  return `${toolsHTML(rows.length, "색")}
    <div class="kanban">${cols.map((c) => `<section class="kcol${c.name ? "" : " none"}" data-status="${esc(c.name)}">
        <h3>${esc(c.label)} <span>${c.rows.length}</span></h3>
        <div class="kcol-body">${c.rows.map((r) => kcardHTML(r.p, r.v)).join("")}</div>
      </section>`).join("")}</div>`;
}

/** 목차 본문 — 지금 보기 방식대로 */
export function bodyHTML(list, hitsOf, cardHTML) {
  if (VIEW.mode === "table") return tableHTML(list, hitsOf);
  if (VIEW.mode === "kanban") return kanbanHTML(list, hitsOf);
  return cardsHTML(list, hitsOf, cardHTML);
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
function bindTable(root, rerender) {
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
}

/* ---------- 칸반 끌어다 놓기 ---------- */
function bindKanban(root, rerender) {
  let drag = null;
  $$(".kcard", root).forEach((c) => {
    c.ondragstart = (e) => { drag = { pid: c.dataset.pid, vid: c.dataset.vid }; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", drag.pid + "::" + drag.vid); };
    c.ondragend = () => { c.classList.remove("dragging"); $$(".kcol.over", root).forEach((x) => x.classList.remove("over")); };
  });
  $$(".kcol", root).forEach((col) => {
    col.ondragover = (e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("over"); };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); };
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove("over");
      if (!drag) return;
      const { pid, vid } = drag;
      drag = null;
      const p = byId(pid), v = p && (p.variations || []).find((x) => x.id === vid);
      const to = col.dataset.status;
      if (!v || (v.status || "").trim() === to) return;
      const card = $(`.kcard[data-pid="${CSS.escape(pid)}"][data-vid="${CSS.escape(vid)}"]`, root);
      if (card) { card.classList.add("saving"); col.querySelector(".kcol-body").appendChild(card); }
      const res = await saveMany([{ pid, label: `${p.pattern.code} ${vName(v)}`, mutate: (d) => applyCell(d, vid, "status", to) }]);
      if (res.fails.length) toast("상태를 바꾸지 못했습니다: " + res.fails[0].msg, 3500);
      else toast(`${p.pattern.code} ${vName(v)} → ${to || "상태 없음"}`);
      rerender();
    };
  });
  const form = $("#kb-add", root);
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    const name = $("#kb-addname", root).value.trim();
    if (!name) return;
    if (!VIEW.kcols.includes(name)) { VIEW.kcols.push(name); keep(LS.kcols, VIEW.kcols); }
    rerender();
  };
}

/** 목차 본문 이벤트 — 보기 도구 줄 + 보기별 동작 */
export function bindBody(root, rerender) {
  const g = $("#vt-group", root);
  if (g) g.onchange = () => { VIEW.group = g.value; keep(LS.group, VIEW.group); rerender(); };
  $$('input[name="vtdens"]', root).forEach((r) => (r.onchange = () => { VIEW.dens = r.value; keep(LS.dens, VIEW.dens); rerender(); }));
  if (VIEW.mode === "table") bindTable(root, rerender);
  if (VIEW.mode === "kanban") bindKanban(root, rerender);
}
