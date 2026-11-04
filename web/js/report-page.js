/* RDP 시편 아카이브 — 패턴 개발 실적 보고서 (#/report)
 *
 * 연도(·분류·담당자·차종)를 고르면 그 해 개발한 패턴을 '패턴 코드 하나당 하나'로 모아 보여 준다.
 * [보고서 구성]에서 넣을 칸(요약 숫자 · 월별 개발 수 · 통계 · 사진 페이지 · 목록)과 순서,
 * 넣을 항목(담당자 · 제안 차종 · 비고 …)을 고른다 — 이 브라우저에 기억.
 * 칸 제목은 보고서에서 눌러서 고친다. A4 세로 인쇄(사진 페이지는 한 쪽 8개, 사진·목록 칸은 새 쪽에서 시작).
 * 화면은 무채색 모노톤, 포인트 컬러(NIFCO 오렌지)는 제목 아래 가는 줄에만.
 * 개발 시점은 패턴 코드(M-60213-F2 → 2026-02-13)에서 읽는다 — 규칙은 report-rules.js.
 *
 * 되돌리기: main.js 의 #/report 라우트, 목차 ⋯ 메뉴의 '개발 실적 보고서', 이 파일과 report-rules.js 를 지우면 된다.
 */
import { $, $$, App, esc, thumbUrl } from "./core.js";
import { KIND_LABEL, reportOptions, reportRows, summarize } from "./report-rules.js";

/* 보고서 구성 — 넣을 칸과 순서를 고른다(이 브라우저에 기억). 제목 글자도 칸마다 고칠 수 있다. */
const SECTIONS = {
  kpi: { label: "요약 숫자", title: "" },
  monthly: { label: "월별 개발 수", title: "월별 개발 수" },
  stats: { label: "통계 (분류·담당자·차종)", title: "분류 · 담당자 · 제안 차종" },
  cards: { label: "사진 페이지 (2열)", title: "개발 패턴" },
  table: { label: "목록 (엑셀식)", title: "개발 패턴 목록" },
};
const DEFAULT_LAYOUT = [["kpi", true], ["monthly", true], ["stats", true], ["cards", true], ["table", false]];
const LS = { layout: "rdp.reportLayout", titles: "rdp.reportTitles", hidden: "rdp.reportHidden" };

