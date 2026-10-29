/* RDP 시편 아카이브 — 제안서 · 확정본 보관함 · 장바구니 바 */
import { $, $$, App, apiGet, apiPost, byId, dash, esc, html, raw, imgUrl, resetPropIdentity, saveLS, toast, todayLocal, vName, fmtDate } from "./core.js";
import { labOf, layerPlate } from "./detail.js";
import { rerender } from "./main.js";
import { groupOrder, movePattern, moveColor, normalizeOrder } from "./cart-order.js";
import { workOf } from "./work.js";

/* ---------------- 담긴 시편 ---------------- */
function cartItems() {
  return App.cart.map((c) => {
    const p = byId(c.pid);
    const v = p ? (p.variations || []).find((x) => x.id === c.vid) : null;
    return p && v ? { p, v } : null;
  }).filter(Boolean);
}

function grouped() {
  const out = [];
  cartItems().forEach((it) => {
    let g = out.find((x) => x.p.id === it.p.id);
    if (!g) { g = { p: it.p, vars: [] }; out.push(g); }
    g.vars.push(it.v);
  });
  return out;
}

function batchCodes(v) {
  const byLayer = {};
  (v.mixes || []).forEach((m) => {
    const l = m.layer || "";
    (byLayer[l] = byLayer[l] || []).push(m);
  });
  const out = [];
  Object.keys(byLayer).forEach((l) => {
    const list = byLayer[l];
    const ref = list.find((m) => m.isReference) || list[list.length - 1];
    if (ref && ref.batch) out.push(String(ref.batch).startsWith(l) ? ref.batch : (l ? l + "-" + ref.batch : ref.batch));
  });
  return out.join(" / ");
}

function remarkLine(p, v) {
  const layers = Array.from(new Set((v.mixes || []).map((m) => m.layer).filter(Boolean)));
  const byLayer = layers.map((l) => ({ l, plate: layerPlate(v, l) })).filter((x) => x.plate);
  const uniq = Array.from(new Set(byLayer.map((x) => x.plate)));
  let platePart;
  if (!byLayer.length) platePart = (p.work.plate || []).filter(Boolean).join(", ");
  else if (uniq.length === 1) platePart = uniq[0];
  else platePart = byLayer.map((x) => `${x.plate}(${p.pattern.code} ${x.l})`).join(" · ");
  const codes = batchCodes(v);
  return [platePart, codes].filter(Boolean).join(" · ") || "—";
}

/* ---------------- 화면용 데이터 ----------------
   작성 중인 제안서와 확정본을 같은 모양의 데이터로 만들어 같은 함수로 그린다.
   확정할 때는 이 데이터(화면에 보인 값)와 원본 기록(source)을 함께 저장한다. */
const firstPageMax = () => Math.max(1, Number((App.config && App.config.firstPageMax) || 2));
const pageMax = () => Math.max(1, Number((App.config && App.config.pageMax) || 2));

function liveModel(withSource) {
  const comments = App.prop.comments || {};
  return {
    version: 2,
    title: App.prop.title || "RDP 패턴 제안",
    client: App.prop.client || "", by: App.prop.by || "",
    date: App.prop.date || todayLocal(),
    docNo: App.prop.docNo || "", rev: String(App.prop.rev || "0"),
    showComments: !!App.prop.showComments,
    brand: App.config.brand || "RDP", brandSub: App.config.brandSub || "SPECIMEN ARCHIVE", company: App.config.company || "",
    firstPageMax: firstPageMax(), pageMax: pageMax(),
    items: grouped().map(({ p, vars }) => ({
      pattern: Object.assign({ id: p.id, code: p.pattern.code, name: p.pattern.name || "", nameKo: p.pattern.nameKo || "",
        project: p.project || "", projectName: p.projectName || "", client: p.client || "" },
      withSource ? { label: p.label, work: p.work } : {}),
      pageComment: comments[p.id + "::all"] || "",
      variations: vars.map((v) => {
        const lab = labOf(p, v);
        const same = v.sameAs ? (p.variations || []).find((x) => x.id === v.sameAs) : null;
        return Object.assign({
          id: v.id, name: vName(v), colorName: v.colorName || "", colorCode: v.colorCode || "",
          work: workOf(p, v),                 // 컬러별 유효 작업정보(확정본 원본에만)
          images: (v.images || []).slice(0, 1),
          item: lab.item || "", type: lab.type || "", remark: remarkLine(p, v),
          comment: comments[p.id + "::" + v.id] || "",
        }, withSource ? {
          // 확정 당시의 원본 기록 (나중에 시편이 바뀌어도 무엇을 보냈는지 알 수 있게)
          source: { label: v.label || null, layerPlates: v.layerPlates || null, layerPatterns: v.layerPatterns || null,
            sameAs: v.sameAs || null, sameAsMixes: same ? same.mixes || [] : null, note: v.note || "",
            coating: v.coating || [], status: v.status || "", date: v.date || "", rev: v.rev == null ? "" : v.rev,
            mixes: v.mixes || [], images: v.images || [] },
        } : {});
      }),
    })),
  };
}

