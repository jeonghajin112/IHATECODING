import { invoke } from "@tauri-apps/api/core";
import {
  applyWorkspaceSaveSuccess,
  beginWorkspaceSave,
  createWorkspaceSession,
  normalizeWorkspaceLoadResponse,
  projectUnreadCount,
  replaceWorkspaceDraft,
  setProjectPaneWidthRatios,
  setTerminalCompletionPending,
  type WorkspaceProject,
  type WorkspaceSession,
  type WorkspaceState,
  type WorkspaceTerminal,
} from "./phase3b-core";
import {
  activateRelativeWorkspaceTab,
  activateWorkspaceTab,
  addBlankWorkspaceTab,
  appendProjectPane,
  appendWorkspaceProject,
  applyProjectPaneInsertion,
  closeWorkspaceTab,
  createWorkspaceProject,
  createWorkspaceTerminal,
  evaluateWorkspaceRestoreCapacity,
  findWorkspaceProjectByFolder,
  moveWorkspaceTabByKeyboard,
  nextWorkspacePaneName,
  openProjectWorkspaceTab,
  removeProjectPane,
  renameProjectPane,
  uniqueWorkspaceProjectName,
  validateWorkspaceProjectDraft,
  type PaneInsertionTarget,
  type RestoreCapacityDecision,
} from "./phase4-core";
import { deriveSafeResumePlans, type SafeResumePlan } from "./phase5-core";

type StatusTone = "normal" | "error";

type StorageStatus = {
  writable: boolean;
  revision: number | null;
};

type Phase3PreviewInspection = {
  available: boolean;
  projectCount: number;
  terminalCount: number;
  sourceSha256: string | null;
};

export type Phase4RuntimePort = {
  restoreCapacity(
    project: WorkspaceProject,
    unloadingProjectId?: string | null,
  ): RestoreCapacityDecision;
  showProject(project: WorkspaceProject): boolean;
  showEmptyView(): void;
  unloadProject(projectId: string): Promise<void>;
  unloadAllProjects(): Promise<void>;
  addPane(projectId: string, terminal: WorkspaceTerminal, focus?: boolean): unknown;
  syncProject(project: WorkspaceProject): void;
  setResumePlans(plans: SafeResumePlan[]): void;
  setTerminalCompletionPending(
    projectId: string,
    terminalId: string,
    completionPending: boolean,
    playSound?: boolean,
  ): void;
  setCatalogWritable(writable: boolean): void;
  setFooterStatus(message: string, tone?: StatusTone): void;
};

export type Phase4ControllerElements = {
  projectList: HTMLElement;
  projectCount: HTMLElement;
  tabList: HTMLElement;
  currentProject: HTMLElement;
  addTerminalButton: HTMLButtonElement;
  addTabButton: HTMLButtonElement;
  createProjectButton: HTMLButtonElement;
  projectDialog: HTMLDialogElement;
  projectForm: HTMLFormElement;
  projectName: HTMLInputElement;
  projectPath: HTMLInputElement;
  projectFormError: HTMLElement;
  cancelProjectButton: HTMLButtonElement;
  upgradeButton: HTMLButtonElement;
  upgradeDialog: HTMLDialogElement;
  upgradeProjectCount: HTMLElement;
  upgradeTerminalCount: HTMLElement;
  upgradeSourceSha: HTMLElement;
  commitUpgradeButton: HTMLButtonElement;
  closeUpgradeButton: HTMLButtonElement;
  upgradeError: HTMLElement;
};

export class Phase4WorkspaceController {
  private session: WorkspaceSession | null = null;
  private initialized = false;
  private storageWritable = false;
  private shuttingDown = false;
  private mutationPending = false;
  private externalReplacementPending = false;
  private storageFaulted = false;
  private upgradeInspection: Phase3PreviewInspection | null = null;
  private activeOperation: Promise<unknown> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperationCount = 0;
  private externalReplacementBarrier: Promise<void> | null = null;
  private resolveExternalReplacement: (() => void) | null = null;
  private readonly listeners = new AbortController();

