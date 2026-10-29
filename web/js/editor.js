/* RDP 시편 아카이브 — 편집 서랍 (기본 · 컬러 · 배합 · 이미지 · JSON) */
import { $, $$, App, RESULT_LABEL, apiDelete, apiGet, apiPost, apiPut, byId, clone, colorNameFor, deriveId, esc, imgUrl, markSaved, normalizeDoc, revOf, saveLS, toast, todayLocal, vName } from "./core.js";
import { renderCatalog } from "./catalog.js";
import { addInkTag, bindRecipePreviews, inkInfo, inkLabel, inkOrder, inkPool, labOf, labText, labToCss, layerCodeOf, layerPlate, loadInkCatalog, mixTable, platePatterns, setLayerPlate, syncLayerPlates } from "./detail.js";
import { renderCart } from "./proposal.js";
// 태그 자동완성 — 기존 태그를 골라 넣게 한다 (web/js/search.js)
import { bindTagInput } from "./search.js";
import { startCrop } from "./crop.js";
import { rerender } from "./main.js";

/* ---------------- editor drawer ---------------- */
export const E = { draft: null, vIdx: 0, tab: "base", pid: null, isNew: false, msg: "" };

export function openEditor(pid, vid) {
  E.isNew = !pid;
  E.pid = pid;
  E.baseRev = pid ? revOf(byId(pid)) : "";
  E.draft = pid ? clone(byId(pid)) : newDoc();
  if (pid) { delete E.draft._file; delete E.draft._mtime; }
  E.vIdx = Math.max(0, E.draft.variations.findIndex((v) => v.id === vid));
  if (E.vIdx < 0) E.vIdx = 0;
  E.tab = "base"; E.msg = ""; E.origJson = JSON.stringify(E.draft); E.jsonErr = null;
  $("#drawer-title").textContent = pid ? byId(pid).pattern.code + " 편집" : "새 시편";
  syncTabs();
  renderDrawer();
  E.returnFocus = document.activeElement;
  $("#drawer").classList.add("on"); $("#drawer-scrim").classList.add("on");
  $("#drawer-close").focus({ preventScroll: true });
}
function isDirty() {
  return !!(E.draft && E.origJson && JSON.stringify(E.draft) !== E.origJson);
}

