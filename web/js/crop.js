/* RDP 시편 아카이브 — 이미지 자르기
 *
 * 그리는 방식(2026-11-03에 바꿈)
 *   예전에는 회전할 때마다 캔버스 → dataURL → <img> 로 다시 디코드했다. 그래서
 *   · 슬라이더를 끌면 인코딩이 메인 스레드를 잡아 값이 튀고,
 *   · 미리보기(디코드 대기)와 실제 업로드본(즉시 만든 캔버스)의 각도가 서로 달랐다.
 *   지금은 **스테이지에 직접 캔버스로 그린다**(paint). 회전·확대·이동이 모두 동기라
 *   미리보기 == 결과가 보장되고, 업로드용 캔버스는 확인을 누를 때 한 번만 만든다.
 */
import { $, apiUpload, deriveId, toast } from "./core.js";
import { E, renderDrawer } from "./editor.js";

// 저장 전 새 시편의 사진은 저장할 때 쓸 파일 ID 폴더로 올린다 (편집기 저장과 같은 deriveId)
function uploadId() {
  const code = String((E.draft.pattern || {}).code || "").trim();
  const id = E.draft.id || deriveId(E.draft.project, code);
  if (!code || !id) throw new Error("먼저 대표 제안차종과 패턴 코드를 입력하세요 (영문·숫자 포함)");
  return id;
}

/* ---------------- crop ---------------- */
// base = 원본 이미지(회전 전). cx·cy = 회전 후 바운딩 박스 안에서 보이는 영역의 중심(0~1).
export const C = { file: null, base: null, z: 1, cx: 0.5, cy: 0.5, slot: 1, rot: 0 };

function stageSize() {
  const el = $("#crop-stage");
  return { W: el.clientWidth, H: el.clientHeight };
}

/** 회전 후 바운딩 박스 크기(픽셀, 반올림) — 화면·자르기·업로드가 모두 이 값을 쓴다 */
function bbox() {
  const w = (C.base && C.base.naturalWidth) || 1;
  const h = (C.base && C.base.naturalHeight) || 1;
  const rad = (Math.abs(C.rot) * Math.PI) / 180;
  // 각 항에 절댓값을 먼저 — 180°/270° 에서 cos·sin 이 음수라 합이 음수가 되어 1×1 이 되던 버그
  return {
    w: Math.max(1, Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)))),
    h: Math.max(1, Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)))),
  };
}

/** 화면 배율 — 바운딩 박스가 스테이지를 덮도록(최소) × 확대 */
function scaleFor(W, H, b) {
  return Math.max(W / b.w, H / b.h) * C.z;
}

function clampC() {
  if (!C.base) return;
  const { W, H } = stageSize();
  if (!W || !H) return;
  const b = bbox();
  const s = scaleFor(W, H, b);
  const visW = W / s / b.w;
  const visH = H / s / b.h;
  const mx = Math.min(0.5, visW / 2);
  const my = Math.min(0.5, visH / 2);
  C.cx = Math.min(1 - mx, Math.max(mx, C.cx));
  C.cy = Math.min(1 - my, Math.max(my, C.cy));
}

/** 스테이지에 지금 상태를 그린다 (회전·확대·이동 모두 여기로) */
function paint() {
  const el = $("#crop-img");
  const { W, H } = stageSize();
  if (!el || !C.base || !W || !H) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
  if (el.width !== cw || el.height !== ch) { el.width = cw; el.height = ch; }
  const ctx = el.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, W, H);
  clampC();
  const b = bbox();
  const s = scaleFor(W, H, b);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(s, s);
  ctx.translate(-C.cx * b.w, -C.cy * b.h);      // 보이는 영역의 왼쪽 위
  ctx.translate(b.w / 2, b.h / 2);              // 바운딩 박스 중심
  ctx.rotate((C.rot * Math.PI) / 180);          // 시계방향 +
  ctx.drawImage(C.base, -C.base.naturalWidth / 2, -C.base.naturalHeight / 2);
  ctx.restore();

  const info = $("#crop-info");
  if (info) info.textContent = `${C.rot ? "회전 " + C.rot + "° · " : ""}원본 ${C.base.naturalWidth}×${C.base.naturalHeight} → ${b.w}×${b.h}`;
}

/** 자를 영역 — 회전 후 바운딩 박스 좌표계(업로드 캔버스와 같은 좌표) */
function cropRect() {
  const { W, H } = stageSize();
  const b = bbox();
  const s = scaleFor(W, H, b);
  const sw = W / s, sh = H / s;
  let x = C.cx * b.w - sw / 2;
  let y = C.cy * b.h - sh / 2;
  x = Math.max(0, Math.min(x, Math.max(0, b.w - sw)));
  y = Math.max(0, Math.min(y, Math.max(0, b.h - sh)));
  return { x, y, w: Math.min(sw, b.w), h: Math.min(sh, b.h) };
}

