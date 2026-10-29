#!/usr/bin/env bash
# 브라우저 검증용 '데모' 인스턴스.
#
# 왜 있나: 실제 데이터(dataRoot)를 가리키는 서버에 테스트용 PUT/DELETE 를 쏘면
# 진짜 장바구니·설정이 날아간다(2026-10-29 실제로 겪음). server.py --demo 는
# sample-data 를 임시 폴더에 복사해서 그 위에서만 돈다 — 실제 데이터는 읽지도 쓰지도 않는다.
#
# 사용:  ./scripts/demo.sh [포트]      (기본 8910)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8910}"
echo "[demo] 실제 데이터는 건드리지 않습니다. http://localhost:${PORT}"
exec python3 server.py --demo --no-browser --port "$PORT"
