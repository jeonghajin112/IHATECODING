# IHATECODING desktop

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

The canonical workspace is stored under Tauri `app_local_data_dir()/state/workspace-v1.json`. Writes use revision checks, atomic replacement, verified backups, and explicit recovery so invalid or stale state is never silently accepted.

## Runtime guarantees

- No fixed per-project PowerShell-session cap; starts remain bounded to at most
  two simultaneously, and a process-wide defensive resource guard rejects
  unsafe aggregate load.
- Backend-owned Job Object cleanup and a single graceful shutdown barrier.
- Exact provider-bound Codex/Grok resume ownership; duplicate bindings fail closed.
- Persisted PowerShell, Claude Code, and OpenCode launch profiles use a closed
  backend enum and fixed commands rather than frontend-supplied shell text.
- The Agents settings tab reports a closed, redacted local status contract for
  Codex, Grok, Claude Code, and OpenCode; it never returns tokens, executable
  paths, or raw authentication command output.
- Optional inactive-session sleep is off by default and never unloads the
  visible project, working or input-active agents, or any pane without a
  durable Codex/Grok conversation binding. It
  resumes only durably bound Codex/Grok conversations and restores browser
  panes from their last saved addresses when a project is reopened. Turning
  the option off immediately restores sleeping panes behind their per-pane
  cleanup barriers without delaying unrelated terminals.
- Completion events come from provider session records, not terminal-output text heuristics.
- Completion acknowledgement is persisted before the visual alert disappears.
- Provider usage reads are bounded and do not expose transcript contents.
- Unknown canonical fields survive frontend edits and compare-and-swap saves.
