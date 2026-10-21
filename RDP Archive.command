#!/bin/bash
cd "$(dirname "$0")"
# 이전에 켜둔 인스턴스가 있으면 정리 (포트가 밀리는 걸 막음)
pkill -f "$(pwd)/server.py" 2>/dev/null
sleep 0.6
for PY in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if "$PY" -c "import PIL" 2>/dev/null; then exec "$PY" "$(pwd)/server.py"; fi
done
echo "Pillow가 설치된 python3를 찾지 못했습니다."
read -n 1 -s
