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
  appendProjectEditorPane,
  appendProjectPane,
  appendWorkspaceProject,
  blockWorkspaceProviderResumeForAccountSwitch,
  closeWorkspaceTab,
  createWorkspaceBrowserPane,
  createWorkspaceEditorPane,
  createWorkspaceProject,
  createWorkspaceTerminal,
  findWorkspaceProjectByFolder,
  moveWorkspaceTabBefore,
  moveWorkspaceTabByKeyboard,
  migrateLegacyAutomaticProjectTabsToManual,
  nextWorkspacePaneName,
  openProjectWorkspaceTab,
  removeWorkspaceProject,
  removeProjectBrowserPane,
  removeProjectEditorPane,
  removeProjectPane,
  renameProjectBrowserPane,
  renameProjectPane,
  renameWorkspaceProject,
  setProjectBrowserPaneUrl,
  setProjectPaneOrder,
  setTerminalAgentConversation,
  sortWorkspaceProjectsByRecentModification,
  suggestWorkspaceProjectName,
  terminalAgentBindingChanged,
  uniqueWorkspaceProjectName,
  validateWorkspaceProjectDraft,
  validateWorkspaceProjectName,
  projectEditorPanes,
  sameProjectEditorPath,
  type RestoreCapacityDecision,
  type WorkspaceBrowserPane,
  type WorkspaceEditorPane,
  type WorkspaceAgentProvider,
  type WorkspaceTerminalLaunchProfile,
} from "./phase4-core";
import {
  ProjectActivityTracker,
  deriveSafeResumePlans,
  type SafeResumePlan,
} from "./phase5-core";
import { localizeBackendMessage, tr } from "./i18n";
import {
  crossedPointerReorderThreshold,
  horizontalReorderTarget,
} from "./pointer-reorder";
import {
  ProjectFileTreeView,
  type ProjectFileTreeViewElements,
} from "./project-file-tree-view";
import { validateProjectPathSegments } from "./project-file-tree";

type StatusTone = "normal" | "error";

type TabPointerReorder = {
  pointerId: number;
  tabId: string;
  element: HTMLElement;
  startX: number;
  startY: number;
  started: boolean;
};

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
  addEditorPane(
    projectId: string,
    editor: WorkspaceEditorPane,
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
  projectListToggle: HTMLButtonElement;
  projectSidebarContent: HTMLElement;
  projectFileTree: ProjectFileTreeViewElements;
  tabList: HTMLElement;
  addTerminalButton: HTMLButtonElement;
  addTabButton: HTMLButtonElement;
  createProjectButton: HTMLButtonElement;
  projectCreateMenu: HTMLElement;
  useExistingProjectFolderButton: HTMLButtonElement;
  startProjectFromScratchButton: HTMLButtonElement;
  projectDialog: HTMLDialogElement;
  projectDialogTitle: HTMLElement;
  projectDialogDescription: HTMLElement;
  projectForm: HTMLFormElement;
  projectName: HTMLInputElement;
  projectPathField: HTMLElement;
  projectPath: HTMLInputElement;
  selectProjectFolderButton: HTMLButtonElement;
  projectFormError: HTMLElement;
  cancelProjectButton: HTMLButtonElement;
  submitProjectButton: HTMLButtonElement;
  projectRenameDialog: HTMLDialogElement;
  projectRenameForm: HTMLFormElement;
  projectRenameName: HTMLInputElement;
  projectRenameError: HTMLElement;
  cancelProjectRenameButton: HTMLButtonElement;
  confirmProjectRenameButton: HTMLButtonElement;
  projectDeleteDialog: HTMLDialogElement;
  projectDeleteMessage: HTMLElement;
  cancelProjectDeleteButton: HTMLButtonElement;
  confirmProjectDeleteButton: HTMLButtonElement;
  upgradeButton: HTMLButtonElement;
  upgradeDialog: HTMLDialogElement;
  upgradeProjectCount: HTMLElement;
  upgradeTerminalCount: HTMLElement;
  upgradeSourceSha: HTMLElement;
  commitUpgradeButton: HTMLButtonElement;
  closeUpgradeButton: HTMLButtonElement;
  upgradeError: HTMLElement;
};

function createProjectActionIcon(kind: "edit" | "delete"): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const paths = kind === "edit"
    ? [
        "M3 12.5l.7-3.1 6.9-6.9a1 1 0 0 1 1.4 0l1.1 1.1a1 1 0 0 1 0 1.4l-6.9 6.9z",
        "M9.8 3.3l2.9 2.9",
      ]
    : [
        "M3.5 4.5h9",
        "M6 2.5h4l.5 2H5.5z",
        "M5 4.5v8h6v-8",
        "M7 6.5v4M9 6.5v4",
      ];
  for (const data of paths) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", data);
    icon.append(path);
  }
  return icon;
}

function createProjectMenuToggle(label: string, menuId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "project-item-menu-toggle";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-controls", menuId);
  button.setAttribute("aria-expanded", "false");
  button.textContent = "…";
  return button;
}

