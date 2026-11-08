/* RDP 시편 아카이브 — 목차(카드 그리드) · 검색 · 선택 */
import { $, $$, App, html, raw, apiGet, apiPost, apiPut, byId, confirmDialog, deriveId, esc, flushNewPhotos, fmtDate, imgUrl, inCart, layers, markSaved, normalizeDoc, paintDots, promptDialog, revOf, saveLS, saveSmart, thumbUrl, toast, toggleCart, vName, varOf } from "./core.js";
import { renderCart } from "./proposal.js";
// 검색 문법은 search.js 한 곳에서만 해석한다 (tests/search.test.mjs 가 이 규칙을 검사한다)
import { parseQuery, matchVars, tokenize, tagToken, withoutToken, tagCounts, fieldToken, hasToken, splitTagGroups, QUERY_HELP } from "./search.js";
// 선택·일괄 편집·CSV (규칙은 bulk-rules.js, 화면은 bulk.js). 서로 import 하지 않고 데이터를 넘긴다.
import { bindPicks, selectionBarHTML, openBulkDialog, downloadCsv } from "./bulk.js";
// 색 정렬에서 "가장 가까운 컬러"를 고르는 규칙 — 정렬 키와 카드 표시가 같은 함수를 쓴다
import { bestVar, deLabel, baseVid, hitFirst, badgeFor } from "./color-rules.js";
import { autoFacets } from "./facets.js";
import { compareFromSelection } from "./compare-page.js";
import { openWorklogPicker } from "./from-worklog.js";
import { openCsvImport } from "./import-csv.js";
import { openBakeDialog } from "./bake-dialog.js";
import { bindRate, rateHTML } from "./rating.js";
import { setView, viewSwitchHTML, bodyHTML, bindBody } from "./views.js";
import { workOf } from "./work.js";

/* ---------------- catalog ---------------- */
/* 검색 결과: 지금 조건에 남은 시편 목록. 동시에 HITS 에 "패턴별로 남은 컬러 id" 를 채운다.
   HITS 가 담기(#selall)·빼기(#selnone)·CSV 의 범위다 — 예전에는 color: 로 컬러 하나만 걸러도
   그 패턴의 모든 컬러가 담겼다(버그). 이제 걸린 컬러만 들어간다. */
export const HITS = new Map();
/* 색 정렬 중일 때 카드별 "가장 가까운 컬러" — 렌더 단계에서만 쓰고 문서(p)는 건드리지 않는다 */
const BEST = new Map();
/* DB 동기화 진행 중 표시 — renderCatalog 안에 두면 다시 그릴 때마다 초기화되어 중복 요청을 막지 못한다 */
let syncingAll = false;

function filtered() {
  // 기준색이 없으면 '색 가까운 순'은 아무 순서나 된다 → 최근순으로 되돌린다
  if (App.sort === "color" && !App.refColor) App.sort = "recent";
  // 기준색은 있는데 ΔE 표가 비었으면(저장 직후 캐시를 버렸을 때) 정렬하지 않는다.
  //   드롭다운은 '색 가까운 순'인데 실제로는 원래 순서인 상태를 만들지 않기 위해.
  const sortMode = App.sort === "color" && !App.de ? "recent" : App.sort;
  const Q = parseQuery(App.q, { tagMode: App.prop.tagMode });
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
  const rate = card.querySelector(".card-rate");
  if (rate && !rate.querySelector(`[data-rate="${CSS.escape(p.id + "::" + v.id)}"]`)) {
    rate.innerHTML = rateHTML(p.id, v.id, true);     // 별점은 '지금 보이는 컬러' 것
    bindRate(rate);
  }
}

/* 배지를 '지금 보이는 컬러'에 맞춘다 — 사진과 배지가 서로 다른 컬러를 가리키지 않게.
   ΔE 가 없는 컬러(사진 없음 등)에서는 배지를 숨긴다. */
