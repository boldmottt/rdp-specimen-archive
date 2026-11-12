/* RDP 시편 아카이브 — 연출 보기: 테이블 위에 놓인 샘플 묶음
 *
 * 기본 보기(카드 · 표 · 칸반)와 같은 목록 · 같은 왼쪽 거르기를 쓰고, 보여 주는 방식만 다르다.
 *  · 패턴 하나 = 컬러 칩을 겹쳐 쌓은 묶음 + 종이 이름표. 묶기를 고르면 구역 이름표가 놓인다.
 *  · 묶음에 마우스를 올리면 컬러가 아래로 펼쳐지고, 올린 칩은 온전히 보인다(아래 칩이 비켜 준다).
 *  · 칩을 누르면 집어 든다 — 가운데만 또렷하고 같은 패턴의 다른 컬러가 양옆에 물러나 있다. 옆에 정보창.
 *  · 처음 들어올 때 한 번, 묶음이 가운데 한 더미에서 날아와 자리 잡는다(누르면 건너뜀 · '동작 줄이기'면 없음).
 * 배치 계산은 show-rules.js (node 테스트). 보기 설정은 이 브라우저(localStorage)에만 둔다.
 *
 * 되돌리기: catalog.js 의 SHOW · showHTML · bindShow 자리, main.js 의 #showseg, index.html 의 #showseg,
 *           styles.css 의 '연출 보기' 블록과 이 파일 · show-rules.js 를 지우면 된다.
 */
import { $, $$, App, byId, esc, fmtDate, imgUrl, inCart, layers, thumbUrl, toast, toggleCart, vName } from "./core.js";
import { renderCart } from "./proposal.js";
import { GROUPS, GROUP, groupRows } from "./table-rules.js";
import { rateHTML, bindRate } from "./rating.js";
import { workOf } from "./work.js";
import {
  CHIP, FAN, GRID, VIEW3D, SIZES, orderVars, fanSlots, restLayout, fanLayout, columnsFor, layoutGroups, maxScroll, rowVisible, flowSlots, loupeZoom,
} from "./show-rules.js";

