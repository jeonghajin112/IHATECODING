# Phase 3 storage and Tauri contract

This document separates the Phase 3A runtime foundation from the Phase 3B
contract required before production migration. The 2026-07-17 automated
Phase 3B slice now implements the isolated canonical store, copied-catalog
inspect/import, revision/process locking, recovery, and local-main command
boundary described below. Remaining deviations and manual gates are tracked in
[PHASE3_ACCEPTANCE.md](../PHASE3_ACCEPTANCE.md). Nothing here grants permission
to write the production C# catalog.

## Phase 3A implemented contract

### Trust and ownership

- Only the local `main` WebView has the Tauri capability containing the current
  storage commands. Remote child WebViews do not inherit it.
- The backend does not enumerate Codex/Grok session roots or resume an agent.
  Imported `CodexThreadId` and `GrokSessionId` values remain inert private data.
- The production C# catalog is not a write target. Inspection accepts only an
  absolute path explicitly labelled by the caller as a detached copy.
- All current command failures are `String` errors, not the structured Phase 3B
  error envelope.

### Current files and path controls

Without an override, the backend derives this path directly from
`LOCALAPPDATA`:

```text
%LOCALAPPDATA%\IHATECODING\RustPreview\Projects\
  projects-v1.json
  projects-v1.json.bak1
  projects-v1.json.bak2
  projects-v1.json.bak3
  .projects-v1.json.<uuid>.tmp
  projects-v1.corrupt-<uuid>.json
```

`IHATECODING_RUST_PREVIEW_PROJECTS_DIR` may replace the directory but must be
absolute. `POWERWORKSPACE_PROJECTS_PATH`, when set, identifies an additional C#
production catalog that must be blocked. At startup the code resolves existing
ancestors and rejects an exact preview catalog alias or a preview directory
equal to a known production catalog parent. `inspect_project_catalog_copy`
canonicalizes the existing source and rejects configured production paths.

These are useful lexical/canonical-path guards, not final file-identity proof.
Phase 3A does not reject every production-tree descendant, compare hard-link
file IDs, hold directory handles against reparse-point swaps, or repeat the
identity check at commit. Those are Phase 3B gates.

### Current persisted model

`projects-v1.json` is a PascalCase `ProjectCatalogV1`, compatible with the
legacy C# shape:

- catalog: `Projects`, required nullable `SelectedProjectId`;
- project: `Id`, `Name`, `FolderPath`, `Terminals`, `PaneWidthRatios`;
- terminal: `Id`, `Name`, `StartDirectory`, required nullable
  `CodexThreadId`, `GrokSessionId`, `CreatedAtUtc`, and `CompletionPending`.

Catalog, project, and terminal objects retain unknown members in
`serde_json::Value` maps. On an update to an existing preview file, stored
unknown values override frontend-returned unknown values at matching
project/terminal IDs. This protects an existing value such as an integer above
JavaScript's exact range, but it is not an exact-byte import mechanism.

The parser currently enforces a 16 MiB whole-file limit, required fields,
non-empty IDs/names/paths, unique project IDs, unique terminal IDs within a
project, a resolvable selected project, positive finite non-empty ratio
vectors, and RFC 3339 terminal timestamps. Terminal count has no separate
per-project product cap; the whole-file limit remains authoritative. A
top-level unknown `SchemaVersion`, if present, must equal `1`; the normal file
does not serialize a required schema version.

The file has no revision, commit timestamp, import provenance, or persisted tab
model. Frontend empty/project tabs and the active tab are process memory only;
browser/output tabs are not part of Phase 3A persistence.

### Current Tauri commands

All filesystem work below is moved to `spawn_blocking`:

- `load_project_catalog() -> { catalog: ProjectCatalogV1,
  recoveryRequired: boolean }`
- `save_project_catalog({ catalog: ProjectCatalogV1 }) -> ()`
- `inspect_project_catalog_copy({ request: { sourcePath,
  sourceIsDetachedCopy } }) -> ProjectCatalogV1`
