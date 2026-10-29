/* RDP 시편 아카이브 — 목차(카드 그리드) · 검색 · 선택 */
import { $, $$, App, html, raw, apiGet, apiPost, apiPut, byId, deriveId, esc, fmtDate, imgUrl, inCart, layers, markSaved, normalizeDoc, paintDots, revOf, saveLS, saveSmart, thumbUrl, toast, toggleCart, vName, varOf } from "./core.js";
import { renderCart } from "./proposal.js";
// 검색 문법은 search.js 한 곳에서만 해석한다 (tests/search.test.mjs 가 이 규칙을 검사한다)
import { parseQuery, matchVars, tokenize, tagToken, withoutToken, tagCounts, QUERY_HELP } from "./search.js";
// 선택·일괄 편집·CSV (규칙은 bulk-rules.js, 화면은 bulk.js). 서로 import 하지 않고 데이터를 넘긴다.
import { bindPicks, selectionBarHTML, openBulkDialog, downloadCsv } from "./bulk.js";
// 색 정렬에서 "가장 가까운 컬러"를 고르는 규칙 — 정렬 키와 카드 표시가 같은 함수를 쓴다
import { bestVar, deLabel, baseVid, badgeFor } from "./color-rules.js";

/* ---------------- catalog ---------------- */
/* 검색 결과: 지금 조건에 남은 시편 목록. 동시에 HITS 에 "패턴별로 남은 컬러 id" 를 채운다.
   HITS 가 담기(#selall)·빼기(#selnone)·CSV 의 범위다 — 예전에는 color: 로 컬러 하나만 걸러도
   그 패턴의 모든 컬러가 담겼다(버그). 이제 걸린 컬러만 들어간다. */
export const HITS = new Map();
/* 색 정렬 중일 때 카드별 "가장 가까운 컬러" — 렌더 단계에서만 쓰고 문서(p)는 건드리지 않는다 */
const BEST = new Map();

