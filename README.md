# codex-bridge

Claude 앱(Claude Code)에서 Codex 모델(Luna, Sol, Astra 등)에게 일을 맡기는 MCP 서버.

- 인증: Codex의 ChatGPT OAuth 로그인만 사용 (API 키 사용 안 함, 환경 변수의 키도 차단)
- Claude 앱이 새 대화를 열 때 자동으로 켜지고, 대화를 닫으면 같이 꺼짐
- macOS / Windows 지원

## 사용 예 (Claude 앱에서)

> 이 작업은 루나에게 맡겨봐, 추론수준은 니가 정해서
>
> 솔에게 작문을 시켜. 서브에이전트로 5개 답변을 받아와

---

## 설치 — macOS

**준비물**: Node.js 18+, Codex(ChatGPT 앱 또는 Codex CLI), Claude 앱

```bash
# 1) Node.js (없으면)
brew install node

# 2) Codex — ChatGPT 앱이 설치돼 있으면 생략 가능 (앱 안의 codex를 자동으로 찾음)
npm i -g @openai/codex

# 3) ChatGPT 계정으로 로그인 (브라우저가 열림, 한 번만)
codex login

# 4) 받아서 설치
git clone https://github.com/rlaehrb1/codex-bridge.git ~/codex-bridge
cd ~/codex-bridge
npm ci

# 5) Claude에 등록
node register.mjs
```

Claude 앱을 다시 시작하면 끝.

## 설치 — Windows

**준비물**: Node.js 18+, Git, Codex CLI, Claude 앱. 아래는 **PowerShell** 기준.

```powershell
# 1) Node.js, Git (없으면)
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# 설치 후 PowerShell 창을 새로 연다 (PATH 반영)

# 2) Codex CLI
npm i -g @openai/codex

# 3) ChatGPT 계정으로 로그인 (브라우저가 열림, 한 번만)
codex login

# 4) 받아서 설치
git clone https://github.com/rlaehrb1/codex-bridge.git $HOME\codex-bridge
cd $HOME\codex-bridge
npm ci

# 5) Claude에 등록
node register.mjs
```

Claude 앱을 다시 시작하면 끝.

> PowerShell에서 `npm`/`codex` 실행이 "스크립트를 실행할 수 없습니다"로 막히면 한 번만:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### register.mjs가 하는 일

`claude mcp add-json codex ... -s user`로 user 범위 MCP 서버 `codex`를 등록한다
(node와 server.mjs는 절대 경로로 등록). `claude` CLI가 PATH에 없으면 `~/.claude.json`
(Windows: `%USERPROFILE%\.claude.json`)에 직접 쓰고 백업(`.claude.json.bak-codex-bridge`)을 남긴다.
이 경우엔 **Claude 앱을 완전히 종료한 상태에서** 실행할 것.

폴더를 옮겼거나 Node를 새로 설치했다면 `node register.mjs`를 다시 실행하면 된다.

---

## 도구

| 도구 | 하는 일 |
| --- | --- |
| `codex_models` | 쓸 수 있는 모델, 추론 수준, 사용량 확인 |
| `codex_start` | 새 작업 맡기기 |
| `codex_reply` | 작업 모델의 질문에 답하기 / 보완 요청 |
| `codex_wait` | 오래 걸리는 작업 결과 더 기다리기 |
| `codex_cancel` | 작업 중단 |

## codex_start 옵션

| 옵션 | 값 |
| --- | --- |
| `access` | `workspace`(기본): 작업 폴더만 수정, 네트워크·플러그인 허용 / `read-only`: 수정 불가 / `full`: 컴퓨터 전체 (요청할 때만) |
| `subagents` | `true`면 작업 모델이 서브에이전트로 일을 나눠 병렬 처리 (Astra·Sol + high 이상 권장) |

그 밖의 동작(작업 폴더 밖 접근, 막힌 네트워크, 플러그인 확인)은 Codex의 **자동 검토(auto_review)** 가
사용자 대신 위험도를 판단해 허용하거나 거절한다. 결과는 보고서의 "자동 승인 검토"에 표시된다.

구조: 나 → Claude(총괄) → 상위 모델(팀장) → 서브에이전트들

## 작업 화면

브리지가 켜져 있으면 http://127.0.0.1:4390/ 에서 Claude가 맡긴 작업을 대화 형태로 실시간으로 볼 수 있다.
Claude의 지시, Codex의 중간 보고·질문·최종 보고가 보이고, 가장 최근 작업을 자동으로 따라간다.

- Codex가 `~/.codex/sessions`에 남기는 기록을 읽기만 한다. 작업에는 영향을 주지 않는다.
- 이 PC 안(127.0.0.1)에서만 열린다. 포트는 환경 변수 `CODEX_BRIDGE_VIEWER_PORT`로 바꿀 수 있다.

## 관리 / 문제 해결

```bash
claude mcp get codex              # 상태 확인
claude mcp remove codex -s user   # 제거
```

- **로그인이 풀림**: `codex login` 다시 실행. 토큰은 `~/.codex/auth.json`에 저장되며 재부팅해도 유지된다.
  이 파일은 비밀번호처럼 취급할 것 (백업·동기화 폴더에 올리지 말 것).
- **"Codex 실행 파일을 찾지 못했습니다"**: `codex --version`이 되는지 확인. 특이한 위치에 설치했다면
  환경 변수 `CODEX_BIN`에 실행 파일 전체 경로를 지정한다.
- **회사 네트워크/프록시**: `codex login`과 작업 실행 모두 OpenAI 서버 접속이 필요하다. 막혀 있으면 IT 정책 확인.