- `recover_project_catalog_backup() -> ProjectCatalogV1`
- `reset_corrupt_project_catalog({ confirmed }) -> ProjectCatalogV1`
- `project_catalog_schema_version() -> 1`

`inspect_project_catalog_copy` only parses a copy read-only. It does not create
a raw snapshot, return a hash, or commit an import. The schema-version command
reports the legacy parser contract and does not imply that `projects-v1.json`
is a versioned workspace state file.

### Current save and recovery semantics

- An in-process mutex serializes operations for one `ProjectStore` instance.
- Save validates the incoming catalog. If main exists, it also validates the
  current bytes, merges stored unknown fields by ID, writes the old main to the
  backup rotation, then uses a same-directory create-new temp, file flush, and
  atomic replace. The first save has no backup generation.
- Save refuses to overwrite an invalid main. It also refuses when main is
  missing but any backup file exists.
- Load returns main with `recoveryRequired: false` when valid. If main is
  corrupt or missing, it returns the first valid `.bak1` through `.bak3`
  without mutating disk and sets `recoveryRequired: true`. The frontend keeps
  that preview read-only, starts no terminals, and exposes explicit recovery.
- Explicit recovery quarantines an existing corrupt main and atomically copies
  a verified backup into main. Explicit reset requires `confirmed: true`; it
  creates an empty main for corrupt/missing state and leaves existing backups
  untouched.

These semantics prevent the ordinary single-instance corrupt-primary → empty
save failure. The current main-window close barrier drains its frontend save
queue, but the store does not provide revision CAS, an inter-process lock, a
backend-owned revisioned storage-flush drain, or a check-to-commit
file-identity guarantee. Terminal process shutdown has a separate bounded
backend barrier and is not part of this storage limitation.

## Phase 3B required contract

All Tauri field names in this section are camelCase. JSON examples are the
future canonical Rust preview state; legacy C# input remains PascalCase.

### Trust and privacy boundary

- Only the local `main` WebView may call storage commands. Remote browser and
  project-output WebViews receive no storage, terminal, event, or raw state
  capability.
- Project names, absolute paths, browser URLs, Codex thread IDs, Grok session
  IDs, unknown legacy fields, backups, and raw imports are private local data.
- These values must not be written to telemetry, stdout, ordinary diagnostic
  logs, crash-report metadata, test snapshots, or repository fixtures.
- State is protected by the current user's inherited Windows ACL. It is not
  encrypted at rest and the UI/documentation must not claim otherwise.
- Phase 3 does not enumerate or read `~/.codex/sessions`, Grok session roots, or
  any agent conversation content. Imported agent IDs are inert values.

### File ownership and locations

The Rust backend resolves paths; the frontend never supplies an output path.

```text
Tauri app_local_data_dir() for com.ihatecoding.preview/
  state/
    workspace-v1.json
    workspace-v1.json.bak.1
    workspace-v1.json.bak.2
    workspace-v1.json.bak.3
    write.lock
    imports/<source-sha256>.projects.json
    quarantine/<utc>-<sha256>.json
```

The production source is normally
`%LOCALAPPDATA%\PowerWorkspace\projects.json`. The C# environment override
`POWERWORKSPACE_PROJECTS_PATH` may identify a candidate for tests or explicit
user import, but Rust never treats it as a write destination and never imports
it silently at startup.

Before opening a write target, the backend rejects reparse traversal and checks
that its resolved file identity cannot alias the import source or production
catalog. Temp files are created in the state directory, never in the shared OS
temp directory.

### Format identities

There are two different version concepts:

1. `projects-v1.schema.json` freezes the current C# `ProjectCatalog` JSON
   shape. The file itself has no serialized version and is called
   `powerWorkspace.projects/1` by the importer.
2. `workspace-v1.json` is the Rust preview state below and always contains
   numeric `schemaVersion: 1`.

A versionless JSON object is accepted as legacy only when its case-sensitive
top-level shape is unambiguously the PascalCase C# catalog. An unknown or newer
serialized Rust schema version is `unsupportedVersion`; it is never interpreted
as empty state or automatically downgraded.

### Canonical workspace model

The shape is intentionally ready for Phase 4 tabs, but Phase 3 does not create
browser processes or terminal sessions from it.

