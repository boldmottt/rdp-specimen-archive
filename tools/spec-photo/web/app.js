/* 실물 크기 시편 사진 — 화면
 * 네 귀퉁이를 찍고(원근 보정 기준), 실물 mm 를 넣으면 서버가 펴서 자른다.
 * 여기서는 ① 사진 목록 ② 귀퉁이 4점 편집(끌기·방향키) ③ 요청·결과 표시 만 한다.
 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const S = {
  items: [],        // {id, name, w, h, quad:[[x,y]x4]}
  cur: -1,
  view: { scale: 1, ox: 0, oy: 0 },
  drag: -1,
};

/* ---------------------------------------------------------------- 업로드 */
async function addFiles(files) {
  const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
  for (const f of list) {
    const buf = await f.arrayBuffer();
    const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", body: buf });
    const j = await r.json();
    if (!j.ok) { alert(j.error || "업로드 실패"); continue; }
    const quad = [[0, 0], [j.w - 1, 0], [j.w - 1, j.h - 1], [0, j.h - 1]];
    S.items.push({ id: j.id, name: j.name, w: j.w, h: j.h, quad });
  }
  if (S.cur < 0 && S.items.length) select(0);
  renderFiles();
  $("#runAll").disabled = !S.items.length;
}

function renderFiles() {
  $("#files").innerHTML = S.items.map((it, i) =>
    `<li data-i="${i}" class="${i === S.cur ? "on" : ""}"><b>${i + 1}. ${esc(it.name)}</b><span>${it.w}×${it.h}</span></li>`
  ).join("");
  $$("#files li").forEach((li) => (li.onclick = () => select(Number(li.dataset.i))));
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------------------------------------------------------- 캔버스 */
let IMG = new Image();

async function select(i) {
  S.cur = i;
  const it = S.items[i];
  $("#curName").textContent = it.name;
  $("#curSize").textContent = `${it.w}×${it.h}px`;
  IMG = new Image();
  await new Promise((res) => { IMG.onload = res; IMG.src = `/api/raw/${it.id}`; });
  renderFiles();
  fitCanvas();
  draw();
}

function fitCanvas() {
  const stage = $(".stage");
  const maxW = stage.clientWidth - 8 || 900;
  const maxH = Math.max(320, Math.min(620, window.innerHeight * 0.6));
  const it = S.items[S.cur];
  const sc = Math.min(maxW / it.w, maxH / it.h, 1);
  S.view.scale = sc;
  const cv = $("#cv");
  cv.width = Math.round(it.w * sc);
  cv.height = Math.round(it.h * sc);
  draw();
}

const toScreen = (p) => [p[0] * S.view.scale, p[1] * S.view.scale];
const toImage = (x, y) => [x / S.view.scale, y / S.view.scale];

function draw() {
  const it = S.items[S.cur];
  if (!it) return;
  const cv = $("#cv"), ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(IMG, 0, 0, cv.width, cv.height);

  const pts = it.quad.map(toScreen);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  pts.slice(1).forEach((p) => ctx.lineTo(p[0], p[1]));
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.fill();
  ctx.strokeStyle = "#fc4c02";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // 자를 영역(가운데, 목표 비율) 미리보기
  const tgt = targetMm();
  const refMm = refSize();
  if (tgt.w > 0 && refMm.w > 0) {
    const ratio = (tgt.w / tgt.h);
    const quadW = dist(pts[0], pts[1]), quadH = dist(pts[1], pts[2]);
    // 기준 사각형(화면) 안에서 '실물 비율' 기준으로 170:70 창을 그린다
    const refRatio = refMm.w / refMm.h;
    let w = Math.min(quadW, quadH * ratio / refRatio * 1e9);
    const boxW = quadW, boxH = quadH;
    // 실물 비율 → 화면 비율: (tgt.w/tgt.h) / (refMm.w/refMm.h)
    const k = (tgt.w / tgt.h) / refRatio;
    let cw = k >= 1 ? boxW : boxH * k;
    let ch = k >= 1 ? boxW / k : boxH;
    if (cw > boxW) { cw = boxW; ch = cw / k; }
    if (ch > boxH) { ch = boxH; cw = ch * k; }
    const cx = (pts[0][0] + pts[2][0]) / 2, cy = (pts[0][1] + pts[2][1]) / 2;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - cw / 2, cy - ch / 2, cw, ch);
    ctx.restore();
  }

  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 8, 0, Math.PI * 2);
    ctx.fillStyle = i === S.drag ? "#fc4c02" : "rgba(255,255,255,.92)";
    ctx.fill();
    ctx.strokeStyle = "#141517";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#141517";
    ctx.font = "10px -apple-system,sans-serif";
    ctx.fillText(String(i + 1), p[0] + 11, p[1] - 8);
  });
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ---------------------------------------------------------------- 입력 */
const refSize = () => ({ w: Number($("#refW").value) || 0, h: Number($("#refH").value) || 0 });
const targetMm = () => ({ w: Number($("#tgtW").value) || 0, h: Number($("#tgtH").value) || 0 });

