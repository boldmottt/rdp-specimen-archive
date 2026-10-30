/* RDP 시편 아카이브 — 다중 선택 · 일괄 편집 · CSV 내보내기 (화면 담당)
 *
 * 규칙은 bulk-rules.js 에 있다(무엇이 바뀌는지·CSV 형식). 이 파일은 화면과 저장만 맡는다.
 * catalog.js 와 서로 import 하지 않는다 — 필요한 데이터는 인자로 받는다(순환 import 회피).
 *
 * 선택은 "패턴(시편) 단위"다. 컬러 단위로 고르면 같은 문서에 PUT 이 두 번 나가 409 가 난다
 * (서버는 저장할 때마다 rev 를 올린다). 컬러 범위는 대화상자에서 고른다:
 *   "검색에 맞는 컬러만" = 지금 검색이 남긴 컬러(HITS) / "모든 컬러"
 *
 * 되돌리기: 이 파일을 지우고 catalog.js 의 선택 관련 3줄(체크박스·선택 바·bindPicks)을 빼면 원상복구.
 * 데이터는 PUT 저장이라 서버 _backup 에 이전 파일이 남는다(자동 백업).
 */
import { $, App, apiPut, byId, clone, esc, markSaved, revOf, toast, vName } from "./core.js";
import { applySpec, BULK_HINT, csvRows, csvText, scopeVids } from "./bulk-rules.js";
import { workOf } from "./work.js";

let lastPick = -1;          // Shift 범위 선택의 시작점 (지금 보이는 순서 기준)

/** 카드 체크박스에 이벤트를 붙인다. order = 지금 보이는 패턴 id 순서(화면 순서), rerender = 다시 그리기 */
export function bindPicks(order, rerender) {
  const picks = Array.from(document.querySelectorAll("[data-pick]"));
  picks.forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const pid = el.dataset.pick;
      const i = order.indexOf(pid);
      if (e.shiftKey && lastPick >= 0) {
        const [a, b] = [Math.min(lastPick, i), Math.max(lastPick, i)];
        order.slice(a, b + 1).forEach((x) => App.sel.add(x));
      } else if (App.sel.has(pid)) App.sel.delete(pid);
      else App.sel.add(pid);
      lastPick = i;
      rerender();
    };
  });
  const clear = $("#sel-clear");
  if (clear) clear.onclick = () => { App.sel.clear(); lastPick = -1; rerender(); };
  // '일괄 편집' 버튼은 catalog.js 가 검색 범위(hitsOf)와 함께 연결한다 — 여기서 범위 없이 붙이면
  //   '검색에 맞는 컬러만'이 아무것도 못 고르는 대화상자가 된다
}

/** 선택 바 HTML — 아무것도 안 골랐으면 빈 문자열(자리도 차지하지 않는다) */
export function selectionBarHTML() {
  if (!App.sel.size) return "";
  return `<div class="selbar" id="selbar"><b>${App.sel.size}개 시편 선택</b>` +
    `<button class="tool" id="bulk-open">일괄 편집</button>` +
    `<button class="tool" id="sel-compare" title="고른 시편의 컬러를 나란히 (최대 4개)">나란히 비교</button>` +
    `<button class="tool" id="sel-clear">선택 해제</button>` +
    `<span class="selhint">Shift 로 범위 · Cmd/Ctrl 로 하나씩</span></div>`;
}


/** 바뀔 내용만 미리 계산한다(저장은 하지 않음).
 *  hidden: 지금 목록에 없어서 컬러 항목이 적용되지 않는 선택 시편 수 —
 *  검색을 바꾼 뒤 예전에 체크한 시편이 조용히 바뀌던 문제를 막고, 화면에도 알린다. */
function plan(spec, hitsOf) {
  const out = [];
  let hidden = 0;
  App.sel.forEach((pid) => {
    const p = byId(pid);
    if (!p) return;
    const hit = hitsOf ? hitsOf(pid) : null;
    if (spec.scope === "hits" && !Array.isArray(hit)) hidden++;
    const doc = clone(p);
    delete doc._file; delete doc._mtime; delete doc._sel;
    const n = applySpec(doc, spec, scopeVids(spec.scope, hit));
    if (n) out.push({ p, doc, n });
  });
  out.hidden = hidden;                    // 배열에 속성으로 붙여 호출부에서 읽는다(반환 모양 유지)
  return out;
}

