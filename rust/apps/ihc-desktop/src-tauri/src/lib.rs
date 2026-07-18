mod agent_runtime;
mod codex_notify;
mod grok_notify;
mod legacy_import;
mod phone_notify;
mod production_import;
mod project_store;
mod provider_accounts;
mod provider_usage;
mod pty;
mod terminal_platform;
mod workspace_store;

use agent_runtime::{
    AgentBindingSnapshot, AgentDiscovery, AgentDiscoveryRequest, AgentEvent, AgentProvider,
    AgentResumeBinding, AgentRuntime, StableTerminalKey,
};
use legacy_import::{
    CommitLegacyCatalogRequest, InspectLegacyCatalogRequest, LegacyImportError,
    LegacyImportErrorCode, LegacyImportMode, LegacyImportPolicy, LegacyImportService,
    LegacyInspection, LegacyTabKind, LegacyTerminalDraft, LegacyWorkspaceDraft,
    PHASE3_PREVIEW_SOURCE_FORMAT,
};
use production_import::{
    ProductionImportError, ProductionImportErrorCode, ProductionImportPolicy,
    ProductionImportService,
};
use project_store::{
    InspectProjectCatalogCopyRequest, LoadProjectCatalogResponse, PROJECT_CATALOG_SCHEMA_VERSION,
    Phase3PreviewUpgradeInspection, ProjectCatalogV1, ProjectStore,
};
use pty::{StartTerminalResponse, TerminalEngineStatus, TerminalEvent, TerminalManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, io,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, State, Webview, ipc::Channel};
use uuid::Uuid;
use workspace_store::{
    ImportProvenanceV1, RecoveryCandidateSummary, RecoveryPreview, SaveWorkspaceRequest,
    SaveWorkspaceResponse, StorageError, StorageErrorCode, StorageMode, StorageResult,
    WorkspaceProjectV1, WorkspaceSnapshot, WorkspaceStateV1, WorkspaceStore, WorkspaceTabV1,
    WorkspaceTerminalV1,
};

const MAIN_WEBVIEW_LABEL: &str = "main";
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ABSENT_WRITTEN_AT_UTC: &str = "1970-01-01T00:00:00Z";
const PHASE6_STATE_ROOT_ENV: &str = "IHATECODING_PHASE6_STATE_ROOT";
const PHASE6_SMOKE_PREFIX: &str = "ihatecoding-phase6-";
const PHASE6_SMOKE_MARKER: &str = ".ihatecoding-phase6-root";
const PRODUCTION_AGENT_BACKFILL_MARKER: &str = "productionAgentStateBackfillV1";
const PRODUCTION_AGENT_BACKFILL_V2_MARKER: &str = "productionAgentStateBackfillV2";

#[tauri::command]
fn read_provider_usage() -> provider_usage::ProviderUsageResponse {
    provider_usage::read_provider_usage()
}

#[tauri::command]
fn read_browser_webview_url(
    app: tauri::AppHandle,
    label: String,
) -> Result<Option<String>, String> {
    if !is_browser_pane_webview_label(&label) {
        return Err("웹 패널 식별자가 올바르지 않습니다.".to_owned());
    }
    let Some(webview) = app.get_webview(&label) else {
        return Ok(None);
    };
    let url = webview
        .url()
        .map_err(|_| "웹 패널의 현재 주소를 확인하지 못했습니다.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Ok(None);
    }
    Ok(Some(url.to_string()))
}

fn is_browser_pane_webview_label(label: &str) -> bool {
    if label.len() > 64 {
        return false;
    }
    let Some(suffix) = label.strip_prefix("ihc-browser-") else {
        return false;
    };
    let Some((sequence, generation)) = suffix.split_once('-') else {
        return false;
    };
    !sequence.is_empty()
        && !generation.is_empty()
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
        && generation.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod browser_webview_label_tests {
    use super::is_browser_pane_webview_label;

    #[test]
    fn browser_webview_labels_are_narrow_and_generated_only() {
        assert!(is_browser_pane_webview_label("ihc-browser-1-2"));
        assert!(is_browser_pane_webview_label("ihc-browser-20-999"));
        for invalid in [
            "main",
            "ihc-browser--2",
            "ihc-browser-1-",
            "ihc-browser-one-2",
            "ihc-browser-1-2-extra",
            "ihc-browser-1/2",
        ] {
            assert!(!is_browser_pane_webview_label(invalid), "{invalid}");
        }
    }
}

#[tauri::command]
fn read_provider_account(
    webview: Webview,
    provider: String,
) -> Result<Option<provider_usage::ProviderAccountSummary>, String> {
    ensure_agent_main_webview(&webview)?;
    provider_usage::read_provider_account(&provider)
}

#[tauri::command]
async fn list_provider_accounts(
    webview: Webview,
    service: State<'_, Arc<provider_accounts::ProviderAccountService>>,
    provider: String,
) -> Result<provider_accounts::ProviderAccountsResponse, String> {
    ensure_agent_main_webview(&webview)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list(&provider))
        .await
        .map_err(|_| "계정 목록 작업이 완료되지 않았습니다.".to_owned())?
}

#[tauri::command]
async fn add_provider_account(
    webview: Webview,
    service: State<'_, Arc<provider_accounts::ProviderAccountService>>,
    provider: String,
) -> Result<provider_accounts::ProviderAccountsResponse, String> {
    ensure_agent_main_webview(&webview)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.add(&provider))
        .await
        .map_err(|_| "계정 추가 작업이 완료되지 않았습니다.".to_owned())?
}

#[tauri::command]
async fn cancel_provider_account_login(
    webview: Webview,
    service: State<'_, Arc<provider_accounts::ProviderAccountService>>,
    provider: String,
) -> Result<bool, String> {
    ensure_agent_main_webview(&webview)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.cancel_login(&provider))
        .await
        .map_err(|_| "계정 추가 취소 작업이 완료되지 않았습니다.".to_owned())?
}

#[tauri::command]
async fn switch_provider_account(
    webview: Webview,
    service: State<'_, Arc<provider_accounts::ProviderAccountService>>,
    provider: String,
    account_id: String,
) -> Result<provider_accounts::ProviderAccountsResponse, String> {
    ensure_agent_main_webview(&webview)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.switch(&provider, &account_id))
        .await
        .map_err(|_| "계정 전환 작업이 완료되지 않았습니다.".to_owned())?
}

#[tauri::command]
fn restart_application(
    webview: Webview,
    app: tauri::AppHandle,
    service: State<'_, Arc<provider_accounts::ProviderAccountService>>,
) -> Result<(), String> {
    ensure_agent_main_webview(&webview)?;
    service.ensure_restart_ready()?;
    app.restart()
}

#[tauri::command]
fn play_completion_sound() {
    #[cfg(windows)]
    // SAFETY: MessageBeep takes a value-only message style and retains no Rust data.
    unsafe {
        let _ = windows_sys::Win32::System::Diagnostics::Debug::MessageBeep(
            windows_sys::Win32::UI::WindowsAndMessaging::MB_OK,
        );
    }
}

#[tauri::command]
fn load_phone_notification_settings(
    webview: Webview,
    service: State<'_, Arc<phone_notify::PhoneNotificationService>>,
) -> Result<phone_notify::PhoneNotificationSettings, String> {
    ensure_agent_main_webview(&webview)?;
    service.settings()
}

#[tauri::command]
fn save_phone_notification_settings(
    webview: Webview,
    service: State<'_, Arc<phone_notify::PhoneNotificationService>>,
    settings: phone_notify::SavePhoneNotificationSettingsRequest,
) -> Result<phone_notify::PhoneNotificationSettings, String> {
    ensure_agent_main_webview(&webview)?;
    service.save(settings)
}

#[tauri::command]
async fn send_phone_notification(
    webview: Webview,
    service: State<'_, Arc<phone_notify::PhoneNotificationService>>,
    request: phone_notify::SendPhoneNotificationRequest,
) -> Result<phone_notify::PhoneNotificationResult, String> {
    ensure_agent_main_webview(&webview)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.send(request))
        .await
        .map_err(|_| "Phone notification worker failed.".to_owned())?
}

