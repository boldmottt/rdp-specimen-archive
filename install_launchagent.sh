#!/bin/bash
# 서버를 로그인 시 자동 실행되게 등록한다 (한 번만).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.nifco.rdparchive.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__APP__|$DIR|g" -e "s|__LOG__|$HOME/Library/Logs/rdp-archive.log|g" \
  "$DIR/launchd/com.nifco.rdparchive.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "등록 완료. 로그: $HOME/Library/Logs/rdp-archive.log"
echo "해제하려면: launchctl bootout gui/$(id -u) $PLIST && rm $PLIST"
