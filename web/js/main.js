/* RDP 시편 아카이브 — 라우터 · 부팅 (진입점) */
import { $, $$, App, apiGet, esc, loadLS, normalizeDoc, saveSmart, toast } from "./core.js";
import { renderCatalog } from "./catalog.js";
import { loadInkCatalog, renderDetail } from "./detail.js";
import { renderArchive, renderArchived, renderCart, renderProposal } from "./proposal.js";
import { renderBoard } from "./board.js";
import { renderPlates } from "./plates-page.js";
import { E, closeEditor, newDoc, renderDrawer, saveDraft, syncTabs } from "./editor.js";
import { bindCrop } from "./crop.js";

/* ---------------- router ---------------- */
export function rerender() {
  const h = location.hash.replace(/^#/, "");
  document.body.classList.remove("board-mode");   // 컬러 보드 전용 인쇄 규칙은 이 화면에서만
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
  } else if (h === "/plates") {
    renderPlates();
  } else if (h.indexOf("/board/") === 0) {
    renderBoard(decodeURIComponent(h.slice("/board/".length)));
  } else if (h === "/proposal") {
    renderProposal();
  } else if (h === "/proposals") {
    renderArchive();
  } else if (h.indexOf("/proposals/") === 0) {
    renderArchived(decodeURIComponent(h.slice("/proposals/".length)));
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
    if (E.tab === "json" && E.jsonErr) { E.msg = "JSON 오류를 먼저 고치세요 — " + E.jsonErr; renderDrawer(); return; }
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
      // 저장된 검색은 서버가 정본(여러 탭·다른 PC 와 맞추기 위해). rev 가 더 크면 서버 것을 쓴다.
      const sfServerRev = Number(ui.state.smartFoldersRev || 0);
      if (Array.isArray(ui.state.smartFolders) && sfServerRev > Number(App.sfRev || 0)) {
        App.smartFolders = ui.state.smartFolders;
        App.sfRev = sfServerRev;
        localStorage.setItem("rdp2-smart", JSON.stringify(App.smartFolders));
        localStorage.setItem("rdp2-sfrev", String(App.sfRev));
      } else if (!Array.isArray(ui.state.smartFolders) && (App.smartFolders || []).length) {
        // 서버에 저장된 검색이 아예 없다(state.json 초기화·새 데이터 폴더) → 이 브라우저의 목록을 다시 올린다.
        //   rev 를 서버 값으로 맞춰야 한다 — 내 rev 가 더 크면 저장할 때마다 409 가 났다.
        App.sfRev = sfServerRev;
        saveSmart();
      } else if (sfServerRev > Number(App.sfRev || 0)) {
        App.sfRev = sfServerRev;
      }
    }
  } catch (e) {}

  try {
    const health = await apiGet("/api/health");
    App.config = health;
    $("#brand-name").textContent = health.brand || "RDP";
    $("#brand-sub").textContent = health.brandSub || "SPECIMEN ARCHIVE";
    document.title = (health.brand || "RDP") + " 시편 아카이브";
    const others = health.otherServers || [];
    if (others.length) {
      toast(`다른 PC(${others.map((o) => o.host).join(", ")})에서도 아카이브 서버가 켜져 있어요 — 같은 시편을 동시에 고치면 저장이 엇갈릴 수 있어요`, 8000);
    }
  } catch (e) {}

  // 저장된 검색이 다른 곳과 맞춰졌을 때(409 복구) 목차의 폴더 칩을 다시 그린다
  window.addEventListener("rdp:folders-changed", () => {
    if (!location.hash || location.hash === "#") renderCatalog();
  });

  $("#search").addEventListener("input", (e) => {
    App.q = e.target.value;
    if (location.hash && location.hash !== "#") location.hash = ""; else renderCatalog();
  });
  document.addEventListener("keydown", (e) => {
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
    if (e.key === "/" && !typing) { e.preventDefault(); $("#search").focus(); }
    if (e.key === "Escape") {
      // Esc는 '지금 하던 것 취소'다 — 인라인 편집·대화상자가 이미 처리했거나 입력 중이면 목차로 나가지 않는다
      if (e.defaultPrevented) return;
      if ($("#crop-modal").classList.contains("on")) return $("#crop-modal").classList.remove("on");
      if ($("#drawer").classList.contains("on")) return closeEditor();
      if (document.querySelector("dialog[open]")) return;   // 배합 미리보기·확정 저장 대화상자는 스스로 닫힌다
      if (typing) { ae.blur(); return; }
      if (location.hash) location.hash = "";
    }
  });

  try {
    const data = await apiGet("/api/patterns");
    App.patterns = (data.patterns || []).map((pp) => {
      normalizeDoc(pp);
      pp.variations.forEach((vv) => vv.mixes.forEach((mm) => {
        if (mm && mm.result === "planned") mm.result = "plan";
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

// 같은 파일이 다른 주소(main.js?v=…)로 한 번 더 실행되면 모든 이벤트가 두 번씩 걸린다
// (Esc가 입력 취소 뒤 목차 이동까지 하던 원인) → 부팅은 한 번만
if (!window.__rdpBooted) {
  window.__rdpBooted = true;
  window.addEventListener("hashchange", rerender);
  boot();
}
