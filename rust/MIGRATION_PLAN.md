# IHATECODING C# to Rust migration

The migration is incremental. The tested C# build remains the rollback path
until the Rust application passes the same functional and data-compatibility
gates.

## Safety baseline

- C# source snapshot: commit `0de4ead6a1f808ad15fc048817235999060d4adb`
- Backup branch: `legacy/csharp`
- Release tag: `csharp-final-2026-07-16`
- Rust preview state is isolated from the production `projects.json` and agent
  session files.
- No phase may overwrite production state until it has a fixture-backed reader,
  an atomic writer, and an explicit rollback test.

## Phase 1 — Windows integration proof

Status: implemented on `agent/rust-migration-phase1`.

- Tauri 2 desktop shell using the Windows MSVC toolchain
- one local xterm.js terminal backed by Rust and ConPTY
- incremental UTF-8 decoding plus a real ConPTY Korean round-trip test
- ordered startup/output/exit events without losing the first or last output
- PowerShell process trees owned by a kill-on-close Windows Job Object
- selection-safe terminal auto-follow behavior
- isolated child WebView proof for a future browser tab; remote content has no
  Rust IPC capability
- restrictive CSP on the privileged local WebView
- frozen project-catalog and PTY compatibility contracts with sanitized data

Phase 1 deliberately does not read or migrate real projects, resume Codex or
Grok sessions, or replace the C# executable.

## Phase 2 — terminal engine parity

Status: core implementation and packaged 20-pane process smoke completed on
`agent/rust-migration-phase2`; manual Windows IME, clipboard, scroll behavior,
and performance gates remain before preview promotion.

- isolate the terminal manager behind injectable sink and lifecycle boundaries;
  move it to a dedicated crate after the Phase 2 protocol stabilizes
- support up to 20 concurrent ConPTY sessions
- add bounded output queues, backpressure, resize coalescing, and clean shutdown
- reproduce copy/paste, Korean IME, scrollback selection, and clipboard-image
  behavior
- run fault tests for rapid create/close, CLI crashes, app shutdown, and orphan
  process cleanup

Implemented automated evidence:

- 20 Rust tests, including the camelCase Tauri event contract, real Korean
  ConPTY round-trip, and 20 real concurrent
  PowerShell sessions with unique output and complete cleanup
- 21 frontend protocol/state tests for deterministic layouts, event-contract
  validation, start cancellation, output sequencing, cumulative ACKs, binary
  bytes, and clipboard classification
- release process smoke passed for 20 panes in normal and forced close modes,
  with zero tracked descendants left after either path
- session output capped at 1 MiB/32 batches and global unacknowledged output
  capped at 8 MiB

Exit gate: 20-pane stress test and terminal behavior parity with no orphaned
Codex, Grok, PowerShell, or Node processes.

## Phase 3 — projects and persistence

Status: Phase 3B automated preview slice implemented on
`agent/rust-migration-phase3b`. The isolated canonical store, two-phase copied
catalog import, revision/process locking, recovery, and migration UI are wired.
Manual copied-production, crash, path, ACL, and performance gates remain before
Phase 3 exit.

- implement Rust models for `projects-v1.schema.json`
- first ship a read-only importer against copied state
- preserve unknown or future fields during migration
- add atomic save, backup rotation, corruption recovery, and schema-version
  upgrades
- restore project selection, pane names, width ratios, and pending alerts

Phase 4 now uses `workspace-v1` as the only live UI state. The Phase 3A preview
catalog remains an isolated rollback/upgrade source and is never used as a
second runtime store. Its explicit one-time upgrade preserves the source bytes
and never resumes a Codex thread or Grok session.

Exit gate: fixture comparison plus a reversible import of a copied production
catalog. The C# catalog remains untouched.

## Phase 4 — workspace and tab UI

Status: canonical runtime cutover and the automated Phase 4 workspace slice are
implemented on `agent/rust-migration-phase4`. Manual Windows interaction,
restart-layout, IME/clipboard, and 20-pane performance gates remain before the
Phase 4 exit gate is signed off.

- rebuild the left project sidebar and top workspace tabs
- support blank tabs that can later host terminals, browser views, project
  output, or another project
- port pane drag/reorder, insertion previews, horizontal resizing, and snapping
- retain the black/white lightweight visual system

Implemented evidence:

- canonical CAS state is the single source for projects, tabs, selected project,
  pane order, names, folders, and row width ratios
- explicit SHA-bound Phase 3A preview upgrade that leaves the source bytes,
  timestamps, and ACLs unchanged and refuses to overwrite canonical state
- persisted blank/project/browser/output tab restoration without automatically
  navigating a browser or resuming an agent
- active-project-only terminal startup, save-before-spawn for new terminals,
  an independent 20-session restore gate per project, and dynamic priority for the visible
  project's queued starts
- save-before-close plus title/layout rollback on failed canonical writes, and
  unload-before-replace for import, recovery, and preview upgrade
- header drag with an 8 px activation threshold, stable-ID insertion preview,
  and a single reorder/save on drop
- horizontal-only internal-edge resizing, minimum widths, sibling-edge snap,
  and one ratio save on pointer release
- 85 frontend core/contract/integration tests plus the Rust storage/bridge suites

The detailed automated and manual acceptance matrix is in
`PHASE4_ACCEPTANCE.md`.

Exit gate: saved layouts reopen identically and 20 panes remain responsive.

## Phase 5 — Codex, Grok, usage, and notifications

- resume Codex threads and Grok sessions without duplicate ownership
- port remaining-limit displays and provider icons
- replace heuristic completion detection with provider/session-correlated events
- persist unread terminal and project alerts across restarts
- verify screenshot clipboard paste and large text copy workflows

Exit gate: completion alerts always identify the correct terminal and never fire
for an unfinished task.

## Phase 6 — cutover

- run C# and Rust builds against separate copies of the same fixture set
- compare startup time, memory, restore latency, Korean input, and 20-pane load
- build a signed/packaged Rust release and a one-click state importer
- keep `csharp-final-2026-07-16` available for immediate rollback

Only after the acceptance matrix passes does the Rust build become the default
IHATECODING executable.
