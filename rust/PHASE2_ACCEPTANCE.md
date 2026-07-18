# Phase 2 acceptance gates

Phase 2의 목표는 프로젝트 UI 완성이 아니라, 최대 20개의 ConPTY 세션을 안전하게
운영할 수 있는 터미널 엔진과 pane별 frontend 제어기를 검증하는 것이다. 실제 프로젝트
복원, Codex/Grok resume, 완료 알림, 브라우저 탭은 후속 phase 범위다.

이 문서의 체크박스는 증거가 확인된 경우에만 완료한다. 테스트 이름이나 실행 명령이
아직 없으면 구현이 아니라 **미완료**로 판단한다.

## Gate 구분

- **P0 자동 gate**: Phase 2 backend/frontend 통합 전에 전부 통과해야 한다.
- **Windows 수동 gate**: 실제 WebView2, Microsoft IME, OS clipboard, GPU와 시스템
  부하가 필요한 항목이다. 내부 구현 커밋은 막지 않지만 Phase 2 종료와 preview 배포를
  막는다.
- 테스트는 production 프로젝트 목록이나 Codex/Grok 세션을 읽거나 수정하면 안 된다.
- 실패한 테스트는 PowerShell, conhost/OpenConsole 및 그 후손 프로세스를 남기면 안 된다.

## 현재 기준점

- [x] 2026-07-16 기준 Phase 1 Rust unit/ConPTY 테스트 3개 통과
- [x] 실제 ConPTY를 통한 한글 UTF-8 round-trip 테스트 존재
- [x] Phase 2 전용 Rust 테스트 20개 존재 및 통과
- [x] frontend unit test runner와 `npm test` script 존재 (21개 통과)
- [x] 실제 ConPTY 20-session Windows stress test와 release process smoke 정상/강제 종료 통과
- [ ] packaged preview 수동 검수 완료

### 알려진 잔여 gate

- `portable-pty`는 Windows process를 생성한 다음 session Job Object에 할당한다.
  `CREATE_SUSPENDED` 또는 `PROC_THREAD_ATTRIBUTE_JOB_LIST`를 지원하기 전까지는
  PowerShell profile이 그 짧은 구간에 즉시 만든 자식의 session별 편입을 별도 수동
  종료 검사로 확인해야 한다.
- Tauri `Channel::send` 성공은 JavaScript callback 소비까지 보증하지 않는다. pane
  폐기 시 frontend가 보내는 `stop_terminal`과 앱 전역 Job Object가 현재 안전망이며,
  실제 WebView reload/Channel 소실 통합 검사는 아직 수동 gate다.
- Microsoft 한국어 IME composition과 OS bitmap clipboard는 실제 packaged WebView2에서
  아래 M1/M2 절차를 통과해야 한다.

## 공통 실행 명령

저장소 루트의 PowerShell에서 실행한다.

```powershell
$Cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$Manifest = 'rust\apps\ihc-desktop\src-tauri\Cargo.toml'
$Desktop = 'rust\apps\ihc-desktop'

if (-not (Test-Path -LiteralPath $Cargo)) {
    throw "cargo.exe not found: $Cargo"
}

& $Cargo fmt --manifest-path $Manifest -- --check
if ($LASTEXITCODE -ne 0) { throw 'cargo fmt failed' }

& $Cargo clippy --manifest-path $Manifest --all-targets --all-features -- -D warnings
if ($LASTEXITCODE -ne 0) { throw 'cargo clippy failed' }

& $Cargo test --manifest-path $Manifest --all-targets
if ($LASTEXITCODE -ne 0) { throw 'cargo test failed' }

npm ci --prefix $Desktop --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

npm run build --prefix $Desktop
if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
```

frontend test runner는 다음 명령으로 실제 테스트 21개를 실행한다. 이 명령이 없거나
0개의 테스트만 실행하면 gate 실패다.

```powershell
npm test --prefix rust\apps\ihc-desktop
```

Windows 실 ConPTY 테스트는 다른 테스트와 process 상태가 섞이지 않도록 직렬 실행한다.
필터 결과가 0 tests이면 성공으로 인정하지 않는다.

```powershell
& $Cargo test --manifest-path $Manifest phase2_windows_ -- --test-threads=1 --nocapture
```

## P0-A — 빌드와 테스트 가능성

