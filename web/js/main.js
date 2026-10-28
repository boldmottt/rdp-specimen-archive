/* RDP 시편 아카이브 — 라우터 · 부팅 (진입점) */
import { $, $$, App, apiGet, esc, loadLS, toast } from "./core.js";
import { renderCatalog } from "./catalog.js";
import { loadInkCatalog, renderDetail } from "./detail.js";
import { renderCart, renderProposal } from "./proposal.js";
import { E, closeEditor, newDoc, renderDrawer, saveDraft, syncTabs } from "./editor.js";
import { bindCrop } from "./crop.js";

/* ---------------- router ---------------- */
export function rerender() {
  const h = location.hash.replace(/^#/, "");
  const nav = $("#navhome");
  if (nav) nav.style.display = h ? "" : "none";
  if (h === "/new") {
    if (!App.newDraft) App.newDraft = newDoc();
    renderDetail("__new__", null, App.newDraft);
    renderCart();
  } else if (h.indexOf("/p/") === 0) {
    const parts = h.slice(3).split("/");
    renderDetail(decodeURIComponent(parts[0]), parts[1] ? decodeURIComponent(parts[1]) : null);
    renderCart();
  } else if (h === "/proposal") {
    renderProposal();
  } else {
    renderCatalog();
    renderCart();
  }
  window.scrollTo(0, 0);
}

/* ---------------- boot ---------------- */
async function boot() {
  loadLS();
  bindCrop();
  $("#brand").onclick = () => (location.hash = "");
  $("#navhome").onclick = () => (location.hash = "");
  $("#cartbtn").onclick = () => (location.hash = "#/proposal");
  $("#newbtn").onclick = () => { App.newDraft = newDoc(); location.hash = "#/new"; };
  $("#drawer-close").onclick = () => closeEditor();
  $("#drawer-cancel").onclick = () => closeEditor();
  $("#drawer-scrim").onclick = () => closeEditor();
  $("#drawer-save").onclick = saveDraft;
  $$("#drawer-tabs button").forEach((b) => (b.onclick = () => {
    if (E.tab === "json" && E.jsonErr) { E.msg = "JSON 문법 오류를 먼저 고치세요"; renderDrawer(); return; }
    E.tab = b.dataset.tab; syncTabs(); renderDrawer();
  }));

  try { await loadInkCatalog(); } catch (e) { /* 아카이브는 목록 없이도 열 수 있다 */ }
  try { App.rdpStatus = await apiGet("/api/rdp/status"); } catch (e) {}

  try {
    const ui = await apiGet("/api/ui");
    if (ui && ui.state) {
      const localTs = Number(App.prop.ts || 0);
      const serverTs = Number(ui.state.ts || 0);
      if (serverTs >= localTs) {
        if (Array.isArray(ui.state.cart)) App.cart = ui.state.cart;
        if (ui.state.prop) App.prop = Object.assign(App.prop, ui.state.prop);
      }
    }
  } catch (e) {}

  try {
    const health = await apiGet("/api/health");
    App.config = health;
    $("#brand-name").textContent = health.brand || "RDP";
    $("#brand-sub").textContent = health.brandSub || "SPECIMEN ARCHIVE";
    document.title = (health.brand || "RDP") + " 시편 아카이브";
  } catch (e) {}

  $("#search").addEventListener("input", (e) => {
    App.q = e.target.value;
    if (location.hash && location.hash !== "#") location.hash = ""; else renderCatalog();
  });
  document.addEventListener("keydown", (e) => {
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
    if (e.key === "/" && !typing) { e.preventDefault(); $("#search").focus(); }
    if (e.key === "Escape") {
      if ($("#crop-modal").classList.contains("on")) return $("#crop-modal").classList.remove("on");
      if ($("#drawer").classList.contains("on")) return closeEditor();
      if (location.hash) location.hash = "";
    }
  });

  try {
    const data = await apiGet("/api/patterns");
    App.patterns = (data.patterns || []).map((pp) => {
      (pp.variations || []).forEach((vv) => (vv.mixes || []).forEach((mm) => {
        if (mm.result === "planned") mm.result = "plan";
      }));
      return pp;
    });
    App.loadErrors = data.errors || [];
    if (data.errors && data.errors.length) {
      console.warn("load errors", data.errors);
      toast("동기화 충돌/깨진 파일 " + data.errors.length + "건 — 콘솔 확인");
    }
  } catch (e) {
    $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><h2>서버에 연결할 수 없습니다</h2>
        <p>터미널에서 <code>python3 server.py</code> 를 실행하거나, 폴더의 <b>RDP Archive.command</b> 를 더블클릭하세요.</p>
        <p style="font-size:12px;color:#8d9198">${esc(e.message)}</p></div></div>`;
    return;
  }
  renderCart();
  rerender();
}

window.addEventListener("hashchange", rerender);
boot();
