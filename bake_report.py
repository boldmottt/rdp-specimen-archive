"""RDP 시편 아카이브 — 개발 실적 보고서를 보기 전용 파일로 굽기

보고서 화면(#/report)에서 고른 구성(칸 · 순서 · 넣을 항목 · 칸 제목 · 연도/분류/담당자/차종)을 그대로
사진까지 들어간 HTML 한 파일로 만든다. PDF 는 server.py 가 같은 HTML 을 Chrome 으로 인쇄해서 만든다.
구성은 굽는 순간 서버(_bake/report.json)에 남겨 두므로, 자동 굽기가 시편이 바뀔 때 같은 구성으로 다시 굽는다.

규칙은 web/js/report-rules.js 와 같다(패턴 코드 → 개발일, 같은 코드는 한 줄, 제안 차종 모으기).
tests/test_server.py ReportBakeTests 가 JS 테스트와 같은 예로 검사한다.
보기는 web/styles.css 의 보고서 블록('/* 개발 실적 보고서 (#/report)' ~ '/* 개발 실적 보고서 끝 */')을 그대로 쓴다.

되돌리기: server.py 의 bake_report 호출(/api/bake/report · 자동 굽기 report)과 이 파일을 지우면 된다.
"""
import os
import re

from bake import _e, _natkey, _s

KIND_LABEL = {"G": "지오메트릭", "M": "메테리얼"}
SECTIONS = {
    "kpi": "",
    "monthly": "월별 개발 수",
    "stats": "분류 · 담당자 · 제안 차종",
    "cards": "개발 패턴",
    "table": "개발 패턴 목록",
}
DEFAULT_LAYOUT = [["kpi", True], ["monthly", True], ["stats", True], ["cards", True], ["table", False]]
FIELDS = ("no", "date", "kind", "cat", "name", "image", "developer", "vehicles", "colors", "remark")
NO_DEV = "담당자 미입력"


# ---------------------------------------------------------------- 규칙 (report-rules.js 와 같다)
def parse_pattern_code(code):
    s = re.sub(r"[\s_-]+", "", _s(code).upper())
    m = re.fullmatch(r"([GM])(\d)(\d{2})(\d{2})([A-Z]*)(\d*)", s)
    if not m:
        return None
    year, month, day = 2020 + int(m[2]), int(m[3]), int(m[4])
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    return {"kind": m[1], "year": year, "month": month, "day": day, "cat": m[5] or "", "seq": int(m[6]) if m[6] else None}


def dev_info(doc):
    pat = doc.get("pattern") or {}
    c = parse_pattern_code(pat.get("code"))
    if c:
        return {"year": c["year"], "month": c["month"], "day": c["day"], "kind": c["kind"], "cat": c["cat"], "source": "code"}
    code = _s(pat.get("code"))
    kind = code[0].upper() if code[:1].upper() in ("G", "M") else ""
    dd = re.match(r"(\d{4})[-./](\d{1,2})", _s(pat.get("devDate")))
    if dd:
        return {"year": int(dd[1]), "month": int(dd[2]), "day": None, "kind": kind, "cat": "", "source": "devDate"}
    dates = sorted(x for x in (re.sub(r"[./]", "-", _s(v.get("date"))) for v in doc.get("variations") or [] if isinstance(v, dict))
                   if re.match(r"\d{4}-\d{1,2}", x))
    if dates:
        y, mo = dates[0].split("-")[:2]
        return {"year": int(y), "month": int(mo), "day": None, "kind": kind, "cat": "", "source": "date"}
    return {"year": None, "month": None, "day": None, "kind": kind, "cat": "", "source": ""}


def _uniq(xs):
    out = []
    for x in xs:
        x = _s(x)
        if x and x not in out:
            out.append(x)
    return out


def vehicles_of(doc):
    pat = doc.get("pattern") or {}
    vs = [doc.get("project"), *(pat.get("vehicles") or [])]
    for v in doc.get("variations") or []:
        if isinstance(v, dict):
            vs += v.get("vehicles") or []
    return _uniq(vs)


def _code_key(code):
    return re.sub(r"[\s_-]+", "", _s(code).upper())


