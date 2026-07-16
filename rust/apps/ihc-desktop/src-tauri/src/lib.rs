mod pty;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let terminal_manager = TerminalManager::default();
    let shutdown_manager = terminal_manager.clone();

    tauri::Builder::default()
        .manage(terminal_manager)
        .invoke_handler(tauri::generate_handler![
            start_terminal,
            write_terminal,
            write_terminal_bytes,
            resize_terminal,
            ack_terminal_output,
            terminal_engine_status,
            phase2_initial_panes,
            stop_terminal
        ])
        .build(tauri::generate_context!())
        .expect("error while building IHATECODING Rust Preview")
        .run(move |_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown_manager.stop_all();
            }
        });
}