```json
{
  "schemaVersion": 1,
  "revision": 7,
  "writtenAtUtc": "2026-07-17T00:00:00Z",
  "selectedProjectId": "project-id-or-null",
  "projects": [
    {
      "id": "project-id",
      "name": "Example",
      "folderPath": "C:\\Example",
      "lastModifiedAtUtc": "2026-07-17T00:00:00Z",
      "terminals": [
        {
          "id": "terminal-id",
          "name": "MAIN",
          "startDirectory": "C:\\Example",
          "codexThreadId": null,
          "grokSessionId": null,
          "createdAtUtc": null,
          "completionPending": false,
          "legacyExtensions": {}
        }
      ],
      "paneWidthRatios": {
        "2x1:row-0": [0.5, 0.5]
      },
      "legacyExtensions": {}
    }
  ],
  "tabs": [
    {
      "id": "tab-id",
      "kind": "project",
      "title": "Example",
      "projectId": "project-id",
      "browser": null,
      "output": null,
      "extensions": {}
    }
  ],
  "activeTabId": "tab-id",
  "importProvenance": {
    "sourceFormat": "powerWorkspace.projects/1",
    "sourceSha256": "64-lowercase-hex-characters",
    "snapshotFile": "<source-sha256>.projects.json",
    "importedAtUtc": "2026-07-17T00:00:00Z"
  },
  "extensions": {},
  "legacyExtensions": {}
}
```

`revision`, `writtenAtUtc`, and `importProvenance` are backend-owned. A save
payload cannot replace them.

#### Project and terminal invariants

- At most 256 projects exist. Project IDs are non-empty, bounded opaque strings
  and are unique using exact ordinal comparison.
- Terminal count has no product-level per-project cap. Terminal IDs are unique
  within the project, and array order is pane order. Whole-document byte/depth
  limits and the runtime's process-wide defensive admission guard remain in
  force.
- Names are trimmed for emptiness but their Unicode content is preserved.
- `folderPath` and `startDirectory` retain the user's display spelling. Path
  availability and containment are derived at activation time and are not
  persisted as truth.
- Codex/Grok IDs are null or valid UUID strings. Duplicate ownership is a
  validation conflict; the values remain preserved but all conflicting panes
  are resume-blocked until Phase 5 resolves them.
- `createdAtUtc` is null or an RFC 3339 instant. Writers emit UTC `Z` form.
- `lastModifiedAtUtc` is null for legacy projects or an RFC 3339 instant. The
  frontend updates it only for durable project-content or pane-state changes;
  tab activation alone does not change recent-project ordering.
- `completionPending` is the persisted unread terminal alert. The project
  unread count is derived, not independently stored.
- `paneWidthRatios` preserves the legacy key format. Active keys match
  `^[1-5]x[1-4]:row-[0-3]$`; vector length equals its column count, each value
  is finite and positive, and the writer normalizes the sum to 1. Unknown or
  inapplicable legacy keys are retained for losslessness but not applied.

#### Tab invariants

- At most 128 tabs exist; array order is visual order. IDs are stable and
  unique. `activeTabId` is null only when no valid tab can be constructed.
- `kind` is `empty`, `project`, `browser`, or `output`. Unknown future kinds are
  retained as unsupported placeholders and never instantiated as a WebView.
- `empty` has null `projectId`, `browser`, and `output`.
- `project` references an existing project and has null browser/output data.
- `browser` may carry project context and has
  `browser: { "url": "https://..." }`. Only `http`, `https`, and
  `about:blank` restore. URL userinfo and `file`, `data`, `javascript`, and
  custom schemes are blocked. Cookies, headers, POST bodies, history, page
  content, and auth state are not part of this file.
- `output` references an existing project and has
  `output: { "mode": "auto", "relativeEntry": null }`. A future relative
  artifact entry is backend-resolved beneath the project root. Absolute local
  folders, virtual hostnames, WebView labels, and capability IDs are never
  persisted.
- Browser and output tabs are restored lazily. Import/load alone performs no
  DNS lookup, network navigation, file mapping, or WebView creation.

