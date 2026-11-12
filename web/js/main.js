/* RDP 시편 아카이브 — 라우터 · 부팅 (진입점) */
import { $, $$, App, apiGet, esc, loadLS, normalizeDoc, saveSmart, toast } from "./core.js";
import { renderCatalog, saveNewPattern } from "./catalog.js";
import { loadInkCatalog, renderDetail } from "./detail.js";
import { renderArchive, renderArchived, renderCart, renderProposal } from "./proposal.js";
import { renderBoard } from "./board.js";
import { renderPlates } from "./plates-page.js";
import { renderCompare } from "./compare-page.js";
import { renderTidy } from "./tidy-page.js";
import { renderReport } from "./report-page.js";
import { E, closeEditor, newDoc, openEditor, renderDrawer, saveDraft, syncTabs } from "./editor.js";
import { bindCrop } from "./crop.js";

/* ---------------- router ---------------- */
// 목차 스크롤 위치 — 상세를 보고 [← 목차]·Esc로 돌아오면 보던 자리로 (전에는 맨 위로 튕겼다)
let lastRoute = null;
let catScroll = 0;
let searchNav = false;
export function rerender() {
  const h = location.hash.replace(/^#/, "");
  const prev = lastRoute;
  if (prev === "" && h !== "") catScroll = window.scrollY;
  // 검색창에 쳐서 목차로 온 것이면 결과가 바뀌었으니 맨 위부터
  const restore = h === "" && prev != null && prev !== "" && !searchNav;
  lastRoute = h;
  searchNav = false;
  document.body.classList.remove("board-mode");   // 컬러 보드 전용 인쇄 규칙은 이 화면에서만
  document.body.classList.remove("compare-mode");  // 비교 화면 인쇄 규칙(가로)도 그 화면에서만
  document.body.classList.remove("report-mode");   // 개발 실적 보고서 인쇄 규칙(A4 가로)도 그 화면에서만
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
  } else if (h === "/compare") {
    renderCompare();
  } else if (h === "/report") {
    renderReport();
  } else if (h === "/tidy") {
    renderTidy();
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
  // 같은 화면을 다시 그린 것(저장·선택 해제 등)이면 보던 자리 그대로
  if (h === prev) return;
  window.scrollTo(0, restore ? catScroll : 0);
}

/* ---------------- boot ---------------- */
async function boot() {
  loadLS();
  bindCrop();
  $("#brand").onclick = () => (location.hash = "");
  $("#navhome").onclick = () => (location.hash = "");
  $("#cartbtn").onclick = () => (location.hash = "#/proposal");
  $("#newbtn").onclick = () => { App.newDraft = newDoc(); location.hash = "#/new"; };
  // 서랍을 닫으면 '새 시편' 화면은 초안(App.newDraft)으로 다시 그린다 — 방금 채운 사진·배합이 보이게
  const closeAndRefresh = async () => {
    await closeEditor();
    if (location.hash === "#/new" && App.newDraft) renderDetail("__new__", null, App.newDraft);
  };
  $("#drawer-close").onclick = () => closeAndRefresh();
  $("#drawer-cancel").onclick = () => closeAndRefresh();
  $("#drawer-scrim").onclick = () => closeAndRefresh();
  // '새 시편' 화면의 [편집] — 초안을 그대로 서랍에서 편집한다(사진·배합 미리 입력)
  window.addEventListener("rdp:edit-new", () => {
    if (!App.newDraft) App.newDraft = newDoc();
    openEditor(null, null, App.newDraft);
  });
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

  // 시편이 많으면(표 보기 수백 줄) 글자마다 다시 그리면 한글 입력이 끊긴다(한 글자에 입력 이벤트가 여러 번) → 잠깐 모아서 그린다
  let qTimer = 0;
  $("#search").addEventListener("input", (e) => {
    App.q = e.target.value;
    clearTimeout(qTimer);
    if (location.hash && location.hash !== "#") { searchNav = true; location.hash = ""; }
    else if (App.patterns.length > 150) qTimer = setTimeout(() => { if (!location.hash || location.hash === "#") renderCatalog(); }, 120);
    else renderCatalog();
  });
  document.addEventListener("keydown", (e) => {
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
    if (e.key === "/" && !typing) { e.preventDefault(); $("#search").focus(); }
    // Ctrl/⌘+S = 저장 — 편집 서랍이 열려 있으면 서랍을, 새 시편 화면이면 새 시편을 (브라우저 '페이지 저장' 대신)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
      if (document.querySelector("dialog[open]")) return;
      if ($("#drawer").classList.contains("on")) { e.preventDefault(); saveDraft(); return; }
      if (location.hash === "#/new") {
        e.preventDefault();
        if (typing) ae.blur();   // 쓰던 칸을 먼저 확정(인라인 칸은 blur 때 반영)
        setTimeout(() => saveNewPattern(), 0);
        return;
      }
      if (typing && ae.classList.contains("inline-input")) { e.preventDefault(); ae.blur(); }
      return;
    }
    if (e.key === "Escape") {
      // Esc는 '지금 하던 것 취소'다 — 인라인 편집·대화상자가 이미 처리했거나 입력 중이면 목차로 나가지 않는다
      if (e.defaultPrevented) return;
      if ($("#crop-modal").classList.contains("on")) return $("#crop-modal").classList.remove("on");
      if (document.querySelector("dialog[open]")) return;   // 배합 미리보기·확정 저장 대화상자는 스스로 닫힌다
      if ($("#drawer").classList.contains("on")) {
        // 확인 대화상자가 이 Esc 를 받아 바로 닫히지 않게 다음 차례에 연다 (전에는 고친 뒤 Esc 를 눌러도 아무 일도 없었다)
        e.preventDefault();
        setTimeout(() => closeEditor(), 0);
        return;
      }
      // 검색창: 첫 Esc 는 검색어를 지우고 목록도 되돌린다(전에는 글자만 지워지고 목록은 걸러진 채였다), 다음 Esc 는 빠져나오기
      if (ae && ae.id === "search" && ae.value) {
        e.preventDefault();
        ae.value = "";
        App.q = "";
        if (!location.hash || location.hash === "#") renderCatalog();
        return;
      }
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