/* 넣을 항목 — 끄면 사진 카드 · 목록 · 요약 숫자 · 통계 어디에서도 빠진다. 패턴 코드는 늘 들어간다. */
const FIELDS = {
  no: "번호", date: "개발일", kind: "분류 (메테리얼·지오메트릭)", cat: "이미지 분류", name: "패턴 이름",
  image: "사진 (목록 표)", developer: "담당자", vehicles: "제안 차종", colors: "베리에이션", remark: "비고",
};
const load = (k, d) => { try { const x = JSON.parse(localStorage.getItem(k)); return x == null ? d : x; } catch (e) { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/** 저장된 구성 — 모르는 칸은 버리고, 새로 생긴 칸은 끝에(꺼진 채로) 붙인다 */
function loadLayout() {
  const saved = (load(LS.layout, null) || []).filter((x) => Array.isArray(x) && SECTIONS[x[0]]);
  const have = new Set(saved.map((x) => x[0]));
  const out = saved.length ? saved : DEFAULT_LAYOUT.map((x) => x.slice());
  DEFAULT_LAYOUT.forEach(([k]) => { if (!have.has(k) && saved.length) out.push([k, false]); });
  return out;
}
const oldList = (() => { try { return localStorage.getItem("rdp.reportListTitle") || ""; } catch (e) { return ""; } })();
const S = { year: null, kind: "", developer: "", vehicle: "", title: "", layout: loadLayout(),
  titles: Object.assign(oldList ? { cards: oldList } : {}, load(LS.titles, {})), panel: false,
  hidden: new Set((load(LS.hidden, []) || []).filter((k) => FIELDS[k])) };
const has = (k) => !S.hidden.has(k);
/** 통계 칸 기본 제목은 켜 둔 항목만 */
const defTitle = (k) => k !== "stats" ? SECTIONS[k].title
  : [has("kind") || has("cat") ? "분류" : "", has("developer") ? "담당자" : "", has("vehicles") ? "제안 차종" : ""].filter(Boolean).join(" · ") || "통계";
const secTitle = (k) => S.titles[k] || defTitle(k);

const pad2 = (n) => String(n).padStart(2, "0");

function barsHTML(byMonth) {
  const max = Math.max(1, ...byMonth);
  return `<div class="rp-bars">${byMonth.map((n, i) => `<div class="rp-bar" title="${i + 1}월 ${n}개">
      <span class="rp-bn">${n || ""}</span><i style="height:${Math.round((n / max) * 100)}%"></i><span class="rp-bm">${i + 1}월</span></div>`).join("")}</div>`;
}

function rankHTML(title, list, limit = 8) {
  if (!list.length) return "";
  const max = Math.max(...list.map((x) => x[1]));
  return `<div class="rp-rank"><h4>${esc(title)}</h4>${list.slice(0, limit).map(([k, n]) => `<div class="rp-ri">
      <span class="k">${esc(k)}</span><span class="b"><i style="width:${Math.round((n / max) * 100)}%"></i></span><span class="n">${n}</span></div>`).join("")}
    ${list.length > limit ? `<div class="rp-more">외 ${list.length - limit}개</div>` : ""}</div>`;
}

/** 카드형 — 사진을 크게(2열), 아래에 하위 정보(켜 둔 항목만) */
const dim = (t) => `<span class="rp-dim">${t}</span>`;
const chips = (r) => r.vehicles.map((v) => `<span class="rp-chip">${esc(v)}</span>`).join("");
const guessed = (r) => r.source && r.source !== "code";

function cardHTML(r, i) {
  const href = `#/p/${encodeURIComponent(r.ids[0])}`;
  const img = r.image ? `<img src="${thumbUrl(r.image.pid, r.image.file, 960)}" alt="${esc(r.code)}">` : `<div class="rp-noimg">사진 없음</div>`;
  const when = r.year ? `${r.year}년 ${r.month ? r.month + "월" : ""}${r.day ? " " + r.day + "일" : ""}` : "개발일 미상";
  const dl = [
    has("developer") && `<dt>담당자</dt><dd>${esc(r.developer) || dim("미입력")}</dd>`,
    has("vehicles") && `<dt>제안 차종</dt><dd>${chips(r) || dim("—")}</dd>`,
    has("colors") && `<dt>베리에이션</dt><dd>${r.colors}개</dd>`,
    has("remark") && r.remark && `<dt>비고</dt><dd>${esc(r.remark)}</dd>`,
  ].filter(Boolean).join("");
  const name = has("name") || (has("cat") && r.cat);
  return `<article class="rp-pc">
      <a class="rp-pc-img" href="${href}">${img}${has("no") ? `<span class="rp-pc-no">${i + 1}</span>` : ""}</a>
      <div class="rp-pc-body">
        <div class="rp-pc-top"><a class="rp-pc-code" href="${href}">${esc(r.code)}</a>
          ${has("kind") && r.kind ? `<span class="rp-pc-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span>` : ""}
          ${has("date") ? `<span class="rp-pc-date">${when}${guessed(r) ? " (추정)" : ""}</span>` : ""}</div>
        ${name ? `<div class="rp-pc-name">${has("name") ? esc(r.name) || dim("패턴 이름 없음") : ""}${has("cat") && r.cat ? `<small>이미지 분류 ${esc(r.cat)}</small>` : ""}</div>` : ""}
        ${dl ? `<dl class="rp-pc-dl">${dl}</dl>` : ""}
      </div>
    </article>`;
}

/** 목록 표 — 켜 둔 항목만 칸으로 [항목, 머리글, class, 값] */
const COLS = [
  ["no", "#", "c-no", (r, i) => i + 1],
  ["date", "개발년도", "c-y", (r) => r.year || "—"],
  ["date", "개발월", "c-m", (r) => (r.month ? r.month + "월" : "—")],
  ["image", "이미지", "c-img", (r, i, href) => `<a href="${href}">${r.image ? `<img src="${thumbUrl(r.image.pid, r.image.file, 240)}" alt="">` : `<div class="rp-noimg">사진 없음</div>`}</a>`],
  ["kind", "분류", "c-k", (r) => (r.kind ? esc(KIND_LABEL[r.kind] || r.kind) : "—")],
  ["name", "패턴이름", "c-name", (r) => `${esc(r.name) || dim("—")}${has("cat") && r.cat ? `<small>분류 ${esc(r.cat)}</small>` : ""}`],
  ["", "패턴코드", "c-code", (r, i, href) => `<a href="${href}">${esc(r.code)}</a>${has("date") && guessed(r) ? `<small title="코드가 개발일 규칙(G/M+숫자 5자리)이 아니어서 ${r.source === "devDate" ? "직접 적은 개발 년월" : "가장 이른 작업일"}로 셌습니다">개발일 추정</small>` : ""}`],
  ["developer", "담당자", "c-dev", (r) => esc(r.developer) || dim("미입력")],
  ["vehicles", "제안차종", "c-veh", (r) => chips(r)],
  ["colors", "베리에이션", "c-n", (r) => `${r.colors}개`],
  ["remark", "비고", "c-note", (r) => esc(r.remark)],
];
const cols = () => COLS.filter(([k]) => !k || has(k));
const rowHTML = (r, i) => {
  const href = `#/p/${encodeURIComponent(r.ids[0])}`;
  return `<tr>${cols().map(([, , c, fn]) => `<td class="${c}">${fn(r, i, href)}</td>`).join("")}</tr>`;
};

/** 칸 제목 — 눌러서 고친다 */
const headHTML = (k, tag = "h3") => `<${tag} class="rp-sec-h" data-sec="${k}" contenteditable="plaintext-only" spellcheck="false" title="눌러서 제목 고치기">${esc(secTitle(k))}</${tag}>`;

const SECTION_HTML = {
  kpi: (rows, sm) => {
    const k = [[sm.total, "개발 패턴"],
      has("vehicles") && [sm.byVehicle.length, "제안 차종"],
      has("colors") && [sm.colors, "베리에이션"],
      has("developer") && [sm.byDeveloper.filter(([d]) => d !== "담당자 미입력").length, "담당자"]].filter(Boolean);
    return `<section class="rp-sec rp-sec-kpi"><div class="rp-kpis" style="--n:${k.length}">${k.map(([n, t]) => `<div><b>${n}</b><span>${t}</span></div>`).join("")}</div></section>`;
  },
  monthly: (rows, sm) => `<section class="rp-sec">${headHTML("monthly", "h4")}<div class="rp-card">${barsHTML(sm.byMonth)}</div></section>`,
  stats: (rows, sm) => {
    const cards = [
      (has("kind") || has("cat")) && `${has("kind") ? rankHTML("분류", sm.byKind) : ""}${has("cat") ? rankHTML("이미지 분류", sm.byCat, 6) : ""}`,
      has("developer") && rankHTML("담당자", sm.byDeveloper),
      has("vehicles") && rankHTML("제안 차종", sm.byVehicle, 10),
    ].filter(Boolean);
    if (!cards.length) return "";
    return `<section class="rp-sec">${headHTML("stats", "h4")}<div class="rp-grid3" style="--n:${cards.length}">${cards.map((c) => `<div class="rp-card">${c}</div>`).join("")}</div></section>`;
  },
  cards: (rows) => `<section class="rp-sec rp-sec-page">${headHTML("cards")}<div class="rp-cards">${rows.map(cardHTML).join("")}</div></section>`,
  table: (rows) => `<section class="rp-sec rp-sec-page">${headHTML("table")}
      <table class="rp-table"><thead><tr>${cols().map(([, t, c]) => `<th class="${c}">${t}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(rowHTML).join("")}</tbody></table></section>`,
};

function paint() {
  const body = $("#rp-body");
  if (!body) return;
  const filter = { year: S.year, kind: S.kind, developer: S.developer, vehicle: S.vehicle };
  const rows = reportRows(App.patterns, filter);
  const sm = summarize(rows);
  const scope = [S.kind && KIND_LABEL[S.kind], S.developer && `담당 ${S.developer}`, S.vehicle && `차종 ${S.vehicle}`].filter(Boolean).join(" · ");
  const title = S.title || `${S.year ? S.year + "년 " : ""}패턴 개발 실적`;
  const today = new Date();
  const on = S.layout.filter(([, v]) => v).map(([k]) => k);
  body.innerHTML = `<div class="rp-doc">
    <header class="rp-head"><h1>${esc(title)}</h1>
      <p>${scope ? esc(scope) + " · " : ""}${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())} 기준</p></header>
    ${!rows.length ? `<p class="rp-empty">조건에 맞는 패턴이 없습니다.</p>`
      : !on.length ? `<p class="rp-empty">보고서 구성에서 넣을 칸을 하나 이상 고르세요.</p>`
      : on.map((k) => SECTION_HTML[k](rows, sm)).join("")}
    ${sm.noDate ? `<p class="rp-warn no-print">개발일을 알 수 없는 패턴 ${sm.noDate}개는 연도 없이 셌습니다 — 패턴 코드 규칙(M-60213-F2)을 쓰거나 편집기에서 '개발 년월'을 적어 주세요.</p>` : ""}
  </div>`;
  bindTitles();
}

/** 보고서 구성 — 칸 켜기/끄기 · 순서 바꾸기 */
function panelHTML() {
  return `<div class="rp-panel no-print" id="rp-panel"${S.panel ? "" : " hidden"}>
    <div class="rp-panel-h">보고서 구성 <small>넣을 칸을 고르고 ↑↓ 로 순서를 바꿔요 · 제목은 보고서에서 눌러서 고쳐요</small>
      <button type="button" class="tool" id="rp-reset">처음 구성으로</button></div>
    <ol class="rp-secs">${S.layout.map(([k, v], i) => `<li class="${v ? "on" : ""}">
      <label><input type="checkbox" data-secon="${k}"${v ? " checked" : ""}> ${esc(SECTIONS[k].label)}</label>
      <span class="rp-mv"><button type="button" class="tool" data-up="${i}" aria-label="${esc(SECTIONS[k].label)} 위로"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="tool" data-down="${i}" aria-label="${esc(SECTIONS[k].label)} 아래로"${i === S.layout.length - 1 ? " disabled" : ""}>↓</button></span></li>`).join("")}</ol>
    <div class="rp-panel-h rp-panel-h2">넣을 항목 <small>끄면 사진 카드 · 목록 · 요약 숫자 · 통계에서 모두 빠져요 · 패턴 코드는 늘 들어가요</small></div>
    <div class="rp-fields">${Object.entries(FIELDS).map(([k, t]) => `<label class="${has(k) ? "on" : ""}"><input type="checkbox" data-field="${k}"${has(k) ? " checked" : ""}> ${esc(t)}</label>`).join("")}</div>
  </div>`;
}

function repaintPanel() {
  const p = $("#rp-panel");
  if (!p) return;
  p.outerHTML = panelHTML();
  bindPanel();
}

function bindPanel() {
  const p = $("#rp-panel");
  if (!p) return;
  const save = () => { keep(LS.layout, S.layout); repaintPanel(); paint(); };
  $$("[data-secon]", p).forEach((c) => (c.onchange = () => { S.layout.find((x) => x[0] === c.dataset.secon)[1] = c.checked; save(); }));
  const swap = (i, j) => { [S.layout[i], S.layout[j]] = [S.layout[j], S.layout[i]]; save(); };
  $$("[data-up]", p).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.up); if (i > 0) swap(i, i - 1); }));
  $$("[data-down]", p).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.down); if (i < S.layout.length - 1) swap(i, i + 1); }));
  $$("[data-field]", p).forEach((c) => (c.onchange = () => {
    if (c.checked) S.hidden.delete(c.dataset.field); else S.hidden.add(c.dataset.field);
    keep(LS.hidden, [...S.hidden]); save();
  }));
  $("#rp-reset", p).onclick = () => { S.layout = DEFAULT_LAYOUT.map((x) => x.slice()); S.hidden.clear(); keep(LS.hidden, []); save(); };
}

/** 칸 제목을 그 자리에서 고친다 — Enter 로 끝, 이 브라우저에 기억 */
function bindTitles() {
  $$(".rp-sec-h").forEach((h) => {
    h.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); h.blur(); } };
    h.onblur = () => {
      const k = h.dataset.sec;
      const v = h.textContent.replace(/\s+/g, " ").trim();
      if (!v || v === defTitle(k)) delete S.titles[k]; else S.titles[k] = v;
      h.textContent = secTitle(k);
      keep(LS.titles, S.titles);
    };
  });
}

export function renderReport() {
  document.body.classList.remove("prop-mode");
  document.body.classList.add("report-mode");
  const opt = reportOptions(App.patterns);
  if (S.year == null || (S.year && !opt.years.includes(S.year))) S.year = opt.years[0] || "";
  const sel = (id, label, cur, list, fmt = (x) => x) => `<label>${label}<select id="${id}"><option value="">전체</option>${list.map((x) =>
    `<option value="${esc(x)}"${String(x) === String(cur) ? " selected" : ""}>${esc(fmt(x))}</option>`).join("")}</select></label>`;
  $("#view").innerHTML = `<div class="wrap report-page">
      <div class="rp-tools no-print">
        <h2>개발 실적 보고서</h2>
        ${sel("rp-year", "연도", S.year, opt.years, (y) => y + "년")}
        ${sel("rp-kind", "분류", S.kind, ["G", "M"], (k) => KIND_LABEL[k])}
        ${sel("rp-dev", "담당자", S.developer, opt.developers)}
        ${sel("rp-veh", "제안 차종", S.vehicle, opt.vehicles)}
        <button type="button" class="tool" id="rp-cfg" aria-expanded="${S.panel}">보고서 구성 ▾</button>
        <input id="rp-title" placeholder="보고서 제목 (비우면 자동)" value="${esc(S.title)}">
        <button type="button" class="btn-dark" id="rp-print">PDF 로 저장 · 인쇄</button>
      </div>
      ${panelHTML()}
      <p class="rp-hint no-print">인쇄 창에서 <b>대상: PDF 로 저장 · 용지 A4 세로 · 배경 그래픽 켜기</b>. 개발일은 패턴 코드(M-60213-F2 → 2026년 2월 13일)에서 읽습니다.</p>
      <div id="rp-body"></div>
    </div>`;
  const on = (id, fn) => { const el = $(id); if (el) el.oninput = el.onchange = fn; };
  on("#rp-year", (e) => { S.year = e.target.value ? Number(e.target.value) : ""; paint(); });
  on("#rp-kind", (e) => { S.kind = e.target.value; paint(); });
  on("#rp-dev", (e) => { S.developer = e.target.value; paint(); });
  on("#rp-veh", (e) => { S.vehicle = e.target.value; paint(); });
  on("#rp-title", (e) => { S.title = e.target.value; paint(); });
  $("#rp-cfg").onclick = () => {
    S.panel = !S.panel;
    $("#rp-cfg").setAttribute("aria-expanded", String(S.panel));
    $("#rp-panel").hidden = !S.panel;
  };
  bindPanel();
  $("#rp-print").onclick = () => {
    const imgs = $$("#rp-body img");     // 사진이 다 뜬 뒤에 인쇄해야 PDF 에 빈칸이 안 생긴다
    imgs.forEach((im) => { im.loading = "eager"; });
    Promise.all(imgs.map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })))).then(() => window.print());
  };
  paint();
}
