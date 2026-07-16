import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Webview } from "@tauri-apps/api/webview";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  CumulativeAckPolicy,
  OutputSequencer,
  PHASE2_MAX_PANES as MAX_PANES,
  StartAbortedError,
  StartScheduler,
  binaryStringToRawBytes,
  clipboardItemsContainImage,
  layoutFor,
  normalizeTerminalEvent,
  prepareTerminalPaste,
  type TerminalEvent,
} from "./phase2-core";
import {
  MAX_PROJECT_PANES,
  addBlankTab,
  appendTerminal,
  catalogMutationsAllowed,
  cloneProjectCatalog,
  closeWorkspaceTab,
  createInitialTabState,
  createSavedTerminal,
  evaluateRestoreCapacity,
  findProjectByFolder,
  initialProject,
  nextTerminalName,
  normalizeProjectCatalog,
  normalizeProjectCatalogLoadResponse,
  openProjectTab,
  removeTerminal,
  renameTerminal,
  selectWorkspaceTab,
  uniqueProjectName,
  validateProjectDraft,
  type ProjectCatalog,
  type SavedTerminalState,
  type WorkspaceProject,
  type WorkspaceTabState,
} from "./phase3-core";
import { createPhase3BMigrationUI } from "./phase3b-ui";

type StartTerminalResponse = {
  sessionId: string;
  processId: number | null;
};

type PaneState =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "error";

type StatusTone = "normal" | "error";
type BrowserState = "closed" | "opening" | "open" | "closing";

type OutputBatch = Extract<TerminalEvent, { event: "output" }>["data"];
type TerminalInput =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: number[] };

const OUTPUT_SETTLED_DELAY_MS = 120;
const EXIT_GAP_TIMEOUT_MS = 2_000;
const UNBOUND_OUTPUT_MAX_BATCHES = 64;
const UNBOUND_OUTPUT_MAX_BYTES = 1_048_576;
const UNBOUND_OUTPUT_MAX_AGE_MS = 2_000;
const ACK_MAX_ATTEMPTS = 3;
const ACK_RETRY_DELAYS_MS = [40, 120] as const;
const outputEncoder = new TextEncoder();

class CancelledStart extends Error {
  constructor() {
    super("Terminal start was cancelled");
  }
}

class TerminalPane {
  readonly id: string;
  readonly terminalId: string;
  readonly projectId: string;
  readonly startDirectory: string;
  title: string;
  readonly element: HTMLElement;

  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly viewport: HTMLElement;
  private readonly titleElement: HTMLElement;
  private readonly titleEditor: HTMLInputElement;
  private readonly stateLabel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly terminalDisposables: Array<{ dispose(): void }> = [];
  private readonly outputSequencer = new OutputSequencer<OutputBatch>();
  private readonly ackPolicy = new CumulativeAckPolicy();
  private readonly unboundOutput: OutputBatch[] = [];
  private readonly terminatedSessionIds = new Set<string>();
  private readonly startAbortController = new AbortController();

  private sessionId: string | null = null;
  private unboundSessionId: string | null = null;
  private unboundOutputBytes = 0;
  private eventChannel: Channel<unknown> | null = null;
  private paneState: PaneState = "queued";
  private statusMessage = "시작 대기 중";
  private statusTone: StatusTone = "normal";
  private lifecycleEpoch = 0;
  private disposed = false;
  private catalogWritable = false;
  private terminalFailed = false;
  private fitTimer = 0;
  private outputSettledTimer = 0;
  private exitGapTimer = 0;
  private unboundOutputTimer = 0;
  private userBrowsingScrollback = false;
  private selectionGestureActive = false;
  private interactionEpoch = 0;
  private exitBarrierVersion = 0;
  private pendingExit: {
    sessionId: string;
    exitCode: number | null;
    lastSequence: number | null;
    epoch: number;
  } | null = null;
  private latestResize: { sessionId: string; columns: number; rows: number } | null = null;
  private resizeDrainRunning = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private renderQueue: Promise<void> = Promise.resolve();
  private clipboardQueue: Promise<void> = Promise.resolve();
  private startCompletion: Promise<void> = Promise.resolve();

  private readonly onWindowMouseUp = (event: MouseEvent) => {
    if (event.button !== 0 || !this.selectionGestureActive) return;
    this.selectionGestureActive = false;
    this.invalidatePendingFollow();
    if (!this.terminal.hasSelection() && this.isAtBottom()) {
      this.userBrowsingScrollback = false;
    }
  };

  private readonly onWindowBlur = () => {
    if (!this.selectionGestureActive) return;
    this.selectionGestureActive = false;
    this.invalidatePendingFollow();
  };

  constructor(
    private readonly workspace: TerminalWorkspace,
    private readonly scheduler: StartScheduler,
    projectId: string,
    savedState: SavedTerminalState,
  ) {
    this.terminalId = savedState.Id;
    this.id = paneRuntimeId(projectId, savedState.Id);
    this.projectId = projectId;
    this.title = savedState.Name;
    this.startDirectory = savedState.StartDirectory;

    this.element = document.createElement("article");
    this.element.className = "terminal-pane";
    this.element.dataset.paneId = this.id;
    this.element.dataset.projectId = this.projectId;
    this.element.dataset.state = this.paneState;
    this.element.dataset.active = "false";
    this.element.setAttribute("aria-label", this.title);

    const header = document.createElement("header");
    header.className = "terminal-header";

    const stateDot = document.createElement("span");
    stateDot.className = "terminal-state-dot";
    stateDot.setAttribute("aria-hidden", "true");

    const heading = document.createElement("div");
    heading.className = "terminal-heading";
    this.titleElement = document.createElement("span");
    this.titleElement.className = "terminal-title";
    this.titleElement.textContent = this.title;
    this.titleElement.title = "더블 클릭하여 이름 변경";
    this.titleEditor = document.createElement("input");
    this.titleEditor.className = "terminal-title-editor";
    this.titleEditor.maxLength = 80;
    this.titleEditor.hidden = true;
    this.titleEditor.setAttribute("aria-label", "PowerShell 이름");
    this.stateLabel = document.createElement("span");
    this.stateLabel.className = "terminal-state-label";
    this.stateLabel.textContent = this.statusMessage;
    heading.append(this.titleElement, this.titleEditor, this.stateLabel);

    const actions = document.createElement("div");
    actions.className = "terminal-actions";
    this.closeButton = document.createElement("button");
    this.closeButton.className = "terminal-close";
    this.closeButton.type = "button";
    this.closeButton.textContent = "×";
    this.closeButton.title = `${this.title} 닫기`;
    this.closeButton.setAttribute("aria-label", `${this.title} 닫기`);
    actions.append(this.closeButton);
    header.append(stateDot, heading, actions);

    this.viewport = document.createElement("div");
    this.viewport.className = "terminal-viewport";
    this.viewport.dataset.paneId = this.id;
    this.element.append(header, this.viewport);

    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      fontFamily: '"Cascadia Mono", "D2Coding", Consolas, monospace',
      fontSize: 12,
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1.08,
      letterSpacing: 0,
      scrollback: 10_000,
      smoothScrollDuration: 0,
      rightClickSelectsWord: false,
      scrollbar: {
        showScrollbar: true,
        showArrows: false,
        width: 6,
      },
      theme: {
        background: "#050505",
        foreground: "#f4f4f5",
        cursor: "#f4f4f5",
        cursorAccent: "#050505",
        selectionBackground: "#3f3f46",
        scrollbarSliderBackground: "#747474",
        scrollbarSliderHoverBackground: "#8a8a8a",
        scrollbarSliderActiveBackground: "#a0a0a0",
        black: "#050505",
        red: "#f87171",
        green: "#86efac",
        yellow: "#fde68a",
        blue: "#7dd3fc",
        magenta: "#d8b4fe",
        cyan: "#67e8f9",
        white: "#e4e4e7",
        brightBlack: "#71717a",
        brightRed: "#fca5a5",
        brightGreen: "#bbf7d0",
        brightYellow: "#fef3c7",
        brightBlue: "#bae6fd",
        brightMagenta: "#e9d5ff",
        brightCyan: "#a5f3fc",
        brightWhite: "#fafafa",
      },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.viewport);

