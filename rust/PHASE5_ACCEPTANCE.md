# Phase 5 acceptance matrix

Phase 5 owns provider resume, usage, clipboard routing, and completion
notifications. This document defines the evidence required for promotion; its
presence alone does not mark Phase 5 complete. A clean run of every automated
gate and the Windows matrix is required.

## Automated gates

| Area | Required evidence |
| --- | --- |
| Resume ownership | A terminal with no provider ID starts a shell; one valid Codex or Grok ID resumes exactly once; duplicate IDs, dual-provider bindings, invalid IDs, and legacy `resumeBlocked` state fail closed. |
| Launch boundary | Resume is passed as a typed backend launch binding tied to the stable project/terminal identity. It is never injected as simulated terminal input. |
| Event correlation | Provider, project, terminal, conversation, route token, pane generation, and turn key must match the live binding. Stale, cross-pane, duplicate, and malformed events are ignored. |
| Codex completion | A matching top-level CLI `task_complete` can finish a turn without a synthetic start record. Subagent rollouts, failures, cancellation, timeout, and duplicate records never alert. |
| Grok completion | A matching `turn_started` must precede a successful `turn_ended`. Missing starts and unsuccessful outcomes never alert. |
| Durable unread state | `completionPending` is committed before visual decoration or sound. Project, tab, and global badges are derived from canonical terminal state, and explicit acknowledgement clears only the selected terminal. |
| Restart behavior | Unacknowledged completion survives restart, but a restored unread item does not replay the completion sound or generate another event. |
| Remaining usage | Codex and Grok payloads are bounded and validated, used percentages are converted to remaining percentages, values are clamped, and absent, malformed, or stale data is shown as unavailable rather than fabricated. |
| Clipboard images | Codex receives `Ctrl+V`, Grok receives `Escape` then `v`, and a plain shell receives no provider-specific image shortcut. Text paste remains ordinary terminal input. |
| Resource bounds | Correlation history, provider log reads, line size, file count, and scan age are bounded. Missing or offline provider roots do not block startup. |
| Shutdown | Completion watchers, usage readers, storage writes, PTYs, and their descendants stop within the bounded shutdown path. |

Run from the repository root:

```powershell
$Manifest = 'rust\apps\ihc-desktop\src-tauri\Cargo.toml'
$Desktop = 'rust\apps\ihc-desktop'

npm ci --prefix $Desktop
npm test --prefix $Desktop
npm run build --prefix $Desktop

cargo fmt --manifest-path $Manifest -- --check
cargo test --manifest-path $Manifest --all-targets
cargo clippy --manifest-path $Manifest --all-targets --all-features -- -D warnings
```

The frontend suite must include both `phase5-core.test.mjs` and
`phase5-integration.test.mjs`. Rust tests must cover provider log seeding,
partial-line handling, truncation/rotation, top-level Codex filtering, Grok
start-to-success sequencing, stale data, malformed input, and runtime shutdown.

## Manual Windows gates

- Use disposable Codex and Grok conversations. Restore each after restart and
  confirm the correct conversation resumes once without typing a resume command
  into the terminal.
- Assign the same provider conversation to two panes, and assign both provider
  IDs to one pane. Confirm every conflicting owner is visibly blocked and no
  provider process starts.
- Run work concurrently in panes on different projects, then reorder, resize,
  switch projects, and recreate a pane while output is active. Only the pane
  whose current binding finishes may receive the unread border, badge, and one
  sound.
- Exercise successful, failed, cancelled, timed-out, interrupted, and still-
  running tasks. Only a correlated successful completion may alert. In
  particular, a prompt becoming visible or output becoming quiet is not a
  completion signal.
- Finish a task without opening its pane, close the app, and restart. The pane
  and project badge must remain unread, no startup sound may play, and clicking
  that exact pane must durably clear the alert. Restart again to confirm it does
  not return.
- Switch to another project or click outside all panes. Confirm no pane remains
  selected merely because it is first in layout, and unread styling remains
  visible until explicit acknowledgement.
- Verify fresh, stale, missing, truncated, and malformed Codex/Grok usage data.
  The footer must show remaining limits only and must not expose raw paths,
  prompts, conversation IDs, or provider log contents.
- Type Korean text continuously in both providers, paste large text, paste a
  screenshot directly from the clipboard, select and copy old output, and
  scroll upward while output arrives. Confirm no composition character is lost,
  selection is not cleared, and the viewport is not forced to the bottom.
- Restore 1, 8, and 20 panes, including mixed shell/Codex/Grok panes. Close while
  work and provider scans are active; confirm one dark window closes without a
  white flash and no PowerShell, Codex, Grok, or Node descendant remains.

## Exit gate

Phase 5 passes only when all automated commands succeed on the exact release
commit and every manual row has recorded Windows evidence. Any false positive,
wrong-pane alert, lost unread state, duplicate resume, raw sensitive data in a
report, or surviving descendant is a release blocker.
