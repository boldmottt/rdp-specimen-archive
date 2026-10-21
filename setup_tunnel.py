#!/usr/bin/env python3
"""터널 주소를 config.json에 등록한다.

    python3 setup_tunnel.py rdp.mydomain.com
    python3 setup_tunnel.py rdp.mydomain.com me@nifco.co.kr
"""
import json
import re
import sys
from pathlib import Path

CFG = Path(__file__).with_name("config.json")


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        print("\n현재 설정:")
        c = json.loads(CFG.read_text(encoding="utf-8"))
        print(f"  allowHosts      = {c.get('allowHosts') or []}")
        print(f"  requireCfAccess = {c.get('requireCfAccess')}")
        print(f"  cfAccessEmail   = {c.get('cfAccessEmail') or '(없음)'}")
        return 1

    host = sys.argv[1].strip().lower()
    host = re.sub(r"^https?://", "", host).strip("/")
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", host):
        print(f"주소 형식이 이상합니다: {host}\n예: rdp.mydomain.com")
        return 2

    email = sys.argv[2].strip() if len(sys.argv) > 2 else ""

    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    cfg["allowHosts"] = [host, "localhost", "127.0.0.1"]
    cfg["requireCfAccess"] = True
    if email:
        cfg["cfAccessEmail"] = email
    CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"설정 완료: https://{host}")
    print(f"  allowHosts      = {cfg['allowHosts']}")
    print(f"  requireCfAccess = True  (Cf-Access-Jwt-Assertion 없는 요청은 403)")
    if cfg.get("cfAccessEmail"):
        print(f"  cfAccessEmail   = {cfg['cfAccessEmail']}  (다른 이메일 토큰은 거절)")
    else:
        print("  cfAccessEmail   = (비어 있음 · 이메일 고정을 권장합니다)")
    print("\n서버를 껐다 켜면 배너에 '터널 https://%s ...'가 찍힙니다." % host)
    return 0


if __name__ == "__main__":
    sys.exit(main())
