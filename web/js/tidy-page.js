/* RDP 시편 아카이브 — 정리 도구 (#/tidy)
 *
 * 탭 네 개:
 *   정리할 것  — 공백·코드 중복·날짜 형식·비슷한 값·빈 칸 점검. 공백은 한 번에 고치고, 빈 칸은 목차 검색으로 넘어간다.
 *   찾아 바꾸기 — 여러 시편의 글자 칸에서 찾아 바꾸기. 미리보기에서 고른 곳만 바꾼다.
 *   값 통일    — '홍길동' / '홍 길동' 처럼 갈라진 값을 하나로 합친다(비슷한 값 제안 + 직접 고르기).
 *   태그       — 태그 사용 수 · 이름 바꾸기(같은 이름이 있으면 합쳐짐) · 지우기 · 여러 개 합치기.
 * 저장은 모두 saveMany(평소 저장 · rev 검사 · 시편 [이력]에서 되돌리기). 규칙은 tidy-rules.js.
 *
 * 되돌리기: main.js 의 #/tidy 라우트, 목차 ⋯ 메뉴의 '정리 도구', 이 파일과 tidy-rules.js 를 지우면 된다.
 */
import { $, $$, App, byId, esc, vName } from "./core.js";
import { saveMany, reportSave } from "./save-many.js";
import { setView } from "./views.js";
import {
  FIELDS, FIELD, CHECKS, findMatches, applyReplace, clusterValues, valueCounts, mergeValues, tagUsage, qualityIssues, tidySpaces,
} from "./tidy-rules.js";

const S = {
  tab: "check", scope: null,
  fr: { find: "", repl: "", regex: false, caseSensitive: false, whole: false, fields: FIELDS.filter((f) => f.key !== "note").map((f) => f.key) },
  frOff: new Set(),          // 미리보기에서 끈 자리 (pid::slot)
  mergeField: "worker",
};

const scoped = () => App.patterns.filter((p) => !S.scope || S.scope === "all" || p.project === S.scope);
const pLabel = (pid, vid) => {
  const p = byId(pid);
  if (!p) return esc(pid);
  const v = vid && (p.variations || []).find((x) => x.id === vid);
  return `<a href="#/p/${encodeURIComponent(pid)}${v ? "/" + encodeURIComponent(v.id) : ""}">${esc(p.project)} ${esc(p.pattern.code)}${v ? " · " + esc(vName(v)) : ""}</a>`;
};

/** 저장 공통 — 확인 → 차례로 저장 → 결과 알림 → 다시 그리기 */
async function run(items, what) {
  if (!items.length) return;
  if (!confirm(`${items.length}개 시편을 고칩니다. ${what}\n\n(시편마다 [이력]에서 되돌릴 수 있어요) 계속할까요?`)) return;
  const st = $("#td-status");
  const res = await saveMany(items, (i, n) => { if (st) st.textContent = `저장 중… ${i} / ${n}`; });
  if (st) st.textContent = "";
  reportSave(res);
  paint();
}

/* ---------- 정리할 것 ---------- */
function checkHTML() {
  const q = qualityIssues(scoped());
  return `<div class="td-checks">${CHECKS.map((c) => {
    const list = q[c.key];
    const n = list.length;
    const pids = [...new Set(list.map((x) => x.pid).filter(Boolean))];
    const act = !n ? "" : c.key === "space" ? `<button type="button" class="tool" data-fix="space">공백 정리 (${pids.length}개 시편)</button>`
      : c.key === "similar" ? `<button type="button" class="tool" data-tab="merge">값 통일로</button>`
      : c.query ? `<button type="button" class="tool" data-q="${esc(c.query)}">목차에서 보기</button>` : "";
    return `<details class="td-check lv-${c.level}${n ? "" : " ok"}"${n && c.level !== "info" ? " open" : ""}>
        <summary><b>${esc(c.label)}</b><span class="td-n">${n ? n : "없음 ✓"}</span>${act}</summary>
        ${c.desc ? `<p class="td-desc">${esc(c.desc)}</p>` : ""}
        ${n ? `<ul>${list.slice(0, 60).map((x) => `<li>${x.pid ? pLabel(x.pid, x.vid) : ""}${x.msg ? ` <span>${esc(x.msg)}</span>` : ""}</li>`).join("")}${n > 60 ? `<li class="more">… ${n - 60}개 더</li>` : ""}</ul>` : ""}
      </details>`;
  }).join("")}</div>`;
}
function bindCheck(root) {
  const fix = $('[data-fix="space"]', root);
  if (fix) fix.onclick = (e) => {
    e.preventDefault();
    const pids = [...new Set(qualityIssues(scoped()).space.map((x) => x.pid))];
    run(pids.map((pid) => ({ pid, label: byId(pid).pattern.code, mutate: tidySpaces })), "앞뒤 공백을 지우고 겹친 공백을 하나로 줄입니다.");
  };
  $$("[data-q]", root).forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    App.q = b.dataset.q;
    if (S.scope && S.scope !== "all") App.project = S.scope;
    setView("table");
    const box = $("#search"); if (box) box.value = App.q;
    location.hash = "";
  }));
}

