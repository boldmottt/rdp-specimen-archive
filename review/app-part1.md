# app part 1 (lines 1-407 of 1220)

```
/* RDP 시편 아카이브 v2 — 프론트엔드 */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dash = (v) => (v == null || v === "" || v === "-" ? "—" : v);
  const fmtDate = (d) => (d ? String(d).replace(/-/g, ".") : "—");
  const todayLocal = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = (p) => p + Math.random().toString(36).slice(2, 6);

  const RESULT_LABEL = { ok: "✅ 합격", warn: "⚠️ 조정", ng: "❌ NG", plan: "⏳ 예정", "": "—" };

  const App = {
    patterns: [],
    config: {},
    q: "", project: "all", sort: "recent",
    cart: [],
    prop: { title: "RDP 패턴 제안", client: "", date: "", by: "", comments: {}, showMix: false, note: "" },
    edit: null,
    meeting: false,
    view: "catalog",
  };

  const LS_CART = "rdp2-cart";
  const LS_PROP = "rdp2-prop";

  function loadLS() {
    try { App.cart = JSON.parse(localStorage.getItem(LS_CART)) || []; } catch (e) { App.cart = []; }
    try { App.prop = Object.assign(App.prop, JSON.parse(localStorage.getItem(LS_PROP)) || {}); } catch (e) {}
    try { App.meeting = !!JSON.parse(localStorage.getItem("rdp2-meeting") || "false"); } catch (e) {}
  }
  let uiTimer = null;
  function saveLS() {
    try { localStorage.setItem(LS_CART, JSON.stringify(App.cart)); } catch (e) {}
    try { localStorage.setItem(LS_PROP, JSON.stringify(App.prop)); } catch (e) {}
    try { localStorage.setItem("rdp2-meeting", JSON.stringify(!!App.meeting)); } catch (e) {}
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      fetch("/api/ui", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart: App.cart, prop: App.prop }),
      }).catch(() => {});
    }, 400);
  }

  /* ---------------- api ---------------- */
  async function apiGet(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function apiPut(path, body, rev) {
    const headers = { "Content-Type": "application/json" };
    if (rev) headers["X-Base-Rev"] = rev;
    const r = await fetch(path, { method: "PUT", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) {
      const err = new Error(j.message || "다른 곳에서 먼저 저장되었습니다");
      err.status = 409; err.payload = j; throw err;
    }
    if (!r.ok || j.ok === false) throw new Error((j.errors || [j.error || "저장 실패"]).join(", "));
    return j;
  }
  async function apiDelete(path) {
    const r = await fetch(path, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "삭제 실패");
    return j;
  }
  async function apiUpload(pid, vid, slot, blob, crop) {
    const q = crop ? `?slot=${slot}&x=${crop.x}&y=${crop.y}&w=${crop.w}&h=${crop.h}` : `?slot=${slot}`;
    const r = await fetch(`/api/image/${encodeURIComponent(pid)}/${encodeURIComponent(vid)}${q}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || "업로드 실패");
    return j;
  }

  /* ---------------- helpers ---------------- */
  const byId = (pid) => App.patterns.find((p) => p.id === pid);
  const varOf = (p, vid) => (p ? (p.variations || []).find((v) => v.id === vid) || (p.variations || [])[0] : null);
  const imgUrl = (pid, name) => `/img/${encodeURIComponent(pid)}/${encodeURIComponent(name)}`;
  const vName = (v) => (v && (v.colorName || v.colorCode)) || "기본";
  const vImg = (pid, v) => (v && v.images && v.images.length ? imgUrl(pid, v.images[0]) : "");
  const mixCount = (p, v) => (v && v.mixes ? v.mixes.length : 0);
  const layers = (v) => Array.from(new Set((v && v.mixes ? v.mixes : []).map((m) => m.layer).filter(Boolean)));
  const inCart = (pid, vid) => App.cart.some((c) => c.pid === pid && c.vid === vid);
  function toggleCart(pid, vid) {
    const i = App.cart.findIndex((c) => c.pid === pid && c.vid === vid);
    if (i >= 0) App.cart.splice(i, 1); else App.cart.push({ pid, vid });
    saveLS();
  }

  const colorCache = new Map();
  function avgColor(url) {
    if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 8;
          const x = c.getContext("2d");
          x.drawImage(im, 0, 0, 8, 8);
          const d = x.getImageData(0, 0, 8, 8).data;
          let r = 0, g = 0, b = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
          const n = d.length / 4;
          const col = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
          colorCache.set(url, col); res(col);
        } catch (e) { res(null); }
      };
      im.onerror = () => res(null);
      im.src = url;
    });
  }
  function paintDots(root) {
    $$(".vdot[data-src]", root || document).forEach(async (el) => {
      const c = await avgColor(el.dataset.src);
      if (c) el.style.background = c;
    });
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("on");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), 1800);
  }

  /* ---------------- catalog ---------------- */
  function filtered() {
    const q = App.q.trim().toLowerCase();
    return App.patterns.filter((p) => {
      if (App.project !== "all" && p.project !== App.project) return false;
      if (!q) return true;
      const hay = [p.pattern.code, p.pattern.name, p.pattern.nameKo, p.projectName, p.client, p.label.type,
        (p.pattern.tags || []).join(" "), (p.work.plate || []).join(" "),
        (p.variations || []).map((v) => [v.colorName, v.colorCode, (v.coating || []).map((c) => c.code).join(" ")].join(" ")).join(" ")]
        .join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    }).sort((a, b) => {
      if (App.sort === "code") return (a.project + a.pattern.code).localeCompare(b.project + b.pattern.code);
      if (App.sort === "recent") {
        const da = (a.variations || []).map((v) => v.date).sort().pop() || "";
        const db = (b.variations || []).map((v) => v.date).sort().pop() || "";
        return db.localeCompare(da);
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
    const title = `<span class="c-code">${esc(p.pattern.code)}</span><span class="c-name">${esc([nm, p.pattern.nameKo].filter(Boolean).join(" ") || "")}</span>`;
    const meta = [(p.work.plate || [])[0] ? "동판 " + p.work.plate[0] : "", "컬러 " + vars.length, v && v.status ? esc(v.status) : ""]
      .filter(Boolean).map((x, i) => (i ? "<i></i>" : "") + x).join("") + `<span class="layer-pill">${esc(layers(v).join("·") || "—")}</span>`;
    const chips = vars.length > 1
      ? vars.map((x) => `
      <button class="vchip${x.id === (v && v.id) ? " on" : ""}" data-sel="${esc(x.id)}" title="${esc(vName(x))}">
        ${x.images && x.images.length ? `<span class="vdot" data-src="${imgUrl(p.id, x.images[0])}"></span>` : '<span class="vdot"></span>'}
        <span class="nm">${esc(vName(x))}</span>
      </button>`).join("")
      : (v && v.colorCode && v.colorCode !== "-" ? `<span class="vchip" style="cursor:default"><span class="nm" style="font-family:var(--mono)">${esc(v.colorCode)}</span></span>` : "");
    return `<article class="card${picked ? " picked" : ""}" data-pid="${esc(p.id)}">
      <div class="media">
        ${v && v.images && v.images.length ? `<img loading="lazy" src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div class="empty">IMAGE N/A</div>'}
        <div class="badge">${esc(p.project)}</div>
        <div class="check${picked ? " on" : ""}" data-check="1" title="제안서에 담기">
          <svg viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5"/></svg>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${title}</div>
        <div class="card-meta">${meta}</div>
        <div class="vchips">${chips}</div>
      </div>
    </article>`;
  }

  function renderCatalog() {
    document.body.classList.remove("prop-mode");
    const list = filtered();
    const projects = ["all"].concat(Array.from(new Set(App.patterns.map((p) => p.project))));
    const chips = projects.map((k) => {
      const n = k === "all" ? App.patterns.length : App.patterns.filter((p) => p.project === k).length;
      return `<button class="chip${App.project === k ? " on" : ""}" data-proj="${esc(k)}">${k === "all" ? "전체" : esc(k)}<span class="n">${n}</span></button>`;
    }).join("");
    const totalVar = App.patterns.reduce((a, p) => a + (p.variations || []).length, 0);
    const totalMix = App.patterns.reduce((a, p) => a + (p.variations || []).reduce((b, v) => b + (v.mixes || []).length, 0), 0);

    $("#view").innerHTML = `<div class="wrap">
      <section class="hero">
        <div>
          <div class="eyebrow">Specimen Archive</div>
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
        <div class="selwrap"><select id="sort">
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
    if (of) of.onclick = (e) => { e.preventDefault(); fetch("/api/open-folder").then(() => toast("Finder에서 열었습니다")).catch(() => {}); };
    paintDots();
    $$("[data-proj]").forEach((el) => (el.onclick = () => { App.project = el.dataset.proj; renderCatalog(); }));
    const sel = $("#sort"); if (sel) sel.onchange = (e) => { App.sort = e.target.value; renderCatalog(); };
    $$(".card").forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest("[data-check]") || e.target.closest("[data-sel]")) return;
        const p = byId(el.dataset.pid);
        location.hash = `#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(p._sel || p.variations[0].id)}`;
      };
    });
    $$("[data-sel]").forEach((el) => (el.onclick = (e) => {
      e.stopPropagation();
      const p = byId(el.closest(".card").dataset.pid);
      p._sel = el.dataset.sel;
      renderCatalog();
    }));
    $$("[data-check]").forEach((el) => (el.onclick = (e) => {
      e.stopPropagation();
      const p = byId(el.closest(".card").dataset.pid);
      const v = varOf(p, p._sel);
      if (!v) return;
      toggleCart(p.id, v.id);
      renderCatalog(); renderCart();
    }));
  }

  /* ---------------- detail ---------------- */
  function mixTable(mixes) {
    const cols = ["MT", "BK", "WH", "YE", "RD", "CL", "YE-D"];
    const used = cols.filter((c) => mixes.some((m) => m.inks && m.inks[c] != null));
    const head = `<tr><th>배합</th>${used.map((c) => `<th>${c}</th>`).join("")}<th>소광</th><th>신나</th><th>경화</th><th>잉크합</th><th>결과</th><th>비고</th></tr>`;
    const body = mixes.map((m) => `<tr>
      <td>${esc(m.batch)}${m.isReference ? " *" : ""}</td>
      ${used.map((c) => `<td>${m.inks && m.inks[c] != null ? m.inks[c] : "—"}</td>`).join("")}
      <td>${m.mattingG != null ? m.mattingG : m.mattingPct != null ? m.mattingPct + "%" : "—"}</td>
      <td>${m.thinnerG != null ? m.thinnerG : m.thinnerPct != null ? m.thinnerPct + "%" : "—"}</td>
      <td>${m.hardenerG != null ? m.hardenerG : m.hardenerPct != null ? m.hardenerPct + "%" : "—"}</td>
      <td>${pigmentTotal(m)}</td>
      <td class="res res-${esc(m.result || "")}">${esc(RESULT_LABEL[m.result] || "—")}</td>
      <td class="note">${esc(m.change || m.note || "")}</td></tr>`).join("");
    return `<div class="tbl-wrap"><table class="mix">${head}${body}</table></div>`;
  }
  function pigmentTotal(m) {
    const keys = ["MT", "BK", "WH", "YE", "RD", "CL", "YE-D"];
    const t = keys.reduce((a, k) => a + (Number(m.inks && m.inks[k]) || 0), 0);
    return t ? Math.round(t * 10) / 10 : "—";
  }

  function renderDetail(pid, vid) {
    document.body.classList.remove("prop-mode");
    const p = byId(pid);
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
    const byLayer = layers(v).map((layer) => {
      const rows = mixes.filter((m) => m.layer === layer);
      return `<div class="mixgroup"><h4>${esc(layer)}<span>${rows.length} 배합</span></h4>${mixTable(rows)}</div>`;
    }).join("");

    $("#view").innerHTML = `<div class="wrap">
      <div class="back" id="back"><svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke:currentColor;stroke-width:2;fill:none"><path d="M15 5 8 12l7 7"/></svg>목차로</div>
      <div class="detail${App.meeting ? " meeting" : ""}">
        <div class="span2 d-head-row">
          <div>
            <div class="kicker"><span class="proj">${esc(p.projectName)}</span><span class="mini">${esc(p.client)}</span></div>
            <h1>${esc(p.pattern.code)}</h1>
            <div class="sub">${esc([p.pattern.name, p.pattern.nameKo].filter(Boolean).join(" · ") || p.label.type || "")}</div>
          </div>
          <div class="d-actions">
            <button class="btn-dark${inCart(p.id, v.id) ? " on" : ""}" id="addbtn">${inCart(p.id, v.id) ? "✓ 담김" : "제안서에 담기"}</button>
            <button class="btn-line${App.meeting ? " on" : ""}" id="meetingbtn" title="고객 미팅용: 메모·배합·작업일지·동판 숨김">${App.meeting ? "미팅 모드 ON" : "미팅 모드"}</button>
            <button class="btn-line" id="editbtn">편집</button>
          </div>
        </div>

        <div class="gallery">
          <div class="main" id="mainimg">${images.length ? `<img src="${imgUrl(p.id, images[0])}" alt="">` : '<div class="empty" style="display:grid;place-items:center;height:100%;color:#8d9198;font-size:11px;letter-spacing:.1em">IMAGE N/A</div>'}</div>
          ${images.length > 1 ? `<div class="thumbs">${images.map((im, i) => `<img src="${imgUrl(p.id, im)}" class="${i === 0 ? "on" : ""}" data-img="${esc(im)}">`).join("")}</div>` : ""}
          ${chips ? `<div class="vchips" style="margin-top:14px">${chips}</div>` : ""}
        </div>

        <div class="side">
          <div class="colorcard">
            <div class="eyebrow" style="margin:0">Color</div>
            <div class="cc-name">${esc(vName(v))}</div>
            ${v.colorName && v.colorCode ? `<div class="cc-code">${esc(v.colorCode)}</div>` : ""}
            <div class="cc-row"><span>${esc(dash(v.status))}</span><span>${esc(fmtDate(v.date))}</span>${App.meeting ? "" : `<span>${mixes.length} 배합</span>`}</div>
          </div>
          <section class="sec sec-tight"><h3>도장</h3>
            ${(v.coating || []).length ? (v.coating || []).map((c) => `<div style="margin-bottom:8px;font-size:12.5px"><b style="font-family:var(--mono);font-weight:600">${esc(c.code || "—")}</b><div style="color:#8d9198;font-size:11.5px">${esc([c.maker, c.lot].filter(Boolean).join(" · ") || "")}</div></div>`).join("") : '<p style="color:#8d9198;font-size:12.5px">—</p>'}
          </section>
          <section class="sec sec-plate"><h3>동판</h3>
            ${(p.work.plate || []).length ? `<span class="chipline">${p.work.plate.map((x) => `<span class="mini">${esc(x)}</span>`).join("")}</span>` : "—"}
          </section>
          ${v.note ? `<div class="d-note">${esc(v.note)}</div>` : ""}
        </div>

        <div class="span2 split2">
          <section class="sec"><h3>라벨 정보</h3>
            <dl class="kv">
              <dt>Company</dt><dd>${esc(dash(p.client))}</dd>
              <dt>Project</dt><dd class="mono">${esc(p.project)}</dd>
              <dt>Pattern Code</dt><dd class="mono">${esc(p.pattern.code)}</dd>
              <dt>Pattern Name</dt><dd>${esc(dash(p.pattern.name))}</dd>
              <dt>Item</dt><dd>${esc(dash(p.label.item))}</dd>
              <dt>Type</dt><dd>${esc(dash(p.label.type))}</dd>
              <dt>Supplier</dt><dd>${esc(dash(p.label.supplier))}</dd>
              ${p.label.remark ? `<dt>Remark</dt><dd>${esc(p.label.remark)}</dd>` : ""}
            </dl>
          </section>
          <section class="sec"><h3>작업 정보</h3>
            <dl class="kv">
              <dt>작업 장소</dt><dd>${esc(dash(p.work.place))}</dd>
              <dt>작업자</dt><dd>${esc(dash(p.work.worker))}</dd>
              <dt>설비</dt><dd>${esc(dash(p.work.machine))}</dd>
              <dt>양산 일정</dt><dd>${esc(dash(p.work.sop))}</dd>
              <dt>엠보</dt><dd>${esc(dash(p.work.emboss))}</dd>
              <dt>패드</dt><dd>${esc(dash(p.work.pad))}</dd>
            </dl>
          </section>
        </div>

        <div class="span2">
          <section class="sec sec-mix"><h3>배합 정보 <span class="cnt">${mixes.length} 배합</span></h3>${byLayer || '<p style="color:#8d9198;font-size:12.5px">등록된 배합이 없습니다.</p>'}</section>
          ${(p.history || []).length ? `<section class="sec sec-hist"><h3>작업일지 <span class="cnt">${p.history.length}</span></h3><ul class="timeline">
            ${p.history.map((h) => `<li><span class="d">${esc(fmtDate(h.date))}</span><div><div>${esc(h.title)}</div>${h.summary ? `<div style="color:#8d9198;font-size:11.5px">${esc(h.summary)}</div>` : ""}</div></li>`).join("")}
          </ul></section>` : ""}
        </div>
      </div>
    </div>`;

    $("#back").onclick = () => (location.hash = "");
    $("#addbtn").onclick = () => { toggleCart(p.id, v.id); renderDetail(pid, v.id); renderCart(); };
    $("#editbtn").onclick = () => openEditor(pid, v.id);
    $("#meetingbtn").onclick = () => { App.meeting = !App.meeting; saveLS(); renderDetail(pid, v.id); };
    paintDots();
    $$("[data-vsel]").forEach((el) => (el.onclick = () => { location.hash = `#/p/${encodeURIComponent(pid)}/${encodeURIComponent(el.dataset.vsel)}`; }));
    $$(".thumbs img").forEach((el) => (el.onclick = () => {
      const m = $("#mainimg img"); if (m) m.src = el.dataset.img;
      $$(".thumbs img").forEach((t) => t.classList.remove("on")); el.classList.add("on");
    }));
  }

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
    const thumbs = flat.slice(0, 9).map(({ p, v }) => `<figure>
      ${v.images && v.images.length ? `<img src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div style="aspect-ratio:170/70;background:#efede8"></div>'}
      <figcaption>${esc(p.pattern.code)}${v.colorName ? " · " + esc(v.colorName) : ""}</figcaption></figure>`).join("");
    return `<section class="sheet s-cover">
      <div class="cov-top"><div class="cov-brand">${esc(App.config.brand || "RDP")}<span>${esc(App.config.brandSub || "SPECIMEN ARCHIVE")}</span></div>
      <div class="dt">${esc(fmtDate(d))}<br><span class="docno">${esc(docLabel())}</span></div></div>
```
