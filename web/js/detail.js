/* RDP 시편 아카이브 — 시편 상세 · 배합표 · 예상색 */
import { $, $$, App, html, raw, RESULT_LABEL, apiGet, apiPost, byId, clone, dash, esc, fmtDate, imgUrl, inCart, layers, paintDots, saveLS, toast, toggleCart, vName, varOf } from "./core.js";
import { inlineSave, inlineSettled, startInline } from "./inline.js";
import { saveNewPattern } from "./catalog.js";
import { showPlate } from "./plates.js";
import { renderCart } from "./proposal.js";
import { workOf, workSource } from "./work.js";
import { openEditor } from "./editor.js";
import { openHistory } from "./history.js";
import { batchCompare, deltaText } from "./mix-compare.js";
import { loadWorklogs } from "./worklog-link.js";
import { loadProposalHistory } from "./feedback.js";

/* ---------------- detail ---------------- */
export const labOf = (p, v) => Object.assign({}, (p && p.label) || {}, (v && v.label) || {});

export function platePatterns(plate) {
  const out = new Map();
  App.patterns.forEach((pp) => (pp.variations || []).forEach((vv) => {
    const lp = vv.layerPlates || {};
    Object.keys(lp).forEach((l) => {
      if (lp[l] === plate) {
        const key = pp.id;
        if (!out.has(key)) out.set(key, { id: pp.id, label: pp.pattern.code, name: pp.pattern.name || pp.pattern.nameKo || "", project: pp.project, layers: new Set() });
        out.get(key).layers.add(l);
      }
    });
  }));
  return Array.from(out.values());
}

const sampleOwn = (v, key) => !!(v && v.label && v.label[key] != null && String(v.label[key]).trim() !== "");
function sampleVal(p, v, key) {
  if (sampleOwn(v, key)) return v.label[key];
  if (key === "company") return p.client || "";
  if (key === "project") return p.project || "";
  return ((p.label || {})[key]) || "";
}

function layerPatLabel(v, layer, p) {
  const custom = ((v && v.layerPatterns) || {})[layer];
  if (custom && String(custom).trim()) return String(custom).trim();
  const plate = layerPlate(v, layer);
  const auto = plate ? platePatterns(plate).map((x) => x.label) : [];
  if (auto.length) return auto.join(" · ");
  return p ? p.pattern.code : "";
}

export function layerPlate(v, layer) {
  const lp = v.layerPlates || {};
  if (lp[layer]) return lp[layer];
  const hit = (v.mixes || []).find((m) => m.layer === layer && m.plate);
  return hit ? hit.plate : "";
}

// 배합이 DB에 들어가는 패턴 코드: 그 도수의 패턴(layerPatterns)이 있으면 그것, 없으면 시편 코드 (server.layer_code와 같음)
export function layerCodeOf(p, v, layer) {
  const lp = String(((v && v.layerPatterns) || {})[layer] || "").trim();
  return lp || ((p && p.pattern && p.pattern.code) || "");
}

// 도수 대표 동판을 바꾸면 그 동판을 따르던 줄(같은 동판이거나 비어 있던 줄)만 함께 바꾼다.
// 다른 동판에서 찍은 예외 줄은 그대로 두고, 그대로 둔 줄 수를 돌려준다.
// (바뀐 줄은 저장할 때 서버가 옛 동판을 plateFrom에 남겨서, DB 전송 때 새 행 대신 옛 동판 행을 옮긴다)
export function setLayerPlate(v, layer, plate) {
  const old = layerPlate(v, layer);
  v.layerPlates = v.layerPlates || {};
  v.layerPlates[layer] = plate;
  let kept = 0;
  (v.mixes || []).forEach((m) => {
    if (m.layer !== layer) return;
    if (!m.plate || m.plate === old) m.plate = plate; else if (m.plate !== plate) kept++;
  });
  return kept;
}

export function syncLayerPlates(v) {
  // 표시용으로만 도수 대표 동판을 기억한다. 배합 행의 plate는 절대 추측해서 채우지 않는다.
  const layers = Array.from(new Set((v.mixes || []).map((m) => m.layer).filter(Boolean)));
  v.layerPlates = v.layerPlates || {};
  layers.forEach((l) => {
    if (!v.layerPlates[l]) {
      const used = Array.from(new Set((v.mixes || []).filter((m) => m.layer === l && m.plate).map((m) => m.plate)));
      if (used.length === 1) v.layerPlates[l] = used[0];
    }
  });
}