/* ---------- 찾아 바꾸기 ---------- */
function frMatches() {
  try { return { list: findMatches(scoped(), S.fr, S.fr.fields) }; } catch (e) { return { list: [], err: e.message }; }
}
function frHTML() {
  const f = S.fr;
  return `<div class="td-fr">
      <div class="td-row"><input id="fr-find" placeholder="찾을 글자" value="${esc(f.find)}"> → <input id="fr-repl" placeholder="바꿀 글자 (비우면 지움)" value="${esc(f.repl)}"></div>
      <div class="td-row td-opts">
        <label><input type="checkbox" id="fr-cs"${f.caseSensitive ? " checked" : ""}> 대소문자 구분</label>
        <label><input type="checkbox" id="fr-whole"${f.whole ? " checked" : ""}> 낱말 전체만</label>
        <label><input type="checkbox" id="fr-regex"${f.regex ? " checked" : ""}> 정규식 <small>($1 로 묶음 쓰기)</small></label>
      </div>
      <div class="td-row td-fields">칸: ${FIELDS.map((x) => `<label class="chip-chk"><input type="checkbox" data-frf="${x.key}"${f.fields.includes(x.key) ? " checked" : ""}> ${esc(x.label)}</label>`).join("")}</div>
      <div id="fr-prev"></div>
    </div>`;
}
function paintFr() {
  const box = $("#fr-prev");
  if (!box) return;
  const { list, err } = frMatches();
  if (err) { box.innerHTML = `<p class="td-err">${esc(err)}</p>`; return; }
  if (!S.fr.find) { box.innerHTML = `<p class="td-desc">찾을 글자를 넣으면 바뀔 곳을 미리 보여 줍니다.</p>`; return; }
  if (!list.length) { box.innerHTML = `<p class="td-desc">찾은 곳이 없습니다.</p>`; return; }
  const on = list.filter((m) => !S.frOff.has(m.pid + "::" + m.slot));
  box.innerHTML = `<div class="td-bar"><span>${list.length}곳 찾음 · ${new Set(list.map((m) => m.pid)).size}개 시편</span>
      <button type="button" class="btn-dark" id="fr-go"${on.length ? "" : " disabled"}>고른 ${on.length}곳 바꾸기</button></div>
    <div class="tbl-wrap"><table class="mix td-table"><tr><th><input type="checkbox" id="fr-all"${on.length === list.length ? " checked" : ""}></th><th>시편</th><th>칸</th><th>지금</th><th>바뀐 뒤</th></tr>
      ${list.slice(0, 500).map((m) => `<tr><td><input type="checkbox" data-fr="${esc(m.pid + "::" + m.slot)}"${S.frOff.has(m.pid + "::" + m.slot) ? "" : " checked"}></td>
        <td>${pLabel(m.pid, m.vid)}</td><td>${esc(FIELD[m.field].label)}</td><td class="before">${esc(m.before)}</td><td class="after">${esc(m.after) || "<i>(빈 칸)</i>"}</td></tr>`).join("")}
    </table></div>${list.length > 500 ? `<p class="td-desc">미리보기는 500곳까지 보여 줍니다 — 바꾸기는 고른 곳 모두에 합니다.</p>` : ""}`;
  $$("[data-fr]", box).forEach((c) => (c.onchange = () => { if (c.checked) S.frOff.delete(c.dataset.fr); else S.frOff.add(c.dataset.fr); paintFr(); }));
  $("#fr-all").onchange = (e) => { list.forEach((m) => (e.target.checked ? S.frOff.delete(m.pid + "::" + m.slot) : S.frOff.add(m.pid + "::" + m.slot))); paintFr(); };
  $("#fr-go").onclick = () => {
    const by = new Map();
    on.forEach((m) => { if (!by.has(m.pid)) by.set(m.pid, []); by.get(m.pid).push(m.slot); });
    const opts = { ...S.fr };
    run([...by].map(([pid, slots]) => ({ pid, label: byId(pid).pattern.code, mutate: (d) => applyReplace(d, slots, opts) })),
      `"${S.fr.find}" → "${S.fr.repl}" (${on.length}곳)`);
  };
}
function bindFr() {
  let tm = 0;
  const later = () => { clearTimeout(tm); tm = setTimeout(() => { S.frOff.clear(); paintFr(); }, 180); };
  $("#fr-find").oninput = (e) => { S.fr.find = e.target.value; later(); };
  $("#fr-repl").oninput = (e) => { S.fr.repl = e.target.value; later(); };
  $("#fr-cs").onchange = (e) => { S.fr.caseSensitive = e.target.checked; later(); };
  $("#fr-whole").onchange = (e) => { S.fr.whole = e.target.checked; later(); };
  $("#fr-regex").onchange = (e) => { S.fr.regex = e.target.checked; later(); };
  $$("[data-frf]").forEach((c) => (c.onchange = () => {
    S.fr.fields = $$("[data-frf]").filter((x) => x.checked).map((x) => x.dataset.frf);
    later();
  }));
  paintFr();
}