  constructor(
    private readonly runtime: Phase4RuntimePort,
    private readonly elements: Phase4ControllerElements,
    private readonly idFactory: () => string = createOpaqueId,
  ) {
    const signal = this.listeners.signal;
    elements.addTerminalButton.addEventListener("click", () => void this.addTerminal(), {
      signal,
    });
    elements.addTabButton.addEventListener("click", () => void this.addBlankTab(), { signal });
    elements.createProjectButton.addEventListener(
      "click",
      () => {
        if (this.canMutate()) this.openProjectDialog();
      },
      { signal },
    );
    elements.cancelProjectButton.addEventListener(
      "click",
      () => elements.projectDialog.close(),
      { signal },
    );
    elements.projectForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.createProject();
      },
      { signal },
    );
    elements.upgradeButton.addEventListener("click", () => this.openUpgradeDialog(), {
      signal,
    });
    elements.closeUpgradeButton.addEventListener(
      "click",
      () => {
        if (!this.mutationPending && !this.externalReplacementPending) {
          elements.upgradeDialog.close();
        }
      },
      { signal },
    );
    elements.upgradeDialog.addEventListener(
      "cancel",
      (event) => {
        if (this.mutationPending || this.externalReplacementPending) {
          event.preventDefault();
        }
      },
      { signal },
    );
    elements.commitUpgradeButton.addEventListener(
      "click",
      () => void this.commitPhase3PreviewUpgrade(),
      { signal },
    );
    this.refreshControls();
  }

  async initialize(): Promise<void> {
    await this.reloadFromCanonicalStore(true);
  }

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.refreshControls();
    this.runtime.setFooterStatus("Rust 작업 공간을 저장한 뒤 종료하는 중…");
  }

  async flushSaves(): Promise<void> {
    // A replacement may create a barrier while an earlier save settles, and
    // the upgrade path may install an active operation after its unload phase.
    // Observe both until one complete pass sees the same settled pair.
    for (;;) {
      const operation = this.activeOperation;
      const replacement = this.externalReplacementBarrier;
      await operation;
      if (replacement) await replacement;
      if (
        operation === this.activeOperation &&
        replacement === this.externalReplacementBarrier
      ) {
        break;
      }
    }
    if (this.storageFaulted || this.session?.dirty || this.session?.phase !== "idle") {
      throw new Error(
        this.session?.lastError?.message ??
          "저장되지 않은 Rust 작업 공간 변경이 남아 있습니다.",
      );
    }
  }

  dispose(): void {
    this.listeners.abort();
    if (this.elements.projectDialog.open) this.elements.projectDialog.close();
    if (this.elements.upgradeDialog.open) this.elements.upgradeDialog.close();
  }

  async prepareForExternalReplacement(allowPreviewUpgrade = false): Promise<void> {
    if (this.externalReplacementPending) {
      throw new Error("다른 저장소 교체 작업이 이미 진행 중입니다.");
    }
    if (this.upgradeInspection !== null && !allowPreviewUpgrade) {
      throw new Error("이전 Rust Preview 상태의 안전한 복사를 먼저 완료하세요.");
    }
    await this.flushSaves();
    if (this.shuttingDown) throw new Error("종료 중에는 저장소를 교체할 수 없습니다.");
    this.externalReplacementPending = true;
    this.externalReplacementBarrier = new Promise<void>((resolve) => {
      this.resolveExternalReplacement = resolve;
    });
    this.refreshControls();
    try {
      // The old process trees must be gone before the backend swaps canonical
      // bytes. This prevents live terminals from writing against a workspace
      // identity that no longer exists.
      await this.runtime.unloadAllProjects();
      if (this.shuttingDown) {
        throw new Error("종료가 시작되어 저장소 교체를 취소했습니다.");
      }
      this.runtime.showEmptyView();
    } catch (error) {
      this.externalReplacementPending = false;
      this.resolveExternalReplacement?.();
      this.resolveExternalReplacement = null;
      this.externalReplacementBarrier = null;
      this.refreshControls();
      if (!this.shuttingDown) this.renderAndActivate();
      throw error;
    }
  }

  async finishExternalReplacement(committed: boolean): Promise<void> {
    if (!this.externalReplacementPending) return;
    try {
      if (!this.shuttingDown) {
        const recheckUpgrade = !committed && this.upgradeInspection !== null;
        if (!(await this.reloadFromCanonicalStore(recheckUpgrade))) {
          throw new Error(
            committed
              ? "저장소 교체는 완료됐지만 새 canonical 상태를 다시 불러오지 못했습니다."
              : "저장소 교체를 취소한 뒤 기존 canonical 상태를 복원하지 못했습니다.",
          );
        }
      }
    } finally {
      this.externalReplacementPending = false;
      this.resolveExternalReplacement?.();
      this.resolveExternalReplacement = null;
      this.externalReplacementBarrier = null;
      this.refreshControls();
    }
  }

  async onPaneClosed(projectId: string, paneId: string): Promise<boolean> {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return false;
    try {
      const next = removeProjectPane(state, projectId, paneId);
      return await this.persist(next, "PowerShell 삭제 상태를 저장하지 못했습니다");
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
      return false;
    }
  }

  /**
   * Durable provider completion. Runtime decoration and sound are deliberately
   * applied only after the canonical compare-and-swap has committed.
   */
  async onAgentTurnCompleted(projectId: string, terminalId: string): Promise<boolean> {
    return this.persistRuntimeCompletion(projectId, terminalId, true, true);
  }

  /** Explicit pane interaction is the only acknowledgement path. */
  async acknowledgeTerminalCompletion(
    projectId: string,
    terminalId: string,
  ): Promise<boolean> {
    return this.persistRuntimeCompletion(projectId, terminalId, false, false);
  }

  async onPaneRenamed(
    projectId: string,
    paneId: string,
    title: string,
  ): Promise<boolean> {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return false;
    try {
      const next = renameProjectPane(state, projectId, paneId, title);
      return await this.persist(next, "PowerShell 이름을 저장하지 못했습니다");
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
      return false;
    }
  }

  onPaneReordered(
    projectId: string,
    draggedPaneId: string,
    target: Pick<PaneInsertionTarget, "beforePaneId">,
  ): void {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return;
    try {
      const next = applyProjectPaneInsertion(state, projectId, draggedPaneId, target);
      void this.persist(next, "PowerShell 배치를 저장하지 못했습니다").then((saved) => {
        const project = this.currentState()?.projects.find((item) => item.id === projectId);
        if (project) this.runtime.syncProject(project);
        if (!saved && project) this.runtime.showProject(project);
      });
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
      const project = state.projects.find((item) => item.id === projectId);
      if (project) {
        this.runtime.syncProject(project);
        this.runtime.showProject(project);
      }
    }
  }

  onPaneRatiosChanged(projectId: string, layoutKey: string, ratios: number[]): void {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return;
    try {
      const next = setProjectPaneWidthRatios(state, projectId, layoutKey, ratios);
      void this.persist(next, "PowerShell 너비를 저장하지 못했습니다").then((saved) => {
        const project = this.currentState()?.projects.find((item) => item.id === projectId);
        if (project) this.runtime.syncProject(project);
        if (!saved && project) this.runtime.showProject(project);
      });
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
    }
  }

  private async reloadFromCanonicalStore(checkUpgrade: boolean): Promise<boolean> {
    this.initialized = false;
    this.storageWritable = false;
    this.storageFaulted = false;
    this.refreshControls();
    try {
      const [statusValue, loadValue] = await Promise.all([
        invoke<unknown>("storage_status"),
        invoke<unknown>("load_workspace_state"),
      ]);
      if (this.shuttingDown) return false;
      const status = normalizeStorageStatus(statusValue);
      const load = normalizeWorkspaceLoadResponse(loadValue);
      this.storageWritable = status.writable;
      this.session = createWorkspaceSession(load, status.writable ? "ready" : "readOnly");
      this.initialized = true;

      if (this.session.draft === null) {
        this.renderAndActivate();
        this.runtime.setFooterStatus(storageAccessMessage(this.session), "error");
        return true;
      }

      if (
        checkUpgrade &&
        this.session.access === "ready" &&
        this.session.snapshot?.revision === 0
      ) {
        const inspection = normalizePhase3PreviewInspection(
          await invoke<unknown>("inspect_phase3_preview_upgrade"),
        );
        if (this.shuttingDown) return false;
        this.upgradeInspection = inspection.available ? inspection : null;
        if (this.upgradeInspection) {
          this.renderUpgradeInspection();
          this.renderAndActivate();
          this.runtime.setFooterStatus(
            "이전 Rust Preview 작업이 있습니다. 먼저 안전한 복사를 확인하세요.",
            "error",
          );
          this.openUpgradeDialog();
          return true;
        }
      }

      this.upgradeInspection = null;
      this.elements.upgradeButton.hidden = true;
      this.renderAndActivate();
      this.runtime.setFooterStatus(
        status.revision === null
          ? "Rust 작업 공간을 준비했습니다."
          : `Rust 작업 공간 r${status.revision}을 불러왔습니다.`,
      );
      return true;
    } catch (error) {
      if (this.shuttingDown) return false;
      this.initialized = true;
      this.storageWritable = false;
      this.storageFaulted = true;
      this.session = null;
      this.renderAndActivate();
      this.runtime.setFooterStatus(
        `Rust 작업 공간을 불러오지 못해 실행과 변경을 막았습니다: ${errorMessage(error)}`,
        "error",
      );
      return false;
    } finally {
      this.refreshControls();
    }
  }

  private renderAndActivate(): void {
    this.renderTabs();
    this.renderSidebar();
    const state = this.currentState();
    if (!state) {
      this.elements.currentProject.textContent = "프로젝트 없음";
      this.runtime.showEmptyView();
      return;
    }
    this.runtime.setResumePlans(deriveSafeResumePlans(state));
    const tab = state.tabs.find((item) => item.id === state.activeTabId) ?? null;
    if (tab?.kind === "project" && tab.projectId) {
      const project = state.projects.find((item) => item.id === tab.projectId);
      if (project && this.canStartRuntime()) {
        this.runtime.syncProject(project);
        if (this.runtime.showProject(project)) {
          this.elements.currentProject.textContent = project.name;
          return;
        }
      }
    }
    this.elements.currentProject.textContent = "프로젝트 없음";
    this.runtime.showEmptyView();
    if (tab && tab.kind !== "empty" && tab.kind !== "project") {
      this.runtime.setFooterStatus(
        `${tab.title} 탭은 저장만 복원했습니다. 실제 실행은 후속 단계에서 연결합니다.`,
      );
    }
  }

  private renderTabs(): void {
    const state = this.currentState();
    this.elements.tabList.replaceChildren();
    if (!state) return;
    const enabled = this.mutationsEnabled();
    for (const tab of state.tabs) {
      const element = document.createElement("div");
      element.className = "workspace-tab";
      element.dataset.active = String(tab.id === state.activeTabId);
      element.dataset.tabId = tab.id;
      element.setAttribute("role", "tab");
      element.setAttribute("aria-selected", String(tab.id === state.activeTabId));
      element.setAttribute("aria-disabled", String(!enabled));
      element.tabIndex = tab.id === state.activeTabId ? 0 : -1;

      const kind = document.createElement("span");
      kind.className = "workspace-tab-kind";
      kind.textContent = tab.kind === "project" ? ">_" : tab.kind === "empty" ? "○" : "□";
      const title = document.createElement("span");
      title.className = "workspace-tab-title";
      title.textContent = tab.title;
      let unreadBadge: HTMLSpanElement | null = null;
      if (tab.projectId) {
        const unread = projectUnreadCount(state, tab.projectId);
        if (unread > 0) {
          const badge = document.createElement("span");
          badge.className = "completion-badge";
          badge.textContent = String(unread);
          badge.title = `확인하지 않은 완료 알림 ${unread}개`;
          badge.setAttribute("aria-label", `확인하지 않은 완료 알림 ${unread}개`);
          unreadBadge = badge;
        }
      }
      const close = document.createElement("button");
      close.className = "workspace-tab-close";
      close.type = "button";
      close.textContent = "×";
      close.title = `${tab.title} 탭 닫기`;
      close.setAttribute("aria-label", `${tab.title} 탭 닫기`);
      close.disabled = !enabled;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.closeTab(tab.id, tab.projectId);
      });
      const activate = () => void this.activateTab(tab.id);
      element.addEventListener("click", activate);
      element.addEventListener("keydown", (event) => this.onTabKeyDown(event, tab.id));
      element.append(kind, title);
      if (unreadBadge) element.append(unreadBadge);
      element.append(close);
      this.elements.tabList.append(element);
    }
  }

  private renderSidebar(): void {
    const state = this.currentState();
    this.elements.projectList.replaceChildren();
    this.elements.projectCount.textContent = String(state?.projects.length ?? 0);
    if (!state) return;
    const enabled = this.mutationsEnabled();
    for (const project of state.projects) {
      const button = document.createElement("button");
      button.className = "project-item";
      button.type = "button";
      button.disabled = !enabled;
      button.dataset.active = String(project.id === state.selectedProjectId);
      button.title = project.folderPath;
      const name = document.createElement("strong");
      name.textContent = project.name;
      const folder = document.createElement("small");
      folder.textContent = project.folderPath;
      const unread = projectUnreadCount(state, project.id);
      button.dataset.hasCompletion = String(unread > 0);
      button.append(name, folder);
      if (unread > 0) {
        const badge = document.createElement("span");
        badge.className = "completion-badge project-completion-badge";
        badge.textContent = String(unread);
        badge.title = `확인하지 않은 완료 알림 ${unread}개`;
        badge.setAttribute("aria-label", `확인하지 않은 완료 알림 ${unread}개`);
        button.append(badge);
      }
      button.addEventListener("click", () => void this.openProject(project.id));
      this.elements.projectList.append(button);
    }
  }

  private onTabKeyDown(event: KeyboardEvent, tabId: string): void {
    if (!this.canMutate(false)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void this.activateTab(tabId);
      return;
    }
    const command =
      event.key === "ArrowLeft"
        ? "previous"
        : event.key === "ArrowRight"
          ? "next"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    if (command === null) return;
    event.preventDefault();
    const state = this.currentState();
    if (!state) return;
    const next = event.ctrlKey && event.shiftKey
      ? moveWorkspaceTabByKeyboard(state, tabId, command)
      : activateRelativeWorkspaceTab(state, tabId, command);
    if (!this.canActivateWorkspaceState(next)) return;
    void this.persist(next, "탭 순서를 저장하지 못했습니다").then((saved) => {
      if (saved) this.renderAndActivate();
    });
  }

  private async addBlankTab(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const next = addBlankWorkspaceTab(state, this.idFactory());
    if (await this.persist(next, "빈 탭을 저장하지 못했습니다")) this.renderAndActivate();
  }

  private async activateTab(tabId: string): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const next = activateWorkspaceTab(state, tabId);
    if (!this.canActivateWorkspaceState(next)) return;
    if (await this.persist(next, "선택한 탭을 저장하지 못했습니다")) {
      this.renderAndActivate();
    }
  }

  private async closeTab(tabId: string, projectId: string | null): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const next = closeWorkspaceTab(state, tabId, this.idFactory());
    const shouldUnload =
      projectId !== null &&
      !next.tabs.some((tab) => tab.kind === "project" && tab.projectId === projectId);
    if (!this.canActivateWorkspaceState(next, shouldUnload ? projectId : null)) return;
    if (!(await this.persist(next, "닫은 탭 상태를 저장하지 못했습니다"))) return;
    if (projectId && shouldUnload) {
      try {
        await this.trackRuntimeTransition(() => this.runtime.unloadProject(projectId));
      } catch (error) {
        this.runtime.setFooterStatus(
          `닫은 프로젝트의 PowerShell을 정리하지 못했습니다: ${errorMessage(error)}`,
          "error",
        );
      }
    }
    this.renderAndActivate();
  }

  private async openProject(projectId: string): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    const next = openProjectWorkspaceTab(state, project.id, this.idFactory());
    if (!this.canActivateWorkspaceState(next)) return;
    if (await this.persist(next, "프로젝트 탭을 저장하지 못했습니다")) {
      this.renderAndActivate();
    }
  }

  private openProjectDialog(): void {
    this.elements.projectForm.reset();
    this.elements.projectFormError.textContent = "";
    this.elements.projectDialog.showModal();
    requestAnimationFrame(() => this.elements.projectName.focus());
  }

  private async createProject(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    this.elements.projectFormError.textContent = "";
    let draft;
    try {
      draft = validateWorkspaceProjectDraft(
        this.elements.projectName.value,
        this.elements.projectPath.value,
      );
    } catch (error) {
      this.elements.projectFormError.textContent = errorMessage(error);
      return;
    }
    const existing = findWorkspaceProjectByFolder(state.projects, draft.folderPath);
    if (existing) {
      this.elements.projectDialog.close();
      await this.openProject(existing.id);
      return;
    }
    const project = createWorkspaceProject(
      this.idFactory(),
      uniqueWorkspaceProjectName(state.projects, draft.name),
      draft.folderPath,
    );
    const withProject = appendWorkspaceProject(state, project);
    const next = openProjectWorkspaceTab(withProject, project.id, this.idFactory());
    if (await this.persist(next, "프로젝트를 저장하지 못했습니다")) {
      this.elements.projectDialog.close();
      this.renderAndActivate();
    }
  }

  private async addTerminal(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== "project" || !tab.projectId) return;
    const project = state.projects.find((item) => item.id === tab.projectId);
    if (!project) return;
    const globalRunning = this.runtime.restoreCapacity({ ...project, terminals: [] }).current;
    const capacity = evaluateWorkspaceRestoreCapacity(globalRunning, 1);
    if (!capacity.allowed || project.terminals.length >= 20) {
      this.runtime.setFooterStatus("PowerShell은 동시에 최대 20개까지 실행할 수 있습니다.", "error");
      return;
    }
    const terminal = createWorkspaceTerminal(
      this.idFactory(),
      nextWorkspacePaneName(project),
      project.folderPath,
      new Date().toISOString(),
    );
    const next = appendProjectPane(state, project.id, terminal);
    if (!(await this.persist(next, "PowerShell 상태를 저장하지 못했습니다"))) return;
    if (!this.runtime.addPane(project.id, terminal, true)) {
      this.runtime.setFooterStatus(
        "PowerShell 상태는 저장했지만 실행 슬롯을 확보하지 못했습니다.",
        "error",
      );
    }
    this.renderSidebar();
  }

  private async persist(next: WorkspaceState, context: string): Promise<boolean> {
    if (!this.canMutate()) return false;
    return this.enqueueOperation(() => this.persistNow(next, context));
  }

  private async trackRuntimeTransition(operation: () => Promise<void>): Promise<void> {
    await this.enqueueOperation(operation);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperationCount += 1;
    this.mutationPending = true;
    this.refreshControls();

    const result = this.operationTail.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationTail = settled;
    this.activeOperation = settled;
    return result.finally(() => {
      this.pendingOperationCount = Math.max(0, this.pendingOperationCount - 1);
      this.mutationPending = this.pendingOperationCount > 0;
      if (!this.mutationPending && this.activeOperation === settled) {
        this.activeOperation = Promise.resolve();
      }
      this.refreshControls();
    });
  }

  private persistRuntimeCompletion(
    projectId: string,
    terminalId: string,
    completionPending: boolean,
    playSound: boolean,
  ): Promise<boolean> {
    if (
      !this.initialized ||
      !this.storageWritable ||
      this.session?.access !== "ready" ||
      this.shuttingDown ||
      this.externalReplacementPending ||
      this.storageFaulted ||
      this.upgradeInspection !== null
    ) {
      return Promise.resolve(false);
    }

    return this.enqueueOperation(async () => {
      const state = this.currentState();
      const terminal = state?.projects
        .find((project) => project.id === projectId)
        ?.terminals.find((item) => item.id === terminalId);
      if (!state || !terminal) return false;
      if (terminal.completionPending === completionPending) {
        this.runtime.setTerminalCompletionPending(
          projectId,
          terminalId,
          completionPending,
          false,
        );
        this.renderTabs();
        this.renderSidebar();
        return true;
      }

      const next = setTerminalCompletionPending(
        state,
        projectId,
        terminalId,
        completionPending,
      );
      const saved = await this.persistNow(
        next,
        completionPending
          ? "완료 알림을 저장하지 못했습니다"
          : "완료 알림 확인 상태를 저장하지 못했습니다",
      );
      if (!saved) return false;
      this.runtime.setTerminalCompletionPending(
        projectId,
        terminalId,
        completionPending,
        completionPending && playSound,
      );
      this.renderTabs();
      this.renderSidebar();
      return true;
    });
  }

  private async persistNow(next: WorkspaceState, context: string): Promise<boolean> {
    const current = this.session;
    if (!current) return false;
    try {
      this.session = replaceWorkspaceDraft(current, next);
      if (!this.session.dirty) return true;
      const save = beginWorkspaceSave(this.session);
      this.session = save.session;
      const response = await invoke<unknown>("save_workspace_state", {
        expectedRevision: save.request.expectedRevision,
        state: save.request.state,
      });
      this.session = applyWorkspaceSaveSuccess(this.session, response);
      this.storageFaulted = false;
      return true;
    } catch (error) {
      // The UI is allowed to mutate only after durable canonical commit. Keep
      // the last clean session on every failure so optimistic layout/title/tab
      // changes can be rolled back without diverging from disk.
      this.session = current;
      this.storageFaulted = true;
      this.runtime.setFooterStatus(`${context}: ${errorMessage(error)}`, "error");
      return false;
    }
  }

  private canActivateWorkspaceState(
    state: WorkspaceState,
    unloadingProjectId: string | null = null,
  ): boolean {
    const tab = state.tabs.find((item) => item.id === state.activeTabId) ?? null;
    if (tab?.kind !== "project" || tab.projectId === null) return true;
    const project = state.projects.find((item) => item.id === tab.projectId);
    if (!project) return true;
    const capacity = this.runtime.restoreCapacity(project, unloadingProjectId);
    if (capacity.allowed) return true;
    this.runtime.setFooterStatus(
      `${project.name}을 열려면 PowerShell ${capacity.incoming}개 슬롯이 필요하지만 ` +
        `${capacity.available}개만 남았습니다.`,
      "error",
    );
    return false;
  }

  private currentState(): WorkspaceState | null {
    return this.session?.draft ?? this.session?.snapshot?.state ?? null;
  }

  private mutationsEnabled(): boolean {
    return (
      this.initialized &&
      this.storageWritable &&
      this.session?.access === "ready" &&
      this.session.phase === "idle" &&
      !this.session.dirty &&
      !this.shuttingDown &&
      !this.mutationPending &&
      !this.externalReplacementPending &&
      !this.storageFaulted &&
      this.upgradeInspection === null
    );
  }

  private canMutate(report = true): boolean {
    const enabled = this.mutationsEnabled();
    if (!enabled && report) {
      this.runtime.setFooterStatus(
        this.upgradeInspection
          ? "이전 Rust Preview 상태의 안전한 복사를 먼저 확인하세요."
          : "Rust 작업 공간이 변경 가능한 상태가 아닙니다.",
        "error",
      );
    }
    return enabled;
  }

  private canStartRuntime(): boolean {
    return (
      this.initialized &&
      this.session?.access === "ready" &&
      !this.storageFaulted &&
      this.upgradeInspection === null
    );
  }

  private refreshControls(): void {
    const enabled = this.mutationsEnabled();
    this.elements.addTabButton.disabled = !enabled;
    this.elements.createProjectButton.disabled = !enabled;
    this.runtime.setCatalogWritable(enabled);
    this.elements.commitUpgradeButton.disabled =
      this.mutationPending ||
      this.externalReplacementPending ||
      this.upgradeInspection?.sourceSha256 == null;
    this.elements.closeUpgradeButton.disabled =
      this.mutationPending || this.externalReplacementPending;
    this.renderTabs();
    this.renderSidebar();
  }

  private renderUpgradeInspection(): void {
    const inspection = this.upgradeInspection;
    this.elements.upgradeButton.hidden = inspection === null;
    if (!inspection) return;
    this.elements.upgradeProjectCount.textContent = String(inspection.projectCount);
    this.elements.upgradeTerminalCount.textContent = String(inspection.terminalCount);
    this.elements.upgradeSourceSha.textContent = inspection.sourceSha256 ?? "-";
    this.elements.upgradeError.textContent = "";
  }

  private openUpgradeDialog(): void {
    if (!this.upgradeInspection || this.elements.upgradeDialog.open) return;
    this.renderUpgradeInspection();
    this.elements.upgradeDialog.showModal();
    this.elements.commitUpgradeButton.focus();
  }

  private async commitPhase3PreviewUpgrade(): Promise<void> {
    const inspection = this.upgradeInspection;
    if (!inspection?.sourceSha256 || this.mutationPending) return;
    this.elements.upgradeError.textContent = "";
    let prepared = false;
    let committed = false;
    try {
      await this.prepareForExternalReplacement(true);
      prepared = true;
    } catch (error) {
      this.elements.upgradeError.textContent = errorMessage(error);
      return;
    }
    if (this.shuttingDown) {
      await this.finishExternalReplacement(false);
      return;
    }

    this.mutationPending = true;
    this.refreshControls();
    const operation = (async () => {
      try {
        await invoke<unknown>("commit_phase3_preview_upgrade", {
          sourceSha256: inspection.sourceSha256,
        });
        committed = true;
        this.upgradeInspection = null;
        this.elements.upgradeButton.hidden = true;
        await this.finishExternalReplacement(true);
        prepared = false;
        if (!this.shuttingDown) {
          if (this.elements.upgradeDialog.open) this.elements.upgradeDialog.close();
          this.runtime.setFooterStatus(
            "이전 Rust Preview 작업을 canonical 저장소로 안전하게 복사했습니다.",
          );
        }
      } catch (error) {
        if (prepared && !committed) {
          try {
            await this.finishExternalReplacement(false);
            prepared = false;
          } catch (restoreError) {
            this.elements.upgradeError.textContent =
              `${errorMessage(error)} · 기존 상태 복원 실패: ${errorMessage(restoreError)}`;
            return;
          }
        }
        this.elements.upgradeError.textContent = errorMessage(error);
      }
    })();
    this.activeOperation = operation;
    try {
      await operation;
    } finally {
      if (this.activeOperation === operation) this.activeOperation = Promise.resolve();
      this.mutationPending = false;
      this.refreshControls();
    }
  }
}

