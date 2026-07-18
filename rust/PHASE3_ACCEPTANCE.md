# Phase 3 acceptance gates

이 문서는 현재 Phase 3A foundation과 production migration 전에 필요한 Phase 3B gate를
분리한다. Phase 3 전체 목표는 C# 프로젝트 카탈로그를 손상시키지 않고 읽어 Rust preview
전용 저장소로 가역적으로 가져오는 것이다. 최종 gate는 프로젝트, pane 순서와 이름,
가로 폭 비율, 선택 상태와 미확인 알림을 저장한다. 탭 모델은 다음 UI 이관이 사용할 수
있게 계약을 고정하지만, 브라우저 자동 탐색과 Codex/Grok resume는 수행하지 않는다.

체크박스는 실행 가능한 테스트나 검수 기록이 있을 때만 완료한다. 앱이 정상 실행되는
것만으로 데이터 호환성, 원자성 또는 복구가 검증됐다고 간주하지 않는다.

## 범위와 안전 기준

- legacy 입력은 C# `ProjectCatalog`의 PascalCase JSON이다. 기본 위치는
  `%LOCALAPPDATA%\PowerWorkspace\projects.json`이며 C# 테스트 override는
  `POWERWORKSPACE_PROJECTS_PATH`다.
- Phase 3B Rust preview의 쓰기 대상은 Tauri `app_local_data_dir()` 아래
  `com.ihatecoding.preview\state`뿐이다. production 파일과 Codex/Grok session
  디렉터리는 읽기·쓰기·rename·ACL 변경 대상이 아니다.
- Phase 3B importer는 production 파일을 직접 갱신하지 않는다. 가져오기 전 exact-byte snapshot과
  SHA-256을 preview 저장소에 만들고 이후 canonical state만 갱신한다.
- `projects-v1.schema.json`은 현재 C# 모양을 고정한 legacy 호환 계약이다. 직렬화된
  `schemaVersion`이 없으므로 Rust workspace schema version과 혼동하지 않는다.
- Phase 3에서 `CodexThreadId`와 `GrokSessionId`는 민감한 불투명 데이터일 뿐이다.
  agent 기록을 검색하거나 해당 ID로 CLI를 실행하면 gate 실패다.
- 저장 및 import 명령은 동기 Tauri IPC thread에서 파일 I/O를 수행하지 않는다.

세부 파일 형식과 command 경계는 `contracts/storage-tauri-v1.md`를 따른다.

## 현재 기준점

- [x] C# project/terminal 모델과 atomic-temp save 경로가 식별됨
- [x] sanitized `projects-v1.json` fixture와 strict legacy schema 존재
- [x] Rust preview bundle identifier가 production과 분리됨
- [x] remote child WebView가 `main` WebView의 IPC capability를 상속하지 않음
- [x] lossless legacy reader 및 resource limit 구현
- [x] versioned Rust workspace model 및 schema 구현
- [x] crash-safe writer, backup rotation 및 corruption recovery 구현
- [ ] copied production catalog에 대한 가역 import 검수

### 현재 구현 스냅샷: Phase 3B automated slice

이 절은 Phase 3 종료 선언이 아니라 2026-07-17 현재 자동화된 범위를 기록한다. 기존
Phase 3A `ProjectCatalogV1` 저장소는 현재 터미널 UI의 실행 상태를 계속 담당하고,
새 `workspace-v1`은 별도의 migration preview 저장소다. 가져온 프로젝트로 터미널을
시작하거나 Codex/Grok을 resume하지 않는다. 실제 런타임 전환은 후속 Phase 4 작업이다.

구현되어 자동 테스트가 존재하는 Phase 3B 범위:

- Tauri `app_local_data_dir()/state/workspace-v1.json`의 canonical schema v1,
  backend-owned revision/timestamp/import provenance와 persisted tab/layout/alert 모델
- 8 MiB 입력 상한, duplicate JSON member/UTF-8/trailing data/resource bound 검증,
  unknown legacy field exact-byte snapshot 보존
