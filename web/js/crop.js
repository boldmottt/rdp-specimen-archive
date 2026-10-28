/* RDP 시편 아카이브 — 이미지 자르기 */
import { $, apiUpload, deriveId, toast } from "./core.js";
import { E, renderDrawer } from "./editor.js";

// 저장 전 새 시편의 사진은 저장할 때 쓸 파일 ID 폴더로 올린다 (편집기 저장과 같은 deriveId)
function uploadId() {
  const id = E.draft.id || deriveId(E.draft.project, E.draft.pattern.code);
  if (!id) throw new Error("먼저 프로젝트와 패턴 코드를 입력하세요 (영문·숫자 포함)");
  return id;
}

/* ---------------- crop ---------------- */
export const C = { file: null, img: null, z: 1, cx: 0.5, cy: 0.5, slot: 1 };

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
  C.z = 1; C.cx = 0.5; C.cy = 0.5;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    C.img = img;
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

async function commitUpload(res) {
  if (!E.draft || !E.draft.variations[E.vIdx]) return;
  const v = E.draft.variations[E.vIdx];
  v.images = v.images || [];
  v.images[C.slot - 1] = res.file;
  v.images = v.images.filter(Boolean);
  renderDrawer();
  toast(res.lowRes ? "저장됨 · 해상도가 낮습니다 (" + res.sourceWidth + "px)" : "이미지 저장됨");
}

async function uploadCenter() {
  if (!E.draft) return;
  try {
    const pid = uploadId();
    const vid = E.draft.variations[E.vIdx].id;
    const res = await apiUpload(pid, vid, C.slot, C.file, null);
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
  window.addEventListener("resize", () => {
    if ($("#crop-modal").classList.contains("on")) layoutCrop();
  });
  $("#crop-cancel").onclick = $("#crop-cancel2").onclick = () => $("#crop-modal").classList.remove("on");
  $("#crop-ok").onclick = async () => {
    const rect = cropRect();
    $("#crop-ok").disabled = true; $("#crop-ok").textContent = "업로드 중…";
    try {
      const pid = uploadId();
      const vid = E.draft.variations[E.vIdx].id;
      const res = await apiUpload(pid, vid, C.slot, C.file, rect);
      $("#crop-modal").classList.remove("on");
      await commitUpload(res);
    } catch (e) {
      toast("업로드 실패: " + e.message);
    } finally {
      $("#crop-ok").disabled = false; $("#crop-ok").textContent = "이 이미지 사용";
    }
  };
}
