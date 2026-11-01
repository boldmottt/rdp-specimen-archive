"""RDP 시편 아카이브 — 보기 전용 파일 굽기(Bake)

서버가 꺼져 있어도 볼 수 있게, 지금 시편들을 '파일 하나'로 굳힌다.
  · HTML 한 파일: 사진까지 안에 넣는다(인터넷·서버 없이 열림). 검색·프로젝트 고르기·배합 펼치기는 있으면 쓰고
    (자바스크립트), 없어도 내용은 다 보인다(휴대폰 미리보기·인쇄).
  · PDF: 같은 HTML 을 Chrome(있으면)으로 인쇄해서 만든다.
고칠 수는 없다 — 읽기 전용 사본이다. 굽는 시각을 맨 위에 적는다.

audience
  internal  내부용: 메모·배합·작업 정보·동판·별점까지
  client    고객용: 미팅 모드처럼 메모·배합·동판을 빼고, 작업 정보·별점도 뺀다

되돌리기: server.py 의 bake 호출(/api/bake · --bake · autoBake)과 이 파일을 지우면 된다.
"""
import json
import re
from html import escape

AUDIENCES = ("internal", "client")


def _s(x) -> str:
    return "" if x is None else str(x).strip()


def _e(x) -> str:
    return escape(_s(x), quote=True)


def _natkey(s):
    return [(0, int(t), "") if t.isdigit() else (1, 0, t.lower()) for t in re.split(r"(\d+)", _s(s)) if t != ""]


def _num(x) -> str:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return _s(x)
    return str(int(f)) if f == int(f) else f"{f:g}"


def _work(doc, v) -> dict:
    """유효 작업 정보 — 컬러별 값(v.work)이 있으면 그것이 이긴다(work.js 와 같은 규칙)."""
    out = dict(doc.get("work") or {})
    for k, val in ((v or {}).get("work") or {}).items():
        if k in ("place", "worker", "machine", "volume") and _s(val):
            out[k] = val
    return out


def _vname(v) -> str:
    return _s(v.get("colorName")) or _s(v.get("colorCode")) or "기본"


def _mix_html(m) -> str:
    inks = m.get("inks") if isinstance(m.get("inks"), dict) else {}
    ink = " · ".join(f"{_e(k)} {_num(g)}" for k, g in inks.items() if _s(g))
    extra = []
    for key, label in (("thinner", "신너"), ("hardener", "경화제"), ("matting", "소광")):
        pct, g = m.get(key + "Pct"), m.get(key + "G")
        if _s(pct) or _s(g):
            extra.append(f"{label} {_num(pct) + '%' if _s(pct) else ''}{' (' + _num(g) + 'g)' if _s(g) else ''}")
    head = " ".join(x for x in (_e(m.get("layer")), f"배치 {_e(m.get('batch'))}" if _s(m.get("batch")) else "",
                                 f"동판 {_e(m.get('plate'))}" if _s(m.get("plate")) else "") if x)
    tail = " · ".join(_e(x) for x in (m.get("result"), m.get("note"), m.get("date")) if _s(x))
    ref = ' <b class="ref">기준</b>' if m.get("isReference") or m.get("is_base") else ""
    return (f'<li><span class="mh">{head}{ref}</span> <span class="mi">{ink or "—"}</span>'
            f'{"<span class=mx> · " + " · ".join(extra) + "</span>" if extra else ""}'
            f'{"<span class=mt> — " + tail + "</span>" if tail else ""}</li>')


