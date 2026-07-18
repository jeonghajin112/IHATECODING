# Phase 6 cutover acceptance

Phase 6 compares the Rust candidate with the frozen C# baseline, packages an
unsigned QA artifact, and preserves immediate rollback. It does not make the
Rust executable the default until every gate below passes.

## Required isolation hook

The Rust candidate must implement `IHATECODING_PHASE6_STATE_ROOT` before the
comparison script may launch it. When set, every mutable Rust workspace,
recovery, import-preview, and migration file used by the smoke run must resolve
under that directory. Provider roots are separately redirected through
`CODEX_HOME` and `GROK_HOME`.

The current comparison is intentionally fail-closed:

- it refuses a Rust binary that does not contain the isolation hook token;
- it creates a GUID-owned temporary root and validates an ownership marker
  before recursive cleanup;
- it copies each executable before launch and uses only sanitized fixtures;
- it fingerprints the production preview state before and after the run;
- it records executable hashes, source labels, timings, counts, and memory, but
  no project path, provider ID, terminal output, prompt, or user profile;
- it verifies process creation time, executable path, and Windows session ID so
  a reused PID cannot be mistaken for a measured descendant.

Until the state-root hook is implemented and its backend tests prove that all
mutable paths honor it, `scripts/phase6-compare.ps1` must be parsed and reviewed
but not executed. A binary string match is a launch precondition, not a
substitute for those backend tests.

## Fixtures and comparison

The sanitized fixture set is:

- `rust/fixtures/phase6-1-pane.projects.json`
- `rust/fixtures/phase6-8-pane.projects.json`
- `rust/fixtures/phase6-20-pane.projects.json`

Each fixture has one deterministic project, placeholder-only paths, no Codex or
Grok resume ID, no unread alert, and no user data. The script writes disposable
legacy state for C# and a canonical `workspace-v1` copy for Rust.

After the isolation hook passes its tests, run from the repository root:

```powershell
powershell.exe -NoProfile -File scripts\phase6-compare.ps1 `
  -RustExecutable rust\apps\ihc-desktop\src-tauri\target\release\ihatecoding.exe
```

Baseline selection is explicit executable first, then the requested tag when
`-BuildCSharpBaselineFromTag` is present, then the workspace
`IHATECODING.exe`. The frozen rollback tag is `csharp-final-2026-07-16`.

```powershell
powershell.exe -NoProfile -File scripts\phase6-compare.ps1 `
  -RustExecutable rust\apps\ihc-desktop\src-tauri\target\release\ihatecoding.exe `
  -BuildCSharpBaselineFromTag `
  -CSharpBaselineTag csharp-final-2026-07-16 `
  -OutputPath artifacts\phase6-comparison.json
```

`-SkipCSharp` is useful only for Rust smoke diagnostics. A Rust-only report can
show that a run was internally healthy, but it cannot satisfy the cutover gate.

For each 1/8/20-pane run, the JSON report records first exact-pane readiness,
500 ms stable readiness, bounded shutdown, zero verified descendants, root and
whole-tree peak working set, and median steady working set. C# smoke execution
uses its documented add/restore/hold environment variables inside the same
isolated fixture policy.

## Automated gates

| Area | Required evidence |
| --- | --- |
| Frontend | Clean `npm ci`, test, and production frontend build on Windows. |
| Rust | Formatting, all-target tests, clippy with warnings denied, and release Tauri build. |
| Fixture privacy | JSON parses, pane counts are exactly 1/8/20, placeholder paths are the only paths, provider IDs are null, and alerts are false. |
| State isolation | Backend tests prove every mutable path is rooted by `IHATECODING_PHASE6_STATE_ROOT`; comparison leaves the production fingerprint unchanged. |
| Restore readiness | Every run reaches and holds exactly the requested PowerShell child count without a click or black pane. |
| Shutdown | Normal close succeeds within 8 seconds and four consecutive descendant samples are empty. Any orphan is an unconditional failure. |
| Report | Every requested run is present and passed; errors are redacted; executable SHA-256 values and baseline source are present. |
| Rollback | `csharp-final-2026-07-16` resolves and can produce or identify the baseline without modifying the current worktree. |

Performance evidence must be collected three times from the same Windows build
and power profile; compare the median reports. Unless a reviewed exception is
recorded before cutover, the Rust candidate must meet all of these budgets:

- stable ready time no greater than the larger of C# + 500 ms or C# x 1.20;
- 20-pane steady process-tree working set no greater than the larger of C# +
  64 MiB or C# x 1.15;
- 20-pane peak process-tree working set no greater than the larger of C# +
  96 MiB or C# x 1.20;
- shutdown at or below 8 seconds with zero descendants.

## Manual Windows gates

- Compare 1, 8, and 20 panes on the same machine. Confirm every pane is live
  immediately, no pane needs a focus click, and saved order and width ratios
  match the fixture.
- Repeat cold start, restore, normal close, close during startup, and close
  during provider work. Check Task Manager or Process Explorer for surviving
  PowerShell, Codex, Grok, Node, WebView, or application descendants.
- Type Korean text, rename panes with IME composition, paste screenshots, copy a
  large output selection, and scroll away from the bottom while output arrives.
- Exercise the copied-state importer with a disposable catalog, verify restart,
  then launch the frozen C# baseline against its untouched copy to prove
  rollback remains usable.
- Inspect the generated report and workflow artifacts for absolute paths,
  project names, conversation IDs, prompts, logs, state files, and credentials.

## Packaging and signing boundary

`.github/workflows/windows-release.yml` builds and uploads an **unsigned QA
bundle** for pull requests. It never creates or publishes a GitHub release.

The manually dispatched signed-candidate job runs only when both
`WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` are configured.
It imports the certificate temporarily, signs the candidate, checks
Authenticode validity, uploads a private workflow artifact, and removes the
temporary certificate material. Missing secrets must skip this job rather than
silently producing an artifact labeled signed.

There is no certificate or private key in this repository, and no production
signing claim can be made without an approved publisher certificate, protected
secrets, a successful timestamped signature, and independent Authenticode
verification. A workflow artifact is not a production release and the workflow
contains no publication step.

## Final cutover gate

Rust becomes the default executable only after the exact release commit passes
all Phase 5 and Phase 6 automated/manual gates, the three-run comparison meets
the budgets, the signed package is independently verified, state import is
reversible, and the C# rollback tag remains available. Otherwise C# stays the
default and the Rust artifact remains preview-only.
