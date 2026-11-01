/* RDP 시편 아카이브 — 목차 보기 방식: 카드 · 표 · 칸반 (+ 카드 크기 · 묶어 보기)
 *
 * 카드: 크기(작게 · 보통 · 크게)와 묶기를 고를 수 있다. 묶기는 카드의 첫 검색 컬러 기준.
 * 표: 한 줄 = 컬러. 머리 칸을 누르면 정렬(오름 → 내림 → 끔), '열 ▾'로 열 숨기기, 맨 앞 칸으로 제안서에 담기.
 *     고칠 수 있는 칸을 누르면 그 자리에서 고친다 — Enter 저장 후 아래 줄, Tab 다음 칸, Esc 취소.
 *     편집칸은 칸 위에 겹쳐 띄운다(열 너비가 바뀌면 옆 버튼을 누르려던 클릭이 빗나갔다).
 *     사람이 값을 바꿨을 때만 저장한다(Tab 으로 지나가기만 하면 그대로). 시편 공통값 칸은 흐리게 표시.
 *     저장은 saveMany(같은 시편 저장 줄 · rev 검사 · 이력). 규칙은 table-rules.js.
 * 칸반: 상태별 칸, 컬러 카드를 다른 칸으로 끌어다 놓거나 카드의 상태 칸에서 골라 바꾼다(터치·키보드).
 * 보기 설정은 이 브라우저(localStorage)에만 둔다.
 *
 * 되돌리기: catalog.js 의 viewSwitchHTML · bodyHTML · bindBody 호출과 이 파일을 지우면 카드만 남는다.
 */
import { $, $$, App, byId, esc, inCart, thumbUrl, toast, toggleCart, vName } from "./core.js";
import { renderCart } from "./proposal.js";
import {
  COLUMNS, COL, DEFAULT_HIDDEN, GROUPS, GROUP, tableRows, sortRows, applyCell, groupRows, kanbanColumns, isShared, suggestValues,
} from "./table-rules.js";
import { normDate } from "./csv-import.js";
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
const str = (x) => (x == null ? "" : String(x));

function cellHTML(c, p, v) {
  if (c.key === "rating") return `<td data-col="rating" class="c-rate">${rateHTML(p.id, v.id, true)}</td>`;
  const val = str(c.get(p, v));
  if (c.key === "code") return `<td data-col="code"><a href="#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(v.id)}">${esc(val)}</a></td>`;
  const long = val.length > 24 ? val : "";                   // 잘려 보이는 긴 값은 마우스를 올리면 전부
  if (!c.edit) return `<td data-col="${c.key}"${long ? ` title="${esc(long)}"` : ""}>${esc(val)}</td>`;
  const sh = isShared(c, p, v);
  const tip = [long, sh ? `시편 공통값 — 고치면 이 시편의 컬러 ${(p.variations || []).length}개에 모두 적용됩니다` : ""].filter(Boolean).join("\n");
  return `<td data-col="${c.key}" class="ed${sh ? " shared" : ""}" tabindex="0"${tip ? ` title="${esc(tip)}"` : ""}>${esc(val)}</td>`;
}

function cartBtnHTML(p, v) {
  const on = inCart(p.id, v.id);
  return `<button type="button" class="dt-cart${on ? " on" : ""}" data-cart="${esc(p.id)}::${esc(v.id)}" aria-pressed="${on}" title="제안서에 담기 / 빼기">${on ? "✓" : "+"}</button>`;
}

