# Rust migration

The Rust application is developed beside the tested C# baseline. Until the
cutover, it uses preview-only state and must not write the production project
catalog or resume the same agent session as the C# application.

## Phase 2 and Phase 3A

`apps/ihc-desktop` now contains the Phase 1 Windows integration proof plus the
Phase 2 multi-terminal engine:

1. Tauri 2 and the Windows MSVC toolchain.
2. One lightweight WebView2 hosting as many as 20 independent xterm.js panes.
3. PowerShell input, bounded output, coalesced resize, and shutdown through
   Rust ConPTY.
4. Korean input without synthetic key processing and raw binary input parity.
5. ACK-based output backpressure, deterministic output completion, and Windows
   Job Object cleanup.
6. A bounded backend shutdown barrier that closes the start gate, waits across
   the spawn-to-Job-assignment boundary, and drains every active process tree.
7. A separately isolated child WebView for the future browser tab.
8. An isolated PascalCase project catalog compatible with the frozen C# shape,
   with atomic saves, verified backups, corruption quarantine/recovery, and
   backend preservation of unknown fields.
9. A lightweight project sidebar plus blank/project workspace tabs. Selecting
   a project restores its saved PowerShell pane names, order, and start folders
   without resuming Codex or Grok.

The Rust state lives under `%LOCALAPPDATA%\IHATECODING\RustPreview` and is kept
separate from `%LOCALAPPDATA%\PowerWorkspace`. Phase 3B still owns reversible
copy import, optimistic revision/process locking, and remaining Windows
file-identity hardening. The Phase 4 shell still needs drag, resize, and snap
parity before it can be called complete.

The compatibility contracts, including the Phase 2 Tauri terminal protocol,
and sanitized fixtures live in `contracts` and `fixtures`. The full gated
rollout is documented in `MIGRATION_PLAN.md`.