// 예전 형식 확정본(화면 값 없이 원본만 저장)도 같은 모양으로 맞춘다
function normalizeModel(doc) {
  if (doc.version === 2) return doc;
  const items = (doc.items || []).map((it) => {
    const pt = it.pattern || {};
    const vars = it.variations || [];
    return {
      pattern: { id: pt.id, code: pt.code || "", name: pt.name || "", nameKo: pt.nameKo || "" },
      pageComment: (vars[0] && vars[0].pageComment) || "",
      variations: vars.map((v) => ({
        id: v.id, name: v.colorName || v.colorCode || "기본", colorCode: v.colorCode || "", images: (v.images || []).slice(0, 1),
        item: ((pt.label || {}).item) || "", type: ((pt.label || {}).type) || "", remark: "", comment: v.comment || "",
      })),
    };
  });
  return {
    version: 1, title: doc.title || "RDP 패턴 제안", client: doc.client || "", by: doc.by || "", date: doc.date || "",
    docNo: doc.docNo || "", rev: String(doc.rev || "0"),
    showComments: items.some((it) => it.pageComment || it.variations.some((v) => v.comment)),
    brand: App.config.brand || "RDP", brandSub: App.config.brandSub || "SPECIMEN ARCHIVE", company: App.config.company || "",
    firstPageMax: firstPageMax(), pageMax: pageMax(), items,
  };
}

const docLabel = (m) => (m.docNo ? `${m.docNo} Rev.${m.rev}` : `Rev.${m.rev}`);
const docKey = (m) => `${m.docNo}#${m.rev}`;

// 확정 뒤 내용이 바뀌었는지 비교하는 짧은 지문 (원본 기록은 빼고 화면에 보이는 값만)
function signature(m) {
  const s = JSON.stringify(m);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}

/* ---------------- 그리기 ---------------- */
function splitVars(m, vars) {
  const n = vars.length;
  if (n <= m.firstPageMax) return [vars];
  const count = Math.ceil(n / m.pageMax);
  const base = Math.floor(n / count), rem = n % count;
  const out = []; let i = 0;
  for (let k = 0; k < count; k++) {
    const size = base + (k < rem ? 1 : 0);
    out.push(vars.slice(i, i + size)); i += size;
  }
  return out;
}

const pname = (pt) => [pt.name, pt.nameKo].filter(Boolean).join(" · ");

// ctx: { img(pid, name) → 주소, editable: 제안 포인트를 고칠 수 있는지 }
function imgTag(ctx, pt, v, cls, empty) {
  return v.images && v.images.length
    ? html`<img${cls ? raw(` class="${cls}"`) : ""} src="${ctx.img(pt.id, v.images[0])}" alt="${pt.code} ${v.name}">`
    : raw(empty);
}

function commentBox(ctx, m, key, text) {
  if (!m.showComments) return "";
  if (!ctx.editable && !String(text || "").trim()) return "";
  return html`<div class="p-comment${String(text || "").trim() ? "" : " empty"}"><h4>제안 포인트</h4>
        ${ctx.editable
    ? html`<div class="c" contenteditable="true" data-comment="${key}">${text || ""}</div>`
    : html`<div class="c">${text}</div>`}
      </div>`;
}

const foot = (m, right) => html`<div class="p-foot"><span>${m.company} · <span class="docno">${docLabel(m)}</span></span><span class="ruler"><i></i>30mm</span><span>${right}</span></div>`;

