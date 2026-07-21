import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  appLocale,
  getAppLanguage,
  localizeBackendMessage,
} from "./i18n";
import {
  mediaEntryKey,
  normalizeMediaDirectoryResponse,
  normalizeMediaRootGrant,
  normalizeMediaVolumeList,
  normalizeResolvedMediaFiles,
  type MediaBrowserEntry,
  type MediaDirectoryResponse,
  type MediaRootGrant,
  type MediaVolumeGrant,
} from "./media-browser-core";
import { isMarkdownFileName } from "./source-file-types";

export type MediaDrawerMarkdownOpenRequest = Readonly<{
  grantId: string;
  rootPath: string;
  name: string;
  pathSegments: readonly string[];
}>;

export type MediaDrawerElements = Readonly<{
  stage: HTMLElement;
  layer: HTMLElement;
  panel: HTMLElement;
  title: HTMLElement;
  pathForm: HTMLFormElement;
  pathInput: HTMLInputElement;
  grid: HTMLElement;
  collapseButton: HTMLButtonElement;
  contextMenu: HTMLElement;
  menuAttachButton: HTMLButtonElement;
  menuOpenButton: HTMLButtonElement;
  menuRevealButton: HTMLButtonElement;
  menuCopyPathButton: HTMLButtonElement;
  menuCopyNameButton: HTMLButtonElement;
  menuDeleteButton: HTMLButtonElement;
  deleteDialog: HTMLDialogElement;
  deleteFileName: HTMLElement;
  deleteError: HTMLElement;
  cancelDeleteButton: HTMLButtonElement;
  confirmDeleteButton: HTMLButtonElement;
}>;

type MediaDrawerCallbacks = Readonly<{
  getProjectFolderPath: () => string | null;
  openMarkdownFile: (request: MediaDrawerMarkdownOpenRequest) => Promise<boolean>;
  attachFiles: (paths: readonly string[]) => Promise<number>;
  previewDropTarget: (paneId: string) => boolean;
  clearDropTarget: () => void;
  attachFilesToPane: (paneId: string, paths: readonly string[]) => Promise<number>;
  restoreFocus: () => void;
}>;

type ContentDragState = {
  pointerId: number;
  card: HTMLButtonElement;
  entry: MediaBrowserEntry;
  startX: number;
  startY: number;
  dragging: boolean;
  ghost: HTMLElement | null;
  dropPaneId: string | null;
};

const CLOSE_ANIMATION_MS = 180;
const OPEN_LAYOUT_SETTLE_MS = 42;

export class MediaDrawer {
  private readonly listeners = new AbortController();
  private grant: MediaRootGrant | null = null;
  private directory: MediaDirectoryResponse | null = null;
  private volumes: MediaVolumeGrant[] | null = null;
  private showingVolumes = false;
  private loading = false;
  private attaching = false;
  private opened = false;
  private disposed = false;
  private requestGeneration = 0;
  private closeTimer = 0;
  private openTimer = 0;
  private previewObserver: IntersectionObserver | null = null;
  private lastFocusedElement: HTMLElement | null = null;
  private rootProjectPath: string | null = null;
  private unlistenBrowserToggle: UnlistenFn | null = null;
  private contextEntry: MediaBrowserEntry | null = null;
  private deleteEntry: MediaBrowserEntry | null = null;
  private dragState: ContentDragState | null = null;
  private suppressClickKey: string | null = null;
  private suppressClickUntil = 0;

