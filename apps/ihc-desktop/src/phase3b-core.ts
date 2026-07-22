export const WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_WORKSPACE_PROJECTS = 256;
export const MAX_WORKSPACE_TABS = 128;
export const MAX_OPAQUE_ID_BYTES = 256;
export const MAX_WORKSPACE_NAME_BYTES = 4 * 1024;
export const MAX_WORKSPACE_PATH_BYTES = 32 * 1024;
export const MAX_BROWSER_URL_BYTES = 16 * 1024;

export type WorkspaceKnownTabKind = "empty" | "project" | "browser" | "output";
export type WorkspaceAccessMode =
  | "ready"
  | "readOnly"
  | "recoveryPreview"
  | "recoveryRequired"
  | "importPreview"
  | "unsupportedVersion";
export type WorkspaceSavePhase = "idle" | "saving" | "revisionConflict";

export type WorkspaceTerminal = {
  [key: string]: unknown;
  id: string;
  name: string;
  startDirectory: string;
  codexThreadId: string | null;
  grokSessionId: string | null;
  createdAtUtc: string | null;
  completionPending: boolean;
  legacyExtensions: Record<string, unknown>;
};

export type WorkspaceProject = {
  [key: string]: unknown;
  id: string;
  name: string;
  folderPath: string;
  lastModifiedAtUtc: string | null;
  terminals: WorkspaceTerminal[];
  paneWidthRatios: Record<string, number[]>;
  legacyExtensions: Record<string, unknown>;
};

export type WorkspaceBrowserState = {
  [key: string]: unknown;
  url: string;
};

export type WorkspaceOutputState = {
  [key: string]: unknown;
  mode: "auto";
  relativeEntry: string | null;
};

export type WorkspaceTab = {
  [key: string]: unknown;
  id: string;
  kind: string;
  title: string;
  projectId: string | null;
  browser: WorkspaceBrowserState | Record<string, unknown> | null;
  output: WorkspaceOutputState | Record<string, unknown> | null;
  extensions: Record<string, unknown>;
};

export type ImportProvenance = {
  [key: string]: unknown;
  sourceFormat: "powerWorkspace.projects/1" | "ihatecoding.phase3-preview/1";
  sourceSha256: string;
  snapshotFile: string;
  importedAtUtc: string;
};

export type WorkspaceState = {
  [key: string]: unknown;
  schemaVersion: 1;
  revision: number;
  writtenAtUtc: string;
  selectedProjectId: string | null;
  projects: WorkspaceProject[];
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  importProvenance: ImportProvenance | null;
  extensions: Record<string, unknown>;
  legacyExtensions: Record<string, unknown>;
};

export type MutableWorkspaceState = {
  [key: string]: unknown;
  schemaVersion: 1;
  selectedProjectId: string | null;
  projects: WorkspaceProject[];
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  extensions: Record<string, unknown>;
  legacyExtensions: Record<string, unknown>;
};

export type WorkspaceSnapshot = {
  revision: number;
  state: WorkspaceState;
};

export type WorkspaceRecovery = Record<string, unknown>;

export type WorkspaceLoadResult =
  | {
      kind: "ready" | "recoveryPreview";
      snapshot: WorkspaceSnapshot;
      recovery: WorkspaceRecovery | null;
    }
  | {
      kind: "recoveryRequired";
      revision: null;
      recovery: WorkspaceRecovery;
    }
  | {
      kind: "unsupportedVersion";
      schemaVersion: number;
      revision: number | null;
      rawState: unknown;
      recovery: WorkspaceRecovery | null;
    };

export type StorageErrorCode =
  | "busy"
  | "io"
  | "invalidSource"
  | "sourceChanged"
  | "tooLarge"
  | "invalidState"
  | "unsupportedVersion"
  | "revisionConflict"
  | "readOnly"
  | "recoveryRequired"
  | "pathDenied";

export type StorageCommandError = {
  [key: string]: unknown;
  code: StorageErrorCode;
  message: string;
  retryable: boolean;
  jsonPointer: string | null;
};

export type RevisionConflict = {
  expectedRevision: number;
  latestRevision: number | null;
};

export type WorkspaceSession = {
  access: WorkspaceAccessMode;
  phase: WorkspaceSavePhase;
  snapshot: WorkspaceSnapshot | null;
  draft: WorkspaceState | null;
  dirty: boolean;
  inFlightExpectedRevision: number | null;
  lastError: StorageCommandError | null;
  conflict: RevisionConflict | null;
  recovery: WorkspaceRecovery | null;
  unsupportedRawState: unknown | null;
};

export type SaveWorkspaceRequest = {
  expectedRevision: number;
  state: MutableWorkspaceState;
};

export type SaveWorkspaceResponse = {
  [key: string]: unknown;
  revision: number;
  writtenAtUtc: string;
};

