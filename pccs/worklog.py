"""PCCS3 — 작업일지(v3) 읽기 · 검사 · 색인.

작업일지 마크다운의 frontmatter(worklog/v3)를 읽어
- 파일마다 `작업일지-AI-작성지침-v3.md` §6 자가 점검을 자동으로 돌리고
- 폴더 전체에서 배합(same_as) · 동판 · 도장 시편을 이어 붙인다.

쓰기는 하지 않는다 (일지 원본은 마크다운, 고치는 건 AI와 대화로).

    python3 -m pccs.worklog <일지 폴더 또는 파일>
"""
import os
import re
import sys

try:
    import yaml
except ImportError:   # 서버는 PyYAML 없이도 떠야 한다 (/pccs 화면에서 안내)
    yaml = None

SCHEMA_V3 = "worklog/v3"
EVAL = ("대기중", "진행", "채택", "미채택")
SURFACE = ("경면", "패브릭엠보", "엠보사출", "무도장", "기타")
STAGE = ("선행연구", "디자인 샘플", "승인", "양산")
TYPE = ("샘플제작", "컬러매칭", "복제", "디자인", "설비", "기타")
CATEGORY = ("작업일지", "카톡보고", "외근보고서")
FM_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.S)


def yaml_available() -> bool:
    return yaml is not None


# ---------------------------------------------------------------- 읽기
class Worklog:
    """일지 파일 하나. kind: v3 / v2 / none(frontmatter 없음) / broken(YAML 오류)."""

    def __init__(self, path, text=None):
        self.path = path
        self.name = os.path.basename(path)
        self.mtime = os.path.getmtime(path) if text is None else 0
        if text is None:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        self.fm, self.body, self.kind, self.error = None, text, "none", ""
        self.notes = []                 # 읽으면서 생긴 형식 문제 (예: no: 키)
        m = FM_RE.match(text)
        if not m:
            return
        self.body = m.group(2)
        try:
            fm = yaml.safe_load(m.group(1)) if yaml else None
        except yaml.YAMLError as e:
            self.kind, self.error = "broken", f"YAML 오류: {e}"
            return
        if not isinstance(fm, dict):
            self.kind, self.error = "broken", "frontmatter가 객체가 아님"
            return
        self.fm = fm
        self.kind = "v3" if fm.get("schema") == SCHEMA_V3 else "v2"
        if self.kind == "v3":
            self._fix_no_keys()

    def _fix_no_keys(self):
        """YAML 1.1은 'no:' 키를 False로 읽는다 → seq로 옮기고 오류로 남긴다."""
        n = 0
        for j in self.jobs:
            for o in [j] + list(j.get("samples") or []):
                if isinstance(o, dict) and "seq" not in o and False in o:
                    o["seq"] = o.pop(False)
                    n += 1
        if n:
            self.notes.append(f"순번 키 'no:' {n}곳 — YAML에서 false로 읽혀 값이 사라짐 → 'seq:'로 바꾸세요")

    @property
    def date(self):
        return str((self.fm or {}).get("date") or "")

    @property
    def jobs(self):
        return [j for j in ((self.fm or {}).get("jobs") or []) if isinstance(j, dict)]

    @property
    def substrates(self):
        return [s for s in ((self.fm or {}).get("substrates") or []) if isinstance(s, dict)]


# ---------------------------------------------------------------- 배합 도우미
def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def ink_total(b):
    return sum(_num(v) or 0 for v in (b.get("inks") or {}).values())


def has_values(b):
    return bool(b.get("inks"))


def batch_key(lot, layer, code):
    return (str(lot), str(layer), str(code))


def parse_ref(ref):
    parts = str(ref or "").split("/")
    return tuple(parts) if len(parts) == 3 else None


def same_values(a, b):
    for f in ("inks", "matting", "thinner", "hardener"):
        if (a.get(f) or None) != (b.get(f) or None):
            return False
    return _num(a.get("total")) == _num(b.get("total"))


