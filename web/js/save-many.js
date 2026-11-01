/* RDP 시편 아카이브 — 여러 시편 저장 (표 편집 · 칸반 · 찾아 바꾸기 · 값 통일 · 태그 관리가 같이 쓴다)
 *
 * 한 시편씩 차례로 평소 저장(PUT, rev 검사 · 서버 백업 · 변경 이력)을 한다.
 * 같은 시편의 저장은 inline.js 의 저장 줄에 세운다(내 저장끼리 409 가 나지 않게) — mutate 는 차례가 왔을 때의
 * 최신 사본에 적용된다. mutate(doc) 가 false 를 돌려주면 바뀐 게 없는 것으로 보고 저장하지 않는다.
 * 다른 곳에서 먼저 저장해 409 가 나면 서버 최신본으로 화면 사본을 바꾸고 실패로 알린다(다시 하면 된다).
 *
 * 되돌리기: 이 파일을 쓰는 화면을 지우면 된다. 저장한 내용은 시편 [이력]에서 되돌릴 수 있다.
 */
import { App, adoptServerCopy, apiPut, byId, clone, markSaved, revOf, toast } from "./core.js";
import { withSaveQueue } from "./inline.js";

/** 한 시편 저장 — 저장 줄(withSaveQueue) 안에서 불린다. 던지지 않고 결과를 돌려준다 */
async function saveOne({ pid, mutate, label }) {
  const p = byId(pid);
  if (!p) return { fail: "시편을 찾지 못했습니다", label: label || pid };
  const doc = clone(p);
  delete doc._file; delete doc._mtime; delete doc._sel;
  let changed;
  try { changed = mutate(doc); } catch (e) { return { fail: e.message, label: label || p.pattern.code }; }
  if (changed === false) return { skipped: true };
  try {
    const r = await apiPut(`/api/patterns/${encodeURIComponent(pid)}`, doc, revOf(p));
    const saved = markSaved(doc, r);
    saved._mtime = Date.now();
    const cur = byId(pid);
    if (cur && cur._sel) saved._sel = cur._sel;
    const k = App.patterns.indexOf(cur);
    if (k >= 0) App.patterns[k] = saved;
    return { ok: true };
  } catch (e) {
    if (e.status === 409) {
      adoptServerCopy(e);           // 화면 사본을 최신본으로 — 새로고침 없이 다시 할 수 있다
      return { fail: "다른 곳에서 먼저 저장됨 — 최신 내용으로 바꿨어요, 다시 해 주세요", label: label || p.pattern.code };
    }
    return { fail: e.message, label: label || p.pattern.code };
  }
}

/**
 * @param items [{pid, mutate(doc) => boolean|void, label?}]
 * @param onProgress (done, total) => void
 * @returns {ok:[pid], skipped:[pid], fails:[{pid, label, msg}]}
 */
export async function saveMany(items, onProgress) {
  const ok = [], skipped = [], fails = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // 같은 시편의 다른 저장(별점·인라인 편집·표 칸)이 진행 중이면 그 뒤에 선다 — 그래야 최신 버전 위에 고친다
    const r = await withSaveQueue(it.pid, () => saveOne(it));
    if (r.ok) ok.push(it.pid);
    else if (r.skipped) skipped.push(it.pid);
    else fails.push({ pid: it.pid, label: r.label, msg: r.fail });
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