    this.closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.workspace.closePane(this.id);
    });
    this.titleElement.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.beginTitleEdit();
    });
    this.titleEditor.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.titleEditor.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitTitleEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelTitleEdit();
      }
    });
    this.titleEditor.addEventListener("blur", () => {
      if (!this.titleEditor.hidden) this.commitTitleEdit();
    });
    this.element.addEventListener("pointerdown", () => {
      this.workspace.activatePane(this.id, false);
    });
    this.viewport.addEventListener("mousedown", () => {
      this.workspace.activatePane(this.id, false);
      this.terminal.focus();
    });

    this.installTerminalInputHandlers();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.viewport);
    window.addEventListener("mouseup", this.onWindowMouseUp, true);
    window.addEventListener("blur", this.onWindowBlur);
  }

  get state() {
    return this.paneState;
  }

  get status() {
    return { message: this.statusMessage, tone: this.statusTone } as const;
  }

  startAfter(barrier: Promise<void>) {
    this.startCompletion = barrier.then(() => this.start());
    return this.startCompletion;
  }

  private async start() {
    const epoch = ++this.lifecycleEpoch;
    this.setState("queued", "시작 대기 중");

    try {
      await this.scheduler.run(async (signal) => {
        if (signal?.aborted || this.disposed || epoch !== this.lifecycleEpoch) {
          throw new CancelledStart();
        }
        this.setState("starting", "PowerShell 시작 중…");
        await nextAnimationFrame();
        if (signal?.aborted || this.disposed || epoch !== this.lifecycleEpoch) {
          throw new CancelledStart();
        }

        this.fitTerminal();
        const onEvent = new Channel<unknown>();
        this.eventChannel = onEvent;
        onEvent.onmessage = (rawMessage) => {
          let message: TerminalEvent;
          try {
            message = normalizeTerminalEvent(rawMessage);
          } catch (error) {
            this.failProtocol(`이벤트 계약 위반: ${String(error)}`, []);
            return;
          }
          this.handleTerminalEvent(message, epoch);
        };

        const result = await invoke<StartTerminalResponse>("start_terminal", {
          cwd: this.startDirectory,
          columns: Math.max(2, this.terminal.cols),
          rows: Math.max(1, this.terminal.rows),
          onEvent,
        });

        if (this.disposed || epoch !== this.lifecycleEpoch) {
          await stopBackendSession(result.sessionId);
          throw new CancelledStart();
        }
        if (this.terminatedSessionIds.has(result.sessionId)) return;
        if (!this.bindSession(result.sessionId)) return;

        if (this.paneState !== "running") {
          this.setState(
            "running",
            result.processId
              ? `연결됨 · PID ${result.processId}`
              : "ConPTY 연결됨",
          );
        }
        this.scheduleFit(0);
      }, this.startAbortController.signal);
    } catch (error) {
      if (
        error instanceof CancelledStart ||
        error instanceof StartAbortedError ||
        this.disposed ||
        epoch !== this.lifecycleEpoch
      ) {
        return;
      }
      this.setState("error", String(error), "error");
    }
  }

  focus() {
    if (this.disposed) return;
    this.terminal.focus();
  }

  setActive(active: boolean) {
    this.element.dataset.active = String(active);
  }

  setTitle(title: string) {
    this.title = title;
    this.titleElement.textContent = title;
    this.element.setAttribute("aria-label", title);
    this.closeButton.title = `${title} 닫기`;
    this.closeButton.setAttribute("aria-label", `${title} 닫기`);
  }

  setCatalogWritable(writable: boolean) {
    this.catalogWritable = writable;
    this.closeButton.disabled = !writable;
    if (!writable && !this.titleEditor.hidden) this.cancelTitleEdit();
  }

  scheduleFit(delay = 35) {
    if (this.disposed) return;
    window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      this.fitTerminal();
      this.queueCurrentSize();
    }, delay);
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.startAbortController.abort();
    this.lifecycleEpoch += 1;
    this.setState("stopping", "종료 중…");
    window.clearTimeout(this.fitTimer);
    window.clearTimeout(this.outputSettledTimer);
    window.clearTimeout(this.exitGapTimer);
    window.clearTimeout(this.unboundOutputTimer);
    this.resizeObserver.disconnect();
    window.removeEventListener("mouseup", this.onWindowMouseUp, true);
    window.removeEventListener("blur", this.onWindowBlur);
    for (const disposable of this.terminalDisposables) disposable.dispose();
    if (this.eventChannel) this.eventChannel.onmessage = () => undefined;
    this.eventChannel = null;

    const sessionsToStop = new Set<string>();
    if (this.sessionId) sessionsToStop.add(this.sessionId);
    if (this.unboundSessionId) sessionsToStop.add(this.unboundSessionId);
    const targetSession = this.sessionId;
    this.sessionId = null;
    this.unboundSessionId = null;
    if (targetSession) {
      this.workspace.releaseSession(targetSession, this.id);
    }
    const stopBarrier = Promise.all([
      ...[...sessionsToStop].map(stopBackendSession),
      this.startCompletion.catch(() => undefined),
    ]).then(() => undefined);
    this.unboundOutput.length = 0;
    this.unboundOutputBytes = 0;
    this.terminal.dispose();
    return stopBarrier;
  }

  private installTerminalInputHandlers() {
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.isComposing || event.keyCode === 229) return true;

      const key = String(event.key || "").toLowerCase();
      const commandModifier = event.ctrlKey || event.metaKey;
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
        return false;
      };

      if (commandModifier && key === "c" && this.terminal.hasSelection()) {
        void this.copySelection();
        return consume();
      }
      if (event.ctrlKey && key === "insert") {
        void this.copySelection();
        return consume();
      }
      if (commandModifier && key === "v") {
        if (!event.repeat) void this.pasteClipboard();
        return consume();
      }
      if (event.shiftKey && !event.ctrlKey && !event.altKey && key === "insert") {
        if (!event.repeat) void this.pasteClipboard();
        return consume();
      }
      if (
        event.shiftKey &&
        (key === "pageup" || key === "pagedown" || key === "home" || key === "end")
      ) {
        if (key === "pageup" || key === "home") this.pauseAutoFollow();
      }
      return true;
    });

    this.terminalDisposables.push(
      this.terminal.onData((data) => {
        this.queueInput({ kind: "text", data });
      }),
      this.terminal.onBinary((data) => {
        const bytes = binaryStringToRawBytes(data);
        this.queueInput({ kind: "binary", data: bytes });
      }),
      this.terminal.onScroll(() => {
        const browsing = !this.isAtBottom();
        if (browsing !== this.userBrowsingScrollback) {
          this.userBrowsingScrollback = browsing;
          this.invalidatePendingFollow();
        } else if (browsing) {
          window.clearTimeout(this.outputSettledTimer);
        }
      }),
      this.terminal.onSelectionChange(() => {
        if (this.terminal.hasSelection()) this.pauseAutoFollow();
      }),
    );

    this.viewport.addEventListener(
      "keydown",
      (event) => {
        if (isTerminalInputIntentKey(event, this.terminal.hasSelection())) {
          this.resumeAutoFollowForUserIntent();
        }
      },
      true,
    );
    this.viewport.addEventListener(
      "beforeinput",
      () => this.resumeAutoFollowForUserIntent(),
      true,
    );
    for (const eventName of ["compositionstart", "compositionupdate", "compositionend"]) {
      this.viewport.addEventListener(
        eventName,
        () => this.resumeAutoFollowForUserIntent(),
        true,
      );
    }

    this.viewport.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY < 0) this.pauseAutoFollow();
      },
      { passive: true },
    );
    this.viewport.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        this.selectionGestureActive = true;
        this.invalidatePendingFollow();
      }
    });
    this.viewport.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (this.terminal.hasSelection()) void this.copySelection();
      else void this.pasteClipboard();
    });
  }

  private handleTerminalEvent(message: TerminalEvent, epoch: number) {
    if (this.disposed || epoch !== this.lifecycleEpoch) return;

    switch (message.event) {
      case "started":
        if (this.terminatedSessionIds.has(message.data.sessionId)) return;
        if (!this.bindSession(message.data.sessionId)) return;
        this.setState(
          "running",
          message.data.processId
            ? `연결됨 · PID ${message.data.processId}`
            : "ConPTY 연결됨",
        );
        this.scheduleFit(0);
        break;

      case "output": {
        if (this.outputSequencer.hasObservedExit) {
          this.failProtocol("Exited 이후 출력 이벤트가 도착했습니다.", [
            message.data.sessionId,
          ]);
          return;
        }
        if (!this.sessionId) {
          this.bufferUnboundOutput(message.data);
          return;
        }
        if (message.data.sessionId !== this.sessionId) {
          this.failProtocol("바인딩된 패널에 다른 세션 출력이 전달되었습니다.", [
            message.data.sessionId,
          ]);
          return;
        }
        this.acceptOutput(message.data);
        break;
      }

      case "error":
        if (this.sessionId && message.data.sessionId !== this.sessionId) {
          this.failProtocol("바인딩된 패널에 다른 세션 오류가 전달되었습니다.", [
            message.data.sessionId,
          ]);
          return;
        }
        this.setState("error", message.data.message, "error");
        break;

      case "exited": {
        this.terminatedSessionIds.add(message.data.sessionId);
        if (this.sessionId && message.data.sessionId !== this.sessionId) {
          this.failProtocol("바인딩된 패널에 다른 세션 종료가 전달되었습니다.", [
            message.data.sessionId,
          ]);
          return;
        }
        if (!this.sessionId && !this.bindSession(message.data.sessionId)) return;
        try {
          this.outputSequencer.observeExit(message.data.lastSequence);
        } catch (error) {
          this.failProtocol(String(error), [message.data.sessionId]);
          return;
        }
        this.pendingExit = {
          sessionId: message.data.sessionId,
          exitCode: message.data.exitCode,
          lastSequence: message.data.lastSequence,
          epoch,
        };
        this.setState("stopping", "마지막 출력 정리 중…");
        if (this.outputSequencer.isFinalReady) this.scheduleExitBarrier();
        else this.scheduleExitGapTimeout();
        break;
      }
    }
  }

  private bindSession(targetSessionId: string) {
    if (this.disposed || this.terminalFailed) return false;
    if (this.sessionId) {
      if (this.sessionId === targetSessionId) return true;
      this.failProtocol("다른 세션 이벤트가 이 패널에 전달되었습니다.", [
        targetSessionId,
      ]);
      return false;
    }
    if (this.unboundSessionId && this.unboundSessionId !== targetSessionId) {
      this.failProtocol("바인딩 전 출력 세션과 시작 세션이 다릅니다.", [
        this.unboundSessionId,
        targetSessionId,
      ]);
      return false;
    }
    if (!this.workspace.claimSession(targetSessionId, this.id)) {
      this.failProtocol("중복된 세션 ID를 거부했습니다.", [targetSessionId]);
      return false;
    }
    this.sessionId = targetSessionId;
    return this.flushUnboundOutput(targetSessionId);
  }

  private bufferUnboundOutput(batch: OutputBatch) {
    if (this.unboundSessionId && this.unboundSessionId !== batch.sessionId) {
      this.failProtocol("바인딩 전 출력에 둘 이상의 세션 ID가 포함되었습니다.", [
        this.unboundSessionId,
        batch.sessionId,
      ]);
      return;
    }

    const byteLength = outputEncoder.encode(batch.data).byteLength;
    if (
      this.unboundOutput.length + 1 > UNBOUND_OUTPUT_MAX_BATCHES ||
      this.unboundOutputBytes + byteLength > UNBOUND_OUTPUT_MAX_BYTES
    ) {
      this.failProtocol("바인딩 전 출력 버퍼 상한을 초과했습니다.", [batch.sessionId]);
      return;
    }

    if (!this.unboundSessionId) {
      this.unboundSessionId = batch.sessionId;
      const epoch = this.lifecycleEpoch;
      this.unboundOutputTimer = window.setTimeout(() => {
        if (
          !this.disposed &&
          epoch === this.lifecycleEpoch &&
          !this.sessionId &&
          this.unboundSessionId === batch.sessionId
        ) {
          this.failProtocol("바인딩 전 출력 대기 시간이 초과되었습니다.", [batch.sessionId]);
        }
      }, UNBOUND_OUTPUT_MAX_AGE_MS);
    }
    this.unboundOutput.push(batch);
    this.unboundOutputBytes += byteLength;
  }

  private flushUnboundOutput(targetSessionId: string) {
    window.clearTimeout(this.unboundOutputTimer);
    if (this.unboundSessionId && this.unboundSessionId !== targetSessionId) {
      this.failProtocol("다른 세션의 바인딩 전 출력을 거부했습니다.", [
        this.unboundSessionId,
        targetSessionId,
      ]);
      return false;
    }
    const buffered = this.unboundOutput.splice(0);
    this.unboundSessionId = null;
    this.unboundOutputBytes = 0;
    this.unboundOutputTimer = 0;
    for (const batch of buffered) {
      if (!this.acceptOutput(batch)) return false;
    }
    return true;
  }

  private acceptOutput(batch: OutputBatch) {
    let ready: OutputBatch[];
    try {
      ready = this.outputSequencer.accept(batch);
    } catch (error) {
      this.failProtocol(String(error), [batch.sessionId]);
      return false;
    }

    for (const next of ready) {
      this.renderQueue = this.renderQueue
        .then(() => this.renderOutput(next))
        .catch((error) => {
          this.failTerminal(`출력 렌더링 실패: ${String(error)}`, [next.sessionId]);
        });
    }
    return true;
  }

  private async renderOutput(batch: OutputBatch) {
    if (this.disposed || this.terminalFailed) return;
    const shouldFollow = this.canAutoFollow() && this.isAtBottom();
    const writeEpoch = this.interactionEpoch;

    await new Promise<void>((resolve) => {
      this.terminal.write(batch.data, () => {
        if (
          !this.disposed &&
          !this.terminalFailed &&
          shouldFollow &&
          writeEpoch === this.interactionEpoch &&
          this.canAutoFollow()
        ) {
          this.terminal.scrollToBottom();
        }
        resolve();
      });
    });

    if (this.disposed || this.terminalFailed) return;
    let sequenceToAck: number | null;
    try {
      sequenceToAck = this.ackPolicy.noteRendered(batch.sequence);
    } catch (error) {
      this.failProtocol(String(error), [batch.sessionId]);
      return;
    }
    if (sequenceToAck !== null) {
      void this.sendCumulativeAck(batch.sessionId, sequenceToAck);
    }
    this.scheduleSettledFollow(shouldFollow, writeEpoch);
  }

  private async sendCumulativeAck(targetSessionId: string, sequence: number) {
    let lastError: unknown = new Error("ACK failed");
    for (let attempt = 0; attempt < ACK_MAX_ATTEMPTS; attempt += 1) {
      if (this.disposed || this.terminalFailed) return;
      try {
        await invoke("ack_terminal_output", {
          sessionId: targetSessionId,
          sequence,
        });
        if (this.disposed || this.terminalFailed) return;
        const next = this.ackPolicy.complete(sequence);
        if (next !== null) void this.sendCumulativeAck(targetSessionId, next);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < ACK_RETRY_DELAYS_MS.length) {
          await delay(ACK_RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    this.failTerminal(
      `출력 ACK ${ACK_MAX_ATTEMPTS}회 실패: ${String(lastError)}`,
      [targetSessionId],
    );
  }

  private queueInput(input: TerminalInput) {
    const commit = this.reserveInputSlot();
    commit?.(input);
  }

  private reserveInputSlot() {
    const targetSession = this.sessionId;
    if (
      !targetSession ||
      this.paneState !== "running" ||
      this.disposed ||
      this.terminalFailed
    ) {
      return null;
    }
    const epoch = this.lifecycleEpoch;
    let resolveInput: (input: TerminalInput | null) => void = () => undefined;
    const inputReady = new Promise<TerminalInput | null>((resolve) => {
      resolveInput = resolve;
    });
    let committed = false;
    this.inputQueue = this.inputQueue
      .then(async () => {
        const input = await inputReady;
        if (!input || input.data.length === 0) return;
        if (
          this.disposed ||
          this.terminalFailed ||
          epoch !== this.lifecycleEpoch ||
          this.sessionId !== targetSession
        ) {
          return;
        }
        if (input.kind === "text") {
          await invoke("write_terminal", {
            sessionId: targetSession,
            data: input.data,
          });
        } else {
          await invoke("write_terminal_bytes", {
            sessionId: targetSession,
            data: input.data,
          });
        }
      })
      .catch((error) => {
        if (!this.disposed && this.sessionId === targetSession) {
          this.setStatusOnly(`입력 전송 실패: ${String(error)}`, "error");
        }
      });
    return (input: TerminalInput | null) => {
      if (committed) return;
      committed = true;
      resolveInput(input);
    };
  }

  private queueCurrentSize() {
    const targetSession = this.sessionId;
    if (!targetSession || this.paneState !== "running" || this.disposed) return;
    this.latestResize = {
      sessionId: targetSession,
      columns: Math.max(2, this.terminal.cols),
      rows: Math.max(1, this.terminal.rows),
    };
    if (!this.resizeDrainRunning) void this.drainResizeQueue();
  }

  private async drainResizeQueue() {
    this.resizeDrainRunning = true;
    try {
      while (!this.disposed && this.latestResize) {
        const resize = this.latestResize;
        this.latestResize = null;
        if (this.sessionId !== resize.sessionId) continue;
        try {
          await invoke("resize_terminal", {
            sessionId: resize.sessionId,
            columns: resize.columns,
            rows: resize.rows,
          });
        } catch (error) {
          if (!this.disposed && this.sessionId === resize.sessionId) {
            this.setStatusOnly(`크기 변경 실패: ${String(error)}`, "error");
          }
        }
      }
    } finally {
      this.resizeDrainRunning = false;
      if (!this.disposed && this.latestResize) void this.drainResizeQueue();
    }
  }

  private fitTerminal() {
    if (this.disposed || this.viewport.clientWidth < 2 || this.viewport.clientHeight < 2) return;
    try {
      this.fitAddon.fit();
    } catch {
      // A pane may be between grid layouts while ResizeObserver is running.
    }
  }

  private isAtBottom() {
    const buffer = this.terminal.buffer.active;
    return buffer.viewportY === buffer.baseY;
  }

  private canAutoFollow() {
    return (
      !this.userBrowsingScrollback &&
      !this.selectionGestureActive &&
      !this.terminal.hasSelection()
    );
  }

  private invalidatePendingFollow() {
    this.interactionEpoch += 1;
    window.clearTimeout(this.outputSettledTimer);
  }

  private pauseAutoFollow() {
    this.userBrowsingScrollback = true;
    this.invalidatePendingFollow();
  }

  private resumeAutoFollowForUserIntent() {
    this.userBrowsingScrollback = false;
    this.selectionGestureActive = false;
    if (this.terminal.hasSelection()) this.terminal.clearSelection();
    this.invalidatePendingFollow();
    this.terminal.scrollToBottom();
  }

  private scheduleSettledFollow(shouldFollow: boolean, writeEpoch: number) {
    window.clearTimeout(this.outputSettledTimer);
    if (!shouldFollow || this.disposed) return;
    this.outputSettledTimer = window.setTimeout(() => {
      this.terminal.write("", () => {
        if (
          !this.disposed &&
          writeEpoch === this.interactionEpoch &&
          this.canAutoFollow()
        ) {
          this.terminal.scrollToBottom();
        }
      });
    }, OUTPUT_SETTLED_DELAY_MS);
  }

  private async copySelection() {
    const text = this.terminal.getSelection();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      this.setStatusOnly(`복사 실패: ${String(error)}`, "error");
      return false;
    }
  }

  private pasteClipboard() {
    this.resumeAutoFollowForUserIntent();
    const commit = this.reserveInputSlot();
    if (!commit) return;

    this.clipboardQueue = this.clipboardQueue
      .then(async () => {
        try {
          commit(await this.readClipboardInput());
        } catch (error) {
          commit(null);
          throw error;
        }
      })
      .catch((error) => {
        if (!this.disposed) this.setStatusOnly(`붙여넣기 실패: ${String(error)}`, "error");
      });
  }

  private async readClipboardInput(): Promise<TerminalInput | null> {
    let imageDetected = false;
    if (typeof navigator.clipboard.read === "function") {
      try {
        const items = await navigator.clipboard.read();
        imageDetected = clipboardItemsContainImage(items);
      } catch {
        // WebView clipboard item access can be unavailable even when readText works.
      }
    }

    if (imageDetected) {
      // Codex consumes Ctrl+V as its image-paste action. Grok needs ESC v, but
      // process-aware Codex/Grok routing is intentionally deferred to Phase 5.
      return { kind: "text", data: "\u0016" };
    }

    const text = await navigator.clipboard.readText();
    if (!text) return null;
    return {
      kind: "text",
      data: prepareTerminalPaste(text, this.terminal.modes.bracketedPasteMode),
    };
  }

  private scheduleExitBarrier() {
    const exit = this.pendingExit;
    if (!exit || !this.outputSequencer.isFinalReady) return;
    window.clearTimeout(this.exitGapTimer);
    const barrierVersion = ++this.exitBarrierVersion;
    this.renderQueue = this.renderQueue
      .then(() => nextAnimationFrame())
      .then(() => {
        if (
          this.disposed ||
          this.terminalFailed ||
          barrierVersion !== this.exitBarrierVersion ||
          this.pendingExit !== exit ||
          exit.epoch !== this.lifecycleEpoch ||
          !this.outputSequencer.isFinalReady
        ) {
          return;
        }
        this.pendingExit = null;
        this.workspace.releaseSession(exit.sessionId, this.id);
        if (this.sessionId === exit.sessionId) this.sessionId = null;
        this.setState("exited", `종료됨 · code ${exit.exitCode ?? "?"}`);
      })
      .catch((error) => {
        this.failTerminal(`종료 렌더 장벽 실패: ${String(error)}`, [exit.sessionId]);
      });
  }

  private scheduleExitGapTimeout() {
    window.clearTimeout(this.exitGapTimer);
    const exit = this.pendingExit;
    if (!exit) return;
    this.exitGapTimer = window.setTimeout(() => {
      if (
        this.disposed ||
        this.terminalFailed ||
        this.pendingExit !== exit ||
        this.outputSequencer.isFinalReady
      ) {
        return;
      }
      this.failProtocol(
        `최종 출력 sequence gap timeout: ${this.outputSequencer.describeFinalGap()}`,
        [exit.sessionId],
      );
    }, EXIT_GAP_TIMEOUT_MS);
  }

  private failProtocol(message: string, sessionIds: Iterable<string>) {
    this.failTerminal(`터미널 프로토콜 오류: ${message}`, sessionIds);
  }

  private failTerminal(message: string, sessionIds: Iterable<string>) {
    const sessionsToStop = new Set(sessionIds);
    if (this.sessionId) sessionsToStop.add(this.sessionId);
    if (this.unboundSessionId) sessionsToStop.add(this.unboundSessionId);
    if (this.disposed) return;
    if (this.terminalFailed) {
      for (const sessionId of sessionsToStop) void stopBackendSession(sessionId);
      return;
    }

    this.terminalFailed = true;
    this.startAbortController.abort();
    this.lifecycleEpoch += 1;
    this.exitBarrierVersion += 1;
    window.clearTimeout(this.exitGapTimer);
    window.clearTimeout(this.unboundOutputTimer);
    this.pendingExit = null;
    if (this.eventChannel) this.eventChannel.onmessage = () => undefined;
    if (this.sessionId) this.workspace.releaseSession(this.sessionId, this.id);
    this.sessionId = null;
    this.unboundSessionId = null;
    this.unboundOutput.length = 0;
    this.unboundOutputBytes = 0;
    this.setState("error", message, "error");
    for (const sessionId of sessionsToStop) void stopBackendSession(sessionId);
  }

  private setState(state: PaneState, message: string, tone: StatusTone = "normal") {
    this.paneState = state;
    this.element.dataset.state = state;
    this.setStatusOnly(message, tone);
  }

  private setStatusOnly(message: string, tone: StatusTone) {
    this.statusMessage = message;
    this.statusTone = tone;
    this.stateLabel.textContent = message;
    this.stateLabel.title = message;
    this.workspace.onPaneStatusChanged(this.id);
  }

  private beginTitleEdit() {
    if (this.disposed || !this.catalogWritable) return;
    this.titleEditor.value = this.title;
    this.titleElement.hidden = true;
    this.titleEditor.hidden = false;
    this.titleEditor.focus();
    this.titleEditor.select();
  }

  private commitTitleEdit() {
    const title = this.titleEditor.value.trim();
    this.titleEditor.hidden = true;
    this.titleElement.hidden = false;
    if (!title || title === this.title) return;
    this.workspace.renamePane(this.id, title);
  }

  private cancelTitleEdit() {
    this.titleEditor.hidden = true;
    this.titleElement.hidden = false;
    this.titleEditor.value = this.title;
    this.terminal.focus();
  }
}

class TerminalWorkspace {
  private readonly panes = new Map<string, TerminalPane>();
  private readonly sessionOwners = new Map<string, string>();
  private readonly scheduler = new StartScheduler();
  private readonly restoredProjects = new Set<string>();
  private activePaneId: string | null = null;
  private activeProjectId: string | null = null;
  private workspaceView: "empty" | "terminals" | "browser" = "empty";
  private catalogWritable = false;
  private disposed = false;
  private stopBarrier: Promise<void> = Promise.resolve();
  private readonly onAppPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".terminal-pane")) return;
    this.clearActivePane();
  };

  constructor(
    private readonly app: HTMLElement,
    private readonly terminalSurface: HTMLElement,
    private readonly addButton: HTMLButtonElement,
    private readonly closeActiveButton: HTMLButtonElement,
    private readonly countElement: HTMLElement,
    private readonly statusElement: HTMLElement,
    private readonly onPaneClosedCallback: (projectId: string, paneId: string) => void,
    private readonly onPaneRenamedCallback: (
      projectId: string,
      paneId: string,
      title: string,
    ) => void,
  ) {
    this.terminalSurface.dataset.empty = "true";
    this.app.addEventListener("pointerdown", this.onAppPointerDown);
    this.closeActiveButton.addEventListener("click", () => {
      if (this.activePaneId) this.closePane(this.activePaneId);
    });
  }

  addPane(projectId: string, savedState: SavedTerminalState, focus = true) {
    if (this.disposed || !this.catalogWritable) return null;
    const existing = this.panes.get(paneRuntimeId(projectId, savedState.Id));
    if (existing) return existing;
    const projectPaneCount = [...this.panes.values()].filter(
      (pane) => pane.projectId === projectId,
    ).length;
    if (projectPaneCount >= MAX_PROJECT_PANES) {
      this.setFooterStatus(
        `PowerShell은 프로젝트마다 최대 ${MAX_PROJECT_PANES}개까지 열 수 있습니다.`,
        "error",
      );
      return null;
    }
    if (this.panes.size >= MAX_PANES) {
      this.setFooterStatus(
        `동시에 실행할 수 있는 PowerShell은 최대 ${MAX_PANES}개입니다.`,
        "error",
      );
      return null;
    }

    const pane = new TerminalPane(this, this.scheduler, projectId, savedState);
    pane.setCatalogWritable(this.catalogWritable);
    this.panes.set(pane.id, pane);
    pane.element.hidden = projectId !== this.activeProjectId;
    this.terminalSurface.append(pane.element);
    if (projectId === this.activeProjectId && focus) this.activatePane(pane.id, false);
    this.updateLayout();
    void pane.startAfter(this.stopBarrier);
    if (
      focus &&
      this.workspaceView === "terminals" &&
      projectId === this.activeProjectId
    ) {
      requestAnimationFrame(() => pane.focus());
    }
    return pane;
  }

  restoreCapacity(project: WorkspaceProject) {
    const incoming = this.restoredProjects.has(project.Id) ? 0 : project.Terminals.length;
    return evaluateRestoreCapacity(this.panes.size, incoming, MAX_PANES);
  }

  showProject(project: WorkspaceProject) {
    if (this.disposed || !this.catalogWritable) return false;
    const capacity = this.restoreCapacity(project);
    if (!capacity.allowed) {
      this.setFooterStatus(
        `${project.Name}을 열려면 PowerShell ${capacity.incoming}개 슬롯이 필요하지만 ` +
          `${capacity.available}개만 남았습니다. 다른 프로젝트 탭을 닫고 다시 시도하세요.`,
        "error",
      );
      return false;
    }
    const projectChanged = this.activeProjectId !== project.Id;
    this.activeProjectId = project.Id;
    for (const pane of this.panes.values()) {
      pane.element.hidden = pane.projectId !== project.Id;
      pane.setActive(false);
    }

    if (!this.restoredProjects.has(project.Id)) {
      for (const terminal of project.Terminals) {
        if (!this.addPane(project.Id, terminal, false)) {
          // Capacity was checked before any pane was created. A different failure
          // rolls the whole runtime project back instead of leaving a partial restore.
          void this.unloadProject(project.Id);
          this.setFooterStatus(`${project.Name} PowerShell 복원을 완료하지 못했습니다.`, "error");
          return false;
        }
      }
      this.restoredProjects.add(project.Id);
    }

    const visible = this.visiblePanes();
    const prior = this.activePaneId ? this.panes.get(this.activePaneId) : null;
    this.activePaneId =
      !projectChanged && prior?.projectId === project.Id ? prior.id : null;
    for (const pane of visible) pane.setActive(pane.id === this.activePaneId);
    if (this.workspaceView !== "browser") {
      this.workspaceView = "terminals";
      this.app.dataset.workspaceView = "terminals";
    }
    this.updateLayout();
    this.renderActiveStatus();
    return true;
  }

  showEmptyView() {
    if (this.disposed) return;
    this.activeProjectId = null;
    this.activePaneId = null;
    for (const pane of this.panes.values()) {
      pane.element.hidden = true;
      pane.setActive(false);
    }
    if (this.workspaceView !== "browser") {
      this.workspaceView = "empty";
      this.app.dataset.workspaceView = "empty";
    }
    this.updateLayout();
    this.setFooterStatus("왼쪽에서 프로젝트를 선택하세요.");
  }

  setCatalogWritable(writable: boolean) {
    if (this.disposed) return;
    this.catalogWritable = writable;
    for (const pane of this.panes.values()) pane.setCatalogWritable(writable);
    this.updateLayout();
  }

  clearActivePane() {
    if (this.disposed) return;
    if (this.activePaneId === null) return;
    this.activePaneId = null;
    for (const pane of this.visiblePanes()) pane.setActive(false);
    this.closeActiveButton.disabled = true;
    this.renderActiveStatus();
  }

  async unloadProject(projectId: string) {
    if (this.disposed) return;
    const targets = [...this.panes.values()].filter(
      (pane) => pane.projectId === projectId,
    );
    for (const pane of targets) {
      this.panes.delete(pane.id);
      pane.element.remove();
    }
    this.restoredProjects.delete(projectId);
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
      this.activePaneId = null;
    } else if (targets.some((pane) => pane.id === this.activePaneId)) {
      this.activePaneId = null;
    }
    const stops = Promise.all(targets.map((pane) => pane.dispose())).then(
      () => undefined,
    );
    const barrier = this.appendStopBarrier(stops);
    this.updateLayout();
    this.renderActiveStatus();
    await barrier;
  }

  closePane(paneId: string) {
    if (!this.catalogWritable) return;
    const pane = this.panes.get(paneId);
    if (!pane) return;

    const orderedIds = this.visiblePanes().map((item) => item.id);
    const removedIndex = orderedIds.indexOf(paneId);
    this.panes.delete(paneId);
    this.appendStopBarrier(pane.dispose());
    pane.element.remove();

    if (this.activePaneId === paneId) {
      const remainingIds = this.visiblePanes().map((item) => item.id);
      this.activePaneId =
        remainingIds[Math.min(Math.max(0, removedIndex), remainingIds.length - 1)] ?? null;
    }
    for (const item of this.visiblePanes()) {
      item.setActive(item.id === this.activePaneId);
    }
    this.onPaneClosedCallback(pane.projectId, pane.terminalId);
    this.updateLayout();
    this.renderActiveStatus();
    if (this.workspaceView === "terminals" && this.activePaneId) {
      requestAnimationFrame(() => this.panes.get(this.activePaneId ?? "")?.focus());
    }
  }

  activatePane(paneId: string, suppressFocus: boolean) {
    const selected = this.panes.get(paneId);
    if (!selected || selected.projectId !== this.activeProjectId || selected.element.hidden) {
      return;
    }
    this.activePaneId = paneId;
    for (const pane of this.visiblePanes()) pane.setActive(pane.id === paneId);
    this.closeActiveButton.disabled = !this.catalogWritable;
    this.renderActiveStatus();
    if (!suppressFocus && this.workspaceView === "terminals") {
      this.panes.get(paneId)?.focus();
    }
  }

  renamePane(paneId: string, title: string) {
    if (!this.catalogWritable) return;
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.setTitle(title);
    this.onPaneRenamedCallback(pane.projectId, pane.terminalId, title);
    this.renderActiveStatus();
  }

  claimSession(sessionId: string, paneId: string) {
    const owner = this.sessionOwners.get(sessionId);
    if (owner && owner !== paneId) return false;
    this.sessionOwners.set(sessionId, paneId);
    return true;
  }

  releaseSession(sessionId: string, paneId: string) {
    if (this.sessionOwners.get(sessionId) === paneId) {
      this.sessionOwners.delete(sessionId);
    }
  }

  onPaneStatusChanged(paneId: string) {
    if (this.activePaneId === paneId && this.workspaceView === "terminals") {
      this.renderActiveStatus();
    }
  }

  showBrowserView() {
    this.workspaceView = "browser";
    this.app.dataset.workspaceView = "browser";
    this.closeActiveButton.disabled = true;
  }

  showTerminalView() {
    this.workspaceView = this.activeProjectId ? "terminals" : "empty";
    this.app.dataset.workspaceView = this.workspaceView;
    this.closeActiveButton.disabled =
      !this.catalogWritable || this.activePaneId === null;
    this.renderActiveStatus();
    requestAnimationFrame(() => {
      for (const pane of this.visiblePanes()) pane.scheduleFit(0);
      this.panes.get(this.activePaneId ?? "")?.focus();
    });
  }

  setFooterStatus(message: string, tone: StatusTone = "normal") {
    this.statusElement.textContent = message;
    this.statusElement.dataset.tone = tone;
  }

  async dispose() {
    if (this.disposed) {
      await this.stopBarrier;
      return;
    }
    this.disposed = true;
    this.catalogWritable = false;
    this.app.removeEventListener("pointerdown", this.onAppPointerDown);
    const stops = Promise.all(
      [...this.panes.values()].map((pane) => pane.dispose()),
    ).then(() => undefined);
    this.panes.clear();
    this.sessionOwners.clear();
    this.restoredProjects.clear();
    await this.appendStopBarrier(stops);
  }

  private updateLayout() {
    const visible = this.visiblePanes();
    const { columns, rows } = layoutFor(visible.length);
    this.terminalSurface.style.setProperty("--grid-columns", String(columns));
    this.terminalSurface.style.setProperty("--grid-rows", String(rows));
    this.terminalSurface.dataset.empty = String(visible.length === 0);
    this.countElement.textContent = `${visible.length} / ${MAX_PROJECT_PANES}`;
    this.addButton.disabled =
      !this.catalogWritable ||
      this.activeProjectId === null ||
      visible.length >= MAX_PROJECT_PANES ||
      this.panes.size >= MAX_PANES;
    this.closeActiveButton.disabled =
      !this.catalogWritable ||
      this.workspaceView === "browser" ||
      this.activePaneId === null;
    requestAnimationFrame(() => {
      for (const pane of visible) pane.scheduleFit(0);
    });
  }

  private renderActiveStatus() {
    if (this.workspaceView === "browser") return;
    if (this.workspaceView === "empty") {
      this.closeActiveButton.disabled = true;
      return;
    }
    const pane = this.activePaneId ? this.panes.get(this.activePaneId) : null;
    if (!pane) {
      this.closeActiveButton.disabled = true;
      this.setFooterStatus(
        this.visiblePanes().length > 0
          ? "상태를 볼 PowerShell을 선택하세요."
          : "＋ PowerShell을 눌러 새 터미널을 여세요.",
      );
      return;
    }
    const status = pane.status;
    this.setFooterStatus(`${pane.title} · ${status.message}`, status.tone);
  }

  private visiblePanes() {
    if (!this.activeProjectId) return [];
    return [...this.panes.values()].filter(
      (pane) => pane.projectId === this.activeProjectId,
    );
  }

  private appendStopBarrier(stop: Promise<void>) {
    const barrier = Promise.all([this.stopBarrier, stop]).then(() => undefined);
    this.stopBarrier = barrier.catch(() => undefined);
    return barrier;
  }
}