/** 업로드용 — 회전 후 바운딩 박스 전체를 원본 해상도로 그린 캔버스 */
function renderBBox() {
  const b = bbox();
  const cv = document.createElement("canvas");
  cv.width = b.w; cv.height = b.h;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";                      // 회전으로 생기는 빈 모서리는 흰색(인쇄 배경과 같게)
  ctx.fillRect(0, 0, b.w, b.h);
  ctx.translate(b.w / 2, b.h / 2);
  ctx.rotate((C.rot * Math.PI) / 180);
  ctx.drawImage(C.base, -C.base.naturalWidth / 2, -C.base.naturalHeight / 2);
  return cv;
}

/**
 * 화면에 보이는 그대로(회전 + 확대 + 위치) 잘라 낸 미리보기 — 새 시편 화면의 '담긴 사진'에 쓴다.
 * 예전에는 담긴 사진을 원본 파일 그대로 보여 줘서, 기울기만 보이고 확대·위치는 빠진 것처럼 보였다
 * (확대·위치는 저장할 때 서버가 rect 로 잘랐다). 저장 결과와 같은 영역을 그린다.
 */
function renderPreview(rect, maxW = 1200) {
  const ow = Math.max(1, Math.round(Math.min(maxW, rect.w)));
  const oh = Math.max(1, Math.round(ow * rect.h / rect.w));
  const b = bbox();
  const cv = document.createElement("canvas");
  cv.width = ow; cv.height = oh;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, ow, oh);
  ctx.scale(ow / rect.w, oh / rect.h);
  ctx.translate(-rect.x, -rect.y);
  ctx.translate(b.w / 2, b.h / 2);
  ctx.rotate((C.rot * Math.PI) / 180);
  ctx.drawImage(C.base, -C.base.naturalWidth / 2, -C.base.naturalHeight / 2);
  return new Promise((resolve) => cv.toBlob((bl) => resolve(bl ? URL.createObjectURL(bl) : ""), "image/jpeg", 0.9));
}

export function startCrop(file, opt) {
  C.file = file; C.slot = (opt && opt.slot) || 1;
  C.z = 1; C.cx = 0.5; C.cy = 0.5; C.rot = 0; C.base = null;
  const rotNum = document.querySelector("#crop-rot-num");
  if (rotNum) rotNum.value = 0;
  const zoomEl = document.querySelector("#crop-zoom");
  if (zoomEl) zoomEl.value = 100;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    C.base = img;
    $("#crop-modal").classList.add("on");
    requestAnimationFrame(paint);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type || "")) {
      toast("HEIC 미리보기 불가 — 가운데 기준으로 잘라 저장합니다");
      uploadCenter();
    } else {
      toast("이미지를 읽을 수 없습니다");
    }
  };
  img.src = url;
}

/** 올릴 바이트 — 기울기를 줬으면 회전 캔버스를 JPEG 로, 아니면 원본 파일 그대로 */
function uploadBytes() {
  if (!C.rot || !C.base) return Promise.resolve(C.file);
  const cv = renderBBox();
  return new Promise((resolve) => {
    cv.toBlob((b) => resolve(new File([b], "rotated.jpg", { type: "image/jpeg" })), "image/jpeg", 0.95);
  });
}

async function commitUpload(res) {
  if (!E.draft || !E.draft.variations[E.vIdx]) return;
  const v = E.draft.variations[E.vIdx];
  v.images = v.images || [];
  v.images[C.slot - 1] = res.file;
  v.images = v.images.filter(Boolean);
  if (C.onDone) { const cb = C.onDone; C.onDone = null; cb(); } else renderDrawer();
  toast(res.lowRes ? "저장됨 · 해상도가 낮습니다 (" + res.sourceWidth + "px)" : "이미지 저장됨");
}

/**
 * 서랍 밖(새 시편 화면)에서 사진을 넣을 때 — 편집기 상태를 잠깐 이 초안으로 맞추고 자르기를 연다.
 * 끝나면 onDone() 으로 그 화면을 다시 그린다.
 */