- [x] `cargo fmt --check` 통과
- [x] `cargo clippy --all-targets --all-features -- -D warnings` 통과
- [x] 전체 Rust 테스트 20개 통과
- [x] frontend typecheck/build 통과
- [x] frontend test runner가 실제 테스트 21개 실행
- [x] 터미널 엔진이 Tauri `Channel`에 직접 종속되지 않고 느린/닫힌 sink를 fake로 주입 가능
- [ ] test snapshot에서 다음 수치를 읽을 수 있음
  - active, reserved, starting, stopping session 수
  - 실제 spawn 동시 실행 수와 최대치
  - session별/global pending output bytes
  - output batch 및 sequence 수
  - resize requested/applied/coalesced 수와 최종 크기
  - 관리 중인 PID

합격 기준: 테스트 전용 관측값 없이 sleep과 추측만으로 검증하는 항목이 없어야 한다.

## P0-B — 20개 제한과 startup cap

필수 자동 테스트 식별자:

- [x] `enforces_twenty_reservations_under_concurrency`
- [x] `spawn_limiter_never_exceeds_two_concurrent_spawns`
- [x] frontend `StartScheduler removes and rejects an aborted queued job`
- [x] `failed_started_event_rolls_back_the_entire_session`
- [x] `starts_marks_and_stops_twenty_real_sessions_without_leaks`

합격 기준:

- 50개 동시 start 요청에도 `active + reserved + starting <= 20`이 항상 성립한다.
- 20개를 넘는 요청은 명시적인 capacity 오류를 반환한다.
- 실제 spawn 동시 실행 수는 최대 2개다.
- 대기 중 취소된 pane은 PowerShell 프로세스를 생성하지 않는다.
- openpty/spawn/Job 할당 실패 후 slot과 startup permit이 즉시 반환된다.
- 20개 session 모두 클릭이나 focus 없이 첫 PowerShell prompt까지 도달한다.
- stop을 요청한 session의 slot은 실제 종료가 확인되기 전에 재사용하지 않는다.

## P0-C — bounded batched output와 순서

필수 자동 테스트 식별자:

- [x] session 1 MiB/32 batches 및 global 8 MiB output budget
- [x] `output_flow_blocks_until_cumulative_ack`
- [x] `batches_without_splitting_korean_scalars`
- [x] 20-session sequence `0..lastSequence`, 단일 `Exited`, 이후 output 0 검증
- [x] `dropped_webview_channel_terminates_a_real_session`
- [ ] `phase2_windows_concurrent_output_hashes_match`
- [ ] `phase2_windows_final_output_drains_before_exit`

합격 기준:

- pending output은 session당 1 MiB, 전체 8 MiB를 넘지 않는다.
- 한 batch는 64 KiB 이하이고, 지속 출력 중 16ms 이내에 전송된다.
- 느린 sink에서는 출력을 버리지 않고 PTY read에 backpressure를 건다.
- frontend/IPC까지 ACK 또는 credit을 사용해 end-to-end backlog를 제한한다. Rust 내부
  queue만 bounded이고 WebView IPC backlog가 무제한이면 실패다.
- fake slow sink를 3초 정지하고 총 32 MiB를 보낸 뒤 byte hash, sequence, 길이가 원본과
  일치한다.
- Windows에서는 20개 session이 각각 최소 4 MiB의 고유 marker를 출력하고 pane별 hash가
  정확히 일치한다.
- 누락, 중복, pane 간 혼입, sequence 역전이 0이다.
- 마지막 output이 sink에 전달된 뒤 `Exited`가 정확히 한 번 전달된다.
- sink/Channel이 닫히면 session과 worker가 bounded deadline 안에 정리된다.

## P0-D — resize latest-wins coalescing

필수 자동 테스트 식별자:

- [x] `resize_mailbox_keeps_only_latest_size` (5,001 requests)
- [x] `resize_mailbox_suppresses_an_already_applied_size` (100회 반복 통과)
- [ ] `phase2_resize_does_not_starve_io`
- [ ] `phase2_resize_after_stop_is_discarded`

합격 기준:

- session마다 resize는 최대 한 개만 in-flight다.
- 20개 session 각각에 2초 동안 5,000개 resize를 요청해도 실제 적용은 pane당 150회
  이하이다.
- 각 session의 최종 cols/rows는 마지막 요청과 정확히 같다.
- 같은 크기의 연속 요청은 ConPTY에 다시 적용하지 않는다.
- stop 이후 남은 resize는 적용하지 않는다.
- resize stress 중에도 output hash가 변하지 않고 input echo p95가 100ms 이하이다.

## P0-E — lifecycle, clean shutdown과 강제 종료

필수 자동 테스트 식별자:

