import {
  MAX_WORKSPACE_PROJECTS,
  MAX_WORKSPACE_TABS,
  cloneWorkspaceState,
  normalizeWorkspaceState,
  setProjectPaneWidthRatios,
  type WorkspaceProject,
  type WorkspaceState,
  type WorkspaceTab,
  type WorkspaceTerminal,
} from "./phase3b-core";
import { tr } from "./i18n";

export const DEFAULT_MIN_PANE_WIDTH_PX = 160;
export const DEFAULT_INSERTION_HYSTERESIS_PX = 14;
export const DEFAULT_SNAP_DISTANCE_PX = 8;
export const PROJECT_BROWSER_PANES_EXTENSION = "browserPanesV1";
export const PROJECT_EDITOR_PANES_EXTENSION = "editorPanesV1";
export const PROJECT_PANE_ORDER_EXTENSION = "paneOrderV1";
export const TERMINAL_LAUNCH_PROFILE_EXTENSION = "launchProfileV1";
export const LOCAL_BROWSER_RETRY_WINDOW_MS = 5 * 60 * 1_000;

const LOCAL_BROWSER_RETRY_RAMP_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const LOCAL_BROWSER_RETRY_TAIL_MS = 15_000;

const MAX_BROWSER_PANE_TITLE_LENGTH = 80;
const MAX_BROWSER_PANE_URL_BYTES = 16 * 1024;
const MAX_EDITOR_PANE_TITLE_LENGTH = 160;
const MAX_EDITOR_PATH_DEPTH = 64;
const MAX_EDITOR_PATH_SEGMENT_LENGTH = 255;

export type WorkspaceBrowserPane = {
  [key: string]: unknown;
  id: string;
  title: string;
  url: string;
};

export type WorkspaceEditorPane = {
  [key: string]: unknown;
  id: string;
  title: string;
  pathSegments: string[];
};

export type WorkspaceTerminalLaunchProfile =
  | "powershell"
  | "codex"
  | "grok"
  | "claude"
  | "opencode";

export function isLoopbackBrowserUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "localhost" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

/**
 * Returns the delay after the latest failed local-server probe. The first
 * probe is immediate; retries ramp quickly and then settle at one lightweight
 * TCP attempt every 15 seconds until the bounded restore window expires.
 */
export function localBrowserRetryDelayMs(
  failedAttempts: number,
  elapsedMs: number,
): number | null {
  if (!Number.isSafeInteger(failedAttempts) || failedAttempts < 1) return null;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= LOCAL_BROWSER_RETRY_WINDOW_MS) {
    return null;
  }
  return (
    LOCAL_BROWSER_RETRY_RAMP_MS[failedAttempts - 1] ?? LOCAL_BROWSER_RETRY_TAIL_MS
  );
}

export type LinearMoveCommand = "previous" | "next" | "first" | "last";

export type WorkspaceTabAccessibility = {
  id: string;
  role: "tab";
  ariaSelected: boolean;
  tabIndex: 0 | -1;
};

export type Point = {
  x: number;
  y: number;
};