/* ---------- 값 통일 ---------- */
function mergeHTML() {
  const k = S.mergeField;
  const clusters = clusterValues(scoped(), k);
  const vals = valueCounts(scoped(), k);
  return `<div class="td-merge">
      <div class="td-row">칸 <select id="mg-field">${FIELDS.filter((f) => f.key !== "note").map((f) => `<option value="${f.key}"${f.key === k ? " selected" : ""}>${esc(f.label)}</option>`).join("")}</select>
        <span class="td-desc">값 ${vals.length}가지</span></div>
      <h3>비슷한 값 ${clusters.length ? clusters.length + "묶음" : ""}</h3>
      ${clusters.length ? clusters.map((c, i) => `<div class="td-cluster" data-ci="${i}">
          ${c.values.map((x, j) => `<label><input type="radio" name="cl${i}" value="${esc(x.value)}"${j === 0 ? " checked" : ""}> <b>${esc(x.value)}</b> <span>${x.n}</span></label>`).join("")}
          <label class="td-own"><input type="radio" name="cl${i}" value="__own"> 직접: <input class="td-ownv" placeholder="새 값"></label>
          <button type="button" class="tool" data-cl="${i}">이 값으로 통일</button>
        </div>`).join("") : `<p class="td-desc">띄어쓰기·대소문자·기호만 다른 값이 없습니다 ✓</p>`}
      <h3>모든 값 <small>— 골라서 하나로 합치기</small></h3>
      <div class="td-bar"><input id="mg-to" placeholder="합칠 값 (고른 값 중 하나를 눌러도 됨)"><button type="button" class="btn-dark" id="mg-go">고른 값 합치기</button></div>
      <div class="td-vals">${vals.map((x) => `<label class="chip-chk"><input type="checkbox" data-mv="${esc(x.value)}"> ${esc(x.value)} <span>${x.n}</span></label>`).join("")}</div>
    </div>`;
}
function bindMerge(root) {
  const k = S.mergeField;
  $("#mg-field", root).onchange = (e) => { S.mergeField = e.target.value; paint(); };
  const doMerge = (from, to) => {
    from = from.filter((x) => x !== to);
    if (!from.length) return;
    const pids = scoped().filter((p) => mergeValues(JSON.parse(JSON.stringify(p)), k, from, to)).map((p) => p.id);
    run(pids.map((pid) => ({ pid, label: byId(pid).pattern.code, mutate: (d) => mergeValues(d, k, from, to) })),
      `${FIELD[k].label}: ${from.map((x) => `"${x}"`).join(", ")} → "${to}"`);
  };
  const clusters = clusterValues(scoped(), k);
  $$("[data-cl]", root).forEach((b) => (b.onclick = () => {
    const box = b.closest(".td-cluster");
    const pick = $("input[type=radio]:checked", box).value;
    const to = pick === "__own" ? $(".td-ownv", box).value.trim() : pick;
    if (!to) { alert("통일할 값을 넣어 주세요"); return; }
    doMerge(clusters[Number(b.dataset.cl)].values.map((x) => x.value), to);
  }));
  $$("[data-mv]", root).forEach((c) => (c.onchange = () => { if (c.checked && !$("#mg-to").value) $("#mg-to").value = c.dataset.mv; }));
  $("#mg-go", root).onclick = () => {
    const from = $$("[data-mv]", root).filter((c) => c.checked).map((c) => c.dataset.mv);
    const to = $("#mg-to").value.trim();
    if (!from.length || !to) { alert("합칠 값들을 고르고, 합칠 값을 넣어 주세요"); return; }
    doMerge(from, to);
  };
}