function rowHTML(p, v) {
  const img = v.images && v.images[0];
  return `<tr data-pid="${esc(p.id)}" data-vid="${esc(v.id)}">
      <td class="c-cart">${cartBtnHTML(p, v)}</td>
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
  const hint = m === "table" ? "칸을 눌러 고치기 · Enter 저장 · Tab 다음 칸 · Esc 취소 · 흐린 칸은 시편 공통값"
    : m === "kanban" ? "카드를 다른 칸으로 끌어다 놓거나, 카드 아래 상태를 골라 바꿉니다" : "";
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
  const body = groups.map((g) => (g.label ? `<tr class="grp-row"><th colspan="${cols.length + 2}">${esc(g.label)} <span>${g.rows.length}</span></th></tr>` : "")
    + g.rows.map((r) => rowHTML(r.p, r.v)).join("")).join("");
  return `${toolsHTML(rows.length, "줄")}
    <div class="tbl-wrap dt-wrap"><table class="dtable">
      <thead><tr><th class="c-cart" title="제안서에 담기">담기</th><th class="c-th"></th>${cols.map((c) => `<th data-sortkey="${c.key}" title="눌러서 정렬">${esc(c.label)}${arrow(c.key)}</th>`).join("")}</tr></thead>
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
function kcardHTML(p, v, names) {
  const img = v.images && v.images[0];
  const cur = str(v.status).trim();
  return `<div class="kcard" draggable="true" data-pid="${esc(p.id)}" data-vid="${esc(v.id)}">
      ${img ? `<img src="${thumbUrl(p.id, img, 240)}" alt="" loading="lazy" draggable="false">` : `<div class="kc-noimg"></div>`}
      <a class="kc-t" href="#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(v.id)}" draggable="false"><b>${esc(p.pattern.code)}</b> ${esc(vName(v))}</a>
      <div class="kc-m">${esc([p.project, v.date].filter(Boolean).join(" · "))}</div>
      <div class="kc-foot">${rateHTML(p.id, v.id, true)}
        <select class="kc-st" aria-label="${esc(p.pattern.code)} ${esc(vName(v))} 상태 바꾸기" title="상태 바꾸기">${names.map((n) =>
          `<option value="${esc(n)}"${n === cur ? " selected" : ""}>${esc(n || "상태 없음")}</option>`).join("")}</select></div>
    </div>`;
}
function kanbanHTML(list, hitsOf) {
  const rows = tableRows(list, hitsOf);
  const cols = kanbanColumns(rows, VIEW.kcols);
  const names = cols.map((c) => c.name);
  return `${toolsHTML(rows.length, "색")}
    <div class="kanban">${cols.map((c) => `<section class="kcol${c.name ? "" : " none"}" data-status="${esc(c.name)}">
        <h3>${esc(c.label)} <span>${c.rows.length}</span>${!c.rows.length && VIEW.kcols.includes(c.name)
          ? `<button type="button" class="kc-del" data-kcdel="${esc(c.name)}" title="직접 추가한 빈 칸 지우기" aria-label="${esc(c.name)} 칸 지우기">×</button>` : ""}</h3>
        <div class="kcol-body">${c.rows.map((r) => kcardHTML(r.p, r.v, names)).join("")}</div>
      </section>`).join("")}</div>`;
}

/** 목차 본문 — 지금 보기 방식대로 */
export function bodyHTML(list, hitsOf, cardHTML) {
  if (VIEW.mode === "table") return tableHTML(list, hitsOf);
  if (VIEW.mode === "kanban") return kanbanHTML(list, hitsOf);
  return cardsHTML(list, hitsOf, cardHTML);
}

/* ---------- 칸 편집 ---------- */
function flash(td) {
  td.classList.remove("saved");
  void td.offsetWidth;                         // 같은 칸을 연달아 고쳐도 다시 반짝이게
  td.classList.add("saved");
  setTimeout(() => td.classList.remove("saved"), 900);
}

/** 그 시편의 줄들을 화면 사본(App.patterns)대로 다시 적는다. 바뀐 칸은 반짝 — 공통값이면 다른 컬러 줄도 바뀐 게 보인다 */
function refreshPatternRows(root, pid) {
  const p = byId(pid);
  if (!p) return;
  $$(`tr[data-pid="${CSS.escape(pid)}"]`, root).forEach((tr) => {
    const v = (p.variations || []).find((x) => x.id === tr.dataset.vid);
    if (!v) return;
    tr.querySelectorAll("td[data-col]").forEach((td) => {
      const c = COL[td.dataset.col];
      if (!c || c.key === "rating" || c.key === "code" || td.classList.contains("editing")) return;
      const nv = str(c.get(p, v));
      if (td.textContent !== nv) { td.textContent = nv; flash(td); }
    });
  });
}

/** 입력 도우미 목록(datalist) — 그 칸에 이미 쓰인 값 */
function datalistFor(root, key) {
  const vals = suggestValues(App.patterns, key);
  if (!vals.length) return "";
  const id = "dt-dl-" + key;
  let dl = document.getElementById(id);
  if (!dl) { dl = document.createElement("datalist"); dl.id = id; root.appendChild(dl); }
  dl.innerHTML = vals.map((x) => `<option value="${esc(x)}"></option>`).join("");
  return id;
}

function editCell(td, root, move) {
  if (td.classList.contains("editing")) return;
  const tr = td.closest("tr");
  const pid = tr.dataset.pid, vid = tr.dataset.vid, key = td.dataset.col;
  const c = COL[key];
  const p = byId(pid), v = p && (p.variations || []).find((x) => x.id === vid);
  if (!c || !c.edit || !v) return;
  // 날짜 칸: 예전에 '2026.8.8'처럼 적은 값도 날짜 입력기에 보이게 바꿔 넣는다(못 읽으면 빈칸이지만, 안 고치면 저장하지 않는다)
  const initial = c.type === "date" ? (normDate(str(c.get(p, v))) || "") : str(c.get(p, v));
  const inp = document.createElement("input");
  inp.className = "dt-in";
  inp.type = c.type === "date" ? "date" : "text";
  inp.value = initial;
  const dl = c.type === "date" ? "" : datalistFor(root, key);
  if (dl) inp.setAttribute("list", dl);
  td.classList.add("editing");
  td.appendChild(inp);
  inp.focus();
  if (inp.type === "text") inp.select();
  let done = false;
  /* next: "down" | "right" | "left" → 그 칸으로 이어서 편집, null → 이 칸에 포커스(Esc), undefined → 그대로(다른 곳을 누름) */
  const finish = (save, next) => {
    if (done) return;
    done = true;
    const val = inp.value;
    inp.remove();
    td.classList.remove("editing");
    // 사람이 바꾼 경우에만 저장 — 보여 준 값 그대로면 Tab·Enter 로 지나가도 아무것도 바꾸지 않는다
    if (save && val.trim() !== initial.trim()) {
      td.textContent = val;
      td.classList.add("saving");
      // 기다리지 않고 다음 칸으로 넘어간다 — 같은 시편의 다음 저장은 저장 줄에서 이 저장 뒤에 선다
      saveMany([{ pid, label: `${p.pattern.code} ${vName(v)}`, mutate: (d) => applyCell(d, vid, key, val) }]).then((res) => {
        td.classList.remove("saving");
        refreshPatternRows(root, pid);          // 실패면 화면 사본(409 면 서버 최신본) 값으로 돌아간다
        if (res.fails.length) toast("저장 실패: " + res.fails[0].msg, 4000);
        else flash(td);
      });
    } else {
      // 안 고쳤으면 화면 사본 값으로 다시 적는다 — 편집하는 동안 같은 시편의 다른 칸 저장(공통값)이 끝났을 수 있다
      const cp = byId(pid), cv = cp && (cp.variations || []).find((x) => x.id === vid);
      if (cv) td.textContent = str(c.get(cp, cv));
    }
    if (next === null) td.focus();
    else if (next && !move(td, next)) td.focus();   // 마지막 줄에서 Enter: 포커스를 잃지 않게
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();                       // 칸(td)·문서의 키 처리로 올라가지 않게 (Enter 재편집 · Esc 목차 나가기)
    // Enter 는 기본 동작을 막지 않는다(표는 form 밖이라 할 일이 없다) — 입력 도우미 목록에서 고른 값이 먼저 들어온 뒤 저장
    if (e.key === "Enter") setTimeout(() => finish(true, "down"), 0);
    else if (e.key === "Tab") { e.preventDefault(); finish(true, e.shiftKey ? "left" : "right"); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false, null); }
  };
  inp.onblur = () => finish(true);
}