export type WorkspaceTabActivation =
  | { kind: "empty"; tabId: string }
  | { kind: "project"; tabId: string; projectId: string }
  | {
      kind: "browser";
      tabId: string;
      projectId: string | null;
      url: string;
      restore: "lazy";
    }
  | {
      kind: "output";
      tabId: string;
      projectId: string;
      mode: "auto";
      relativeEntry: string | null;
      restore: "lazy";
    }
  | { kind: "unsupported"; tabId: string; persistedKind: string };

export type AgentResumeConflict = {
  provider: "codex" | "grok";
  owners: Array<{ projectId: string; terminalId: string }>;
};

const KNOWN_TAB_KINDS = new Set<WorkspaceKnownTabKind>([
  "empty",
  "project",
  "browser",
  "output",
]);
const STORAGE_ERROR_CODES = new Set<StorageErrorCode>([
  "busy",
  "io",
  "invalidSource",
  "sourceChanged",
  "tooLarge",
  "invalidState",
  "unsupportedVersion",
  "revisionConflict",
  "readOnly",
  "recoveryRequired",
  "pathDenied",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PANE_RATIO_KEY_PATTERN = /^([1-5])x([1-9]\d*):row-(0|[1-9]\d*)$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

export class WorkspaceValidationError extends Error {
  readonly code = "invalidState" as const;

  constructor(
    message: string,
    readonly jsonPointer: string | null,
  ) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

export type PaneRatioLayoutKey = Readonly<{
  columns: number;
  rows: number;
  row: number;
}>;

/** Parse a canonical active layout key without imposing a fixed row limit. */
export function parsePaneRatioLayoutKey(key: string): PaneRatioLayoutKey | null {
  const match = PANE_RATIO_KEY_PATTERN.exec(key);
  if (!match) return null;
  const columns = Number(match[1]);
  const rows = Number(match[2]);
  const row = Number(match[3]);
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(row) || row >= rows) {
    return null;
  }
  return { columns, rows, row };
}

export function normalizeWorkspaceLoadResponse(value: unknown): WorkspaceLoadResult {
  const envelope = cloneJsonRecord(requireRecord(value, "workspace load response", null));
  requireOwn(envelope, "state", "/state");
  requireOwn(envelope, "revision", "/revision");
  requireOwn(envelope, "recovery", "/recovery");
  const recovery = normalizeRecovery(envelope.recovery, "/recovery");

  if (envelope.state === null) {
    if (envelope.revision !== null || recovery === null) {
      fail("A missing workspace state requires recovery mode and no revision.", "/state");
    }
    return { kind: "recoveryRequired", revision: null, recovery };
  }

  const rawState = requireRecord(envelope.state, "workspace state", "/state");
  const schemaVersion = requireSchemaVersionNumber(rawState.schemaVersion, "/state/schemaVersion");
  if (schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    const revision =
      envelope.revision === null
        ? null
        : requireRevision(envelope.revision, "/revision");
    return {
      kind: "unsupportedVersion",
      schemaVersion,
      revision,
      rawState: cloneJsonValue(rawState),
      recovery,
    };
  }
  if (schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    fail("The workspace schema version is not supported.", "/state/schemaVersion");
  }

  const revision = requireRevision(envelope.revision, "/revision");
  const state = normalizeWorkspaceState(rawState);
  if (state.revision !== revision) {
    fail("The workspace envelope and state revisions do not match.", "/revision");
  }
  const snapshot = { revision, state };
  return recovery === null
    ? { kind: "ready", snapshot, recovery: null }
    : { kind: "recoveryPreview", snapshot, recovery };
}

export function normalizeWorkspaceState(value: unknown): WorkspaceState {
  const state = cloneJsonRecord(requireRecord(value, "workspace state", null));
  const schemaVersion = requireSchemaVersionNumber(state.schemaVersion, "/schemaVersion");
  if (schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    fail("The workspace schema version is not supported.", "/schemaVersion");
  }
  const revision = requireRevision(state.revision, "/revision");
  const writtenAtUtc = requireRfc3339(state.writtenAtUtc, "/writtenAtUtc");
  const projectsSource = requireArray(state.projects, "/projects");
  if (projectsSource.length > MAX_WORKSPACE_PROJECTS) {
    fail("The workspace contains too many projects.", "/projects");
  }

  const projects = projectsSource.map((project, index) =>
    normalizeProject(project, index),
  );
  const projectIds = new Set<string>();
  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    if (projectIds.has(project.id)) {
      fail("A project identifier is duplicated.", `/projects/${index}/id`);
    }
    projectIds.add(project.id);
  }

  const selectedProjectId = requireNullableOpaqueId(
    state.selectedProjectId,
    "/selectedProjectId",
  );
  if (selectedProjectId !== null && !projectIds.has(selectedProjectId)) {
    fail("The selected project reference is not present.", "/selectedProjectId");
  }

  const tabsSource = requireArray(state.tabs, "/tabs");
  if (tabsSource.length > MAX_WORKSPACE_TABS) {
    fail("The workspace contains too many tabs.", "/tabs");
  }
  const tabs = tabsSource.map((tab, index) => normalizeTab(tab, index, projectIds));
  const tabIds = new Set<string>();
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (tabIds.has(tab.id)) {
      fail("A tab identifier is duplicated.", `/tabs/${index}/id`);
    }
    tabIds.add(tab.id);
  }

  const activeTabId = requireNullableOpaqueId(state.activeTabId, "/activeTabId");
  if (tabs.length === 0 && activeTabId !== null) {
    fail("An empty tab list cannot have an active tab.", "/activeTabId");
  }
  if (tabs.length > 0 && (activeTabId === null || !tabIds.has(activeTabId))) {
    fail("The active tab reference is not present.", "/activeTabId");
  }

  requireOwn(state, "importProvenance", "/importProvenance");
  const importProvenance = normalizeImportProvenance(
    state.importProvenance,
    "/importProvenance",
  );
  const extensions = cloneRequiredRecord(state.extensions, "/extensions");
  const legacyExtensions = cloneRequiredRecord(
    state.legacyExtensions,
    "/legacyExtensions",
  );

  return {
    ...cloneJsonRecord(state),
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision,
    writtenAtUtc,
    selectedProjectId,
    projects,
    tabs,
    activeTabId,
    importProvenance,
    extensions,
    legacyExtensions,
  };
}

