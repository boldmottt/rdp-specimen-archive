# PCCS3 — 작업일지 검사 · 동판 타임라인

시편 아카이브 서버에 붙어 있는 **읽기 전용** 화면입니다. 주소는 `http://localhost:8791/pccs/`이고, 아카이브 위쪽 **작업일지** 버튼으로도 들어갈 수 있습니다.
터널을 쓰면 `https://<터널 주소>/pccs/`로 접속하며, 아카이브와 같은 Cloudflare Access 로그인을 거칩니다.

- **일지 검사**: 작업일지 폴더의 v3 일지(`schema: worklog/v3`)를 `작업일지-AI-작성지침-v3.md` §6 자가 점검 규칙으로 자동 검사합니다.
  - 합계와 % 검산
  - 시료 ↔ 배합 ↔ 도장 시편 연결
  - `patterns` 쪼개기
  - 다른 날짜 파일을 가리키는 `same_as`
  - 같은 코드를 다른 값으로 다시 쓴 경우
  - 본문 총계
- **동판 타임라인**: 동판 하나로 언제, 어떤 1도·2도 조합을, 어느 도장 시편에 찍었고 평가가 어땠는지 날짜순으로 모아 보여 줍니다. v2.1(예전) 일지도 `patterns` 정보로 함께 나옵니다.

일지 파일을 **쓰거나 고치지 않습니다.** 일지는 지금처럼 AI와 대화로 쓰고, 여기서는 확인만 합니다.

## 설정

`config.json`에 작업일지 폴더를 적습니다. 적지 않으면 기본값 `~/MySecondBrain/Areas/NIFCO/작업일지`를 씁니다.

```json
"worklogDir": "~/MySecondBrain/Areas/NIFCO/작업일지"
```

YAML을 읽으려면 **PyYAML**이 필요합니다. 앱을 실행하는 python3(Pillow가 깔린 것)에 한 번만 설치하세요.

```bash
/opt/homebrew/bin/python3 -m pip install --user pyyaml
# "externally-managed-environment" 오류가 나면:
/opt/homebrew/bin/python3 -m pip install --user --break-system-packages pyyaml
```

PyYAML이 없어도 아카이브는 그대로 동작하고, `/pccs/` 화면에서만 설치 안내가 나옵니다.

## 터미널에서 검사

```bash
python3 -m pccs.worklog ~/MySecondBrain/Areas/NIFCO/작업일지            # 폴더 전체
python3 -m pccs.worklog ~/MySecondBrain/Areas/NIFCO/작업일지/2026-10-12_….md   # 파일 하나 (같은 폴더의 다른 일지도 참고)
```

오류가 하나라도 있으면 종료 코드 1을 돌려줍니다.

## 데모

`python3 server.py --demo`로 켜면 `pccs/sample-worklogs/`의 **익명 예시 일지**를 보여 줍니다. 저장소가 공개이므로 이 폴더에는 실제 일지를 넣지 마세요.
