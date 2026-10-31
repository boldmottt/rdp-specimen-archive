/* RDP 시편 아카이브 — 작업일지에서 새 시편 등록
 *
 * 작업일지(PCCS3 v3)의 작업 × 패턴 코드를 고르면 프로젝트·코드·동판·도수별 배합·작업일·장소·작업자를
 * 채운 새 시편 초안을 연다. 저장은 평소 '새 시편' 화면에서 사람이 확인하고 누른다.
 * 이미 아카이브에 있는 패턴(코드가 같으면: W1 = W01)은 표시하고, 그래도 새로 만들지 묻는다.
 *
 * 되돌리기: ⋯ 메뉴·새 시편 화면의 버튼과 이 파일·worklog-draft.js 를 지우면 된다.
 */
import { $, $$, App, apiGet, byId, esc, fmtDate, toast } from "./core.js";
import { newDoc } from "./editor.js";
import { applyWorklogDraft, jobMatches } from "./worklog-draft.js";

export async function openWorklogPicker() {
  const dlg = document.createElement("dialog");
  dlg.className = "recipe-preview wl-picker";
  dlg.innerHTML = `<button class="mini-btn recipe-close" type="button">닫기</button>
    <h3>작업일지에서 새 시편</h3>
    <p class="recipe-help">작업 하나를 고르면 동판·도수별 배합·작업 정보가 채워진 새 시편이 열립니다. 확인하고 [저장]을 눌러야 등록됩니다.</p>
    <input class="wl-q" placeholder="날짜 · 제목 · 패턴 코드 · 동판 · 고객" autocomplete="off">
    <div class="wl-body"><p class="recipe-help">불러오는 중…</p></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".recipe-close").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  let jobs = [];
  try {
    const r = await apiGet("/api/worklog-jobs");
    if (!r.available) { dlg.querySelector(".wl-body").innerHTML = `<p class="recipe-help">작업일지 폴더를 읽을 수 없습니다 (config.json 의 worklogDir · PyYAML 확인).</p>`; return; }
    jobs = r.jobs || [];
  } catch (e) { dlg.querySelector(".wl-body").innerHTML = `<p class="recipe-help">작업일지를 읽지 못했습니다: ${esc(e.message)}</p>`; return; }

  const paint = () => {
    const q = dlg.querySelector(".wl-q").value;
    const list = jobs.filter((j) => jobMatches(j, q));
    dlg.querySelector(".wl-body").innerHTML = list.length ? `<ul class="wl-jobs">${list.map((j) => {
      const i = jobs.indexOf(j);
      const ex = j.existing && byId(j.existing);
      return `<li>
        <div class="wl-main"><span class="d">${esc(fmtDate(j.date))}</span> <b>${esc(j.code)}</b>
          <span class="wl-meta">${esc(j.title || "")}</span>
          <div class="wl-sub">동판 ${esc(j.lot || "—")} · ${esc(j.layers.join("·"))} · 배치 ${j.batches}${j.samples ? ` · 시편 ${j.samples}종` : ""}${j.customer ? ` · ${esc(j.customer)}` : ""}${j.stage ? ` · ${esc(j.stage)}` : ""}</div></div>
        ${ex ? `<a class="wl-exist" href="#/p/${encodeURIComponent(ex.id)}" data-close="1" title="이미 아카이브에 있는 패턴">이미 있음: ${esc(ex.pattern.code)} →</a>` : ""}
        <button type="button" class="btn-line wl-pick" data-i="${i}">새 시편으로</button>
      </li>`;
    }).join("")}</ul>` : `<p class="recipe-help">${jobs.length ? "검색에 맞는 작업이 없습니다" : "v3 형식 작업일지가 없습니다"}</p>`;
    $$("[data-close]", dlg).forEach((a) => (a.onclick = () => dlg.close()));
    $$("[data-i]", dlg).forEach((b) => (b.onclick = () => pick(jobs[Number(b.dataset.i)], dlg, b)));
  };
  dlg.querySelector(".wl-q").oninput = paint;
  paint();
  dlg.querySelector(".wl-q").focus();
}

async function pick(j, dlg, btn) {
  if (j.existing && byId(j.existing) &&
    !confirm(`이 패턴은 이미 아카이브에 '${byId(j.existing).pattern.code}'(으)로 있습니다.\n컬러를 더하려면 그 시편의 편집기에서 추가하세요.\n\n그래도 새 시편으로 만들까요?`)) return;
  btn.disabled = true;
  try {
    const q = new URLSearchParams({ file: j.file, seq: String(j.seq), code: j.code });
    const r = await apiGet(`/api/worklog-draft?${q}`);
    App.newDraft = applyWorklogDraft(newDoc(), r.draft);
    dlg.close();
    if (location.hash === "#/new") window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = "#/new";
    toast(`${j.code} 초안을 채웠어요 — 확인하고 [저장]을 누르세요`, 3500);
  } catch (e) {
    btn.disabled = false;
    toast("초안을 만들지 못했습니다: " + e.message, 3500);
  }
}
