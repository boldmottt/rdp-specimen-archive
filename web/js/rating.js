/* RDP 시편 아카이브 — 별점(1~5)·깃발 (컬러 단위)
 *
 * 별점은 오래 가는 평가(추천도), 깃발은 '이번에 고를 후보' 같은 임시 표시로 쓴다(Lightroom 관례).
 * 검색: rating:3+ · ★3 · flag:on (search.js), 표·칸반·스마트 폴더에서도 쓴다.
 * 같은 별을 다시 누르면 지운다. 저장은 인라인 저장 큐(inline.js)로 — 연달아 눌러도 순서대로.
 *
 * 되돌리기: 카드·상세의 rateHTML 자리와 이 파일을 지우면 된다(저장된 rating·flag 는 남아도 무해).
 */
import { $$, byId, esc } from "./core.js";
import { inlineSave } from "./inline.js";

const varOfId = (p, vid) => (p && (p.variations || []).find((v) => v.id === vid)) || null;

export function rateHTML(pid, vid, small) {
  const v = varOfId(byId(pid), vid);
  const r = Number((v && v.rating) || 0), f = !!(v && v.flag);
  return `<span class="rate${small ? " sm" : ""}${r || f ? " has" : ""}" data-rate="${esc(pid)}::${esc(vid)}">
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="st${n <= r ? " on" : ""}" data-star="${n}" aria-label="별 ${n}개" title="별 ${n}개 (같은 별을 다시 누르면 지움)">★</button>`).join("")}
      <button type="button" class="fl${f ? " on" : ""}" data-flag="1" aria-pressed="${f}" title="깃발 — 이번에 고를 후보 같은 임시 표시">⚑</button>
    </span>`;
}

/** root 안의 별점·깃발에 이벤트를 붙인다. onSaved(pid) 는 저장 뒤 다시 그리기 */
export function bindRate(root, onSaved) {
  $$("[data-rate]", root).forEach((box) => {
    const [pid, vid] = box.dataset.rate.split("::");
    const paint = () => {
      const v = varOfId(byId(pid), vid);
      const r = Number((v && v.rating) || 0), f = !!(v && v.flag);
      box.querySelectorAll("[data-star]").forEach((b) => b.classList.toggle("on", Number(b.dataset.star) <= r));
      const fl = box.querySelector("[data-flag]");
      fl.classList.toggle("on", f); fl.setAttribute("aria-pressed", String(f));
      box.classList.toggle("has", !!(r || f));
    };
    const save = (mut) => inlineSave(pid, (d) => {
      const v = (d.variations || []).find((x) => x.id === vid);
      if (!v) return false;
      mut(v);
      return true;
    }).then(() => { paint(); if (onSaved) onSaved(pid); });
    box.querySelectorAll("[data-star]").forEach((b) => (b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const n = Number(b.dataset.star);
      save((v) => { if (Number(v.rating || 0) === n) delete v.rating; else v.rating = n; });
    }));
    box.querySelector("[data-flag]").onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      save((v) => { if (v.flag) delete v.flag; else v.flag = true; });
    };
  });
}