- detached copy의 read-only stable read, SHA-256/길이/mtime/file ID/ACL fingerprint 재검사,
  inspect token에 결합된 two-phase import와 동일 hash idempotency
- `expectedRevision` CAS, process-lifetime writer lock, 두 번째 instance read-only,
  same-directory temp flush/재검증, `ReplaceFileW` write-through commit과 3세대 backup
- corrupt/missing primary의 fail-closed load, opaque backup/temp 후보, 사용자가 고르는 복구,
  corrupt primary exact-byte quarantine
- local `main` WebView guard, `spawn_blocking` storage commands, structured redacted errors,
  JavaScript safe-integer 경계와 read-only import/recovery/future-version frontend state machine
- sidebar의 저장소 상태, 분리 복사본 검사/명시적 교체 및 verified recovery UI

자동 검증은 `cargo fmt --check`, 전체 `cargo clippy -D warnings`, Rust all-target tests,
frontend test 56개와 frontend build를 통과했다. Rust suite에는 실제 20개 ConPTY와
Job Object 종료 회귀도 계속 포함된다. 테스트는 UUID 기반 임시 디렉터리와 sanitized
fixture만 사용하며 실제 production catalog 또는 agent session content를 읽지 않는다.

Phase 3 종료 전에 남은 gate:

- 사용자가 만든 production catalog **복사본**으로 M1 가역 import/rollback 수동 검수
- directory handle을 유지한 최종 target identity 및 reparse-swap 방어, 상속 ACL 확인
- future schema raw payload를 손실 없이 보여 주는 IPC/read-only UX와 version golden chain
- backend storage drain/change notification 및 crash/process-kill Windows 수동 matrix
- M2~M5 corruption/path/privacy/multi-instance/performance 수동 기록

이 항목이 닫히기 전에는 production catalog를 직접 source/target으로 연결하지 않으며,
C# baseline과 rollback branch/tag를 유지한다.

### 구현 전 해결해야 할 계약 충돌

`MIGRATION_PLAN.md`는 unknown/future field 보존을 요구하지만 legacy schema는 catalog,
project, terminal 모두 `additionalProperties: false`다. strict schema validator만 사용하거나
typed struct를 그대로 재직렬화하면 future field가 사라진다. 따라서 strict validation과
lossless import를 분리하고, raw source snapshot 및 bounded unknown-field 보존을 모두
검증하기 전에는 writer를 production 경로에 연결하면 안 된다.

## 공통 자동화 명령

구현 후 저장소 루트에서 다음 명령이 모두 성공해야 한다.

```powershell
$Cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$Manifest = 'rust\apps\ihc-desktop\src-tauri\Cargo.toml'
$Desktop = 'rust\apps\ihc-desktop'

& $Cargo fmt --manifest-path $Manifest -- --check
if ($LASTEXITCODE -ne 0) { throw 'cargo fmt failed' }

& $Cargo clippy --manifest-path $Manifest --all-targets --all-features -- -D warnings
if ($LASTEXITCODE -ne 0) { throw 'cargo clippy failed' }

& $Cargo test --manifest-path $Manifest --all-targets
if ($LASTEXITCODE -ne 0) { throw 'cargo test failed' }

npm test --prefix $Desktop
if ($LASTEXITCODE -ne 0) { throw 'frontend tests failed' }

npm run build --prefix $Desktop
if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
```

storage fault test는 실제 `%LOCALAPPDATA%` 대신 테스트별 임시 디렉터리만 사용한다. 테스트
시작과 종료에 production catalog, preview production-like directory, Codex/Grok session
root의 content hash, 길이, last-write time과 ACL fingerprint를 비교한다.

## P0-A — schema, parser와 resource bounds

필수 자동 테스트 식별자:

- [x] `phase3_legacy_fixture_matches_csharp_shape`
- [x] `phase3_rejects_duplicate_json_members`
- [x] `phase3_rejects_oversized_catalog_before_parse`
- [ ] `phase3_bounds_projects_tabs_strings_ratios_and_extensions`
- [x] `phase3_unknown_fields_survive_lossless_import`
- [x] `phase3_unsupported_future_version_is_read_only`