const LS = { on: "rdp.show", tone: "rdp.showTone", size: "rdp.showSize", group: "rdp.showGroup" };
const load = (k, d) => { try { const x = JSON.parse(localStorage.getItem(k)); return x == null ? d : x; } catch (e) { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const TONES = [["light", "밝게", "#cbc8c2"], ["mid", "회색", "#808080"], ["dark", "어둡게", "#2a2a2b"]];

export const SHOW = {
  on: !!load(LS.on, false),
  tone: load(LS.tone, "light"),               // 테이블 색 — 색은 주변 밝기에 따라 달라 보여서 바꿔 볼 수 있게
  size: load(LS.size, "m"),                   // "s" | "m" | "l"
  group: load(LS.group, ""),                  // 묶기(구역) — table-rules.js GROUPS 의 key
};
export function setShow(on) { SHOW.on = !!on; keep(LS.on, SHOW.on); }

/** 위 막대의 [기본 보기 | 연출 보기] 를 지금 상태로 칠한다 */
export function paintShowSeg() {
  $$('#showseg input[name="showmode"]').forEach((r) => {
    const on = (r.value === "1") === SHOW.on;
    r.checked = on;
    r.closest(".segbtn").classList.toggle("on", on);
  });
}

/* ---------------- 도구 줄 ---------------- */
export const showHintHTML = () => `<span class="sh-hint">묶음에 마우스를 올리면 컬러가 펼쳐져요 · 칩을 누르면 집어 들어요</span>`;
export function showToolsHTML() {
  return `<label class="sh-group">묶기 <select id="sh-group"><option value="">없음</option>${GROUPS.map((g) =>
      `<option value="${g.key}"${SHOW.group === g.key ? " selected" : ""}>${esc(g.label)}</option>`).join("")}</select></label>
    <div class="sh-tone" role="radiogroup" aria-label="테이블 색"><span>테이블</span>${TONES.map(([k, l, c]) =>
      `<button type="button" role="radio" aria-checked="${SHOW.tone === k}" class="${SHOW.tone === k ? "on" : ""}" data-tone="${k}" title="테이블 ${l} — 색은 주변 밝기에 따라 달라 보여요" aria-label="테이블 ${l}" style="background:${c}"></button>`).join("")}</div>
    <div class="seg sh-size" role="radiogroup" aria-label="묶음 크기">${[["s", "작게"], ["m", "보통"], ["l", "크게"]].map(([k, l]) =>
      `<label class="segbtn${SHOW.size === k ? " on" : ""}"><input type="radio" name="shsize" value="${k}"${SHOW.size === k ? " checked" : ""}>${l}</label>`).join("")}</div>`;
}

/** 목차 본문 자리에 들어갈 뼈대 — 묶음은 화면 폭을 재야 놓을 수 있어서 bindShow 가 채운다 */
export function showHTML() {
  return `<div class="sh-scene tone-${esc(SHOW.tone)}" id="sh-scene"><div class="sh-plane" id="sh-plane"></div></div><div class="sh-spacer" id="sh-spacer"></div>`;
}

/* ---------------- 묶음 ---------------- */
const stripCode = (v) => (v.colorName && v.colorCode ? v.colorCode : "");
function chipHTML(p, v, k) {
  const img = v.images && v.images[0];
  const media = img
    ? `<img loading="lazy" draggable="false" src="${esc(thumbUrl(p.id, img, 480))}" data-full="${esc(imgUrl(p.id, img))}" onerror="this.onerror=null;this.src=this.dataset.full" alt="">`
    : `<span class="sh-none">사진 없음</span>`;
  const inn = inCart(p.id, v.id);
  return `<div class="sh-chip${inn ? " in" : ""}" role="button" tabindex="${k ? -1 : 0}" data-k="${k}" data-vid="${esc(v.id)}" style="z-index:${40 - k}"
      aria-label="${esc(p.pattern.code)} ${esc(vName(v))} — 눌러서 집어 들기">${media}
      <span class="sh-strip"><b>${esc(vName(v))}</b><code>${esc(stripCode(v))}</code></span>
      <span class="sh-acts"><button type="button" data-act="pick" tabindex="-1">⤢ 집어 들기</button><button type="button" class="pri" data-act="cart" tabindex="-1" aria-pressed="${inn}">${inn ? "✓ 담김" : "＋ 담기"}</button></span></div>`;
}

function tagHTML(p, vars, total) {
  const top = vars[0] || {};
  const nm = [p.pattern.name && p.pattern.name !== p.pattern.code ? p.pattern.name : "", p.pattern.nameKo].filter(Boolean).join(" ");
  const line = [App.project === "all" ? p.project : "", nm].filter(Boolean).join(" · ");
  const count = vars.length < total ? `${vars.length} / ${total}색` : `${total}색`;
  const mk = [top.rating ? `<span class="st">★ ${Number(top.rating)}</span>` : "", top.flag ? `<span class="fl">⚑</span>` : ""].join("");
  const inN = vars.filter((v) => inCart(p.id, v.id)).length;
  return `<div class="sh-tag"><i>${count}</i><code>${esc(p.pattern.code)}</code><span>${esc(line)}</span>
      <div class="mk">${mk}</div><div class="stamp"${inN ? "" : " hidden"}>담김${inN > 1 ? " " + inN : ""}</div></div>`;
}

function stackHTML(p, vars, total, cell, k, flip) {
  const { shown, more } = fanSlots(vars.length);
  const chips = vars.slice(0, shown).map((v, i) => chipHTML(p, v, i)).join("")
    + (more ? `<div class="sh-chip sh-more" role="button" tabindex="-1" data-k="${shown}" data-more="${shown}" style="z-index:${40 - shown}" aria-label="나머지 ${more}색 보기"><span class="sh-moretxt"><b>+${more}색 더</b>눌러서 모두 넘겨 보기</span></div>` : "");
  const rot = ((cell.i * 37) % 7 - 3) * 0.55;       // 묶음마다 조금씩 삐뚤게(늘 같은 값 — 다시 그려도 흔들리지 않게)
  return `<div class="sh-stack" data-pid="${esc(p.id)}" data-flip="${flip ? 1 : 0}" style="left:${cell.x}px;--r:${rot.toFixed(2)}deg;--u:${k}">
      <div class="sh-pile">${chips}</div>${tagHTML(p, vars, total)}</div>`;
}

/** 칩들의 자리를 CSS 변수로 적는다(움직임은 CSS transition) */
function place(stack, lay) {
  $$(".sh-chip", stack).forEach((c, i) => {
    const l = lay[i] || lay[lay.length - 1];
    c.style.setProperty("--x", l.x + "px");
    c.style.setProperty("--y", l.y + "px");
    c.style.setProperty("--a", l.rot.toFixed(2) + "deg");
  });
}
const chipCount = (stack) => stack.querySelectorAll(".sh-chip").length;
const rest = (stack) => place(stack, restLayout(chipCount(stack), stack.dataset.flip === "1"));

let cleanup = null;          // 지난번에 건 창 이벤트 떼기
let introDone = false;       // 이번에 연 창에서 등장 움직임을 이미 봤는가
try { introDone = sessionStorage.getItem("rdp.showIntro") === "1"; } catch (e) {}

/**
 * 뼈대(showHTML)에 묶음을 놓고 움직임을 붙인다.
 * ctx: { list, hitsOf(pid), topOf(pid) → 맨 위에 보일 컬러 id | null, rerender(), onCart() }
 */
export function bindShow(root, ctx) {
  if (cleanup) cleanup();
  const scene = $("#sh-scene", root), plane = $("#sh-plane", root), spacer = $("#sh-spacer", root);
  if (!scene || !plane) return;
  const head = document.querySelector(".topbar");
  const k = SIZES[SHOW.size] || 1;
  const VARS = new Map();     // pid → 묶음에 보이는 컬러(순서대로)
  let rowsMeta = [], maxSy = 0, sceneH = 0, open = null, openT = 0, closeT = 0, touch = false;

  function build() {
    const topH = head ? Math.round(head.getBoundingClientRect().height) : 56;
    document.body.style.setProperty("--sh-top", topH + "px");
    const W = window.innerWidth;
    sceneH = Math.max(320, window.innerHeight - topH);
    const side = $("#filterbar");
    const sr = side && getComputedStyle(side).position === "fixed" && getComputedStyle(side).display !== "none" && W > 1080 ? side.getBoundingClientRect() : null;
    const freeL = sr ? sr.right + 24 : 12, freeW = Math.max(240, W - freeL - 24);
    scene.style.setProperty("--cx", (freeL + freeW / 2) + "px");
    const cols = columnsFor(freeW, sceneH, k);
    const rows = ctx.list.map((p) => {
      const hits = ctx.hitsOf(p.id);
      const vars = orderVars(p.variations || [], hits, ctx.topOf(p.id));
      VARS.set(p.id, vars);
      return { p, v: vars[0] || {} };
    }).filter((r) => VARS.get(r.p.id).length);
    const groups = SHOW.group && GROUP[SHOW.group]
      ? groupRows(rows, SHOW.group).map((g) => ({ label: g.label, items: g.rows.map((r) => r.p) }))
      : [{ label: "", items: rows.map((r) => r.p) }];
    const lay = layoutGroups(groups, cols, k);
    rowsMeta = lay.rows.map((r) => r.y);
    plane.innerHTML = lay.rows.map((r, ri) => `<div class="sh-row" data-row="${ri}" style="top:${r.y}px">${
      r.zone ? `<div class="sh-zone" style="left:${r.cells[0].x - 4}px;top:${-GRID.zoneH * k + 2}px">${esc(r.zone)}</div>` : ""}${
      r.cells.map((c) => stackHTML(c.item, VARS.get(c.item.id), (c.item.variations || []).length, c, k, c.i % 2)).join("")}</div>`).join("");
    $$(".sh-stack", plane).forEach(rest);
    maxSy = maxScroll(lay.height + GRID.tagH * k, sceneH);
    spacer.style.height = (sceneH + maxSy) + "px";
    onScroll();
  }

  function onScroll() {
    if (!plane.isConnected) { if (cleanup) cleanup(); return; }
    const sy = Math.max(0, Math.min(maxSy, window.scrollY));
    plane.style.setProperty("--sy", sy);
    $$(".sh-row", plane).forEach((el, i) => { el.hidden = !rowVisible(rowsMeta[i], sy, sceneH, k); });
  }
  let rz = 0;
  const onResize = () => { clearTimeout(rz); rz = setTimeout(() => { if (!plane.isConnected) { if (cleanup) cleanup(); return; } closeFan(); build(); }, 150); };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  const onDocDown = (e) => { if (open && !open.contains(e.target)) closeFan(); };
  document.addEventListener("pointerdown", onDocDown);
  cleanup = () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("pointerdown", onDocDown);
    clearTimeout(openT); clearTimeout(closeT); clearTimeout(rz);
    cleanup = null;
  };

  /* ---- 펼치기 ---- */
  function setHot(stack, hot) {
    const n = chipCount(stack);
    const h = Math.max(0, Math.min(n - 1, hot));
    stack.dataset.hot = h;
    $$(".sh-chip", stack).forEach((c, i) => c.classList.toggle("hot", i === h));
    place(stack, fanLayout(n, h));
  }
  function openFan(stack, hot) {
    if (open && open !== stack) closeFan();
    open = stack;
    stack.classList.add("open");
    stack.parentElement.classList.add("has-open");
    setHot(stack, hot || 0);
  }
  function closeFan() {
    clearTimeout(openT); clearTimeout(closeT);
    if (!open) return;
    open.classList.remove("open");
    open.parentElement.classList.remove("has-open");
    $$(".sh-chip", open).forEach((c) => c.classList.remove("hot"));
    delete open.dataset.hot;
    rest(open);
    open = null;
  }
  const chipIndex = (el) => { const c = el && el.closest && el.closest(".sh-chip"); return c ? Number(c.dataset.k) : -1; };

  plane.addEventListener("pointerdown", (e) => { touch = e.pointerType === "touch" || e.pointerType === "pen"; });
  plane.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || plane.classList.contains("intro-run")) return;
    const stack = e.target.closest(".sh-stack");
    if (!stack) return;
    clearTimeout(closeT);
    const ci = chipIndex(e.target);
    if (stack === open) { if (ci >= 0 && ci !== Number(stack.dataset.hot)) setHot(stack, ci); return; }
    clearTimeout(openT);
    // 지나가기만 해도 여기저기 펼쳐지면 정신없다 → 잠깐 머물렀을 때만
    openT = setTimeout(() => openFan(stack, Math.max(0, ci)), open ? 60 : 170);
  });
  plane.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse") return;
    const stack = e.target.closest(".sh-stack");
    if (!stack || stack.contains(e.relatedTarget)) return;
    clearTimeout(openT);
    if (stack === open) closeT = setTimeout(closeFan, 160);
  });
  plane.addEventListener("click", (e) => {
    const stack = e.target.closest(".sh-stack");
    if (!stack) return;
    const p = byId(stack.dataset.pid), vars = VARS.get(stack.dataset.pid) || [];
    const chip = e.target.closest(".sh-chip");
    if (!p || !chip) return;
    const act = e.target.closest("[data-act]");
    const ci = Number(chip.dataset.k);
    if (act && act.dataset.act === "cart") { e.stopPropagation(); cart(p, vars[ci], stack); return; }
    // 손가락에는 '올리기'가 없다 → 첫 탭은 펼치기, 펼친 뒤 고른 칩을 한 번 더 누르면 집어 들기
    if (touch && !act) {
      if (stack !== open) { openFan(stack, ci); return; }
      if (ci !== Number(stack.dataset.hot)) { setHot(stack, ci); return; }
    }
    openPick(p, vars, chip.dataset.more != null ? Number(chip.dataset.more) : ci, ctx);
  });
  plane.addEventListener("focusin", (e) => {
    const stack = e.target.closest(".sh-stack"), ci = chipIndex(e.target);
    if (!stack || ci < 0 || touch) return;
    if (stack !== open) openFan(stack, ci); else setHot(stack, ci);
  });
  plane.addEventListener("focusout", (e) => {
    const stack = e.target.closest(".sh-stack");
    if (stack && stack === open && !stack.contains(e.relatedTarget)) closeT = setTimeout(closeFan, 120);
  });
  plane.addEventListener("keydown", (e) => {
    const chip = e.target.closest(".sh-chip");
    if (!chip || e.target !== chip) return;
    const stack = chip.closest(".sh-stack"), ci = Number(chip.dataset.k);
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chip.click(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = $$(".sh-chip", stack)[ci + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    }
    if (e.key === "c" || e.key === "C") { const p = byId(stack.dataset.pid), v = (VARS.get(stack.dataset.pid) || [])[ci]; if (p && v) cart(p, v, stack); }
    if (e.key === "Escape" && open) { e.preventDefault(); closeFan(); chip.blur(); }
  });

  function cart(p, v, stack) {
    if (!v) return;
    toggleCart(p.id, v.id);
    renderCart();
    paintCart(stack, p, VARS.get(p.id) || []);
    toast(inCart(p.id, v.id) ? `${vName(v)} — 제안서에 담았어요` : `${vName(v)} — 제안서에서 뺐어요`, 1500);
    if (ctx.onCart) ctx.onCart();
  }

  /* ---- 도구 줄 ---- */
  const grp = $("#sh-group");
  if (grp) grp.onchange = () => { SHOW.group = grp.value; keep(LS.group, SHOW.group); window.scrollTo(0, 0); ctx.rerender(); };
  $$("[data-tone]").forEach((b) => (b.onclick = () => {
    SHOW.tone = b.dataset.tone; keep(LS.tone, SHOW.tone);
    scene.className = `sh-scene tone-${SHOW.tone}`;
    document.body.dataset.shTone = SHOW.tone;
    $$("[data-tone]").forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-checked", String(on)); });
  }));
  $$('input[name="shsize"]').forEach((r) => (r.onchange = () => { SHOW.size = r.value; keep(LS.size, SHOW.size); ctx.rerender(); }));
  document.body.dataset.shTone = SHOW.tone;

  build();
  intro(plane, k);
}

