#!/usr/bin/env python3
"""
v1(pattern-archive/data.js) -> v2(패턴당 JSON + 170:70 이미지) 마이그레이션.
한 번만 실행하면 됩니다.

    python3 migrate_v1.py --src "../pattern-archive" --dest "<드라이브>/RDP-Archive"
"""
import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime

from PIL import Image, ImageOps

RATIO_W, RATIO_H = 170, 70
TARGET_W, TARGET_H = 2400, 988  # 170x70mm @ ~358dpi


def crop_ratio(im: Image.Image) -> Image.Image:
    """가운데 기준으로 170:70 비율로 크롭."""
    w, h = im.size
    target = RATIO_W / RATIO_H
    cur = w / h
    if cur > target:
        nw = int(round(h * target))
        x = (w - nw) // 2
        im = im.crop((x, 0, x + nw, h))
    else:
        nh = int(round(w / target))
        y = (h - nh) // 2
        im = im.crop((0, y, w, y + nh))
    return im


def save_variant(src_path: str, out_path: str, orig_path: str):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    os.makedirs(os.path.dirname(orig_path), exist_ok=True)
    im = Image.open(src_path)
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    im.save(orig_path, quality=92)
    im = crop_ratio(im)
    if im.width > TARGET_W:
        im = im.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    im.save(out_path, quality=90, optimize=True)
    return im.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="v1 폴더 (data.js + images/)")
    ap.add_argument("--dest", required=True, help="드라이브 RDP-Archive 폴더")
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    dest = os.path.abspath(args.dest)
    with open(os.path.join(src, "data.js"), encoding="utf-8") as f:
        raw = f.read()
    payload = json.loads(raw[raw.index("{"):raw.rindex(";")])

    patterns_dir = os.path.join(dest, "patterns")
    images_dir = os.path.join(dest, "images")
    orig_dir = os.path.join(dest, "_orig")
    for d in (patterns_dir, images_dir, orig_dir):
        os.makedirs(d, exist_ok=True)

    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    results = []

    for sp in payload["specimens"]:
        pid = sp["id"]
        label = sp.get("label", {})
        work = sp.get("work", {})

        remark = (label.get("remark") or "").strip()
        if remark.startswith("동판"):
            remark = ""

        coating = []
        seen = set()
        for c in work.get("coatings", []) or []:
            key = (c.get("maker"), c.get("code"), c.get("lot"))
            if key in seen:
                continue
            seen.add(key)
            coating.append({"maker": c.get("maker") or "", "code": c.get("code") or "", "lot": c.get("lot") or ""})

        mixes = []
        for m in sp.get("mixes", []):
            r = m.get("result") or ""
            code = "ok" if "✅" in r else "warn" if "⚠" in r else "ng" if "❌" in r else "planned" if "예정" in r else ""
            note = (m.get("note") or "").strip()
            mixes.append({
                "layer": m.get("layer") or "",
                "batch": m.get("batch") or "",
                "inks": m.get("inks") or {},
                "mattingPct": m.get("mattingPct"),
                "mattingG": m.get("mattingG"),
                "thinnerPct": m.get("thinnerPct"),
                "thinnerG": m.get("thinnerG"),
                "hardenerPct": m.get("hardenerPct"),
                "hardenerG": m.get("hardenerG"),
                "result": code,
                "isReference": note in ("기준", "기준(5/7)", "1차 테스트") or bool(m.get("isBase")),
                "change": m.get("change") or "",
                "note": "" if note in ("기준", "기준(5/7)", "1차 테스트") else note,
                "date": m.get("date") or "",
            })

        images = []
        for i, rel in enumerate(sp.get("images") or []):
            src_img = os.path.join(src, rel)
            if not os.path.exists(src_img):
                continue
            name = "v01" + ("" if i == 0 else f"-{i+1}") + ".jpg"
            out = os.path.join(images_dir, pid, name)
            orig = os.path.join(orig_dir, pid, os.path.splitext(name)[0] + "_src.jpg")
            size = save_variant(src_img, out, orig)
            images.append(name)

        doc = {
            "schemaVersion": 2,
            "id": pid,
            "project": sp.get("project"),
            "projectName": sp.get("projectName") or sp.get("project"),
            "client": sp.get("client") or "",
            "pattern": {
                "code": sp.get("code"),
                "name": sp.get("name") or "",
                "nameKo": sp.get("nameKo") or "",
                "tags": sp.get("tags") or [],
            },
            "label": {
                "item": label.get("item") or "",
                "type": label.get("type") or sp.get("type") or "",
                "supplier": label.get("supplier") or "니프코코리아",
                "remark": remark,
            },
            "work": {
                "place": work.get("place") or "",
                "worker": work.get("worker") or "",
                "machine": work.get("machine") or "",
                "plate": work.get("plates") or [],
                "emboss": work.get("emboss") or "",
                "pad": (work.get("pad") or "") + ((" / " + work["hardness"]) if work.get("hardness") else ""),
                "sop": work.get("sop") or "",
                "volume": work.get("volume") or "",
            },
            "variations": [{
                "id": "v01",
                "colorName": "",
                "colorCode": label.get("colorCode") or "",
                "coating": coating,
                "status": work.get("status") or "",
                "date": work.get("date") or "",
                "images": images,
                "mixes": mixes,
                "note": sp.get("note") or "",
            }],
            "history": [{"date": h.get("date") or "", "title": h.get("title") or "",
                         "summary": h.get("summary") or "", "variationId": None}
                        for h in (sp.get("history") or [])],
            "createdAt": now,
            "updatedAt": now,
        }

        with open(os.path.join(patterns_dir, pid + ".json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        results.append((pid, len(mixes), len(images)))

    print(f"[ok] {len(results)}개 패턴 마이그레이션 -> {dest}")
    for pid, nm, ni in results:
        print(f"   - {pid:<22} 배합 {nm:>2}  이미지 {ni}")


if __name__ == "__main__":
    main()
