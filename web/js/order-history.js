/* RDP 시편 아카이브 — 제안서 순서 되돌리기 기록 (화면을 모르는 순수 함수)
 *
 * 왜 있나: 레일에서 순서를 바꾸면 바로 저장된다(자동 저장). 잘못 옮겼을 때 한 번에 되돌릴 수단이 필요하다.
 *   순서 조작만 기록하고, 담기·빼기처럼 항목 구성이 바뀌면 기록을 비운다(이미 뺀 항목이 되살아나는 것 방지).
 *
 * 되돌리기: proposal.js 가 이 파일을 안 쓰게 되돌리고 지우면 된다.
 */

/** 두 장바구니가 같은 항목 집합인가(순서 무관) */
export function sameItems(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const key = (c) => `${c.pid}/${c.vid}`;
  return a.map(key).sort().join("|") === b.map(key).sort().join("|");
}

/** 최대 limit 단계까지 되돌리기 기록 */
export function createHistory(limit = 20) {
  const stack = [];
  return {
    push(cart) {
      stack.push((cart || []).map((c) => ({ pid: c.pid, vid: c.vid })));
      if (stack.length > limit) stack.shift();       // 오래된 것부터 버린다
    },
    undo() { return stack.length ? stack.pop() : null; },
    canUndo: () => stack.length > 0,
    size: () => stack.length,
    clear() { stack.length = 0; },
  };
}