export function closeEditor(force) {
  if (!force && isDirty()) {
    if (!confirm("저장하지 않은 변경이 있습니다. 닫을까요?")) return;
  }
  $("#drawer").classList.remove("on"); $("#drawer-scrim").classList.remove("on");
  E.draft = null; E.origJson = null;
  const rf = E.returnFocus; E.returnFocus = null;
  if (rf && rf.isConnected) rf.focus({ preventScroll: true });
}
export function syncTabs() { $$("#drawer-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === E.tab)); }

function nextVarId(d) {
  const nums = (d.variations || []).map((v) => {
    const m = /^v(\d+)$/.exec(v.id || "");
    return m ? Number(m[1]) : 0;
  });
  const maxUsed = Math.max(0, ...nums);
  const seq = Math.max(Number(d.nextVarSeq || 0), maxUsed + 1);
  d.nextVarSeq = seq + 1;
  return "v" + String(seq).padStart(2, "0");
}

export function newDoc() {
  return {
    schemaVersion: 2, id: "", project: "", projectName: "", client: "",
    nextVarSeq: 2,
    pattern: { code: "", name: "", nameKo: "", tags: [] },
    label: { item: "Design Sample", type: "Padprint Layer ", supplier: "NIFCO KOREA", remark: "" },
    work: { place: "", worker: "", machine: "", plate: [], emboss: "", pad: "", sop: "", volume: "" },
    variations: [{ id: "v01", colorName: "", colorCode: "", coating: [], status: "", date: todayLocal(), images: [], mixes: [], note: "" }],
    history: [],
  };
}

// 라벨 정리: 구분 끝 공백 제거, 컬러 라벨의 빈 값은 키째 지워서 공통 라벨을 쓰게 한다
// 다른 컬러로 복사하는 배합: 배치번호·결과·기준을 비워 DB에서 원본과 같은 행으로 잡히지 않게
function freshCopy(m, existing) {
  const c = clone(m);
  c.isReference = false; c.result = ""; c.date = todayLocal();
  delete c._id; delete c.plateFrom;
  // 배합 이름(batch)은 그대로 가져가되, 같은 컬러에 같은 도수·이름이 이미 있으면 -2, -3 …
  const list = existing || [];
  const same = (x, b) => (x.layer || "") === (c.layer || "") && (x.batch || "") === b;
  if (c.batch && list.some((x) => same(x, c.batch))) {
    const base = c.batch;
    let n = 2;
    while (list.some((x) => same(x, base + "-" + n))) n++;
    c.batch = base + "-" + n;
  }
  return c;
}

function tidyLabels(d) {
  const trimType = (lb) => { if (lb && typeof lb.type === "string") lb.type = lb.type.trim(); };
  trimType(d.label);
  (d.variations || []).forEach((vv) => {
    if (!vv.label || typeof vv.label !== "object") { delete vv.label; return; }
    trimType(vv.label);
    Object.keys(vv.label).forEach((k) => { if (vv.label[k] == null || String(vv.label[k]).trim() === "") delete vv.label[k]; });
    if (!Object.keys(vv.label).length) delete vv.label;
  });
}

function fieldRow(label, key, opts) {
  const o = opts || {};
  const val = key.split(".").reduce((a, k) => (a == null ? "" : a[k]), E.draft) ?? "";
  const v = Array.isArray(val) ? val.join(", ") : val;
  if (o.type === "textarea") return `<div class="field-row"><label>${label}</label><textarea data-k="${key}" placeholder="${o.ph || ""}">${esc(v)}</textarea></div>`;
  if (o.type === "date") return `<div class="field-row"><label>${label}</label><input type="date" data-k="${key}" value="${esc(String(v).replace(/\./g, "-").slice(0, 10))}"></div>`;
  if (o.type === "select") return `<div class="field-row"><label>${label}</label><select data-k="${key}">${o.options.map((x) => `<option value="${esc(x)}"${x === v ? " selected" : ""}>${esc(x || "—")}</option>`).join("")}</select></div>`;
  return `<div class="field-row"><label>${label}</label><input data-k="${key}" value="${esc(v)}" placeholder="${o.ph || ""}" ${o.mono ? 'style="font-family:var(--mono);font-size:12px"' : ""}></div>`;
}

// 미리보기는 서버에 저장된 시편으로 계산한다 — 편집기가 보고 있는 버전과 다르면(다른 탭·PC에서 저장) 보내지 않는다
function staleDraft(pv) {
  if (!pv.rev || !E.baseRev || pv.rev === E.baseRev) return false;
  toast("다른 곳에서 이 시편이 바뀌었어요 — 편집기를 닫고 다시 열어 최신 내용을 확인한 뒤 보내세요");
  return true;
}

function pushPanel(pv) {
  if (pv.ink_errors && pv.ink_errors.length) {
    return `<div class="push-panel"><div class="pp-blocked">${esc(pv.blocked)}</div><ul>${pv.ink_errors.map((x) => `<li>${esc(x.vid || "")} · ${esc(x.layer || "")} ${esc(x.batch || "-")}: ${esc(x.reason)}</li>`).join("")}</ul><div class="pp-actions"><button class="mini-btn" id="pp-cancel">닫기</button><a href="/lab/#/library" target="_blank" rel="noopener">컬러연구소에서 DB 연결 설정</a><button class="mini-btn" disabled>전체 전송 차단</button></div></div>`;
  }
  if (pv.blocked) {
    const rf = pv.renamedFrom || {};
    return `<div class="push-panel">
        <div class="pp-blocked">${esc(pv.blocked)}</div>
        <div class="pp-actions">
          <button class="mini-btn" id="pp-cancel">취소</button>
          <button class="mini-btn" id="pp-ignore" title="DB의 옛 행은 그대로 두고, 이 시편은 새 코드로 따로 보냅니다">옛 행은 두고 새 코드로</button>
          <button class="mini-btn danger" id="pp-renamedb" title="DB 백업 후 옛 코드 행을 새 코드로 바꿉니다">DB 코드도 변경 (${esc(rf.code || "")} 행 ${rf.rows || 0}개)</button>
          <button class="mini-btn danger" id="pp-ok" disabled>DB에 반영</button>
        </div>
      </div>`;
  }
  const upd = pv.updates || [], ins = pv.inserts || [], sk = pv.skipped || [], mv = pv.moves || [], sh = pv.shared || [];
  const multi = new Set([...upd, ...ins].map((x) => x.vid)).size > 1;
  const tag = (x) => (multi && x.vid ? `<span class="pp-skip">${esc(x.vid)}</span> ` : "");
  const rows = [];
  // 이동: 예전 코드·동판으로 들어간 DB 행을 새 행 대신 옮긴다 (코드와 동판이 함께 바뀌었으면 둘 다)
  const moveText = (x) => [x.from !== x.to ? `패턴 코드 ${esc(x.from)} → <b>${esc(x.to)}</b>` : "",
    x.fromPlate && x.fromPlate !== x.toPlate ? `동판 ${esc(x.fromPlate)} → <b>${esc(x.toPlate)}</b>` : ""].filter(Boolean).join(" · ");
  mv.forEach((x) => rows.push(`<li><b>${esc(x.batch)}</b> ${tag(x)}<span class="pp-f">${esc(x.layer || "")} ${moveText(x)} 이동</span></li>`));
  const fieldText = (f) => (f.name === "is_base" ? `기준 배합 ${f.from ? "기준" : "아님"} → <b>${f.to ? "기준" : "아님"}</b>`
    : `${esc(f.name)} ${esc(String(f.from))} → <b>${esc(String(f.to))}</b>`);
  upd.forEach((u) => rows.push(`<li><b>${esc(u.batch)}</b> ${tag(u)}<span class="pp-f">${u.fields.map(fieldText).join(", ")}</span></li>`));
  ins.forEach((i) => rows.push(`<li><b>${esc(i.batch)}</b> ${tag(i)}<span class="pp-f">신규 배합 (${esc(i.code || "")} · ${esc(i.layer || "")} · ${esc(i.plate)})</span></li>`));
  const n = rows.length;
  sh.forEach((x) => rows.push(`<li class="pp-skip"><b>${esc(x.batch || "-")}</b> ${esc(x.vid || "")} 공유 — ${esc(x.reason || "")}</li>`));
  sk.forEach((x) => rows.push(`<li class="pp-skip"><b>${esc(x.batch || "-")}</b> ${esc(x.vid || "")} 건너뜀 — ${esc(x.reason || "")}</li>`));
  const shown = rows.slice(0, 14).join("");
  const more = rows.length > 14 ? `<li class="pp-more">외 ${rows.length - 14}건</li>` : "";
  return `<div class="push-panel">
      <div class="pp-head">DB에 반영할 변경 — ${mv.length ? `이동 <b>${mv.length}</b> · ` : ""}수정 <b>${upd.length}</b> · 신규 <b>${ins.length}</b>${sh.length ? ` · 공유 배합 ${sh.length}` : ""}${sk.length ? ` · 건너뜀 ${sk.length}` : ""}</div>
      ${rows.length ? `<ul>${shown}${more}</ul>` : ""}${n ? "" : `<div class="pp-empty">반영할 변경이 없습니다</div>`}
      <div class="pp-actions">
        <button class="mini-btn" id="pp-cancel">취소</button>
        <button class="mini-btn danger" id="pp-ok" ${n ? "" : "disabled"}>DB에 반영</button>
      </div>
    </div>`;
}

function renderVars() {
  const el = $("#drawer-vars");
  if (!el) return;
  const d = E.draft;
  const vars = (d && d.variations) || [];
  if (vars.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="dv-label">샘플</span>` + vars.map((x, i) =>
    `<button class="dv${i === E.vIdx ? " on" : ""}" data-vsw="${i}" title="${esc(vName(x))}">${esc(vName(x) || "샘플 " + (i + 1))}${x.colorCode && vName(x) !== x.colorCode ? `<i>${esc(x.colorCode)}</i>` : ""}</button>`).join("");
  $$("[data-vsw]").forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.vsw);
    if (i === E.vIdx) return;
    E.vIdx = i;
    renderVars();
    renderDrawer();
  }));
}

export function renderDrawer() {
  const d = E.draft;
  renderVars();
  let body = "";
  if (E.tab === "base") {
    body = `<div class="sec-label">패턴</div>
        ${fieldRow("프로젝트", "project", { ph: "PJ01" })}
        ${fieldRow("차종명", "projectName", { ph: "PJ01 (차종명)" })}
        ${fieldRow("고객", "client", { ph: "고객사" })}
        ${fieldRow("패턴 코드", "pattern.code", { ph: "WB7", mono: true })}
        ${fieldRow("영문명", "pattern.name", { ph: "Wood" })}
        ${fieldRow("한글명", "pattern.nameKo", { ph: "우드" })}
        ${fieldRow("태그", "pattern.tags", { ph: "우드, 엠보, 도어" })}
        <div class="sec-label">라벨</div>
        ${fieldRow("품목", "label.item", { ph: "Design Sample" })}
        ${fieldRow("구분", "label.type", { ph: "Padprint Layer 1" })}
        ${fieldRow("공급사", "label.supplier", { ph: "NIFCO KOREA" })}
        ${fieldRow("비고", "label.remark")}
        <div class="sec-label">작업</div>
        ${fieldRow("작업 장소", "work.place")}
        ${fieldRow("작업자", "work.worker")}
        ${fieldRow("설비", "work.machine")}
        ${fieldRow("동판", "work.plate", { ph: "26_027, 26_045" })}
        <div class="field-row"><label>엠보</label><input data-k="work.emboss" list="emboss-list" value="${esc((E.draft.work && E.draft.work.emboss) || "")}" placeholder="평엠보 · 사용한 값은 다시 고를 수 있습니다"><datalist id="emboss-list">${Array.from(new Set(App.patterns.flatMap((pp) => [(pp.work || {}).emboss]).filter(Boolean))).map((x) => `<option value="${esc(x)}">`).join("")}</datalist></div>
        ${fieldRow("패드", "work.pad")}
        ${fieldRow("양산 일정", "work.sop", { ph: "2027-01" })}
        ${fieldRow("생산 수량", "work.volume")}
        ${E.isNew ? "" : `<div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--line)"><button class="mini-btn danger" id="del-pattern">이 시편 삭제</button> <span style="font-size:11px;color:#8d9198">삭제하면 _trash로 이동합니다</span></div>`}`;
  }

  if (E.tab === "var") {
    const v = d.variations[E.vIdx];
    const list = d.variations.map((x, i) => `<div class="var-item${i === E.vIdx ? " on" : ""}" data-vidx="${i}">
        ${x.images && x.images.length ? `<img src="${imgUrl(d.id, x.images[0])}" alt="">` : '<div style="width:64px;height:26px;border-radius:5px;background:#eceae5"></div>'}
        <div class="vi-t"><b>${esc(x.id)}</b><span>${esc(vName(x))} ${x.colorCode ? "· " + esc(x.colorCode) : ""}</span></div>
      </div>`).join("");
    body = `<div class="sec-label">베리에이션 (${d.variations.length})</div>
        <div class="var-list">${list}</div>
        <div style="display:flex;gap:6px;margin-bottom:16px">
          <button class="mini-btn" id="add-var">+ 추가</button>
          <button class="mini-btn" id="dup-var">복제</button>
          <button class="mini-btn danger" id="del-var" ${d.variations.length <= 1 ? "disabled" : ""}>삭제</button>
        </div>
        <div class="sec-label">선택된 베리에이션 (${esc(v.id)})</div>
        ${fieldRow("컬러명", "variations." + E.vIdx + ".colorName", { ph: "다크 브라운" })}
        ${fieldRow("컬러코드", "variations." + E.vIdx + ".colorCode", { ph: "K-1116S", mono: true })}
        ${fieldRow("상태", "variations." + E.vIdx + ".status", { ph: "가승인" })}
        ${fieldRow("작업일", "variations." + E.vIdx + ".date", { type: "date" })}
        ${fieldRow("Rev", "variations." + E.vIdx + ".rev", { ph: "0" })}
        ${fieldRow("메모", "variations." + E.vIdx + ".note", { type: "textarea", ph: "2도 톤 미세조정 단계" })}
        <div class="sec-label">이 샘플의 라벨 <span style="font-weight:400;color:#8d9198;font-size:10px">비우면 공통값을 씁니다 (패턴 코드·이름은 공통)</span></div>
        ${fieldRow("Company", "variations." + E.vIdx + ".label.company", { ph: d.client || "고객사" })}
        ${fieldRow("Project", "variations." + E.vIdx + ".label.project", { ph: d.project || "PJ01", mono: true })}
        ${fieldRow("품목", "variations." + E.vIdx + ".label.item", { ph: d.label.item || "Design Sample" })}
        ${fieldRow("구분", "variations." + E.vIdx + ".label.type", { ph: d.label.type || "Padprint Layer 1" })}
        ${fieldRow("공급사", "variations." + E.vIdx + ".label.supplier", { ph: d.label.supplier || "NIFCO KOREA" })}
        ${fieldRow("비고", "variations." + E.vIdx + ".label.remark", { ph: d.label.remark || "" })}
        <div class="sec-label">도장</div>
        ${(v.coating || []).map((c, ci) => `<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:8px">
          <div class="field-row"><label>제조사</label><input data-c="${ci}" data-cf="maker" value="${esc(c.maker || "")}"></div>
          <div class="field-row"><label>도료코드</label><input data-c="${ci}" data-cf="code" value="${esc(c.code || "")}" style="font-family:var(--mono);font-size:12px"></div>
          <div class="field-row"><label>LOT</label><input data-c="${ci}" data-cf="lot" value="${esc(c.lot || "")}"></div>
          <button class="mini-btn danger" data-delcoat="${ci}">이 도장 삭제</button>
        </div>`).join("")}
        <button class="mini-btn" id="add-coat">+ 도장 추가</button>`;
  }

  if (E.tab === "mixes") {
    const v = d.variations[E.vIdx];
    const linkedVar = v.sameAs ? (d.variations || []).find((x) => x.id === v.sameAs) : null;
    const layerNum = (l) => { const m = /(\d+)/.exec(String(l || "")); return m ? Number(m[1]) : 0; };
    // 화면용 순서만 따로 만든다 (데이터를 정렬하면 열기만 해도 '변경 있음'이 된다). data-mi는 원래 인덱스
    const order = (v.mixes || []).map((_, i) => i)
      .sort((a, b) => layerNum(v.mixes[a].layer) - layerNum(v.mixes[b].layer) || a - b);
    const usedInk = Array.from(new Set((v.mixes || []).flatMap((m) => Object.keys(m.inks || {}))));
    const inkCols = inkOrder(Array.from(new Set([...usedInk, ...(v._inkCols || [])])));
    const pool = inkPool();
    const showMatting = v._showMatting != null ? v._showMatting
      : (v.mixes || []).some((m) => m.mattingPct != null || m.mattingG != null);
    const head = `<tr><th></th><th>도수</th><th title="이 배합이 DB에 들어가는 동판 · 패턴 코드 (위 도수별 칸에서 정함)">동판·패턴</th><th>배합</th>${inkCols.map((c) => `<th>${inkLabel(c)}</th>`).join("")}${showMatting ? "<th>소광</th>" : ""}<th>신나</th><th>경화</th><th>실측 LAB</th><th>예상색</th><th>결과</th><th>기준</th><th></th></tr>`;
    const rows = order.map((mi) => [v.mixes[mi], mi]).map(([m, mi]) => `<tr data-mi="${mi}">
        <td><input type="checkbox" data-pick="${mi}" style="accent-color:#141517"></td>
        <td><input data-mf="layer" value="${esc(m.layer || "")}" style="width:44px"></td>
        <td class="mix-set${m.plate ? "" : " empty"}" title="DB 키: ${esc(layerCodeOf(d, v, m.layer))} · ${esc(m.layer || "")} · ${esc(m.plate || "동판 없음")}">${m.plate ? esc(m.plate) : "동판 없음"}<i>${esc(layerCodeOf(d, v, m.layer))}</i></td>
        <td><input data-mf="batch" value="${esc(m.batch || "")}" style="width:72px"></td>
        ${inkCols.map((c) => `<td><input data-mf="ink:${esc(c)}" value="${m.inks && m.inks[c] != null ? esc(m.inks[c]) : ""}" style="width:34px"></td>`).join("")}
        ${showMatting ? `<td><input data-mf="mattingG" value="${m.mattingG != null ? esc(m.mattingG) : ""}" placeholder="${m.mattingG == null && m.mattingPct != null ? esc(m.mattingPct) + "%" : ""}" style="width:36px"></td>` : ""}
        <td><input data-mf="thinnerG" value="${m.thinnerG != null ? esc(m.thinnerG) : ""}" placeholder="${m.thinnerG == null && m.thinnerPct != null ? esc(m.thinnerPct) + "%" : ""}" style="width:36px"></td>
        <td><input data-mf="hardenerG" value="${m.hardenerG != null ? esc(m.hardenerG) : ""}" placeholder="${m.hardenerG == null && m.hardenerPct != null ? esc(m.hardenerPct) + "%" : ""}" style="width:36px"></td>
        <td class="lab-cell">${(() => {
        const sce = m.labSce, sci = m.labSci;
        if (!sce && !sci) return `<button class="lab-btn empty" data-lab="${mi}" title="LAB 값 입력">+ LAB</button>`;
        const line = (k, lab) => (lab ? `<span class="lab-line"><i class="labsw" style="background:${labToCss(lab)}"></i>${k} ${esc(labText(lab))}</span>` : "");
        return `<button class="lab-btn" data-lab="${mi}" title="클릭해서 수정">${line("SCE", sce)}${line("SCI", sci)}</button>`;
      })()}</td>
        <td><button class="mini-btn" type="button" data-recipe-preview="${mi}">예상색</button></td>
        <td><select data-mf="result" style="width:74px">${Object.keys(RESULT_LABEL).map((k) => `<option value="${k}"${k === (m.result || "") ? " selected" : ""}>${RESULT_LABEL[k]}</option>`).join("")}</select></td>
        <td><input type="checkbox" data-mf="isReference" ${m.isReference ? "checked" : ""}></td>
        <td class="act"><button class="mini-btn danger" data-delmix="${mi}" title="배합 삭제" aria-label="배합 삭제">✕</button></td></tr>` +
      (E.labOpen === mi ? `<tr class="lab-edit"><td colspan="${11 + inkCols.length + (showMatting ? 1 : 0)}">
          <div class="lab-grid">
            ${["sce", "sci"].map((k) => {
            const lab = m["lab" + k[0].toUpperCase() + k.slice(1)] || {};
            return `<div class="lab-block">
                <span class="lab-k">${k.toUpperCase()}</span>
                <i class="labsw big" data-labsw="${mi}-${k}" style="background:${labToCss(lab) || "#eee"}"></i>
                <label>L<input data-labf="${mi}:${k}.L" value="${lab.L != null ? esc(lab.L) : ""}" inputmode="decimal"></label>
                <label>a<input data-labf="${mi}:${k}.a" value="${lab.a != null ? esc(lab.a) : ""}" inputmode="decimal"></label>
                <label>b<input data-labf="${mi}:${k}.b" value="${lab.b != null ? esc(lab.b) : ""}" inputmode="decimal"></label>
              </div>`;
          }).join("")}
            <button class="mini-btn" data-labclear="${mi}">LAB 지우기</button>
          </div></td></tr>` : "")).join("");
    body = `<div class="rdp-bar">
          <button class="mini-btn" id="rdpdiff">DB와 비교</button>
          <button class="mini-btn" id="rdpsync">DB에서 가져오기</button>
          <button class="mini-btn" id="rdppush">DB로 보내기</button>
          <span class="hint" id="rdpstat">${App.rdpStatus ? (App.rdpStatus.exists ? "DB 연결됨 · " + (App.rdpStatus.total || 0) + "행" : "DB 경로 없음") : "확인 중…"}</span>
        </div>
        ${E.push ? pushPanel(E.push) : ""}
        <div class="sec-label">배합 — ${esc(d.pattern.code || "")} / ${esc(vName(v))}</div>
        <div class="layer-plates">
          <span class="lp-head">패턴 <b>${esc(d.pattern.code)}</b> · 도수별 동판</span>
          ${Array.from(new Set((v.mixes || []).map((m) => m.layer).filter(Boolean)))
          .sort((a, b) => (parseInt(String(a), 10) || 0) - (parseInt(String(b), 10) || 0))
          .map((l) => {
          const plate = layerPlate(v, l);
          const list = plate ? platePatterns(plate) : [];
          return `<div class="lp-row"><span class="lp-l">${esc(l)}</span>
              <span class="lp-k">동판</span><input data-lp="${esc(l)}" value="${esc(plate)}" placeholder="동판 번호">
              <span class="lp-k">패턴</span><input class="lp-pat" data-lpat="${esc(l)}" value="${esc(((v.layerPatterns || {})[l]) || "")}" placeholder="${esc(list.length ? list.map((x) => x.label).join(" · ") : (d.pattern.code || ""))}" title="이 도수의 패턴 코드 — 이 도수 배합은 DB에 이 코드로 들어갑니다 (비우면 시편 코드)">
              <span class="lp-db" data-dbplate="${esc(plate)}" data-lplayer="${esc(l)}"></span></div>`;
        }).join("")}
        </div>
        <div class="ink-tags">
          <span class="it-head">잉크</span>
          <button class="itag${showMatting ? " on" : ""}" data-matttog="1" title="소광(매트) 열 켜기/끄기">소광</button>
          <span class="it-sep"></span>
          ${pool.map((t) => `<button class="itag${inkCols.includes(t) ? " on" : ""}" data-inkadd="${esc(t)}" title="${inkCols.includes(t) ? "이 컬러에 사용 중" : "이 컬러에 열 추가"}">${inkLabel(t)}</button>`).join("")}
          <input id="ink-new" placeholder="+ 정식명 또는 별칭" maxlength="80" autocomplete="off" list="shared-ink-names">
          <datalist id="shared-ink-names">${((App.inkCatalog && App.inkCatalog.inks) || []).flatMap((i) => [...new Set([i.name, i.short_name, ...i.aliases])].map((n) => `<option value="${esc(n)}" label="${esc(i.name)}"></option>`)).join("")}</datalist>
        </div>
        <div class="ink-note">태그를 누르면 이 컬러의 배합 열이 생깁니다. 한 번 쓴 잉크는 다음 시편에서도 태그로 나옵니다.
          약칭·별칭은 <a href="/lab/#/library" target="_blank" rel="noopener">컬러연구소 공통 잉크 목록</a>에서 관리합니다. 색상칩은 SCI 은폐 도막 측정색이며 배합 예상색과 다릅니다.
          <b>DB 미지원 잉크가 있으면 전체 전송을 차단</b>합니다. 회사 DB 연결을 명시적으로 지정하세요.
          <button type="button" class="mini-btn" id="reload-inks">잉크 목록 새로고침</button> ${esc(App.inkCatalogError)}
          배합은 <b>도수별 동판 · 패턴 코드</b>에 속해서 DB에도 그 패턴 코드로 들어갑니다.</div>
        <button type="button" class="mini-btn" id="normalize-ink-names">이 컬러의 별칭 정리·중량 합산</button>
        <div class="tbl-wrap" style="margin:8px -6px"><table class="mix-edit">${head}${rows}</table></div>
        <div style="display:flex;gap:6px;margin-top:12px">
          <button class="mini-btn" id="add-mix">+ 배합 추가</button>
          <button class="mini-btn" id="dup-mix">마지막 배합 복제</button>
          <button class="mini-btn" id="add-layer">+ 도수 추가</button>
        </div>
        ${d.variations.length > 1 ? `<div style="display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap">
          <span style="font-size:11px;color:#8d9198">체크한 배합을</span>
          <select id="move-to" style="border:1px solid var(--line-2);border-radius:7px;padding:5px 8px;font-size:11.5px">
            ${d.variations.filter((_, i) => i !== E.vIdx).map((x) => `<option value="${esc(x.id)}">${esc(vName(x))}</option>`).join("")}
          </select>
          <span style="font-size:11px;color:#8d9198">로</span>
          <button class="mini-btn" id="move-mix">이동</button>
          <button class="mini-btn" id="copy-mix">복제</button>
        </div>` : ""}
        <p style="font-size:11px;color:#8d9198;margin-top:14px">모든 값은 <b>g 단위</b>로 입력합니다(잉크·소광·신나·경화). 결과는 합격/조정/NG/예정 중 선택.</p>`;
    if (linkedVar) {
      body = `<div class="sameas-bar"><b>${esc(vName(linkedVar))}</b> 컬러와 <b>같은 배합</b>으로 지정되어 있습니다.
            <span class="muted">DB에는 ${esc(vName(linkedVar))} 한 벌만 들어갑니다.</span>
            <button class="mini-btn" id="unlink-same">직접 입력하기</button></div>`
        + ((linkedVar.mixes || []).length ? mixTable(linkedVar.mixes) : '<p style="color:#8d9198;font-size:12px">참조한 컬러에 배합이 없습니다.</p>');
    } else if ((d.variations || []).length > 1) {
      body = `<div class="sameas-bar muted">배합이 같고 도장 컬러만 다르면 복제하지 말고
            <select id="same-target">${d.variations.filter((x) => x.id !== v.id).map((x) => `<option value="${esc(x.id)}">${esc(vName(x))}</option>`).join("")}</select>
            <button class="mini-btn" id="link-same">동일 배합으로 지정</button></div>` + body;
    }
  }

  if (E.tab === "images") {
    const v = d.variations[E.vIdx];
    const cells = (v.images || []).map((name, i) => `<div class="img-cell${i === 0 ? " primary" : ""}">
        <img src="${imgUrl(d.id, name)}" alt="">
        <div class="ic-bar"><span>${i === 0 ? "대표" : "#" + (i + 1)}</span>
          <div style="display:flex;gap:4px">
            <button class="mini-btn" data-reimg="${i}">교체</button>
            <button class="mini-btn danger" data-delimg="${i}">삭제</button>
          </div></div></div>`).join("");
    body = `<div class="sec-label">이미지 — ${esc(vName(v))}</div>
        <p style="font-size:11.5px;color:#8d9198;margin:0 0 12px">모든 이미지는 170:70으로 잘라서 저장됩니다. 첫 번째가 대표 이미지입니다.</p>
        <div class="img-grid">${cells}</div>
        <div class="drop" id="addimg" style="margin-top:12px">+ 이미지 추가 (클릭해서 파일 선택)</div>
        <input type="file" id="fileinput" accept="image/*" style="display:none">`;
  }

  if (E.tab === "json") {
    body = `<div class="sec-label">JSON 직접 편집</div>
        <p style="font-size:11.5px;color:#8d9198;margin:0 0 10px">폼에 없는 필드를 고칠 때만 사용하세요. 저장 시 검증합니다.</p>
        <textarea class="json-area" id="jsonarea" spellcheck="false">${esc(JSON.stringify(E.draft, null, 2))}</textarea>`;
  }

  $("#drawer-body").innerHTML = body;
  // 태그 입력칸에 자동완성(기존 태그 + 지금 초안 태그). 입력칸은 fieldRow 가 data-k 로 만든다.
  if (E.tab === "base") bindTagInput($('#drawer-body [data-k="pattern.tags"]'), App.patterns.concat([E.draft]));
  if (E.tab === "mixes") {
    const variation = d.variations[E.vIdx];
    const source = variation.sameAs ? d.variations.find((x) => x.id === variation.sameAs) : variation;
    bindRecipePreviews($("#drawer-body"), source?.mixes || []);
    const refresh = $("#reload-inks");
    if (refresh) refresh.onclick = async () => {
      try { await loadInkCatalog(); renderDrawer(); toast("공통 잉크 목록을 새로 불러왔습니다"); }
      catch (e) { toast(App.inkCatalogError); }
    };
    const normalize = $("#normalize-ink-names");
    if (normalize) normalize.onclick = async () => {
      try {
        await loadInkCatalog();
        const changes = (variation.mixes || []).map((m) => {
          const inks = {};
          Object.entries(m.inks || {}).forEach(([n, g]) => {
            if (!Number.isFinite(Number(g)) || Number(g) < 0) throw new Error(`${n}: 중량을 확인하세요`);
            const key = inkInfo(n)?.name || n;
            inks[key] = (inks[key] || 0) + Number(g);
          });
          return inks;
        });
        if (!confirm("등록된 별칭을 정식명으로 바꾸고 같은 잉크의 중량을 합산할까요? 시편 저장 전에는 원본이 바뀌지 않습니다.")) return;
        variation.mixes.forEach((m, i) => { m.inks = changes[i]; });
        variation._inkCols = [...new Set((variation._inkCols || []).map((n) => inkInfo(n)?.name || n))];
        renderDrawer(); toast("별칭 정리 완료 — 저장을 눌러 반영하세요");
      } catch (e) { toast(e.message); }
    };
  }
  $("#drawer-msg").textContent = E.msg;
  $("#drawer-msg").className = "msg" + (E.msg && E.msg.indexOf("저장") === 0 ? "" : E.msg ? " err" : "");

  // bindings
  $$("[data-k]").forEach((el) => (el.oninput = () => {
    const path = el.dataset.k.split(".");
    let obj = E.draft;
    // 중간 객체가 없으면 만든다 (예: label이 없는 베리에이션의 variations.N.label.item)
    for (let i = 0; i < path.length - 1; i++) {
      if (obj[path[i]] == null || typeof obj[path[i]] !== "object") obj[path[i]] = {};
      obj = obj[path[i]];
    }
    const last = path[path.length - 1];
    let val = el.value;
    if (last === "tags" || last === "plate") val = val.split(",").map((s) => s.trim()).filter(Boolean);
    // 컬러 라벨은 비우면 키를 지워서 공통 라벨을 쓰게 한다
    if (path[0] === "variations" && path[2] === "label" && val.trim() === "") {
      delete obj[last];
      const vv = E.draft.variations[Number(path[1])];
      if (vv && vv.label && !Object.keys(vv.label).length) delete vv.label;
      return;
    }
    obj[last] = val;
    if (/^variations\.\d+\.colorCode$/.test(el.dataset.k) && String(val).trim()) {
      const vi = Number(String(el.dataset.k).split(".")[1]);
      const vv = (E.draft.variations || [])[vi];
      if (vv && !String(vv.colorName || "").trim()) {
        const nm = colorNameFor(val);
        if (nm) {
          vv.colorName = nm;
          const ni = document.querySelector(`[data-k="variations.${vi}.colorName"]`);
          if (ni) ni.value = nm;
        }
      }
    }
  }));

  if (E.tab === "var") {
    $$("[data-vidx]").forEach((el) => (el.onclick = () => { E.vIdx = Number(el.dataset.vidx); renderDrawer(); }));
    $("#add-var").onclick = () => {
      const src = d.variations[E.vIdx] || {};
      const nv = {
        id: nextVarId(d), colorName: "", colorCode: "", coating: [], status: "",
        date: todayLocal(), images: [], note: "",
        mixes: (src.mixes || []).map(freshCopy),
        layerPlates: clone(src.layerPlates || {}),
        layerPatterns: clone(src.layerPatterns || {}),
      };
      if (src.label) nv.label = clone(src.label);
      d.variations.push(nv);
      E.vIdx = d.variations.length - 1; renderDrawer();
      toast("앞 컬러의 라벨·배합을 복사했습니다 — 값과 배치번호를 입력하세요");
    };
    $("#dup-var").onclick = () => {
      const src = clone(d.variations[E.vIdx]);
      src.id = nextVarId(d);
      src.images = [];
      src.colorName = (src.colorName || "기본") + " 복사";
      src.mixes = (src.mixes || []).map(freshCopy);
      d.variations.push(src); E.vIdx = d.variations.length - 1; renderDrawer();
    };
    $("#del-var").onclick = () => {
      if (d.variations.length <= 1) return;
      if (!confirm(vName(d.variations[E.vIdx]) + " 베리에이션을 삭제할까요? 이미지는 유지됩니다.")) return;
      d.variations.splice(E.vIdx, 1); E.vIdx = 0; renderDrawer();
    };
    $$("[data-c]").forEach((el) => (el.oninput = () => {
      d.variations[E.vIdx].coating[Number(el.dataset.c)][el.dataset.cf] = el.value;
    }));
    $$("[data-delcoat]").forEach((el) => (el.onclick = () => {
      d.variations[E.vIdx].coating.splice(Number(el.dataset.delcoat), 1); renderDrawer();
    }));
    $("#add-coat").onclick = () => {
      const v = d.variations[E.vIdx];
      v.coating = v.coating || []; v.coating.push({ maker: "", code: "", lot: "" }); renderDrawer();
    };
  }

  if (E.tab === "mixes") {
    const v = d.variations[E.vIdx];
    $$("[data-lpat]").forEach((el) => {
      const h = () => {
        v.layerPatterns = v.layerPatterns || {};
        const val = el.value.trim();
        // 자동으로 잡힌 이름(placeholder)과 같으면 따로 저장하지 않는다 → 동판이 바뀌면 계속 따라감
        if (val && val !== el.placeholder) v.layerPatterns[el.dataset.lpat] = val;
        else delete v.layerPatterns[el.dataset.lpat];
      };
      el.oninput = h; el.onchange = h;
      // 비어 있으면 회색 안내 문구(자동 패턴명)를 실제 값으로 채워서 바로 고칠 수 있게
      el.onfocus = () => { if (!el.value.trim() && el.placeholder) { el.value = el.placeholder; el.select(); } };
      el.onblur = () => { if (el.value.trim() === el.placeholder) el.value = ""; h(); refreshMixSets(el.dataset.lpat); };
      el.addEventListener("input", () => refreshMixSets(el.dataset.lpat));
    });
    // 동판을 바꿔도 드로어 전체를 다시 그리지 않는다
    // (다시 그리면 바로 옆 패턴 칸을 클릭한 것이 사라져 입력이 막힌 것처럼 보였다) → 그 도수 줄만 갱신
    $$("[data-lp]").forEach((el) => (el.onchange = () => {
      const plate = el.value.trim();
      setLayerPlate(v, el.dataset.lp, plate);
      const row = el.closest(".lp-row");
      const pat = row && row.querySelector("[data-lpat]");
      if (pat) {
        const auto = (plate ? platePatterns(plate).map((x) => x.label) : []).join(" · ") || d.pattern.code || "";
        if (document.activeElement === pat && pat.value === pat.placeholder) pat.value = auto;
        pat.placeholder = auto;
      }
      const db = row && row.querySelector("[data-dbplate]");
      if (db) { db.dataset.dbplate = plate; loadDbPlate(db); }
      refreshMixSets(el.dataset.lp);
    }));
    // 배합 행의 '동판·패턴' 칸만 갱신 (입력 중인 칸을 지우지 않게)
    function refreshMixSets(layer) {
      $$("table.mix-edit tr[data-mi]").forEach((tr) => {
        const m = v.mixes[Number(tr.dataset.mi)];
        if (!m || (layer && m.layer !== layer)) return;
        const td = tr.querySelector(".mix-set");
        if (!td) return;
        const code = layerCodeOf(d, v, m.layer);
        td.className = "mix-set" + (m.plate ? "" : " empty");
        td.innerHTML = `${m.plate ? esc(m.plate) : "동판 없음"}<i>${esc(code)}</i>`;
        td.title = `DB 키: ${code} · ${m.layer || ""} · ${m.plate || "동판 없음"}`;
      });
    }
    $$("[data-mi] input[data-mf], [data-mi] select[data-mf]").forEach((el) => {
      const h = el.oninput || el.onchange;
      const handler = () => {
        const mi = Number(el.closest("[data-mi]").dataset.mi);
        const f = el.dataset.mf;
        const m = v.mixes[mi];
        if (f.startsWith("ink:")) {
          m.inks = m.inks || {};
          const k = f.slice(4);
          const num = parseFloat(el.value);
          if (el.value === "" || isNaN(num)) delete m.inks[k]; else m.inks[k] = num;
        } else if (f === "isReference") {
          m.isReference = el.checked;
          if (el.checked) v.mixes.forEach((x) => { if (x !== m && x.layer === m.layer) x.isReference = false; });
        }
        else if (["mattingPct", "thinnerPct", "hardenerPct", "mattingG", "thinnerG", "hardenerG"].includes(f)) {
          const num = parseFloat(el.value); m[f] = isNaN(num) ? null : num;
          const pair = { mattingPct: "mattingG", thinnerPct: "thinnerG", hardenerPct: "hardenerG",
                         mattingG: "mattingPct", thinnerG: "thinnerPct", hardenerG: "hardenerPct" }[f];
          if (pair) delete m[pair];
        } else m[f] = el.value;
      };
      el.oninput = handler;
      el.onchange = () => {
        handler();
        if (el.dataset.mf === "layer") {
          // 도수를 옮기면 그 도수의 동판을 따라간다 (동판·패턴 세트)
          const m = v.mixes[Number(el.closest("[data-mi]").dataset.mi)];
          const lp = (v.layerPlates || {})[m.layer]
            || ((v.mixes || []).find((x) => x !== m && x.layer === m.layer && x.plate) || {}).plate;
          if (lp) m.plate = lp;
          renderDrawer();
        }
      };
    });
    async function loadDbPlate(el) {
      const plate = el.dataset.dbplate;
      el.textContent = ""; el.className = "lp-db";
      if (!plate) return;
      try {
        const info = await apiGet(`/api/plate/${encodeURIComponent(plate)}`);
        if (el.dataset.dbplate !== plate) return;   // 기다리는 사이 동판이 또 바뀜
        const map = new Map();
        (info.usedBy || []).forEach((u) => {
          if (!map.has(u.code)) map.set(u.code, new Set());
          if (u.layer) map.get(u.code).add(u.layer);
        });
        if (!map.size) { el.textContent = "DB 기록 없음"; el.className = "lp-db empty"; return; }
        el.innerHTML = "DB " + Array.from(map.entries()).map(([code, layers]) =>
          `<b class="${code === d.pattern.code ? "cur" : ""}">${esc(code)}</b><i>${esc([...layers].join("·"))}</i>`).join(" · ");
        const patInput = el.closest(".lp-row")?.querySelector("[data-lpat]");
        if (patInput && !patInput.value.trim() && document.activeElement !== patInput) patInput.placeholder = Array.from(map.keys()).join(" · ");
      } catch (e) {
        el.textContent = "";
      }
    }
    $$("[data-dbplate]").forEach((el) => loadDbPlate(el));
    const mattBtn = document.querySelector("[data-matttog]");
    if (mattBtn) mattBtn.onclick = () => {
      const cur = v._showMatting != null ? v._showMatting
        : (v.mixes || []).some((m) => m.mattingPct != null || m.mattingG != null);
      v._showMatting = !cur;
      renderDrawer();
    };
    $$("[data-lab]").forEach((el) => (el.onclick = () => {
      const mi = Number(el.dataset.lab);
      E.labOpen = E.labOpen === mi ? null : mi;
      renderDrawer();
    }));
    $$("[data-labf]").forEach((el) => {
      const h = () => {
        const raw = el.dataset.labf.split(":");
        const mi = Number(raw[0]);
        const mode = raw[1].split(".")[0];
        const comp = raw[1].split(".")[1];
        const m = v.mixes[mi];
        const key = mode === "sce" ? "labSce" : "labSci";
        const val = el.value.trim();
        if (val === "") { if (m[key]) delete m[key][comp]; }
        else {
          const n = parseFloat(val);
          if (isNaN(n)) { if (m[key]) delete m[key][comp]; }
          else { (m[key] = m[key] || {})[comp] = n; }
        }
        if (m[key] && Object.keys(m[key]).length === 0) delete m[key];
        const sw = document.querySelector(`[data-labsw="${mi}-${mode}"]`);
        if (sw) sw.style.background = labToCss(m[key]) || "#eee";
      };
      el.oninput = h; el.onchange = h;
    });
    $$("[data-labclear]").forEach((el) => (el.onclick = () => {
      const m = v.mixes[Number(el.dataset.labclear)];
      delete m.labSce; delete m.labSci;
      renderDrawer();
    }));
    $$("[data-inkadd]").forEach((el) => (el.onclick = () => {
      const t = el.dataset.inkadd;
      const hasVals = (v.mixes || []).some((m) => m.inks && m.inks[t] != null);
      const isOn = (v._inkCols || []).includes(t) || hasVals;
      if (isOn) {
        if (hasVals && !confirm(`${t} 값을 이 컬러의 배합에서 지울까요?`)) return;
        (v.mixes || []).forEach((m) => { if (m.inks) delete m.inks[t]; });
        v._inkCols = (v._inkCols || []).filter((x) => x !== t);
      } else {
        v._inkCols = v._inkCols || [];
        v._inkCols.push(t);
        addInkTag(t);
      }
      renderDrawer();
    }));
    const inkNew = $("#ink-new");
    if (inkNew) inkNew.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const t = addInkTag(inkNew.value);
      if (!t) return;
      v._inkCols = v._inkCols || [];
      if (!v._inkCols.includes(t)) v._inkCols.push(t);
      renderDrawer();
    };
    $$("[data-delmix]").forEach((el) => (el.onclick = () => { v.mixes.splice(Number(el.dataset.delmix), 1); renderDrawer(); }));
    const pp = $("#pp-cancel");
    if (pp) pp.onclick = () => { E.push = null; renderDrawer(); };
    const renameDb = async (mode) => {
      if (isDirty()) { toast("먼저 저장한 뒤 진행하세요"); return; }
      const rf = (E.push && E.push.renamedFrom) || {};
      const q = mode === "rename"
        ? `회사 DB(rdp.db)의 ${rf.project}-${rf.code} 행 ${rf.rows}개를 ${d.project}-${d.pattern.code}로 바꿉니다.\n(실행 전에 DB를 백업합니다) 진행할까요?`
        : `DB의 ${rf.project}-${rf.code} 행은 그대로 두고, 이 시편은 ${d.project}-${d.pattern.code}로 따로 보냅니다.\n(다음 보내기부터 같은 배합이 새 코드로 추가됩니다) 진행할까요?`;
      if (!confirm(q)) return;
      try {
        const r = await apiPost(`/api/rdp/rename-db/${encodeURIComponent(d.id)}`, { mode }, E.baseRev);
        const p0 = byId(d.id);
        if (p0) { delete p0.renamedFrom; markSaved(p0, r); }
        delete d.renamedFrom; markSaved(d, r);
        E.baseRev = revOf(d); E.origJson = JSON.stringify(d);
        E.push = await apiGet(`/api/rdp/push-preview/${encodeURIComponent(d.id)}`);
        renderDrawer();
        toast(mode === "rename" ? `DB 코드 변경 ${r.renamed || 0}행` + (r.backup ? ` (백업 ${r.backup})` : "") : "옛 코드 표시를 지웠습니다");
      } catch (e) { toast("실패: " + e.message); }
    };
    const prn = $("#pp-renamedb");
    if (prn) prn.onclick = () => renameDb("rename");
    const pig = $("#pp-ignore");
    if (pig) pig.onclick = () => renameDb("ignore");
    const pok = $("#pp-ok");
    if (pok) pok.onclick = async () => {
      if (isDirty()) { toast("먼저 저장한 뒤 보내세요"); return; }
      pok.disabled = true; pok.textContent = "반영 중…";
      try {
        // 미리보기에서 본 계획 그대로일 때만 서버가 쓴다 (그사이 시편·잉크 연결·DB가 바뀌면 409 → 새 미리보기)
        const r = await apiPost(`/api/rdp/push/${encodeURIComponent(d.id)}`, { planHash: (E.push && E.push.planHash) || "" });
        E.push = null;
        renderDrawer();
        const nf = (r.failed || []).length;
        toast(`DB 반영 완료 · ${r.moved ? `이동 ${r.moved} · ` : ""}수정 ${r.updated || 0} · 신규 ${r.inserted || 0}`
          + (nf ? ` · 실패 ${nf}건 (${(r.failed || []).map((f) => `${f.layer} ${f.batch}: ${f.reason}`).join(", ")})` : "")
          + (r.backup ? ` (백업 ${r.backup})` : ""));
      } catch (e) {
        if (e.status === 409 && e.payload && e.payload.stale) {
          toast(e.message);
          try { E.push = await apiGet(`/api/rdp/push-preview/${encodeURIComponent(d.id)}`); } catch (e2) { E.push = null; }
          if (E.push && staleDraft(E.push)) E.push = null;
          renderDrawer();
          return;
        }
        toast("반영 실패: " + e.message);
        pok.disabled = false; pok.textContent = "DB에 반영";
      }
    };
    const pu = $("#rdppush");
    if (pu) pu.onclick = async () => {
      if (isDirty()) { toast("먼저 저장한 뒤 보내세요"); return; }
      try {
        const pv = await apiGet(`/api/rdp/push-preview/${encodeURIComponent(d.id)}`);
        if (staleDraft(pv)) return;
        E.push = pv; renderDrawer();
      } catch (e) { toast("미리보기 실패: " + e.message); }
    };
    const df = $("#rdpdiff");
    if (df) df.onclick = async () => {
      if (isDirty()) { toast("먼저 저장한 뒤 비교하세요"); return; }
      try {
        const r = await apiGet(`/api/rdp/diff/${encodeURIComponent(d.id)}`);
        const c = (r.changed || []).length, a = (r.archiveOnly || []).length, b = (r.dbOnly || []).length;
        const msg = (c + a + b) === 0
          ? "DB와 차이 없음 (" + r.same + "건 동일)"
          : `아카이브만 다름 ${c}건 · DB에만 있음 ${b}건 · DB에 없음 ${a}건`;
        toast(msg);
      } catch (e) { toast("비교 실패: " + e.message); }
    };
    const sy = $("#rdpsync");
    if (sy) sy.onclick = async () => {
      if (isDirty()) { toast("먼저 저장한 뒤 가져오세요"); return; }
      sy.disabled = true; sy.textContent = "가져오는 중…";
      try {
        const r = await fetch(`/api/rdp/sync/${encodeURIComponent(d.id)}`, { method: "POST" }).then((x) => x.json());
        if (!r.ok) throw new Error(r.error || "동기화 실패");
        const fresh = await apiGet("/api/patterns");
        const p2 = normalizeDoc((fresh.patterns || []).find((x) => x.id === d.id));
        if (p2) {
          const idx = App.patterns.findIndex((x) => x.id === d.id);
          if (idx >= 0) App.patterns[idx] = p2; else App.patterns.push(p2);
          E.draft = clone(p2);
          delete E.draft._file; delete E.draft._mtime;
          E.baseRev = revOf(p2);
          E.vIdx = Math.max(0, (p2.variations || []).findIndex((x) => x.id === r.variation));
          E.origJson = JSON.stringify(E.draft);
        }
        renderDrawer();
        toast(`DB에서 ${r.added}건 추가 · ${r.updated}건 갱신`);
      } catch (e) {
        toast("동기화 실패: " + e.message);
        sy.disabled = false; sy.textContent = "RDP-DB에서 가져오기";
      }
    };
    const addMixBtn = $("#add-mix");
    if (addMixBtn) addMixBtn.onclick = () => {
      const layer = "1도";
      v.mixes.push({ layer, batch: "", plate: layerPlate(v, layer) || "", inks: {}, mattingG: null, thinnerG: null, hardenerG: null, result: "", isReference: false, note: "", change: "" });
      renderDrawer();
    };
    const al = $("#add-layer");
    if (al) al.onclick = () => {
      const nums = Array.from(new Set((v.mixes || []).map((m) => {
        const mm = /(\d+)/.exec(String(m.layer || ""));
        return mm ? Number(mm[1]) : 0;
      })));
      const next = Math.max(0, ...nums) + 1;
      const layer = next + "도";
      v.layerPlates = v.layerPlates || {};
      v.layerPlates[layer] = (d.work.plate || [])[0] || "";
      v.mixes.push({ layer, batch: "", plate: v.layerPlates[layer], inks: {}, mattingPct: 2, thinnerPct: 30, hardenerPct: 20, result: "", isReference: false, note: "", change: "" });
      renderDrawer();
      toast(layer + " 추가 — 배합번호와 값을 입력하세요");
    };
    const dupMixBtn = $("#dup-mix");
    if (dupMixBtn) dupMixBtn.onclick = () => { if (!v.mixes.length) return; const c = clone(v.mixes[v.mixes.length - 1]); c.batch = (c.batch || "") + "-C"; c.isReference = false; v.mixes.push(c); renderDrawer(); };
    const linkBtn = $("#link-same");
    if (linkBtn) linkBtn.onclick = () => {
      const t = $("#same-target").value;
      if (!t) return;
      if ((v.mixes || []).length && !confirm("이 샘플에 입력된 배합 " + v.mixes.length + "건이 지워집니다(복구 불가). 동일 배합으로 바꿀까요?")) return;
      v.mixes = [];
      v.sameAs = t;
      renderDrawer();
    };
    const unlinkBtn = $("#unlink-same");
    if (unlinkBtn) unlinkBtn.onclick = () => { delete v.sameAs; renderDrawer(); };
    const mv = $("#move-mix");
    if (mv) mv.onclick = () => {
      const targetId = $("#move-to").value;
      const tv = d.variations.find((x) => x.id === targetId);
      if (!tv) return;
      const picks = $$("[data-pick]").filter((el) => el.checked).map((el) => Number(el.dataset.pick)).sort((a, b) => b - a);
      if (!picks.length) { toast("이동할 배합을 체크하세요"); return; }
      picks.forEach((mi) => { const m = v.mixes.splice(mi, 1)[0]; tv.mixes = tv.mixes || []; tv.mixes.push(m); });
      toast(picks.length + "건 이동");
      renderDrawer();
    };
    const cp = $("#copy-mix");
    if (cp) cp.onclick = () => {
      const targetId = $("#move-to").value;
      const tv = d.variations.find((x) => x.id === targetId);
      if (!tv) return;
      const picks = $$("[data-pick]").filter((el) => el.checked).map((el) => Number(el.dataset.pick));
      if (!picks.length) { toast("복제할 배합을 체크하세요"); return; }
      tv.mixes = tv.mixes || [];
      picks.slice().sort((a, b) => a - b).forEach((mi) => tv.mixes.push(freshCopy(v.mixes[mi], tv.mixes)));
      toast(picks.length + "건 복제 → " + vName(tv) + " · 배치번호를 새로 입력하세요");
      renderDrawer();
    };
  }

  if (E.tab === "images") {
    const v = d.variations[E.vIdx];
    $("#addimg").onclick = () => $("#fileinput").click();
    $("#fileinput").onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) startCrop(f, { slot: (v.images || []).length + 1 });
    };
    $$("[data-reimg]").forEach((el) => (el.onclick = () => {
      const i = Number(el.dataset.reimg);
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*";
      input.onchange = () => { const f = input.files[0]; if (f) startCrop(f, { slot: i + 1 }); };
      input.click();
    }));
    $$("[data-delimg]").forEach((el) => (el.onclick = () => {
      const i = Number(el.dataset.delimg);
      if (!confirm("이 이미지를 뺄까요? 저장하면 파일은 _trash로 정리됩니다.")) return;
      v.images.splice(i, 1);
      renderDrawer();
      toast("이미지 제외 — 저장을 눌러 반영");
    }));
  }

  if (E.tab === "json") {
    $("#jsonarea").oninput = (e) => {
      try {
        const parsed = JSON.parse(e.target.value);
        const why = jsonShapeError(parsed);
        if (why) { E.jsonErr = why; return; }
        E.draft = normalizeDoc(parsed); E.jsonErr = null;
        E.vIdx = Math.min(E.vIdx, E.draft.variations.length - 1);
      } catch (err) { E.jsonErr = err.message; }
    };
  }

  const del = $("#del-pattern");
  if (del) del.onclick = async () => {
    if (!confirm("이 시편을 삭제할까요? JSON·이미지·업로드 원본이 _trash로 이동합니다.")) return;
    try {
      await apiDelete(`/api/patterns/${encodeURIComponent(E.draft.id)}`, revOf(byId(E.draft.id)));
      App.patterns = App.patterns.filter((x) => x.id !== E.draft.id);
      closeEditor(); location.hash = ""; renderCatalog(); renderCart();
      toast("삭제됨");
    } catch (e) { E.msg = "삭제 실패: " + e.message; renderDrawer(); }
  };
}

// JSON 탭: 편집기가 그릴 수 없는 모양은 탭 이동·저장 전에 막는다 (최상위 객체 + 컬러 1개 이상)
const jsonShapeError = (x) => (!x || typeof x !== "object" || Array.isArray(x) ? "최상위는 객체여야 합니다"
  : !Array.isArray(x.variations) || !x.variations.some((v) => v && typeof v === "object" && !Array.isArray(v))
    ? "variations에 컬러가 하나 이상 있어야 합니다" : "");

export async function saveDraft() {
  if (!E.draft) return;
  let d = E.draft;
  try {
    if (E.tab === "json" && $("#jsonarea")) {
      let parsed;
      try { parsed = JSON.parse($("#jsonarea").value); } catch (e) { parsed = e; }
      const why = parsed instanceof Error ? "JSON 문법 오류" : jsonShapeError(parsed);
      if (why) {
        const msg = $("#drawer-msg");
        if (msg) { msg.textContent = why + " — 고친 뒤 다시 저장하세요"; msg.className = "msg err"; }
        return;
      }
      d = E.draft = normalizeDoc(parsed);
      E.vIdx = Math.min(E.vIdx, d.variations.length - 1);
    }
    if (!d.pattern.code) { E.msg = "패턴 코드를 입력하세요"; E.tab = "base"; syncTabs(); renderDrawer(); return; }
    if (!d.id) {
      if (!d.project) { E.msg = "프로젝트를 입력하세요"; E.tab = "base"; syncTabs(); renderDrawer(); return; }
      d.id = deriveId(d.project, d.pattern.code);
      if (!d.id) { E.msg = "프로젝트·패턴 코드에 영문/숫자를 넣어주세요 (ID를 만들 수 없습니다)"; E.tab = "base"; syncTabs(); renderDrawer(); return; }
      if (byId(d.id) && !confirm(`이미 '${d.id}' 시편이 있습니다. 덮어쓸까요?`)) {
        d.id = ""; E.msg = "저장 취소 — 패턴 코드를 바꾸세요"; renderDrawer(); return;
      }
    }
    (d.variations || []).forEach((vv) => syncLayerPlates(vv));
    const prevId = d.id;
    let targetId = d.id;
    const derived = deriveId(d.project, d.pattern.code);
    if (!E.isNew && d.id && derived && derived !== d.id) {
      if (!confirm(`시편 ID를 바꿀까요?\n\n${d.id}  →  ${derived}\n(이미지·원본 폴더도 함께 옮겨집니다)`)) {
        E.msg = "저장 취소 — 프로젝트/패턴 코드를 되돌리세요"; renderDrawer(); return;
      }
      targetId = derived;
    }
    // 실제로 인쇄되는 값(labOf: 컬러 라벨 우선) 기준으로 도수 숫자가 빠졌는지 본다
    const warnType = (d.variations || []).some((vv) => /^Padprint Layer$/i.test(String(labOf(d, vv).type || "").trim()));
    if (warnType && !confirm("구분이 'Padprint Layer'로 끝나 있습니다 (도수 숫자 없음).\n그대로 저장할까요?")) {
      E.msg = "저장 취소 — 구분에 도수 숫자를 넣으세요"; renderDrawer(); return;
    }
    tidyLabels(d);
    const layerNo = (l) => { const m = /(\d+)/.exec(String(l || "")); return m ? Number(m[1]) : 0; };
    (d.variations || []).forEach((vv) => {   // 저장할 때만 1도→2도 순으로 (원래 순서는 유지하는 안정 정렬)
      if (Array.isArray(vv.mixes)) vv.mixes = vv.mixes.map((m, i) => [m, i]).sort((a, b) => layerNo(a[0].layer) - layerNo(b[0].layer) || a[1] - b[1]).map((x) => x[0]);
    });
    E.labOpen = null;
    E.msg = "저장 중…"; renderDrawer();
    const payload = {};
    Object.keys(d).forEach((k) => { if (!k.startsWith("_")) payload[k] = d[k]; });
    payload.id = targetId;
    // 이름 변경은 저장과 한 요청으로 보낸다 (서버가 락 안에서 rev 확인 → 이동 → 저장, 실패 시 되돌림)
    const r = await apiPut(`/api/patterns/${encodeURIComponent(targetId)}`, payload, E.baseRev, E.isNew,
      targetId !== prevId ? prevId : "");
    d.id = targetId;
    if (prevId && prevId !== d.id) App.patterns = App.patterns.filter((x) => x.id !== prevId);
    if (r.renamedFrom) d.renamedFrom = r.renamedFrom; else delete d.renamedFrom;
    const idx = App.patterns.findIndex((x) => x.id === d.id);
    const saved = markSaved(clone(d), r); saved._mtime = Date.now();
    E.baseRev = revOf(saved);
    if (idx >= 0) App.patterns[idx] = saved; else App.patterns.push(saved);
    const vids = new Set((d.variations || []).map((v) => v.id));
    App.cart = App.cart.filter((c) => c.pid !== d.id || vids.has(c.vid));
    if (App.prop.comments) {
      Object.keys(App.prop.comments).forEach((k) => {
        const [pid, vid] = k.split("::");
        if (pid === d.id && vid !== "all" && !vids.has(vid)) delete App.prop.comments[k];
      });
    }
    saveLS();
    E.msg = "저장됨 " + (r.savedAt || "");
    E.isNew = false;
    E.origJson = JSON.stringify(saved);
    toast("저장됨");
    E.draft = clone(saved);
    E.origJson = JSON.stringify(saved);
    if (prevId && prevId !== d.id) {
      App.cart.forEach((c) => { if (c.pid === prevId) c.pid = d.id; });
      if (App.prop.comments) {
        Object.keys(App.prop.comments).forEach((k) => {
          const [pid, vid] = k.split("::");
          if (pid === prevId) { App.prop.comments[d.id + "::" + vid] = App.prop.comments[k]; delete App.prop.comments[k]; }
        });
      }
      saveLS();
      if (String(location.hash).includes("/p/")) {
        location.hash = `#/p/${encodeURIComponent(d.id)}/${encodeURIComponent((d.variations[0] || {}).id || "v01")}`;
      }
    }
    rerender();
    renderDrawer();
  } catch (e) {
    if (e.status === 409 && e.payload && e.payload.current) {
      const ok = confirm("다른 곳에서 먼저 저장되었습니다.\n최신 내용을 불러올까요? 지금 편집 중인 내용은 사라집니다.");
      if (ok) {
        const cur = normalizeDoc(e.payload.current);
        const i = App.patterns.findIndex((x) => x.id === cur.id);
        if (i >= 0) App.patterns[i] = cur; else App.patterns.push(cur);
        closeEditor(); rerender(); toast("최신 내용을 불러왔습니다");
      } else {
        E.msg = "저장 취소 — 최신 내용을 확인하세요";
        renderDrawer();
      }
      return;
    }
    E.msg = "저장 실패: " + e.message;
    renderDrawer();
  }
}
