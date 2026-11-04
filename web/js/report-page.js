/* RDP 시편 아카이브 — 패턴 개발 실적 보고서 (#/report)
 *
 * 연도(·분류·담당자·차종)를 고르면 그 해 개발한 패턴을 '패턴 코드 하나당 한 줄'로 모아
 *   1쪽: 요약(개발 수 · 월별 막대 · 분류 · 담당자 · 제안 차종)
 *   2쪽~: 개발 리스트 — 엑셀 양식 그대로(개발년도·개발월·이미지·분류·패턴이름·패턴코드·담당자·제안차종·비고)
 * 를 A4 세로로 보여 준다(사진 2열 · 한 쪽 8개). [PDF 로 저장]은 브라우저 인쇄(대상: PDF 로 저장)를 연다.
 * 개발 시점은 패턴 코드(M-60213-F2 → 2026-02-13)에서 읽는다 — 규칙은 report-rules.js.
 *
 * 되돌리기: main.js 의 #/report 라우트, 목차 ⋯ 메뉴의 '개발 실적 보고서', 이 파일과 report-rules.js 를 지우면 된다.
 */
import { $, $$, App, esc, thumbUrl } from "./core.js";
import { KIND_LABEL, reportOptions, reportRows, summarize } from "./report-rules.js";

const S = { year: null, kind: "", developer: "", vehicle: "", title: "", layout: "cards" };   // layout: cards(사진 2열) | table(엑셀식)

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

/** 카드형 — 사진을 크게(2열), 아래에 하위 정보 */
function cardHTML(r, i) {
  const href = `#/p/${encodeURIComponent(r.ids[0])}`;
  const img = r.image ? `<img src="${thumbUrl(r.image.pid, r.image.file, 960)}" alt="${esc(r.code)}">` : `<div class="rp-noimg">사진 없음</div>`;
  const when = r.year ? `${r.year}년 ${r.month ? r.month + "월" : ""}${r.day ? " " + r.day + "일" : ""}` : "개발일 미상";
  return `<article class="rp-pc">
      <a class="rp-pc-img" href="${href}">${img}<span class="rp-pc-no">${i + 1}</span></a>
      <div class="rp-pc-body">
        <div class="rp-pc-top"><a class="rp-pc-code" href="${href}">${esc(r.code)}</a>
          ${r.kind ? `<span class="rp-pc-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span>` : ""}
          <span class="rp-pc-date">${when}${r.source && r.source !== "code" ? " (추정)" : ""}</span></div>
        <div class="rp-pc-name">${esc(r.name) || '<span class="rp-dim">패턴 이름 없음</span>'}${r.cat ? `<small>이미지 분류 ${esc(r.cat)}</small>` : ""}</div>
        <dl class="rp-pc-dl">
          <dt>담당자</dt><dd>${esc(r.developer) || '<span class="rp-dim">미입력</span>'}</dd>
          <dt>제안 차종</dt><dd>${r.vehicles.map((v) => `<span class="rp-chip">${esc(v)}</span>`).join("") || '<span class="rp-dim">—</span>'}</dd>
          <dt>베리에이션</dt><dd>${r.colors}개</dd>
          ${r.remark ? `<dt>비고</dt><dd>${esc(r.remark)}</dd>` : ""}
        </dl>
      </div>
    </article>`;
}

function rowHTML(r, i) {
  const img = r.image ? `<img src="${thumbUrl(r.image.pid, r.image.file, 240)}" alt="">` : `<div class="rp-noimg">사진 없음</div>`;
  const href = `#/p/${encodeURIComponent(r.ids[0])}`;
  return `<tr>
      <td class="c-no">${i + 1}</td>
      <td class="c-y">${r.year || "—"}</td><td class="c-m">${r.month ? r.month + "월" : "—"}</td>
      <td class="c-img"><a href="${href}">${img}</a></td>
      <td class="c-k">${r.kind ? esc(KIND_LABEL[r.kind] || r.kind) : "—"}</td>
      <td class="c-name">${esc(r.name) || '<span class="rp-dim">—</span>'}${r.cat ? `<small>분류 ${esc(r.cat)}</small>` : ""}</td>
      <td class="c-code"><a href="${href}">${esc(r.code)}</a>${r.source && r.source !== "code" ? `<small title="코드가 개발일 규칙(G/M+숫자 5자리)이 아니어서 ${r.source === "devDate" ? "직접 적은 개발 년월" : "가장 이른 작업일"}로 셌습니다">개발일 추정</small>` : ""}</td>
      <td class="c-dev">${esc(r.developer) || '<span class="rp-dim">미입력</span>'}</td>
      <td class="c-veh">${r.vehicles.map((v) => `<span class="rp-chip">${esc(v)}</span>`).join("")}</td>
      <td class="c-note">${esc(r.remark)}</td>
    </tr>`;
}

