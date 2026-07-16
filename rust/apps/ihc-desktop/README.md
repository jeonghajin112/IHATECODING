# IHATECODING Rust Preview

Phase 3A adds isolated project persistence and the first workspace/tab shell on
top of the Phase 2 multi-terminal engine:

- Tauri 2 using one main WebView2
- the same xterm.js version as the C# baseline
- up to 20 independent Windows PowerShell 5.1 processes hosted by Rust ConPTY
- at most two concurrent process starts
- ordered and batched Rust-to-frontend output through Tauri channels
- per-session and global output limits with render-complete ACK backpressure
- latest-wins resize coalescing
- UTF-8 decoding across arbitrary ConPTY read boundaries
- raw terminal byte input without UTF-8 re-encoding
- kill-on-close Windows Job Object ownership for the complete process tree
- one bounded backend shutdown barrier that drains starts and active process trees
- pane-local input, output, scroll, selection, and lifecycle state
- an optional child browser WebView with no Rust IPC capability
- a restrictive CSP for the privileged local WebView
- a left project sidebar and top blank/project tabs
- project creation from an explicit absolute folder path
- project-specific PowerShell names, order, start folders, width ratios, and
  unread flags stored in an isolated Rust preview catalog
- serialized frontend saves plus atomic backend replacement, three verified
  backups, and explicit corruption recovery
- backend-owned preservation of unknown future fields, including JSON integer
  values that JavaScript cannot represent exactly

Restored panes always start as fresh PowerShell sessions in this phase. Stored
Codex and Grok identifiers remain inert; resuming those agents is a later gate.

Run from this directory:

```powershell
npm install
npm run tauri dev
```

Validation:

```powershell
npm test
npm run build
cd src-tauri
cargo fmt -- --check
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

After building the release executable, the Phase 3 persistence smoke test uses
a temporary preview store. It starts 20 saved panes without clicks, restarts
the same layout, checks that the catalog did not change, and verifies normal or
forced shutdown without touching unrelated PowerShell processes:

```powershell
.\scripts\phase3-persistence-smoke.ps1 -PaneCount 20 -CloseMode Normal
.\scripts\phase3-persistence-smoke.ps1 -PaneCount 20 -CloseMode Forced
.\scripts\phase3-persistence-smoke.ps1 -PaneCount 20 -CloseMode RapidNormal
```

`RapidNormal` requests a normal window close as soon as the first restored
PowerShell child appears, while the remaining pane starts are still queued. It
tracks late descendants during shutdown and requires four consecutive empty
process samples before passing.

The preview store defaults to:

```text
%LOCALAPPDATA%\IHATECODING\RustPreview\Projects\projects-v1.json
```

Tests may redirect only this preview store with
`IHATECODING_RUST_PREVIEW_PROJECTS_DIR`. The application does not read or write
the production C# `projects.json`, Codex config, Codex sessions, or Grok
sessions. Import commit, cross-process revision locking, and Codex/Grok resume
remain gated work rather than implied capabilities of this preview.