export function cloneWorkspaceState(state: WorkspaceState): WorkspaceState {
  return cloneJsonValue(state) as WorkspaceState;
}

export function createWorkspaceSession(
  load: WorkspaceLoadResult,
  requestedAccess: "ready" | "readOnly" | "importPreview" = "ready",
): WorkspaceSession {
  if (load.kind === "unsupportedVersion") {
    return {
      access: "unsupportedVersion",
      phase: "idle",
      snapshot: null,
      draft: null,
      dirty: false,
      inFlightExpectedRevision: null,
      lastError: null,
      conflict: null,
      recovery: cloneNullableRecord(load.recovery),
      unsupportedRawState: cloneJsonValue(load.rawState),
    };
  }
  if (load.kind === "recoveryRequired") {
    return {
      access: "recoveryRequired",
      phase: "idle",
      snapshot: null,
      draft: null,
      dirty: false,
      inFlightExpectedRevision: null,
      lastError: null,
      conflict: null,
      recovery: cloneJsonRecord(load.recovery),
      unsupportedRawState: null,
    };
  }

  const snapshot = cloneSnapshot(load.snapshot);
  const access =
    load.kind === "recoveryPreview"
      ? "recoveryPreview"
      : requestedAccess === "ready"
        ? "ready"
        : requestedAccess;
  return {
    access,
    phase: "idle",
    snapshot,
    draft: cloneWorkspaceState(snapshot.state),
    dirty: false,
    inFlightExpectedRevision: null,
    lastError: null,
    conflict: null,
    recovery: cloneNullableRecord(load.recovery),
    unsupportedRawState: null,
  };
}

export function createImportPreviewSession(snapshotValue: unknown): WorkspaceSession {
  const snapshotRecord = cloneJsonRecord(
    requireRecord(snapshotValue, "workspace snapshot", null),
  );
  const revision = requireRevision(snapshotRecord.revision, "/revision");
  const state = normalizeWorkspaceState(snapshotRecord.state);
  if (revision !== state.revision) {
    fail("The workspace snapshot revisions do not match.", "/revision");
  }
  return createWorkspaceSession(
    { kind: "ready", snapshot: { revision, state }, recovery: null },
    "importPreview",
  );
}

export function replaceWorkspaceDraft(
  session: WorkspaceSession,
  nextStateValue: unknown,
): WorkspaceSession {
  assertEditable(session);
  const snapshot = requireSessionSnapshot(session);
  const nextState = normalizeWorkspaceState(nextStateValue);
  assertBackendOwnedFieldsUnchanged(snapshot.state, nextState);
  return {
    ...session,
    draft: nextState,
    dirty: !jsonValuesEqual(nextState, snapshot.state),
    lastError: null,
    conflict: null,
  };
}

export function beginWorkspaceSave(session: WorkspaceSession): {
  session: WorkspaceSession;
  request: SaveWorkspaceRequest;
} {
  assertEditable(session);
  if (!session.dirty) {
    throw new Error("The workspace has no pending mutation to save.");
  }
  const snapshot = requireSessionSnapshot(session);
  const draft = requireSessionDraft(session);
  const expectedRevision = snapshot.revision;
  const request = createSaveWorkspaceRequest(draft, expectedRevision);
  return {
    session: {
      ...session,
      phase: "saving",
      inFlightExpectedRevision: expectedRevision,
      lastError: null,
      conflict: null,
    },
    request,
  };
}