#### Transient state excluded from persistence

Terminal output and scrollback, cursor and selection, shell environment,
running PID, focus, maximized pane, resize drag previews, browser DOM, passwords,
clipboard data, and completion-detection timers are runtime-only.

### Lossless legacy import

Import is a two-phase operation:

1. Inspect a stable read-only byte snapshot and return only counts, warnings,
   source format, and SHA-256.
2. Import only if the caller supplies the same SHA-256 and explicitly selects
   preview replacement. The backend re-reads and re-hashes before commit.

The exact source bytes are copied to `imports/<sha>.projects.json` before the
canonical state is committed. Unknown bounded properties are also retained in
the nearest `legacyExtensions` map. The raw snapshot is authoritative for
future export and makes normalization reversible.

Importer behavior is deterministic:

- project and terminal order are unchanged;
- the first duplicate legacy ID is the active canonical item, while duplicates
  remain in the raw snapshot and produce diagnostics;
- all terminals that fit the validated document resource limits remain in
  canonical pane order; importing does not spawn sessions, and later activation
  remains subject to the runtime's process-wide defensive admission guard;
- invalid or dangling selected project becomes unselected rather than choosing
  and launching the first project;
- a valid selected project produces one deterministic project tab; otherwise
  one deterministic empty tab is produced;
- legacy browser/output tabs are never inferred because C# did not persist
  them;
- missing paths are preserved and marked unavailable, not replaced by the
  process working directory;
- re-importing the same source hash is idempotent.

The source file is never renamed, reformatted, repaired, backed up in place, or
opened with write/delete access.

### Schema migration rules

- Each supported version has a pure `Vn -> Vn+1` transformation, before/after
  golden fixture, unknown-field sentinel, and failure fixture.
- Migration operates in memory and validates the complete result before atomic
  commit. It never edits a state file in place.
- Migration is idempotent under canonical serialization.
- The pre-migration main file remains a verified backup until at least three
  later valid generations exist.
- Newer major versions open read-only. A downgrade requires a future explicit
  export command and is not part of v1.

### Atomic and crash-safe writes

One backend storage actor owns all writes. A process-lifetime lock prevents a
second instance from writing; an instance that cannot acquire it reports
read-only mode.

For every save:

1. Validate `expectedRevision` against the currently committed generation.
2. Validate all model, size, reference, path-policy, and privacy invariants.
3. Serialize deterministically to a unique same-directory file opened with
   create-new semantics.
4. Write all bytes, append the canonical newline, and call
   `FlushFileBuffers`.
5. Reopen the temp file and parse/validate it using the normal reader.
6. Preserve the previous verified generations, then use Windows atomic replace
   for an existing main file or write-through rename for first creation.
7. Return success only after replacement completes. Remove obsolete temp files
   after, never before, a valid main or backup exists.

`revision` is a monotonic `u64`; overflow is a hard read-only error. Every
frontend save supplies `expectedRevision`. Stale saves return
`revisionConflict` and cannot overwrite a newer state. If writes are coalesced,
every awaiting caller succeeds only after a durable generation covering its
mutation commits.

Backup rotation retains at least three independently parseable generations.
Failure to rotate an older backup must not delete `.bak.1` or invalidate the
main commit. Fault tests inject errors or process termination after every step.

### Load and corruption recovery

Loading validates byte limit, UTF-8, duplicate members, JSON syntax, schema
version, semantic invariants, references, and revision before returning data.
An error is never converted to a normal empty catalog.

Candidate order is main, `.bak.1` through `.bak.3`, then valid uncommitted temp
files for manual inspection. If main is invalid:

- copy its exact bytes to a hash-named quarantine file without logging values;
- select the newest verified committed backup as a read-only recovery preview;
- require explicit `recover_workspace_state` before replacing main.

If every committed candidate is invalid, status is `recoveryRequired`. The UI
may render an empty placeholder but project creation and save remain locked.
There is no reset/delete command in v1. A valid main always wins over a newer
leftover temp because the temp was never acknowledged as committed.

### Windows path policy