class BrowserController {
  private state: BrowserState = "closed";
  private webview: Webview | null = null;
  private label: string | null = null;
  private generation = 0;
  private boundsSyncPending = false;
  private shuttingDown = false;
  private boundsSyncQueue: Promise<void> = Promise.resolve();
  private activeOperation: Promise<void> = Promise.resolve();
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly workspace: TerminalWorkspace,
    private readonly surface: HTMLElement,
    private readonly button: HTMLButtonElement,
  ) {
    this.button.addEventListener("click", () => {
      const operation = this.toggle();
      this.activeOperation = operation;
      void operation.catch((error) => {
        this.workspace.setFooterStatus(String(error), "error");
      });
    });
    this.resizeObserver = new ResizeObserver(() => this.scheduleBoundsSync());
    this.resizeObserver.observe(this.surface);
    window.addEventListener("resize", () => this.scheduleBoundsSync());
  }

  async toggle() {
    if (this.shuttingDown) return;
    if (this.state === "opening" || this.state === "closing") return;
    if (this.state === "open") await this.close();
    else await this.open();
  }

  beginShutdown() {
    this.shuttingDown = true;
    this.button.disabled = true;
  }

  async dispose() {
    this.shuttingDown = true;
    this.generation += 1;
    this.resizeObserver.disconnect();
    await this.activeOperation.catch(() => undefined);
    const current = this.webview;
    this.webview = null;
    this.label = null;
    this.state = "closed";
    await this.boundsSyncQueue.catch(() => undefined);
    if (current) {
      await current.hide().catch(() => undefined);
      await current.close().catch(() => undefined);
    }
  }

  private async open() {
    const generation = ++this.generation;
    const label = `phase2-browser-${Date.now()}-${generation}`;
    this.state = "opening";
    this.label = label;
    this.button.disabled = true;
    this.button.textContent = "브라우저 여는 중…";
    this.workspace.showBrowserView();
    this.workspace.setFooterStatus("격리된 child WebView를 준비하는 중…");
    let webview: Webview | null = null;
    let removeCreatedListener: () => void = () => undefined;
    let removeErrorListener: () => void = () => undefined;
    try {
      await nextAnimationFrame();
      const bounds = this.surface.getBoundingClientRect();
      webview = new Webview(getCurrentWindow(), label, {
        url: "https://example.com",
        x: Math.round(bounds.left),
        y: Math.round(bounds.top),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
        focus: true,
      });
      this.webview = webview;

      let markCreated: () => void = () => undefined;
      let markFailed: (error: Error) => void = () => undefined;
      const creationEvent = new Promise<void>((resolve, reject) => {
        markCreated = resolve;
        markFailed = reject;
      });
      [removeCreatedListener, removeErrorListener] = await Promise.all([
        webview.once("tauri://created", markCreated),
        webview.once<string>("tauri://error", (event) => {
          markFailed(new Error(String(event.payload)));
        }),
      ]);
      const missedEventFallback = delay(250).then(() => waitForWebview(label, 5_750));
      await Promise.race([creationEvent, missedEventFallback]);
      if (
        generation !== this.generation ||
        this.webview !== webview ||
        this.label !== label
      ) {
        await webview.close().catch(() => undefined);
        return;
      }

      this.state = "open";
      this.button.textContent = "브라우저 닫기";
      await this.syncBounds(generation, webview);
      this.workspace.setFooterStatus(
        "브라우저 PoC · 터미널 세션은 뒤에서 계속 실행 중",
      );
    } catch (error) {
      if (generation === this.generation) {
        this.webview = null;
        this.label = null;
        this.state = "closed";
        this.button.textContent = "브라우저 PoC";
        this.workspace.showTerminalView();
      }
      if (webview) {
        await webview.hide().catch(() => undefined);
        await webview.close().catch(() => undefined);
      }
      throw new Error(`브라우저 생성 실패: ${String(error)}`);
    } finally {
      removeCreatedListener();
      removeErrorListener();
      if (generation === this.generation && !this.shuttingDown) {
        this.button.disabled = false;
      }
    }
  }

  private async close() {
    const webview = this.webview;
    if (!webview) {
      this.finishClosedState();
      return;
    }

    const generation = ++this.generation;
    this.state = "closing";
    this.button.disabled = true;
    this.button.textContent = "브라우저 닫는 중…";
    try {
      // A native child WebView must be hidden before terminal DOM is revealed.
      await webview.hide();
      if (generation !== this.generation) return;
      this.workspace.showTerminalView();
      await webview.close();
      if (generation === this.generation) this.finishClosedState();
    } catch (error) {
      const stillExists = this.label ? await Webview.getByLabel(this.label) : null;
      if (!stillExists) {
        this.finishClosedState();
        return;
      }
      this.state = "open";
      this.webview = stillExists;
      this.button.textContent = "브라우저 닫기";
      this.workspace.showBrowserView();
      await stillExists.show().catch(() => undefined);
      throw new Error(`브라우저 종료 실패: ${String(error)}`);
    } finally {
      if (generation === this.generation && !this.shuttingDown) {
        this.button.disabled = false;
      }
    }
  }

  private finishClosedState() {
    this.webview = null;
    this.label = null;
    this.state = "closed";
    this.button.disabled = this.shuttingDown;
    this.button.textContent = "브라우저 PoC";
    this.workspace.showTerminalView();
  }

  private scheduleBoundsSync() {
    if (this.boundsSyncPending || this.state !== "open") return;
    this.boundsSyncPending = true;
    requestAnimationFrame(() => {
      this.boundsSyncPending = false;
      const generation = this.generation;
      const webview = this.webview;
      if (!webview || this.state !== "open") return;
      this.boundsSyncQueue = this.boundsSyncQueue
        .then(() => this.syncBounds(generation, webview))
        .catch((error) => {
          if (generation === this.generation && this.webview === webview) {
            this.workspace.setFooterStatus(`브라우저 배치 실패: ${String(error)}`, "error");
          }
        });
    });
  }

  private async syncBounds(generation: number, webview: Webview) {
    if (
      generation !== this.generation ||
      this.state !== "open" ||
      this.webview !== webview
    ) {
      return;
    }

    const bounds = this.surface.getBoundingClientRect();
    if (bounds.width < 2 || bounds.height < 2) {
      await webview.hide();
      return;
    }
    await webview.setPosition(
      new LogicalPosition(Math.round(bounds.left), Math.round(bounds.top)),
    );
    if (generation !== this.generation || this.webview !== webview) return;
    await webview.setSize(
      new LogicalSize(Math.round(bounds.width), Math.round(bounds.height)),
    );
    if (generation !== this.generation || this.webview !== webview) return;
    await webview.show();
  }
}

