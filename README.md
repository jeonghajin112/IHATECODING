# IHATECODING

하나의 가벼운 Windows 프로그램 안에서 PowerShell을 최대 20개까지 열고 자동 분할하는 앱입니다. 하단에는 Codex 5시간 사용량과 Codex·Grok의 남은 주간 한도가 작게 표시됩니다.

## 실행

폴더의 `IHATECODING.exe`를 더블클릭하면 됩니다.

처음 실행하면 왼쪽 프로젝트 사이드바의 `＋ 새 프로젝트`에서 프로젝트 이름과 폴더를 지정합니다. 그다음 사이드바에서 사용할 프로젝트를 선택하고 상단의 `＋ PowerShell`을 누르면 해당 프로젝트 폴더에서 새 PowerShell이 열립니다. 프로젝트 목록과 마지막 선택은 앱을 다시 실행해도 유지됩니다. 실행 파일을 새로 빌드하려면 PowerShell에서 다음 명령을 실행합니다.

```powershell
.\Build.ps1
```

## 사용법

- 왼쪽 `프로젝트` 사이드바: 저장된 프로젝트 목록과 폴더 확인
- `＋ 새 프로젝트`: 이름과 폴더를 지정해 새 프로젝트 추가
- 상단 탭의 `＋`: 프로젝트가 연결되지 않은 빈 작업 탭을 즉시 추가
- 빈 탭에서 왼쪽 프로젝트 클릭: 선택한 빈 탭을 해당 프로젝트 작업 탭으로 전환
- 프로젝트 탭: 여러 프로젝트를 동시에 열어 두고 전환(탭을 닫아도 실행 중인 PowerShell은 유지)
- `＋ PowerShell`: 활성 프로젝트 탭 안에 해당 폴더의 새 PowerShell 추가(최대 20개)
- 프로젝트 전환: 다른 프로젝트의 PowerShell은 종료하지 않고 숨겼다가 다시 선택하면 그대로 표시
- 각 패널 제목 더블클릭: PowerShell 이름 변경(Enter 저장, Esc 취소)
- Codex 작업 완료: 알림음과 해당 패널의 황금색 맥동 효과 표시(패널 클릭 시 해제)
- 각 패널의 `□`: 해당 PowerShell만 크게 보기/원래 분할로 돌아가기
- 각 패널의 `×`: 해당 PowerShell 종료
- `Ctrl+Shift+T`: PowerShell 추가
- `Ctrl+Shift+W`: 현재 PowerShell 닫기
- `Alt+Enter`: 현재 PowerShell 확대/복귀
- `Ctrl+Shift+C`, `Ctrl+Shift+V`: 터미널 화면 복사/붙여넣기
- 마우스 휠: 터미널 기록 스크롤
- 터미널에서 우클릭: 붙여넣기

PowerShell 개수에 따라 1~20개 패널이 화면에 자동으로 배치됩니다.

## 사용량 표시

- Codex: 로컬 `~/.codex/sessions` 기록에서 5시간 사용량과 남은 주간 한도를 읽습니다.
- Grok: 로컬 `~/.grok/logs/unified.jsonl` 기록이 있을 때 남은 주간 한도를 표시합니다.
- 15초마다 새로 확인하며, 계정 비밀번호나 인증 토큰은 읽지 않습니다.

## 터미널 구조

셸은 기본 Windows PowerShell 5.1 그대로입니다. 화면과 입력은 xterm.js + ConPTY(`node-pty`) 경로를 사용하므로, 한글 IME 조합 중간값이 PowerShell로 들어가지 않고 조합이 끝난 글자만 UTF-8로 전달됩니다.

Electron 앱을 창마다 띄우지 않습니다. 모든 패널은 하나의 공용 PTY 백엔드와 작은 Chromium 렌더러 풀을 공유합니다. 따라서 8개 이상의 패널도 클릭해야 뒤늦게 켜지는 검은 화면 없이 자동으로 준비되고, 창 개수만큼 Node 프로세스나 Chromium 렌더러가 늘어나지 않습니다.

각 패널은 독립된 기본 PowerShell 프로세스이므로 패널을 닫으면 그 안에서 실행한 Codex 등의 자식 프로세스도 함께 종료됩니다.

Codex 완료 알림은 공식 `agent-turn-complete` 알림 훅을 사용합니다. 앱을 업데이트한 뒤 새로 만든 PowerShell에서 실행한 Codex부터 각 패널과 연결됩니다.

프로젝트별 PowerShell 개수·순서·이름·시작 폴더는 자동 저장됩니다. Codex 작업 완료 알림에서 대화 ID도 함께 저장하므로 컴퓨터를 다시 켠 뒤 프로젝트를 열면 해당 패널에서 `codex resume`이 자동 실행됩니다. 이름에 `GROK`이 포함된 기존 패널은 로컬 Grok 기록에서 각 대화 ID를 한 번 연결해 저장하고, 이후에는 해당 패널에서 `grok --resume`이 자동 실행됩니다. 실행 중이던 일반 명령, PowerShell 환경 변수, 화면 출력 자체는 재부팅 후 복원되지 않습니다.

Windows 10 1809 이상, .NET 9 Desktop Runtime, Microsoft Edge WebView2 Runtime, Node.js가 필요합니다. Codex 또는 Grok CLI를 npm으로 설치했다면 Node.js는 이미 설치되어 있습니다.