Paths are validated in Rust immediately before use, not only by JavaScript or
at import time.

- Reject NUL, device-only paths, alternate data streams, non-directory targets,
  and relative project roots.
- Compare existing paths by final file identity where possible; compare missing
  paths by normalized Windows components using case-insensitive semantics.
- Treat `\\?\`, UNC, drive-letter case, trailing separators, junctions, and
  symlinks explicitly. Never use raw string prefix for containment.
- Preserve missing/offline project paths without launching. Do not persist a
  fallback current directory.
- A start directory resolving outside its project root is blocked until an
  explicit local-main-WebView confirmation. Reparse escape receives the same
  treatment.
- Project-output relative entries must stay under the resolved project root
  after following reparse points.

### Tauri commands

All commands are asynchronous. Blocking filesystem work runs on the storage
actor or `spawn_blocking`, never the IPC/event thread.

#### `storage_status()`

Returns:

```text
{
  mode: "absent" | "ready" | "readOnly" | "recoveryRequired" | "unsupportedVersion",
  schemaVersion: number | null,
  revision: number | null,
  hasLegacyImport: boolean,
  hasRecoveryCandidates: boolean,
  writable: boolean
}
```

It does not expose raw paths, IDs, or import contents.

#### `inspect_legacy_catalog({ sourcePath })`

Callable only from local `main` after explicit user file selection. Returns:

```text
{
  inspectToken,
  sourceFormat,
  sourceSha256,
  byteLength,
  projectCount,
  terminalCount,
  recoverableWarnings: [{ code, jsonPointer }],
  blockingErrors: [{ code, jsonPointer }]
}
```

Messages and pointers identify fields but never echo their values.

#### `import_legacy_catalog({ inspectToken, sourcePath, sourceSha256, mode })`

`mode` is only `replacePreview` in v1. The command revalidates a stable source,
writes the exact import snapshot, creates canonical revision 1 when state is
absent (or the next monotonic revision for an explicit replacement), and
returns the same `WorkspaceSnapshot` shape as load. `inspectToken` is bound to
the canonical source path, file identity/metadata, and SHA-256 and expires on
application restart. The command never merges automatically and never writes
the source.

#### `load_workspace_state()`

Returns `{ revision, state, recovery }`, where `state` omits backend-owned file
paths and raw import bytes. In recovery mode the snapshot is read-only until
confirmed.

#### `save_workspace_state({ expectedRevision, state })`

Validates and atomically commits mutable project/tab/layout fields. The backend
retains provenance and unknown extensions not owned by the frontend. Returns
`{ revision, writtenAtUtc }` only after durable commit.

#### `list_recovery_candidates()`

Returns opaque candidate IDs, revision if readable, timestamp, byte length, and
validation status. It never returns raw filenames or content.

#### `recover_workspace_state({ candidateId })`

Revalidates the candidate, preserves the current corrupt main in quarantine,
and atomically commits the candidate as a new revision. Candidate IDs cannot be
used as arbitrary paths.

There is intentionally no `save_to_path`, `delete_file`, `reset_all`, raw file
read, or production export command in v1.

### Errors and change notification

Commands reject with a structured, serializable error:

```text
{
  code: "busy" | "io" | "invalidSource" | "sourceChanged" | "tooLarge" |
        "invalidState" | "unsupportedVersion" | "revisionConflict" |
        "readOnly" | "recoveryRequired" | "pathDenied",
  message: safe localized summary,
  retryable: boolean,
  jsonPointer: string | null
}
```

Raw OS errors are retained only in redacted local diagnostics. Multi-window or
future UI consumers may receive `{ event: "storageChanged", revision }`; the
event carries no state and receivers must reload using their current revision.

### Non-goals for Phase 3B

- Writing or repairing the C# production catalog
- Resuming Codex/Grok sessions or reading their conversation files
- Starting terminals from imported state
- Navigating restored browser/output tabs
- Persisting terminal output, browser credentials, cookies, clipboard content,
  or arbitrary local file URLs
- Making the Rust build the default executable

Those operations remain gated by later phases and cannot be inferred from a
successful Phase 3 import.