function coverSheet(m, ctx) {
  const flat = m.items.reduce((a, it) => a.concat(it.variations.map((v) => ({ pt: it.pattern, v }))), []);
  const cols = flat.length <= 4 ? Math.max(1, flat.length) : 4;
  return html`<section class="sheet s-cover">
      <div class="cov-top"><div class="cov-brand">${m.brand}<span>${m.brandSub}</span></div>
      <div class="dt">${fmtDate(m.date)}<br><span class="docno">${docLabel(m)}</span></div></div>
      <h1>${m.title}</h1>
      <div class="cov-sub">패턴 ${m.items.length}종 · 컬러 ${flat.length}종</div>
      ${m.client || m.by ? html`<div class="cov-client">
        ${m.client ? html`<div><dt>Client</dt><dd>${m.client}</dd></div>` : ""}
        ${m.by ? html`<div><dt>Prepared by</dt><dd>${m.by}</dd></div>` : ""}
      </div>` : ""}
      <div class="cov-list"><div class="cl-h">SELECTED PATTERNS</div>
        <div class="cov-thumbs" style="grid-template-columns:repeat(${cols},1fr)">${flat.map(({ pt, v }) => html`<figure>
      ${imgTag(ctx, pt, v, "", '<div style="aspect-ratio:170/70;background:#efede8"></div>')}
      <figcaption>${pt.code}${v.name && v.name !== "기본" ? " · " + v.name : ""}</figcaption></figure>`)}</div></div>
      <div class="cov-foot"><span>${m.company} · <span class="docno">${docLabel(m)}</span></span><span class="ruler"><i></i>30mm</span><span>${flat.length} VARIATIONS</span></div>
    </section>`;
}

function pageSingle(m, ctx, it, v, idx, total) {
  const pt = it.pattern;
  return html`<section class="sheet s-page">
      <div class="p-head"><div class="pn">${String(idx + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div></div>
      <div class="p-title">
        <span>PATTERN</span>
        <h2>${pt.code}</h2>
        <div class="pname">${pname(pt)}</div>
      </div>
      ${imgTag(ctx, pt, v, "p-img", '<div class="p-img"></div>')}
      <div class="p-spec">
        <div><span>COLOR</span>${v.name}</div>
        <div><span>ITEM</span>${dash(v.item)}</div>
        <div><span>TYPE</span>${dash(v.type)}</div>
        <div><span>REMARK</span>${v.remark || "—"}</div>
      </div>
      ${commentBox(ctx, m, `${pt.id}::${v.id}`, v.comment)}
      <div class="caution">* 색상은 실물 시편 기준이며 인쇄물은 참고용입니다.</div>
      ${foot(m, pt.code)}
    </section>`;
}

function pageCompare(m, ctx, it, vars, idx, total, part, parts) {
  const pt = it.pattern;
  const letters = "ABCDEFGH";
  const strip = ["item", "type"].map((k) => {
    // 컬러마다 값이 다르면 A/B로 나눠 표기
    const vals = vars.map((v) => v[k] || "");
    const uniq = Array.from(new Set(vals));
    if (!uniq.some(Boolean)) return "";
    const txt = uniq.length === 1 ? uniq[0] : vals.map((x, i) => `${letters[i]} ${x || "—"}`).join(" · ");
    return html`<div><span>${k.toUpperCase()}</span>${txt}</div>`;
  });
  return html`<section class="sheet s-page">
      <div class="p-head"><div class="pn">${String(idx + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div></div>
      <div class="p-title">
        <span>PATTERN</span>
        <h2>${pt.code}</h2>
        <div class="pname">${pname(pt)}${parts > 1 ? ` (계속 ${part}/${parts})` : ""}</div>
      </div>
      <div class="cmp-stack">${vars.map((v, i) => html`<div class="cmp-cell">
        ${imgTag(ctx, pt, v, "", '<div style="width:170mm;height:70mm;background:#efede8"></div>')}
        <span class="ab">${letters[i]}</span>
      </div>`)}</div>
      <div class="cmp-legend">
        <div class="lg-head"><b></b><span>COLOR</span><span>REMARK</span></div>
        ${vars.map((v, i) => html`<div>
        <b>${letters[i]}</b>
        <span class="cn">${v.name}</span>
        <span>${v.remark || "—"}</span>
      </div>`)}
      </div>
      <div class="p-strip">${strip}</div>
      ${commentBox(ctx, m, `${pt.id}::all`, it.pageComment)}
      <div class="caution">* 색상은 실물 시편 기준이며 인쇄물은 참고용입니다. A~${letters[vars.length - 1]}는 실물 크기(170×70mm)로 인쇄됩니다.</div>
      ${foot(m, pt.code)}
    </section>`;
}

function sheetsHTML(m, ctx) {
  const plan = m.items.map((it) => (it.variations.length === 1
    ? { type: "single", it }
    : { type: "compare", it, chunks: splitVars(m, it.variations) }));
  const total = plan.reduce((a, x) => a + (x.type === "single" ? 1 : x.chunks.length), 0);
  let n = 0;
  const pages = [];
  plan.forEach((x) => {
    if (x.type === "single") pages.push(pageSingle(m, ctx, x.it, x.it.variations[0], n++, total));
    else x.chunks.forEach((ch, ci) => pages.push(pageCompare(m, ctx, x.it, ch, n++, total, ci + 1, x.chunks.length)));
  });
  return String(html`<div class="sheets">${coverSheet(m, ctx)}${pages}</div>`);
}

