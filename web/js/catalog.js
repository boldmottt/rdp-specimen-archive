/* RDP 시편 아카이브 — 목차(카드 그리드) · 검색 · 선택 */
import { $, $$, App, html, raw, apiGet, apiPut, byId, esc, fmtDate, imgUrl, inCart, layers, markSaved, paintDots, revOf, saveLS, thumbUrl, toast, toggleCart, vImg, vName, varOf } from "./core.js";
import { renderCart } from "./proposal.js";

/* ---------------- catalog ---------------- */
function filtered() {
  const q = App.q.trim().toLowerCase();
  return App.patterns.filter((p) => {
    if (App.project !== "all" && p.project !== App.project) return false;
    if (!q) return true;
    const hay = [p.pattern.code, p.pattern.name, p.pattern.nameKo, p.projectName, p.client, p.label.type,
      (p.pattern.tags || []).join(" "), (p.work.plate || []).join(" "),
      (p.variations || []).map((v) => [v.colorName, v.colorCode, (v.coating || []).map((c) => c.code).join(" "),
        // 도수별 동판·패턴 코드와 배합에 적힌 동판도 찾는다
        Object.values(v.layerPlates || {}).join(" "), Object.values(v.layerPatterns || {}).join(" "),
        (v.mixes || []).map((m) => m.plate || "").join(" ")].join(" ")).join(" ")]
      .join(" ").toLowerCase();
    return hay.indexOf(q) >= 0;
  }).sort((a, b) => {
    if (App.sort === "code") return (a.project + a.pattern.code).localeCompare(b.project + b.pattern.code);
    if (App.sort === "recent") {
      const key = (p) => {
        const d = (p.variations || []).map((v) => v.date).filter(Boolean).sort().pop();
        return d || String(p.updatedAt || "").slice(0, 10);
      };
      return key(b).localeCompare(key(a));
    }
    return 0;
  });
}

function cardHTML(p) {
  const vars = p.variations || [];
  const vid = p._sel || (vars[0] && vars[0].id);
  const v = varOf(p, vid) || vars[0];
  const picked = v && inCart(p.id, v.id);
  const nm = p.pattern.name && p.pattern.name !== p.pattern.code ? p.pattern.name : "";
  const title = html`<span class="c-code">${p.pattern.code}</span><span class="c-name">${[nm, p.pattern.nameKo].filter(Boolean).join(" ") || ""}</span>`;
  const when = (v && v.date) ? fmtDate(v.date).slice(2) : (p.updatedAt ? String(p.updatedAt).slice(2, 10).replace(/-/g, ".") : "");
  const metaParts = [(p.work.plate || [])[0] ? "동판 " + p.work.plate[0] : "", "컬러 " + vars.length, v && v.status ? v.status : when];
  const meta = html`${metaParts.filter(Boolean).map((x, i) => html`${i ? raw("<i></i>") : ""}${x}`)}${layers(v).length ? html`<span class="layer-pill">${layers(v).join("·")}</span>` : ""}`;
  const dot = (x) => (x.images && x.images.length ? html`<span class="vdot" data-src="${imgUrl(p.id, x.images[0])}"></span>` : raw('<span class="vdot"></span>'));
  const chips = vars.length > 1
    ? html`${vars.map((x) => html`
      <button class="vchip${inCart(p.id, x.id) ? " in" : ""}${x.id === (v && v.id) ? " on" : ""}" data-sel="${x.id}" data-img="${vImg(p.id, x) || ""}" title="클릭: 제안서에 담기/빼기 · 커서를 올리면 미리보기">
        ${dot(x)}
        <span class="nm">${vName(x)}</span>
      </button>`)}<button class="vchip vchip-all" data-all="1" title="이 패턴의 모든 컬러를 한 번에">${vars.every((x) => inCart(p.id, x.id)) ? "전체 빼기" : `전체 ${vars.length}색`}</button>`
    : (v ? html`
      <button class="vchip${inCart(p.id, v.id) ? " in" : ""}${v.id === vid ? " on" : ""}" data-sel="${v.id}" data-img="${vImg(p.id, v) || ""}" title="클릭: 제안서에 담기/빼기">
        ${dot(v)}
        <span class="nm" style="font-family:var(--mono)">${vName(v)}</span>
      </button>` : "");
  const href = `#/p/${encodeURIComponent(p.id)}${v ? "/" + encodeURIComponent(v.id) : ""}`;
  const alt = [p.pattern.code, v ? vName(v) : ""].filter(Boolean).join(" ");
  const img = (n) => {
    const full = imgUrl(p.id, n);
    return html`<img loading="lazy" src="${thumbUrl(p.id, n, 480)}" srcset="${thumbUrl(p.id, n, 480)} 480w, ${thumbUrl(p.id, n, 960)} 960w, ${full} 2400w" sizes="(max-width:760px) 94vw, (max-width:1180px) 44vw, 340px" onerror="this.onerror=null;this.src='${full}'" alt="${alt}">`;
  };
  return String(html`<article class="card${picked ? " picked" : ""}" data-pid="${p.id}">
      <a class="media" href="${href}" aria-label="${alt} 상세 보기">
        ${v && v.images && v.images.length ? img(v.images[0]) : raw('<div class="empty">IMAGE N/A</div>')}
        ${p.project ? html`<div class="badge">${p.project}</div>` : ""}
      </a>
      <div class="card-body">
        <div class="card-title">${title}</div>
        <div class="card-meta">${meta}</div>
        <div class="vchips">${chips}</div>
      </div>
    </article>`);
}