export function createSaveWorkspaceRequest(
  stateValue: unknown,
  expectedRevisionValue?: unknown,
): SaveWorkspaceRequest {
  const state = normalizeWorkspaceState(stateValue);
  const expectedRevision = requireRevision(
    expectedRevisionValue === undefined ? state.revision : expectedRevisionValue,
    "/expectedRevision",
  );
  if (state.revision !== expectedRevision) {
    fail("The save base revision does not match the workspace draft.", "/expectedRevision");
  }
  const mutable = cloneJsonRecord(state);
  delete mutable.revision;
  delete mutable.writtenAtUtc;
  delete mutable.importProvenance;
  return {
    expectedRevision,
    state: mutable as MutableWorkspaceState,
  };
}

export function applyWorkspaceSaveSuccess(
  session: WorkspaceSession,
  responseValue: unknown,
): WorkspaceSession {
  if (session.phase !== "saving" || session.inFlightExpectedRevision === null) {
    throw new Error("A save success requires one in-flight workspace save.");
  }
  const response = normalizeSaveWorkspaceResponse(responseValue);
  if (response.revision <= session.inFlightExpectedRevision) {
    fail("A committed workspace revision must advance monotonically.", "/revision");
  }
  const priorSnapshot = requireSessionSnapshot(session);
  const draft = requireSessionDraft(session);
  const committed = normalizeWorkspaceState({
    ...cloneJsonRecord(draft),
    revision: response.revision,
    writtenAtUtc: response.writtenAtUtc,
    importProvenance: cloneJsonValue(priorSnapshot.state.importProvenance),
  });
  const snapshot = { revision: response.revision, state: committed };
  return {
    ...session,
    access: "ready",
    phase: "idle",
    snapshot,
    draft: cloneWorkspaceState(committed),
    dirty: false,
    inFlightExpectedRevision: null,
    lastError: null,
    conflict: null,
    recovery: null,
  };
}

export function applyWorkspaceSaveError(
  session: WorkspaceSession,
  errorValue: unknown,
): WorkspaceSession {
  if (session.phase !== "saving" || session.inFlightExpectedRevision === null) {
    throw new Error("A save error requires one in-flight workspace save.");
  }
  const error = normalizeStorageCommandError(errorValue);
  const expectedRevision = session.inFlightExpectedRevision;
  if (error.code === "revisionConflict") {
    const latestRevision = optionalSafeRevision(error.currentRevision);
    return {
      ...session,
      phase: "revisionConflict",
      dirty: true,
      inFlightExpectedRevision: null,
      lastError: error,
      conflict: { expectedRevision, latestRevision },
    };
  }

  const access =
    error.code === "readOnly"
      ? "readOnly"
      : error.code === "recoveryRequired"
        ? "recoveryRequired"
        : error.code === "unsupportedVersion"
          ? "unsupportedVersion"
          : session.access;
  return {
    ...session,
    access,
    phase: "idle",
    dirty: true,
    inFlightExpectedRevision: null,
    lastError: error,
    conflict: null,
  };
}

export function resolveRevisionConflictByReload(
  session: WorkspaceSession,
  load: WorkspaceLoadResult,
): { session: WorkspaceSession; discardedLocalDraft: WorkspaceState } {
  if (session.phase !== "revisionConflict" || session.conflict === null) {
    throw new Error("A reload resolution requires a revision conflict.");
  }
  if (load.kind !== "ready") {
    throw new Error("A revision conflict can only resolve to a writable current snapshot.");
  }
  if (load.snapshot.revision <= session.conflict.expectedRevision) {
    throw new Error("The reloaded revision does not supersede the conflicted revision.");
  }
  const discardedLocalDraft = cloneWorkspaceState(requireSessionDraft(session));
  return {
    session: createWorkspaceSession(load),
    discardedLocalDraft,
  };
}

export function normalizeStorageCommandError(value: unknown): StorageCommandError {
  const error = cloneJsonRecord(requireRecord(value, "storage error", null));
  const code = requireString(error.code, "/code");
  if (!STORAGE_ERROR_CODES.has(code as StorageErrorCode)) {
    fail("The storage error code is not supported.", "/code");
  }
  const message = requireString(error.message, "/message");
  const retryable = requireBoolean(error.retryable, "/retryable");
  const jsonPointer = requireNullableString(error.jsonPointer, "/jsonPointer");
  return {
    ...cloneJsonRecord(error),
    code: code as StorageErrorCode,
    message,
    retryable,
    jsonPointer,
  };
}

export function normalizeSaveWorkspaceResponse(value: unknown): SaveWorkspaceResponse {
  const response = cloneJsonRecord(requireRecord(value, "workspace save response", null));
  return {
    ...cloneJsonRecord(response),
    revision: requireRevision(response.revision, "/revision"),
    writtenAtUtc: requireRfc3339(response.writtenAtUtc, "/writtenAtUtc"),
  };
}

