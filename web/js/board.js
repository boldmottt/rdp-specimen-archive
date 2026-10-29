/* RDP 시편 아카이브 — 프로젝트 컬러 보드 (#/board/<프로젝트>)
 *
 * 왜 있나: CMF 보고·검토에서 "이 프로젝트에 무슨 색이 있는지"를 한 장으로 본다.
 * 색은 사진에서 뽑은 대표색(/api/color)이다 — 측색값이 아니라 참고용이다(화면에 그렇게 적는다).
 * 기준색(App.refColor)이 있으면 ΔE2000 을 함께 보여준다.
 *
 * 인쇄: body.board-mode 일 때만 규칙을 건다(제안서 인쇄와 섞이지 않게).
 *   색 견본은 배경색이라 브라우저 기본 설정으로는 인쇄되지 않는다 → print-color-adjust: exact 필요.
 */
import { $, App, apiGet, esc, html, vName } from "./core.js";

export async function renderBoard(proj) {
  document.body.classList.remove("prop-mode");
  document.body.classList.add("board-mode");

  let items = [];
  try {
    const ref = App.refColor ? "?ref=" + App.refColor.lab.join(",") : "";
    items = (await apiGet("/api/colors" + ref)).items || [];
  } catch (e) { /* 색을 못 읽어도 보드는 연다 */ }
  const byVar = new Map(items.map((it) => [it.pid + "/" + it.vid, it]));

  const pats = App.patterns.filter((p) => p.project === proj);
  const cells = pats.flatMap((p) => (p.variations || []).map((v) => {
    const it = byVar.get(p.id + "/" + v.id);
    const c = it && it.colors && it.colors[0];
    const de = it && it.de != null ? html`<span class="bd-de">ΔE ${it.de}</span>` : "";
    return html`<div class="bd-cell">
        <div class="bd-sw" style="background:${c ? esc(c.hex) : "#eee"}"></div>
        <b>${esc(v.colorCode || vName(v))}</b>
        <span class="bd-name">${esc(v.colorName || "")}</span>
        <span class="bd-code">${esc(p.pattern.code)}</span>
        ${de}
      </div>`;
  }));

  $("#view").innerHTML = String(html`<div class="wrap board">
      <div class="bd-head">
        <h1>${esc(proj || "프로젝트")} 컬러 보드</h1>
        <span class="bd-sub">${pats.length}개 시편 · ${cells.length}개 컬러 · 사진에서 뽑은 대표색(참고용)</span>
        <span class="bd-tools noprint">
          ${App.refColor ? html`<span class="bd-ref">기준 <i style="background:${esc(App.refColor.hex)}"></i>${esc(App.refColor.hex)}</span>` : ""}
          <button class="tool" id="bd-print">인쇄</button>
        </span>
      </div>
      ${cells.length ? html`<div class="bd-grid">${cells}</div>`
        : html`<p class="bd-empty">이 프로젝트에 컬러가 없습니다.</p>`}
    </div>`);

  const pr = $("#bd-print");
  if (pr) pr.onclick = () => window.print();
}
