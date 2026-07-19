import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
  appendProjectBrowserPane,
  appendProjectPane,
  appendWorkspaceProject,
  applyProjectPaneInsertion,
  blockWorkspaceProviderResumeForAccountSwitch,
  closeWorkspaceTab,
  createWorkspaceBrowserPane,
  createWorkspaceProject,
  createWorkspaceTerminal,
  findWorkspaceProjectByFolder,
  moveWorkspaceTabByKeyboard,
  migrateLegacyAutomaticProjectTabsToManual,
  nextWorkspacePaneName,
  openProjectWorkspaceTab,
  removeProjectBrowserPane,
  removeProjectPane,
  renameProjectBrowserPane,
  renameProjectPane,
  setProjectBrowserPaneUrl,
  setTerminalAgentConversation,
  sortWorkspaceProjectsByRecentModification,
  suggestWorkspaceProjectName,
  terminalAgentBindingChanged,
  uniqueWorkspaceProjectName,
  validateWorkspaceProjectDraft,
  type PaneInsertionTarget,
  type RestoreCapacityDecision,
  type WorkspaceBrowserPane,
  type WorkspaceAgentProvider,
} from "./phase4-core";
import {
  ProjectActivityTracker,
  deriveSafeResumePlans,
  type SafeResumePlan,
} from "./phase5-core";
import { localizeBackendMessage, tr } from "./i18n";

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
  canAddPane(projectId: string): boolean;
  unloadProject(projectId: string): Promise<void>;
  unloadAllProjects(): Promise<void>;
  addPane(projectId: string, terminal: WorkspaceTerminal, focus?: boolean): unknown;
  addBrowserPane(
    projectId: string,
    browser: WorkspaceBrowserPane,
    focus?: boolean,
  ): unknown;
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
  setModalOverlayOpen(reason: string, open: boolean): void;
};