class ProjectCatalogAdapter {
  async load() {
    return normalizeProjectCatalogLoadResponse(
      await invoke<unknown>("load_project_catalog"),
    );
  }

  async save(catalog: ProjectCatalog) {
    await invoke("save_project_catalog", { catalog: cloneProjectCatalog(catalog) });
  }

  async recoverBackup() {
    return normalizeProjectCatalog(
      await invoke<unknown>("recover_project_catalog_backup"),
    );
  }
}

class Phase3Controller {
  private readonly adapter = new ProjectCatalogAdapter();
  private catalog: ProjectCatalog = { Projects: [], SelectedProjectId: null };
  private tabs: WorkspaceTabState = createInitialTabState(null, createLocalId);
  private saveQueue: Promise<void> = Promise.resolve();
  private saveFailure: unknown | null = null;
  private recoveryTask: Promise<void> | null = null;
  private initialized = false;
  private writable = false;
  private shuttingDown = false;
  private tabTransitionPending = false;
  private projectCreationPending = false;
  private terminalCreationPending = false;

  constructor(
    private readonly workspace: TerminalWorkspace,
    private readonly projectList: HTMLElement,
    private readonly projectCount: HTMLElement,
    private readonly tabList: HTMLElement,
    private readonly currentProject: HTMLElement,
    private readonly addTerminalButton: HTMLButtonElement,
    private readonly addTabButton: HTMLButtonElement,
    private readonly createProjectButton: HTMLButtonElement,
    private readonly recoverProjectButton: HTMLButtonElement,
    private readonly dialog: HTMLDialogElement,
    private readonly form: HTMLFormElement,
    private readonly nameInput: HTMLInputElement,
    private readonly pathInput: HTMLInputElement,
    private readonly formError: HTMLElement,
    private readonly cancelProjectButton: HTMLButtonElement,
  ) {
    this.addTerminalButton.addEventListener("click", () => void this.addTerminal());
    this.addTabButton.addEventListener("click", () => {
      if (!this.canMutateCatalog()) return;
      this.tabs = addBlankTab(this.tabs, createLocalId);
      this.renderAndActivate();
    });
    this.createProjectButton.addEventListener("click", () => {
      if (this.canMutateCatalog()) this.openProjectDialog();
    });
    this.recoverProjectButton.addEventListener("click", () => {
      const task = this.recoverProjectCatalog();
      this.recoveryTask = task;
      void task.finally(() => {
        if (this.recoveryTask === task) this.recoveryTask = null;
      });
    });
    this.cancelProjectButton.addEventListener("click", () => this.dialog.close());
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.createProject();
    });
    this.setWritable(false);
  }

  async initialize() {
    try {
      const loaded = await this.adapter.load();
      if (this.shuttingDown) return;
      this.catalog = loaded.catalog;
      this.initialized = true;
      if (loaded.recoveryRequired) {
        this.tabs = createInitialTabState(null, createLocalId);
        this.recoverProjectButton.hidden = false;
        this.recoverProjectButton.disabled = false;
        this.renderAndActivate(false);
        this.workspace.setFooterStatus(
          "정상 카탈로그 대신 검증된 백업을 찾았습니다. 백업 복구를 눌러 확인하세요.",
          "error",
        );
        return;
      }
      this.tabs = createInitialTabState(initialProject(this.catalog), createLocalId);
      this.setWritable(true);
      this.renderAndActivate(false);
      this.workspace.setFooterStatus("프로젝트를 불러왔습니다.");
    } catch (error) {
      if (this.shuttingDown) return;
      this.initialized = true;
      this.tabs = createInitialTabState(null, createLocalId);
      this.setWritable(false);
      this.renderAndActivate(false);
      this.workspace.setFooterStatus(
        `프로젝트 저장소를 불러오지 못해 읽기 전용으로 유지합니다: ${String(error)}`,
        "error",
      );
    }
  }

  onPaneClosed(projectId: string, paneId: string) {
    if (!this.canMutateCatalog(false)) return;
    try {
      this.catalog = removeTerminal(this.catalog, projectId, paneId);
      this.queueSave(this.catalog, "PowerShell 삭제 상태를 저장하지 못했습니다");
    } catch (error) {
      this.workspace.setFooterStatus(String(error), "error");
    }
  }

  onPaneRenamed(projectId: string, paneId: string, title: string) {
    if (!this.canMutateCatalog(false)) return;
    try {
      this.catalog = renameTerminal(this.catalog, projectId, paneId, title);
      this.queueSave(this.catalog, "PowerShell 이름을 저장하지 못했습니다");
    } catch (error) {
      this.workspace.setFooterStatus(String(error), "error");
    }
  }

  beginShutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.setWritable(false);
    this.recoverProjectButton.disabled = true;
    this.renderTabs();
    this.renderSidebar();
    this.workspace.setFooterStatus("프로젝트 상태를 저장한 뒤 종료하는 중…");
  }

  async flushSaves() {
    while (this.recoveryTask) {
      const recovery = this.recoveryTask;
      await recovery;
      if (this.recoveryTask === recovery) this.recoveryTask = null;
    }
    let observed: Promise<void>;
    do {
      observed = this.saveQueue;
      await observed;
    } while (observed !== this.saveQueue);
    if (this.saveFailure !== null) throw this.saveFailure;
  }

  private renderAndActivate(persistSelection = true) {
    this.renderTabs();
    this.activateCurrentTab(persistSelection);
    this.renderSidebar();
  }

  private renderTabs() {
    this.tabList.replaceChildren();
    const mutationEnabled = this.mutationsEnabled();
    for (const tab of this.tabs.tabs) {
      const element = document.createElement("div");
      element.className = "workspace-tab";
      element.dataset.active = String(tab.id === this.tabs.activeTabId);
      element.setAttribute("role", "tab");
      element.setAttribute("aria-selected", String(tab.id === this.tabs.activeTabId));
      element.setAttribute("aria-disabled", String(!mutationEnabled));
      element.tabIndex = mutationEnabled && tab.id === this.tabs.activeTabId ? 0 : -1;

      const kind = document.createElement("span");
      kind.className = "workspace-tab-kind";
      kind.textContent = tab.kind === "project" ? ">_" : "○";
      const title = document.createElement("span");
      title.className = "workspace-tab-title";
      title.textContent = tab.title;
      const close = document.createElement("button");
      close.className = "workspace-tab-close";
      close.type = "button";
      close.textContent = "×";
      close.title = `${tab.title} 탭 닫기`;
      close.setAttribute("aria-label", `${tab.title} 탭 닫기`);
      close.disabled = !mutationEnabled;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!this.canMutateCatalog()) return;
        void this.closeTab(tab.id, tab.projectId);
      });

      const select = () => {
        if (!this.canMutateCatalog()) return;
        this.tabs = selectWorkspaceTab(this.tabs, tab.id);
        this.renderAndActivate();
      };
      element.addEventListener("click", select);
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
      element.append(kind, title, close);
      this.tabList.append(element);
    }
  }

  private renderSidebar() {
    const activeTab = this.activeTab();
    const activeProjectId = activeTab?.kind === "project" ? activeTab.projectId : null;
    this.projectCount.textContent = String(this.catalog.Projects.length);
    this.projectList.replaceChildren();
    const mutationEnabled = this.mutationsEnabled();
    for (const project of this.catalog.Projects) {
      const button = document.createElement("button");
      button.className = "project-item";
      button.type = "button";
      button.disabled = !mutationEnabled;
      button.dataset.active = String(project.Id === activeProjectId);
      button.title = project.FolderPath;
      const name = document.createElement("strong");
      name.textContent = project.Name;
      const folder = document.createElement("small");
      folder.textContent = project.FolderPath;
      button.append(name, folder);
      button.addEventListener("click", () => this.openProject(project));
      this.projectList.append(button);
    }
  }

  private activateCurrentTab(persistSelection: boolean) {
    const tab = this.activeTab();
    if (tab?.kind === "project" && tab.projectId) {
      const project = this.catalog.Projects.find((item) => item.Id === tab.projectId);
      if (project) {
        if (!this.workspace.showProject(project)) return;
        this.currentProject.textContent = project.Name;
        if (
          persistSelection &&
          this.writable &&
          this.catalog.SelectedProjectId !== project.Id
        ) {
          this.catalog = { ...this.catalog, SelectedProjectId: project.Id };
          this.queueSave(this.catalog, "선택한 프로젝트를 저장하지 못했습니다");
        }
        return;
      }
    }

    this.currentProject.textContent = "프로젝트 없음";
    this.workspace.showEmptyView();
    if (persistSelection && this.writable && this.catalog.SelectedProjectId !== null) {
      this.catalog = { ...this.catalog, SelectedProjectId: null };
      this.queueSave(this.catalog, "빈 탭 상태를 저장하지 못했습니다");
    }
  }

  private activeTab() {
    return this.tabs.tabs.find((tab) => tab.id === this.tabs.activeTabId) ?? null;
  }

  private openProject(project: WorkspaceProject) {
    if (!this.canMutateCatalog()) return;
    const capacity = this.workspace.restoreCapacity(project);
    if (!capacity.allowed) {
      this.workspace.setFooterStatus(
        `${project.Name}을 열 공간이 부족합니다. 다른 프로젝트 탭을 닫아 ` +
          `PowerShell ${capacity.incoming - capacity.available}개 슬롯을 더 확보하세요.`,
        "error",
      );
      return;
    }
    this.tabs = openProjectTab(this.tabs, project, createLocalId);
    this.renderAndActivate();
  }

  private async closeTab(tabId: string, projectId: string | null) {
    if (!this.canMutateCatalog()) return;
    this.tabTransitionPending = true;
    const next = closeWorkspaceTab(this.tabs, tabId, createLocalId);
    this.tabs = next;
    const nextActive = next.tabs.find((tab) => tab.id === next.activeTabId) ?? null;
    const nextSelectedProjectId =
      nextActive?.kind === "project" ? nextActive.projectId : null;
    if (this.catalog.SelectedProjectId !== nextSelectedProjectId) {
      this.catalog = {
        ...this.catalog,
        SelectedProjectId: nextSelectedProjectId,
      };
      this.queueSave(this.catalog, "닫은 프로젝트 탭 상태를 저장하지 못했습니다");
    }
    this.refreshMutationControls(true);
    try {
      if (
        projectId &&
        !next.tabs.some((tab) => tab.kind === "project" && tab.projectId === projectId)
      ) {
        this.workspace.setFooterStatus("프로젝트 PowerShell을 정리하는 중…");
        await this.workspace.unloadProject(projectId);
      }
    } finally {
      this.tabTransitionPending = false;
      if (!this.shuttingDown) {
        this.refreshMutationControls(false);
        this.renderAndActivate();
      }
    }
  }

  private openProjectDialog() {
    this.form.reset();
    this.formError.textContent = "";
    this.dialog.showModal();
    requestAnimationFrame(() => this.nameInput.focus());
  }

  private async recoverProjectCatalog() {
    if (
      !this.initialized ||
      this.writable ||
      this.shuttingDown ||
      this.recoverProjectButton.hidden ||
      this.recoverProjectButton.disabled
    ) {
      return;
    }
    this.recoverProjectButton.disabled = true;
    this.workspace.setFooterStatus("검증된 프로젝트 백업을 복구하는 중…");
    try {
      const recovered = await this.adapter.recoverBackup();
      if (this.shuttingDown) return;
      this.catalog = recovered;
      this.tabs = createInitialTabState(initialProject(this.catalog), createLocalId);
      this.recoverProjectButton.hidden = true;
      this.setWritable(true);
      this.renderAndActivate(false);
      this.workspace.setFooterStatus("프로젝트 백업을 복구했습니다.");
    } catch (error) {
      if (this.shuttingDown) return;
      this.recoverProjectButton.disabled = false;
      this.workspace.setFooterStatus(
        `프로젝트 백업을 복구하지 못했습니다: ${errorMessage(error)}`,
        "error",
      );
    }
  }

  private async createProject() {
    if (!this.canMutateCatalog() || this.projectCreationPending) return;
    this.projectCreationPending = true;
    this.refreshMutationControls(true);
    this.formError.textContent = "";
    let draft: ReturnType<typeof validateProjectDraft>;
    try {
      draft = validateProjectDraft(this.nameInput.value, this.pathInput.value);
    } catch (error) {
      this.formError.textContent = errorMessage(error);
      this.projectCreationPending = false;
      this.refreshMutationControls(true);
      return;
    }

    const existing = findProjectByFolder(this.catalog.Projects, draft.folderPath);
    if (existing) {
      this.projectCreationPending = false;
      this.refreshMutationControls(true);
      this.dialog.close();
      this.openProject(existing);
      this.workspace.setFooterStatus("이미 등록된 폴더의 프로젝트를 열었습니다.");
      return;
    }

    const project: WorkspaceProject = {
      Id: createLocalId(),
      Name: uniqueProjectName(this.catalog.Projects, draft.name),
      FolderPath: draft.folderPath,
      Terminals: [],
      PaneWidthRatios: {},
    };
    const next: ProjectCatalog = {
      ...this.catalog,
      Projects: [...this.catalog.Projects, project],
      SelectedProjectId: project.Id,
    };
    const prior = this.catalog;
    this.catalog = next;
    try {
      await this.saveBeforeCommit(next);
      if (this.shuttingDown) return;
    } catch (error) {
      if (this.catalog === next) this.catalog = prior;
      const rollbackError = await this.persistRollback(prior);
      if (this.shuttingDown) return;
      const message =
        `프로젝트를 만들지 못했습니다: ${errorMessage(error)}` +
        (rollbackError
          ? ` · 이전 상태 재확인 실패: ${errorMessage(rollbackError)}`
          : "");
      this.formError.textContent = message;
      this.workspace.setFooterStatus(message, "error");
      this.projectCreationPending = false;
      this.refreshMutationControls(true);
      return;
    }

    this.projectCreationPending = false;
    this.refreshMutationControls(true);
    this.dialog.close();
    this.openProject(project);
  }

  private async addTerminal() {
    if (!this.canMutateCatalog() || this.terminalCreationPending) return;
    const tab = this.activeTab();
    if (tab?.kind !== "project" || !tab.projectId) return;
    const project = this.catalog.Projects.find((item) => item.Id === tab.projectId);
    if (!project) return;
    const terminal = createSavedTerminal(
      createLocalId(),
      nextTerminalName(project),
      project.FolderPath,
      new Date().toISOString(),
    );
    let next: ProjectCatalog | null = null;
    const prior = this.catalog;
    this.terminalCreationPending = true;
    this.refreshMutationControls(true);
    try {
      next = appendTerminal(this.catalog, project.Id, terminal);
      this.catalog = next;
      await this.saveBeforeCommit(next);
      if (this.shuttingDown) return;
    } catch (error) {
      if (next && this.catalog === next) this.catalog = prior;
      const rollbackError = next ? await this.persistRollback(prior) : null;
      if (this.shuttingDown) return;
      this.workspace.setFooterStatus(
        `PowerShell을 추가하지 못했습니다: ${errorMessage(error)}` +
          (rollbackError
            ? ` · 이전 상태 재확인 실패: ${errorMessage(rollbackError)}`
            : ""),
        "error",
      );
      this.terminalCreationPending = false;
      this.refreshMutationControls(true);
      return;
    }

    const activeTab = this.activeTab();
    const projectStillOpen = this.tabs.tabs.some(
      (item) => item.kind === "project" && item.projectId === project.Id,
    );
    const projectStillActive =
      activeTab?.kind === "project" && activeTab.projectId === project.Id;
    this.terminalCreationPending = false;
    this.refreshMutationControls(true);
    if (!projectStillOpen || !projectStillActive) {
      this.workspace.setFooterStatus(
        "프로젝트 탭 상태가 바뀌어 저장된 PowerShell을 실행하지 않았습니다.",
        "error",
      );
      return;
    }
    if (!this.workspace.addPane(project.Id, terminal, true)) {
      this.workspace.setFooterStatus(
        "PowerShell 상태는 저장했지만 실행 슬롯을 확보하지 못했습니다.",
        "error",
      );
    }
  }

  private queueSave(catalog: ProjectCatalog, context: string) {
    void this.enqueueSave(catalog).catch((error) => {
      this.workspace.setFooterStatus(`${context}: ${errorMessage(error)}`, "error");
    });
  }

  private saveBeforeCommit(catalog: ProjectCatalog) {
    return this.enqueueSave(catalog);
  }

  private async persistRollback(catalog: ProjectCatalog) {
    try {
      await this.enqueueSave(catalog);
      return null;
    } catch (error) {
      return error;
    }
  }

  private enqueueSave(catalog: ProjectCatalog) {
    const snapshot = cloneProjectCatalog(catalog);
    const operation = this.saveQueue.then(() => this.adapter.save(snapshot));
    this.saveQueue = operation.then(
      () => {
        this.saveFailure = null;
      },
      (error: unknown) => {
        this.saveFailure = error;
      },
    );
    return operation;
  }

  private setWritable(writable: boolean) {
    this.writable = writable;
    this.refreshMutationControls(false);
    if (!writable && this.dialog.open) this.dialog.close();
  }

  private refreshMutationControls(render: boolean) {
    const enabled = this.mutationsEnabled();
    this.createProjectButton.disabled = !enabled;
    this.addTabButton.disabled = !enabled;
    this.workspace.setCatalogWritable(enabled);
    if (render) {
      this.renderTabs();
      this.renderSidebar();
    }
  }

  private canMutateCatalog(report = true) {
    const allowed = this.mutationsEnabled();
    if (!allowed && report) {
      this.workspace.setFooterStatus(
        this.shuttingDown
          ? "종료를 준비하고 있어 변경할 수 없습니다."
          : "프로젝트 저장소가 준비되지 않아 변경할 수 없습니다.",
        "error",
      );
    }
    return allowed;
  }

  private mutationsEnabled() {
    return catalogMutationsAllowed({
      initialized: this.initialized,
      writable: this.writable,
      shuttingDown: this.shuttingDown,
      tabTransitionPending: this.tabTransitionPending,
      projectCreationPending: this.projectCreationPending,
      terminalCreationPending: this.terminalCreationPending,
    });
  }
}