function hit(x, y) {
  const it = S.items[S.cur];
  if (!it) return -1;
  let best = -1, bd = 16;
  it.quad.forEach((p, i) => {
    const [sx, sy] = toScreen(p);
    const d = Math.hypot(sx - x, sy - y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function bindCanvas() {
  const cv = $("#cv");
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  cv.addEventListener("pointerdown", (e) => {
    const [x, y] = pos(e);
    S.drag = hit(x, y);
    if (S.drag >= 0) { cv.setPointerCapture(e.pointerId); draw(); }
  });
  cv.addEventListener("pointermove", (e) => {
    if (S.drag < 0) { cv.style.cursor = hit(...pos(e)) >= 0 ? "grab" : "crosshair"; return; }
    const [x, y] = pos(e);
    const it = S.items[S.cur];
    const p = toImage(x, y);
    it.quad[S.drag] = [Math.max(0, Math.min(it.w - 1, p[0])), Math.max(0, Math.min(it.h - 1, p[1]))];
    draw();
    showLoupe(x, y, it.quad[S.drag]);
  });
  const stop = () => { S.drag = -1; $("#loupe").style.display = "none"; draw(); };
  cv.addEventListener("pointerup", stop);
  cv.addEventListener("pointercancel", stop);

  window.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      const it = S.items[S.cur];
      if (!it) return;
      const i = S.drag >= 0 ? S.drag : 0;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      it.quad[i] = [Math.max(0, Math.min(it.w - 1, it.quad[i][0] + d[0])),
                    Math.max(0, Math.min(it.h - 1, it.quad[i][1] + d[1]))];
      e.preventDefault();
      draw();
    }
  });
}

function showLoupe(x, y, p) {
  const L = $("#loupe");
  const zoom = 5;
  L.style.display = "block";
  L.style.left = Math.max(0, x - 52) + "px";
  L.style.top = Math.max(0, y - 120) + "px";
  L.style.backgroundImage = `url(${IMG.src})`;
  L.style.backgroundSize = `${S.items[S.cur].w * S.view.scale * zoom}px auto`;
  const bx = p[0] * S.view.scale * zoom - 52, by = p[1] * S.view.scale * zoom - 52;
  L.style.backgroundPosition = `${-bx}px ${-by}px`;
}

/* ---------------------------------------------------------------- 처리 */
async function runOne(item, index) {
  const body = {
    id: item.id,
    quad: item.quad,
    refMm: refSize(),
    targetMm: targetMm(),
    offsetMm: { x: Number($("#offX").value) || 0, y: Number($("#offY").value) || 0 },
    allowUpscale: $("#allowUp").checked,
    format: ($$('input[name="fmt"]').find((r) => r.checked) || {}).value || "PNG",
    index,
  };
  const r = await fetch("/api/process", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}

function resultRow(j, name) {
  if (!j.ok) {
    return `<li><div class="meta"><b>${esc(name)}</b><span class="warn">${esc(j.error)}</span></div></li>`;
  }
  const warn = (j.warn || []).map((w) => `<div class="warn">· ${esc(w)}</div>`).join("");
  return `<li>
    <img src="/api/preview/${j.outId}" alt="">
    <div class="meta">
      <b>${esc(j.name)}</b>
      <span>${j.px[0]}×${j.px[1]}px · ${j.mm[0]}×${j.mm[1]}mm · ${Math.round(j.dpi[0])}dpi${j.upscale ? " · 확대됨" : ""}</span>
      ${warn}
    </div>
    <a class="dl" href="/api/file/${j.outId}"><button class="mini">내려받기</button></a>
  </li>`;
}

async function runAll() {
  const list = $("#results");
  list.innerHTML = "";
  $("#runAll").disabled = true;
  $("#sum").textContent = "처리 중…";
  const out = [];
  for (let i = 0; i < S.items.length; i++) {
    const it = S.items[i];
    try {
      const j = await runOne(it, i + 1);
      out.push(j);
      list.insertAdjacentHTML("beforeend", resultRow(j, it.name));
    } catch (e) {
      list.insertAdjacentHTML("beforeend", resultRow({ ok: false, error: "요청 실패: " + e.message }, it.name));
    }
  }
  const ok = out.filter((j) => j.ok).length;
  $("#sum").textContent = `${ok} / ${S.items.length} 완료`;
  $("#runAll").disabled = false;
}

/* ---------------------------------------------------------------- 시작 */
function bind() {
  const drop = $("#drop"), file = $("#file");
  drop.onclick = () => file.click();
  file.onchange = () => { addFiles(file.files); file.value = ""; };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  $("#refPreset").onchange = (e) => {
    if (e.target.value === "custom") return;
    const [w, h] = e.target.value.split(",");
    $("#refW").value = w; $("#refH").value = h; draw();
  };
  ["#refW", "#refH", "#tgtW", "#tgtH", "#offX", "#offY"].forEach((s) => ($(s).oninput = draw));
  $("#tgt170").onclick = () => { $("#tgtW").value = 170; $("#tgtH").value = 70; draw(); };

  $("#suggest").onclick = async () => {
    const it = S.items[S.cur];
    if (!it) return;
    const r = await fetch("/api/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id }) });
    const j = await r.json();
    if (!j.ok) return alert(j.error);
    it.quad = j.quad;
    draw();
    $("#curSize").textContent = `${it.w}×${it.h}px · ${j.why}`;
  };

  $("#applyAll").onclick = () => {
    const cur = S.items[S.cur];
    if (!cur) return;
    S.items.forEach((it, i) => { if (i !== S.cur) it.quad = cur.quad.map((p) => [p[0], p[1]]); });
    $("#sum").textContent = "이 귀퉁이를 모든 사진에 복사했습니다";
  };

  $("#runAll").onclick = runAll;
  bindCanvas();
  window.addEventListener("resize", () => { if (S.items.length) { fitCanvas(); } });
}

bind();
