/* 컬러연구소 — 측색 라이브러리 · 색 예측 · 배합 추천 · 보정 추천 */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MATTING = "소광제";
  const SURFACES = ["경면", "패브릭엠보", "엠보사출", "무도장", "기타"];
  const MEAS = [["solid", "은폐 도막 (꾸덕하게 바른 것)"], ["white_bg", "바탕 A (흰 카드 등)"], ["on_white", "바탕 A + 잉크"], ["black_bg", "바탕 B (검정 카드 등)"], ["on_black", "바탕 B + 잉크"]];
  const REGION = { substrate: "바탕", layer1: "1도", layer2: "2도 단독", overlap: "1도 + 2도 겹침", average: "면적 평균 (측색기 시야)" };

  const S = {
    lib: null, info: null, rev: "", edit: null, dirty: false, prof: {},
    mode: load("cl.mode") === "sce" ? "sce" : "sci",
    f: {}, res: {},
  };

  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function keep(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 화면은 동작 */ } }

  // ------------------------------------------------------------------ 서버
  async function api(method, path, body, headers) {
    const r = await fetch(path, {
      method, headers: { "Content-Type": "application/json", ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch (e) { /* 빈 응답 */ }
    if (!r.ok || j.ok === false) {
      const err = new Error(j.error || j.message || `HTTP ${r.status}`);
      err.status = r.status; err.body = j;
      throw err;
    }
    return j;
  }

  async function loadLibrary() {
    const j = await api("GET", "/api/lab/library");
    S.lib = j.library; S.info = j.info; S.rev = j.library.updatedAt || "";
    S.edit = clone(S.lib); S.dirty = false;
    status();
  }

  function status() {
    const L = S.lib || {};
    const n = (L.inks || []).length, s = (L.substrates || []).length, p = (L.plates || []).length;
    $("#status").innerHTML = `라이브러리: 잉크 <b>${n}</b> · 도장 시편 <b>${s}</b> · 동판 <b>${p}</b>`
      + (L.updatedAt ? ` · 저장 ${esc(L.updatedAt.replace("T", " "))}` : " · <span class=\"bad\">아직 저장된 라이브러리가 없습니다</span>")
      + (S.dirty ? ` · <span class="bad">저장 안 한 변경 있음</span>` : "");
  }

  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg; t.className = "cl-toast on" + (bad ? " bad" : "");
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = "cl-toast"), 2600);
  }

  const clone = (o) => JSON.parse(JSON.stringify(o ?? null));

  // ------------------------------------------------------------------ 색 (화면 견본용)
  function labToHex(lab) {
    if (!lab) return "";
    const [L, a, b] = lab;
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const d = 6 / 29, inv = (t) => (t > d ? t ** 3 : 3 * d * d * (t - 4 / 29));
    const X = 0.95047 * inv(fx), Y = inv(fy), Z = 1.08883 * inv(fz);
    const lin = [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
    return "#" + lin.map((c) => {
      c = Math.min(1, Math.max(0, c));
      c = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(c * 255).toString(16).padStart(2, "0");
    }).join("");
  }

  // "52.1 -0.8 3.4" / "52.1, -0.8, 3.4" / 엑셀 한 줄 → [L,a,b]
  function parseLab(text) {
    const t = String(text ?? "").trim();
    if (!t) return null;
    const n = t.split(/[\s,;/]+/).filter(Boolean).map(Number);
    if (n.length !== 3 || n.some((x) => !Number.isFinite(x))) return { error: "L a b 세 숫자를 적어 주세요" };
    if (n[0] < 0 || n[0] > 100) return { error: "L은 0~100" };
    return n;
  }
  const labStr = (lab) => (lab ? lab.map((x) => (+x).toFixed(2)).join("  ") : "");

  // 분광 → LAB (D65 · 2°, 400~700 nm 10 nm — 서버 colormath와 같은 표). 단위 판단·미리보기용
  const CMF = [[0.01431, 0.000396, 0.06785], [0.04351, 0.00121, 0.2074], [0.13438, 0.004, 0.6456], [0.2839, 0.0116, 1.3856],
    [0.34828, 0.023, 1.74706], [0.3362, 0.038, 1.77211], [0.2908, 0.06, 1.6692], [0.19536, 0.09098, 1.28764], [0.09564, 0.13902, 0.81295],
    [0.03201, 0.20802, 0.46518], [0.0049, 0.323, 0.272], [0.0093, 0.503, 0.1582], [0.06327, 0.71, 0.07825], [0.1655, 0.862, 0.04216],
    [0.2904, 0.954, 0.0203], [0.43345, 0.99495, 0.00875], [0.5945, 0.995, 0.0039], [0.7621, 0.952, 0.0021], [0.9163, 0.87, 0.00165],
    [1.0263, 0.757, 0.0011], [1.0622, 0.631, 0.0008], [1.0026, 0.503, 0.00034], [0.85445, 0.381, 0.00019], [0.6424, 0.265, 0.00005],
    [0.4479, 0.175, 0.00002], [0.2835, 0.107, 0], [0.1649, 0.061, 0], [0.0874, 0.032, 0], [0.04677, 0.017, 0], [0.0227, 0.00821, 0], [0.011359, 0.004102, 0]];
  const D65 = [82.7549, 91.486, 93.4318, 86.6823, 104.865, 117.008, 117.812, 114.861, 115.923, 108.811, 109.354, 107.802, 104.79, 107.689,
    104.405, 104.046, 100, 96.3342, 95.788, 88.6856, 90.0062, 89.5991, 87.6987, 83.2886, 83.6992, 80.0268, 80.2146, 82.2778, 78.2842, 69.7213, 71.6091];
  function specLab(r) {
    const xyz = [0, 1, 2].map((c) => r.reduce((a, v, i) => a + v * D65[i] * CMF[i][c], 0));
    const wp = [0, 1, 2].map((c) => D65.reduce((a, v, i) => a + v * CMF[i][c], 0));
    const f = (t) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
    const [fx, fy, fz] = xyz.map((v, c) => f(v / wp[c]));
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // 분광 붙여넣기: 31개(400~700 nm) · 39개(360~740) · 41개(380~780) · 36개(380~730) · 파장+값 두 열
  //   unit: "auto" | "pct" | "frac". 자동이면 1.5보다 큰 값이 있을 때 %, 아니면 같은 칸의 LAB에 가까운 쪽
  //   (아주 어두운 색을 %로 내보내면 값이 모두 1.5 이하라 모양만으로는 0~1과 구별이 안 된다)
  function parseSpec(text, unit = "auto", lab = null) {
    const t = String(text ?? "").trim();
    if (!t) return null;
    const nums = t.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (nums.some((x) => !Number.isFinite(x))) return { error: "숫자가 아닌 값이 있습니다" };
    let vals = null;
    if (nums.length >= 62 && nums.length % 2 === 0) {
      const wl = nums.filter((_, i) => i % 2 === 0), v = nums.filter((_, i) => i % 2 === 1);
      if (wl.every((w, i) => w >= 300 && w <= 800 && (i === 0 || w > wl[i - 1]))) {
        const m = new Map(wl.map((w, i) => [Math.round(w), v[i]]));
        const want = Array.from({ length: 31 }, (_, i) => 400 + 10 * i);
        if (want.every((w) => m.has(w))) vals = want.map((w) => m.get(w));
        else return { error: "400~700 nm를 10 nm 간격으로 모두 담고 있지 않습니다" };
      }
    }
    if (!vals) {
      const cut = { 31: 0, 39: 4, 41: 2, 36: 2 }[nums.length];
      if (cut === undefined) return { error: `값 ${nums.length}개 — 400~700 nm 10 nm 간격 31개가 필요합니다 (360~740·380~780도 받음)` };
      vals = nums.slice(cut, cut + 31);
    }
    let pct = unit === "pct" || (unit === "auto" && Math.max(...vals) > 1.5);
    let how = unit === "auto" ? (pct ? "%로 읽음 (1.5보다 큰 값)" : "0~1로 읽음") : unit === "pct" ? "%" : "0~1";
    if (unit === "auto" && !pct && Array.isArray(lab) && Math.max(...vals) > 0) {
      const asPct = vals.map((x) => x / 100);
      if (dist(specLab(asPct), lab) < dist(specLab(vals), lab)) { pct = true; how = "%로 읽음 (같은 칸의 LAB와 맞는 쪽)"; }
      else how = "0~1로 읽음 (같은 칸의 LAB와 맞는 쪽)";
    }
    if (pct) vals = vals.map((x) => x / 100);
    vals = vals.map((x) => Math.round(x * 1e5) / 1e5);
    return { vals, how, lab: specLab(vals) };
  }

  // ------------------------------------------------------------------ 입력 도우미 (값은 S.f[탭][키]에 보관)
  const F = () => (S.f[S.tab] = S.f[S.tab] || {});
  const val = (k, d = "") => (F()[k] ?? d);

  function labField(k, label, hint) {
    const v = val(k);
    const p = parseLab(v);
    const ok = Array.isArray(p);
    return `<label class="cl-f"><span>${esc(label)}${hint ? ` <em>${esc(hint)}</em>` : ""}</span>
      <div class="cl-lab"><i class="cl-sw" data-sw="${esc(k)}" style="background:${ok ? labToHex(p) : "transparent"}"></i>
      <input data-k="${esc(k)}" data-lab="1" value="${esc(v)}" placeholder="L  a  b   (예: 52.1 -0.8 3.4)" autocomplete="off"></div></label>`;
  }

  function subField(k, label = "바탕 (도장 시편)") {
    const subs = (S.info && S.info.substrates) || [];
    const ref = val(`${k}.ref`, subs[0] ? subs[0].ref : "__direct");
    const opts = subs.map((s) => `<option value="${esc(s.ref)}"${s.ref === ref ? " selected" : ""}>${esc(s.ref)}${s.swatch ? ` — L ${s.swatch.lab[0]}` : ""}</option>`).join("");
    return `<label class="cl-f"><span>${esc(label)}</span>
      <select data-k="${esc(k)}.ref" data-re="1">${opts}<option value="__direct"${ref === "__direct" ? " selected" : ""}>직접 입력 (LAB)</option></select></label>
      ${ref === "__direct" ? labField(`${k}.lab`, `바탕 LAB`, `지금 ${S.mode.toUpperCase()} 값`) : ""}`;
  }

  function plateField(k) {
    const plates = (S.lib && S.lib.plates) || [];
    const v = val(k);
    return `<label class="cl-f"><span>동판 <em>막두께 계수</em></span><select data-k="${esc(k)}" data-plate="1">
      <option value="">기본 (×1.00)</option>
      ${plates.map((p) => {
        const inf = S.info && S.info.plates && S.info.plates[p.lot];
        const th = inf ? +inf.thickness : (p.thickness != null && p.thickness !== "" ? +p.thickness : NaN);
        return `<option value="${esc(p.lot)}"${p.lot === v ? " selected" : ""}>${esc(p.lot)} (${Number.isFinite(th) ? `×${th.toFixed(2)}` : "막두께 저장 후 확인"})</option>`;
      }).join("")}
    </select></label>`;
  }

  function recipeField(k, label, d = {}) {
    return `<div class="cl-recipe"><label class="cl-f wide"><span>${esc(label)} <em>잉크 g — 예: WH 20, YE 6, RD 3</em></span>
      <input data-k="${esc(k)}.inks" value="${esc(val(`${k}.inks`, d.inks || ""))}" placeholder="잉크 g (쉼표로 구분)" autocomplete="off"></label>
      <div class="cl-pcts">
        <label class="cl-f sm"><span>소광제 %</span><input data-k="${esc(k)}.mat" type="number" step="0.1" min="0" value="${esc(val(`${k}.mat`, d.mat ?? 0))}"></label>
        <label class="cl-f sm"><span>신나 %</span><input data-k="${esc(k)}.thin" type="number" step="1" min="0" value="${esc(val(`${k}.thin`, d.thin ?? 30))}"></label>
        <label class="cl-f sm"><span>경화제 %</span><input data-k="${esc(k)}.hard" type="number" step="1" min="0" value="${esc(val(`${k}.hard`, d.hard ?? 20))}"></label>
      </div></div>`;
  }

  // "WH 20, 9:1실버(2000) 50 + BK 10" → {WH:20, "9:1실버(2000)":50, BK:10} (마지막 숫자가 g)
  function parseInks(text) {
    const out = {}, bad = [];
    String(text || "").split(/[,\n+]+/).map((x) => x.trim()).filter(Boolean).forEach((chunk) => {
      const m = chunk.match(/^(.*\S)\s+(-?\d+(?:\.\d+)?)\s*g?$/i);
      if (!m || !(+m[2] > 0)) { bad.push(chunk); return; }
      out[m[1]] = (out[m[1]] || 0) + +m[2];
    });
    return { inks: out, bad };
  }

  function getRecipe(k, need = true) {
    const { inks, bad } = parseInks(val(`${k}.inks`));
    if (bad.length) throw new Error(`배합을 읽지 못함: ${bad.join(" / ")} — "이름 숫자" 형식으로`);
    const tot = Object.values(inks).reduce((a, b) => a + b, 0);
    if (!tot) { if (need) throw new Error("배합(잉크 g)을 적어 주세요"); return null; }
    const pct = (x) => Math.max(0, +val(`${k}.${x}`, { mat: 0, thin: 30, hard: 20 }[x]) || 0);
    return { inks, matting: { g: tot * pct("mat") / 100 }, thinner: { g: tot * pct("thin") / 100 }, hardener: { g: tot * pct("hard") / 100 } };
  }

  function getLab(k, need, label) {
    const p = parseLab(val(k));
    if (!p) { if (need) throw new Error(`${label}: LAB를 적어 주세요`); return null; }
    if (p.error) throw new Error(`${label}: ${p.error}`);
    return p;
  }

  // 분광 입력 칸 (선택) — 붙여 넣은 글자를 그대로 두고, 계산할 때 31개로 읽는다
  const specField = (k, label, hint) => `<label class="cl-f wide"><span>${esc(label)}${hint ? ` <em>${esc(hint)}</em>` : ""}</span>
      <textarea data-k="${esc(k)}" rows="2" placeholder="400~700 nm 반사율 (% 또는 0~1) — 측색기에서 붙여 넣기">${esc(val(k))}</textarea></label>`;
  function getSpec(k, lab) {
    const t = val(k);
    if (!String(t || "").trim()) return null;
    const r = parseSpec(t, "auto", lab);
    if (r.error) throw new Error(`분광: ${r.error}`);
    return r.vals;
  }
  // 3채널 근사일 때: 이 라이브러리로 전사 시료를 예측한 실제 오차
  function accuracyBox(r) {
    if (r.space === "spec" || !r.accuracy) return "";
    const a = r.accuracy;
    const bits = [a.single != null ? `단독 잉크 ${a.single_n}개 평균 ΔE ${a.single.toFixed(2)}` : "", a.mix != null ? `혼합·2도 ${a.mix_n}개 평균 ΔE ${a.mix.toFixed(2)}` : ""].filter(Boolean);
    return `<p class="cl-empty">⚠ <b>3채널 근사 (LAB만)</b> — 잉크를 섞으면 실제와 수 ΔE 다를 수 있어요. 이 결과는 <b>출발점</b>으로 쓰고, 찍어 본 뒤 <a href="#/correct">보정 추천</a>으로 맞추세요.
      ${bits.length ? `<br>이 라이브러리로 전사 시료를 예측한 오차: ${bits.join(" · ")} (보정에 쓴 시료 포함이라 실제보다 좋게 나올 수 있음 — 검증용 시료로 확인)` : "<br>전사 시료가 없어 실제 오차를 아직 몰라요."}
      잉크·바탕에 분광을 넣으면 분광 계산으로 바뀝니다.</p>`;
  }
  const weighLine = (w) => {
    const e = Object.entries(w || {});
    if (!e.length) return "";
    const hot = e.some(([, v]) => v >= 0.3);
    return `<small class="${hot ? "bad" : "cl-note"}">계량 민감도 (0.1 g 잘못 달면): ${e.map(([k, v]) => `${esc(k)} ΔE ${v.toFixed(2)}${v >= 0.3 ? " ⚠" : ""}`).join(" · ")}${hot ? " — 양을 늘려 만들거나 정밀 저울을 쓰세요" : ""}</small>`;
  };
  const metaTable = (rows) => rows && rows.length ? `<table class="cl-table narrow"><tr><th>조명</th><th>기준</th><th>비교</th><th>ΔE00</th></tr>
      ${rows.map((m) => `<tr><td>${esc(m.label)}</td><td class="mono">${labStr(m.a)}</td><td class="mono">${labStr(m.b)}</td><td class="${deClass(m.dE)}">${m.dE.toFixed(2)}</td></tr>`).join("")}</table>
      <p class="cl-note">D65에서 같아도 A(백열등)·F11(매장 조명)에서 ΔE가 크면 메타메리즘 — 조명에 따라 다른 색으로 보입니다.</p>` : "";
  const altLine = (v) => (v.alt ? `<small class="cl-note">A ${labStr(v.alt.A)}<br>F11 ${labStr(v.alt.F11)}</small>` : "");

  // 잰 자리의 설계 망점 % (빈칸·100 = 솔리드)
  const toneField = () => `<label class="cl-f sm"><span>잰 자리 망점 % <em>솔리드=100</em></span><input data-k="tone" type="number" step="1" min="1" max="100" value="${esc(val("tone", 100))}"></label>`;
  function getTone() {
    const v = val("tone", 100);
    if (v === "") return 100;
    if (!(+v > 0 && +v <= 100)) throw new Error("망점 %는 1~100");
    return +v;
  }

  function getSub(k) {
    const ref = val(`${k}.ref`, ((S.info && S.info.substrates) || [])[0]?.ref || "__direct");
    if (ref !== "__direct") return ref;
    return { [S.mode]: getLab(`${k}.lab`, true, "바탕") };
  }

  function bindFields(root, rerender) {
    $$("[data-k]", root).forEach((el) => {
      const k = el.dataset.k;
      const save = () => {
        F()[k] = el.type === "checkbox" ? el.checked : el.value;
        if (el.dataset.lab) {
          const p = parseLab(el.value);
          const sw = $(`[data-sw="${CSS.escape(k)}"]`, root);
          if (sw) sw.style.background = Array.isArray(p) ? labToHex(p) : "transparent";
          el.classList.toggle("bad", !!(p && p.error));
        }
      };
      el.addEventListener("input", save);
      el.addEventListener("change", () => {
        save();
        if (el.dataset.plate) onPlate(el.value);
        if (el.dataset.re) rerender();
      });
    });
  }

  // 동판을 고르면 그 동판의 면적률로 채운다
  function onPlate(lot) {
    const p = ((S.lib && S.lib.plates) || []).find((x) => x.lot === lot);
    if (!p || S.tab !== "predict") return;
    const c = p.coverage || {};
    if (c["1도"] != null) F().cov1 = String(Math.round(c["1도"] * 1000) / 10);
    if (c["2도"] != null) F().cov2 = String(Math.round(c["2도"] * 1000) / 10);
    render();
  }

  // ------------------------------------------------------------------ 결과 조각
  const sw = (hex, big) => `<i class="cl-sw${big ? " big" : ""}" style="background:${esc(hex)}"></i>`;
  const inkText = (inks) => Object.entries(inks || {}).map(([k, v]) => `${k} ${(+v).toFixed(1).replace(/\.0$/, "")}`).join(" · ");

  function yamlName(n) { return /^[A-Za-z0-9_-]+$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`; }
  const r1 = (x) => Math.round(x * 10) / 10;

  // 작업일지 v3 batches 한 줄 (합계 = 잉크 + 소광제 + 신나 + 경화제)
  function batchYaml(layer, inks, pct) {
    const tot = Object.values(inks).reduce((a, b) => a + b, 0);
    const part = (key, p) => (p ? `, ${key}: {g: ${r1(tot * p / 100)}, pct: ${p}}` : "");
    const total = tot * (1 + (pct.mat + pct.thin + pct.hard) / 100);
    return `- {layer: ${layer}, code: '?', inks: {${Object.entries(inks).map(([k, v]) => `${yamlName(k)}: ${r1(v)}`).join(", ")}}${part("matting", pct.mat)}${part("thinner", pct.thin)}${part("hardener", pct.hard)}, total: ${r1(total)}}`;
  }

  function pctOf(k) {
    return { mat: +val(`${k}.mat`, 0) || 0, thin: +val(`${k}.thin`, 30) || 0, hard: +val(`${k}.hard`, 20) || 0 };
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("복사했습니다 — 작업일지 batches에 붙여 넣고 code만 바꾸세요"); }
    catch (e) { window.prompt("복사해서 쓰세요", text); }
  }

  function noteBox(r) {
    const space = SPACE_LABEL[r.space] || r.space;
    const pi = r.plate_info;
    const bits = [r.mode.toUpperCase(), space];
    if (r.plate) bits.push(`막두께 ×${(+r.plate).toFixed(2)}${pi ? ` (${pi.thickness_src})` : ""}`);
    if (pi && pi.gain_src !== "퍼짐 없음") bits.push(`50% 망점 → ${r1(pi.dot50 * 100)}% (${pi.gain_src})`);
    const prof = Object.entries(r.sources || {}).filter(([, v]) => v === "profile").map(([k]) => k);
    if (prof.length) bits.push(`보정 프로필: ${prof.join(", ")}`);
    const tone = r.average && r.average.tone;
    if (tone) bits.push(Object.entries(tone).map(([k, [d, e]]) => `${k} 망점 ${r1(d * 100)}% → 실효 ${r1(e * 100)}%`).join(" · "));
    const extra = r.note ? r.note.replace(/^3채널 근사 \((XYZ|sRGB) 기저\) — /, "") : "";
    return `<p class="cl-note">계산: ${bits.map(esc).join(" · ")}${extra ? ` — ${esc(extra)}` : ""}</p>`;
  }

  function needInks() {
    return (S.lib && (S.lib.inks || []).some((i) => !i.clear)) ? "" :
      `<div class="cl-empty">라이브러리에 잉크 측정값이 아직 없습니다. <a href="#/library">측색 라이브러리</a>에 잉크(흰·검정 카드 위 측색값)를 먼저 넣어 주세요.</div>`;
  }

  async function run(btn, fn) {
    const out = $("#out");
    btn.disabled = true; const t = btn.textContent; btn.textContent = "계산 중…";
    try { await fn(out); }
    catch (e) { out.innerHTML = `<div class="cl-err">${esc(e.message)}</div>`; }
    finally { btn.disabled = false; btn.textContent = t; }
  }

  // ------------------------------------------------------------------ 탭: 색 예측
  function viewPredict() {
    const two = !!val("use2", false);
    return `${needInks()}<div class="cl-card"><h2>색 예측 <small>도장 시편 위에 찍었을 때 — 바탕이 비치는 것까지</small></h2>
      <div class="cl-grid">${subField("sub")}${plateField("plate")}</div>
      ${recipeField("l1", "1도 배합")}
      <label class="cl-check"><input type="checkbox" data-k="use2" data-re="1"${two ? " checked" : ""}> 2도도 찍기 (1도 위에 겹침)</label>
      ${two ? recipeField("l2", "2도 배합") : ""}
      <div class="cl-grid">
        <label class="cl-f sm"><span>1도 망점 % <em>빈칸=솔리드</em></span><input data-k="cov1" type="number" step="1" min="0" max="100" value="${esc(val("cov1"))}"></label>
        ${two ? `<label class="cl-f sm"><span>2도 망점 % <em>빈칸=솔리드</em></span><input data-k="cov2" type="number" step="1" min="0" max="100" value="${esc(val("cov2"))}"></label>` : ""}
        ${labField("target", "목표 LAB", "선택 — 있으면 ΔE 표시")}
      </div>
      ${specField("tspec", "목표 분광", "선택 — 분광 계산이면 조명별 차이(메타메리즘)")}
      <div class="cl-actions"><button class="cl-btn" id="go">예측</button></div></div>
      <div id="out">${S.res.predict || ""}</div>`;
  }

  async function goPredict(out) {
    const two = !!val("use2", false);
    const body = { mode: S.mode, substrate: getSub("sub"), plate: val("plate") || null, layer1: getRecipe("l1"), layer2: two ? getRecipe("l2") : null };
    const c1 = val("cov1"), c2 = val("cov2");
    if (c1 !== "" || (two && c2 !== "")) body.coverage = { "1도": c1 === "" ? 1 : (+c1 || 0) / 100, "2도": two ? (c2 === "" ? 1 : (+c2 || 0) / 100) : 0 };
    const t = getLab("target", false, "목표");
    if (t) body.target = t;
    const ts = getSpec("tspec", t);
    if (ts) body.target_spec = ts;
    const r = await api("POST", "/api/lab/predict", body);
    const regs = Object.entries(r.regions).concat(r.average ? [["average", r.average]] : []);
    const yaml = [batchYaml("1도", body.layer1.inks, pctOf("l1"))].concat(two ? [batchYaml("2도", body.layer2.inks, pctOf("l2"))] : []).join("\n");
    S.res.predict = `<div class="cl-card"><h3>예측 결과</h3>
      <div class="cl-swatches">${r.target ? `<div class="cl-tile tgt">${sw(r.target.hex, 1)}<b>목표</b><span>${labStr(r.target.lab)}</span></div>` : ""}
      ${regs.map(([k, v]) => `<div class="cl-tile${k === "average" ? " avg" : ""}">${sw(v.hex, 1)}<b>${esc(REGION[k] || k)}</b><span>${labStr(v.lab)}</span>
        ${v.dE != null ? `${judgeTag(v.judge, v.dE)}<small>${esc(v.diff)}</small>` : ""}${altLine(v)}</div>`).join("")}</div>
      ${r.metamerism ? `<h4>목표 분광과 조명별 차이 <small>메타메리즘</small></h4><table class="cl-table narrow"><tr>${Object.keys(r.metamerism).map((k) => `<th>${esc(k)}</th>`).join("")}</tr>
        <tr>${Object.values(r.metamerism).map((d) => `<td class="${deClass(d)}">ΔE ${d.toFixed(2)}</td>`).join("")}</tr></table>` : ""}
      ${accuracyBox(r)}
      ${noteBox(r)}
      <div class="cl-actions"><button class="cl-btn ghost" data-copy="${esc(yaml)}">일지용 복사 (batches)</button>
      <button class="cl-btn ghost" data-similar="${esc(JSON.stringify((r.average || r.regions.overlap || r.regions.layer1).lab))}">비슷한 과거 사례 찾기</button></div></div>`;
    out.innerHTML = S.res.predict;
    bindResult(out);
  }

  function bindResult(out) {
    $$("[data-copy]", out).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
    $$("[data-tocorrect]", out).forEach((b) => (b.onclick = () => {
      const d = JSON.parse(b.dataset.tocorrect);
      const cf = (S.f.correct = S.f.correct || {});
      cf["cur.inks"] = inkText(d.recipe.inks).replace(/ · /g, ", ");
      Object.assign(cf, { "cur.thin": d.recipe.thinner, "cur.hard": d.recipe.hardener, "cur.mat": d.recipe.matting,
        measured: d.lab.join(" "), target: d.target.join(" "), tone: d.recipe.tone || 100, use_prev: false });
      const refs = ((S.info && S.info.substrates) || []).map((s) => s.ref);
      const ref = d.substrate && (refs.find((r) => r === d.substrate) || refs.find((r) => r.split("@")[0] === String(d.substrate).split("@")[0]));
      if (ref) cf["sub.ref"] = ref;
      if (d.plate && ((S.lib && S.lib.plates) || []).some((p) => p.lot === d.plate)) cf.plate = d.plate;
      S.res.correct = ""; location.hash = "#/correct";
      toast(ref ? "과거 기록을 지금 배합·잰 값으로 넣었어요 — 확인하고 [보정 추천]" : "배합·잰 값을 넣었어요 — 바탕을 골라 주세요", !ref);
    }));
    $$("[data-nexttrial]", out).forEach((b) => (b.onclick = () => {
      const cf = (S.f.correct = S.f.correct || {});
      Object.assign(cf, { "prev.inks": cf["cur.inks"], "prev.thin": cf["cur.thin"], "prev.hard": cf["cur.hard"], "prev.mat": cf["cur.mat"],
        prev_m: cf.measured, use_prev: true, measured: "" });
      cf["cur.inks"] = inkText(JSON.parse(b.dataset.nexttrial)).replace(/ · /g, ", ");
      S.res.correct = ""; render(); window.scrollTo(0, 0);
      toast("새 배합을 '지금 배합'으로 옮겼어요 — 찍어서 잰 LAB를 넣고 다시 보정하세요");
    }));
    $$("[data-similar]", out).forEach((b) => (b.onclick = () => {
      (S.f.similar = S.f.similar || {}).target = JSON.parse(b.dataset.similar).join(" ");
      S.res.similar = ""; S.autoRun = "similar"; location.hash = "#/similar";
    }));
    $$("[data-topredict]", out).forEach((b) => (b.onclick = () => {
      const d = JSON.parse(b.dataset.topredict);
      const pf = (S.f.predict = S.f.predict || {});
      const key = d.layer === "2도" ? "l2" : "l1";
      pf[`${key}.inks`] = inkText(d.inks).replace(/ · /g, ", ");
      Object.assign(pf, { [`${key}.mat`]: d.pct.mat, [`${key}.thin`]: d.pct.thin, [`${key}.hard`]: d.pct.hard });
      ["sub.ref", "sub.lab", "plate"].forEach((x) => { if (F()[x] !== undefined) pf[x] = F()[x]; });
      if (d.under) { pf.use2 = true; pf["l1.inks"] = d.under; }
      if (d.target) pf.target = d.target;
      pf[key === "l2" ? "cov2" : "cov1"] = d.tone && d.tone < 100 ? String(d.tone) : "";
      S.res.predict = ""; location.hash = "#/predict";
    }));
  }

  // ------------------------------------------------------------------ 탭: 배합 추천
  function inkChecks(prefix, defOn) {
    const inks = ((S.lib && S.lib.inks) || []).filter((i) => i.name !== MATTING);
    if (!inks.length) return `<p class="cl-note">라이브러리에 잉크가 없습니다.</p>`;
    return `<div class="cl-inks">${inks.map((i) => {
      const k = `${prefix}:${i.name}`;
      const on = val(k, defOn(i));
      const swc = (S.info.inks.find((x) => x.name === i.name) || {}).swatch;
      const hex = swc && swc.on_white ? swc.on_white.hex : "transparent";
      const ready = inkReady(i.name);
      return `<label class="cl-ink${ready ? "" : " off"}" title="${ready ? "" : "지금 모드로 계산할 수 없어요 — 측정값이나 보정 프로필이 필요합니다"}"><input type="checkbox" data-k="${esc(k)}"${on ? " checked" : ""}>${sw(hex)}${esc(i.name)}${i.clear ? " <em>투명</em>" : ready ? "" : " <em>계산 불가</em>"}</label>`;
    }).join("")}</div>`;
  }
  // 지금 모드에서 계산할 수 있는 잉크 (측정 보정 또는 적용한 프로필) — 못 하는 잉크는 기본으로 체크하지 않는다
  const inkReady = (name) => {
    const i = ((S.info && S.info.inks) || []).find((x) => x.name === name);
    return !!(i && (i.clear || ((i.status || {})[`${S.mode}_tri`] || {}).ok || ((i.status || {})[`${S.mode}_spec`] || {}).ok));
  };
  const checkedInks = (prefix, defOn) => ((S.lib && S.lib.inks) || []).filter((i) => i.name !== MATTING && val(`${prefix}:${i.name}`, defOn(i))).map((i) => i.name);

  function viewRecommend() {
    const under = !!val("under", false);
    return `${needInks()}<div class="cl-card"><h2>배합 추천 <small>목표색에 가까운 잉크 조합과 g</small></h2>
      <div class="cl-grid">${labField("target", "목표 LAB")}${toneField()}${subField("sub")}${plateField("plate")}</div>
      <label class="cl-check"><input type="checkbox" data-k="under" data-re="1"${under ? " checked" : ""}> 2도 배합 고르기 (이미 정한 1도 위에 찍음)</label>
      ${under ? recipeField("u", "아래 1도 배합") : ""}
      <h4>쓸 수 있는 잉크</h4>${inkChecks("ink", (i) => !i.clear && inkReady(i.name))}
      <div class="cl-grid">
        <label class="cl-f sm"><span>최대 잉크 수</span><select data-k="max">${[1, 2, 3, 4].map((n) => `<option${String(val("max", 3)) === String(n) ? " selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="cl-f sm"><span>잉크 합계 g <em>만들 양</em></span><input data-k="total" type="number" step="1" min="1" value="${esc(val("total", 60))}"></label>
        <label class="cl-f sm"><span>소광제 %</span><input data-k="r.mat" type="number" step="0.1" min="0" value="${esc(val("r.mat", 0))}"></label>
        <label class="cl-f sm"><span>신나 %</span><input data-k="r.thin" type="number" step="1" min="0" value="${esc(val("r.thin", 30))}"></label>
        <label class="cl-f sm"><span>경화제 %</span><input data-k="r.hard" type="number" step="1" min="0" value="${esc(val("r.hard", 20))}"></label>
      </div>
      <div class="cl-actions"><button class="cl-btn" id="go">추천</button><span class="cl-note">잉크를 많이 고를수록 오래 걸립니다 (조합 수만큼 계산)</span></div></div>
      <div id="out">${S.res.recommend || ""}</div>`;
  }

  async function goRecommend(out) {
    const under = !!val("under", false);
    const pct = pctOf("r");
    const target = getLab("target", true, "목표");
    const u = under ? getRecipe("u") : null;
    const body = { mode: S.mode, target, substrate: getSub("sub"), plate: val("plate") || null, inks: checkedInks("ink", (i) => !i.clear && inkReady(i.name)),
      max_inks: +val("max", 3), ink_total: +val("total", 60), under: u, hardener_pct: pct.hard, thinner_pct: pct.thin, matting_pct: pct.mat, tone: getTone() };
    const r = await api("POST", "/api/lab/recommend", body);
    const layer = under ? "2도" : "1도";
    S.res.recommend = `<div class="cl-card"><h3>추천 후보${r.space === "spec" ? "" : " (출발점)"} <small>${esc(S.mode.toUpperCase())} · ${esc(((S.info && S.info.formulas) || {})[(r.tolerance || {}).formula] || "ΔE00")} 순</small></h3>
      <div class="cl-cands">${r.candidates.map((c, i) => `<div class="cl-cand">
        <div class="cl-pair">${sw(r.target_hex, 1)}${sw(c.hex, 1)}</div>
        <div class="cl-cand-b"><b>${i + 1}. ${esc(inkText(c.inks))}</b>
          ${judgeTag(c.judge, c.dE)} <small>${esc(c.diff)} · ${labStr(c.lab)}</small><br>${weighLine(c.weigh)}
          <div class="cl-actions">
            <button class="cl-btn ghost sm" data-topredict="${esc(JSON.stringify({ layer, inks: c.inks, pct, target: target.join(" "), under: under ? val("u.inks") : "", tone: body.tone }))}">예측으로</button>
            <button class="cl-btn ghost sm" data-copy="${esc(batchYaml(layer, c.inks, pct))}">일지용 복사</button></div></div></div>`).join("")}</div>
      ${r.truncated ? `<p class="cl-empty">시간 제한으로 조합 ${r.truncated.total}개 중 ${r.truncated.done}개만 계산했어요 (적은 잉크 조합부터) — 쓸 잉크를 줄여 고르면 전부 계산합니다.</p>` : ""}
      ${accuracyBox(r)}
      ${r.candidates.length && r.candidates[0].dE > 2 ? `<p class="cl-empty">가장 가까운 후보도 ΔE ${r.candidates[0].dE.toFixed(1)} — 이 막두께로는 바탕이 비쳐서 목표에 닿기 어렵습니다. 신나를 줄여 막을 두껍게 하거나(동판 막두께 계수도 확인), 흰색 1도를 먼저 깔고 2도로 맞추는 방법(위 "2도 배합 고르기")을 검토해 보세요.</p>` : ""}
      ${noteBox(r)}</div>`;
    out.innerHTML = S.res.recommend;
    bindResult(out);
  }

  // ------------------------------------------------------------------ 탭: 보정 추천
  function viewCorrect() {
    const under = !!val("under", false);
    return `${needInks()}<div class="cl-card"><h2>보정 추천 <small>찍어 보니 다를 때 — 지금 배합에서 무엇을 몇 g</small></h2>
      ${recipeField("cur", "지금 배합")}
      <div class="cl-grid">${labField("measured", "찍어서 잰 LAB")}${labField("target", "목표 LAB")}${toneField()}</div>
      <div class="cl-grid">${subField("sub")}${plateField("plate")}</div>
      <label class="cl-check"><input type="checkbox" data-k="under" data-re="1"${under ? " checked" : ""}> 2도 보정 (1도 위에 찍은 색)</label>
      ${under ? recipeField("u", "아래 1도 배합") : ""}
      <label class="cl-check"><input type="checkbox" data-k="use_prev" data-re="1"${val("use_prev", false) ? " checked" : ""}> 이전 시도도 있어요 <em>배합을 바꿨을 때 색이 실제로 얼마나 움직였는지 다음 보정에 반영</em></label>
      ${val("use_prev", false) ? `${recipeField("prev", "이전 시도 배합")}<div class="cl-grid">${labField("prev_m", "이전 시도에서 잰 LAB")}</div>` : ""}
      <div class="cl-grid">
        <label class="cl-check"><input type="checkbox" data-k="add_only" data-re="1"${val("add_only", false) ? " checked" : ""}> 이미 섞은 통에 <b>더 넣기만</b> (뺄 수 없음)</label>
        ${val("add_only", false) ? `<label class="cl-f sm"><span>통에 남은 잉크 g <em>선택 — 넣을 양을 환산</em></span><input data-k="remain" type="number" step="1" min="0" value="${esc(val("remain"))}"></label>` : ""}
      </div>
      <h4>더 넣어도 되는 잉크 <em>지금 배합에 있는 잉크는 자동 포함</em></h4>${inkChecks("add", () => false)}
      <label class="cl-f"><span>변경을 아끼는 정도 <em>클수록 조금만 바꾸는 쪽</em></span>
        <input data-k="w" type="range" min="0" max="2" step="0.1" value="${esc(val("w", 0.5))}" oninput="this.nextElementSibling.textContent=this.value"><b class="cl-range">${esc(val("w", 0.5))}</b></label>
      <div class="cl-actions"><button class="cl-btn" id="go">보정 추천</button></div></div>
      <div id="out">${S.res.correct || ""}</div>`;
  }

  async function goCorrect(out) {
    const under = !!val("under", false);
    const cur = getRecipe("cur");
    const body = { mode: S.mode, current: cur, measured: getLab("measured", true, "측정"), target: getLab("target", true, "목표"),
      substrate: getSub("sub"), plate: val("plate") || null, under: under ? getRecipe("u") : null,
      adjustable: checkedInks("add", () => false), change_weight: +val("w", 0.5), tone: getTone(),
      add_only: !!val("add_only", false), remaining: val("add_only", false) && val("remain") !== "" ? +val("remain") : null };
    if (val("use_prev", false)) body.previous = [{ recipe: getRecipe("prev"), measured: getLab("prev_m", true, "이전 시도 측정") }];
    const r = await api("POST", "/api/lab/correct", body);
    const pct = pctOf("cur");
    const layer = under ? "2도" : "1도";
    S.res.correct = `<div class="cl-card"><h3>보정 결과</h3>
      <div class="cl-swatches">
        <div class="cl-tile tgt">${sw(labToHex(body.target), 1)}<b>목표</b><span>${labStr(body.target)}</span></div>
        <div class="cl-tile">${sw(r.now.hex, 1)}<b>지금</b><span>${labStr(body.measured)}</span>${judgeTag(r.now.judge, r.now.dE)}<small>${esc(r.now.diff)}</small></div>
        <div class="cl-tile avg">${sw(r.expected.hex, 1)}<b>보정 후 (예상)</b><span>${labStr(r.expected.lab)}</span>${judgeTag(r.expected.judge, r.expected.dE)}<small>${esc(r.expected.diff)}</small></div>
      </div>
      <div class="cl-change">${esc(r.change_text)}</div>
      <p>${r.add ? "넣은 뒤 배합" : "새 배합"}: <b>${esc(inkText(r.inks))}</b><br>${weighLine(r.weigh)}</p>
      <p class="cl-note">모델이 지금 배합에서 틀린 만큼(측정 − 예측: ΔL ${r.model_bias[0]}, Δa ${r.model_bias[1]}, Δb ${r.model_bias[2]})을 그대로 옮겨 보정했습니다. 차이가 크면 라이브러리 측정값이나 동판 막두께 계수를 확인해 보세요.</p>
      ${noteBox(r)}
      <div class="cl-actions"><button class="cl-btn ghost" data-copy="${esc(batchYaml(layer, r.inks, pct))}">일지용 복사 (새 배치)</button>
        <button class="cl-btn ghost" data-nexttrial="${esc(JSON.stringify(r.inks))}" title="지금 배합·잰 값을 '이전 시도'로 옮기고 이 배합을 '지금 배합'으로">이 배합으로 찍어 봤어요 → 다음 보정</button></div></div>`;
    out.innerHTML = S.res.correct;
    bindResult(out);
  }

  // ------------------------------------------------------------------ 탭: 과거 사례
  function viewSimilar() {
    return `<div class="cl-card"><h2>과거 사례 <small>시편 아카이브 배합 LAB · 작업일지 시료 lab 중 목표에 가까운 것</small></h2>
      <div class="cl-grid">${labField("target", "목표 LAB")}
        <label class="cl-f sm"><span>바탕 <em>같은 도장 코드만</em></span><select data-k="fsub"><option value="">전체</option>
          ${[...new Set(((S.info && S.info.substrates) || []).filter((s) => !s.card).map((s) => s.ref.split("@")[0]))].map((c) => `<option${val("fsub") === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
        <label class="cl-f sm"><span>동판</span><select data-k="fplate"><option value="">전체</option>
          ${((S.lib && S.lib.plates) || []).map((p) => `<option${val("fplate") === p.lot ? " selected" : ""}>${esc(p.lot)}</option>`).join("")}</select></label></div>
      <div class="cl-actions"><button class="cl-btn" id="go">찾기</button><span class="cl-note">${esc(S.mode.toUpperCase())} 값끼리 비교합니다 · 배합이 있는 기록은 [보정 추천으로] 바로 이어 갈 수 있어요</span></div></div>
      <div id="out">${S.res.similar || ""}</div>`;
  }

  async function goSimilar(out) {
    const t = getLab("target", true, "목표");
    const q = new URLSearchParams({ mode: S.mode, L: t[0], a: t[1], b: t[2], substrate: val("fsub"), plate: val("fplate") });
    const r = await api("GET", `/api/lab/similar?${q}`);
    S.res.similar = `<div class="cl-card">${r.items.length ? `<table class="cl-table"><thead><tr><th></th><th>ΔE</th><th>출처</th><th>내용</th><th>LAB</th></tr></thead><tbody>
      ${r.items.map((x) => `<tr><td><span class="cl-pair">${sw(labToHex(t))}${sw(x.hex)}</span></td>
        <td class="${x.dE <= 1 ? "ok" : x.dE <= 2.5 ? "mid" : "ng"}">${x.dE.toFixed(2)}</td>
        <td><span class="cl-tag">${esc(x.source)}</span>${x.eval ? ` <span class="cl-tag">${esc(x.eval)}</span>` : ""}</td>
        <td><a href="${esc(x.link)}"><b>${esc(x.title)}</b></a><br><small>${esc(x.detail)}${Object.keys(x.inks || {}).length ? " · " + esc(inkText(x.inks)) : ""}</small>
          ${x.recipe ? `<br><button class="cl-btn ghost sm" data-tocorrect="${esc(JSON.stringify({ recipe: x.recipe, lab: x.lab, substrate: x.substrate, plate: x.plate, target: t }))}">보정 추천으로</button>` : ""}</td>
        <td class="mono">${labStr(x.lab)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="cl-note">${esc(S.mode.toUpperCase())} LAB가 적힌 과거 기록이 없습니다. 시편 아카이브 배합의 LAB 칸이나 작업일지 시료의 <code>lab:</code>을 채우면 여기서 찾을 수 있어요.</p>`}</div>`;
    out.innerHTML = S.res.similar;
    bindResult(out);
  }

  // ------------------------------------------------------------------ 탭: ΔE 계산기
  function viewDe() {
    return `<div class="cl-card"><h2>ΔE 계산기</h2>
      <div class="cl-grid">${labField("a", "기준 (목표)")}${labField("b", "비교 (시료)")}</div>
      <details${val("spa") || val("spb") ? " open" : ""}><summary>분광으로 메타메리즘 보기 (선택)</summary>
        ${specField("spa", "기준 분광")}${specField("spb", "비교 분광")}</details>
      <div class="cl-actions"><button class="cl-btn" id="go">계산</button></div></div>
      <div id="out">${S.res.de || ""}</div>`;
  }

  async function goDe(out) {
    const a = getLab("a", true, "기준"), b = getLab("b", true, "비교");
    const r = await api("POST", "/api/lab/deltae", { a, b, spec_a: getSpec("spa", a), spec_b: getSpec("spb", b) });
    const p = r.parts;
    S.res.de = `<div class="cl-card"><div class="cl-pair xl">${sw(r.hex[0], 1)}${sw(r.hex[1], 1)}</div>
      <div class="cl-de"><b class="${deClass(r.dE2000)}">ΔE2000 ${r.dE2000.toFixed(2)}</b> <span>ΔE*ab ${r.dE76.toFixed(2)}</span> <span>CMC(2:1) ${r.dEcmc.toFixed(2)}</span></div>
      ${r.judge ? `<p>고객 기준: ${judgeTag(r.judge)}</p>` : ""}
      <p class="cl-change">${esc(r.text)}</p>
      <table class="cl-table narrow"><tr><th>ΔL 밝기</th><th>Δa 빨강+/녹색−</th><th>Δb 노랑+/파랑−</th><th>ΔC 채도</th><th>ΔH 색상</th></tr>
      <tr class="mono">${["dL", "da", "db", "dC", "dH"].map((k) => `<td>${p[k] > 0 ? "+" : ""}${p[k].toFixed(2)}</td>`).join("")}</tr></table>
      ${r.metamerism ? `<h4>조명별 차이 <small>분광 · ${esc(r.observer)}° 관찰자</small></h4>${metaTable(r.metamerism)}` : ""}</div>`;
    out.innerHTML = S.res.de;
  }

  // ------------------------------------------------------------------ 탭: 측색 라이브러리
  const E = () => S.edit;
  function getPath(o, path) { return path.split(".").reduce((x, k) => (x == null ? x : x[k]), o); }
  function setPath(o, path, v) {
    const ks = path.split(".");
    let x = o;
    ks.slice(0, -1).forEach((k, i) => { if (x[k] == null) x[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; x = x[k]; });
    if (v === undefined) delete x[ks[ks.length - 1]]; else x[ks[ks.length - 1]] = v;
  }
  // 보정 프로필 적용·끄기·되돌리기는 저장된 라이브러리로 하고 끝나면 다시 불러온다 → 저장 안 한 변경이 있으면 막는다
  const PROFILE_BUTTONS = ["#prof-run", "#prof-apply", "#prof-off", "#prof-revert"];
  function markDirty() {
    S.dirty = true; status();
    const b = $("#save"); if (b) b.classList.add("hot");
    [...PROFILE_BUTTONS.map((sel) => $(sel)), ...$$("[data-prof-off], [data-prof-revert]")].forEach((x) => { if (x) { x.disabled = true; x.title = "라이브러리를 저장한 뒤 할 수 있어요"; } });
  }
  function blockedByEdits() {
    if (!S.dirty) return false;
    toast("저장 안 한 라이브러리 변경이 있어요 — 먼저 저장하거나 되돌린 뒤 하세요 (지금 하면 그 변경이 사라집니다)", true);
    return true;
  }

  // 측정값 칸: SCI · SCE LAB + 분광 단추
  function measCell(path, title) {
    const m = getPath(E(), path) || {};
    const spec = ["sci", "sce"].filter((x) => (m[`${x}_spec`] || []).length === 31);
    return `<div class="cl-meas"><div class="cl-meas-h">${esc(title)}</div>
      ${["sci", "sce"].map((md) => `<div class="cl-lab sm">${sw(m[md] ? labToHex(m[md]) : "transparent")}<span class="cl-md">${md.toUpperCase()}</span>
        <input data-p="${esc(path)}.${md}" data-type="lab" value="${esc(m[md] ? m[md].join(" ") : "")}" placeholder="L a b"></div>`).join("")}
      <button class="cl-link" data-spec="${esc(path)}">분광${spec.length ? ` ✓ ${spec.map((x) => x.toUpperCase()).join("·")}` : " 붙여넣기"}</button></div>`;
  }

  function inkStatus(name) {
    const i = ((S.info && S.info.inks) || []).find((x) => x.name === name);
    if (!i) return `<span class="cl-tag">저장 후 확인</span>`;
    if (i.clear) return `<span class="cl-tag ok">투명</span>`;
    return ["sci", "sce"].map((md) => {
      const r = i.status[`${md}_tri`], s = i.status[`${md}_spec`];
      if (!r.ok) return `<span class="cl-tag ng" title="${esc(r.msg)}">${md.toUpperCase()} 부족</span>`;
      if (r.source === "profile") return `<span class="cl-tag ok" title="적용한 보정 프로필의 값 (${esc((r.used || []).join(" · "))})">${md.toUpperCase()} ✓ 보정 프로필</span>${s.ok ? `<span class="cl-tag ok">${md.toUpperCase()} 분광</span>` : ""}`;
      const fit = r.residual < 0.002 ? "ok" : r.residual < 0.01 ? "mid" : "ng";
      const used = (r.used || []).length;
      return `<span class="cl-tag ${fit}" title="측정 ${used}개를 한 막으로 설명한 오차 (반사율). 측정이 딱 2개면 늘 0에 가깝고, 3개 이상이면 측정끼리 맞는지 알려 줍니다.">${md.toUpperCase()} ✓ ${(r.used || []).includes("solid") ? "은폐 도막+" : ""}${used}칸 · 잔차 ${r.residual}</span>${s.ok ? `<span class="cl-tag ok">${md.toUpperCase()} 분광</span>` : ""}`;
    }).join("");
  }

  function viewLibrary() {
    const L = E();
    const cards = (L.settings && L.settings.cards) || {};
    const lots = (L.plates || []).map((p) => p.lot).filter(Boolean);
    return `<div class="cl-card cl-libbar">
      <div><b>측색 라이브러리</b> <span class="cl-note">잉크 · 도장 시편(바탕) · 동판 · 전사 시료 — 예측·추천은 모두 여기 값으로 계산합니다</span></div>
      <div class="cl-actions">
        <button class="cl-btn${S.dirty ? " hot" : ""}" id="save">저장</button>
        <button class="cl-btn ghost" id="revert"${S.dirty ? "" : " disabled"}>되돌리기</button>
        <button class="cl-btn ghost" id="export">JSON 내보내기</button>
        <label class="cl-btn ghost">JSON 가져오기<input type="file" id="import" accept=".json,application/json" hidden></label>
      </div></div>

    <details class="cl-card cl-help"${(L.inks || []).length ? "" : " open"}><summary>측정 방법 (처음이면 읽어 주세요)</summary>
      <ol>
        <li><b>잉크</b>: <b>은폐 도막</b>(꾸덕하게 발라 바탕이 안 비치게 한 것)을 잽니다. 그다음은 둘 중 하나:
          <br>① 그 잉크로 찍은 <b>전사 시료(망점 패치)</b>를 아래에 쌓고 <b>보정 프로필</b>을 계산·적용 — 100% 동판이 없어도 됩니다
          <br>② 얇게 찍은 값(바탕 + 그 위 잉크)을 잉크 칸에 직접 — 흰·검정 카드 둘이거나, 은폐 도막 + 하나
          <br>얇게 찍을 때 경화제 · 신나 %를 적어 주세요. 기준이 되는 동판의 막두께가 ×1.00입니다.</li>
        <li><b>도장 시편</b>: 컬러코드 · 도장처 · 표면마다 한 줄. 같은 코드라도 경면/패브릭엠보는 따로. 흰·검정 카드는 "기본 카드값"에 넣으면 바탕으로 고를 수 있어요.</li>
        <li><b>동판</b>: LPI · 부식 깊이 · 설계 망점 %를 적습니다. 망점 곡선과 막두께는 <b>보정 프로필</b>이 정하고, 프로필이 없는 동판은 입력값이나 다른 동판에서 추정합니다.</li>
        <li><b>전사 시료</b>: 동판으로 네모 패치를 찍어 잰 값을 쌓아 두세요 — 날짜 · 동판 · 바탕 · 배합 g · 망점 % · 잰 값. 잉크마다 <b>95 · 70 · 40 · 20%</b>처럼 망점을 넓게 찍을수록 프로필이 믿을 만해집니다. SCI로 재는 것을 권장합니다.</li>
        <li><b>분광</b>(선택): 측색기가 400~700 nm 반사율을 내보내면 각 칸의 "분광 붙여넣기"에. 31개(10 nm) · 파장+값 두 열 · 360~740 · 380~780 모두 받습니다.</li>
      </ol></details>

    <div class="cl-card"><h3>잉크 <small>${(L.inks || []).length}개</small></h3>
      <div class="cl-cardrow"><span class="cl-note">기본 카드값 (새 잉크에 자동으로 들어가고, 바탕으로도 고를 수 있음)</span>
        ${measCell("settings.cards.white", "흰 카드")}${measCell("settings.cards.black", "검정 카드")}
        <button class="cl-btn ghost sm" id="cards-all"${cards.white || cards.black ? "" : " disabled"}>모든 잉크에 적용</button></div>
      ${(L.inks || []).map((ink, i) => `<div class="cl-inkcard">
        <div class="cl-inkhead">
          <input class="cl-name" data-p="inks.${i}.name" value="${esc(ink.name)}" placeholder="정식 제품명 (예: 200YE-D)" aria-label="정식 제품명">
          <label class="cl-check"><input type="checkbox" data-p="inks.${i}.clear" data-type="bool" data-re="1"${ink.clear ? " checked" : ""}> 투명 (CL 등 색 없음)</label>
          ${ink.clear ? "" : `<label class="cl-f xs"><span>경화제 %</span><input type="number" data-p="inks.${i}.cal.hardener_pct" data-type="num" value="${esc(ink.cal?.hardener_pct ?? 20)}"></label>
          <label class="cl-f xs"><span>신나 %</span><input type="number" data-p="inks.${i}.cal.thinner_pct" data-type="num" value="${esc(ink.cal?.thinner_pct ?? 30)}"></label>
          <label class="cl-f xs"><span>찍은 동판</span><select data-p="inks.${i}.cal.plate"><option value=""></option>${lots.map((l) => `<option${ink.cal?.plate === l ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
          <label class="cl-f date"><span>측정일</span><input type="date" data-p="inks.${i}.cal.measured_on" value="${esc(ink.cal?.measured_on || "")}"></label>
          <label class="cl-f sm"><span>잉크 로트</span><input data-p="inks.${i}.lot" value="${esc(ink.lot || "")}" placeholder="제조 로트"></label>`}
          <input class="cl-memo" data-p="inks.${i}.note" value="${esc(ink.note || "")}" placeholder="메모">
          <div class="grow"></div><span class="cl-status-tags">${inkStatus(ink.name)}</span>
          <button class="cl-x" data-del="inks.${i}" title="삭제">×</button></div>
        <div class="cl-identity">
          <label class="cl-f"><span>표시 약칭 <em>입력 별칭으로도 인식</em></span><input data-p="inks.${i}.short_name" value="${esc(ink.short_name || "")}" placeholder="YE-D" maxlength="80"></label>
          <label class="cl-f wide"><span>입력 별칭 <em>쉼표로 구분</em></span><input data-p="inks.${i}.aliases" data-type="aliases" value="${esc((ink.aliases || []).join(", "))}" placeholder="현장에서 사용하는 다른 이름"></label>
          <label class="cl-f"><span>회사 DB 연결 <em>별칭과 별도 지정</em></span><select data-p="inks.${i}.db_ink" aria-label="회사 DB 연결">
            <option value="">연결 안 함 (DB 전송 차단)</option>${DB_CODES().map((code) => `<option value="${code}"${(ink.db_ink ?? (DB_CODES().includes(ink.name) ? ink.name : "")) === code ? " selected" : ""}>${code}</option>`).join("")}</select></label>
        </div>
        ${ink.clear ? "" : `<div class="cl-measrow">${MEAS.map(([k, t]) => measCell(`inks.${i}.cal.${k}`, t)).join("")}</div>`}
      </div>`).join("")}
      <button class="cl-btn ghost" id="add-ink">+ 잉크</button>
      <p class="cl-note">저장하면 아카이브와 컬러연구소가 같은 별칭을 사용합니다. 대소문자·앞뒤 공백은 무시하며, 같은 제품의 정식명과 별칭 중량은 합산합니다. 다른 제품과 이름·별칭·DB 연결은 중복할 수 없습니다. 기존 정식명 변경 대신 약칭을 지정하세요. DB 연결은 제품을 확인한 뒤 지정하며 과거 DB 행은 자동 변경하지 않습니다.</p></div>

    <div class="cl-card"><h3>도장 시편 (바탕) <small>${(L.substrates || []).length}개</small></h3>
      <div class="cl-scroll"><table class="cl-table lib"><thead><tr><th>컬러코드</th><th>도장처</th><th>표면</th><th>종류</th><th>광택 GU</th><th>설명</th><th>도장일</th><th>측정일</th><th>SCI · SCE · 분광</th><th></th></tr></thead><tbody>
      ${(L.substrates || []).map((s, i) => `<tr>
        <td><input data-p="substrates.${i}.code" value="${esc(s.code)}" placeholder="C 1000"></td>
        <td><input data-p="substrates.${i}.maker" value="${esc(s.maker || "")}"></td>
        <td><select data-p="substrates.${i}.surface"><option value=""></option>${SURFACES.map((x) => `<option${s.surface === x ? " selected" : ""}>${x}</option>`).join("")}</select></td>
        <td><select data-p="substrates.${i}.finish" title="메탈릭·펄이면 각도별 색을 못 담는다고 알려 줘요"><option value=""></option>${["솔리드", "메탈릭", "펄"].map((x) => `<option${s.finish === x ? " selected" : ""}>${x}</option>`).join("")}</select></td>
        <td><input class="num" type="number" step="0.1" min="0" data-p="substrates.${i}.gloss" data-type="num" value="${esc(s.gloss ?? "")}" placeholder="60°"></td>
        <td><input data-p="substrates.${i}.desc" value="${esc(s.desc || "")}"></td>
        <td><input type="date" data-p="substrates.${i}.painted" value="${esc(s.painted || "")}"></td>
        <td><input type="date" data-p="substrates.${i}.measured_on" value="${esc(s.measured_on || "")}"></td>
        <td>${measCell(`substrates.${i}`, "")}</td>
        <td><button class="cl-x" data-del="substrates.${i}" title="삭제">×</button></td></tr>`).join("")}
      </tbody></table></div>
      <button class="cl-btn ghost" id="add-sub">+ 도장 시편</button></div>

    <div class="cl-card"><h3>동판 <small>${(L.plates || []).length}개</small></h3>
      <div class="cl-scroll"><table class="cl-table lib"><thead><tr><th>동판 lot</th><th>LPI</th><th>부식 깊이 µm</th><th>막두께 계수</th><th>50% 망점 → 실제 %</th><th>1도 망점 %</th><th>2도 망점 %</th><th>예측 오차</th><th>메모</th><th></th></tr></thead><tbody>
      ${(L.plates || []).map((p, i) => {
        const inf = !S.dirty && S.info && S.info.plates ? S.info.plates[p.lot] : null;
        const acc = inf && inf.accuracy[S.mode];
        return `<tr>
        <td><input data-p="plates.${i}.lot" value="${esc(p.lot)}" placeholder="26_135"></td>
        <td><input class="num" type="number" step="1" min="1" data-p="plates.${i}.lpi" data-type="num" value="${esc(p.lpi ?? "")}"></td>
        <td><input class="num" type="number" step="0.5" min="0" data-p="plates.${i}.depth_um" data-type="num" value="${esc(p.depth_um ?? "")}"></td>
        <td><input class="num" type="number" step="0.01" min="0.05" data-p="plates.${i}.thickness" data-type="num" value="${esc(p.thickness ?? "")}"
          placeholder="${inf ? inf.thickness.toFixed(2) : "1.00"}" title="${esc(inf ? `비우면: ×${inf.thickness.toFixed(3)} — ${inf.thickness_src}` : "비우면 추정")}"></td>
        <td><input class="num" type="number" step="1" min="5" max="99" data-p="plates.${i}.dot50" data-type="pct" value="${p.dot50 != null ? r1(p.dot50 * 100) : ""}"
          placeholder="${inf ? r1(inf.dot50 * 100) : "50"}" title="${esc(inf ? `비우면: ${r1(inf.dot50 * 100)}% — ${inf.gain_src}` : "비우면 추정")}"></td>
        <td><input class="num" type="number" step="1" min="0" max="100" data-p="plates.${i}.coverage.1도" data-type="pct" value="${p.coverage && p.coverage["1도"] != null ? r1(p.coverage["1도"] * 100) : ""}"></td>
        <td><input class="num" type="number" step="1" min="0" max="100" data-p="plates.${i}.coverage.2도" data-type="pct" value="${p.coverage && p.coverage["2도"] != null ? r1(p.coverage["2도"] * 100) : ""}"></td>
        <td>${acc ? `<span class="cl-tag ${deClass(acc.dE)}" title="전사 시료 ${acc.n}개를 지금 값으로 예측했을 때의 평균 ΔE (${S.mode.toUpperCase()})">ΔE ${acc.dE.toFixed(2)} · ${acc.n}개</span>` : `<span class="cl-note">${inf && inf.samples ? "—" : "시료 없음"}</span>`}</td>
        <td><input data-p="plates.${i}.note" value="${esc(p.note || "")}"></td>
        <td><button class="cl-x" data-del="plates.${i}" title="삭제">×</button></td></tr>`;
      }).join("")}
      </tbody></table></div>
      <p class="cl-note">보정 프로필을 적용한 동판은 프로필의 막두께·망점 곡선을 씁니다. 나머지는 입력값, 비우면 추정 — 막두께는 부식 깊이에 비례, 망점 퍼짐은 같은 LPI 동판의 평균. 칸에 마우스를 올리면 근거가 보여요.</p>
      <button class="cl-btn ghost" id="add-plate">+ 동판</button></div>

    ${viewProfile()}

    ${viewTransfers()}

    <div class="cl-card"><h3>계산 설정</h3>
      <label class="cl-f xs"><span>Yule–Nielsen n</span><input type="number" step="0.1" min="1" max="10" data-p="settings.yn" data-type="num" value="${esc((L.settings && L.settings.yn) ?? 1)}"></label>
      <p class="cl-note">망점 패치의 평균색을 낼 때 빛이 잉크 가장자리에서 번지는 정도. 1이면 단순 면적 평균. 동판의 망점 곡선이 이 효과까지 함께 담으므로 보통 1로 두세요.</p>
      <label class="cl-f sm"><span>3채널 기저 <em>분광이 없을 때</em></span><select data-p="settings.basis">
        ${[["xyz", "XYZ (권장)"], ["srgb", "sRGB (예전 방식)"]].map(([v, t]) => `<option value="${v}"${((L.settings && L.settings.basis) || "xyz") === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <p class="cl-note">XYZ는 진한 노랑·파랑도 잘리지 않습니다. sRGB는 화면 색역 밖 색이 잘려 오차가 커집니다. 바꾸면 보정 프로필을 다시 계산해야 해요.</p>
      <div class="cl-grid"><label class="cl-f sm"><span>측색기 <em>기록용</em></span><input data-p="settings.instrument" value="${esc((L.settings && L.settings.instrument) || "")}" placeholder="기종"></label>
        <label class="cl-f sm"><span>측정 구경</span><input data-p="settings.aperture" value="${esc((L.settings && L.settings.aperture) || "")}" placeholder="예: 8 mm"></label></div>
      <label class="cl-f sm"><span>측색기 관찰자 <em>분광 → LAB</em></span><select data-p="settings.observer">
        ${[["2", "2° (CIE 1931)"], ["10", "10° (CIE 1964) — 자동차 업계 보통"]].map(([v, t]) => `<option value="${v}"${String((L.settings && L.settings.observer) || "2") === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <p class="cl-note">측색기 화면의 LAB가 D65/10°이면 10°로 맞추세요. 분광으로 계산한 LAB를 측색기 LAB와 같은 조건으로 비교합니다 (채도 높은 색은 2°/10° 차이가 수 ΔE). LAB만 쓰는 계산에는 영향이 없어요.</p>
      <h4>허용 기준 <small>고객 규격 — 합격 표시와 배합 추천·보정의 목표에 씁니다</small></h4>
      <div class="cl-grid">
        <label class="cl-f sm"><span>공식</span><select data-p="settings.tolerance.formula">
          ${[["de00", "ΔE00 (CIEDE2000)"], ["de76", "ΔE*ab (CIE76)"], ["cmc", "ΔE CMC(2:1)"]].map(([v, t]) => `<option value="${v}"${(((L.settings || {}).tolerance || {}).formula || "de00") === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="cl-f xs"><span>한도</span><input type="number" step="0.1" min="0.1" data-p="settings.tolerance.limit" data-type="num" value="${esc(((L.settings || {}).tolerance || {}).limit ?? 1)}"></label>
        ${["dL", "da", "db"].map((k) => `<label class="cl-f xs"><span>|${{ dL: "ΔL", da: "Δa", db: "Δb" }[k]}| 한도 <em>선택</em></span><input type="number" step="0.1" min="0" data-p="settings.tolerance.axes.${k}" data-type="num" value="${esc((((L.settings || {}).tolerance || {}).axes || {})[k] ?? "")}"></label>`).join("")}
      </div></div>
    <div id="spec-panel"></div>`;
  }

  const deClass = (d) => (d <= 1 ? "ok" : d <= 2.5 ? "mid" : "ng");
  // 고객 허용 기준 판정 (라이브러리 › 계산 설정). 판정이 없으면 ΔE00 그대로
  const AXIS = { dL: "ΔL", da: "Δa", db: "Δb" };
  function judgeTag(j, de00) {
    if (!j) return de00 == null ? "" : `<em class="${deClass(de00)}">ΔE ${de00.toFixed(2)}</em>`;
    const cls = j.ok ? "ok" : j.value <= j.limit * 2 && !j.over.length ? "mid" : "ng";
    const over = j.over.length ? ` · ${j.over.map((k) => AXIS[k] || k).join("·")} 한도 넘음` : "";
    return `<em class="${cls}" title="고객 기준 ${esc(j.formula)} ≤ ${j.limit}${de00 != null ? ` · ΔE00 ${de00.toFixed(2)}` : ""}">${esc(j.formula)} ${j.value.toFixed(2)} ${j.ok ? "✓" : "✗"}${over}</em>`;
  }
  // 회사 DB 잉크 칸 — 서버(model.DB_INK_CODES)가 정한 목록. 못 받았을 때만 기본 9종
  const DB_CODES = () => (S.info && S.info.db_codes) || ["MT", "BK", "WH", "YE", "RD", "CL", "YE-D", "BL", "VL"];
  const recipeText = (inks) => Object.entries(inks || {}).map(([k, v]) => `${k} ${v}`).join(", ");

  // 바탕으로 고를 수 있는 이름 (서버 _sub_ref와 같은 규칙) + 기본 카드
  function subRefs() {
    const subs = (E().substrates || []).filter((s) => s.code);
    const refs = subs.map((s) => {
      const same = subs.filter((x) => x.code === s.code);
      if (same.length <= 1) return s.code;
      if (new Set(same.map((x) => x.maker)).size === same.length) return `${s.code}@${s.maker}`;
      if (new Set(same.map((x) => x.surface)).size === same.length) return `${s.code}@${s.surface}`;
      return `${s.code}@${s.maker}@${s.surface}`;
    });
    const cards = (E().settings && E().settings.cards) || {};
    return [...new Set(refs)].concat(cards.white ? ["흰 카드"] : [], cards.black ? ["검정 카드"] : []);
  }

  function viewTransfers() {
    const T = E().transfers || [];
    const lots = (E().plates || []).map((p) => p.lot).filter(Boolean);
    const refs = subRefs();
    const f = S.trFilter || "";
    const rows = T.map((t, i) => [t, i]).filter(([t]) => !f || t.plate === f);
    const opt = (list, v) => list.map((x) => `<option${x === v ? " selected" : ""}>${esc(x)}</option>`).join("");
    return `<div class="cl-card" id="transfers"><h3>전사 시료 <small>${T.length}개${f ? ` · 동판 ${esc(f)} ${rows.length}개` : ""}</small></h3>
      <p class="cl-note">동판으로 네모 패치를 찍어 잰 값. 오른쪽 견본은 지금 라이브러리로 예측한 색과 그 오차(저장된 값 기준)입니다.</p>
      <div class="cl-actions"><label class="cl-f xs"><span>동판 보기</span><select id="tr-filter"><option value="">전체</option>${opt(lots, f)}</select></label></div>
      ${rows.map(([t, i]) => {
        const inf = !S.dirty && S.info && S.info.transfers ? (S.info.transfers[i] || {})[S.mode] : null;
        const subOk = typeof t.substrate === "string";
        return `<div class="cl-tr">
        <div class="cl-tr-row">
          <b class="cl-tr-no">${i + 1}</b>
          <label class="cl-f date"><span>날짜</span><input type="date" data-p="transfers.${i}.date" value="${esc(t.date || "")}"></label>
          <label class="cl-f sm"><span>동판</span><select data-p="transfers.${i}.plate"><option value=""></option>${opt(lots, t.plate)}</select></label>
          <label class="cl-f sm"><span>바탕</span><select data-p="transfers.${i}.substrate">${subOk && t.substrate && !refs.includes(t.substrate) ? `<option selected>${esc(t.substrate)}</option>` : ""}${!subOk ? `<option selected disabled>(직접 입력값)</option>` : ""}<option value=""></option>${opt(refs, t.substrate)}</select></label>
          <label class="cl-f xs"><span>신나 %</span><input type="number" data-p="transfers.${i}.thinner_pct" data-type="num" value="${esc(t.thinner_pct ?? 30)}"></label>
          <label class="cl-f xs"><span>경화제 %</span><input type="number" data-p="transfers.${i}.hardener_pct" data-type="num" value="${esc(t.hardener_pct ?? 20)}"></label>
          <label class="cl-f xs"><span>소광제 %</span><input type="number" data-p="transfers.${i}.matting_pct" data-type="num" value="${esc(t.matting_pct ?? 0)}"></label>
          <input class="cl-memo" data-p="transfers.${i}.note" value="${esc(t.note || "")}" placeholder="메모">
          <div class="grow"></div>
          <button class="cl-x" data-del="transfers.${i}" title="삭제">×</button></div>
        <div class="cl-tr-row">
          ${["layer1", "layer2"].map((ly, n) => `<div class="cl-tr-layer">
            <label class="cl-f"><span>${n + 1}도 배합 g${n ? " <em>없으면 비움</em>" : ""}</span><input data-recipe="transfers.${i}.${ly}" value="${esc(recipeText(t[ly]?.inks))}" placeholder="${n ? "(없으면 비움)" : "WH 20, YE 6"}"></label>
            <label class="cl-f xs"><span>망점 %</span><input type="number" step="1" min="1" max="100" data-p="transfers.${i}.${ly}.tone" data-type="num" value="${esc(t[ly]?.tone ?? (n ? "" : 100))}"></label></div>`).join("")}
          ${measCell(`transfers.${i}.measured`, "잰 값")}
          <details class="cl-tr-meta"${["machine", "pad", "cure", "instrument", "temp", "humidity"].some((k) => t[k] != null && t[k] !== "") ? " open" : ""}><summary>공정·측정 조건</summary>
            <label class="cl-f sm"><span>설비</span><input data-p="transfers.${i}.machine" value="${esc(t.machine || "")}"></label>
            <label class="cl-f sm"><span>패드</span><input data-p="transfers.${i}.pad" value="${esc(t.pad || "")}" placeholder="경도·모양"></label>
            <label class="cl-f xs"><span>온도 °C</span><input type="number" data-p="transfers.${i}.temp" data-type="num" value="${esc(t.temp ?? "")}"></label>
            <label class="cl-f xs"><span>습도 %</span><input type="number" data-p="transfers.${i}.humidity" data-type="num" value="${esc(t.humidity ?? "")}"></label>
            <label class="cl-f sm"><span>측정 시점</span><input data-p="transfers.${i}.cure" value="${esc(t.cure || "")}" list="cl-cure" placeholder="인쇄 직후 / 24시간 / 완전 경화"></label>
            <label class="cl-f sm"><span>측색기</span><input data-p="transfers.${i}.instrument" value="${esc(t.instrument || "")}"></label></details>
          <div class="cl-tr-pred">${inf ? (inf.error ? `<span class="cl-tag ng" title="${esc(inf.error)}">계산 안 됨</span><small>${esc(inf.error)}</small>`
            : `<div class="cl-pair">${sw(labToHex(t.measured?.[S.mode]) || inf.hex)}${sw(inf.hex)}</div><span class="cl-tag ${deClass(inf.dE)}">예측 ΔE ${inf.dE.toFixed(2)}</span><small>예측이 ${esc(inf.diff)}</small>`)
            : `<small class="cl-note">${S.dirty ? "저장 후 예측 오차 표시" : ""}</small>`}</div>
        </div></div>`;
      }).join("")}
      <datalist id="cl-cure"><option>인쇄 직후</option><option>1시간</option><option>24시간</option><option>완전 경화</option></datalist>
      <button class="cl-btn ghost" id="add-tr">+ 전사 시료</button> <span class="cl-note">마지막 줄의 날짜 · 동판 · 바탕 · 배합을 복사해서 새 줄을 만듭니다 (망점 단계 입력용)</span></div>`;
  }

  // ------------------------------------------------------------------ 보정 프로필
  const SPACE_LABEL = { spec: "분광 31채널", xyz: "3채널 (XYZ)", srgb: "3채널 (sRGB)" };
  const confClass = (lv) => ({ 좋음: "ok", 보통: "mid", 낮음: "mid", 부족: "ng" }[lv] || "");
  const pc = (x) => `${r1(x * 100)}%`;

  function viewProfile() {
    const info = (S.info && S.info.profile) || {};
    const runs = info.runs || [], prevs = info.previous || {};
    const L = E();
    const counts = {};
    (L.transfers || []).forEach((t) => { if (t.plate && !t.validation) counts[t.plate] = (counts[t.plate] || 0) + 1; });
    const lots = (L.plates || []).map((p) => p.lot).filter(Boolean);
    const plate = S.prof.plate || [...lots].sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0] || "";
    const run = S.prof.run && S.prof.run.plate === plate && S.prof.run.mode === S.mode ? S.prof.run : null;
    const keys = new Set(runs.map((r) => r.key));
    const offOnly = Object.entries(prevs).filter(([k]) => !keys.has(k));
    const dis = S.dirty ? " disabled" : "";
    return `<div class="cl-card" id="profile"><h3>보정 프로필 <small>동판 × 모드(SCI/SCE)마다 하나 — 처음 잉크를 맞춘 동판이 막두께 기준 ×1.00, 다음 동판들은 그 잉크로 막두께·망점 곡선을 맞춤</small></h3>
      ${runs.length || offOnly.length ? `<table class="cl-table narrow"><thead><tr><th>동판</th><th>모드</th><th>잉크 (산란을 맞춘 것)</th><th>신뢰도</th><th>상태</th><th></th></tr></thead><tbody>
        ${runs.map((a) => `<tr><td><b>${esc(a.plate)}</b></td><td>${esc(a.mode.toUpperCase())} · ${esc(SPACE_LABEL[a.space] || a.space)}</td>
          <td>${esc((a.inks || []).join(", ") || "— (막두께·망점 곡선만)")}</td>
          <td><span class="cl-tag ${confClass(a.confidence.level)}">${esc(a.confidence.level)}</span></td>
          <td>${a.stale && a.stale.length ? `<span class="cl-tag mid" title="계산 이후 바뀐 입력">재맞추기 필요 — ${esc(a.stale.join(" · "))}</span>` : `<span class="cl-note">${esc((a.created || "").replace("T", " "))}</span>`}</td>
          <td><button class="cl-btn ghost sm" data-prof-off="${esc(a.key)}"${dis}>끄기</button>
            ${prevs[a.key] ? `<button class="cl-btn ghost sm" data-prof-revert="${esc(a.key)}"${dis}>바로 전으로</button>` : ""}</td></tr>`).join("")}
        ${offOnly.map(([k, p]) => `<tr class="off"><td>${esc(p.plate)}</td><td>${esc(p.mode.toUpperCase())} · ${esc(SPACE_LABEL[p.space] || p.space)}</td>
          <td colspan="3" class="cl-note">꺼 둠</td><td><button class="cl-btn ghost sm" data-prof-revert="${esc(k)}"${dis}>다시 켜기</button></td></tr>`).join("")}
        </tbody></table>`
        : `<p class="cl-note">적용한 프로필이 없습니다 — 은폐 도막만 있는 잉크는 프로필을 적용해야 계산됩니다.</p>`}
      <div class="cl-actions">
        <label class="cl-f sm"><span>동판</span><select id="prof-plate">${lots.map((l) => `<option value="${esc(l)}"${l === plate ? " selected" : ""}>${esc(l)} (시료 ${counts[l] || 0})</option>`).join("")}</select></label>
        <span class="cl-note">모드: <b>${S.mode.toUpperCase()}</b> (오른쪽 위에서 바꿈)${S.mode === "sce" ? " — 은폐 도막(광택)과 종이 시료(무광)를 SCE로 비교하면 오차가 커요. SCI 권장" : ""}</span>
        <button class="cl-btn" id="prof-run"${S.dirty || !plate || S.prof.busy ? " disabled" : ""}>${S.prof.busy ? "계산 중…" : "계산 (미리보기)"}</button>
        ${S.dirty ? `<span class="cl-note bad">저장한 뒤 계산할 수 있어요</span>` : ""}</div>
      ${S.prof.error ? `<div class="cl-err">${esc(S.prof.error)}</div>` : ""}
      ${run ? viewRun(run) : `<p class="cl-note">미리보기는 라이브러리를 바꾸지 않습니다. 결과를 보고 [적용]을 눌렀을 때만 저장돼요.</p>`}</div>`;
  }

  function viewRun(r) {
    const lv = r.confidence.level;
    const issues = (r.issues || []).concat();
    const curve = ((r.plates || {})[r.plate] || {}).tone_curve || [];
    const valBy = Object.fromEntries((r.validation || []).map((v) => [v.no, v]));
    const meas = r.measurement_issues || [];
    const g0 = (r.groups || []).find((g) => g.c_top_range);
    return `<div class="cl-prof">
      <div class="cl-prof-head"><span class="cl-tag ${confClass(lv)} big">신뢰도 ${esc(lv)}</span>
        <span>${esc(SPACE_LABEL[r.space] || r.space)} · 시료 ${r.samples.length}개${r.excluded.length ? ` · 제외 ${r.excluded.length}개` : ""}${r.ok ? ` · 맞춘 오차 평균 ΔE ${(+r.fit_dE_mean).toFixed(2)}` : ""}</span></div>
      ${r.confidence.reasons.length ? `<ul class="cl-reasons">${r.confidence.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${issues.length ? `<ul class="cl-issues">${issues.map((i) => `<li class="${i.level === "error" ? "ng" : i.level === "warn" ? "mid" : ""}">${esc(i.msg)}</li>`).join("")}</ul>` : ""}
      ${r.excluded.length ? `<details><summary>제외된 시료 ${r.excluded.length}개</summary><ul>${r.excluded.map((x) => `<li>${x.no}번 — ${esc(x.reason)}</li>`).join("")}</ul></details>` : ""}
      ${meas.length ? `<details><summary>측정 진단 ${meas.length}건 <small>(${[...new Set(meas.map((m) => ({ display_gamut_outside: "화면 표시", channel_model_invalid: "채널 범위", surface_model_incompatible: "표면 보정" }[m.kind])))].join(" · ")})</small></summary>
        <ul>${meas.map((m) => `<li class="${m.level === "error" ? "ng" : m.level === "warn" ? "mid" : ""}"><b>${esc(m.what)}</b> — ${esc(m.msg)}</li>`).join("")}</ul></details>` : ""}
      ${r.ok ? `
      <div class="cl-prof-grid">
        <div><h4>망점 곡선 <small>동판 ${esc(r.plate)}</small></h4>
          <table class="cl-table narrow"><tr><th>설계</th><th>실효 덮임</th></tr>
          ${curve.map(([d, e]) => `<tr class="mono"><td>${pc(d)}</td><td><b>${pc(e)}</b></td></tr>`).join("")}</table>
          <p class="cl-note">잰 망점 사이는 직선, ${pc(curve[0][0])} 아래·${pc(curve[curve.length - 1][0])} 위는 0%·100%까지 직선으로 <b>외삽(가정)</b>합니다.
          ${g0 && g0.c_top_range ? `<br>가장 진한 패치의 실효 덮임은 데이터만으로는 ${pc(g0.c_top_range[0])}~100% 사이에서 정해지지 않습니다.` : ""}</p></div>
        <div><h4>잉크 <small>잉크 1단위 산란 (채널별)</small></h4>
          <table class="cl-table narrow"><tr><th>잉크</th><th>산란</th><th>시료</th></tr>
          ${Object.entries(r.inks).map(([n, v]) => `<tr><td><b>${esc(n)}</b></td><td class="mono">${v.s.length > 3 ? `${v.s[0].toFixed(3)} … ${v.s[v.s.length - 1].toFixed(3)}` : v.s.map((x) => x.toFixed(3)).join(" / ")}</td><td>${v.samples}</td></tr>`).join("")}
          ${(r.fixed_inks || []).map((n) => `<tr><td>${esc(n)}</td><td colspan="2" class="cl-note">측정 보정 값 그대로</td></tr>`).join("")}</table>
          <p class="cl-note">막두께는 동판 ${esc(r.plate)} 기준 ×${(+r.plates[r.plate].thickness).toFixed(3)} (상대값, µm 아님)</p></div></div>
      <h4>시료별 오차 <small>맞춘 오차 · 하나 빼고 예측(검증)</small></h4>
      <div class="cl-scroll"><table class="cl-table"><thead><tr><th>번호</th><th>잉크</th><th>망점 → 실효</th><th>잰 · 예측</th><th>맞춘 ΔE</th><th>하나 빼고 ΔE</th></tr></thead><tbody>
      ${r.samples.map((x) => { const v = valBy[x.no] || {}; return `<tr><td>${x.no}</td><td>${esc(x.ink)}</td><td class="mono">${pc(x.design)} → ${pc(x.coverage)}</td>
        <td><span class="cl-pair">${sw(labToHex(x.measured_lab))}${sw(x.pred_hex)}</span></td>
        <td class="${deClass(x.dE)}">${x.dE.toFixed(2)}</td>
        <td>${v.status === "ok" ? `<span class="${deClass(v.dE)}">${v.dE.toFixed(2)}</span>${v.extrapolated ? ` <span class="cl-tag mid">외삽</span>` : ""}` : `<span class="cl-note">평가 불가 — ${esc(v.reason || "")}</span>`}</td></tr>`; }).join("")}
      </tbody></table></div>
      ${(r.sensitivity || []).map((x) => `<p class="cl-note">가정 민감도 — ${esc(x.ink)}: 가장 진한 패치의 실효 덮임을 ${pc(x.c_top_range[0])}~100% 중 어디로 보느냐에 따라 ${pc(x.target)} 패치 예측이 ΔE <b>${x.dE_range.toFixed(2)}</b>만큼 달라집니다 (통계적 신뢰구간이 아니라 가정에 따른 범위).</p>`).join("")}
      <details><summary>가정 · 적용 범위</summary><ul>${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}
        <li>검증된 바탕: ${esc(r.applicability.substrates.join(", "))} · 망점 ${pc(r.applicability.tones[0])}~${pc(r.applicability.tones[1])}
          · 신나/경화제/소광제 % ${esc(r.applicability.conditions.map((c) => JSON.parse(c).join("/")).join(", "))}
          ${["machine", "pad", "cure", "instrument"].map((k) => (r.applicability[k] || []).length ? ` · ${{ machine: "설비", pad: "패드", cure: "측정 시점", instrument: "측색기" }[k]} ${esc(r.applicability[k].join(", "))}` : "").join("")}</li></ul></details>
      <div class="cl-actions">
        ${lv === "부족" ? `<button class="cl-btn" disabled>적용할 수 없음</button><span class="cl-note bad">위 문제를 먼저 해결해야 합니다</span>`
          : `${lv === "낮음" ? `<label class="cl-check"><input type="checkbox" id="prof-ack"${S.prof.ack ? " checked" : ""}> 신뢰도가 낮은 것을 알고 적용합니다</label>` : ""}
             <button class="cl-btn" id="prof-apply"${(lv === "낮음" && !S.prof.ack) || S.dirty ? " disabled" : ""}>이 프로필 적용</button>
             <span class="cl-note">적용하면 이 동판의 망점 곡선·막두께와 위 잉크 값이 예측·추천·보정에 쓰입니다. 원본 측정은 바뀌지 않아요.</span>`}</div>` : ""}
    </div>`;
  }

  async function runProfile() {
    const plate = ($("#prof-plate") || {}).value || S.prof.plate;
    S.prof = { plate, busy: true };
    render();
    try {
      const j = await api("POST", "/api/lab/profile/preview", { mode: S.mode, plate });
      S.prof = { plate, run: j.run, snapshot: j.snapshot };
    } catch (e) { S.prof = { plate, error: e.message }; }
    if (S.tab === "library") render();
  }

  async function applyProfile() {
    if (blockedByEdits()) return;
    const r = S.prof.run;
    try {
      await api("POST", "/api/lab/profile/apply", { mode: r.mode, plate: r.plate, space: r.space, snapshot: S.prof.snapshot, ack_low: !!S.prof.ack },
        { "X-Base-Rev": S.rev });
      await loadLibrary();
      S.prof = { plate: r.plate };
      toast("보정 프로필을 적용했습니다 (｡•̀ᴗ-)✧");
    } catch (e) {
      if (e.status === 409) { S.prof = { plate: r.plate }; toast(e.message, true); await loadLibrary(); }
      else toast(e.message, true);
    }
    render();
  }

  async function switchProfile(action, key) {
    if (blockedByEdits()) return;
    const what = key ? `동판 ${key.split("|")[0]} · ${(key.split("|")[1] || "").toUpperCase()} ` : "";
    if (!confirm(action === "off" ? `${what}보정 프로필을 끌까요? (바로 전 프로필로 남아서 다시 켤 수 있어요)` : `${what}바로 전 프로필로 바꿀까요?`)) return;
    try {
      await api("POST", `/api/lab/profile/${action}`, { key }, { "X-Base-Rev": S.rev });
      await loadLibrary();
      toast(action === "off" ? "프로필을 껐습니다" : "바로 전 프로필로 바꿨습니다");
    } catch (e) { toast(e.message, true); if (e.status === 409) await loadLibrary(); }
    render();
  }

  function bindLibrary(root) {
    $$("[data-p]", root).forEach((el) => {
      const h = (final) => {
        const p = el.dataset.p, type = el.dataset.type;
        let v = el.type === "checkbox" ? el.checked : el.value;
        if (type === "lab") {
          const lab = parseLab(v);
          el.classList.toggle("bad", !!(lab && lab.error));
          if (lab && lab.error) return;
          v = lab || undefined;
          const s = el.parentElement.querySelector(".cl-sw");
          if (s) s.style.background = lab ? labToHex(lab) : "transparent";
        } else if (type === "aliases") v = [...new Set(String(v).split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean))];
        else if (type === "num") v = v === "" ? undefined : +v;
        else if (type === "pct") v = v === "" ? undefined : +v / 100;
        setPath(E(), p, v);
        markDirty();
        if (final && el.dataset.re) render();
      };
      el.addEventListener("input", () => h(false));
      el.addEventListener("change", () => h(true));
    });
    $$("[data-del]", root).forEach((b) => (b.onclick = () => {
      const [list, i] = b.dataset.del.split(".");
      const it = E()[list][+i];
      if (!confirm(`${it.name || it.code || it.lot || "이 줄"}을(를) 지울까요? (저장해야 반영)`)) return;
      E()[list].splice(+i, 1); markDirty(); render();
    }));
    $("#add-ink").onclick = () => {
      const c = (E().settings && E().settings.cards) || {};
      (E().inks = E().inks || []).push({ name: "", clear: false, note: "", cal: { hardener_pct: 20, thinner_pct: 30, method: "", measured_on: "", solid: {}, white_bg: clone(c.white) || {}, black_bg: clone(c.black) || {}, on_white: {}, on_black: {} } });
      markDirty(); render();
    };
    $("#add-sub").onclick = () => { (E().substrates = E().substrates || []).push({ code: "", maker: "", surface: "경면", desc: "" }); markDirty(); render(); };
    $("#add-plate").onclick = () => { (E().plates = E().plates || []).push({ lot: "", coverage: {}, note: "" }); markDirty(); render(); };
    $("#cards-all").onclick = () => {
      const c = E().settings.cards;
      if (!confirm("모든 잉크의 흰·검정 카드 값을 기본 카드값으로 바꿀까요?")) return;
      (E().inks || []).filter((i) => !i.clear).forEach((i) => { i.cal = i.cal || {}; if (c.white) i.cal.white_bg = clone(c.white); if (c.black) i.cal.black_bg = clone(c.black); });
      markDirty(); render();
    };
    $("#save").onclick = saveLibrary;
    $("#revert").onclick = () => { if (confirm("저장 안 한 변경을 버릴까요?")) { S.edit = clone(S.lib); S.dirty = false; status(); render(); } };
    $("#export").onclick = () => {
      const blob = new Blob([JSON.stringify(E(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `colorlab-library-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $("#import").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const doc = JSON.parse(await f.text());
        if (!doc || !Array.isArray(doc.inks)) throw new Error("컬러연구소 라이브러리 JSON이 아닙니다");
        if (!confirm(`가져온 파일로 화면의 라이브러리를 바꿀까요? (잉크 ${doc.inks.length} · 도장 시편 ${(doc.substrates || []).length} · 동판 ${(doc.plates || []).length}) 저장해야 반영됩니다.`)) return;
        S.edit = { ...doc, updatedAt: S.lib.updatedAt }; markDirty(); render();
      } catch (err) { toast(err.message, true); }
    };
    $$("[data-spec]", root).forEach((b) => (b.onclick = () => openSpec(b.dataset.spec)));
    // 전사 시료: 배합 글자 → {잉크: g}
    $$("[data-recipe]", root).forEach((el) => {
      const h = () => {
        const { inks, bad } = parseInks(el.value);
        el.classList.toggle("bad", bad.length > 0);
        if (bad.length) return;
        const path = el.dataset.recipe;
        if (!Object.keys(inks).length && path.endsWith("layer2")) setPath(E(), path, undefined);
        else { setPath(E(), `${path}.inks`, inks); if (getPath(E(), `${path}.tone`) == null) setPath(E(), `${path}.tone`, 100); }
        markDirty();
      };
      el.addEventListener("input", h); el.addEventListener("change", h);
    });
    $("#add-tr").onclick = () => {
      const T = (E().transfers = E().transfers || []);
      const last = [...T].reverse().find((t) => !S.trFilter || t.plate === S.trFilter);
      const lots = (E().plates || []).map((p) => p.lot).filter(Boolean);
      T.push(last ? { ...clone(last), measured: {}, note: "" }
        : { date: new Date().toISOString().slice(0, 10), plate: S.trFilter || lots[0] || "", substrate: subRefs()[0] || "",
            layer1: { inks: {}, tone: 100 }, thinner_pct: 30, hardener_pct: 20, matting_pct: 0, measured: {}, note: "" });
      markDirty(); render();
      const cards = $$(".cl-tr"); cards[cards.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    $("#tr-filter").onchange = (e) => { S.trFilter = e.target.value; render(); };
    const pp = $("#prof-plate");
    if (pp) pp.onchange = () => { S.prof = { plate: pp.value }; render(); };
    if ($("#prof-run")) $("#prof-run").onclick = runProfile;
    if ($("#prof-apply")) $("#prof-apply").onclick = applyProfile;
    if ($("#prof-ack")) $("#prof-ack").onchange = (e) => { S.prof.ack = e.target.checked; render(); };
    $$("[data-prof-off]", root).forEach((b) => (b.onclick = () => switchProfile("off", b.dataset.profOff)));
    $$("[data-prof-revert]", root).forEach((b) => (b.onclick = () => switchProfile("revert", b.dataset.profRevert)));
  }

  function openSpec(path) {
    const m = getPath(E(), path) || {};
    const panel = $("#spec-panel");
    panel.className = "cl-modal on";
    panel.innerHTML = `<div class="cl-modal-in"><h3>분광 반사율 붙여넣기</h3>
      <p class="cl-note">측색기에서 내보낸 반사율(% 또는 0~1). 엑셀 한 줄·한 열, 파장+값 두 열 모두 됩니다. 비우면 지웁니다.</p>
      <label class="cl-f sm"><span>단위</span><select id="spec-unit"><option value="auto">자동</option><option value="pct">% (0~100)</option><option value="frac">0~1</option></select></label>
      ${["sci", "sce"].map((md) => `<label class="cl-f wide"><span>${md.toUpperCase()} <em data-specmsg="${md}"></em></span>
        <textarea rows="4" data-spec-in="${md}">${esc((m[`${md}_spec`] || []).join(" "))}</textarea></label>`).join("")}
      <div class="cl-actions"><button class="cl-btn" id="spec-ok">확인</button><button class="cl-btn ghost" id="spec-no">취소</button></div></div>`;
    const check = () => {
      let ok = true;
      $$("[data-spec-in]", panel).forEach((t) => {
        const r = parseSpec(t.value, $("#spec-unit", panel).value, m[t.dataset.specIn]);
        const msg = $(`[data-specmsg="${t.dataset.specIn}"]`, panel);
        if (r && r.error) { msg.textContent = r.error; msg.className = "bad"; ok = false; }
        else {
          const far = r && Array.isArray(m[t.dataset.specIn]) && dist(r.lab, m[t.dataset.specIn]) > 3;
          msg.textContent = r ? `31개 ✓ · ${r.how} → L ${r.lab.map((x) => x.toFixed(1)).join(" ")}${far ? " · 같은 칸의 LAB와 많이 다릅니다 — 단위를 확인하세요" : ""}` : "없음";
          msg.className = far ? "bad" : "";
        }
      });
      return ok;
    };
    $$("[data-spec-in]", panel).forEach((t) => (t.oninput = check));
    $("#spec-unit", panel).onchange = check;
    check();
    $("#spec-no").onclick = () => { panel.className = ""; panel.innerHTML = ""; };
    $("#spec-ok").onclick = () => {
      if (!check()) return;
      $$("[data-spec-in]", panel).forEach((t) => {
        const r = parseSpec(t.value, $("#spec-unit", panel).value, m[t.dataset.specIn]);
        setPath(E(), `${path}.${t.dataset.specIn}_spec`, r ? r.vals : undefined);
      });
      panel.className = ""; panel.innerHTML = "";
      markDirty(); render();
    };
  }

  async function saveLibrary() {
    const doc = clone(E());
    delete doc.updatedAt;
    try {
      const r = await api("PUT", "/api/lab/library", doc, { "X-Base-Rev": S.rev });
      await loadLibrary();
      if ((r.requalified || []).length) alert(`같은 컬러코드의 도장 시편이 늘어서, 전사 시료의 바탕 이름을 원래 가리키던 줄로 구체화했어요:\n${r.requalified.join("\n")}`);
      toast("저장했습니다 (｡•̀ᴗ-)✧");
      render();
    } catch (e) {
      if (e.status === 409) {
        if (confirm("다른 곳에서 먼저 저장했습니다. 그 내용을 불러올까요? (지금 화면의 변경은 사라집니다)")) { await loadLibrary(); render(); }
      } else toast(e.message, true);
    }
  }

  // ------------------------------------------------------------------ 라우팅
  const VIEWS = {
    predict: [viewPredict, goPredict], recommend: [viewRecommend, goRecommend], correct: [viewCorrect, goCorrect],
    similar: [viewSimilar, goSimilar], library: [viewLibrary, null], de: [viewDe, goDe],
  };

  function render() {
    const tab = (location.hash.match(/^#\/(\w+)/) || [])[1];
    S.tab = VIEWS[tab] ? tab : "predict";
    $$("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === S.tab));
    $$("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
    const main = $("#main");
    const y = window.scrollY;
    main.innerHTML = VIEWS[S.tab][0]();
    if (S.tab === "library") bindLibrary(main);
    else {
      bindFields(main, render);
      const go = $("#go");
      if (go) go.onclick = () => run(go, VIEWS[S.tab][1]);
      const out = $("#out");
      if (out) bindResult(out);
      if (go && S.autoRun === S.tab) { S.autoRun = null; go.click(); }
    }
    window.scrollTo(0, y);
  }

  $$("#mode button").forEach((b) => (b.onclick = () => {
    S.mode = b.dataset.mode; keep("cl.mode", S.mode);
    S.res = {};   // 결과는 모드마다 다르다
    render();
  }));
  window.addEventListener("hashchange", () => { window.scrollTo(0, 0); render(); });
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

  loadLibrary().then(render).catch((e) => { $("#status").innerHTML = `<span class="bad">${esc(e.message)}</span>`; });
})();
