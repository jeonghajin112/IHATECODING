import {
  MAX_WORKSPACE_PROJECTS,
  MAX_WORKSPACE_TABS,
  MAX_WORKSPACE_TERMINALS,
  cloneWorkspaceState,
  normalizeWorkspaceState,
  setProjectPaneWidthRatios,
  type WorkspaceProject,
  type WorkspaceState,
  type WorkspaceTab,
  type WorkspaceTerminal,
} from "./phase3b-core";

export const DEFAULT_MIN_PANE_WIDTH_PX = 160;
export const DEFAULT_INSERTION_HYSTERESIS_PX = 14;
export const DEFAULT_SNAP_DISTANCE_PX = 8;

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

/** Add and activate a blank tab. The caller owns ID generation. */
export function addBlankWorkspaceTab(
  state: WorkspaceState,
  tabId: string,
  title = "새 탭",
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
 * Open a project using the current blank tab when possible. A project has at
 * most one dedicated project tab: an existing tab wins over a new/blank one.
 */
export function openProjectWorkspaceTab(
  state: WorkspaceState,
  projectId: string,
  newTabId: string,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const active = next.tabs.find((tab) => tab.id === next.activeTabId) ?? null;
  const existing = next.tabs.find(
    (tab) => tab.kind === "project" && tab.projectId === projectId,
  );

  if (active?.kind === "empty") {
    if (existing && existing.id !== active.id) {
      next.tabs = next.tabs.filter((tab) => tab.id !== active.id);
      next.activeTabId = existing.id;
    } else {
      replaceBlankWithProject(active, project);
      next.activeTabId = active.id;
    }
  } else if (existing) {
    next.activeTabId = existing.id;
  } else {
    if (next.tabs.length >= MAX_WORKSPACE_TABS) {
      throw new Error(`A workspace can contain at most ${MAX_WORKSPACE_TABS} tabs.`);
    }
    assertNewTabId(next, newTabId);
    next.tabs.push(projectTab(project, newTabId));
    next.activeTabId = newTabId;
  }
  next.selectedProjectId = projectId;
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
    next.tabs = next.tabs.filter((tab) => tab.id !== tabId);
    next.activeTabId = existing.id;
  } else {
    replaceBlankWithProject(target, project);
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
      title: "새 탭",
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

/** Add a persisted terminal/pane while enforcing the Phase 4 limit. */
export function appendProjectPane(
  state: WorkspaceState,
  projectId: string,
  pane: WorkspaceTerminal,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  if (project.terminals.length >= MAX_WORKSPACE_TERMINALS) {
    throw new Error(`A project can contain at most ${MAX_WORKSPACE_TERMINALS} panes.`);
  }
  if (project.terminals.some((item) => item.id === pane.id)) {
    throw new Error("The pane identifier is already in use.");
  }
  project.terminals.push(pane);
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

export function removeProjectPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const index = project.terminals.findIndex((pane) => pane.id === paneId);
  if (index < 0) throw new Error("The requested pane does not exist.");
  project.terminals.splice(index, 1);
  return normalizeWorkspaceState(next);
}

export function renameProjectPane(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  title: string,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const pane = project.terminals.find((item) => item.id === paneId);
  if (!pane) throw new Error("The requested pane does not exist.");
  const normalized = title.trim();
  if (!normalized) throw new Error("A pane title cannot be empty.");
  pane.name = normalized;
  return normalizeWorkspaceState(next);
}

export function createWorkspaceProject(
  id: string,
  name: string,
  folderPath: string,
): WorkspaceProject {
  assertOpaqueLocalId(id, "project");
  const draft = validateWorkspaceProjectDraft(name, folderPath);
  return {
    id,
    name: draft.name,
    folderPath: draft.folderPath,
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
): WorkspaceTerminal {
  assertOpaqueLocalId(id, "pane");
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("A pane title cannot be empty.");
  const normalizedDirectory = normalizeWindowsFolder(startDirectory);
  if (!isAbsoluteWindowsPath(normalizedDirectory)) {
    throw new Error("A pane start directory must be an absolute Windows path.");
  }
  return {
    id,
    name: normalizedName,
    startDirectory: normalizedDirectory,
    codexThreadId: null,
    grokSessionId: null,
    createdAtUtc,
    completionPending: false,
    legacyExtensions: {},
  };
}

export function validateWorkspaceProjectDraft(
  name: string,
  folderPath: string,
): WorkspaceProjectDraft {
  const normalizedName = name.trim();
  const normalizedFolder = normalizeWindowsFolder(folderPath);
  if (!normalizedName) throw new Error("프로젝트 이름을 입력하세요.");
  if (normalizedName.length > 50) {
    throw new Error("프로젝트 이름은 50자 이하여야 합니다.");
  }
  if (!isAbsoluteWindowsPath(normalizedFolder)) {
    throw new Error("드라이브 또는 UNC로 시작하는 절대 폴더 경로를 입력하세요.");
  }
  return { name: normalizedName, folderPath: normalizedFolder };
}

export function findWorkspaceProjectByFolder(
  projects: readonly WorkspaceProject[],
  folderPath: string,
): WorkspaceProject | null {
  const key = windowsPathKey(folderPath);
  return projects.find((project) => windowsPathKey(project.folderPath) === key) ?? null;
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

export function nextWorkspacePaneName(project: WorkspaceProject): string {
  const names = new Set(project.terminals.map((pane) => pane.name.toLocaleLowerCase()));
  for (let index = 1; ; index += 1) {
    const candidate = `PowerShell ${index}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function evaluateWorkspaceRestoreCapacity(
  current: number,
  incoming: number,
  maximum = MAX_WORKSPACE_TERMINALS,
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
  return next;
}

/** Reorder one pane from the keyboard without relying on screen coordinates. */
export function moveProjectPaneByKeyboard(
  state: WorkspaceState,
  projectId: string,
  paneId: string,
  command: LinearMoveCommand,
): WorkspaceState {
  const next = editableClone(state);
  const project = requireProject(next, projectId);
  const index = project.terminals.findIndex((pane) => pane.id === paneId);
  if (index < 0) throw new Error("The requested pane does not exist.");
  const target = linearTarget(index, project.terminals.length, command, false);
  moveArrayItem(project.terminals, index, target);
  return next;
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
): { state: WorkspaceState; resize: HorizontalResizeResult } {
  requirePositiveFinite(stepPx, "keyboard resize step");
  return resizeProjectPaneBoundaryHorizontal(state, projectId, {
    ...request,
    deltaX: command === "grow-left" ? stepPx : -stepPx,
  });
}

function editableClone(state: WorkspaceState): WorkspaceState {
  return cloneWorkspaceState(normalizeWorkspaceState(state));
}

function requireProject(state: WorkspaceState, projectId: string): WorkspaceProject {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("The requested workspace project does not exist.");
  return project;
}

function replaceBlankWithProject(tab: WorkspaceTab, project: WorkspaceProject): void {
  tab.kind = "project";
  tab.title = project.name;
  tab.projectId = project.id;
  tab.browser = null;
  tab.output = null;
}

function projectTab(project: WorkspaceProject, id: string): WorkspaceTab {
  return {
    id,
    kind: "project",
    title: project.name,
    projectId: project.id,
    browser: null,
    output: null,
    extensions: {},
  };
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
  if (geometry.length === 0 || geometry.length > MAX_WORKSPACE_TERMINALS) {
    throw new Error(`Measured pane geometry must contain 1 to ${MAX_WORKSPACE_TERMINALS} panes.`);
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