export type PaneGeometry = {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PaneInsertionTarget = {
  /** Stable identity. null means append after every remaining pane. */
  beforePaneId: string | null;
  /** Preview-only index in the order after the dragged pane is removed. */
  index: number;
  anchorX: number;
  anchorY: number;
};

export type PaneInsertionOptions = {
  hysteresisPx?: number;
  rowDistanceWeight?: number;
};

export type HorizontalResizeRequest = {
  ratios: readonly number[];
  dividerIndex: number;
  totalWidthPx: number;
  deltaX: number;
  minPaneWidthPx?: number;
  containerLeftPx?: number;
  siblingEdgesPx?: readonly number[];
  snapDistancePx?: number;
};

export type HorizontalResizeResult = {
  ratios: number[];
  dividerX: number;
  appliedDeltaX: number;
  snappedToPx: number | null;
};

export type ProjectPaneResizeRequest = Omit<HorizontalResizeRequest, "ratios" | "dividerIndex"> & {
  layoutKey: string;
  rowPaneIds: readonly string[];
  leftPaneId: string;
  rightPaneId: string;
};

export type KeyboardResizeCommand = "grow-left" | "shrink-left";
export type WorkspaceAgentProvider = "codex" | "grok";

export function blockWorkspaceProviderResumeForAccountSwitch(
  state: WorkspaceState,
  provider: WorkspaceAgentProvider,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = cloneWorkspaceState(state);
  for (const project of next.projects) {
    let projectChanged = false;
    for (const terminal of project.terminals) {
      const hasBinding =
        provider === "codex"
          ? terminal.codexThreadId !== null
          : terminal.grokSessionId !== null;
      if (hasBinding && terminal.legacyExtensions.resumeBlocked !== true) {
        terminal.legacyExtensions.resumeBlocked = true;
        projectChanged = true;
      }
    }
    if (projectChanged) project.lastModifiedAtUtc = modifiedAtUtc;
  }
  return normalizeWorkspaceState(next);
}

export type WorkspaceProjectDraft = {
  name: string;
  folderPath: string;
};

export type RestoreCapacityDecision = {
  allowed: boolean;
  current: number;
  incoming: number;
  required: number;
  available: number;
  maximum: number;
};

/**
 * One-shot conversion from the legacy automatically-created project tabs to
 * manually assigned tabs. The migration deliberately collapses only the
 * exact legacy shape; any ambiguous/user-authored layout is left untouched.
 */
export function migrateLegacyAutomaticProjectTabsToManual(
  state: WorkspaceState,
): WorkspaceState {
  const next = editableClone(state);
  if (next.legacyExtensions.manualProjectTabsV1 === true) {
    return next;
  }

  next.legacyExtensions.manualProjectTabsV1 = true;
  const projectIds = new Set(next.projects.map((project) => project.id));
  const representedProjectIds = new Set<string>();
  const hasExactLegacyShape =
    next.tabs.length > 0 &&
    next.tabs.length === next.projects.length &&
    next.tabs.every((tab) => {
      if (
        tab.kind !== "project" ||
        tab.projectId === null ||
        !projectIds.has(tab.projectId) ||
        representedProjectIds.has(tab.projectId)
      ) {
        return false;
      }
      representedProjectIds.add(tab.projectId);
      return true;
    }) &&
    representedProjectIds.size === projectIds.size;
  const active = next.tabs.find((tab) => tab.id === next.activeTabId) ?? null;

  if (hasExactLegacyShape && active?.kind === "project" && active.projectId !== null) {
    next.tabs = [active];
    next.activeTabId = active.id;
    next.selectedProjectId = active.projectId;
  }

  return normalizeWorkspaceState(next);
}

/** Add and activate a blank tab. The caller owns ID generation. */
export function addBlankWorkspaceTab(
  state: WorkspaceState,
  tabId: string,
  title = tr("New tab", "새 탭"),
): WorkspaceState {
  const next = editableClone(state);
  if (next.tabs.length >= MAX_WORKSPACE_TABS) {
    throw new Error(`A workspace can contain at most ${MAX_WORKSPACE_TABS} tabs.`);
  }
  assertNewTabId(next, tabId);
  const tab: WorkspaceTab = {
    id: tabId,
    kind: "empty",
    title,
    projectId: null,
    browser: null,
    output: null,
    extensions: {},
  };
  next.tabs.push(tab);
  next.activeTabId = tabId;
  next.selectedProjectId = null;
  return normalizeWorkspaceState(next);
}

/**
 * Assign a project to the current tab without creating a tab implicitly.
 * Explicitly-added blank tabs keep their stable identity, project tabs are
 * reassigned in place, and an already-open project tab is activated as-is.
 */
export function openProjectWorkspaceTab(
  state: WorkspaceState,
  projectId: string,
  _newTabId: string,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const active = next.tabs.find((tab) => tab.id === next.activeTabId) ?? null;
  const existing = next.tabs.find(
    (tab) => tab.kind === "project" && tab.projectId === projectId,
  );

  if (existing) {
    next.activeTabId = existing.id;
  } else if (active?.kind === "empty" || active?.kind === "project") {
    replaceTabWithProject(active, project);
    next.activeTabId = active.id;
  }
  const selected = next.tabs.find((tab) => tab.id === next.activeTabId);
  next.selectedProjectId = selected?.kind === "project" ? selected.projectId : null;
  return normalizeWorkspaceState(next);
}

/** Assign a specific blank tab without changing its stable tab ID. */
export function assignBlankWorkspaceTabToProject(
  state: WorkspaceState,
  tabId: string,
  projectId: string,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const target = next.tabs.find((tab) => tab.id === tabId);
  if (!target) throw new Error("The requested workspace tab does not exist.");
  if (target.kind !== "empty") throw new Error("Only a blank tab can be assigned.");
  const existing = next.tabs.find(
    (tab) => tab.id !== tabId && tab.kind === "project" && tab.projectId === projectId,
  );
  if (existing) {
    next.activeTabId = existing.id;
  } else {
    replaceTabWithProject(target, project);
    next.activeTabId = target.id;
  }
  next.selectedProjectId = projectId;
  return normalizeWorkspaceState(next);
}

/** Activate a tab and keep sidebar project selection consistent with it. */
export function activateWorkspaceTab(
  state: WorkspaceState,
  tabId: string,
): WorkspaceState {
  const next = editableClone(state);
  const tab = next.tabs.find((item) => item.id === tabId);
  if (!tab) throw new Error("The requested workspace tab does not exist.");
  next.activeTabId = tab.id;
  next.selectedProjectId = tab.kind === "project" ? tab.projectId : null;
  return next;
}

/** Close a tab, always leaving one blank tab when the last tab is closed. */
export function closeWorkspaceTab(
  state: WorkspaceState,
  tabId: string,
  replacementTabId: string,
): WorkspaceState {
  const next = editableClone(state);
  const index = next.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) throw new Error("The requested workspace tab does not exist.");
  next.tabs.splice(index, 1);
  if (next.tabs.length === 0) {
    assertOpaqueLocalId(replacementTabId, "replacement tab");
    next.tabs.push({
      id: replacementTabId,
      kind: "empty",
      title: tr("New tab", "새 탭"),
      projectId: null,
      browser: null,
      output: null,
      extensions: {},
    });
    next.activeTabId = replacementTabId;
  } else if (next.activeTabId === tabId) {
    next.activeTabId = next.tabs[Math.min(index, next.tabs.length - 1)].id;
  }
  const active = next.tabs.find((tab) => tab.id === next.activeTabId);
  next.selectedProjectId = active?.kind === "project" ? active.projectId : null;
  return normalizeWorkspaceState(next);
}

/** Keyboard/assistive-tech friendly tab activation with wrapping arrows. */
export function activateRelativeWorkspaceTab(
  state: WorkspaceState,
  fromTabId: string,
  command: LinearMoveCommand,
): WorkspaceState {
  const normalized = normalizeWorkspaceState(state);
  const index = normalized.tabs.findIndex((tab) => tab.id === fromTabId);
  if (index < 0) throw new Error("The requested workspace tab does not exist.");
  if (normalized.tabs.length === 0) return normalized;
  let target: number;
  switch (command) {
    case "previous":
      target = (index - 1 + normalized.tabs.length) % normalized.tabs.length;
      break;
    case "next":
      target = (index + 1) % normalized.tabs.length;
      break;
    case "first":
      target = 0;
      break;
    case "last":
      target = normalized.tabs.length - 1;
      break;
  }
  return activateWorkspaceTab(normalized, normalized.tabs[target].id);
}

/** Move a tab without changing its identity or the active tab. */
export function moveWorkspaceTabByKeyboard(
  state: WorkspaceState,
  tabId: string,
  command: LinearMoveCommand,
): WorkspaceState {
  const next = editableClone(state);
  const index = next.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) throw new Error("The requested workspace tab does not exist.");
  const target = linearTarget(index, next.tabs.length, command, false);
  moveArrayItem(next.tabs, index, target);
  return next;
}

/**
 * Move a tab directly before another tab, or append it when the target is null.
 * This mirrors pointer drag/drop semantics without changing tab identity,
 * activation, project selection, or any opaque persisted fields.
 */
export function moveWorkspaceTabBefore(
  state: WorkspaceState,
  tabId: string,
  beforeTabId: string | null,
): WorkspaceState {
  const next = editableClone(state);
  const sourceIndex = next.tabs.findIndex((tab) => tab.id === tabId);
  if (sourceIndex < 0) throw new Error("The requested workspace tab does not exist.");

  if (beforeTabId === tabId) return next;
  if (beforeTabId !== null && !next.tabs.some((tab) => tab.id === beforeTabId)) {
    throw new Error("The requested target workspace tab does not exist.");
  }

  const [tab] = next.tabs.splice(sourceIndex, 1);
  if (beforeTabId === null) {
    next.tabs.push(tab);
  } else {
    const targetIndex = next.tabs.findIndex((item) => item.id === beforeTabId);
    next.tabs.splice(targetIndex, 0, tab);
  }
  return next;
}