def _color_html(doc, v, img, internal) -> str:
    pid = doc.get("id")
    pic = img(pid, (v.get("images") or [None])[0]) if v.get("images") else ""
    rating = int(v.get("rating") or 0) if str(v.get("rating") or "0").isdigit() else 0
    meta = [x for x in (_s(v.get("status")), _s(v.get("date"))) if x]
    rows = []
    coat = [c for c in (v.get("coating") or []) if isinstance(c, dict) and (_s(c.get("code")) or _s(c.get("maker")))]
    if coat:
        rows.append(("도장", ", ".join(" ".join(x for x in (_s(c.get("code")), _s(c.get("maker"))) if x) for c in coat)))
    if internal:
        lp = v.get("layerPlates") if isinstance(v.get("layerPlates"), dict) else {}
        if lp:
            rows.append(("동판", " · ".join(f"{k}={val}" for k, val in lp.items() if _s(val))))
        w = _work(doc, v)
        if (v.get("work") or {}) and any(_s((v.get("work") or {}).get(k)) for k in ("place", "worker", "machine")):
            rows.append(("작업", " · ".join(_s(w.get(k)) for k in ("place", "worker", "machine") if _s(w.get(k)))))
    body = "".join(f"<div class=kv><span>{_e(k)}</span>{_e(val)}</div>" for k, val in rows)
    mixes = [m for m in (v.get("mixes") or []) if isinstance(m, dict)] if internal else []
    note = _s(v.get("note")) if internal else ""
    more = ""
    if mixes or note:
        more = (f'<div class="more">{"<ul class=mixes>" + "".join(_mix_html(m) for m in mixes) + "</ul>" if mixes else ""}'
                f'{"<p class=note>" + _e(note).replace(chr(10), "<br>") + "</p>" if note else ""}</div>')
    stars = ""
    if internal and (rating or v.get("flag")):
        stars = f'<span class="stars" title="별점 {rating}">{"★" * rating}{"<i>⚑</i>" if v.get("flag") else ""}</span>'
    return f"""<article class="col">
      {f'<img src="{pic}" alt="{_e(_vname(v))}" loading="lazy">' if pic else '<div class="noimg">사진 없음</div>'}
      <div class="ct"><b>{_e(v.get("colorCode"))}</b> {_e(v.get("colorName")) if _s(v.get("colorName")) != _s(v.get("colorCode")) else ""}{stars}</div>
      {f'<div class="cm">{" · ".join(_e(x) for x in meta)}</div>' if meta else ""}
      {body}{more}
    </article>"""


def _search_text(doc) -> str:
    p = doc.get("pattern") or {}
    bits = [doc.get("project"), doc.get("projectName"), doc.get("client"), p.get("code"), p.get("name"), p.get("nameKo"),
            " ".join(p.get("tags") or [])]
    for v in doc.get("variations") or []:
        bits += [v.get("colorCode"), v.get("colorName"), v.get("status"), v.get("date")]
    return " ".join(_s(x) for x in bits if _s(x)).lower()


def _pattern_html(doc, img, internal) -> str:
    p = doc.get("pattern") or {}
    lab = doc.get("label") or {}
    work = doc.get("work") or {}
    names = " ".join(x for x in (_s(p.get("name")) if _s(p.get("name")) != _s(p.get("code")) else "", _s(p.get("nameKo"))) if x)
    facts = [("고객", doc.get("client")), ("차종", doc.get("projectName")), ("품목", lab.get("item")), ("구분", lab.get("type"))]
    if internal:
        facts += [("공급사", lab.get("supplier")), ("작업 장소", work.get("place")), ("작업자", work.get("worker")),
                  ("설비", work.get("machine")), ("동판", ", ".join(work.get("plate") or []) if isinstance(work.get("plate"), list) else work.get("plate")),
                  ("엠보", work.get("emboss")), ("패드", work.get("pad")), ("양산", work.get("sop")), ("수량", work.get("volume"))]
    facts_html = "".join(f"<span><i>{_e(k)}</i> {_e(val)}</span>" for k, val in facts if _s(val))
    tags = "".join(f"<span class=tag>#{_e(t)}</span>" for t in (p.get("tags") or []) if _s(t))
    statuses = sorted({_s(v.get("status")) for v in doc.get("variations") or [] if _s(v.get("status"))})
    cols = "".join(_color_html(doc, v, img, internal) for v in doc.get("variations") or [] if isinstance(v, dict))
    return f"""<section class="pat" data-project="{_e(doc.get('project'))}" data-status="{_e('|'.join(statuses))}" data-q="{_e(_search_text(doc))}">
    <header><h2><span class="pj">{_e(doc.get("project"))}</span> {_e(p.get("code"))} <small>{_e(names)}</small></h2>
      <div class="facts">{facts_html}</div>{f'<div class="tags">{tags}</div>' if tags else ""}</header>
    <div class="cols">{cols}</div>
  </section>"""