export function renderCatalog() {
  document.body.classList.remove("prop-mode");
  const list = filtered();
  const projects = ["all"].concat(Array.from(new Set(App.patterns.map((p) => p.project))));
  const chips = projects.map((k) => {
    const n = k === "all" ? App.patterns.length : App.patterns.filter((p) => p.project === k).length;
    return `<button class="chip${App.project === k ? " on" : ""}" data-proj="${esc(k)}">${k === "all" ? "전체" : (k ? esc(k) : "미지정")}<span class="n">${n}</span></button>`;
  }).join("");
  const totalVar = App.patterns.reduce((a, p) => a + (p.variations || []).length, 0);
  const totalMix = App.patterns.reduce((a, p) => a + (p.variations || []).reduce((b, v) => b + (v.mixes || []).length, 0), 0);

  $("#view").innerHTML = `<div class="wrap">
      <section class="hero">
        <div>
          <h1>시편 아카이브</h1>
          <p>패턴 1개에 컬러 베리에이션 여러 개. 이미지·라벨·작업·배합을 한 곳에서 관리하고 바로 제안서로.</p>
        </div>
        <div class="stats">
          <div class="stat"><b>${App.patterns.length}</b><span>패턴</span></div>
          <div class="stat"><b>${totalVar}</b><span>베리에이션</span></div>
          <div class="stat"><b>${totalMix}</b><span>배합</span></div>
        </div>
      </section>
      <div class="toolbar">${chips}<div class="spacer"></div>
        <button class="tool" id="selall" title="지금 보이는 시편을 모두 제안서에 담기">전체 선택<span class="n">${list.reduce((a, p) => a + (p.variations || []).length, 0)}</span></button>
        <button class="tool" id="selnone" title="지금 보이는 시편을 제안서에서 빼기">전체 해제</button>
        <button class="tool" id="syncall" title="RDP-DB의 배합을 모든 시편에 반영">DB 동기화</button>
        <div class="selwrap"><select id="sort" aria-label="정렬">
          <option value="recent"${App.sort === "recent" ? " selected" : ""}>최근 작업순</option>
          <option value="code"${App.sort === "code" ? " selected" : ""}>코드순</option>
        </select></div>
      </div>
      ${list.length ? `<div class="grid">${list.map(cardHTML).join("")}</div>`
      : `<div class="empty-state"><h2>조건에 맞는 시편이 없습니다</h2><p>다른 프로젝트를 선택하거나 검색어를 지워보세요.</p></div>`}
      <div class="foot"><span>${esc(App.config.company || "")} · RDP</span>
        <span style="display:flex;gap:12px;align-items:center">
          <a href="#" id="openfolder" style="text-decoration:underline;text-underline-offset:3px">데이터 폴더 열기</a>
          <span style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(App.config.dataRoot || "")}</span>
        </span></div>
    </div>`;

  const of = $("#openfolder");
  if (of) of.onclick = (e) => { e.preventDefault(); fetch("/api/open-folder", { method: "POST" }).then(() => toast("Finder에서 열었습니다")).catch(() => {}); };
  paintDots();
  $$("[data-proj]").forEach((el) => (el.onclick = () => { App.project = el.dataset.proj; renderCatalog(); }));
  const btnAll = $("#selall");
  if (btnAll) btnAll.onclick = () => {
    filtered().forEach((p) => (p.variations || []).forEach((v) => {
      if (!inCart(p.id, v.id)) App.cart.push({ pid: p.id, vid: v.id });
    }));
    saveLS(); renderCatalog(); renderCart();
  };
  const btnNone = $("#selnone");
  if (btnNone) btnNone.onclick = () => {
    const ids = new Set(filtered().map((p) => p.id));
    App.cart = ids.size === App.patterns.length ? [] : App.cart.filter((c) => !ids.has(c.pid));
    saveLS(); renderCatalog(); renderCart();
  };
  const sel = $("#sort"); if (sel) sel.onchange = (e) => { App.sort = e.target.value; renderCatalog(); };
  const sa = $("#syncall");
  if (sa) sa.onclick = async () => {
    if (!confirm("RDP-DB의 배합을 모든 시편에 반영할까요?\n(기존 배합 수치는 DB 값으로 갱신되고, 메모는 유지됩니다)")) return;
    sa.disabled = true; sa.textContent = "동기화 중…";
    try {
      const r = await fetch("/api/rdp/sync-all", { method: "POST" }).then((x) => x.json());
      if (!r || r.ok === false) throw new Error(r && r.error ? r.error : "동기화 실패");
      const fresh = await apiGet("/api/patterns");
      App.patterns = fresh.patterns || [];
      renderCatalog();
      toast(`동기화 완료 · ${r.patterns}개 시편 / 추가 ${r.added} · 갱신 ${r.updated}`);
    } catch (e) { toast("동기화 실패: " + e.message); sa.disabled = false; sa.textContent = "DB 동기화"; }
  };
  $$("[data-sel]").forEach((el) => {
    const card = el.closest(".card");
    const p = byId(card.dataset.pid);
    const img = () => card.querySelector(".media img");
    el.onmouseenter = () => { const im = img(); if (im && el.dataset.img) im.src = el.dataset.img; };
    el.onmouseleave = () => {
      const im = img(); if (!im) return;
      const cur = varOf(p, p._sel);
      im.src = vImg(p.id, cur) || im.src;
    };
    el.onclick = (e) => {
      e.stopPropagation();
      toggleCart(p.id, el.dataset.sel);
      p._sel = el.dataset.sel;
      const im = img(); if (im && el.dataset.img) im.src = el.dataset.img;
      card.classList.toggle("picked", inCart(p.id, el.dataset.sel));
      card.querySelectorAll("[data-sel]").forEach((b) => b.classList.toggle("in", inCart(p.id, b.dataset.sel)));
      // 썸네일 링크도 방금 고른 컬러로 열리게
      const link = card.querySelector("a.media");
      if (link) link.href = `#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(p._sel)}`;
      const all = card.querySelector("[data-all]");
      if (all) all.textContent = p.variations.every((x) => inCart(p.id, x.id)) ? "전체 빼기" : `전체 ${p.variations.length}색`;
      renderCart();
    };
  });
  $$("[data-all]").forEach((el) => (el.onclick = (e) => {
    e.stopPropagation();
    const p = byId(el.closest(".card").dataset.pid);
    const allIn = p.variations.every((x) => inCart(p.id, x.id));
    if (allIn) App.cart = App.cart.filter((c) => c.pid !== p.id);
    else p.variations.forEach((x) => { if (!inCart(p.id, x.id)) App.cart.push({ pid: p.id, vid: x.id }); });
    saveLS(); renderCatalog(); renderCart();
  }));
}