export function describeWorkspaceTabsForAccessibility(
  state: WorkspaceState,
): WorkspaceTabAccessibility[] {
  const normalized = normalizeWorkspaceState(state);
  return normalized.tabs.map((tab) => ({
    id: tab.id,
    role: "tab",
    ariaSelected: tab.id === normalized.activeTabId,
    tabIndex: tab.id === normalized.activeTabId ? 0 : -1,
  }));
}

/** Add a persisted terminal/pane. Storage bytes, not pane count, bound state. */
export function appendProjectPane(
  state: WorkspaceState,
  projectId: string,
  pane: WorkspaceTerminal,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  if (
    project.terminals.some((item) => item.id === pane.id) ||
    projectBrowserPanes(project).some((item) => item.id === pane.id) ||
    projectEditorPanes(project).some((item) => item.id === pane.id)
  ) {
    throw new Error("The pane identifier is already in use.");
  }
  project.terminals.push(pane);
  repairPersistedPaneOrder(project);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

/**
 * Browser panes predate a first-class canonical field. Keep them in the
 * project extension envelope so schema-v1 workspaces remain forwards and
 * backwards compatible while still restoring the pane itself after restart.
 */
export function projectBrowserPanes(
  project: WorkspaceProject,
): WorkspaceBrowserPane[] {
  const source = project.legacyExtensions[PROJECT_BROWSER_PANES_EXTENSION];
  if (!Array.isArray(source)) return [];
  const panes: WorkspaceBrowserPane[] = [];
  const ids = new Set(project.terminals.map((terminal) => terminal.id));
  for (const entry of source) {
    if (!isRecord(entry)) continue;
    try {
      const id = String(entry.id ?? "");
      assertOpaqueLocalId(id, "browser pane");
      if (ids.has(id)) continue;
      const title = normalizeBrowserPaneTitle(String(entry.title ?? ""));
      const url = normalizePersistedBrowserPaneUrl(String(entry.url ?? ""));
      ids.add(id);
      panes.push({ ...structuredClone(entry), id, title, url });
    } catch {
      // Opaque extension data must never make an otherwise valid project
      // impossible to open. Invalid browser entries are ignored on restore.
    }
  }
  return panes;
}

export function createWorkspaceBrowserPane(
  id: string,
  title = "WEB",
  url = "https://www.google.com/",
): WorkspaceBrowserPane {
  assertOpaqueLocalId(id, "browser pane");
  return {
    id,
    title: normalizeBrowserPaneTitle(title),
    url: normalizePersistedBrowserPaneUrl(url),
  };
}

export function appendProjectBrowserPane(
  state: WorkspaceState,
  projectId: string,
  pane: WorkspaceBrowserPane,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const browsers = projectBrowserPanes(project);
  const normalized = createWorkspaceBrowserPane(pane.id, pane.title, pane.url);
  if (
    project.terminals.some((item) => item.id === normalized.id) ||
    browsers.some((item) => item.id === normalized.id) ||
    projectEditorPanes(project).some((item) => item.id === normalized.id)
  ) {
    throw new Error("The pane identifier is already in use.");
  }
  browsers.push({ ...structuredClone(pane), ...normalized });
  project.legacyExtensions[PROJECT_BROWSER_PANES_EXTENSION] = browsers;
  repairPersistedPaneOrder(project);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function removeProjectBrowserPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const browsers = projectBrowserPanes(project);
  const index = browsers.findIndex((pane) => pane.id === paneId);
  if (index < 0) throw new Error("The requested browser pane does not exist.");
  browsers.splice(index, 1);
  project.legacyExtensions[PROJECT_BROWSER_PANES_EXTENSION] = browsers;
  repairPersistedPaneOrder(project);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function renameProjectBrowserPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  title: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  return updateProjectBrowserPane(state, projectId, paneId, (pane) => {
    pane.title = normalizeBrowserPaneTitle(title);
  }, modifiedAtUtc);
}

export function setProjectBrowserPaneUrl(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  url: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  return updateProjectBrowserPane(state, projectId, paneId, (pane) => {
    pane.url = normalizePersistedBrowserPaneUrl(url);
  }, modifiedAtUtc);
}

/**
 * Persist lightweight text/Markdown editors beside browser panes without
 * changing schema-v1. Only the project-relative identity is stored; file
 * contents remain in the project and are re-read through the guarded backend.
 */
export function projectEditorPanes(project: WorkspaceProject): WorkspaceEditorPane[] {
  const source = project.legacyExtensions[PROJECT_EDITOR_PANES_EXTENSION];
  if (!Array.isArray(source)) return [];
  const panes: WorkspaceEditorPane[] = [];
  const ids = new Set([
    ...project.terminals.map((terminal) => terminal.id),
    ...projectBrowserPanes(project).map((pane) => pane.id),
  ]);
  for (const entry of source) {
    if (!isRecord(entry)) continue;
    try {
      const id = String(entry.id ?? "");
      assertOpaqueLocalId(id, "editor pane");
      if (ids.has(id)) continue;
      const pathSegments = normalizeEditorPathSegments(entry.pathSegments);
      const title = normalizeEditorPaneTitle(
        String(entry.title ?? pathSegments[pathSegments.length - 1] ?? ""),
      );
      ids.add(id);
      panes.push({ ...structuredClone(entry), id, title, pathSegments });
    } catch {
      // Invalid opaque editor state must not prevent the project from opening.
    }
  }
  return panes;
}

export function createWorkspaceEditorPane(
  id: string,
  pathSegments: readonly string[],
  title = pathSegments[pathSegments.length - 1] ?? "File",
): WorkspaceEditorPane {
  assertOpaqueLocalId(id, "editor pane");
  return {
    id,
    title: normalizeEditorPaneTitle(title),
    pathSegments: normalizeEditorPathSegments(pathSegments),
  };
}

export function appendProjectEditorPane(
  state: WorkspaceState,
  projectId: string,
  pane: WorkspaceEditorPane,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const editors = projectEditorPanes(project);
  const normalized = createWorkspaceEditorPane(pane.id, pane.pathSegments, pane.title);
  if (
    project.terminals.some((item) => item.id === normalized.id) ||
    projectBrowserPanes(project).some((item) => item.id === normalized.id) ||
    editors.some((item) => item.id === normalized.id)
  ) {
    throw new Error("The pane identifier is already in use.");
  }
  editors.push({ ...structuredClone(pane), ...normalized });
  project.legacyExtensions[PROJECT_EDITOR_PANES_EXTENSION] = editors;
  repairPersistedPaneOrder(project);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function removeProjectEditorPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const editors = projectEditorPanes(project);
  const index = editors.findIndex((pane) => pane.id === paneId);
  if (index < 0) throw new Error("The requested editor pane does not exist.");
  editors.splice(index, 1);
  project.legacyExtensions[PROJECT_EDITOR_PANES_EXTENSION] = editors;
  repairPersistedPaneOrder(project);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function sameProjectEditorPath(
  pane: WorkspaceEditorPane,
  pathSegments: readonly string[],
): boolean {
  let normalized: string[];
  try {
    normalized = normalizeEditorPathSegments(pathSegments);
  } catch {
    return false;
  }
  return (
    pane.pathSegments.length === normalized.length &&
    pane.pathSegments.every(
      (segment, index) => segment.localeCompare(normalized[index], undefined, { sensitivity: "accent" }) === 0,
    )
  );
}

/**
 * Resolve the UI-owned mixed pane sequence without letting stale extension
 * data hide a real pane. Persisted valid IDs retain their relative order;
 * panes added since the last save are appended in canonical storage order.
 */
export function projectPaneOrder(project: WorkspaceProject): string[] {
  const canonical = canonicalProjectPaneIds(project);
  const available = new Set(canonical);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const source = project.legacyExtensions[PROJECT_PANE_ORDER_EXTENSION];
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry !== "string" || !available.has(entry) || seen.has(entry)) continue;
      seen.add(entry);
      ordered.push(entry);
    }
  }
  for (const paneId of canonical) {
    if (seen.has(paneId)) continue;
    seen.add(paneId);
    ordered.push(paneId);
  }
  return ordered;
}

