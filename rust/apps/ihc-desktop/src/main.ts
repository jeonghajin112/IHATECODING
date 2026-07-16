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
  clampPaneCount,
  clipboardItemsContainImage,
  layoutFor,
  normalizeTerminalEvent,
  prepareTerminalPaste,
  type TerminalEvent,
} from "./phase2-core";

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
  readonly title: string;
  readonly element: HTMLElement;

  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly viewport: HTMLElement;
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
    number: number,
  ) {
    this.id = createLocalId();
    this.title = `PowerShell ${number}`;

    this.element = document.createElement("article");
    this.element.className = "terminal-pane";
    this.element.dataset.paneId = this.id;
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
    const titleElement = document.createElement("span");
    titleElement.className = "terminal-title";
    titleElement.textContent = this.title;
    this.stateLabel = document.createElement("span");
    this.stateLabel.className = "terminal-state-label";
    this.stateLabel.textContent = this.statusMessage;
    heading.append(titleElement, this.stateLabel);

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

  async start() {
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
          cwd: null,
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

  scheduleFit(delay = 35) {
    if (this.disposed) return;
    window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      this.fitTerminal();
      this.queueCurrentSize();
    }, delay);
  }

  dispose() {
    if (this.disposed) return;
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
    for (const sessionId of sessionsToStop) void stopBackendSession(sessionId);
    this.unboundOutput.length = 0;
    this.unboundOutputBytes = 0;
    this.terminal.dispose();
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
}

class TerminalWorkspace {
  private readonly panes = new Map<string, TerminalPane>();
  private readonly sessionOwners = new Map<string, string>();
  private readonly scheduler = new StartScheduler();
  private activePaneId: string | null = null;
  private nextPaneNumber = 1;
  private workspaceView: "terminals" | "browser" = "terminals";

  constructor(
    private readonly app: HTMLElement,
    private readonly terminalSurface: HTMLElement,
    private readonly addButton: HTMLButtonElement,
    private readonly closeActiveButton: HTMLButtonElement,
    private readonly countElement: HTMLElement,
    private readonly statusElement: HTMLElement,
  ) {
    this.terminalSurface.dataset.empty = "true";
    this.addButton.addEventListener("click", () => this.addPane(true));
    this.closeActiveButton.addEventListener("click", () => {
      if (this.activePaneId) this.closePane(this.activePaneId);
    });
  }

  addPane(focus = true) {
    if (this.panes.size >= MAX_PANES) {
      this.setFooterStatus(`PowerShell은 최대 ${MAX_PANES}개까지 열 수 있습니다.`, "error");
      return null;
    }

    const pane = new TerminalPane(this, this.scheduler, this.nextPaneNumber++);
    this.panes.set(pane.id, pane);
    this.terminalSurface.append(pane.element);
    this.activatePane(pane.id, !focus);
    this.updateLayout();
    void pane.start();
    if (focus && this.workspaceView === "terminals") {
      requestAnimationFrame(() => pane.focus());
    }
    return pane;
  }

  closePane(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    const orderedIds = [...this.panes.keys()];
    const removedIndex = orderedIds.indexOf(paneId);
    this.panes.delete(paneId);
    pane.dispose();
    pane.element.remove();

    if (this.activePaneId === paneId) {
      const remainingIds = [...this.panes.keys()];
      this.activePaneId =
        remainingIds[Math.min(Math.max(0, removedIndex), remainingIds.length - 1)] ?? null;
    }
    for (const item of this.panes.values()) {
      item.setActive(item.id === this.activePaneId);
    }
    this.updateLayout();
    this.renderActiveStatus();
    if (this.workspaceView === "terminals" && this.activePaneId) {
      requestAnimationFrame(() => this.panes.get(this.activePaneId ?? "")?.focus());
    }
  }

  activatePane(paneId: string, suppressFocus: boolean) {
    if (!this.panes.has(paneId)) return;
    this.activePaneId = paneId;
    for (const pane of this.panes.values()) pane.setActive(pane.id === paneId);
    this.closeActiveButton.disabled = false;
    this.renderActiveStatus();
    if (!suppressFocus && this.workspaceView === "terminals") {
      this.panes.get(paneId)?.focus();
    }
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
    this.workspaceView = "terminals";
    this.app.dataset.workspaceView = "terminals";
    this.closeActiveButton.disabled = this.activePaneId === null;
    this.renderActiveStatus();
    requestAnimationFrame(() => {
      for (const pane of this.panes.values()) pane.scheduleFit(0);
      this.panes.get(this.activePaneId ?? "")?.focus();
    });
  }

