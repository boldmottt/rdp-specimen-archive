/* RDP 시편 아카이브 — 제안서 · 장바구니 바 */
import { $, $$, App, byId, dash, esc, fmtDate, imgUrl, layers, saveLS, toast, todayLocal, vName } from "./core.js";
import { labOf, layerPlate, pigmentTotal } from "./detail.js";
import { rerender } from "./main.js";

/* ---------------- proposal ---------------- */
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

function coverSheet(groups) {
  const d = App.prop.date || todayLocal();
  const flat = groups.reduce((a, g) => a.concat(g.vars.map((v) => ({ p: g.p, v }))), []);
  const thumbs = flat.map(({ p, v }) => `<figure>
      ${v.images && v.images.length ? `<img src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div style="aspect-ratio:170/70;background:#efede8"></div>'}
      <figcaption>${esc(p.pattern.code)}${(v.colorName || v.colorCode) ? " · " + esc(v.colorName || v.colorCode) : ""}</figcaption></figure>`).join("");
  return `<section class="sheet s-cover">
      <div class="cov-top"><div class="cov-brand">${esc(App.config.brand || "RDP")}<span>${esc(App.config.brandSub || "SPECIMEN ARCHIVE")}</span></div>
      <div class="dt">${esc(fmtDate(d))}<br><span class="docno">${esc(docLabel())}</span></div></div>
      <h1>${esc(App.prop.title || "RDP 패턴 제안")}</h1>
      <div class="cov-sub">패턴 ${groups.length}종 · 컬러 ${flat.length}종</div>
      ${App.prop.client || App.prop.by ? `<div class="cov-client">
        ${App.prop.client ? `<div><dt>Client</dt><dd>${esc(App.prop.client)}</dd></div>` : ""}
        ${App.prop.by ? `<div><dt>Prepared by</dt><dd>${esc(App.prop.by)}</dd></div>` : ""}
      </div>` : ""}
      <div class="cov-list"><div class="cl-h">SELECTED PATTERNS</div>
        <div class="cov-thumbs" style="grid-template-columns:repeat(${flat.length <= 4 ? Math.max(1, flat.length) : 4},1fr)">${thumbs}</div></div>
      <div class="cov-foot"><span>${esc(App.config.company || "")} · <span class="docno">${esc(docLabel())}</span></span><span class="ruler"><i></i>30mm</span><span>${flat.length} VARIATIONS</span></div>
    </section>`;
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

function pageSingle(p, v, idx, total) {
  return `<section class="sheet s-page">
      <div class="p-head"><div class="pn">${String(idx + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div></div>
      <div class="p-title">
        <span>PATTERN</span>
        <h2>${esc(p.pattern.code)}</h2>
        <div class="pname">${esc([p.pattern.name, p.pattern.nameKo].filter(Boolean).join(" · "))}</div>
      </div>
      ${v.images && v.images.length ? `<img class="p-img" src="${imgUrl(p.id, v.images[0])}" alt="${esc(p.pattern.code + " " + vName(v))}">` : '<div class="p-img"></div>'}
      <div class="p-spec">
        <div><span>COLOR</span>${esc(vName(v))}</div>
        <div><span>ITEM</span>${esc(dash(labOf(p, v).item))}</div>
        <div><span>TYPE</span>${esc(dash(labOf(p, v).type))}</div>
        <div><span>REMARK</span>${esc(remarkLine(p, v))}</div>
      </div>
      ${App.prop.showComments ? `<div class="p-comment${((App.prop.comments || {})[p.id + "::" + v.id] || "").trim() ? "" : " empty"}"><h4>제안 포인트</h4>
        <div class="c" contenteditable="true" data-comment="${esc(p.id)}::${esc(v.id)}">${esc((App.prop.comments || {})[p.id + "::" + v.id] || "")}</div>
      </div>` : ""}
      <div class="caution">* 색상은 실물 시편 기준이며 인쇄물은 참고용입니다.</div>
      <div class="p-foot"><span>${esc(App.config.company || "")} · <span class="docno">${esc(docLabel())}</span></span><span class="ruler"><i></i>30mm</span><span>${esc(p.pattern.code)}</span></div>
    </section>`;
}

function mixBlock(v) {
  const rows = layers(v).map((layer) => {
    const list = (v.mixes || []).filter((m) => m.layer === layer);
    const base = list.find((m) => m.isReference) || list[list.length - 1];
    if (!base) return "";
    const inks = Object.entries(base.inks || {}).map(([k, x]) => k + " " + x).join(" · ");
    return `<tr><td>${esc(layer)}</td><td>${esc(base.batch)}</td><td style="text-align:left">${esc(inks || "—")}</td><td>${pigmentTotal(base)}</td><td>${esc((mixingPct(base)) || "")}</td></tr>`;
  }).join("");
  return `<div class="pmix"><div class="pm-h"><span>REPRESENTATIVE MIX</span><span>${(v.mixes || []).length} BATCHES</span></div>
      <table><tr><th>도수</th><th>배합</th><th style="text-align:left">잉크 (g)</th><th>잉크합</th><th>소광/신나/경화</th></tr>${rows}</table></div>`;
}
function mixingPct(m) {
  const p = [];
  if (m.mattingPct != null) p.push(m.mattingPct + "%");
  if (m.thinnerPct != null) p.push(m.thinnerPct + "%");
  if (m.hardenerPct != null) p.push(m.hardenerPct + "%");
  return p.join(" / ");
}

const firstPageMax = () => Math.max(1, Number((App.config && App.config.firstPageMax) || 2));
const pageMax = () => Math.max(1, Number((App.config && App.config.pageMax) || 2));

function splitVars(vars) {
  const n = vars.length;
  if (n <= firstPageMax()) return [vars];
  const count = Math.ceil(n / pageMax());
  const base = Math.floor(n / count), rem = n % count;
  const out = []; let i = 0;
  for (let p = 0; p < count; p++) {
    const size = base + (p < rem ? 1 : 0);
    out.push(vars.slice(i, i + size)); i += size;
  }
  return out;
}

function pageCompare(p, vars, idx, total, part, parts) {
  const letters = "ABCDEFGH";
  const cells = vars.map((v, i) => `<div class="cmp-cell">
        ${v.images && v.images.length ? `<img src="${imgUrl(p.id, v.images[0])}" alt="${esc(p.pattern.code + " " + vName(v))}">` : '<div style="width:170mm;height:70mm;background:#efede8"></div>'}
        <span class="ab">${letters[i]}</span>
      </div>`).join("");
  const legend = vars.map((v, i) => `<div>
        <b>${letters[i]}</b>
        <span class="cn">${esc(vName(v))}</span>
        <span>${esc(remarkLine(p, v))}</span>
      </div>`).join("");
  return `<section class="sheet s-page">
      <div class="p-head"><div class="pn">${String(idx + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div></div>
      <div class="p-title">
        <span>PATTERN</span>
        <h2>${esc(p.pattern.code)}</h2>
        <div class="pname">${esc([p.pattern.name, p.pattern.nameKo].filter(Boolean).join(" · "))}${parts > 1 ? ` (계속 ${part}/${parts})` : ""}</div>
      </div>
      <div class="cmp-stack">${cells}</div>
      <div class="cmp-legend">
        <div class="lg-head"><b></b><span>COLOR</span><span>REMARK</span></div>
        ${legend}
      </div>
      <div class="p-strip">${["item", "type"].map((k) => {
      // 단일 페이지와 같은 값(labOf)을 쓴다. 컬러마다 다르면 A/B로 나눠 표기
      const vals = vars.map((v) => labOf(p, v)[k] || "");
      const uniq = Array.from(new Set(vals));
      if (!uniq.some(Boolean)) return "";
      const txt = uniq.length === 1 ? uniq[0] : vals.map((x, i) => `${letters[i]} ${x || "—"}`).join(" · ");
      return `<div><span>${k.toUpperCase()}</span>${esc(txt)}</div>`;
    }).join("")}
      </div>
      ${App.prop.showComments ? `<div class="p-comment${((App.prop.comments || {})[p.id + "::all"] || "").trim() ? "" : " empty"}"><h4>제안 포인트</h4>
        <div class="c" contenteditable="true" data-comment="${esc(p.id)}::all">${esc((App.prop.comments || {})[p.id + "::all"] || "")}</div>
      </div>` : ""}
      <div class="caution">* 색상은 실물 시편 기준이며 인쇄물은 참고용입니다. A~${letters[vars.length - 1]}는 실물 크기(170×70mm)로 인쇄됩니다.</div>
      <div class="p-foot"><span>${esc(App.config.company || "")} · <span class="docno">${esc(docLabel())}</span></span><span class="ruler"><i></i>30mm</span><span>${esc(p.pattern.code)}</span></div>
    </section>`;
}

function docLabel() {
  const no = (App.prop.docNo || "").trim();
  const rev = (App.prop.rev || "0").toString().trim();
  return no ? `${no} Rev.${rev}` : `Rev.${rev}`;
}

export function renderProposal() {
  document.body.classList.add("prop-mode");
  if (!App.prop.docNo) {
    App.prop.docNo = "RDP-P-" + String(App.prop.date || todayLocal()).replace(/-/g, "") + "-01";
    saveLS();
  }
  const groups = grouped();
  $("#cartbar").className = "cartbar"; $("#cartbar").innerHTML = "";   // 화면 밖에 숨은 버튼도 남기지 않기
  if (!groups.length) {
    $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><h2>담긴 시편이 없습니다</h2>
        <p>목차에서 카드의 컬러 칩을 눌러 담아보세요.</p>
        <button class="btn-dark" id="golist">시편 보러 가기</button></div></div>`;
    $("#golist").onclick = () => (location.hash = "");
    return;
  }

  const pages = [];
  let total = 0;
  const plan = groups.map((g) => {
    if (g.vars.length === 1) return { type: "single", p: g.p, vars: g.vars };
    return { type: "compare", p: g.p, chunks: splitVars(g.vars) };
  });
  plan.forEach((x) => { total += x.type === "single" ? 1 : x.chunks.length; });

  let n = 0;
  let body = "";
  plan.forEach((x) => {
    if (x.type === "single") body += pageSingle(x.p, x.vars[0], n++, total);
    else x.chunks.forEach((ch, ci) => { body += pageCompare(x.p, ch, n++, total, ci + 1, x.chunks.length); });
  });

  $("#view").innerHTML = `<div class="prop-toolbar"><div class="prop-toolbar-in">
        <button class="btn-line" id="pback">← 목차</button>
        <div class="field"><label>제목</label><input class="w-lg" id="f-title" value="${esc(App.prop.title || "")}"></div>
        <div class="field"><label>고객</label><input class="w-md" id="f-client" value="${esc(App.prop.client || "")}" placeholder="고객사"></div>
        <div class="field"><label>날짜</label><input class="w-sm" id="f-date" value="${esc(App.prop.date || todayLocal())}"></div>
        <div class="field"><label>작성</label><input class="w-sm" id="f-by" value="${esc(App.prop.by || "")}"></div>
        <label class="chk-inline" title="켜면 각 페이지에 '제안 포인트' 칸이 생깁니다"><input type="checkbox" id="f-comments"${App.prop.showComments ? " checked" : ""}> 제안 포인트</label>
        <div class="grow"></div>
        <button class="btn-line" id="psnapshot">확정 저장</button>
        <button class="btn-dark" id="pprint">인쇄 / PDF</button>
      </div></div>
      <div class="wrap"><div class="sheets">${coverSheet(groups)}${body}</div></div>`;

  $("#pback").onclick = () => (location.hash = "");
  $("#pprint").onclick = () => window.print();
  $("#psnapshot").onclick = saveSnapshot;
  const bindField = (id, key) => {
    const el = $(id);
    el.oninput = () => { App.prop[key] = el.value; saveLS(); if (key !== "showMix") { const c = $(".s-cover"); if (c) c.outerHTML = coverSheet(groups); } };
  };
  bindField("#f-title", "title"); bindField("#f-client", "client"); bindField("#f-date", "date"); bindField("#f-by", "by");
  const chkC = $("#f-comments");
  if (chkC) chkC.onchange = (e) => { App.prop.showComments = e.target.checked; saveLS(); renderProposal(); };
  $$("[data-comment]").forEach((el) => (el.oninput = () => {
    App.prop.comments = App.prop.comments || {};
    App.prop.comments[el.dataset.comment] = el.innerText;
    const box = el.closest(".p-comment");
    if (box) box.classList.toggle("empty", !el.innerText.trim());
    saveLS();
  }));
}

async function saveSnapshot() {
  // 이미 확정한 번호면 다음 번호로 넘긴 뒤 저장한다. 확정 직후에는 번호를 그대로 두어
  // [확정 저장] → [인쇄/PDF] 순서로 써도 보관본과 인쇄본 번호가 같다.
  if (App.prop.docNo && App.prop.confirmedDocNo === App.prop.docNo) {
    const m = /^(.*-)(\d+)$/.exec(App.prop.docNo);
    if (m) { App.prop.docNo = m[1] + String(Number(m[2]) + 1).padStart(2, "0"); saveLS(); renderProposal(); }
  }
  const groups = grouped();
  const doc = {
    slug: `${App.prop.date || todayLocal()}_${(App.prop.client || "proposal").replace(/[^\w가-힣-]/g, "")}`,
    title: App.prop.title, client: App.prop.client, date: App.prop.date || todayLocal(), by: App.prop.by,
    docNo: App.prop.docNo, rev: App.prop.rev || "0",
    createdAt: new Date().toISOString(),
    items: groups.map((g) => ({
      pattern: { id: g.p.id, code: g.p.pattern.code, name: g.p.pattern.name, nameKo: g.p.pattern.nameKo, project: g.p.project, projectName: g.p.projectName, client: g.p.client,
        label: g.p.label, work: g.p.work },
      variations: g.vars.map((v) => ({ id: v.id, colorName: v.colorName, colorCode: v.colorCode, coating: v.coating, status: v.status, date: v.date,
        images: v.images, mixes: v.mixes,
        comment: (App.prop.comments || {})[g.p.id + "::" + v.id] || "",
        pageComment: (App.prop.comments || {})[g.p.id + "::all"] || "" })),
    })),
  };
  try {
    const r = await fetch("/api/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
    const j = await r.json();
    if (j.ok) {
      App.prop.confirmedDocNo = doc.docNo; saveLS();
      const miss = (j.missing || []).length;
      toast(`${doc.docNo || "제안서"} 확정 저장됨 · 이미지 ${j.images || 0}장` + (miss ? ` · ⚠ 이미지 ${miss}장 없음` : ""));
    } else {
      toast("저장 실패");
    }
  } catch (e) { toast("저장 실패: " + e.message); }
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
  const thumbs = items.slice(0, 4).map(({ p, v }) => v.images && v.images.length ? `<img src="${imgUrl(p.id, v.images[0])}" alt="">` : "").join("");
  bar.className = "cartbar show";
  bar.innerHTML = `<div class="cartbar-in">
      <div class="cart-count">선택 <b>${App.cart.length}</b>종</div>
      <div class="cart-thumbs">${thumbs}</div>
      <button class="btn-ghost2" id="clearcart">비우기</button>
      <button class="btn-light" id="mkprop">제안서 만들기</button></div>`;
  $("#clearcart").onclick = () => { App.cart = []; saveLS(); renderCart(); rerender(); };
  $("#mkprop").onclick = () => (location.hash = "#/proposal");
}