def report_rows(docs, flt=None):
    by = {}
    for p in docs:
        if not isinstance(p, dict):
            continue
        pat = p.get("pattern") or {}
        key = _code_key(pat.get("code")) or p.get("id")
        d = dev_info(p)
        r = by.get(key)
        if r is None:
            r = by[key] = {"key": key, "code": _s(pat.get("code")), "name": "", "year": d["year"], "month": d["month"], "day": d["day"],
                           "kind": d["kind"], "cat": d["cat"], "source": d["source"], "developer": "", "vehicles": [], "remark": "",
                           "ids": [], "image": None, "colors": 0}
        r["ids"].append(p.get("id"))
        r["colors"] += len(p.get("variations") or [])
        r["name"] = r["name"] or " · ".join(x for x in (_s(pat.get("nameKo")), _s(pat.get("name")) if _s(pat.get("name")) != r["code"] else "") if x)
        r["developer"] = r["developer"] or _s(pat.get("developer"))
        r["remark"] = " / ".join(_uniq([r["remark"], (p.get("label") or {}).get("remark")]))
        r["vehicles"] = _uniq(r["vehicles"] + vehicles_of(p))
        if not r["image"]:
            v = next((x for x in p.get("variations") or [] if isinstance(x, dict) and x.get("images")), None)
            if v:
                r["image"] = {"pid": p.get("id"), "file": v["images"][0]}
        if r["year"] is None and d["year"] is not None:
            r.update(year=d["year"], month=d["month"], day=d["day"], source=d["source"])
    f = flt or {}
    year = int(f["year"]) if _s(f.get("year")).isdigit() else None
    rows = [r for r in by.values()
            if (not year or r["year"] == year) and (not f.get("kind") or r["kind"] == f["kind"])
            and (not f.get("developer") or r["developer"] == f["developer"])
            and (not f.get("vehicle") or f["vehicle"] in r["vehicles"])]
    rows.sort(key=lambda r: (r["year"] or 9999, r["month"] or 99, r["day"] or 99, _natkey(r["code"])))
    return rows


def summarize(rows):
    def count(fn):
        m = {}
        for r in rows:
            for k in (fn(r) if isinstance(fn(r), list) else [fn(r)]):
                if k:
                    m[k] = m.get(k, 0) + 1
        return sorted(m.items(), key=lambda kv: (-kv[1], str(kv[0])))
    by_month = [0] * 12
    for r in rows:
        if r["month"] and 1 <= r["month"] <= 12:
            by_month[r["month"] - 1] += 1
    return {"total": len(rows), "colors": sum(r["colors"] for r in rows), "byMonth": by_month,
            "byKind": count(lambda r: r["kind"] and KIND_LABEL.get(r["kind"], r["kind"])),
            "byCat": count(lambda r: r["cat"]),
            "byDeveloper": count(lambda r: r["developer"] or NO_DEV),
            "byVehicle": count(lambda r: r["vehicles"]),
            "noDate": sum(1 for r in rows if r["year"] is None)}


# ---------------------------------------------------------------- 구성
def normalize_config(cfg) -> dict:
    """화면에서 보낸 구성을 검사한다 — 모르는 칸·항목은 버리고, 빠진 칸은 끝에 꺼진 채로 붙인다."""
    cfg = cfg if isinstance(cfg, dict) else {}
    layout, seen = [], set()
    for x in cfg.get("layout") or []:
        if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in SECTIONS and x[0] not in seen:
            layout.append([x[0], bool(x[1])])
            seen.add(x[0])
    if not layout:
        layout = [x[:] for x in DEFAULT_LAYOUT]
    layout += [[k, False] for k, _ in DEFAULT_LAYOUT if k not in {x[0] for x in layout}]
    titles = {k: _s(v)[:80] for k, v in (cfg.get("titles") or {}).items() if k in SECTIONS and _s(v)} if isinstance(cfg.get("titles"), dict) else {}
    year = _s(cfg.get("year"))
    return {"year": int(year) if year.isdigit() else "",
            "kind": _s(cfg.get("kind")) if _s(cfg.get("kind")) in KIND_LABEL else "",
            "developer": _s(cfg.get("developer"))[:60], "vehicle": _s(cfg.get("vehicle"))[:60], "title": _s(cfg.get("title"))[:120],
            "layout": layout, "hidden": [k for k in FIELDS if k in (cfg.get("hidden") or [])], "titles": titles}


# ---------------------------------------------------------------- 그리기 (report-page.js 와 같은 모양)
def report_css(web_dir) -> str:
    """앱의 보고서 CSS 블록을 그대로 가져온다(화면에서 고친 모양이 구운 파일에도 그대로)."""
    try:
        with open(os.path.join(web_dir, "styles.css"), encoding="utf-8") as f:
            css = f.read()
    except OSError:
        return ""
    a = css.find("/* 개발 실적 보고서 (#/report)")
    if a < 0:
        return ""
    b = css.find("/* 개발 실적 보고서 끝 */", a)
    return css[a:b if b > 0 else len(css)]