합격 기준:

- UTF-8 BOM 유무를 처리하고 invalid UTF-8, duplicate JSON member와 trailing garbage를
  명시적으로 거부한다. 같은 key의 last-wins 처리는 금지한다.
- 입력 파일은 기본 8 MiB 이하이며 한도를 넘으면 전체 allocation 전에 중단한다.
- canonical state는 project 256개, tab 128개, project당 terminal 20개 이하이다.
- ID, 이름, 경로, URL, unknown JSON의 depth와 총 byte 수에 상한이 있다.
- project/terminal ID는 공백이 아닌 불투명 문자열이며 대소문자를 포함해 정확히
  중복 검사한다. Codex/Grok ID는 UUID로 검증하되 Phase 3에서는 사용하지 않는다.
- NaN/Infinity/0/음수 ratio는 허용하지 않는다. vector 길이는 layout column 수와 같고
  합계가 유한한 양수일 때만 정규화한다.
- strict fixture schema에 없는 field도 lossless import에서 raw snapshot과 extension
  영역에 보존된다. 값 자체는 log나 오류 문자열에 포함하지 않는다.

## P0-B — production 격리와 reversible import

필수 자동 테스트 식별자:

- [x] `phase3_import_never_opens_source_for_write`
- [x] `phase3_import_preserves_source_hash_metadata_and_acl`
- [x] `phase3_preview_path_cannot_alias_source`
- [x] `phase3_same_source_hash_is_idempotent`
- [x] `phase3_import_does_not_touch_agent_sessions`
- [x] `phase3_failed_import_leaves_no_committed_preview_state`

합격 기준:

- source는 read-only로 열고, 읽는 동안 크기나 last-write metadata가 변하면 안정된 snapshot을
  얻을 때까지 bounded retry 후 `sourceChanged`로 실패한다.
