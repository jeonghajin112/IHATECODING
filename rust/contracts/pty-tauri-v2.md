# Rust Tauri terminal protocol v2

This contract is the Phase 2 boundary between the privileged local WebView and
the Rust ConPTY engine. It does not replace the frozen C# Node broker v1
contract in `pty-v1.md`.

All JavaScript field names are camelCase. A session ID is an opaque string and
must be routed to exactly one terminal pane.

## Commands

- `start_terminal({ cwd, columns, rows, onEvent })`
  - asynchronous; blocking ConPTY creation runs outside the Tauri IPC thread
  - returns `{ sessionId, processId }`
- `write_terminal({ sessionId, data })`
  - writes UTF-8 text in pane input order
- `write_terminal_bytes({ sessionId, data })`
  - writes an array of raw byte values without UTF-8 re-encoding
- `resize_terminal({ sessionId, columns, rows })`
  - latest-wins and suppresses an already-applied identical size
- `ack_terminal_output({ sessionId, sequence })`
  - cumulative acknowledgement through `sequence`
  - the frontend sends it only after the corresponding xterm write callback
- `stop_terminal({ sessionId })`
  - idempotently requests termination of the session Job Object
- `stop_terminal_and_wait({ sessionId })`
  - used by opt-in idle-agent sleep; requests termination and resolves only
    after the process tree, agent ownership, and notification routes are fully
    released, so the same saved conversation can be resumed immediately
- `terminal_engine_status()`
  - reports lifecycle, output-budget, resize, and spawn-limit counters
- `phase2_initial_panes()`
  - preview-only benchmark pane count, clamped to `1..20`; this hook does not
    define production workspace capacity

## Events

```text
{ event: "started", data: { sessionId, processId } }
{ event: "output",  data: { sessionId, sequence, data } }
{ event: "error",   data: { sessionId, message } }
{ event: "exited",  data: { sessionId, exitCode, lastSequence } }
```

`lastSequence` is `null` when no output batch was successfully sent. Otherwise
output sequences begin at zero, are contiguous through `lastSequence`, and no
`output` event may follow `exited`. The frontend must not show the exited state
until every declared sequence has passed the xterm write callback and one
animation frame has completed. A gap or cross-session event is a fatal protocol
error for that pane.

## Capacity and flow control

- No project-scoped reservation limit is imposed by this protocol. A
  process-wide defensive reservation guard rejects unsafe aggregate load with
  an explicit capacity error; it is not a per-project product cap.
- At most two `openpty`/spawn/Job assignments run concurrently.
- Output batches flush at 64 KiB or after an 8 ms window.
- A session may have at most 32 unacknowledged batches and 1 MiB of
  unacknowledged output.
- All sessions together may have at most 8 MiB of unacknowledged output.
- Reaching a limit applies backpressure to the PTY reader; output is not
  intentionally dropped.
- Process exit waits up to three seconds for output drain, then closes flow
  control and reports a terminal error before completing shutdown.

The `IHC_PHASE2_INITIAL_PANES` environment variable is a preview test hook only.
The Phase 2 engine does not read the production project catalog or Codex/Grok
session data.