export function setTerminalCompletionPending(
  state: WorkspaceState,
  projectId: string,
  terminalId: string,
  completionPending: boolean,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = cloneWorkspaceState(normalizeWorkspaceState(state));
  const project = next.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("The requested workspace terminal does not exist.");
  const terminal = project.terminals.find((item) => item.id === terminalId);
  if (!terminal) throw new Error("The requested workspace terminal does not exist.");
  terminal.completionPending = completionPending;
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function setProjectPaneWidthRatios(
  state: WorkspaceState,
  projectId: string,
  key: string,
  ratios: number[],
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = cloneWorkspaceState(normalizeWorkspaceState(state));
  const project = next.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("The requested workspace project does not exist.");
  const normalizedEntry = normalizeApplicableRatioEntry(key, ratios, "/paneWidthRatios");
  if (normalizedEntry === null) {
    throw new Error("Only an applicable pane ratio key can be edited.");
  }
  project.paneWidthRatios[key] = normalizedEntry;
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function projectUnreadCount(state: WorkspaceState, projectId: string): number {
  const project = state.projects.find((item) => item.id === projectId);
  return project?.terminals.filter((terminal) => terminal.completionPending).length ?? 0;
}

export function workspaceUnreadCounts(state: WorkspaceState): Record<string, number> {
  return Object.fromEntries(
    state.projects.map((project) => [
      project.id,
      project.terminals.filter((terminal) => terminal.completionPending).length,
    ]),
  );
}

export function describeWorkspaceTabActivation(
  state: WorkspaceState,
  tabId: string,
): WorkspaceTabActivation {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) throw new Error("The requested workspace tab does not exist.");
  switch (tab.kind) {
    case "empty":
      return { kind: "empty", tabId: tab.id };
    case "project":
      return { kind: "project", tabId: tab.id, projectId: tab.projectId as string };
    case "browser":
      return {
        kind: "browser",
        tabId: tab.id,
        projectId: tab.projectId,
        url: (tab.browser as WorkspaceBrowserState).url,
        restore: "lazy",
      };
    case "output": {
      const output = tab.output as WorkspaceOutputState;
      return {
        kind: "output",
        tabId: tab.id,
        projectId: tab.projectId as string,
        mode: output.mode,
        relativeEntry: output.relativeEntry,
        restore: "lazy",
      };
    }
    default:
      return { kind: "unsupported", tabId: tab.id, persistedKind: tab.kind };
  }
}

export function deriveAgentResumeConflicts(state: WorkspaceState): AgentResumeConflict[] {
  const ownership = new Map<
    string,
    { provider: "codex" | "grok"; owners: Array<{ projectId: string; terminalId: string }> }
  >();
  for (const project of state.projects) {
    for (const terminal of project.terminals) {
      for (const [provider, value] of [
        ["codex", terminal.codexThreadId],
        ["grok", terminal.grokSessionId],
      ] as const) {
        if (value === null) continue;
        const key = `${provider}:${value.toLowerCase()}`;
        const entry = ownership.get(key) ?? { provider, owners: [] };
        entry.owners.push({ projectId: project.id, terminalId: terminal.id });
        ownership.set(key, entry);
      }
    }
  }
  return [...ownership.values()]
    .filter((entry) => entry.owners.length > 1)
    .map((entry) => ({
      provider: entry.provider,
      owners: entry.owners.map((owner) => ({ ...owner })),
    }));
}

export function isKnownWorkspaceTabKind(kind: string): kind is WorkspaceKnownTabKind {
  return KNOWN_TAB_KINDS.has(kind as WorkspaceKnownTabKind);
}

function normalizeProject(value: unknown, index: number): WorkspaceProject {
  const pointer = `/projects/${index}`;
  const project = requireRecord(value, "project", pointer);
  const terminalsSource = requireArray(project.terminals, `${pointer}/terminals`);
  const terminals = terminalsSource.map((terminal, terminalIndex) =>
    normalizeTerminal(terminal, `${pointer}/terminals/${terminalIndex}`),
  );
  const terminalIds = new Set<string>();
  for (let terminalIndex = 0; terminalIndex < terminals.length; terminalIndex += 1) {
    if (terminalIds.has(terminals[terminalIndex].id)) {
      fail(
        "A terminal identifier is duplicated within its project.",
        `${pointer}/terminals/${terminalIndex}/id`,
      );
    }
    terminalIds.add(terminals[terminalIndex].id);
  }
  return {
    ...cloneJsonRecord(project),
    id: requireOpaqueId(project.id, `${pointer}/id`),
    name: requireBoundedNonEmptyString(
      project.name,
      `${pointer}/name`,
      MAX_WORKSPACE_NAME_BYTES,
    ),
    folderPath: requireBoundedNonEmptyString(
      project.folderPath,
      `${pointer}/folderPath`,
      MAX_WORKSPACE_PATH_BYTES,
    ),
    lastModifiedAtUtc: requireNullableRfc3339(
      project.lastModifiedAtUtc === undefined ? null : project.lastModifiedAtUtc,
      `${pointer}/lastModifiedAtUtc`,
    ),
    terminals,
    paneWidthRatios: normalizePaneWidthRatios(
      project.paneWidthRatios,
      `${pointer}/paneWidthRatios`,
    ),
    legacyExtensions: cloneRequiredRecord(
      project.legacyExtensions,
      `${pointer}/legacyExtensions`,
    ),
  };
}

function normalizeTerminal(value: unknown, pointer: string): WorkspaceTerminal {
  const terminal = requireRecord(value, "terminal", pointer);
  return {
    ...cloneJsonRecord(terminal),
    id: requireOpaqueId(terminal.id, `${pointer}/id`),
    name: requireBoundedNonEmptyString(
      terminal.name,
      `${pointer}/name`,
      MAX_WORKSPACE_NAME_BYTES,
    ),
    startDirectory: requireBoundedNonEmptyString(
      terminal.startDirectory,
      `${pointer}/startDirectory`,
      MAX_WORKSPACE_PATH_BYTES,
    ),
    codexThreadId: requireNullableUuid(
      terminal.codexThreadId,
      `${pointer}/codexThreadId`,
    ),
    grokSessionId: requireNullableUuid(
      terminal.grokSessionId,
      `${pointer}/grokSessionId`,
    ),
    createdAtUtc: requireNullableRfc3339(
      terminal.createdAtUtc,
      `${pointer}/createdAtUtc`,
    ),
    completionPending: requireBoolean(
      terminal.completionPending,
      `${pointer}/completionPending`,
    ),
    legacyExtensions: cloneRequiredRecord(
      terminal.legacyExtensions,
      `${pointer}/legacyExtensions`,
    ),
  };
}

function normalizeTab(
  value: unknown,
  index: number,
  projectIds: ReadonlySet<string>,
): WorkspaceTab {
  const pointer = `/tabs/${index}`;
  const tab = requireRecord(value, "tab", pointer);
  const kind = requireOpaqueId(tab.kind, `${pointer}/kind`);
  const projectId = requireNullableOpaqueId(tab.projectId, `${pointer}/projectId`);
  if (projectId !== null && !projectIds.has(projectId)) {
    fail("The tab project reference is not present.", `${pointer}/projectId`);
  }
  const extensions = cloneRequiredRecord(tab.extensions, `${pointer}/extensions`);
  const cloned = cloneJsonRecord(tab);

  if (!isKnownWorkspaceTabKind(kind)) {
    return {
      ...cloned,
      id: requireOpaqueId(tab.id, `${pointer}/id`),
      kind,
      title: requireBoundedNonEmptyString(
        tab.title,
        `${pointer}/title`,
        MAX_WORKSPACE_NAME_BYTES,
      ),
      projectId,
      browser: normalizeUnknownNullableRecord(tab.browser, `${pointer}/browser`),
      output: normalizeUnknownNullableRecord(tab.output, `${pointer}/output`),
      extensions,
    };
  }

  const common = {
    ...cloned,
    id: requireOpaqueId(tab.id, `${pointer}/id`),
    kind,
    title: requireBoundedNonEmptyString(
      tab.title,
      `${pointer}/title`,
      MAX_WORKSPACE_NAME_BYTES,
    ),
    projectId,
    extensions,
  };
  switch (kind) {
    case "empty":
      requireAllNull(tab, pointer, ["projectId", "browser", "output"]);
      return { ...common, projectId: null, browser: null, output: null };
    case "project":
      if (projectId === null) {
        fail("A project tab requires a project reference.", `${pointer}/projectId`);
      }
      requireAllNull(tab, pointer, ["browser", "output"]);
      return { ...common, projectId, browser: null, output: null };
    case "browser": {
      if (tab.output !== null) {
        fail("A browser tab cannot contain output state.", `${pointer}/output`);
      }
      const browser = normalizeBrowser(tab.browser, `${pointer}/browser`);
      return { ...common, projectId, browser, output: null };
    }
    case "output": {
      if (projectId === null) {
        fail("An output tab requires a project reference.", `${pointer}/projectId`);
      }
      if (tab.browser !== null) {
        fail("An output tab cannot contain browser state.", `${pointer}/browser`);
      }
      const output = normalizeOutput(tab.output, `${pointer}/output`);
      return { ...common, projectId, browser: null, output };
    }
  }
}

function normalizeBrowser(value: unknown, pointer: string): WorkspaceBrowserState {
  const browser = requireRecord(value, "browser tab state", pointer);
  const url = requireString(browser.url, `${pointer}/url`);
  if (utf8ByteLength(url) > MAX_BROWSER_URL_BYTES) {
    fail("The browser URL is too long for restore.", `${pointer}/url`);
  }
  if (!isRestorableBrowserUrl(url)) {
    fail("The browser URL is not allowed for restore.", `${pointer}/url`);
  }
  return { ...cloneJsonRecord(browser), url };
}

function normalizeOutput(value: unknown, pointer: string): WorkspaceOutputState {
  const output = requireRecord(value, "output tab state", pointer);
  if (output.mode !== "auto") {
    fail("The output mode is not supported.", `${pointer}/mode`);
  }
  const relativeEntry = requireNullableString(
    output.relativeEntry,
    `${pointer}/relativeEntry`,
  );
  if (
    relativeEntry !== null &&
    (utf8ByteLength(relativeEntry) > MAX_WORKSPACE_PATH_BYTES ||
      !isSafeRelativeEntry(relativeEntry))
  ) {
    fail("The output entry must remain relative to its project.", `${pointer}/relativeEntry`);
  }
  return { ...cloneJsonRecord(output), mode: "auto", relativeEntry };
}

function normalizeImportProvenance(
  value: unknown,
  pointer: string,
): ImportProvenance | null {
  if (value === null) return null;
  const provenance = requireRecord(value, "import provenance", pointer);
  if (
    provenance.sourceFormat !== "powerWorkspace.projects/1" &&
    provenance.sourceFormat !== "ihatecoding.phase3-preview/1"
  ) {
    fail("The import source format is not supported.", `${pointer}/sourceFormat`);
  }
  const sourceFormat = provenance.sourceFormat;
  const sourceSha256 = requireString(provenance.sourceSha256, `${pointer}/sourceSha256`);
  if (!SHA256_PATTERN.test(sourceSha256)) {
    fail("The import source digest is invalid.", `${pointer}/sourceSha256`);
  }
  const snapshotFile = requireString(provenance.snapshotFile, `${pointer}/snapshotFile`);
  if (snapshotFile !== `${sourceSha256}.projects.json`) {
    fail("The import snapshot identity is invalid.", `${pointer}/snapshotFile`);
  }
  return {
    ...cloneJsonRecord(provenance),
    sourceFormat,
    sourceSha256,
    snapshotFile,
    importedAtUtc: requireRfc3339(
      provenance.importedAtUtc,
      `${pointer}/importedAtUtc`,
    ),
  };
}

function normalizePaneWidthRatios(
  value: unknown,
  pointer: string,
): Record<string, number[]> {
  const ratios = requireRecord(value, "pane width ratios", pointer);
  const normalized: Array<[string, number[]]> = [];
  for (const [key, entry] of Object.entries(ratios)) {
    const applicable = normalizeApplicableRatioEntry(key, entry, pointer);
    normalized.push([
      key,
      applicable ?? normalizeRetainedRatioEntry(entry, pointer),
    ]);
  }
  return Object.fromEntries(normalized);
}

function normalizeRetainedRatioEntry(value: unknown, pointer: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
    fail("A retained pane ratio vector has an invalid length.", pointer);
  }
  return value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
      fail("A retained pane ratio must be finite and positive.", pointer);
    }
    return entry;
  });
}