- [ ] `phase2_stop_is_idempotent_under_race`
- [ ] `phase2_natural_exit_and_stop_emit_one_exit`
- [x] 20-session 실제 ConPTY에서 `Exited` 이후 output 0
- [ ] `phase2_rapid_create_close_leaves_no_sessions`
- [ ] `phase2_stop_all_recovers_poisoned_registry`
- [ ] `phase2_windows_shutdown_kills_descendants`
- [ ] `phase2_windows_stalled_reader_has_bounded_shutdown`
- [ ] `phase2_windows_instant_grandchild_cannot_escape_job`

합격 기준:

- 상태 전이는 `Queued -> Starting -> Running -> Stopping -> Exited`의 허용된 방향만 따른다.
- start/write/resize/stop/natural-exit 경쟁에서도 `Started`는 최대 한 번, `Exited`는 정확히
  한 번이다.
- `Exited` 뒤 output은 0건이다.
- graceful 종료 deadline은 1.5초, 이후 강제 종료 deadline은 1.5초다.
- 앱 shutdown 전체는 5초 안에 끝난다.
- output drain 대기, reader/wait worker join에는 반드시 timeout이 있다.
- 20개 session이 출력·입력·resize 중일 때 종료해도 모든 PowerShell, conhost/OpenConsole,
  즉시 생성된 grandchild PID가 5초 안에 사라진다.
- mutex poison, sink 단절, read 오류에서도 남은 session 종료를 포기하지 않는다.
- 100회 빠른 create/close 뒤 session, reservation, worker, PID 수가 0이다.

## P0-F — pane별 frontend 상태와 라우팅

필수 frontend 테스트 시나리오:

- [ ] 20개 controller가 서로 다른 session ID와 xterm 인스턴스를 소유
- [ ] output이 session ID가 일치하는 pane에만 전달됨
- [ ] pane별 input, resize, scroll/follow 상태가 섞이지 않음
- [ ] start 응답 전에 닫은 pane이 늦은 응답으로 부활하지 않음
- [ ] 닫은 pane의 이전 input/output 오류가 새 generation 상태를 덮지 않음
- [ ] 100회 controller create/dispose 뒤 listener와 timer 수가 원래 값으로 복귀

합격 기준:

- 20개 pane에 서로 다른 marker를 동시에 왕복했을 때 다른 pane에서 발견되는 marker가
  0개다.
- 모든 async callback은 pane ID와 generation을 함께 검증한다.
- controller dispose 뒤 Channel listener, ResizeObserver, timer, xterm 인스턴스가 남지 않는다.

## P0-G — 자동화 가능한 입력·복사·스크롤 상태

실제 OS IME와 clipboard 호출 자체가 아니라 frontend 상태와 routing을 fake로 검증한다.

필수 frontend 테스트 시나리오:

- [ ] composition 중 key event를 가로채거나 중복 전송하지 않음
- [ ] committed `onData`를 순서대로 정확히 한 번 전송
- [x] `onBinary`의 `00/7f/80/ff` raw byte 경로 보존
- [ ] 선택 있음 + Ctrl+C는 copy, 선택 없음 + Ctrl+C는 ETX/SIGINT
- [ ] Ctrl+Shift+C와 Ctrl+Insert는 copy
- [ ] Ctrl+V, Ctrl+Shift+V, Shift+Insert는 paste
- [ ] 우클릭은 선택이 있으면 copy, 없으면 paste
- [ ] image clipboard routing이 Codex/Grok/unsupported를 구분
- [ ] 맨 아래·선택 없음일 때만 output follow
- [ ] 위로 스크롤하거나 선택 중이면 viewport 고정
- [ ] output 종료 뒤 지연된 callback이 강제로 맨 아래로 이동시키지 않음
- [ ] 사용자가 입력하면 follow를 재개한 뒤 input 전송
- [x] `lastSequence` 연속성 + xterm write callback + animation frame barrier 자동 테스트

합격 기준: 위 상태 행렬 전부 통과하고, test runner가 0 tests로 끝나지 않아야 한다.

## P0-H — fault injection

- [ ] openpty 실패
- [ ] process spawn 실패
- [ ] Job Object 생성·설정·할당 실패
- [ ] output reader 오류와 stall
- [ ] writer 오류
- [ ] resize 오류
- [ ] worker 생성 실패
- [x] sink send 실패 및 Started event 실패 rollback
- [ ] registry mutex poison

합격 기준: 각 실패 직후 reservation, permit, handle, worker, process가 남지 않고 다음 정상
session을 시작할 수 있어야 한다.

