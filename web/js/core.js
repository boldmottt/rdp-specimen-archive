/* RDP 시편 아카이브 — 공통 유틸 · 앱 상태 · 서버 API · 데이터 헬퍼 */

export const $ = (s, r) => (r || document).querySelector(s);
export const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 안전한 HTML 조립: html`<b>${값}</b>`은 값을 자동으로 이스케이프한다 (esc를 빠뜨려도 안전).
// 이미 만들어진 HTML 조각은 raw()로 감싸 그대로 넣고, 배열은 이어 붙인다. null·undefined·false는 빈칸.
class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new SafeHtml(s == null ? "" : String(s));
const part = (v) => (v instanceof SafeHtml ? v.s : Array.isArray(v) ? v.map(part).join("")
  : v == null || v === false ? "" : esc(v));
export const html = (strings, ...vals) => new SafeHtml(strings.reduce((a, s, i) => a + s + (i < vals.length ? part(vals[i]) : ""), ""));
export const dash = (v) => (v == null || v === "" || v === "-" ? "—" : v);
export const fmtDate = (d) => (d ? String(d).replace(/-/g, ".") : "—");
export const todayLocal = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
export const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = (p) => p + Math.random().toString(36).slice(2, 6);

export const RESULT_LABEL = { ok: "✅ 합격", warn: "⚠️ 조정", ng: "❌ NG", plan: "⏳ 예정", "": "—" };

export const App = {
  patterns: [],
  inkCatalog: null, inkCatalogError: "",
  config: {},
  q: "", project: "all", sort: "recent",
  cart: [],
  prop: { title: "RDP 패턴 제안", client: "", date: "", by: "", comments: {}, showMix: false, showComments: false, note: "", inkTags: [] },
  edit: null,
  meeting: false,
  view: "catalog",
};

const LS_CART = "rdp2-cart";
const LS_PROP = "rdp2-prop";

export function loadLS() {
  try { App.cart = JSON.parse(localStorage.getItem(LS_CART)) || []; } catch (e) { App.cart = []; }
  try { App.prop = Object.assign(App.prop, JSON.parse(localStorage.getItem(LS_PROP)) || {}); } catch (e) {}
  try { App.meeting = !!JSON.parse(localStorage.getItem("rdp2-meeting") || "false"); } catch (e) {}
}
let uiTimer = null;
export function saveLS() {
  try { localStorage.setItem(LS_CART, JSON.stringify(App.cart)); } catch (e) {}
  try { localStorage.setItem(LS_PROP, JSON.stringify(App.prop)); } catch (e) {}
  try { localStorage.setItem("rdp2-meeting", JSON.stringify(!!App.meeting)); } catch (e) {}
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    fetch("/api/ui", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart: App.cart, prop: App.prop, ts: (App.prop.ts = Date.now()) }),
    }).catch(() => {});
  }, 400);
}

/* ---------------- api ---------------- */
export async function apiGet(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export function colorNameFor(code) {
  const key = String(code || "").trim().toUpperCase();
  if (!key) return "";
  for (const p of App.patterns) {
    for (const v of (p.variations || [])) {
      const cc = String(v.colorCode || "").trim().toUpperCase();
      const nm = String(v.colorName || "").trim();
      if (cc === key && nm) return nm;
    }
  }
  return "";
}

export function deriveId(project, code) {
  let x = `${project || ""}-${code || ""}`;
  x = x.replace(/[^\w.-]+/g, "-").replace(/-{2,}/g, "-");
  x = x.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
  return x.slice(0, 80);
}

export async function apiPost(path, body, rev) {
  const headers = { "Content-Type": "application/json" };
  if (rev) headers["X-Base-Rev"] = rev;
  const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const err = new Error(j.error || "요청 실패");
    err.status = r.status; err.payload = j; throw err;
  }
  return j;
}

export async function apiPut(path, body, rev, create, renameFrom) {
  const headers = { "Content-Type": "application/json" };
  if (rev) headers["X-Base-Rev"] = rev;
  if (create) headers["X-Create"] = "1";
  if (renameFrom) headers["X-Rename-From"] = renameFrom;
  const r = await fetch(path, { method: "PUT", headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409) {
    const err = new Error(j.message || "다른 곳에서 먼저 저장되었습니다");
    err.status = 409; err.payload = j; throw err;
  }
  if (!r.ok || j.ok === false) throw new Error((j.errors || [j.error || "저장 실패"]).join(", "));
  return j;
}
export async function apiDelete(path, rev) {
  const r = await fetch(path, { method: "DELETE", headers: rev ? { "X-Base-Rev": rev } : {} });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || "삭제 실패");
  return j;
}
export async function apiUpload(pid, vid, slot, blob, crop) {
  const q = crop ? `?slot=${slot}&x=${crop.x}&y=${crop.y}&w=${crop.w}&h=${crop.h}` : `?slot=${slot}`;
  const r = await fetch(`/api/image/${encodeURIComponent(pid)}/${encodeURIComponent(vid)}${q}`, {
    method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || "업로드 실패");
  return j;
}

/* ---------------- helpers ---------------- */
export const byId = (pid) => App.patterns.find((p) => p.id === pid);
// 서버 충돌 검사용 버전 (rev가 없는 예전 파일은 updatedAt)
export const revOf = (p) => (p && (p.rev || p.updatedAt)) || "";
export const markSaved = (doc, r) => { if (r.savedAt) doc.updatedAt = r.savedAt; if (r.rev) doc.rev = r.rev; return doc; };
export const varOf = (p, vid) => (p ? (p.variations || []).find((v) => v.id === vid) || (p.variations || [])[0] : null);
export const imgUrl = (pid, name) => `/img/${encodeURIComponent(pid)}/${encodeURIComponent(name)}`;
export const thumbUrl = (pid, name, w) => `/api/thumb/${encodeURIComponent(pid)}/${encodeURIComponent(name)}?w=${w}`;
export const vName = (v) => (v && (v.colorName || v.colorCode)) || "기본";
export const vImg = (pid, v) => (v && v.images && v.images.length ? imgUrl(pid, v.images[0]) : "");
const mixCount = (p, v) => (v && v.mixes ? v.mixes.length : 0);
export const layers = (v) => Array.from(new Set((v && v.mixes ? v.mixes : []).map((m) => m.layer).filter(Boolean)))
  .sort((a, b) => { const na = parseInt(String(a), 10) || 0, nb = parseInt(String(b), 10) || 0; return na - nb; });
export const inCart = (pid, vid) => App.cart.some((c) => c.pid === pid && c.vid === vid);
export function toggleCart(pid, vid) {
  const i = App.cart.findIndex((c) => c.pid === pid && c.vid === vid);
  if (i >= 0) App.cart.splice(i, 1); else App.cart.push({ pid, vid });
  saveLS();
}

const colorCache = new Map();
function avgColor(url) {
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 8;
        const x = c.getContext("2d");
        x.drawImage(im, 0, 0, 8, 8);
        const d = x.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        const col = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
        colorCache.set(url, col); res(col);
      } catch (e) { res(null); }
    };
    im.onerror = () => res(null);
    im.src = url;
  });
}
export function paintDots(root) {
  $$(".vdot[data-src]", root || document).forEach(async (el) => {
    const c = await avgColor(el.dataset.src);
    if (c) el.style.background = c;
  });
}

export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), 1800);
}
