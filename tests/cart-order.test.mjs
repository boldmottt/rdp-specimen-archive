/* 제안서 순서 규칙 테스트 — node --test tests/cart-order.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { groupOrder, movePattern, moveColor, normalizeOrder } from "../web/js/cart-order.js";

const cart = () => ([
  { pid: "A", vid: "a1" }, { pid: "B", vid: "b1" },
  { pid: "A", vid: "a2" }, { pid: "B", vid: "b2" }, { pid: "C", vid: "c1" },
]);
const key = (c) => c.map((x) => `${x.pid}/${x.vid}`).join(",");

test("groupOrder — 처음 나온 패턴 순서, 컬러는 장바구니 순서", () => {
  assert.deepEqual(groupOrder(cart()), [
    { pid: "A", vids: ["a1", "a2"] }, { pid: "B", vids: ["b1", "b2"] }, { pid: "C", vids: ["c1"] },
  ]);
});

test("패턴 이동 — 컬러가 덩어리째 함께 움직인다", () => {
  const moved = movePattern(cart(), "A", 1);
  assert.equal(key(moved), "B/b1,B/b2,A/a1,A/a2,C/c1");
});

test("패턴 맨 위로", () => {
  assert.equal(key(movePattern(cart(), "C", "top")), "C/c1,A/a1,A/a2,B/b1,B/b2");
});

test("끝에서 더 옮기면 그대로", () => {
  const c = cart();
  assert.equal(key(movePattern(c, "A", -1)), key(c));
  assert.equal(key(movePattern(c, "C", 1)), key(c));
  assert.equal(key(moveColor(c, "A", "a1", -1)), key(c));
  assert.equal(key(moveColor(c, "A", "a2", 1)), key(c));
});

test("컬러는 같은 패턴 안에서만 움직인다", () => {
  const moved = moveColor(cart(), "A", "a2", -1);
  assert.equal(moved.filter((x) => x.pid === "A").map((x) => x.vid).join(","), "a2,a1");
  assert.equal(moved.filter((x) => x.pid === "B").map((x) => x.vid).join(","), "b1,b2");
});

test("어떤 이동 뒤에도 {pid,vid} 집합은 그대로", () => {
  const before = [...cart()].map((x) => `${x.pid}/${x.vid}`).sort().join(",");
  [movePattern(cart(), "B", 1), movePattern(cart(), "C", "top"), moveColor(cart(), "B", "b2", -1)]
    .forEach((r) => assert.equal(r.map((x) => `${x.pid}/${x.vid}`).sort().join(","), before));
});

test("섞인 입력은 grouped()와 같은 순서로 정리된다", () => {
  assert.equal(key(normalizeOrder(cart())), "A/a1,A/a2,B/b1,B/b2,C/c1");
});

/* --- 레일용: 원하는 자리로 · 정렬 --- */
import { movePatternTo, moveColorTo, sortPatterns } from "../web/js/cart-order.js";
import { createHistory, sameItems } from "../web/js/order-history.js";

test("movePatternTo — 0·끝·범위 밖", () => {
  assert.equal(key(movePatternTo(cart(), "C", 0)), "C/c1,A/a1,A/a2,B/b1,B/b2");
  assert.equal(key(movePatternTo(cart(), "A", 2)), "B/b1,B/b2,C/c1,A/a1,A/a2");
  assert.equal(key(movePatternTo(cart(), "A", 99)), "B/b1,B/b2,C/c1,A/a1,A/a2", "범위 밖이면 끝으로");
});

test("moveColorTo — 패턴 안에서 원하는 자리로", () => {
  assert.equal(key(moveColorTo(cart(), "A", "a2", 0)).split(",").slice(0, 2).join(","), "A/a2,A/a1");
  const g = groupOrder(moveColorTo(cart(), "A", "a1", 99));
  assert.deepEqual(g[0], { pid: "A", vids: ["a2", "a1"] }, "범위 밖이면 그 패턴의 끝");
});

test("moveColorTo — 패턴 밖으로는 나가지 않는다", () => {
  const r = moveColorTo(cart(), "A", "a1", 99);
  assert.equal(r.filter((x) => x.pid === "A").length, 2);
  assert.equal(r.filter((x) => x.pid === "B").length, 2);
});

test("sortPatterns — 키 순, 같은 키는 원래 순서, 컬러 순서 유지", () => {
  const codes = { A: "M-2", B: "G-1", C: "M-1" };
  const r = sortPatterns(cart(), (pid) => codes[pid]);
  assert.equal(key(r), "B/b1,B/b2,C/c1,A/a1,A/a2");
  assert.equal(r.filter((x) => x.pid === "A").map((x) => x.vid).join(","), "a1,a2", "컬러 순서 그대로");
});

test("어떤 조작 뒤에도 항목 집합은 그대로", () => {
  const base = cart();
  [movePatternTo(base, "C", 0), moveColorTo(base, "B", "b2", 0), sortPatterns(base, (p) => p)].forEach((r) => {
    assert.ok(sameItems(base, r));
  });
});

test("되돌리기 — 20단계까지만, 빈 기록은 null", () => {
  const h = createHistory(20);
  assert.equal(h.undo(), null);
  assert.equal(h.canUndo(), false);
  for (let i = 0; i < 25; i++) h.push(cart());
  assert.equal(h.size(), 20);
  assert.ok(h.undo());
});

test("sameItems — 순서가 달라도 같은 집합이면 true", () => {
  assert.ok(sameItems(cart(), cart().reverse()));
  assert.ok(!sameItems(cart(), cart().slice(1)), "개수가 다르면 false");
  assert.ok(!sameItems(cart(), [...cart().slice(1), { pid: "Z", vid: "z1" }]));
});