/** 일괄 편집 대화상자. hitsOf(pid) = 지금 검색에 걸린 컬러 id 배열(없으면 null) */
export function openBulkDialog(rerender, hitsOf) {
  if (!App.sel.size) { toast("먼저 시편을 선택하세요"); return; }
  const statuses = [...new Set(App.patterns.flatMap((p) => (p.variations || []).map((v) => v.status)).filter(Boolean))];
  const projects = [...new Set(App.patterns.map((p) => p.project).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  let dlg = $("#bulk-dlg");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "bulk-dlg";
    document.body.appendChild(dlg);
  }
  dlg.className = "bulk-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>일괄 편집 · ${App.sel.size}개 시편</h3>
      <p class="bulk-hint">${esc(BULK_HINT.trim())}</p>
      <div class="bulk-grid">
        <label>프로젝트<input name="project" list="bulk-project" placeholder="비우면 그대로" autocomplete="off">
          <datalist id="bulk-project">${projects.map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label>
        <label>상태<input name="status" list="bulk-status" placeholder="비우면 그대로">
          <datalist id="bulk-status">${statuses.map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label>
        <label>Rev<input name="rev" placeholder="비우면 그대로"></label>
        <label>작업자<input name="worker" placeholder="비우면 그대로"></label>
        <label>양산 일정<input name="sop" placeholder="비우면 그대로"></label>
        <label>태그 추가<input name="tagsAdd" placeholder="쉼표로 구분"></label>
        <label>태그 제거<input name="tagsRemove" placeholder="쉼표로 구분"></label>
      </div>
      <div class="bulk-scope">
        <span>컬러 범위</span>
        <label><input type="radio" name="scope" value="hits" checked> 검색에 맞는 컬러만</label>
        <label><input type="radio" name="scope" value="all"> 모든 컬러</label>
      </div>
      <p class="bulk-pv" id="bulk-pv"></p>
      <div class="bulk-actions">
        <button type="button" class="btn-line" id="bulk-cancel">취소</button>
        <button type="button" class="btn-dark" id="bulk-go">적용</button>
      </div>
    </form>`;

  const f = dlg.querySelector("form");
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const read = () => ({
    project: f.project.value.trim(),
    status: f.status.value.trim(), rev: f.rev.value.trim(),
    worker: f.worker.value.trim(), sop: f.sop.value.trim(),
    tagsAdd: list(f.tagsAdd.value), tagsRemove: list(f.tagsRemove.value),
    scope: f.querySelector('input[name="scope"]:checked').value,
  });

  const pv = () => {
    const ps = plan(read(), hitsOf);
    const changed = ps.reduce((a, x) => a + x.n, 0);
    const hidden = ps.hidden ? ` · 선택한 ${ps.hidden}개는 지금 목록에 없어 컬러 항목은 빠집니다` : "";
    $("#bulk-pv").textContent = ps.length
      ? `${ps.length}개 시편 · ${changed}칸이 바뀝니다${hidden}`
      : (ps.hidden
        ? `선택한 ${ps.hidden}개 시편이 지금 목록에 없습니다 — 검색을 지우거나 '모든 컬러'를 고르세요`
        : "바뀌는 칸이 없습니다 (값을 적어 주세요)");
  };
  f.oninput = pv;
  pv();

  $("#bulk-cancel").onclick = () => dlg.close();
  $("#bulk-go").onclick = async () => {
    const spec = read();
    const ps = plan(spec, hitsOf);
    if (!ps.length) { toast("바뀌는 칸이 없습니다"); return; }
    const go = $("#bulk-go");
    go.disabled = true;
    go.textContent = "저장 중…";
    const fails = [];
    const failedPids = [];
    let ok = 0;
    // 패턴당 PUT 1회, 순차. 저장할 때마다 rev 가 올라가므로 반드시 응답의 새 rev 를 반영한다.
    for (const { p, doc } of ps) {
      try {
        const r = await apiPut(`/api/patterns/${encodeURIComponent(p.id)}`, doc, revOf(p));
        const saved = markSaved(doc, r);
        saved._sel = p._sel;
        saved._mtime = Date.now();
        const i = App.patterns.findIndex((x) => x.id === p.id);
        if (i >= 0) App.patterns[i] = saved;
        App.sel.delete(p.id);
        ok++;
      } catch (e) {
        failedPids.push(p.id);
        fails.push(`${p.pattern.code}: ${e.status === 409 ? "다른 곳에서 먼저 저장됨 — 새로고침 후 다시" : e.message}`);
      }
    }
    dlg.close();
    if (fails.length) {
      // 실패한 시편만 다시 선택 — 패턴 코드 앞부분 비교(startsWith)는 G-51208 이 성공한
      // G-51208-T1 까지 잡으므로, 실패한 pid 로 정확히 비교한다.
      App.sel.clear();
      failedPids.forEach((pid) => App.sel.add(pid));
      alert(`${ok}건 반영, ${fails.length}건 실패\n\n${fails.join("\n")}`);
    } else {
      toast(`${ok}건 반영`);
    }
    rerender();
  };
  dlg.showModal();
}

/** 지금 목록(검색에 걸린 것)을 CSV 로 내려받는다. vidsOf(pid) = 걸린 컬러 id */
export function downloadCsv(list, vidsOf) {
  const rows = csvRows(list, vidsOf, vName, workOf);   // 컬러별 유효 작업정보까지 내보낸다
  if (rows.length <= 1) { toast("내보낼 시편이 없습니다"); return; }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const a = document.createElement("a");
  const url = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }));
  a.href = url;
  a.download = `RDP-시편-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${rows.length - 1}행 내보냄`);
}