/* ---------- 태그 ---------- */
function tagsHTML() {
  const tags = tagUsage(scoped());
  return `<div class="td-tags">
      <div class="td-bar"><span>태그 ${tags.length}개</span>
        <input id="tg-to" placeholder="고른 태그를 합칠 이름"><button type="button" class="btn-dark" id="tg-merge">고른 태그 합치기</button></div>
      <div class="tbl-wrap"><table class="mix td-table"><tr><th></th><th>태그</th><th>시편</th><th>이름 바꾸기 <small>(이미 있는 이름이면 합쳐짐)</small></th><th></th></tr>
      ${tags.map((x) => `<tr><td><input type="checkbox" data-tg="${esc(x.tag)}"></td><td><b>${esc(x.tag)}</b></td><td>${x.n}</td>
        <td><input class="tg-new" data-tgfor="${esc(x.tag)}" placeholder="새 이름" value=""> <button type="button" class="tool" data-tgren="${esc(x.tag)}">바꾸기</button></td>
        <td><button type="button" class="tool danger" data-tgdel="${esc(x.tag)}">지우기</button></td></tr>`).join("")}
      </table></div></div>`;
}
function bindTags(root) {
  const go = (from, to, what) => {
    const pids = scoped().filter((p) => mergeValues(JSON.parse(JSON.stringify(p)), "tags", from, to)).map((p) => p.id);
    run(pids.map((pid) => ({ pid, label: byId(pid).pattern.code, mutate: (d) => mergeValues(d, "tags", from, to) })), what);
  };
  $$("[data-tgren]", root).forEach((b) => (b.onclick = () => {
    const from = b.dataset.tgren;
    const inp = $$(".tg-new", root).find((x) => x.dataset.tgfor === from);
    const to = inp.value.trim();
    if (!to || to === from) { inp.focus(); return; }
    go([from], to, `태그 "${from}" → "${to}"`);
  }));
  $$(".tg-new", root).forEach((inp) => (inp.onkeydown = (e) => { if (e.key === "Enter") $$("[data-tgren]", root).find((b) => b.dataset.tgren === inp.dataset.tgfor).click(); }));
  $$("[data-tgdel]", root).forEach((b) => (b.onclick = () => go([b.dataset.tgdel], "", `태그 "${b.dataset.tgdel}" 를 지웁니다.`)));
  $$("[data-tg]", root).forEach((c) => (c.onchange = () => { if (c.checked && !$("#tg-to").value) $("#tg-to").value = c.dataset.tg; }));
  $("#tg-merge", root).onclick = () => {
    const from = $$("[data-tg]", root).filter((c) => c.checked).map((c) => c.dataset.tg);
    const to = $("#tg-to").value.trim();
    if (from.length < 1 || !to) { alert("합칠 태그를 고르고 이름을 넣어 주세요"); return; }
    go(from, to, `태그 ${from.map((x) => `"${x}"`).join(", ")} → "${to}"`);
  };
}

/* ---------- 화면 ---------- */
const TABS = [["check", "정리할 것"], ["fr", "찾아 바꾸기"], ["merge", "값 통일"], ["tags", "태그"]];

function paint() {
  const body = $("#td-body");
  if (!body) return;
  $$("[data-tdtab]").forEach((b) => b.classList.toggle("on", b.dataset.tdtab === S.tab));
  if (S.tab === "check") { body.innerHTML = checkHTML(); bindCheck(body); }
  else if (S.tab === "fr") { body.innerHTML = frHTML(); bindFr(); }
  else if (S.tab === "merge") { body.innerHTML = mergeHTML(); bindMerge(body); }
  else { body.innerHTML = tagsHTML(); bindTags(body); }
  $$("[data-tab]", body).forEach((b) => (b.onclick = (e) => { e.preventDefault(); S.tab = b.dataset.tab; paint(); }));
}

export function renderTidy() {
  document.body.classList.remove("prop-mode");
  if (S.scope === null) S.scope = App.project || "all";
  const projects = [...new Set(App.patterns.map((p) => p.project).filter(Boolean))].sort();
  $("#view").innerHTML = `<div class="wrap tidy-page">
      <div class="pl-head"><h1>정리 도구</h1>
        <span class="pl-sub">빈 칸·갈라진 값·태그를 한 화면에서 — 고친 시편은 [이력]에서 되돌릴 수 있어요</span></div>
      <div class="td-top">
        <div class="seg" role="tablist">${TABS.map(([k, l]) => `<button type="button" class="segbtn${S.tab === k ? " on" : ""}" data-tdtab="${k}">${l}</button>`).join("")}</div>
        <label>범위 <select id="td-scope"><option value="all">전체</option>${projects.map((x) => `<option${S.scope === x ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
        <span id="td-status" class="td-status" aria-live="polite"></span>
      </div>
      <div id="td-body"></div>
    </div>`;
  $$("[data-tdtab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tdtab; paint(); }));
  $("#td-scope").onchange = (e) => { S.scope = e.target.value; paint(); };
  paint();
}