export type Phase4ControllerElements = {
  projectList: HTMLElement;
  tabList: HTMLElement;
  addTerminalButton: HTMLButtonElement;
  addTabButton: HTMLButtonElement;
  createProjectButton: HTMLButtonElement;
  projectDialog: HTMLDialogElement;
  projectForm: HTMLFormElement;
  projectName: HTMLInputElement;
  projectPath: HTMLInputElement;
  selectProjectFolderButton: HTMLButtonElement;
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
  private projectFolderPickerPending = false;
  private projectFolderDefaultPath: string | null = null;
  private providerAccountRestartRollback: WorkspaceState | null = null;
  private readonly projectActivity = new ProjectActivityTracker();
  private readonly listeners = new AbortController();
  private readonly projectListToggle: HTMLButtonElement | null;

  constructor(
    private readonly runtime: Phase4RuntimePort,
    private readonly elements: Phase4ControllerElements,
    private readonly idFactory: () => string = createOpaqueId,
  ) {
    const signal = this.listeners.signal;
    this.projectListToggle = elements.projectList.parentElement?.querySelector<HTMLButtonElement>(
      "#toggle-project-list",
    ) ?? null;
    this.projectListToggle?.addEventListener(
      "click",
      () => {
        const expanded = this.projectListToggle?.getAttribute("aria-expanded") === "true";
        this.setProjectListExpanded(!expanded);
      },
      { signal },
    );
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
    elements.selectProjectFolderButton.addEventListener(
      "click",
      () => void this.selectProjectFolder(),
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
    elements.projectDialog.addEventListener(
      "close",
      () => this.runtime.setModalOverlayOpen("project", false),
      { signal },
    );
    elements.upgradeDialog.addEventListener(
      "close",
      () => this.runtime.setModalOverlayOpen("upgrade", false),
      { signal },
    );
    elements.commitUpgradeButton.addEventListener(
      "click",
      () => void this.commitPhase3PreviewUpgrade(),
      { signal },
    );
    this.setProjectListExpanded(true);
    this.refreshControls();
  }

  private setProjectListExpanded(expanded: boolean): void {
    this.elements.projectList.hidden = !expanded;
    if (!this.projectListToggle) return;
    this.projectListToggle.setAttribute("aria-expanded", String(expanded));
    const label = expanded
      ? tr("Collapse project list", "프로젝트 목록 접기")
      : tr("Expand project list", "프로젝트 목록 펼치기");
    this.projectListToggle.setAttribute("aria-label", label);
    this.projectListToggle.title = label;
  }

  async initialize(): Promise<void> {
    await this.reloadFromCanonicalStore(true);
  }

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.refreshControls();
    this.runtime.setFooterStatus(
      tr("Saving the Rust workspace before closing…", "Rust 작업 공간을 저장한 뒤 종료하는 중…"),
    );
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
          tr(
            "There are unsaved Rust workspace changes.",
            "저장되지 않은 Rust 작업 공간 변경이 남아 있습니다.",
          ),
      );
    }
  }

  async assertProviderAccountRestartReady(): Promise<void> {
    if (!this.canMutate()) {
      throw new Error(
        tr("Account switching cannot start in the current state.", "계정 전환을 시작할 수 있는 상태가 아닙니다."),
      );
    }
    await this.flushSaves();
    if (!this.canMutate()) {
      throw new Error(
        tr("Account switching cannot start in the current state.", "계정 전환을 시작할 수 있는 상태가 아닙니다."),
      );
    }
  }

  async prepareProviderAccountRestart(provider: WorkspaceAgentProvider): Promise<void> {
    if (!this.canMutate()) {
      throw new Error(
        tr("Account switching cannot be saved in the current state.", "계정 전환을 저장할 수 있는 상태가 아닙니다."),
      );
    }
    await this.enqueueOperation(async () => {
      const state = this.currentState();
      if (!state) {
        throw new Error(tr("Could not load the workspace state.", "작업 공간 상태를 불러오지 못했습니다."));
      }
      const next = blockWorkspaceProviderResumeForAccountSwitch(state, provider);
      const saved = await this.persistNow(
        next,
        tr("Could not save the account-switch state", "계정 전환 상태를 저장하지 못했습니다"),
      );
      if (!saved) {
        throw new Error(
          tr("Could not save the account-switch state.", "계정 전환 상태를 저장하지 못했습니다."),
        );
      }
      this.providerAccountRestartRollback = structuredClone(state);
    });
    await this.flushSaves();
  }

  async rollbackProviderAccountRestart(): Promise<void> {
    const previous = this.providerAccountRestartRollback;
    if (!previous) return;
    await this.enqueueOperation(async () => {
      const saved = await this.persistNow(
        previous,
        tr(
          "Could not restore the account-switch restart state",
          "계정 전환 재시작 상태를 복구하지 못했습니다",
        ),
      );
      if (!saved) {
        throw new Error(
          tr(
            "Could not restore the account-switch restart state.",
            "계정 전환 재시작 상태를 복구하지 못했습니다.",
          ),
        );
      }
      this.providerAccountRestartRollback = null;
    });
    await this.flushSaves();
  }

  dispose(): void {
    this.projectActivity.clear();
    if (this.elements.projectDialog.open) this.elements.projectDialog.close();
    if (this.elements.upgradeDialog.open) this.elements.upgradeDialog.close();
    this.runtime.setModalOverlayOpen("project", false);
    this.runtime.setModalOverlayOpen("upgrade", false);
    this.listeners.abort();
  }

  async prepareForExternalReplacement(allowPreviewUpgrade = false): Promise<void> {
    if (this.externalReplacementPending) {
      throw new Error(
        tr("Another storage replacement is already in progress.", "다른 저장소 교체 작업이 이미 진행 중입니다."),
      );
    }
    if (this.upgradeInspection !== null && !allowPreviewUpgrade) {
      throw new Error(
        tr(
          "Complete the safe copy of the previous Rust Preview state first.",
          "이전 Rust Preview 상태의 안전한 복사를 먼저 완료하세요.",
        ),
      );
    }
    await this.flushSaves();
    if (this.shuttingDown) {
      throw new Error(tr("Storage cannot be replaced while closing.", "종료 중에는 저장소를 교체할 수 없습니다."));
    }
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
        throw new Error(
          tr("Storage replacement was canceled because shutdown started.", "종료가 시작되어 저장소 교체를 취소했습니다."),
        );
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
              ? tr(
                  "Storage replacement completed, but the new canonical state could not be reloaded.",
                  "저장소 교체는 완료됐지만 새 canonical 상태를 다시 불러오지 못했습니다.",
                )
              : tr(
                  "The previous canonical state could not be restored after canceling storage replacement.",
                  "저장소 교체를 취소한 뒤 기존 canonical 상태를 복원하지 못했습니다.",
                ),
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
      return await this.persist(
        next,
        tr("Could not save the PowerShell removal", "PowerShell 삭제 상태를 저장하지 못했습니다"),
      );
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
      return false;
    }
  }

  async onBrowserPaneClosed(projectId: string, paneId: string): Promise<boolean> {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return false;
    try {
      const next = removeProjectBrowserPane(state, projectId, paneId);
      return await this.persist(
        next,
        tr("Could not save the web pane removal", "웹 패널 삭제 상태를 저장하지 못했습니다"),
      );
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

  /** Durably associate a provider conversation before it can be resumed later. */
  async onAgentConversationDiscovered(
    projectId: string,
    terminalId: string,
    provider: WorkspaceAgentProvider,
    conversationId: string,
  ): Promise<boolean> {
    if (!this.canPersistRuntimeMutation()) return false;

    return this.enqueueOperation(async () => {
      const state = this.currentState();
      const terminal = state?.projects
        .find((project) => project.id === projectId)
        ?.terminals.find((item) => item.id === terminalId);
      if (!state || !terminal) return false;

      try {
        const next = setTerminalAgentConversation(
          state,
          projectId,
          terminalId,
          provider,
          conversationId,
        );
        const nextTerminal = next.projects
          .find((project) => project.id === projectId)
          ?.terminals.find((item) => item.id === terminalId);
        const bindingChanged =
          nextTerminal !== undefined && terminalAgentBindingChanged(terminal, nextTerminal);
        if (bindingChanged) {
          const saved = await this.persistNow(
            next,
            tr(
              "Could not save the agent conversation link",
              "에이전트 대화 연결을 저장하지 못했습니다",
            ),
          );
          if (!saved) return false;
        }

        const committed = this.currentState();
        if (!committed) return false;
        this.runtime.setResumePlans(deriveSafeResumePlans(committed));
        const committedProject = committed.projects.find((item) => item.id === projectId);
        if (committedProject) this.runtime.syncProject(committedProject);
        return true;
      } catch (error) {
        this.runtime.setFooterStatus(
          tr(
            `Could not link the agent conversation: ${errorMessage(error)}`,
            `에이전트 대화를 연결하지 못했습니다: ${errorMessage(error)}`,
          ),
          "error",
        );
        return false;
      }
    });
  }

  setTerminalAgentWorking(projectId: string, terminalId: string, working: boolean): void {
    this.projectActivity.setTerminalWorking(projectId, terminalId, working);
    this.refreshProjectActivity(projectId);
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
      return await this.persist(
        next,
        tr("Could not save the PowerShell name", "PowerShell 이름을 저장하지 못했습니다"),
      );
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
      return false;
    }
  }

  async onBrowserPaneRenamed(
    projectId: string,
    paneId: string,
    title: string,
  ): Promise<boolean> {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return false;
    try {
      const next = renameProjectBrowserPane(state, projectId, paneId, title);
      return await this.persist(
        next,
        tr("Could not save the web pane name", "웹 패널 이름을 저장하지 못했습니다"),
      );
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
      return false;
    }
  }

  async onBrowserPaneUrlChanged(
    projectId: string,
    paneId: string,
    url: string,
  ): Promise<boolean> {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return false;
    try {
      const next = setProjectBrowserPaneUrl(state, projectId, paneId, url);
      return await this.persist(
        next,
        tr("Could not save the web pane address", "웹 패널 주소를 저장하지 못했습니다"),
      );
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
      void this.persist(
        next,
        tr("Could not save the PowerShell layout", "PowerShell 배치를 저장하지 못했습니다"),
      ).then((saved) => {
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
      void this.persist(
        next,
        tr("Could not save the PowerShell widths", "PowerShell 너비를 저장하지 못했습니다"),
      ).then((saved) => {
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
            tr(
              "A previous Rust Preview workspace was found. Review the safe copy first.",
              "이전 Rust Preview 작업이 있습니다. 먼저 안전한 복사를 확인하세요.",
            ),
            "error",
          );
          this.openUpgradeDialog();
          return true;
        }
      }

      this.upgradeInspection = null;
      this.elements.upgradeButton.hidden = true;
      const current = this.currentState();
      if (
        this.session.access === "ready" &&
        current &&
        current.legacyExtensions.manualProjectTabsV1 !== true
      ) {
        const migrated = migrateLegacyAutomaticProjectTabsToManual(current);
        if (
          !(await this.persistNow(
            migrated,
            tr(
              "Could not save the manual project-tab migration",
              "수동 프로젝트 탭 전환을 저장하지 못했습니다",
            ),
          ))
        ) {
          this.renderAndActivate();
          return false;
        }
      }
      this.renderAndActivate();
      return true;
    } catch (error) {
      if (this.shuttingDown) return false;
      this.initialized = true;
      this.storageWritable = false;
      this.storageFaulted = true;
      this.session = null;
      this.renderAndActivate();
      this.runtime.setFooterStatus(
        tr(
          `The Rust workspace could not be loaded, so running and editing are disabled: ${errorMessage(error)}`,
          `Rust 작업 공간을 불러오지 못해 실행과 변경을 막았습니다: ${errorMessage(error)}`,
        ),
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
          return;
        }
      }
    }
    this.runtime.showEmptyView();
    if (tab && tab.kind !== "empty" && tab.kind !== "project") {
      const localizedTitle = localizeBuiltInTabTitle(tab.title);
      this.runtime.setFooterStatus(
        tr(
          `Only the saved state of the ${localizedTitle} tab was restored. Runtime support will be connected in a later step.`,
          `${localizedTitle} 탭은 저장만 복원했습니다. 실제 실행은 후속 단계에서 연결합니다.`,
        ),
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
      if (tab.projectId) element.dataset.projectId = tab.projectId;
      element.setAttribute("role", "tab");
      element.setAttribute("aria-selected", String(tab.id === state.activeTabId));
      element.setAttribute("aria-disabled", String(!enabled));
      element.tabIndex = tab.id === state.activeTabId ? 0 : -1;

      const working = Boolean(
        tab.kind === "project" &&
        tab.projectId &&
        this.projectActivity.isProjectWorking(tab.projectId),
      );
      element.dataset.working = String(working);
      element.setAttribute("aria-busy", String(working));

      const kind = document.createElement("span");
      kind.className = "workspace-tab-kind";
      kind.textContent = tab.kind === "project" ? ">_" : tab.kind === "empty" ? "○" : "□";
      const title = document.createElement("span");
      title.className = "workspace-tab-title";
      const localizedTitle = localizeBuiltInTabTitle(tab.title);
      title.textContent = localizedTitle;
      const status = document.createElement("span");
      status.className = "workspace-tab-status";
      let activity: HTMLSpanElement | null = null;
      if (tab.kind === "project" && tab.projectId) {
        activity = document.createElement("span");
        activity.className = "workspace-tab-activity";
        activity.hidden = !working;
        activity.title = tr("Working", "작업 중");
        activity.setAttribute("aria-hidden", "true");
        status.append(activity);
      }
      let unreadBadge: HTMLSpanElement | null = null;
      if (tab.projectId) {
        const unread = projectUnreadCount(state, tab.projectId);
        if (unread > 0) {
          const badge = document.createElement("span");
          badge.className = "completion-badge";
          badge.textContent = String(unread);
          const unreadLabel = tr(
            `${unread} unread completion notification${unread === 1 ? "" : "s"}`,
            `확인하지 않은 완료 알림 ${unread}개`,
          );
          badge.title = unreadLabel;
          badge.setAttribute("aria-label", unreadLabel);
          unreadBadge = badge;
        }
      }
      if (unreadBadge) status.append(unreadBadge);
      status.hidden = !working && unreadBadge === null;
      const close = document.createElement("button");
      close.className = "workspace-tab-close";
      close.type = "button";
      close.textContent = "×";
      const closeLabel = isBuiltInTabTitle(tab.title)
        ? tr("Close New tab", "새 탭 닫기")
        : tr(`Close ${tab.title} tab`, `${tab.title} 탭 닫기`);
      close.title = closeLabel;
      close.setAttribute("aria-label", closeLabel);
      close.disabled = !enabled;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.closeTab(tab.id, tab.projectId);
      });
      const activate = () => void this.activateTab(tab.id);
      element.addEventListener("click", activate);
      element.addEventListener("keydown", (event) => this.onTabKeyDown(event, tab.id));
      element.append(kind, title, status, close);
      this.elements.tabList.append(element);
    }
  }

  private refreshProjectActivity(projectId: string): void {
    const working = this.projectActivity.isProjectWorking(projectId);
    for (const tab of this.elements.tabList.querySelectorAll<HTMLElement>(".workspace-tab")) {
      if (tab.dataset.projectId !== projectId) continue;
      tab.dataset.working = String(working);
      tab.setAttribute("aria-busy", String(working));
      const activity = tab.querySelector<HTMLElement>(".workspace-tab-activity");
      if (activity) activity.hidden = !working;
      const status = tab.querySelector<HTMLElement>(".workspace-tab-status");
      if (status) {
        status.hidden = !working && status.querySelector(".completion-badge") === null;
      }
    }
  }

  private renderSidebar(): void {
    const state = this.currentState();
    this.elements.projectList.replaceChildren();
    if (!state) return;
    const enabled = this.mutationsEnabled();
    for (const project of sortWorkspaceProjectsByRecentModification(state.projects)) {
      const button = document.createElement("button");
      button.className = "project-item";
      button.type = "button";
      button.disabled = !enabled;
      button.dataset.active = String(project.id === state.selectedProjectId);
      const name = document.createElement("strong");
      name.textContent = project.name;
      const unread = projectUnreadCount(state, project.id);
      button.dataset.hasCompletion = String(unread > 0);
      button.append(name);
      if (unread > 0) {
        const badge = document.createElement("span");
        badge.className = "completion-badge project-completion-badge";
        badge.textContent = String(unread);
        const unreadLabel = tr(
          `${unread} unread completion notification${unread === 1 ? "" : "s"}`,
          `확인하지 않은 완료 알림 ${unread}개`,
        );
        badge.title = unreadLabel;
        badge.setAttribute("aria-label", unreadLabel);
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
    void this.persist(
      next,
      tr("Could not save the tab order", "탭 순서를 저장하지 못했습니다"),
    ).then((saved) => {
      if (saved) this.renderAndActivate();
    });
  }

  private async addBlankTab(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const next = addBlankWorkspaceTab(state, this.idFactory());
    if (
      await this.persist(next, tr("Could not save the blank tab", "빈 탭을 저장하지 못했습니다"))
    ) {
      this.renderAndActivate();
    }
  }

  private async activateTab(tabId: string): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const next = activateWorkspaceTab(state, tabId);
    if (!this.canActivateWorkspaceState(next)) return;
    if (
      await this.persist(next, tr("Could not save the selected tab", "선택한 탭을 저장하지 못했습니다"))
    ) {
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
    if (
      !(await this.persist(next, tr("Could not save the closed-tab state", "닫은 탭 상태를 저장하지 못했습니다")))
    ) {
      return;
    }
    if (projectId && shouldUnload) {
      try {
        await this.trackRuntimeTransition(() => this.runtime.unloadProject(projectId));
      } catch (error) {
        this.runtime.setFooterStatus(
          tr(
            `Could not clean up the closed project's PowerShell panes: ${errorMessage(error)}`,
            `닫은 프로젝트의 PowerShell을 정리하지 못했습니다: ${errorMessage(error)}`,
          ),
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
    if (
      await this.persist(next, tr("Could not save the project tab", "프로젝트 탭을 저장하지 못했습니다"))
    ) {
      this.renderAndActivate();
    }
  }

  private openProjectDialog(): void {
    const state = this.currentState();
    this.projectFolderDefaultPath =
      state?.projects.find((project) => project.id === state.selectedProjectId)?.folderPath ?? null;
    this.elements.projectForm.reset();
    this.elements.projectFormError.textContent = "";
    this.runtime.setModalOverlayOpen("project", true);
    try {
      this.elements.projectDialog.showModal();
    } catch (error) {
      this.runtime.setModalOverlayOpen("project", false);
      throw error;
    }
    requestAnimationFrame(() => this.elements.projectName.focus());
  }

  private async selectProjectFolder(): Promise<void> {
    if (this.projectFolderPickerPending || !this.canMutate()) return;
    this.projectFolderPickerPending = true;
    this.elements.selectProjectFolderButton.disabled = true;
    try {
      const currentPath = this.elements.projectPath.value.trim();
      const selected = await open({
        directory: true,
        multiple: false,
        title: tr("Select project folder", "프로젝트 폴더 선택"),
        defaultPath: currentPath || this.projectFolderDefaultPath || undefined,
      });
      if (typeof selected !== "string") return;
      this.elements.projectPath.value = selected;
      if (!this.elements.projectName.value.trim()) {
        this.elements.projectName.value = suggestWorkspaceProjectName(selected);
      }
      this.elements.projectFormError.textContent = "";
    } catch (error) {
      this.elements.projectFormError.textContent = tr(
        `Could not open the folder picker. ${errorMessage(error)}`,
        `폴더 선택기를 열지 못했습니다. ${errorMessage(error)}`,
      );
    } finally {
      this.projectFolderPickerPending = false;
      this.elements.selectProjectFolderButton.disabled = !this.mutationsEnabled();
    }
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
      new Date().toISOString(),
    );
    const withProject = appendWorkspaceProject(state, project);
    const next = openProjectWorkspaceTab(withProject, project.id, this.idFactory());
    if (await this.persist(next, tr("Could not save the project", "프로젝트를 저장하지 못했습니다"))) {
      this.elements.projectDialog.close();
      this.renderAndActivate();
    }
  }

  async addTerminal(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== "project" || !tab.projectId) return;
    const project = state.projects.find((item) => item.id === tab.projectId);
    if (!project) return;
    if (!this.runtime.canAddPane(project.id)) {
      this.runtime.setFooterStatus(
        tr(
          "A PowerShell pane cannot be added right now.",
          "지금은 PowerShell 화면을 추가할 수 없습니다.",
        ),
        "error",
      );
      return;
    }
    const terminal = createWorkspaceTerminal(
      this.idFactory(),
      nextWorkspacePaneName(project),
      project.folderPath,
      new Date().toISOString(),
    );
    const next = appendProjectPane(state, project.id, terminal);
    if (
      !(await this.persist(next, tr("Could not save the PowerShell state", "PowerShell 상태를 저장하지 못했습니다")))
    ) {
      return;
    }
    if (!this.runtime.addPane(project.id, terminal, true)) {
      this.runtime.setFooterStatus(
        tr(
          "The PowerShell state was saved, but no runtime slot could be reserved.",
          "PowerShell 상태는 저장했지만 실행 슬롯을 확보하지 못했습니다.",
        ),
        "error",
      );
    }
    this.renderSidebar();
  }

  async addBrowserPane(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== "project" || !tab.projectId) return;
    const project = state.projects.find((item) => item.id === tab.projectId);
    if (!project) return;
    if (!this.runtime.canAddPane(project.id)) {
      this.runtime.setFooterStatus(
        tr(
          "A web pane cannot be added right now.",
          "지금은 웹 화면을 추가할 수 없습니다.",
        ),
        "error",
      );
      return;
    }
    const browser = createWorkspaceBrowserPane(this.idFactory());
    const next = appendProjectBrowserPane(state, project.id, browser);
    if (
      !(await this.persist(next, tr("Could not save the web pane state", "웹 패널 상태를 저장하지 못했습니다")))
    ) {
      return;
    }
    if (!this.runtime.addBrowserPane(project.id, browser, true)) {
      this.runtime.setFooterStatus(
        tr(
          "The web pane state was saved, but no runtime slot could be reserved.",
          "웹 패널 상태는 저장했지만 실행 슬롯을 확보하지 못했습니다.",
        ),
        "error",
      );
    }
  }

  async addBrowserPaneFromLink(projectId: string, url: string): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const project = state.projects.find((item) => item.id === projectId);
    const activeTab = state.tabs.find((item) => item.id === state.activeTabId);
    if (!project || activeTab?.kind !== "project" || activeTab.projectId !== projectId) {
      return;
    }
    if (!this.runtime.canAddPane(project.id)) {
      this.runtime.setFooterStatus(
        tr(
          "A web pane cannot be added right now.",
          "지금은 웹 화면을 추가할 수 없습니다.",
        ),
        "error",
      );
      return;
    }

    let browser: WorkspaceBrowserPane;
    try {
      browser = createWorkspaceBrowserPane(this.idFactory(), "WEB", url);
    } catch {
      this.runtime.setFooterStatus(
        tr("The selected link cannot be opened.", "선택한 링크를 열 수 없습니다."),
        "error",
      );
      return;
    }

    const next = appendProjectBrowserPane(state, project.id, browser);
    if (
      !(await this.persist(
        next,
        tr("Could not save the web pane state", "웹 패널 상태를 저장하지 못했습니다"),
      ))
    ) {
      return;
    }
    if (!this.runtime.addBrowserPane(project.id, browser, true)) {
      this.runtime.setFooterStatus(
        tr(
          "The web pane state was saved, but no runtime slot could be reserved.",
          "웹 패널 상태는 저장했지만 실행 슬롯을 확보하지 못했습니다.",
        ),
        "error",
      );
    }
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
    if (!this.canPersistRuntimeMutation()) {
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
          ? tr("Could not save the completion notification", "완료 알림을 저장하지 못했습니다")
          : tr(
              "Could not save the completion-notification acknowledgement",
              "완료 알림 확인 상태를 저장하지 못했습니다",
            ),
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

  private canPersistRuntimeMutation(): boolean {
    return (
      this.initialized &&
      this.storageWritable &&
      this.session?.access === "ready" &&
      !this.shuttingDown &&
      !this.externalReplacementPending &&
      !this.storageFaulted &&
      this.upgradeInspection === null
    );
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
      tr(
        `Opening ${project.name} requires ${capacity.incoming} PowerShell slots, but only ${capacity.available} remain.`,
        `${project.name}을 열려면 PowerShell ${capacity.incoming}개 슬롯이 필요하지만 ${capacity.available}개만 남았습니다.`,
      ),
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
          ? tr(
              "Review the safe copy of the previous Rust Preview state first.",
              "이전 Rust Preview 상태의 안전한 복사를 먼저 확인하세요.",
            )
          : tr(
              "The Rust workspace cannot be changed in its current state.",
              "Rust 작업 공간이 변경 가능한 상태가 아닙니다.",
            ),
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
    this.elements.selectProjectFolderButton.disabled = !enabled || this.projectFolderPickerPending;
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
    this.runtime.setModalOverlayOpen("upgrade", true);
    try {
      this.elements.upgradeDialog.showModal();
    } catch (error) {
      this.runtime.setModalOverlayOpen("upgrade", false);
      throw error;
    }
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
            tr(
              "The previous Rust Preview workspace was copied safely into canonical storage.",
              "이전 Rust Preview 작업을 canonical 저장소로 안전하게 복사했습니다.",
            ),
          );
        }
      } catch (error) {
        if (prepared && !committed) {
          try {
            await this.finishExternalReplacement(false);
            prepared = false;
          } catch (restoreError) {
            this.elements.upgradeError.textContent = tr(
              `${errorMessage(error)} · Failed to restore the previous state: ${errorMessage(restoreError)}`,
              `${errorMessage(error)} · 기존 상태 복원 실패: ${errorMessage(restoreError)}`,
            );
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
      return tr(
        "Read-only because another app window is using canonical storage.",
        "다른 앱 창이 canonical 저장소를 사용 중이어서 읽기 전용입니다.",
      );
    case "recoveryRequired":
    case "recoveryPreview":
      return tr("Canonical storage needs to be recovered.", "canonical 저장소 복구가 필요합니다.");
    case "unsupportedVersion":
      return tr(
        "Read-only because canonical storage uses a newer format.",
        "더 새로운 canonical 저장소라 읽기 전용입니다.",
      );
    default:
      return tr(
        "Canonical storage could not be loaded into a runnable state.",
        "canonical 저장소를 실행 가능한 상태로 불러오지 못했습니다.",
      );
  }
}

function localizeBuiltInTabTitle(title: string): string {
  return isBuiltInTabTitle(title) ? tr("New tab", "새 탭") : title;
}

function isBuiltInTabTitle(title: string): boolean {
  return title === "New tab" || title === "새 탭";
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
  if (value instanceof Error) return localizeBackendMessage(value.message);
  if (isRecord(value)) {
    if (typeof value.message === "string") return localizeBackendMessage(value.message);
    if ("error" in value) return errorMessage(value.error);
  }
  return localizeBackendMessage(String(value));
}