export function startCropForDraft(draft, vidx, file, opt, onDone) {
  if (!draft) return;
  E.draft = draft;
  E.vIdx = Math.max(0, vidx || 0);
  C.onDone = onDone || (opt && opt.onDone) || null;   // 5번째 인자든 opt.onDone 이든 받는다
  C.stage = !!(opt && opt.stage);
  C.onCropped = (opt && opt.onCropped) || null;
  startCrop(file, opt);
}

async function uploadCenter() {
  if (!E.draft) return;
  try {
    const pid = uploadId();
    const vid = E.draft.variations[E.vIdx].id;
    const res = await apiUpload(pid, vid, C.slot, await uploadBytes(), null);
    await commitUpload(res);
  } catch (e) { toast("업로드 실패: " + e.message); }
}

export function bindCrop() {
  const stage = $("#crop-stage");
  let dragging = false, sx = 0, sy = 0, scx = 0.5, scy = 0.5;

  stage.addEventListener("pointerdown", (e) => {
    if (!C.base) return;
    dragging = true; sx = e.clientX; sy = e.clientY; scx = C.cx; scy = C.cy;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragging || !C.base) return;
    const { W, H } = stageSize();
    const b = bbox();
    const s = scaleFor(W, H, b);
    C.cx = scx - (e.clientX - sx) / (b.w * s);
    C.cy = scy - (e.clientY - sy) / (b.h * s);
    paint();
  });
  const stop = () => (dragging = false);
  stage.addEventListener("pointerup", stop);
  stage.addEventListener("pointercancel", stop);

  $("#crop-zoom").addEventListener("input", (e) => {
    C.z = Number(e.target.value) / 100;
    paint();
  });

  /* 회전 — 슬라이더를 없앴다. 드래그하는 동안 계속 다시 그리면 이 맥(Retina)에서는 브라우저가
     따라오지 못해 값이 튄다. 버튼·숫자는 한 번에 한 번만 그리므로 구조적으로 튈 수가 없다.
     · ⟲/⟳ 90° : 통째로 돌리기(세로 사진 바로 세우기)
     · ±0.1°/±1° + 각도 입력 : 미세 보정(직접 입력도 가능) */
  const rotNum = $("#crop-rot-num");
  const setRot = (deg) => {
    // -180 ~ 180 으로 정리 (181 → -179)
    let d = Number(deg) || 0;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    d = Math.round(d * 10) / 10;                 // 0.1도 단위
    C.rot = d;
    if (rotNum) rotNum.value = String(d);
    paint();
  };
  const step = (delta) => () => setRot(C.rot + delta);
  const wire = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  wire("#crop-rot-ccw", () => setRot(C.rot - 90));
  wire("#crop-rot-cw", () => setRot(C.rot + 90));
  wire("#crop-rot-dec1", step(-1));
  wire("#crop-rot-dec01", step(-0.1));
  wire("#crop-rot-inc01", step(0.1));
  wire("#crop-rot-inc1", step(1));
  wire("#crop-rot-reset", () => setRot(0));
  if (rotNum) {
    rotNum.addEventListener("change", () => setRot(rotNum.value));
    rotNum.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); setRot(rotNum.value); }
      if (e.key === "ArrowUp") { e.preventDefault(); setRot(C.rot + (e.shiftKey ? 1 : 0.1)); }
      if (e.key === "ArrowDown") { e.preventDefault(); setRot(C.rot - (e.shiftKey ? 1 : 0.1)); }
    });
  }

  window.addEventListener("resize", () => {
    if ($("#crop-modal").classList.contains("on")) paint();
  });
  $("#crop-cancel").onclick = $("#crop-cancel2").onclick = () => $("#crop-modal").classList.remove("on");
  $("#crop-ok").onclick = async () => {
    const rect = cropRect();
    $("#crop-ok").disabled = true; $("#crop-ok").textContent = "업로드 중…";
    try {
      if (C.stage) {                       // 새 시편: 지금은 담아 두고 저장할 때 올린다
        const file = await uploadBytes();
        const preview = C.base ? await renderPreview(rect) : "";   // 담긴 사진도 확대·위치까지 반영해 보여 준다
        $("#crop-modal").classList.remove("on");
        const cb = C.onCropped; C.onCropped = null; C.stage = false;
        if (cb) cb(file, rect, preview);
        return;
      }
      const pid = uploadId();
      const vid = E.draft.variations[E.vIdx].id;
      const res = await apiUpload(pid, vid, C.slot, await uploadBytes(), rect);
      $("#crop-modal").classList.remove("on");
      await commitUpload(res);
    } catch (e) {
      toast("업로드 실패: " + e.message);
    } finally {
      $("#crop-ok").disabled = false; $("#crop-ok").textContent = "이 이미지 사용";
    }
  };
}
