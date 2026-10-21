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
        body: JSON.stringify({ cart: App.cart, prop: App.prop, ts: (App.prop.ts = Date.now()) }),
      }).catch(() => {});
    }, 400);
  }

  /* ---------------- api ---------------- */
  async function apiGet(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function apiPut(path, body, rev, create) {
    const headers = { "Content-Type": "application/json" };
    if (rev) headers["X-Base-Rev"] = rev;
    if (create) headers["X-Create"] = "1";
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
      <h1>${esc(App.prop.title || "RDP 패턴 제안")}</h1>
      <div class="cov-sub">패턴 ${groups.length}종 · 컬러 ${flat.length}종</div>
      <div class="cov-client">
        <div><dt>Client</dt><dd>${esc(App.prop.client || "—")}</dd></div>
        <div><dt>Prepared by</dt><dd>${esc(App.prop.by || "—")}</dd></div>
      </div>
      <div class="cov-list"><div class="cl-h">SELECTED PATTERNS</div>
        <div class="cov-thumbs" style="grid-template-columns:repeat(${flat.length <= 4 ? Math.max(1, flat.length) : 3},1fr)">${thumbs}</div></div>
      <div class="cov-foot"><span>${esc(App.config.company || "")} · <span class="docno">${esc(docLabel())}</span></span><span class="ruler"><i></i>30mm</span><span>${flat.length} VARIATIONS</span></div>
    </section>`;
  }

  function pageSingle(p, v, idx, total) {
    return `<section class="sheet s-page">
      <div class="p-head"><div>
        <div class="pn">${String(idx + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div>
        <h2>${esc(p.pattern.code)}</h2>
        <div class="pname">${esc([v.colorName, v.colorCode].filter(Boolean).join(" · ") || [p.pattern.name, p.pattern.nameKo].filter(Boolean).join(" · "))}</div>
      </div><div class="ptag">${esc(p.project)}<br>${esc(p.client)}</div></div>
      ${v.images && v.images.length ? `<img class="p-img" src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div class="p-img"></div>'}
      <div class="p-body">
        <div class="p-sec"><h4>SPECIFICATION</h4><dl>
          <dt>Color</dt><dd>${esc(vName(v))}</dd>
          ${v.colorName && v.colorCode ? `<dt>Color Code</dt><dd class="mono">${esc(v.colorCode)}</dd>` : ""}
          <dt>Item</dt><dd>${esc(dash(p.label.item))}</dd>
          <dt>Type</dt><dd>${esc(dash(p.label.type))}</dd>
          <dt>동판</dt><dd class="mono">${esc((p.work.plate || []).join(", ") || "—")}</dd>
          ${(() => { const cs = (v.coating || []).filter((c) => c.code && c.code !== v.colorCode);
                     return cs.length ? `<dt>도장</dt><dd>${esc(cs.map((c) => [c.code, c.lot].filter(Boolean).join(" ")).join(", "))}</dd>` : ""; })()}
          <dt>엠보</dt><dd>${esc(dash(p.work.emboss))}</dd>
        </dl></div>
        <div class="p-sec"><h4>PROJECT</h4><dl>
          <dt>차종</dt><dd>${esc(p.projectName)}</dd>
          <dt>고객</dt><dd>${esc(p.client || "—")}</dd>
          <dt>상태</dt><dd>${esc(dash(v.status))}</dd>
          <dt>양산 일정</dt><dd>${esc(dash(p.work.sop))}</dd>
          <dt>작업일</dt><dd class="mono">${esc(fmtDate(v.date))}</dd>
          ${App.prop.showMix ? `<dt>배합</dt><dd>${(v.mixes || []).length}건</dd>` : ""}
        </dl></div>
      </div>
      ${v.note ? `<div class="p-note"><h4>NOTE</h4><p>${esc(v.note)}</p></div>` : ""}
      ${App.prop.showMix ? mixBlock(v) : ""}
      <div class="p-comment${((App.prop.comments || {})[p.id + "::" + v.id] || "").trim() ? "" : " empty"}"><h4>제안 포인트</h4>
        <div class="c" contenteditable="true" data-comment="${esc(p.id)}::${esc(v.id)}">${esc((App.prop.comments || {})[p.id + "::" + v.id] || "")}</div>
      </div>
      <div class="caution">* 색상은 실물 시편 기준이며 인쇄물은 참고용입니다. 배합 정보는 사내 검토용입니다.</div>
      <div class="p-foot"><span>${esc(App.config.company || "")} · <span class="docno">${esc(docLabel())}</span></span><span class="ruler"><i></i>30mm</span><span>${esc(p.project)} / ${esc(p.pattern.code)}${v.colorName ? " / " + esc(v.colorName) : ""}</span></div>
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
        ${v.images && v.images.length ? `<img src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div style="width:170mm;height:70mm;background:#efede8"></div>'}
        <span class="ab">${letters[i]}</span>
      </div>`).join("");
    const legend = vars.map((v, i) => {
      const codes = (v.coating || []).map((c) => c.code).filter(Boolean).filter((c) => c !== v.colorCode);
      const nm = [vName(v), v.colorName ? v.colorCode : ""].filter(Boolean).join(" · ");
      return `<div>
        <b>${letters[i]}</b>
        <span class="cn">${esc(nm)}</span>
        <span>${codes.length ? "도장 " + esc(codes.join(", ")) : "—"}</span>
        <span>${esc(v.status || "—")}</span>
        <span class="dt">${v.date ? esc(fmtDate(v.date)) : "—"}</span>
      </div>`;
    }).join("");
    return `<section class="sheet s-page">
      <div class="p-head"><div>
        <div class="pn">${String(idx + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div>
        <h2>${esc(p.pattern.code)}</h2>
        <div class="pname">컬러 비교 · ${esc([p.pattern.name, p.pattern.nameKo].filter(Boolean).join(" · "))}${parts > 1 ? ` (계속 ${part}/${parts})` : ""}</div>
      </div><div class="ptag">${esc(p.project)}<br>${esc(p.client)}</div></div>
      <div class="cmp-stack">${cells}</div>
      <div class="cmp-legend">
        <div class="lg-head"><b></b><span>COLOR</span><span>도장</span><span>상태</span><span class="dt">날짜</span></div>
        ${legend}
      </div>
      <div class="p-strip">
        ${p.label.item ? `<div><span>ITEM</span>${esc(p.label.item)}</div>` : ""}
        ${p.label.type ? `<div><span>TYPE</span>${esc(p.label.type)}</div>` : ""}
        ${p.label.supplier ? `<div><span>SUPPLIER</span>${esc(p.label.supplier)}</div>` : ""}
        ${(p.work.plate || []).length ? `<div><span>동판</span>${esc((p.work.plate || []).join(", "))}</div>` : ""}
        ${p.work.sop ? `<div><span>양산</span>${esc(p.work.sop)}</div>` : ""}
        ${p.work.emboss ? `<div><span>엠보</span>${esc(p.work.emboss)}</div>` : ""}
      </div>
      <div class="p-comment"><h4>제안 포인트</h4>
        <div class="c" contenteditable="true" data-comment="${esc(p.id)}::all">${esc((App.prop.comments || {})[p.id + "::all"] || "")}</div>
      </div>
      <div class="caution">* 색상은 실물 시편 기준이며 인쇄물은 참고용입니다. A~${letters[vars.length - 1]}는 실물 크기(170×70mm)로 인쇄됩니다.</div>
      <div class="p-foot"><span>${esc(App.config.company || "")} · <span class="docno">${esc(docLabel())}</span></span><span class="ruler"><i></i>30mm</span><span>${esc(p.project)} / ${esc(p.pattern.code)}</span></div>
    </section>`;
  }

  function docLabel() {
    const no = (App.prop.docNo || "").trim();
    const rev = (App.prop.rev || "0").toString().trim();
    return no ? `${no} Rev.${rev}` : `Rev.${rev}`;
  }

  function renderProposal() {
    document.body.classList.add("prop-mode");
    if (!App.prop.docNo) {
      App.prop.docNo = "RDP-P-" + String(App.prop.date || todayLocal()).replace(/-/g, "") + "-01";
      saveLS();
    }
    const groups = grouped();
    $("#cartbar").className = "cartbar";
    if (!groups.length) {
      $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><h2>담긴 시편이 없습니다</h2>
        <p>목차에서 카드의 체크 버튼이나 컬러 칩을 눌러 담아보세요.</p>
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
        <label class="toggle"><input type="checkbox" id="f-mix" ${App.prop.showMix ? "checked" : ""}> 배합 표시(사내용)</label>
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
    $("#f-mix").onchange = (e) => { App.prop.showMix = e.target.checked; saveLS(); renderProposal(); };
    $$("[data-comment]").forEach((el) => (el.oninput = () => {
      App.prop.comments = App.prop.comments || {};
      App.prop.comments[el.dataset.comment] = el.innerText;
      const box = el.closest(".p-comment");
      if (box) box.classList.toggle("empty", !el.innerText.trim());
      saveLS();
    }));
  }

  async function saveSnapshot() {
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
          images: v.images, mixes: App.prop.showMix ? v.mixes : undefined,
          comment: (App.prop.comments || {})[g.p.id + "::" + v.id] || "",
          pageComment: (App.prop.comments || {})[g.p.id + "::all"] || "" })),
      })),
    };
    try {
      const r = await fetch("/api/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
      const j = await r.json();
      if (j.ok) {
        const m = /^(.*-)(\d+)$/.exec(App.prop.docNo || "");
        if (m) { App.prop.docNo = m[1] + String(Number(m[2]) + 1).padStart(2, "0"); saveLS(); renderProposal(); }
        toast("제안서 스냅샷 저장됨 · 이미지 " + (j.images || 0) + "장");
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

  function renderCart() {
    pruneCart();
    const bar = $("#cartbar");
    $("#cartbtn-n").textContent = App.cart.length;
    if (!App.cart.length) { bar.className = "cartbar"; bar.innerHTML = ""; return; }
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

  /* ---------------- editor drawer ---------------- */
  const E = { draft: null, vIdx: 0, tab: "base", pid: null, isNew: false, msg: "" };

  function openEditor(pid, vid) {
    E.isNew = !pid;
    E.pid = pid;
    E.baseRev = pid ? (byId(pid) || {}).updatedAt || "" : "";
    E.draft = pid ? clone(byId(pid)) : newDoc();
    if (pid) { delete E.draft._file; delete E.draft._mtime; }
    E.vIdx = Math.max(0, E.draft.variations.findIndex((v) => v.id === vid));
    if (E.vIdx < 0) E.vIdx = 0;
    E.tab = "base"; E.msg = ""; E.origJson = JSON.stringify(E.draft); E.jsonErr = null;
    $("#drawer-title").textContent = pid ? byId(pid).pattern.code + " 편집" : "새 시편";
    syncTabs();
    renderDrawer();
    $("#drawer").classList.add("on"); $("#drawer-scrim").classList.add("on");
  }
  function isDirty() {
    return !!(E.draft && E.origJson && JSON.stringify(E.draft) !== E.origJson);
  }

  function closeEditor(force) {
    if (!force && isDirty()) {
      if (!confirm("저장하지 않은 변경이 있습니다. 닫을까요?")) return;
    }
    $("#drawer").classList.remove("on"); $("#drawer-scrim").classList.remove("on");
    E.draft = null; E.origJson = null;
  }
  function syncTabs() { $$("#drawer-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === E.tab)); }

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

  function newDoc() {
    return {
      schemaVersion: 2, id: "", project: "", projectName: "", client: "",
      nextVarSeq: 2,
      pattern: { code: "", name: "", nameKo: "", tags: [] },
      label: { item: "", type: "", supplier: "", remark: "" },
      work: { place: "", worker: "", machine: "", plate: [], emboss: "", pad: "", sop: "", volume: "" },
      variations: [{ id: "v01", colorName: "기본", colorCode: "", coating: [], status: "", date: todayLocal(), images: [], mixes: [], note: "" }],
      history: [],
    };
  }

  function fieldRow(label, key, opts) {
    const o = opts || {};
    const val = key.split(".").reduce((a, k) => (a == null ? "" : a[k]), E.draft) ?? "";
    const v = Array.isArray(val) ? val.join(", ") : val;
    if (o.type === "textarea") return `<div class="field-row"><label>${label}</label><textarea data-k="${key}" placeholder="${o.ph || ""}">${esc(v)}</textarea></div>`;
    if (o.type === "select") return `<div class="field-row"><label>${label}</label><select data-k="${key}">${o.options.map((x) => `<option value="${esc(x)}"${x === v ? " selected" : ""}>${esc(x || "—")}</option>`).join("")}</select></div>`;
    return `<div class="field-row"><label>${label}</label><input data-k="${key}" value="${esc(v)}" placeholder="${o.ph || ""}" ${o.mono ? 'style="font-family:var(--mono);font-size:12px"' : ""}></div>`;
  }

  function renderDrawer() {
    const d = E.draft;
    let body = "";
    if (E.tab === "base") {
      body = `<div class="sec-label">패턴</div>
        ${fieldRow("프로젝트", "project", { ph: "NX5a" })}
        ${fieldRow("차종명", "projectName", { ph: "NX5a (투싼)" })}
        ${fieldRow("고객", "client", { ph: "현대자동차" })}
        ${fieldRow("패턴 코드", "pattern.code", { ph: "WB7", mono: true })}
        ${fieldRow("영문명", "pattern.name", { ph: "Wood" })}
        ${fieldRow("한글명", "pattern.nameKo", { ph: "우드" })}
        ${fieldRow("태그", "pattern.tags", { ph: "우드, 엠보, 도어" })}
        <div class="sec-label">라벨</div>
        ${fieldRow("품목", "label.item", { ph: "도어 격자" })}
        ${fieldRow("구분", "label.type", { ph: "2도 인쇄" })}
        ${fieldRow("공급사", "label.supplier", { ph: "니프코코리아" })}
        ${fieldRow("비고", "label.remark")}
        <div class="sec-label">작업</div>
        ${fieldRow("작업 장소", "work.place")}
        ${fieldRow("작업자", "work.worker")}
        ${fieldRow("설비", "work.machine")}
        ${fieldRow("동판", "work.plate", { ph: "26_027, 26_045" })}
        ${fieldRow("엠보", "work.emboss")}
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
        ${fieldRow("작업일", "variations." + E.vIdx + ".date", { ph: "2026-10-22" })}
        ${fieldRow("메모", "variations." + E.vIdx + ".note", { type: "textarea", ph: "2도 톤 미세조정 단계" })}
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
      const inkCols = ["MT", "BK", "WH", "YE", "RD", "CL", "YE-D"];
      const head = `<tr><th></th><th>도수</th><th>배합</th>${inkCols.map((c) => `<th>${c}</th>`).join("")}<th>소광%</th><th>신나%</th><th>경화%</th><th>결과</th><th>기준</th><th></th></tr>`;
      const rows = (v.mixes || []).map((m, mi) => `<tr data-mi="${mi}">
        <td><input type="checkbox" data-pick="${mi}" style="accent-color:#141517"></td>
        <td><input data-mf="layer" value="${esc(m.layer || "")}" style="width:44px"></td>
        <td><input data-mf="batch" value="${esc(m.batch || "")}" style="width:66px"></td>
        ${inkCols.map((c) => `<td><input data-mf="ink:${c}" value="${m.inks && m.inks[c] != null ? m.inks[c] : ""}" style="width:38px"></td>`).join("")}
        <td><input data-mf="mattingPct" value="${m.mattingPct != null ? m.mattingPct : ""}" style="width:42px"></td>
        <td><input data-mf="thinnerPct" value="${m.thinnerPct != null ? m.thinnerPct : ""}" style="width:42px"></td>
        <td><input data-mf="hardenerPct" value="${m.hardenerPct != null ? m.hardenerPct : ""}" style="width:42px"></td>
        <td><select data-mf="result" style="width:74px">${Object.keys(RESULT_LABEL).map((k) => `<option value="${k}"${k === (m.result || "") ? " selected" : ""}>${RESULT_LABEL[k]}</option>`).join("")}</select></td>
        <td><input type="checkbox" data-mf="isReference" ${m.isReference ? "checked" : ""}></td>
        <td class="act"><button class="mini-btn danger" data-delmix="${mi}">✕</button></td></tr>`).join("");
      body = `<div class="sec-label">배합 — ${esc(d.pattern.code || "")} / ${esc(vName(v))}</div>
        <div class="tbl-wrap" style="margin:0 -6px"><table class="mix-edit">${head}${rows}</table></div>
        <div style="display:flex;gap:6px;margin-top:12px">
          <button class="mini-btn" id="add-mix">+ 배합 추가</button>
          <button class="mini-btn" id="dup-mix">마지막 배합 복제</button>
        </div>
        ${d.variations.length > 1 ? `<div style="display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap">
          <span style="font-size:11px;color:#8d9198">체크한 배합을</span>
          <select id="move-to" style="border:1px solid var(--line-2);border-radius:7px;padding:5px 8px;font-size:11.5px">
            ${d.variations.filter((_, i) => i !== E.vIdx).map((x) => `<option value="${esc(x.id)}">${esc(vName(x))}</option>`).join("")}
          </select>
          <span style="font-size:11px;color:#8d9198">로</span>
          <button class="mini-btn" id="move-mix">이동</button>
        </div>` : ""}
        <p style="font-size:11px;color:#8d9198;margin-top:14px">잉크 값은 g 단위. 소광·신나·경화는 %로 입력하면 제안서에 그대로 표기됩니다. 결과는 합격/조정/NG/예정 중 선택.</p>`;
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
    $("#drawer-msg").textContent = E.msg;
    $("#drawer-msg").className = "msg" + (E.msg && E.msg.indexOf("저장") === 0 ? "" : E.msg ? " err" : "");

    // bindings
    $$("[data-k]").forEach((el) => (el.oninput = () => {
      const path = el.dataset.k.split(".");
      let obj = E.draft;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
      let val = el.value;
      if (path[path.length - 1] === "tags" || path[path.length - 1] === "plate") val = val.split(",").map((s) => s.trim()).filter(Boolean);
      obj[path[path.length - 1]] = val;
    }));

    if (E.tab === "var") {
      $$("[data-vidx]").forEach((el) => (el.onclick = () => { E.vIdx = Number(el.dataset.vidx); renderDrawer(); }));
      $("#add-var").onclick = () => {
        d.variations.push({ id: nextVarId(d), colorName: "", colorCode: "", coating: [], status: "", date: todayLocal(), images: [], mixes: [], note: "" });
        E.vIdx = d.variations.length - 1; renderDrawer();
      };
      $("#dup-var").onclick = () => {
        const src = clone(d.variations[E.vIdx]);
        src.id = nextVarId(d);
        src.images = [];
        src.colorName = (src.colorName || "기본") + " 복사";
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
          else if (["mattingPct", "thinnerPct", "hardenerPct"].includes(f)) {
            const num = parseFloat(el.value); m[f] = isNaN(num) ? null : num;
          } else m[f] = el.value;
        };
        el.oninput = handler; el.onchange = handler;
      });
      $$("[data-delmix]").forEach((el) => (el.onclick = () => { v.mixes.splice(Number(el.dataset.delmix), 1); renderDrawer(); }));
      $("#add-mix").onclick = () => { v.mixes.push({ layer: "1도", batch: "", inks: { MT: 0, BK: 0 }, mattingPct: 2, thinnerPct: 30, hardenerPct: 20, result: "", isReference: false, note: "", change: "" }); renderDrawer(); };
      $("#dup-mix").onclick = () => { if (!v.mixes.length) return; const c = clone(v.mixes[v.mixes.length - 1]); c.batch = (c.batch || "") + "-C"; c.isReference = false; v.mixes.push(c); renderDrawer(); };
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
        try { E.draft = JSON.parse(e.target.value); E.jsonErr = null; }
        catch (err) { E.jsonErr = err.message; }
      };
    }

    const del = $("#del-pattern");
    if (del) del.onclick = async () => {
      if (!confirm("이 시편을 삭제할까요? JSON과 이미지가 _trash로 이동합니다.")) return;
      try {
        await apiDelete(`/api/patterns/${encodeURIComponent(E.draft.id)}`);
        App.patterns = App.patterns.filter((x) => x.id !== E.draft.id);
        closeEditor(); location.hash = ""; renderCatalog(); renderCart();
        toast("삭제됨");
      } catch (e) { E.msg = "삭제 실패: " + e.message; renderDrawer(); }
    };
  }

  async function saveDraft() {
    if (!E.draft) return;
    let d = E.draft;
    try {
      if (E.tab === "json" && $("#jsonarea")) {
        try { d = E.draft = JSON.parse($("#jsonarea").value); } catch (e) {
          const msg = $("#drawer-msg");
          if (msg) { msg.textContent = "JSON 문법 오류 — 고친 뒤 다시 저장하세요"; msg.className = "msg err"; }
          return;
        }
      }
      if (!d.pattern.code) { E.msg = "패턴 코드를 입력하세요"; E.tab = "base"; syncTabs(); renderDrawer(); return; }
      if (!d.id) {
        if (!d.project) { E.msg = "프로젝트를 입력하세요"; E.tab = "base"; syncTabs(); renderDrawer(); return; }
        d.id = (d.project + "-" + d.pattern.code).replace(/[^\w.-]/g, "-");
        if (byId(d.id) && !confirm(`이미 '${d.id}' 시편이 있습니다. 덮어쓸까요?`)) {
          d.id = ""; E.msg = "저장 취소 — 패턴 코드를 바꾸세요"; renderDrawer(); return;
        }
      }
      E.msg = "저장 중…"; renderDrawer();
      const payload = {};
      Object.keys(d).forEach((k) => { if (!k.startsWith("_")) payload[k] = d[k]; });
      const r = await apiPut(`/api/patterns/${encodeURIComponent(d.id)}`, payload, E.baseRev, E.isNew);
      const idx = App.patterns.findIndex((x) => x.id === d.id);
      const saved = clone(d); saved._mtime = Date.now();
      if (r.savedAt) { saved.updatedAt = r.savedAt; E.baseRev = r.savedAt; }
      if (idx >= 0) App.patterns[idx] = saved; else App.patterns.push(saved);
      const vids = new Set((d.variations || []).map((v) => v.id));
      App.cart = App.cart.filter((c) => c.pid !== d.id || vids.has(c.vid));
      if (App.prop.comments) {
        Object.keys(App.prop.comments).forEach((k) => {
          const [pid, vid] = k.split("::");
          if (pid === d.id && !vids.has(vid)) delete App.prop.comments[k];
        });
      }
      saveLS();
      E.msg = "저장됨 " + (r.savedAt || "");
      E.isNew = false;
      E.origJson = JSON.stringify(saved);
      toast("저장됨");
      rerender();
      closeEditor();
    } catch (e) {
      if (e.status === 409 && e.payload && e.payload.current) {
        const ok = confirm("다른 곳에서 먼저 저장되었습니다.\n최신 내용을 불러올까요? 지금 편집 중인 내용은 사라집니다.");
        if (ok) {
          const cur = e.payload.current;
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

  /* ---------------- crop ---------------- */
  const C = { file: null, img: null, z: 1, cx: 0.5, cy: 0.5, slot: 1 };

  function stageSize() {
    const el = $("#crop-stage");
    return { W: el.clientWidth, H: el.clientHeight };
  }
  function baseScale(W, H) {
    return Math.max(W / C.img.naturalWidth, H / C.img.naturalHeight);
  }
  function clampC() {
    if (!C.img) return;
    const { W, H } = stageSize();
    if (!W || !H) return;
    const s = baseScale(W, H) * C.z;
    const visW = W / s / C.img.naturalWidth;
    const visH = H / s / C.img.naturalHeight;
    const mx = Math.max(0, (1 - visW) / 2);
    const my = Math.max(0, (1 - visH) / 2);
    C.cx = Math.min(1 - mx, Math.max(mx, C.cx));
    C.cy = Math.min(1 - my, Math.max(my, C.cy));
  }
  function layoutCrop() {
    if (!C.img) return;
    const { W, H } = stageSize();
    if (!W || !H) return;
    clampC();
    const s = baseScale(W, H) * C.z;
    const dw = C.img.naturalWidth * s, dh = C.img.naturalHeight * s;
    const left = W / 2 - C.cx * dw;
    const top = H / 2 - C.cy * dh;
    const el = $("#crop-img");
    el.style.width = dw + "px";
    el.style.height = dh + "px";
    el.style.transform = `translate(${left}px, ${top}px)`;
  }
  function cropRect() {
    const { W, H } = stageSize();
    const s = baseScale(W, H) * C.z;
    const sw = W / s, sh = H / s;
    const iw = C.img.naturalWidth, ih = C.img.naturalHeight;
    let x = C.cx * iw - sw / 2;
    let y = C.cy * ih - sh / 2;
    x = Math.max(0, Math.min(x, Math.max(0, iw - sw)));
    y = Math.max(0, Math.min(y, Math.max(0, ih - sh)));
    return { x, y, w: Math.min(sw, iw), h: Math.min(sh, ih) };
  }

  function startCrop(file, opt) {
    C.file = file; C.slot = (opt && opt.slot) || 1;
    C.z = 1; C.cx = 0.5; C.cy = 0.5;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      C.img = img;
      $("#crop-img").src = url;
      $("#crop-modal").classList.add("on");
      $("#crop-zoom").value = 100;
      $("#crop-info").textContent = `원본 ${img.naturalWidth}×${img.naturalHeight}`;
      requestAnimationFrame(layoutCrop);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type || "")) {
        toast("HEIC 미리보기 불가 — 가운데 기준으로 잘라 저장합니다");
        uploadCenter();
      } else {
        toast("이미지를 읽을 수 없습니다");
      }
    };
    img.src = url;
  }

  async function commitUpload(res) {
    if (!E.draft || !E.draft.variations[E.vIdx]) return;
    const v = E.draft.variations[E.vIdx];
    v.images = v.images || [];
    v.images[C.slot - 1] = res.file;
    v.images = v.images.filter(Boolean);
    renderDrawer();
    toast(res.lowRes ? "저장됨 · 해상도가 낮습니다 (" + res.sourceWidth + "px)" : "이미지 저장됨");
  }

  async function uploadCenter() {
    if (!E.draft) return;
    try {
      const pid = E.draft.id || (E.draft.project + "-" + E.draft.pattern.code).replace(/[^\w.-]/g, "-");
      const vid = E.draft.variations[E.vIdx].id;
      const res = await apiUpload(pid, vid, C.slot, C.file, null);
      await commitUpload(res);
    } catch (e) { toast("업로드 실패: " + e.message); }
  }

  function bindCrop() {
    const stage = $("#crop-stage");
    let dragging = false, sx = 0, sy = 0, scx = 0.5, scy = 0.5;
    stage.addEventListener("pointerdown", (e) => {
      if (!C.img) return;
      dragging = true; sx = e.clientX; sy = e.clientY; scx = C.cx; scy = C.cy;
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragging || !C.img) return;
      const { W, H } = stageSize();
      const s = baseScale(W, H) * C.z;
      const dw = C.img.naturalWidth * s, dh = C.img.naturalHeight * s;
      C.cx = scx - (e.clientX - sx) / dw;
      C.cy = scy - (e.clientY - sy) / dh;
      layoutCrop();
    });
    const stop = () => (dragging = false);
    stage.addEventListener("pointerup", stop);
    stage.addEventListener("pointercancel", stop);
    $("#crop-zoom").addEventListener("input", (e) => {
      C.z = Number(e.target.value) / 100;
      layoutCrop();
    });
    window.addEventListener("resize", () => {
      if ($("#crop-modal").classList.contains("on")) layoutCrop();
    });
    $("#crop-cancel").onclick = $("#crop-cancel2").onclick = () => $("#crop-modal").classList.remove("on");
    $("#crop-ok").onclick = async () => {
      const rect = cropRect();
      $("#crop-ok").disabled = true; $("#crop-ok").textContent = "업로드 중…";
      try {
        const pid = E.draft.id || (E.draft.project + "-" + E.draft.pattern.code).replace(/[^\w.-]/g, "-");
        const vid = E.draft.variations[E.vIdx].id;
        const res = await apiUpload(pid, vid, C.slot, C.file, rect);
        $("#crop-modal").classList.remove("on");
        await commitUpload(res);
      } catch (e) {
        toast("업로드 실패: " + e.message);
      } finally {
        $("#crop-ok").disabled = false; $("#crop-ok").textContent = "이 이미지 사용";
      }
    };
  }

  /* ---------------- router ---------------- */
  function rerender() {
    const h = location.hash.replace(/^#/, "");
    if (h.indexOf("/p/") === 0) {
      const parts = h.slice(3).split("/");
      renderDetail(decodeURIComponent(parts[0]), parts[1] ? decodeURIComponent(parts[1]) : null);
      renderCart();
    } else if (h === "/proposal") {
      renderProposal();
    } else {
      renderCatalog();
      renderCart();
    }
    window.scrollTo(0, 0);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    loadLS();
    bindCrop();
    $("#brand").onclick = () => (location.hash = "");
    $("#cartbtn").onclick = () => (location.hash = "#/proposal");
    $("#newbtn").onclick = () => openEditor(null, null);
    $("#drawer-close").onclick = () => closeEditor();
    $("#drawer-cancel").onclick = () => closeEditor();
    $("#drawer-scrim").onclick = () => closeEditor();
    $("#drawer-save").onclick = saveDraft;
    $$("#drawer-tabs button").forEach((b) => (b.onclick = () => {
      if (E.tab === "json" && E.jsonErr) { E.msg = "JSON 문법 오류를 먼저 고치세요"; renderDrawer(); return; }
      E.tab = b.dataset.tab; syncTabs(); renderDrawer();
    }));

    try {
      const ui = await apiGet("/api/ui");
      if (ui && ui.state) {
        const localTs = Number(App.prop.ts || 0);
        const serverTs = Number(ui.state.ts || 0);
        if (serverTs >= localTs) {
          if (Array.isArray(ui.state.cart)) App.cart = ui.state.cart;
          if (ui.state.prop) App.prop = Object.assign(App.prop, ui.state.prop);
        }
      }
    } catch (e) {}

    try {
      const health = await apiGet("/api/health");
      App.config = health;
      $("#brand-name").textContent = health.brand || "RDP";
      $("#brand-sub").textContent = health.brandSub || "SPECIMEN ARCHIVE";
      document.title = (health.brand || "RDP") + " 시편 아카이브";
    } catch (e) {}

    $("#search").addEventListener("input", (e) => {
      App.q = e.target.value;
      if (location.hash && location.hash !== "#") location.hash = ""; else renderCatalog();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement.tagName !== "INPUT" && !document.activeElement.isContentEditable) { e.preventDefault(); $("#search").focus(); }
      if (e.key === "Escape") {
        if ($("#crop-modal").classList.contains("on")) return $("#crop-modal").classList.remove("on");
        if ($("#drawer").classList.contains("on")) return closeEditor();
        if (location.hash) location.hash = "";
      }
    });

    try {
      const data = await apiGet("/api/patterns");
      App.patterns = data.patterns || [];
      App.loadErrors = data.errors || [];
      if (data.errors && data.errors.length) {
        console.warn("load errors", data.errors);
        toast("동기화 충돌/깨진 파일 " + data.errors.length + "건 — 콘솔 확인");
      }
    } catch (e) {
      $("#view").innerHTML = `<div class="wrap"><div class="empty-state"><h2>서버에 연결할 수 없습니다</h2>
        <p>터미널에서 <code>python3 server.py</code> 를 실행하거나, 폴더의 <b>RDP Archive.command</b> 를 더블클릭하세요.</p>
        <p style="font-size:12px;color:#8d9198">${esc(e.message)}</p></div></div>`;
      return;
    }
    renderCart();
    rerender();
  }

  window.addEventListener("hashchange", rerender);
  boot();
})();
