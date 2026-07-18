# IHATECODING

IHATECODING은 여러 PowerShell과 Codex/Grok CLI를 한 창에서 관리하는 가벼운 Windows 데스크톱 앱입니다. Rust + Tauri + ConPTY 기반이며 프로젝트별로 최대 20개 터미널을 복원합니다.

## 주요 기능

- 프로젝트별 PowerShell 최대 20개 자동 배치 및 재시작 복원
- 저장된 Codex 대화와 Grok 세션의 안전한 이어하기
- 작업 완료 알림음, 터미널 테두리, 프로젝트·탭 미확인 배지
- Codex 5시간/주간 한도와 Grok 남은 한도 표시
- 터미널 드래그 이동, 좌우 크기 조절, 정렬 스냅
- 한글 IME 입력, 텍스트 복사/붙여넣기, 클립보드 스크린샷 붙여넣기
- 사용자가 위로 스크롤하거나 내용을 선택하면 자동 맨 아래 이동 일시 중지
- 기존 프로젝트 목록의 읽기 전용 자동 가져오기

프로젝트 경로, 대화 내용, 세션 ID, 프롬프트 및 인증 정보는 외부 서버로 전송하지 않습니다. 상태와 사용량은 로컬 파일만 읽고 저장합니다.

## 실행

릴리스 파일이 있다면 `IHATECODING.exe`를 실행합니다.

소스에서 개발 실행:

```powershell
cd .\rust\apps\ihc-desktop
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm install
npm run tauri dev
```

## 빌드

저장소 루트에서 다음을 실행합니다.

```powershell
.\Build.ps1
```

스크립트는 프런트엔드·Rust 테스트를 실행한 뒤 production 후보 바이너리와 NSIS 설치 파일을 만듭니다. 현재 기본 실행 파일은 자동으로 바꾸지 않습니다. 주요 출력 위치는 다음과 같습니다.

- `rust\apps\ihc-desktop\src-tauri\target\release\ihatecoding.exe`
- `rust\apps\ihc-desktop\src-tauri\target\release\bundle\nsis\`

빠른 바이너리 빌드만 필요하면:

```powershell
.\Build.ps1 -NoInstaller
```

서명과 검증을 마친 후보를 기본 실행 파일로 전환할 때는 CI에서 받은 후보 경로를 명시합니다. 이 경로를 사용하면 후보를 다시 빌드하거나 덮어쓰지 않습니다. 서명되지 않은 로컬 개발 빌드의 전환은 별도 위험 수락 옵션 없이는 차단됩니다.

```powershell
.\Build.ps1 -Cutover `
  -CandidatePath 'C:\path\to\signed\ihatecoding.exe' `
  -ApprovedPublisherThumbprint '<승인된 인증서 지문>'
```

## 요구 사항

- Windows 10 1809 이상 또는 Windows 11
- Microsoft Edge WebView2 Runtime
- 실행할 Codex/Grok CLI(선택)
- 소스 빌드 시 Node.js 22 이상과 Rust stable

앱 내부 터미널은 Windows PowerShell 5.1을 사용합니다.

## 검증

```powershell
cd .\rust\apps\ihc-desktop
npm test
npm run build

cd .\src-tauri
cargo test --all-targets
cargo clippy --all-targets --all-features -- -D warnings
```

1·8·20개 터미널의 자동 복원, 메모리, 정상 종료 및 고아 프로세스 검증은 저장소 루트의 `scripts\phase6-compare.ps1 -SkipCSharp`로 수행합니다. 검증은 전용 임시 상태만 사용하며 실제 사용자 상태를 변경하지 않습니다.
