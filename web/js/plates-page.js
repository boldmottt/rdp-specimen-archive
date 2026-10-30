/* RDP 시편 아카이브 — 동판 대장 (#/plates)
 *
 * rdp.db 동판 표 · 아카이브 시편이 쓰는 동판 · 작업일지 활동을 동판 번호 하나로 모아 본다(읽기 전용).
 * 규칙은 plate-rules.js. 동판 번호를 누르면 기존 동판 팝오버(plates.js)를 연다.
 *
 * 되돌리기: main.js 의 #/plates 라우트, 목차 ⋯ 메뉴의 '동판 대장', 이 파일과 plate-rules.js 를 지우면 된다.
 */
import { $, $$, App, apiGet, esc, fmtDate, vName } from "./core.js";
import { mergePlates, plateMatches } from "./plate-rules.js";
import { showPlate } from "./plates.js";

let state = { q: "", onlyUsed: false };

const vHref = (pid) => {
  const p = App.patterns.find((x) => x.id === pid);
  const v = p && p.variations && p.variations[0];
  return `#/p/${encodeURIComponent(pid)}${v ? "/" + encodeURIComponent(v.id) : ""}`;
};

function rowHTML(r) {
  const db = r.db;
  const arch = r.archive.map((a) => `<a class="pl-pat" href="${vHref(a.pid)}">${esc(a.project)} ${esc(a.code)}${a.layers.length ? `<small>${esc(a.layers.join("·"))}</small>` : ""}</a>`).join("");
  const dbPats = db && db.usedBy && db.usedBy.length ? db.usedBy.map((u) => `${u.project} ${u.code}${u.layer ? " " + u.layer : ""}`).join(", ") : "";
  const wl = r.worklog ? `${fmtDate(r.worklog.last)}<small>${r.worklog.days}일 작업</small>` : "—";
  return `<tr>
      <td>${db ? `<button type="button" class="pl-lot" data-plate="${esc(r.lot)}" title="rdp.db 동판 정보">${esc(r.lot)}</button>` : `<b class="pl-lot-txt">${esc(r.lot)}</b>`}
        ${r.flags.notInDb ? `<span class="pl-flag" title="아카이브 시편은 이 동판을 쓰는데 rdp.db 동판 표에 없습니다">DB 미등록</span>` : ""}</td>
      <td>${db ? esc([db.type, db.size].filter(Boolean).join(" · ") || "—") : "—"}${db && db.created ? `<small>${esc(fmtDate(db.created))}</small>` : ""}</td>
      <td><div class="pl-arch">${arch || `<span class="pl-none">아카이브 시편 없음</span>`}</div></td>
      <td class="pl-dbpats">${esc(dbPats) || "—"}</td>
      <td>${wl}</td>
      <td class="note">${db && db.note ? esc(db.note) : ""}</td>
    </tr>`;
}

function paint(rows, meta) {
  const body = $("#pl-body");
  if (!body) return;
  const list = rows.filter((r) => (!state.onlyUsed || r.archive.length) && plateMatches(r, state.q));
  body.innerHTML = list.length
    ? `<div class="tbl-wrap"><table class="mix pl-table">
        <tr><th>동판</th><th>종류·규격 (DB)</th><th>아카이브 시편</th><th>DB 등록 패턴</th><th>작업일지</th><th>메모</th></tr>
        ${list.map(rowHTML).join("")}</table></div>`
    : `<div class="empty-state"><h2>조건에 맞는 동판이 없습니다</h2></div>`;
  $("#pl-n").textContent = `${list.length} / ${rows.length}개`;
  $$("[data-plate]", body).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); showPlate(b.dataset.plate, b); }));
  const warn = $("#pl-warn");
  if (warn) warn.textContent = meta.join(" · ");
}

export async function renderPlates() {
  document.body.classList.remove("prop-mode");
  const want = location.hash;
  $("#view").innerHTML = `<div class="wrap plates-page">
      <div class="pl-head"><h1>동판 대장</h1>
        <span class="pl-sub">rdp.db 동판 · 아카이브 시편이 쓰는 동판 · 작업일지 활동을 한 줄로</span></div>
      <div class="pl-tools">
        <input id="pl-q" class="pl-q" placeholder="동판 번호 · 종류 · 패턴 코드 · 컬러" value="${esc(state.q)}">
        <label class="chk-inline"><input type="checkbox" id="pl-used"${state.onlyUsed ? " checked" : ""}> 아카이브에서 쓰는 것만</label>
        <span id="pl-n" class="pl-n"></span>
      </div>
      <p class="pl-warn" id="pl-warn"></p>
      <div id="pl-body"><p class="pl-none">불러오는 중…</p></div>
    </div>`;
  const [db, wl] = await Promise.all([
    apiGet("/api/plates").catch((e) => ({ plates: [], dbError: e.message })),
    apiGet("/api/pccs/plates").catch(() => null),
  ]);
  if (location.hash !== want) return;                      // 기다리는 사이 다른 화면으로 갔다
  const rows = mergePlates(db.plates || [], App.patterns, (wl && wl.plates) || [], vName);
  const meta = [];
  if (db.dbError) meta.push(db.dbError);
  if (!wl) meta.push("작업일지를 읽지 못해 작업일지 칸은 비어 있습니다");
  const redraw = () => paint(rows, meta);
  $("#pl-q").oninput = (e) => { state.q = e.target.value; redraw(); };
  $("#pl-used").onchange = (e) => { state.onlyUsed = e.target.checked; redraw(); };
  redraw();
}
