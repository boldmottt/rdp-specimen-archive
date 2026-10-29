/* RDP 시편 아카이브 — 목차(카드 그리드) · 검색 · 선택 */
import { $, $$, App, html, raw, apiGet, apiPost, apiPut, byId, deriveId, esc, fmtDate, imgUrl, inCart, layers, markSaved, normalizeDoc, paintDots, revOf, saveLS, thumbUrl, toast, toggleCart, vName, varOf } from "./core.js";
import { renderCart } from "./proposal.js";
// 검색 문법은 search.js 한 곳에서만 해석한다 (tests/search.test.mjs 가 이 규칙을 검사한다)
import { parseQuery, matchVars, tokenize, tagToken, withoutToken, tagCounts, QUERY_HELP } from "./search.js";

/* ---------------- catalog ---------------- */
/* 검색 결과: 지금 조건에 남은 시편 목록. 동시에 HITS 에 "패턴별로 남은 컬러 id" 를 채운다.
   HITS 가 담기(#selall)·빼기(#selnone)·CSV 의 범위다 — 예전에는 color: 로 컬러 하나만 걸러도
   그 패턴의 모든 컬러가 담겼다(버그). 이제 걸린 컬러만 들어간다. */
export const HITS = new Map();

function filtered() {
  const Q = parseQuery(App.q);
  HITS.clear();
  const list = App.patterns.filter((p) => {
    if (App.project !== "all" && p.project !== App.project) return false;
    const vids = matchVars(p, Q);
    if (!vids) return false;
    HITS.set(p.id, vids);
    return true;
  });
  return list.sort((a, b) => {
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

/* 태그 칩 토글: 검색창 문자열에 #태그 토큰을 넣었다 뺐다 한다.
   검색 상태를 App.q 하나로 두면 저장·복원·새로고침이 저절로 맞는다. */
function toggleTag(tag) {
  const key = String(tag || "").toLowerCase();
  const isThisTag = (t) => {
    const q = parseQuery(t.raw).terms.find((x) => x.key === "tag");
    return !!q && !q.neg && q.val === key;
  };
  const has = tokenize(App.q).some(isThisTag);
  App.q = has ? withoutToken(App.q, isThisTag)
    : ((App.q || "").trim() ? App.q.trim() + " " : "") + tagToken(tag);
}

/* 태그 칩을 눌렀을 때: 검색창 값도 같이 맞추고 목차를 다시 그린다 */
function syncSearch() {
  const box = $("#search");
  if (box) box.value = App.q;
  if (location.hash && location.hash !== "#") location.hash = "";
  else renderCatalog();
}

// 카드 썸네일: 축소본 srcset + 원본 대체. 컬러 칩으로 바꿀 때도 이걸 통째로 다시 그린다
// (srcset이 있으면 브라우저는 src를 무시하므로 src만 바꾸면 화면이 그대로다)
function cardMedia(p, v) {
  const n = v && v.images && v.images.length ? v.images[0] : "";
  const vid = v ? v.id : "";
  if (!n) return html`<div class="empty" data-vid="${vid}">IMAGE N/A</div>`;
  const full = imgUrl(p.id, n);
  const alt = [p.pattern.code, vName(v)].filter(Boolean).join(" ");
  return html`<img loading="lazy" data-vid="${vid}" src="${thumbUrl(p.id, n, 480)}" srcset="${thumbUrl(p.id, n, 480)} 480w, ${thumbUrl(p.id, n, 960)} 960w, ${full} 2400w" sizes="(max-width:760px) 94vw, (max-width:1180px) 44vw, 340px" onerror="this.onerror=null;this.removeAttribute('srcset');this.src='${full}'" alt="${alt}">`;
}
function showVar(card, p, v) {
  const media = card.querySelector("a.media");
  if (!media || !v) return;
  const cur = media.querySelector("img, .empty");
  if (cur && cur.dataset.vid === v.id) return;
  const box = document.createElement("div");
  box.innerHTML = String(cardMedia(p, v));
  const next = box.firstElementChild;
  if (cur) cur.replaceWith(next); else media.prepend(next);
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
  // 컬러 점은 평균색만 필요하다 → 원본(2400px) 대신 가장 작은 축소본
  const dot = (x) => (x.images && x.images.length ? html`<span class="vdot" data-src="${thumbUrl(p.id, x.images[0], 120)}"></span>` : raw('<span class="vdot"></span>'));
  const chips = vars.length > 1
    ? html`${vars.map((x) => html`
      <button class="vchip${inCart(p.id, x.id) ? " in" : ""}${x.id === (v && v.id) ? " on" : ""}" data-sel="${x.id}" title="클릭: 제안서에 담기/빼기 · 커서를 올리면 미리보기">
        ${dot(x)}
        <span class="nm">${vName(x)}</span>
      </button>`)}<button class="vchip vchip-all" data-all="1" title="이 패턴의 모든 컬러를 한 번에">${vars.every((x) => inCart(p.id, x.id)) ? "전체 빼기" : `전체 ${vars.length}색`}</button>`
    : (v ? html`
      <button class="vchip${inCart(p.id, v.id) ? " in" : ""}${v.id === vid ? " on" : ""}" data-sel="${v.id}" title="클릭: 제안서에 담기/빼기">
        ${dot(v)}
        <span class="nm" style="font-family:var(--mono)">${vName(v)}</span>
      </button>` : "");
  const href = `#/p/${encodeURIComponent(p.id)}${v ? "/" + encodeURIComponent(v.id) : ""}`;
  const alt = [p.pattern.code, v ? vName(v) : ""].filter(Boolean).join(" ");
  return String(html`<article class="card${picked ? " picked" : ""}" data-pid="${p.id}">
      <a class="media" href="${href}" aria-label="${alt} 상세 보기">
        ${cardMedia(p, v)}
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

  // 태그 칩 줄 — 지금 프로젝트 범위에서 많이 쓴 태그부터. 누르면 #태그 가 검색창에 들어간다.
  const tagbar = (() => {
    const tags = tagCounts(App.patterns, App.project).slice(0, 18);
    if (!tags.length) return "";
    const on = new Set(parseQuery(App.q).terms.filter((t) => t.key === "tag" && !t.neg).map((t) => t.val));
    return `<div class="tagbar"><span class="tb-lbl">태그</span>${
      tags.map(([t, n]) => `<button class="chip tag${on.has(t.toLowerCase()) ? " on" : ""}" data-tag="${esc(t)}" title="눌러서 이 태그만 보기 · 다시 눌러 해제">${esc(t)}<span class="n">${n}</span></button>`).join("")
    }<button class="tb-help" id="qhelp" title="검색 문법 보기">?</button></div>`;
  })();

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
        <button class="tool" id="selall" title="지금 조건에 걸린 컬러만 제안서에 담기">${list.reduce((a, p) => a + (HITS.get(p.id) || []).length, 0)}개 담기</button>
        <button class="tool" id="selnone" title="지금 보이는 시편을 제안서에서 빼기">전체 해제</button>
        <button class="tool" id="syncall" title="RDP-DB의 배합을 모든 시편에 반영">DB 동기화</button>
        <div class="selwrap"><select id="sort" aria-label="정렬">
          <option value="recent"${App.sort === "recent" ? " selected" : ""}>최근 작업순</option>
          <option value="code"${App.sort === "code" ? " selected" : ""}>코드순</option>
        </select></div>
      </div>
      ${tagbar}
      ${list.length ? `<div class="grid">${list.map(cardHTML).join("")}</div>`
      : `<div class="empty-state"><h2>조건에 맞는 시편이 없습니다</h2><p>다른 프로젝트를 선택하거나 검색어를 지워보세요.</p></div>`}
      <div class="foot"><span>${esc(App.config.company || "")} · RDP</span>
        <span style="display:flex;gap:12px;align-items:center">
          <a href="#" id="openfolder" style="text-decoration:underline;text-underline-offset:3px">데이터 폴더 열기</a>
          <span style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(App.config.dataRoot || "")}</span>
        </span></div>
    </div>`;

  const of = $("#openfolder");
  if (of) of.onclick = (e) => { e.preventDefault(); apiPost("/api/open-folder").then(() => toast("데이터 폴더를 열었습니다")).catch((err) => toast(err.message)); };
  paintDots();
  $$("[data-proj]").forEach((el) => (el.onclick = () => { App.project = el.dataset.proj; renderCatalog(); }));
  $$("[data-tag]").forEach((el) => (el.onclick = () => { toggleTag(el.dataset.tag); syncSearch(); }));
  const qhelp = $("#qhelp");
  if (qhelp) qhelp.onclick = () => toast(QUERY_HELP, 6500);
  const btnAll = $("#selall");
  if (btnAll) btnAll.onclick = () => {
    filtered();                                   // HITS 를 지금 조건으로 다시 채운다
    App.patterns.forEach((p) => (HITS.get(p.id) || []).forEach((vid) => {
      if (!inCart(p.id, vid)) App.cart.push({ pid: p.id, vid });
    }));
    saveLS(); renderCatalog(); renderCart();
  };
  const btnNone = $("#selnone");
  if (btnNone) btnNone.onclick = () => {
    filtered();
    App.cart = App.cart.filter((c) => !(HITS.get(c.pid) || []).includes(c.vid));
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
      App.patterns = (fresh.patterns || []).map(normalizeDoc);
      renderCatalog();
      toast(`동기화 완료 · ${r.patterns}개 시편 / 추가 ${r.added} · 갱신 ${r.updated}`);
    } catch (e) { toast("동기화 실패: " + e.message); sa.disabled = false; sa.textContent = "DB 동기화"; }
  };
  $$("[data-sel]").forEach((el) => {
    const card = el.closest(".card");
    const p = byId(card.dataset.pid);
    const x = varOf(p, el.dataset.sel);
    el.onmouseenter = () => showVar(card, p, x);
    el.onmouseleave = () => showVar(card, p, varOf(p, p._sel));
    el.onclick = (e) => {
      e.stopPropagation();
      toggleCart(p.id, el.dataset.sel);
      p._sel = el.dataset.sel;
      showVar(card, p, x);
      card.querySelectorAll("[data-sel]").forEach((b) => b.classList.toggle("on", b.dataset.sel === p._sel));
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
  // 파일 ID는 편집기·사진 업로드와 같은 규칙(deriveId) — 다르면 저장 전에 올린 사진이 다른 폴더로 갔다
  const id = deriveId(d.project, d.pattern.code);
  if (!id) { toast("프로젝트·패턴 코드에 영문이나 숫자가 하나는 있어야 해요 (파일 이름에 씁니다)"); return; }
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