/** 표 이벤트 — rerender 는 정렬·열 바꿈 뒤 다시 그리기 */
function bindTable(root, rerender) {
  /** dir 쪽 다음 편집 칸을 연다. 없으면 false */
  const move = (td, dir) => {
    const tr = td.closest("tr");
    let target = null;
    if (dir === "down" || dir === "up") {
      let row = dir === "down" ? tr.nextElementSibling : tr.previousElementSibling;
      while (row && !row.querySelector(`td.ed[data-col="${td.dataset.col}"]`)) row = dir === "down" ? row.nextElementSibling : row.previousElementSibling;
      target = row && row.querySelector(`td.ed[data-col="${td.dataset.col}"]`);
    } else {
      const eds = $$("td.ed", root);
      const i = eds.indexOf(td);
      target = eds[i + (dir === "right" ? 1 : -1)];
    }
    if (!target) return false;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    editCell(target, root, move);
    return true;
  };
  $$("td.ed", root).forEach((td) => {
    td.onclick = () => editCell(td, root, move);
    td.onkeydown = (e) => { if (e.target !== td) return; if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); editCell(td, root, move); } };
  });
  $$("[data-cart]", root).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const [pid, vid] = b.dataset.cart.split("::");
    toggleCart(pid, vid);
    renderCart();
    const on = inCart(pid, vid);
    b.classList.toggle("on", on);
    b.textContent = on ? "✓" : "+";
    b.setAttribute("aria-pressed", String(on));
  }));
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

