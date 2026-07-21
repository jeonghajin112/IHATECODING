export type ProjectFileKind = "directory" | "file" | "symlink" | "other";

export type ProjectFileEntry = {
  name: string;
  segments: string[];
  kind: ProjectFileKind;
  hidden?: boolean;
  openable?: boolean;
};

export type ProjectDirectoryRequest = {
  projectId: string;
  pathSegments: string[];
};

export type ProjectDirectoryResponse = {
  entries: ProjectFileEntry[];
  truncated: boolean;
};

export type ProjectDirectoryLoader = (
  request: ProjectDirectoryRequest,
) => Promise<ProjectDirectoryResponse>;

export type ProjectDirectoryLoadState = "idle" | "loading" | "loaded" | "error";

export type ProjectDirectoryLoadSnapshot = {
  pathSegments: string[];
  loadState: ProjectDirectoryLoadState;
  entries: ProjectFileEntry[];
  truncated: boolean;
  error: string | null;
};

export type VisibleProjectFileNode = ProjectFileEntry & {
  key: string;
  depth: number;
  expanded: boolean;
  loadState: ProjectDirectoryLoadState;
  truncated: boolean;
  error: string | null;
};

export type ProjectFileTreeSnapshot = {
  projectId: string | null;
  root: ProjectDirectoryLoadSnapshot;
  visibleNodes: VisibleProjectFileNode[];
};

export type ProjectFileTreeListener = (snapshot: ProjectFileTreeSnapshot) => void;

type DirectoryRecord = {
  pathSegments: string[];
  loadState: ProjectDirectoryLoadState;
  entries: ProjectFileEntry[];
  truncated: boolean;
  error: string | null;
  requestSerial: number;
  pending: Promise<boolean> | null;
};

const fileNameCollator = new Intl.Collator(["en", "ko"], {
  numeric: true,
  sensitivity: "base",
});

const projectFileKinds = new Set<ProjectFileKind>([
  "directory",
  "file",
  "symlink",
  "other",
]);

export function projectFileTreePathKey(pathSegments: readonly string[]): string {
  return JSON.stringify(validateProjectPathSegments(pathSegments));
}

export function validateProjectPathSegments(pathSegments: readonly string[]): string[] {
  if (!Array.isArray(pathSegments)) throw new Error("Project path segments must be an array.");
  return pathSegments.map((segment) => {
    if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw new Error("A project path contains an invalid segment.");
    }
    return segment;
  });
}

export function sortProjectFileEntries(
  entries: readonly ProjectFileEntry[],
): ProjectFileEntry[] {
  return entries.map(cloneEntry).sort((left, right) => {
    const leftGroup = left.kind === "directory" ? 0 : 1;
    const rightGroup = right.kind === "directory" ? 0 : 1;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    const insensitive = fileNameCollator.compare(left.name, right.name);
    return insensitive !== 0 ? insensitive : left.name.localeCompare(right.name, "en");
  });
}

export function normalizeProjectDirectoryResponse(
  response: ProjectDirectoryResponse,
  parentSegments: readonly string[],
): ProjectDirectoryResponse {
  const parent = validateProjectPathSegments(parentSegments);
  if (!response || typeof response !== "object" || !Array.isArray(response.entries)) {
    throw new Error("The project directory response is invalid.");
  }
  if (typeof response.truncated !== "boolean") {
    throw new Error("The project directory response has an invalid truncation flag.");
  }

  const seen = new Set<string>();
  const entries = response.entries.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("The project directory response contains an invalid entry.");
    }
    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      throw new Error("A project directory entry has an invalid name.");
    }
    if (!projectFileKinds.has(candidate.kind)) {
      throw new Error("A project directory entry has an invalid kind.");
    }
    const segments = validateProjectPathSegments(candidate.segments);
    if (
      segments.length !== parent.length + 1 ||
      segments[segments.length - 1] !== candidate.name ||
      parent.some((segment, index) => segments[index] !== segment)
    ) {
      throw new Error("A project directory entry is outside its requested parent.");
    }
    const key = projectFileTreePathKey(segments);
    if (seen.has(key)) throw new Error("A project directory response contains duplicate entries.");
    seen.add(key);
    return {
      name: candidate.name,
      segments,
      kind: candidate.kind,
      ...(typeof candidate.hidden === "boolean" ? { hidden: candidate.hidden } : {}),
      ...(typeof candidate.openable === "boolean" ? { openable: candidate.openable } : {}),
    } satisfies ProjectFileEntry;
  });

  return { entries: sortProjectFileEntries(entries), truncated: response.truncated };
}

