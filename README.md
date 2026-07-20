# IHATECODING

The AI Workspace for autonomous development.

## Features

- Project-based workspaces without a fixed per-project PowerShell pane cap
- One-click PowerShell, Claude Code, and OpenCode panes with their launch type restored per project
- Agent settings for Codex, Grok, Claude Code, and OpenCode with local install/sign-in indicators, refresh, and one-click launch in the current project
- Persistent pane layouts and automatic workspace restoration after a restart
- Safe continuation of saved Codex conversations and Grok sessions
- Tabs that can host project workspaces, terminal panes, or embedded web panels
- Completion and error feedback through sounds, highlighted panes, unread badges, and optional Discord notifications
- Remaining-limit indicators for Codex five-hour and weekly limits, plus Grok usage
- Drag-to-reorder panes, horizontal resizing, alignment snapping, and pane maximization
- Windows IME support, terminal text copy and paste, clipboard screenshot paste, and file drag-and-drop
- UI Pick in embedded web panels: right-click one element, Shift-right-click to add elements, or right-drag a box to select only elements fully enclosed by it (up to 32); styled cards are grouped with their descendant text before selectors, visible styles, and a local screenshot reference are copied for an AI CLI
- Scroll-follow behavior that pauses while output is selected or the terminal is scrolled upward
- Read-only import of an existing local project list
- English and Korean user interfaces

## Requirements

- Windows 10 version 1809 or later, or Windows 11
- Microsoft Edge WebView2 Runtime
- Install the CLI commands you want to use (`codex`, `grok`, `claude`, and/or `opencode`)
- Node.js 22 or later and the stable Rust toolchain when building from source

Terminal panes use Windows PowerShell 5.1 through ConPTY.

## Run from source

From PowerShell:

```powershell
cd .\apps\ihc-desktop
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm ci
npm run tauri dev
```

If you already have a release build, run `IHATECODING.exe` instead.

## Build

Run the release pipeline from the repository root:

```powershell
.\Build.ps1
```

The script restores locked frontend dependencies, runs the frontend and Rust test suites, runs Clippy with warnings denied, and produces a production executable and an NSIS installer candidate. It does not replace the repository-root `IHATECODING.exe` unless cutover is explicitly requested.

Build outputs are written to:

- `apps\ihc-desktop\src-tauri\target\release\ihatecoding.exe`
- `apps\ihc-desktop\src-tauri\target\release\bundle\nsis\`

To build only the executable:

```powershell
.\Build.ps1 -NoInstaller
```

### Release cutover

Use a verified candidate when replacing the repository-root executable. A signed candidate must have a valid Authenticode signature, an explicitly approved publisher certificate thumbprint, and a timestamp certificate.

```powershell
.\Build.ps1 -Cutover `
  -CandidatePath 'C:\path\to\signed\ihatecoding.exe' `
  -ApprovedPublisherThumbprint '<approved-certificate-thumbprint>'
```

Unsigned cutover is blocked by default. `-AllowUnsignedLocalCutover` exists only for a local development build whose risk has been explicitly accepted.

## Verify

```powershell
cd .\apps\ihc-desktop
npm ci
npm test
npm run build

cd .\src-tauri
cargo test --all-targets
cargo clippy --all-targets --all-features -- -D warnings
```

## Security and privacy

IHATECODING stores workspace state and settings locally. The app itself does not upload terminal output, prompts, project paths, conversation identifiers, or CLI credentials to an IHATECODING server. Codex CLI, Grok CLI, Claude Code, OpenCode, and pages opened in web panels still communicate with their respective services under their own policies.

Agent connection checks expose only bounded local status such as installation, an available account label, or the number of configured OpenCode providers. Tokens, executable paths, and raw CLI output are not returned to the interface. Provider icon sources and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

UI Pick treats captured page content as untrusted data. It does not read form values, cookies, browser storage, full HTML, or URL queries and fragments, and it refuses targets that directly contain password inputs. Its bounded screenshot can still include sensitive information already visible near the selected elements. Captures stay in the local application cache and are pruned on app launch and future captures.

Discord notifications are optional. When enabled, IHATECODING sends the notification type together with the project and terminal names to the Discord webhook configured by the user. The webhook URL is restricted to official Discord webhook hosts and is protected locally with Windows Data Protection API (DPAPI).

Do not commit CLI credentials, Discord webhook URLs, local state files, or release-signing certificates to the repository.