/** 묶음의 '담김' 표시를 지금 제안서 상태로 */
function paintCart(stack, p, vars) {
  $$(".sh-chip[data-vid]", stack).forEach((c) => {
    const inn = inCart(p.id, c.dataset.vid);
    c.classList.toggle("in", inn);
    const b = c.querySelector('[data-act="cart"]');
    if (b) { b.textContent = inn ? "✓ 담김" : "＋ 담기"; b.setAttribute("aria-pressed", String(inn)); }
  });
  const n = vars.filter((v) => inCart(p.id, v.id)).length, st = stack.querySelector(".stamp");
  if (st) { st.hidden = !n; st.textContent = "담김" + (n > 1 ? " " + n : ""); }
}

/* ---------------- 등장: 한 더미에서 날아와 자리 잡기 ---------------- */
function intro(plane, k) {
  if (introDone) return;
  introDone = true;
  try { sessionStorage.setItem("rdp.showIntro", "1"); } catch (e) {}
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const stacks = $$(".sh-row:not([hidden]) .sh-stack", plane);
  if (!stacks.length) return;
  const pileY = Math.max(0, window.scrollY) + 140;     // 화면 가운데쯤(평면 좌표)
  stacks.forEach((s, i) => {
    const x = parseFloat(s.style.left) || 0, y = parseFloat(s.parentElement.style.top) || 0;
    s.style.setProperty("--ix", (-x - (CHIP.w * k) / 2) + "px");
    s.style.setProperty("--iy", (pileY - y) + "px");
    s.style.setProperty("--ir", (((i * 53) % 11) - 5) * 6 + "deg");
    s.style.setProperty("--idl", Math.min(i, 24) * 34 + "ms");
  });
  plane.classList.add("intro");
  const end = () => { plane.classList.remove("intro", "intro-run"); document.removeEventListener("pointerdown", end, true); };
  // 두 프레임 뒤에 풀어야 '모여 있는 상태'가 먼저 그려지고, 거기서부터 움직인다
  requestAnimationFrame(() => requestAnimationFrame(() => {
    plane.classList.add("intro-run");
    plane.classList.remove("intro");
    setTimeout(end, 1700);
  }));
  document.addEventListener("pointerdown", end, true);      // 아무 데나 누르면 건너뛴다
}

