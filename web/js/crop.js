/* RDP 시편 아카이브 — 이미지 자르기 */
import { $, apiUpload, deriveId, toast } from "./core.js";
import { E, renderDrawer } from "./editor.js";

// 저장 전 새 시편의 사진은 저장할 때 쓸 파일 ID 폴더로 올린다 (편집기 저장과 같은 deriveId)
function uploadId() {
  const code = String((E.draft.pattern || {}).code || "").trim();
  const id = E.draft.id || deriveId(E.draft.project, code);
  if (!code || !id) throw new Error("먼저 프로젝트와 패턴 코드를 입력하세요 (영문·숫자 포함)");
  return id;
}

/* ---------------- crop ---------------- */
export const C = { file: null, img: null, z: 1, cx: 0.5, cy: 0.5, slot: 1, rot: 0, rotated: null };
// rotated = 회전(확장)한 캔버스. 기울기가 0 이면 null 이고 원본 파일을 그대로 올린다.

function stageSize() {
  const el = $("#crop-stage");
  return { W: el.clientWidth, H: el.clientHeight };
}
function baseScale(W, H) {
  return Math.max(W / C.img.naturalWidth, H / C.img.naturalHeight);
}
function clampC() {
  if (!C.img) return;
  const { W, H } = stageSize();
  if (!W || !H) return;
  const s = baseScale(W, H) * C.z;
  const visW = W / s / C.img.naturalWidth;
  const visH = H / s / C.img.naturalHeight;
  // 중심이 움직일 수 있는 범위 = [보이는 비율/2, 1 − 보이는 비율/2] (저장 단계 cropRect와 같은 범위)
  const mx = Math.min(0.5, visW / 2);
  const my = Math.min(0.5, visH / 2);
  C.cx = Math.min(1 - mx, Math.max(mx, C.cx));
  C.cy = Math.min(1 - my, Math.max(my, C.cy));
}
/**
 * 기울기(도)를 적용해 확장 캔버스를 만든다 — CSS 회전은 캔버스가 커지지 않아 자르기 좌표가 어긋난다.
 * 회전 각도는 시계방향 +, 캔버스 크기는 회전 후 바운딩 박스.
 */
function buildRotated() {
  if (!C.img || !C.rot) { C.rotated = null; return null; }
  const rad = (Math.abs(C.rot) * Math.PI) / 180;
  const base = C.base || C.img;
  const w = base.naturalWidth, h = base.naturalHeight;
  const W = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
  const H = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";                     // 회전으로 생기는 빈 모서리는 흰색(인쇄 배경과 같게)
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate((C.rot * Math.PI) / 180);
  ctx.drawImage(base, -w / 2, -h / 2);
  C.rotated = cv;
  return cv;
}

function layoutCrop() {
  if (!C.img) return;
  const { W, H } = stageSize();
  if (!W || !H) return;
  clampC();
  const s = baseScale(W, H) * C.z;
  const dw = C.img.naturalWidth * s, dh = C.img.naturalHeight * s;
  const left = W / 2 - C.cx * dw;
  const top = H / 2 - C.cy * dh;
  const el = $("#crop-img");
  el.style.width = dw + "px";
  el.style.height = dh + "px";
  el.style.transform = `translate(${left}px, ${top}px)`;
}
function cropRect() {
  const { W, H } = stageSize();
  const s = baseScale(W, H) * C.z;
  const sw = W / s, sh = H / s;
  const iw = C.img.naturalWidth, ih = C.img.naturalHeight;
  let x = C.cx * iw - sw / 2;
  let y = C.cy * ih - sh / 2;
  x = Math.max(0, Math.min(x, Math.max(0, iw - sw)));
  y = Math.max(0, Math.min(y, Math.max(0, ih - sh)));
  return { x, y, w: Math.min(sw, iw), h: Math.min(sh, ih) };
}

