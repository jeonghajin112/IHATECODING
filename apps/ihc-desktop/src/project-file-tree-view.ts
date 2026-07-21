import { invoke } from "@tauri-apps/api/core";
import { localizeBackendMessage, tr } from "./i18n";
import {
  ProjectFileTreeModel,
  type ProjectDirectoryResponse,
  type ProjectFileTreeSnapshot,
  type VisibleProjectFileNode,
} from "./project-file-tree";

export type ProjectFileTreeViewElements = {
  section: HTMLElement;
  toggleButton: HTMLButtonElement;
  refreshButton: HTMLButtonElement;
  title: HTMLElement;
  tree: HTMLElement;
  status: HTMLElement;
  onOpenFile?: ProjectFileOpenHandler;
};

export type ProjectFileOpenRequest = {
  projectId: string;
  projectName: string;
  name: string;
  pathSegments: string[];
};

export type ProjectFileOpenHandler = (
  request: ProjectFileOpenRequest,
) => void | Promise<void>;

type ProjectFileTreeProject = {
  id: string;
  name: string;
};

const PROJECT_FILES_EXPANDED_KEY = "ihatecoding.project-files-expanded.v1";

export class ProjectFileTreeView {
  private readonly listeners = new AbortController();
  private readonly model: ProjectFileTreeModel;
  private readonly unsubscribe: () => void;
  private activeProject: ProjectFileTreeProject | null = null;
  private snapshot: ProjectFileTreeSnapshot;
  private selectedKey: string | null = null;
  private focusedKey: string | null = null;
  private openingKey: string | null = null;
  private refreshing = false;
  private expanded = readExpandedPreference();