function createProjectMenuItem(kind: "edit" | "delete", label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `project-item-menu-entry project-item-${kind}`;
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.append(createProjectActionIcon(kind));
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  return button;
}

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
  private projectCreationPending = false;
  private projectFolderDefaultPath: string | null = null;
  private projectDialogMode: "existing" | "scratch" = "scratch";
  private scratchProjectDirectory: { projectName: string; folderPath: string } | null = null;
  private pendingProjectRenameId: string | null = null;
  private pendingProjectRenameTrigger: HTMLButtonElement | null = null;
  private projectRenamePending = false;
  private pendingProjectDeleteId: string | null = null;
  private pendingProjectDeleteTrigger: HTMLButtonElement | null = null;
  private providerAccountRestartRollback: WorkspaceState | null = null;
  private readonly projectActivity = new ProjectActivityTracker();
  private readonly listeners = new AbortController();
  private readonly projectListToggle: HTMLButtonElement;
  private readonly projectFileTree: ProjectFileTreeView;
  private tabPointerReorder: TabPointerReorder | null = null;
  private tabDropTargetId: string | null = null;
  private tabDropPosition: "before" | "after" | null = null;
  private suppressTabClickUntil = 0;

  constructor(
    private readonly runtime: Phase4RuntimePort,
    private readonly elements: Phase4ControllerElements,
    private readonly idFactory: () => string = createOpaqueId,
  ) {
    const signal = this.listeners.signal;
    this.projectListToggle = elements.projectListToggle;
    this.projectFileTree = new ProjectFileTreeView({
      ...elements.projectFileTree,
      onOpenFile: (request) => this.openProjectFile(request.projectId, request.pathSegments),
    });
    this.projectListToggle.addEventListener(
      "click",
      () => {
        const expanded = this.projectListToggle.getAttribute("aria-expanded") === "true";
        this.setProjectListExpanded(!expanded);
      },
      { signal },
    );
    elements.addTabButton.addEventListener("click", () => void this.addBlankTab(), { signal });
    elements.tabList.addEventListener("pointermove", (event) => this.onTabPointerMove(event), {
      signal,
    });
    elements.tabList.addEventListener("pointerup", (event) => void this.onTabPointerUp(event), {
      signal,
    });
    elements.tabList.addEventListener("pointercancel", (event) => this.onTabPointerCancel(event), {
      signal,
    });
    elements.tabList.addEventListener(
      "lostpointercapture",
      (event) => this.onTabPointerCaptureLost(event),
      { signal },
    );
    elements.createProjectButton.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        if (this.canMutate()) this.setProjectCreateMenuOpen(elements.projectCreateMenu.hidden);
      },
      { signal },
    );
    elements.useExistingProjectFolderButton.addEventListener(
      "click",
      () => {
        this.setProjectCreateMenuOpen(false);
        void this.openExistingFolderProject();
      },
      { signal },
    );
    elements.startProjectFromScratchButton.addEventListener(
      "click",
      () => {
        this.setProjectCreateMenuOpen(false);
        if (this.canMutate()) this.openProjectDialog(null, "scratch");
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest(".project-create-menu-root")) this.setProjectCreateMenuOpen(false);
        if (!target?.closest(".project-item-menu-root")) this.closeProjectItemMenus();
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        if (!elements.projectCreateMenu.hidden) {
          event.preventDefault();
          this.setProjectCreateMenuOpen(false, true);
          return;
        }
        const openProjectMenu = elements.projectList.querySelector<HTMLElement>(
          '.project-item-menu:not([hidden])',
        );
        if (openProjectMenu) {
          event.preventDefault();
          this.closeProjectItemMenus(true);
        }
      },
      { signal },
    );
    elements.cancelProjectButton.addEventListener(
      "click",
      () => {
        if (!this.projectCreationPending) elements.projectDialog.close();
      },
      { signal },
    );
    elements.projectDialog.addEventListener(
      "cancel",
      (event) => {
        if (this.projectCreationPending) event.preventDefault();
      },
      { signal },
    );
    elements.cancelProjectRenameButton.addEventListener(
      "click",
      () => {
        if (!this.projectRenamePending) elements.projectRenameDialog.close();
      },
      { signal },
    );
    elements.projectRenameDialog.addEventListener(
      "cancel",
      (event) => {
        if (this.projectRenamePending) event.preventDefault();
      },
      { signal },
    );
    elements.projectRenameForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.submitProjectRename();
      },
      { signal },
    );
    elements.cancelProjectDeleteButton.addEventListener(
      "click",
      () => elements.projectDeleteDialog.close(),
      { signal },
    );
    elements.confirmProjectDeleteButton.addEventListener(
      "click",
      () => {
        const projectId = this.pendingProjectDeleteId;
        if (!projectId) return;
        elements.projectDeleteDialog.close();
        void this.deleteProject(projectId);
      },
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
      () => {
        this.scratchProjectDirectory = null;
        this.runtime.setModalOverlayOpen("project", false);
        this.setProjectCreateMenuOpen(false);
      },
      { signal },
    );
    elements.projectRenameDialog.addEventListener(
      "close",
      () => {
        const trigger = this.pendingProjectRenameTrigger;
        this.pendingProjectRenameId = null;
        this.pendingProjectRenameTrigger = null;
        this.elements.projectRenameError.textContent = "";
        this.runtime.setModalOverlayOpen("project-rename", false);
        requestAnimationFrame(() => {
          if (!this.shuttingDown && trigger?.isConnected) trigger.focus();
        });
      },
      { signal },
    );
    elements.projectDeleteDialog.addEventListener(
      "close",
      () => {
        const trigger = this.pendingProjectDeleteTrigger;
        this.pendingProjectDeleteId = null;
        this.pendingProjectDeleteTrigger = null;
        this.runtime.setModalOverlayOpen("project-delete", false);
        requestAnimationFrame(() => {
          if (!this.shuttingDown && trigger?.isConnected) trigger.focus();
        });
      },
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
    this.setProjectCreateMenuOpen(false);
    this.refreshControls();
  }

  private setProjectCreateMenuOpen(open: boolean, restoreFocus = false): void {
    const allowed = open && this.mutationsEnabled();
    this.elements.projectCreateMenu.hidden = !allowed;
    this.elements.createProjectButton.setAttribute("aria-expanded", String(allowed));
    if (allowed) {
      this.closeProjectItemMenus();
      requestAnimationFrame(() => this.elements.useExistingProjectFolderButton.focus());
    } else if (restoreFocus && this.elements.createProjectButton.isConnected) {
      this.elements.createProjectButton.focus();
    }
  }

  private closeProjectItemMenus(restoreFocus = false): void {
    for (const menu of this.elements.projectList.querySelectorAll<HTMLElement>(
      ".project-item-menu",
    )) {
      if (menu.hidden) continue;
      menu.hidden = true;
      const root = menu.closest<HTMLElement>(".project-item-menu-root");
      const toggle = root?.querySelector<HTMLButtonElement>(".project-item-menu-toggle") ?? null;
      toggle?.setAttribute("aria-expanded", "false");
      const item = root?.closest<HTMLElement>(".project-item");
      if (item) delete item.dataset.menuOpen;
      if (restoreFocus && toggle?.isConnected) toggle.focus();
    }
  }

  private setProjectListExpanded(expanded: boolean): void {
    this.elements.projectList.hidden = !expanded;
    this.elements.projectSidebarContent.hidden = !expanded;
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
    this.finishTabPointerReorder(false);
    this.projectFileTree.dispose();
    if (this.elements.projectDialog.open) this.elements.projectDialog.close();
    if (this.elements.projectRenameDialog.open) this.elements.projectRenameDialog.close();
    if (this.elements.projectDeleteDialog.open) this.elements.projectDeleteDialog.close();
    if (this.elements.upgradeDialog.open) this.elements.upgradeDialog.close();
    this.runtime.setModalOverlayOpen("project", false);
    this.runtime.setModalOverlayOpen("project-rename", false);
    this.runtime.setModalOverlayOpen("project-delete", false);
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

  async onEditorPaneClosed(projectId: string, paneId: string): Promise<boolean> {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return false;
    try {
      const next = removeProjectEditorPane(state, projectId, paneId);
      return await this.persist(
        next,
        tr("Could not save the editor removal", "편집기 삭제 상태를 저장하지 못했습니다"),
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

  onPaneOrderChanged(projectId: string, orderedPaneIds: string[]): void {
    const state = this.currentState();
    if (!state || !this.canMutate(false)) return;
    try {
      const next = setProjectPaneOrder(state, projectId, orderedPaneIds);
      void this.persist(
        next,
        tr("Could not save the panel layout", "패널 배치를 저장하지 못했습니다"),
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
      this.projectFileTree.hide();
      this.runtime.showEmptyView();
      return;
    }
    this.runtime.setResumePlans(deriveSafeResumePlans(state));
    const tab = state.tabs.find((item) => item.id === state.activeTabId) ?? null;
    if (tab?.kind === "project" && tab.projectId) {
      const project = state.projects.find((item) => item.id === tab.projectId);
      if (project) {
        this.projectFileTree.showProject(project);
      } else {
        this.projectFileTree.hide();
      }
      if (project && this.canStartRuntime()) {
        this.runtime.syncProject(project);
        if (this.runtime.showProject(project)) {
          return;
        }
      }
    } else {
      this.projectFileTree.hide();
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
      element.setAttribute("aria-grabbed", "false");
      element.draggable = false;
      element.dataset.reorderable = String(enabled);
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
      close.draggable = false;
      close.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.closeTab(tab.id, tab.projectId);
      });
      const activate = () => {
        if (performance.now() < this.suppressTabClickUntil) return;
        void this.activateTab(tab.id);
      };
      element.addEventListener("click", activate);
      element.addEventListener("pointerdown", (event) => this.onTabPointerDown(event, tab.id));
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
      const item = document.createElement("div");
      item.className = "project-item";
      item.dataset.enabled = String(enabled);
      item.dataset.active = String(project.id === state.selectedProjectId);

      const openButton = document.createElement("button");
      openButton.className = "project-item-open";
      openButton.type = "button";
      openButton.disabled = !enabled;
      openButton.title = tr(`Open ${project.name}`, `${project.name} 열기`);
      openButton.setAttribute("aria-label", openButton.title);
      const name = document.createElement("strong");
      name.className = "project-item-name";
      name.textContent = project.name;
      openButton.append(name);

      const unread = projectUnreadCount(state, project.id);
      item.dataset.hasCompletion = String(unread > 0);
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
        item.append(badge);
      }

      const menuRoot = document.createElement("div");
      menuRoot.className = "project-item-menu-root";
      const menuId = `project-item-menu-${project.id}`;
      const menuLabel = tr(`More actions for ${project.name}`, `${project.name} 추가 작업`);
      const menuToggle = createProjectMenuToggle(menuLabel, menuId);
      menuToggle.disabled = !enabled;
      const menu = document.createElement("div");
      menu.id = menuId;
      menu.className = "project-item-menu";
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      const editButton = createProjectMenuItem(
        "edit",
        tr("Rename", "이름 변경"),
      );
      const deleteButton = createProjectMenuItem(
        "delete",
        tr("Delete", "삭제"),
      );
      editButton.disabled = !enabled;
      deleteButton.disabled = !enabled;
      menu.append(editButton, deleteButton);
      menuRoot.append(menuToggle, menu);

      menuToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!enabled) return;
        const opening = menu.hidden;
        this.closeProjectItemMenus();
        this.setProjectCreateMenuOpen(false);
        if (!opening) return;
        const listBounds = this.elements.projectList.getBoundingClientRect();
        const itemBounds = item.getBoundingClientRect();
        item.dataset.menuDirection = listBounds.bottom - itemBounds.bottom < 70 ? "up" : "down";
        item.dataset.menuOpen = "true";
        menu.hidden = false;
        menuToggle.setAttribute("aria-expanded", "true");
        requestAnimationFrame(() => editButton.focus());
      });
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!enabled) return;
        this.closeProjectItemMenus();
        this.openProjectRenameDialog(project.id, menuToggle);
      });
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!enabled) return;
        this.closeProjectItemMenus();
        this.openProjectDeleteDialog(project.id, menuToggle);
      });
      openButton.addEventListener("click", () => void this.openProject(project.id));
      item.append(openButton, menuRoot);
      this.elements.projectList.append(item);
    }
  }

  private onTabPointerDown(event: PointerEvent, tabId: string): void {
    const target = event.target instanceof Element ? event.target : null;
    if (
      !this.canMutate(false) ||
      event.button !== 0 ||
      !event.isPrimary ||
      target?.closest(".workspace-tab-close")
    ) {
      return;
    }
    const element = target?.closest<HTMLElement>(".workspace-tab");
    if (!element || element.dataset.tabId !== tabId) {
      return;
    }
    this.finishTabPointerReorder(false);
    this.tabPointerReorder = {
      pointerId: event.pointerId,
      tabId,
      element,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      this.tabPointerReorder = null;
    }
  }

  private onTabPointerMove(event: PointerEvent): void {
    const pointer = this.tabPointerReorder;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    if (
      !pointer.started &&
      !crossedPointerReorderThreshold(
        pointer.startX,
        pointer.startY,
        event.clientX,
        event.clientY,
      )
    ) {
      return;
    }
    if (!pointer.started) {
      pointer.started = true;
      this.suppressTabClickUntil = Number.POSITIVE_INFINITY;
      pointer.element.setAttribute("aria-grabbed", "true");
      pointer.element.dataset.dragging = "true";
    }
    event.preventDefault();
    pointer.element.style.setProperty(
      "--reorder-offset-x",
      `${event.clientX - pointer.startX}px`,
    );
    this.clearTabDropIndicators();
    const elements = [...this.elements.tabList.querySelectorAll<HTMLElement>(".workspace-tab")];
    const target = horizontalReorderTarget(
      elements.flatMap((element) => {
        const id = element.dataset.tabId;
        if (!id) return [];
        const bounds = element.getBoundingClientRect();
        return [{ id, left: bounds.left, right: bounds.right }];
      }),
      pointer.tabId,
      event.clientX,
    );
    if (!target) {
      this.tabDropTargetId = null;
      this.tabDropPosition = null;
      return;
    }
    this.tabDropTargetId = target.targetId;
    this.tabDropPosition = target.position;
    elements.find((element) => element.dataset.tabId === target.targetId)!.dataset.dropPosition =
      target.position;
  }

  private async onTabPointerUp(event: PointerEvent): Promise<void> {
    const pointer = this.tabPointerReorder;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    if (!pointer.started) {
      this.finishTabPointerReorder(false);
      return;
    }
    event.preventDefault();
    const draggedTabId = pointer.tabId;
    const state = this.currentState();
    const targetId = this.tabDropTargetId;
    const position = this.tabDropPosition;
    this.finishTabPointerReorder(true);
    if (!state || !this.canMutate()) return;

    const remaining = state.tabs.filter((tab) => tab.id !== draggedTabId);
    let beforeTabId: string | null = null;
    if (targetId && position) {
      const targetIndex = remaining.findIndex((tab) => tab.id === targetId);
      if (targetIndex < 0) return;
      beforeTabId = position === "before"
        ? targetId
        : (remaining[targetIndex + 1]?.id ?? null);
    } else {
      return;
    }

    try {
      const next = moveWorkspaceTabBefore(state, draggedTabId, beforeTabId);
      if (next.tabs.every((tab, index) => tab.id === state.tabs[index]?.id)) return;
      if (
        await this.persist(
          next,
          tr("Could not save the tab order", "탭 순서를 저장하지 못했습니다"),
        )
      ) {
        this.renderAndActivate();
        requestAnimationFrame(() => {
          this.elements.tabList
            .querySelector<HTMLElement>(`.workspace-tab[data-tab-id="${CSS.escape(draggedTabId)}"]`)
            ?.focus();
        });
      }
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
    }
  }

  private onTabPointerCancel(event: PointerEvent): void {
    if (this.tabPointerReorder?.pointerId !== event.pointerId) return;
    this.finishTabPointerReorder(this.tabPointerReorder.started);
  }

  private onTabPointerCaptureLost(event: PointerEvent): void {
    if (this.tabPointerReorder?.pointerId !== event.pointerId) return;
    this.finishTabPointerReorder(this.tabPointerReorder.started);
  }

  private clearTabDropIndicators(): void {
    for (const tab of this.elements.tabList.querySelectorAll<HTMLElement>(".workspace-tab")) {
      delete tab.dataset.dropPosition;
    }
  }

  private finishTabPointerReorder(suppressClick = this.tabPointerReorder?.started ?? false): void {
    const pointer = this.tabPointerReorder;
    this.tabPointerReorder = null;
    if (pointer) {
      delete pointer.element.dataset.dragging;
      pointer.element.style.removeProperty("--reorder-offset-x");
      pointer.element.setAttribute("aria-grabbed", "false");
      try {
        if (pointer.element.hasPointerCapture(pointer.pointerId)) {
          pointer.element.releasePointerCapture(pointer.pointerId);
        }
      } catch {
        // The element may have been replaced while storage state refreshed.
      }
    }
    this.clearTabDropIndicators();
    this.tabDropTargetId = null;
    this.tabDropPosition = null;
    if (suppressClick) this.suppressTabClickUntil = performance.now() + 240;
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

  refreshLocalizedUi(): void {
    if (this.shuttingDown) return;
    const projectListExpanded = this.projectListToggle.getAttribute("aria-expanded") !== "false";
    this.renderTabs();
    this.renderSidebar();
    this.projectFileTree.refreshLocalizedUi();
    this.setProjectListExpanded(projectListExpanded);
    this.refreshControls();
  }

  private openProjectRenameDialog(projectId: string, trigger: HTMLButtonElement): void {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project || this.elements.projectRenameDialog.open) return;
    this.pendingProjectRenameId = projectId;
    this.pendingProjectRenameTrigger = trigger;
    this.elements.projectRenameName.value = project.name;
    this.elements.projectRenameError.textContent = "";
    this.elements.confirmProjectRenameButton.disabled = false;
    this.runtime.setModalOverlayOpen("project-rename", true);
    try {
      this.elements.projectRenameDialog.showModal();
    } catch (error) {
      this.pendingProjectRenameId = null;
      this.pendingProjectRenameTrigger = null;
      this.runtime.setModalOverlayOpen("project-rename", false);
      throw error;
    }
    requestAnimationFrame(() => {
      this.elements.projectRenameName.focus();
      this.elements.projectRenameName.select();
    });
  }

  private async submitProjectRename(): Promise<void> {
    const projectId = this.pendingProjectRenameId;
    const state = this.currentState();
    if (!projectId || !state || !this.canMutate()) return;
    this.elements.projectRenameError.textContent = "";
    this.projectRenamePending = true;
    this.elements.cancelProjectRenameButton.disabled = true;
    this.elements.confirmProjectRenameButton.disabled = true;
    try {
      const name = validateWorkspaceProjectName(this.elements.projectRenameName.value);
      const currentName = state.projects.find((project) => project.id === projectId)?.name;
      if (name === currentName) {
        this.elements.projectRenameDialog.close();
      } else if (await this.renameProject(projectId, name)) {
        this.elements.projectRenameDialog.close();
      } else {
        this.elements.projectRenameError.textContent = tr(
          "The project name could not be saved. Try again.",
          "프로젝트 이름을 저장하지 못했습니다. 다시 시도하세요.",
        );
      }
    } catch (error) {
      this.elements.projectRenameError.textContent = errorMessage(error);
    } finally {
      this.projectRenamePending = false;
      this.elements.cancelProjectRenameButton.disabled = false;
      if (this.elements.projectRenameDialog.open) {
        this.elements.confirmProjectRenameButton.disabled = false;
      }
    }
  }

  private async renameProject(projectId: string, name: string): Promise<boolean> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return false;
    const next = renameWorkspaceProject(state, projectId, name);
    if (
      !(await this.persist(
        next,
        tr("Could not save the project name", "프로젝트 이름을 저장하지 못했습니다"),
      ))
    ) {
      return false;
    }
    const committedProject = this.currentState()?.projects.find(
      (project) => project.id === projectId,
    );
    if (committedProject) this.runtime.syncProject(committedProject);
    this.renderAndActivate();
    return true;
  }

  private async deleteProject(projectId: string): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;

    try {
      const next = removeWorkspaceProject(state, projectId, this.idFactory());
      if (!this.canActivateWorkspaceState(next, projectId)) return;
      if (
        !(await this.persist(
          next,
          tr("Could not remove the project", "프로젝트를 삭제하지 못했습니다"),
        ))
      ) {
        return;
      }
      let cleanupError: string | null = null;
      try {
        await this.trackRuntimeTransition(() => this.runtime.unloadProject(projectId));
      } catch (error) {
        cleanupError = tr(
          `The project was removed, but its running panes could not be closed cleanly: ${errorMessage(error)}`,
          `프로젝트는 삭제했지만 실행 중인 창을 정상적으로 닫지 못했습니다: ${errorMessage(error)}`,
        );
      }
      this.projectActivity.clearProject(projectId);
      this.renderAndActivate();
      if (cleanupError) {
        this.runtime.setFooterStatus(cleanupError, "error");
      } else {
        this.runtime.setFooterStatus(
          tr(
            `Removed ${project.name} from IHATECODING. Its folder and files were left unchanged.`,
            `${project.name} 프로젝트를 IHATECODING에서 삭제했습니다. 폴더와 파일은 그대로 유지됩니다.`,
          ),
        );
      }
    } catch (error) {
      this.runtime.setFooterStatus(errorMessage(error), "error");
    }
  }

  private openProjectDeleteDialog(projectId: string, trigger: HTMLButtonElement): void {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    if (this.elements.projectDeleteDialog.open) return;
    this.pendingProjectDeleteId = projectId;
    this.pendingProjectDeleteTrigger = trigger;
    this.elements.projectDeleteMessage.textContent = tr(
      `Remove "${project.name}" and close its open tabs and running panes?`,
      `"${project.name}" 프로젝트와 열려 있는 탭, 실행 중인 창을 닫을까요?`,
    );
    this.runtime.setModalOverlayOpen("project-delete", true);
    try {
      this.elements.projectDeleteDialog.showModal();
    } catch (error) {
      this.pendingProjectDeleteId = null;
      this.pendingProjectDeleteTrigger = null;
      this.runtime.setModalOverlayOpen("project-delete", false);
      throw error;
    }
    requestAnimationFrame(() => this.elements.cancelProjectDeleteButton.focus());
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

  private async openExistingFolderProject(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const defaultPath =
      state.projects.find((project) => project.id === state.selectedProjectId)?.folderPath ?? null;
    const selected = await this.pickProjectFolder(defaultPath, false);
    if (!selected || !this.canMutate(false)) return;
    const current = this.currentState();
    if (!current) return;
    const existing = findWorkspaceProjectByFolder(current.projects, selected);
    if (existing) {
      await this.openProject(existing.id);
      return;
    }
    this.openProjectDialog(selected, "existing");
  }

  private openProjectDialog(
    initialFolderPath: string | null = null,
    mode: "existing" | "scratch" = "scratch",
  ): void {
    const state = this.currentState();
    this.projectDialogMode = mode;
    this.scratchProjectDirectory = null;
    this.projectFolderDefaultPath =
      state?.projects.find((project) => project.id === state.selectedProjectId)?.folderPath ?? null;
    this.elements.projectForm.reset();
    this.elements.projectFormError.textContent = "";
    const scratch = mode === "scratch";
    this.elements.projectPathField.hidden = scratch;
    this.elements.projectPath.required = !scratch;
    this.elements.selectProjectFolderButton.disabled = scratch;
    this.elements.projectDialogTitle.textContent = mode === "existing"
      ? tr("Use existing folder", "기존 폴더 사용")
      : tr("Start from scratch", "처음부터 시작");
    this.elements.projectDialogDescription.textContent = mode === "existing"
      ? tr(
          "Review the project name for the selected folder.",
          "선택한 폴더의 프로젝트 이름을 확인하세요.",
        )
      : tr(
          "Enter a name. A matching folder will be created in Documents.",
          "이름을 입력하면 문서 폴더 안에 같은 이름의 프로젝트 폴더를 만듭니다.",
        );
    this.elements.submitProjectButton.textContent = mode === "existing"
      ? tr("Add project", "프로젝트 추가")
      : tr("Create project", "프로젝트 만들기");
    this.elements.submitProjectButton.disabled = false;
    if (initialFolderPath) {
      this.elements.projectPath.value = initialFolderPath;
      this.elements.projectName.value = suggestWorkspaceProjectName(initialFolderPath);
    }
    this.runtime.setModalOverlayOpen("project", true);
    try {
      this.elements.projectDialog.showModal();
    } catch (error) {
      this.runtime.setModalOverlayOpen("project", false);
      throw error;
    }
    requestAnimationFrame(() => {
      this.elements.projectName.focus();
      if (initialFolderPath) this.elements.projectName.select();
    });
  }

  private async selectProjectFolder(): Promise<void> {
    if (this.projectFolderPickerPending || !this.canMutate()) return;
    const currentPath = this.elements.projectPath.value.trim();
    const selected = await this.pickProjectFolder(
      currentPath || this.projectFolderDefaultPath,
      true,
    );
    if (!selected) return;
    this.elements.projectPath.value = selected;
    if (!this.elements.projectName.value.trim()) {
      this.elements.projectName.value = suggestWorkspaceProjectName(selected);
    }
    this.elements.projectFormError.textContent = "";
  }

  private async pickProjectFolder(
    defaultPath: string | null,
    reportToProjectForm: boolean,
  ): Promise<string | null> {
    if (this.projectFolderPickerPending || !this.canMutate()) return null;
    this.projectFolderPickerPending = true;
    this.elements.selectProjectFolderButton.disabled = true;
    this.elements.createProjectButton.disabled = true;
    this.elements.useExistingProjectFolderButton.disabled = true;
    this.elements.startProjectFromScratchButton.disabled = true;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: tr("Select project folder", "프로젝트 폴더 선택"),
        defaultPath: defaultPath || undefined,
      });
      return typeof selected === "string" ? selected : null;
    } catch (error) {
      const message = tr(
        `Could not open the folder picker. ${errorMessage(error)}`,
        `폴더 선택기를 열지 못했습니다. ${errorMessage(error)}`,
      );
      if (reportToProjectForm) this.elements.projectFormError.textContent = message;
      else this.runtime.setFooterStatus(message, "error");
      return null;
    } finally {
      this.projectFolderPickerPending = false;
      const enabled = this.mutationsEnabled();
      this.elements.selectProjectFolderButton.disabled =
        !enabled || this.projectDialogMode === "scratch";
      this.elements.createProjectButton.disabled = !enabled;
      this.elements.useExistingProjectFolderButton.disabled = !enabled;
      this.elements.startProjectFromScratchButton.disabled = !enabled;
    }
  }

  private async createProject(): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate() || this.elements.submitProjectButton.disabled) return;
    this.elements.projectFormError.textContent = "";
    this.projectCreationPending = true;
    this.elements.cancelProjectButton.disabled = true;
    this.elements.submitProjectButton.disabled = true;
    try {
      const requestedName = validateWorkspaceProjectName(this.elements.projectName.value);
      if (this.projectDialogMode === "scratch") {
        const saved = await this.enqueueOperation(async () => {
          const current = this.currentState();
          if (!current) {
            throw new Error(
              tr("Could not load the workspace state.", "작업 공간 상태를 불러오지 못했습니다."),
            );
          }
          const projectName = uniqueWorkspaceProjectName(current.projects, requestedName);
          let cachedDirectory = this.scratchProjectDirectory;
          if (cachedDirectory && cachedDirectory.projectName !== projectName) {
            if (!(await this.rollbackScratchProjectDirectory())) {
              throw new Error(
                tr(
                  `The previously created "${cachedDirectory.projectName}" folder is not empty. It was left unchanged.`,
                  `앞서 만든 "${cachedDirectory.projectName}" 폴더가 비어 있지 않아 그대로 유지했습니다.`,
                ),
              );
            }
            cachedDirectory = null;
          }
          const folderPath = cachedDirectory?.folderPath ??
            await invoke<string>("create_documents_project_directory", { projectName });
          this.scratchProjectDirectory = { projectName, folderPath };
          const draft = validateWorkspaceProjectDraft(projectName, folderPath);
          this.elements.projectPath.value = draft.folderPath;
          const project = createWorkspaceProject(
            this.idFactory(),
            draft.name,
            draft.folderPath,
            new Date().toISOString(),
          );
          const withProject = appendWorkspaceProject(current, project);
          const next = openProjectWorkspaceTab(withProject, project.id, this.idFactory());
          return this.persistNow(
            next,
            tr("Could not save the project", "프로젝트를 저장하지 못했습니다"),
          );
        });
        if (saved) {
          this.elements.projectDialog.close();
          this.renderAndActivate();
        } else {
          const rolledBack = await this.rollbackScratchProjectDirectory();
          this.elements.projectFormError.textContent = rolledBack
            ? tr(
                "The project could not be saved. The empty folder was removed; try again.",
                "프로젝트를 저장하지 못해 빈 폴더를 되돌렸습니다. 다시 시도하세요.",
              )
            : tr(
                "The folder was created, but the project could not be saved. Try again.",
                "폴더는 만들었지만 프로젝트를 저장하지 못했습니다. 다시 시도하세요.",
              );
        }
        return;
      }

      const projectName = uniqueWorkspaceProjectName(state.projects, requestedName);
      const draft = validateWorkspaceProjectDraft(projectName, this.elements.projectPath.value);
      this.elements.projectPath.value = draft.folderPath;
      const existing = findWorkspaceProjectByFolder(state.projects, draft.folderPath);
      if (existing) {
        this.elements.projectDialog.close();
        await this.openProject(existing.id);
        return;
      }
      const project = createWorkspaceProject(
        this.idFactory(),
        draft.name,
        draft.folderPath,
        new Date().toISOString(),
      );
      const withProject = appendWorkspaceProject(state, project);
      const next = openProjectWorkspaceTab(withProject, project.id, this.idFactory());
      const saved = await this.persist(
        next,
        tr("Could not save the project", "프로젝트를 저장하지 못했습니다"),
      );
      if (saved) {
        this.elements.projectDialog.close();
        this.renderAndActivate();
      }
    } catch (error) {
      const message = errorMessage(error);
      const rolledBack = await this.rollbackScratchProjectDirectory();
      this.elements.projectFormError.textContent = rolledBack
        ? message
        : tr(
            `${message} The created folder is not empty, so it was left unchanged.`,
            `${message} 생성된 폴더가 비어 있지 않아 그대로 유지했습니다.`,
          );
    } finally {
      this.projectCreationPending = false;
      this.elements.cancelProjectButton.disabled = false;
      if (this.elements.projectDialog.open) this.elements.submitProjectButton.disabled = false;
    }
  }

  private async rollbackScratchProjectDirectory(): Promise<boolean> {
    const created = this.scratchProjectDirectory;
    if (!created) return true;
    try {
      await invoke<void>("remove_empty_documents_project_directory", {
        projectName: created.projectName,
      });
      this.scratchProjectDirectory = null;
      return true;
    } catch {
      return false;
    }
  }

  activeProjectFolderPath(): string | null {
    const state = this.currentState();
    if (!state) return null;
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== "project" || !tab.projectId) return null;
    return state.projects.find((project) => project.id === tab.projectId)?.folderPath ?? null;
  }

  async openContentBrowserMarkdownFile(
    grantId: string,
    pathSegments: readonly string[],
  ): Promise<boolean> {
    const state = this.currentState();
    if (!state) return false;
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== "project" || !tab.projectId) return false;
    const project = state.projects.find((item) => item.id === tab.projectId);
    if (!project) return false;

    const absolutePath = await invoke<unknown>("resolve_content_entry_path", {
      grantId,
      pathSegments: [...pathSegments],
    });
    if (typeof absolutePath !== "string" || !absolutePath) {
      throw new Error(tr("The selected file path is invalid.", "선택한 파일 경로가 올바르지 않습니다."));
    }
    const resolved = await invoke<unknown>("resolve_project_file_path", {
      projectId: project.id,
      absolutePath,
    });
    if (resolved === null) return false;
    if (!Array.isArray(resolved)) {
      throw new Error(tr("The selected project file is invalid.", "선택한 프로젝트 파일이 올바르지 않습니다."));
    }
    const projectPathSegments = validateProjectPathSegments(resolved);
    if (projectPathSegments.length === 0) {
      throw new Error(tr("The selected project file is invalid.", "선택한 프로젝트 파일이 올바르지 않습니다."));
    }
    await this.openProjectFile(project.id, projectPathSegments);
    return true;
  }

  async addTerminal(
    launchProfile: WorkspaceTerminalLaunchProfile = "powershell",
  ): Promise<void> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return;
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== "project" || !tab.projectId) return;
    const project = state.projects.find((item) => item.id === tab.projectId);
    if (!project) return;
    if (!this.runtime.canAddPane(project.id)) {
      this.runtime.setFooterStatus(
        tr(
          "A terminal pane cannot be added right now.",
          "지금은 터미널 화면을 추가할 수 없습니다.",
        ),
        "error",
      );
      return;
    }
    const terminal = createWorkspaceTerminal(
      this.idFactory(),
      nextWorkspacePaneName(project, launchProfile),
      project.folderPath,
      new Date().toISOString(),
      launchProfile,
    );
    const next = appendProjectPane(state, project.id, terminal);
    if (
      !(await this.persist(next, tr("Could not save the terminal state", "터미널 상태를 저장하지 못했습니다")))
    ) {
      return;
    }
    if (!this.runtime.addPane(project.id, terminal, true)) {
      this.runtime.setFooterStatus(
        tr(
          "The terminal state was saved, but no runtime slot could be reserved.",
          "터미널 상태는 저장했지만 실행 슬롯을 확보하지 못했습니다.",
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

  async addBrowserPaneFromLink(projectId: string, url: string): Promise<string | null> {
    const state = this.currentState();
    if (!state || !this.canMutate()) return null;
    const project = state.projects.find((item) => item.id === projectId);
    const activeTab = state.tabs.find((item) => item.id === state.activeTabId);
    if (!project || activeTab?.kind !== "project" || activeTab.projectId !== projectId) {
      return null;
    }
    if (!this.runtime.canAddPane(project.id)) {
      this.runtime.setFooterStatus(
        tr(
          "A web pane cannot be added right now.",
          "지금은 웹 화면을 추가할 수 없습니다.",
        ),
        "error",
      );
      return null;
    }

    let browser: WorkspaceBrowserPane;
    try {
      browser = createWorkspaceBrowserPane(this.idFactory(), "WEB", url);
    } catch {
      this.runtime.setFooterStatus(
        tr("The selected link cannot be opened.", "선택한 링크를 열 수 없습니다."),
        "error",
      );
      return null;
    }

    const next = appendProjectBrowserPane(state, project.id, browser);
    if (
      !(await this.persist(
        next,
        tr("Could not save the web pane state", "웹 패널 상태를 저장하지 못했습니다"),
      ))
    ) {
      return null;
    }
    if (!this.runtime.addBrowserPane(project.id, browser, true)) {
      this.runtime.setFooterStatus(
        tr(
          "The web pane state was saved, but no runtime slot could be reserved.",
          "웹 패널 상태는 저장했지만 실행 슬롯을 확보하지 못했습니다.",
        ),
        "error",
      );
      return null;
    }
    return browser.id;
  }

  private async openProjectFile(
    projectId: string,
    pathSegments: readonly string[],
  ): Promise<void> {
    if (!this.storageWritable || !this.canPersistRuntimeMutation()) {
      throw new Error(
        tr(
          "Wait for the current workspace update to finish, then try again.",
          "현재 작업공간 업데이트가 끝난 뒤 다시 시도하세요.",
        ),
      );
    }
    const requestedPath = [...pathSegments];
    await this.enqueueOperation(async () => {
      const state = this.currentState();
      const project = state?.projects.find((item) => item.id === projectId);
      if (!state || !project) {
        throw new Error(tr("The project no longer exists.", "프로젝트가 더 이상 없습니다."));
      }

      const existing = projectEditorPanes(project).find((pane) =>
        sameProjectEditorPath(pane, requestedPath),
      );
      if (existing) {
        this.runtime.addEditorPane(project.id, existing, true);
        return;
      }

      const editor = createWorkspaceEditorPane(
        this.idFactory(),
        requestedPath,
        requestedPath[requestedPath.length - 1] ?? tr("File", "파일"),
      );
      const next = appendProjectEditorPane(state, project.id, editor);
      const saved = await this.persistNow(
        next,
        tr("Could not save the editor pane", "편집기 창을 저장하지 못했습니다"),
      );
      if (!saved) {
        throw new Error(
          tr("The editor pane could not be saved.", "편집기 창을 저장하지 못했습니다."),
        );
      }
      if (!this.runtime.addEditorPane(project.id, editor, true)) {
        throw new Error(
          tr("The editor pane could not be opened.", "편집기 창을 열지 못했습니다."),
        );
      }
    });
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
    this.elements.useExistingProjectFolderButton.disabled = !enabled;
    this.elements.startProjectFromScratchButton.disabled = !enabled;
    this.elements.selectProjectFolderButton.disabled =
      !enabled || this.projectFolderPickerPending || this.projectDialogMode === "scratch";
    if (!enabled) {
      this.setProjectCreateMenuOpen(false);
      this.closeProjectItemMenus();
      this.finishTabPointerReorder();
    }
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