/* ---------------- 집어 들기 ---------------- */
let PK = null;        // { p, vars, i, changed, ctx }
function pickDialog() {
  let d = $("#sh-pick");
  if (d) return d;
  d = document.createElement("dialog");
  d.id = "sh-pick";
  d.className = "sh-pick";
  d.setAttribute("aria-label", "컬러 크게 보기");
  document.body.appendChild(d);
  d.addEventListener("close", () => {
    document.body.classList.remove("sh-picking");
    const pk = PK;
    PK = null;
    d.innerHTML = "";
    if (pk && pk.changed && pk.ctx && pk.ctx.rerender && SHOW.on && (!location.hash || location.hash === "#")) pk.ctx.rerender();
  });
  d.addEventListener("click", (e) => { if (e.target === d || e.target.classList.contains("pk-wrap")) d.close(); });
  d.addEventListener("keydown", (e) => {
    if (!PK || e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); go(PK.i - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); go(PK.i + 1); }
  });
  return d;
}

function go(i) {
  if (!PK || i < 0 || i >= PK.vars.length || i === PK.i) return;
  PK.i = i;
  paintPick();
}

const fullOf = (p, v) => (v.images && v.images[0] ? imgUrl(p.id, v.images[0]) : "");

function openPick(p, vars, i, ctx) {
  if (!vars.length) return;
  const d = pickDialog();
  PK = { p, vars, i: Math.max(0, Math.min(vars.length - 1, i || 0)), changed: false, ctx };
  const nm = [p.pattern.name && p.pattern.name !== p.pattern.code ? p.pattern.name : "", p.pattern.nameKo].filter(Boolean).join(" · ");
  d.innerHTML = `<div class="pk-wrap"><div class="pk-main">
      <div class="pk-crumb"><code>${esc(p.pattern.code)}</code><span>${esc(nm)}</span><button type="button" class="pk-x" data-close>Esc 테이블로 ✕</button></div>
      <div class="pk-flow" id="pk-flow"><button type="button" class="pk-arr prev" data-go="-1" aria-label="이전 컬러">‹</button><button type="button" class="pk-arr next" data-go="1" aria-label="다음 컬러">›</button>
        <div class="pk-loupe" id="pk-loupe" hidden><i></i></div></div>
      <div class="pk-name" id="pk-name" aria-live="polite"></div>
      <div class="pk-hint">${vars.length > 1 ? "옆 칩을 누르거나 <kbd>←</kbd><kbd>→</kbd> 로 다른 컬러 · " : ""}<kbd>Esc</kbd> 테이블로</div>
    </div><aside class="pk-panel" id="pk-panel"></aside></div>`;
  d.querySelector("[data-close]").onclick = () => d.close();
  $$("[data-go]", d).forEach((b) => (b.onclick = () => go(PK.i + Number(b.dataset.go))));
  const flow = $("#pk-flow", d);
  flow.addEventListener("click", (e) => { const fc = e.target.closest(".pk-fc"); if (fc && fc.dataset.slot !== "0") go(Number(fc.dataset.i)); });
  // 손가락으로 밀어 넘기기
  let sx = null;
  flow.addEventListener("pointerdown", (e) => { sx = e.pointerType === "mouse" ? null : e.clientX; });
  flow.addEventListener("pointerup", (e) => { if (sx != null && Math.abs(e.clientX - sx) > 48) go(PK.i + (e.clientX < sx ? 1 : -1)); sx = null; });
  bindLoupe(flow);
  document.body.classList.add("sh-picking");
  if (!d.open) d.showModal();
  paintPick();
}