async function stopBackendSession(sessionId: string) {
  await invoke("stop_terminal", { sessionId }).catch(() => undefined);
}

function isTerminalInputIntentKey(event: KeyboardEvent, hasSelection: boolean) {
  if (event.isComposing || event.keyCode === 229) return false;
  const key = event.key.toLowerCase();
  if (["control", "shift", "alt", "meta", "capslock", "numlock"].includes(key)) {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && key === "c" && hasSelection) return false;
  if (event.ctrlKey && key === "insert") return false;
  if (
    event.shiftKey &&
    ["pageup", "pagedown", "home", "end"].includes(key)
  ) {
    return false;
  }
  return true;
}

async function waitForWebview(label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Webview.getByLabel(label)) return;
    await delay(25);
  }
  throw new Error("child WebView 생성 시간이 초과되었습니다.");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function createLocalId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `pane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function paneRuntimeId(projectId: string, terminalId: string) {
  return `${projectId.length}:${projectId}${terminalId}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function requireButton(id: string): HTMLButtonElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button`);
  }
  return element;
}

function requireInput(id: string): HTMLInputElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`);
  return element;
}

function requireForm(id: string): HTMLFormElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLFormElement)) throw new Error(`#${id} is not a form`);
  return element;
}

function requireDialog(id: string): HTMLDialogElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLDialogElement)) throw new Error(`#${id} is not a dialog`);
  return element;
}

