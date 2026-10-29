/* RDP 시편 아카이브 — 제안서 순서 규칙 (화면을 모르는 순수 함수)
 *
 * 왜 있나
 *   제안서 순서 = 장바구니(App.cart) 배열 순서다. 담기(끝에 추가)·빼기(그 자리 제거)는 저절로 맞지만
 *   "이 패턴을 위로" 같은 조작은 배열을 직접 만져야 한다. 그 규칙을 여기 모아 검사한다.
 *
 * 규칙
 *   · 화면은 패턴 덩어리(grouped)로 그린다 → 패턴 순서와, 패턴 안 컬러 순서 두 단계만 있으면 된다.
 *   · 항목을 더하거나 빼지 않는다. 순서만 바꾼다({pid,vid} 집합은 항상 그대로).
 *   · 어떤 이동 뒤에도 "패턴별로 연속"이 되도록 평평하게 정리한다.
 *
 * 되돌리기: proposal.js 가 이 파일을 안 쓰게 되돌리고 파일을 지우면 된다.
 */

/** 장바구니 → [{pid, vids:[vid...]}] (그 패턴이 처음 나온 순서, 컬러는 장바구니 순서) */
export function groupOrder(cart) {
  const out = [];
  (cart || []).forEach((c) => {
    if (!c || !c.pid) return;
    let g = out.find((x) => x.pid === c.pid);
    if (!g) { g = { pid: c.pid, vids: [] }; out.push(g); }
    if (c.vid && !g.vids.includes(c.vid)) g.vids.push(c.vid);
  });
  return out;
}

/** [{pid, vids}] → 장바구니 배열 */
export function flatten(groups) {
  const out = [];
  (groups || []).forEach((g) => (g.vids || []).forEach((vid) => out.push({ pid: g.pid, vid })));
  return out;
}

const copy = (cart) => (cart || []).map((c) => ({ pid: c.pid, vid: c.vid }));

/**
 * 패턴 덩어리를 옮긴다.
 * @param delta -1(위) | 1(아래) | "top"(맨 위로)
 */
export function movePattern(cart, pid, delta) {
  const g = groupOrder(cart);
  const i = g.findIndex((x) => x.pid === pid);
  if (i < 0) return copy(cart);
  if (delta === "top") {
    if (i === 0) return copy(cart);
    const [x] = g.splice(i, 1);
    g.unshift(x);
    return flatten(g);
  }
  const j = i + (delta === -1 ? -1 : 1);
  if (j < 0 || j >= g.length) return copy(cart);          // 끝에서는 그대로
  [g[i], g[j]] = [g[j], g[i]];
  return flatten(g);
}

/** 한 패턴 안에서 컬러 하나를 옮긴다(패턴 밖으로는 못 나간다) */
export function moveColor(cart, pid, vid, delta) {
  const g = groupOrder(cart);
  const grp = g.find((x) => x.pid === pid);
  if (!grp) return copy(cart);
  const i = grp.vids.indexOf(vid);
  if (i < 0) return copy(cart);
  const j = i + (delta === -1 ? -1 : 1);
  if (j < 0 || j >= grp.vids.length) return copy(cart);
  [grp.vids[i], grp.vids[j]] = [grp.vids[j], grp.vids[i]];
  return flatten(g);
}

/** 패턴별로 연속이 되게 정리한다(섞여 들어온 장바구니를 grouped()와 같은 순서로) */
export function normalizeOrder(cart) {
  return flatten(groupOrder(cart));
}
