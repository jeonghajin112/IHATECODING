# Phase 4 acceptance matrix

Phase 4 moves the Rust UI from the isolated Phase 3A catalog to the canonical
`workspace-v1` store. Passing an automated row means the behavior has a pure
core, Rust unit, contract, build, or lint check. Manual rows must still be run
on Windows before Phase 4 is promoted.

## Automated gates

| Area | Gate | Status |
| --- | --- | --- |
| Canonical state | Projects, tabs, selection, pane order, and width ratios load and save through revision CAS | Pass |
| Fail-closed access | Read-only, recovery, import-preview, and future-schema modes cannot save or start terminals | Pass |
| Phase 3A upgrade | Inspect and commit are SHA-bound, exact-byte, one-time, and cannot overwrite canonical state | Pass |
| Source isolation | Upgrade source bytes, timestamps, identity, and ACL fingerprint remain unchanged | Pass |
| Unknown fields | Root, project, terminal, tab, and provenance extensions survive normalization and mutations | Pass |
| Tabs | Blank assignment, activation, close, keyboard order, and non-project selection invariants | Pass |
| Terminals | Save-before-spawn, active-project restore, stable names/folders/order, no fixed per-project count cap, and process-wide defensive admission | Pass |
| Save failure | Close waits for durable commit; title, order, and ratios roll back to the last clean snapshot | Pass |
| Replacement | Live terminal trees unload before import, recovery, or upgrade; shutdown waits on the replacement barrier | Pass |
| Start queue | Pending starts are reprioritized for the project currently on screen while preserving FIFO ties | Pass |
| Drag | Stable-ID insertion, deterministic preview, and boundary hysteresis | Pass |
| Resize | Horizontal-only adjacent ratios, minimum widths, sibling snap, and invalid-key rejection | Pass |
| Frontend | `npm test` and `npm run build` | Pass |
| Rust | formatting, all tests, and clippy with warnings denied | Pass |

## Manual Windows gates

- Restart with 1, 2, 3, 5, 7, 8, 11, 17, and 20 saved panes; confirm order,
  row ratios, active tab, and selected project reopen identically.
- Drag slowly across row boundaries and back again; confirm the pane follows the
  pointer, the matte-gray insertion line remains stable, and only drop changes
  the saved order.
- Resize every internal edge; confirm only the two adjacent widths change,
  height never changes, and aligned edges snap without oscillation.
- Cancel drag and resize with Escape, pointer cancellation, Alt+Tab, and window
  blur; confirm no guide or transformed pane remains.
- Double-click and edit a Korean pane title; confirm composition Enter does not
  close the editor early.
- Type Korean text in Codex and Grok, paste large text and screenshots, select
  old output, copy it, and scroll upward while output arrives; confirm no input
  loss, selection loss, or forced scroll-to-bottom.
- Restore 20 terminals and switch projects rapidly; confirm no black pane needs
  a click to start and no queued terminal from an inactive project blocks the
  active project.
- Import and recover a disposable copied fixture while terminals are open;
  confirm the runtime unloads before replacement and reloads only committed
  canonical state.
- Close normally and during queued startup; confirm a single dark window closes
  without a white flash and no PowerShell, Codex, Grok, or Node descendant is
  left behind.

Codex and Grok automatic resume, usage display, and completion notifications
are Phase 5 work and are not implied by this matrix.
