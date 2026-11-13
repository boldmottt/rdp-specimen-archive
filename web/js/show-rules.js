/* RDP 시편 아카이브 — 연출 보기(테이블 위 샘플 묶음)의 배치 규칙
 *
 * 화면(showroom.js)이 쓰는 계산만 모았다 — DOM 을 만지지 않으므로 node 로 검사한다(tests/show-rules.test.mjs).
 * 단위는 '테이블 평면의 px'. y=0 이 회전축(화면에서 장면 위쪽 pivot px 높이)이고 아래로 +.
 * 스크롤하면 평면이 sy 만큼 올라간다 — 평면 y 에 있는 것은 축에서 d = y − sy 떨어진 곳에 보인다.
 * 테이블은 비스듬히 누워 있어 화면에는 0.8~0.93배로 보인다(가까울수록 크게).
 */

/** 칩 한 장(시편 사진 170:70 + 아래 이름 띠) · 묶음 간격 */
export const CHIP = { w: 236, h: 115, strip: 18 };
export const FAN = { step: 37, dx: 17, max: 5 };          // 펼칠 때 한 장마다 내려오는 높이 · 옆으로 밀리는 폭 · 펼쳐 보이는 장수
export const GRID = { gapX: 86, pitchY: 344, zoneH: 92, top: -60, tagH: 0 };   // 이름표는 시편 위쪽(뒤)에 꽂혀 있어 아래 자리를 차지하지 않는다
/** 원근 — CSS 의 perspective · translateZ · rotateX 와 같은 값이어야 계산이 화면과 맞는다 */
export const VIEW3D = { persp: 2300, back: 430, tilt: 21, pivot: 248 };
export const SIZES = { s: 0.82, m: 1, l: 1.2 };

/**
 * 묶음에 보일 컬러 순서 — 검색에 걸린 컬러만, '맨 위에 보일 컬러'가 첫 장.
 * top: 색 정렬 중이면 기준색과 가장 가까운 컬러 id (없으면 걸린 첫 컬러)
 */
export function orderVars(vars, hits, top) {
  const list = (vars || []).filter((v) => !hits || hits.includes(v.id));
  const i = top ? list.findIndex((v) => v.id === top) : -1;
  if (i > 0) list.unshift(list.splice(i, 1)[0]);
  return list;
}

/**
 * 펼친 묶음에서 실제로 칩으로 그릴 것 — 5장까지. 더 많으면 4장 + '+N색 더'.
 * @returns {{shown: number, more: number}}  shown: 칩 장수, more: 남은 컬러 수(0이면 '더 보기' 없음)
 */
export function fanSlots(n, max = FAN.max) {
  if (n <= max) return { shown: n, more: 0 };
  return { shown: max - 1, more: n - (max - 1) };
}

/**
 * 쉬는 묶음 — 아래 칩의 가장자리가 살짝 보이게 조금씩 어긋나게 쌓는다.
 * flip: 묶음마다 어긋나는 방향을 바꿔 가지런한 격자가 딱딱해 보이지 않게
 */
export function restLayout(n, flip) {
  const out = [];
  for (let k = 0; k < n; k++) out.push({ x: k * 5.5, y: k * 4.5, rot: k ? (flip ? -1.1 : 1.3) * Math.min(k, 3) * 0.6 : 0 });
  return out;
}

/**
 * 펼친 묶음 — 한 장씩 step 만큼 아래로(앞 장이 위에 겹쳐서, 각 장의 아래 끝 띠와 무늬 한 줄이 보인다).
 * hot(마우스가 올라간 칩)을 온전히 보이게: hot 과 그 아래 칩들을 '겹친 만큼(h − step)' 더 내린다.
 *  → hot 의 위 끝이 바로 위 칩의 아래 끝과 맞닿아 가리는 것이 없다.
 *  커서는 hot 의 보이던 띠(아래 끝) 위에 있었으므로 내려간 hot 위에 그대로 남는다.
 * hot 위쪽 칩들은 움직이지 않는다(위 칩으로 마우스를 옮겨도 그 칩이 달아나지 않게).
 */
export function fanLayout(n, hot, o = {}) {
  const step = o.step || FAN.step, dx = o.dx || FAN.dx, h = o.h || CHIP.h;
  const push = hot > 0 && hot < n ? h - step : 0;
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ x: k * dx, y: k * step + (hot > 0 && k >= hot ? push : 0), rot: (k - Math.max(hot, 0)) * -1.2 });
  }
  return out;
}

/** 펼친 묶음이 차지하는 높이(가장 길 때) — 줄 간격이 이보다 커야 아랫줄을 가리지 않는다 */
export function fanHeight(n, o = {}) {
  const step = o.step || FAN.step, h = o.h || CHIP.h;
  const m = Math.min(n, FAN.max);
  return (m - 1) * step + h + (m > 1 ? h - step : 0);
}

