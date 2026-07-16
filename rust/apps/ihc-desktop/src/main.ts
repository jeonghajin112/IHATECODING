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
  MAX_WORKSPACE_TERMINALS as MAX_PROJECT_PANES,
  type WorkspaceProject,
  type WorkspaceTerminal,
} from "./phase3b-core";
import {
  computeHorizontalResize,
  evaluateWorkspaceRestoreCapacity,
  resolvePaneInsertionPreview,
  type PaneGeometry,
  type PaneInsertionTarget,
} from "./phase4-core";
import {
  createPhase4WorkspaceController,
  type Phase4WorkspaceController,
} from "./phase4-controller";
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
  private readonly resizeHandle: HTMLDivElement;
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
    savedState: WorkspaceTerminal,
  ) {
    this.terminalId = savedState.id;
    this.id = paneRuntimeId(projectId, savedState.id);
    this.projectId = projectId;
    this.title = savedState.name;
    this.startDirectory = savedState.startDirectory;

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
    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "terminal-resize-handle";
    this.resizeHandle.dataset.paneInteraction = "resize";
    this.resizeHandle.hidden = true;
    this.resizeHandle.tabIndex = -1;
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-orientation", "vertical");
    this.resizeHandle.setAttribute("aria-label", `${this.title} 너비 조절`);
    this.element.append(header, this.viewport, this.resizeHandle);

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
      void this.workspace.closePane(this.id);
    });
    this.titleElement.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.beginTitleEdit();
    });
    this.titleEditor.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.titleEditor.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        if (event.isComposing || event.keyCode === 229) return;
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
    header.addEventListener("pointerdown", (event) => {
      this.workspace.beginPaneDrag(event, this.id, header);
    });
    this.resizeHandle.addEventListener("pointerdown", (event) => {
      this.workspace.beginPaneResize(event, this.id, this.resizeHandle);
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
      }, this.startAbortController.signal, () =>
        this.workspace.startPriority(this.projectId),
      );
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
    this.resizeHandle.setAttribute("aria-label", `${title} 너비 조절`);
  }

  setResizeHandleEnabled(enabled: boolean) {
    this.resizeHandle.hidden = !enabled;
    this.resizeHandle.tabIndex = enabled ? 0 : -1;
  }

  setDragging(dragging: boolean) {
    this.element.dataset.dragging = String(dragging);
  }

  setCatalogWritable(writable: boolean) {
    this.catalogWritable = writable;
    this.closeButton.disabled = !writable;
    if (!writable && !this.titleEditor.hidden) this.cancelTitleEdit();
  }

  scheduleFit(delay = 35) {
    if (this.disposed || this.workspace.shouldDeferFit()) return;
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
    void this.workspace.renamePane(this.id, title);
  }

  private cancelTitleEdit() {
    this.titleEditor.hidden = true;
    this.titleElement.hidden = false;
    this.titleEditor.value = this.title;
    this.terminal.focus();
  }
}

type ActiveTerminalRow = {
  key: string;
  element: HTMLDivElement;
  paneIds: string[];
  ratios: number[];
  columns: number;
};

type PaneDragState = {
  paneId: string;
  projectId: string;
  pointerId: number;
  captureTarget: HTMLElement;
  originX: number;
  originY: number;
  latestX: number;
  latestY: number;
  started: boolean;
  geometry: PaneGeometry[];
  preview: PaneInsertionTarget | null;
  frame: number;
};

type PaneResizeState = {
  paneId: string;
  projectId: string;
  pointerId: number;
  captureTarget: HTMLElement;
  row: ActiveTerminalRow;
  dividerIndex: number;
  originX: number;
  latestX: number;
  rowLeft: number;
  totalWidth: number;
  gap: number;
  minPaneWidth: number;
  siblingEdges: number[];
  originalRatios: number[];
  previewRatios: number[];
  frame: number;
};