  constructor(private readonly elements: ProjectFileTreeViewElements) {
    this.model = new ProjectFileTreeModel(async ({ projectId, pathSegments }) => {
      try {
        return await invoke<ProjectDirectoryResponse>("list_project_directory", {
          projectId,
          pathSegments,
        });
      } catch (error) {
        throw new Error(projectFileTreeErrorMessage(error));
      }
    });
    this.snapshot = this.model.snapshot();
    this.unsubscribe = this.model.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.render();
    });

    const signal = this.listeners.signal;
    elements.toggleButton.addEventListener("click", () => this.setExpanded(!this.expanded), {
      signal,
    });
    elements.refreshButton.addEventListener("click", () => void this.refresh(), { signal });
    elements.tree.addEventListener("click", (event) => this.onTreeClick(event), { signal });
    elements.tree.addEventListener("keydown", (event) => this.onTreeKeyDown(event), {
      signal,
    });
    this.setExpanded(this.expanded, false);
  }

  showProject(project: ProjectFileTreeProject): void {
    const changed = this.activeProject?.id !== project.id;
    const nameChanged = this.activeProject?.name !== project.name;
    this.activeProject = { id: project.id, name: project.name };
    this.elements.section.hidden = false;
    if (changed) {
      this.selectedKey = null;
      this.focusedKey = null;
    }
    if (changed || nameChanged) this.updateLocalizedLabels();
    void this.model.activateProject(project.id);
  }

  hide(): void {
    if (this.activeProject === null && this.elements.section.hidden) return;
    this.activeProject = null;
    this.selectedKey = null;
    this.focusedKey = null;
    this.openingKey = null;
    this.elements.section.hidden = true;
    this.elements.tree.replaceChildren();
    this.elements.status.textContent = "";
    this.model.clearProject();
  }

  refreshLocalizedUi(): void {
    this.updateLocalizedLabels();
    if (!this.elements.section.hidden) this.render();
  }

  private updateLocalizedLabels(): void {
    const project = this.activeProject;
    this.elements.title.textContent = project?.name ?? tr("Files", "파일");
    const treeLabel = project
      ? tr(`Files in ${project.name}`, `${project.name} 파일`)
      : tr("Project files", "프로젝트 파일");
    this.elements.tree.setAttribute("aria-label", treeLabel);
    this.setExpanded(this.expanded, false);
    const refreshLabel = tr("Refresh project files", "프로젝트 파일 새로고침");
    this.elements.refreshButton.setAttribute("aria-label", refreshLabel);
    this.elements.refreshButton.title = refreshLabel;
  }

  dispose(): void {
    this.listeners.abort();
    this.unsubscribe();
    this.model.clearProject();
    this.activeProject = null;
  }

  private setExpanded(expanded: boolean, persist = true): void {
    this.expanded = expanded;
    this.elements.section.dataset.expanded = String(expanded);
    this.elements.toggleButton.setAttribute("aria-expanded", String(expanded));
    const label = expanded
      ? tr("Collapse project files", "프로젝트 파일 접기")
      : tr("Expand project files", "프로젝트 파일 펼치기");
    this.elements.toggleButton.setAttribute("aria-label", label);
    this.elements.toggleButton.title = label;
    if (persist) {
      try {
        localStorage.setItem(PROJECT_FILES_EXPANDED_KEY, String(expanded));
      } catch {
        // The current view can still change when WebView storage is unavailable.
      }
    }
    if (expanded && this.activeProject && this.snapshot.root.loadState === "idle") {
      void this.model.activateProject(this.activeProject.id);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.activeProject || this.refreshing) return;
    const expandedDirectories = this.snapshot.visibleNodes
      .filter((node) => node.kind === "directory" && node.expanded)
      .map((node) => [...node.segments])
      .sort((left, right) => left.length - right.length);
    this.refreshing = true;
    this.elements.refreshButton.disabled = true;
    this.elements.section.setAttribute("aria-busy", "true");
    try {
      const rootRefreshed = await this.model.refresh([]);
      if (!rootRefreshed) return;
      for (const segments of expandedDirectories) {
        await this.model.refresh(segments);
      }
      this.announce(tr("Project files refreshed.", "프로젝트 파일을 새로고침했습니다."));
    } finally {
      this.refreshing = false;
      this.elements.refreshButton.disabled = false;
      this.elements.section.removeAttribute("aria-busy");
    }
  }

  private render(): void {
    if (
      this.elements.section.hidden ||
      !this.activeProject ||
      this.snapshot.projectId !== this.activeProject.id
    ) {
      return;
    }

    const activeElement = document.activeElement;
    const hadTreeFocus = activeElement instanceof Node && this.elements.tree.contains(activeElement);
    const focusedRow = activeElement instanceof Element
      ? activeElement.closest<HTMLElement>(".project-file-tree-row")
      : null;
    if (focusedRow?.dataset.key) this.focusedKey = focusedRow.dataset.key;

    const fragment = document.createDocumentFragment();
    const root = this.snapshot.root;
    this.elements.tree.setAttribute("aria-busy", String(root.loadState === "loading"));

    if (root.loadState === "loading" && root.entries.length === 0) {
      fragment.append(this.createMessage(tr("Loading files…", "파일 불러오는 중…"), 0, "loading"));
    } else if (root.loadState === "error") {
      fragment.append(this.createErrorMessage(root.error, [], 0));
    } else if (root.loadState === "loaded" && root.entries.length === 0) {
      fragment.append(this.createMessage(tr("This folder is empty.", "빈 폴더입니다."), 0));
    }

    for (const node of this.snapshot.visibleNodes) {
      fragment.append(this.createTreeRow(node));
      if (!node.expanded) continue;
      if (node.loadState === "loading") {
        fragment.append(
          this.createMessage(tr("Loading…", "불러오는 중…"), node.depth, "loading"),
        );
      } else if (node.loadState === "error") {
        fragment.append(this.createErrorMessage(node.error, node.segments, node.depth));
      } else if (node.loadState === "loaded" && !this.hasVisibleChild(node)) {
        fragment.append(this.createMessage(tr("Empty folder", "빈 폴더"), node.depth));
      }
      if (node.truncated) {
        fragment.append(
          this.createMessage(
            tr("Some items are not shown.", "일부 항목은 표시되지 않습니다."),
            node.depth,
          ),
        );
      }
    }

    if (root.truncated) {
      fragment.append(
        this.createMessage(
          tr("Some root items are not shown.", "루트의 일부 항목은 표시되지 않습니다."),
          0,
        ),
      );
    }

    this.elements.tree.replaceChildren(fragment);
    const rows = this.treeRows();
    const preferred = rows.find((row) => row.dataset.key === this.focusedKey)
      ?? rows.find((row) => row.dataset.key === this.selectedKey)
      ?? rows[0]
      ?? null;
    for (const row of rows) row.tabIndex = row === preferred ? 0 : -1;
    if (hadTreeFocus && preferred) preferred.focus({ preventScroll: true });
  }

  private createTreeRow(node: VisibleProjectFileNode): HTMLElement {
    const row = document.createElement("div");
    row.className = "project-file-tree-row";
    row.dataset.key = node.key;
    row.dataset.segments = JSON.stringify(node.segments);
    row.dataset.kind = node.kind;
    row.dataset.selected = String(node.key === this.selectedKey);
    row.dataset.hidden = String(node.hidden === true);
    row.style.setProperty("--tree-indent", `${Math.max(0, node.depth - 1) * 13}px`);
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(node.depth));
    row.setAttribute("aria-selected", String(node.key === this.selectedKey));
    if (node.kind === "directory") {
      row.setAttribute("aria-expanded", String(node.expanded));
    }
    row.tabIndex = -1;

    const disclosure = document.createElement("span");
    disclosure.className = "project-file-tree-disclosure";
    disclosure.dataset.expanded = String(node.expanded);
    disclosure.setAttribute("aria-hidden", "true");
    if (node.kind === "directory") disclosure.append(createTreeSvg("chevron"));

    const icon = document.createElement("span");
    icon.className = "project-file-tree-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(createTreeSvg(node.kind));

    const name = document.createElement("span");
    name.className = "project-file-tree-name";
    name.textContent = node.name;
    row.title = node.name;
    row.append(disclosure, icon, name);
    return row;
  }

  private createMessage(
    message: string,
    depth: number,
    tone: "normal" | "loading" = "normal",
  ): HTMLElement {
    const element = document.createElement("div");
    element.className = "project-file-tree-message";
    element.style.setProperty("--tree-indent", `${Math.max(0, depth) * 13}px`);
    if (tone === "loading") {
      const spinner = document.createElement("span");
      spinner.className = "project-file-tree-spinner";
      spinner.setAttribute("aria-hidden", "true");
      element.append(spinner);
    }
    const text = document.createElement("span");
    text.textContent = message;
    element.append(text);
    return element;
  }

  private createErrorMessage(
    error: string | null,
    segments: readonly string[],
    depth: number,
  ): HTMLElement {
    const element = this.createMessage(
      error ? localizeBackendMessage(error) : tr("Could not load this folder.", "폴더를 불러오지 못했습니다."),
      depth,
    );
    element.dataset.tone = "error";
    const retry = document.createElement("button");
    retry.className = "project-file-tree-retry";
    retry.type = "button";
    retry.textContent = tr("Retry", "다시 시도");
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.model.retry(segments);
    });
    element.append(retry);
    return element;
  }

  private hasVisibleChild(parent: VisibleProjectFileNode): boolean {
    const index = this.snapshot.visibleNodes.findIndex((node) => node.key === parent.key);
    return index >= 0 && this.snapshot.visibleNodes[index + 1]?.depth === parent.depth + 1;
  }

  private onTreeClick(event: MouseEvent): void {
    const row = this.eventRow(event);
    if (!row) return;
    row.focus();
    this.focusedKey = row.dataset.key ?? null;
    this.selectRow(row);
    if (row.dataset.kind === "directory" && event.detail <= 1) {
      const segments = rowSegments(row);
      if (segments) void this.model.toggle(segments);
    } else if (row.dataset.kind === "file" && event.detail <= 1) {
      void this.openFileRow(row);
    }
  }

  private onTreeKeyDown(event: KeyboardEvent): void {
    const row = this.eventRow(event);
    if (!row) return;
    const rows = this.treeRows();
    const index = rows.indexOf(row);
    if (index < 0) return;

    const focusAt = (nextIndex: number) => {
      const next = rows[nextIndex];
      if (!next) return;
      event.preventDefault();
      this.focusRow(next);
    };

    switch (event.key) {
      case "ArrowDown":
        focusAt(Math.min(rows.length - 1, index + 1));
        return;
      case "ArrowUp":
        focusAt(Math.max(0, index - 1));
        return;
      case "Home":
        focusAt(0);
        return;
      case "End":
        focusAt(rows.length - 1);
        return;
      case "ArrowRight": {
        if (row.dataset.kind !== "directory") return;
        event.preventDefault();
        if (row.getAttribute("aria-expanded") !== "true") {
          const segments = rowSegments(row);
          if (segments) void this.model.expand(segments);
          return;
        }
        const level = Number(row.getAttribute("aria-level"));
        const child = rows[index + 1];
        if (child && Number(child.getAttribute("aria-level")) === level + 1) this.focusRow(child);
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (row.dataset.kind === "directory" && row.getAttribute("aria-expanded") === "true") {
          const segments = rowSegments(row);
          if (segments) this.model.collapse(segments);
          return;
        }
        const level = Number(row.getAttribute("aria-level"));
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
          if (Number(rows[candidate].getAttribute("aria-level")) < level) {
            this.focusRow(rows[candidate]);
            break;
          }
        }
        return;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        this.selectRow(row);
        if (row.dataset.kind === "directory") {
          const segments = rowSegments(row);
          if (segments) void this.model.toggle(segments);
        } else if (event.key === "Enter" && row.dataset.kind === "file") {
          void this.openFileRow(row);
        }
        return;
      }
      default:
        return;
    }
  }

  private async openFileRow(row: HTMLElement): Promise<void> {
    const key = row.dataset.key;
    const segments = rowSegments(row);
    const projectId = this.activeProject?.id;
    if (!key || !segments || !projectId || this.openingKey === key) return;
    const node = this.snapshot.visibleNodes.find((candidate) => candidate.key === key);
    if (!node || node.kind !== "file") return;
    const openFile = this.elements.onOpenFile;
    if (!openFile && node.openable !== true) {
      this.announce(
        tr(
          `${node.name} cannot be opened safely from the project tree.`,
          `${node.name} 파일은 프로젝트 트리에서 안전하게 열 수 없습니다.`,
        ),
      );
      return;
    }
    this.openingKey = key;
    try {
      if (openFile) {
        await openFile({
          projectId,
          projectName: this.activeProject?.name ?? projectId,
          name: node.name,
          pathSegments: [...segments],
        });
      } else {
        await invoke("open_project_file", { projectId, pathSegments: segments });
      }
      this.announce(tr(`Opened ${node.name}.`, `${node.name} 파일을 열었습니다.`));
    } catch (error) {
      this.announce(projectFileTreeErrorMessage(error));
    } finally {
      if (this.openingKey === key) this.openingKey = null;
    }
  }

  private selectRow(row: HTMLElement): void {
    this.selectedKey = row.dataset.key ?? null;
    for (const candidate of this.treeRows()) {
      const selected = candidate.dataset.key === this.selectedKey;
      candidate.dataset.selected = String(selected);
      candidate.setAttribute("aria-selected", String(selected));
    }
  }

  private focusRow(row: HTMLElement): void {
    for (const candidate of this.treeRows()) candidate.tabIndex = candidate === row ? 0 : -1;
    this.focusedKey = row.dataset.key ?? null;
    row.focus();
  }

  private eventRow(event: Event): HTMLElement | null {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>(".project-file-tree-row") ?? null;
    return row && this.elements.tree.contains(row) ? row : null;
  }

  private treeRows(): HTMLElement[] {
    return [...this.elements.tree.querySelectorAll<HTMLElement>(".project-file-tree-row")];
  }

  private announce(message: string): void {
    this.elements.status.textContent = message;
  }
}

