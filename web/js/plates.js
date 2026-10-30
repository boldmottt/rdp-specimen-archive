/* RDP 시편 아카이브 — 동판 정보 팝오버 */
import { $, $$, App, apiGet, byId, esc, fmtDate } from "./core.js";

/* ---------------- plate popover ---------------- */
const plateCache = new Map();
export async function showPlate(lot, anchor) {
  const pop = $("#plate-pop");
  if (!pop) return;
  if (pop.dataset.lot === lot && pop.classList.contains("on")) { pop.classList.remove("on"); return; }
  const r = anchor.getBoundingClientRect();
  pop.dataset.lot = lot;
  pop.innerHTML = '<div class="pp-load">불러오는 중…</div>';
  pop.style.left = Math.max(12, Math.min(window.innerWidth - 320, r.left)) + "px";
  pop.style.top = "0px";
  pop.classList.add("on");
  const ph = pop.offsetHeight || 200;
  const below = r.bottom + 8;
  const top = below + ph > window.innerHeight - 12 ? Math.max(12, r.top - ph - 8) : below;
  pop.style.top = top + "px";
  let info = plateCache.get(lot);
  if (!info) {
    try { info = await apiGet(`/api/plate/${encodeURIComponent(lot)}`); plateCache.set(lot, info); }
    catch (e) { info = null; }
  }
  if (!info || info.ok === false) { pop.innerHTML = '<div class="pp-load">동판 정보가 없습니다</div>'; return; }
  const curPid = decodeURIComponent((location.hash.match(/#\/p\/([^/]+)/) || [])[1] || "");
  const rowsMap = new Map();
  (info.usedBy || []).forEach((u) => rowsMap.set(u.id + "|" + (u.layer || ""), { id: u.id, project: u.project, code: u.code, layer: u.layer || "" }));
  App.patterns.forEach((pp) => (pp.variations || []).forEach((vv) => {
    const lp = vv.layerPlates || {};
    Object.keys(lp).forEach((l) => {
      if (lp[l] === lot) rowsMap.set(pp.id + "|" + l, { id: pp.id, project: pp.project, code: pp.pattern.code, layer: l });
    });
  }));
  const rowsArr = Array.from(rowsMap.values()).sort((a, b) => (a.code + a.layer).localeCompare(b.code + b.layer));
  const used = rowsArr.map((u) => {
    const p2 = byId(u.id);
    const vid = p2 && p2.variations && p2.variations[0] ? p2.variations[0].id : "";
    const href = `#/p/${encodeURIComponent(u.id)}${vid ? "/" + encodeURIComponent(vid) : ""}`;
    const here = curPid === u.id;
    return `<li${here ? ' class="here"' : ""}><a href="${href}" data-goto="1">${esc(u.project)} ${esc(u.code)}</a><span>${esc(u.layer)}${here ? " · 현재" : ""}</span></li>`;
  }).join("");
  pop.innerHTML = `<div class="pp-title">${esc(info.lot)}</div>
      <div class="pp-meta">${esc([info.type, info.size].filter(Boolean).join(" · ") || "—")}</div>
      ${info.note ? `<div class="pp-note">${esc(info.note)}</div>` : ""}
      ${info.created ? `<div class="pp-date">${esc(fmtDate(info.created))}</div>` : ""}
      ${used ? `<div class="pp-sub">이 동판에 들어간 패턴</div><ul>${used}</ul>` : ""}
      ${location.hash === "#/plates" ? "" : `<a class="pp-all" href="#/plates" data-goto="1">동판 대장 전체 보기 →</a>`}`;
  $$("[data-goto]", pop).forEach((a) => (a.onclick = () => pop.classList.remove("on")));
}

document.addEventListener("click", (e) => {
  const pop = $("#plate-pop");
  if (!pop || !pop.classList.contains("on")) return;
  if (pop.contains(e.target) || e.target.closest("[data-plate]")) return;
  pop.classList.remove("on");
});