const app = requireElement("app");
const terminalSurface = requireElement("terminal-surface");
const browserSurface = requireElement("browser-surface");
const addButton = requireButton("add-terminal");
const closeActiveButton = requireButton("close-active-terminal");
const browserButton = requireButton("toggle-browser");
const sessionCount = requireElement("session-count");
const statusElement = requireElement("status");
const projectList = requireElement("project-list");
const projectCount = requireElement("project-count");
const tabList = requireElement("workspace-tab-list");
const currentProject = requireElement("current-project");
const addTabButton = requireButton("add-workspace-tab");
const createProjectButton = requireButton("create-project");
const recoverProjectButton = requireButton("recover-project-catalog");
const projectDialog = requireDialog("project-dialog");
const projectForm = requireForm("project-form");
const projectName = requireInput("project-name");
const projectPath = requireInput("project-path");
const projectFormError = requireElement("project-form-error");
const cancelProjectButton = requireButton("cancel-project");
const migrationUi = createPhase3BMigrationUI();

let controller: Phase3Controller | null = null;
const workspace = new TerminalWorkspace(
  app,
  terminalSurface,
  addButton,
  closeActiveButton,
  sessionCount,
  statusElement,
  (projectId, paneId) => controller?.onPaneClosed(projectId, paneId),
  (projectId, paneId, title) => controller?.onPaneRenamed(projectId, paneId, title),
);
const browser = new BrowserController(workspace, browserSurface, browserButton);
controller = new Phase3Controller(
  workspace,
  projectList,
  projectCount,
  tabList,
  currentProject,
  addButton,
  addTabButton,
  createProjectButton,
  recoverProjectButton,
  projectDialog,
  projectForm,
  projectName,
  projectPath,
  projectFormError,
  cancelProjectButton,
);

