/* RDP 시편 아카이브 — 사진 파일명에서 정보 읽기 (화면을 모르는 순수 함수)
 *
 * 왜 있나
 *   현장에서는 사진을 먼저 찍어 두고 나중에 등록한다. 파일명에 시편 코드·컬러·동판이
 *   들어 있는 경우가 많아, 그것을 읽어 칸을 미리 채우고 **이미 있는 시편이면 그 시편으로 연결**한다.
 *   규칙만 담아 tests/photo-intake.test.mjs 가 브라우저 없이 검사한다.
 *
 * 읽는 것(확신도 순)
 *   1) 이미 아카이브에 있는 시편 — 코드/ID 가 파일명에 들어 있으면 그 시편(가장 김)
 *   2) 컬러 코드 — E3940 · B3961 같은 영문1+숫자4
 *   3) 컬러명 — 기존 데이터에 있는 이름(블랙·실버·메탈 브라운 …)이 파일명에 있으면
 *   4) 동판 — 26_136 같은 숫자_숫자
 *   5) 새 시편 코드 후보 — G-60813-L1 · M-01120-M1 같은 모양
 */

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[\s_-]+/g, "");

/** 파일명에서 확장자 떼고 비교용 문자열로 */
export function baseName(name) {
  return String(name == null ? "" : name).replace(/\.[a-z0-9]{1,5}$/i, "");
}

/**
 * @param fileName 사용자가 고른 사진 파일 이름
 * @param patterns App.patterns (있으면 기존 시편 연결까지 시도)
 * @returns {matchId, code, colorCode, colorName, plate, from} — 못 읽은 값은 ""
 */
export function parsePhotoName(fileName, patterns) {
  const raw = baseName(fileName);
  const hay = norm(raw);
  const out = { matchId: "", code: "", colorCode: "", colorName: "", plate: "", from: [] };

  // 1) 기존 시편과 연결 — 코드/ID 를 파일명이 품고 있으면 그 시편
  let best = null;
  (patterns || []).forEach((p) => {
    const code = norm((p.pattern || {}).code);
    const id = norm(p.id);
    const bare = norm(String(p.id || "").replace(new RegExp("^" + String(p.project || "").replace(/[^\w]/g, "") + "-", "i"), ""));
    [code, id, bare].forEach((cand) => {
      if (!cand || cand.length < 4) return;
      if (hay.indexOf(cand) >= 0 && (!best || cand.length > best.len)) best = { id: p.id, len: cand.length };
    });
  });
  if (best) { out.matchId = best.id; out.from.push("기존 시편"); }

  // 2) 컬러 코드 (E3940 · B3961 · F3024 …)
  const cc = /(?:^|[^A-Z0-9])([A-Z]\d{4})(?![0-9])/.exec(raw.toUpperCase());
  if (cc) { out.colorCode = cc[1]; out.from.push("컬러코드"); }

  // 3) 컬러명 — 기존 데이터에 실제로 쓰인 이름만 인정한다(추측 금지)
  const names = [];
  (patterns || []).forEach((p) => (p.variations || []).forEach((v) => {
    const n = String(v.colorName || "").trim();
    if (n && n.length >= 2) names.push(n);
  }));
  const hitName = [...new Set(names)]
    .sort((a, b) => b.length - a.length)
    .find((n) => hay.indexOf(norm(n)) >= 0);
  if (hitName) { out.colorName = hitName; out.from.push("컬러명"); }

  // 4) 동판 (26_136)
  const pl = /(?:^|[^\d])(\d{2}_\d{3})(?![\d])/.exec(raw);
  if (pl) { out.plate = pl[1]; out.from.push("동판"); }

  // 5) 시편 코드 후보 — 기존 시편에 없을 때만 (새 시편 등록용)
  if (!out.matchId) {
    const m = /(?:^|[^A-Za-z0-9])([A-Z]{1,6}\d{0,2}-\d{3,6}(?:-[A-Za-z0-9.]+)?)/i.exec(raw);
    if (m) {
      const cand = m[1].replace(/[._]+$/, "").toUpperCase();
      const known = (patterns || []).find((p) => String((p.pattern || {}).code || "").toUpperCase() === cand);
      if (known) out.matchId = known.id; else out.code = cand;
      out.from.push(known ? "기존 시편" : "시편 코드");
    }
  }
  return out;
}

/** 읽은 값 요약 — 화면 안내문에 쓴다 */
export function describeParse(parsed) {
  const bits = [];
  if (parsed.matchId) bits.push(`기존 시편 ${parsed.matchId}`);
  else if (parsed.code) bits.push(`코드 ${parsed.code}`);
  if (parsed.colorName) bits.push(`컬러 ${parsed.colorName}`);
  if (parsed.colorCode) bits.push(`컬러코드 ${parsed.colorCode}`);
  if (parsed.plate) bits.push(`동판 ${parsed.plate}`);
  return bits.join(" · ");
}
