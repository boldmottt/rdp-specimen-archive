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