export function setProjectPaneOrder(
  state: WorkspaceState,
  projectId: string,
  orderedPaneIds: readonly string[],
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const canonical = canonicalProjectPaneIds(project);
  const available = new Set(canonical);
  const seen = new Set<string>();
  if (!Array.isArray(orderedPaneIds) || orderedPaneIds.length !== canonical.length) {
    throw new Error("A pane order must contain every current pane exactly once.");
  }
  for (const paneId of orderedPaneIds) {
    if (typeof paneId !== "string" || !available.has(paneId) || seen.has(paneId)) {
      throw new Error("A pane order must contain every current pane exactly once.");
    }
    seen.add(paneId);
  }
  project.legacyExtensions[PROJECT_PANE_ORDER_EXTENSION] = [...orderedPaneIds];
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

/** Append a canonical project without creating hidden runtime state. */
export function appendWorkspaceProject(
  state: WorkspaceState,
  project: WorkspaceProject,
): WorkspaceState {
  const next = editableClone(state);
  if (next.projects.length >= MAX_WORKSPACE_PROJECTS) {
    throw new Error(`A workspace can contain at most ${MAX_WORKSPACE_PROJECTS} projects.`);
  }
  if (next.projects.some((item) => item.id === project.id)) {
    throw new Error("The project identifier is already in use.");
  }
  if (findWorkspaceProjectByFolder(next.projects, project.folderPath)) {
    throw new Error("The project folder is already registered.");
  }
  next.projects.push(project);
  return normalizeWorkspaceState(next);
}

/** Rename one project and every project tab that presents its canonical name. */
export function renameWorkspaceProject(
  state: WorkspaceState,
  projectId: string,
  name: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const normalized = validateWorkspaceProjectDraft(name, project.folderPath).name;
  project.name = normalized;
  project.lastModifiedAtUtc = modifiedAtUtc;
  for (const tab of next.tabs) {
    if (tab.kind === "project" && tab.projectId === projectId) tab.title = normalized;
  }
  return normalizeWorkspaceState(next);
}

/**
 * Remove a project from the workspace catalog without touching its folder.
 * Every tab referencing the project is removed atomically. If that leaves no
 * tab, create one explicit blank replacement so the workspace remains valid.
 */
export function removeWorkspaceProject(
  state: WorkspaceState,
  projectId: string,
  replacementTabId: string,
): WorkspaceState {
  const next = editableClone(state);
  const projectIndex = next.projects.findIndex((project) => project.id === projectId);
  if (projectIndex < 0) throw new Error("The requested workspace project does not exist.");

  const activeIndex = next.tabs.findIndex((tab) => tab.id === next.activeTabId);
  const activeRemoved = next.tabs.some(
    (tab) => tab.id === next.activeTabId && tab.projectId === projectId,
  );
  const fallbackActiveTabId =
    activeIndex >= 0
      ? (next.tabs.slice(activeIndex + 1).find((tab) => tab.projectId !== projectId)?.id ??
        next.tabs
          .slice(0, activeIndex)
          .reverse()
          .find((tab) => tab.projectId !== projectId)?.id)
      : next.tabs.find((tab) => tab.projectId !== projectId)?.id;
  next.projects.splice(projectIndex, 1);
  next.tabs = next.tabs.filter((tab) => tab.projectId !== projectId);

  if (next.tabs.length === 0) {
    assertNewTabId(next, replacementTabId);
    next.tabs.push({
      id: replacementTabId,
      kind: "empty",
      title: tr("New tab", "새 탭"),
      projectId: null,
      browser: null,
      output: null,
      extensions: {},
    });
    next.activeTabId = replacementTabId;
  } else if (activeRemoved || !next.tabs.some((tab) => tab.id === next.activeTabId)) {
    next.activeTabId = fallbackActiveTabId ?? next.tabs[0].id;
  }

  const active = next.tabs.find((tab) => tab.id === next.activeTabId) ?? null;
  next.selectedProjectId = active?.kind === "project" ? active.projectId : null;
  return normalizeWorkspaceState(next);
}

/** Stamp one project without mutating the caller's workspace snapshot. */
export function touchWorkspaceProject(
  state: WorkspaceState,
  projectId: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function removeProjectPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const index = project.terminals.findIndex((pane) => pane.id === paneId);
  if (index < 0) throw new Error("The requested pane does not exist.");
  project.terminals.splice(index, 1);
  repairPersistedPaneOrder(project);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

export function renameProjectPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  title: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const pane = project.terminals.find((item) => item.id === paneId);
  if (!pane) throw new Error("The requested pane does not exist.");
  const normalized = title.trim();
  if (!normalized) throw new Error("A pane title cannot be empty.");
  pane.name = normalized;
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

/**
 * Persist a provider conversation against one stable terminal. Provider IDs
 * are exclusive per terminal and a conversation may have only one terminal
 * owner for the same provider across the workspace.
 */
export function setTerminalAgentConversation(
  state: WorkspaceState,
  projectId: string,
  terminalId: string,
  provider: WorkspaceAgentProvider,
  conversationId: string,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  if (provider !== "codex" && provider !== "grok") {
    throw new Error("The agent provider is invalid.");
  }
  const normalizedConversationId = normalizeConversationId(conversationId);
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const terminal = project.terminals.find((item) => item.id === terminalId);
  if (!terminal) throw new Error("The requested pane does not exist.");

  const providerField = provider === "codex" ? "codexThreadId" : "grokSessionId";
  for (const candidateProject of next.projects) {
    for (const candidate of candidateProject.terminals) {
      if (candidateProject.id === projectId && candidate.id === terminalId) continue;
      if (candidate[providerField]?.toLowerCase() === normalizedConversationId) {
        throw new Error("The agent conversation is already owned by another pane.");
      }
    }
  }

  if (provider === "codex") {
    terminal.codexThreadId = normalizedConversationId;
    terminal.grokSessionId = null;
  } else {
    terminal.codexThreadId = null;
    terminal.grokSessionId = normalizedConversationId;
  }
  if (terminal.legacyExtensions.resumeBlocked === true) {
    delete terminal.legacyExtensions.resumeBlocked;
  }
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

/**
 * Compare the canonical fields that control agent ownership and safe resume.
 * `resumeBlocked` is part of the binding semantics even though it lives in the
 * legacy extension bag, so clearing it must be persisted when the IDs already
 * match.
 */
export function terminalAgentBindingChanged(
  previous: WorkspaceTerminal,
  next: WorkspaceTerminal,
): boolean {
  return (
    previous.codexThreadId !== next.codexThreadId ||
    previous.grokSessionId !== next.grokSessionId ||
    (previous.legacyExtensions.resumeBlocked === true) !==
      (next.legacyExtensions.resumeBlocked === true)
  );
}

export function createWorkspaceProject(
  id: string,
  name: string,
  folderPath: string,
  lastModifiedAtUtc: string,
): WorkspaceProject {
  assertOpaqueLocalId(id, "project");
  const draft = validateWorkspaceProjectDraft(name, folderPath);
  return {
    id,
    name: draft.name,
    folderPath: draft.folderPath,
    lastModifiedAtUtc,
    terminals: [],
    paneWidthRatios: {},
    legacyExtensions: {},
  };
}

export function createWorkspaceTerminal(
  id: string,
  name: string,
  startDirectory: string,
  createdAtUtc: string,
  launchProfile: WorkspaceTerminalLaunchProfile = "powershell",
): WorkspaceTerminal {
  assertOpaqueLocalId(id, "pane");
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("A pane title cannot be empty.");
  const normalizedDirectory = normalizeWindowsFolder(startDirectory);
  if (!isAbsoluteWindowsPath(normalizedDirectory)) {
    throw new Error("A pane start directory must be an absolute Windows path.");
  }
  if (!isWorkspaceTerminalLaunchProfile(launchProfile)) {
    throw new Error("The terminal launch profile is invalid.");
  }
  return {
    id,
    name: normalizedName,
    startDirectory: normalizedDirectory,
    codexThreadId: null,
    grokSessionId: null,
    createdAtUtc,
    completionPending: false,
    legacyExtensions:
      launchProfile === "powershell"
        ? {}
        : { [TERMINAL_LAUNCH_PROFILE_EXTENSION]: launchProfile },
  };
}

export function workspaceTerminalLaunchProfile(
  terminal: Pick<WorkspaceTerminal, "legacyExtensions">,
): WorkspaceTerminalLaunchProfile {
  const candidate = terminal.legacyExtensions[TERMINAL_LAUNCH_PROFILE_EXTENSION];
  return isWorkspaceTerminalLaunchProfile(candidate) ? candidate : "powershell";
}

export function validateWorkspaceProjectDraft(
  name: string,
  folderPath: string,
): WorkspaceProjectDraft {
  const normalizedName = validateWorkspaceProjectName(name);
  const normalizedFolder = normalizeWindowsFolder(folderPath);
  if (!isAbsoluteWindowsPath(normalizedFolder)) {
    throw new Error(
      tr(
        "Enter an absolute folder path that starts with a drive letter or UNC path.",
        "드라이브 또는 UNC로 시작하는 절대 폴더 경로를 입력하세요.",
      ),
    );
  }
  return { name: normalizedName, folderPath: normalizedFolder };
}

export function validateWorkspaceProjectName(name: string): string {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error(tr("Enter a project name.", "프로젝트 이름을 입력하세요."));
  if (normalizedName.length > 50) {
    throw new Error(
      tr("Project names must be 50 characters or fewer.", "프로젝트 이름은 50자 이하여야 합니다."),
    );
  }
  return normalizedName;
}

/** Match the legacy dialog: suggest the selected folder's final path segment. */
export function suggestWorkspaceProjectName(folderPath: string): string {
  const withoutTrailingSeparators = folderPath.trim().replace(/[\\/]+$/, "");
  if (!withoutTrailingSeparators || /^[a-z]:$/i.test(withoutTrailingSeparators)) {
    return tr("New project", "새 프로젝트");
  }
  const segments = withoutTrailingSeparators.split(/[\\/]/);
  const finalSegment = segments[segments.length - 1]?.trim();
  return finalSegment || tr("New project", "새 프로젝트");
}

export function findWorkspaceProjectByFolder(
  projects: readonly WorkspaceProject[],
  folderPath: string,
): WorkspaceProject | null {
  const key = windowsPathKey(folderPath);
  return projects.find((project) => windowsPathKey(project.folderPath) === key) ?? null;
}

/**
 * Return projects newest-first without changing the canonical persisted order.
 * Legacy projects without their own timestamp fall back to their newest pane,
 * and exact ties retain the caller's original order.
 */
export function sortWorkspaceProjectsByRecentModification(
  projects: readonly WorkspaceProject[],
): WorkspaceProject[] {
  return projects
    .map((project, index) => ({
      project,
      index,
      timestamp: recentProjectTimestamp(project),
    }))
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp > right.timestamp ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ project }) => project);
}