function paint() {
  const body = $("#rp-body");
  if (!body) return;
  const filter = { year: S.year, kind: S.kind, developer: S.developer, vehicle: S.vehicle };
  const rows = reportRows(App.patterns, filter);
  const sm = summarize(rows);
  const scope = [S.kind && KIND_LABEL[S.kind], S.developer && `담당 ${S.developer}`, S.vehicle && `차종 ${S.vehicle}`].filter(Boolean).join(" · ");
  const title = S.title || `${S.year ? S.year + "년 " : ""}패턴 개발 실적`;
  const today = new Date();
  body.innerHTML = `
    <section class="rp-page rp-cover">
      <header class="rp-head"><div><h1>${esc(title)}</h1>
        <p>${scope ? esc(scope) + " · " : ""}${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())} 기준</p></div>
        <div class="rp-kpis">
          <div><b>${sm.total}</b><span>개발 패턴</span></div>
          <div><b>${sm.byVehicle.length}</b><span>제안 차종</span></div>
          <div><b>${sm.colors}</b><span>베리에이션</span></div>
        </div></header>
      ${rows.length ? `<div class="rp-grid">
        <div class="rp-card rp-wide"><h4>월별 개발 수</h4>${barsHTML(sm.byMonth)}</div>
        <div class="rp-card">${rankHTML("분류", sm.byKind)}${rankHTML("이미지 분류", sm.byCat, 6)}</div>
        <div class="rp-card">${rankHTML("담당자", sm.byDeveloper)}</div>
        <div class="rp-card">${rankHTML("제안 차종", sm.byVehicle, 10)}</div>
      </div>` : `<p class="rp-empty">조건에 맞는 패턴이 없습니다.</p>`}
      ${sm.noDate ? `<p class="rp-warn no-print">개발일을 알 수 없는 패턴 ${sm.noDate}개는 연도 없이 셌습니다 — 패턴 코드 규칙(M-60213-F2)을 쓰거나 편집기에서 '개발 년월'을 적어 주세요.</p>` : ""}
    </section>
    ${rows.length ? `<section class="rp-page rp-list">
      <h3>개발 패턴</h3>
      ${S.layout === "table"
        ? `<table class="rp-table"><thead><tr><th class="c-no">#</th><th>개발년도</th><th>개발월</th><th>이미지</th><th>분류</th><th>패턴이름</th><th>패턴코드</th><th>담당자</th><th>제안차종</th><th>비고</th></tr></thead>
        <tbody>${rows.map(rowHTML).join("")}</tbody></table>`
        : `<div class="rp-cards">${rows.map(cardHTML).join("")}</div>`}
    </section>` : ""}`;
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
        <div class="seg" role="radiogroup" aria-label="배치">${[["cards", "사진 2열"], ["table", "목록(엑셀식)"]].map(([k, l]) =>
          `<label class="segbtn${S.layout === k ? " on" : ""}"><input type="radio" name="rp-layout" value="${k}"${S.layout === k ? " checked" : ""}>${l}</label>`).join("")}</div>
        <input id="rp-title" placeholder="보고서 제목 (비우면 자동)" value="${esc(S.title)}">
        <button type="button" class="btn-dark" id="rp-print">PDF 로 저장 · 인쇄</button>
      </div>
      <p class="rp-hint no-print">인쇄 창에서 <b>대상: PDF 로 저장 · 용지 A4 세로 · 배경 그래픽 켜기</b>. 개발일은 패턴 코드(M-60213-F2 → 2026년 2월 13일)에서 읽습니다.</p>
      <div id="rp-body"></div>
    </div>`;
  const on = (id, fn) => { const el = $(id); if (el) el.oninput = el.onchange = fn; };
  on("#rp-year", (e) => { S.year = e.target.value ? Number(e.target.value) : ""; paint(); });
  on("#rp-kind", (e) => { S.kind = e.target.value; paint(); });
  on("#rp-dev", (e) => { S.developer = e.target.value; paint(); });
  on("#rp-veh", (e) => { S.vehicle = e.target.value; paint(); });
  on("#rp-title", (e) => { S.title = e.target.value; paint(); });
  $$('input[name="rp-layout"]').forEach((r) => (r.onchange = () => {
    S.layout = r.value;
    $$('input[name="rp-layout"]').forEach((x) => x.closest(".segbtn").classList.toggle("on", x.checked));
    paint();
  }));
  $("#rp-print").onclick = () => {
    const imgs = $$("#rp-body img");     // 사진이 다 뜬 뒤에 인쇄해야 PDF 에 빈칸이 안 생긴다
    imgs.forEach((im) => { im.loading = "eager"; });
    Promise.all(imgs.map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })))).then(() => window.print());
  };
  paint();
}