#[tauri::command]
async fn read_clipboard_snapshot() -> Result<terminal_platform::ClipboardSnapshot, String> {
    tauri::async_runtime::spawn_blocking(terminal_platform::read_clipboard_snapshot)
        .await
        .map_err(|_| "Clipboard snapshot worker failed.".to_owned())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn write_clipboard_text(webview: Webview, text: String) -> Result<(), String> {
    ensure_agent_main_webview(&webview)?;
    #[cfg(windows)]
    let owner_window = webview
        .window()
        .hwnd()
        .map_err(|_| "The clipboard owner window is unavailable.".to_owned())?
        .0 as usize;
    #[cfg(not(windows))]
    let owner_window = 0;

    tauri::async_runtime::spawn_blocking(move || {
        terminal_platform::write_clipboard_text(owner_window, &text)
    })
    .await
    .map_err(|_| "Clipboard write worker failed.".to_owned())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn detect_terminal_agent(
    manager: State<'_, TerminalManager>,
    session_id: String,
) -> Result<Option<agent_runtime::AgentProvider>, String> {
    let root_process_id = manager.root_process_id(&session_id)?;
    Ok(root_process_id.and_then(terminal_platform::detect_terminal_agent))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscoverAgentConversationRequest {
    session_id: String,
    terminal_key: StableTerminalKey,
    cwd: String,
    not_before_unix_ms: u64,
    provider_hint: Option<AgentProvider>,
}

#[tauri::command]
async fn discover_agent_conversation(
    webview: Webview,
    manager: State<'_, TerminalManager>,
    runtime: State<'_, AgentRuntime>,
    request: DiscoverAgentConversationRequest,
) -> Result<Option<AgentDiscovery>, String> {
    ensure_agent_main_webview(&webview)?;
    let DiscoverAgentConversationRequest {
        session_id,
        terminal_key,
        cwd,
        not_before_unix_ms,
        provider_hint,
    } = request;
    if not_before_unix_ms > JS_MAX_SAFE_INTEGER {
        return Err("The agent discovery timestamp is invalid.".to_owned());
    }
    let root_process_id = manager.root_process_id(&session_id)?;
    let notified_completion = codex_notify::read_completion(&session_id)?;
    let codex_notifications = codex_notify::read_hook_events(&session_id)?;
    let grok_notifications = grok_notify::read_events(&session_id)?;
    let detected_provider = root_process_id.and_then(terminal_platform::detect_terminal_agent);
    let notified_provider = {
        let codex_time = notified_completion
            .as_ref()
            .map(|notification| notification.observed_at_unix_ms)
            .into_iter()
            .chain(
                codex_notifications
                    .iter()
                    .map(|notification| notification.observed_at_unix_ms),
            )
            .max();
        let grok_time = grok_notifications
            .iter()
            .map(|notification| notification.observed_at_unix_ms)
            .max();
        match (codex_time, grok_time) {
            (Some(codex), Some(grok)) if grok > codex => Some(AgentProvider::Grok),
            (Some(_), _) => Some(AgentProvider::Codex),
            (None, Some(_)) => Some(AgentProvider::Grok),
            (None, None) => None,
        }
    };
    let provider = detected_provider.or(notified_provider).or(provider_hint);
    let Some(provider) = provider else {
        return Ok(None);
    };
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.discover_conversation(AgentDiscoveryRequest {
            runtime_session_id: session_id,
            terminal_key,
            provider,
            working_directory: PathBuf::from(cwd),
            not_before_unix_ms,
            notified_completion,
            codex_notifications,
            grok_notifications,
        })
    })
    .await
    .map_err(|error| format!("The agent discovery worker failed: {error}"))?
}

#[tauri::command]
fn acknowledge_codex_completion(
    webview: Webview,
    session_id: String,
    conversation_id: String,
    turn_id: Option<String>,
    observed_at_unix_ms: u64,
) -> Result<bool, String> {
    ensure_agent_main_webview(&webview)?;
    if observed_at_unix_ms > JS_MAX_SAFE_INTEGER || uuid::Uuid::parse_str(&conversation_id).is_err()
    {
        return Err("The Codex completion acknowledgement is invalid.".to_owned());
    }
    let turn_id = turn_id
        .as_deref()
        .map(codex_notify::normalize_turn_id)
        .transpose()?;
    let legacy = codex_notify::acknowledge_completion(
        &session_id,
        &codex_notify::CodexCompletionRoute {
            conversation_id: conversation_id.clone(),
            turn_id: turn_id.clone(),
            observed_at_unix_ms,
        },
    )?;
    let hook = codex_notify::acknowledge_hook_completion(
        &session_id,
        &conversation_id,
        turn_id.as_deref(),
        observed_at_unix_ms,
    )?;
    Ok(legacy || hook)
}

#[tauri::command]
fn acknowledge_grok_completion(
    webview: Webview,
    runtime_session_id: String,
    conversation_id: String,
    observed_at_unix_ms: u64,
) -> Result<bool, String> {
    ensure_agent_main_webview(&webview)?;
    if observed_at_unix_ms > JS_MAX_SAFE_INTEGER
        || uuid::Uuid::parse_str(&runtime_session_id).is_err()
        || uuid::Uuid::parse_str(&conversation_id).is_err()
    {
        return Err("The Grok completion acknowledgement is invalid.".to_owned());
    }
    grok_notify::acknowledge_event(
        &runtime_session_id,
        &grok_notify::GrokHookEventRecord {
            session_id: conversation_id,
            event: grok_notify::GrokHookEvent::Stop,
            observed_at_unix_ms,
        },
    )
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Phase3bCommandError {
    Storage(StorageError),
}

impl From<StorageError> for Phase3bCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

impl From<LegacyImportError> for Phase3bCommandError {
    fn from(error: LegacyImportError) -> Self {
        let code = match error.code {
            LegacyImportErrorCode::Busy => StorageErrorCode::Busy,
            LegacyImportErrorCode::Io => StorageErrorCode::Io,
            LegacyImportErrorCode::InvalidSource => StorageErrorCode::InvalidSource,
            LegacyImportErrorCode::SourceChanged => StorageErrorCode::SourceChanged,
            LegacyImportErrorCode::TooLarge => StorageErrorCode::TooLarge,
            LegacyImportErrorCode::PathDenied => StorageErrorCode::PathDenied,
            LegacyImportErrorCode::RecoveryRequired => StorageErrorCode::RecoveryRequired,
        };
        Self::Storage(StorageError {
            code,
            message: error.message,
            retryable: error.retryable,
            json_pointer: error.json_pointer,
        })
    }
}

impl From<ProductionImportError> for Phase3bCommandError {
    fn from(error: ProductionImportError) -> Self {
        let code = match error.code {
            ProductionImportErrorCode::MissingSource | ProductionImportErrorCode::InvalidSource => {
                StorageErrorCode::InvalidSource
            }
            ProductionImportErrorCode::TooLarge => StorageErrorCode::TooLarge,
            ProductionImportErrorCode::SourceChanged => StorageErrorCode::SourceChanged,
            ProductionImportErrorCode::PathDenied => StorageErrorCode::PathDenied,
            ProductionImportErrorCode::CorruptStaging => StorageErrorCode::InvalidSource,
            ProductionImportErrorCode::Io => StorageErrorCode::Io,
        };
        Self::Storage(StorageError {
            code,
            message: error.message,
            retryable: error.retryable,
            json_pointer: None,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageStatusResponse {
    mode: StorageMode,
    schema_version: Option<u32>,
    revision: Option<u64>,
    has_legacy_import: bool,
    has_recovery_candidates: bool,
    writable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalWorkspaceState {
    schema_version: u32,
    revision: u64,
    written_at_utc: String,
    #[serde(flatten)]
    state: WorkspaceStateV1,
    import_provenance: Option<ImportProvenanceV1>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalWorkspaceSnapshot {
    revision: u64,
    state: CanonicalWorkspaceState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadWorkspaceStateResponse {
    revision: Option<u64>,
    state: Option<CanonicalWorkspaceState>,
    recovery: Option<RecoveryPreview>,
}

#[tauri::command]
async fn start_terminal(
    manager: State<'_, TerminalManager>,
    cwd: Option<String>,
    columns: u16,
    rows: u16,
    terminal_key: Option<StableTerminalKey>,
    resume: Option<AgentResumeBinding>,
    on_event: Channel<TerminalEvent>,
) -> Result<StartTerminalResponse, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.start(cwd, columns, rows, terminal_key, resume, on_event)
    })
    .await
    .map_err(|error| format!("Terminal start worker failed: {error}"))?
}

#[tauri::command]
fn subscribe_agent_events(
    webview: Webview,
    runtime: State<'_, AgentRuntime>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    ensure_agent_main_webview(&webview)?;
    runtime.subscribe(on_event)
}

#[tauri::command]
fn bind_agent_session(
    webview: Webview,
    manager: State<'_, TerminalManager>,
    runtime: State<'_, AgentRuntime>,
    session_id: String,
    terminal_key: StableTerminalKey,
    resume: AgentResumeBinding,
    replay_not_before_unix_ms: u64,
) -> Result<AgentBindingSnapshot, String> {
    ensure_agent_main_webview(&webview)?;
    if replay_not_before_unix_ms > JS_MAX_SAFE_INTEGER {
        return Err("The agent replay timestamp is invalid.".to_owned());
    }
    if !manager.has_active_session(&session_id) {
        return Err("The terminal session is not active.".to_owned());
    }
    runtime.bind_discovered(&session_id, terminal_key, resume, replay_not_before_unix_ms)
}

#[tauri::command]
fn unbind_agent_session(
    webview: Webview,
    runtime: State<'_, AgentRuntime>,
    session_id: String,
) -> Result<Option<AgentBindingSnapshot>, String> {
    ensure_agent_main_webview(&webview)?;
    Ok(runtime.unbind(&session_id))
}

#[tauri::command]
async fn write_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(&session_id, data.as_bytes()))
        .await
        .map_err(|error| format!("Terminal input worker failed: {error}"))?
}

#[tauri::command]
async fn write_terminal_bytes(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(&session_id, &data))
        .await
        .map_err(|error| format!("Terminal binary input worker failed: {error}"))?
}

#[tauri::command]
async fn shutdown_terminal_engine(manager: State<'_, TerminalManager>) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.shutdown_for_command())
        .await
        .map_err(|error| format!("Terminal shutdown worker failed: {error}"))?
}

#[tauri::command]
fn resize_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, columns, rows)
}

#[tauri::command]
fn ack_terminal_output(
    manager: State<'_, TerminalManager>,
    session_id: String,
    sequence: u64,
) -> Result<(), String> {
    manager.acknowledge_output(&session_id, sequence)
}

#[tauri::command]
fn terminal_engine_status(manager: State<'_, TerminalManager>) -> TerminalEngineStatus {
    manager.status()
}

#[tauri::command]
fn phase2_initial_panes() -> u8 {
    pty::phase2_initial_panes()
}

#[tauri::command]
fn stop_terminal(manager: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
    manager.stop(&session_id)
}

#[tauri::command]
async fn load_project_catalog(
    store: State<'_, ProjectStore>,
) -> Result<LoadProjectCatalogResponse, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.load())
        .await
        .map_err(|error| format!("Project catalog load worker failed: {error}"))?
}

#[tauri::command]
async fn save_project_catalog(
    store: State<'_, ProjectStore>,
    catalog: ProjectCatalogV1,
) -> Result<(), String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.save(catalog))
        .await
        .map_err(|error| format!("Project catalog save worker failed: {error}"))?
}

#[tauri::command]
async fn inspect_project_catalog_copy(
    store: State<'_, ProjectStore>,
    request: InspectProjectCatalogCopyRequest,
) -> Result<ProjectCatalogV1, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.inspect_copy(request))
        .await
        .map_err(|error| format!("Project catalog inspection worker failed: {error}"))?
}

#[tauri::command]
async fn recover_project_catalog_backup(
    store: State<'_, ProjectStore>,
) -> Result<ProjectCatalogV1, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.recover_verified_backup())
        .await
        .map_err(|error| format!("Project catalog recovery worker failed: {error}"))?
}

#[tauri::command]
async fn reset_corrupt_project_catalog(
    store: State<'_, ProjectStore>,
    confirmed: bool,
) -> Result<ProjectCatalogV1, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.reset_corrupt(confirmed))
        .await
        .map_err(|error| format!("Project catalog reset worker failed: {error}"))?
}

#[tauri::command]
fn project_catalog_schema_version() -> u32 {
    PROJECT_CATALOG_SCHEMA_VERSION
}

#[tauri::command]
async fn storage_status(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
) -> Result<StorageStatusResponse, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let store = store.inner().clone();
    phase3b_blocking(move || {
        let writable = store.is_writable();
        let load = store.load()?;
        let candidates = store.list_recovery_candidates()?;
        let snapshot = load.snapshot.as_ref();
        let revision = snapshot.map(|value| value.revision);
        if let Some(revision) = revision {
            ensure_js_safe_integer(revision, "/revision")?;
        }
        for candidate in &candidates {
            ensure_js_safe_integer(candidate.byte_length, "/recoveryCandidates/byteLength")?;
            if let Some(revision) = candidate.revision {
                ensure_js_safe_integer(revision, "/recoveryCandidates/revision")?;
            }
        }
        Ok(StorageStatusResponse {
            mode: load.mode,
            schema_version: if load.mode == StorageMode::Absent {
                None
            } else {
                snapshot.map(|value| value.schema_version)
            },
            revision,
            has_legacy_import: snapshot
                .and_then(|value| value.import_provenance.as_ref())
                .is_some(),
            has_recovery_candidates: !candidates.is_empty(),
            writable,
        })
    })
    .await
}

#[tauri::command]
async fn load_workspace_state(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
) -> Result<LoadWorkspaceStateResponse, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let store = store.inner().clone();
    phase3b_blocking(move || flatten_workspace_load(store.load()?)).await
}

#[tauri::command]
async fn save_workspace_state(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    expected_revision: u64,
    state: WorkspaceStateV1,
) -> Result<SaveWorkspaceResponse, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    ensure_js_safe_integer(expected_revision, "/expectedRevision")?;
    let store = store.inner().clone();
    phase3b_blocking(move || {
        let response = store.save(SaveWorkspaceRequest {
            expected_revision,
            state,
        })?;
        ensure_js_safe_integer(response.revision, "/revision")?;
        Ok(response)
    })
    .await
}