BASE_CSS = """
:root{--ink:#141517;--ink-2:#5b5f66;--ink-3:#6f737a;--line:#e4e1da;--line-2:#cfcbc2;--mono:ui-monospace,SFMono-Regular,Menlo,"Roboto Mono",monospace}
*{box-sizing:border-box}
body{margin:0;background:#f6f5f2;color:var(--ink);font:14px/1.5 Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;-webkit-text-size-adjust:100%}
a{color:inherit;text-decoration:none}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
.rp-baked{font-size:12px;color:var(--ink-3);padding:14px 0 10px}
.rp-baked b{color:var(--ink-2);font-weight:600}
.rp-doc{margin-bottom:40px}
@page{size:A4 portrait;margin:10mm 9mm}
@media print{body{background:#fff}.rp-baked{display:none}}
"""


def _bars(by_month):
    mx = max([1, *by_month])
    return '<div class="rp-bars">' + "".join(
        f'<div class="rp-bar"><span class="rp-bn">{n or ""}</span><i style="height:{round(n / mx * 100)}%"></i><span class="rp-bm">{i + 1}월</span></div>'
        for i, n in enumerate(by_month)) + "</div>"


def _rank(title, lst, limit=8):
    if not lst:
        return ""
    mx = max(n for _, n in lst)
    items = "".join(f'<div class="rp-ri"><span class="k">{_e(k)}</span><span class="b"><i style="width:{round(n / mx * 100)}%"></i></span><span class="n">{n}</span></div>'
                    for k, n in lst[:limit])
    more = f'<div class="rp-more">외 {len(lst) - limit}개</div>' if len(lst) > limit else ""
    return f'<div class="rp-rank"><h4>{_e(title)}</h4>{items}{more}</div>'


