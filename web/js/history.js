/* RDP 시편 아카이브 — 변경 이력 대화상자 (상세 화면 [이력])
 *
 * 서버가 저장 때마다 남긴 _backup 을 읽어 '저장 한 번 = 한 줄'로 보여 주고, 원하면 그 저장 전 상태로 되돌린다.
 * 되돌리기도 평소 저장(PUT)이다 — rev 충돌 검사·백업·동판 추적이 그대로 돌고, 지금 상태도 이력에 남는다.
 * 옛 버전이 쓰던 사진이 휴지통에 있으면 먼저 되살리고, 없으면 그 사진만 빼고 되돌린다.
 *
 * 되돌리기: detail.js 의 [이력] 버튼과 이 파일·history-rules.js 를 지우면 된다.
 */
import { App, apiGet, apiPost, apiPut, byId, clone, esc, fmtDate, markSaved, revOf, toast } from "./core.js";
import { historyRows, stampText } from "./history-rules.js";

const SHOW = 6;   // 한 줄에 바로 보여 줄 변경 수(나머지는 '외 N개'를 눌러 펼친다)

function whenText(row) {
  const t = String(row.savedAt || "");
  return t ? `${fmtDate(t.slice(0, 10))} ${t.slice(11, 16)}` : stampText(row.stamp);
}

function rowHTML(row, i) {
  if (row.error) return `<li class="hi-row hi-err"><span class="hi-when">${esc(stampText(row.stamp))}</span><span>${esc(row.error)}</span></li>`;
  const ch = row.changes.length ? row.changes : ["(내용 변화 없음 — 저장만 다시 됨)"];
  const more = ch.length > SHOW ? `<button type="button" class="link-btn hi-more" data-more="${i}">외 ${ch.length - SHOW}개</button>` : "";
  const miss = row.missingImages.length
    ? `<div class="hi-note">이 버전의 사진 ${row.missingImages.length}장은 지금 없습니다 — 휴지통에 있으면 되살리고, 없으면 빼고 되돌립니다</div>` : "";
  return `<li class="hi-row">
      <div class="hi-top"><span class="hi-when">${esc(whenText(row))} 저장</span>
        <button type="button" class="btn-line hi-restore" data-restore="${i}" title="이 저장이 일어나기 전 상태로 되돌립니다">이 저장 전으로</button></div>
      <ul class="hi-ch">${ch.map((c, k) => `<li${k >= SHOW ? ' class="hi-hide" hidden' : ""}>${esc(c)}</li>`).join("")}</ul>${more}${miss}
    </li>`;
}

/**
 * @param pid       시편 id
 * @param onRestored (saved) => void  되돌린 뒤 화면을 다시 그린다
 */
export async function openHistory(pid, onRestored) {
  const p = byId(pid);
  if (!p) return;
  const dlg = document.createElement("dialog");
  dlg.className = "recipe-preview history-dialog";
  dlg.innerHTML = `<button class="mini-btn recipe-close" type="button">닫기</button>
    <h3>변경 이력 · ${esc(p.pattern.code)}</h3>
    <p class="recipe-help">저장할 때마다 바뀌기 전 상태가 남습니다. 되돌려도 지금 상태가 이력에 남아 다시 되돌릴 수 있습니다.</p>
    <div class="hi-body">불러오는 중…</div>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".recipe-close").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  const body = dlg.querySelector(".hi-body");
  let rows = [];
  try {
    const r = await apiGet(`/api/history/${encodeURIComponent(pid)}`);
    rows = historyRows(r.items || [], byId(pid));
    if (!dlg.isConnected) return;
    if (!rows.length) { body.innerHTML = `<p class="recipe-help">아직 저장 이력이 없습니다 (처음 만든 뒤 고친 적이 없음).</p>`; return; }
    const older = r.total > rows.length ? `<p class="recipe-help">그 전 ${r.total - rows.length}개는 데이터 폴더의 _backup 에 있습니다.</p>` : "";
    body.innerHTML = `<ol class="hi-list">${rows.map(rowHTML).join("")}</ol>${older}`;
  } catch (e) {
    body.innerHTML = `<p class="recipe-help">이력을 읽지 못했습니다: ${esc(e.message)}</p>`;
    return;
  }

  body.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => {
    b.closest(".hi-row").querySelectorAll(".hi-hide").forEach((li) => { li.hidden = false; });
    b.remove();
  }));
  body.querySelectorAll("[data-restore]").forEach((b) => (b.onclick = async () => {
    const row = rows[Number(b.dataset.restore)];
    if (!row || !row.before) return;
    if (!confirm(`${whenText(row)} 저장 전 상태로 되돌릴까요?\n\n지금 상태는 이력에 남아 다시 되돌릴 수 있습니다.`)) return;
    b.disabled = true;
    try {
      const saved = await restoreVersion(pid, row);
      dlg.close();
      toast("되돌렸습니다 — 지금 상태는 이력에 남아 있습니다", 3500);
      onRestored(saved);
    } catch (e) {
      b.disabled = false;
      toast(e.status === 409 ? "다른 곳에서 먼저 저장됐습니다 — 새로고침 후 다시 해 주세요" : "되돌리지 못했습니다: " + e.message, 4000);
    }
  }));
}

/** 옛 문서를 평소 저장으로 보낸다(사진은 먼저 휴지통에서 되살린다) */
export async function restoreVersion(pid, row) {
  const cur = byId(pid);
  const doc = clone(row.before);
  if (row.missingImages && row.missingImages.length) {
    const r = await apiPost(`/api/history/${encodeURIComponent(pid)}/recover-images`, { images: row.missingImages });
    const gone = new Set(r.missing || []);
    (doc.variations || []).forEach((v) => { if (v && Array.isArray(v.images)) v.images = v.images.filter((n) => !gone.has(n)); });
  }
  doc.id = pid;
  ["_file", "_mtime", "_sel", "rev", "updatedAt", "renamedFrom"].forEach((k) => delete doc[k]);
  const r = await apiPut(`/api/patterns/${encodeURIComponent(pid)}`, doc, revOf(cur));
  const saved = markSaved(doc, r);
  saved._mtime = Date.now();
  if (r.renamedFrom) saved.renamedFrom = r.renamedFrom;
  const i = App.patterns.findIndex((x) => x.id === pid);
  if (i >= 0) App.patterns[i] = saved;
  return saved;
}