class TerminalWorkspace {
  private readonly panes = new Map<string, TerminalPane>();
  private readonly sessionOwners = new Map<string, string>();
  private readonly scheduler = new StartScheduler();
  private readonly restoredProjects = new Set<string>();
  private readonly projectOrders = new Map<string, string[]>();
  private readonly projectRatios = new Map<string, Record<string, number[]>>();
  private readonly activeRows = new Map<string, ActiveTerminalRow>();
  private readonly rowsHost = document.createElement("div");
  private readonly inactivePaneBin = document.createElement("div");
  private readonly interactionOverlay = document.createElement("div");
  private readonly insertionLine = document.createElement("div");
  private readonly snapGuide = document.createElement("div");
  private activePaneId: string | null = null;
  private activeProjectId: string | null = null;
  private workspaceView: "empty" | "terminals" | "browser" = "empty";
  private catalogWritable = false;
  private disposed = false;
  private dragState: PaneDragState | null = null;
  private resizeState: PaneResizeState | null = null;
  private stopBarrier: Promise<void> = Promise.resolve();
  private readonly onAppPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".terminal-pane, [data-pane-interaction]")
    ) {
      return;
    }
    this.clearActivePane();
  };
  private readonly onLayoutPointerMove = (event: PointerEvent) => {
    if (this.dragState?.pointerId === event.pointerId) {
      this.updatePaneDrag(event);
      return;
    }
    if (this.resizeState?.pointerId === event.pointerId) {
      this.updatePaneResize(event);
    }
  };
  private readonly onLayoutPointerUp = (event: PointerEvent) => {
    if (this.dragState?.pointerId === event.pointerId) {
      this.finishPaneDrag(false);
      return;
    }
    if (this.resizeState?.pointerId === event.pointerId) {
      this.finishPaneResize(false);
    }
  };
  private readonly onLayoutPointerCancel = (event: PointerEvent) => {
    if (
      this.dragState?.pointerId === event.pointerId ||
      this.resizeState?.pointerId === event.pointerId
    ) {
      this.cancelLayoutInteraction();
    }
  };
  private readonly onLayoutKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && (this.dragState || this.resizeState)) {
      event.preventDefault();
      this.cancelLayoutInteraction();
    }
  };
  private readonly onLayoutWindowBlur = () => this.cancelLayoutInteraction();

  constructor(
    private readonly app: HTMLElement,
    private readonly terminalSurface: HTMLElement,
    private readonly addButton: HTMLButtonElement,
    private readonly closeActiveButton: HTMLButtonElement,
    private readonly countElement: HTMLElement,
    private readonly statusElement: HTMLElement,
    private readonly onPaneClosedCallback: (
      projectId: string,
      paneId: string,
    ) => Promise<boolean>,
    private readonly onPaneRenamedCallback: (
      projectId: string,
      paneId: string,
      title: string,
    ) => Promise<boolean>,
    private readonly onPaneReorderedCallback: (
      projectId: string,
      paneId: string,
      target: Pick<PaneInsertionTarget, "beforePaneId">,
    ) => void,
    private readonly onPaneRatiosChangedCallback: (
      projectId: string,
      layoutKey: string,
      ratios: number[],
    ) => void,
  ) {
    this.rowsHost.className = "terminal-rows";
    this.inactivePaneBin.className = "inactive-pane-bin";
    this.inactivePaneBin.setAttribute("aria-hidden", "true");
    this.interactionOverlay.className = "pane-interaction-overlay";
    this.interactionOverlay.dataset.paneInteraction = "overlay";
    this.insertionLine.className = "pane-insertion-line";
    this.insertionLine.hidden = true;
    this.snapGuide.className = "pane-snap-guide";
    this.snapGuide.hidden = true;
    this.interactionOverlay.append(this.insertionLine, this.snapGuide);
    this.terminalSurface.append(
      this.rowsHost,
      this.inactivePaneBin,
      this.interactionOverlay,
    );
    this.terminalSurface.dataset.empty = "true";
    this.app.addEventListener("pointerdown", this.onAppPointerDown);
    window.addEventListener("pointermove", this.onLayoutPointerMove, true);
    window.addEventListener("pointerup", this.onLayoutPointerUp, true);
    window.addEventListener("pointercancel", this.onLayoutPointerCancel, true);
    window.addEventListener("keydown", this.onLayoutKeyDown, true);
    window.addEventListener("blur", this.onLayoutWindowBlur);
    this.closeActiveButton.addEventListener("click", () => {
      if (this.activePaneId) void this.closePane(this.activePaneId);
    });
  }

  addPane(projectId: string, savedState: WorkspaceTerminal, focus = true) {
    if (this.disposed) return null;
    const existing = this.panes.get(paneRuntimeId(projectId, savedState.id));
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
    const order = this.projectOrders.get(projectId) ?? [];
    if (!order.includes(pane.id)) this.projectOrders.set(projectId, [...order, pane.id]);
    pane.element.hidden = projectId !== this.activeProjectId;
    this.inactivePaneBin.append(pane.element);
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

  restoreCapacity(
    project: WorkspaceProject,
    unloadingProjectId: string | null = null,
  ) {
    const unloadingCount = unloadingProjectId
      ? [...this.panes.values()].filter((pane) => pane.projectId === unloadingProjectId)
          .length
      : 0;
    const current = Math.max(0, this.panes.size - unloadingCount);
    const targetRemainsRestored =
      this.restoredProjects.has(project.id) && project.id !== unloadingProjectId;
    const incoming = targetRemainsRestored ? 0 : project.terminals.length;
    return evaluateWorkspaceRestoreCapacity(current, incoming, MAX_PANES);
  }

  startPriority(projectId: string) {
    return projectId === this.activeProjectId && this.workspaceView === "terminals"
      ? 100
      : 0;
  }

  syncProject(project: WorkspaceProject) {
    const ordered = project.terminals.map((terminal) =>
      paneRuntimeId(project.id, terminal.id),
    );
    this.projectOrders.set(project.id, ordered);
    this.projectRatios.set(
      project.id,
      Object.fromEntries(
        Object.entries(project.paneWidthRatios).map(([key, ratios]) => [
          key,
          [...ratios],
        ]),
      ),
    );
    if (this.restoredProjects.has(project.id)) {
      for (const terminal of project.terminals) {
        const existing = this.panes.get(paneRuntimeId(project.id, terminal.id));
        if (existing) existing.setTitle(terminal.name);
        else this.addPane(project.id, terminal, false);
      }
    }
  }

  showProject(project: WorkspaceProject) {
    if (this.disposed) return false;
    this.cancelLayoutInteraction();
    const capacity = this.restoreCapacity(project);
    if (!capacity.allowed) {
      this.setFooterStatus(
        `${project.name}을 열려면 PowerShell ${capacity.incoming}개 슬롯이 필요하지만 ` +
          `${capacity.available}개만 남았습니다. 다른 프로젝트 탭을 닫고 다시 시도하세요.`,
        "error",
      );
      return false;
    }
    const projectChanged = this.activeProjectId !== project.id;
    this.activeProjectId = project.id;
    for (const pane of this.panes.values()) {
      pane.element.hidden = pane.projectId !== project.id;
      pane.setActive(false);
    }

    if (!this.restoredProjects.has(project.id)) {
      for (const terminal of project.terminals) {
        if (!this.addPane(project.id, terminal, false)) {
          // Capacity was checked before any pane was created. A different failure
          // rolls the whole runtime project back instead of leaving a partial restore.
          void this.unloadProject(project.id);
          this.setFooterStatus(`${project.name} PowerShell 복원을 완료하지 못했습니다.`, "error");
          return false;
        }
      }
      this.restoredProjects.add(project.id);
    }

    const visible = this.visiblePanes();
    const prior = this.activePaneId ? this.panes.get(this.activePaneId) : null;
    this.activePaneId =
      !projectChanged && prior?.projectId === project.id ? prior.id : null;
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
    this.cancelLayoutInteraction();
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
    this.updateControls();
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
    this.cancelLayoutInteraction();
    const targets = [...this.panes.values()].filter(
      (pane) => pane.projectId === projectId,
    );
    for (const pane of targets) {
      this.panes.delete(pane.id);
      pane.element.remove();
    }
    this.restoredProjects.delete(projectId);
    this.projectOrders.delete(projectId);
    this.projectRatios.delete(projectId);
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

  async unloadAllProjects() {
    if (this.disposed) return;
    this.cancelLayoutInteraction();
    const projectIds = [...new Set([...this.panes.values()].map((pane) => pane.projectId))];
    for (const projectId of projectIds) await this.unloadProject(projectId);
  }

  async closePane(paneId: string): Promise<void> {
    if (!this.catalogWritable) return;
    const pane = this.panes.get(paneId);
    if (!pane) return;

    const orderedIds = this.visiblePanes().map((item) => item.id);
    const removedIndex = orderedIds.indexOf(paneId);
    const saved = await this.onPaneClosedCallback(pane.projectId, pane.terminalId);
    if (!saved || this.disposed || !this.panes.has(paneId)) return;

    this.panes.delete(paneId);
    const order = this.projectOrders.get(pane.projectId) ?? [];
    this.projectOrders.set(
      pane.projectId,
      order.filter((candidate) => candidate !== paneId),
    );
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

  async renamePane(paneId: string, title: string): Promise<void> {
    if (!this.catalogWritable) return;
    const pane = this.panes.get(paneId);
    if (!pane) return;
    const previousTitle = pane.title;
    pane.setTitle(title);
    const saved = await this.onPaneRenamedCallback(
      pane.projectId,
      pane.terminalId,
      title,
    );
    if (!saved && !this.disposed && this.panes.get(paneId) === pane) {
      pane.setTitle(previousTitle);
    }
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

  shouldDeferFit() {
    return this.dragState?.started === true || this.resizeState !== null;
  }

  beginPaneDrag(event: PointerEvent, paneId: string, captureTarget: HTMLElement) {
    if (
      this.disposed ||
      !this.catalogWritable ||
      event.button !== 0 ||
      this.dragState !== null ||
      this.resizeState !== null
    ) {
      return;
    }
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest("button, input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }
    const pane = this.panes.get(paneId);
    if (!pane || pane.projectId !== this.activeProjectId || pane.element.hidden) return;
    this.dragState = {
      paneId,
      projectId: pane.projectId,
      pointerId: event.pointerId,
      captureTarget,
      originX: event.clientX,
      originY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      started: false,
      geometry: [],
      preview: null,
      frame: 0,
    };
  }

  beginPaneResize(event: PointerEvent, paneId: string, captureTarget: HTMLElement) {
    if (
      this.disposed ||
      !this.catalogWritable ||
      event.button !== 0 ||
      this.dragState !== null ||
      this.resizeState !== null
    ) {
      return;
    }
    const pane = this.panes.get(paneId);
    const row = [...this.activeRows.values()].find((item) =>
      item.paneIds.includes(paneId),
    );
    const dividerIndex = row?.paneIds.indexOf(paneId) ?? -1;
    if (
      !pane ||
      !row ||
      pane.projectId !== this.activeProjectId ||
      dividerIndex < 0 ||
      dividerIndex >= row.paneIds.length - 1
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rowRect = row.element.getBoundingClientRect();
    const gapValue = Number.parseFloat(getComputedStyle(row.element).columnGap);
    const gap = Number.isFinite(gapValue) ? gapValue : 6;
    const totalWidth = Math.max(1, rowRect.width - gap * (row.columns - 1));
    const currentWidths = row.ratios.map((ratio) => ratio * totalWidth);
    const average = totalWidth / row.columns;
    const dynamicMinimum = Math.min(180, Math.max(80, average * 0.72));
    const minPaneWidth = Math.max(1, Math.min(dynamicMinimum, ...currentWidths));
    const siblingEdges = [...this.activeRows.values()]
      .filter((candidate) => candidate !== row)
      .flatMap((candidate) =>
        candidate.paneIds
          .slice(0, -1)
          .map((candidateId) => this.panes.get(candidateId)?.element.getBoundingClientRect().right)
          .filter((edge): edge is number => edge !== undefined),
      );
    this.resizeState = {
      paneId,
      projectId: pane.projectId,
      pointerId: event.pointerId,
      captureTarget,
      row,
      dividerIndex,
      originX: event.clientX,
      latestX: event.clientX,
      rowLeft: rowRect.left,
      totalWidth,
      gap,
      minPaneWidth,
      siblingEdges,
      originalRatios: [...row.ratios],
      previewRatios: [...row.ratios],
      frame: 0,
    };
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // The window listeners still provide a safe cancel path.
    }
    document.body.dataset.paneResizing = "true";
  }

  cancelLayoutInteraction() {
    if (this.dragState) this.finishPaneDrag(true);
    if (this.resizeState) this.finishPaneResize(true);
  }

  private updatePaneDrag(event: PointerEvent) {
    const state = this.dragState;
    if (!state) return;
    state.latestX = event.clientX;
    state.latestY = event.clientY;
    if (!state.started) {
      if (Math.hypot(state.latestX - state.originX, state.latestY - state.originY) < 8) {
        return;
      }
      const visible = this.visiblePanes();
      if (visible.length < 2) {
        this.finishPaneDrag(true);
        return;
      }
      state.geometry = visible.map((pane) => {
        const rect = pane.element.getBoundingClientRect();
        return {
          paneId: pane.id,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
      state.started = true;
      this.panes.get(state.paneId)?.setDragging(true);
      document.body.dataset.paneDragging = "true";
      try {
        state.captureTarget.setPointerCapture(state.pointerId);
      } catch {
        // Window-level pointer listeners remain active if capture is unavailable.
      }
    }
    event.preventDefault();
    if (!state.frame) {
      state.frame = requestAnimationFrame(() => this.renderPaneDragFrame());
    }
  }

  private renderPaneDragFrame() {
    const state = this.dragState;
    if (!state?.started) return;
    state.frame = 0;
    const pane = this.panes.get(state.paneId);
    if (!pane) return;
    pane.element.style.transform = `translate3d(${state.latestX - state.originX}px, ${
      state.latestY - state.originY
    }px, 0)`;
    state.preview = resolvePaneInsertionPreview(
      state.geometry,
      state.paneId,
      { x: state.latestX, y: state.latestY },
      state.preview,
    );
    const targetGeometry = state.preview.beforePaneId
      ? state.geometry.find((item) => item.paneId === state.preview?.beforePaneId)
      : state.geometry[state.geometry.length - 1];
    if (!targetGeometry) return;
    const surfaceRect = this.terminalSurface.getBoundingClientRect();
    const lineX = state.preview.beforePaneId
      ? targetGeometry.left
      : targetGeometry.left + targetGeometry.width;
    this.insertionLine.style.left = `${Math.round(lineX - surfaceRect.left)}px`;
    this.insertionLine.style.top = `${Math.round(targetGeometry.top - surfaceRect.top)}px`;
    this.insertionLine.style.height = `${Math.round(targetGeometry.height)}px`;
    this.insertionLine.hidden = false;
  }

  private finishPaneDrag(cancelled: boolean) {
    const state = this.dragState;
    if (!state) return;
    if (state.frame) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
      if (!cancelled) this.renderPaneDragFrame();
    }
    this.dragState = null;
    try {
      if (state.captureTarget.hasPointerCapture(state.pointerId)) {
        state.captureTarget.releasePointerCapture(state.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by Windows.
    }
    delete document.body.dataset.paneDragging;
    this.insertionLine.hidden = true;
    const pane = this.panes.get(state.paneId);
    if (pane) {
      pane.setDragging(false);
      pane.element.style.transform = "";
    }
    if (cancelled || !state.started || !state.preview || !pane) return;

    const current = [...(this.projectOrders.get(state.projectId) ?? [])];
    const next = current.filter((candidate) => candidate !== state.paneId);
    const insertionIndex = state.preview.beforePaneId
      ? next.indexOf(state.preview.beforePaneId)
      : next.length;
    if (insertionIndex < 0) return;
    next.splice(insertionIndex, 0, state.paneId);
    if (next.every((candidate, index) => candidate === current[index])) return;
    this.projectOrders.set(state.projectId, next);
    const beforeTerminalId = state.preview.beforePaneId
      ? this.panes.get(state.preview.beforePaneId)?.terminalId ?? null
      : null;
    this.updateLayout();
    this.onPaneReorderedCallback(state.projectId, pane.terminalId, {
      beforePaneId: beforeTerminalId,
    });
  }

  private updatePaneResize(event: PointerEvent) {
    const state = this.resizeState;
    if (!state) return;
    state.latestX = event.clientX;
    event.preventDefault();
    if (!state.frame) {
      state.frame = requestAnimationFrame(() => this.renderPaneResizeFrame());
    }
  }

  private renderPaneResizeFrame() {
    const state = this.resizeState;
    if (!state) return;
    state.frame = 0;
    try {
      const resized = computeHorizontalResize({
        ratios: state.originalRatios,
        dividerIndex: state.dividerIndex,
        totalWidthPx: state.totalWidth,
        deltaX: state.latestX - state.originX,
        minPaneWidthPx: state.minPaneWidth,
        containerLeftPx: state.rowLeft + state.gap * state.dividerIndex,
        siblingEdgesPx: state.siblingEdges,
      });
      state.previewRatios = resized.ratios;
      this.applyRowRatios(state.row, resized.ratios);
      if (resized.snappedToPx === null) {
        this.snapGuide.hidden = true;
      } else {
        const surfaceRect = this.terminalSurface.getBoundingClientRect();
        const rowRect = state.row.element.getBoundingClientRect();
        this.snapGuide.style.left = `${Math.round(resized.snappedToPx - surfaceRect.left)}px`;
        this.snapGuide.style.top = `${Math.round(rowRect.top - surfaceRect.top)}px`;
        this.snapGuide.style.height = `${Math.round(rowRect.height)}px`;
        this.snapGuide.hidden = false;
      }
    } catch (error) {
      this.setFooterStatus(`너비를 조절할 수 없습니다: ${errorMessage(error)}`, "error");
    }
  }

  private finishPaneResize(cancelled: boolean) {
    const state = this.resizeState;
    if (!state) return;
    if (state.frame) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
      if (!cancelled) this.renderPaneResizeFrame();
    }
    this.resizeState = null;
    try {
      if (state.captureTarget.hasPointerCapture(state.pointerId)) {
        state.captureTarget.releasePointerCapture(state.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by Windows.
    }
    delete document.body.dataset.paneResizing;
    this.snapGuide.hidden = true;
    const ratios = cancelled ? state.originalRatios : state.previewRatios;
    this.applyRowRatios(state.row, ratios);
    if (!cancelled && !ratiosEqual(state.originalRatios, state.previewRatios)) {
      const entries = this.projectRatios.get(state.projectId) ?? {};
      this.projectRatios.set(state.projectId, {
        ...entries,
        [state.row.key]: [...state.previewRatios],
      });
      this.onPaneRatiosChangedCallback(
        state.projectId,
        state.row.key,
        [...state.previewRatios],
      );
    }
    requestAnimationFrame(() => {
      for (const paneId of state.row.paneIds) this.panes.get(paneId)?.scheduleFit(0);
    });
  }

  showBrowserView() {
    this.cancelLayoutInteraction();
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
    this.cancelLayoutInteraction();
    this.app.removeEventListener("pointerdown", this.onAppPointerDown);
    window.removeEventListener("pointermove", this.onLayoutPointerMove, true);
    window.removeEventListener("pointerup", this.onLayoutPointerUp, true);
    window.removeEventListener("pointercancel", this.onLayoutPointerCancel, true);
    window.removeEventListener("keydown", this.onLayoutKeyDown, true);
    window.removeEventListener("blur", this.onLayoutWindowBlur);
    const stops = Promise.all(
      [...this.panes.values()].map((pane) => pane.dispose()),
    ).then(() => undefined);
    this.panes.clear();
    this.sessionOwners.clear();
    this.restoredProjects.clear();
    this.projectOrders.clear();
    this.projectRatios.clear();
    this.activeRows.clear();
    await this.appendStopBarrier(stops);
  }

  private updateLayout() {
    const visible = this.visiblePanes();
    const { columns, rows } = layoutFor(visible.length);
    for (const pane of this.panes.values()) {
      pane.element.hidden = true;
      pane.setResizeHandleEnabled(false);
      this.inactivePaneBin.append(pane.element);
    }
    this.rowsHost.replaceChildren();
    this.activeRows.clear();
    this.rowsHost.style.setProperty("--terminal-row-count", String(rows));

    const storedRatios = this.activeProjectId
      ? this.projectRatios.get(this.activeProjectId) ?? {}
      : {};
    for (let rowIndex = 0; rowIndex < rows && visible.length > 0; rowIndex += 1) {
      const start = rowIndex * columns;
      const rowPanes = visible.slice(start, start + columns);
      if (rowPanes.length === 0) break;
      const key = `${columns}x${rows}:row-${rowIndex}`;
      const ratios = normalizedLayoutRatios(storedRatios[key], columns);
      const rowElement = document.createElement("div");
      rowElement.className = "terminal-row";
      rowElement.dataset.layoutKey = key;
      rowElement.dataset.row = String(rowIndex);
      const row: ActiveTerminalRow = {
        key,
        element: rowElement,
        paneIds: rowPanes.map((pane) => pane.id),
        ratios,
        columns,
      };

      for (let column = 0; column < columns; column += 1) {
        const pane = rowPanes[column];
        if (pane) {
          pane.element.hidden = false;
          pane.setResizeHandleEnabled(
            this.catalogWritable && column < rowPanes.length - 1,
          );
          rowElement.append(pane.element);
        } else {
          const spacer = document.createElement("div");
          spacer.className = "terminal-row-spacer";
          spacer.setAttribute("aria-hidden", "true");
          rowElement.append(spacer);
        }
      }
      this.applyRowRatios(row, ratios);
      this.activeRows.set(key, row);
      this.rowsHost.append(rowElement);
    }

    this.terminalSurface.dataset.empty = String(visible.length === 0);
    this.updateControls();
    requestAnimationFrame(() => {
      for (const pane of visible) pane.scheduleFit(0);
    });
  }

  private updateControls() {
    const visible = this.visiblePanes();
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
    for (const row of this.activeRows.values()) {
      row.paneIds.forEach((paneId, index) => {
        this.panes
          .get(paneId)
          ?.setResizeHandleEnabled(
            this.catalogWritable && index < row.paneIds.length - 1,
          );
      });
    }
  }

  private applyRowRatios(row: ActiveTerminalRow, ratios: readonly number[]) {
    row.ratios = [...ratios];
    [...row.element.children].forEach((child, index) => {
      if (!(child instanceof HTMLElement)) return;
      child.style.flexGrow = String(ratios[index] ?? 0);
      child.style.flexShrink = "1";
      child.style.flexBasis = "0px";
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
    const candidates = [...this.panes.values()].filter(
      (pane) => pane.projectId === this.activeProjectId,
    );
    const byId = new Map(candidates.map((pane) => [pane.id, pane]));
    const ordered = (this.projectOrders.get(this.activeProjectId) ?? [])
      .map((paneId) => byId.get(paneId))
      .filter((pane): pane is TerminalPane => pane !== undefined);
    const known = new Set(ordered.map((pane) => pane.id));
    ordered.push(...candidates.filter((pane) => !known.has(pane.id)));
    return ordered;
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

function paneRuntimeId(projectId: string, terminalId: string) {
  return `${projectId.length}:${projectId}${terminalId}`;
}

function normalizedLayoutRatios(
  stored: readonly number[] | undefined,
  columns: number,
) {
  const source =
    stored?.length === columns && stored.every((value) => Number.isFinite(value) && value > 0)
      ? [...stored]
      : Array.from({ length: columns }, () => 1);
  const sum = source.reduce((total, value) => total + value, 0);
  return source.map((value) => value / sum);
}

function ratiosEqual(left: readonly number[], right: readonly number[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - right[index]) < 1e-6)
  );
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
const projectDialog = requireDialog("project-dialog");
const projectForm = requireForm("project-form");
const projectName = requireInput("project-name");
const projectPath = requireInput("project-path");
const projectFormError = requireElement("project-form-error");
const cancelProjectButton = requireButton("cancel-project");
const upgradeButton = requireButton("open-phase3-upgrade");
const upgradeDialog = requireDialog("phase3-upgrade-dialog");
const upgradeProjectCount = requireElement("phase3-upgrade-project-count");
const upgradeTerminalCount = requireElement("phase3-upgrade-terminal-count");
const upgradeSourceSha = requireElement("phase3-upgrade-source-sha");
const commitUpgradeButton = requireButton("commit-phase3-upgrade");
const closeUpgradeButton = requireButton("close-phase3-upgrade");
const upgradeError = requireElement("phase3-upgrade-error");

let controller: Phase4WorkspaceController | null = null;
const workspace = new TerminalWorkspace(
  app,
  terminalSurface,
  addButton,
  closeActiveButton,
  sessionCount,
  statusElement,
  (projectId, paneId) =>
    controller?.onPaneClosed(projectId, paneId) ?? Promise.resolve(false),
  (projectId, paneId, title) =>
    controller?.onPaneRenamed(projectId, paneId, title) ?? Promise.resolve(false),
  (projectId, paneId, target) =>
    controller?.onPaneReordered(projectId, paneId, target),
  (projectId, layoutKey, ratios) =>
    controller?.onPaneRatiosChanged(projectId, layoutKey, ratios),
);
const browser = new BrowserController(workspace, browserSurface, browserButton);
controller = createPhase4WorkspaceController(workspace, {
  projectList,
  projectCount,
  tabList,
  currentProject,
  addTerminalButton: addButton,
  addTabButton,
  createProjectButton,
  projectDialog,
  projectForm,
  projectName,
  projectPath,
  projectFormError,
  cancelProjectButton,
  upgradeButton,
  upgradeDialog,
  upgradeProjectCount,
  upgradeTerminalCount,
  upgradeSourceSha,
  commitUpgradeButton,
  closeUpgradeButton,
  upgradeError,
});
const migrationUi = createPhase3BMigrationUI({
  beforeReplace: async () => {
    if (!controller) throw new Error("Rust 작업 공간 제어기가 준비되지 않았습니다.");
    await controller.prepareForExternalReplacement();
  },
  afterReplace: async (committed) => {
    await controller?.finishExternalReplacement(committed);
  },
});

const initializationPromise = controller.initialize();
const migrationInitializationPromise = initializationPromise.then(() =>
  migrationUi.initialize(),
);
void migrationInitializationPromise;

const currentAppWindow = getCurrentWindow();
let closeBarrierRunning = false;
void currentAppWindow.onCloseRequested(async (event) => {
  event.preventDefault();
  if (closeBarrierRunning) {
    // A backend replacement or startup IPC can be indefinitely delayed by an
    // unhealthy child/process. A second explicit close request is therefore
    // the guaranteed escape hatch; Job Object ownership cleans descendants as
    // the application process exits.
    migrationUi.dispose();
    controller?.dispose();
    void browser.dispose();
    void workspace.dispose();
    await currentAppWindow.destroy();
    return;
  }

  closeBarrierRunning = true;
  controller?.beginShutdown();
  browser.beginShutdown();
  try {
    await Promise.all([initializationPromise, migrationInitializationPromise]);
    await controller?.flushSaves();
    migrationUi.dispose();
    controller?.dispose();
    await browser.dispose();
    // Use one backend-owned barrier instead of twenty pane-local stop IPCs. It
    // rejects queued starts, waits until every spawned child belongs to a Job
    // Object, and then drains all active terminal process trees before destroy.
    await invoke("shutdown_terminal_engine");
    await currentAppWindow.destroy();
  } catch (error) {
    workspace.setFooterStatus(
      `정상 종료를 완료하지 못했습니다. X를 다시 누르면 강제 종료합니다: ${errorMessage(error)}`,
      "error",
    );
  }
});

window.addEventListener("beforeunload", () => {
  if (closeBarrierRunning) return;
  migrationUi.dispose();
  controller?.dispose();
  void browser.dispose();
  void workspace.dispose();
});