/* ---------- 칸반 ---------- */
async function setStatus(pid, vid, to, root, rerender) {
  const p = byId(pid), v = p && (p.variations || []).find((x) => x.id === vid);
  if (!v || str(v.status).trim() === to) return;
  const card = $(`.kcard[data-pid="${CSS.escape(pid)}"][data-vid="${CSS.escape(vid)}"]`, root);
  const col = $(`.kcol[data-status="${CSS.escape(to)}"] .kcol-body`, root);
  if (card) { card.classList.add("saving"); if (col) col.appendChild(card); }
  const res = await saveMany([{ pid, label: `${p.pattern.code} ${vName(v)}`, mutate: (d) => applyCell(d, vid, "status", to) }]);
  if (res.fails.length) toast("상태를 바꾸지 못했습니다: " + res.fails[0].msg, 4000);
  else toast(`${p.pattern.code} ${vName(v)} → ${to || "상태 없음"}`);
  rerender();
}

function bindKanban(root, rerender) {
  let drag = null;
  $$(".kcard", root).forEach((c) => {
    c.ondragstart = (e) => {
      if (e.target.closest && e.target.closest("select, button")) { e.preventDefault(); return; }
      drag = { pid: c.dataset.pid, vid: c.dataset.vid };
      c.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", drag.pid + "::" + drag.vid);
    };
    c.ondragend = () => { c.classList.remove("dragging"); $$(".kcol.over", root).forEach((x) => x.classList.remove("over")); };
    const sel = c.querySelector(".kc-st");
    if (sel) {
      sel.onclick = (e) => e.stopPropagation();
      sel.onchange = () => setStatus(c.dataset.pid, c.dataset.vid, sel.value, root, rerender);
    }
  });
  $$(".kcol", root).forEach((col) => {
    col.ondragover = (e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("over"); };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); };
    col.ondrop = (e) => {
      e.preventDefault();
      col.classList.remove("over");
      if (!drag) return;
      const { pid, vid } = drag;
      drag = null;
      setStatus(pid, vid, col.dataset.status, root, rerender);
    };
  });
  $$("[data-kcdel]", root).forEach((b) => (b.onclick = () => {
    VIEW.kcols = VIEW.kcols.filter((x) => x !== b.dataset.kcdel);
    keep(LS.kcols, VIEW.kcols);
    rerender();
  }));
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
