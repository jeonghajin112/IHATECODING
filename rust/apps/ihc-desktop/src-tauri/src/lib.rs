mod pty;

use pty::{StartTerminalResponse, TerminalEvent, TerminalManager};
use tauri::{State, ipc::Channel};

#[tauri::command]
fn start_terminal(
    manager: State<'_, TerminalManager>,
    cwd: Option<String>,
    columns: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<StartTerminalResponse, String> {
    manager.start(cwd, columns, rows, on_event)
}

#[tauri::command]
fn write_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, data.as_bytes())
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
            resize_terminal,
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