  constructor(
    private readonly elements: MediaDrawerElements,
    private readonly callbacks: MediaDrawerCallbacks,
  ) {
    const signal = this.listeners.signal;
    elements.collapseButton.addEventListener("click", () => this.close(), { signal });
    elements.pathForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.openTypedLocation();
    }, { signal });
    elements.pathInput.addEventListener("paste", (event) => {
      const clipboardPath = event.clipboardData?.getData("text");
      if (clipboardPath) {
        event.preventDefault();
        elements.pathInput.value = clipboardPath;
      }
      window.setTimeout(() => {
        if (this.opened && !this.disposed) void this.openTypedLocation();
      }, 0);
    }, { signal });
    elements.grid.addEventListener("click", (event) => this.onGridClick(event), { signal });
    elements.grid.addEventListener("dblclick", (event) => this.onGridDoubleClick(event), {
      signal,
    });
    elements.grid.addEventListener("keydown", (event) => this.onGridKeyDown(event), { signal });
    elements.grid.addEventListener("contextmenu", (event) => this.onGridContextMenu(event), {
      signal,
    });
    elements.grid.addEventListener("pointerdown", (event) => this.onGridPointerDown(event), {
      signal,
    });
    elements.grid.addEventListener("pointermove", (event) => this.onGridPointerMove(event), {
      signal,
    });
    elements.grid.addEventListener("pointerup", (event) => this.onGridPointerUp(event), {
      signal,
    });
    elements.grid.addEventListener("pointercancel", () => this.cancelContentDrag(), { signal });
    elements.grid.addEventListener("lostpointercapture", (event) => {
      if (this.dragState && event.pointerId === this.dragState.pointerId) {
        this.cancelContentDrag();
      }
    }, { signal });
    elements.grid.addEventListener("scroll", () => this.closeContextMenu(), {
      passive: true,
      signal,
    });
    elements.contextMenu.addEventListener("keydown", (event) => this.onMenuKeyDown(event), {
      signal,
    });
    elements.menuAttachButton.addEventListener("click", () => void this.runContextAction("attach"), { signal });
    elements.menuOpenButton.addEventListener("click", () => void this.runContextAction("open"), { signal });
    elements.menuRevealButton.addEventListener("click", () => void this.runContextAction("reveal"), { signal });
    elements.menuCopyPathButton.addEventListener("click", () => void this.runContextAction("copy-path"), { signal });
    elements.menuCopyNameButton.addEventListener("click", () => void this.runContextAction("copy-name"), { signal });
    elements.menuDeleteButton.addEventListener("click", () => this.requestDelete(), { signal });
    elements.cancelDeleteButton.addEventListener("click", () => elements.deleteDialog.close(), { signal });
    elements.confirmDeleteButton.addEventListener("click", () => void this.confirmDelete(), { signal });
    elements.deleteDialog.addEventListener("close", () => {
      this.deleteEntry = null;
      elements.deleteError.textContent = "";
      elements.confirmDeleteButton.disabled = false;
    }, { signal });
    document.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!elements.contextMenu.hidden && (!(target instanceof Node) || !elements.contextMenu.contains(target))) {
        this.closeContextMenu();
      }
    }, { capture: true, signal });
    window.addEventListener("resize", () => this.closeContextMenu(), { signal });
    window.addEventListener("blur", () => {
      this.closeContextMenu();
      this.cancelContentDrag();
    }, { signal });
    window.addEventListener("beforeunload", () => this.cancelContentDrag(), { signal });
    window.addEventListener("keydown", (event) => this.onWindowKeyDown(event), {
      capture: true,
      signal,
    });
    window.addEventListener("keyup", (event) => this.onWindowKeyUp(event), {
      capture: true,
      signal,
    });
    void listen("media-drawer-toggle-requested", () => this.toggle())
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlistenBrowserToggle = unlisten;
      })
      .catch(() => undefined);

    elements.layer.hidden = true;
    elements.layer.inert = true;
    elements.layer.dataset.open = "false";
    elements.layer.setAttribute("aria-hidden", "true");
    elements.stage.dataset.mediaDrawerOpen = "false";
    this.refreshLocalizedUi();
  }

  refreshLocalizedUi(): void {
    this.elements.title.textContent = tr("Content browser", "콘텐츠 브라우저");
    this.setButtonLabel(this.elements.collapseButton, tr("Collapse content browser", "콘텐츠 브라우저 접기"));
    this.elements.pathInput.placeholder = tr("Paste a file or folder path", "파일 또는 폴더 경로 붙여넣기");
    this.elements.pathInput.setAttribute("aria-label", tr("Content browser path", "콘텐츠 브라우저 경로"));
    this.elements.grid.setAttribute(
      "aria-label",
      tr("Files and media", "파일 및 미디어"),
    );
    this.renderPath();
    if (this.opened) this.renderCurrentView();
  }

  async open(): Promise<void> {
    if (this.disposed || this.opened) return;
    if (document.querySelector("dialog[open]")) return;
    this.opened = true;
    window.clearTimeout(this.closeTimer);
    window.clearTimeout(this.openTimer);
    this.lastFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.elements.stage.dataset.mediaDrawerOpen = "true";
    this.elements.layer.hidden = false;
    this.elements.layer.inert = false;
    this.elements.layer.setAttribute("aria-hidden", "false");
    this.openTimer = window.setTimeout(() => {
      if (!this.opened || this.disposed) return;
      this.elements.layer.dataset.open = "true";
      if (this.directory) this.focusFirstResult();
      else this.elements.panel.focus({ preventScroll: true });
    }, OPEN_LAYOUT_SETTLE_MS);

    const projectFolder = this.callbacks.getProjectFolderPath();
    if (projectFolder !== this.rootProjectPath) {
      if (projectFolder) {
        await this.openLocation(projectFolder, projectFolder);
      } else {
        this.clearRoot();
        this.renderEmptyStart();
      }
      return;
    }
    if (this.directory) {
      this.renderCurrentView();
      return;
    }
    if (projectFolder) {
      await this.openLocation(projectFolder, projectFolder);
    } else {
      this.renderEmptyStart();
    }
  }

  close(): void {
    if (!this.opened || this.disposed) return;
    this.closeContextMenu();
    this.cancelContentDrag();
    if (this.elements.deleteDialog.open) this.elements.deleteDialog.close();
    this.opened = false;
    this.requestGeneration += 1;
    this.loading = false;
    window.clearTimeout(this.openTimer);
    this.elements.layer.dataset.open = "false";
    this.elements.layer.inert = true;
    this.elements.layer.setAttribute("aria-hidden", "true");
    this.releasePreviews();
    window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => {
      if (!this.opened) {
        this.elements.layer.hidden = true;
        this.elements.stage.dataset.mediaDrawerOpen = "false";
      }
    }, CLOSE_ANIMATION_MS);
    requestAnimationFrame(() => {
      const prior = this.lastFocusedElement;
      this.lastFocusedElement = null;
      if (prior?.isConnected) {
        prior.focus({ preventScroll: true });
      } else {
        this.callbacks.restoreFocus();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    const wasOpen = this.opened;
    this.disposed = true;
    this.opened = false;
    this.loading = false;
    this.listeners.abort();
    window.clearTimeout(this.closeTimer);
    window.clearTimeout(this.openTimer);
    this.requestGeneration += 1;
    this.releasePreviews();
    this.closeContextMenu();
    this.cancelContentDrag();
    if (this.elements.deleteDialog.open) this.elements.deleteDialog.close();
    this.unlistenBrowserToggle?.();
    this.unlistenBrowserToggle = null;
    if (wasOpen) {
      this.elements.layer.hidden = true;
      this.elements.stage.dataset.mediaDrawerOpen = "false";
    }
  }

  private onWindowKeyDown(event: KeyboardEvent): void {
    if (this.isToggleShortcut(event)) {
      if (event.isComposing || event.keyCode === 229) return;
      if (!this.opened && document.querySelector("dialog[open]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      this.toggle();
      return;
    }
    if (this.opened && event.key === "Escape") {
      if (this.dragState) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.cancelContentDrag();
        return;
      }
      if (!this.elements.contextMenu.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.closeContextMenu(true);
        return;
      }
      if (this.elements.deleteDialog.open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    }
  }

  private onWindowKeyUp(event: KeyboardEvent): void {
    if (!this.isToggleShortcut(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private isToggleShortcut(event: KeyboardEvent): boolean {
    return (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      (event.code === "Space" || event.key === " ")
    );
  }

  private toggle(): void {
    if (this.disposed) return;
    if (this.opened) this.close();
    else void this.open();
  }

  private async openLocation(startPath: string, projectPath?: string): Promise<void> {
    const generation = ++this.requestGeneration;
    this.loading = true;
    this.directory = null;
    this.showingVolumes = false;
    this.renderLoading();
    this.elements.pathInput.value = startPath;
    this.elements.pathInput.title = startPath;
    try {
      const grant = normalizeMediaRootGrant(
        await invoke<unknown>("open_media_location", { startPath }),
      );
      if (this.disposed || generation !== this.requestGeneration) return;
      this.grant = grant;
      if (projectPath !== undefined) this.rootProjectPath = projectPath;
      await this.loadDirectory(
        grant.initialPathSegments,
        generation,
        true,
        grant.focusFileName,
      );
    } catch (error) {
      if (this.disposed || generation !== this.requestGeneration) return;
      this.loading = false;
      this.renderError(mediaErrorMessage(error));
    }
  }

  private async loadDirectory(
    pathSegments: readonly string[],
    inheritedGeneration?: number,
    focusResults = false,
    focusFileName: string | null = null,
  ) {
    const grant = this.grant;
    if (!grant) return;
    const generation = inheritedGeneration ?? ++this.requestGeneration;
    this.loading = true;
    this.renderLoading();
    try {
      const response = normalizeMediaDirectoryResponse(
        await invoke<unknown>("list_media_directory", {
          grantId: grant.grantId,
          pathSegments: [...pathSegments],
        }),
      );
      if (
        this.disposed ||
        generation !== this.requestGeneration ||
        response.grantId !== grant.grantId
      ) {
        return;
      }
      this.directory = response;
      this.showingVolumes = false;
      this.loading = false;
      this.renderDirectory();
      if (focusResults) this.focusResult(focusFileName);
    } catch (error) {
      if (this.disposed || generation !== this.requestGeneration) return;
      this.loading = false;
      this.renderError(mediaErrorMessage(error));
    }
  }

  private async openTypedLocation(): Promise<void> {
    if (this.loading) return;
    const startPath = normalizeTypedPath(this.elements.pathInput.value);
    if (!startPath) {
      this.renderPath();
      return;
    }
    this.elements.pathInput.value = startPath;
    await this.openLocation(startPath);
  }

  private async navigateUp(focusResults = false): Promise<void> {
    if (this.showingVolumes) return;
    if (!this.directory || this.loading) return;
    if (this.directory.pathSegments.length === 0) {
      await this.showVolumeList(focusResults);
      return;
    }
    await this.loadDirectory(this.directory.pathSegments.slice(0, -1), undefined, focusResults);
  }

  private async showVolumeList(focusResults = false): Promise<void> {
    const generation = ++this.requestGeneration;
    this.loading = true;
    this.renderLoading();
    try {
      const volumes = normalizeMediaVolumeList(await invoke<unknown>("list_media_volumes"));
      if (this.disposed || generation !== this.requestGeneration) return;
      this.volumes = volumes;
      this.showingVolumes = true;
      this.loading = false;
      this.renderVolumes();
      if (focusResults) this.focusFirstResult();
    } catch (error) {
      if (this.disposed || generation !== this.requestGeneration) return;
      this.loading = false;
      this.renderError(mediaErrorMessage(error));
    }
  }

  private onGridClick(event: MouseEvent): void {
    const card = this.cardFromEvent(event);
    if (!card) return;
    if (
      this.suppressClickKey &&
      card.dataset.key === this.suppressClickKey &&
      performance.now() <= this.suppressClickUntil
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.suppressClickKey = null;
      this.suppressClickUntil = 0;
      return;
    }
    if (card.dataset.action === "parent") {
      this.setRovingCard(card);
      void this.navigateUp();
      return;
    }
    if (card.dataset.action === "volume") {
      this.setRovingCard(card);
      void this.openVolume(card);
      return;
    }
    const entry = this.entryForCard(card);
    if (!entry) return;
    this.setRovingCard(card);
    if (entry.kind === "directory") {
      void this.loadDirectory(entry.pathSegments);
    }
  }

  private onGridContextMenu(event: MouseEvent): void {
    const card = this.cardFromEvent(event);
    const entry = card ? this.entryForCard(card) : null;
    if (!card || !entry || entry.kind === "directory") return;
    event.preventDefault();
    this.cancelContentDrag();
    this.setRovingCard(card);
    card.focus({ preventScroll: true });
    this.openContextMenu(entry, event.clientX, event.clientY);
  }

  private onGridPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || this.loading || this.attaching) return;
    const card = this.cardFromEvent(event);
    const entry = card ? this.entryForCard(card) : null;
    if (!card || !entry || entry.kind === "directory") return;
    this.closeContextMenu();
    this.cancelContentDrag();
    this.dragState = {
      pointerId: event.pointerId,
      card,
      entry,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      ghost: null,
      dropPaneId: null,
    };
    try {
      card.setPointerCapture(event.pointerId);
    } catch {
      this.dragState = null;
    }
  }

  private onGridPointerMove(event: PointerEvent): void {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.dragging = true;
      drag.card.dataset.contentDragging = "true";
      drag.ghost = this.createDragGhost(drag.entry);
      document.body.append(drag.ghost);
    }
    event.preventDefault();
    this.moveDragGhost(drag.ghost, event.clientX, event.clientY);
    const paneId = this.terminalPaneIdAtPoint(event.clientX, event.clientY);
    if (paneId === drag.dropPaneId) return;
    this.callbacks.clearDropTarget();
    drag.dropPaneId = paneId && this.callbacks.previewDropTarget(paneId) ? paneId : null;
  }

  private onGridPointerUp(event: PointerEvent): void {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const pointedPaneId = drag.dragging
      ? this.terminalPaneIdAtPoint(event.clientX, event.clientY)
      : null;
    if (pointedPaneId !== drag.dropPaneId) {
      this.callbacks.clearDropTarget();
      drag.dropPaneId =
        pointedPaneId && this.callbacks.previewDropTarget(pointedPaneId)
          ? pointedPaneId
          : null;
    }
    const paneId = drag.dropPaneId;
    const entry = drag.entry;
    const didDrag = drag.dragging;
    if (didDrag) {
      this.suppressClickKey = mediaEntryKey(entry.pathSegments);
      this.suppressClickUntil = performance.now() + 500;
    }
    this.cancelContentDrag();
    if (didDrag && paneId) void this.dropEntryOnPane(entry, paneId);
  }

  private onGridDoubleClick(event: MouseEvent): void {
    const card = this.cardFromEvent(event);
    if (card?.dataset.action === "parent" || card?.dataset.action === "volume") return;
    const entry = card ? this.entryForCard(card) : null;
    if (!entry || entry.kind === "directory") return;
    void this.openMarkdownOrAttach(entry);
  }

  private onGridKeyDown(event: KeyboardEvent): void {
    const card = this.cardFromEvent(event);
    if (event.key === "Backspace" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void this.navigateUp(true);
      return;
    }
    if (!card) return;
    if (card.dataset.action === "parent") {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.navigateUp(true);
        return;
      }
      this.moveGridFocus(event, card);
      return;
    }
    if (card.dataset.action === "volume") {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.openVolume(card, true);
        return;
      }
      this.moveGridFocus(event, card);
      return;
    }
    const entry = this.entryForCard(card);
    if (!entry) return;
    if (
      entry.kind !== "directory" &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      const bounds = card.getBoundingClientRect();
      this.openContextMenu(entry, bounds.left + 12, bounds.top + 12);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (entry.kind === "directory") void this.loadDirectory(entry.pathSegments, undefined, true);
      else void this.openMarkdownOrAttach(entry);
      return;
    }
    this.moveGridFocus(event, card);
  }

  private moveGridFocus(event: KeyboardEvent, card: HTMLButtonElement): void {
    const cards = this.cards();
    const index = cards.indexOf(card);
    if (index < 0) return;
    let nextIndex = index;
    const columns = Math.max(1, Math.floor(this.elements.grid.clientWidth / 132));
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
    else if (event.key === "ArrowRight") nextIndex = Math.min(cards.length - 1, index + 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(0, index - columns);
    else if (event.key === "ArrowDown") nextIndex = Math.min(cards.length - 1, index + columns);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = cards.length - 1;
    else return;
    event.preventDefault();
    const next = cards[nextIndex];
    if (next) {
      this.setRovingCard(next);
      next.focus({ preventScroll: true });
    }
  }

  private openContextMenu(entry: MediaBrowserEntry, clientX: number, clientY: number): void {
    this.contextEntry = entry;
    this.elements.menuOpenButton.disabled =
      !entry.openable && !isMarkdownFileName(entry.name);
    this.elements.contextMenu.hidden = false;
    this.elements.contextMenu.style.left = "0px";
    this.elements.contextMenu.style.top = "0px";
    requestAnimationFrame(() => {
      if (this.contextEntry !== entry || this.elements.contextMenu.hidden) return;
      const bounds = this.elements.contextMenu.getBoundingClientRect();
      const panelBounds = this.elements.panel.getBoundingClientRect();
      const left = Math.max(
        panelBounds.left + 6,
        Math.min(clientX, panelBounds.right - bounds.width - 6),
      );
      const top = Math.max(
        panelBounds.top + 6,
        Math.min(clientY, panelBounds.bottom - bounds.height - 6),
      );
      this.elements.contextMenu.style.left = `${Math.round(left)}px`;
      this.elements.contextMenu.style.top = `${Math.round(top)}px`;
      this.menuButtons().find((button) => !button.disabled)?.focus({ preventScroll: true });
    });
  }

  private closeContextMenu(restoreCardFocus = false): void {
    if (this.elements.contextMenu.hidden) {
      this.contextEntry = null;
      return;
    }
    const entry = this.contextEntry;
    this.elements.contextMenu.hidden = true;
    this.contextEntry = null;
    if (!restoreCardFocus || !entry) return;
    const key = mediaEntryKey(entry.pathSegments);
    this.cards().find((card) => card.dataset.key === key)?.focus({ preventScroll: true });
  }

  private onMenuKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeContextMenu(true);
      return;
    }
    const buttons = this.menuButtons().filter((button) => !button.disabled);
    if (buttons.length === 0) return;
    const current = document.activeElement instanceof HTMLButtonElement
      ? buttons.indexOf(document.activeElement)
      : -1;
    let next = current;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  }

  private menuButtons(): HTMLButtonElement[] {
    return [
      this.elements.menuAttachButton,
      this.elements.menuOpenButton,
      this.elements.menuRevealButton,
      this.elements.menuCopyPathButton,
      this.elements.menuCopyNameButton,
      this.elements.menuDeleteButton,
    ];
  }

  private async runContextAction(
    action: "attach" | "open" | "reveal" | "copy-path" | "copy-name",
  ): Promise<void> {
    const entry = this.contextEntry;
    const grant = this.grant;
    if (!entry || !grant) return;
    this.closeContextMenu();
    try {
      if (action === "attach") {
        await this.attachEntry(entry);
        return;
      }
      if (action === "open") {
        if (await this.tryOpenMarkdownEntry(entry)) return;
        if (!entry.openable) return;
        await invoke("open_content_entry", {
          grantId: grant.grantId,
          pathSegments: [...entry.pathSegments],
        });
        return;
      }
      if (action === "reveal") {
        await invoke("reveal_content_entry", {
          grantId: grant.grantId,
          pathSegments: [...entry.pathSegments],
        });
        return;
      }
      const text = action === "copy-name"
        ? entry.name
        : await this.resolveEntryPath(grant.grantId, entry.pathSegments);
      await invoke("write_clipboard_text", { text });
    } catch (error) {
      if (this.opened && !this.disposed) this.renderError(mediaErrorMessage(error));
    }
  }

  private async openMarkdownOrAttach(entry: MediaBrowserEntry): Promise<void> {
    if (!isMarkdownFileName(entry.name)) {
      await this.attachEntry(entry);
      return;
    }
    if (await this.tryOpenMarkdownEntry(entry)) return;
    const grant = this.grant;
    if (!grant || !entry.openable) return;
    try {
      await invoke("open_content_entry", {
        grantId: grant.grantId,
        pathSegments: [...entry.pathSegments],
      });
    } catch (error) {
      if (this.opened && !this.disposed) this.renderError(mediaErrorMessage(error));
    }
  }

  private async tryOpenMarkdownEntry(entry: MediaBrowserEntry): Promise<boolean> {
    const grant = this.grant;
    if (!grant || !isMarkdownFileName(entry.name)) return false;
    try {
      return await this.callbacks.openMarkdownFile({
        grantId: grant.grantId,
        rootPath: grant.rootPath,
        name: entry.name,
        pathSegments: [...entry.pathSegments],
      });
    } catch (error) {
      if (this.opened && !this.disposed) this.renderError(mediaErrorMessage(error));
      return true;
    }
  }

  private requestDelete(): void {
    const entry = this.contextEntry;
    if (!entry || entry.kind === "directory") return;
    this.closeContextMenu();
    this.deleteEntry = entry;
    this.elements.deleteError.textContent = "";
    this.elements.deleteFileName.textContent = entry.name;
    this.elements.deleteFileName.title = entry.name;
    if (!this.elements.deleteDialog.open) this.elements.deleteDialog.showModal();
    this.elements.cancelDeleteButton.focus({ preventScroll: true });
  }

  private async confirmDelete(): Promise<void> {
    const entry = this.deleteEntry;
    const grant = this.grant;
    const directory = this.directory;
    if (!entry || entry.kind === "directory" || !grant || !directory) return;
    this.elements.confirmDeleteButton.disabled = true;
    this.elements.deleteError.textContent = "";
    try {
      await invoke("delete_content_file", {
        grantId: grant.grantId,
        pathSegments: [...entry.pathSegments],
      });
      this.deleteEntry = null;
      this.elements.deleteDialog.close();
      await this.loadDirectory(directory.pathSegments);
    } catch (error) {
      this.elements.confirmDeleteButton.disabled = false;
      this.elements.deleteError.textContent = mediaErrorMessage(error);
    }
  }

  private async dropEntryOnPane(entry: MediaBrowserEntry, paneId: string): Promise<void> {
    const grant = this.grant;
    if (!grant || this.disposed || !this.opened) return;
    try {
      const path = await this.resolveEntryPath(grant.grantId, entry.pathSegments);
      if (this.disposed || !this.opened || this.grant?.grantId !== grant.grantId) return;
      await this.callbacks.attachFilesToPane(paneId, [path]);
    } catch (error) {
      if (this.opened && !this.disposed) this.renderError(mediaErrorMessage(error));
    }
  }

  private async resolveEntryPath(
    grantId: string,
    pathSegments: readonly string[],
  ): Promise<string> {
    const value = await invoke<unknown>("resolve_content_entry_path", {
      grantId,
      pathSegments: [...pathSegments],
    });
    if (typeof value !== "string" || value.length === 0 || value.length > 32_768) {
      throw new Error("The resolved content path is invalid.");
    }
    return value;
  }

  private createDragGhost(entry: MediaBrowserEntry): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "content-file-drag-ghost";
    const icon = this.createFileTypeIcon(entry);
    icon.classList.add("content-file-drag-ghost-icon");
    const name = document.createElement("span");
    name.textContent = entry.name;
    ghost.append(icon, name);
    return ghost;
  }

  private moveDragGhost(ghost: HTMLElement | null, clientX: number, clientY: number): void {
    if (!ghost) return;
    ghost.style.transform = `translate3d(${Math.round(clientX + 12)}px, ${Math.round(clientY + 14)}px, 0)`;
  }

  private terminalPaneIdAtPoint(clientX: number, clientY: number): string | null {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const pane = element.closest<HTMLElement>(".terminal-pane[data-pane-id]");
      if (pane && !pane.hidden && pane.dataset.paneId) return pane.dataset.paneId;
    }
    return null;
  }

  private cancelContentDrag(): void {
    const drag = this.dragState;
    this.dragState = null;
    this.callbacks.clearDropTarget();
    if (!drag) return;
    drag.card.removeAttribute("data-content-dragging");
    drag.ghost?.remove();
    if (drag.card.hasPointerCapture(drag.pointerId)) {
      try {
        drag.card.releasePointerCapture(drag.pointerId);
      } catch {
        // The pointer may already have been released by the operating system.
      }
    }
  }

  private async attachEntry(entry: MediaBrowserEntry): Promise<void> {
    const grant = this.grant;
    if (!grant || this.attaching) return;
    const generation = this.requestGeneration;
    this.attaching = true;
    try {
      const paths = normalizeResolvedMediaFiles(
        await invoke<unknown>("resolve_media_files", {
          grantId: grant.grantId,
          selections: [[...entry.pathSegments]],
        }),
      );
      if (!this.opened || this.disposed || generation !== this.requestGeneration) return;
      const attached = await this.callbacks.attachFiles(paths);
      if (
        attached > 0 &&
        this.opened &&
        !this.disposed &&
        generation === this.requestGeneration
      ) {
        this.close();
      }
    } catch (error) {
      if (this.opened && !this.disposed && generation === this.requestGeneration) {
        this.renderError(mediaErrorMessage(error));
      }
    } finally {
      this.attaching = false;
    }
  }

  private async openVolume(card: HTMLButtonElement, focusResults = false): Promise<void> {
    const index = Number(card.dataset.volumeIndex);
    if (!Number.isInteger(index) || index < 0) return;
    const volume = this.volumes?.[index];
    if (!volume || this.loading) return;
    this.grant = { ...volume, initialPathSegments: [], focusFileName: null };
    await this.loadDirectory([], undefined, focusResults);
  }

  private renderDirectory(): void {
    if (!this.opened || this.loading) return;
    this.closeContextMenu();
    this.cancelContentDrag();
    const directory = this.directory;
    if (!directory) {
      this.renderEmptyStart();
      return;
    }
    this.releasePreviews();
    this.elements.grid.replaceChildren();
    this.renderPath();
    const fragment = document.createDocumentFragment();
    fragment.append(this.createParentCard());
    directory.entries.forEach((entry, index) =>
      fragment.append(this.createCard(entry, index, false)),
    );
    if (directory.entries.length === 0) {
      fragment.append(
        this.createMessage(tr("No files or media in this folder.", "이 폴더에 파일이나 미디어가 없습니다.")),
      );
    }
    if (directory.truncated) {
      fragment.append(
        this.createTruncatedMessage(
          tr(
            "This folder has more items. Only the first 240 are shown.",
            "이 폴더에 항목이 더 있습니다. 처음 240개만 표시합니다.",
          ),
        ),
      );
    }
    this.elements.grid.append(fragment);
    this.installPreviewObserver();
  }

  private renderVolumes(): void {
    if (!this.opened || this.loading || !this.showingVolumes) return;
    this.closeContextMenu();
    this.cancelContentDrag();
    this.releasePreviews();
    this.elements.grid.replaceChildren();
    this.renderPath();
    const fragment = document.createDocumentFragment();
    (this.volumes ?? []).forEach((volume, index) => {
      fragment.append(this.createVolumeCard(volume, index, index === 0));
    });
    if (!this.volumes?.length) {
      fragment.append(this.createMessage(tr("No storage locations found.", "저장소를 찾지 못했습니다.")));
    }
    this.elements.grid.append(fragment);
  }

  private renderCurrentView(): void {
    if (this.showingVolumes) this.renderVolumes();
    else this.renderDirectory();
  }

  private renderLoading(): void {
    this.closeContextMenu();
    this.cancelContentDrag();
    this.releasePreviews();
    this.elements.grid.replaceChildren(
      this.createMessage(tr("Loading content…", "콘텐츠 불러오는 중…"), true),
    );
    this.renderPath();
  }

  private renderEmptyStart(): void {
    this.releasePreviews();
    this.elements.grid.replaceChildren(
      this.createMessage(
        tr(
          "Open a project to browse files and media.",
          "프로젝트를 열어 파일과 미디어를 찾아보세요.",
        ),
      ),
    );
  }

  private renderError(message: string): void {
    this.releasePreviews();
    this.elements.grid.replaceChildren(this.createMessage(message));
  }

  private renderPath(): void {
    if (this.showingVolumes) {
      this.elements.pathInput.value = "";
      this.elements.pathInput.placeholder = tr(
        "Storage locations · paste a path",
        "저장소 · 경로 붙여넣기",
      );
      this.elements.pathInput.title = tr("Storage locations", "저장소");
      return;
    }
    this.elements.pathInput.placeholder = tr(
      "Paste a file or folder path",
      "파일 또는 폴더 경로 붙여넣기",
    );
    const segments = this.directory?.pathSegments ?? [];
    const path = this.grant ? joinMediaPath(this.grant.rootPath, segments) : "";
    this.elements.pathInput.value = path;
    this.elements.pathInput.title = path;
  }

  private createParentCard(): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "media-card media-card-parent";
    card.dataset.action = "parent";
    card.dataset.kind = "directory";
    card.dataset.selected = "false";
    card.tabIndex = 0;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", "false");
    card.setAttribute("aria-label", tr("Go to parent folder", "상위 폴더로 이동"));

    const preview = document.createElement("span");
    preview.className = "media-card-preview";
    preview.setAttribute("aria-hidden", "true");
    const folder = document.createElement("span");
    folder.className = "media-card-folder-icon media-card-parent-icon";
    const parentMark = document.createElement("span");
    parentMark.className = "media-card-parent-mark";
    parentMark.textContent = "↑";
    preview.append(folder, parentMark);

    const details = document.createElement("span");
    details.className = "media-card-details";
    const name = document.createElement("strong");
    name.textContent = "...";
    const meta = document.createElement("small");
    meta.textContent = this.directory?.pathSegments.length
      ? tr("Parent folder", "상위 폴더")
      : tr("Storage locations", "저장소");
    details.append(name, meta);
    card.append(preview, details);
    return card;
  }

  private createVolumeCard(
    volume: MediaVolumeGrant,
    volumeIndex: number,
    initiallyFocusable: boolean,
  ): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "media-card media-card-volume";
    card.dataset.action = "volume";
    card.dataset.kind = "directory";
    card.dataset.volumeIndex = String(volumeIndex);
    card.dataset.selected = "false";
    card.tabIndex = initiallyFocusable ? 0 : -1;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", "false");
    card.setAttribute("aria-label", tr(`Open ${volume.rootPath}`, `${volume.rootPath} 열기`));

    const preview = document.createElement("span");
    preview.className = "media-card-preview";
    preview.setAttribute("aria-hidden", "true");
    const drive = document.createElement("span");
    drive.className = "media-card-volume-icon";
    preview.append(drive);

    const details = document.createElement("span");
    details.className = "media-card-details";
    const name = document.createElement("strong");
    name.textContent = volume.rootName;
    name.title = volume.rootPath;
    const meta = document.createElement("small");
    meta.textContent = volume.rootPath;
    details.append(name, meta);
    card.append(preview, details);
    return card;
  }

  private createCard(
    entry: MediaBrowserEntry,
    entryIndex: number,
    initiallyFocusable: boolean,
  ): HTMLButtonElement {
    const card = document.createElement("button");
    const key = mediaEntryKey(entry.pathSegments);
    card.type = "button";
    card.className = "media-card";
    card.dataset.key = key;
    card.dataset.kind = entry.kind;
    card.dataset.entryIndex = String(entryIndex);
    card.dataset.selected = "false";
    card.tabIndex = initiallyFocusable ? 0 : -1;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", "false");
    card.setAttribute(
      "aria-label",
      entry.kind === "directory"
        ? tr(`Open folder ${entry.name}`, `${entry.name} 폴더 열기`)
        : tr(`Open ${entry.name}`, `${entry.name} 열기`),
    );

    const preview = document.createElement("span");
    preview.className = "media-card-preview";
    preview.setAttribute("aria-hidden", "true");
    if (entry.kind === "directory") {
      const folder = document.createElement("span");
      folder.className = "media-card-folder-icon";
      preview.append(folder);
    } else if (entry.kind === "file") {
      preview.append(this.createFileTypeIcon(entry));
    } else {
      preview.dataset.previewPending = String(Boolean(entry.previewPath));
      const fallback = this.createFileTypeIcon(entry);
      fallback.classList.add("media-card-fallback");
      preview.append(fallback);
      if (entry.kind === "video") {
        const badge = document.createElement("span");
        badge.className = "media-card-video-badge";
        badge.textContent = "▶";
        preview.append(badge);
      }
    }

    const details = document.createElement("span");
    details.className = "media-card-details";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    name.title = entry.name;
    details.append(name);
    const meta = document.createElement("small");
    meta.textContent =
      entry.kind === "directory"
        ? tr("Folder", "폴더")
        : `${fileKindLabel(entry.kind)} · ${formatFileSize(entry.sizeBytes)}`;
    details.append(meta);
    card.append(preview, details);
    return card;
  }

  private createFileTypeIcon(entry: MediaBrowserEntry): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "media-card-file-icon";
    icon.setAttribute("aria-hidden", "true");
    const extension = document.createElement("span");
    extension.className = "media-card-file-extension";
    extension.textContent = compactExtension(entry.name, entry.kind);
    icon.append(extension);
    return icon;
  }

  private installPreviewObserver(): void {
    const cards = this.cards().filter((card) => card.dataset.kind !== "directory");
    if (!("IntersectionObserver" in window)) {
      for (const card of cards) this.loadCardPreview(card);
      return;
    }
    this.previewObserver = new IntersectionObserver(
      (observations) => {
        for (const observation of observations) {
          if (!observation.isIntersecting || !(observation.target instanceof HTMLButtonElement)) {
            continue;
          }
          this.previewObserver?.unobserve(observation.target);
          this.loadCardPreview(observation.target);
        }
      },
      { root: this.elements.grid, rootMargin: "120px" },
    );
    for (const card of cards) this.previewObserver.observe(card);
  }

  private loadCardPreview(card: HTMLButtonElement): void {
    const entry = this.entryForCard(card);
    if (!entry?.previewPath || entry.kind === "directory") return;
    const preview = card.querySelector<HTMLElement>(".media-card-preview");
    if (!preview || preview.dataset.loaded === "true") return;
    preview.dataset.loaded = "true";
    const source = convertFileSrc(entry.previewPath);
    if (entry.kind === "image") {
      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      image.decoding = "async";
      image.loading = "lazy";
      image.addEventListener("load", () => {
        preview.dataset.previewReady = "true";
      }, { once: true });
      image.addEventListener("error", () => {
        image.removeAttribute("src");
        preview.dataset.previewError = "true";
      }, { once: true });
      image.src = source;
      preview.prepend(image);
      return;
    }

    if (entry.kind !== "video") return;

    const video = document.createElement("video");
    video.draggable = false;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.tabIndex = -1;
    video.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(video.duration) && video.duration > 0.1) {
        try {
          video.currentTime = Math.min(0.2, video.duration / 10);
        } catch {
          // The first decoded frame remains a useful fallback.
        }
      }
    }, { once: true });
    video.addEventListener("loadeddata", () => {
      preview.dataset.previewReady = "true";
    }, { once: true });
    video.addEventListener("error", () => {
      video.removeAttribute("src");
      video.load();
      preview.dataset.previewError = "true";
    }, { once: true });
    video.src = source;
    preview.prepend(video);
  }

  private releasePreviews(): void {
    this.previewObserver?.disconnect();
    this.previewObserver = null;
    for (const image of this.elements.grid.querySelectorAll<HTMLImageElement>("img")) {
      image.removeAttribute("src");
    }
    for (const video of this.elements.grid.querySelectorAll<HTMLVideoElement>("video")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  private createMessage(message: string, loading = false): HTMLElement {
    const root = document.createElement("div");
    root.className = "media-drawer-message";
    if (loading) {
      const spinner = document.createElement("span");
      spinner.className = "media-drawer-spinner";
      spinner.setAttribute("aria-hidden", "true");
      root.append(spinner);
    }
    const text = document.createElement("span");
    text.textContent = message;
    root.append(text);
    return root;
  }

  private createTruncatedMessage(message: string): HTMLElement {
    const root = document.createElement("div");
    root.className = "media-drawer-truncated";
    root.setAttribute("role", "status");
    root.textContent = message;
    return root;
  }

  private cardFromEvent(event: Event): HTMLButtonElement | null {
    const target = event.target;
    return target instanceof Element ? target.closest<HTMLButtonElement>(".media-card") : null;
  }

  private entryForCard(card: HTMLButtonElement): MediaBrowserEntry | null {
    const index = Number(card.dataset.entryIndex);
    if (!Number.isInteger(index) || index < 0) return null;
    return this.directory?.entries[index] ?? null;
  }

  private focusFirstResult(): void {
    requestAnimationFrame(() => {
      if (!this.opened || this.disposed) return;
      const first = this.cards()[0];
      if (first) {
        this.setRovingCard(first);
        first.focus({ preventScroll: true });
      } else {
        this.elements.grid.focus({ preventScroll: true });
      }
    });
  }

  private focusResult(fileName: string | null): void {
    requestAnimationFrame(() => {
      if (!this.opened || this.disposed) return;
      const matching = fileName
        ? this.cards().find((card) => {
            const entry = this.entryForCard(card);
            return entry?.name.localeCompare(fileName, undefined, { sensitivity: "accent" }) === 0;
          })
        : null;
      const target = matching ?? this.cards()[0];
      if (target) {
        this.setRovingCard(target);
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else {
        this.elements.grid.focus({ preventScroll: true });
      }
    });
  }

  private setRovingCard(active: HTMLButtonElement): void {
    for (const card of this.cards()) card.tabIndex = card === active ? 0 : -1;
  }

  private clearRoot(): void {
    this.grant = null;
    this.directory = null;
    this.volumes = null;
    this.showingVolumes = false;
    this.rootProjectPath = null;
  }

  private cards(): HTMLButtonElement[] {
    return [...this.elements.grid.querySelectorAll<HTMLButtonElement>(".media-card")];
  }

  private setButtonLabel(button: HTMLButtonElement, label: string): void {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

function formatFileSize(value: number | null): string {
  if (value === null) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(appLocale(), { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(amount)} ${units[unit]}`;
}

function fileKindLabel(kind: MediaBrowserEntry["kind"]): string {
  if (kind === "image") return tr("Image", "이미지");
  if (kind === "video") return tr("Video", "동영상");
  if (kind === "directory") return tr("Folder", "폴더");
  return tr("File", "파일");
}

function compactExtension(name: string, kind: MediaBrowserEntry["kind"]): string {
  const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  const normalized = extension.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (normalized) return normalized.slice(0, 5);
  if (kind === "image") return "IMG";
  if (kind === "video") return "VID";
  return "FILE";
}

function mediaErrorMessage(error: unknown): string {
  if (typeof error === "string") return localizeBackendMessage(error);
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return localizeBackendMessage(message);
  }
  return tr("The content location could not be opened.", "콘텐츠 위치를 열지 못했습니다.");
}

function joinMediaPath(rootPath: string, pathSegments: readonly string[]): string {
  if (pathSegments.length === 0) return rootPath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const cleanRoot = rootPath.replace(/[\\/]+$/, "");
  return `${cleanRoot}${separator}${pathSegments.join(separator)}`;
}

function normalizeTypedPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

// Media names and item counts are transient. Unlike the application-wide tr()
// registry, this formatter does not retain every dynamic label ever browsed.
function tr(english: string, korean: string): string {
  return getAppLanguage() === "ko" ? korean : english;
}
