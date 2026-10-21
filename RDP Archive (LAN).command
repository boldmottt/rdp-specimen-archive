#!/bin/bash
cd "$(dirname "$0")"
PORT=$(/opt/homebrew/bin/python3 -c "import json;print(json.load(open('config.json')).get('port',8791))" 2>/dev/null || echo 8791)
OLD=$(lsof -ti tcp:$PORT 2>/dev/null)
[ -n "$OLD" ] && kill $OLD 2>/dev/null && sleep 1
for PY in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if "$PY" -c "import PIL" 2>/dev/null; then exec "$PY" "$(pwd)/server.py" --lan; fi
done
echo "Pillow가 설치된 python3를 찾지 못했습니다."
read -n 1 -s