export function uniqueWorkspaceProjectName(
  projects: readonly WorkspaceProject[],
  requested: string,
): string {
  const names = new Set(projects.map((project) => project.name.toLocaleLowerCase()));
  if (!names.has(requested.toLocaleLowerCase())) return requested;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${requested} (${suffix})`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function nextWorkspacePaneName(
  project: WorkspaceProject,
  launchProfile: WorkspaceTerminalLaunchProfile = "powershell",
): string {
  if (!isWorkspaceTerminalLaunchProfile(launchProfile)) {
    throw new Error("The terminal launch profile is invalid.");
  }
  const names = new Set(project.terminals.map((pane) => pane.name.toLocaleLowerCase()));
  const prefix =
    launchProfile === "codex"
      ? "Codex"
      : launchProfile === "grok"
        ? "Grok"
        : launchProfile === "claude"
          ? "Claude Code"
          : launchProfile === "opencode"
            ? "OpenCode"
            : "PowerShell";
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix} ${index}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

function isWorkspaceTerminalLaunchProfile(
  value: unknown,
): value is WorkspaceTerminalLaunchProfile {
  return (
    value === "powershell" ||
    value === "codex" ||
    value === "grok" ||
    value === "claude" ||
    value === "opencode"
  );
}

export function evaluateWorkspaceRestoreCapacity(
  current: number,
  incoming: number,
  maximum = Number.MAX_SAFE_INTEGER,
): RestoreCapacityDecision {
  for (const [label, value] of [
    ["current", current],
    ["incoming", incoming],
    ["maximum", maximum],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} pane count must be a non-negative integer.`);
    }
  }
  if (maximum === 0) throw new Error("maximum pane count must be positive.");
  const required = current + incoming;
  return {
    allowed: required <= maximum,
    current,
    incoming,
    required,
    available: Math.max(0, maximum - current),
    maximum,
  };
}

