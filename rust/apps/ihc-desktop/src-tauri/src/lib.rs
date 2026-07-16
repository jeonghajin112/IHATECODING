mod project_store;
mod pty;

use project_store::{
    InspectProjectCatalogCopyRequest, LoadProjectCatalogResponse, PROJECT_CATALOG_SCHEMA_VERSION,
    ProjectCatalogV1, ProjectStore,
};
use pty::{StartTerminalResponse, TerminalEngineStatus, TerminalEvent, TerminalManager};
use tauri::{State, ipc::Channel};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let terminal_manager = TerminalManager::default();
    let shutdown_manager = terminal_manager.clone();
    let project_store = ProjectStore::preview_default()
        .expect("the isolated IHATECODING Rust preview project store path is invalid");

    tauri::Builder::default()
        .manage(terminal_manager)
        .manage(project_store)
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
            project_catalog_schema_version
        ])
        .build(tauri::generate_context!())
        .expect("error while building IHATECODING Rust Preview")
        .run(move |_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = shutdown_manager.shutdown_for_exit();
            }
        });
}
