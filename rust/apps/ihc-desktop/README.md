# IHATECODING Rust Preview

Phase 2 extends the Windows integration proof into a multi-terminal preview:

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
- pane-local input, output, scroll, selection, and lifecycle state
- an optional child browser WebView with no Rust IPC capability
- a restrictive CSP for the privileged local WebView

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

After building the release executable, the process smoke test can start all 20
panes and verify normal or forced shutdown without touching unrelated
PowerShell processes:

```powershell
.\scripts\phase2-smoke.ps1 -PaneCount 20 -CloseMode Normal
.\scripts\phase2-smoke.ps1 -PaneCount 20 -CloseMode Forced
```

The preview does not read or write the production `projects.json`, Codex config,
Codex sessions, or Grok sessions.