# ---------------------------------------------------------------- 색인 (폴더 전체)
class Index:
    """폴더의 모든 일지. 파일 간 same_as를 풀고, 동판 타임라인을 만든다."""

    def __init__(self, logs):
        self.logs = sorted(logs, key=lambda w: (w.date, w.name))
        self.batches = {}           # (lot, layer, code) -> [(Worklog, batch)]
        for w in self.logs:
            if w.kind != "v3":
                continue
            for j in w.jobs:
                lot = (j.get("plate") or {}).get("lot")
                for b in j.get("batches") or []:
                    if isinstance(b, dict):
                        self.batches.setdefault(batch_key(lot, b.get("layer"), b.get("code")), []).append((w, b))

    def find(self, key, before_date=None, exclude=None):
        """값이 적힌 원본 후보 (날짜가 같거나 이전, 자기 파일 제외)."""
        out = []
        for w, b in self.batches.get(key, []):
            if w is exclude or not has_values(b):
                continue
            if before_date and w.date and w.date > before_date:
                continue
            out.append((w, b))
        return out

    # --- 동판 타임라인
    def plates(self):
        seen = {}
        for e in self.timeline_entries():
            p = seen.setdefault(e["lot"], {"lot": e["lot"], "first": e["date"], "last": e["date"],
                                           "days": set(), "patterns": set(), "samples": 0})
            p["first"] = min(p["first"], e["date"]) if e["date"] else p["first"]
            p["last"] = max(p["last"], e["date"])
            p["days"].add(e["date"])
            p["patterns"].update(c for c in e["layers"].values() if c)
            p["samples"] += sum(s.get("qty") or 0 for s in e.get("samples") or [])
        out = []
        for p in seen.values():
            out.append({**p, "days": len(p["days"]), "patterns": sorted(p["patterns"])})
        return sorted(out, key=lambda p: (p["last"], p["lot"]), reverse=True)

    def timeline_entries(self, lot=None):
        out = []
        for w in self.logs:
            if w.kind == "v3":
                for j in w.jobs:
                    plate = j.get("plate") or {}
                    l = str(plate.get("lot") or "")
                    if not l or (lot and l != lot):
                        continue
                    out.append({
                        "lot": l, "date": w.date, "file": w.name, "kind": "v3",
                        "seq": j.get("seq"), "title": j.get("title") or "", "customer": j.get("customer") or "",
                        "project": j.get("project") or "", "stage": j.get("stage") or "",
                        "status": j.get("status") or "",
                        "layers": {str(k): str(v) for k, v in (plate.get("layers") or {}).items()},
                        "batches": [{"layer": b.get("layer"), "code": str(b.get("code")),
                                     "same_as": b.get("same_as"), "status": b.get("status"),
                                     "note": b.get("note")} for b in j.get("batches") or [] if isinstance(b, dict)],
                        "samples": [s for s in j.get("samples") or [] if isinstance(s, dict)],
                    })
            elif w.kind == "v2":
                # v2.1: patterns → plates(lot, layers, batches)만 있다
                per = {}
                for p in (w.fm or {}).get("patterns") or []:
                    if not isinstance(p, dict):
                        continue
                    for pl in p.get("plates") or []:
                        if not isinstance(pl, dict):
                            continue
                        l = str(pl.get("lot") or "")
                        if not l or (lot and l != lot):
                            continue
                        e = per.setdefault(l, {"lot": l, "date": w.date, "file": w.name, "kind": "v2",
                                               "layers": {}, "batches": [], "samples": []})
                        for layer in pl.get("layers") or []:
                            e["layers"][str(layer)] = str(p.get("code") or "")
                        for c in pl.get("batches") or []:
                            e["batches"].append({"layer": None, "code": str(c)})
                out.extend(per.values())
        return sorted(out, key=lambda e: (e["date"], e["file"], e.get("seq") or 0))


def load_folder(folder):
    logs = []
    if folder and os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            if name.endswith(".md") and not name.startswith("."):
                try:
                    logs.append(Worklog(os.path.join(folder, name)))
                except (OSError, UnicodeDecodeError) as e:
                    w = Worklog.__new__(Worklog)
                    w.path, w.name, w.mtime, w.fm, w.body = os.path.join(folder, name), name, 0, None, ""
                    w.kind, w.error, w.notes = "broken", f"읽기 실패: {e}", []
                    logs.append(w)
    return Index(logs)