CSS = """
:root{--ink:#141517;--ink2:#555a61;--ink3:#8d9198;--line:#e4e1da;--bg:#f6f5f2;--card:#fff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;color:var(--ink);background:var(--bg)}
.top{position:relative;z-index:5;background:rgba(246,245,242,.96);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:12px 16px}
.top h1{margin:0;font-size:18px}
.top .sub{color:var(--ink3);font-size:12px;margin-top:2px}
.tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
.tools input[type=search]{flex:1;min-width:180px;max-width:420px;padding:8px 11px;border:1px solid var(--line);border-radius:9px;font:inherit;background:#fff}
.tools select{padding:7px 8px;border:1px solid var(--line);border-radius:9px;font:inherit;background:#fff}
.tools label{font-size:12.5px;color:var(--ink2);display:flex;gap:5px;align-items:center}
.tools .n{color:var(--ink3);font-size:12px}
main{padding:14px 16px 60px;max-width:1400px;margin:0 auto}
.pat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:0 0 14px}
.pat h2{margin:0;font-size:17px;letter-spacing:-.01em}
.pat h2 .pj{font-size:11.5px;font-weight:600;color:var(--ink2);border:1px solid var(--line);border-radius:999px;padding:1px 8px;vertical-align:2px;margin-right:4px}
.pat h2 small{font-weight:400;color:var(--ink2);font-size:13px;margin-left:4px}
.facts{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12.5px}
.facts i{font-style:normal;color:var(--ink3);margin-right:2px}
.tags{margin-top:5px;display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:11.5px;color:var(--ink2);background:var(--bg);border-radius:999px;padding:1px 8px}
.cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:12px}
.col{border:1px solid var(--line);border-radius:10px;padding:8px;break-inside:avoid}
.col img,.col .noimg{width:100%;aspect-ratio:170/70;object-fit:cover;border-radius:7px;display:block;background:#ecebe6}
.col .noimg{display:flex;align-items:center;justify-content:center;color:var(--ink3);font-size:12px}
.ct{margin-top:7px;font-size:13.5px}
.ct .stars{color:#d8a21a;margin-left:6px;font-size:12px}
.ct .stars i{font-style:normal;color:#c2412d;margin-left:4px}
.cm{color:var(--ink2);font-size:12px}
.kv{font-size:12px;color:var(--ink2)}
.kv span{color:var(--ink3);margin-right:5px}
.more{margin-top:6px;border-top:1px dashed var(--line);padding-top:6px;font-size:12px}
.mixes{list-style:none;margin:0;padding:0}
.mixes li{margin:2px 0}
.mixes .mh{font-weight:600}
.mixes .ref{font-size:10.5px;color:#fff;background:var(--ink);border-radius:4px;padding:0 4px;font-weight:600}
.mixes .mx,.mixes .mt{color:var(--ink2)}
.note{margin:4px 0 0;color:var(--ink2);white-space:normal}
.empty{color:var(--ink3);text-align:center;padding:40px 0}
.js .more{display:none}
.js.open-more .more{display:block}
.hide{display:none!important}
@media (min-width:760px){.top{position:sticky;top:0}}   /* 휴대폰에서는 위 칸이 화면을 너무 가려서 붙이지 않는다 */
footer{color:var(--ink3);font-size:11.5px;text-align:center;padding:10px 0 30px}
@page{size:A4;margin:10mm}
@media print{
  body{background:#fff;font-size:11px}
  .top{position:static;border:0;padding:0 0 8px}
  .tools{display:none}
  main{padding:0;max-width:none}
  .pat{break-inside:auto;border-color:#ccc;padding:10px 12px}
  .pat header{break-after:avoid}
  .cols{grid-template-columns:repeat(3,1fr);gap:8px}
  .js .more{display:block}
  .pat.hide{display:block!important}
}
"""