#[tauri::command]
async fn list_recovery_candidates(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
) -> Result<Vec<RecoveryCandidateSummary>, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let store = store.inner().clone();
    phase3b_blocking(move || {
        let candidates = store.list_recovery_candidates()?;
        for candidate in &candidates {
            ensure_js_safe_integer(candidate.byte_length, "/recoveryCandidates/byteLength")?;
            if let Some(revision) = candidate.revision {
                ensure_js_safe_integer(revision, "/recoveryCandidates/revision")?;
            }
        }
        Ok(candidates)
    })
    .await
}

#[tauri::command]
async fn recover_workspace_state(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    candidate_id: String,
) -> Result<CanonicalWorkspaceSnapshot, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let store = store.inner().clone();
    phase3b_blocking(move || flatten_snapshot(store.recover(&candidate_id)?)).await
}

fn normalized_backfill_directory(value: &str) -> Option<String> {
    let mut path = value.trim().replace('/', "\\");
    if path
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\?\UNC\"))
    {
        path = format!(r"\\{}", &path[8..]);
    } else if path
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\?\"))
    {
        path = path[4..].to_owned();
    }

    let collapse = |parts: Vec<&str>| {
        let mut normalized = Vec::new();
        for part in parts {
            if part.is_empty() || part == "." {
                continue;
            }
            if part == ".." {
                normalized.pop();
            } else {
                normalized.push(part.to_lowercase());
            }
        }
        normalized
    };

    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        let drive = path[..2].to_ascii_lowercase();
        let parts = collapse(path[3..].split('\\').collect());
        return Some(if parts.is_empty() {
            format!(r"{drive}\")
        } else {
            format!(r"{drive}\{}", parts.join(r"\"))
        });
    }

    if let Some(remainder) = path.strip_prefix(r"\\") {
        let mut root = remainder.split('\\').filter(|part| !part.is_empty());
        let server = root.next()?.to_lowercase();
        let share = root.next()?.to_lowercase();
        let parts = collapse(root.collect());
        return Some(if parts.is_empty() {
            format!(r"\\{server}\{share}")
        } else {
            format!(r"\\{server}\{share}\{}", parts.join(r"\"))
        });
    }

    None
}

fn merge_production_agent_state_v1(
    state: &mut WorkspaceStateV1,
    legacy: &LegacyWorkspaceDraft,
) -> bool {
    if state
        .legacy_extensions
        .get(PRODUCTION_AGENT_BACKFILL_MARKER)
        == Some(&Value::Bool(true))
    {
        return false;
    }

    let mut exact = HashMap::<(String, String), &LegacyTerminalDraft>::new();
    let mut legacy_by_directory = HashMap::<String, Vec<&LegacyTerminalDraft>>::new();
    for project in &legacy.projects {
        for terminal in &project.terminals {
            exact.insert((project.id.clone(), terminal.id.clone()), terminal);
            if let Some(directory) = normalized_backfill_directory(&terminal.start_directory) {
                legacy_by_directory
                    .entry(directory)
                    .or_default()
                    .push(terminal);
            }
        }
    }

    let mut canonical_directory_counts = HashMap::<String, usize>::new();
    let mut codex_owners = HashSet::<Uuid>::new();
    let mut grok_owners = HashSet::<Uuid>::new();
    for project in &state.projects {
        for terminal in &project.terminals {
            if let Some(directory) = normalized_backfill_directory(&terminal.start_directory) {
                *canonical_directory_counts.entry(directory).or_default() += 1;
            }
            if let Some(id) = terminal
                .codex_thread_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok())
            {
                codex_owners.insert(id);
            }
            if let Some(id) = terminal
                .grok_session_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok())
            {
                grok_owners.insert(id);
            }
        }
    }

    for project in &mut state.projects {
        for terminal in &mut project.terminals {
            let exact_match = exact
                .get(&(project.id.clone(), terminal.id.clone()))
                .copied();
            let legacy_terminal = exact_match.or_else(|| {
                let directory = normalized_backfill_directory(&terminal.start_directory)?;
                if canonical_directory_counts.get(&directory) != Some(&1) {
                    return None;
                }
                let candidates = legacy_by_directory.get(&directory)?;
                (candidates.len() == 1).then_some(candidates[0])
            });
            let Some(legacy_terminal) = legacy_terminal else {
                continue;
            };

            if !terminal.completion_pending && legacy_terminal.completion_pending {
                terminal.completion_pending = true;
            }

            // A pane with an existing provider remains authoritative. Adding the
            // other provider would create a dual binding and disable safe resume.
            if terminal.codex_thread_id.is_some()
                || terminal.grok_session_id.is_some()
                || legacy_terminal.resume_blocked
            {
                continue;
            }

            match (
                legacy_terminal.codex_thread_id.as_deref(),
                legacy_terminal.grok_session_id.as_deref(),
            ) {
                (Some(candidate), None) => {
                    if let Ok(id) = Uuid::parse_str(candidate)
                        && codex_owners.insert(id)
                    {
                        terminal.codex_thread_id = Some(id.to_string());
                    }
                }
                (None, Some(candidate)) => {
                    if let Ok(id) = Uuid::parse_str(candidate)
                        && grok_owners.insert(id)
                    {
                        terminal.grok_session_id = Some(id.to_string());
                    }
                }
                // Invalid or dual-provider legacy bindings are not safe to resume.
                _ => {}
            }
        }
    }

    state.legacy_extensions.insert(
        PRODUCTION_AGENT_BACKFILL_MARKER.to_owned(),
        Value::Bool(true),
    );
    true
}

fn normalized_backfill_name(value: &str) -> Option<String> {
    let normalized = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum BackfillProvider {
    Codex,
    Grok,
}

fn valid_legacy_provider_candidate(
    terminal: &LegacyTerminalDraft,
) -> Option<(BackfillProvider, Uuid)> {
    if terminal.resume_blocked {
        return None;
    }
    match (
        terminal.codex_thread_id.as_deref(),
        terminal.grok_session_id.as_deref(),
    ) {
        (Some(candidate), None) => Uuid::parse_str(candidate)
            .ok()
            .map(|id| (BackfillProvider::Codex, id)),
        (None, Some(candidate)) => Uuid::parse_str(candidate)
            .ok()
            .map(|id| (BackfillProvider::Grok, id)),
        _ => None,
    }
}

fn merge_production_agent_state_v2(
    state: &mut WorkspaceStateV1,
    legacy: &LegacyWorkspaceDraft,
) -> bool {
    if state
        .legacy_extensions
        .get(PRODUCTION_AGENT_BACKFILL_V2_MARKER)
        == Some(&Value::Bool(true))
    {
        return false;
    }

    let mut canonical_projects_by_folder = HashMap::<String, Vec<usize>>::new();
    for (index, project) in state.projects.iter().enumerate() {
        if let Some(folder) = normalized_backfill_directory(&project.folder_path) {
            canonical_projects_by_folder
                .entry(folder)
                .or_default()
                .push(index);
        }
    }
    let mut legacy_projects_by_folder = HashMap::<String, Vec<usize>>::new();
    for (index, project) in legacy.projects.iter().enumerate() {
        if let Some(folder) = normalized_backfill_directory(&project.folder_path) {
            legacy_projects_by_folder
                .entry(folder)
                .or_default()
                .push(index);
        }
    }

    let mut legacy_provider_counts = HashMap::<(BackfillProvider, Uuid), usize>::new();
    for project in &legacy.projects {
        for terminal in &project.terminals {
            if let Some(id) = terminal
                .codex_thread_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok())
            {
                *legacy_provider_counts
                    .entry((BackfillProvider::Codex, id))
                    .or_default() += 1;
            }
            if let Some(id) = terminal
                .grok_session_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok())
            {
                *legacy_provider_counts
                    .entry((BackfillProvider::Grok, id))
                    .or_default() += 1;
            }
        }
    }
    let mut codex_owners = state
        .projects
        .iter()
        .flat_map(|project| &project.terminals)
        .filter_map(|terminal| terminal.codex_thread_id.as_deref())
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect::<HashSet<_>>();
    let mut grok_owners = state
        .projects
        .iter()
        .flat_map(|project| &project.terminals)
        .filter_map(|terminal| terminal.grok_session_id.as_deref())
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect::<HashSet<_>>();

    for (folder, canonical_indices) in canonical_projects_by_folder {
        if canonical_indices.len() != 1 {
            continue;
        }
        let Some(legacy_indices) = legacy_projects_by_folder.get(&folder) else {
            continue;
        };
        if legacy_indices.len() != 1 {
            continue;
        }
        let canonical_project_index = canonical_indices[0];
        let legacy_project = &legacy.projects[legacy_indices[0]];
        let canonical_project = &mut state.projects[canonical_project_index];

        let mut matches = vec![None; canonical_project.terminals.len()];
        let mut used_legacy = HashSet::<usize>::new();

        let mut legacy_ids = HashMap::<&str, Vec<usize>>::new();
        for (index, terminal) in legacy_project.terminals.iter().enumerate() {
            legacy_ids
                .entry(terminal.id.as_str())
                .or_default()
                .push(index);
        }
        for (canonical_index, terminal) in canonical_project.terminals.iter().enumerate() {
            let Some(indices) = legacy_ids.get(terminal.id.as_str()) else {
                continue;
            };
            if indices.len() == 1 && used_legacy.insert(indices[0]) {
                matches[canonical_index] = Some(indices[0]);
            }
        }

        let mut canonical_names = HashMap::<String, Vec<usize>>::new();
        for (index, terminal) in canonical_project.terminals.iter().enumerate() {
            if let Some(name) = normalized_backfill_name(&terminal.name) {
                canonical_names.entry(name).or_default().push(index);
            }
        }
        let mut legacy_names = HashMap::<String, Vec<usize>>::new();
        for (index, terminal) in legacy_project.terminals.iter().enumerate() {
            if let Some(name) = normalized_backfill_name(&terminal.name) {
                legacy_names.entry(name).or_default().push(index);
            }
        }
        for (name, canonical_name_indices) in canonical_names {
            if canonical_name_indices.len() != 1 {
                continue;
            }
            let canonical_index = canonical_name_indices[0];
            if matches[canonical_index].is_some() {
                continue;
            }
            let Some(legacy_name_indices) = legacy_names.get(&name) else {
                continue;
            };
            if legacy_name_indices.len() == 1 && used_legacy.insert(legacy_name_indices[0]) {
                matches[canonical_index] = Some(legacy_name_indices[0]);
            }
        }

        let ordinal_layout_matches = canonical_project.terminals.len()
            == legacy_project.terminals.len()
            && canonical_project
                .terminals
                .iter()
                .zip(&legacy_project.terminals)
                .all(|(canonical, legacy)| {
                    normalized_backfill_directory(&canonical.start_directory)
                        .zip(normalized_backfill_directory(&legacy.start_directory))
                        .is_some_and(|(canonical, legacy)| canonical == legacy)
                });
        if ordinal_layout_matches {
            for (index, matched) in matches.iter_mut().enumerate() {
                if matched.is_none() && used_legacy.insert(index) {
                    *matched = Some(index);
                }
            }
        }

        for (canonical_index, legacy_index) in matches.into_iter().enumerate() {
            let Some(legacy_index) = legacy_index else {
                continue;
            };
            let canonical_terminal = &mut canonical_project.terminals[canonical_index];
            if canonical_terminal.codex_thread_id.is_some()
                || canonical_terminal.grok_session_id.is_some()
                || canonical_terminal.legacy_extensions.get("resumeBlocked")
                    == Some(&Value::Bool(true))
            {
                continue;
            }
            let Some(candidate) =
                valid_legacy_provider_candidate(&legacy_project.terminals[legacy_index])
            else {
                continue;
            };
            if legacy_provider_counts.get(&candidate) != Some(&1) {
                continue;
            }
            match candidate {
                (BackfillProvider::Codex, id) if codex_owners.insert(id) => {
                    canonical_terminal.codex_thread_id = Some(id.hyphenated().to_string());
                }
                (BackfillProvider::Grok, id) if grok_owners.insert(id) => {
                    canonical_terminal.grok_session_id = Some(id.hyphenated().to_string());
                }
                _ => {}
            }
        }
    }

    state.legacy_extensions.insert(
        PRODUCTION_AGENT_BACKFILL_V2_MARKER.to_owned(),
        Value::Bool(true),
    );
    true
}

fn merge_production_agent_state(
    state: &mut WorkspaceStateV1,
    legacy: &LegacyWorkspaceDraft,
) -> bool {
    let v1_changed = merge_production_agent_state_v1(state, legacy);
    let v2_changed = merge_production_agent_state_v2(state, legacy);
    v1_changed || v2_changed
}

fn save_production_agent_backfill(
    store: &WorkspaceStore,
    snapshot: &WorkspaceSnapshot,
    legacy: &LegacyWorkspaceDraft,
) -> StorageResult<Option<WorkspaceSnapshot>> {
    let mut state = snapshot.state.clone();
    if !merge_production_agent_state(&mut state, legacy) {
        return Ok(None);
    }
    store.save(SaveWorkspaceRequest {
        expected_revision: snapshot.revision,
        state,
    })?;
    store
        .load()?
        .snapshot
        .map(Some)
        .ok_or_else(|| StorageError {
            code: StorageErrorCode::Io,
            message: "The production agent backfill was saved but could not be reloaded."
                .to_owned(),
            retryable: true,
            json_pointer: None,
        })
}

#[tauri::command]
async fn import_discovered_production_catalog(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    production_importer: State<'_, Arc<ProductionImportService>>,
    importer: State<'_, Arc<LegacyImportService>>,
) -> Result<Option<CanonicalWorkspaceSnapshot>, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let store = store.inner().clone();
    let production_importer = Arc::clone(production_importer.inner());
    let importer = Arc::clone(importer.inner());
    phase3b_blocking(move || {
        let current = store.load()?;
        let existing_snapshot = match current.mode {
            StorageMode::Absent => None,
            StorageMode::Ready => {
                let Some(snapshot) = current.snapshot else {
                    return Err(StorageError {
                        code: StorageErrorCode::Io,
                        message: "The ready workspace snapshot is unavailable.".to_owned(),
                        retryable: true,
                        json_pointer: None,
                    }
                    .into());
                };
                if snapshot
                    .state
                    .legacy_extensions
                    .get(PRODUCTION_AGENT_BACKFILL_V2_MARKER)
                    == Some(&Value::Bool(true))
                {
                    return Ok(None);
                }
                Some(snapshot)
            }
            StorageMode::ReadOnly
            | StorageMode::RecoveryRequired
            | StorageMode::UnsupportedVersion => return Ok(None),
        };
        if !store.is_writable() {
            return Err(StorageError {
                code: StorageErrorCode::ReadOnly,
                message: "Another application instance owns the workspace writer lock.".to_owned(),
                retryable: true,
                json_pointer: None,
            }
            .into());
        }

        let descriptor = match production_importer.stage_discovered_catalog() {
            Ok(descriptor) => descriptor,
            Err(error) if error.code == ProductionImportErrorCode::MissingSource => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        let inspection = importer.inspect_detached_copy(InspectLegacyCatalogRequest {
            source_path: descriptor.path.clone(),
            source_is_detached_copy: true,
        })?;
        if inspection.source_sha256 != descriptor.sha256
            || inspection.byte_length != descriptor.byte_length
        {
            return Err(StorageError {
                code: StorageErrorCode::SourceChanged,
                message: "The staged production catalog changed before inspection.".to_owned(),
                retryable: true,
                json_pointer: None,
            }
            .into());
        }

        let prepared = importer.commit_detached_copy(CommitLegacyCatalogRequest {
            inspect_token: inspection.inspect_token,
            source_path: descriptor.path,
            source_sha256: descriptor.sha256,
            mode: LegacyImportMode::ReplacePreview,
        })?;
        if let Some(snapshot) = existing_snapshot {
            return save_production_agent_backfill(&store, &snapshot, &prepared.draft)?
                .map(flatten_snapshot)
                .transpose();
        }

        let provenance = ImportProvenanceV1::from_import(
            prepared.source_format,
            prepared.source_sha256,
            prepared.snapshot_file,
        )?;
        let mut state = workspace_state_from_legacy(prepared.draft);
        state.legacy_extensions.insert(
            PRODUCTION_AGENT_BACKFILL_MARKER.to_owned(),
            Value::Bool(true),
        );
        state.legacy_extensions.insert(
            PRODUCTION_AGENT_BACKFILL_V2_MARKER.to_owned(),
            Value::Bool(true),
        );
        Ok(Some(flatten_snapshot(
            store.replace_from_import(state, provenance)?,
        )?))
    })
    .await
}

#[tauri::command]
async fn inspect_legacy_catalog(
    webview: Webview,
    importer: State<'_, Arc<LegacyImportService>>,
    source_path: String,
) -> Result<LegacyInspection, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let importer = Arc::clone(importer.inner());
    phase3b_blocking(move || {
        let inspection = importer.inspect_detached_copy(InspectLegacyCatalogRequest {
            source_path,
            source_is_detached_copy: true,
        })?;
        ensure_js_safe_integer(inspection.byte_length, "/byteLength")?;
        Ok(inspection)
    })
    .await
}