export class ProjectFileTreeModel {
  private activeProjectId: string | null = null;
  private generation = 0;
  private requestSerial = 0;
  private readonly directories = new Map<string, DirectoryRecord>();
  private readonly expandedDirectories = new Set<string>();
  private readonly listeners = new Set<ProjectFileTreeListener>();

  constructor(private readonly loadDirectory: ProjectDirectoryLoader) {}

  subscribe(listener: ProjectFileTreeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async activateProject(projectId: string): Promise<boolean> {
    if (typeof projectId !== "string" || projectId.trim().length === 0) {
      throw new Error("A project identifier is required.");
    }
    if (this.activeProjectId !== projectId) {
      this.generation += 1;
      this.activeProjectId = projectId;
      this.directories.clear();
      this.expandedDirectories.clear();
      this.emitChange();
    }
    return this.ensureDirectory([], false);
  }

  clearProject(): void {
    if (this.activeProjectId === null && this.directories.size === 0) return;
    this.generation += 1;
    this.activeProjectId = null;
    this.directories.clear();
    this.expandedDirectories.clear();
    this.emitChange();
  }

  async expand(pathSegments: readonly string[]): Promise<boolean> {
    const segments = validateProjectPathSegments(pathSegments);
    if (!this.canExpand(segments)) return false;
    if (segments.length > 0) {
      const key = projectFileTreePathKey(segments);
      if (!this.expandedDirectories.has(key)) {
        this.expandedDirectories.add(key);
        this.emitChange();
      }
    }
    return this.ensureDirectory(segments, false);
  }

  collapse(pathSegments: readonly string[]): boolean {
    const segments = validateProjectPathSegments(pathSegments);
    if (segments.length === 0) return false;
    const changed = this.expandedDirectories.delete(projectFileTreePathKey(segments));
    if (changed) this.emitChange();
    return changed;
  }

  async toggle(pathSegments: readonly string[]): Promise<boolean> {
    const segments = validateProjectPathSegments(pathSegments);
    const key = projectFileTreePathKey(segments);
    if (segments.length > 0 && this.expandedDirectories.has(key)) {
      return this.collapse(segments);
    }
    return this.expand(segments);
  }

  async retry(pathSegments: readonly string[]): Promise<boolean> {
    const segments = validateProjectPathSegments(pathSegments);
    if (!this.canExpand(segments)) return false;
    if (segments.length > 0 && !this.expandedDirectories.has(projectFileTreePathKey(segments))) {
      this.expandedDirectories.add(projectFileTreePathKey(segments));
      this.emitChange();
    }
    return this.ensureDirectory(segments, true);
  }

  async refresh(pathSegments: readonly string[]): Promise<boolean> {
    const segments = validateProjectPathSegments(pathSegments);
    if (!this.canExpand(segments)) return false;
    return this.ensureDirectory(segments, true);
  }

  snapshot(): ProjectFileTreeSnapshot {
    const root = this.directorySnapshot([]);
    const visibleNodes: VisibleProjectFileNode[] = [];
    this.appendVisibleNodes(root.entries, 1, visibleNodes);
    return {
      projectId: this.activeProjectId,
      root,
      visibleNodes,
    };
  }

  private canExpand(pathSegments: readonly string[]): boolean {
    if (this.activeProjectId === null) return false;
    if (pathSegments.length === 0) return true;
    const parent = pathSegments.slice(0, -1);
    const parentRecord = this.directories.get(projectFileTreePathKey(parent));
    const key = projectFileTreePathKey(pathSegments);
    return parentRecord?.entries.some(
      (entry) => projectFileTreePathKey(entry.segments) === key && entry.kind === "directory",
    ) ?? false;
  }

  private async ensureDirectory(
    pathSegments: readonly string[],
    force: boolean,
  ): Promise<boolean> {
    const projectId = this.activeProjectId;
    if (projectId === null) return false;
    const segments = validateProjectPathSegments(pathSegments);
    const key = projectFileTreePathKey(segments);
    const record = this.directories.get(key) ?? this.createDirectoryRecord(segments);
    if (record.pending) return record.pending;
    if (!force && record.loadState === "loaded") return true;

    const generation = this.generation;
    const requestSerial = ++this.requestSerial;
    record.requestSerial = requestSerial;
    record.loadState = "loading";
    record.error = null;
    this.emitChange();

    const pending = Promise.resolve()
      .then(() => this.loadDirectory({ projectId, pathSegments: [...segments] }))
      .then((response) => {
        const normalized = normalizeProjectDirectoryResponse(response, segments);
        if (!this.isCurrentRequest(projectId, generation, key, requestSerial, record)) {
          return false;
        }
        record.entries = normalized.entries;
        record.truncated = normalized.truncated;
        record.loadState = "loaded";
        record.error = null;
        this.emitChange();
        return true;
      })
      .catch((error: unknown) => {
        if (!this.isCurrentRequest(projectId, generation, key, requestSerial, record)) {
          return false;
        }
        record.loadState = "error";
        record.error = projectFileTreeErrorMessage(error);
        record.truncated = false;
        this.emitChange();
        return false;
      })
      .finally(() => {
        if (record.requestSerial === requestSerial) record.pending = null;
      });
    record.pending = pending;
    return pending;
  }

  private createDirectoryRecord(pathSegments: readonly string[]): DirectoryRecord {
    const record: DirectoryRecord = {
      pathSegments: [...pathSegments],
      loadState: "idle",
      entries: [],
      truncated: false,
      error: null,
      requestSerial: 0,
      pending: null,
    };
    this.directories.set(projectFileTreePathKey(pathSegments), record);
    return record;
  }

  private isCurrentRequest(
    projectId: string,
    generation: number,
    key: string,
    requestSerial: number,
    record: DirectoryRecord,
  ): boolean {
    return (
      this.activeProjectId === projectId &&
      this.generation === generation &&
      this.directories.get(key) === record &&
      record.requestSerial === requestSerial
    );
  }

  private directorySnapshot(pathSegments: readonly string[]): ProjectDirectoryLoadSnapshot {
    const segments = validateProjectPathSegments(pathSegments);
    const record = this.directories.get(projectFileTreePathKey(segments));
    return {
      pathSegments: [...segments],
      loadState: record?.loadState ?? "idle",
      entries: record?.entries.map(cloneEntry) ?? [],
      truncated: record?.truncated ?? false,
      error: record?.error ?? null,
    };
  }

  private appendVisibleNodes(
    entries: readonly ProjectFileEntry[],
    depth: number,
    target: VisibleProjectFileNode[],
  ): void {
    for (const entry of entries) {
      const key = projectFileTreePathKey(entry.segments);
      const expanded = entry.kind === "directory" && this.expandedDirectories.has(key);
      const childRecord = entry.kind === "directory" ? this.directories.get(key) : undefined;
      target.push({
        ...cloneEntry(entry),
        key,
        depth,
        expanded,
        loadState: childRecord?.loadState ?? "idle",
        truncated: childRecord?.truncated ?? false,
        error: childRecord?.error ?? null,
      });
      if (expanded && childRecord) {
        this.appendVisibleNodes(childRecord.entries, depth + 1, target);
      }
    }
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A view listener must not be able to corrupt asynchronous tree state.
      }
    }
  }
}

function cloneEntry(entry: ProjectFileEntry): ProjectFileEntry {
  return {
    name: entry.name,
    segments: [...entry.segments],
    kind: entry.kind,
    ...(typeof entry.hidden === "boolean" ? { hidden: entry.hidden } : {}),
    ...(typeof entry.openable === "boolean" ? { openable: entry.openable } : {}),
  };
}

function projectFileTreeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "Could not load this folder.";
}