- import 전후 source의 exact SHA-256, 길이, last-write time, file ID와 ACL이 같다.
- preview target과 source가 lexical path뿐 아니라 resolved file identity로도 같으면
  import/save를 거부한다. junction, symlink, `\\?\`, UNC alias도 검사한다.
- 같은 source SHA-256을 다시 import해도 project, terminal, tab이 중복되지 않는다.
- merge 또는 replace는 명시적으로 선택하며 자동 merge는 없다. replace도 preview state만
  대상으로 한다.
- exact-byte source snapshot은 preview 전용 import directory에 사용자 전용 ACL로 남아
  rollback 근거가 된다. 자동 cleanup으로 마지막 snapshot을 지우지 않는다.
- 테스트와 fixture에 실제 사용자 이름, project path, agent ID 또는 session 내용이 없다.

## P0-C — 모델과 의미 보존

필수 자동 테스트 식별자:

- [x] `phase3_import_preserves_project_and_terminal_order`
- [x] `phase3_import_preserves_names_paths_timestamps_and_alerts`
- [x] `phase3_import_preserves_and_normalizes_valid_width_ratios`
- [x] `phase3_invalid_selected_project_becomes_unselected`
- [x] `phase3_duplicate_resume_ids_are_flagged_not_started`
- [x] `phase3_initial_tabs_are_deterministic`

합격 기준:

- project 순서와 각 project의 terminal 순서는 byte-for-byte fixture expectation과 같다.
- `Name`, `FolderPath`, `StartDirectory`, `CreatedAtUtc`, 두 agent ID와
  `CompletionPending`이 의미상 동일하다. timestamp는 UTC로 정규화해도 instant는 같다.
- 유효한 selected project만 선택한다. dangling ID를 임의의 첫 project로 바꾸거나 그
  project의 terminal을 자동 시작하지 않는다.
- C#의 pane layout 함수가 생성할 수 있는 `1..5` columns, `1..4` rows, `row-0..3`
  key만 활성 layout으로 사용한다. 알 수 없는 key는 보존하되 적용하지 않는다.
- 여러 pane이 같은 Codex/Grok ID를 소유하면 데이터를 지우지 않고 conflict를 기록한다.
  Phase 5의 명시적 해결 전까지 resume 대상이 될 수 없다.
- legacy에는 tab persistence가 없으므로 선택 project가 있으면 project tab 하나, 없으면
  empty tab 하나를 deterministic하게 생성한다. browser/output tab을 추측해 만들지 않는다.
- scrollback, terminal output, shell environment, cursor/selection, browser cookies와 POST
  body는 저장하지 않는다.

## P0-D — version migration

필수 자동 테스트 식별자:

- [ ] `phase3_legacy_v0_to_workspace_v1_golden`
- [ ] `phase3_migration_is_idempotent`
- [ ] `phase3_migration_failure_does_not_replace_current_state`
- [ ] `phase3_downgrade_is_refused`
- [ ] `phase3_every_supported_version_has_a_golden_fixture`

합격 기준:

- version dispatch는 구조 추측과 version field 규칙이 문서화돼 있고 모호한 입력은
  거부한다. version이 없는 PascalCase C# catalog만 legacy v0로 취급한다.
- migration은 pure transformation으로 실행되고 성공한 전체 결과를 검증한 뒤 한 번에
  commit한다. migration 도중 현재 파일을 수정하지 않는다.
- 같은 입력을 두 번 migration해도 의미와 canonical serialization이 같다.
- 지원 버전보다 높은 major version은 read-only `unsupportedVersion` 상태가 되며 backup이나
  empty state로 덮어쓰지 않는다.
- 각 migration은 before/after golden fixture, unknown-field sentinel과 rollback test를 가진다.

## P0-E — atomic, durable, concurrent save

필수 자동 테스트 식별자:

- [ ] `phase3_save_uses_same_directory_unique_temp`
- [ ] `phase3_save_flushes_before_atomic_replace`
- [x] `phase3_fault_at_every_write_boundary_keeps_one_valid_generation`
- [x] `phase3_revision_conflict_prevents_lost_update`
- [x] `phase3_second_instance_is_read_only_or_serialized`
- [ ] `phase3_acknowledged_save_survives_process_kill`

합격 기준:

- writer는 backend storage actor 하나만 소유한다. frontend가 임의 저장 경로나 revision을
  정할 수 없다.
- temp file은 target과 같은 directory에 `create_new`로 만들고 완전한 write와
  `FlushFileBuffers` 후 다시 parse/validate한다.
- 기존 target은 Windows atomic replace로 교체하고 바로 이전 verified generation을
  `.bak.1`로 남긴다. 첫 생성도 write-through rename을 사용한다.
- write, flush, backup rotation, replace 각 경계에 process kill 또는 injected I/O error가
  발생해도 main/backup 중 최소 하나가 완전히 유효하다. partial JSON을 empty state로
  해석하지 않는다.
- 모든 durable mutation은 monotonic revision과 `expectedRevision` CAS를 사용한다. stale
  frontend는 `revisionConflict`를 받고 최신 snapshot을 reload한다.
- process-level lock을 얻지 못한 두 번째 instance는 명시적인 read-only mode가 되거나
  동일 storage actor로 직렬화된다.
- save future는 해당 revision이 durable commit된 후에만 성공한다. clean shutdown은 pending
  save를 bounded deadline 내 flush한다.

## P0-F — corruption detection과 recovery

필수 자동 테스트 식별자:

- [x] `phase3_truncated_main_recovers_verified_backup`
- [ ] `phase3_checksum_or_semantic_corruption_is_detected`
- [x] `phase3_all_candidates_invalid_never_autosaves_empty_state`
- [x] `phase3_recovery_quarantines_exact_corrupt_bytes`
- [x] `phase3_valid_main_ignores_uncommitted_temp`
- [ ] `phase3_recovery_is_repeatable`

합격 기준:

- load는 syntax뿐 아니라 schema version, invariants, reference와 resource limits를 검증한다.
- main이 invalid하면 verified backup을 찾아 recovery preview를 제공한다. 복구본을 main에
  다시 쓰는 작업은 사용자 확인 또는 명시적 command 뒤에만 수행한다.
- main과 backup이 모두 invalid이면 `recoveryRequired`가 된다. UI는 empty-looking 화면을
  보여줄 수 있지만 create/save를 잠그고, 명시적 reset 전에 기존 파일을 보존한다.
- corrupt main의 exact bytes는 timestamp와 hash를 가진 quarantine 파일로 복사한다.
  path와 agent ID는 일반 log에 기록하지 않는다.
- valid main이 있으면 더 높은 revision의 leftover temp를 자동 승격하지 않는다. commit
  acknowledgement를 받지 못한 generation은 수동 recovery candidate일 뿐이다.
- backup retention은 최소 3개의 verified generation이며 rotation 실패가 main commit을
  손상시키지 않는다.

## P0-G — Windows path validation

필수 자동 테스트 식별자:

- [ ] `phase3_path_equivalence_handles_case_unc_and_extended_prefix`
- [ ] `phase3_component_containment_rejects_prefix_confusion`
- [ ] `phase3_reparse_point_escape_is_not_auto_activated`
- [ ] `phase3_missing_or_offline_path_is_preserved_but_not_started`
- [ ] `phase3_external_start_directory_requires_confirmation`

합격 기준:

- import 시 display spelling은 보존하되 activation 시 backend가 absolute Windows path,
  존재 여부와 directory type을 다시 검사한다.
- containment는 문자열 prefix가 아니라 normalized components와 가능한 경우 final file
  identity를 사용한다. `C:\work`와 `C:\worker`를 같은 tree로 보지 않는다.
- project root 밖으로 resolve되는 `StartDirectory`와 reparse escape는 자동 실행하지 않고
  사용자 확인이 필요한 blocked 상태로 둔다.
- missing drive, offline UNC와 이동된 folder를 현재 process directory로 조용히 바꾸거나
  그 fallback을 저장하지 않는다. 원래 path와 진단을 보존한다.
- device namespace, NUL, ADS를 포함한 비-directory path와 storage/import source alias를
  거부한다.

## P0-H — Tauri boundary와 privacy

필수 자동 테스트 식별자:

- [ ] `phase3_remote_webview_cannot_invoke_storage_commands`
- [ ] `phase3_storage_commands_never_accept_output_path`
- [ ] `phase3_errors_and_logs_redact_sensitive_values`
- [ ] `phase3_browser_restore_allows_only_safe_schemes`
- [ ] `phase3_state_payload_has_size_and_depth_limits`
- [ ] `phase3_import_never_reads_agent_session_contents`

합격 기준:

- storage commands는 capability가 있는 local `main` WebView만 호출할 수 있다. remote
  browser/output WebView에는 command, event, state snapshot capability가 없다.
- load/save command는 backend가 정한 preview path만 사용한다. import source는 local main
  UI에서 명시적으로 선택한 file token/path 하나이며 directory traversal로 output target을
  바꿀 수 없다.
- browser tab restore는 `https`, `http`, `about:blank`만 허용한다. `file`, `data`,
  `javascript`, custom scheme, URL userinfo와 임의 local output folder는 복원하지 않는다.
- project-output path는 project root와 bounded relative artifact path에서 backend가 다시
  계산한다. 저장된 virtual hostname이나 WebView label을 신뢰하지 않는다.
- absolute paths, project names, browser URL, Codex/Grok IDs와 raw unknown fields는 telemetry,
  crash report, stdout 및 일반 diagnostic log에 남지 않는다.
- state, snapshot, backup, quarantine은 같은 사용자 전용 ACL과 privacy 등급을 가진다.
  평문 로컬 저장임을 문서화하고 암호화된 저장이라고 주장하지 않는다.

## P0-I — Phase 2 회귀 방지

- [ ] Phase 2 Rust tests와 frontend tests가 모두 계속 통과
- [ ] project catalog load가 terminal을 자동 생성하지 않음
- [ ] Phase 3에서 Codex/Grok command 또는 resume가 실행되지 않음
- [ ] 20개를 넘는 saved terminal은 보존/report되지만 20개 이상 spawn되지 않음
- [ ] storage import/save 중 terminal input/output p95와 UI frame time 회귀 없음
- [ ] app shutdown이 storage flush와 terminal cleanup을 합쳐 5초 안에 종료

합격 기준: persistence가 ConPTY manager lock, output worker 또는 Tauri sync IPC thread에서
disk I/O를 수행하지 않는다. storage failure가 실행 중 terminal을 종료시키거나 terminal
failure가 마지막 verified state를 손상시키지 않는다.

## Windows 수동 gate

각 검수는 app version, executable SHA-256, Windows build, source-copy SHA-256과 preview
state path를 기록한다. 보고서에는 실제 project path나 agent ID를 복사하지 않는다.

### M1 — copied production import와 rollback

- [ ] C# 앱을 종료하고 production catalog를 사용자 지정 임시 directory에 복사
- [ ] copy를 Rust importer로 preview한 뒤 project/pane 수, 순서, 이름, ratio, alert 비교
- [ ] import 취소 시 committed preview state가 생성되지 않음
- [ ] import 성공 후 production catalog content hash, last-write time과 ACL 불변
- [ ] Rust preview 종료 후 C# baseline이 원래 catalog를 그대로 열 수 있음
- [ ] Rust preview에서 어떤 Codex/Grok session도 resume되지 않음

### M2 — crash와 recovery

- [ ] project 생성, rename, reorder, resize, alert ACK 각각의 save 중 100회 강제 종료
- [ ] 재실행마다 main 또는 backup으로 열리고 zero-byte/partial state가 없음
- [ ] main truncation, invalid UTF-8, valid JSON semantic corruption에서 recovery UI 확인
- [ ] 모든 candidate 손상 시 기존 파일을 보존하고 자동 empty overwrite가 없음
- [ ] recovery 선택 후 다음 재실행에서도 동일 상태

### M3 — path matrix

- [ ] ASCII, 한글, 공백, 장경로 project
- [ ] drive root, UNC share, offline share, 분리된 removable drive
- [ ] junction/symlink가 project 내부와 외부를 가리키는 경우
- [ ] 이동되거나 삭제된 project와 start directory
- [ ] 외부 start directory가 자동 실행되지 않고 확인을 요구함

### M4 — tabs와 privacy preview

- [ ] imported selected project에 deterministic project tab 하나만 생성
- [ ] no-project catalog는 empty tab 하나 생성
- [ ] browser/output tab state를 넣어도 Phase 3에서 자동 network navigation하지 않음
- [ ] remote browser DevTools에서 storage Tauri command 호출 불가
- [ ] logs, crash output, test artifacts에 absolute path와 agent ID가 없음
- [ ] backup/quarantine ACL이 현재 사용자, `SYSTEM`, `Administrators` 외 principal의
  쓰기를 허용하지 않음

### M5 — multi-instance와 성능

- [ ] 첫 instance가 저장 중일 때 두 번째 instance는 명확한 read-only 표시
- [ ] stale revision save가 첫 instance의 변경을 덮어쓰지 않음
- [ ] 256 projects/20 panes fixture load 시간과 memory가 정한 budget 이내
- [ ] 8 MiB limit 직전 catalog에서 UI가 응답하고 limit 초과는 빠르게 실패
- [ ] storage flush와 20-terminal cleanup을 포함한 창 종료가 5초 이내

## Phase 3 종료 판정

- [ ] P0-A부터 P0-I까지 모두 통과
- [ ] source와 preview store가 file identity 수준으로 분리됨
- [ ] legacy unknown fields와 exact source snapshot 보존 확인
- [ ] atomic replace, revision CAS, multi-instance와 corruption recovery 확인
- [ ] production catalog 및 agent session tree 변경 0건
- [ ] copied production catalog import와 C# rollback 수동 검수 완료
- [ ] Phase 2 자동/수동 필수 gate에 회귀 없음

하나라도 미완료면 Phase 4 UI 작업은 별도 branch에서 진행할 수 있지만 production catalog
쓰기, 기본 executable 전환 또는 C# rollback 제거는 허용하지 않는다.