function paintPick() {
  const d = $("#sh-pick"), { p, vars, i } = PK;
  const flow = $("#pk-flow", d), v = vars[i];
  const want = new Map(flowSlots(vars.length, i).map((s) => [s.i, s.slot]));
  $$(".pk-fc", flow).forEach((el) => { if (!want.has(Number(el.dataset.i))) el.remove(); });
  want.forEach((slot, vi) => {
    let el = flow.querySelector(`.pk-fc[data-i="${vi}"]`);
    if (!el) {
      const x = vars[vi], img = x.images && x.images[0];
      el = document.createElement("div");
      el.className = "pk-fc";
      el.dataset.i = vi;
      el.innerHTML = img ? `<img draggable="false" src="${esc(thumbUrl(p.id, img, 960))}" data-full="${esc(imgUrl(p.id, img))}" onerror="this.onerror=null;this.src=this.dataset.full" alt="${esc(vName(x))}">`
        : `<span class="sh-none">사진 없음</span>`;
      flow.insertBefore(el, flow.firstChild);
    }
    el.dataset.slot = slot;
    el.title = slot ? `${vName(vars[vi])} — 눌러서 가운데로` : "";
    // 가운데 칩만 원본으로 바꾼다(또렷하게 · 돋보기용). 옆 칩은 흐리게 물러나 있으니 축소본으로 충분
    const im = el.querySelector("img");
    if (!slot && im && im.dataset.full && im.getAttribute("src") !== im.dataset.full) {
      const full = new Image();
      full.onload = () => { if (el.dataset.slot === "0") im.src = im.dataset.full; };
      full.src = im.dataset.full;
    }
  });
  $(".pk-arr.prev", d).disabled = i <= 0;
  $(".pk-arr.next", d).disabled = i >= vars.length - 1;
  $("#pk-loupe", d).hidden = true;
  $("#pk-name", d).innerHTML = `<b>${esc(vName(v))}</b><code>${esc([stripCode(v), `${i + 1} / ${vars.length}`].filter(Boolean).join(" · "))}</code>`;
  paintPanel();
}

