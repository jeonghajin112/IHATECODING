# IHATECODING Rust desktop

Production desktop implementation built with Tauri, Rust, TypeScript, xterm.js, and Windows ConPTY.

## Commands

```powershell
npm install
npm test
npm run build
npm run tauri dev
npm run tauri build
```

The Tauri CLI enables the `custom-protocol` Cargo feature for production builds. A plain `cargo build --release` is not the packaging entry point.

## State

The canonical workspace is stored under Tauri `app_local_data_dir()/state/workspace-v1.json`. The application keeps the historical `com.ihatecoding.preview` identifier so existing Rust migration state remains available after the production rename.

At first startup, when canonical state is absent, the backend can discover the C# `PowerWorkspace/projects.json` catalog, create a bounded read-only SHA-addressed staging copy, verify it again through the legacy importer, and atomically initialize canonical state. Existing canonical or recovery state is never overwritten by this automatic path.

`IHATECODING_PHASE6_STATE_ROOT` is a guarded smoke-test-only override. It accepts only a marked `ihatecoding-phase6-*` directory below the Windows temporary directory and also isolates WebView2 data.

## Runtime guarantees

- No fixed per-project PowerShell-session cap; starts remain bounded to at most
  two simultaneously, and a process-wide defensive resource guard rejects
  unsafe aggregate load.
- Backend-owned Job Object cleanup and a single graceful shutdown barrier.
- Exact provider-bound Codex/Grok resume ownership; duplicate bindings fail closed.
- Optional inactive-session sleep is off by default and never unloads the
  visible project, working or input-active agents, or plain PowerShell. It
  resumes only durably bound Codex/Grok conversations and restores browser
  panes from their last saved addresses when a project is reopened. Turning
  the option off immediately restores sleeping panes behind their per-pane
  cleanup barriers without delaying unrelated terminals.
- Completion events come from provider session records, not terminal-output text heuristics.
- Completion acknowledgement is persisted before the visual alert disappears.
- Provider usage reads are bounded and do not expose transcript contents.
- Unknown canonical fields survive frontend edits and compare-and-swap saves.

See `rust/PHASE5_ACCEPTANCE.md` and `rust/PHASE6_ACCEPTANCE.md` for verification details.
