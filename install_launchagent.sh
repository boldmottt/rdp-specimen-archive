#!/bin/bash
# 서버를 로그인 시 자동 실행되게 등록한다 (한 번만).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.nifco.rdparchive.plist"
# Pillow가 있는 python3를 찾는다 (애플 실리콘 Homebrew · 인텔 Homebrew · 그 밖의 python3)
PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3 || true)"; do
  if [ -n "$c" ] && [ -x "$c" ] && "$c" -c "import PIL" 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Pillow가 설치된 python3를 찾지 못했습니다:  python3 -m pip install --user pillow"
  exit 1
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__APP__|$DIR|g" -e "s|__LOG__|$HOME/Library/Logs/rdp-archive.log|g" \
    -e "s|__PY__|$PY|g" -e "s|__PYDIR__|$(dirname "$PY")|g" \
  "$DIR/launchd/com.nifco.rdparchive.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "등록 완료 (python: $PY). 로그: $HOME/Library/Logs/rdp-archive.log"
echo "해제하려면: launchctl bootout gui/$(id -u) $PLIST && rm $PLIST"
