import { invoke } from "@tauri-apps/api/core";
import { localizeBackendMessage, tr } from "./i18n";
import type { WorkspaceEditorPane } from "./phase4-core";

type StatusTone = "normal" | "error";

type ProjectTextFileResponse = {
  content: string;
  revision: string;
  byteLength: number;
};

type SaveProjectTextFileResponse = {
  revision: string;
  byteLength: number;
};

export type SourceEditorPaneHost = {
  activatePane(paneId: string, suppressFocus: boolean): void;
  beginPaneDrag(event: PointerEvent, paneId: string, captureTarget: HTMLElement): void;
  beginPaneResize(event: PointerEvent, paneId: string, captureTarget: HTMLElement): void;
  togglePaneMaximize(paneId: string): void;
  closeEditorPane(paneId: string): Promise<boolean>;
  onPaneStatusChanged(paneId: string): void;
  setModalOverlayOpen(reason: string, open: boolean): Promise<void> | void;
};

export class SourceEditorPane {
  readonly id: string;
  readonly persistentId: string;
  readonly projectId: string;
  readonly pathSegments: string[];
  readonly element: HTMLElement;
  title: string;

  private readonly editor: HTMLTextAreaElement;
  private readonly stateLabel: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly maximizeButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly resizeHandle: HTMLDivElement;
  private readonly closeDialog: HTMLDialogElement;
  private readonly closeDialogSaveButton: HTMLButtonElement;
  private readonly closeDialogDiscardButton: HTMLButtonElement;
  private readonly closeDialogCancelButton: HTMLButtonElement;
  private revision: string | null = null;
  private savedContent = "";
  private lineEnding: "\n" | "\r\n" = "\n";
  private disposed = false;
  private saving = false;
  private closeRequestInFlight = false;
  private closeDialogOpening = false;
  private modalOverlayOpen = false;
  private catalogWritable = true;
  private loadingEpoch = 0;
  private statusMessage: string;
  private statusTone: StatusTone = "normal";

