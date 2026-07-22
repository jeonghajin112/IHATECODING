// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = ihatecoding_lib::run_agent_lifecycle_hook_if_requested() {
        std::process::exit(exit_code);
    }
    if let Some(exit_code) = ihatecoding_lib::run_browser_mcp_if_requested() {
        std::process::exit(exit_code);
    }
    if let Some(exit_code) = ihatecoding_lib::run_grok_notifier_if_requested() {
        std::process::exit(exit_code);
    }
    if let Some(exit_code) = ihatecoding_lib::run_codex_notifier_if_requested() {
        std::process::exit(exit_code);
    }
    ihatecoding_lib::run()
}