const liveCtx = { img: imgUrl, editable: true };

/* ---------------- 작성 중인 제안서 ---------------- */
function confirmedState(m) {
  const c = App.prop.confirmed;
  if (!c || c.key !== docKey(m)) return null;
  return c.sig === signature(m) ? { ...c, same: true } : { ...c, same: false };
}

function statusHTML(m) {
  const st = confirmedState(m);
  if (!st) return "";
  return st.same
    ? html`<a class="prop-status ok" href="#/proposals/${encodeURIComponent(st.slug)}" title="보관함에서 확정본 보기">✓ 확정됨</a>`
    : html`<span class="prop-status warn" title="다시 확정하면 개정본(Rev+1)이나 새 번호로 저장합니다">확정 후 수정됨</span>`;
}

export function renderProposal() {
  document.body.classList.add("prop-mode");
  if (!App.prop.docNo) {
    App.prop.docNo = "RDP-P-" + String(App.prop.date || todayLocal()).replace(/-/g, "") + "-01";
    saveLS();
  }
  $("#cartbar").className = "cartbar"; $("#cartbar").innerHTML = "";   // 화면 밖에 숨은 버튼도 남기지 않기
  const m = liveModel(false);
  if (!m.items.length) {
    $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><h2>담긴 시편이 없습니다</h2>
        <p>목차에서 카드의 컬러 칩을 눌러 담아보세요. 확정한 제안서는 보관함에 있습니다.</p>
        <button class="btn-dark" id="golist">시편 보러 가기</button> <button class="btn-line" id="goarch">제안서 보관함</button></div></div>`;
    $("#golist").onclick = () => (location.hash = "");
    $("#goarch").onclick = () => (location.hash = "#/proposals");
    return;
  }

  $("#view").innerHTML = String(html`<div class="prop-toolbar"><div class="prop-toolbar-in">
        <button class="btn-line" id="pback">← 목차</button>
        <div class="field"><label for="f-title">제목</label><input class="w-lg" id="f-title" value="${App.prop.title || ""}"></div>
        <div class="field"><label for="f-client">고객</label><input class="w-md" id="f-client" value="${App.prop.client || ""}" placeholder="고객사"></div>
        <div class="field"><label for="f-date">날짜</label><input class="w-sm" id="f-date" value="${App.prop.date || todayLocal()}"></div>
        <div class="field"><label for="f-by">작성</label><input class="w-sm" id="f-by" value="${App.prop.by || ""}"></div>
        <label class="chk-inline" title="켜면 각 페이지에 '제안 포인트' 칸이 생깁니다"><input type="checkbox" id="f-comments"${App.prop.showComments ? raw(" checked") : ""}> 제안 포인트</label>
        <div class="grow"></div>
        <span id="pstatus">${statusHTML(m)}</span>
        <button class="btn-line" id="porder" title="담긴 시편의 순서를 바꿉니다">순서</button>
        <button class="btn-line" id="parchive">보관함</button>
        <button class="btn-line" id="psnapshot">확정 저장</button>
        <button class="btn-dark" id="pprint">인쇄 / PDF</button>
      </div></div>
      <div class="wrap">${raw(sheetsHTML(m, liveCtx))}</div>`);

  const refreshStatus = () => { const el = $("#pstatus"); if (el) el.innerHTML = String(statusHTML(liveModel(false))); };
  $("#pback").onclick = () => (location.hash = "");
  $("#parchive").onclick = () => (location.hash = "#/proposals");
  $("#pprint").onclick = () => window.print();
  $("#porder").onclick = openOrderDialog;
  $("#psnapshot").onclick = saveSnapshot;
  $("#psnapshot").disabled = snapBusy;
  const bindField = (id, key) => {
    const el = $(id);
    el.oninput = () => {
      App.prop[key] = el.value; saveLS();
      const c = $(".s-cover"); if (c) c.outerHTML = String(coverSheet(liveModel(false), liveCtx));
      refreshStatus();
    };
  };
  bindField("#f-title", "title"); bindField("#f-client", "client"); bindField("#f-date", "date"); bindField("#f-by", "by");
  const chkC = $("#f-comments");
  if (chkC) chkC.onchange = (e) => { App.prop.showComments = e.target.checked; saveLS(); renderProposal(); };
  $$("[data-comment]").forEach((el) => (el.oninput = () => {
    App.prop.comments = App.prop.comments || {};
    App.prop.comments[el.dataset.comment] = el.innerText;
    const box = el.closest(".p-comment");
    if (box) box.classList.toggle("empty", !el.innerText.trim());
    saveLS(); refreshStatus();
  }));
}

/* 세 가지 중 고르는 작은 대화상자. 고른 값(또는 null)을 돌려준다 */
function choose(title, message, options) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "recipe-preview choose-dialog";
    dlg.innerHTML = String(html`<h3>${title}</h3><p class="recipe-help">${message}</p>
      <div class="choose-actions">${options.map((o, i) => html`<button type="button" class="${o.primary ? "btn-dark" : "btn-line"}" data-i="${i}">${o.label}</button>`)}
      <button type="button" class="btn-line" data-i="-1">취소</button></div>`);
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    $$("[data-i]", dlg).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.i); done(i < 0 ? null : options[i].value); }));
    dlg.showModal();
  });
}

async function nextDocNo() {
  const prefix = "RDP-P-" + String(App.prop.date || todayLocal()).replace(/-/g, "") + "-";
  try { return (await apiGet(`/api/proposals/next-no?prefix=${encodeURIComponent(prefix)}`)).docNo; } catch (e) { return ""; }
}

// 확정 저장은 한 번에 하나만 — 두 번 누르면 두 번째가 '이미 확정된 번호' 대화상자를 띄우고 보관함에 두 번 들어갔다
let snapBusy = false;
async function saveSnapshot() {
  if (snapBusy) return;
  snapBusy = true;
  const btn = $("#psnapshot");
  if (btn) btn.disabled = true;
  try { await doSaveSnapshot(); } finally {
    snapBusy = false;
    const b = $("#psnapshot");
    if (b) b.disabled = false;
  }
}

// 기다리는 사이 다른 화면으로 갔으면 제안서 화면으로 덮어쓰지 않는다 (상태만 바꿔 둔다)
const refreshProposal = () => { if (location.hash === "#/proposal") renderProposal(); };

async function doSaveSnapshot() {
  if (!App.prop.date) { App.prop.date = todayLocal(); saveLS(); }   // 날짜가 바뀌어도 확정 내용과 비교되게 고정
  let m = liveModel(false);
  // 예전 방식(confirmedDocNo)으로 확정한 기록도 같은 번호로 취급
  if (!App.prop.confirmed && App.prop.confirmedDocNo && App.prop.confirmedDocNo === App.prop.docNo) {
    App.prop.confirmed = { key: docKey(m), sig: "", slug: "" };
  }
  const st = confirmedState(m);
  if (st && st.same) { toast("이미 확정된 내용과 같습니다 — 보관함에서 볼 수 있어요"); return; }
  if (st && !st.same) {
    // 확정한 번호로 내용이 바뀌었다: 같은 번호의 개정본으로 낼지, 새 번호로 낼지 고른다
    const nextRev = String((Number(m.rev) || 0) + 1);
    const fresh = await nextDocNo();
    const pick = await choose("확정 후 내용이 바뀌었어요", `${docLabel(m)}는 이미 확정되어 보관함에 있습니다. 바뀐 내용을 어떻게 저장할까요?`, [
      { label: `개정본 ${m.docNo} Rev.${nextRev}`, value: "rev", primary: true },
      ...(fresh ? [{ label: `새 번호 ${fresh}`, value: "new" }] : []),
    ]);
    if (!pick) return;
    if (pick === "rev") App.prop.rev = nextRev;
    else { App.prop.docNo = fresh; App.prop.rev = "0"; }
    App.prop.date = todayLocal();   // 개정본·새 번호는 오늘 날짜로 다시 낸다
    saveLS(); refreshProposal();
    m = liveModel(false);
  }
  const noImage = m.items.flatMap((it) => it.variations.filter((v) => !v.images.length).map((v) => `${it.pattern.code} ${v.name}`));
  if (noImage.length && !confirm(`이미지가 없는 컬러가 ${noImage.length}개 있습니다.\n${noImage.join("\n")}\n\n빈 칸으로 확정할까요?`)) return;

  const snap = liveModel(true);
  const doc = Object.assign({}, snap, {
    slug: `${snap.date}_${(snap.client || "proposal").replace(/[^\w가-힣-]/g, "")}`,
    createdAt: new Date().toISOString(),
  });
  let body = doc, j = null;
  while (!j) {
    try { j = await apiPost("/api/proposals", body); } catch (e) {
      const x = e.payload || {};
      if (e.status === 409 && x.missing && !body.allowMissing) {
        if (!confirm(`원본 이미지 ${x.missing.length}장을 찾을 수 없습니다.\n${x.missing.join("\n")}\n\n이 이미지 없이 확정할까요?`)) return;
        body = Object.assign({}, doc, { allowMissing: true });
        continue;
      }
      if (e.status === 409 && x.duplicate) {
        // 개정본을 만들던 중이면 다음 Rev를, 새 문서면 새 번호를 먼저 권한다 (전에는 새 번호뿐이라 개정이 막다른 길)
        const opts = [];
        if ((Number(m.rev) || 0) > 0 && x.nextRev) opts.push({ label: `개정본 ${m.docNo} Rev.${x.nextRev}로 확정`, value: "rev", primary: true });
        if (x.suggest) opts.push({ label: `새 번호 ${x.suggest}로 확정`, value: "new", primary: !opts.length });
        const pick = await choose("이미 확정된 번호예요", `${docLabel(m)}는 보관함에 이미 있습니다 (다른 PC에서 확정했을 수 있어요).`, opts);
        if (!pick) return;
        if (pick === "rev") App.prop.rev = x.nextRev; else { App.prop.docNo = x.suggest; App.prop.rev = "0"; }
        saveLS(); refreshProposal();
        return doSaveSnapshot();
      }
      toast("확정 실패: " + e.message);
      return;
    }
  }
  App.prop.confirmed = { key: docKey(m), sig: signature(m), slug: j.slug };
  delete App.prop.confirmedDocNo;
  saveLS(); refreshProposal();
  const miss = (j.missing || []).length;
  toast(`${docLabel(m)} 확정 저장됨 · 이미지 ${j.images || 0}장` + (miss ? ` · 이미지 ${miss}장 없음` : ""));
}

/* ---------------- 확정본 보관함 ---------------- */
const archCtx = (slug) => ({
  img: (pid, name) => `/proposal-img/${encodeURIComponent(slug)}/${encodeURIComponent(pid)}/${encodeURIComponent(name)}`,
  editable: false,
});
const stamp = (s) => { const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(String(s || "")); return m ? `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}` : String(s || "").slice(0, 16).replace("T", " "); };

export async function renderArchive() {
  document.body.classList.add("prop-mode");
  $("#cartbar").className = "cartbar"; $("#cartbar").innerHTML = "";
  $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><p>보관함을 불러오는 중…</p></div></div>`;
  let list = [];
  try { list = (await apiGet("/api/proposals")).proposals || []; } catch (e) { toast("보관함을 불러오지 못했습니다"); }
  if (location.hash !== "#/proposals") return;   // 기다리는 사이 다른 화면으로 이동
  App.archList = list;
  $("#view").innerHTML = String(html`<div class="prop-toolbar"><div class="prop-toolbar-in">
        <button class="btn-line" id="aback">← 목차</button>
        <strong class="arch-title">제안서 보관함</strong><span class="arch-count">${list.length}건</span>
        <div class="grow"></div>
        <div class="field"><label for="arch-q">찾기</label><input class="w-lg" id="arch-q" value="${App.archQ || ""}" placeholder="문서번호 · 제목 · 고객"></div>
        <button class="btn-dark" id="adraft">작성 중인 제안서</button>
      </div></div>
      <div class="wrap" id="arch-body"></div>`);
  $("#aback").onclick = () => (location.hash = "");
  $("#adraft").onclick = () => (location.hash = "#/proposal");
  const qi = $("#arch-q");
  // 찾기: 입력 칸은 그대로 두고 받아 둔 목록만 다시 그린다 (한글 조합이 끊기지 않고, 글자마다 서버에 묻지 않음)
  qi.oninput = () => { App.archQ = qi.value; paintArchive(); };
  paintArchive();
}