#[tauri::command]
async fn import_legacy_catalog(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    importer: State<'_, Arc<LegacyImportService>>,
    inspect_token: String,
    source_path: String,
    source_sha256: String,
    mode: LegacyImportMode,
) -> Result<CanonicalWorkspaceSnapshot, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let store = store.inner().clone();
    let importer = Arc::clone(importer.inner());
    phase3b_blocking(move || {
        if !store.is_writable() {
            return Err(StorageError {
                code: StorageErrorCode::ReadOnly,
                message: "Another application instance owns the workspace writer lock.".to_owned(),
                retryable: true,
                json_pointer: None,
            }
            .into());
        }

        let prepared = importer.commit_detached_copy(CommitLegacyCatalogRequest {
            inspect_token,
            source_path,
            source_sha256,
            mode,
        })?;
        ensure_js_safe_integer(prepared.byte_length, "/byteLength")?;
        let provenance = ImportProvenanceV1::from_import(
            prepared.source_format,
            prepared.source_sha256,
            prepared.snapshot_file,
        )?;
        let state = workspace_state_from_legacy(prepared.draft);
        flatten_snapshot(store.replace_from_import(state, provenance)?)
    })
    .await
}

#[tauri::command]
async fn inspect_phase3_preview_upgrade(
    webview: Webview,
    project_store: State<'_, ProjectStore>,
) -> Result<Phase3PreviewUpgradeInspection, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let project_store = project_store.inner().clone();
    phase3b_blocking(move || inspect_phase3_preview_upgrade_blocking(&project_store)).await
}

#[tauri::command]
async fn commit_phase3_preview_upgrade(
    webview: Webview,
    project_store: State<'_, ProjectStore>,
    store: State<'_, WorkspaceStore>,
    source_sha256: String,
) -> Result<CanonicalWorkspaceSnapshot, Phase3bCommandError> {
    ensure_main_webview(&webview)?;
    drop(webview);
    let project_store = project_store.inner().clone();
    let store = store.inner().clone();
    phase3b_blocking(move || {
        commit_phase3_preview_upgrade_blocking(&project_store, &store, &source_sha256)
    })
    .await
}

fn inspect_phase3_preview_upgrade_blocking(
    project_store: &ProjectStore,
) -> Result<Phase3PreviewUpgradeInspection, Phase3bCommandError> {
    project_store
        .inspect_phase3_preview_upgrade()
        .map_err(Into::into)
}

fn commit_phase3_preview_upgrade_blocking(
    project_store: &ProjectStore,
    store: &WorkspaceStore,
    source_sha256: &str,
) -> Result<CanonicalWorkspaceSnapshot, Phase3bCommandError> {
    let guard = project_store.begin_phase3_preview_upgrade()?;
    let source = guard.read_expected_source(source_sha256)?;
    guard.verify_unchanged(&source)?;
    let provenance = ImportProvenanceV1::from_import(
        PHASE3_PREVIEW_SOURCE_FORMAT.to_owned(),
        source.source_sha256().to_owned(),
        format!("{}.projects.json", source.source_sha256()),
    )?;
    let state = workspace_state_from_legacy(source.draft.clone());
    let snapshot = store.initialize_from_phase3_preview(state, provenance, source.bytes())?;
    // The ProjectStore operation lock and retained Windows read handle prevent
    // in-process writes and write/delete sharing for the whole commit. This
    // final exact-byte/metadata/ACL check also fails closed on other platforms.
    guard.verify_unchanged(&source)?;
    flatten_snapshot(snapshot)
}

fn ensure_main_webview(webview: &Webview) -> Result<(), Phase3bCommandError> {
    if webview.label() == MAIN_WEBVIEW_LABEL {
        return Ok(());
    }
    Err(StorageError {
        code: StorageErrorCode::PathDenied,
        message: "This storage command is available only to the local main view.".to_owned(),
        retryable: false,
        json_pointer: None,
    }
    .into())
}

fn ensure_agent_main_webview(webview: &Webview) -> Result<(), String> {
    if webview.label() == MAIN_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err("This agent command is available only to the local main view.".to_owned())
    }
}

async fn phase3b_blocking<F, T>(task: F) -> Result<T, Phase3bCommandError>
where
    F: FnOnce() -> Result<T, Phase3bCommandError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| {
            Phase3bCommandError::Storage(StorageError {
                code: StorageErrorCode::Io,
                message: "The storage worker did not complete.".to_owned(),
                retryable: true,
                json_pointer: None,
            })
        })?
}

fn flatten_workspace_load(
    load: workspace_store::WorkspaceLoad,
) -> Result<LoadWorkspaceStateResponse, Phase3bCommandError> {
    if load.mode == StorageMode::UnsupportedVersion {
        return Err(StorageError {
            code: StorageErrorCode::UnsupportedVersion,
            message: "The workspace schema version is newer than this application supports."
                .to_owned(),
            retryable: false,
            json_pointer: Some("/schemaVersion".to_owned()),
        }
        .into());
    }

    let snapshot = load.snapshot.map(flatten_snapshot).transpose()?;
    Ok(LoadWorkspaceStateResponse {
        revision: snapshot.as_ref().map(|value| value.revision),
        state: snapshot.map(|value| value.state),
        recovery: load.recovery,
    })
}

fn flatten_snapshot(
    snapshot: WorkspaceSnapshot,
) -> Result<CanonicalWorkspaceSnapshot, Phase3bCommandError> {
    ensure_js_safe_integer(snapshot.revision, "/revision")?;
    let revision = snapshot.revision;
    Ok(CanonicalWorkspaceSnapshot {
        revision,
        state: CanonicalWorkspaceState {
            schema_version: snapshot.schema_version,
            revision,
            written_at_utc: snapshot
                .written_at_utc
                .unwrap_or_else(|| ABSENT_WRITTEN_AT_UTC.to_owned()),
            state: snapshot.state,
            import_provenance: snapshot.import_provenance,
        },
    })
}

