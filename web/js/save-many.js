/* RDP 시편 아카이브 — 여러 시편 저장 (표 편집 · 칸반 · 찾아 바꾸기 · 값 통일 · 태그 관리가 같이 쓴다)
 *
 * 한 시편씩 차례로 평소 저장(PUT, rev 검사 · 서버 백업 · 변경 이력)을 한다.
 * 같은 시편의 인라인 저장이 진행 중이면 끝나길 기다린다(내 저장끼리 409 가 나지 않게).
 * mutate(doc) 가 false 를 돌려주면 바뀐 게 없는 것으로 보고 저장하지 않는다.
 *
 * 되돌리기: 이 파일을 쓰는 화면을 지우면 된다. 저장한 내용은 시편 [이력]에서 되돌릴 수 있다.
 */
import { App, apiPut, byId, clone, markSaved, revOf, toast } from "./core.js";
import { inlineSettled } from "./inline.js";

/**
 * @param items [{pid, mutate(doc) => boolean|void, label?}]
 * @param onProgress (done, total) => void
 * @returns {ok:[pid], skipped:[pid], fails:[{pid, label, msg}]}
 */
export async function saveMany(items, onProgress) {
  const ok = [], skipped = [], fails = [];
  for (let i = 0; i < items.length; i++) {
    const { pid, mutate, label } = items[i];
    await inlineSettled(pid);
    const p = byId(pid);
    if (!p) { fails.push({ pid, label: label || pid, msg: "시편을 찾지 못했습니다" }); continue; }
    const doc = clone(p);
    delete doc._file; delete doc._mtime; delete doc._sel;
    let changed;
    try { changed = mutate(doc); } catch (e) { fails.push({ pid, label: label || p.pattern.code, msg: e.message }); continue; }
    if (changed === false) { skipped.push(pid); if (onProgress) onProgress(i + 1, items.length); continue; }
    try {
      const r = await apiPut(`/api/patterns/${encodeURIComponent(pid)}`, doc, revOf(p));
      const saved = markSaved(doc, r);
      saved._mtime = Date.now();
      if (p._sel) saved._sel = p._sel;
      const k = App.patterns.indexOf(p);
      if (k >= 0) App.patterns[k] = saved;
      ok.push(pid);
    } catch (e) {
      fails.push({ pid, label: label || p.pattern.code, msg: e.status === 409 ? "다른 곳에서 먼저 저장됨 — 새로고침 후 다시" : e.message });
    }
    if (onProgress) onProgress(i + 1, items.length);
  }
  return { ok, skipped, fails };
}

/** 결과 알림 — 실패가 있으면 목록을 보여 준다 */
export function reportSave(res, what = "시편") {
  if (res.fails.length) {
    alert(`${res.ok.length}개 ${what} 저장, ${res.fails.length}개 실패\n\n${res.fails.map((f) => `${f.label}: ${f.msg}`).join("\n")}`);
  } else if (res.ok.length) {
    toast(`${res.ok.length}개 ${what} 저장했습니다 — 시편 [이력]에서 되돌릴 수 있어요`, 3000);
  } else {
    toast("바뀐 것이 없습니다");
  }
}