function paintArchive() {
  const body = $("#arch-body");
  if (!body) return;
  const list = App.archList || [];
  const q = (App.archQ || "").trim().toLowerCase();
  const rows = list.filter((x) => !q || [x.docNo, x.title, x.client, x.by, x.date].join(" ").toLowerCase().includes(q));
  body.innerHTML = String(html`${rows.length ? html`<div class="arch-list">${rows.map((x) => html`<a class="arch-row" href="#/proposals/${encodeURIComponent(x.slug)}">
          <span class="arch-thumb">${x.thumb ? html`<img src="${archCtx(x.slug).img(x.thumb.pid, x.thumb.name)}?w=240" alt="" loading="lazy">` : ""}</span>
          <span class="arch-main"><b>${x.title || "제안서"}</b><span>${[x.client, x.by].filter(Boolean).join(" · ") || "—"}</span></span>
          <span class="arch-doc">${x.docNo || "—"} <em>Rev.${x.rev}</em></span>
          <span class="arch-n">패턴 ${x.patterns} · 컬러 ${x.variations}${x.missing ? html` · <i class="warn">이미지 ${x.missing}장 없음</i>` : ""}</span>
          <span class="arch-date">${x.date ? fmtDate(x.date) : ""}<small>확정 ${stamp(x.createdAt)}</small></span>
        </a>`)}</div>`
    : html`<div class="empty-state"><h2>${list.length ? "찾는 제안서가 없습니다" : "아직 확정한 제안서가 없습니다"}</h2><p>제안서 화면에서 [확정 저장]을 누르면 여기에 보관됩니다.</p></div>`}`);
}