export function createPhase4WorkspaceController(
  runtime: Phase4RuntimePort,
  elements: Phase4ControllerElements,
): Phase4WorkspaceController {
  return new Phase4WorkspaceController(runtime, elements);
}

function normalizeStorageStatus(value: unknown): StorageStatus {
  const record = requireRecord(value, "storage status");
  return {
    writable: record.writable === true,
    revision: safeIntegerOrNull(record.revision),
  };
}

function normalizePhase3PreviewInspection(value: unknown): Phase3PreviewInspection {
  const record = requireRecord(value, "Phase 3 preview upgrade inspection");
  const available = record.available === true;
  const projectCount = requireCount(record.projectCount, "project count");
  const terminalCount = requireCount(record.terminalCount, "terminal count");
  const sourceSha256 =
    record.sourceSha256 === null || record.sourceSha256 === undefined
      ? null
      : requireString(record.sourceSha256, "source SHA-256");
  if (sourceSha256 !== null && !/^[0-9a-f]{64}$/i.test(sourceSha256)) {
    throw new Error("Phase 3 preview SHA-256 is invalid.");
  }
  if (available !== (sourceSha256 !== null)) {
    throw new Error("Phase 3 preview availability is inconsistent.");
  }
  return { available, projectCount, terminalCount, sourceSha256 };
}

function storageAccessMessage(session: WorkspaceSession): string {
  switch (session.access) {
    case "readOnly":
      return "다른 앱 창이 canonical 저장소를 사용 중이어서 읽기 전용입니다.";
    case "recoveryRequired":
    case "recoveryPreview":
      return "canonical 저장소 복구가 필요합니다.";
    case "unsupportedVersion":
      return "더 새로운 canonical 저장소라 읽기 전용입니다.";
    default:
      return "canonical 저장소를 실행 가능한 상태로 불러오지 못했습니다.";
  }
}

function createOpaqueId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireCount(value: unknown, label: string): number {
  const count = safeIntegerOrNull(value);
  if (count === null) throw new Error(`${label} is invalid.`);
  return count;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is invalid.`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value)) {
    if (typeof value.message === "string") return value.message;
    if ("error" in value) return errorMessage(value.error);
  }
  return String(value);
}