fn ensure_js_safe_integer(value: u64, pointer: &str) -> StorageResult<()> {
    if value <= JS_MAX_SAFE_INTEGER {
        return Ok(());
    }
    Err(StorageError {
        code: StorageErrorCode::InvalidState,
        message: "A numeric storage value exceeds the JavaScript safe integer range.".to_owned(),
        retryable: false,
        json_pointer: Some(pointer.to_owned()),
    })
}

fn workspace_state_from_legacy(draft: LegacyWorkspaceDraft) -> WorkspaceStateV1 {
    let projects = draft
        .projects
        .into_iter()
        .map(|project| WorkspaceProjectV1 {
            id: project.id,
            name: project.name,
            folder_path: project.folder_path,
            terminals: project
                .terminals
                .into_iter()
                .map(|terminal| {
                    let mut legacy_extensions: BTreeMap<String, Value> =
                        terminal.legacy_extensions.into_iter().collect();
                    if terminal.resume_blocked {
                        legacy_extensions.insert("resumeBlocked".to_owned(), Value::Bool(true));
                    }
                    WorkspaceTerminalV1 {
                        id: terminal.id,
                        name: terminal.name,
                        start_directory: terminal.start_directory,
                        codex_thread_id: terminal.codex_thread_id,
                        grok_session_id: terminal.grok_session_id,
                        created_at_utc: terminal.created_at_utc,
                        completion_pending: terminal.completion_pending,
                        legacy_extensions,
                    }
                })
                .collect(),
            pane_width_ratios: project.pane_width_ratios,
            legacy_extensions: project.legacy_extensions.into_iter().collect(),
        })
        .collect();
    let tabs = draft
        .tabs
        .into_iter()
        .map(|tab| WorkspaceTabV1 {
            id: tab.id,
            kind: match tab.kind {
                LegacyTabKind::Empty => "empty",
                LegacyTabKind::Project => "project",
            }
            .to_owned(),
            title: tab.title,
            project_id: tab.project_id,
            browser: None,
            output: None,
            extensions: BTreeMap::new(),
        })
        .collect();
    WorkspaceStateV1 {
        selected_project_id: draft.selected_project_id,
        projects,
        tabs,
        active_tab_id: draft.active_tab_id,
        extensions: BTreeMap::new(),
        legacy_extensions: draft.legacy_extensions.into_iter().collect(),
    }
}

fn legacy_import_policy(preview_root: PathBuf) -> Result<LegacyImportPolicy, LegacyImportError> {
    let mut production_roots = Vec::new();
    let mut production_catalogs = Vec::new();
    let mut agent_session_roots = Vec::new();
    let mut additional_protected_files = Vec::new();

    if let Some(local_app_data) = absolute_env_path("LOCALAPPDATA") {
        let root = local_app_data.join("PowerWorkspace");
        production_catalogs.push(root.join("projects.json"));
        production_roots.push(root);
        additional_protected_files.push(
            local_app_data
                .join("IHATECODING")
                .join("RustPreview")
                .join("Projects")
                .join("projects-v1.json"),
        );
        agent_session_roots.push(local_app_data.join("Grok"));
        agent_session_roots.push(local_app_data.join("xAI").join("Grok"));
    }
    if let Some(roaming_app_data) = absolute_env_path("APPDATA") {
        agent_session_roots.push(roaming_app_data.join("Grok"));
        agent_session_roots.push(roaming_app_data.join("xAI").join("Grok"));
    }
    if let Some(user_profile) = absolute_env_path("USERPROFILE") {
        agent_session_roots.push(user_profile.join(".codex").join("sessions"));
        agent_session_roots.push(user_profile.join(".grok"));
        agent_session_roots.push(user_profile.join(".xai"));
        agent_session_roots.push(user_profile.join(".config").join("grok"));
    }
    if let Some(configured_catalog) = configured_production_catalog() {
        if let Some(parent) = configured_catalog.parent() {
            production_roots.push(parent.to_path_buf());
        }
        production_catalogs.push(configured_catalog);
    }

    LegacyImportPolicy::new(preview_root)?
        .with_production_roots(production_roots)?
        .with_production_catalogs(production_catalogs)?
        .with_agent_session_roots(agent_session_roots)?
        .with_additional_protected_files(additional_protected_files)
}

fn absolute_env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn configured_production_catalog() -> Option<PathBuf> {
    let configured = env::var_os("POWERWORKSPACE_PROJECTS_PATH").map(PathBuf::from)?;
    if configured.is_absolute() {
        return Some(configured);
    }
    env::current_dir()
        .ok()
        .map(|current| current.join(configured))
}

fn workspace_app_local_data_dir(default_dir: PathBuf) -> io::Result<PathBuf> {
    let Some(configured) = env::var_os(PHASE6_STATE_ROOT_ENV) else {
        return Ok(default_dir);
    };

    validate_phase6_state_root(&PathBuf::from(configured), &env::temp_dir())
}

fn validate_phase6_state_root(configured: &Path, temp_dir: &Path) -> io::Result<PathBuf> {
    fn denied(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::PermissionDenied, message)
    }

    if !configured.is_absolute() {
        return Err(denied("The Phase 6 state root must be an absolute path."));
    }

    let resolved_temp = std::fs::canonicalize(temp_dir)
        .map_err(|_| denied("The system temporary directory could not be verified."))?;
    let resolved = std::fs::canonicalize(configured)
        .map_err(|_| denied("The Phase 6 state root must already exist."))?;
    let relative = resolved.strip_prefix(&resolved_temp).map_err(|_| {
        denied("The Phase 6 state root must stay inside the system temporary directory.")
    })?;

    let mut components = relative.components();
    let smoke_component = components
        .next()
        .and_then(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .ok_or_else(|| denied("The Phase 6 state root is missing its owned smoke directory."))?;
    if components.next().is_none() {
        return Err(denied(
            "The Phase 6 state root cannot be the smoke directory itself.",
        ));
    }

    let Some(token) = smoke_component.strip_prefix(PHASE6_SMOKE_PREFIX) else {
        return Err(denied("The Phase 6 smoke directory name is invalid."));
    };
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(denied("The Phase 6 smoke directory token is invalid."));
    }

    let smoke_root = resolved_temp.join(smoke_component);
    let marker = smoke_root.join(PHASE6_SMOKE_MARKER);
    let marker_metadata = std::fs::symlink_metadata(&marker)
        .map_err(|_| denied("The Phase 6 ownership marker is missing."))?;
    if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
        return Err(denied(
            "The Phase 6 ownership marker is not a regular file.",
        ));
    }
    let marker_token = std::fs::read_to_string(marker)
        .map_err(|_| denied("The Phase 6 ownership marker could not be read."))?;
    if marker_token != token {
        return Err(denied(
            "The Phase 6 ownership marker does not match its directory.",
        ));
    }

    Ok(resolved)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let default_app_local_data_dir = dirs::data_local_dir()
        .expect("the local application data directory is unavailable")
        .join(&context.config().identifier);
    let app_local_data_dir = workspace_app_local_data_dir(default_app_local_data_dir)
        .expect("the IHATECODING application data path is invalid");
    let provider_account_service = Arc::new(
        provider_accounts::ProviderAccountService::open(&app_local_data_dir)
            .expect("the provider account registry is unavailable"),
    );
    // SAFETY: this runs before Tauri, AgentRuntime, PTY, or notifier worker threads exist.
    unsafe {
        provider_account_service
            .apply_active_homes_to_environment()
            .expect("the active provider account home is invalid");
    }
    if env::var_os(PHASE6_STATE_ROOT_ENV).is_none() {
        let _ = codex_notify::ensure_configured();
        let _ = grok_notify::ensure_configured();
    }
    let agent_runtime = AgentRuntime::default();
    let terminal_manager = TerminalManager::with_agent_runtime(agent_runtime.clone());
    let shutdown_manager = terminal_manager.clone();
    let shutdown_agent_runtime = agent_runtime.clone();
    let project_store = ProjectStore::preview_default()
        .expect("the isolated IHATECODING migration store path is invalid");
    let setup_app_local_data_dir = app_local_data_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal_manager)
        .manage(agent_runtime)
        .manage(project_store)
        .manage(provider_account_service)
        .setup(move |app| {
            let app_local_data_dir = setup_app_local_data_dir.clone();
            let workspace_store = WorkspaceStore::open(&app_local_data_dir)?;
            let phone_notification_service =
                phone_notify::PhoneNotificationService::open(&app_local_data_dir)?;
            let import_policy = legacy_import_policy(workspace_store.state_root().to_path_buf())?;
            debug_assert_eq!(import_policy.preview_root(), workspace_store.state_root());
            let legacy_import_service = LegacyImportService::new(import_policy)?;
            let production_import_policy = ProductionImportPolicy::new(
                app_local_data_dir.join("production-import-staging"),
                vec![workspace_store.state_root().to_path_buf()],
            )?;
            let production_import_service = ProductionImportService::new(production_import_policy)?;
            app.manage(workspace_store);
            app.manage(Arc::new(phone_notification_service));
            app.manage(Arc::new(legacy_import_service));
            app.manage(Arc::new(production_import_service));

            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == MAIN_WEBVIEW_LABEL)
                .ok_or_else(|| io::Error::other("The main window configuration is missing."))?;
            let titlebar_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            let mut main_window =
                tauri::WebviewWindowBuilder::from_config(app.handle(), main_config)?
                    .icon(titlebar_icon)?;
            if env::var_os(PHASE6_STATE_ROOT_ENV).is_some() {
                let webview_data_dir = app_local_data_dir.join("webview-data");
                std::fs::create_dir_all(&webview_data_dir)?;
                main_window = main_window.data_directory(webview_data_dir);
            }
            main_window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_provider_usage,
            read_browser_webview_url,
            read_provider_account,
            list_provider_accounts,
            add_provider_account,
            cancel_provider_account_login,
            switch_provider_account,
            restart_application,
            play_completion_sound,
            load_phone_notification_settings,
            save_phone_notification_settings,
            send_phone_notification,
            read_clipboard_snapshot,
            write_clipboard_text,
            detect_terminal_agent,
            discover_agent_conversation,
            acknowledge_codex_completion,
            acknowledge_grok_completion,
            start_terminal,
            subscribe_agent_events,
            bind_agent_session,
            unbind_agent_session,
            write_terminal,
            write_terminal_bytes,
            shutdown_terminal_engine,
            resize_terminal,
            ack_terminal_output,
            terminal_engine_status,
            phase2_initial_panes,
            stop_terminal,
            load_project_catalog,
            save_project_catalog,
            inspect_project_catalog_copy,
            recover_project_catalog_backup,
            reset_corrupt_project_catalog,
            project_catalog_schema_version,
            storage_status,
            load_workspace_state,
            save_workspace_state,
            list_recovery_candidates,
            recover_workspace_state,
            import_discovered_production_catalog,
            inspect_legacy_catalog,
            import_legacy_catalog,
            inspect_phase3_preview_upgrade,
            commit_phase3_preview_upgrade
        ])
        .build(context)
        .expect("error while building IHATECODING")
        .run(move |_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = shutdown_manager.shutdown_for_exit();
                shutdown_agent_runtime.shutdown();
            }
        });
}