JS = """
(function(){
  var b=document.documentElement; b.classList.add('js');
  var q=document.getElementById('q'), pj=document.getElementById('pj'), st=document.getElementById('st'), more=document.getElementById('more'), n=document.getElementById('n');
  var pats=[].slice.call(document.querySelectorAll('.pat'));
  function run(){
    var words=(q.value||'').toLowerCase().split(/\\s+/).filter(Boolean), p=pj.value, s=st?st.value:'', shown=0;
    pats.forEach(function(el){
      var ok=(!p||el.getAttribute('data-project')===p)&&(!s||('|'+el.getAttribute('data-status')+'|').indexOf('|'+s+'|')>=0);
      var hay=el.getAttribute('data-q'); for(var i=0;ok&&i<words.length;i++) if(hay.indexOf(words[i])<0) ok=false;
      el.classList.toggle('hide',!ok); if(ok) shown++;
    });
    n.textContent=shown+' / '+pats.length+'개 시편';
    document.getElementById('none').classList.toggle('hide',shown>0);
  }
  q.addEventListener('input',run); pj.addEventListener('change',run); if(st) st.addEventListener('change',run);
  if(more) more.addEventListener('change',function(){b.classList.toggle('open-more',more.checked);});
  run();
})();
"""


def build_html(docs, img, *, audience="internal", brand="RDP", company="", baked_at="", scope_note="") -> str:
    """docs: 시편 문서 목록, img(pid, name) → 'data:image/jpeg;base64,…' 또는 '' (사진이 없거나 못 읽으면)."""
    if audience not in AUDIENCES:
        raise ValueError("audience 는 internal 또는 client")
    internal = audience == "internal"
    docs = sorted([d for d in docs if isinstance(d, dict)],
                  key=lambda d: (_natkey(d.get("project")), _natkey((d.get("pattern") or {}).get("code"))))
    projects = sorted({_s(d.get("project")) for d in docs if _s(d.get("project"))}, key=_natkey)
    statuses = sorted({_s(v.get("status")) for d in docs for v in d.get("variations") or [] if isinstance(v, dict) and _s(v.get("status"))})
    ncol = sum(len(d.get("variations") or []) for d in docs)
    title = f"{brand} 시편 아카이브 — {'내부용' if internal else '고객용'} 보기 전용"
    body = "".join(_pattern_html(d, img, internal) for d in docs)
    meta = json.dumps({"bakedAt": baked_at, "audience": audience, "patterns": len(docs), "colors": ncol}, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>{_e(title)}</title>
<style>{CSS}</style>
<script type="application/json" id="bake-meta">{meta}</script>
</head><body>
<div class="top">
  <h1>{_e(brand)} 시편 아카이브 <small style="font-weight:400;font-size:13px;color:#8d9198">{'내부용' if internal else '고객용'} · 보기 전용</small></h1>
  <div class="sub">{_e(baked_at)} 기준 사본 · 시편 {len(docs)}개 · 컬러 {ncol}개{(' · ' + _e(scope_note)) if scope_note else ''}{(' · ' + _e(company)) if company else ''} — 고치려면 아카이브 앱에서</div>
  <div class="tools">
    <input id="q" type="search" placeholder="코드 · 이름 · 컬러 · 고객 · 태그 · 상태">
    <select id="pj"><option value="">모든 프로젝트</option>{''.join(f'<option>{_e(x)}</option>' for x in projects)}</select>
    {'<select id="st"><option value="">모든 상태</option>' + ''.join(f'<option>{_e(x)}</option>' for x in statuses) + '</select>' if statuses else ''}
    {'<label><input type="checkbox" id="more"> 배합·메모 펼치기</label>' if internal else ''}
    <span class="n" id="n"></span>
  </div>
</div>
<main>{body or '<p class="empty">시편이 없습니다</p>'}<p class="empty hide" id="none">조건에 맞는 시편이 없습니다</p></main>
<footer>{_e(brand)} 시편 아카이브에서 {_e(baked_at)}에 만든 읽기 전용 사본입니다.</footer>
<script>{JS}</script>
</body></html>"""