# ---------------------------------------------------------------- 검사 (§6 자가 점검)
def check(w, index=None):
    """일지 하나를 검사한다 → {'errors': [...], 'warnings': [...], 'stats': {...}}.
    index를 주면 다른 날짜 파일의 same_as 원본까지 찾는다."""
    errs, warns = [], []

    def E(where, msg):
        errs.append({"where": where, "msg": msg})

    def W(where, msg):
        warns.append({"where": where, "msg": msg})

    if w.kind == "broken":
        E("파일", w.error)
        return {"errors": errs, "warnings": warns, "stats": {}}
    if w.kind != "v3":
        return {"errors": errs, "warnings": warns, "stats": {}}
    d = w.fm
    for n in w.notes:
        E("형식", n)

    # --- 형식
    for k in ("schema", "date", "category", "tags", "place", "worker"):
        if not d.get(k):
            E("공통", f"필수 항목 없음: {k}")
    if d.get("date") and not isinstance(d.get("date"), str):
        E("공통", f"date가 따옴표 문자열이 아님: {d.get('date')}")
    if d.get("category") and d["category"] not in CATEGORY:
        E("공통", f"category 값이 규칙 밖: {d['category']}")
    tags = d.get("tags") or []
    if tags and tags[0] != "NIFCO":
        E("공통", "tags 첫 항목이 NIFCO가 아님")

    subs = w.substrates
    for s in subs:
        code = s.get("code")
        if not isinstance(code, str):
            E("도장 시편", f"code가 문자열이 아님: {code}")
        if not s.get("maker"):
            E("도장 시편", f"{code}: maker(도장처) 없음")
        if s.get("surface") and s["surface"] not in SURFACE:
            E("도장 시편", f"{code}: surface 값이 규칙 밖: {s['surface']}")
        if s.get("painted"):
            if not isinstance(s["painted"], str):
                E("도장 시편", f"{code}: painted가 따옴표 문자열이 아님")
            elif w.date and str(s["painted"]) > w.date:
                E("도장 시편", f"{code}: 도장일 {s['painted']}이 작업일 {w.date}보다 늦음")

    def find_sub(ref):
        code, *quals = str(ref).split("@")
        cands = [s for s in subs if s.get("code") == code]
        for q in quals:
            cands = [s for s in cands if q in (s.get("maker"), s.get("surface"))]
        return cands

    # --- 이 파일의 배합
    local = {}
    for j in w.jobs:
        lot = (j.get("plate") or {}).get("lot")
        if not isinstance(lot, str):
            E(f"작업 {j.get('seq')}", f"plate.lot이 따옴표 문자열이 아님: {lot}")
        for b in j.get("batches") or []:
            if not isinstance(b, dict):
                continue
            if not isinstance(b.get("code"), str):
                E(f"작업 {j.get('seq')}", f"배치 코드가 문자열이 아님 (따옴표 필요): {b.get('code')}")
            key = batch_key(lot, b.get("layer"), b.get("code"))
            if key in local:
                E(f"작업 {j.get('seq')}", f"같은 동판·도수·코드의 배합이 두 번 있음: {'/'.join(key)}")
            local[key] = b

    def resolve(key, seen=()):
        """같은 파일 안에서 same_as를 따라가 값이 있는 원본을 찾는다."""
        b = local.get(key)
        if b is None or key in seen:
            return None
        if has_values(b):
            return b
        ref = parse_ref(b.get("same_as"))
        return resolve(ref, seen + (key,)) if ref else None

    for key, b in local.items():
        name = "/".join(key)
        if "same_as" in b:
            ref = parse_ref(b["same_as"])
            if not ref:
                E(f"배합 {name}", f"same_as 형식이 '동판/도수/코드'가 아님: {b['same_as']}")
            else:
                # 자기와 같은 키(같은 동판·도수·코드)를 가리키면 "예전에 쓴 그 배합"이다 → 다른 날짜에서 찾는다
                src = resolve(ref) if ref != key else None
                if src is not None:
                    if has_values(b) and not same_values(b, src):
                        E(f"배합 {name}", f"same_as 원본({b['same_as']})과 값이 다름")
                else:
                    others = index.find(ref, before_date=w.date, exclude=w) if index else []
                    if not others:
                        where = "일지 전체에서" if index else "이 파일에서"
                        E(f"배합 {name}", f"same_as 원본({b['same_as']})을 {where} 찾지 못함")
                    else:
                        ow, ob = others[-1]
                        if not has_values(b):
                            E(f"배합 {name}", f"원본이 다른 날짜 파일({ow.name})이면 값도 함께 적어야 함")
                        elif not same_values(b, ob):
                            E(f"배합 {name}", f"same_as 원본({ow.name})과 값이 다름")
                        if len({str(sorted((x.get('inks') or {}).items())) for _, x in others}) > 1:
                            W(f"배합 {name}", f"same_as 원본({b['same_as']})이 여러 날짜에 서로 다른 값으로 있음 — 가장 최근 {ow.date} 기준")
            if not has_values(b):
                continue
        if not has_values(b):
            E(f"배합 {name}", "inks 없음 (same_as도 없음)")
            continue
        ink = ink_total(b)
        tot = ink + sum(_num((b.get(k) or {}).get("g")) or 0 for k in ("matting", "thinner", "hardener"))
        if b.get("total") is None:
            E(f"배합 {name}", "total 없음")
        elif abs(tot - (_num(b["total"]) or 0)) > 1e-6:
            E(f"배합 {name}", f"total {b['total']} ≠ 계산 {tot:g} (잉크+소광제+신나+경화제)")
        for k, label in (("matting", "소광제"), ("thinner", "신나"), ("hardener", "경화제")):
            x = b.get(k)
            if not x:
                continue
            if not isinstance(x, dict) or x.get("g") is None:
                E(f"배합 {name}", f"{label}는 {{g:, pct:}} 형식")
            elif x.get("pct") is None:
                E(f"배합 {name}", f"{label} pct 없음")
            elif ink and abs((_num(x["g"]) or 0) / ink * 100 - (_num(x["pct"]) or 0)) > 0.05:
                E(f"배합 {name}", f"{label} {x['g']}g = 잉크합 {ink:g}의 {(_num(x['g']) or 0) / ink * 100:.1f}% 인데 pct={x['pct']}")

    # 같은 동판·도수·코드를 예전 일지에서 다른 값으로 쓴 적이 있다 → DB 키(동판·도수·배치)가 겹친다
    if index:
        for key, b in local.items():
            vals = b if has_values(b) else resolve(key)
            if not vals:
                continue
            for ow, ob in index.find(key, before_date=w.date, exclude=w):
                if ow.date < w.date and not same_values(vals, ob):
                    W(f"배합 {'/'.join(key)}", f"{ow.date} 일지({ow.name})의 같은 코드와 값이 다름 — 새 배합이면 코드를 바꾸세요 (DB에서 같은 키)")
                    break

    sig = {}
    for key, b in local.items():
        if has_values(b) and "same_as" not in b:
            s = (tuple(sorted((b.get("inks") or {}).items())), str(b.get("matting")), str(b.get("thinner")), str(b.get("hardener")))
            sig.setdefault(s, []).append("/".join(key))
    for keys in sig.values():
        if len(keys) > 1:
            W("배합", "값이 똑같은 배합 — 같은 배합이면 same_as로 연결: " + " = ".join(keys))

    # --- 작업 · 시료
    stats = {"jobs": len(w.jobs), "batches": len(local), "samples": 0, "qty": 0}
    for j in w.jobs:
        seq = j.get("seq")
        tag = f"작업 {seq}"
        for k in ("customer", "project", "stage", "type"):
            if not j.get(k):
                E(tag, f"필수 항목 없음: {k}")
        if j.get("stage") and j["stage"] not in STAGE:
            E(tag, f"stage 값이 규칙 밖: {j['stage']}")
        if j.get("type") and j["type"] not in TYPE:
            E(tag, f"type 값이 규칙 밖: {j['type']}")
        plate = j.get("plate") or {}
        lot, layers = str(plate.get("lot")), plate.get("layers") or {}
        if not layers:
            E(tag, "plate.layers(도수 → 패턴 코드) 없음")
        for b in j.get("batches") or []:
            if isinstance(b, dict) and b.get("layer") not in layers:
                E(tag, f"배합 {b.get('layer')}/{b.get('code')}의 도수가 plate.layers에 없음")
        for s in j.get("samples") or []:
            if not isinstance(s, dict):
                continue
            st = f"{tag} 시료 {s.get('seq')}"
            stats["samples"] += 1
            hit = find_sub(s.get("substrate"))
            if not hit:
                E(st, f"도장 시편 '{s.get('substrate')}'가 substrates에 없음")
            elif len(hit) > 1:
                E(st, f"'{s.get('substrate')}'가 substrates {len(hit)}줄과 맞음 — '@도장처' 또는 '@표면'으로 구분")
            if s.get("eval") not in EVAL:
                E(st, f"eval 값이 규칙 밖: {s.get('eval')} (원문은 note로)")
            if not isinstance(s.get("qty"), int) or isinstance(s.get("qty"), bool) or s["qty"] <= 0:
                E(st, f"qty가 양의 정수가 아님: {s.get('qty')}")
            else:
                stats["qty"] += s["qty"]
            if not s.get("layers"):
                E(st, "layers(도수 → 배치 코드) 없음")
            for ly, cd in (s.get("layers") or {}).items():
                if not isinstance(cd, str):
                    E(st, f"배치 코드가 문자열이 아님 (따옴표 필요): {cd}")
                if ly not in layers:
                    E(st, f"도수 {ly}가 plate.layers에 없음")
                b = local.get(batch_key(lot, ly, cd))
                if b is None:
                    E(st, f"배합 {lot}/{ly}/{cd}가 이 작업의 batches에 없음")
                elif b.get("status") == "미채택":
                    W(st, f"미채택 배합 {lot}/{ly}/{cd}를 시료에 씀")

    # --- patterns(v2.1) ↔ jobs (패턴 코드별로 쪼갠 형태여야 한다)
    want = {}
    for j in w.jobs:
        plate = j.get("plate") or {}
        for b in j.get("batches") or []:
            if not isinstance(b, dict):
                continue
            code = (plate.get("layers") or {}).get(b.get("layer"))
            e = want.setdefault((str(code), str(plate.get("lot"))), {"layers": set(), "batches": set()})
            e["layers"].add(str(b.get("layer")))
            e["batches"].add(str(b.get("code")))
    have = {}
    for p in d.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        for pl in p.get("plates") or []:
            if isinstance(pl, dict):
                have[(str(p.get("code")), str(pl.get("lot")))] = {
                    "layers": set(map(str, pl.get("layers") or [])),
                    "batches": set(map(str, pl.get("batches") or []))}
    for k in sorted(set(want) | set(have)):
        if want.get(k) != have.get(k):
            E("patterns", f"{k[0]} / {k[1]}: jobs={_fmt(want.get(k))} · patterns={_fmt(have.get(k))}"
                          " — 패턴 코드별로 그 패턴의 도수·배치만 적기")

    # --- 본문 '총계 (lot)' 줄들 (작업 순서 표 · 시료 표 · 결과)
    for j in w.jobs:
        lot = str((j.get("plate") or {}).get("lot"))
        q = sum(s.get("qty") or 0 for s in j.get("samples") or [] if isinstance(s, dict) and isinstance(s.get("qty"), int))
        for ln in re.findall(rf"[^\n]*총계 \({re.escape(lot)}\)[^\n]*", w.body):
            nums = re.findall(r"(\d+)장", ln)
            if nums and int(nums[-1]) != q:   # 줄의 마지막 'N장' (앞의 '동판 1장' 제외)
                E(f"작업 {j.get('seq')}", f"본문 총계 {nums[-1]}장 ≠ 시료 qty 합계 {q}장 — {ln.strip()[:60]}")

    return {"errors": errs, "warnings": warns, "stats": stats}