export function labToCss(lab) {
  if (!lab || lab.L == null || lab.a == null || lab.b == null) return "";
  const L = Number(lab.L), A = Number(lab.a), B = Number(lab.b);
  if ([L, A, B].some((v) => isNaN(v))) return "";
  const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
  const f = (t) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const X = 0.95047 * f(fx), Y = 1.0 * f(fy), Z = 1.08883 * f(fz);
  const lin = [X * 3.2406 + Y * -1.5372 + Z * -0.4986, X * -0.9689 + Y * 1.8758 + Z * 0.0415, X * 0.0557 + Y * -0.2040 + Z * 1.0570];
  const gam = (u) => {
    const v = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(Math.max(u, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  return `rgb(${gam(lin[0])},${gam(lin[1])},${gam(lin[2])})`;
}

export function labText(lab) {
  if (!lab || lab.L == null) return "";
  const n = (v) => (v == null || v === "" ? "-" : Number(v).toFixed(1));
  return `${n(lab.L)} ${n(lab.a)} ${n(lab.b)}`;
}

export async function loadInkCatalog() {
  try {
    App.inkCatalog = await apiGet("/api/lab/inks");
    App.inkCatalogError = "";
  } catch (e) {
    App.inkCatalog = null;
    App.inkCatalogError = "공통 잉크 목록을 읽지 못했습니다. 컬러연구소에서 라이브러리를 확인하세요.";
    throw e;
  }
}

export function inkInfo(name) {
  const catalog = App.inkCatalog;
  const canonical = catalog && catalog.lookup[String(name).trim().toLowerCase()];
  return canonical ? catalog.inks.find((i) => i.name === canonical) : null;
}

export function inkLabel(name) {
  const info = inkInfo(name);
  const label = info ? info.short_name : name;
  const sw = info && info.swatches.sci;
  const title = info ? `${info.name} · ${sw ? "SCI 은폐 도막 측정색 (화면 근사)" + (sw.in_gamut ? "" : " · 화면 색역 밖") : info.clear ? "투명 잉크" : "SCI 측정 없음"} · DB ${info.db_ink || "연결 없음"}` : `${name} · 컬러연구소 미등록`;
  return `<span class="ink-identity" title="${esc(title)}">${sw ? `<i class="labsw" style="background:${esc(sw.hex)}"></i>` : ""}${esc(label)}${info && name !== info.name && name !== label ? `<small> (${esc(name)})</small>` : ""}</span>`;
}

// 배합표를 바꾸지 않고 한 행의 조건부 예상색을 계산한다.
async function openRecipePreview(mix) {
  const source = clone(mix);
  const previousFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "recipe-preview";
  dialog.innerHTML = '<button class="mini-btn recipe-close" type="button">닫기</button><h3>배합 예상색</h3><div class="recipe-content">공통 잉크 목록을 불러오는 중…</div>';
  document.body.appendChild(dialog);
  dialog.querySelector(".recipe-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { dialog.remove(); if (previousFocus && previousFocus.isConnected) previousFocus.focus(); });
  dialog.showModal();
  const content = dialog.querySelector(".recipe-content");
  try {
    await loadInkCatalog();
    if (!dialog.isConnected) return;
    const catalog = App.inkCatalog;
    const total = Object.values(source.inks || {}).reduce((sum, n) => sum + Number(n), 0);
    const grams = (key) => source[`${key}G`] != null ? source[`${key}G`] : source[`${key}Pct`] != null ? total * source[`${key}Pct`] / 100 : (key === "matting" ? 0 : "");
    content.innerHTML = `<p class="recipe-help">${esc(source.layer || "")} ${esc(source.batch || "")} · 이 배합 한 도를 선택한 바탕 위에 찍는 예상입니다. 2도 배합도 겹침색이 아니라 단독 전사색입니다. 실측 LAB는 변경하지 않습니다.</p>
        <div class="recipe-ingredients">${Object.entries(source.inks || {}).map(([n, g]) => `<span>${inkLabel(n)} <b>${esc(g)}g</b></span>`).join("")}</div>
        <p class="recipe-help">잉크 옆 색상칩은 SCI 은폐 도막 측정색의 화면 근사입니다. 배합색이 아닙니다.</p>
        <form class="recipe-form">
          <label>측정 모드<select name="mode"><option value="sci">SCI</option><option value="sce">SCE</option></select></label>
          <label>바탕<select name="substrate" required><option value="">바탕 선택</option>${catalog.substrates.map((x) => `<option value="${esc(x.ref)}">${esc(x.ref)} (${x.modes.map((m) => m.toUpperCase()).join("/")})</option>`).join("")}</select></label>
          <label>동판<select name="plate"><option value="">기본 ×1.00 (가정)</option>${catalog.plates.map((x) => `<option value="${esc(x)}"${source.plate === x ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
          <label>설계 망점 %<input name="tone" type="number" min="0.01" max="100" step="any" required placeholder="예: 70" value="${esc(source.tone ?? "")}"></label>
          ${[["thinner", "신나"], ["hardener", "경화제"], ["matting", "소광제"]].map(([key, label]) => `<label>${label} g<input name="${key}" type="number" min="0" step="any" required value="${esc(grams(key))}" placeholder="실제 사용량"></label>`).join("")}
          <button class="btn-dark" type="submit">예상색 계산</button>
        </form>
        ${source.plate && !catalog.plates.includes(source.plate) ? `<p class="recipe-help">배합의 동판 ${esc(source.plate)}은 컬러연구소에 없습니다. 기본 계수를 쓰거나 동판을 등록하세요.</p>` : ""}
        <div class="recipe-result" aria-live="polite">바탕·망점·첨가량을 확인한 뒤 계산하세요.</div>
        <a href="/lab/#/library" target="_blank" rel="noopener">컬러연구소에서 잉크·별칭·보정 관리</a>`;
    const form = content.querySelector("form"), output = content.querySelector(".recipe-result");
    let sequence = 0;
    form.addEventListener("input", () => { sequence++; output.textContent = "조건이 바뀌었습니다. 다시 계산하세요."; });
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const ticket = ++sequence;
      const values = new FormData(form);
      const recipe = { inks: source.inks };
      ["thinner", "hardener", "matting"].forEach((key) => { recipe[key] = { g: Number(values.get(key)) }; });
      output.textContent = "계산 중…";
      try {
        const result = await apiPost("/api/lab/recipe-preview", { recipe, mode: values.get("mode"), substrate: values.get("substrate"), plate: values.get("plate"), tone: Number(values.get("tone")) });
        if (!dialog.isConnected || ticket !== sequence) return;
        const swatch = result.average;
        const measured = source[result.mode === "sci" ? "labSci" : "labSce"];
        output.innerHTML = `<div class="recipe-color"><i style="background:${esc(swatch.hex)}"></i><div><b>모델 예상색 · ${esc(result.mode.toUpperCase())}</b><p>L* a* b*: ${swatch.lab.map((n) => Number(n).toFixed(2)).join(" / ")}</p><small>${esc(result.space === "spec" ? "분광 31채널" : "3채널 " + result.space.toUpperCase())} · 상대 두께 ×${Number(result.plate).toFixed(3)} (µm 아님)</small></div></div>
            ${measured ? `<p>별도 저장된 실측 LAB: ${esc(labText(measured))} (실측 조건과 일치하는지 확인)</p>` : ""}
            <p>${result.ingredients.map((i) => `${esc(i.name)} ${Number(i.g).toFixed(2)}g (${Number(i.pct).toFixed(1)}%)`).join(" · ")}</p>
            <ul>${[result.note, ...(result.warnings || [])].filter(Boolean).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
      } catch (e) {
        if (dialog.isConnected && ticket === sequence) output.textContent = "계산할 수 없습니다: " + e.message;
      }
    };
  } catch (e) {
    if (dialog.isConnected) content.textContent = App.inkCatalogError || e.message;
  }
}

export function bindRecipePreviews(root, mixes) {
  $$("[data-recipe-preview]", root).forEach((button) => {
    button.onclick = () => { const mix = mixes[Number(button.dataset.recipePreview)]; if (mix) openRecipePreview(mix); };
  });
}

/* 잉크 이름은 정식 코드(800MT)로 통일한다. 표시 순서는 rdp.db 7색 칼럼 순서를 따른다. */
const INK_PRIORITY = ["800MT", "700BK", "100WH", "200YE-L", "300RD", "800CL", "200YE-D"];

export function inkOrder(list) {
  const canon = (n) => inkInfo(n)?.name || n;   // 옛 약칭(MT)이 섞여 있어도 정식명으로 줄 세운다
  return list.slice().sort((a, b) => {
    const ca = canon(a), cb = canon(b);
    const ia = INK_PRIORITY.indexOf(ca), ib = INK_PRIORITY.indexOf(cb);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return ca.localeCompare(cb);
  });
}

const DEFAULT_INKS = ["800MT", "700BK", "100WH", "200YE-L", "300RD", "800CL", "200YE-D"];

export function inkPool() {
  const set = new Set(DEFAULT_INKS.concat(App.prop.inkTags || []));
  App.patterns.forEach((p) => (p.variations || []).forEach((v) => (v.mixes || []).forEach((m) => {
    Object.keys(m.inks || {}).forEach((k) => set.add(k));
  })));
  ((App.inkCatalog && App.inkCatalog.inks) || []).forEach((i) => set.add(i.name));
  return inkOrder(Array.from(new Set(Array.from(set).map((n) => inkInfo(n)?.name || n))));
}

export function addInkTag(tag) {
  const raw = String(tag || "").trim();
  const t = inkInfo(raw)?.name || raw.toUpperCase();
  if (!t) return "";
  App.prop.inkTags = App.prop.inkTags || [];
  if (!App.prop.inkTags.includes(t)) { App.prop.inkTags.push(t); saveLS(); }
  return t;
}

export function mixTable(mixes) {
  const used = inkOrder(Array.from(new Set(mixes.flatMap((m) => Object.keys(m.inks || {})))));
  const hasMatting = mixes.some((m) => m.mattingPct != null || m.mattingG != null);
  const hasLab = mixes.some((m) => m.labSce || m.labSci);
  const amount = (g, pct) => (g != null ? `${g}g` : pct != null ? `${pct}%` : "—");
  const head = html`<tr><th>배합</th>${used.map((c) => html`<th>${raw(inkLabel(c))}</th>`)}${hasMatting ? raw("<th>소광</th>") : ""}<th>신나</th><th>경화</th>${hasLab ? raw("<th>LAB</th>") : ""}<th>잉크합</th><th>예상색</th><th>결과</th><th>비고</th></tr>`;
  const body = mixes.map((m, mi) => html`<tr>
      <td>${m.batch}${m.isReference ? " *" : ""}</td>
      ${used.map((c) => html`<td>${m.inks && m.inks[c] != null ? m.inks[c] : "—"}</td>`)}
      ${hasMatting ? html`<td>${amount(m.mattingG, m.mattingPct)}</td>` : ""}
      <td>${amount(m.thinnerG, m.thinnerPct)}</td>
      <td>${amount(m.hardenerG, m.hardenerPct)}</td>
      ${hasLab ? html`<td>${m.labSce || m.labSci ? html`<span class="lab-line"><i class="labsw" style="background:${labToCss(m.labSce || m.labSci)}"></i>${labText(m.labSce || m.labSci)}</span>` : "—"}</td>` : ""}
      <td>${pigmentTotal(m)}</td>
      <td><button type="button" class="mini-btn" data-recipe-preview="${mi}">예상색</button></td>
      <td class="res res-${m.result || ""}">${RESULT_LABEL[m.result] || "—"}</td>
      <td class="note">${m.change || m.note || ""}</td></tr>`);
  return String(html`<div class="tbl-wrap"><table class="mix">${head}${body}</table></div>`);
}
/* 같은 도수 배치끼리 나란히 — 바로 앞 배치보다 늘었으면 +, 줄었으면 − (규칙은 mix-compare.js) */
function openBatchCompare(title, rows) {
  const r = batchCompare(rows, inkOrder);
  const cell = (c, unit) => c.v == null
    ? `<td class="${c.changed ? "bc-chg" : ""}">${c.changed ? "없앰" : "—"}</td>`
    : `<td class="${c.changed ? "bc-chg" : ""}">${esc(c.v)}${unit === "%" ? "%" : ""}${c.d ? `<small class="${c.d > 0 ? "up" : "down"}">${esc(deltaText(c.d))}</small>` : ""}</td>`;
  const dlg = document.createElement("dialog");
  dlg.className = "recipe-preview batch-compare";
  dlg.innerHTML = `<button class="mini-btn recipe-close" type="button">닫기</button>
    <h3>배치 비교 <small>${esc(title)}</small></h3>
    <p class="recipe-help">왼쪽부터 배합표 순서입니다. 칸의 작은 숫자는 바로 앞 배치보다 늘거나 준 양이고, 바뀐 칸은 색으로 표시합니다.</p>
    <div class="tbl-wrap"><table class="mix bc">
      <tr><th></th>${r.batches.map((b) => `<th>${esc(b.batch)}${b.isReference ? " *" : ""}${b.plate ? `<small>${esc(b.plate)}</small>` : ""}</th>`).join("")}</tr>
      ${r.rows.map((x) => `<tr class="${x.changedAny ? "" : "bc-same"}"><th>${x.key.startsWith("ink:") ? inkLabel(x.label) : esc(x.label)}</th>${x.cells.map((c) => cell(c, x.unit)).join("")}</tr>`).join("")}
      <tr><th>결과</th>${r.batches.map((b) => `<td class="res res-${esc(b.result)}">${esc(RESULT_LABEL[b.result] || "—")}</td>`).join("")}</tr>
      <tr><th>변경 메모</th>${r.batches.map((b) => `<td class="note">${esc(b.change)}</td>`).join("")}</tr>
    </table></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".recipe-close").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

export function pigmentTotal(m) {
  const keys = Object.keys(m.inks || {});
  const t = keys.reduce((a, k) => a + (Number(m.inks[k]) || 0), 0);
  return t ? Math.round(t * 10) / 10 : "—";
}

export function renderDetail(pid, vid, override) {
  document.body.classList.remove("prop-mode");
  const isNew = !!override;
  const p = override || byId(pid);
  if (!p) { location.hash = ""; return; }
  const v = varOf(p, vid) || p.variations[0];
  p._sel = v.id;
  const vars = p.variations || [];
  const chips = vars.length > 1 ? vars.map((x) => `
      <button class="vchip${x.id === v.id ? " on" : ""}" data-vsel="${esc(x.id)}" title="${esc(vName(x))}">
        ${x.images && x.images.length ? `<img class="th" src="${imgUrl(p.id, x.images[0])}" alt="">` : '<span class="plus">·</span>'}
        <span class="nm">${esc(vName(x))}</span>
      </button>`).join("") : "";
  const images = v.images || [];
  const mixes = v.mixes || [];
  const sameAsVar = (v && v.sameAs) ? (p.variations || []).find((x) => x.id === v.sameAs) : null;
  const sameAsMixCount = sameAsVar ? ((sameAsVar.mixes || []).length) : 0;
  const byLayer = layers(v).map((layer) => {
    const rows = mixes.filter((m) => m.layer === layer);
    const plate = layerPlate(v, layer);
    const extra = Array.from(new Set(rows.map((m) => m.plate).filter(Boolean))).filter((x) => x !== plate);
    return `<div class="mixgroup"><h4>${esc(layer)}
        <button class="plate-chip" data-layer-plate="${esc(layer)}" title="이 도수의 동판 — 클릭해서 변경">${plate ? "동판 " + esc(plate) : "동판 지정"}</button>
        ${plate ? `<span class="plate-pats">${((v.layerPatterns || {})[layer]) ? `<b class="cur">${esc(v.layerPatterns[layer])}</b>` : (platePatterns(plate).map((x) => `<b class="${x.id === p.id ? "cur" : ""}">${esc(x.label)}</b>`).join(" · ") || `<b class="cur">${esc(p.pattern.code)}</b>`)}</span>` : ""}
        ${plate ? `<button class="plate-info" data-plate="${esc(plate)}" title="동판 정보" aria-label="동판 ${esc(plate)} 정보">i</button>` : ""}
        <span>${rows.length} 배합${extra.length ? " · 예외 " + extra.map(esc).join(", ") : ""}</span>
        ${rows.length > 1 ? `<button type="button" class="mini-btn" data-batch-compare="${esc(layer)}" title="같은 도수의 배치끼리 무엇을 바꿨는지 나란히">배치 비교</button>` : ""}</h4>${mixTable(rows)}</div>`;
  }).join("");

  $("#view").innerHTML = `<div class="wrap">

      <div class="detail${App.meeting ? " meeting" : ""}">
        <div class="span2 d-head-row">
          <div>
            <div class="kicker">${p.projectName || p.client ? `<span class="proj">${esc(p.projectName)}</span><span class="mini">${esc(p.client)}</span>` : `<span class="proj">NEW SPECIMEN</span>`}</div>
            <h1>${esc(p.pattern.code || "새 시편")}</h1>
            <div class="sub">${esc([p.pattern.name, p.pattern.nameKo].filter(Boolean).join(" · ") || p.label.type || "")}</div>
            ${isNew ? '<div class="new-hint">값을 클릭해 채우세요. 프로젝트와 패턴 코드는 필수입니다.</div>' : ""}
          </div>
          <div class="d-actions">
            ${isNew
            ? `<button class="btn-dark" id="newsave">저장</button><button class="btn-line" id="newcancel">취소</button>`
            : `<button class="btn-dark${inCart(p.id, v.id) ? " on" : ""}" id="addbtn">${inCart(p.id, v.id) ? "✓ 담김" : "제안서에 담기"}</button>
                 <button class="btn-line${App.meeting ? " on" : ""}" id="meetingbtn" title="고객 미팅용: 메모·배합·작업일지·동판 숨김">${App.meeting ? "미팅 모드 ON" : "미팅 모드"}</button>
                 <button class="btn-line" id="histbtn" title="저장할 때마다 남은 이전 상태 보기·되돌리기">이력</button>
                 <button class="btn-line" id="editbtn">편집</button>`}
          </div>
        </div>

        <div class="gallery">
          <div class="main" id="mainimg">${images.length ? `<img src="${imgUrl(p.id, images[0])}" alt="${esc(p.pattern.code + " " + vName(v))}">` : (isNew ? '<div class="empty-new"><span>이미지는 저장 후 <b>편집</b>에서 추가합니다</span></div>' : '<div class="empty" style="display:grid;place-items:center;height:100%;color:#8d9198;font-size:11px;letter-spacing:.1em">IMAGE N/A</div>')}</div>
          ${images.length > 1 ? `<div class="thumbs">${images.map((im, i) => `<img src="${imgUrl(p.id, im)}" class="${i === 0 ? "on" : ""}" data-img="${esc(imgUrl(p.id, im))}" alt="${esc(p.pattern.code + " " + vName(v))} 이미지 ${i + 1}">`).join("")}</div>` : ""}
          ${chips ? `<div class="vchips" style="margin-top:14px">${chips}</div>` : ""}
        </div>

        <div class="side">
          <div class="colorcard">
            <div class="eyebrow" style="margin:0">Color</div>
            <div class="cc-name${v.colorName || v.colorCode ? (v.colorName ? "" : " is-code") : " is-empty"}" data-f="v.colorName" title="클릭해서 컬러명 수정">${esc(v.colorName || v.colorCode || "컬러명")}</div>
            ${v.colorName || (!v.colorName && !v.colorCode) ? `<div class="cc-code${v.colorCode ? "" : " is-empty"}" data-f="v.colorCode" title="클릭해서 컬러코드 수정">${esc(v.colorCode || "컬러코드")}</div>` : ""}
            <div class="cc-row">
              <span class="${v.status ? "" : "is-empty"}" data-f="v.status">${esc(v.status || "상태")}</span>
              <span data-f="v.date">${esc(v.date ? fmtDate(v.date) : "날짜")}</span>
              ${App.meeting ? "" : `<span>${mixes.length} 배합</span>`}
            </div>
          </div>
          <section class="sec sec-tight"><h3>도장</h3>
            ${(v.coating || []).length ? (v.coating || []).map((c) => `<div style="margin-bottom:8px;font-size:12.5px"><b style="font-family:var(--mono);font-weight:600">${esc(c.code || "—")}</b><div style="color:#8d9198;font-size:11.5px">${esc([c.maker, c.lot].filter(Boolean).join(" · ") || "")}</div></div>`).join("") : '<p style="color:#8d9198;font-size:12.5px">—</p>'}
          </section>
          <section class="sec sec-plate"><h3>동판</h3>
            <div class="plate-edit" data-f="work.plate">${(p.work.plate || []).length ? `<span class="chipline">${p.work.plate.map((x) => `<span class="mini">${esc(x)}</span>`).join("")}</span>` : '<span class="is-empty">동판</span>'}</div>
          </section>
          <div class="d-note" data-f="v.note">${esc(v.note || "메모 추가")}</div>
        </div>

        <div class="span2 split2">
          <section class="sec"><h3>라벨 정보 <span class="lab-hint">샘플(컬러) 기준 — 패턴 코드·이름만 공통</span></h3>
            <dl class="kv">
              ${[["회사", "company", "Company"], ["프로젝트", "project", "Project"]].map(([t, k, en]) => {
              const own = sampleOwn(v, k);
              const f = own ? "v.label." + k : (k === "company" ? "client" : "project");
              return `<dt>${t}<small>${en}</small>${own ? ' <span class="lab-own" title="이 샘플 전용">샘플</span>' : ""}</dt><dd data-f="${f}"${own ? ' data-tip="이 샘플 전용 값 — 비우면 공통값을 씁니다"' : ""}>${esc(dash(sampleVal(p, v, k)))}</dd>`;
            }).join("")}
              <dt>패턴 코드<small>Pattern Code</small></dt><dd class="mono" data-f="pattern.code" data-tip="패턴 코드 — 바꾸면 파일 ID도 함께 바뀝니다 (편집기에서 변경)">${esc(p.pattern.code)}</dd>
              <dt>패턴명<small>Pattern Name</small></dt><dd data-f="pattern.name">${esc(dash(p.pattern.name))}</dd>
              <dt>컬러 코드<small>Color Code</small></dt><dd class="mono" data-f="v.colorCode">${esc(dash(v && v.colorCode))}</dd>
              ${[["품목", "item", "Item"], ["구분", "type", "Type"]].map(([t, k, en]) => {
              // 화면에 보이는 값(labOf: 컬러 라벨 우선)과 같은 곳을 고치도록 data-f를 고른다
              const own = v && v.label && v.label[k] != null && String(v.label[k]).trim() !== "";
              return `<dt>${t}<small>${en}</small>${own ? ' <span class="lab-own" title="이 컬러 전용 라벨">컬러</span>' : ""}</dt><dd data-f="${own ? "v.label." + k : "label." + k}"${own ? ' data-tip="이 컬러 전용 라벨 — 비우면 공통 라벨을 씁니다"' : ""}>${esc(dash(labOf(p, v)[k]))}</dd>`;
            }).join("")}
              <dt>날짜<small>Date(Rev)</small></dt><dd><span data-f="v.date">${esc(v && v.date ? fmtDate(v.date) : "—")}</span> <span class="revtag" data-f="v.rev" title="Rev 번호 — 클릭해서 수정">Rev.${esc(String((v && v.rev) != null && v.rev !== "" ? v.rev : "0"))}</span></dd>
              ${[["공급사", "supplier", "Supplier"], ["비고", "remark", "Remark"]].map(([t, k, en]) => {
              const own = sampleOwn(v, k);
              return `<dt>${t}<small>${en}</small>${own ? ' <span class="lab-own" title="이 샘플 전용">샘플</span>' : ""}</dt><dd data-f="${own ? "v.label." + k : "label." + k}"${own ? ' data-tip="이 샘플 전용 값 — 비우면 공통값을 씁니다"' : ""}>${esc(dash(sampleVal(p, v, k)))}</dd>`;
            }).join("")}
            </dl>
          </section>
          <section class="sec"><h3>작업 정보</h3>
            <dl class="kv">
              <dt>작업일자</dt><dd data-f="v.date" data-tip="이 샘플의 작업일 — 라벨 Date(Rev)·편집기 작업일과 같은 값">${esc(v && v.date ? fmtDate(v.date) : "—")}</dd>
              ${[["작업 장소", "place"], ["작업자", "worker"], ["설비", "machine"]].map(([label, key]) => {
                // 컬러가 덮어쓴 값이면 「컬러」 배지 + 공통값을 title 로. 클릭하면 그 자리(컬러 값)를 고친다.
                const src = workSource(p, v, key);
                const val = workOf(p, v)[key];
                const base = (p.work || {})[key];
                const tip = src === "color" ? `공통값: ${base || "—"}` : "";
                const f = src === "color" ? `v.work.${key}` : `work.${key}`;
                return `<dt>${label}${src === "color" ? ' <span class="lab-own" title="이 컬러만 다른 값">컬러</span>' : ""}</dt>` +
                  `<dd data-f="${f}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${esc(dash(val))}</dd>`;
              }).join("")}
              <dt>양산 일정</dt><dd data-f="work.sop">${esc(dash(p.work.sop))}</dd>
              <dt>엠보</dt><dd data-f="work.emboss">${esc(dash(p.work.emboss))}</dd>
              <dt>패드</dt><dd data-f="work.pad">${esc(dash(p.work.pad))}</dd>
            </dl>
          </section>
        </div>

        <div class="span2">
          <section class="sec sec-mix"><h3>배합 정보 <span class="cnt">${mixes.length} 배합${sameAsVar ? " · " + esc(vName(sameAsVar)) + "과 동일" : ""}</span></h3>${
          sameAsVar
            ? `<div class="sameas">${esc(vName(sameAsVar))} 컬러와 <b>같은 배합</b>입니다${sameAsMixCount ? ` (${sameAsMixCount}건)` : ""} — 별도 배합을 넣지 않습니다.</div>${sameAsMixCount ? mixTable(sameAsVar.mixes) : ""}`
            : (byLayer || '<p style="color:#8d9198;font-size:12.5px">등록된 배합이 없습니다.</p>')}</section>
          ${(p.history || []).length ? `<section class="sec sec-hist"><h3>작업일지 <span class="cnt">${p.history.length}</span></h3><ul class="timeline">
            ${p.history.map((h) => `<li><span class="d">${esc(fmtDate(h.date))}</span><div><div>${esc(h.title)}</div>${h.summary ? `<div style="color:#8d9198;font-size:11.5px">${esc(h.summary)}</div>` : ""}</div></li>`).join("")}
          </ul></section>` : ""}
          ${isNew ? "" : `<section class="sec sec-hist sec-fb" id="fb-sec" data-pid="${esc(p.id)}" hidden></section>`}
          ${isNew ? "" : `<section class="sec sec-hist sec-wl" id="wl-sec" data-pid="${esc(p.id)}" hidden></section>`}
        </div>
      </div>
    </div>`;

  $$(".mixgroup", $("#view")).forEach((group, index) => {
    const layer = layers(v)[index];
    bindRecipePreviews(group, mixes.filter((m) => m.layer === layer));
  });
  if (!isNew) loadProposalHistory(p, v);   // 이 시편이 들어간 확정본과 고객 반응
  if (!isNew) loadWorklogs(p);      // 작업일지(PCCS3)에서 이 시편과 관련된 작업 — 비동기, 없으면 칸을 숨긴 채로
  $$("[data-batch-compare]").forEach((b) => (b.onclick = () => {
    const layer = b.dataset.batchCompare;
    openBatchCompare(`${p.pattern.code} · ${vName(v)} · ${layer}`, mixes.filter((m) => m.layer === layer));
  }));
  if (sameAsVar) bindRecipePreviews($("#view .sec-mix"), sameAsVar.mixes || []);
  if (isNew) {
    $("#newsave").onclick = () => saveNewPattern();
    $("#newcancel").onclick = () => { if (confirm("작성을 취소할까요?")) { App.newDraft = null; location.hash = ""; } };
  } else {
    const addBtn = $("#addbtn");
    if (addBtn) addBtn.onclick = () => { toggleCart(p.id, v.id); renderDetail(pid, v.id); renderCart(); };
    const editBtn = $("#editbtn");
    if (editBtn) editBtn.onclick = async () => { await inlineSettled(pid); openEditor(pid, v.id); };
    const histBtn = $("#histbtn");
    // 고치던 메모(인라인 저장)가 끝난 뒤 열어야 '지금 상태'와 rev 가 맞는다
    if (histBtn) histBtn.onclick = async () => { await inlineSettled(pid); openHistory(pid, (saved) => renderDetail(pid, (saved.variations || []).some((x) => x.id === v.id) ? v.id : null)); };
    const meetBtn = $("#meetingbtn");
    if (meetBtn) meetBtn.onclick = () => { App.meeting = !App.meeting; saveLS(); renderDetail(pid, v.id); };
  }
  paintDots();
  $$("[data-layer-plate]").forEach((el) => (el.onclick = (e) => {
    e.stopPropagation();
    if (el.dataset.editing) return;
    const layer = el.dataset.layerPlate;
    const cur = layerPlate(v, layer);
    const prev = el.innerHTML;
    el.dataset.editing = "1";
    el.innerHTML = '<input class="inline-input" style="width:118px;font-size:11px">';
    const inp = el.firstElementChild;
    inp.value = cur || "";
    inp.placeholder = "동판";
    inp.focus(); inp.select();
    const restore = () => { delete el.dataset.editing; el.innerHTML = prev; };
    const commit = async () => {
      if (!el.dataset.editing) return;
      const val = inp.value.trim();
      restore();
      if (val === (cur || "")) return;
      let kept = 0;
      await inlineSave(pid, (d2) => {
        const v2 = (d2.variations || []).find((x) => x.id === v.id);
        if (!v2) return false;
        kept = setLayerPlate(v2, layer, val);
        return true;
      });
      if (kept) toast(`다른 동판에서 찍은 ${layer} 배합 ${kept}줄은 그대로 뒀어요`);
      renderDetail(pid, v.id);
    };
    inp.onblur = commit;
    inp.onkeydown = (e2) => {
      if (e2.key === "Enter") { e2.preventDefault(); inp.blur(); }
      if (e2.key === "Escape") { e2.preventDefault(); inp.onblur = null; restore(); }
    };
  }));
  $$("[data-plate]").forEach((el) => (el.onclick = (e) => { e.stopPropagation(); showPlate(el.dataset.plate, el); }));
  $$("[data-f]").forEach((el) => {
    el.title = el.dataset.tip || "클릭해서 수정";
    el.onclick = (e) => { e.stopPropagation(); startInline(el, pid, v.id); };
  });
  $$("[data-vsel]").forEach((el) => (el.onclick = () => { location.hash = `#/p/${encodeURIComponent(pid)}/${encodeURIComponent(el.dataset.vsel)}`; }));
  $$(".thumbs img").forEach((el) => (el.onclick = () => {
    const m = $("#mainimg img"); if (m) m.src = el.dataset.img;
    $$(".thumbs img").forEach((t) => t.classList.remove("on")); el.classList.add("on");
  }));
}
