/* RDP 시편 아카이브 — 보기 전용 파일 만들기 (⋯ 메뉴 '보기 전용 파일 (Bake)')
 *
 * 서버(맥)가 꺼져 있어도 볼 수 있게 지금 시편을 HTML 한 파일(사진 포함) + PDF 로 굳힌다(server.py bake · bake.py).
 * 파일은 데이터 폴더/_bake 에 남는다 — 데이터 폴더가 구글 드라이브면 휴대폰 드라이브 앱에서 바로 열린다.
 * '자동으로 새로 굽기'를 켜면 시편을 고친 뒤 2분 조용할 때 서버가 내부용을 다시 굽는다.
 *
 * 되돌리기: catalog.js 의 메뉴 한 줄과 이 파일을 지우면 된다.
 */
import { apiGet, apiPost, esc, toast } from "./core.js";

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const fileUrl = (name) => `/api/bake/file?name=${encodeURIComponent(name)}`;

/** @param scope {ids:[보이는 시편 id], total:전체 수} */
export async function openBakeDialog(scope) {
  const dlg = document.createElement("dialog");
  dlg.className = "recipe-preview bake-dlg";
  const nHit = (scope.ids || []).length;
  dlg.innerHTML = `<button class="mini-btn recipe-close" type="button">닫기</button>
    <h3>보기 전용 파일 만들기</h3>
    <p class="recipe-help">맥이 꺼져 있어도 볼 수 있게 지금 시편을 <b>파일로 굳혀요</b>. 사진까지 들어간 HTML 한 파일과 PDF — 고칠 수는 없는 사본이에요.</p>
    <fieldset class="bk-opt"><legend>누가 볼 건가요</legend>
      <label><input type="radio" name="bk-aud" value="internal" checked> 내부용 — 배합·메모·작업 정보·별점까지</label>
      <label><input type="radio" name="bk-aud" value="client"> 고객용 — 미팅 모드처럼 배합·메모·동판·작업 정보·별점 빼기</label></fieldset>
    <fieldset class="bk-opt"><legend>범위</legend>
      <label><input type="radio" name="bk-scope" value="all" checked> 전체 시편 ${scope.total}개</label>
      <label><input type="radio" name="bk-scope" value="hits"${nHit && nHit < scope.total ? "" : " disabled"}> 지금 검색 결과 ${nHit}개만</label></fieldset>
    <label class="bk-pdf"><input type="checkbox" id="bk-pdf" checked> PDF 도 만들기 <small id="bk-pdfnote"></small></label>
    <div class="bulk-actions"><button type="button" class="btn-dark" id="bk-go">만들기</button></div>
    <p class="bk-status" id="bk-status" aria-live="polite"></p>
    <div class="bk-files" id="bk-files"></div>
    <label class="bk-auto"><input type="checkbox" id="bk-auto"> 시편을 고치면 <b>자동으로 새로 굽기</b> (내부용 · 고친 뒤 2분 조용할 때, 서버가 켜져 있는 동안)</label>
    <p class="recipe-help bk-tip">데이터 폴더가 구글 드라이브에 있으면 휴대폰 <b>드라이브 앱 → RDP-Archive → _bake</b> 에서 바로 열려요. 휴대폰은 PDF 가 가장 편하고, HTML 은 컴퓨터 브라우저에서 검색·필터까지 돼요.</p>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".recipe-close").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  const $d = (s) => dlg.querySelector(s);
  const paintFiles = (info) => {
    const files = info.files || [];
    $d("#bk-files").innerHTML = files.length
      ? `<p class="bk-where">저장 위치: <code>${esc(info.folder)}</code></p><ul>${files.map((f) => `<li><a href="${fileUrl(f.name)}" download="${esc(f.name)}">${esc(f.name)}</a>
          <span>${kb(f.size)} · ${esc(f.mtime)}</span></li>`).join("")}</ul>`
      : `<p class="bk-where">아직 만든 파일이 없어요 — 저장 위치: <code>${esc(info.folder)}</code></p>`;
  };
  const load = async () => {
    try {
      const info = await apiGet("/api/bake");
      paintFiles(info);
      $d("#bk-auto").checked = !!(info.auto && info.auto.enabled);
      if (!info.pdfReady) {
        $d("#bk-pdf").checked = false;
        $d("#bk-pdf").disabled = true;
        $d("#bk-pdfnote").textContent = "— 이 컴퓨터에서 Chrome 을 찾지 못했어요. HTML 을 열어 인쇄 → PDF 로 저장하면 돼요";
      }
    } catch (e) { $d("#bk-status").textContent = "불러오지 못했어요: " + e.message; }
  };
  $d("#bk-auto").onchange = async (e) => {
    try {
      await apiPost("/api/bake/auto", { enabled: e.target.checked, audiences: ["internal"] });
      toast(e.target.checked ? "시편을 고치면 보기 전용 파일을 자동으로 새로 구워요" : "자동 굽기를 껐어요");
    } catch (err) { e.target.checked = !e.target.checked; toast("바꾸지 못했어요: " + err.message); }
  };
  $d("#bk-go").onclick = async () => {
    const go = $d("#bk-go");
    const audience = dlg.querySelector('input[name="bk-aud"]:checked').value;
    const hits = dlg.querySelector('input[name="bk-scope"]:checked').value === "hits";
    go.disabled = true;
    $d("#bk-status").textContent = "만드는 중… 사진이 많으면 1~2분 걸려요";
    try {
      const r = await apiPost("/api/bake", { audience, ids: hits ? scope.ids : null, pdf: $d("#bk-pdf").checked });
      $d("#bk-status").innerHTML = `완료 — 시편 ${r.patterns}개 · 컬러 ${r.colors}개 (${esc(r.bakedAt)} 기준)
        · <a href="${fileUrl(r.html)}" download="${esc(r.html)}">HTML ${kb(r.htmlSize)}</a>${r.pdf ? ` · <a href="${fileUrl(r.pdf)}" download="${esc(r.pdf)}">PDF ${kb(r.pdfSize)}</a>` : ""}
        ${r.pdfError ? `<br><small>${esc(r.pdfError)}</small>` : ""}`;
      await load();
    } catch (e) {
      $d("#bk-status").textContent = "만들지 못했어요: " + e.message;
    } finally { go.disabled = false; }
  };
  load();
}

/** 개발 실적 보고서를 보기 전용 파일로 — 보고서 화면의 지금 구성(칸·항목·제목·연도) 그대로.
 *  @param config  report-page.js 의 구성 {year, kind, developer, vehicle, title, layout, hidden, titles} */
export async function openReportBakeDialog(config) {
  const dlg = document.createElement("dialog");
  dlg.className = "recipe-preview bake-dlg";
  dlg.innerHTML = `<button class="mini-btn recipe-close" type="button">닫기</button>
    <h3>보고서를 보기 전용 파일로</h3>
    <p class="recipe-help">맥이 꺼져 있어도 볼 수 있게 <b>지금 보이는 보고서 그대로</b>(칸 · 순서 · 넣을 항목 · 제목 · 연도) 사진까지 들어간
      HTML 한 파일과 PDF 로 만들어요. 파일만 보내면 바로 열려요 — 고칠 수는 없는 사본이에요.</p>
    <label class="bk-pdf"><input type="checkbox" id="bk-pdf" checked> PDF 도 만들기 <small id="bk-pdfnote"></small></label>
    <div class="bulk-actions"><button type="button" class="btn-dark" id="bk-go">만들기</button></div>
    <p class="bk-status" id="bk-status" aria-live="polite"></p>
    <div class="bk-files" id="bk-files"></div>
    <label class="bk-auto"><input type="checkbox" id="bk-auto"> <span>시편을 고치면 <b>이 보고서도 자동으로 새로 굽기</b>
      (마지막으로 [만들기]한 구성으로 · 고친 뒤 2분 조용할 때, 서버가 켜져 있는 동안)</span></label>
    <p class="recipe-help bk-tip">데이터 폴더가 구글 드라이브에 있으면 휴대폰 <b>드라이브 앱 → RDP-Archive → _bake → 개발실적보고서.pdf</b>.
      드라이브에서 [공유] → 링크를 보내면 맥이 꺼져 있어도 상대가 바로 열어 봐요.</p>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".recipe-close").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  const $d = (s) => dlg.querySelector(s);
  const paintFiles = (info) => {
    const files = (info.files || []).filter((f) => f.name.startsWith("개발실적보고서"));
    $d("#bk-files").innerHTML = files.length
      ? `<p class="bk-where">저장 위치: <code>${esc(info.folder)}</code></p><ul>${files.map((f) => `<li><a href="${fileUrl(f.name)}" download="${esc(f.name)}">${esc(f.name)}</a>
          <span>${kb(f.size)} · ${esc(f.mtime)}</span></li>`).join("")}</ul>`
      : `<p class="bk-where">아직 구운 보고서가 없어요 — 저장 위치: <code>${esc(info.folder)}</code></p>`;
  };
  const load = async () => {
    try {
      const info = await apiGet("/api/bake");
      paintFiles(info);
      $d("#bk-auto").checked = !!(info.auto && info.auto.report);
      if (!info.pdfReady) {
        $d("#bk-pdf").checked = false;
        $d("#bk-pdf").disabled = true;
        $d("#bk-pdfnote").textContent = "— 이 컴퓨터에서 Chrome 을 찾지 못했어요. HTML 을 열어 인쇄 → PDF 로 저장하면 돼요";
      }
    } catch (e) { $d("#bk-status").textContent = "불러오지 못했어요: " + e.message; }
  };
  $d("#bk-auto").onchange = async (e) => {
    try {
      await apiPost("/api/bake/auto", { report: e.target.checked });
      toast(e.target.checked ? "시편을 고치면 보고서도 자동으로 새로 구워요 (마지막으로 만든 구성으로)" : "보고서 자동 굽기를 껐어요");
    } catch (err) { e.target.checked = !e.target.checked; toast("바꾸지 못했어요: " + err.message); }
  };
  $d("#bk-go").onclick = async () => {
    const go = $d("#bk-go");
    go.disabled = true;
    $d("#bk-status").textContent = "만드는 중… 사진이 많으면 1~2분 걸려요";
    try {
      const r = await apiPost("/api/bake/report", { config, pdf: $d("#bk-pdf").checked });
      $d("#bk-status").innerHTML = `완료 — 패턴 ${r.rows}개 (${esc(r.bakedAt)} 기준)
        · <a href="${fileUrl(r.html)}" download="${esc(r.html)}">HTML ${kb(r.htmlSize)}</a>${r.pdf ? ` · <a href="${fileUrl(r.pdf)}" download="${esc(r.pdf)}">PDF ${kb(r.pdfSize)}</a>` : ""}
        ${r.pdfError ? `<br><small>${esc(r.pdfError)}</small>` : ""}`;
      await load();
    } catch (e) {
      $d("#bk-status").textContent = "만들지 못했어요: " + e.message;
    } finally { go.disabled = false; }
  };
  load();
}