function paintPanel() {
  const d = $("#sh-pick"), { p, vars, i } = PK, v = vars[i];
  const w = workOf(p, v);
  const coat = (v.coating || []).filter((c) => c && (c.code || c.maker));
  const plates = (Array.isArray(w.plate) ? w.plate : [w.plate]).filter(Boolean);
  const ly = layers(v);
  const rows = [
    ["도장 컬러", coat.map((c) => `<b>${esc(c.code || "—")}</b>${c.maker ? ` <small>${esc(c.maker)}</small>` : ""}`).join(", ")],
    ["동판", [plates.map((x) => `<code>${esc(x)}</code>`).join(" "), ly.length ? esc(ly.join(" · ")) : ""].filter(Boolean).join(" · ")],
    ["프로젝트", esc([p.project, p.projectName].filter(Boolean).join(" · "))],
    ["고객", esc(p.client || "")],
    ["작업일", v.date ? esc(fmtDate(v.date)) : ""],
    ["상태", esc(v.status || "")],
  ].filter(([, val]) => val);
  const tags = (p.pattern.tags || []).map((t) => `<span>${esc(t)}</span>`).join("");
  const inn = inCart(p.id, v.id);
  const panel = $("#pk-panel", d);
  panel.innerHTML = `<div class="pk-k">컬러 ${i + 1} / ${vars.length}</div>
    <h2>${esc(vName(v))}</h2>${stripCode(v) ? `<code class="pk-code">${esc(stripCode(v))}</code>` : ""}
    <div class="pk-pat"><code>${esc(p.pattern.code)}</code><span>${esc([p.pattern.name && p.pattern.name !== p.pattern.code ? p.pattern.name : "", p.pattern.nameKo].filter(Boolean).join(" · "))}</span></div>
    ${rows.length ? `<dl>${rows.map(([key, val]) => `<dt>${key}</dt><dd>${val}</dd>`).join("")}</dl>` : ""}
    <div class="pk-marks">${rateHTML(p.id, v.id)}${tags ? `<div class="pk-tags">${tags}</div>` : ""}</div>
    <div class="pk-acts"><button type="button" class="pk-cart${inn ? " in" : ""}" id="pk-cart" aria-pressed="${inn}">${inn ? "✓ 제안서에 담김 — 빼기" : "＋ 제안서에 담기"}</button>
      <a class="pk-open" id="pk-open" href="#/p/${encodeURIComponent(p.id)}/${encodeURIComponent(v.id)}">시편 열기 ↗</a></div>`;
  bindRate(panel, () => { if (PK) PK.changed = true; });
  $("#pk-cart", panel).onclick = () => {
    toggleCart(p.id, v.id);
    renderCart();
    PK.changed = true;
    paintPanel();
    $("#pk-cart", $("#sh-pick")).focus();
  };
  $("#pk-open", panel).onclick = () => { PK.changed = false; d.close(); };
}

