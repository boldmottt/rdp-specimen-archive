# app part 3 (lines 815-1220 of 1220)

```
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
        const n = d.variations.length + 1;
        d.variations.push({ id: "v" + String(n).padStart(2, "0"), colorName: "", colorCode: "", coating: [], status: "", date: todayLocal(), images: [], mixes: [], note: "" });
        E.vIdx = d.variations.length - 1; renderDrawer();
      };
      $("#dup-var").onclick = () => {
        const src = clone(d.variations[E.vIdx]);
        const n = d.variations.length + 1;
        src.id = "v" + String(n).padStart(2, "0");
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
      $$("[data-delimg]").forEach((el) => (el.onclick = async () => {
        const i = Number(el.dataset.delimg);
        const name = v.images[i];
        if (!confirm("이미지를 삭제할까요? (_trash로 이동)")) return;
        try {
          if (!String(name).startsWith("v")) { /* noop */ }
          await apiDelete(`/api/image/${encodeURIComponent(d.id)}/${encodeURIComponent(name)}`);
        } catch (e) { /* 파일이 없어도 배열에서는 제거 */ }
        v.images.splice(i, 1);
        renderDrawer();
        toast("이미지 삭제됨 (저장을 눌러 반영)");
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
        try { d = E.draft = JSON.parse($("#jsonarea").value); } catch (e) { E.msg = "JSON 문법 오류"; renderDrawer(); return; }
      }
      if (!d.pattern.code) { E.msg = "패턴 코드를 입력하세요"; E.tab = "base"; syncTabs(); renderDrawer(); return; }
      if (!d.id) {
        if (!d.project) { E.msg = "프로젝트를 입력하세요"; E.tab = "base"; syncTabs(); renderDrawer(); return; }
        d.id = (d.project + "-" + d.pattern.code).replace(/[^\w.-]/g, "-");
      }
      E.msg = "저장 중…"; renderDrawer();
      const payload = {};
      Object.keys(d).forEach((k) => { if (!k.startsWith("_")) payload[k] = d[k]; });
      const r = await apiPut(`/api/patterns/${encodeURIComponent(d.id)}`, payload, E.baseRev);
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
        if (Array.isArray(ui.state.cart)) App.cart = ui.state.cart;
        if (ui.state.prop) App.prop = Object.assign(App.prop, ui.state.prop);
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

```