function rowSegments(row: HTMLElement): string[] | null {
  const value = row.dataset.segments;
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((segment) => typeof segment === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function readExpandedPreference(): boolean {
  try {
    return localStorage.getItem(PROJECT_FILES_EXPANDED_KEY) !== "false";
  } catch {
    return true;
  }
}

function projectFileTreeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return localizeBackendMessage(error.message.trim());
  }
  if (typeof error === "string" && error.trim()) {
    return localizeBackendMessage(error.trim());
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return localizeBackendMessage(message.trim());
    }
  }
  return tr("Could not complete the project file action.", "프로젝트 파일 작업을 완료하지 못했습니다.");
}

function createTreeSvg(kind: "chevron" | "directory" | "file" | "symlink" | "other"):
  SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("focusable", "false");
  const paths: Record<typeof kind, readonly string[]> = {
    chevron: ["M5.5 3.5 10 8l-4.5 4.5"],
    directory: ["M1.8 4.2h4l1.4 1.6h7v6.7H1.8z"],
    file: ["M3.2 1.8h6l3.6 3.6v8.8H3.2z", "M9.2 1.8v3.8h3.6"],
    symlink: ["M6.2 5H5a3 3 0 0 0 0 6h1.2", "M9.8 5H11a3 3 0 0 1 0 6H9.8", "M5.7 8h4.6"],
    other: ["M3 3h10v10H3z"],
  };
  for (const data of paths[kind]) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}