/**
 * 테이블 평면의 깊이 d(회전축에서 아래로 +)에 있는 점이 화면에서 얼마나 커 보이는가(1 = 그대로).
 * CSS: perspective(P) · translateZ(-back) · rotateX(tilt)
 */
export function scaleAt(d, v = VIEW3D) {
  const t = (v.tilt * Math.PI) / 180;
  return v.persp / (v.persp + v.back - d * Math.sin(t));
}

/** 회전축에서 화면 아래로 dy(px) 떨어진 곳에 보이는 평면의 깊이 d — 스크롤 끝을 정할 때 쓴다 */
export function depthAtScreen(dy, v = VIEW3D) {
  const t = (v.tilt * Math.PI) / 180;
  // dy = d·cos(t)·P / (P + back − d·sin(t))  →  d 에 대해 푼다
  return (dy * (v.persp + v.back)) / (v.persp * Math.cos(t) + dy * Math.sin(t));
}

/**
 * 한 줄에 놓을 묶음 수 — 가장 가까운(가장 크게 보이는) 줄에서도 빈 폭 안에 들어가게.
 * freeW: 왼쪽 태그 트레이를 뺀 화면 폭(px) · sceneH: 장면 높이(px) · k: 크기 배율
 */
export function columnsFor(freeW, sceneH, k = 1) {
  const pitch = (CHIP.w + GRID.gapX) * k;
  const nearScale = scaleAt(depthAtScreen(Math.max(0, sceneH - VIEW3D.pivot)));
  const usable = Math.max(0, freeW - 56) / nearScale + GRID.gapX * k - FAN.dx * (FAN.max - 1) * k;
  return Math.max(1, Math.min(8, Math.floor(usable / pitch)));
}

/**
 * 묶음들의 자리 — 가운데 정렬(평면 x=0 이 빈 폭의 가운데).
 * groups: [{label, items:[…]}] (묶기 없음이면 label:"" 하나)
 * @returns {{rows: {y, zone, cells: {x, item, i}[]}[], height}}  y 는 평면 위에서 아래로
 */
export function layoutGroups(groups, cols, k = 1) {
  const pitchX = (CHIP.w + GRID.gapX) * k, pitchY = GRID.pitchY * k;
  const rowW = cols * pitchX - GRID.gapX * k;
  const rows = [];
  let y = GRID.top, i = 0;
  groups.forEach((g) => {
    if (g.label) y += GRID.zoneH * k;
    for (let s = 0; s < g.items.length; s += cols) {
      const cells = g.items.slice(s, s + cols).map((item, c) => ({ x: -rowW / 2 + c * pitchX, item, i: i++ }));
      rows.push({ y, zone: s === 0 ? g.label : "", cells });
      y += pitchY;
    }
  });
  return { rows, height: y };
}

/** 스크롤 끝 — 마지막 줄(이름표까지)이 화면 아래(제안서 막대 위)에 다 보일 때까지 */
export function maxScroll(contentH, sceneH) {
  const bottom = depthAtScreen(Math.max(0, sceneH - VIEW3D.pivot - 96));
  return Math.max(0, Math.round(contentH - bottom));
}

/** 지금 스크롤에서 그릴 줄인가 — 화면 밖 줄은 숨겨 둔다(수백 묶음이어도 가볍게) */
export function rowVisible(y, sy, sceneH, k = 1) {
  const d = y - sy;
  const top = depthAtScreen(-VIEW3D.pivot) - GRID.pitchY * k - 60;
  const bottom = depthAtScreen(Math.max(0, sceneH - VIEW3D.pivot)) + 80;
  return d > top && d < bottom;
}

/**
 * 집어 든 화면(커버플로)의 자리 — 가운데 cur, 양옆으로 두 장씩.
 * @returns {{i:number, slot:number}[]}  slot: -2 … 2 (0 = 가운데)
 */
export function flowSlots(n, cur) {
  const out = [];
  for (let s = -2; s <= 2; s++) { const i = cur + s; if (i >= 0 && i < n) out.push({ i, slot: s }); }
  return out;
}

/** 돋보기 배율 — 원본이 화면에 보이는 폭의 몇 배인지 넘지 않게(없는 화소를 만들어 보여 주지 않는다). 1.3배도 안 되면 0(돋보기 없음) */
export function loupeZoom(naturalW, shownW, want = 2) {
  if (!naturalW || !shownW) return 0;
  const z = Math.min(want, naturalW / shownW);
  return z < 1.3 ? 0 : Math.round(z * 10) / 10;
}