/** Apply a drag preview by stable beforePaneId; its numeric index may be stale. */
export function applyProjectPaneInsertion(
  state: WorkspaceState,
  projectId: string,
  draggedPaneId: string,
  target: Pick<PaneInsertionTarget, "beforePaneId">,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const sourceIndex = project.terminals.findIndex((pane) => pane.id === draggedPaneId);
  if (sourceIndex < 0) throw new Error("The dragged pane does not exist.");
  if (target.beforePaneId === draggedPaneId) {
    throw new Error("A pane cannot be inserted before itself.");
  }
  const [dragged] = project.terminals.splice(sourceIndex, 1);
  const insertionIndex =
    target.beforePaneId === null
      ? project.terminals.length
      : project.terminals.findIndex((pane) => pane.id === target.beforePaneId);
  if (insertionIndex < 0) throw new Error("The insertion target no longer exists.");
  project.terminals.splice(insertionIndex, 0, dragged);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

/** Reorder one pane from the keyboard without relying on screen coordinates. */
export function moveProjectPaneByKeyboard(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  command: LinearMoveCommand,
  modifiedAtUtc = new Date().toISOString(),
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const index = project.terminals.findIndex((pane) => pane.id === paneId);
  if (index < 0) throw new Error("The requested pane does not exist.");
  const target = linearTarget(index, project.terminals.length, command, false);
  moveArrayItem(project.terminals, index, target);
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

/**
 * Resolve the nearest insertion line. A new target must improve the pointer
 * distance by more than hysteresisPx before the preview changes, preventing
 * rapid oscillation around a boundary.
 */
export function resolvePaneInsertionPreview(
  geometry: readonly PaneGeometry[],
  draggedPaneId: string,
  pointer: Point,
  previous: PaneInsertionTarget | null = null,
  options: PaneInsertionOptions = {},
): PaneInsertionTarget {
  const hysteresisPx = options.hysteresisPx ?? DEFAULT_INSERTION_HYSTERESIS_PX;
  const rowWeight = options.rowDistanceWeight ?? 1.35;
  requireNonNegativeFinite(hysteresisPx, "insertion hysteresis");
  requirePositiveFinite(rowWeight, "row distance weight");
  requireFinitePoint(pointer);
  validatePaneGeometry(geometry);
  if (!geometry.some((pane) => pane.paneId === draggedPaneId)) {
    throw new Error("The dragged pane has no measured geometry.");
  }

  const remaining = geometry.filter((pane) => pane.paneId !== draggedPaneId);
  if (remaining.length === 0) {
    return {
      beforePaneId: null,
      index: 0,
      anchorX: pointer.x,
      anchorY: pointer.y,
    };
  }
  const candidates: PaneInsertionTarget[] = remaining.map((pane, index) => ({
    beforePaneId: pane.paneId,
    index,
    anchorX: pane.left,
    anchorY: pane.top + pane.height / 2,
  }));
  const last = remaining[remaining.length - 1];
  candidates.push({
    beforePaneId: null,
    index: remaining.length,
    anchorX: last.left + last.width,
    anchorY: last.top + last.height / 2,
  });

  const distance = (candidate: PaneInsertionTarget) =>
    Math.hypot(
      pointer.x - candidate.anchorX,
      (pointer.y - candidate.anchorY) * rowWeight,
    );
  let best = candidates[0];
  let bestDistance = distance(best);
  for (const candidate of candidates.slice(1)) {
    const candidateDistance = distance(candidate);
    if (
      candidateDistance < bestDistance ||
      (candidateDistance === bestDistance && candidate.index < best.index)
    ) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  if (previous !== null && previous.beforePaneId !== best.beforePaneId) {
    const retained = candidates.find(
      (candidate) => candidate.beforePaneId === previous.beforePaneId,
    );
    if (retained && bestDistance + hysteresisPx >= distance(retained)) {
      return retained;
    }
  }
  return best;
}

/** Pure horizontal divider calculation with minimum widths and edge snapping. */
export function computeHorizontalResize(
  request: HorizontalResizeRequest,
): HorizontalResizeResult {
  const ratios = normalizeRatios(request.ratios);
  if (ratios.length < 2 || ratios.length > 5) {
    throw new Error("A horizontal row must contain between 2 and 5 panes.");
  }
  if (
    !Number.isInteger(request.dividerIndex) ||
    request.dividerIndex < 0 ||
    request.dividerIndex >= ratios.length - 1
  ) {
    throw new Error("The divider index must identify adjacent panes.");
  }
  requirePositiveFinite(request.totalWidthPx, "row width");
  requireFiniteNumber(request.deltaX, "horizontal resize delta");
  const minimum = request.minPaneWidthPx ?? DEFAULT_MIN_PANE_WIDTH_PX;
  const containerLeft = request.containerLeftPx ?? 0;
  const snapDistance = request.snapDistancePx ?? DEFAULT_SNAP_DISTANCE_PX;
  requirePositiveFinite(minimum, "minimum pane width");
  requireFiniteNumber(containerLeft, "container left");
  requireNonNegativeFinite(snapDistance, "snap distance");
  if (request.totalWidthPx + 1e-9 < minimum * ratios.length) {
    throw new Error("The row is too narrow to satisfy every minimum pane width.");
  }

  const widths = ratios.map((ratio) => ratio * request.totalWidthPx);
  if (widths.some((width) => width + 1e-7 < minimum)) {
    throw new Error("The current row violates the minimum pane width.");
  }
  const divider = request.dividerIndex;
  const prefix = widths.slice(0, divider).reduce((sum, width) => sum + width, 0);
  const pairWidth = widths[divider] + widths[divider + 1];
  const originalLocal = prefix + widths[divider];
  const lower = prefix + minimum;
  const upper = prefix + pairWidth - minimum;
  let local = clamp(originalLocal + request.deltaX, lower, upper);
  let snappedToPx: number | null = null;

  const snapTargets = [...new Set(request.siblingEdgesPx ?? [])]
    .map((target) => {
      requireFiniteNumber(target, "sibling edge");
      return target;
    })
    .filter((target) => target >= containerLeft + lower && target <= containerLeft + upper)
    .sort((left, right) => {
      const leftDistance = Math.abs(left - (containerLeft + local));
      const rightDistance = Math.abs(right - (containerLeft + local));
      return leftDistance - rightDistance || left - right;
    });
  const nearest = snapTargets[0];
  if (
    nearest !== undefined &&
    Math.abs(nearest - (containerLeft + local)) <= snapDistance
  ) {
    local = nearest - containerLeft;
    snappedToPx = nearest;
  }

  const resizedLeft = local - prefix;
  widths[divider] = resizedLeft;
  widths[divider + 1] = pairWidth - resizedLeft;
  return {
    ratios: normalizeRatios(widths),
    dividerX: containerLeft + local,
    appliedDeltaX: local - originalLocal,
    snappedToPx,
  };
}

/** Resize adjacent, stable pane IDs and persist only their horizontal ratios. */
export function resizeProjectPaneBoundaryHorizontal(
  state: WorkspaceState,
  projectId: string,
  request: ProjectPaneResizeRequest,
  modifiedAtUtc = new Date().toISOString(),
): { state: WorkspaceState; resize: HorizontalResizeResult } {
  const normalized = normalizeWorkspaceState(state);
  const project = requireProject(normalized, projectId);
  validateRowPaneIds(project, request.rowPaneIds);
  const dividerIndex = request.rowPaneIds.indexOf(request.leftPaneId);
  if (
    dividerIndex < 0 ||
    request.rowPaneIds[dividerIndex + 1] !== request.rightPaneId
  ) {
    throw new Error("Resize handles must connect adjacent sibling panes.");
  }
  const keyColumns = /^([1-5])x[1-4]:row-[0-3]$/.exec(request.layoutKey);
  if (!keyColumns || Number(keyColumns[1]) !== request.rowPaneIds.length) {
    throw new Error("The layout key does not match the resized row.");
  }
  const ratios =
    project.paneWidthRatios[request.layoutKey] ??
    request.rowPaneIds.map(() => 1 / request.rowPaneIds.length);
  const resize = computeHorizontalResize({
    ratios,
    dividerIndex,
    totalWidthPx: request.totalWidthPx,
    deltaX: request.deltaX,
    minPaneWidthPx: request.minPaneWidthPx,
    containerLeftPx: request.containerLeftPx,
    siblingEdgesPx: request.siblingEdgesPx,
    snapDistancePx: request.snapDistancePx,
  });
  return {
    state: setProjectPaneWidthRatios(
      normalized,
      projectId,
      request.layoutKey,
      resize.ratios,
      modifiedAtUtc,
    ),
    resize,
  };
}

/** Keyboard equivalent of dragging a horizontal resize handle. */
export function resizeProjectPaneBoundaryByKeyboard(
  state: WorkspaceState,
  projectId: string,
  request: Omit<ProjectPaneResizeRequest, "deltaX">,
  command: KeyboardResizeCommand,
  stepPx = 16,
  modifiedAtUtc = new Date().toISOString(),
): { state: WorkspaceState; resize: HorizontalResizeResult } {
  requirePositiveFinite(stepPx, "keyboard resize step");
  return resizeProjectPaneBoundaryHorizontal(state, projectId, {
    ...request,
    deltaX: command === "grow-left" ? stepPx : -stepPx,
  }, modifiedAtUtc);
}

function editableClone(state: WorkspaceState): WorkspaceState {
  return cloneWorkspaceState(normalizeWorkspaceState(state));
}

function updateProjectBrowserPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  update: (pane: WorkspaceBrowserPane) => void,
  modifiedAtUtc: string,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const browsers = projectBrowserPanes(project);
  const pane = browsers.find((item) => item.id === paneId);
  if (!pane) throw new Error("The requested browser pane does not exist.");
  update(pane);
  project.legacyExtensions[PROJECT_BROWSER_PANES_EXTENSION] = browsers;
  project.lastModifiedAtUtc = modifiedAtUtc;
  return normalizeWorkspaceState(next);
}

function canonicalProjectPaneIds(project: WorkspaceProject): string[] {
  return [
    ...project.terminals.map((terminal) => terminal.id),
    ...projectBrowserPanes(project).map((pane) => pane.id),
    ...projectEditorPanes(project).map((pane) => pane.id),
  ];
}

/** Keep an already-persisted mixed order valid across pane lifecycle changes. */
function repairPersistedPaneOrder(project: WorkspaceProject): void {
  if (!Array.isArray(project.legacyExtensions[PROJECT_PANE_ORDER_EXTENSION])) return;
  project.legacyExtensions[PROJECT_PANE_ORDER_EXTENSION] = projectPaneOrder(project);
}

function normalizeBrowserPaneTitle(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("A browser pane title cannot be empty.");
  if (normalized.length > MAX_BROWSER_PANE_TITLE_LENGTH) {
    throw new Error(`A browser pane title cannot exceed ${MAX_BROWSER_PANE_TITLE_LENGTH} characters.`);
  }
  return normalized;
}

function normalizePersistedBrowserPaneUrl(value: string): string {
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > MAX_BROWSER_PANE_URL_BYTES) {
    throw new Error("The browser pane URL is empty or too long.");
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("The browser pane URL is invalid.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    [...normalized].some((character) => /\s|\p{Cc}/u.test(character))
  ) {
    throw new Error("The browser pane URL is not allowed for restore.");
  }
  return parsed.href;
}

function normalizeEditorPaneTitle(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("An editor pane title cannot be empty.");
  if (normalized.length > MAX_EDITOR_PANE_TITLE_LENGTH) {
    throw new Error(`An editor pane title cannot exceed ${MAX_EDITOR_PANE_TITLE_LENGTH} characters.`);
  }
  return normalized;
}

function normalizeEditorPathSegments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITOR_PATH_DEPTH) {
    throw new Error("An editor pane path is invalid.");
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_EDITOR_PATH_SEGMENT_LENGTH ||
      entry === "." ||
      entry === ".." ||
      entry.endsWith(" ") ||
      entry.endsWith(".") ||
      /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(entry)
    ) {
      throw new Error("An editor pane path is invalid.");
    }
    return entry;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireProject(state: WorkspaceState, projectId: string): WorkspaceProject {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("The requested workspace project does not exist.");
  return project;
}

function replaceTabWithProject(tab: WorkspaceTab, project: WorkspaceProject): void {
  tab.kind = "project";
  tab.title = project.name;
  tab.projectId = project.id;
  tab.browser = null;
  tab.output = null;
}

function assertNewTabId(state: WorkspaceState, tabId: string): void {
  assertOpaqueLocalId(tabId, "tab");
  if (state.tabs.some((tab) => tab.id === tabId)) {
    throw new Error("The tab identifier is already in use.");
  }
}

function assertOpaqueLocalId(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ${label} identifier must be non-empty.`);
  }
}

function normalizeConversationId(value: string): string {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("The agent conversation identifier is not a valid UUID.");
  }
  return normalized;
}

function recentProjectTimestamp(project: WorkspaceProject): number {
  const projectTimestamp = parseTimestamp(project.lastModifiedAtUtc);
  if (projectTimestamp !== null) return projectTimestamp;

  let newestTerminalTimestamp: number | null = null;
  for (const terminal of project.terminals) {
    const terminalTimestamp = parseTimestamp(terminal.createdAtUtc);
    if (
      terminalTimestamp !== null &&
      (newestTerminalTimestamp === null || terminalTimestamp > newestTerminalTimestamp)
    ) {
      newestTerminalTimestamp = terminalTimestamp;
    }
  }
  return newestTerminalTimestamp ?? Number.NEGATIVE_INFINITY;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function linearTarget(
  index: number,
  length: number,
  command: LinearMoveCommand,
  wrap: boolean,
): number {
  switch (command) {
    case "previous":
      return wrap ? (index - 1 + length) % length : Math.max(0, index - 1);
    case "next":
      return wrap ? (index + 1) % length : Math.min(length - 1, index + 1);
    case "first":
      return 0;
    case "last":
      return length - 1;
  }
}

function moveArrayItem<T>(items: T[], from: number, to: number): void {
  if (from === to) return;
  const [item] = items.splice(from, 1);
  items.splice(to, 0, item);
}

function validatePaneGeometry(geometry: readonly PaneGeometry[]): void {
  if (geometry.length === 0) {
    throw new Error("Measured pane geometry must contain at least one pane.");
  }
  const ids = new Set<string>();
  for (const pane of geometry) {
    assertOpaqueLocalId(pane.paneId, "pane");
    if (ids.has(pane.paneId)) throw new Error("Measured pane identifiers must be unique.");
    ids.add(pane.paneId);
    requireFiniteNumber(pane.left, "pane left");
    requireFiniteNumber(pane.top, "pane top");
    requirePositiveFinite(pane.width, "pane width");
    requirePositiveFinite(pane.height, "pane height");
  }
}

function normalizeRatios(values: readonly number[]): number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Pane ratios must be a non-empty array.");
  }
  const normalized = values.map((value) => {
    requirePositiveFinite(value, "pane ratio");
    return value;
  });
  const sum = normalized.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0) throw new Error("Pane ratio sum is invalid.");
  return normalized.map((value) => value / sum);
}

function validateRowPaneIds(
  project: WorkspaceProject,
  paneIds: readonly string[],
): void {
  if (paneIds.length < 2 || paneIds.length > 5) {
    throw new Error("A horizontal row must identify between 2 and 5 panes.");
  }
  if (new Set(paneIds).size !== paneIds.length) {
    throw new Error("A horizontal row cannot repeat pane identifiers.");
  }
  const projectIds = new Set(project.terminals.map((pane) => pane.id));
  if (paneIds.some((id) => !projectIds.has(id))) {
    throw new Error("A horizontal row references a pane outside the project.");
  }
}

function requireFinitePoint(point: Point): void {
  requireFiniteNumber(point.x, "pointer x");
  requireFiniteNumber(point.y, "pointer y");
}

function requireFiniteNumber(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`The ${label} must be finite.`);
  }
}

function requirePositiveFinite(value: number, label: string): void {
  requireFiniteNumber(value, label);
  if (value <= 0) throw new Error(`The ${label} must be positive.`);
}

function requireNonNegativeFinite(value: number, label: string): void {
  requireFiniteNumber(value, label);
  if (value < 0) throw new Error(`The ${label} must be non-negative.`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeWindowsFolder(value: string): string {
  const trimmed = value.trim().replace(/\//g, "\\");
  if (/^[A-Za-z]:\\$/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+\\$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/\\+$/, "");
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[A-Za-z]:\\(?:[^<>:"|?*\u0000-\u001f]+(?:\\|$))*$/.test(value) ||
    /^\\\\[^\\/:*?"<>|\u0000-\u001f]+\\[^\\/:*?"<>|\u0000-\u001f]+(?:\\.*)?$/.test(value);
}

function windowsPathKey(value: string): string {
  return normalizeWindowsFolder(value).toLocaleLowerCase();
}
