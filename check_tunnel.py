#!/usr/bin/env python3
"""터널 준비 상태 점검."""
import json
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
OK, NG, WARN = "OK  ", "NG  ", "WARN"


def line(mark, title, detail=""):
    print(f" [{mark}] {title}" + (f"  {detail}" if detail else ""))


def main():
    print("RDP 아카이브 · 터널 점검\n" + "-" * 46)

    exe = shutil.which("cloudflared") or "/opt/homebrew/bin/cloudflared"
    try:
        v = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=5).stdout.strip()
        line(OK, "cloudflared", v)
    except Exception:
        line(NG, "cloudflared", "설치 안 됨 → brew install cloudflared")

    host = next((h for h in CFG.get("allowHosts") or [] if h not in ("localhost", "127.0.0.1")), None)
    if host:
        line(OK, "터널 주소", f"https://{host}")
    else:
        line(NG, "터널 주소", "python3 setup_tunnel.py rdp.내도메인.com")

    if CFG.get("requireCfAccess"):
        line(OK, "Cloudflare Access 강제", "JWT 헤더 없으면 403")
    else:
        line(WARN, "Cloudflare Access 강제", "꺼져 있음 · 터널을 열면 누구나 접속")

    email = CFG.get("cfAccessEmail")
    line(OK if email else WARN, "이메일 고정", email or "비어 있음")

    port = CFG.get("port", 8791)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as r:
            body = r.read().decode(errors="ignore")
            if "ok" in body:
                line(OK, "로컬 서버", f"실행 중 · 포트 {port}")
            else:
                raise ValueError("not our app")
    except urllib.error.HTTPError:
        line(NG, "로컬 서버", f"포트 {port}를 다른 프로그램이 사용 중 → lsof -nP -iTCP:{port} -sTCP:LISTEN")
    except Exception:
        line(NG, "로컬 서버", f"응답 없음 · 포트 {port} (앱을 켜세요)")

    daemon = Path("/Library/LaunchDaemons/com.cloudflare.cloudflared.plist")
    line(OK if daemon.exists() else WARN, "터널 서비스 등록", "등록됨 (부팅 시 자동 시작)" if daemon.exists() else "아직 등록 전 · 대시보드 토큰으로 설치")
    print("-" * 46)


if __name__ == "__main__":
    main()
