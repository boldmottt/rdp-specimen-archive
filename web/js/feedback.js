/* RDP 시편 아카이브 — 고객 피드백 (확정본 컬러별 채택·수정 요청·반려 + 메모)
 *
 * 확정본 화면의 [고객 피드백] 대화상자에서 적고, 상세 화면 '제안 이력'에서 그 시편이 어느 제안에
 * 들어갔고 어떤 반응이었는지 본다. 확정본의 내용(스냅샷)은 그대로 두고 proposal.json 의 feedback 에만 쓴다.
 * 시편 상태(v.status)는 자동으로 바꾸지 않는다 — 줄마다 [시편 상태에도]를 눌러야 바뀐다.
 *
 * 되돌리기: proposal.js·detail.js 의 버튼/칸과 이 파일을 지우면 된다. 적어 둔 feedback 은 확정본 파일에 남는다.
 */
import { $, apiGet, apiPost, byId, esc, fmtDate, toast } from "./core.js";
import { inlineSave } from "./inline.js";

export const FB = [["adopted", "채택"], ["revise", "수정 요청"], ["rejected", "반려"]];
const LABEL = Object.fromEntries(FB);

/** "채택 2 · 수정 요청 1" (없으면 빈 문자열) */
export function fbCountText(counts) {
  return FB.filter(([k]) => counts && counts[k]).map(([k, l]) => `${l} ${counts[k]}`).join(" · ");
}

function rowHTML(slug, it, v, fb, img) {
  const key = `${it.pattern.id}::${v.id}`;
  const f = fb[key] || {};
  const exists = !!(byId(it.pattern.id) && (byId(it.pattern.id).variations || []).some((x) => x.id === v.id));
  return `<li class="fb-row" data-key="${esc(key)}">
      ${v.images && v.images[0] ? `<img class="fb-th" src="${esc(img(it.pattern.id, v.images[0]))}?w=120" alt="">` : `<span class="fb-th"></span>`}
      <div class="fb-main">
        <b>${esc(it.pattern.code)}</b> <span>${esc(v.name || v.id)}</span>
        <div class="fb-seg" role="radiogroup" aria-label="${esc(it.pattern.code + " " + (v.name || ""))} 고객 반응">
          ${FB.map(([k, l]) => `<button type="button" class="fb-btn fb-${k}${f.status === k ? " on" : ""}" data-st="${k}" aria-pressed="${f.status === k}">${l}</button>`).join("")}
        </div>
        <input class="fb-note" maxlength="500" placeholder="고객 의견·요청 사항" value="${esc(f.note || "")}">
        <div class="fb-foot">
          <span class="fb-at">${f.at ? esc(fmtDate(f.at.slice(0, 10))) + " 기록" : ""}</span>
          ${exists ? `<button type="button" class="link-btn fb-apply"${f.status ? "" : " hidden"} title="아카이브의 이 컬러 상태도 같은 말로 바꿉니다">시편 상태에도 '${esc(LABEL[f.status] || "")}'</button>` : `<span class="fb-gone">아카이브에 없는 컬러</span>`}
        </div>
      </div>
    </li>`;
}

/**
 * @param slug  확정본 이름
 * @param doc   확정본 원본(proposal.json — feedback 포함)
 * @param m     normalizeModel(doc) 결과(items·variations)
 * @param img   (pid, name) => 확정본 사진 주소
 * @param onChange (counts) => void  툴바 숫자 갱신
 */