/** 가운데 칩 위에서 마우스를 따라다니는 돋보기 — 원본 화소가 받쳐 주는 만큼만 키운다(최대 2배) */
function bindLoupe(flow) {
  const lp = $("#pk-loupe", flow);
  const hide = () => { lp.hidden = true; };
  flow.addEventListener("pointerleave", hide);
  flow.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return hide();
    const fc = e.target.closest('.pk-fc[data-slot="0"]'), im = fc && fc.querySelector("img");
    if (!im || !im.naturalWidth || im.getAttribute("src") !== im.dataset.full) return hide();
    const r = fc.getBoundingClientRect(), fr = flow.getBoundingClientRect();
    const z = loupeZoom(im.naturalWidth, r.width, 2);
    if (!z) return hide();
    const R = lp.offsetWidth / 2 || 95, px = e.clientX - r.left, py = e.clientY - r.top;
    lp.hidden = false;
    lp.style.left = (e.clientX - fr.left - R) + "px";
    lp.style.top = (e.clientY - fr.top - R) + "px";
    lp.style.backgroundImage = `url("${im.dataset.full}")`;
    lp.style.backgroundSize = `${r.width * z}px ${r.height * z}px`;
    lp.style.backgroundPosition = `${-(px * z - R)}px ${-(py * z - R)}px`;
    lp.firstElementChild.textContent = `× ${z}`;
  });
}