pub fn run_codex_notifier_if_requested() -> Option<i32> {
    codex_notify::run_if_requested()
}

pub fn run_grok_notifier_if_requested() -> Option<i32> {
    grok_notify::run_if_requested()
}

#[cfg(test)]
mod phase6_state_root_tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn owned_root(temp: &Path) -> PathBuf {
        let smoke = temp.join(format!("{PHASE6_SMOKE_PREFIX}{TOKEN}"));
        let state = smoke.join("rust-20").join("state-root");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(smoke.join(PHASE6_SMOKE_MARKER), TOKEN).unwrap();
        state
    }

    #[test]
    fn phase6_state_root_accepts_only_a_marked_temp_descendant() {
        let temp = tempfile::tempdir().unwrap();
        let configured = owned_root(temp.path());
        let resolved = validate_phase6_state_root(&configured, temp.path()).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(configured).unwrap());
    }

    #[test]
    fn phase6_state_root_rejects_an_unowned_or_changed_marker() {
        let temp = tempfile::tempdir().unwrap();
        let configured = owned_root(temp.path());
        std::fs::write(
            temp.path()
                .join(format!("{PHASE6_SMOKE_PREFIX}{TOKEN}"))
                .join(PHASE6_SMOKE_MARKER),
            "different-token",
        )
        .unwrap();
        assert_eq!(
            validate_phase6_state_root(&configured, temp.path())
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        let outside = temp.path().join("ordinary").join("state-root");
        std::fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            validate_phase6_state_root(&outside, temp.path())
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}

#[cfg(test)]
mod phase3b_bridge_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{fs, path::Path};
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "ihc-phase3b-bridge-test-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.0.join(relative)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn phase3_preview_fixture() -> Vec<u8> {
        let mut root: Value =
            serde_json::from_slice(include_bytes!("../../../../fixtures/projects-v1.json"))
                .unwrap();
        root["SchemaVersion"] = Value::from(1);
        root["UnknownTopLevel"] = serde_json::json!({ "keep": [1, 2, 3] });
        root["Projects"][0]["UnknownProject"] = Value::String("preserved".to_owned());
        root["Projects"][0]["Terminals"][0]["UnknownTerminal"] = Value::Bool(true);

        let mut second = root["Projects"][0].clone();
        second["Id"] = Value::String("44444444444444444444444444444444".to_owned());
        second["Name"] = Value::String("Second Project".to_owned());
        second["FolderPath"] = Value::String(r"C:\Example\Beta".to_owned());
        second["Terminals"][0]["Id"] = Value::String("55555555555555555555555555555555".to_owned());
        second["Terminals"][0]["Name"] = Value::String("SECOND".to_owned());
        second["Terminals"][0]["StartDirectory"] = Value::String(r"C:\Example\Beta".to_owned());
        second["Terminals"][0]["CodexThreadId"] = Value::Null;
        second["Terminals"][0]["GrokSessionId"] =
            Value::String("66666666-6666-6666-6666-666666666666".to_owned());
        second["Terminals"][0]["CompletionPending"] = Value::Bool(false);
        root["Projects"].as_array_mut().unwrap().push(second);
        root["SelectedProjectId"] = Value::String("44444444444444444444444444444444".to_owned());
        serde_json::to_vec_pretty(&root).unwrap()
    }

    struct Phase3UpgradeLayout {
        _directory: TestDirectory,
        source: PathBuf,
        project_store: ProjectStore,
        workspace_store: WorkspaceStore,
    }

    impl Phase3UpgradeLayout {
        fn new(with_source: bool) -> Self {
            let directory = TestDirectory::new();
            let phase3_root = directory.path("phase3-preview");
            fs::create_dir_all(&phase3_root).unwrap();
            let source = phase3_root.join("projects-v1.json");
            if with_source {
                fs::write(&source, phase3_preview_fixture()).unwrap();
            }
            let project_store = ProjectStore::new_for_phase3_upgrade_test(phase3_root);
            let workspace_store = WorkspaceStore::open(&directory.path("app-local")).unwrap();
            Self {
                _directory: directory,
                source,
                project_store,
                workspace_store,
            }
        }

        fn inspect(&self) -> Phase3PreviewUpgradeInspection {
            inspect_phase3_preview_upgrade_blocking(&self.project_store).unwrap()
        }

        fn commit(&self, source_sha256: &str) -> CanonicalWorkspaceSnapshot {
            commit_phase3_preview_upgrade_blocking(
                &self.project_store,
                &self.workspace_store,
                source_sha256,
            )
            .unwrap()
        }
    }

    fn command_error_code(error: Phase3bCommandError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn backfill_terminal(id: &str, directory: &str) -> WorkspaceTerminalV1 {
        WorkspaceTerminalV1 {
            id: id.to_owned(),
            name: format!("current-{id}"),
            start_directory: directory.to_owned(),
            codex_thread_id: None,
            grok_session_id: None,
            created_at_utc: Some("2026-07-18T00:00:00Z".to_owned()),
            completion_pending: false,
            legacy_extensions: BTreeMap::new(),
        }
    }

    fn backfill_workspace(terminals: Vec<WorkspaceTerminalV1>) -> WorkspaceStateV1 {
        WorkspaceStateV1 {
            selected_project_id: Some("current-project".to_owned()),
            projects: vec![WorkspaceProjectV1 {
                id: "current-project".to_owned(),
                name: "Current layout".to_owned(),
                folder_path: r"C:\Current".to_owned(),
                terminals,
                pane_width_ratios: BTreeMap::from([("grid-2x1-row-0".to_owned(), vec![0.4, 0.6])]),
                legacy_extensions: BTreeMap::new(),
            }],
            tabs: vec![WorkspaceTabV1 {
                id: "current-tab".to_owned(),
                kind: "project".to_owned(),
                title: "Current tab".to_owned(),
                project_id: Some("current-project".to_owned()),
                browser: None,
                output: None,
                extensions: BTreeMap::new(),
            }],
            active_tab_id: Some("current-tab".to_owned()),
            extensions: BTreeMap::new(),
            legacy_extensions: BTreeMap::new(),
        }
    }

    fn legacy_backfill_terminal(
        id: &str,
        directory: &str,
        codex: Option<&str>,
        grok: Option<&str>,
        completion_pending: bool,
        resume_blocked: bool,
    ) -> LegacyTerminalDraft {
        LegacyTerminalDraft {
            id: id.to_owned(),
            name: format!("legacy-{id}"),
            start_directory: directory.to_owned(),
            codex_thread_id: codex.map(str::to_owned),
            grok_session_id: grok.map(str::to_owned),
            created_at_utc: Some("2025-01-01T00:00:00Z".to_owned()),
            completion_pending,
            resume_blocked,
            legacy_extensions: serde_json::Map::new(),
        }
    }

    fn legacy_backfill_workspace(
        projects: Vec<(&str, Vec<LegacyTerminalDraft>)>,
    ) -> LegacyWorkspaceDraft {
        LegacyWorkspaceDraft {
            selected_project_id: None,
            projects: projects
                .into_iter()
                .map(|(id, terminals)| legacy_import::LegacyProjectDraft {
                    id: id.to_owned(),
                    name: format!("legacy-{id}"),
                    folder_path: r"C:\Legacy".to_owned(),
                    terminals,
                    pane_width_ratios: BTreeMap::new(),
                    legacy_extensions: serde_json::Map::new(),
                })
                .collect(),
            tabs: Vec::new(),
            active_tab_id: None,
            legacy_extensions: serde_json::Map::new(),
        }
    }

    fn mark_v1_backfill_complete(state: &mut WorkspaceStateV1) {
        state.legacy_extensions.insert(
            PRODUCTION_AGENT_BACKFILL_MARKER.to_owned(),
            Value::Bool(true),
        );
    }

    #[test]
    fn production_agent_v2_migrates_v1_and_restores_eight_same_directory_panes() {
        const IDS: [&str; 8] = [
            "10000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000002",
            "10000000-0000-4000-8000-000000000003",
            "10000000-0000-4000-8000-000000000004",
            "10000000-0000-4000-8000-000000000005",
            "10000000-0000-4000-8000-000000000006",
            "10000000-0000-4000-8000-000000000007",
            "10000000-0000-4000-8000-000000000008",
        ];
        const CURRENT_NAMES: [&str; 8] = [
            "MAIN",
            "Backend DATA",
            "BACKEND SECURITY",
            "BACKEND DB",
            "ADMIN DASHBOARD",
            "API",
            "TEST",
            "INTEGRATION",
        ];
        const LEGACY_NAMES: [&str; 8] = [
            "MAIN",
            "BACKEND",
            "SECURITY",
            "DATABASE",
            "ADMIN FRONT",
            "QA",
            "TEST",
            "INTEGRATION",
        ];

        let mut canonical_terminals = (0..8)
            .map(|index| backfill_terminal(&format!("current-{index}"), r"C:\SampleProject"))
            .collect::<Vec<_>>();
        for (terminal, name) in canonical_terminals.iter_mut().zip(CURRENT_NAMES) {
            terminal.name = name.to_owned();
        }
        let mut state = backfill_workspace(canonical_terminals);
        state.projects[0].folder_path = r"C:\SampleProject".to_owned();
        mark_v1_backfill_complete(&mut state);

        let mut legacy_terminals = IDS
            .iter()
            .enumerate()
            .map(|(index, id)| {
                legacy_backfill_terminal(
                    &format!("legacy-{index}"),
                    r"c:\sampleproject\.",
                    Some(id),
                    None,
                    false,
                    false,
                )
            })
            .collect::<Vec<_>>();
        for (terminal, name) in legacy_terminals.iter_mut().zip(LEGACY_NAMES) {
            terminal.name = name.to_owned();
        }
        let mut legacy = legacy_backfill_workspace(vec![("legacy-project", legacy_terminals)]);
        legacy.projects[0].folder_path = r"c:/sampleproject/./".to_owned();

        assert!(merge_production_agent_state(&mut state, &legacy));
        assert_eq!(
            state.projects[0]
                .terminals
                .iter()
                .map(|terminal| terminal.codex_thread_id.as_deref().unwrap())
                .collect::<Vec<_>>(),
            IDS
        );
        assert_eq!(
            state
                .legacy_extensions
                .get(PRODUCTION_AGENT_BACKFILL_V2_MARKER),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            state
                .legacy_extensions
                .get(PRODUCTION_AGENT_BACKFILL_MARKER),
            Some(&Value::Bool(true))
        );
        assert!(!merge_production_agent_state(&mut state, &legacy));
    }

    #[test]
    fn production_agent_v2_uses_unique_names_before_ordinal_positions() {
        const ALPHA: &str = "20000000-0000-4000-8000-000000000001";
        const BETA: &str = "20000000-0000-4000-8000-000000000002";
        let mut first = backfill_terminal("current-a", r"C:\Names");
        first.name = " Alpha  Pane ".to_owned();
        let mut second = backfill_terminal("current-b", r"C:\Names");
        second.name = "Beta Pane".to_owned();
        let mut state = backfill_workspace(vec![first, second]);
        state.projects[0].folder_path = r"C:\Names".to_owned();
        mark_v1_backfill_complete(&mut state);

        let mut legacy_beta =
            legacy_backfill_terminal("legacy-b", r"c:\names\.", Some(BETA), None, false, false);
        legacy_beta.name = " beta   pane ".to_owned();
        let mut legacy_alpha =
            legacy_backfill_terminal("legacy-a", r"C:\Names", Some(ALPHA), None, false, false);
        legacy_alpha.name = "ALPHA PANE".to_owned();
        let mut legacy =
            legacy_backfill_workspace(vec![("legacy", vec![legacy_beta, legacy_alpha])]);
        legacy.projects[0].folder_path = r"c:\names\".to_owned();

        assert!(merge_production_agent_state(&mut state, &legacy));
        assert_eq!(
            state.projects[0].terminals[0].codex_thread_id.as_deref(),
            Some(ALPHA)
        );
        assert_eq!(
            state.projects[0].terminals[1].codex_thread_id.as_deref(),
            Some(BETA)
        );
    }

    #[test]
    fn production_agent_v2_refuses_ambiguous_projects_and_mismatched_ordinals() {
        const FIRST: &str = "30000000-0000-4000-8000-000000000001";
        const SECOND: &str = "30000000-0000-4000-8000-000000000002";
        let mut ambiguous = backfill_workspace(vec![backfill_terminal("new", r"C:\Same")]);
        ambiguous.projects[0].folder_path = r"C:\Same".to_owned();
        mark_v1_backfill_complete(&mut ambiguous);
        let mut ambiguous_legacy = legacy_backfill_workspace(vec![
            (
                "old-a",
                vec![legacy_backfill_terminal(
                    "old-a",
                    r"C:\Same",
                    Some(FIRST),
                    None,
                    false,
                    false,
                )],
            ),
            (
                "old-b",
                vec![legacy_backfill_terminal(
                    "old-b",
                    r"C:\Same",
                    Some(SECOND),
                    None,
                    false,
                    false,
                )],
            ),
        ]);
        for project in &mut ambiguous_legacy.projects {
            project.folder_path = r"C:\Same".to_owned();
        }
        assert!(merge_production_agent_state(
            &mut ambiguous,
            &ambiguous_legacy
        ));
        assert!(ambiguous.projects[0].terminals[0].codex_thread_id.is_none());

        let mut mismatched = backfill_workspace(vec![
            backfill_terminal("new-a", r"C:\One"),
            backfill_terminal("new-b", r"C:\Two"),
        ]);
        mismatched.projects[0].folder_path = r"C:\Layout".to_owned();
        mark_v1_backfill_complete(&mut mismatched);
        let mut mismatched_legacy = legacy_backfill_workspace(vec![(
            "old-layout",
            vec![
                legacy_backfill_terminal("old-a", r"C:\One", Some(FIRST), None, false, false),
                legacy_backfill_terminal(
                    "old-b",
                    r"C:\Different",
                    Some(SECOND),
                    None,
                    false,
                    false,
                ),
            ],
        )]);
        mismatched_legacy.projects[0].folder_path = r"c:\layout\".to_owned();
        assert!(merge_production_agent_state(
            &mut mismatched,
            &mismatched_legacy
        ));
        assert!(
            mismatched.projects[0]
                .terminals
                .iter()
                .all(|terminal| terminal.codex_thread_id.is_none())
        );
    }

    #[test]
    fn production_agent_v2_rejects_duplicate_invalid_blocked_and_bound_candidates() {
        const DUPLICATE: &str = "40000000-0000-4000-8000-000000000001";
        const CURRENT_CODEX: &str = "40000000-0000-4000-8000-000000000002";
        const CURRENT_GROK: &str = "40000000-0000-4000-8000-000000000003";
        const CANDIDATE_GROK: &str = "40000000-0000-4000-8000-000000000004";
        const BLOCKED: &str = "40000000-0000-4000-8000-000000000005";
        const LEGACY_BLOCKED: &str = "40000000-0000-4000-8000-000000000006";

        let mut terminals = (0..6)
            .map(|index| backfill_terminal(&format!("pane-{index}"), r"C:\Protected"))
            .collect::<Vec<_>>();
        terminals[1].codex_thread_id = Some(CURRENT_CODEX.to_owned());
        terminals[2].codex_thread_id = Some(CURRENT_CODEX.to_owned());
        terminals[2].grok_session_id = Some(CURRENT_GROK.to_owned());
        terminals[3]
            .legacy_extensions
            .insert("resumeBlocked".to_owned(), Value::Bool(true));
        let mut state = backfill_workspace(terminals);
        state.projects[0].folder_path = r"C:\Protected".to_owned();
        mark_v1_backfill_complete(&mut state);

        let legacy_terminals = vec![
            legacy_backfill_terminal(
                "pane-0",
                r"C:\Protected",
                Some(DUPLICATE),
                None,
                false,
                false,
            ),
            legacy_backfill_terminal(
                "pane-1",
                r"C:\Protected",
                None,
                Some(CANDIDATE_GROK),
                false,
                false,
            ),
            legacy_backfill_terminal(
                "pane-2",
                r"C:\Protected",
                Some("40000000-0000-4000-8000-000000000007"),
                None,
                false,
                false,
            ),
            legacy_backfill_terminal("pane-3", r"C:\Protected", Some(BLOCKED), None, false, false),
            legacy_backfill_terminal(
                "pane-4",
                r"C:\Protected",
                Some(LEGACY_BLOCKED),
                None,
                false,
                true,
            ),
            legacy_backfill_terminal(
                "pane-5",
                r"C:\Protected",
                Some("not-a-uuid"),
                None,
                false,
                false,
            ),
        ];
        let mut legacy = legacy_backfill_workspace(vec![
            ("protected", legacy_terminals),
            (
                "duplicate-owner",
                vec![legacy_backfill_terminal(
                    "other",
                    r"C:\Elsewhere",
                    Some(DUPLICATE),
                    None,
                    false,
                    false,
                )],
            ),
        ]);
        legacy.projects[0].folder_path = r"c:\protected\".to_owned();
        legacy.projects[1].folder_path = r"C:\Elsewhere".to_owned();

        assert!(merge_production_agent_state(&mut state, &legacy));
        let terminals = &state.projects[0].terminals;
        assert!(terminals[0].codex_thread_id.is_none());
        assert_eq!(terminals[1].codex_thread_id.as_deref(), Some(CURRENT_CODEX));
        assert!(terminals[1].grok_session_id.is_none());
        assert_eq!(terminals[2].codex_thread_id.as_deref(), Some(CURRENT_CODEX));
        assert_eq!(terminals[2].grok_session_id.as_deref(), Some(CURRENT_GROK));
        assert!(terminals[3].codex_thread_id.is_none());
        assert!(terminals[4].codex_thread_id.is_none());
        assert!(terminals[5].codex_thread_id.is_none());
    }

    #[test]
    fn production_agent_backfill_uses_exact_ids_then_only_unique_normalized_directories() {
        const CODEX: &str = "11111111-1111-4111-8111-111111111111";
        const GROK: &str = "22222222-2222-4222-8222-222222222222";
        const CURRENT: &str = "33333333-3333-4333-8333-333333333333";

        let mut conflict = backfill_terminal("conflict", r"C:\Conflict");
        conflict.codex_thread_id = Some(CURRENT.to_owned());
        let mut state = backfill_workspace(vec![
            backfill_terminal("exact", r"C:\Current\Moved"),
            backfill_terminal("fallback", r"C:/Unique/Folder/./"),
            backfill_terminal("ambiguous-a", r"C:\Shared"),
            backfill_terminal("ambiguous-b", r"c:\shared\"),
            conflict,
            backfill_terminal("duplicate-owner", r"C:\DuplicateOwner"),
            backfill_terminal("blocked", r"C:\Blocked"),
        ]);
        let original_name = state.projects[0].name.clone();
        let original_ratios = state.projects[0].pane_width_ratios.clone();
        let legacy = legacy_backfill_workspace(vec![
            (
                "current-project",
                vec![
                    legacy_backfill_terminal(
                        "exact",
                        r"D:\OldLocation",
                        Some(CODEX),
                        None,
                        true,
                        false,
                    ),
                    legacy_backfill_terminal(
                        "conflict",
                        r"C:\Conflict",
                        None,
                        Some(GROK),
                        true,
                        false,
                    ),
                ],
            ),
            (
                "legacy-only",
                vec![
                    legacy_backfill_terminal(
                        "old-fallback",
                        r"c:\unique\folder",
                        None,
                        Some(GROK),
                        true,
                        false,
                    ),
                    legacy_backfill_terminal(
                        "shared-one",
                        r"C:\Shared",
                        Some(CODEX),
                        None,
                        false,
                        false,
                    ),
                    legacy_backfill_terminal(
                        "shared-two",
                        r"C:\Shared\.",
                        None,
                        Some(GROK),
                        false,
                        false,
                    ),
                    legacy_backfill_terminal(
                        "duplicate-owner-old",
                        r"C:\DuplicateOwner",
                        Some(CODEX),
                        None,
                        false,
                        false,
                    ),
                    legacy_backfill_terminal(
                        "blocked-old",
                        r"C:\Blocked",
                        Some("44444444-4444-4444-8444-444444444444"),
                        None,
                        false,
                        true,
                    ),
                ],
            ),
        ]);

        assert!(merge_production_agent_state(&mut state, &legacy));
        let terminals = &state.projects[0].terminals;
        assert_eq!(terminals[0].codex_thread_id.as_deref(), Some(CODEX));
        assert!(terminals[0].completion_pending);
        assert_eq!(terminals[0].start_directory, r"C:\Current\Moved");
        assert_eq!(terminals[1].grok_session_id.as_deref(), Some(GROK));
        assert!(terminals[1].completion_pending);
        assert!(terminals[2].codex_thread_id.is_none());
        assert!(terminals[2].grok_session_id.is_none());
        assert!(terminals[3].codex_thread_id.is_none());
        assert!(terminals[3].grok_session_id.is_none());
        assert_eq!(terminals[4].codex_thread_id.as_deref(), Some(CURRENT));
        assert!(terminals[4].grok_session_id.is_none());
        assert!(terminals[4].completion_pending);
        assert!(terminals[5].codex_thread_id.is_none());
        assert!(terminals[6].codex_thread_id.is_none());
        assert_eq!(state.projects[0].name, original_name);
        assert_eq!(state.projects[0].pane_width_ratios, original_ratios);
        assert_eq!(
            state
                .legacy_extensions
                .get(PRODUCTION_AGENT_BACKFILL_MARKER),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn production_agent_backfill_marker_prevents_pending_or_ids_from_returning() {
        const CODEX: &str = "55555555-5555-4555-8555-555555555555";
        let mut state = backfill_workspace(vec![backfill_terminal("pane", r"C:\Once")]);
        let legacy = legacy_backfill_workspace(vec![(
            "legacy",
            vec![legacy_backfill_terminal(
                "old-pane",
                r"C:\Once",
                Some(CODEX),
                None,
                true,
                false,
            )],
        )]);
        assert!(merge_production_agent_state(&mut state, &legacy));
        state.projects[0].terminals[0].completion_pending = false;
        state.projects[0].terminals[0].codex_thread_id = None;

        assert!(!merge_production_agent_state(&mut state, &legacy));
        assert!(!state.projects[0].terminals[0].completion_pending);
        assert!(state.projects[0].terminals[0].codex_thread_id.is_none());
    }

    #[test]
    fn production_agent_backfill_is_durable_and_does_not_reapply_after_acknowledgement() {
        const CODEX: &str = "66666666-6666-4666-8666-666666666666";
        let directory = TestDirectory::new();
        let store = WorkspaceStore::open(&directory.path("app-local")).unwrap();
        let initial = backfill_workspace(vec![backfill_terminal("new-pane", r"C:\Durable")]);
        store
            .save(SaveWorkspaceRequest {
                expected_revision: 0,
                state: initial,
            })
            .unwrap();
        let snapshot = store.load().unwrap().snapshot.unwrap();
        let legacy = legacy_backfill_workspace(vec![(
            "old-project",
            vec![legacy_backfill_terminal(
                "old-pane",
                r"c:/durable/.",
                Some(CODEX),
                None,
                true,
                false,
            )],
        )]);

        let merged = save_production_agent_backfill(&store, &snapshot, &legacy)
            .unwrap()
            .unwrap();
        assert_eq!(merged.revision, 2);
        assert_eq!(
            merged.state.projects[0].terminals[0]
                .codex_thread_id
                .as_deref(),
            Some(CODEX)
        );
        assert!(merged.state.projects[0].terminals[0].completion_pending);

        let mut acknowledged = merged.state.clone();
        acknowledged.projects[0].terminals[0].completion_pending = false;
        // Simulate an older frontend omitting the internal marker; storage must
        // preserve it from the current canonical document.
        acknowledged
            .legacy_extensions
            .remove(PRODUCTION_AGENT_BACKFILL_MARKER);
        store
            .save(SaveWorkspaceRequest {
                expected_revision: merged.revision,
                state: acknowledged,
            })
            .unwrap();
        let acknowledged = store.load().unwrap().snapshot.unwrap();
        assert!(
            acknowledged
                .state
                .legacy_extensions
                .contains_key(PRODUCTION_AGENT_BACKFILL_MARKER)
        );
        assert!(
            save_production_agent_backfill(&store, &acknowledged, &legacy)
                .unwrap()
                .is_none()
        );
        let final_snapshot = store.load().unwrap().snapshot.unwrap();
        assert_eq!(final_snapshot.revision, 3);
        assert!(!final_snapshot.state.projects[0].terminals[0].completion_pending);
    }

    #[test]
    fn phase3b_absent_snapshot_flattens_to_the_frontend_contract() {
        let directory = TestDirectory::new();
        let store = WorkspaceStore::open(&directory.path("app-local")).unwrap();
        let response = flatten_workspace_load(store.load().unwrap()).unwrap();
        assert_eq!(response.revision, Some(0));
        let state = response.state.unwrap();
        assert_eq!(state.schema_version, 1);
        assert_eq!(state.revision, 0);
        assert_eq!(state.written_at_utc, ABSENT_WRITTEN_AT_UTC);
        assert!(response.recovery.is_none());
    }

    #[test]
    fn phase3b_two_phase_import_commits_only_the_canonical_preview() {
        const FIXTURE: &[u8] = include_bytes!("../../../../fixtures/projects-v1.json");
        let directory = TestDirectory::new();
        let source = directory.path("detached/projects-copy.json");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, FIXTURE).unwrap();

        let snapshot = {
            let store = WorkspaceStore::open(&directory.path("app-local")).unwrap();
            let policy = LegacyImportPolicy::new(store.state_root().to_path_buf()).unwrap();
            let importer = LegacyImportService::new(policy).unwrap();
            let inspection = importer
                .inspect_detached_copy(InspectLegacyCatalogRequest {
                    source_path: source.to_string_lossy().into_owned(),
                    source_is_detached_copy: true,
                })
                .unwrap();
            let prepared = importer
                .commit_detached_copy(CommitLegacyCatalogRequest {
                    inspect_token: inspection.inspect_token,
                    source_path: source.to_string_lossy().into_owned(),
                    source_sha256: inspection.source_sha256,
                    mode: LegacyImportMode::ReplacePreview,
                })
                .unwrap();
            let provenance = ImportProvenanceV1::from_import(
                prepared.source_format,
                prepared.source_sha256,
                prepared.snapshot_file,
            )
            .unwrap();
            store
                .replace_from_import(workspace_state_from_legacy(prepared.draft), provenance)
                .unwrap()
        };

        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.state.projects.len(), 1);
        assert_eq!(snapshot.state.projects[0].terminals.len(), 1);
        assert_eq!(fs::read(&source).unwrap(), FIXTURE);
        assert!(Path::new(&snapshot.import_provenance.unwrap().snapshot_file).is_relative());
    }

    #[test]
    fn phase4a_upgrade_inspect_reports_absent_without_reading_a_backup() {
        let layout = Phase3UpgradeLayout::new(false);
        let inspection = layout.inspect();
        assert!(!inspection.available);
        assert_eq!(inspection.project_count, 0);
        assert_eq!(inspection.terminal_count, 0);
        assert_eq!(inspection.source_sha256, None);

        let error = commit_phase3_preview_upgrade_blocking(
            &layout.project_store,
            &layout.workspace_store,
            &"0".repeat(64),
        )
        .unwrap_err();
        assert_eq!(command_error_code(error), "invalidSource");
        assert_eq!(
            layout.workspace_store.load().unwrap().mode,
            StorageMode::Absent
        );
    }

    #[test]
    fn phase4a_upgrade_commits_exact_snapshot_and_preserves_source_and_semantics() {
        let layout = Phase3UpgradeLayout::new(true);
        let source_bytes = fs::read(&layout.source).unwrap();
        let source_fingerprint =
            legacy_import::phase3_preview_source_fingerprint(&layout.source).unwrap();
        let source_modified = fs::metadata(&layout.source).unwrap().modified().ok();
        let inspection = layout.inspect();
        assert!(inspection.available);
        assert_eq!(inspection.project_count, 2);
        assert_eq!(inspection.terminal_count, 2);
        let digest = inspection.source_sha256.unwrap();
        assert_eq!(digest, format!("{:x}", Sha256::digest(&source_bytes)));

        let snapshot = layout.commit(&digest);
        assert_eq!(snapshot.revision, 1);
        let state = &snapshot.state.state;
        assert_eq!(state.projects.len(), 2);
        assert_eq!(state.projects[0].name, "Example Project");
        assert_eq!(state.projects[1].name, "Second Project");
        assert_eq!(state.projects[0].terminals[0].name, "MAIN");
        assert!(state.projects[0].terminals[0].completion_pending);
        assert_eq!(
            state.projects[0].terminals[0].codex_thread_id.as_deref(),
            Some("33333333-3333-3333-3333-333333333333")
        );
        assert_eq!(
            state.projects[1].terminals[0].grok_session_id.as_deref(),
            Some("66666666-6666-6666-6666-666666666666")
        );
        assert_eq!(
            state.selected_project_id.as_deref(),
            Some("44444444444444444444444444444444")
        );
        assert_eq!(state.tabs.len(), 1);
        assert_eq!(state.tabs[0].project_id, state.selected_project_id);
        assert_eq!(state.active_tab_id, Some(state.tabs[0].id.clone()));
        assert_eq!(state.legacy_extensions["UnknownTopLevel"]["keep"][2], 3);
        assert_eq!(
            state.projects[0].legacy_extensions["UnknownProject"],
            "preserved"
        );
        assert_eq!(
            state.projects[0].terminals[0].legacy_extensions["UnknownTerminal"],
            true
        );
        let provenance = snapshot.state.import_provenance.as_ref().unwrap();
        assert_eq!(provenance.source_format, PHASE3_PREVIEW_SOURCE_FORMAT);
        assert_eq!(provenance.source_sha256, digest);
        assert_eq!(
            fs::read(
                layout
                    .workspace_store
                    .state_root()
                    .join("imports")
                    .join(&provenance.snapshot_file)
            )
            .unwrap(),
            source_bytes
        );
        assert_eq!(fs::read(&layout.source).unwrap(), source_bytes);
        assert_eq!(
            fs::metadata(&layout.source).unwrap().modified().ok(),
            source_modified
        );
        assert_eq!(
            legacy_import::phase3_preview_source_fingerprint(&layout.source).unwrap(),
            source_fingerprint
        );
    }

    #[test]
    fn phase4a_upgrade_detects_sha_mismatch_and_source_change_before_commit() {
        let layout = Phase3UpgradeLayout::new(true);
        let inspected = layout.inspect().source_sha256.unwrap();
        let mismatch = commit_phase3_preview_upgrade_blocking(
            &layout.project_store,
            &layout.workspace_store,
            &"0".repeat(64),
        )
        .unwrap_err();
        assert_eq!(command_error_code(mismatch), "sourceChanged");

        let mut changed: Value = serde_json::from_slice(&phase3_preview_fixture()).unwrap();
        changed["Projects"][0]["Name"] = Value::String("Changed".to_owned());
        fs::write(&layout.source, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
        let changed_error = commit_phase3_preview_upgrade_blocking(
            &layout.project_store,
            &layout.workspace_store,
            &inspected,
        )
        .unwrap_err();
        assert_eq!(command_error_code(changed_error), "sourceChanged");
        assert_eq!(
            layout.workspace_store.load().unwrap().mode,
            StorageMode::Absent
        );
        assert!(!layout.workspace_store.state_root().join("imports").exists());
    }

    #[test]
    fn phase4a_upgrade_refuses_an_existing_canonical_workspace_without_writing() {
        let layout = Phase3UpgradeLayout::new(true);
        layout
            .workspace_store
            .save(SaveWorkspaceRequest {
                expected_revision: 0,
                state: WorkspaceStateV1::empty(),
            })
            .unwrap();
        let primary = layout
            .workspace_store
            .state_root()
            .join("workspace-v1.json");
        let before = fs::read(&primary).unwrap();
        let digest = layout.inspect().source_sha256.unwrap();
        let error = commit_phase3_preview_upgrade_blocking(
            &layout.project_store,
            &layout.workspace_store,
            &digest,
        )
        .unwrap_err();
        assert_eq!(command_error_code(error), "revisionConflict");
        assert_eq!(fs::read(primary).unwrap(), before);
        assert!(!layout.workspace_store.state_root().join("imports").exists());
    }

    #[test]
    fn phase4a_upgrade_fails_closed_for_backup_only_and_invalid_primary_state() {
        let layout = Phase3UpgradeLayout::new(false);
        fs::write(
            layout.source.with_file_name("projects-v1.json.bak1"),
            phase3_preview_fixture(),
        )
        .unwrap();
        let backup_only =
            inspect_phase3_preview_upgrade_blocking(&layout.project_store).unwrap_err();
        assert_eq!(command_error_code(backup_only), "recoveryRequired");

        fs::write(&layout.source, b"invalid-primary").unwrap();
        let invalid = inspect_phase3_preview_upgrade_blocking(&layout.project_store).unwrap_err();
        assert_eq!(command_error_code(invalid), "invalidSource");
        assert_eq!(
            layout.workspace_store.load().unwrap().mode,
            StorageMode::Absent
        );
    }

    #[test]
    fn phase4a_upgrade_retry_of_the_same_digest_is_idempotent() {
        let layout = Phase3UpgradeLayout::new(true);
        let digest = layout.inspect().source_sha256.unwrap();
        let first = layout.commit(&digest);
        let primary = layout
            .workspace_store
            .state_root()
            .join("workspace-v1.json");
        let before = fs::read(&primary).unwrap();
        let second = layout.commit(&digest);
        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 1);
        assert_eq!(fs::read(primary).unwrap(), before);
        assert_eq!(second.state.state.projects.len(), 2);
    }
}
