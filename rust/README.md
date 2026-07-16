# Rust migration

The Rust application is developed beside the tested C# baseline. Until the
cutover, it uses preview-only state and must not write the production project
catalog or resume the same agent session as the C# application.

## Phase 1

`apps/ihc-desktop` is a focused feasibility build for:

1. Tauri 2 and the Windows MSVC toolchain.
2. A single WebView2 hosting xterm.js.
3. PowerShell input, output, resize, and shutdown through Rust ConPTY.
4. Korean IME input without synthetic key processing.
5. A separately isolated child WebView for the future browser tab.

The compatibility contracts and sanitized fixtures live in `contracts` and
`fixtures`. The full gated rollout is documented in `MIGRATION_PLAN.md`.
