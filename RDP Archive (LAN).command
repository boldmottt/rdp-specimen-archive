#!/bin/bash
cd "$(dirname "$0")"
PORT=$(/opt/homebrew/bin/python3 -c "import json;print(json.load(open('config.json')).get('port',8791))" 2>/dev/null || echo 8791)
# 포트를 LISTEN 중인 프로세스 중 '이 앱의 server.py'만 끈다
# (lsof -ti tcp:PORT 는 접속 중인 브라우저·cloudflared까지 잡아서 함께 죽인다)
KILLED=""
for OLD in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  if ps -p "$OLD" -o command= 2>/dev/null | grep -q "server.py"; then
    kill "$OLD" 2>/dev/null && KILLED=1
  fi
done
[ -n "$KILLED" ] && sleep 1
for PY in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if "$PY" -c "import PIL" 2>/dev/null; then exec "$PY" "$(pwd)/server.py" --lan; fi
done
echo "Pillow가 설치된 python3를 찾지 못했습니다."
read -n 1 -s
