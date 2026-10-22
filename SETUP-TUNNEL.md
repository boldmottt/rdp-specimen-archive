# 외부 접속 구축 가이드 (Cloudflare Tunnel + Access)

## 지금 구성 (2026-10-22 완료)

| 항목 | 값 |
|---|---|
| 공개 주소 | `https://rdparchive.fyi` |
| 터널 | `rdp-archive` (ID `2aedd753-41dc-49dd-9c53-8cd29e64168c`) → `http://localhost:8791` |
| 인증 | Cloudflare Access · 정책 `Only Seokhee` (Allow · Emails `loo4leesk@gmail.com`) |
| 팀 도메인 | `rdp-archive.cloudflareaccess.com` |
| 터널 자동 시작 | `~/.cloudflared/rdp-archive.sh` + `~/Library/LaunchAgents/com.nifco.rdptunnel.plist` |
| 앱 자동 시작 | `./install_launchagent.sh` (선택) |

아래 원문 가이드는 다른 도메인으로 다시 구축할 때를 위한 참고용입니다.

---

회사 PC 브라우저 → Cloudflare(이메일 인증) → 집 맥북 `cloudflared` → `localhost:8791`

공유기 포트를 열지 않고, 인증을 통과한 사람만 들어옵니다.

---

## 지금 상태

| 항목 | 상태 |
|---|---|
| 서버 코드 (터널 주소 허용 + Access 헤더 검사) | 완료 |
| `cloudflared` | 설치됨 (`/opt/homebrew/bin/cloudflared`, 2026.3.0) |
| Cloudflare 계정 / 도메인 | **없음 (직접 만들어야 함)** |
| 터널 생성 · 서비스 등록 | **대시보드에서 해야 함** |

```bash
cd ~/.aside/artifacts/rdp-archive      # 앱 폴더 (실제 경로로)
python3 check_tunnel.py                 # 준비 상태 점검
```

---

## 1. 도메인 준비

1. https://dash.cloudflare.com 가입
2. **도메인 등록**(Cloudflare Registrar) 또는 기존 도메인의 네임서버를 Cloudflare로 변경
3. 1년 1~2만 원 수준. Access를 쓰려면 도메인이 반드시 있어야 합니다.

---

## 2. 터널 만들기 (맥북, 처음 한 번)

Cloudflare 대시보드 → **Zero Trust → Networks → Tunnels → Create a tunnel**

1. 커넥터 종류 **Cloudflared** 선택, 이름은 `rdp-archive`
2. 화면에 나오는 설치 명령을 맥 터미널에 붙여넣기:

```bash
sudo /opt/homebrew/bin/cloudflared service install eyJhIjoi...   # 대시보드가 준 명령 그대로
```

이렇게 하면 **재부팅해도 터널이 자동으로 켜집니다.**

3. 같은 화면의 **Public Hostname** 탭에서:

| 항목 | 값 |
|---|---|
| Subdomain | `rdp` |
| Domain | 내 도메인 |
| Type | `HTTP` |
| URL | `localhost:8791` |

→ `https://rdp.내도메인.com` 이 맥북의 8791 포트로 연결됩니다.

> 확인: `sudo launchctl list | grep cloudflare` 또는 `curl -I https://rdp.내도메인.com` (아직 502/403이어도 정상)

---

## 3. 인증 걸기 (가장 중요)

**Zero Trust → Access → Applications → Add an application → Self-hosted**

1. Application name: `RDP Archive`
2. Public hostname: `rdp.내도메인.com`
3. **Policy**:
   - Action: `Allow`
   - Include → **Emails** → 내 이메일 (회사 이메일 권장)
4. **Authentication**: One-time PIN 활성 (이메일로 오는 6자리 코드)

이 단계를 빼면 **누구나 회사 배합 DB를 고칠 수 있습니다.**
(그래도 앱이 `Cf-Access-Jwt-Assertion` 헤더 없는 요청을 403으로 막지만, Access는 꼭 켜세요.)

---

## 4. 앱에 주소 등록

```bash
cd ~/.aside/artifacts/rdp-archive
python3 setup_tunnel.py rdp.내도메인.com me@nifco.co.kr 내팀이름
```

