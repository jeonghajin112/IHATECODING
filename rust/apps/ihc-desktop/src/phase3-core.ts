import { tr } from "./i18n";

export type SavedTerminalState = {
  [key: string]: unknown;
  Id: string;
  Name: string;
  StartDirectory: string;
  CodexThreadId: string | null;
  GrokSessionId: string | null;
  CreatedAtUtc: string | null;
  CompletionPending: boolean;
};

export type WorkspaceProject = {
  [key: string]: unknown;
  Id: string;
  Name: string;
  FolderPath: string;
  Terminals: SavedTerminalState[];
  PaneWidthRatios: Record<string, number[]>;
};

export type ProjectCatalog = {
  [key: string]: unknown;
  Projects: WorkspaceProject[];
  SelectedProjectId: string | null;
};

export type ProjectCatalogLoadResponse = {
  catalog: ProjectCatalog;
  recoveryRequired: boolean;
};

export function normalizeProjectCatalogLoadResponse(
  value: unknown,
): ProjectCatalogLoadResponse {
  const response = requireRecord(value, "project catalog load response");
  if (typeof response.recoveryRequired !== "boolean") {
    throw new Error("project catalog load response.recoveryRequired must be a boolean");
  }
  return {
    catalog: normalizeProjectCatalog(response.catalog),
    recoveryRequired: response.recoveryRequired,
  };
}

export type WorkspaceTab = {
  id: string;
  kind: "empty" | "project";
  title: string;
  projectId: string | null;
};

export type WorkspaceTabState = {
  tabs: WorkspaceTab[];
  activeTabId: string;
};

export type RestoreCapacityDecision = {
  allowed: boolean;
  current: number;
  incoming: number;
  required: number;
  available: number;
  maximum: number;
};

export type CatalogMutationGateState = {
  initialized: boolean;
  writable: boolean;
  shuttingDown: boolean;
  tabTransitionPending: boolean;
  projectCreationPending: boolean;
  terminalCreationPending: boolean;
};

export function catalogMutationsAllowed(state: CatalogMutationGateState): boolean {
  return (
    state.initialized &&
    state.writable &&
    !state.shuttingDown &&
    !state.tabTransitionPending &&
    !state.projectCreationPending &&
    !state.terminalCreationPending
  );
}

export function evaluateRestoreCapacity(
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
      throw new Error(`${label} pane count must be a non-negative integer`);
    }
  }
  if (maximum === 0) throw new Error("maximum pane count must be greater than zero");
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

export function normalizeProjectCatalog(value: unknown): ProjectCatalog {
  const catalog = requireRecord(value, "project catalog");
  if (!Array.isArray(catalog.Projects)) {
    throw new Error("project catalog.Projects must be an array");
  }
  const projects = catalog.Projects.map(normalizeProject);
  const projectIds = new Set<string>();
  const folderKeys = new Set<string>();
  for (const project of projects) {
    if (projectIds.has(project.Id)) throw new Error(`duplicate project Id: ${project.Id}`);
    projectIds.add(project.Id);
    const folderKey = normalizePathKey(project.FolderPath);
    if (folderKeys.has(folderKey)) throw new Error(`duplicate project folder: ${project.FolderPath}`);
    folderKeys.add(folderKey);
  }

  const selected = catalog.SelectedProjectId;
  if (selected !== null && typeof selected !== "string") {
    throw new Error("project catalog.SelectedProjectId must be a string or null");
  }
  const normalizedSelected =
    selected === null
      ? null
      : typeof selected === "string" && projectIds.has(selected)
        ? selected
        : null;
  return {
    ...deepCloneRecord(catalog),
    Projects: projects,
    SelectedProjectId: normalizedSelected,
  };
}

export function cloneProjectCatalog(catalog: ProjectCatalog): ProjectCatalog {
  return deepCloneValue(catalog) as ProjectCatalog;
}

export function initialProject(catalog: ProjectCatalog): WorkspaceProject | null {
  if (catalog.SelectedProjectId === null) return null;
  return catalog.Projects.find((project) => project.Id === catalog.SelectedProjectId) ?? null;
}

export function createInitialTabState(
  project: WorkspaceProject | null,
  idFactory: () => string,
): WorkspaceTabState {
  const tab = project
    ? projectTab(project, idFactory())
    : emptyTab(idFactory());
  return { tabs: [tab], activeTabId: tab.id };
}

