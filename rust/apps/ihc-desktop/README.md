# IHATECODING Rust Preview

Phase 4 runs the workspace shell directly from the canonical Rust store on top
of the Phase 2 multi-terminal engine:

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
- a left project sidebar and persisted blank/project/browser/output tabs
- project creation from an explicit absolute folder path
- project-specific PowerShell names, order, start folders, width ratios, and
  unread flags stored in canonical `workspace-v1` state
- serialized frontend saves plus atomic backend replacement, three verified
  backups, and explicit corruption recovery
- backend-owned preservation of unknown future fields, including JSON integer
  values that JavaScript cannot represent exactly
- a canonical `workspace-v1` store under Tauri `app_local_data_dir()` with
  revision CAS, a process writer lock, three backups, and explicit quarantine
  recovery
- two-phase inspection/import of an explicitly selected detached catalog copy,
  including exact-byte SHA-256 snapshots and source identity/metadata checks
- a compact sidebar storage badge plus import and verified-candidate recovery UI
- a SHA-bound one-time upgrade from the isolated Phase 3A preview catalog that
  preserves the source file
- pane header drag/reorder, a stable matte-gray insertion preview, and
  horizontal-only internal-edge resize with sibling snapping
- durable-save-before-close behavior with title/layout rollback on save failure
- unload-before-replace coordination for import, recovery, and preview upgrade
- dynamic queued-start priority for the project currently on screen

The canonical store is the only runtime UI source. Imported or upgraded Codex
and Grok identifiers are retained as data but are never resumed in Phase 4.
Browser and output tab state is restored without automatic navigation or
execution.

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

The older Phase 3A persistence smoke remains useful only for rollback testing.
Phase 4 promotion is governed by the repository-level
`rust/PHASE4_ACCEPTANCE.md` matrix.

```powershell
.\scripts\phase3-persistence-smoke.ps1 -PaneCount 20 -CloseMode Normal
.\scripts\phase3-persistence-smoke.ps1 -PaneCount 20 -CloseMode Forced
.\scripts\phase3-persistence-smoke.ps1 -PaneCount 20 -CloseMode RapidNormal
```

`RapidNormal` requests a normal window close as soon as the first restored
PowerShell child appears, while the remaining pane starts are still queued. It
tracks late descendants during shutdown and requires four consecutive empty
process samples before passing.

The rollback-only Phase 3A source defaults to:

```text
%LOCALAPPDATA%\IHATECODING\RustPreview\Projects\projects-v1.json
```

Tests may redirect only that Phase 3A source with
`IHATECODING_RUST_PREVIEW_PROJECTS_DIR`. The application does not read or write
the production C# `projects.json` and never enumerates Codex/Grok session
contents. The canonical runtime store is resolved by Tauri at:

```text
app_local_data_dir()/state/workspace-v1.json
```

Only a user-entered, detached copy path can be inspected and imported. The C#
catalog remains untouched. Codex/Grok resume remains Phase 5 work rather than
an implied capability of this preview.
