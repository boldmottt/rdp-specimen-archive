/* RDP 시편 아카이브 — 상세 화면 인라인 편집 */
import { App, apiPut, byId, clone, colorNameFor, markSaved, revOf, toast, varOf } from "./core.js";
import { renderDetail } from "./detail.js";
import { openEditor } from "./editor.js";

/* ---------------- inline edit ---------------- */
const saveChain = new Map();
function queueSave(pid, fn) {
  const prev = saveChain.get(pid) || Promise.resolve();
  const next = prev.then(fn, fn);
  saveChain.set(pid, next.catch(() => {}));
  return next;
}

export async function inlineSave(pid, mutate) {
  return queueSave(pid, () => doInlineSave(pid, mutate));
}

// 그 시편의 인라인 저장이 끝날 때까지 기다린다 — 메모를 고치다 바로 [편집]을 누르면
// 편집기가 저장 전 버전으로 열려, 편집기에서 저장할 때 내 저장과 '충돌'(409)이 났다
export function inlineSettled(pid) {
  return saveChain.get(pid) || Promise.resolve();
}

async function doInlineSave(pid, mutate) {
  const p = byId(pid);
  if (!p) return;
  const draft = clone(p);
  delete draft._file; delete draft._mtime;
  if (mutate(draft) === false) return;
  const payload = {};
  Object.keys(draft).forEach((k) => { if (!k.startsWith("_")) payload[k] = draft[k]; });
  try {
    const r = await apiPut(`/api/patterns/${encodeURIComponent(pid)}`, payload, revOf(p));
    const saved = markSaved(draft, r);
    saved._mtime = Date.now();
    const i = App.patterns.findIndex((x) => x.id === pid);
    if (i >= 0) App.patterns[i] = saved;
    toast("저장됨");
  } catch (e) {
    if (e.status === 409) toast("다른 곳에서 먼저 저장되었습니다 — 새로고침하세요");
    else toast("저장 실패: " + e.message);
  }
}

export function startInline(el, pid, vid) {
  if (el.dataset.editing) return;
  const path = el.dataset.f;
  if ((path === "project" || path === "pattern.code") && pid !== "__new__") {
    // 인라인으로 바꾸면 파일 ID·DB 키와 어긋난다 → ID 변경 흐름이 있는 편집기로 보낸다
    toast("프로젝트/패턴 코드는 편집기에서 바꿉니다 (파일 ID도 함께 변경)");
    openEditor(pid, vid);
    return;
  }
  const isVar = path.startsWith("v.");
  const rel = isVar ? path.slice(2) : path;
  const isNewMode = !!App.newDraft && pid === "__new__";
  const p = isNewMode ? App.newDraft : byId(pid);
  const v = isNewMode ? (p.variations || [])[0] : varOf(p, vid);
  const src = isVar ? v : p;
  if (!src) return;
  let cur = rel.split(".").reduce((a, k) => (a == null ? null : a[k]), src);
  if (Array.isArray(cur)) cur = cur.join(", ");
  const prev = el.innerHTML;
  const multi = /note|remark/.test(rel);
  el.dataset.editing = "1";
  el.innerHTML = multi ? '<textarea class="inline-input" rows="3"></textarea>' : '<input class="inline-input">';
  const inp = el.firstElementChild;
  inp.value = cur == null ? "" : String(cur);
  if (path === "v.colorName") inp.placeholder = "컬러명 (비우면 컬러코드로 표시)";
  if (path === "v.colorCode") inp.placeholder = "컬러코드";
  inp.focus();
  if (/label\.type$/.test(path) && inp.setSelectionRange) {
    const n = inp.value.length;
    inp.setSelectionRange(n, n);   // 접두어 뒤에 바로 숫자만 치도록 커서를 끝에
  } else if (inp.select) inp.select();

  const restore = () => { delete el.dataset.editing; el.innerHTML = prev; };
  const commit = async () => {
    if (!el.dataset.editing) return;
    const val = inp.value.trim();
    restore();
    if ((cur == null ? "" : String(cur)) === val) return;
    if (isNewMode) {
      const tgt = isVar ? (p.variations || [])[0] : p;
      if (!tgt) return;
      const keys = rel.split(".");
      let o = tgt;
      for (let i = 0; i < keys.length - 1; i++) {
        if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
        o = o[keys[i]];
      }
      o[keys[keys.length - 1]] = /plate/i.test(rel) ? val.split(",").map((x) => x.trim()).filter(Boolean) : val;
      if (isVar && rel === "colorCode" && val && !String(tgt.colorName || "").trim()) {
        const nm = colorNameFor(val);
        if (nm) tgt.colorName = nm;
      }
      renderDetail("__new__", null, App.newDraft);
      return;
    }
    await inlineSave(pid, (d) => {
      const tgt = isVar ? (d.variations || []).find((x) => x.id === v.id) : d;
      if (!tgt) return false;
      const keys = rel.split(".");
      let o = tgt;
      for (let i = 0; i < keys.length - 1; i++) {
        if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
        o = o[keys[i]];
      }
      let out = val;
      if (isVar && keys[0] === "label" && val === "") {
        delete o[keys[keys.length - 1]];
        if (tgt.label && !Object.keys(tgt.label).length) delete tgt.label;
        return true;
      }
      if (/label\.type$/.test(rel) && /^Padprint Layer$/i.test(val)) toast("구분에 도수 숫자가 없습니다 (Padprint Layer)");
      if (isVar && rel === "colorCode" && val && !String(tgt.colorName || "").trim()) {
        const nm = colorNameFor(val);
        if (nm) { tgt.colorName = nm; toast(`컬러명 자동 입력: ${nm}`); }
      }
      if (/date$/i.test(rel) && val) {
        const m2 = /^(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})$/.exec(val.replace(/\s/g, ""));
        if (!m2) { toast("날짜는 2026-10-22 형식으로 입력하세요"); return false; }
        out = `${m2[1]}-${m2[2]}-${m2[3]}`;
      }
      o[keys[keys.length - 1]] = /plate/i.test(rel)
        ? val.split(",").map((s) => s.trim()).filter(Boolean)
        : out;
      return true;
    });
    renderDetail(pid, v.id);
  };
  inp.onblur = commit;
  inp.onkeydown = (e) => {
    if (e.key === "Enter" && !multi) { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { e.preventDefault(); inp.onblur = null; restore(); }
  };
}