  constructor(
    private readonly host: SourceEditorPaneHost,
    projectId: string,
    savedState: WorkspaceEditorPane,
    runtimeId: string,
  ) {
    this.projectId = projectId;
    this.persistentId = savedState.id;
    this.id = runtimeId;
    this.title = savedState.title;
    this.pathSegments = [...savedState.pathSegments];
    this.statusMessage = tr("Loading file", "파일을 불러오는 중");

    this.element = document.createElement("article");
    this.element.className = "terminal-pane source-editor-pane";
    this.element.dataset.paneId = this.id;
    this.element.dataset.projectId = projectId;
    this.element.dataset.state = "starting";
    this.element.dataset.active = "false";
    this.element.setAttribute("aria-label", this.title);

    const header = document.createElement("header");
    header.className = "terminal-header";
    const stateDot = document.createElement("span");
    stateDot.className = "terminal-state-dot";
    stateDot.setAttribute("aria-hidden", "true");
    const heading = document.createElement("div");
    heading.className = "terminal-heading";
    const title = document.createElement("span");
    title.className = "terminal-title";
    title.textContent = this.title;
    title.title = this.pathSegments.join("\\");
    this.stateLabel = document.createElement("span");
    this.stateLabel.className = "terminal-state-label";
    this.stateLabel.textContent = this.statusMessage;
    heading.append(title, this.stateLabel);

    const actions = document.createElement("div");
    actions.className = "terminal-actions";
    this.maximizeButton = paneAction("□");
    this.closeButton = paneAction("×");
    actions.append(this.maximizeButton, this.closeButton);
    header.append(stateDot, heading, actions);

    const toolbar = document.createElement("div");
    toolbar.className = "source-editor-toolbar";
    const path = document.createElement("span");
    path.className = "source-editor-path";
    path.textContent = this.pathSegments.join(" / ");
    path.title = this.pathSegments.join("\\");
    const fileActions = document.createElement("div");
    fileActions.className = "source-editor-file-actions";
    this.saveButton = toolbarButton(tr("Save", "저장"));
    this.saveButton.dataset.primary = "true";
    fileActions.append(this.saveButton);
    toolbar.append(path, fileActions);

    const body = document.createElement("div");
    body.className = "source-editor-body";
    this.editor = document.createElement("textarea");
    this.editor.className = "source-editor-textarea";
    this.editor.spellcheck = false;
    this.editor.wrap = "off";
    this.editor.disabled = true;
    this.editor.setAttribute("aria-label", tr(`Edit ${this.title}`, `${this.title} 편집`));
    body.append(this.editor);

    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "terminal-resize-handle";
    this.resizeHandle.dataset.paneInteraction = "resize";
    this.resizeHandle.hidden = true;
    this.resizeHandle.tabIndex = -1;
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-orientation", "vertical");
    this.resizeHandle.setAttribute(
      "aria-label",
      tr(`Resize ${this.title} width`, `${this.title} 너비 조절`),
    );
    this.element.append(header, toolbar, body, this.resizeHandle);

    this.closeDialog = document.createElement("dialog");
    this.closeDialog.className = "project-dialog source-editor-close-dialog";
    this.closeDialog.setAttribute("aria-labelledby", `${this.id}-close-dialog-title`);
    const closeDialogForm = document.createElement("form");
    closeDialogForm.method = "dialog";
    const closeDialogHeading = document.createElement("div");
    closeDialogHeading.className = "dialog-heading";
    const closeDialogTitle = document.createElement("strong");
    closeDialogTitle.id = `${this.id}-close-dialog-title`;
    closeDialogTitle.textContent = tr("Save changes before closing?", "닫기 전에 변경사항을 저장할까요?");
    const closeDialogMessage = document.createElement("span");
    closeDialogMessage.textContent = tr(
      `There are unsaved changes in ${this.title}.`,
      `${this.title}에 저장하지 않은 변경사항이 있습니다.`,
    );
    closeDialogHeading.append(closeDialogTitle, closeDialogMessage);
    const closeDialogActions = document.createElement("div");
    closeDialogActions.className = "dialog-actions source-editor-close-dialog-actions";
    this.closeDialogCancelButton = dialogButton(tr("Cancel", "취소"));
    this.closeDialogDiscardButton = dialogButton(tr("Don't Save", "저장하지 않고 나가기"));
    this.closeDialogSaveButton = dialogButton(tr("Save", "저장"), "dialog-submit");
    closeDialogActions.append(
      this.closeDialogCancelButton,
      this.closeDialogDiscardButton,
      this.closeDialogSaveButton,
    );
    closeDialogForm.append(closeDialogHeading, closeDialogActions);
    this.closeDialog.append(closeDialogForm);
    document.body.append(this.closeDialog);

    this.maximizeButton.title = tr(`Maximize ${this.title}`, `${this.title} 확대`);
    this.maximizeButton.setAttribute("aria-label", this.maximizeButton.title);
    this.maximizeButton.setAttribute("aria-pressed", "false");
    this.closeButton.title = tr(`Close ${this.title}`, `${this.title} 닫기`);
    this.closeButton.setAttribute("aria-label", this.closeButton.title);

    this.element.addEventListener("pointerdown", () => this.host.activatePane(this.id, true));
    header.addEventListener("pointerdown", (event) => {
      this.host.beginPaneDrag(event, this.id, header);
    });
    this.resizeHandle.addEventListener("pointerdown", (event) => {
      this.host.beginPaneResize(event, this.id, this.resizeHandle);
    });
    toolbar.addEventListener("pointerdown", (event) => event.stopPropagation());
    body.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.maximizeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.host.togglePaneMaximize(this.id);
    });
    this.closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.requestClose();
    });
    this.saveButton.addEventListener("click", () => void this.save());
    this.closeDialogCancelButton.addEventListener("click", (event) => {
      event.preventDefault();
      if (!this.closeRequestInFlight && !this.saving) this.closeDialog.close();
    });
    this.closeDialogDiscardButton.addEventListener("click", (event) => {
      event.preventDefault();
      void this.closeWithoutSaving();
    });
    this.closeDialogSaveButton.addEventListener("click", (event) => {
      event.preventDefault();
      void this.saveAndClose();
    });
    this.closeDialog.addEventListener("cancel", (event) => {
      if (this.closeRequestInFlight || this.saving) event.preventDefault();
    });
    this.closeDialog.addEventListener("close", () => {
      this.setCloseDialogOverlayOpen(false);
      if (!this.disposed) this.editor.focus();
    });
    this.editor.addEventListener("input", () => this.updateDirtyState());
    this.editor.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.save();
      } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        this.editor.setRangeText("  ", start, end, "end");
        this.editor.dispatchEvent(new Event("input"));
      }
    });
    this.updateControls();
  }

  get status() {
    return { message: this.statusMessage, tone: this.statusTone };
  }

  get dirty() {
    return this.editor.value !== this.savedContent;
  }

  start(): void {
    void this.load();
  }

  focus(): void {
    this.editor.focus();
  }

  setActive(active: boolean): void {
    this.element.dataset.active = String(active);
  }

  setCatalogWritable(writable: boolean): void {
    this.catalogWritable = writable;
    this.updateControls();
  }

  setResizeHandleEnabled(enabled: boolean): void {
    this.resizeHandle.hidden = !enabled;
    this.resizeHandle.tabIndex = enabled ? 0 : -1;
  }

  setDragging(dragging: boolean): void {
    this.element.dataset.dragging = String(dragging);
  }

  setMaximized(maximized: boolean): void {
    this.element.dataset.maximized = String(maximized);
    this.maximizeButton.textContent = maximized ? "❐" : "□";
    this.maximizeButton.setAttribute("aria-pressed", String(maximized));
  }

  scheduleFit(_delay = 35): void {
    // DOM text and Markdown flow naturally; kept for the shared layout port.
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.loadingEpoch += 1;
    if (this.closeDialog.open) this.closeDialog.close();
    this.setCloseDialogOverlayOpen(false);
    this.closeDialog.remove();
    this.element.remove();
  }

  private async load(): Promise<void> {
    const epoch = ++this.loadingEpoch;
    this.setState("starting", tr("Loading file", "파일을 불러오는 중"));
    this.editor.disabled = true;
    this.updateControls();
    try {
      const response = await invoke<ProjectTextFileResponse>("read_project_text_file", {
        projectId: this.projectId,
        pathSegments: this.pathSegments,
      });
      if (this.disposed || epoch !== this.loadingEpoch) return;
      this.revision = response.revision;
      this.lineEnding = response.content.includes("\r\n") ? "\r\n" : "\n";
      const editableContent = response.content.replace(/\r\n?/gu, "\n");
      this.savedContent = editableContent;
      this.editor.value = editableContent;
      this.editor.disabled = false;
      this.updateDirtyState();
    } catch (error) {
      if (this.disposed || epoch !== this.loadingEpoch) return;
      this.revision = null;
      this.savedContent = "";
      this.editor.value = "";
      this.element.dataset.dirty = "false";
      this.setState("error", projectFileErrorMessage(error), "error");
    } finally {
      if (!this.disposed && epoch === this.loadingEpoch) this.updateControls();
    }
  }

  private async save(): Promise<boolean> {
    if (this.disposed || this.saving) return false;
    const loaded = !this.editor.disabled && this.revision !== null;
    if (!this.dirty) return loaded;
    if (!this.catalogWritable || !loaded || !this.revision) return false;
    const editableContent = this.editor.value;
    const content = this.lineEnding === "\r\n"
      ? editableContent.replace(/\n/gu, "\r\n")
      : editableContent;
    const revision = this.revision;
    this.saving = true;
    this.setState("starting", tr("Saving", "저장 중"));
    this.updateControls();
    try {
      const response = await invoke<SaveProjectTextFileResponse>("save_project_text_file", {
        projectId: this.projectId,
        pathSegments: this.pathSegments,
        content,
        expectedRevision: revision,
      });
      if (this.disposed) return false;
      this.revision = response.revision;
      this.savedContent = editableContent;
      this.updateDirtyState(tr("Saved", "저장됨"));
      return !this.dirty;
    } catch (error) {
      if (!this.disposed) this.setState("error", projectFileErrorMessage(error), "error");
      return false;
    } finally {
      this.saving = false;
      if (!this.disposed) this.updateControls();
    }
  }

  private async requestClose(): Promise<void> {
    if (this.disposed || this.closeRequestInFlight) return;
    if (this.dirty) {
      await this.openCloseDialog();
      return;
    }
    await this.finishClose();
  }

  private async saveAndClose(): Promise<void> {
    if (this.disposed || this.closeRequestInFlight || this.saving) return;
    this.closeRequestInFlight = true;
    this.updateControls();
    try {
      const savedCleanly = await this.save();
      if (savedCleanly && !this.disposed && !this.dirty) {
        const closed = await this.host.closeEditorPane(this.id);
        if (!closed && !this.disposed && this.closeDialog.open) {
          this.closeDialog.close();
        }
      }
    } finally {
      if (!this.disposed) {
        this.closeRequestInFlight = false;
        this.updateControls();
      }
    }
  }

  private async closeWithoutSaving(): Promise<void> {
    if (this.disposed || this.closeRequestInFlight || this.saving) return;
    this.closeRequestInFlight = true;
    this.updateControls();
    try {
      await this.host.closeEditorPane(this.id);
    } finally {
      if (!this.disposed) {
        this.closeRequestInFlight = false;
        this.updateControls();
      }
    }
  }

  private async finishClose(): Promise<void> {
    if (this.disposed || this.closeRequestInFlight) return;
    this.closeRequestInFlight = true;
    this.updateControls();
    try {
      await this.host.closeEditorPane(this.id);
    } finally {
      if (!this.disposed) {
        this.closeRequestInFlight = false;
        this.updateControls();
      }
    }
  }

  private async openCloseDialog(): Promise<void> {
    if (this.disposed || this.closeDialog.open || this.closeDialogOpening) return;
    this.closeDialogOpening = true;
    this.modalOverlayOpen = true;
    this.updateControls();
    try {
      await this.host.setModalOverlayOpen(this.closeDialogOverlayReason(), true);
      if (this.disposed || !this.dirty) {
        this.setCloseDialogOverlayOpen(false);
        return;
      }
      if (!this.closeDialog.open) this.closeDialog.showModal();
    } catch {
      this.setCloseDialogOverlayOpen(false);
    } finally {
      this.closeDialogOpening = false;
      if (!this.disposed) this.updateControls();
    }
  }

  private setCloseDialogOverlayOpen(open: boolean): void {
    if (this.modalOverlayOpen === open) return;
    this.modalOverlayOpen = open;
    void this.host.setModalOverlayOpen(this.closeDialogOverlayReason(), open);
  }

  private closeDialogOverlayReason(): string {
    return `source-editor-close:${this.id}`;
  }

  private updateDirtyState(cleanMessage?: string): void {
    this.element.dataset.dirty = String(this.dirty);
    if (cleanMessage !== undefined || this.element.dataset.state !== "error") {
      this.setState(
        "running",
        this.dirty
          ? tr("Unsaved changes", "저장하지 않은 변경")
          : cleanMessage ?? tr("Source editor", "소스 편집기"),
      );
    }
    this.updateControls();
  }

  private updateControls(): void {
    const loaded = !this.editor.disabled && this.revision !== null;
    this.saveButton.disabled = this.saving || !this.catalogWritable || !loaded || !this.dirty;
    this.closeButton.disabled = !this.catalogWritable || this.closeRequestInFlight;
    this.closeDialogSaveButton.disabled =
      this.saving || this.closeRequestInFlight || this.closeDialogOpening || !this.catalogWritable || !loaded || !this.dirty;
    this.closeDialogDiscardButton.disabled =
      this.saving || this.closeRequestInFlight || this.closeDialogOpening || !this.catalogWritable;
    this.closeDialogCancelButton.disabled = this.saving || this.closeRequestInFlight || this.closeDialogOpening;
  }

  private setState(state: "starting" | "running" | "error", message: string, tone: StatusTone = "normal"): void {
    this.element.dataset.state = state;
    this.statusMessage = message;
    this.statusTone = tone;
    this.stateLabel.textContent = message;
    this.stateLabel.title = message;
    this.host.onPaneStatusChanged(this.id);
  }
}

function paneAction(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "terminal-window-action";
  button.textContent = text;
  return button;
}

function toolbarButton(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "source-editor-toolbar-button";
  button.textContent = text;
  return button;
}

function dialogButton(text: string, className?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  if (className) button.className = className;
  button.textContent = text;
  return button;
}

function projectFileErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return localizeBackendMessage(error);
  if (error && typeof error === "object") {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim()) return localizeBackendMessage(message);
  }
  return tr("The project file operation failed.", "프로젝트 파일 작업에 실패했습니다.");
}