def _fmt(x):
    if not x:
        return "없음"
    return f"[{','.join(sorted(x['layers']))}] {{{','.join(sorted(x['batches']))}}}"


def summary(w, result):
    titles = [j.get("title") or f"동판 {(j.get('plate') or {}).get('lot')}" for j in w.jobs]
    lots = [str((j.get("plate") or {}).get("lot")) for j in w.jobs]
    if w.kind == "v2":
        lots = sorted({str(pl.get("lot")) for p in (w.fm or {}).get("patterns") or [] if isinstance(p, dict)
                       for pl in p.get("plates") or [] if isinstance(pl, dict) and pl.get("lot")})
    return {"name": w.name, "date": w.date, "kind": w.kind, "category": (w.fm or {}).get("category") or "",
            "titles": titles, "lots": lots,
            "errors": len(result["errors"]), "warnings": len(result["warnings"]), "stats": result.get("stats") or {}}


# ---------------------------------------------------------------- CLI
def main(argv):
    if not yaml_available():
        print("PyYAML이 필요합니다:  python3 -m pip install --user pyyaml")
        return 2
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    target = argv[1]
    if os.path.isdir(target):
        idx = load_folder(target)
        logs = idx.logs
    else:
        idx = load_folder(os.path.dirname(os.path.abspath(target)))
        logs = [w for w in idx.logs if w.name == os.path.basename(target)]
    bad = 0
    for w in logs:
        if w.kind not in ("v3", "broken"):
            continue
        r = check(w, idx)
        mark = "OK " if not r["errors"] else "NG "
        st = r.get("stats") or {}
        print(f"[{mark}] {w.name}  (작업 {st.get('jobs', 0)} · 시료 {st.get('samples', 0)}행 {st.get('qty', 0)}장)"
              f"  오류 {len(r['errors'])} · 참고 {len(r['warnings'])}")
        for e in r["errors"]:
            print(f"   ❌ {e['where']}: {e['msg']}")
        for x in r["warnings"]:
            print(f"   💡 {x['where']}: {x['msg']}")
        bad += bool(r["errors"])
    others = [w for w in logs if w.kind in ("v2", "none")]
    if others:
        print(f"\n(v3 아님 {len(others)}개: v2.1 {sum(w.kind == 'v2' for w in others)} · frontmatter 없음 {sum(w.kind == 'none' for w in others)})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
