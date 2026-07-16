# Rust migration

The staged C# to Rust migration is implemented through Phase 6. The production desktop lives in `apps/ihc-desktop` and uses Tauri 2, TypeScript, xterm.js, portable-pty/ConPTY, and one shared WebView2 renderer.

Implemented production slices include:

1. Up to 20 PowerShell panes with bounded two-at-a-time startup and Job Object cleanup.
2. Canonical `workspace-v1` state with compare-and-swap saves, writer ownership, verified backups, recovery, and unknown-field preservation.
3. Project and workspace tabs, drag reorder, horizontal resize, and alignment snapping.
4. Codex and Grok session ownership, safe resume, exact provider completion events, durable unread alerts, and usage summaries.
5. Korean IME input, text/image clipboard routing, scrollback selection, and output backpressure.
6. Read-only automatic staging and atomic migration of the old C# project catalog when canonical state is absent.
7. Isolated 1/8/20-pane comparison, package verification, unsigned QA artifacts, and optional protected CI signing.

The internal Tauri identifier remains `com.ihatecoding.preview` solely to preserve the app-local state created during the staged migration. Product name, window title, package version, executable, and installer are production `IHATECODING` artifacts.

The frozen C# rollback tag is `csharp-final-2026-07-16`. Migration contracts and historical phase evidence remain under `contracts`, `fixtures`, and the `PHASE*_ACCEPTANCE.md` files.
