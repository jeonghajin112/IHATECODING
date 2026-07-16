# Rust migration

The Rust application is developed beside the tested C# baseline. Until the
cutover, it uses preview-only state and must not write the production project
catalog or resume the same agent session as the C# application.

## Phase 4 preview

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
9. A lightweight project sidebar plus persisted blank, project, browser, and
   output workspace tabs. Selecting a project restores its saved PowerShell
   pane names, order, start folders, and horizontal row ratios without resuming
   Codex or Grok.
10. An isolated canonical `workspace-v1` store with revision CAS, a
    process-lifetime writer lock, verified backup recovery, and exact-byte
    quarantine for corrupt state.
11. A two-phase, read-only inspector for an explicitly selected detached C#
    catalog copy. Successful import snapshots the exact source bytes and writes
    only the canonical Rust preview store.
12. A small sidebar status/import/recovery UI coordinated with the live runtime
    so stale state cannot be saved over an import or recovery.
13. Header drag/reorder with a stable insertion preview, plus horizontal-only
    internal-edge resizing and sibling-edge snapping.
14. An explicit SHA-bound one-time upgrade from the isolated Phase 3A preview
    into canonical state; the source file is left unchanged.

The Phase 3A catalog under `%LOCALAPPDATA%\IHATECODING\RustPreview` is now only
an isolated rollback/upgrade source. The running Phase 4 UI uses canonical
state under Tauri's app-local directory for
`com.ihatecoding.preview/state`. Both remain separate from
`%LOCALAPPDATA%\PowerWorkspace`. Manual Phase 4 interaction and performance
gates remain; see `PHASE4_ACCEPTANCE.md`.

The compatibility contracts, including the Phase 2 Tauri terminal protocol,
and sanitized fixtures live in `contracts` and `fixtures`. The full gated
rollout is documented in `MIGRATION_PLAN.md`.