function normalizeApplicableRatioEntry(
  key: string,
  value: unknown,
  pointer: string,
): number[] | null {
  const layout = parsePaneRatioLayoutKey(key);
  if (!layout) return null;
  const { columns } = layout;
  if (!Array.isArray(value) || value.length !== columns) {
    fail("An applicable pane ratio vector has the wrong length.", pointer);
  }
  const values = value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
      fail("An applicable pane ratio must be finite and positive.", pointer);
    }
    return entry;
  });
  const sum = values.reduce((total, entry) => total + entry, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    fail("An applicable pane ratio sum is invalid.", pointer);
  }
  return values.map((entry) => entry / sum);
}

function isRestorableBrowserUrl(value: string): boolean {
  if (value.toLowerCase() === "about:blank") return true;
  if ([...value].some((character) => isWhitespaceOrControl(character))) return false;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority?.includes("@")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.hostname !== ""
  );
}

function isSafeRelativeEntry(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes(":")
  ) {
    return false;
  }
  const segments = normalized.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function assertEditable(session: WorkspaceSession) {
  if (session.access !== "ready") {
    throw new Error(`Workspace access mode ${session.access} is read-only.`);
  }
  if (session.phase !== "idle") {
    throw new Error(`Workspace save phase ${session.phase} does not allow mutation.`);
  }
  requireSessionSnapshot(session);
  requireSessionDraft(session);
}

