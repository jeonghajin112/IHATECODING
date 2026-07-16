# IHATECODING Rust Preview

Phase 1 proves the risky Windows integration before the full UI migration:

- Tauri 2 using one main WebView2
- the same xterm.js version as the C# baseline
- one Windows PowerShell 5.1 process hosted by Rust ConPTY
- ordered Rust-to-frontend output through a Tauri channel
- UTF-8 decoding across arbitrary ConPTY read boundaries
- kill-on-close Windows Job Object ownership for the complete process tree
- an optional child browser WebView with no Rust IPC capability
- a restrictive CSP for the privileged local WebView

Run from this directory:

```powershell
npm install
npm run tauri dev
```

Validation:

```powershell
npm run build
cd src-tauri
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

The preview does not read or write the production `projects.json`, Codex config,
Codex sessions, or Grok sessions.