const initializationPromise = controller.initialize();
void initializationPromise;
const migrationInitializationPromise = migrationUi.initialize();
void migrationInitializationPromise;

const currentAppWindow = getCurrentWindow();
let closeBarrierRunning = false;
let forceCloseArmed = false;
void currentAppWindow.onCloseRequested(async (event) => {
  event.preventDefault();
  if (closeBarrierRunning) {
    if (forceCloseArmed) {
      void browser.dispose();
      await currentAppWindow.destroy();
    } else {
      workspace.setFooterStatus("저장과 종료 처리가 진행 중입니다. 잠시 기다려 주세요.");
    }
    return;
  }

  closeBarrierRunning = true;
  controller?.beginShutdown();
  browser.beginShutdown();
  try {
    await Promise.all([initializationPromise, migrationInitializationPromise]);
    await controller?.flushSaves();
    migrationUi.dispose();
    await browser.dispose();
    // Use one backend-owned barrier instead of twenty pane-local stop IPCs. It
    // rejects queued starts, waits until every spawned child belongs to a Job
    // Object, and then drains all active terminal process trees before destroy.
    await invoke("shutdown_terminal_engine");
    await currentAppWindow.destroy();
  } catch (error) {
    forceCloseArmed = true;
    workspace.setFooterStatus(
      `정상 종료를 완료하지 못했습니다. X를 다시 누르면 강제 종료합니다: ${errorMessage(error)}`,
      "error",
    );
  }
});

window.addEventListener("beforeunload", () => {
  if (closeBarrierRunning) return;
  migrationUi.dispose();
  void browser.dispose();
  void workspace.dispose();
});