def build_report_html(docs, img, cfg, *, css="", brand="RDP", baked_at="") -> tuple:
    """(html, 줄 수). img(pid, file, w) → data: URL 또는 ''."""
    cfg = normalize_config(cfg)
    hidden = set(cfg["hidden"])
    has = lambda k: k not in hidden   # noqa: E731
    flt = {k: cfg[k] for k in ("year", "kind", "developer", "vehicle")}
    rows = report_rows(docs, flt)
    sm = summarize(rows)
    dim = lambda t: f'<span class="rp-dim">{t}</span>'   # noqa: E731
    chips = lambda r: "".join(f'<span class="rp-chip">{_e(v)}</span>' for v in r["vehicles"])   # noqa: E731
    guessed = lambda r: bool(r["source"]) and r["source"] != "code"   # noqa: E731

    def default_title(k):
        if k != "stats":
            return SECTIONS[k]
        return " · ".join(x for x in ("분류" if has("kind") or has("cat") else "", "담당자" if has("developer") else "",
                                      "제안 차종" if has("vehicles") else "") if x) or "통계"

    def head(k, tag="h3"):
        return f'<{tag} class="rp-sec-h">{_e(cfg["titles"].get(k) or default_title(k))}</{tag}>'

    def picture(r, w, alt=""):
        src = img(r["image"]["pid"], r["image"]["file"], w) if r["image"] else ""
        return f'<img src="{src}" alt="{_e(alt)}">' if src else '<div class="rp-noimg">사진 없음</div>'

    def card(r, i):
        when = f'{r["year"]}년 {str(r["month"]) + "월" if r["month"] else ""}{" " + str(r["day"]) + "일" if r["day"] else ""}' if r["year"] else "개발일 미상"
        dl = "".join(x for x in (
            has("developer") and f'<dt>담당자</dt><dd>{_e(r["developer"]) or dim("미입력")}</dd>',
            has("vehicles") and f'<dt>제안 차종</dt><dd>{chips(r) or dim("—")}</dd>',
            has("colors") and f'<dt>베리에이션</dt><dd>{r["colors"]}개</dd>',
            has("remark") and r["remark"] and f'<dt>비고</dt><dd>{_e(r["remark"])}</dd>') if x)
        name = ""
        if has("name") or (has("cat") and r["cat"]):
            nm = (_e(r["name"]) or dim("패턴 이름 없음")) if has("name") else ""
            cat = f'<small>이미지 분류 {_e(r["cat"])}</small>' if has("cat") and r["cat"] else ""
            name = f'<div class="rp-pc-name">{nm}{cat}</div>'
        return f"""<article class="rp-pc"><div class="rp-pc-img">{picture(r, 960, r["code"])}{f'<span class="rp-pc-no">{i + 1}</span>' if has("no") else ""}</div>
      <div class="rp-pc-body"><div class="rp-pc-top"><span class="rp-pc-code">{_e(r["code"])}</span>
        {f'<span class="rp-pc-kind">{_e(KIND_LABEL.get(r["kind"], r["kind"]))}</span>' if has("kind") and r["kind"] else ""}
        {f'<span class="rp-pc-date">{when}{" (추정)" if guessed(r) else ""}</span>' if has("date") else ""}</div>
        {name}{f'<dl class="rp-pc-dl">{dl}</dl>' if dl else ""}</div></article>"""

    cols = [c for c in (
        ("no", "#", "c-no", lambda r, i: str(i + 1)),
        ("date", "개발년도", "c-y", lambda r, i: str(r["year"] or "—")),
        ("date", "개발월", "c-m", lambda r, i: f'{r["month"]}월' if r["month"] else "—"),
        ("image", "이미지", "c-img", lambda r, i: picture(r, 240)),
        ("kind", "분류", "c-k", lambda r, i: _e(KIND_LABEL.get(r["kind"], r["kind"])) if r["kind"] else "—"),
        ("name", "패턴이름", "c-name", lambda r, i: (_e(r["name"]) or dim("—")) + (f'<small>분류 {_e(r["cat"])}</small>' if has("cat") and r["cat"] else "")),
        ("", "패턴코드", "c-code", lambda r, i: _e(r["code"]) + ("<small>개발일 추정</small>" if has("date") and guessed(r) else "")),
        ("developer", "담당자", "c-dev", lambda r, i: _e(r["developer"]) or dim("미입력")),
        ("vehicles", "제안차종", "c-veh", lambda r, i: chips(r)),
        ("colors", "베리에이션", "c-n", lambda r, i: f'{r["colors"]}개'),
        ("remark", "비고", "c-note", lambda r, i: _e(r["remark"])),
    ) if not c[0] or has(c[0])]

    def section(k):
        if k == "kpi":
            ks = [(sm["total"], "개발 패턴")]
            if has("vehicles"):
                ks.append((len(sm["byVehicle"]), "제안 차종"))
            if has("colors"):
                ks.append((sm["colors"], "베리에이션"))
            if has("developer"):
                ks.append((len([d for d, _ in sm["byDeveloper"] if d != NO_DEV]), "담당자"))
            return (f'<section class="rp-sec rp-sec-kpi"><div class="rp-kpis" style="--n:{len(ks)}">'
                    + "".join(f"<div><b>{n}</b><span>{t}</span></div>" for n, t in ks) + "</div></section>")
        if k == "monthly":
            return f'<section class="rp-sec">{head("monthly", "h4")}<div class="rp-card">{_bars(sm["byMonth"])}</div></section>'
        if k == "stats":
            cards = [c for c in (
                (has("kind") or has("cat")) and (_rank("분류", sm["byKind"]) if has("kind") else "") + (_rank("이미지 분류", sm["byCat"], 6) if has("cat") else ""),
                has("developer") and _rank("담당자", sm["byDeveloper"]),
                has("vehicles") and _rank("제안 차종", sm["byVehicle"], 10)) if c]
            if not cards:
                return ""
            return (f'<section class="rp-sec">{head("stats", "h4")}<div class="rp-grid3" style="--n:{len(cards)}">'
                    + "".join(f'<div class="rp-card">{c}</div>' for c in cards) + "</div></section>")
        if k == "cards":
            return f'<section class="rp-sec rp-sec-page">{head("cards")}<div class="rp-cards">{"".join(card(r, i) for i, r in enumerate(rows))}</div></section>'
        if k == "table":
            th = "".join(f'<th class="{c}">{t}</th>' for _, t, c, _f in cols)
            trs = "".join("<tr>" + "".join(f'<td class="{c}">{fn(r, i)}</td>' for _, _t, c, fn in cols) + "</tr>" for i, r in enumerate(rows))
            return f'<section class="rp-sec rp-sec-page">{head("table")}<div class="rp-tscroll"><table class="rp-table"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div></section>'
        return ""

    on = [k for k, v in cfg["layout"] if v]
    scope = " · ".join(x for x in (KIND_LABEL.get(cfg["kind"], ""), cfg["developer"] and f'담당 {cfg["developer"]}',
                                   cfg["vehicle"] and f'차종 {cfg["vehicle"]}') if x)
    title = cfg["title"] or f'{str(cfg["year"]) + "년 " if cfg["year"] else ""}패턴 개발 실적'
    day = _s(baked_at)[:10]
    body = ('<p class="rp-empty">조건에 맞는 패턴이 없습니다.</p>' if not rows
            else '<p class="rp-empty">넣을 칸이 없습니다.</p>' if not on else "".join(section(k) for k in on))
    html = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>{_e(title)}</title>
<style>{BASE_CSS}{css}</style>
</head><body class="report-mode">
<div class="wrap report-page">
  <p class="rp-baked"><b>{_e(brand)} 시편 아카이브</b> · {_e(baked_at)}에 만든 보기 전용 사본 — 고치려면 아카이브 앱 보고서 화면에서</p>
  <div class="rp-doc">
    <header class="rp-head"><h1>{_e(title)}</h1><p>{_e(scope) + " · " if scope else ""}{_e(day)} 기준</p></header>
    {body}
  </div>
</div>
</body></html>"""
    return html, len(rows)