## Windows 수동 gate — 실제 앱 동작

다음 항목은 Phase 2 자동 P0가 모두 통과한 debug/release preview에서 수행한다. 각 항목은
검수 날짜, Windows/WebView2 버전, 실행 파일 hash를 함께 기록한다.

### M1 — Microsoft 한국어 IME

- [ ] `우리가`를 20회 입력해 누락·지연 0회
- [ ] `실험용`을 20회 입력해 누락·지연 0회
- [ ] 마지막 음절 직후 추가 키 없이 Enter를 20회 수행해 원문 일치
- [ ] 대량 출력 중 한글 조합 20회 성공
- [ ] pane 전환 직후 한글 조합 20회 성공
- [ ] resize 직후 한글 조합 20회 성공

합격 기준: xterm 화면과 PowerShell echo 모두 원문과 같고 글자 누락, 다음 키까지 지연,
중복 입력이 한 번도 없어야 한다.

### M2 — 실제 Windows clipboard

- [ ] 1 MiB 한글/영문/CRLF 텍스트 copy-paste 왕복 일치
- [ ] 출력 중 선택 영역을 10회 복사해 선택 당시 문자열과 일치
- [ ] bitmap screenshot을 Codex 대상 pane에 5회 붙여넣기 성공
- [ ] bitmap screenshot을 Grok 대상 pane에 5회 붙여넣기 성공
- [ ] PNG 파일 clipboard와 혼합 clipboard 처리 확인
- [ ] clipboard 권한/일시 잠금 실패 후 UI 정지 없이 재시도 가능

### M3 — 실제 scroll/focus

- [ ] 맨 아래에서는 마지막 줄을 따라감
- [ ] 위로 스크롤한 동안 10,000줄 출력해도 viewport가 맨 아래로 이동하지 않음
- [ ] 드래그 선택 중 출력해도 selection과 복사 결과 유지
- [ ] 출력이 끝난 뒤 지연된 자동 스크롤이 발생하지 않음
- [ ] 비활성 pane 출력이 focus를 훔치지 않음
- [ ] 입력 시에만 해당 pane이 맨 아래로 이동

### M4 — 20-pane 성능과 복구

- [x] 20개 PowerShell이 클릭 없이 모두 첫 prompt 표시
- [ ] 20개 동시 출력 중 pane 입력 echo p95 100ms 이하
- [ ] UI frame time p95 33ms 이하
- [ ] 5분 유휴 CPU 평균 1% 이하
- [ ] Rust 앱/WebView/PTY 인프라 메모리가 C# 기준보다 증가하지 않음
- [x] 8번째와 20번째 pane이 검은 화면 또는 지연 로딩 상태로 남지 않음
- [ ] 100회 pane 추가/종료 후 thread, handle, memory의 지속 증가 없음

성능 측정 도구와 C# 비교 기준값이 아직 기록되지 않았다면 M4는 미완료다.

### M5 — packaged app 종료

- [ ] 20개 session 작업 중 창 X 버튼으로 5초 안에 종료
- [x] 종료 직후 PowerShell, conhost/OpenConsole 및 후손 PID 0개
- [ ] 강제 종료 fallback에서도 흰 화면이나 pane별 순차 종료가 노출되지 않음
- [x] 종료 후 즉시 재실행 가능

2026-07-16 release smoke에서 20개 pane은 약 1.3–1.6초 안에 생성됐다. 정상
`CloseMainWindow` 종료는 약 0.54초, 강제 root-process 종료는 약 0.68초였고 두 경우
모두 identity로 추적한 후손 프로세스가 0개였다. 같은 build를 다시 실행해 20개 pane과
각 첫 prompt를 화면에서 확인했다. 자동 데스크톱 입력은 포커스 보장이 되지 않아 Microsoft
IME gate의 근거로 사용하지 않았다.

## Phase 2 종료 판정

- [ ] P0-A부터 P0-H까지 전부 통과
- [ ] 필수 Rust/Windows 테스트가 각각 1개 이상 실제 실행되고 0 tests가 아님
- [ ] frontend test runner가 실제 상태·라우팅 테스트를 실행
- [ ] M1부터 M5까지 동일 build에서 통과
- [ ] orphan process 0개
- [ ] production `projects.json`과 실제 Codex/Grok session 파일 변경 0개
- [ ] 실패 시 C# baseline으로 돌아가는 경로 확인

하나라도 미완료면 Phase 3으로 넘어갈 수는 있어도 Phase 2 완료 또는 Rust preview 승격으로
표시하지 않는다.
