/* 화면 상태 저장 큐 테스트 — 브라우저 없이 돈다.
 *   실행: node --test tests/ui-sync.test.mjs
 *
 * 지키는 것 (Genspark 리뷰 2026-10-29 지적 ①)
 *   - 요청이 오가는 동안 폴더를 또 고쳐도 그 변경이 사라지지 않는다(세대 비교)
 *   - 동시에 여러 번 불러도 PUT 은 한 번만 나가고, 나머지는 끝난 뒤 한 번으로 합쳐진다
 *   - 409 면 서버 것을 받아들이고 장바구니만 다시 보낸다(루프 없음, 총 2회)
 *   - 네트워크 오류로 dirty 가 잠기지 않는다
 *
 * 각 테스트는 timeout 을 걸어 둔다 — 응답을 잘못 잡으면 '매달리지 않고 실패'하게.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createUiSync } from "../web/js/ui-sync.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/* 가짜 send: 호출을 기록하고, 응답은 테스트가 '가장 오래된 대기'부터 직접 결정한다 */
function harness() {
  const calls = [];
  const adopted = [];
  let rev = 1;
  const sync = createUiSync({
    send: (body) => new Promise((resolve, reject) => {
      calls.push({ body, done: false, settle: (status, fail) => {
        if (fail) return reject(new Error("network"));
        resolve({ status, json: status === 200 ? { ok: true, state: { smartFoldersRev: ++rev } } : null });
      } });
    }),
    fetchState: async () => ({ smartFolders: [{ id: "srv", name: "서버쪽" }], smartFoldersRev: 9 }),
    getBody: (withFolders) => (withFolders ? { smartFolders: [{ id: "mine" }], smartFoldersRev: rev } : { cart: [1] }),
    onAdopt: (s) => adopted.push(s),
    onRev: (j) => { rev = j.state.smartFoldersRev; },
  });
  // 가장 오래된 미결 호출을 응답시킨다
  const answer = async (status = 200, fail = false) => {
    await tick();
    const c = calls.find((x) => !x.done);
    assert.ok(c, "응답할 요청이 없습니다(요청이 안 나갔거나 이미 다 끝남)");
    c.done = true;
    c.settle(status, fail);
    await tick();
  };
  return { sync, calls, adopted, answer, get rev() { return rev; } };
}

test("①-1 응답 전에 또 고치면, 다음 요청에 그 변경이 실린다", { timeout: 4000 }, async () => {
  const h = harness();
  h.sync.markDirty();
  const p = h.sync.push();
  await tick();
  h.sync.markDirty();                 // ← 응답 오기 전에 또 변경
  h.sync.push();                      //   (실제 화면도 변경 직후 저장을 예약한다)
  await h.answer(200);                // 1번째 응답 도착 → 2번째 요청 생성
  assert.equal(h.calls.length, 2, "두 번째 PUT 이 나가야 한다");
  assert.ok(h.calls[1].body.smartFolders, "두 번째 요청에 폴더가 실려야 한다");
  assert.equal(h.calls[1].body.smartFoldersRev, h.rev, "첫 응답의 새 rev 를 써야 한다");
  await h.answer(200);
  await p;
  assert.equal(h.sync.isDirty(), false);
});

test("①-2 응답 대기 중 3번 불러도 추가 PUT 은 1번", { timeout: 4000 }, async () => {
  const h = harness();
  h.sync.markDirty();
  const p = h.sync.push();
  await tick();
  h.sync.push(); h.sync.push(); h.sync.push();
  assert.equal(h.calls.length, 1, "오가는 동안에는 새로 보내지 않는다");
  await h.answer(200);
  assert.equal(h.calls.length, 2, "끝나고 한 번만 더");
  await h.answer(200);
  await p;
});

test("①-3 409 면 서버 것을 받아들이고 장바구니만 다시 보낸다(총 2회)", { timeout: 4000 }, async () => {
  const h = harness();
  h.sync.markDirty();
  const p = h.sync.push();
  await h.answer(409);
  assert.equal(h.adopted.length, 1, "서버 상태를 한 번 받아들인다");
  assert.equal(h.calls.length, 2, "409 뒤 한 번만 더 (루프 없음)");
  assert.ok(!h.calls[1].body.smartFolders, "다시 보낼 때는 폴더를 싣지 않는다");
  await h.answer(200);
  await p;
  assert.equal(h.sync.isDirty(), false, "받아들였으니 dirty 해제");
  assert.equal(h.calls.length, 2, "그 뒤로는 더 보내지 않는다");
});

test("①-4 네트워크 오류로 잠기지 않는다", { timeout: 4000 }, async () => {
  const h = harness();
  h.sync.markDirty();
  const p = h.sync.push();
  await h.answer(200, true);          // reject
  await p;
  assert.equal(h.sync.isDirty(), true, "실패했으니 dirty 유지");
  const p2 = h.sync.push();
  await tick();
  assert.equal(h.calls.length, 2, "두 번째 시도가 나간다");
  await h.answer(200);
  await p2;
  assert.equal(h.sync.isDirty(), false, "성공하면 해제");
});

test("폴더를 안 바꾼 저장(장바구니)은 폴더를 싣지 않는다", { timeout: 4000 }, async () => {
  const h = harness();
  const p = h.sync.push();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.ok(!h.calls[0].body.smartFolders);
  await h.answer(200);
  await p;
});
