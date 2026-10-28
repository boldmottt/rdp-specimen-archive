/* PCCS3 — 작업일지 검사 · 동판 타임라인 (읽기 전용) */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = { files: [], plates: null, onlyErr: false, status: null };

  async function api(path) {
    const r = await fetch(path, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) { const e = new Error(j.error || "요청 실패"); e.status = r.status; throw e; }
    return j;
  }

  const KIND = { v3: "", v2: "v2.1", none: "frontmatter 없음", broken: "읽기 오류" };
  function stateBadge(f) {
    if (f.kind === "v3") return f.errors ? `<span class="pc-badge ng">오류 ${f.errors}</span>` : `<span class="pc-badge ok">OK</span>`;
    if (f.kind === "broken") return `<span class="pc-badge ng">읽기 오류</span>`;
    return `<span class="pc-badge mute">${esc(KIND[f.kind] || f.kind)}</span>`;
  }
  const lotLink = (lot) => `<a class="lot" href="#/plate/${encodeURIComponent(lot)}">${esc(lot)}</a>`;
  const evalBadge = (e) => `<span class="pc-badge e-${esc(e || "")}">${esc(e || "—")}</span>`;
  const fmtNum = (x) => (x == null ? "" : String(x));
  // 일지는 손으로 쓰므로 모양이 틀릴 수 있다 (검사 결과에 오류로 나오고, 화면은 그대로 그린다)
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  const arr = (x) => (Array.isArray(x) ? x : []);
  const pctTxt = (x) => (x && typeof x === "object" ? (x.g != null ? `${esc(fmtNum(x.g))}${x.pct != null ? ` <span class="sub">(${esc(fmtNum(x.pct))}%)</span>` : ""}` : "")
    : esc(fmtNum(x)));
  const inksTxt = (inks) => Object.entries(obj(inks)).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(" · ");

  /* ---------- status / list ---------- */
  function renderStatus() {
    const st = S.status;
    if (!st) return;
    if (!st.yaml) { $("#status").innerHTML = `<span class="bad">PyYAML이 없습니다 — 맥 터미널에서 <b>python3 -m pip install --user pyyaml</b> 후 앱을 다시 켜세요</span>`; return; }
    if (!st.exists) { $("#status").innerHTML = `<span class="bad">작업일지 폴더를 찾을 수 없습니다: <b>${esc(st.dir)}</b> — config.json의 <b>worklogDir</b>를 확인하세요</span>`; return; }
    const c = st.counts || {};
    const bad = S.files.filter((f) => f.kind === "v3" && f.errors).length;
    $("#status").innerHTML = `폴더 <b>${esc(st.dir)}</b> · v3 <b>${c.v3 || 0}</b> · v2.1 ${c.v2 || 0} · frontmatter 없음 ${c.none || 0}${c.broken ? ` · <span class="bad">읽기 오류 ${c.broken}</span>` : ""}${bad ? ` · <span class="bad">오류 있는 일지 ${bad}</span>` : ""}`;
  }

  function renderFileList(cur) {
    const list = S.files.filter((f) => !S.onlyErr || f.errors || f.kind === "broken");
    $("#list").innerHTML = `<div class="pc-filter"><label><input type="checkbox" id="onlyerr" ${S.onlyErr ? "checked" : ""}> 오류 있는 일지만</label><span class="grow"></span>${list.length}개</div>`
      + (list.length ? list.map((f) => `<a class="pc-item${f.name === cur ? " on" : ""}" href="#/file/${encodeURIComponent(f.name)}">
          <div class="d">${esc(f.date || "날짜 없음")} ${f.category && f.category !== "작업일지" ? `· ${esc(f.category)}` : ""}</div>
          <div class="t">${esc((f.titles || []).join(" / ") || f.name)}</div>
          <div class="m">${stateBadge(f)}${f.warnings ? `<span class="pc-badge warn">참고 ${f.warnings}</span>` : ""}${(f.lots || []).map((l) => `<span class="mono">${esc(l)}</span>`).join("")}</div>
        </a>`).join("") : `<div class="pc-empty">일지가 없습니다</div>`);
    const cb = $("#onlyerr");
    if (cb) cb.onchange = () => { S.onlyErr = cb.checked; renderFileList(cur); };
  }

  function renderPlateList(cur) {
    const ps = S.plates || [];
    $("#list").innerHTML = `<div class="pc-filter">동판 ${ps.length}개 <span class="grow"></span>최근 순</div>`
      + (ps.length ? ps.map((p) => `<a class="pc-item${p.lot === cur ? " on" : ""}" href="#/plate/${encodeURIComponent(p.lot)}">
          <div class="d">${esc(p.first)} ~ ${esc(p.last)} · ${p.days}일</div>
          <div class="t mono">${esc(p.lot)}</div>
          <div class="m">${(p.patterns || []).map((c) => `<span class="mono">${esc(c)}</span>`).join(" · ")}${p.samples ? `<span>시료 ${p.samples}장</span>` : ""}</div>
        </a>`).join("") : `<div class="pc-empty">동판 기록이 없습니다</div>`);
  }

  /* ---------- views ---------- */
  function msgList(items, cls) {
    return `<ul class="pc-msgs ${cls}">${items.map((m) => `<li><span class="w">${esc(m.where)}</span><span>${esc(m.msg)}</span></li>`).join("")}</ul>`;
  }

  function jobCard(j) {
    const plate = obj(j.plate);
    const layers = obj(plate.layers);
    const batches = arr(j.batches).filter((b) => b && typeof b === "object");
    const samples = arr(j.samples).filter((s) => s && typeof s === "object");
    const layerKeys = Object.keys(layers);
    return `<div class="pc-card">
      <h3>작업 ${esc(j.seq == null ? "?" : j.seq)} ${plate.lot ? lotLink(plate.lot) : ""} ${esc(j.title || "")} ${j.status ? `<span class="pc-badge mute">${esc(j.status)}</span>` : ""}</h3>
      <div class="sub">${esc([j.customer, j.contact, j.project && j.project !== "-" ? j.project : "", j.stage, j.type].filter(Boolean).join(" · "))}</div>
      <div class="layers" style="margin-top:8px">${layerKeys.map((l) => `<span>${esc(l)} <b>${esc(layers[l])}</b></span>`).join("")}</div>
      <table class="pc"><tr><th>도수</th><th>코드</th><th>잉크 (g)</th><th>소광</th><th>신나</th><th>경화</th><th>합계</th><th>비고</th></tr>
        ${batches.map((b) => `<tr class="${b.status === "미채택" ? "dim" : ""}">
          <td>${esc(b.layer)}</td><td class="mono"><b>${esc(b.code)}</b></td>
          <td class="mono">${b.inks ? inksTxt(b.inks) : (b.same_as ? `= ${esc(b.same_as)}` : "")}</td>
          <td class="mono">${pctTxt(b.matting)}</td><td class="mono">${pctTxt(b.thinner)}</td><td class="mono">${pctTxt(b.hardener)}</td>
          <td class="mono">${esc(fmtNum(b.total))}</td>
          <td>${b.status ? `<span class="pc-badge e-${esc(b.status)}">${esc(b.status)}</span> ` : ""}${b.inks && b.same_as ? `<span class="sub">= ${esc(b.same_as)}</span> ` : ""}${esc(b.note || "")}</td></tr>`).join("")}
      </table>
      <table class="pc" style="margin-top:12px"><tr><th>#</th><th>도장 시편</th>${layerKeys.map((l) => `<th>${esc(l)}</th>`).join("")}<th>장</th><th>평가</th><th>메모</th></tr>
        ${samples.map((s) => `<tr><td>${esc(s.seq)}</td><td class="mono">${esc(s.substrate)}</td>
          ${layerKeys.map((l) => `<td class="mono"><b>${esc(obj(s.layers)[l] || "")}</b></td>`).join("")}
          <td>${esc(s.qty)}</td><td>${evalBadge(s.eval)}</td><td>${esc(s.note || "")}</td></tr>`).join("")}
      </table>
    </div>`;
  }

  async function showFile(name) {
    setTab("files");
    renderFileList(name);
    $("#main").innerHTML = `<div class="pc-empty">불러오는 중…</div>`;
    try {
      const f = await api(`/api/pccs/file?name=${encodeURIComponent(name)}`);
      const r = f.result || { errors: [], warnings: [] };
      const st = (r.stats || {});
      const fm = f.frontmatter || {};
      let html = `<div class="pc-card"><h2>${esc(f.date)} ${stateBadge(f)}</h2><div class="sub">${esc(f.name)}</div>`;
      if (f.kind === "v3") html += `<div class="sub" style="margin-top:4px">작업 ${st.jobs || 0} · 배합 ${st.batches || 0} · 시료 ${st.samples || 0}행 ${st.qty || 0}장 · ${esc([fm.place, fm.worker].filter(Boolean).join(" · "))}</div>`;
      if (f.kind === "v2") html += `<p class="sub">v2.1(예전 형식) 일지라 검사하지 않습니다. 동판 타임라인에는 patterns 정보로 나옵니다.</p>`;
      if (f.kind === "none") html += `<p class="sub">frontmatter가 없는 파일입니다 (메일 초안 등).</p>`;
      if (r.errors.length) html += `<h3 style="margin-top:12px">오류 ${r.errors.length} — 지침 §6 자가 점검 실패</h3>${msgList(r.errors, "err")}`;
      if (r.warnings.length) html += `<h3 style="margin-top:12px">참고 ${r.warnings.length}</h3>${msgList(r.warnings, "warn")}`;
      if (f.kind === "v3" && !r.errors.length && !r.warnings.length) html += `<p class="sub" style="margin-top:8px">✅ 자가 점검을 모두 통과했습니다.</p>`;
      html += `</div>`;
      if (f.kind === "v3") html += arr(fm.jobs).filter((j) => j && typeof j === "object" && !Array.isArray(j)).map(jobCard).join("");
      $("#main").innerHTML = html;
    } catch (e) {
      $("#main").innerHTML = `<div class="pc-empty">${esc(e.message)}</div>`;
    }
  }

  function showFileHome() {
    setTab("files");
    renderFileList(null);
    const bad = S.files.filter((f) => f.kind === "v3" && f.errors);
    $("#main").innerHTML = `<div class="pc-card"><h2>일지 검사</h2>
      <p class="sub">작업일지 폴더의 v3 일지를 <b>작업일지-AI-작성지침-v3</b> §6 자가 점검 규칙으로 자동 검사합니다. 왼쪽에서 일지를 고르세요.</p>
      ${bad.length ? `<h3 style="margin-top:10px">오류가 있는 일지 ${bad.length}개</h3><ul class="pc-msgs err">${bad.map((f) => `<li><span class="w">${esc(f.date)}</span><a href="#/file/${encodeURIComponent(f.name)}">${esc(f.name)}</a> — 오류 ${f.errors}</li>`).join("")}</ul>` : `<p class="sub">✅ 오류가 있는 v3 일지가 없습니다.</p>`}
    </div>`;
  }

  async function showPlates(lot) {
    setTab("plates");
    if (!S.plates) {
      try { S.plates = (await api("/api/pccs/plates")).plates || []; } catch (e) { S.plates = []; $("#main").innerHTML = `<div class="pc-empty">${esc(e.message)}</div>`; }
    }
    renderPlateList(lot);
    if (!lot) {
      $("#main").innerHTML = `<div class="pc-card"><h2>동판 타임라인</h2><p class="sub">동판을 고르면, 그 동판으로 언제 어떤 조합을 찍었고 평가가 어땠는지 날짜순으로 모아 보여 줍니다 (일지의 "이전 작업 이력"을 자동으로).</p></div>`;
      return;
    }
    $("#main").innerHTML = `<div class="pc-empty">불러오는 중…</div>`;
    try {
      const t = await api(`/api/pccs/plate?lot=${encodeURIComponent(lot)}`);
      const items = t.entries.map((e) => {
        const layerKeys = Object.keys(e.layers || {});
        const head = `<div class="layers">${layerKeys.map((l) => `<span>${esc(l)} <b>${esc(e.layers[l])}</b></span>`).join("")}${e.kind === "v2" ? `<span class="pc-badge mute">v2.1</span>` : ""}</div>`;
        let body;
        if (e.kind === "v2") {
          body = `<div class="sub">배치 ${e.batches.map((b) => `<span class="mono">${esc(b.code)}</span>`).join(" · ") || "—"}</div>`;
        } else {
          body = `<div class="sub">${esc([e.title, e.customer, e.stage].filter(Boolean).join(" · "))}</div>`
            + (e.samples.length ? `<table class="pc"><tr><th>도장 시편</th>${layerKeys.map((l) => `<th>${esc(l)}</th>`).join("")}<th>장</th><th>평가</th><th>메모</th></tr>
              ${e.samples.map((s) => `<tr><td class="mono">${esc(s.substrate)}</td>${layerKeys.map((l) => `<td class="mono"><b>${esc(obj(s.layers)[l] || "")}</b></td>`).join("")}<td>${esc(s.qty)}</td><td>${evalBadge(s.eval)}</td><td>${esc(s.note || "")}</td></tr>`).join("")}</table>`
              : `<div class="sub">시료 기록 없음</div>`);
        }
        return `<li><div class="dt">${esc(e.date)}<a href="#/file/${encodeURIComponent(e.file)}">${esc(e.file)}</a></div><div>${head}${body}</div></li>`;
      }).join("");
      $("#main").innerHTML = `<div class="pc-card"><h2 class="mono">${esc(lot)}</h2><div class="sub">${t.entries.length}건 · 날짜순</div><ul class="tl" style="margin-top:8px">${items}</ul></div>`;
    } catch (e) {
      $("#main").innerHTML = `<div class="pc-empty">${esc(e.message)}</div>`;
    }
  }

  function setTab(t) { $$(".pc-tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === t)); }

  function route() {
    let h = location.hash.replace(/^#/, "");
    try { h = decodeURIComponent(h); } catch (e) { /* 잘린 % 주소는 그대로 */ }
    if (h.startsWith("/file/")) return showFile(h.slice(6));
    if (h === "/plates") return showPlates(null);
    if (h.startsWith("/plate/")) return showPlates(h.slice(7));
    return showFileHome();
  }

  async function boot() {
    try {
      S.status = await api("/api/pccs/status");
      if (S.status.yaml && S.status.exists) S.files = (await api("/api/pccs/files")).files || [];
    } catch (e) {
      $("#status").innerHTML = `<span class="bad">${esc(e.message)}</span>`;
    }
    renderStatus();
    window.addEventListener("hashchange", route);
    route();
  }
  boot();
})();