  setFooterStatus(message: string, tone: StatusTone = "normal") {
    this.statusElement.textContent = message;
    this.statusElement.dataset.tone = tone;
  }

  dispose() {
    for (const pane of this.panes.values()) pane.dispose();
    this.panes.clear();
    this.sessionOwners.clear();
  }

  private updateLayout() {
    const { columns, rows } = layoutFor(this.panes.size);
    this.terminalSurface.style.setProperty("--grid-columns", String(columns));
    this.terminalSurface.style.setProperty("--grid-rows", String(rows));
    this.terminalSurface.dataset.empty = String(this.panes.size === 0);
    this.countElement.textContent = `${this.panes.size} / ${MAX_PANES}`;
    this.addButton.disabled = this.panes.size >= MAX_PANES;
    this.closeActiveButton.disabled =
      this.workspaceView === "browser" || this.activePaneId === null;
    requestAnimationFrame(() => {
      for (const pane of this.panes.values()) pane.scheduleFit(0);
    });
  }

  private renderActiveStatus() {
    if (this.workspaceView !== "terminals") return;
    const pane = this.activePaneId ? this.panes.get(this.activePaneId) : null;
    if (!pane) {
      this.closeActiveButton.disabled = true;
      this.setFooterStatus("＋ PowerShell을 눌러 새 터미널을 여세요.");
      return;
    }
    const status = pane.status;
    this.setFooterStatus(`${pane.title} · ${status.message}`, status.tone);
  }
}

class BrowserController {
  private state: BrowserState = "closed";
  private webview: Webview | null = null;
  private label: string | null = null;
  private generation = 0;
  private boundsSyncPending = false;
  private boundsSyncQueue: Promise<void> = Promise.resolve();
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly workspace: TerminalWorkspace,
    private readonly surface: HTMLElement,
    private readonly button: HTMLButtonElement,
  ) {
    this.button.addEventListener("click", () => {
      void this.toggle().catch((error) => {
        this.workspace.setFooterStatus(String(error), "error");
      });
    });
    this.resizeObserver = new ResizeObserver(() => this.scheduleBoundsSync());
    this.resizeObserver.observe(this.surface);
    window.addEventListener("resize", () => this.scheduleBoundsSync());
  }

  async toggle() {
    if (this.state === "opening" || this.state === "closing") return;
    if (this.state === "open") await this.close();
    else await this.open();
  }

  dispose() {
    this.generation += 1;
    this.resizeObserver.disconnect();
    const current = this.webview;
    this.webview = null;
    this.label = null;
    this.state = "closed";
    if (current) {
      void current.hide().catch(() => undefined);
      void current.close().catch(() => undefined);
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
      if (generation === this.generation) this.button.disabled = false;
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
      if (generation === this.generation) this.button.disabled = false;
    }
  }

  private finishClosedState() {
    this.webview = null;
    this.label = null;
    this.state = "closed";
    this.button.disabled = false;
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

async function resolveInitialPaneCount() {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.has("initialPanes")) {
    const raw = parameters.get("initialPanes") ?? "";
    return /^\d+$/.test(raw) ? clampPaneCount(Number.parseInt(raw, 10)) : 1;
  }

  try {
    return clampPaneCount(await invoke<number>("phase2_initial_panes"));
  } catch (error) {
    // Keep the preview usable with an older Phase 1 backend during migration.
    console.warn("phase2_initial_panes is unavailable; using one pane.", error);
    return 1;
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

const app = requireElement("app");
const terminalSurface = requireElement("terminal-surface");
const browserSurface = requireElement("browser-surface");
const addButton = requireButton("add-terminal");
const closeActiveButton = requireButton("close-active-terminal");
const browserButton = requireButton("toggle-browser");
const sessionCount = requireElement("session-count");
const statusElement = requireElement("status");

const workspace = new TerminalWorkspace(
  app,
  terminalSurface,
  addButton,
  closeActiveButton,
  sessionCount,
  statusElement,
);
const browser = new BrowserController(workspace, browserSurface, browserButton);

async function bootstrap() {
  const initialPaneCount = await resolveInitialPaneCount();
  for (let index = 0; index < initialPaneCount; index += 1) {
    workspace.addPane(index === initialPaneCount - 1);
  }
}

void bootstrap();

window.addEventListener("beforeunload", () => {
  browser.dispose();
  workspace.dispose();
});
