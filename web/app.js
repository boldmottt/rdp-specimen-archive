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
    prop: { title: "RDP 패턴 제안", client: "", date: "", by: "", comments: {}, showMix: false, showComments: false, note: "", inkTags: [] },
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
  function colorNameFor(code) {
    const key = String(code || "").trim().toUpperCase();
    if (!key) return "";
    for (const p of App.patterns) {
      for (const v of (p.variations || [])) {
        const cc = String(v.colorCode || "").trim().toUpperCase();
        const nm = String(v.colorName || "").trim();
        if (cc === key && nm) return nm;
      }
    }
    return "";
  }

  function deriveId(project, code) {
    let x = `${project || ""}-${code || ""}`;
    x = x.replace(/[^\w.-]+/g, "-").replace(/-{2,}/g, "-");
    x = x.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
    return x.slice(0, 80);
  }

  async function apiPost(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      const err = new Error(j.error || "요청 실패");
      err.status = r.status; err.payload = j; throw err;
    }
    return j;
  }

  async function apiPut(path, body, rev, create, renameFrom) {
    const headers = { "Content-Type": "application/json" };
    if (rev) headers["X-Base-Rev"] = rev;
    if (create) headers["X-Create"] = "1";
    if (renameFrom) headers["X-Rename-From"] = renameFrom;
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
  const layers = (v) => Array.from(new Set((v && v.mixes ? v.mixes : []).map((m) => m.layer).filter(Boolean)))
    .sort((a, b) => { const na = parseInt(String(a), 10) || 0, nb = parseInt(String(b), 10) || 0; return na - nb; });
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

  /* ---------------- inline edit ---------------- */
  const saveChain = new Map();
  function queueSave(pid, fn) {
    const prev = saveChain.get(pid) || Promise.resolve();
    const next = prev.then(fn, fn);
    saveChain.set(pid, next.catch(() => {}));
    return next;
  }

  async function inlineSave(pid, mutate) {
    return queueSave(pid, () => doInlineSave(pid, mutate));
  }

  async function doInlineSave(pid, mutate) {
    const p = byId(pid);
    if (!p) return;
    const draft = clone(p);
    delete draft._file; delete draft._mtime;
    if (mutate(draft) === false) return;
    const payload = {};
    Object.keys(draft).forEach((k) => { if (!k.startsWith("_")) payload[k] = draft[k]; });
    try {
      const r = await apiPut(`/api/patterns/${encodeURIComponent(pid)}`, payload, p.updatedAt);
      const saved = draft;
      saved.updatedAt = r.savedAt || saved.updatedAt;
      saved._mtime = Date.now();
      const i = App.patterns.findIndex((x) => x.id === pid);
      if (i >= 0) App.patterns[i] = saved;
      toast("저장됨");
    } catch (e) {
      if (e.status === 409) toast("다른 곳에서 먼저 저장되었습니다 — 새로고침하세요");
      else toast("저장 실패: " + e.message);
    }
  }

  function startInline(el, pid, vid) {
    if (el.dataset.editing) return;
    const path = el.dataset.f;
    if ((path === "project" || path === "pattern.code") && pid !== "__new__") {
      // 인라인으로 바꾸면 파일 ID·DB 키와 어긋난다 → ID 변경 흐름이 있는 편집기로 보낸다
      toast("프로젝트/패턴 코드는 편집기에서 바꿉니다 (파일 ID도 함께 변경)");
      openEditor(pid, vid);
      return;
    }
    const isVar = path.startsWith("v.");
    const rel = isVar ? path.slice(2) : path;
    const isNewMode = !!App.newDraft && pid === "__new__";
    const p = isNewMode ? App.newDraft : byId(pid);
    const v = isNewMode ? (p.variations || [])[0] : varOf(p, vid);
    const src = isVar ? v : p;
    if (!src) return;
    let cur = rel.split(".").reduce((a, k) => (a == null ? null : a[k]), src);
    if (Array.isArray(cur)) cur = cur.join(", ");
    const prev = el.innerHTML;
    const multi = /note|remark/.test(rel);
    el.dataset.editing = "1";
    el.innerHTML = multi ? '<textarea class="inline-input" rows="3"></textarea>' : '<input class="inline-input">';
    const inp = el.firstElementChild;
    inp.value = cur == null ? "" : String(cur);
    if (path === "v.colorName") inp.placeholder = "컬러명 (비우면 컬러코드로 표시)";
    if (path === "v.colorCode") inp.placeholder = "컬러코드";
    inp.focus();
    if (/label\.type$/.test(path) && inp.setSelectionRange) {
      const n = inp.value.length;
      inp.setSelectionRange(n, n);   // 접두어 뒤에 바로 숫자만 치도록 커서를 끝에
    } else if (inp.select) inp.select();

    const restore = () => { delete el.dataset.editing; el.innerHTML = prev; };
    const commit = async () => {
      if (!el.dataset.editing) return;
      const val = inp.value.trim();
      restore();
      if ((cur == null ? "" : String(cur)) === val) return;
      if (isNewMode) {
        const tgt = isVar ? (p.variations || [])[0] : p;
        if (!tgt) return;
        const keys = rel.split(".");
        let o = tgt;
        for (let i = 0; i < keys.length - 1; i++) {
          if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
          o = o[keys[i]];
        }
        o[keys[keys.length - 1]] = /plate/i.test(rel) ? val.split(",").map((x) => x.trim()).filter(Boolean) : val;
        if (isVar && rel === "colorCode" && val && !String(tgt.colorName || "").trim()) {
          const nm = colorNameFor(val);
          if (nm) tgt.colorName = nm;
        }
        renderDetail("__new__", null, App.newDraft);
        return;
      }
      await inlineSave(pid, (d) => {
        const tgt = isVar ? (d.variations || []).find((x) => x.id === v.id) : d;
        if (!tgt) return false;
        const keys = rel.split(".");
        let o = tgt;
        for (let i = 0; i < keys.length - 1; i++) {
          if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
          o = o[keys[i]];
        }
        let out = val;
        if (isVar && keys[0] === "label" && val === "") {
          delete o[keys[keys.length - 1]];
          if (tgt.label && !Object.keys(tgt.label).length) delete tgt.label;
          return true;
        }
        if (/label\.type$/.test(rel) && /^Padprint Layer$/i.test(val)) toast("구분에 도수 숫자가 없습니다 (Padprint Layer)");
        if (isVar && rel === "colorCode" && val && !String(tgt.colorName || "").trim()) {
          const nm = colorNameFor(val);
          if (nm) { tgt.colorName = nm; toast(`컬러명 자동 입력: ${nm}`); }
        }
        if (/date$/i.test(rel) && val) {
          const m2 = /^(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})$/.exec(val.replace(/\s/g, ""));
          if (!m2) { toast("날짜는 2026-10-22 형식으로 입력하세요"); return false; }
          out = `${m2[1]}-${m2[2]}-${m2[3]}`;
        }
        o[keys[keys.length - 1]] = /plate/i.test(rel)
          ? val.split(",").map((s) => s.trim()).filter(Boolean)
          : out;
        return true;
      });
      renderDetail(pid, v.id);
    };
    inp.onblur = commit;
    inp.onkeydown = (e) => {
      if (e.key === "Enter" && !multi) { e.preventDefault(); inp.blur(); }
      if (e.key === "Escape") { e.preventDefault(); inp.onblur = null; restore(); }
    };
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
    const title = `<span class="c-code">${esc(p.pattern.code)}</span><span class="c-name">${esc([nm, p.pattern.nameKo].filter(Boolean).join(" ") || "")}</span>`;
    const when = (v && v.date) ? fmtDate(v.date).slice(2) : (p.updatedAt ? String(p.updatedAt).slice(2, 10).replace(/-/g, ".") : "");
    const meta = [(p.work.plate || [])[0] ? "동판 " + p.work.plate[0] : "", "컬러 " + vars.length, v && v.status ? esc(v.status) : (when ? esc(when) : "")]
      .filter(Boolean).map((x, i) => (i ? "<i></i>" : "") + x).join("") + (layers(v).length ? `<span class="layer-pill">${esc(layers(v).join("·"))}</span>` : "");
    const chips = vars.length > 1
      ? vars.map((x) => `
      <button class="vchip${inCart(p.id, x.id) ? " in" : ""}${x.id === (v && v.id) ? " on" : ""}" data-sel="${esc(x.id)}" data-img="${esc(vImg(p.id, x) || "")}" title="클릭: 제안서에 담기/빼기 · 커서를 올리면 미리보기">
        ${x.images && x.images.length ? `<span class="vdot" data-src="${imgUrl(p.id, x.images[0])}"></span>` : '<span class="vdot"></span>'}
        <span class="nm">${esc(vName(x))}</span>
      </button>`).join("") + `<button class="vchip vchip-all" data-all="1" title="이 패턴의 모든 컬러를 한 번에">${vars.every((x) => inCart(p.id, x.id)) ? "전체 빼기" : `전체 ${vars.length}색`}</button>`
      : (v ? `
      <button class="vchip${inCart(p.id, v.id) ? " in" : ""}${v.id === vid ? " on" : ""}" data-sel="${esc(v.id)}" data-img="${esc(vImg(p.id, v) || "")}" title="클릭: 제안서에 담기/빼기">
        ${v.images && v.images.length ? `<span class="vdot" data-src="${imgUrl(p.id, v.images[0])}"></span>` : '<span class="vdot"></span>'}
        <span class="nm" style="font-family:var(--mono)">${esc(vName(v))}</span>
      </button>` : "");
    return `<article class="card${picked ? " picked" : ""}" data-pid="${esc(p.id)}">
      <div class="media">
        ${v && v.images && v.images.length ? `<img loading="lazy" src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div class="empty">IMAGE N/A</div>'}
        ${p.project ? `<div class="badge">${esc(p.project)}</div>` : ""}
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
      return `<button class="chip${App.project === k ? " on" : ""}" data-proj="${esc(k)}">${k === "all" ? "전체" : (k ? esc(k) : "미지정")}<span class="n">${n}</span></button>`;
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
        <button class="chip" id="selall" title="지금 보이는 시편을 모두 제안서에 담기">전체 선택<span class="n">${list.reduce((a, p) => a + (p.variations || []).length, 0)}</span></button>
        <button class="chip" id="selnone" title="지금 보이는 시편을 제안서에서 빼기">전체 해제</button>
        <button class="chip" id="syncall" title="RDP-DB의 배합을 모든 시편에 반영">DB 동기화</button>
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
    $$(".card").forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest("[data-check]") || e.target.closest("[data-sel]")) return;
        const p = byId(el.dataset.pid);
        location.hash = `#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(p._sel || p.variations[0].id)}`;
      };
    });
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
        const chk = card.querySelector("[data-check]");
        if (chk) chk.classList.toggle("on", inCart(p.id, el.dataset.sel));
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
    $$("[data-check]").forEach((el) => (el.onclick = (e) => {
      e.stopPropagation();
      const p = byId(el.closest(".card").dataset.pid);
      const v = varOf(p, p._sel);
      if (!v) return;
      toggleCart(p.id, v.id);
      renderCatalog(); renderCart();
    }));
  }

  async function saveNewPattern() {
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
      const r = await apiPut(`/api/patterns/${encodeURIComponent(id)}`, payload, exists ? (exists.updatedAt || "") : "", !exists);
      const saved = JSON.parse(JSON.stringify(payload));
      saved.updatedAt = r.savedAt || "";
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

  /* ---------------- plate popover ---------------- */
  const plateCache = new Map();
  async function showPlate(lot, anchor) {
    const pop = $("#plate-pop");
    if (!pop) return;
    if (pop.dataset.lot === lot && pop.classList.contains("on")) { pop.classList.remove("on"); return; }
    const r = anchor.getBoundingClientRect();
    pop.dataset.lot = lot;
    pop.innerHTML = '<div class="pp-load">불러오는 중…</div>';
    pop.style.left = Math.max(12, Math.min(window.innerWidth - 320, r.left)) + "px";
    pop.style.top = "0px";
    pop.classList.add("on");
    const ph = pop.offsetHeight || 200;
    const below = r.bottom + 8;
    const top = below + ph > window.innerHeight - 12 ? Math.max(12, r.top - ph - 8) : below;
    pop.style.top = top + "px";
    let info = plateCache.get(lot);
    if (!info) {
      try { info = await apiGet(`/api/plate/${encodeURIComponent(lot)}`); plateCache.set(lot, info); }
      catch (e) { info = null; }
    }
    if (!info || info.ok === false) { pop.innerHTML = '<div class="pp-load">동판 정보가 없습니다</div>'; return; }
    const curPid = decodeURIComponent((location.hash.match(/#\/p\/([^/]+)/) || [])[1] || "");
    const rowsMap = new Map();
    (info.usedBy || []).forEach((u) => rowsMap.set(u.id + "|" + (u.layer || ""), { id: u.id, project: u.project, code: u.code, layer: u.layer || "" }));
    App.patterns.forEach((pp) => (pp.variations || []).forEach((vv) => {
      const lp = vv.layerPlates || {};
      Object.keys(lp).forEach((l) => {
        if (lp[l] === lot) rowsMap.set(pp.id + "|" + l, { id: pp.id, project: pp.project, code: pp.pattern.code, layer: l });
      });
    }));
    const rowsArr = Array.from(rowsMap.values()).sort((a, b) => (a.code + a.layer).localeCompare(b.code + b.layer));
    const used = rowsArr.map((u) => {
      const p2 = byId(u.id);
      const vid = p2 && p2.variations && p2.variations[0] ? p2.variations[0].id : "";
      const href = `#/p/${encodeURIComponent(u.id)}${vid ? "/" + encodeURIComponent(vid) : ""}`;
      const here = curPid === u.id;
      return `<li${here ? ' class="here"' : ""}><a href="${href}" data-goto="1">${esc(u.project)} ${esc(u.code)}</a><span>${esc(u.layer)}${here ? " · 현재" : ""}</span></li>`;
    }).join("");
    pop.innerHTML = `<div class="pp-title">${esc(info.lot)}</div>
      <div class="pp-meta">${esc([info.type, info.size].filter(Boolean).join(" · ") || "—")}</div>
      ${info.note ? `<div class="pp-note">${esc(info.note)}</div>` : ""}
      ${info.created ? `<div class="pp-date">${esc(fmtDate(info.created))}</div>` : ""}
      ${used ? `<div class="pp-sub">이 동판에 들어간 패턴</div><ul>${used}</ul>` : ""}`;
    $$("[data-goto]", pop).forEach((a) => (a.onclick = () => pop.classList.remove("on")));
  }

  document.addEventListener("click", (e) => {
    const pop = $("#plate-pop");
    if (!pop || !pop.classList.contains("on")) return;
    if (pop.contains(e.target) || e.target.closest("[data-plate]")) return;
    pop.classList.remove("on");
  });

  /* ---------------- detail ---------------- */
  const labOf = (p, v) => Object.assign({}, (p && p.label) || {}, (v && v.label) || {});

  function platePatterns(plate) {
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

  function layerPlate(v, layer) {
    const lp = v.layerPlates || {};
    if (lp[layer]) return lp[layer];
    const hit = (v.mixes || []).find((m) => m.layer === layer && m.plate);
    return hit ? hit.plate : "";
  }

  // 배합이 DB에 들어가는 패턴 코드: 그 도수의 패턴(layerPatterns)이 있으면 그것, 없으면 시편 코드 (server.layer_code와 같음)
  function layerCodeOf(p, v, layer) {
    const lp = String(((v && v.layerPatterns) || {})[layer] || "").trim();
    return lp || ((p && p.pattern && p.pattern.code) || "");
  }

  function setLayerPlate(v, layer, plate) {
    v.layerPlates = v.layerPlates || {};
    v.layerPlates[layer] = plate;
    (v.mixes || []).forEach((m) => { if (m.layer === layer) m.plate = plate; });
  }

  function syncLayerPlates(v) {
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

  function labToCss(lab) {
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

  function labText(lab) {
    if (!lab || lab.L == null) return "";
    const n = (v) => (v == null || v === "" ? "-" : Number(v).toFixed(1));
    return `${n(lab.L)} ${n(lab.a)} ${n(lab.b)}`;
  }

  function inkOrder(list) {
    const PRIORITY = ["MT", "BK", "WH", "YE", "RD", "CL", "YE-D"];
    return list.slice().sort((a, b) => {
      const ia = PRIORITY.indexOf(a), ib = PRIORITY.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
  }

  const DEFAULT_INKS = ["MT", "BK", "WH", "YE", "RD", "CL", "YE-D"];

  function inkPool() {
    const set = new Set(DEFAULT_INKS.concat(App.prop.inkTags || []));
    App.patterns.forEach((p) => (p.variations || []).forEach((v) => (v.mixes || []).forEach((m) => {
      Object.keys(m.inks || {}).forEach((k) => set.add(k));
    })));
    return inkOrder(Array.from(set));
  }

  function addInkTag(tag) {
    const t = String(tag || "").trim().toUpperCase();
    if (!t) return "";
    App.prop.inkTags = App.prop.inkTags || [];
    if (!App.prop.inkTags.includes(t)) { App.prop.inkTags.push(t); saveLS(); }
    return t;
  }

  function mixTable(mixes) {
    const used = inkOrder(Array.from(new Set(mixes.flatMap((m) => Object.keys(m.inks || {})))));
    const hasMatting = mixes.some((m) => m.mattingPct != null || m.mattingG != null);
    const hasLab = mixes.some((m) => m.labSce || m.labSci);
    const head = `<tr><th>배합</th>${used.map((c) => `<th>${c}</th>`).join("")}${hasMatting ? "<th>소광</th>" : ""}<th>신나</th><th>경화</th>${hasLab ? "<th>LAB</th>" : ""}<th>잉크합</th><th>결과</th><th>비고</th></tr>`;
    const body = mixes.map((m) => `<tr>
      <td>${esc(m.batch)}${m.isReference ? " *" : ""}</td>
      ${used.map((c) => `<td>${m.inks && m.inks[c] != null ? m.inks[c] : "—"}</td>`).join("")}
      ${hasMatting ? `<td>${m.mattingG != null ? m.mattingG + "g" : m.mattingPct != null ? m.mattingPct + "%" : "—"}</td>` : ""}
      <td>${m.thinnerG != null ? m.thinnerG + "g" : m.thinnerPct != null ? m.thinnerPct + "%" : "—"}</td>
      <td>${m.hardenerG != null ? m.hardenerG + "g" : m.hardenerPct != null ? m.hardenerPct + "%" : "—"}</td>
      ${hasLab ? `<td>${m.labSce || m.labSci ? `<span class="lab-line"><i class="labsw" style="background:${labToCss(m.labSce || m.labSci)}"></i>${esc(labText(m.labSce || m.labSci))}</span>` : "—"}</td>` : ""}
      <td>${pigmentTotal(m)}</td>
      <td class="res res-${esc(m.result || "")}">${esc(RESULT_LABEL[m.result] || "—")}</td>
      <td class="note">${esc(m.change || m.note || "")}</td></tr>`).join("");
    return `<div class="tbl-wrap"><table class="mix">${head}${body}</table></div>`;
  }
  function pigmentTotal(m) {
    const keys = Object.keys(m.inks || {});
    const t = keys.reduce((a, k) => a + (Number(m.inks[k]) || 0), 0);
    return t ? Math.round(t * 10) / 10 : "—";
  }

  function renderDetail(pid, vid, override) {
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
        ${plate ? `<button class="plate-info" data-plate="${esc(plate)}" title="동판 정보">i</button>` : ""}
        <span>${rows.length} 배합${extra.length ? " · 예외 " + extra.map(esc).join(", ") : ""}</span></h4>${mixTable(rows)}</div>`;
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
                 <button class="btn-line" id="editbtn">편집</button>`}
          </div>
        </div>

        <div class="gallery">
          <div class="main" id="mainimg">${images.length ? `<img src="${imgUrl(p.id, images[0])}" alt="">` : (isNew ? '<div class="empty-new"><span>이미지는 저장 후 <b>편집</b>에서 추가합니다</span></div>' : '<div class="empty" style="display:grid;place-items:center;height:100%;color:#8d9198;font-size:11px;letter-spacing:.1em">IMAGE N/A</div>')}</div>
          ${images.length > 1 ? `<div class="thumbs">${images.map((im, i) => `<img src="${imgUrl(p.id, im)}" class="${i === 0 ? "on" : ""}" data-img="${esc(imgUrl(p.id, im))}">`).join("")}</div>` : ""}
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
              ${[["Company", "company"], ["Project", "project"]].map(([t, k]) => {
                const own = sampleOwn(v, k);
                const f = own ? "v.label." + k : (k === "company" ? "client" : "project");
                return `<dt>${t}${own ? ' <span class="lab-own" title="이 샘플 전용">샘플</span>' : ""}</dt><dd data-f="${f}"${own ? ' data-tip="이 샘플 전용 값 — 비우면 공통값을 씁니다"' : ""}>${esc(dash(sampleVal(p, v, k)))}</dd>`;
              }).join("")}
              <dt>Pattern Code</dt><dd class="mono" data-f="pattern.code" data-tip="패턴 코드 — 바꾸면 파일 ID도 함께 바뀝니다 (편집기에서 변경)">${esc(p.pattern.code)}</dd>
              <dt>Pattern Name</dt><dd data-f="pattern.name">${esc(dash(p.pattern.name))}</dd>
              <dt>Color Code</dt><dd class="mono" data-f="v.colorCode">${esc(dash(v && v.colorCode))}</dd>
              ${[["Item", "item"], ["Type", "type"]].map(([t, k]) => {
                // 화면에 보이는 값(labOf: 컬러 라벨 우선)과 같은 곳을 고치도록 data-f를 고른다
                const own = v && v.label && v.label[k] != null && String(v.label[k]).trim() !== "";
                return `<dt>${t}${own ? ' <span class="lab-own" title="이 컬러 전용 라벨">컬러</span>' : ""}</dt><dd data-f="${own ? "v.label." + k : "label." + k}"${own ? ' data-tip="이 컬러 전용 라벨 — 비우면 공통 라벨을 씁니다"' : ""}>${esc(dash(labOf(p, v)[k]))}</dd>`;
              }).join("")}
              <dt>Date(Rev)</dt><dd><span data-f="v.date">${esc(v && v.date ? fmtDate(v.date) : "—")}</span> <span class="revtag" data-f="v.rev" title="Rev 번호 — 클릭해서 수정">Rev.${esc(String((v && v.rev) != null && v.rev !== "" ? v.rev : "0"))}</span></dd>
              ${[["Supplier", "supplier"], ["Remark", "remark"]].map(([t, k]) => {
                const own = sampleOwn(v, k);
                return `<dt>${t}${own ? ' <span class="lab-own" title="이 샘플 전용">샘플</span>' : ""}</dt><dd data-f="${own ? "v.label." + k : "label." + k}"${own ? ' data-tip="이 샘플 전용 값 — 비우면 공통값을 씁니다"' : ""}>${esc(dash(sampleVal(p, v, k)))}</dd>`;
              }).join("")}
            </dl>
          </section>
          <section class="sec"><h3>작업 정보</h3>
            <dl class="kv">
              <dt>작업 장소</dt><dd data-f="work.place">${esc(dash(p.work.place))}</dd>
              <dt>작업자</dt><dd data-f="work.worker">${esc(dash(p.work.worker))}</dd>
              <dt>설비</dt><dd data-f="work.machine">${esc(dash(p.work.machine))}</dd>
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
        </div>
      </div>
    </div>`;

    if (isNew) {
      $("#newsave").onclick = () => saveNewPattern();
      $("#newcancel").onclick = () => { if (confirm("작성을 취소할까요?")) { App.newDraft = null; location.hash = ""; } };
    } else {
      const addBtn = $("#addbtn");
      if (addBtn) addBtn.onclick = () => { toggleCart(p.id, v.id); renderDetail(pid, v.id); renderCart(); };
      const editBtn = $("#editbtn");
      if (editBtn) editBtn.onclick = () => openEditor(pid, v.id);
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
        await inlineSave(pid, (d2) => {
          const v2 = (d2.variations || []).find((x) => x.id === v.id);
          if (!v2) return false;
          v2.layerPlates = v2.layerPlates || {};
          v2.layerPlates[layer] = val;
          (v2.mixes || []).forEach((m) => { if (m.layer === layer) m.plate = val; });
          return true;
        });
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
      <div class="cov-client">
        <div><dt>Client</dt><dd>${esc(App.prop.client || "—")}</dd></div>
        <div><dt>Prepared by</dt><dd>${esc(App.prop.by || "—")}</dd></div>
      </div>
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
      ${v.images && v.images.length ? `<img class="p-img" src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div class="p-img"></div>'}
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
        ${v.images && v.images.length ? `<img src="${imgUrl(p.id, v.images[0])}" alt="">` : '<div style="width:170mm;height:70mm;background:#efede8"></div>'}
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
    delete c._id;
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
    if (o.type === "select") return `<div class="field-row"><label>${label}</label><select data-k="${key}">${o.options.map((x) => `<option value="${esc(x)}"${x === v ? " selected" : ""}>${esc(x || "—")}</option>`).join("")}</select></div>`;
    return `<div class="field-row"><label>${label}</label><input data-k="${key}" value="${esc(v)}" placeholder="${o.ph || ""}" ${o.mono ? 'style="font-family:var(--mono);font-size:12px"' : ""}></div>`;
  }

  function pushPanel(pv) {
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
    const upd = pv.updates || [], ins = pv.inserts || [], sk = pv.skipped || [], mv = pv.moves || [];
    const multi = new Set([...upd, ...ins].map((x) => x.vid)).size > 1;
    const tag = (x) => (multi && x.vid ? `<span class="pp-skip">${esc(x.vid)}</span> ` : "");
    const rows = [];
    mv.forEach((x) => rows.push(`<li><b>${esc(x.batch)}</b> ${tag(x)}<span class="pp-f">${esc(x.layer || "")} 패턴 코드 이동 ${esc(x.from)} → <b>${esc(x.to)}</b></span></li>`));
    upd.forEach((u) => rows.push(`<li><b>${esc(u.batch)}</b> ${tag(u)}<span class="pp-f">${u.fields.map((f) => `${esc(f.name)} ${esc(String(f.from))} → <b>${esc(String(f.to))}</b>`).join(", ")}</span></li>`));
    ins.forEach((i) => rows.push(`<li><b>${esc(i.batch)}</b> ${tag(i)}<span class="pp-f">신규 배합 (${esc(i.code || "")} · ${esc(i.layer || "")} · ${esc(i.plate)})</span></li>`));
    const n = rows.length;
    sk.forEach((x) => rows.push(`<li class="pp-skip"><b>${esc(x.batch || "-")}</b> ${esc(x.vid || "")} 건너뜀 — ${esc(x.reason || "")}</li>`));
    const shown = rows.slice(0, 14).join("");
    const more = rows.length > 14 ? `<li class="pp-more">외 ${rows.length - 14}건</li>` : "";
    return `<div class="push-panel">
      <div class="pp-head">DB에 반영할 변경 — ${mv.length ? `코드 이동 <b>${mv.length}</b> · ` : ""}수정 <b>${upd.length}</b> · 신규 <b>${ins.length}</b>${sk.length ? ` · 건너뜀 ${sk.length}` : ""}</div>
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

  function renderDrawer() {
    const d = E.draft;
    renderVars();
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
        ${fieldRow("작업일", "variations." + E.vIdx + ".date", { ph: "2026-10-22" })}
        ${fieldRow("Rev", "variations." + E.vIdx + ".rev", { ph: "0" })}
        ${fieldRow("메모", "variations." + E.vIdx + ".note", { type: "textarea", ph: "2도 톤 미세조정 단계" })}
        <div class="sec-label">이 샘플의 라벨 <span style="font-weight:400;color:#8d9198;font-size:10px">비우면 공통값을 씁니다 (패턴 코드·이름은 공통)</span></div>
        ${fieldRow("Company", "variations." + E.vIdx + ".label.company", { ph: d.client || "현대자동차" })}
        ${fieldRow("Project", "variations." + E.vIdx + ".label.project", { ph: d.project || "NX5a", mono: true })}
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
      const head = `<tr><th></th><th>도수</th><th title="이 배합이 DB에 들어가는 동판 · 패턴 코드 (위 도수별 칸에서 정함)">동판·패턴</th><th>배합</th>${inkCols.map((c) => `<th>${c}</th>`).join("")}${showMatting ? "<th>소광</th>" : ""}<th>신나</th><th>경화</th><th>LAB</th><th>결과</th><th>기준</th><th></th></tr>`;
      const rows = order.map((mi) => [v.mixes[mi], mi]).map(([m, mi]) => `<tr data-mi="${mi}">
        <td><input type="checkbox" data-pick="${mi}" style="accent-color:#141517"></td>
        <td><input data-mf="layer" value="${esc(m.layer || "")}" style="width:44px"></td>
        <td class="mix-set${m.plate ? "" : " empty"}" title="DB 키: ${esc(layerCodeOf(d, v, m.layer))} · ${esc(m.layer || "")} · ${esc(m.plate || "동판 없음")}">${m.plate ? esc(m.plate) : "동판 없음"}<i>${esc(layerCodeOf(d, v, m.layer))}</i></td>
        <td><input data-mf="batch" value="${esc(m.batch || "")}" style="width:72px"></td>
        ${inkCols.map((c) => `<td><input data-mf="ink:${c}" value="${m.inks && m.inks[c] != null ? m.inks[c] : ""}" style="width:34px"></td>`).join("")}
        ${showMatting ? `<td><input data-mf="mattingG" value="${m.mattingG != null ? m.mattingG : ""}" placeholder="${m.mattingG == null && m.mattingPct != null ? m.mattingPct + "%" : ""}" style="width:36px"></td>` : ""}
        <td><input data-mf="thinnerG" value="${m.thinnerG != null ? m.thinnerG : ""}" placeholder="${m.thinnerG == null && m.thinnerPct != null ? m.thinnerPct + "%" : ""}" style="width:36px"></td>
        <td><input data-mf="hardenerG" value="${m.hardenerG != null ? m.hardenerG : ""}" placeholder="${m.hardenerG == null && m.hardenerPct != null ? m.hardenerPct + "%" : ""}" style="width:36px"></td>
        <td class="lab-cell">${(() => {
          const sce = m.labSce, sci = m.labSci;
          if (!sce && !sci) return `<button class="lab-btn empty" data-lab="${mi}" title="LAB 값 입력">+ LAB</button>`;
          const line = (k, lab) => (lab ? `<span class="lab-line"><i class="labsw" style="background:${labToCss(lab)}"></i>${k} ${esc(labText(lab))}</span>` : "");
          return `<button class="lab-btn" data-lab="${mi}" title="클릭해서 수정">${line("SCE", sce)}${line("SCI", sci)}</button>`;
        })()}</td>
        <td><select data-mf="result" style="width:74px">${Object.keys(RESULT_LABEL).map((k) => `<option value="${k}"${k === (m.result || "") ? " selected" : ""}>${RESULT_LABEL[k]}</option>`).join("")}</select></td>
        <td><input type="checkbox" data-mf="isReference" ${m.isReference ? "checked" : ""}></td>
        <td class="act"><button class="mini-btn danger" data-delmix="${mi}">✕</button></td></tr>` +
        (E.labOpen === mi ? `<tr class="lab-edit"><td colspan="${7 + inkCols.length + (showMatting ? 1 : 0)}">
          <div class="lab-grid">
            ${["sce", "sci"].map((k) => {
              const lab = m["lab" + k[0].toUpperCase() + k.slice(1)] || {};
              return `<div class="lab-block">
                <span class="lab-k">${k.toUpperCase()}</span>
                <i class="labsw big" data-labsw="${mi}-${k}" style="background:${labToCss(lab) || "#eee"}"></i>
                <label>L<input data-labf="${mi}:${k}.L" value="${lab.L != null ? lab.L : ""}" inputmode="decimal"></label>
                <label>a<input data-labf="${mi}:${k}.a" value="${lab.a != null ? lab.a : ""}" inputmode="decimal"></label>
                <label>b<input data-labf="${mi}:${k}.b" value="${lab.b != null ? lab.b : ""}" inputmode="decimal"></label>
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
          ${pool.map((t) => `<button class="itag${inkCols.includes(t) ? " on" : ""}" data-inkadd="${esc(t)}" title="${inkCols.includes(t) ? "이 컬러에 사용 중" : "이 컬러에 열 추가"}">${esc(t)}</button>`).join("")}
          <input id="ink-new" placeholder="+ 새 잉크" maxlength="10" autocomplete="off">
        </div>
        <div class="ink-note">태그를 누르면 이 컬러의 배합 열이 생깁니다. 한 번 쓴 잉크는 다음 시편에서도 태그로 나옵니다.
          <b>DB 반영은 MT·BK·WH·YE·RD·CL·YE-D 7종만</b> 되고, 그 외 태그는 아카이브에만 저장됩니다.
          배합은 <b>도수별 동판 · 패턴 코드</b>에 속해서 DB에도 그 패턴 코드로 들어갑니다.</div>
        <div class="tbl-wrap" style="margin:0 -6px"><table class="mix-edit">${head}${rows}</table></div>
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
          const r = await apiPost(`/api/rdp/rename-db/${encodeURIComponent(d.id)}`, { mode });
          const p0 = byId(d.id);
          if (p0) { delete p0.renamedFrom; p0.updatedAt = r.savedAt; }
          delete d.renamedFrom; d.updatedAt = r.savedAt;
          E.baseRev = r.savedAt; E.origJson = JSON.stringify(d);
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
          const r = await fetch(`/api/rdp/push/${encodeURIComponent(d.id)}`, { method: "POST" }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error || "반영 실패");
          E.push = null;
          renderDrawer();
          toast(`DB 반영 완료 · ${r.moved ? `코드 이동 ${r.moved} · ` : ""}수정 ${r.updated || 0} · 신규 ${r.inserted || 0}` + (r.backup ? ` (백업 ${r.backup})` : ""));
        } catch (e) {
          toast("반영 실패: " + e.message);
          pok.disabled = false; pok.textContent = "DB에 반영";
        }
      };
      const pu = $("#rdppush");
      if (pu) pu.onclick = async () => {
        if (isDirty()) { toast("먼저 저장한 뒤 보내세요"); return; }
        try {
          const pv = await apiGet(`/api/rdp/push-preview/${encodeURIComponent(d.id)}`);
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
          const p2 = (fresh.patterns || []).find((x) => x.id === d.id);
          if (p2) {
            const idx = App.patterns.findIndex((x) => x.id === d.id);
            if (idx >= 0) App.patterns[idx] = p2; else App.patterns.push(p2);
            E.draft = clone(p2);
            delete E.draft._file; delete E.draft._mtime;
            E.baseRev = p2.updatedAt || "";
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
    const nav = $("#navhome");
    if (nav) nav.style.display = h ? "" : "none";
    if (h === "/new") {
      if (!App.newDraft) App.newDraft = newDoc();
      renderDetail("__new__", null, App.newDraft);
      renderCart();
    } else if (h.indexOf("/p/") === 0) {
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
    $("#navhome").onclick = () => (location.hash = "");
    $("#cartbtn").onclick = () => (location.hash = "#/proposal");
    $("#newbtn").onclick = () => { App.newDraft = newDoc(); location.hash = "#/new"; };
    $("#drawer-close").onclick = () => closeEditor();
    $("#drawer-cancel").onclick = () => closeEditor();
    $("#drawer-scrim").onclick = () => closeEditor();
    $("#drawer-save").onclick = saveDraft;
    $$("#drawer-tabs button").forEach((b) => (b.onclick = () => {
      if (E.tab === "json" && E.jsonErr) { E.msg = "JSON 문법 오류를 먼저 고치세요"; renderDrawer(); return; }
      E.tab = b.dataset.tab; syncTabs(); renderDrawer();
    }));

    try { App.rdpStatus = await apiGet("/api/rdp/status"); } catch (e) {}

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
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
      if (e.key === "/" && !typing) { e.preventDefault(); $("#search").focus(); }
      if (e.key === "Escape") {
        if ($("#crop-modal").classList.contains("on")) return $("#crop-modal").classList.remove("on");
        if ($("#drawer").classList.contains("on")) return closeEditor();
        if (location.hash) location.hash = "";
      }
    });

    try {
      const data = await apiGet("/api/patterns");
      App.patterns = (data.patterns || []).map((pp) => {
        (pp.variations || []).forEach((vv) => (vv.mixes || []).forEach((mm) => {
          if (mm.result === "planned") mm.result = "plan";
        }));
        return pp;
      });
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