function filtered() {
  // 기준색이 없으면 '색 가까운 순'은 아무 순서나 된다 → 최근순으로 되돌린다
  if (App.sort === "color" && !App.refColor) App.sort = "recent";
  // 기준색은 있는데 ΔE 표가 비었으면(저장 직후 캐시를 버렸을 때) 정렬하지 않는다.
  //   드롭다운은 '색 가까운 순'인데 실제로는 원래 순서인 상태를 만들지 않기 위해.
  const sortMode = App.sort === "color" && !App.de ? "recent" : App.sort;
  const Q = parseQuery(App.q);
  HITS.clear();
  const list = App.patterns.filter((p) => {
    if (App.project !== "all" && p.project !== App.project) return false;
    const vids = matchVars(p, Q);
    if (!vids) return false;
    HITS.set(p.id, vids);
    return true;
  });
  BEST.clear();
  if (sortMode === "color" && App.de) {
    list.forEach((p) => { const b = bestVar(p.id, HITS.get(p.id), App.de); if (b) BEST.set(p.id, b); });
  }
  return list.sort((a, b) => {
    if (sortMode === "code") return (a.project + a.pattern.code).localeCompare(b.project + b.pattern.code);
    // 색 가까운 순: 그 카드에서 '검색에 걸린 컬러' 중 기준색과 가장 가까운 ΔE 로 줄 세운다
    if (sortMode === "color" && App.de) {
      // 카드에 보여 줄 컬러(bestVar)와 같은 값으로 줄을 세운다 — 표시와 순서가 어긋나지 않게
      const key = (p) => { const b = bestVar(p.id, HITS.get(p.id), App.de); return b ? b.de : 999; };
      return key(a) - key(b);
    }
    if (sortMode === "recent") {
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

/* ---------------- 색(사진 대표색) ----------------
 * 색은 사진에서 뽑은 값이라 측색값과 다르다. 정렬용 참고로만 쓴다(화면에도 그렇게 알린다).
 * /api/colors 는 컬러마다 첫 사진의 대표색을 돌려준다. 한 번 받아 App.colors 에 캐시한다. */
let colorsPending = null;
async function ensureColors() {
  if (App.colors) return App.colors;
  // 같은 순간에 여러 번 그려도 요청은 하나로 합친다(캐시를 비운 직후 두 번 부르면 두 번 나갔다)
  if (colorsPending) return colorsPending;
  colorsPending = apiGet("/api/colors").then((r) => {
    App.colors = new Map((r.items || []).map((it) => [it.pid + "/" + it.vid, it]));
    return App.colors;
  }).finally(() => { colorsPending = null; });
  return colorsPending;
}

async function paintRefDots() {
  try {
    const m = await ensureColors();
    $$(".refdot").forEach((el) => {
      const it = m.get(el.dataset.pid + "/" + (el.dataset.ref || ""));
      const c = it && it.colors && it.colors[0];
      if (c) { el.style.background = c.hex; el.classList.add("has"); }
    });
    // 색 정렬 배지의 '이 컬러' 견본 (paintSwatch 와 같은 규칙)
    $$(".de-badge .this").forEach((el) => paintSwatch(el, el.dataset.pid, el.dataset.vid || ""));
  } catch (e) { /* 색을 못 읽어도 목록은 그대로 */ }
}

/* 저장하면 invalidation 으로 App.de 가 비워진다. 색 정렬을 쓰던 중이면 ΔE 표만 다시 받아
   정렬을 이어 간다(기준색은 그대로 — Lab 값이라 사진 교체와 무관하다). */
let dePending = false;
async function ensureDe() {
  if (App.sort !== "color" || !App.refColor || App.de || dePending) return;
  dePending = true;
  try {
    const r = await apiGet("/api/colors?ref=" + App.refColor.lab.join(","));
    App.de = new Map((r.items || []).map((x) => [x.pid + "/" + x.vid, x.de]));
    if (!location.hash || location.hash === "#") renderCatalog();   // 표가 생겼으니 다시 그린다
  } catch (e) {
    /* 실패하면 정렬은 최근순으로 떨어진다(위 sortMode) */
  } finally {
    dePending = false;
  }
}

async function setRefColor(pid, vid) {
  const m = await ensureColors();
  const it = m.get(pid + "/" + (vid || ""));
  const c = it && it.colors && it.colors[0];
  if (!c) { toast("이 컬러에는 사진이 없어 기준으로 쓸 수 없습니다"); return; }
  App.refColor = { pid, vid, lab: c.lab, hex: c.hex };
  // 기준색을 새로 잡으면 각 카드의 '눌러서 고정된 컬러'를 푼다 — 안 풀면 정렬 순서(가장 가까운 컬러)와
  // 카드 사진이 어긋난다(예전에 담아 둔 카드가 옛 컬러 사진을 계속 보여 주던 문제).
  App.patterns.forEach((p) => { delete p._sel; });
  const r = await apiGet("/api/colors?ref=" + c.lab.join(","));
  App.de = new Map((r.items || []).map((x) => [x.pid + "/" + x.vid, x.de]));
  App.sort = "color";
  renderCatalog();
  toast(`기준색 ${c.hex} (사진 기준) — 측색값이 아니라 근사입니다`, 4000);
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
  if (!(cur && cur.dataset.vid === v.id)) {
    const box = document.createElement("div");
    box.innerHTML = String(cardMedia(p, v));
    const next = box.firstElementChild;
    if (cur) cur.replaceWith(next); else media.prepend(next);
  }
  paintBadge(card, p, v);
}

/* 배지를 '지금 보이는 컬러'에 맞춘다 — 사진과 배지가 서로 다른 컬러를 가리키지 않게.
   ΔE 가 없는 컬러(사진 없음 등)에서는 배지를 숨긴다. */
function paintBadge(card, p, v) {
  const badge = card.querySelector(".de-badge");
  if (!badge) return;
  const bd = (App.sort === "color" && App.de) ? badgeFor(p.id, v && v.id, App.de, BEST.get(p.id) || null) : null;
  if (!bd) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.querySelector(".de-num").textContent = `ΔE ${bd.de.toFixed(1)}`;
  const word = badge.querySelector("b");
  const text = bd.isBest ? "가장 가까움" : (bd.de <= 5 ? bd.label : "");
  word.textContent = text;
  word.hidden = !text;
  const sw = badge.querySelector(".this");
  if (sw) { sw.dataset.vid = v.id; paintSwatch(sw, p.id, v.id); }
}

function paintSwatch(el, pid, vid) {
  const it = App.colors && App.colors.get(pid + "/" + vid);
  const hex = it && it.colors && it.colors[0] && it.colors[0].hex;
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) el.style.background = hex;
}

function cardHTML(p) {
  const vars = p.variations || [];
  // 색 정렬 중에는 '기준색과 가장 가까운 컬러'를 보여 준다. 커서를 올린 칩(p._sel)이 있으면 그게 우선.
  const best = App.sort === "color" && App.de ? BEST.get(p.id) : null;
  const vid = baseVid({ sel: p._sel, best, first: vars[0] && vars[0].id });
  const v = varOf(p, vid) || vars[0];
  // 배지는 '지금 보이는 컬러'의 ΔE — 사진과 배지가 항상 같은 컬러를 가리킨다.
  // 색 정렬일 때만 붙인다(최근순·코드순은 예전과 똑같이 배지가 없다).
  const bd = App.sort === "color" && App.de ? badgeFor(p.id, v && v.id, App.de, best) : null;
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
      <button class="vchip${inCart(p.id, x.id) ? " in" : ""}${x.id === (v && v.id) ? " on" : ""}${best && best.vid === x.id ? " best" : ""}" data-sel="${x.id}" title="클릭: 제안서에 담기/빼기 · 커서를 올리면 미리보기">
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
  // 선택 체크는 .media(링크) 밖에 둔다 — 안에 두면 누를 때 상세로 넘어간다.
  // 위치는 오른쪽 위: 왼쪽 위(.badge, left:10px)와 겹치지 않게.
  const sel = App.sel.has(p.id);
  return String(html`<article class="card${picked ? " picked" : ""}${sel ? " sel" : ""}" data-pid="${p.id}" data-base="${v ? v.id : ""}">
      <button class="pick${sel ? " on" : ""}" data-pick="${p.id}" aria-pressed="${sel ? "true" : "false"}"
        title="선택 (Shift 범위 · Cmd/Ctrl 하나씩)">✓</button>
      <a class="media" href="${href}" aria-label="${alt} 상세 보기">
        ${cardMedia(p, v)}
        ${p.project ? html`<div class="badge">${p.project}</div>` : ""}
        ${bd ? html`<span class="de-badge" title="사진에서 뽑은 대표색 기준 — 측색값과 다를 수 있습니다">
            <i class="sw ref" style="background:${App.refColor && /^#[0-9a-f]{6}$/i.test(App.refColor.hex || "") ? App.refColor.hex : "transparent"}"></i>
            <i class="sw this" data-pid="${p.id}" data-vid="${v ? v.id : ""}"></i>
            <span class="de-num">ΔE ${bd.de.toFixed(1)}</span><b${bd.isBest || bd.de <= 5 ? "" : " hidden"}>${bd.isBest ? "가장 가까움" : (bd.de <= 5 ? bd.label : "")}</b>
          </span>` : ""}
      </a>
      <div class="card-body">
        <div class="card-title">${title}</div>
        <div class="card-meta">${meta}<button class="refdot" data-pid="${p.id}" data-ref="${v ? v.id : ""}"
          aria-label="이 색을 기준으로" title="이 컬러를 기준색으로 삼아 '색 가까운 순' 정렬">◎</button></div>
        <div class="vchips">${chips}</div>
      </div>
    </article>`);
}

export function renderCatalog() {
  document.body.classList.remove("prop-mode");
  ensureDe();                       // 색 정렬인데 ΔE 표가 비었으면 서버에서 한 번 받아 온다


  const list = filtered();
  const projects = ["all"].concat(Array.from(new Set(App.patterns.map((p) => p.project))));
  const chips = projects.map((k) => {
    const n = k === "all" ? App.patterns.length : App.patterns.filter((p) => p.project === k).length;
    return `<button class="chip${App.project === k ? " on" : ""}" data-proj="${esc(k)}">${k === "all" ? "전체" : (k ? esc(k) : "미지정")}<span class="n">${n}</span></button>`;
  }).join("");
  const totalVar = App.patterns.reduce((a, p) => a + (p.variations || []).length, 0);
  const totalMix = App.patterns.reduce((a, p) => a + (p.variations || []).reduce((b, v) => b + (v.mixes || []).length, 0), 0);

  // 저장된 검색(스마트 폴더) 줄 — 지금 조건을 이름 붙여 저장한다.
  //   폴더를 바꿀 때만 saveSmart() 로 서버에 보낸다(장바구니 저장이 남의 목록을 덮지 않게).
  const sfbar = (() => {
    const fs = App.smartFolders || [];
    const chips = fs.map((f) => {
      const on = f.q === App.q && f.project === App.project;
      return `<span class="chip sf${on ? " on" : ""}" data-sf="${esc(f.id)}">` +
        `<b class="sf-name" title="눌러서 적용 · 두 번 눌러 이름 바꾸기">${esc(f.name)}</b>` +
        `<button class="sf-del" title="저장된 검색 지우기" aria-label="${esc(f.name)} 지우기">×</button></span>`;
    }).join("");
    return `<div class="sfbar"><span class="tb-lbl">저장</span>${chips}` +
      `<button class="tool mini" id="sf-save" title="지금 검색 조건을 이름 붙여 저장">＋ 현재 조건 저장</button></div>`;
  })();

  // 태그 칩 줄 — 지금 프로젝트 범위에서 많이 쓴 태그부터. 누르면 #태그 가 검색창에 들어간다.
  const tagbar = (() => {
    const tags = tagCounts(App.patterns, App.project).slice(0, 20);
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
        <button class="tool" id="csv" title="지금 목록을 CSV로 내려받기 (엑셀)">CSV</button>
        <button class="tool" id="boardbtn" title="지금 프로젝트의 컬러 보드 보기">컬러 보드</button>
        <div class="selwrap"><select id="sort" aria-label="정렬">
          <option value="recent"${App.sort === "recent" ? " selected" : ""}>최근 작업순</option>
          <option value="code"${App.sort === "code" ? " selected" : ""}>코드순</option>
          <option value="color"${App.sort === "color" ? " selected" : ""}${App.refColor ? "" : " disabled"}>색 가까운 순${App.refColor ? "" : " (◎ 먼저)"}</option>
        </select></div>
      </div>
      ${selectionBarHTML()}
      ${sfbar}
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

  // 저장된 검색: 저장 / 적용 / 이름 변경 / 삭제
  const sfSave = $("#sf-save");
  if (sfSave) sfSave.onclick = () => {
    const dflt = App.q.trim() || (App.project !== "all" ? App.project : "저장된 검색");
    const name = (prompt("저장할 이름", dflt) || "").trim();
    if (!name) return;
    App.smartFolders.push({
      id: "sf" + Date.now().toString(36), name,
      q: App.q, project: App.project,
      sort: App.sort === "code" ? "code" : "recent",   // 색 정렬은 기준색이 저장되지 않으므로 최근순으로
    });
    saveSmart(); renderCatalog(); toast("저장했습니다");
  };
  $$("[data-sf]").forEach((el) => {
    const f = (App.smartFolders || []).find((x) => x.id === el.dataset.sf);
    if (!f) return;
    const nm = el.querySelector(".sf-name");
    nm.onclick = () => {
      App.q = f.q || ""; App.project = f.project || "all"; App.sort = f.sort || "recent";
      const box = $("#search"); if (box) box.value = App.q;
      renderCatalog();
    };
    nm.ondblclick = () => {
      const n = (prompt("새 이름", f.name) || "").trim();
      if (n && n !== f.name) { f.name = n; saveSmart(); renderCatalog(); }
    };
    el.querySelector(".sf-del").onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`'${f.name}' 저장된 검색을 지울까요?`)) return;
      App.smartFolders = (App.smartFolders || []).filter((x) => x.id !== f.id);
      saveSmart(); renderCatalog();
    };
  });
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
  // 선택(패턴 단위) · 일괄 편집 · CSV
  bindPicks(list.map((p) => p.id), renderCatalog);
  const csvBtn = $("#csv");
  if (csvBtn) csvBtn.onclick = () => downloadCsv(list, (pid) => HITS.get(pid));
  const bulkBtn = $("#bulk-open");
  if (bulkBtn) bulkBtn.onclick = () => openBulkDialog(renderCatalog, (pid) => HITS.get(pid));

  // 기준색(사진 대표색) — 카드의 ◎ 를 누르면 그 컬러가 기준이 되고 '색 가까운 순'으로 바뀐다
  paintRefDots();
  $$(".refdot").forEach((el) => (el.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    setRefColor(el.dataset.pid, el.dataset.ref).catch((err) => toast(err.message || "색을 읽지 못했습니다"));
  }));
  const boardBtn = $("#boardbtn");
  if (boardBtn) boardBtn.onclick = () => {
    if (App.project === "all") { toast("프로젝트를 먼저 고르세요"); return; }
    location.hash = "#/board/" + encodeURIComponent(App.project);
  };

  const sel = $("#sort");
  if (sel) sel.onchange = (e) => {
    if (e.target.value === "color" && !App.refColor) {
      toast("카드의 ◎ 를 먼저 눌러 기준색을 잡아 주세요");
      e.target.value = App.sort;
      return;
    }
    App.sort = e.target.value;
    renderCatalog();
  };
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
    // 떼면 '이 카드의 기본 컬러'(색 정렬이면 가장 가까운 컬러)로 돌아간다 — p._sel 이 아니라
    el.onmouseleave = () => showVar(card, p, varOf(p, card.dataset.base));
    el.onclick = (e) => {
      e.stopPropagation();
      toggleCart(p.id, el.dataset.sel);
      p._sel = el.dataset.sel;
      card.dataset.base = el.dataset.sel;      // 누른 컬러가 이 카드의 기본이 된다
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
