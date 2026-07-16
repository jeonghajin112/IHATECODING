mod legacy_import;
mod project_store;
mod pty;
mod workspace_store;

use legacy_import::{
    CommitLegacyCatalogRequest, InspectLegacyCatalogRequest, LegacyImportError,
    LegacyImportErrorCode, LegacyImportMode, LegacyImportPolicy, LegacyImportService,
    LegacyInspection, LegacyTabKind, LegacyWorkspaceDraft,
};
use project_store::{
    InspectProjectCatalogCopyRequest, LoadProjectCatalogResponse, PROJECT_CATALOG_SCHEMA_VERSION,
    ProjectCatalogV1, ProjectStore,
};
use pty::{StartTerminalResponse, TerminalEngineStatus, TerminalEvent, TerminalManager};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, env, path::PathBuf, sync::Arc};
use tauri::{Manager, State, Webview, ipc::Channel};
use workspace_store::{
    ImportProvenanceV1, RecoveryCandidateSummary, RecoveryPreview, SaveWorkspaceRequest,
    SaveWorkspaceResponse, StorageError, StorageErrorCode, StorageMode, StorageResult,
    WorkspaceProjectV1, WorkspaceSnapshot, WorkspaceStateV1, WorkspaceStore, WorkspaceTabV1,
    WorkspaceTerminalV1,
};

const MAIN_WEBVIEW_LABEL: &str = "main";
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ABSENT_WRITTEN_AT_UTC: &str = "1970-01-01T00:00:00Z";

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
        };
        Self::Storage(StorageError {
            code,
            message: error.message,
            retryable: error.retryable,
            json_pointer: error.json_pointer,
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
    on_event: Channel<TerminalEvent>,
) -> Result<StartTerminalResponse, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(cwd, columns, rows, on_event))
        .await
        .map_err(|error| format!("Terminal start worker failed: {error}"))?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let terminal_manager = TerminalManager::default();
    let shutdown_manager = terminal_manager.clone();
    let project_store = ProjectStore::preview_default()
        .expect("the isolated IHATECODING Rust preview project store path is invalid");

    tauri::Builder::default()
        .manage(terminal_manager)
        .manage(project_store)
        .setup(|app| {
            let app_local_data_dir = app.path().app_local_data_dir()?;
            let workspace_store = WorkspaceStore::open(&app_local_data_dir)?;
            let import_policy = legacy_import_policy(workspace_store.state_root().to_path_buf())?;
            debug_assert_eq!(import_policy.preview_root(), workspace_store.state_root());
            let legacy_import_service = LegacyImportService::new(import_policy)?;
            app.manage(workspace_store);
            app.manage(Arc::new(legacy_import_service));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_terminal,
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
            inspect_legacy_catalog,
            import_legacy_catalog
        ])
        .build(tauri::generate_context!())
        .expect("error while building IHATECODING Rust Preview")
        .run(move |_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = shutdown_manager.shutdown_for_exit();
            }
        });
}

#[cfg(test)]
mod phase3b_bridge_tests {
    use super::*;
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
}