function paintBadge(card, p, v) {
  const badge = card.querySelector(".de-badge");
  if (!badge) return;
  const bd = (App.sort === "color" && App.de) ? badgeFor(p.id, v && v.id, App.de, BEST.get(p.id) || null) : null;
  if (!bd) {
    // 숨김 + 값도 비운다 — 화면에는 안 보이지만, 나중에 다른 컬러로 바뀔 때 옛 숫자가 남지 않게
    badge.hidden = true;
    badge.querySelector(".de-num").textContent = "";
    const w = badge.querySelector("b");
    w.textContent = ""; w.hidden = true;
    return;
  }
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
  const colorMode = App.sort === "color" && !!App.de;   // 색 정렬 중인가(배지 자리를 그릴지 결정)
  const best = colorMode ? BEST.get(p.id) : null;
  // 검색이 컬러를 좁혔으면(도장:DC-101 등) 걸린 컬러를 먼저 보여 준다 — 사진도 그 컬러의 것
  const hits = HITS.get(p.id);
  const narrowed = !!hits && hits.length < vars.length;
  const hitSet = new Set(hits || []);
  const vid = baseVid({ sel: p._sel, best, first: hitFirst(vars, hits) });
  const v = varOf(p, vid) || vars[0];
  // 배지는 '지금 보이는 컬러'의 ΔE — 사진과 배지가 항상 같은 컬러를 가리킨다.
  // 색 정렬일 때만 자리를 만들고(최근순·코드순은 예전과 똑같이 배지가 없다),
  // 이 컬러에 ΔE 가 없으면 hidden 으로 숨긴다 — 자리를 남겨 두어야 다른 칩에 올렸을 때 값이 뜬다.
  const bd = colorMode ? badgeFor(p.id, v && v.id, App.de, best) : null;
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
      <button class="vchip${inCart(p.id, x.id) ? " in" : ""}${x.id === (v && v.id) ? " on" : ""}${best && best.vid === x.id ? " best" : ""}${narrowed && !hitSet.has(x.id) ? " miss" : ""}" data-sel="${x.id}" title="${narrowed && !hitSet.has(x.id) ? "검색 조건에 안 걸린 컬러 · " : ""}클릭: 제안서에 담기/빼기 · 커서를 올리면 미리보기">
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
        ${p.project && App.project === "all" ? html`<div class="badge">${p.project}</div>` : ""}
        ${colorMode ? html`<span class="de-badge" title="사진에서 뽑은 대표색 기준 — 측색값과 다를 수 있습니다"${bd ? "" : " hidden"}>
            <i class="sw ref" style="background:${App.refColor && /^#[0-9a-f]{6}$/i.test(App.refColor.hex || "") ? App.refColor.hex : "transparent"}"></i>
            <i class="sw this" data-pid="${p.id}" data-vid="${v ? v.id : ""}"></i>
            <span class="de-num">${bd ? `ΔE ${bd.de.toFixed(1)}` : ""}</span><b${bd ? "" : " hidden"}>${bd ? (bd.isBest ? "가장 가까움" : (bd.de <= 5 ? bd.label : "")) : ""}</b>
          </span>` : ""}
      </a>
      <div class="card-body">
        <div class="card-title">${title}</div>
        <div class="card-meta">${meta}<button class="refdot" data-pid="${p.id}" data-ref="${v ? v.id : ""}"
          aria-label="이 색을 기준으로" title="이 컬러를 기준색으로 삼아 '색 가까운 순' 정렬">◎</button></div>
        <div class="vchips">${chips}</div>
        ${v ? raw(`<div class="card-rate">${rateHTML(p.id, v.id, true)}</div>`) : ""}
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

  // 좁히기 줄(C) 접힘 상태 — 좁은 화면에서만 접힌다. 상태는 localStorage 한 키에만 둔다.
  let filtersOpen = false;
  try { filtersOpen = localStorage.getItem("rdp.filtersOpen") === "1"; } catch (e) {}
  // 필터 ▾ 옆 숫자 = 저장된 검색 수 + 지금 검색에 걸린 태그 수
  const activeTerms = parseQuery(App.q).terms.filter((t) => !t.neg);
  const tagOnCount = activeTerms.filter((t) => t.key === "tag").length;
  const autoOnCount = activeTerms.filter((t) => ["client", "place", "code", "layers", "plate", "color", "status"].includes(t.key)).length;
  const filterCount = (App.smartFolders || []).length + tagOnCount + autoOnCount;

  // 결과 줄(B)에 쓸 값 — 지금 조건에 남은 컬러 수, 전부 담겨 있는지
  const hitCount = list.reduce((a, p) => a + (HITS.get(p.id) || []).length, 0);
  const allIn = hitCount > 0 && list.every((p) => (HITS.get(p.id) || []).every((vid) => inCart(p.id, vid)));

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
    // 저장할 조건이 없으면 버튼도 없다(검색어도 프로젝트 선택도 없을 때)
    const canSave = !!(App.q || "").trim() || App.project !== "all";
    const saveBtn = canSave
      ? `<button class="tool mini" id="sf-save" title="지금 검색 조건을 이름 붙여 저장">☆ 현재 조건 저장</button>`
      : "";
    if (!chips && !saveBtn) return "";
    return `<div class="sfbar fc-sec"><span class="tb-lbl fc-h">저장된 검색</span>${chips}${saveBtn}</div>`;
  })();

  // 태그 칩 줄 — 지금 프로젝트 범위에서 많이 쓴 태그부터. 누르면 #태그 가 검색창에 들어간다.
  // 자동 태그 — 필드 값에서 계산한 것(저장하지 않음). 직접 단 태그와 구분선으로 나눈다.
  //   직접 단 태그처럼 지금 프로젝트 범위로 센다 — 다른 프로젝트 수까지 세면 눌렀을 때 숫자와 결과가 달랐다
  const autoRows = autoFacets(App.project === "all" ? App.patterns : App.patterns.filter((p) => p.project === App.project), workOf, 6);

  const tagbar = (() => {
    // '질감:우드'처럼 '그룹:값'으로 단 태그는 그룹별로 묶어 값만 보여 준다(태그 그룹)
    const split = splitTagGroups(tagCounts(App.patterns, App.project));
    const tags = split.plain.slice(0, 20);
    if (!tags.length && !split.groups.length && !autoRows.length) return "";
    const posTerms = parseQuery(App.q).terms.filter((t) => !t.neg);
    const on = new Set(posTerms.filter((t) => t.key === "tag").map((t) => t.val));
    // 같은 종류(태그·고객사·계열·작업장소·도수 …)를 2개 이상 골랐을 때만 조합 선택이 의미가 있다
    const kindCount = new Map();
    posTerms.forEach((t) => kindCount.set(t.key, (kindCount.get(t.key) || 0) + 1));
    const multiKind = [...kindCount.values()].some((n) => n > 1);
    const chip = (t, label, n) => `<button class="chip tag${on.has(t.toLowerCase()) ? " on" : ""}" data-tag="${esc(t)}" title="눌러서 이 태그만 보기 · 다시 눌러 해제">${esc(label)}<span class="n">${n}</span></button>`;
    const groupHTML = split.groups.map((g) => `<span class="auto-group tag-group"><span class="auto-lbl">${esc(g.name)}</span>${
      g.items.slice(0, 12).map((i) => chip(i.tag, i.value, i.n)).join("")}</span>`).join("");
    // 조합 선택은 **항상** 보인다. 조건을 고를 때만 나타나면 그 순간 칩들이 밀려 버튼 위치가 바뀐다.
    //   지금은 효과가 없을 때(같은 종류를 2개 미만 골랐을 때)만 흐리게 표시한다.
    const modeHTML = `<span class="tb-mode${multiKind ? "" : " is-idle"}" role="group" aria-label="조건 조합"><span class="tb-lbl">조합</span>` +
      `<button class="tb-m${(App.prop.tagMode || "and") === "or" ? "" : " on"}" data-tagmode="and" title="AND — 같은 종류를 여러 개 골랐을 때 모두 만족">AND</button>` +
      `<button class="tb-m${(App.prop.tagMode || "and") === "or" ? " on" : ""}" data-tagmode="or" title="OR — 같은 종류를 여러 개 골랐을 때 하나라도 만족 (종류가 다르면 그대로 AND)">OR</button></span>`;
    return `<div class="tagbar">${modeHTML}${tags.length ? '<span class="tb-lbl">태그</span>' : ""}${
      tags.map(([t, n]) => chip(t, t, n)).join("")
    }${groupHTML}${autoTagHTML()}<button class="tb-help" id="qhelp" title="검색 문법 보기">?</button></div>`;
  })();

  function autoTagHTML() {
    if (!autoRows.length) return "";
    const sep = tagCounts(App.patterns, App.project).length ? `<span class="tb-sep" aria-hidden="true"></span>` : "";
    return sep + autoRows.map((row) => {
      const chips = row.values.map((v) => {
        const tok = fieldToken(row.kind, v.val);
        const on = hasToken(App.q, tok);
        return `<button class="chip auto${on ? " on" : ""}" data-auto="${esc(tok)}"
          title="${esc(row.label)} ${esc(v.val)} — ${v.n}장${v.colors != null && v.colors !== v.n ? ` · 컬러 ${v.colors}개` : ""} · 눌러서 거르기(자동 태그, 저장되지 않음)">${esc(v.val)}<span class="n">${v.n}</span></button>`;
      }).join("");
      return `<span class="auto-group"><span class="auto-lbl">${esc(row.label)}</span>${chips}</span>`;
    }).join("");
  }

  // 적용된 조건 줄 — 지금 걸린 프로젝트·검색 조건을 하나씩 지울 수 있는 칩으로 보여 준다
  //   (좁혀진 목록이 전체처럼 보이지 않게). 칩을 지우면 검색어에서 그 토큰만 뺀다.
  const activeHTML = (() => {
    const toks = tokenize(App.q);
    const proj = App.project !== "all"
      ? `<span class="achip"><span class="achip-k">프로젝트</span>${esc(App.project || "미지정")}<button type="button" data-rmproj aria-label="프로젝트 조건 빼기">×</button></span>` : "";
    if (!toks.length && !proj) return "";
    return `<div class="activebar" aria-label="적용된 조건">${proj}${toks.map((t) =>
      `<span class="achip${t.raw.startsWith("-") ? " neg" : ""}">${esc(t.raw)}<button type="button" data-rmtok="${esc(t.raw)}" aria-label="${esc(t.raw)} 빼기">×</button></span>`).join("")}` +
      `<button type="button" class="achip-clear" id="clearq">모두 지우기</button></div>`;
  })();

  // 페이지 머리 요약 카드 — 실제 데이터에서만 센다(가짜 추세 없음). 이번 달 = 오늘 기준 YYYY-MM
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const allVars = App.patterns.reduce((a, p) => a.concat(p.variations || []), []);
  const newPat = App.patterns.filter((p) => String(p.createdAt || "").startsWith(ym)).length;
  const newVar = allVars.filter((v) => String(v.date || "").startsWith(ym)).length;
  const approved = allVars.filter((v) => v.status === "승인").length;
  const prelim = allVars.filter((v) => v.status === "가승인").length;
  const refMix = allVars.reduce((a, v) => a + (v.mixes || []).filter((m) => m.isReference).length, 0);
  const statCard = (k, v, badge, trend, note) => `<div class="stat"><div class="stat-top"><span class="k">${k}</span>${badge ? `<span class="pill b-outline">${badge}</span>` : ""}</div>
      <span class="v">${v}</span><span class="f">${trend}<span class="muted">${note}</span></span></div>`;
  const upIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8M14 7h7v7"/></svg>';
  const statsHTML = [
    statCard("패턴", App.patterns.length, newPat ? `${upIcon}+${newPat}` : "", newPat ? `<span class="up">이번 달 ${newPat}개 추가</span>` : "", newPat ? "" : "이번 달 추가 없음"),
    statCard("컬러 베리에이션", totalVar, newVar ? `${upIcon}+${newVar}` : "", newVar ? `<span class="up">이번 달 작업 ${newVar}색</span>` : "", newVar ? "" : "이번 달 작업 없음"),
    statCard("승인된 컬러", approved, "", `<span>가승인 ${prelim}색</span>`, " 대기"),
    statCard("배합", totalMix, "", `<span>기준 배합 ${refMix}개</span>`, ""),
  ].join("");
  const crumb = App.project === "all" ? "전체" : esc(App.project || "미지정");

  $("#view").innerHTML = `<section class="pagehead"><div class="ph-in">
      <nav class="crumbs" aria-label="경로"><a href="#" id="ph-home">시편 아카이브</a><span aria-hidden="true">/</span><span aria-current="page">${crumb}</span></nav>
      <div class="ph-title">
        <div class="ph-text"><h1>${App.project === "all" ? "전체 시편" : esc(App.project || "미지정") + " 시편"}</h1>
          <p>패턴 하나에 컬러 여러 개. 컬러 칩을 눌러 제안서에 담아요.</p></div>
        <button class="btn-line" type="button" id="ph-csv">CSV 내보내기</button>
        <button class="btn-line" type="button" id="ph-tidy">정리 도구</button>
      </div>
      <div class="ph-stats">${statsHTML}</div>
    </div></section>
    <div class="wrap">
      <div class="cat">
      <aside class="filterbar facets${filtersOpen ? " open" : ""}" id="filterbar" aria-label="거르기">
        <div class="fc-sec"><div class="fc-h">프로젝트</div><div class="projrow">${chips}</div></div>
        ${sfbar}${tagbar}
      </aside>
      <div class="cat-main">
      <div class="fpanel">
        <div class="fp-top">
          <span class="res-n" title="지금 조건에 걸린 시편·컬러">${list.length}장 · ${hitCount}색</span>
          <span class="grow"></span>
          ${viewSwitchHTML()}
          <div class="seg" role="radiogroup" aria-label="정렬">
            ${[["recent", "최근"], ["code", "코드"], ["color", "색"]].map(([v, label]) => {
              const off = v === "color" && !App.refColor;
              const dot = v === "color" && App.refColor ? '<i class="sw dot"></i>' : "";
              return `<label class="segbtn${App.sort === v ? " on" : ""}${off ? " off" : ""}"${off ? ' title="카드의 ◎로 기준색을 고르세요"' : ""}>
                <input type="radio" name="sort" value="${v}"${App.sort === v ? " checked" : ""}${off ? " disabled" : ""}>${dot}${label}</label>`;
            }).join("")}
          </div>
          <button class="tool" id="selall" title="지금 조건에 걸린 컬러만 제안서에 담기·빼기">${allIn ? `${hitCount}개 빼기` : `${hitCount}개 담기`}</button>
          <button class="tool filtertoggle" id="filtertoggle" aria-controls="filterbar" aria-expanded="${filtersOpen ? "true" : "false"}" title="프로젝트·저장된 검색·태그 펼치기">필터 ▾${filterCount ? ` ${filterCount}` : ""}</button>
          <div class="more">
            <button class="tool" id="morebtn" aria-haspopup="true" aria-expanded="false" aria-label="더보기">⋯</button>
            <div class="menu" id="moremenu" hidden>
              <button type="button" data-act="csv">CSV로 내보내기</button>
              <button type="button" data-act="csvin">CSV 가져오기 (일괄 등록)</button>
              <button type="button" data-act="sync">DB 동기화</button>
              <button type="button" data-act="none">결과 빼기 (${hitCount}개)</button>
              <button type="button" data-act="board">${App.project === "all" ? "컬러 보드 (프로젝트 선택)" : `${esc(App.project)} 컬러 보드`}</button>
              <button type="button" data-act="fromwl">작업일지에서 새 시편</button>
              <button type="button" data-act="report">개발 실적 보고서</button>
              <button type="button" data-act="tidy">정리 도구</button>
              <button type="button" data-act="bake">보기 전용 파일 (맥 꺼져도 보기)</button>
              <button type="button" data-act="plates">동판 대장</button>
              <button type="button" data-act="compare">나란히 비교</button>
              <button type="button" data-act="help">검색 문법</button>
            </div>
          </div>
        </div>
        <div class="fp-res">
          ${App.project !== "all" ? `<a class="tool board-link" id="boardbtn" href="#/board/${encodeURIComponent(App.project)}" title="지금 프로젝트의 컬러 보드">${esc(App.project)} 컬러 보드 →</a>` : ""}
          ${App.refColor ? (() => {
            const rp = byId(App.refColor.pid), rv = rp && varOf(rp, App.refColor.vid);
            const label = rp ? `${rp.pattern.code} ${rv ? vName(rv) : App.refColor.vid}` : App.refColor.vid;
            return `<span class="refchip" title="색 가까운 순의 기준 — 사진에서 뽑은 대표색">
              <i class="sw" style="background:${/^#[0-9a-f]{6}$/i.test(App.refColor.hex || "") ? App.refColor.hex : "transparent"}"></i>
              <b data-refgoto>${esc(label)}</b><button type="button" data-refclear aria-label="기준색 해제">×</button></span>`;
          })() : ""}
          ${activeHTML}
        </div>
      </div>
      ${selectionBarHTML()}
      ${list.length ? `<div id="vbody">${bodyHTML(list, (pid) => HITS.get(pid), cardHTML)}</div>`
      : `<div class="panel empty-wrap"><div class="empty">
          <span class="ic" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>
          <div><h3>조건에 맞는 시편이 없어요</h3>
          <p>${(App.q || "").trim() || App.project !== "all" ? `걸린 조건을 하나씩 빼 보거나 모두 지워 보세요.` : "아직 등록한 시편이 없어요. 새 시편을 등록해 보세요."}</p></div>
          <div class="acts">${(App.q || "").trim() || App.project !== "all" ? `<button class="btn-line" type="button" id="empty-clear">조건 모두 지우기</button>` : ""}
          <button class="btn-dark" type="button" id="empty-new">새 시편</button></div>
        </div></div>`}
      </div>
      </div>
      <div class="foot"><span>${esc(App.config.company || "")} · RDP</span>
        <span class="foot-right">
          <a href="#" id="openfolder">데이터 폴더 열기</a>
          <span class="path" title="${esc(App.config.dataRoot || "")}">
            <span class="path-full">${esc(App.config.dataRoot || "")}</span>
            <span class="path-tail">…/${esc((App.config.dataRoot || "").split("/").slice(-2).join("/"))}</span>
          </span>
        </span></div>
    </div>`;

  const of = $("#openfolder");
  if (of) of.onclick = (e) => { e.preventDefault(); apiPost("/api/open-folder").then(() => toast("데이터 폴더를 열었습니다")).catch((err) => toast(err.message)); };
  paintDots();
  $$("[data-proj]").forEach((el) => (el.onclick = () => { App.project = el.dataset.proj; renderCatalog(); }));
  $$("[data-rmtok]").forEach((el) => (el.onclick = () => { const r = el.dataset.rmtok; App.q = withoutToken(App.q, (t) => t.raw === r); syncSearch(); }));
  const phHome = $("#ph-home");
  if (phHome) phHome.onclick = (e) => { e.preventDefault(); App.project = "all"; App.q = ""; syncSearch(); };
  const phCsv = $("#ph-csv");
  if (phCsv) phCsv.onclick = () => downloadCsv(list, (pid) => HITS.get(pid));
  const phTidy = $("#ph-tidy");
  if (phTidy) phTidy.onclick = () => (location.hash = "#/tidy");
  const emClear = $("#empty-clear");
  if (emClear) emClear.onclick = () => { App.q = ""; App.project = "all"; syncSearch(); };
  const emNew = $("#empty-new");
  if (emNew) emNew.onclick = () => { const nb = $("#newbtn"); if (nb) nb.click(); };
  const rmp = document.querySelector("[data-rmproj]");
  if (rmp) rmp.onclick = () => { App.project = "all"; renderCatalog(); };
  const clq = $("#clearq");
  if (clq) clq.onclick = () => { App.q = ""; App.project = "all"; syncSearch(); };
  $$("[data-tag]").forEach((el) => (el.onclick = () => { toggleTag(el.dataset.tag); syncSearch(); }));
  // 태그를 두 개 이상 골랐을 때 '모두(AND) / 하나라도(OR)' 를 고른다 — 선택은 저장된다
  $$("[data-tagmode]").forEach((el) => (el.onclick = () => {
    if ((App.prop.tagMode || "and") === el.dataset.tagmode) return;
    App.prop.tagMode = el.dataset.tagmode;
    saveLS();
    renderCatalog();
  }));
  // 자동 태그 칩: 값 토큰(client:"현대자동차" 등)을 넣었다 뺐다 한다
  $$("[data-auto]").forEach((el) => (el.onclick = () => {
    const tok = el.dataset.auto;
    App.q = hasToken(App.q, tok)
      ? withoutToken(App.q, (t) => t.raw === tok)
      : ((App.q || "").trim() ? App.q.trim() + " " : "") + tok;
    syncSearch();
  }));
  const qhelp = $("#qhelp");
  if (qhelp) qhelp.onclick = () => toast(QUERY_HELP, 6500);

  // 저장된 검색: 저장 / 적용 / 이름 변경 / 삭제
  const sfSave = $("#sf-save");
  if (sfSave) sfSave.onclick = async () => {
    const dflt = App.q.trim() || (App.project !== "all" ? App.project : "저장된 검색");
    const name = (await promptDialog({ title: "저장된 검색 이름", value: dflt, ok: "저장" }) || "").trim();
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
    nm.ondblclick = async () => {
      const n = (await promptDialog({ title: "이름 바꾸기", value: f.name, ok: "바꾸기" }) || "").trim();
      if (n && n !== f.name) { f.name = n; saveSmart(); renderCatalog(); }
    };
    el.querySelector(".sf-del").onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirmDialog({ title: "저장된 검색을 지울까요?", body: `'${f.name}'`, ok: "지우기", danger: true }))) return;
      App.smartFolders = (App.smartFolders || []).filter((x) => x.id !== f.id);
      saveSmart(); renderCatalog();
    };
  });
  // ---- 결과 줄(B) 동작: 담기 토글 · 더보기 메뉴 · 정렬 세그먼트
  // 다시 그리면 툴바가 새로 만들어져 초점이 body 로 빠진다 → 원래 있던 자리로 돌려준다
  const refocus = (sel) => { const el = $(sel); if (el) el.focus(); };
  const addAll = (focusSel) => {
    // 화면에 보이는 순서(정렬 포함)대로 담는다 — 제안서 순서가 곧 담은 순서다. filtered()가 HITS 도 다시 채운다
    filtered().forEach((p) => (HITS.get(p.id) || []).forEach((vid) => {
      if (!inCart(p.id, vid)) App.cart.push({ pid: p.id, vid });
    }));
    saveLS(); renderCatalog(); renderCart();
    refocus(focusSel || "#selall");
  };
  const removeAll = (focusSel) => {
    filtered();
    App.cart = App.cart.filter((c) => !(HITS.get(c.pid) || []).includes(c.vid));
    saveLS(); renderCatalog(); renderCart();
    refocus(focusSel || "#selall");
  };
  const btnAll = $("#selall");
  // 결과가 전부 담겨 있으면 같은 버튼이 '빼기'가 된다(같은 대상의 반대 동작이라 토글로 합침)
  if (btnAll) btnAll.onclick = () => (allIn ? removeAll() : addAll());

  async function doSyncAll() {
    if (syncingAll) { toast("동기화 중입니다"); return; }
    if (!(await confirmDialog({ title: "RDP-DB 배합을 모든 시편에 반영할까요?", body: "기존 배합 수치는 DB 값으로 갱신되고, 메모는 유지됩니다.", ok: "반영" }))) return;
    syncingAll = true;
    toast("동기화 중…", 1200);
    try {
      const r = await fetch("/api/rdp/sync-all", { method: "POST" }).then((x) => x.json());
      if (!r || r.ok === false) throw new Error(r && r.error ? r.error : "동기화 실패");
      const fresh = await apiGet("/api/patterns");
      App.patterns = (fresh.patterns || []).map(normalizeDoc);
      renderCatalog();
      toast(`동기화 완료 · ${r.patterns}개 시편 / 추가 ${r.added} · 갱신 ${r.updated}`);
    } catch (e) { toast("동기화 실패: " + e.message); }
    finally { syncingAll = false; }
  }

  const moreBtn = $("#morebtn");
  const moreMenu = $("#moremenu");
  if (moreBtn && moreMenu) {
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      const willOpen = moreMenu.hidden;
      moreMenu.hidden = !willOpen;
      moreBtn.setAttribute("aria-expanded", String(willOpen));
    };
    // 바깥을 누르거나 Esc 면 닫힌다(한 번만 등록)
    if (!document._moreMenuBound) {
      document.addEventListener("click", (e) => {
        const m = document.getElementById("moremenu"), b = document.getElementById("morebtn");
        if (!m || m.hidden) return;
        if (b && (b === e.target || b.contains(e.target))) return;
        if (m.contains(e.target)) return;
        m.hidden = true; if (b) b.setAttribute("aria-expanded", "false");
      });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const m = document.getElementById("moremenu"), b = document.getElementById("morebtn");
        if (m && !m.hidden) { m.hidden = true; if (b) b.setAttribute("aria-expanded", "false"); }
      });
      document._moreMenuBound = true;
    }
    moreMenu.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => {
      moreMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false");
      const act = b.dataset.act;
      if (act === "csv") downloadCsv(list, (pid) => HITS.get(pid));
      else if (act === "none") removeAll("#morebtn");
      else if (act === "help") toast(QUERY_HELP, 6500);
      else if (act === "report") location.hash = "#/report";
      else if (act === "tidy") location.hash = "#/tidy";
      else if (act === "bake") openBakeDialog({ ids: list.map((p) => p.id), total: App.patterns.length });
      else if (act === "plates") location.hash = "#/plates";
      else if (act === "fromwl") openWorklogPicker();
      else if (act === "csvin") openCsvImport(renderCatalog);
      else if (act === "compare") location.hash = "#/compare";
      else if (act === "sync") doSyncAll();
      else if (act === "board") {
        // 좁은 화면에서는 결과 줄의 보드 링크가 숨으므로 메뉴가 유일한 진입로다
        if (App.project === "all") toast("프로젝트를 먼저 고르세요");
        else location.hash = "#/board/" + encodeURIComponent(App.project);
      }
    }));
  }

  // 좁히기 줄 접기/펼치기 (좁은 화면 전용 — CSS 가 760 이하에서만 숨긴다)
  const ftog = $("#filtertoggle");
  if (ftog) ftog.onclick = () => {
    const bar = $("#filterbar");
    const open = !bar.classList.contains("open");
    bar.classList.toggle("open", open);
    ftog.setAttribute("aria-expanded", String(open));
    try { localStorage.setItem("rdp.filtersOpen", open ? "1" : "0"); } catch (e) {}
  };

  // 선택(패턴 단위) · 일괄 편집
  bindPicks(list.map((p) => p.id), renderCatalog);
  // 보기 전환(카드 · 표 · 칸반) + 보기 도구(묶기 · 카드 크기 · 열 · 칸반 끌어 놓기)
  $$('input[name="viewmode"]').forEach((r) => (r.onchange = () => { setView(r.value); renderCatalog(); }));
  const vbody = $("#vbody");
  if (vbody) bindBody(vbody, renderCatalog);
  const bulkBtn = $("#bulk-open");
  if (bulkBtn) bulkBtn.onclick = () => openBulkDialog(renderCatalog, (pid) => HITS.get(pid));
  const cmpSel = $("#sel-compare");
  if (cmpSel) cmpSel.onclick = () => compareFromSelection(list.map((p) => p.id), (pid) => HITS.get(pid));

  // 기준색(사진 대표색) — 카드의 ◎ 를 누르면 그 컬러가 기준이 되고 '색 가까운 순'으로 바뀐다
  bindRate($("#view"));
  paintRefDots();
  $$(".refdot").forEach((el) => (el.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    setRefColor(el.dataset.pid, el.dataset.ref).catch((err) => toast(err.message || "색을 읽지 못했습니다"));
  }));

  // 기준색 칩: 누르면 기준 시편 카드로 이동, × 면 해제하고 최근순으로
  const refGoto = document.querySelector("[data-refgoto]");
  if (refGoto && App.refColor) refGoto.onclick = () => {
    const card = document.querySelector(`.card[data-pid="${CSS.escape(App.refColor.pid)}"]`);
    if (card) card.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const refClear = document.querySelector("[data-refclear]");
  if (refClear) refClear.onclick = () => {
    App.refColor = null; App.de = null; App.sort = "recent";
    renderCatalog();
  };

  // 정렬 세그먼트(라디오) — 화살표 키 이동은 브라우저가 해 준다
  $$('input[name="sort"]').forEach((r) => (r.onchange = () => {
    if (r.value === "color" && !App.refColor) { toast("카드의 ◎를 먼저 눌러 기준색을 잡아 주세요"); return; }
    App.sort = r.value;
    renderCatalog();
    refocus(`input[name="sort"][value="${App.sort}"]`);   // 화살표로 계속 옮길 수 있게 초점 유지
  }));
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
    if (await confirmDialog({ title: "이미 있는 시편입니다", body: `'${id}' 시편이 이미 있습니다.\n기존 시편을 열까요? (지금 작성한 내용은 저장되지 않습니다)`, ok: "기존 시편 열기" })) {
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
    let r = await apiPut(`/api/patterns/${encodeURIComponent(id)}`, payload, exists ? revOf(exists) : "", !exists);
    let saved = markSaved(JSON.parse(JSON.stringify(payload)), r);
    // 저장 전에 고른 사진이 있으면 지금 올린다(사진 먼저 등록). 올린 뒤 이미지 목록만 다시 저장.
    if ((App.newPhotos || []).length) {
      try {
        const n = await flushNewPhotos(saved);
        if (n) {
          const doc2 = JSON.parse(JSON.stringify(saved));
          delete doc2._file; delete doc2._mtime;
          r = await apiPut(`/api/patterns/${encodeURIComponent(id)}`, doc2, revOf(saved));
          saved = markSaved(JSON.parse(JSON.stringify(doc2)), r);
          toast(`사진 ${n}장 함께 저장`);
        }
      } catch (e) { toast("사진 업로드 실패: " + e.message + " — 시편은 저장됐습니다"); }
    }
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