export function openFeedback(slug, doc, m, img, onChange) {
  let fb = Object.assign({}, doc.feedback || {});
  const dlg = document.createElement("dialog");
  dlg.className = "recipe-preview feedback-dialog";
  dlg.innerHTML = `<button class="mini-btn recipe-close" type="button">닫기</button>
    <h3>고객 피드백 <small>${esc(m.docNo || slug)} Rev.${esc(m.rev || "0")}</small></h3>
    <p class="recipe-help">컬러마다 고객 반응을 남깁니다. 확정본 내용은 바뀌지 않고, 시편 상세의 '제안 이력'에 함께 보입니다.</p>
    <ol class="fb-list">${m.items.map((it) => it.variations.map((v) => rowHTML(slug, it, v, fb, img)).join("")).join("")}</ol>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".recipe-close").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());

  const save = async (row, patch) => {
    const key = row.dataset.key;
    const cur = fb[key] || {};
    const body = { key, status: cur.status || "", note: cur.note || "", ...patch };
    try {
      const r = await apiPost(`/api/proposals/${encodeURIComponent(slug)}/feedback`, body);
      fb = r.feedback || {};
      doc.feedback = fb;
      const f = fb[key] || {};
      row.querySelectorAll(".fb-btn").forEach((b) => { const on = b.dataset.st === f.status; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
      const ap = row.querySelector(".fb-apply");
      if (ap) { ap.hidden = !f.status; ap.textContent = `시편 상태에도 '${LABEL[f.status] || ""}'`; }
      row.querySelector(".fb-at").textContent = f.at ? fmtDate(f.at.slice(0, 10)) + " 기록" : "";
      onChange(r.counts || {});
    } catch (e) { toast("저장하지 못했습니다: " + e.message, 3500); }
  };
  dlg.querySelectorAll(".fb-row").forEach((row) => {
    row.querySelectorAll(".fb-btn").forEach((b) => (b.onclick = () => {
      const cur = (fb[row.dataset.key] || {}).status || "";
      save(row, { status: cur === b.dataset.st ? "" : b.dataset.st });     // 같은 버튼을 다시 누르면 지운다
    }));
    const note = row.querySelector(".fb-note");
    note.onchange = () => save(row, { note: note.value });
    const ap = row.querySelector(".fb-apply");
    if (ap) ap.onclick = () => {
      const [pid, vid] = row.dataset.key.split("::");
      const label = LABEL[(fb[row.dataset.key] || {}).status];
      if (!label) return;
      inlineSave(pid, (d) => {
        const v = (d.variations || []).find((x) => x.id === vid);
        if (!v || v.status === label) return false;
        v.status = label;
        return true;
      });
    };
  });
  dlg.showModal();
}

/** 상세 화면 '제안 이력' — 이 시편이 들어간 확정본과 고객 반응. 지금 컬러를 위로. */
export async function loadProposalHistory(p, v) {
  const sec = $("#fb-sec");
  if (!sec) return;
  let items;
  try { items = (await apiGet(`/api/proposals-for/${encodeURIComponent(p.id)}`)).items || []; } catch (e) { return; }
  const now = $("#fb-sec");
  if (!now || now.dataset.pid !== p.id || !items.length) return;
  items.sort((a, b) => (a.vid === v.id ? 0 : 1) - (b.vid === v.id ? 0 : 1) || String(b.date).localeCompare(String(a.date)));
  now.innerHTML = `<h3>제안 이력 <span class="cnt">${items.length}건</span></h3>
    <ul class="timeline">${items.map((x) => `<li class="${x.vid === v.id ? "" : "fb-other"}"><span class="d">${esc(x.date ? fmtDate(x.date) : "")}</span><div>
        <div><a href="#/proposals/${encodeURIComponent(x.slug)}">${esc(x.docNo || x.title || x.slug)} Rev.${esc(x.rev)}</a>
          ${x.client ? `<span class="wl-meta">${esc(x.client)}</span>` : ""} · ${esc(x.name)}
          ${x.status ? `<b class="fb-tag fb-${esc(x.status)}">${esc(LABEL[x.status] || x.status)}</b>` : `<span class="wl-meta">반응 미기록</span>`}</div>
        ${x.note ? `<div class="wl-sub">${esc(x.note)}</div>` : ""}
      </div></li>`).join("")}</ul>`;
  now.hidden = false;
}