function assertBackendOwnedFieldsUnchanged(previous: WorkspaceState, next: WorkspaceState) {
  if (
    previous.revision !== next.revision ||
    previous.writtenAtUtc !== next.writtenAtUtc ||
    !jsonValuesEqual(previous.importProvenance, next.importProvenance)
  ) {
    throw new Error("Backend-owned workspace fields cannot be changed by the frontend.");
  }
}

function requireSessionSnapshot(session: WorkspaceSession): WorkspaceSnapshot {
  if (session.snapshot === null) throw new Error("The workspace session has no snapshot.");
  return session.snapshot;
}

function requireSessionDraft(session: WorkspaceSession): WorkspaceState {
  if (session.draft === null) throw new Error("The workspace session has no draft.");
  return session.draft;
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return { revision: snapshot.revision, state: cloneWorkspaceState(snapshot.state) };
}

function normalizeRecovery(value: unknown, pointer: string): WorkspaceRecovery | null {
  if (value === null) return null;
  return cloneRequiredRecord(value, pointer);
}

function cloneNullableRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return value === null ? null : cloneJsonRecord(value);
}

function normalizeUnknownNullableRecord(
  value: unknown,
  pointer: string,
): Record<string, unknown> | null {
  if (value === null) return null;
  return cloneRequiredRecord(value, pointer);
}