export function startCrop(file, opt) {
  C.file = file; C.slot = (opt && opt.slot) || 1;
  C.z = 1; C.cx = 0.5; C.cy = 0.5; C.rot = 0; C.rotated = null;
  const rotEl = document.querySelector("#crop-rot");
  if (rotEl) rotEl.value = 0;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    C.img = img; C.base = img;
    $("#crop-img").src = url;
    $("#crop-modal").classList.add("on");
    $("#crop-zoom").value = 100;
    $("#crop-info").textContent = `원본 ${img.naturalWidth}×${img.naturalHeight}`;
    requestAnimationFrame(layoutCrop);
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
  if (!C.rot || !C.rotated) return Promise.resolve(C.file);
  return new Promise((resolve) => {
    C.rotated.toBlob((b) => resolve(new File([b], "rotated.jpg", { type: "image/jpeg" })), "image/jpeg", 0.95);
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
    if (!C.img) return;
    dragging = true; sx = e.clientX; sy = e.clientY; scx = C.cx; scy = C.cy;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragging || !C.img) return;
    const { W, H } = stageSize();
    const s = baseScale(W, H) * C.z;
    const dw = C.img.naturalWidth * s, dh = C.img.naturalHeight * s;
    C.cx = scx - (e.clientX - sx) / dw;
    C.cy = scy - (e.clientY - sy) / dh;
    layoutCrop();
  });
  const stop = () => (dragging = false);
  stage.addEventListener("pointerup", stop);
  stage.addEventListener("pointercancel", stop);
  $("#crop-zoom").addEventListener("input", (e) => {
    C.z = Number(e.target.value) / 100;
    layoutCrop();
  });
  // 기울기 — 회전한 캔버스를 새 '지금 이미지'로 삼는다(확대·이동 계산은 그대로 재사용)
  const rotInput = $("#crop-rot");
  const resetRot = () => { if (rotInput) rotInput.value = 0; applyRot(0); };
  const rotReset = $("#crop-rot-reset");
  if (rotReset) rotReset.onclick = resetRot;
  if (rotInput) rotInput.addEventListener("input", (e) => applyRot(Number(e.target.value)));
  function applyRot(deg) {
    if (!C.img) return;
    C.rot = deg || 0;
    const cv = buildRotated();
    if (cv) {
      const url = cv.toDataURL("image/jpeg", 0.95);
      const img = new Image();
      img.onload = () => {
        C.img = img;                      // 회전본을 기준 이미지로 (naturalWidth = 회전 캔버스 폭)
        $("#crop-img").src = url;
        C.z = Math.max(1, Math.min(4, Number($("#crop-zoom").value) / 100));
        layoutCrop();
        const info = $("#crop-info");
        if (info) info.textContent = `기울기 ${C.rot}° · 원본 ${img.naturalWidth}×${img.naturalHeight}`;
      };
      img.src = url;
    } else {
      // 0° — 회전 전 원본으로 되돌린다
      const base = C.base || C.img;
      const src = base.src || URL.createObjectURL(C.file);
      const img = new Image();
      img.onload = () => {
        C.img = img;
        $("#crop-img").src = src;
        C.z = Math.max(1, Math.min(4, Number($("#crop-zoom").value) / 100));
        layoutCrop();
        const info2 = $("#crop-info");
        if (info2) info2.textContent = `원본 ${img.naturalWidth}×${img.naturalHeight}`;
      };
      img.src = src;
    }
  }
  window.addEventListener("resize", () => {
    if ($("#crop-modal").classList.contains("on")) layoutCrop();
  });
  $("#crop-cancel").onclick = $("#crop-cancel2").onclick = () => $("#crop-modal").classList.remove("on");
  $("#crop-ok").onclick = async () => {
    const rect = cropRect();
    $("#crop-ok").disabled = true; $("#crop-ok").textContent = "업로드 중…";
    try {
      if (C.stage) {                       // 새 시편: 지금은 담아 두고 저장할 때 올린다
        const file = await uploadBytes();
        $("#crop-modal").classList.remove("on");
        const cb = C.onCropped; C.onCropped = null; C.stage = false;
        if (cb) cb(file, rect);
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
