#!/bin/bash
cd "$(dirname "$0")"
# 실행 직후 격리 표시를 스스로 지운다 (다음부터 경고 없음)
xattr -d com.apple.quarantine "$0" 2>/dev/null || true
# Pillow가 있는 python3 (애플 실리콘 Homebrew · 인텔 Homebrew · 그 밖의 python3)
PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if "$c" -c "import PIL" 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Pillow가 설치된 python3를 찾지 못했습니다:  python3 -m pip install --user pillow"
  read -n 1 -s; exit 1
fi
PORT=$("$PY" -c "import json;print(json.load(open('config.json')).get('port',8791))" 2>/dev/null || echo 8791)
# 로그인 자동 실행 서버가 등록돼 있으면 끄지 않는다 (끄면 터널 접속도 끊긴다)
AGENT="gui/$(id -u)/com.nifco.rdparchive"
if launchctl print "$AGENT" >/dev/null 2>&1; then
  if "$PY" -c "import json,sys;sys.exit(0 if json.load(open('config.json')).get('lan') else 1)" 2>/dev/null; then
    launchctl kickstart -k "$AGENT"
    for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.25; done
    open "http://localhost:$PORT"
    echo "자동 실행 서버(LAN 켜짐)를 다시 시작했습니다 → http://localhost:$PORT  (이 창은 닫아도 됩니다)"
    exit 0
  fi
  echo "로그인 자동 실행 서버가 켜져 있어서 여기서 멈춥니다 (끄면 터널 접속도 끊겨요)."
  echo "같은 네트워크에서도 쓰려면 config.json에  \"lan\": true  를 넣고 이 파일을 다시 실행하세요."
  read -n 1 -s; exit 0
fi
# 포트를 LISTEN 중인 프로세스 중 '이 앱의 server.py'만 끈다
# (lsof -ti tcp:PORT 는 접속 중인 브라우저·cloudflared까지 잡아서 함께 죽인다)
KILLED=""
for OLD in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  if ps -p "$OLD" -o command= 2>/dev/null | grep -q "server.py"; then
    kill "$OLD" 2>/dev/null && KILLED=1
  fi
done
[ -n "$KILLED" ] && sleep 1
exec "$PY" "$(pwd)/server.py" --lan
