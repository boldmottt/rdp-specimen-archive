/* 연출 보기 배치 규칙 테스트 — node --test tests/show-rules.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHIP, FAN, GRID, VIEW3D, orderVars, fanSlots, restLayout, fanLayout, fanHeight, scaleAt, depthAtScreen,
  columnsFor, layoutGroups, maxScroll, rowVisible, flowSlots, loupeZoom,
} from "../web/js/show-rules.js";

const V = (...ids) => ids.map((id) => ({ id }));

test("orderVars — 검색에 걸린 컬러만, 맨 위 컬러가 첫 장", () => {
  const vars = V("a", "b", "c", "d");
  assert.deepEqual(orderVars(vars, null, null).map((v) => v.id), ["a", "b", "c", "d"]);
  assert.deepEqual(orderVars(vars, ["b", "d"], null).map((v) => v.id), ["b", "d"]);
  assert.deepEqual(orderVars(vars, null, "c").map((v) => v.id), ["c", "a", "b", "d"]);
  // 맨 위로 고른 컬러가 검색에 안 걸렸으면 무시(걸린 것만 보여 준다)
  assert.deepEqual(orderVars(vars, ["a", "b"], "c").map((v) => v.id), ["a", "b"]);
  assert.deepEqual(orderVars([], null, "x"), []);
});

test("fanSlots — 5장까지는 그대로, 넘으면 4장 + '+N색 더'", () => {
  assert.deepEqual(fanSlots(1), { shown: 1, more: 0 });
  assert.deepEqual(fanSlots(5), { shown: 5, more: 0 });
  assert.deepEqual(fanSlots(6), { shown: 4, more: 2 });
  assert.deepEqual(fanSlots(12), { shown: 4, more: 8 });
});

test("restLayout — 첫 장은 반듯하게, 아래 장은 살짝 어긋나게", () => {
  const l = restLayout(3, false);
  assert.deepEqual(l[0], { x: 0, y: 0, rot: 0 });
  assert.ok(l[1].x > 0 && l[1].y > 0);
  assert.ok(restLayout(3, true)[1].rot < 0 && l[1].rot > 0, "묶음마다 어긋나는 방향이 다르다");
});

test("fanLayout — 마우스를 올린 칩은 온전히 보이고 그 위 칩은 움직이지 않는다", () => {
  const n = 5, hot = 2;
  const l = fanLayout(n, hot);
  const plain = fanLayout(n, 0);
  // 위쪽 칩은 그대로 — 커서 아래 칩이 달아나지 않게
  assert.equal(l[0].y, plain[0].y);
  assert.equal(l[1].y, plain[1].y);
  // 앞 장이 위에 그려진다 — 올린 칩의 위 끝이 바로 위 칩의 아래 끝과 맞닿아 온전히 보인다
  assert.equal(l[hot].y, l[hot - 1].y + CHIP.h);
  // 커서가 있던 자리(올리기 전 그 칩의 보이던 띠: 위 칩 아래 끝 ~ 그 칩 아래 끝)는 올린 칩 안에 그대로 있다
  const band = [plain[hot - 1].y + CHIP.h, plain[hot].y + CHIP.h];
  assert.ok(band[0] >= l[hot].y && band[1] <= l[hot].y + CHIP.h);
  // 그 아래 칩들은 간격을 그대로 유지(띠가 하나씩 보인다)
  assert.equal(l[hot + 1].y - l[hot].y, FAN.step);
  // 첫 칩을 올렸을 때는 밀 필요가 없다(맨 위라 이미 다 보인다)
  assert.deepEqual(fanLayout(n, 0).map((x) => x.y), [0, 1, 2, 3, 4].map((k) => k * FAN.step));
});

test("fanHeight — 펼친 묶음은 줄 간격 안에 들어간다(아랫줄을 가리지 않게)", () => {
  assert.ok(fanHeight(FAN.max) <= GRID.pitchY, `${fanHeight(FAN.max)} ≤ ${GRID.pitchY}`);
  assert.ok(fanHeight(12) <= GRID.pitchY, "12색이어도 5장까지만 펼친다");
  assert.equal(fanHeight(1), CHIP.h);
});

test("원근 — 축에서 가까울수록(아래) 크게, depthAtScreen 은 화면 → 평면 역산", () => {
  assert.ok(scaleAt(400) > scaleAt(0) && scaleAt(0) > scaleAt(-300));
  const t = (VIEW3D.tilt * Math.PI) / 180;
  for (const d of [-300, 0, 250, 600]) {
    const dy = (d * Math.cos(t) * VIEW3D.persp) / (VIEW3D.persp + VIEW3D.back - d * Math.sin(t));
    assert.ok(Math.abs(depthAtScreen(dy) - d) < 1e-6, `d=${d}`);
  }
});

test("columnsFor — 넓을수록 많이, 작게 보기면 더 많이, 최소 1 · 최대 8", () => {
  const wide = columnsFor(1300, 900), narrow = columnsFor(354, 780);
  assert.ok(wide >= 3 && wide <= 5, `wide=${wide}`);
  assert.equal(narrow, 1);
  assert.ok(columnsFor(1300, 900, 0.82) >= wide);
  assert.ok(columnsFor(1300, 900, 1.2) <= wide);
  assert.equal(columnsFor(10, 900), 1);
  assert.ok(columnsFor(20000, 900) <= 8);
});

test("layoutGroups — 가운데 정렬 · 줄 나눔 · 구역은 첫 줄에만", () => {
  const g = [{ label: "A", items: [1, 2, 3, 4, 5] }, { label: "B", items: [6] }];
  const { rows, height } = layoutGroups(g, 2);
  assert.deepEqual(rows.map((r) => r.cells.map((c) => c.item)), [[1, 2], [3, 4], [5], [6]]);
  assert.deepEqual(rows.map((r) => r.zone), ["A", "", "", "B"]);
  // 같은 줄의 칸은 0 을 가운데로 좌우 대칭
  const r0 = rows[0].cells.map((c) => c.x);
  assert.equal(r0[0] + CHIP.w / 2, -(r0[1] + CHIP.w / 2));
  // 순번 i 는 전체에서 이어진다
  assert.deepEqual(rows.flatMap((r) => r.cells.map((c) => c.i)), [0, 1, 2, 3, 4, 5]);
  // 구역 이름표 자리만큼 아래로 밀린다
  assert.equal(rows[3].y - rows[2].y, GRID.pitchY + GRID.zoneH);
  assert.ok(height > rows[3].y);
  // 묶기 없음(label "")이면 구역 자리를 두지 않는다
  assert.equal(layoutGroups([{ label: "", items: [1] }], 3).rows[0].y, GRID.top);
});

test("maxScroll · rowVisible — 짧으면 스크롤 없음, 화면 밖 줄은 숨김", () => {
  assert.equal(maxScroll(200, 900), 0);
  assert.ok(maxScroll(5000, 900) > 3000);
  assert.ok(rowVisible(GRID.top, 0, 900));
  assert.ok(!rowVisible(5000, 0, 900), "한참 아래 줄은 그리지 않는다");
  assert.ok(!rowVisible(0, 3000, 900), "한참 위로 지나간 줄도");
  assert.ok(rowVisible(3000, 3000, 900), "스크롤하면 그 줄이 보인다");
});

test("flowSlots — 가운데와 양옆 두 장씩, 끝에서는 있는 것만", () => {
  assert.deepEqual(flowSlots(5, 2).map((s) => s.slot), [-2, -1, 0, 1, 2]);
  assert.deepEqual(flowSlots(5, 0), [{ i: 0, slot: 0 }, { i: 1, slot: 1 }, { i: 2, slot: 2 }]);
  assert.deepEqual(flowSlots(1, 0), [{ i: 0, slot: 0 }]);
});

test("loupeZoom — 원본 화소가 받쳐 주는 만큼만(최대 2배), 모자라면 돋보기 없음", () => {
  assert.equal(loupeZoom(1700, 700), 2);
  assert.equal(loupeZoom(1000, 700), 1.4);
  assert.equal(loupeZoom(800, 700), 0);
  assert.equal(loupeZoom(0, 700), 0);
  assert.equal(loupeZoom(1700, 0), 0);
});
