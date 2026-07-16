# Rust migration

The Rust application is developed beside the tested C# baseline. Until the
cutover, it uses preview-only state and must not write the production project
catalog or resume the same agent session as the C# application.

## Phase 2

`apps/ihc-desktop` now contains the Phase 1 Windows integration proof plus the
Phase 2 multi-terminal engine:

1. Tauri 2 and the Windows MSVC toolchain.
2. One lightweight WebView2 hosting as many as 20 independent xterm.js panes.
3. PowerShell input, bounded output, coalesced resize, and shutdown through
   Rust ConPTY.
4. Korean input without synthetic key processing and raw binary input parity.
5. ACK-based output backpressure, deterministic output completion, and Windows
   Job Object cleanup.
6. A separately isolated child WebView for the future browser tab.

The compatibility contracts, including the Phase 2 Tauri terminal protocol,
and sanitized fixtures live in `contracts` and `fixtures`. The full gated
rollout is documented in `MIGRATION_PLAN.md`.