export async function renderArchived(slug) {
  document.body.classList.add("prop-mode");
  $("#cartbar").className = "cartbar"; $("#cartbar").innerHTML = "";
  const here = () => location.hash === `#/proposals/${encodeURIComponent(slug)}` || location.hash === `#/proposals/${slug}`;
  let res;
  try { res = await apiGet(`/api/proposals/${encodeURIComponent(slug)}`); } catch (e) {
    if (!here()) return;   // 기다리는 사이 다른 화면으로 갔으면 덮어쓰지 않는다
    $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><h2>확정본을 찾을 수 없습니다</h2><button class="btn-line" id="aback">보관함으로</button></div></div>`;
    $("#aback").onclick = () => (location.hash = "#/proposals");
    return;
  }
  if (!here()) return;
  const doc = res.proposal || {};
  const m = normalizeModel(doc);
  const snap = doc._snapshot || {};
  $("#view").innerHTML = String(html`<div class="prop-toolbar"><div class="prop-toolbar-in">
        <button class="btn-line" id="aback">← 보관함</button>
        <span class="arch-badge">확정본</span>
        <strong class="arch-title">${docLabel(m)}</strong>
        <span class="arch-count">${m.title} · 확정 ${stamp(snap.createdAt || doc.createdAt)}${(snap.missing || []).length ? ` · 이미지 ${(snap.missing || []).length}장 없음` : ""}</span>
        <div class="grow"></div>
        <button class="btn-line" id="arevise" title="이 확정본 내용을 작성 중인 제안서로 불러와 개정본(Rev+1)을 만듭니다">개정본 만들기</button>
        <button class="btn-dark" id="aprint">인쇄 / PDF</button>
      </div></div>
      <div class="wrap">${raw(sheetsHTML(m, archCtx(slug)))}</div>`);
  $("#aback").onclick = () => (location.hash = "#/proposals");
  $("#aprint").onclick = () => window.print();
  $("#arevise").onclick = () => reviseFrom(m);
}

// 확정본을 작성 중인 제안서로 불러와 같은 번호의 다음 Rev로 고칠 수 있게 한다
function reviseFrom(m) {
  if (App.cart.length && !confirm("작성 중인 제안서(담긴 시편·제목·코멘트)를 이 확정본 내용으로 바꿉니다. 계속할까요?")) return;
  const cart = [], gone = [], comments = {};
  m.items.forEach((it) => {
    const p = byId(it.pattern.id);
    if (it.pageComment) comments[it.pattern.id + "::all"] = it.pageComment;
    it.variations.forEach((v) => {
      if (p && (p.variations || []).some((x) => x.id === v.id)) cart.push({ pid: it.pattern.id, vid: v.id });
      else gone.push(`${it.pattern.code} ${v.name}`);
      if (v.comment) comments[it.pattern.id + "::" + v.id] = v.comment;
    });
  });
  App.cart = cart;
  Object.assign(App.prop, {
    title: m.title, client: m.client, by: m.by, date: todayLocal(), docNo: m.docNo,
    rev: String((Number(m.rev) || 0) + 1), showComments: m.showComments, comments, confirmed: null,
  });
  delete App.prop.confirmedDocNo;
  saveLS();
  location.hash = "#/proposal";
  toast(gone.length ? `개정본으로 불러왔습니다 · 아카이브에 없는 컬러 ${gone.length}개는 빠졌어요` : `개정본 Rev.${App.prop.rev}로 불러왔습니다`);
}

/* ---------------- cart bar ---------------- */
function pruneCart() {
  if (App.loadErrors && App.loadErrors.length) return;
  const before = App.cart.length;
  App.cart = App.cart.filter((c) => {
    const p = byId(c.pid);
    return p && (p.variations || []).some((v) => v.id === c.vid);
  });
  if (App.cart.length !== before) saveLS();
}

export function renderCart() {
  pruneCart();
  const bar = $("#cartbar");
  $("#cartbtn-n").textContent = App.cart.length;
  const onCatalog = !location.hash || location.hash === "#";
  if (!App.cart.length || !onCatalog) { bar.className = "cartbar"; bar.innerHTML = ""; return; }
  const items = cartItems();
  bar.className = "cartbar show";
  bar.innerHTML = String(html`<div class="cartbar-in">
      <div class="cart-count">선택 <b>${App.cart.length}</b>종</div>
      <div class="cart-thumbs">${items.slice(0, 4).map(({ p, v }) => (v.images && v.images.length ? html`<img src="${imgUrl(p.id, v.images[0])}" alt="">` : ""))}</div>
      <button class="btn-ghost2" id="clearcart">비우기</button>
      <button class="btn-light" id="mkprop">제안서 만들기</button></div>`);
  $("#clearcart").onclick = () => { App.cart = []; resetPropIdentity(); saveLS(); renderCart(); rerender(); };
  $("#mkprop").onclick = () => (location.hash = "#/proposal");
}

/* ---------------- 순서 조정 대화상자 ----------------
 * 제안서 순서 = 장바구니 배열 순서다(cart-order.js 규칙).
 * 시트 위에 버튼을 얹으면 인쇄 규격을 건드릴 위험이 있어, 대화상자를 body 에 붙여 시트와 분리한다.
 * 이동할 때마다 App.cart 를 바꾸고 → 저장 → 시트를 다시 그리고 → 이 대화상자만 갱신한다(초점 유지).
 */
function orderDialogNode() {
  let dlg = document.getElementById("order-dlg");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "order-dlg";
    dlg.className = "order-dialog";
    document.body.appendChild(dlg);
  }
  return dlg;
}

function orderRowsHTML() {
  const groups = groupOrder(App.cart);
  if (!groups.length) return `<p class="ord-empty">담긴 시편이 없습니다.</p>`;
  return groups.map((g, gi) => {
    const p = byId(g.pid);
    const code = (p && p.pattern && p.pattern.code) || g.pid;
    const last = gi === groups.length - 1;
    const colors = g.vids.map((vid, ci) => {
      const v = p && (p.variations || []).find((x) => x.id === vid);
      const nm = v ? (v.colorName || v.colorCode || vid) : vid;
      return `<div class="ord-col">
          <span class="ord-nm">${esc(nm)}</span>
          <button type="button" data-k="col:${g.pid}:${vid}:up"${ci === 0 ? " disabled" : ""} aria-label="${esc(nm)} 위로">↑</button>
          <button type="button" data-k="col:${g.pid}:${vid}:down"${ci === g.vids.length - 1 ? " disabled" : ""} aria-label="${esc(nm)} 아래로">↓</button>
        </div>`;
    }).join("");
    return `<div class="ord-pat">
        <div class="ord-head">
          <b>${esc(code)}</b><span class="ord-n">${g.vids.length}색</span>
          <button type="button" data-k="pat:${g.pid}:up"${gi === 0 ? " disabled" : ""} aria-label="${esc(code)} 위로">↑</button>
          <button type="button" data-k="pat:${g.pid}:down"${last ? " disabled" : ""} aria-label="${esc(code)} 아래로">↓</button>
          <button type="button" class="ord-top" data-k="pat:${g.pid}:top"${gi === 0 ? " disabled" : ""}>맨 위로</button>
        </div>
        ${colors}
      </div>`;
  }).join("");
}

function openOrderDialog() {
  const dlg = orderDialogNode();
  dlg.innerHTML = `<form method="dialog">
      <h3>제안서 순서</h3>
      <p class="ord-hint">패턴을 옮기면 그 컬러들이 함께 움직입니다. 컬러는 같은 패턴 안에서만 옮길 수 있습니다.</p>
      <div class="ord-list" id="ord-list">${orderRowsHTML()}</div>
      <div class="ord-actions"><button type="submit" class="btn-dark">닫기</button></div>
    </form>`;
  bindOrder(dlg);
  if (!dlg.open) dlg.showModal();
}

function bindOrder(dlg) {
  dlg.querySelectorAll("[data-k]").forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.k;
      const parts = key.split(":");
      const kind = parts[0];
      const pid = parts[1];
      if (kind === "pat") {
        const dir = parts[2];                         // up | down | top
        App.cart = movePattern(App.cart, pid, dir === "top" ? "top" : (dir === "up" ? -1 : 1));
      } else {
        const vid = parts[2], dir = parts[3];         // col:<pid>:<vid>:<up|down>
        App.cart = moveColor(App.cart, pid, vid, dir === "up" ? -1 : 1);
      }
      App.cart = normalizeOrder(App.cart);      // 패턴별 연속 유지
      saveLS();
      renderProposal();                          // 시트를 즉시 다시 그린다
      const d = orderDialogNode();
      d.querySelector("#ord-list").innerHTML = orderRowsHTML();
      bindOrder(d);
      const again = d.querySelector(`[data-k="${key}"]`);   // 같은 버튼으로 초점 복귀
      if (again) again.focus();
    };
  });
}
