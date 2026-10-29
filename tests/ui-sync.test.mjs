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

/* ② 서버 목록을 받아들일 때 버려진 폴더를 알려 준다 */
test("②-1 lostFolders — 서버에 없거나 내용이 다른 로컬 폴더 이름만", async () => {
  const { lostFolders } = await import("../web/js/ui-sync.js");
  const local = [
    { id: "a", name: "같은것", q: "", project: "all" },
    { id: "b", name: "서버에없음", q: "#x", project: "all" },
    { id: "c", name: "이름바뀜", q: "", project: "all" },
    { id: "d", name: "조건바뀜", q: "", project: "all" },
  ];
  const server = [
    { id: "a", name: "같은것", q: "", project: "all" },
    { id: "c", name: "서버이름", q: "", project: "all" },
    { id: "d", name: "조건바뀜", q: "#y", project: "all" },
  ];
  assert.deepEqual(lostFolders(local, server), ["서버에없음", "이름바뀜", "조건바뀜"]);
  assert.deepEqual(lostFolders(server, server), [], "같으면 빈 배열");
  assert.deepEqual(lostFolders([], server), []);
});

test("②-2 adoptMessage — 버려진 폴더가 있으면 이름이 들어간다", async () => {
  const { adoptMessage } = await import("../web/js/ui-sync.js");
  assert.equal(adoptMessage([]), "저장된 검색이 다른 곳에서 바뀌어 최신 목록으로 맞췄습니다");
  const m1 = adoptMessage(["세미나"]);
  assert.ok(m1.includes("'세미나'") && m1.includes("반영되지 않았습니다"), m1);
  const m4 = adoptMessage(["a", "b", "c", "d"]);
  assert.ok(m4.includes("외 1개"), m4);
});

test("②-3 409 인데 서버 상태를 못 받으면 받아들이지 않는다(onAdopt 0회, 전송 2회)", { timeout: 4000 }, async () => {
  const calls = [];
  const adopted = [];
  const sync = createUiSync({
    send: (body) => new Promise((resolve) => {
      calls.push({ body, done: false, settle: (st) => resolve({ status: st, json: st === 200 ? { ok: true, state: { smartFoldersRev: 5 } } : null }) });
    }),
    fetchState: async () => ({}),                       // 서버가 아무것도 못 줬다
    getBody: (withFolders) => (withFolders ? { smartFolders: [{ id: "mine" }] } : { cart: [] }),
    onAdopt: (s) => adopted.push(s),
    onRev: () => {},
  });
  const answer = async (st) => {
    await new Promise((r) => setTimeout(r, 0));
    const c = calls.find((x) => !x.done);
    c.done = true; c.settle(st);
    await new Promise((r) => setTimeout(r, 0));
  };
  sync.markDirty();
  const p = sync.push();
  await answer(409);
  assert.equal(adopted.length, 0, "빈 상태로 덮어쓰지 않는다");
  assert.equal(calls.length, 2, "장바구니 재전송은 그대로 한다");
  await answer(200);
  await p;
});