세 번째 값은 Zero Trust **팀 이름**입니다 (Settings → Custom Pages 의 Team domain `내팀이름.cloudflareaccess.com`).
서버가 이 주소의 공개키로 Access 토큰 **서명을 검증**합니다. 비워 두면 외부 접속은 전부 403입니다.

`config.json`에 이렇게 들어갑니다:

```json
"allowHosts": ["rdp.내도메인.com", "localhost", "127.0.0.1"],
"requireCfAccess": true,
"cfAccessEmail": "me@nifco.co.kr",
"cfAccessTeamDomain": "내팀이름.cloudflareaccess.com"
```

(선택) Access 애플리케이션의 **AUD 태그**를 `"cfAccessAud"`에 넣으면 다른 Access 앱의 토큰도 거절합니다.
`config.json`이 깨져서 읽히지 않으면 서버는 외부 접속을 모두 거절한 채로 시작합니다(localhost만 허용).

`cfAccessEmail`을 넣으면 **그 이메일 토큰만** 통과합니다(다른 사람 초대 시 비우거나 추가).

---

## 5. 서버 켜기

`RDP Archive.command` 더블클릭 (또는 터미널 `python3 server.py`).
기본 모드로 켜면 됩니다. `--lan`은 쓰지 마세요.

터미널에 이 줄이 보이면 성공:

```
  터널    https://rdp.내도메인.com   (Cloudflare Access 인증 필수)
```

---

## 6. 재부팅해도 자동으로 켜지게 (선택)

```bash
cd ~/.aside/artifacts/rdp-archive
./install_launchagent.sh
```

- 로그: `~/Library/Logs/rdp-archive.log`
- 해제: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.nifco.rdparchive.plist`

> 터널(cloudflared)은 2단계에서 서비스로 설치했으므로 이미 자동 시작입니다.
> 이 스크립트는 **앱 서버**를 자동 시작시킵니다.

---

## 7. 맥북 상시 대기

- 전원 연결
- 시스템 설정 → 배터리 → 옵션 → **"디스플레이가 꺼져 있을 때 자동으로 잠자기 방지"** 켜기
- 뚜껑은 열어 두기 (닫으면 잠자기)

---

## 8. 확인 체크리스트

| 증상 | 원인 / 조치 |
|---|---|
| `403 Cloudflare Access 인증이 필요합니다` | Access 앱·정책 미설정, 또는 `setup_tunnel.py` 미실행 |
| `403 forbidden host` | `allowHosts`에 그 주소가 없음 → `setup_tunnel.py` 다시 |
| `502 Bad Gateway` | 맥북의 앱 서버가 꺼져 있음 → `RDP Archive.command` 실행 |
| `1033` / 터널 오프라인 | `sudo launchctl list \| grep cloudflare`, 맥북이 잠들었는지 확인 |
| 이메일 코드가 안 옴 | Access 정책의 Emails에 그 주소가 있는지, 스팸함 확인 |

회사 PC에서 `https://rdp.내도메인.com` → 이메일 코드 입력 → 아카이브가 열리면 끝입니다.

---

## 주의 2가지

1. **회사 방화벽**: 일부 회사는 개인 도메인이나 Cloudflare를 막습니다. 회사 PC에서 먼저 열어보세요.
2. **회사 데이터 반출**: 배합 DB가 집 맥북 ↔ Cloudflare를 거쳐 회사로 오갑니다. 보안 규정상 문제없는지 확인하세요.
   (원치 않으면 조회 전용으로 쓰고, 원격에서는 "DB로 보내기"를 누르지 않는 방법도 있습니다.)

---

## 9. 포트가 막혀 있을 때

터널은 `localhost:8791`을 봅니다. 앱이 포트를 밀어내면 터널이 502가 되므로,
앱은 **8791이 다른 프로그램에 잡혀 있으면 그냥 종료하고 알려줍니다.**

```bash
lsof -nP -iTCP:8791 -sTCP:LISTEN     # 누가 쓰고 있는지 확인
kill <PID>                            # 정리 후 다시 실행
```

이미 앱이 떠 있으면 `이미 실행 중입니다 → http://localhost:8791`만 출력하고 끝납니다(중복 실행 안 됨).