function requireAllNull(
  value: Record<string, unknown>,
  pointer: string,
  keys: string[],
) {
  for (const key of keys) {
    if (value[key] !== null) fail("The tab contains incompatible state.", `${pointer}/${key}`);
  }
}

function requireRevision(value: unknown, pointer: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("The workspace revision must be a non-negative safe integer.", pointer);
  }
  return value;
}

function optionalSafeRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function requireSchemaVersionNumber(value: unknown, pointer: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("The workspace schema version must be a positive safe integer.", pointer);
  }
  return value;
}

function requireOpaqueId(value: unknown, pointer: string): string {
  const id = requireNonEmptyString(value, pointer);
  if (id.includes("\0") || utf8ByteLength(id) > MAX_OPAQUE_ID_BYTES) {
    fail("An opaque identifier is invalid or too long.", pointer);
  }
  return id;
}

function requireNullableOpaqueId(value: unknown, pointer: string): string | null {
  return value === null ? null : requireOpaqueId(value, pointer);
}

function requireNullableUuid(value: unknown, pointer: string): string | null {
  if (value === null) return null;
  const id = requireString(value, pointer);
  if (!UUID_PATTERN.test(id)) fail("An agent identifier is not a valid UUID.", pointer);
  return id;
}

function requireRfc3339(value: unknown, pointer: string): string {
  const timestamp = requireString(value, pointer);
  if (!isRfc3339(timestamp)) fail("The timestamp is not RFC 3339.", pointer);
  return timestamp;
}

function requireNullableRfc3339(value: unknown, pointer: string): string | null {
  return value === null ? null : requireRfc3339(value, pointer);
}

function isRfc3339(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function requireBoolean(value: unknown, pointer: string): boolean {
  if (typeof value !== "boolean") fail("The field must be a boolean.", pointer);
  return value;
}

function requireNonEmptyString(value: unknown, pointer: string): string {
  const text = requireString(value, pointer);
  if (text.trim() === "") fail("The field must not be empty.", pointer);
  return text;
}

function requireBoundedNonEmptyString(
  value: unknown,
  pointer: string,
  maxBytes: number,
): string {
  const text = requireNonEmptyString(value, pointer);
  if (text.includes("\0") || utf8ByteLength(text) > maxBytes) {
    fail("The text field is invalid or too long.", pointer);
  }
  return text;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isWhitespaceOrControl(value: string): boolean {
  if (/\s/u.test(value)) return true;
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function requireString(value: unknown, pointer: string): string {
  if (typeof value !== "string") fail("The field must be a string.", pointer);
  return value;
}

function requireNullableString(value: unknown, pointer: string): string | null {
  if (value === null) return null;
  return requireString(value, pointer);
}

function requireArray(value: unknown, pointer: string): unknown[] {
  if (!Array.isArray(value)) fail("The field must be an array.", pointer);
  return value;
}

function cloneRequiredRecord(value: unknown, pointer: string): Record<string, unknown> {
  return cloneJsonRecord(requireRecord(value, "object", pointer));
}

function requireRecord(
  value: unknown,
  label: string,
  pointer: string | null,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`The ${label} must be an object.`, pointer);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`The ${label} must be a plain JSON object.`, pointer);
  }
  return value as Record<string, unknown>;
}

function requireOwn(value: Record<string, unknown>, key: string, pointer: string) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail("A required field is missing.", pointer);
  }
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonValue(value) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown, stack = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("A JSON number must be finite.", null);
    return value;
  }
  if (typeof value !== "object") fail("The value is not JSON-compatible.", null);
  if (stack.has(value)) fail("The value contains a cycle.", null);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        fail("A JSON array cannot contain symbol properties.", null);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          fail("A JSON array cannot contain holes.", null);
        }
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          fail("A JSON array contains a non-data property.", null);
        }
      }
      const ownNames = Object.getOwnPropertyNames(value);
      if (ownNames.some((key) => key !== "length" && !/^\d+$/.test(key))) {
        fail("A JSON array cannot contain named properties.", null);
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        return cloneJsonValue(descriptor?.value, stack);
      });
    }
    const record = requireRecord(value, "JSON value", null);
    const names = Object.getOwnPropertyNames(record);
    const entries: Array<[string, unknown]> = [];
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
        fail("A JSON object contains a non-data property.", null);
      }
      entries.push([key, cloneJsonValue(descriptor.value, stack)]);
    }
    if (Object.getOwnPropertySymbols(record).length > 0) {
      fail("A JSON object cannot contain symbol properties.", null);
    }
    return Object.fromEntries(entries);
  } finally {
    stack.delete(value);
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      jsonValuesEqual(leftRecord[key], rightRecord[key]),
  );
}

function fail(message: string, jsonPointer: string | null): never {
  throw new WorkspaceValidationError(message, jsonPointer);
}
