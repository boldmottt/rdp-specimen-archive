# app part 2 (lines 408-814 of 1220)

```
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
          <dt>배합</dt><dd>${(v.mixes || []).length}건</dd>
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
      createdAt: new Date().toISOString(),
      items: groups.map((g) => ({
        pattern: { id: g.p.id, code: g.p.pattern.code, name: g.p.pattern.name, nameKo: g.p.pattern.nameKo, project: g.p.project, projectName: g.p.projectName, client: g.p.client,
          label: g.p.label, work: g.p.work },
        variations: g.vars.map((v) => ({ id: v.id, colorName: v.colorName, colorCode: v.colorCode, coating: v.coating, status: v.status, date: v.date,
          images: v.images, mixes: App.prop.showMix ? v.mixes : undefined,
          comment: (App.prop.comments || {})[g.p.id + "::" + v.id] || "" })),
      })),
    };
    try {
      const r = await fetch("/api/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
      const j = await r.json();
      toast(j.ok ? "제안서 스냅샷 저장됨" : "저장 실패");
    } catch (e) { toast("저장 실패: " + e.message); }
  }

  /* ---------------- cart bar ---------------- */
  function pruneCart() {
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

  function newDoc() {
    return {
      schemaVersion: 2, id: "", project: "", projectName: "", client: "",
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

```
