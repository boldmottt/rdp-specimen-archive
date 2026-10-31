/* RDP 시편 아카이브 — CSV 일괄 등록 (⋯ 메뉴 'CSV 가져오기')
 *
 * 파일을 고르면 저장 전에 미리보기(새 시편 · 기존 시편에 컬러 추가 · 건너뜀 · 줄별 오류)를 보여 주고,
 * [등록]을 눌러야 평소 저장(PUT)으로 한 시편씩 저장한다. 이미 있는 컬러는 덮어쓰지 않는다.
 * 엑셀에서 '다른 이름으로 저장 → CSV'로 만든 한글 파일(CP949)도 읽는다.
 *
 * 되돌리기: catalog.js 의 메뉴 한 줄과 이 파일·csv-import.js 를 지우면 된다.
 */
import { $, App, apiPut, byId, clone, deriveId, esc, markSaved, normalizeDoc, revOf, toast } from "./core.js";
import { buildImport, parseCsv, TEMPLATE_HEAD, TEMPLATE_ROW } from "./csv-import.js";
import { csvText } from "./bulk-rules.js";
import { newDoc } from "./editor.js";

/** UTF-8 이 아니면(엑셀 한글 CSV) EUC-KR 로 읽는다 */
export function decodeCsv(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder("euc-kr").decode(buf); }
}

function downloadTemplate() {
  const a = document.createElement("a");
  const url = URL.createObjectURL(new Blob([csvText([TEMPLATE_HEAD, TEMPLATE_ROW])], { type: "text/csv;charset=utf-8" }));
  a.href = url; a.download = "RDP-시편-등록양식.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function previewHTML(r) {
  const newN = r.plans.filter((p) => p.isNew).length;
  const addN = r.plans.reduce((a, p) => a + p.add.length, 0);
  const skipN = r.plans.reduce((a, p) => a + p.skipped.length, 0);
  return `<p class="ci-sum"><b>새 시편 ${newN}개</b> · 컬러 ${addN}개 등록 예정${skipN ? ` · 이미 있어 건너뜀 ${skipN}개` : ""}${r.errors.length ? ` · <span class="ci-err">오류 ${r.errors.length}줄 (빼고 등록)</span>` : ""}</p>
    ${r.unknown.length ? `<p class="recipe-help">모르는 머리줄은 무시합니다: ${esc(r.unknown.join(", "))}</p>` : ""}
    ${r.errors.length ? `<ul class="ci-errs">${r.errors.map((e) => `<li><b>${e.line}줄</b> ${esc(e.msg)}</li>`).join("")}</ul>` : ""}
    ${r.plans.length ? `<div class="tbl-wrap"><table class="mix ci-table"><tr><th>시편</th><th>구분</th><th>등록할 컬러</th><th>건너뜀</th></tr>
      ${r.plans.map((p) => `<tr><td><b>${esc(p.project)} ${esc(p.code)}</b></td>
        <td>${p.isNew ? '<span class="ci-new">새 시편</span>' : "기존 시편에 추가"}</td>
        <td>${esc(p.add.map((v) => v.colorCode || v.colorName).join(", ")) || "—"}</td>
        <td>${esc(p.skipped.map((s) => s.color).join(", ")) || ""}</td></tr>`).join("")}</table></div>` : ""}
    ${r.warnings.length ? `<details class="ci-warn"><summary>확인할 점 ${r.warnings.length}개</summary><ul>${r.warnings.map((w) => `<li>${w.line}줄 ${esc(w.msg)}</li>`).join("")}</ul></details>` : ""}`;
}

async function savePlans(plans, onProgress) {
  let ok = 0;
  const fails = [];
  for (const p of plans) {
    if (!p.add.length) continue;
    try {
      if (p.isNew) {
        const doc = normalizeDoc(clone(p.doc));
        const r = await apiPut(`/api/patterns/${encodeURIComponent(doc.id)}`, doc, "", true);
        const saved = markSaved(doc, r);
        saved._mtime = Date.now();
        App.patterns.push(saved);
      } else {
        const cur = byId(p.target.id);
        if (!cur) throw new Error("시편을 찾지 못했습니다");
        const doc = clone(cur);
        delete doc._file; delete doc._mtime; delete doc._sel;
        doc.variations = (doc.variations || []).concat(clone(p.add));
        doc.nextVarSeq = Math.max(Number(doc.nextVarSeq || 0), p.nextVarSeq);
        const r = await apiPut(`/api/patterns/${encodeURIComponent(cur.id)}`, doc, revOf(cur));
        const saved = markSaved(doc, r);
        saved._mtime = Date.now();
        App.patterns[App.patterns.indexOf(cur)] = saved;
      }
      ok++;
    } catch (e) {
      fails.push(`${p.project} ${p.code}: ${e.status === 409 ? "다른 곳에서 먼저 만들어졌거나 저장됨 — 새로고침 후 다시" : e.message}`);
    }
    onProgress(ok + fails.length);
  }
  return { ok, fails };
}

/** @param onDone () => void  목차 다시 그리기 */
export function openCsvImport(onDone) {
  const dlg = document.createElement("dialog");
  dlg.className = "recipe-preview csv-import";
  dlg.innerHTML = `<button class="mini-btn recipe-close" type="button">닫기</button>
    <h3>CSV로 시편 일괄 등록</h3>
    <p class="recipe-help">한 줄이 컬러 하나입니다. 프로젝트+패턴코드가 같은 줄은 한 시편으로 묶습니다.
      머리줄은 <b>CSV로 내보내기</b>와 같아서, 내보낸 파일을 고쳐 다시 올릴 수 있어요. 이미 있는 컬러는 덮어쓰지 않습니다.</p>
    <div class="ci-tools"><button type="button" class="btn-line" id="ci-tpl">양식 내려받기</button>
      <label class="btn-dark ci-file">CSV 파일 고르기<input type="file" accept=".csv,text/csv" hidden></label></div>
    <div class="ci-body"></div>
    <div class="bulk-actions"><button type="button" class="btn-line" id="ci-cancel">취소</button>
      <button type="button" class="btn-dark" id="ci-go" disabled>등록</button></div>`;
  document.body.appendChild(dlg);
  const close = () => dlg.close();
  dlg.querySelector(".recipe-close").onclick = close;
  dlg.querySelector("#ci-cancel").onclick = close;
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("#ci-tpl").onclick = downloadTemplate;
  let plan = null;
  const go = dlg.querySelector("#ci-go");
  dlg.querySelector('input[type="file"]').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = decodeCsv(await file.arrayBuffer());
    plan = buildImport(parseCsv(text), App.patterns, { deriveId, newDoc });
    dlg.querySelector(".ci-body").innerHTML = `<p class="recipe-help">${esc(file.name)}</p>` + previewHTML(plan);
    const n = plan.plans.reduce((a, p) => a + p.add.length, 0);
    go.disabled = !n;
    go.textContent = n ? `컬러 ${n}개 등록` : "등록할 것이 없습니다";
  };
  go.onclick = async () => {
    if (!plan) return;
    go.disabled = true;
    const total = plan.plans.filter((p) => p.add.length).length;
    const res = await savePlans(plan.plans, (k) => { go.textContent = `저장 중… ${k}/${total}`; });
    dlg.close();
    onDone();
    if (res.fails.length) alert(`${res.ok}개 시편 저장, ${res.fails.length}개 실패\n\n${res.fails.join("\n")}`);
    else toast(`${res.ok}개 시편에 등록했습니다`, 3000);
  };
  dlg.showModal();
}