export function addBlankTab(
  state: WorkspaceTabState,
  idFactory: () => string,
): WorkspaceTabState {
  const tab = emptyTab(idFactory());
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

export function openProjectTab(
  state: WorkspaceTabState,
  project: WorkspaceProject,
  idFactory: () => string,
): WorkspaceTabState {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  const existing = state.tabs.find(
    (tab) => tab.kind === "project" && tab.projectId === project.Id,
  );

  if (active?.kind === "empty") {
    if (existing) {
      return {
        tabs: state.tabs.filter((tab) => tab.id !== active.id),
        activeTabId: existing.id,
      };
    }
    return {
      tabs: state.tabs.map((tab) =>
        tab.id === active.id ? projectTab(project, tab.id) : tab,
      ),
      activeTabId: active.id,
    };
  }

  if (existing) return { ...state, activeTabId: existing.id };
  const tab = projectTab(project, idFactory());
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

export function selectWorkspaceTab(
  state: WorkspaceTabState,
  tabId: string,
): WorkspaceTabState {
  return state.tabs.some((tab) => tab.id === tabId)
    ? { ...state, activeTabId: tabId }
    : state;
}

export function closeWorkspaceTab(
  state: WorkspaceTabState,
  tabId: string,
  idFactory: () => string,
): WorkspaceTabState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    const replacement = emptyTab(idFactory());
    return { tabs: [replacement], activeTabId: replacement.id };
  }
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  return {
    tabs,
    activeTabId: tabs[Math.min(index, tabs.length - 1)].id,
  };
}