export async function saveNewPattern() {
  const d = App.newDraft;
  if (!d) return;
  if (!d.project) { toast("프로젝트를 입력하세요"); return; }
  if (!d.pattern.code) { toast("패턴 코드를 입력하세요"); return; }
  const id = (d.project + "-" + d.pattern.code).replace(/[^\w.-]/g, "-");
  const exists = byId(id);
  if (exists) {
    if (confirm(`'${id}' 시편이 이미 있습니다.\n기존 시편을 열까요? (지금 작성한 내용은 저장되지 않습니다)`)) {
      const v0 = (exists.variations && exists.variations[0]) ? exists.variations[0].id : "";
      App.newDraft = null;
      location.hash = `#/p/${encodeURIComponent(id)}${v0 ? "/" + encodeURIComponent(v0) : ""}`;
    } else {
      toast("이미 있는 시편입니다 — 프로젝트나 패턴 코드를 바꾸세요");
    }
    return;
  }
  const payload = { ...JSON.parse(JSON.stringify(d)), id };
  try {
    const r = await apiPut(`/api/patterns/${encodeURIComponent(id)}`, payload, exists ? revOf(exists) : "", !exists);
    const saved = markSaved(JSON.parse(JSON.stringify(payload)), r);
    saved._mtime = Date.now();
    const i = App.patterns.findIndex((x) => x.id === id);
    if (i >= 0) App.patterns[i] = saved; else App.patterns.push(saved);
    App.newDraft = null;
    toast("저장됨");
    location.hash = `#/p/${encodeURIComponent(id)}/${encodeURIComponent(saved.variations[0].id)}`;
  } catch (e) {
    if (e.status === 409) toast("같은 ID의 시편이 이미 있습니다");
    else toast("저장 실패: " + e.message);
  }
}