export function validateProjectDraft(name: string, folderPath: string) {
  const normalizedName = name.trim();
  const normalizedFolder = normalizeFolderInput(folderPath);
  if (!normalizedName) throw new Error(tr("Enter a project name.", "프로젝트 이름을 입력하세요."));
  if (normalizedName.length > 50) {
    throw new Error(
      tr("Project names must be 50 characters or fewer.", "프로젝트 이름은 50자 이하여야 합니다."),
    );
  }
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

export function uniqueProjectName(projects: WorkspaceProject[], requested: string): string {
  const names = new Set(projects.map((project) => project.Name.toLocaleLowerCase()));
  if (!names.has(requested.toLocaleLowerCase())) return requested;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${requested} (${suffix})`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function findProjectByFolder(
  projects: WorkspaceProject[],
  folderPath: string,
): WorkspaceProject | null {
  const key = normalizePathKey(folderPath);
  return projects.find((project) => normalizePathKey(project.FolderPath) === key) ?? null;
}

export function appendTerminal(
  catalog: ProjectCatalog,
  projectId: string,
  terminal: SavedTerminalState,
): ProjectCatalog {
  return updateProject(catalog, projectId, (project) => {
    if (project.Terminals.some((item) => item.Id === terminal.Id)) {
      throw new Error(`duplicate terminal Id: ${terminal.Id}`);
    }
    return { ...project, Terminals: [...project.Terminals, { ...terminal }] };
  });
}

export function removeTerminal(
  catalog: ProjectCatalog,
  projectId: string,
  terminalId: string,
): ProjectCatalog {
  return updateProject(catalog, projectId, (project) => ({
    ...project,
    Terminals: project.Terminals.filter((terminal) => terminal.Id !== terminalId),
  }));
}

export function renameTerminal(
  catalog: ProjectCatalog,
  projectId: string,
  terminalId: string,
  name: string,
): ProjectCatalog {
  const trimmed = name.trim();
  if (!trimmed) return catalog;
  return updateProject(catalog, projectId, (project) => ({
    ...project,
    Terminals: project.Terminals.map((terminal) =>
      terminal.Id === terminalId ? { ...terminal, Name: trimmed } : terminal,
    ),
  }));
}

export function reorderTerminals(
  catalog: ProjectCatalog,
  projectId: string,
  orderedIds: string[],
): ProjectCatalog {
  return updateProject(catalog, projectId, (project) => {
    if (
      orderedIds.length !== project.Terminals.length ||
      new Set(orderedIds).size !== orderedIds.length
    ) {
      throw new Error("terminal order must contain every terminal exactly once");
    }
    const byId = new Map(project.Terminals.map((terminal) => [terminal.Id, terminal]));
    const terminals = orderedIds.map((id) => {
      const terminal = byId.get(id);
      if (!terminal) throw new Error(`unknown terminal in order: ${id}`);
      return terminal;
    });
    return { ...project, Terminals: terminals };
  });
}

export function createSavedTerminal(
  id: string,
  name: string,
  startDirectory: string,
  createdAtUtc: string,
): SavedTerminalState {
  return {
    Id: id,
    Name: name,
    StartDirectory: startDirectory,
    CodexThreadId: null,
    GrokSessionId: null,
    CreatedAtUtc: createdAtUtc,
    CompletionPending: false,
  };
}

export function nextTerminalName(project: WorkspaceProject): string {
  const existing = new Set(project.Terminals.map((item) => item.Name.toLocaleLowerCase()));
  for (let number = 1; ; number += 1) {
    const candidate = `PowerShell ${number}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

function normalizeProject(value: unknown): WorkspaceProject {
  const project = requireRecord(value, "project");
  const folderPath = requireNonEmptyString(project.FolderPath, "project.FolderPath");
  if (!Array.isArray(project.Terminals)) throw new Error("project.Terminals must be an array");
  const terminals = project.Terminals.map(normalizeTerminal);
  if (new Set(terminals.map((terminal) => terminal.Id)).size !== terminals.length) {
    throw new Error("duplicate terminal Id in project");
  }

  const ratioSource = requireRecord(project.PaneWidthRatios, "project.PaneWidthRatios");
  const ratios: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(ratioSource)) {
    if (!key || !Array.isArray(value) || value.length === 0) {
      throw new Error("invalid project pane ratio entry");
    }
    if (!value.every((ratio) => typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0)) {
      throw new Error(`invalid pane ratios for ${key}`);
    }
    ratios[key] = [...value] as number[];
  }

  return {
    ...deepCloneRecord(project),
    Id: requireNonEmptyString(project.Id, "project.Id"),
    Name: requireNonEmptyString(project.Name, "project.Name"),
    FolderPath: folderPath,
    Terminals: terminals,
    PaneWidthRatios: ratios,
  };
}

function normalizeTerminal(value: unknown): SavedTerminalState {
  const terminal = requireRecord(value, "terminal");
  const startDirectory = requireNonEmptyString(
    terminal.StartDirectory,
    "terminal.StartDirectory",
  );
  return {
    ...deepCloneRecord(terminal),
    Id: requireNonEmptyString(terminal.Id, "terminal.Id"),
    Name: requireNonEmptyString(terminal.Name, "terminal.Name"),
    StartDirectory: startDirectory,
    CodexThreadId: requireNullableString(terminal.CodexThreadId, "terminal.CodexThreadId"),
    GrokSessionId: requireNullableString(terminal.GrokSessionId, "terminal.GrokSessionId"),
    CreatedAtUtc: requireNullableString(terminal.CreatedAtUtc, "terminal.CreatedAtUtc"),
    CompletionPending: requireBoolean(
      terminal.CompletionPending,
      "terminal.CompletionPending",
    ),
  };
}

function updateProject(
  catalog: ProjectCatalog,
  projectId: string,
  update: (project: WorkspaceProject) => WorkspaceProject,
): ProjectCatalog {
  let found = false;
  const projects = catalog.Projects.map((project) => {
    if (project.Id !== projectId) return project;
    found = true;
    return update(project);
  });
  if (!found) throw new Error(`project not found: ${projectId}`);
  return { ...catalog, Projects: projects, SelectedProjectId: catalog.SelectedProjectId };
}

function emptyTab(id: string): WorkspaceTab {
  return { id, kind: "empty", title: tr("New tab", "새 탭"), projectId: null };
}

function projectTab(project: WorkspaceProject, id: string): WorkspaceTab {
  return { id, kind: "project", title: project.Name, projectId: project.Id };
}

function normalizePathKey(path: string): string {
  return normalizeFolderInput(path).toLocaleLowerCase();
}

function isAbsoluteWindowsPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\");
  return /^[a-zA-Z]:\\/.test(normalized) || /^\\\\[^\\]+\\[^\\]+/.test(normalized);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeFolderInput(path: string): string {
  const normalized = path.trim().replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\+$/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  const uncRoot = normalized.match(/^(\\\\[^\\]+\\[^\\]+)\\*$/);
  if (uncRoot) return `${uncRoot[1]}\\`;
  return normalized.replace(/\\+$/, "");
}

function deepCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return deepCloneValue(value) as Record<string, unknown>;
}

function deepCloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCloneValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      deepCloneValue(item),
    ]),
  );
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
