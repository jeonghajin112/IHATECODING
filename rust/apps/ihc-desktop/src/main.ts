import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  getCurrentWebview,
  Webview,
  type DragDropEvent,
} from "@tauri-apps/api/webview";
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
  StartAbortedError,
  StartScheduler,
  binaryStringToRawBytes,
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
  projectBrowserPanes,
  type PaneGeometry,
  type PaneInsertionTarget,
  type WorkspaceBrowserPane,
} from "./phase4-core";
import {
  createPhase4WorkspaceController,
  type Phase4WorkspaceController,
} from "./phase4-controller";
import {
  formatProviderResetCountdown,
  formatDroppedFileReference,
  isTerminalCopyShortcut,
  isTerminalCtrlInsertShortcut,
  isTerminalModifierOnlyInput,
  millisecondsUntilNextProviderUsageReset,
  normalizeProviderAccountListResponse,
  normalizeProviderUsageResponse,
  selectDroppedFilePaths,
  selectClipboardImageSequence,
  shouldManuallySendTerminalInterrupt,
  shouldOwnTerminalCopyFallback,
  TerminalLaunchPaintWatchdog,
  TerminalSelectionCopyGuard,
  type AgentProvider,
  type ProviderAccountListResponse,
  type ProviderLimitUsage,
  type ProviderUsageResponse,
  type SafeResumePlan,
} from "./phase5-core";

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

type CursorClickSnapshot = {
  clientX: number;
  clientY: number;
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  targetColumn: number;
  lineFingerprint: string;
  renderVersion: number;
};

type NativeClipboardSnapshot =
  | { kind: "image" }
  | { kind: "text"; text: string }
  | { kind: "empty" };

type AgentDiscoveryResponse = {
  binding: {
    runtimeSessionId: string;
    terminalKey: { projectId: string; terminalId: string };
    provider: AgentProvider;
    conversationId: string;
  };
  completionObservedAtUnixMs: number | null;
};

type PendingAgentCompletionRoute = {
  provider: AgentProvider;
  runtimeSessionId: string;
  conversationId: string;
  turnId: string | null;
  observedAtUnixMs: number;
};

type PhoneNotificationSettings = {
  enabled: boolean;
  webhookConfigured: boolean;
  notifyOnSuccess: boolean;
  notifyOnError: boolean;
};

type PhoneNotificationLabels = {
  projectName: string;
  terminalName: string;
};

type PhoneNotificationSettingsUpdate = {
  enabled: boolean;
  webhookUrl: string | null;
  clearWebhook: boolean;
  notifyOnSuccess: boolean;
  notifyOnError: boolean;
};

type PhoneNotificationKind = "success" | "error" | "test";

type PhoneNotificationResult = {
  sent: boolean;
};

type QueuedPhoneNotification = {
  kind: Exclude<PhoneNotificationKind, "test">;
  eventId: string;
  labels: PhoneNotificationLabels;
};

const OUTPUT_SETTLED_DELAY_MS = 120;
const OUTPUT_RENDER_COALESCE_MS = 10;
const OUTPUT_RENDER_MAX_BYTES = 256 * 1024;
const COMPLETION_OUTPUT_QUIET_MS = 1_000;
const EXIT_GAP_TIMEOUT_MS = 2_000;
const UNBOUND_OUTPUT_MAX_BATCHES = 64;
const UNBOUND_OUTPUT_MAX_BYTES = 1_048_576;
const UNBOUND_OUTPUT_MAX_AGE_MS = 2_000;
const ACK_MAX_ATTEMPTS = 3;
const ACK_RETRY_DELAYS_MS = [40, 120] as const;
const COMPLETION_ROUTE_ACK_RETRY_DELAYS_MS = [150, 500, 1_500] as const;
const AGENT_DISCOVERY_DELAYS_MS = [200, 400, 800, 1_500, 3_000, 6_000] as const;
const AGENT_DISCOVERY_REARM_MS = 2_000;
const AGENT_REBIND_PROBE_INTERVAL_MS = 1_000;
const RESUME_HEALTH_DELAYS_MS = [2_500, 5_000, 7_500, 10_000] as const;
const RESUME_HEALTH_FINAL_RECHECK_MS = 3_000;
const AGENT_EVENT_BIND_RETRY_DELAYS_MS = [
  80,
  200,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
] as const;
const PHONE_NOTIFICATION_RETRY_DELAYS_MS = [1_500, 4_000] as const;
const CLIPBOARD_READ_TIMEOUT_MS = 3_000;
const TERMINAL_LAUNCH_PROBE_TTL_MS = 12_000;
const TERMINAL_PAINT_WATCHDOG_POLL_MS = 120;
const TERMINAL_SYNCHRONIZED_PAINT_LIMIT_MS = 1_600;
const PANE_DRAG_START_DISTANCE_PX = 8;
const PANE_DRAG_MINIMUM_REORDER_DISTANCE_PX = 12;
const PANE_DRAG_SLOT_HYSTERESIS_PX = 18;
const PANE_DRAG_CANDIDATE_HOLD_MS = 80;
const PANE_DRAG_BOUNCE_BACK_ANGLE_RADIANS = 1;
const CURSOR_CLICK_MAX_POINTER_DRIFT_PX = 4;
const CURSOR_CLICK_MAX_KEYSTROKES = 256;
const outputEncoder = new TextEncoder();
let phoneNotificationEventSequence = 0;

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
  private readonly contextLabel: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly maximizeButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly resizeHandle: HTMLDivElement;
  private readonly fileDropOverlay: HTMLDivElement;
  private readonly fileDropCount: HTMLSpanElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly terminalDisposables: Array<{ dispose(): void }> = [];
  private readonly outputSequencer = new OutputSequencer<OutputBatch>();
  private readonly ackPolicy = new CumulativeAckPolicy();
  private readonly launchPaintWatchdog = new TerminalLaunchPaintWatchdog(
    TERMINAL_SYNCHRONIZED_PAINT_LIMIT_MS,
  );
  private readonly selectionCopyGuard = new TerminalSelectionCopyGuard();
  private readonly unboundOutput: OutputBatch[] = [];
  private readonly pendingRenderBatches: OutputBatch[] = [];
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
  private phoneErrorNotifiedEpoch = -1;
  private disposed = false;
  private catalogWritable = false;
  private terminalFailed = false;
  private copyShortcutReleasePending = false;
  private fitTimer = 0;
  private launchProbeExpiryTimer = 0;
  private launchPaintWatchdogTimer = 0;
  private outputSettledTimer = 0;
  private exitGapTimer = 0;
  private unboundOutputTimer = 0;
  private userBrowsingScrollback = false;
  private selectionGestureActive = false;
  private cursorClickSnapshot: CursorClickSnapshot | null = null;
  private editableAnchorColumn: number | null = null;
  private capturedCursorMoveInput: string[] | null = null;
  private terminalRenderVersion = 0;
  private terminalPaintedVersion = 0;
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
  private renderDrainScheduled = false;
  private startCompletion: Promise<void> = Promise.resolve();
  private agentProvider: AgentProvider | null;
  private agentConversationId: string | null;
  private agentConversationBound: boolean;
  private runtimeStartedAtUnixMs = Date.now();
  private agentDiscoveryTimer = 0;
  private agentDiscoveryAttempts = 0;
  private agentDiscoveryLastAttemptAt = 0;
  private agentDiscoveryPending = false;
  private resumeHealthTimer = 0;
  private resumeHealthAttempt = 0;
  private resumeHealthMisses = 0;
  private completionPending = false;
  private completionAckPending = false;
  private completionBarrierTimer = 0;
  private pendingCompletionKey: string | null = null;
  private pendingAgentCompletionRoutes: PendingAgentCompletionRoute[] = [];
  private lastRenderedOutputAt = performance.now();
  private readonly observedCompletionKeys = new Set<string>();

  private readonly onWindowMouseUp = (event: MouseEvent) => {
    if (event.button !== 0 || !this.selectionGestureActive) return;
    const snapshot = this.cursorClickSnapshot;
    const release = {
      clientX: event.clientX,
      clientY: event.clientY,
      detail: event.detail,
      isTrusted: event.isTrusted,
      hasModifier: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
      insideViewport:
        event.target instanceof Node && this.viewport.contains(event.target),
    };
    this.selectionCopyGuard.captureLiveSelection(this.liveTerminalSelection());
    this.cursorClickSnapshot = null;
    this.selectionGestureActive = false;
    this.invalidatePendingFollow();
    if (!this.terminal.hasSelection() && this.isAtBottom()) {
      this.userBrowsingScrollback = false;
    }
    if (snapshot) {
      window.setTimeout(() => this.moveCursorFromClick(snapshot, release), 0);
    }
  };

  private readonly onWindowBlur = () => {
    this.copyShortcutReleasePending = false;
    if (!this.selectionGestureActive) return;
    this.selectionGestureActive = false;
    this.cursorClickSnapshot = null;
    this.invalidatePendingFollow();
  };

  private readonly onWindowFocus = () => {
    this.resumeInteractiveLaunchPaintProbeIfVisible();
  };

  private readonly onWindowTerminalKeyDown = (event: KeyboardEvent) => {
    if (!this.ownsTerminalKeyboardEvent(event)) return;
    if (this.consumeSelectionCopyShortcut(event, true)) return;
    if (isTerminalInputIntentKey(event, this.terminal.hasSelection())) {
      this.selectionCopyGuard.invalidate();
    }
  };

  private readonly onWindowTerminalKeyUp = (event: KeyboardEvent) => {
    if (
      !this.copyShortcutReleasePending ||
      (!isTerminalCopyShortcut(event) && !isTerminalCtrlInsertShortcut(event))
    ) {
      return;
    }
    this.copyShortcutReleasePending = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  constructor(
    private readonly workspace: TerminalWorkspace,
    private readonly scheduler: StartScheduler,
    projectId: string,
    savedState: WorkspaceTerminal,
    private readonly resumePlan: SafeResumePlan,
  ) {
    this.terminalId = savedState.id;
    this.id = paneRuntimeId(projectId, savedState.id);
    this.projectId = projectId;
    this.title = savedState.name;
    this.startDirectory = savedState.startDirectory;
    this.agentProvider =
      resumePlan.action === "resume" ? resumePlan.provider : null;
    this.agentConversationId =
      resumePlan.action === "resume" ? resumePlan.conversationId : null;
    this.agentConversationBound = resumePlan.action === "resume";
    this.completionPending = savedState.completionPending;

    this.element = document.createElement("article");
    this.element.className = "terminal-pane";
    this.element.dataset.paneId = this.id;
    this.element.dataset.projectId = this.projectId;
    this.element.dataset.state = this.paneState;
    this.element.dataset.active = "false";
    this.element.dataset.completionPending = String(this.completionPending);
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
    this.contextLabel = document.createElement("span");
    this.contextLabel.className = "terminal-context";
    this.contextLabel.hidden = true;
    heading.append(
      this.titleElement,
      this.titleEditor,
      this.stateLabel,
      this.contextLabel,
    );

    const actions = document.createElement("div");
    actions.className = "terminal-actions";
    this.copyButton = document.createElement("button");
    this.copyButton.className = "terminal-window-action terminal-copy";
    this.copyButton.type = "button";
    this.copyButton.hidden = true;
    this.copyButton.title = "선택한 답변 복사";
    this.copyButton.setAttribute("aria-label", "선택한 답변 복사");
    this.maximizeButton = document.createElement("button");
    this.maximizeButton.className = "terminal-window-action terminal-maximize";
    this.maximizeButton.type = "button";
    this.maximizeButton.textContent = "□";
    this.maximizeButton.title = `${this.title} 확대`;
    this.maximizeButton.setAttribute("aria-label", `${this.title} 확대`);
    this.maximizeButton.setAttribute("aria-pressed", "false");
    this.closeButton = document.createElement("button");
    this.closeButton.className = "terminal-window-action terminal-close";
    this.closeButton.type = "button";
    this.closeButton.textContent = "×";
    this.closeButton.title = `${this.title} 닫기`;
    this.closeButton.setAttribute("aria-label", `${this.title} 닫기`);
    actions.append(this.copyButton, this.maximizeButton, this.closeButton);
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
    this.fileDropOverlay = document.createElement("div");
    this.fileDropOverlay.className = "terminal-file-drop-overlay";
    this.fileDropOverlay.setAttribute("aria-hidden", "true");
    const fileDropTitle = document.createElement("strong");
    fileDropTitle.textContent = "파일을 놓아 첨부";
    this.fileDropCount = document.createElement("span");
    this.fileDropCount.textContent = "1개 파일";
    this.fileDropOverlay.append(fileDropTitle, this.fileDropCount);
    this.element.append(
      header,
      this.viewport,
      this.resizeHandle,
      this.fileDropOverlay,
    );

    this.terminal = new Terminal({
      altClickMovesCursor: false,
      // Keep the input caret stable while full-screen CLIs repaint progress.
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "bar",
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
      vtExtensions: {
        kittyKeyboard: true,
        win32InputMode: true,
      },
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
        // xterm 6 draws this one-pixel separator directly on a canvas. Match
        // the terminal surface so the scrollbar keeps its thumb without a
        // bright full-height rule beside it.
        overviewRulerBorder: "#050505",
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
    this.installStableCursorPolicy();

    this.copyButton.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    this.copyButton.addEventListener("mousedown", (event) => {
      // Keep the hidden xterm textarea focused so copying a selection cannot
      // interrupt a Korean IME composition in another pane interaction.
      event.preventDefault();
    });
    this.copyButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.copySelection();
    });
    this.maximizeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.workspace.togglePaneMaximize(this.id);
    });
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
      this.workspace.acknowledgePaneCompletion(this.id);
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
    window.addEventListener("keydown", this.onWindowTerminalKeyDown, true);
    window.addEventListener("keyup", this.onWindowTerminalKeyUp, true);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("focus", this.onWindowFocus);
  }

  get state() {
    return this.paneState;
  }

  get status() {
    return { message: this.statusMessage, tone: this.statusTone } as const;
  }

  get runtimeStartTime() {
    return this.runtimeStartedAtUnixMs;
  }

  get hasCompletionPending() {
    return this.completionPending;
  }

  ownsRuntimeSession(sessionId: string) {
    return this.sessionId === sessionId;
  }

  matchesAgentConversation(provider: AgentProvider, conversationId: string) {
    return (
      this.agentConversationBound &&
      this.agentProvider === provider &&
      this.agentConversationId === conversationId.toLowerCase()
    );
  }

  setAgentConversation(provider: AgentProvider, conversationId: string) {
    const normalizedConversationId = conversationId.toLowerCase();
    if (
      !this.agentConversationBound ||
      this.agentProvider !== provider ||
      this.agentConversationId !== normalizedConversationId
    ) {
      this.clearAgentContextUsage();
    }
    this.agentProvider = provider;
    this.agentConversationId = normalizedConversationId;
    this.agentConversationBound = true;
    this.agentDiscoveryAttempts = 0;
    window.clearTimeout(this.agentDiscoveryTimer);
    this.agentDiscoveryTimer = 0;
    window.clearTimeout(this.resumeHealthTimer);
    this.resumeHealthTimer = 0;
  }

  setAgentContextUsage(
    provider: AgentProvider,
    conversationId: string,
    usedTokens: number,
    windowTokens: number,
    remainingPercent: number,
  ) {
    if (!this.matchesAgentConversation(provider, conversationId)) return false;
    const providerName = provider === "codex" ? "Codex" : "Grok";
    this.contextLabel.textContent = `Context ${remainingPercent}%`;
    this.contextLabel.title =
      `${providerName} 컨텍스트 ${usedTokens.toLocaleString("ko-KR")} / ` +
      `${windowTokens.toLocaleString("ko-KR")} 토큰 사용 · ${remainingPercent}% 남음`;
    this.contextLabel.dataset.low = String(remainingPercent <= 20);
    this.contextLabel.hidden = false;
    return true;
  }

  private clearAgentContextUsage() {
    this.contextLabel.hidden = true;
    this.contextLabel.textContent = "";
    this.contextLabel.title = "";
    this.contextLabel.dataset.low = "false";
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

        this.runtimeStartedAtUnixMs = Date.now();
        const result = await invoke<StartTerminalResponse>("start_terminal", {
          cwd: this.startDirectory,
          columns: Math.max(2, this.terminal.cols),
          rows: Math.max(1, this.terminal.rows),
          terminalKey: {
            projectId: this.projectId,
            terminalId: this.terminalId,
          },
          resume:
            this.resumePlan.action === "resume" &&
            this.resumePlan.provider &&
            this.resumePlan.conversationId
              ? {
                  provider: this.resumePlan.provider,
                  conversationId: this.resumePlan.conversationId,
                }
              : null,
          onEvent,
        });

        if (this.disposed || epoch !== this.lifecycleEpoch) {
          await stopBackendSession(result.sessionId);
          throw new CancelledStart();
        }
        if (this.terminatedSessionIds.has(result.sessionId)) return;
        if (!this.bindSession(result.sessionId)) return;

        if (this.paneState !== "running") {
          this.setState("running", "");
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

  setFileDropTarget(active: boolean, fileCount = 0) {
    this.element.dataset.fileDropTarget = String(active);
    if (active) {
      this.fileDropCount.textContent = `${Math.max(1, fileCount)}개 파일`;
    }
  }

  async attachDroppedFiles(paths: readonly string[]): Promise<number> {
    const commit = this.reserveInputSlot();
    if (!commit || paths.length === 0) return 0;

    this.workspace.acknowledgePaneCompletion(this.id);
    this.resumeAutoFollowForUserIntent();
    this.terminal.focus();
    const provider = await this.detectDroppedFileProvider();
    if (this.disposed) {
      commit(null);
      return 0;
    }
    const bracketed = this.terminal.modes.bracketedPasteMode;
    const data = paths
      .map(
        (path) =>
          `${prepareTerminalPaste(
            formatDroppedFileReference(provider, path),
            bracketed,
          )} `,
      )
      .join("");
    commit({ kind: "text", data });
    if (provider) this.scheduleAgentDiscovery(true);
    return paths.length;
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
    const maximizeAction = this.element.dataset.maximized === "true" ? "복원" : "확대";
    this.maximizeButton.title = `${title} ${maximizeAction}`;
    this.maximizeButton.setAttribute("aria-label", `${title} ${maximizeAction}`);
    this.resizeHandle.setAttribute("aria-label", `${title} 너비 조절`);
  }

  setCompletionPending(completionPending: boolean) {
    const wasCompletionPending = this.completionPending;
    this.completionPending = completionPending;
    if (!completionPending) this.completionAckPending = false;
    this.element.dataset.completionPending = String(completionPending);
    // syncProject can replay the already-persisted `false` value while a newly
    // observed completion is waiting for the output-quiet barrier. Only an
    // actual acknowledged true -> false transition may cancel that barrier.
    if (wasCompletionPending && !completionPending) {
      this.pendingCompletionKey = null;
      window.clearTimeout(this.completionBarrierTimer);
    }
  }

  beginCompletionAcknowledgement() {
    if (!this.completionPending || this.completionAckPending) return false;
    this.completionAckPending = true;
    return true;
  }

  finishCompletionAcknowledgement() {
    this.completionAckPending = false;
  }

  queueAgentCompletion(
    turnKey: string,
    route: PendingAgentCompletionRoute | null = null,
  ) {
    if (this.disposed) return;
    if (
      route &&
      !this.pendingAgentCompletionRoutes.some(
        (pending) =>
          pending.provider === route.provider &&
          pending.runtimeSessionId === route.runtimeSessionId &&
          pending.conversationId.toLowerCase() === route.conversationId.toLowerCase() &&
          ((pending.turnId !== null && pending.turnId === route.turnId) ||
            (pending.turnId === null &&
              route.turnId === null &&
              pending.observedAtUnixMs === route.observedAtUnixMs)),
      )
    ) {
      this.pendingAgentCompletionRoutes.push(route);
    }
    if (this.completionPending) {
      this.observedCompletionKeys.add(turnKey);
      this.acknowledgePendingAgentCompletionRoutes();
      return;
    }
    if (this.observedCompletionKeys.has(turnKey)) return;
    this.observedCompletionKeys.add(turnKey);
    if (this.pendingCompletionKey !== null) return;
    this.pendingCompletionKey = turnKey;
    this.armCompletionBarrier();
  }

  setResizeHandleEnabled(enabled: boolean) {
    this.resizeHandle.hidden = !enabled;
    this.resizeHandle.tabIndex = enabled ? 0 : -1;
  }

  setDragging(dragging: boolean) {
    this.element.dataset.dragging = String(dragging);
  }

  setMaximized(maximized: boolean) {
    this.element.dataset.maximized = String(maximized);
    this.maximizeButton.textContent = maximized ? "▣" : "□";
    this.maximizeButton.title = `${this.title} ${maximized ? "복원" : "확대"}`;
    this.maximizeButton.setAttribute(
      "aria-label",
      `${this.title} ${maximized ? "복원" : "확대"}`,
    );
    this.maximizeButton.setAttribute("aria-pressed", String(maximized));
  }

  setCatalogWritable(writable: boolean) {
    this.catalogWritable = writable;
    this.maximizeButton.disabled = !writable;
    this.closeButton.disabled = !writable;
    if (!writable && !this.titleEditor.hidden) this.cancelTitleEdit();
  }

  scheduleFit(delay = 35) {
    if (this.disposed || this.workspace.shouldDeferFit()) return;
    this.resumeInteractiveLaunchPaintProbeIfVisible();
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
    window.clearTimeout(this.launchProbeExpiryTimer);
    window.clearTimeout(this.launchPaintWatchdogTimer);
    this.launchPaintWatchdog.clear();
    window.clearTimeout(this.outputSettledTimer);
    window.clearTimeout(this.exitGapTimer);
    window.clearTimeout(this.unboundOutputTimer);
    window.clearTimeout(this.completionBarrierTimer);
    window.clearTimeout(this.agentDiscoveryTimer);
    window.clearTimeout(this.resumeHealthTimer);
    this.resizeObserver.disconnect();
    window.removeEventListener("mouseup", this.onWindowMouseUp, true);
    window.removeEventListener("keydown", this.onWindowTerminalKeyDown, true);
    window.removeEventListener("keyup", this.onWindowTerminalKeyUp, true);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("focus", this.onWindowFocus);
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
    this.pendingRenderBatches.length = 0;
    this.selectionCopyGuard.invalidate();
    this.terminal.dispose();
    return stopBarrier;
  }

  private installTerminalInputHandlers() {
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keyup") {
        if (
          this.copyShortcutReleasePending &&
          (isTerminalCopyShortcut(event) || isTerminalCtrlInsertShortcut(event))
        ) {
          this.copyShortcutReleasePending = false;
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
        return true;
      }
      if (event.type !== "keydown") return true;
      if (this.consumeSelectionCopyShortcut(event)) return false;
      if (this.consumeManualTerminalInterruptShortcut(event)) return false;
      if (event.isComposing || event.keyCode === 229) return true;

      const key = String(event.key || "").toLowerCase();
      const commandModifier = event.ctrlKey || event.metaKey;
      if (
        key === "enter" &&
        !event.repeat &&
        !event.altKey &&
        !commandModifier &&
        this.terminal.buffer.active.type === "normal"
      ) {
        this.armInteractiveLaunchPaintProbe();
      }
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
        return false;
      };

      if (isTerminalCtrlInsertShortcut(event)) {
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
      this.terminal.onRender(() => {
        this.terminalPaintedVersion = this.terminalRenderVersion;
        if (this.launchPaintWatchdog.observePaint(this.terminalPaintedVersion)) {
          window.clearTimeout(this.launchPaintWatchdogTimer);
          this.launchPaintWatchdogTimer = 0;
          if (!this.launchPaintWatchdog.isArmed) {
            window.clearTimeout(this.launchProbeExpiryTimer);
            this.launchProbeExpiryTimer = 0;
          }
        }
      }),
      this.terminal.onData((data) => {
        if (this.capturedCursorMoveInput) {
          this.capturedCursorMoveInput.push(data);
          return;
        }
        const selectedCopy = this.selectionCopyGuard.selectionForTerminalInput(
          data,
          this.liveTerminalSelection(),
        );
        if (selectedCopy !== null) {
          void this.copySelection(selectedCopy);
          return;
        }
        // DECSET 9001 makes xterm emit a standalone Control record before the
        // C record. Relay that protocol state without treating it as editing:
        // clearing the selection here would turn the next Ctrl+C into ETX.
        if (isTerminalModifierOnlyInput(data)) {
          this.queueInput({ kind: "text", data });
          return;
        }
        this.forwardTerminalTextInput(data);
      }),
      this.terminal.onBinary((data) => {
        const selectedCopy = this.selectionCopyGuard.selectionForTerminalInput(
          data,
          this.liveTerminalSelection(),
        );
        if (selectedCopy !== null) {
          void this.copySelection(selectedCopy);
          return;
        }
        if (isTerminalModifierOnlyInput(data)) {
          this.queueInput({ kind: "binary", data: binaryStringToRawBytes(data) });
          return;
        }
        this.resumeAutoFollowForUserIntent();
        const bytes = binaryStringToRawBytes(data);
        this.queueInput({ kind: "binary", data: bytes });
        this.scheduleAgentDiscovery(false);
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
        const selection = this.liveTerminalSelection();
        const hasSelection = selection.length > 0;
        if (hasSelection) {
          this.selectionCopyGuard.captureLiveSelection(selection);
        }
        this.copyButton.hidden = !hasSelection;
        if (hasSelection) this.pauseAutoFollow();
      }),
    );

    this.viewport.addEventListener(
      "keydown",
      (event) => {
        if (this.consumeSelectionCopyShortcut(event)) return;
        if (isTerminalInputIntentKey(event, this.terminal.hasSelection())) {
          this.resumeAutoFollowForUserIntent();
        }
      },
      true,
    );

    this.viewport.addEventListener(
      "copy",
      (event) => {
        const selection = this.selectionCopyGuard.selectionForCopy(
          this.liveTerminalSelection(),
        );
        if (selection === null) return;
        if (event.clipboardData) {
          event.clipboardData.setData("text/plain", selection);
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        this.pauseAutoFollow();
      },
      true,
    );

    this.viewport.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY < 0) this.pauseAutoFollow();
      },
      { passive: true },
    );
    this.viewport.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        this.selectionCopyGuard.beginPointerGesture();
        this.cursorClickSnapshot = this.captureCursorClick(event);
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

  private installStableCursorPolicy() {
    // DECSCUSR (CSI Ps SP q) lets full-screen TUIs override the configured
    // xterm cursor. Codex uses cursor updates while repainting its composer;
    // allowing those updates turns the steady bar back into a blinking block
    // and makes the character under it appear to flash. Handle only that
    // sequence and leave cursor visibility/position control to the TUI.
    this.terminalDisposables.push(
      this.terminal.parser.registerCsiHandler(
        { intermediates: " ", final: "q" },
        () => true,
      ),
    );
  }

  private consumeSelectionCopyShortcut(event: KeyboardEvent, immediate = false) {
    const liveSelection = this.liveTerminalSelection();
    const selection = this.selectionCopyGuard.selectionForShortcut(
      event,
      liveSelection,
    );
    if (selection === null) return false;
    this.copyShortcutReleasePending = true;
    event.preventDefault();
    if (immediate) event.stopImmediatePropagation();
    else event.stopPropagation();
    if (!event.repeat) void this.copySelection(selection);
    if (!liveSelection) this.selectionCopyGuard.invalidate();
    return true;
  }

  private ownsTerminalKeyboardEvent(event: KeyboardEvent) {
    if (
      event.composedPath().includes(this.viewport) ||
      this.terminal.textarea === document.activeElement
    ) {
      return true;
    }

    const documentSelection = document.getSelection();
    const nativeTerminalSelection = this.nativeTerminalSelection(documentSelection);
    const hasExternalDocumentSelection = Boolean(
      documentSelection &&
      !documentSelection.isCollapsed &&
      nativeTerminalSelection.length === 0,
    );
    const passiveDocumentTarget =
      event.target === window ||
      event.target === document ||
      event.target === document.body ||
      event.target === document.documentElement;
    const externalEditableTarget = event.composedPath().some(
      (target) =>
        target instanceof Element &&
        !this.viewport.contains(target) &&
        target.matches(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
        ),
    );
    return shouldOwnTerminalCopyFallback({
      paneActive: this.element.dataset.active === "true",
      hasCopySelection: this.selectionCopyGuard.hasCopySelection(
        this.liveTerminalSelection(),
      ),
      passiveDocumentTarget,
      nativeTerminalSelection: nativeTerminalSelection.length > 0,
      externalEditableTarget,
      externalDocumentSelection: hasExternalDocumentSelection,
    });
  }

  private liveTerminalSelection() {
    const terminalSelection = this.terminal.getSelection();
    if (terminalSelection) return terminalSelection;

    return this.nativeTerminalSelection(document.getSelection());
  }

  private nativeTerminalSelection(nativeSelection: Selection | null) {
    if (
      !nativeSelection ||
      nativeSelection.isCollapsed ||
      !nativeSelection.anchorNode ||
      !nativeSelection.focusNode ||
      !this.viewport.contains(nativeSelection.anchorNode) ||
      !this.viewport.contains(nativeSelection.focusNode)
    ) {
      return "";
    }
    return nativeSelection.toString();
  }

  private consumeManualTerminalInterruptShortcut(event: KeyboardEvent) {
    if (
      !shouldManuallySendTerminalInterrupt(event, this.terminal.hasSelection())
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) this.forwardTerminalTextInput("\u0003");
    return true;
  }

  private forwardTerminalTextInput(data: string) {
    this.selectionCopyGuard.invalidate();
    this.armInteractiveLaunchPaintProbeForSubmittedInput(data);
    this.noteEditableUserInput(data);
    this.resumeAutoFollowForUserIntent();
    this.queueInput({ kind: "text", data });
    this.scheduleAgentDiscovery(data.includes("\r") || data.includes("\n"));
  }

  private armInteractiveLaunchPaintProbeForSubmittedInput(data: string) {
    if (
      this.terminal.buffer.active.type === "normal" &&
      (data.includes("\r") || data.includes("\n"))
    ) {
      this.armInteractiveLaunchPaintProbe();
    }
  }

  private armInteractiveLaunchPaintProbe() {
    const epoch = this.lifecycleEpoch;
    window.clearTimeout(this.launchProbeExpiryTimer);
    window.clearTimeout(this.launchPaintWatchdogTimer);
    this.launchPaintWatchdogTimer = 0;
    this.launchPaintWatchdog.arm(epoch);
    this.scheduleInteractiveLaunchProbeExpiry(epoch);
  }

  private scheduleInteractiveLaunchProbeExpiry(epoch: number) {
    window.clearTimeout(this.launchProbeExpiryTimer);
    this.launchProbeExpiryTimer = window.setTimeout(() => {
      this.launchProbeExpiryTimer = 0;
      this.launchPaintWatchdog.expire(epoch);
      window.clearTimeout(this.launchPaintWatchdogTimer);
      this.launchPaintWatchdogTimer = 0;
    }, TERMINAL_LAUNCH_PROBE_TTL_MS);
  }

  private observeInteractiveLaunchOutput(enteredAlternateBuffer: boolean) {
    if (
      !this.launchPaintWatchdog.observeOutput(
        this.lifecycleEpoch,
        this.terminalRenderVersion,
        enteredAlternateBuffer,
        performance.now(),
      )
    ) {
      return;
    }
    this.scheduleInteractiveLaunchPaintWatchdog();
  }

  private scheduleInteractiveLaunchPaintWatchdog() {
    window.clearTimeout(this.launchPaintWatchdogTimer);
    this.launchPaintWatchdogTimer = window.setTimeout(() => {
      this.launchPaintWatchdogTimer = 0;
      if (this.disposed || this.terminalFailed) return;
      if (!this.isTerminalViewportPaintable()) {
        // xterm intentionally pauses its renderer while a project/pane is in
        // the hidden bin. Keep the checkpoint, but never diagnose that pause
        // as a paint stall. scheduleFit/window focus will resume this probe.
        window.clearTimeout(this.launchProbeExpiryTimer);
        this.launchProbeExpiryTimer = 0;
        return;
      }
      const decision = this.launchPaintWatchdog.poll(
        this.lifecycleEpoch,
        this.terminalPaintedVersion,
        this.terminal.modes.synchronizedOutputMode,
        performance.now(),
      );
      if (decision === "waiting") {
        this.scheduleInteractiveLaunchPaintWatchdog();
      } else if (decision === "recover") {
        window.clearTimeout(this.launchProbeExpiryTimer);
        this.launchProbeExpiryTimer = 0;
        this.launchPaintWatchdog.clear();
        this.recoverInteractiveLaunchPaint();
      }
    }, TERMINAL_PAINT_WATCHDOG_POLL_MS);
  }

  private resumeInteractiveLaunchPaintProbeIfVisible() {
    if (
      !this.launchPaintWatchdog.hasPendingPaint ||
      !this.isTerminalViewportPaintable()
    ) {
      return;
    }
    if (this.launchProbeExpiryTimer === 0) {
      this.scheduleInteractiveLaunchProbeExpiry(this.lifecycleEpoch);
    }
    if (this.launchPaintWatchdogTimer === 0) {
      this.scheduleInteractiveLaunchPaintWatchdog();
    }
  }

  private isTerminalViewportPaintable() {
    return (
      document.visibilityState === "visible" &&
      this.element.isConnected &&
      !this.element.hidden &&
      this.viewport.clientWidth >= 2 &&
      this.viewport.clientHeight >= 2 &&
      this.element.getClientRects().length > 0
    );
  }

  private recoverInteractiveLaunchPaint() {
    if (!this.isTerminalViewportPaintable()) return;
    this.fitTerminal();
    this.queueCurrentSize();
    // @xterm/xterm is intentionally pinned to 6.1.0-beta.290. Its public
    // refresh API is rAF-debounced, which cannot release a frame whose rAF is
    // itself wedged in WebView2. Use the pinned core's synchronous refresh only
    // for this single, bounded launch recovery and retain the public fallback.
    const core = (
      this.terminal as unknown as {
        _core?: { refresh(start: number, end: number, sync?: boolean): void };
      }
    )._core;
    try {
      if (core?.refresh) core.refresh(0, Math.max(0, this.terminal.rows - 1), true);
      else this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
    } catch {
      this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
    }
  }

  private noteEditableUserInput(data: string) {
    if (data.includes("\r") || data.includes("\n")) {
      this.editableAnchorColumn = null;
      this.cursorClickSnapshot = null;
      return;
    }
    // Keyboard protocol records and navigation keys start with ESC. They must
    // never arm click-to-move merely because their payload contains '[' or a
    // printable key name.
    if (data.startsWith("\u001b")) return;
    const containsPrintable = [...data].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    });
    if (containsPrintable && this.editableAnchorColumn === null) {
      this.editableAnchorColumn = this.terminal.buffer.active.cursorX;
    }
  }

  private captureCursorClick(event: MouseEvent): CursorClickSnapshot | null {
    if (
      !event.isTrusted ||
      event.detail > 1 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      this.editableAnchorColumn === null ||
      this.paneState !== "running" ||
      this.terminal.hasSelection() ||
      !this.isAtBottom() ||
      this.terminal.modes.mouseTrackingMode !== "none" ||
      !this.terminal.modes.showCursor
    ) {
      return null;
    }

    const buffer = this.terminal.buffer.active;
    const dimensions = this.terminal.dimensions;
    const screen = this.viewport.querySelector<HTMLElement>(".xterm-screen");
    if (
      buffer.type !== "normal" ||
      !dimensions ||
      !screen ||
      !(event.target instanceof Node) ||
      !screen.contains(event.target)
    ) {
      return null;
    }
    const cellWidth = dimensions.css.cell.width;
    const cellHeight = dimensions.css.cell.height;
    if (cellWidth <= 0 || cellHeight <= 0) return null;

    const screenBounds = screen.getBoundingClientRect();
    const targetRow = Math.floor((event.clientY - screenBounds.top) / cellHeight);
    if (targetRow !== buffer.cursorY) return null;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (!line) return null;

    let lineEndColumn = buffer.cursorX;
    for (let column = 0; column < this.terminal.cols; column += 1) {
      const cell = line.getCell(column);
      if (cell?.getChars()) {
        lineEndColumn = Math.max(lineEndColumn, column + Math.max(1, cell.getWidth()));
      }
    }
    let targetColumn = Math.round((event.clientX - screenBounds.left) / cellWidth);
    targetColumn = Math.max(
      this.editableAnchorColumn,
      Math.min(lineEndColumn, targetColumn),
    );
    while (targetColumn > this.editableAnchorColumn) {
      const cell = line.getCell(targetColumn);
      if (!cell || cell.getWidth() !== 0) break;
      targetColumn -= 1;
    }

    return {
      clientX: event.clientX,
      clientY: event.clientY,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      targetColumn,
      lineFingerprint: line.translateToString(false, 0, this.terminal.cols),
      renderVersion: this.terminalRenderVersion,
    };
  }

  private moveCursorFromClick(
    snapshot: CursorClickSnapshot,
    release: {
      clientX: number;
      clientY: number;
      detail: number;
      isTrusted: boolean;
      hasModifier: boolean;
      insideViewport: boolean;
    },
  ) {
    const pointerDrift = Math.hypot(
      release.clientX - snapshot.clientX,
      release.clientY - snapshot.clientY,
    );
    if (
      this.disposed ||
      this.paneState !== "running" ||
      !release.isTrusted ||
      release.detail > 1 ||
      release.hasModifier ||
      !release.insideViewport ||
      pointerDrift > CURSOR_CLICK_MAX_POINTER_DRIFT_PX ||
      this.terminal.hasSelection() ||
      !this.isAtBottom() ||
      this.terminal.modes.mouseTrackingMode !== "none" ||
      !this.terminal.modes.showCursor ||
      this.terminalRenderVersion !== snapshot.renderVersion
    ) {
      return;
    }

    const buffer = this.terminal.buffer.active;
    if (
      buffer.type !== "normal" ||
      buffer.cursorX !== snapshot.cursorX ||
      buffer.cursorY !== snapshot.cursorY ||
      buffer.baseY !== snapshot.baseY ||
      buffer.viewportY !== snapshot.viewportY
    ) {
      return;
    }
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (
      !line ||
      line.translateToString(false, 0, this.terminal.cols) !== snapshot.lineFingerprint
    ) {
      return;
    }

    const direction = snapshot.targetColumn < buffer.cursorX ? "ArrowLeft" : "ArrowRight";
    const start = Math.min(snapshot.targetColumn, buffer.cursorX);
    const end = Math.max(snapshot.targetColumn, buffer.cursorX);
    let keystrokes = 0;
    for (let column = start; column < end; ) {
      const width = line.getCell(column)?.getWidth() ?? 1;
      if (width > 0) keystrokes += 1;
      column += Math.max(1, width);
    }
    if (keystrokes === 0 || keystrokes > CURSOR_CLICK_MAX_KEYSTROKES) return;

    const textarea = this.terminal.textarea;
    if (!textarea || this.capturedCursorMoveInput) return;
    const captured: string[] = [];
    this.capturedCursorMoveInput = captured;
    try {
      for (let index = 0; index < keystrokes; index += 1) {
        textarea.dispatchEvent(createTerminalArrowEvent("keydown", direction));
        textarea.dispatchEvent(createTerminalArrowEvent("keyup", direction));
      }
    } finally {
      this.capturedCursorMoveInput = null;
    }

    // xterm emits keyboard data synchronously. Queue the complete movement as
    // one PTY write so Win32/Kitty key-down and key-up records cannot interleave
    // with output or another user action.
    const encodedMovement = captured.join("");
    if (!encodedMovement) return;
    this.resumeAutoFollowForUserIntent();
    this.queueInput({ kind: "text", data: encodedMovement });
    this.scheduleAgentDiscovery(false);
  }

  private handleTerminalEvent(message: TerminalEvent, epoch: number) {
    if (this.disposed || epoch !== this.lifecycleEpoch) return;

    switch (message.event) {
      case "started":
        if (this.terminatedSessionIds.has(message.data.sessionId)) return;
        if (!this.bindSession(message.data.sessionId)) return;
        this.setState("running", "");
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
    this.scheduleResumeHealthCheck();
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
    this.scheduleAgentDiscovery(false);
    let ready: OutputBatch[];
    try {
      ready = this.outputSequencer.accept(batch);
    } catch (error) {
      this.failProtocol(String(error), [batch.sessionId]);
      return false;
    }

    if (ready.length > 0) {
      this.pendingRenderBatches.push(...ready);
      this.scheduleRenderDrain();
    }
    if (this.pendingExit && this.outputSequencer.isFinalReady) {
      this.scheduleExitBarrier();
    }
    return true;
  }

  private scheduleRenderDrain() {
    if (this.renderDrainScheduled || this.disposed || this.terminalFailed) return;
    this.renderDrainScheduled = true;
    this.renderQueue = this.renderQueue.then(() => this.drainPendingRenderBatches());
  }

  private async drainPendingRenderBatches() {
    let rendering: OutputBatch[] = [];
    try {
      // A Codex TUI redraw can cross the Rust output dispatcher's 8 ms batch
      // boundary. Briefly collect adjacent batches so xterm never paints the
      // intermediate cleared composer between those fragments.
      await delay(OUTPUT_RENDER_COALESCE_MS);
      while (!this.disposed && !this.terminalFailed && this.pendingRenderBatches.length > 0) {
        rendering = this.takePendingRenderBatches();
        await this.renderOutputBatches(rendering);
        rendering = [];
        if (this.pendingRenderBatches.length > 0) {
          await delay(OUTPUT_RENDER_COALESCE_MS);
        }
      }
    } catch (error) {
      const failed = [...rendering, ...this.pendingRenderBatches];
      this.pendingRenderBatches.length = 0;
      this.failTerminal(
        `출력 렌더링 실패: ${String(error)}`,
        [...new Set(failed.map((item) => item.sessionId))],
      );
    } finally {
      this.renderDrainScheduled = false;
      if (this.pendingRenderBatches.length > 0) this.scheduleRenderDrain();
    }
  }

  private takePendingRenderBatches() {
    let count = 0;
    let bytes = 0;
    for (const batch of this.pendingRenderBatches) {
      const nextBytes = outputEncoder.encode(batch.data).byteLength;
      if (count > 0 && bytes + nextBytes > OUTPUT_RENDER_MAX_BYTES) break;
      count += 1;
      bytes += nextBytes;
    }
    return this.pendingRenderBatches.splice(0, Math.max(1, count));
  }

  private async renderOutputBatches(batches: readonly OutputBatch[]) {
    if (this.disposed || this.terminalFailed) return;
    const shouldFollow = this.canAutoFollow() && this.isAtBottom();
    const writeEpoch = this.interactionEpoch;
    const data = batches.map((batch) => batch.data).join("");
    const bufferTypeBeforeWrite = this.terminal.buffer.active.type;

    await new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        this.terminalRenderVersion += batches.length;
        this.observeInteractiveLaunchOutput(
          bufferTypeBeforeWrite !== "alternate" &&
            this.terminal.buffer.active.type === "alternate",
        );
        if (
          !this.disposed &&
          !this.terminalFailed &&
          shouldFollow &&
          writeEpoch === this.interactionEpoch &&
          this.canAutoFollow() &&
          !this.isAtBottom()
        ) {
          this.terminal.scrollToBottom();
        }
        this.lastRenderedOutputAt = performance.now();
        if (this.pendingCompletionKey) this.armCompletionBarrier();
        resolve();
      });
    });

    if (this.disposed || this.terminalFailed) return;
    let sequenceToAck: number | null = null;
    try {
      for (const batch of batches) {
        sequenceToAck = this.ackPolicy.noteRendered(batch.sequence) ?? sequenceToAck;
      }
    } catch (error) {
      this.failProtocol(
        String(error),
        [...new Set(batches.map((batch) => batch.sessionId))],
      );
      return;
    }
    if (sequenceToAck !== null) {
      void this.sendCumulativeAck(batches[0].sessionId, sequenceToAck);
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
    if (!this.isAtBottom()) this.terminal.scrollToBottom();
  }

  private scheduleSettledFollow(shouldFollow: boolean, writeEpoch: number) {
    window.clearTimeout(this.outputSettledTimer);
    if (!shouldFollow || this.disposed) return;
    this.outputSettledTimer = window.setTimeout(() => {
      this.terminal.write("", () => {
        if (
          !this.disposed &&
          writeEpoch === this.interactionEpoch &&
          this.canAutoFollow() &&
          !this.isAtBottom()
        ) {
          this.terminal.scrollToBottom();
        }
      });
    }, OUTPUT_SETTLED_DELAY_MS);
  }

  private async copySelection(retainedText?: string) {
    const text = retainedText ?? this.terminal.getSelection();
    if (!text) return false;
    this.pauseAutoFollow();
    try {
      await invoke("write_clipboard_text", { text });
      return true;
    } catch (nativeError) {
      const clipboardEventSucceeded = this.copySelectionThroughClipboardEvent(text);
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        if (clipboardEventSucceeded) return true;
        this.setStatusOnly(`복사 실패: ${String(nativeError)}`, "error");
        return false;
      }
    }
  }

  private copySelectionThroughClipboardEvent(text: string) {
    let clipboardDataWritten = false;
    const onCopy = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      clipboardDataWritten = true;
    };
    document.addEventListener("copy", onCopy, true);
    try {
      return document.execCommand("copy") && clipboardDataWritten;
    } catch {
      return false;
    } finally {
      document.removeEventListener("copy", onCopy, true);
    }
  }

  private pasteClipboard() {
    // Start one native clipboard snapshot immediately, but reserve the PTY
    // input slot in the next task. xterm finalizes a
    // Korean IME composition with its own setTimeout(0); this fence lets that
    // committed onData reserve its slot before Ctrl+V without intercepting any
    // composition event ourselves.
    const clipboardRead = Promise.race([
      this.readClipboardInput(),
      delay(CLIPBOARD_READ_TIMEOUT_MS).then(() => {
        throw new Error("클립보드 응답 시간이 초과되었습니다.");
      }),
    ]);
    const inputReady = clipboardRead.then(
      (input) => ({ input, error: null as unknown }),
      (error: unknown) => ({ input: null, error }),
    );
    window.setTimeout(() => {
      if (this.disposed) return;
      this.workspace.acknowledgePaneCompletion(this.id);
      this.resumeAutoFollowForUserIntent();
      const commit = this.reserveInputSlot();
      if (!commit) return;
      void inputReady.then(({ input, error }) => {
        if (input?.kind === "text") {
          this.armInteractiveLaunchPaintProbeForSubmittedInput(input.data);
        }
        commit(input);
        if (error && !this.disposed) {
          this.setStatusOnly(`붙여넣기 실패: ${String(error)}`, "error");
        }
      });
    }, 0);
  }

  private scheduleResumeHealthCheck() {
    if (
      this.resumePlan.action !== "resume" ||
      !this.resumePlan.provider ||
      !this.resumePlan.conversationId ||
      !this.sessionId ||
      this.disposed ||
      this.terminalFailed
    ) {
      return;
    }
    window.clearTimeout(this.resumeHealthTimer);
    const delayMs =
      RESUME_HEALTH_DELAYS_MS[this.resumeHealthAttempt] ??
      RESUME_HEALTH_FINAL_RECHECK_MS;
    this.resumeHealthAttempt += 1;
    const sessionId = this.sessionId;
    const expectedProvider = this.resumePlan.provider;
    this.resumeHealthTimer = window.setTimeout(async () => {
      this.resumeHealthTimer = 0;
      if (this.disposed || this.terminalFailed || this.sessionId !== sessionId) return;
      const detected = await invoke<AgentProvider | null>("detect_terminal_agent", {
        sessionId,
      }).catch(() => null);
      if (this.disposed || this.terminalFailed || this.sessionId !== sessionId) return;
      if (detected === expectedProvider) {
        this.resumeHealthMisses = 0;
        if (this.resumeHealthAttempt < RESUME_HEALTH_DELAYS_MS.length) {
          this.scheduleResumeHealthCheck();
        }
        return;
      }
      if (detected !== null) {
        await this.detachFailedResume(sessionId, detected);
        return;
      }
      this.resumeHealthMisses += 1;
      if (
        this.resumeHealthAttempt < RESUME_HEALTH_DELAYS_MS.length ||
        this.resumeHealthMisses < 2
      ) {
        this.scheduleResumeHealthCheck();
        return;
      }
      await this.detachFailedResume(sessionId, null);
    }, delayMs);
  }

  private async detachFailedResume(
    sessionId: string,
    detectedProvider: AgentProvider | null,
  ) {
    await invoke("unbind_agent_session", { sessionId }).catch(() => undefined);
    if (this.disposed || this.terminalFailed || this.sessionId !== sessionId) return;
    this.agentConversationBound = false;
    this.agentConversationId = null;
    this.agentProvider = detectedProvider;
    this.clearAgentContextUsage();
    this.resumeHealthMisses = 0;
    this.setStatusOnly(
      detectedProvider
        ? "실행 중인 CLI 대화를 다시 연결하는 중"
        : "자동 대화 복구가 끝나 PowerShell 상태로 전환됨",
      "normal",
    );
    this.scheduleAgentDiscovery(true);
  }

  private scheduleAgentDiscovery(reset: boolean) {
    if (
      this.disposed ||
      this.terminalFailed ||
      !this.sessionId ||
      this.paneState !== "running"
    ) {
      return;
    }
    if (this.agentConversationBound) {
      if (this.agentDiscoveryPending || this.agentDiscoveryTimer !== 0) return;
      const elapsed = Date.now() - this.agentDiscoveryLastAttemptAt;
      const delayMs = reset
        ? 200
        : Math.max(200, AGENT_REBIND_PROBE_INTERVAL_MS - elapsed);
      this.agentDiscoveryTimer = window.setTimeout(() => {
        this.agentDiscoveryTimer = 0;
        void this.discoverAgentConversation();
      }, delayMs);
      return;
    }
    if (reset) {
      this.agentDiscoveryAttempts = 0;
      window.clearTimeout(this.agentDiscoveryTimer);
      this.agentDiscoveryTimer = 0;
    }
    if (
      this.agentDiscoveryAttempts >= AGENT_DISCOVERY_DELAYS_MS.length &&
      Date.now() - this.agentDiscoveryLastAttemptAt >= AGENT_DISCOVERY_REARM_MS
    ) {
      this.agentDiscoveryAttempts = 0;
    }
    if (
      this.agentDiscoveryAttempts >= AGENT_DISCOVERY_DELAYS_MS.length &&
      this.agentProvider === "codex" &&
      !this.agentDiscoveryPending &&
      this.agentDiscoveryTimer === 0
    ) {
      const remainingMs = Math.max(
        250,
        AGENT_DISCOVERY_REARM_MS - (Date.now() - this.agentDiscoveryLastAttemptAt),
      );
      this.agentDiscoveryTimer = window.setTimeout(() => {
        this.agentDiscoveryTimer = 0;
        this.agentDiscoveryAttempts = 0;
        void this.discoverAgentConversation();
      }, remainingMs);
      return;
    }
    if (
      this.agentDiscoveryPending ||
      this.agentDiscoveryTimer !== 0 ||
      this.agentDiscoveryAttempts >= AGENT_DISCOVERY_DELAYS_MS.length
    ) {
      return;
    }

    const delayMs = AGENT_DISCOVERY_DELAYS_MS[this.agentDiscoveryAttempts];
    this.agentDiscoveryAttempts += 1;
    this.agentDiscoveryTimer = window.setTimeout(() => {
      this.agentDiscoveryTimer = 0;
      void this.discoverAgentConversation();
    }, delayMs);
  }

  private async discoverAgentConversation() {
    const sessionId = this.sessionId;
    const wasBound = this.agentConversationBound;
    if (
      !sessionId ||
      this.disposed ||
      this.terminalFailed ||
      this.agentDiscoveryPending
    ) {
      return;
    }

    this.agentDiscoveryPending = true;
    this.agentDiscoveryLastAttemptAt = Date.now();
    let retry = false;
    try {
      const discovered = await invoke<AgentDiscoveryResponse | null>(
        "discover_agent_conversation",
        {
          request: {
            sessionId,
            terminalKey: {
              projectId: this.projectId,
              terminalId: this.terminalId,
            },
            cwd: this.startDirectory,
            notBeforeUnixMs: this.runtimeStartedAtUnixMs,
            providerHint: this.agentProvider,
          },
        },
      );
      if (!discovered) {
        const detected = await invoke<AgentProvider | null>("detect_terminal_agent", {
          sessionId,
        }).catch(() => null);
        if (detected === "codex" || detected === "grok") {
          this.agentProvider = detected;
        }
        retry = !wasBound;
        return;
      }

      const { binding, completionObservedAtUnixMs } = discovered;
      if (
        binding.runtimeSessionId !== sessionId ||
        binding.terminalKey.projectId !== this.projectId ||
        binding.terminalKey.terminalId !== this.terminalId ||
        (binding.provider !== "codex" && binding.provider !== "grok") ||
        typeof binding.conversationId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          binding.conversationId,
        ) ||
        (completionObservedAtUnixMs !== null &&
          (!Number.isSafeInteger(completionObservedAtUnixMs) ||
            completionObservedAtUnixMs < 0))
      ) {
        throw new Error("에이전트 대화 검색 응답이 올바르지 않습니다.");
      }

      if (
        wasBound &&
        completionObservedAtUnixMs === null &&
        this.matchesAgentConversation(binding.provider, binding.conversationId)
      ) {
        return;
      }

      const saved = await this.workspace.associateAgentConversation(
        this.projectId,
        this.terminalId,
        sessionId,
        binding.provider,
        binding.conversationId,
        completionObservedAtUnixMs,
      );
      if (saved) {
        this.setAgentConversation(binding.provider, binding.conversationId);
      } else {
        // Discovery itself does not mutate the backend binding. In particular,
        // keep the old binding alive when persisting an exact /new, /fork, or
        // resume switch fails; the next probe can retry without losing alerts
        // from the conversation that is still durably associated.
        retry = true;
      }
    } catch (error) {
      retry = true;
      if (!this.disposed && this.sessionId === sessionId) {
        this.setStatusOnly(`대화 자동 연결 재시도 중: ${String(error)}`, "error");
      }
    } finally {
      this.agentDiscoveryPending = false;
      if (retry) this.scheduleAgentDiscovery(false);
    }
  }

  private armCompletionBarrier() {
    window.clearTimeout(this.completionBarrierTimer);
    const key = this.pendingCompletionKey;
    if (!key || this.disposed || this.completionPending) return;
    const quietFor = performance.now() - this.lastRenderedOutputAt;
    const delayMs = Math.max(0, COMPLETION_OUTPUT_QUIET_MS - quietFor);
    this.completionBarrierTimer = window.setTimeout(() => {
      if (
        this.disposed ||
        this.completionPending ||
        this.pendingCompletionKey !== key
      ) {
        return;
      }
      if (performance.now() - this.lastRenderedOutputAt < COMPLETION_OUTPUT_QUIET_MS) {
        this.armCompletionBarrier();
        return;
      }
      this.renderQueue
        .then(() => nextAnimationFrame())
        .then(() => {
          if (
            !this.disposed &&
            !this.completionPending &&
            this.pendingCompletionKey === key
          ) {
            return this.workspace.commitPaneCompletion(this.id);
          }
          return false;
        })
        .then((saved) => {
          if (!saved) {
            this.completionBarrierTimer = window.setTimeout(
              () => this.armCompletionBarrier(),
              1_000,
            );
            return;
          }
          this.pendingCompletionKey = null;
          this.acknowledgePendingAgentCompletionRoutes();
        })
        .catch(() => undefined);
    }, delayMs);
  }

  private acknowledgePendingAgentCompletionRoutes() {
    const routes = this.pendingAgentCompletionRoutes.splice(0);
    for (const route of routes) {
      this.acknowledgeAgentCompletionRoute(route, 0);
    }
  }

  private acknowledgeAgentCompletionRoute(
    route: PendingAgentCompletionRoute,
    attempt: number,
  ) {
    const acknowledgement =
      route.provider === "codex"
        ? invoke<boolean>("acknowledge_codex_completion", {
            sessionId: route.runtimeSessionId,
            conversationId: route.conversationId,
            turnId: route.turnId,
            observedAtUnixMs: route.observedAtUnixMs,
          })
        : invoke<boolean>("acknowledge_grok_completion", {
            runtimeSessionId: route.runtimeSessionId,
            conversationId: route.conversationId,
            observedAtUnixMs: route.observedAtUnixMs,
          });
    void acknowledgement
      .then((acknowledged) => {
        if (!acknowledged) this.retryAgentCompletionRoute(route, attempt);
      })
      .catch(() => this.retryAgentCompletionRoute(route, attempt));
  }

  private retryAgentCompletionRoute(
    route: PendingAgentCompletionRoute,
    attempt: number,
  ) {
    const delayMs = COMPLETION_ROUTE_ACK_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined || this.disposed) return;
    window.setTimeout(
      () => this.acknowledgeAgentCompletionRoute(route, attempt + 1),
      delayMs,
    );
  }

  private async readClipboardInput(): Promise<TerminalInput | null> {
    const snapshot = normalizeClipboardSnapshot(
      await invoke<unknown>("read_clipboard_snapshot"),
    );

    if (snapshot.kind === "image") {
      let provider: AgentProvider | null = null;
      if (this.sessionId) {
        const detected = await invoke<AgentProvider | null>("detect_terminal_agent", {
          sessionId: this.sessionId,
        }).catch(() => null);
        if (detected === "codex" || detected === "grok") {
          provider = detected;
          if (
            this.agentProvider &&
            this.agentProvider !== detected &&
            this.agentConversationBound
          ) {
            await invoke("unbind_agent_session", { sessionId: this.sessionId }).catch(
              () => undefined,
            );
            this.agentConversationBound = false;
            this.agentConversationId = null;
            this.clearAgentContextUsage();
          }
          this.agentProvider = detected;
        }
      }
      const sequence = selectClipboardImageSequence(provider);
      if (!sequence) {
        this.setStatusOnly(
          "이미지를 붙여넣으려면 이 PowerShell에서 Codex 또는 Grok을 먼저 실행하세요.",
          "error",
        );
        return null;
      }
      this.scheduleAgentDiscovery(true);
      return { kind: "text", data: sequence };
    }

    if (snapshot.kind === "empty" || !snapshot.text) return null;
    return {
      kind: "text",
      data: prepareTerminalPaste(snapshot.text, this.terminal.modes.bracketedPasteMode),
    };
  }

  private async detectDroppedFileProvider(): Promise<AgentProvider | null> {
    const sessionId = this.sessionId;
    if (!sessionId) return null;
    const timedOut = Symbol("agent detection timed out");
    const detected = await Promise.race([
      invoke<AgentProvider | null>("detect_terminal_agent", { sessionId }).catch(
        () => null,
      ),
      delay(750).then(() => timedOut),
    ]);
    if (detected === timedOut) return this.agentProvider;
    if (detected === "codex" || detected === "grok") {
      this.agentProvider = detected;
      return detected;
    }
    return null;
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
        window.clearTimeout(this.resumeHealthTimer);
        this.resumeHealthTimer = 0;
        this.workspace.releaseSession(exit.sessionId, this.id);
        if (this.sessionId === exit.sessionId) this.sessionId = null;
        if (exit.exitCode !== null && exit.exitCode !== 0) {
          this.notifyPhoneErrorOnce();
        }
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
    window.clearTimeout(this.launchProbeExpiryTimer);
    window.clearTimeout(this.launchPaintWatchdogTimer);
    this.launchProbeExpiryTimer = 0;
    this.launchPaintWatchdogTimer = 0;
    this.launchPaintWatchdog.clear();
    window.clearTimeout(this.exitGapTimer);
    window.clearTimeout(this.unboundOutputTimer);
    window.clearTimeout(this.resumeHealthTimer);
    this.resumeHealthTimer = 0;
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
    if (state === "error") this.notifyPhoneErrorOnce();
  }

  private notifyPhoneErrorOnce() {
    if (this.disposed || this.phoneErrorNotifiedEpoch === this.lifecycleEpoch) return;
    this.phoneErrorNotifiedEpoch = this.lifecycleEpoch;
    const labels = this.workspace.phoneNotificationLabels(
      this.projectId,
      this.terminalId,
    );
    if (labels) {
      void phoneNotifications.sendBackground(
        "error",
        createPhoneNotificationEventId("terminal"),
        labels,
      );
    } else {
      console.warn("Discord notification skipped: terminal label mapping unavailable");
    }
  }

  private setStatusOnly(message: string, tone: StatusTone) {
    this.statusMessage = message;
    this.statusTone = tone;
    this.stateLabel.textContent = message;
    this.stateLabel.title = message;
    this.stateLabel.hidden = message.length === 0;
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

class BrowserPane {
  readonly id: string;
  readonly persistentId: string;
  readonly projectId: string;
  title: string;
  readonly element: HTMLElement;

  private readonly viewport: HTMLElement;
  private readonly address: HTMLInputElement;
  private readonly titleElement: HTMLElement;
  private readonly titleEditor: HTMLInputElement;
  private readonly stateLabel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly resizeHandle: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private webview: Webview | null = null;
  private generation = 0;
  private fitTimer = 0;
  private disposed = false;
  private layoutVisible = false;
  private interactionSuspended = false;
  private catalogWritable = true;
  private currentUrl: string;
  private statusMessage = "브라우저 준비 중";
  private statusTone: StatusTone = "normal";
  private operationQueue: Promise<void> = Promise.resolve();
  private boundsQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: TerminalWorkspace,
    projectId: string,
    savedState: WorkspaceBrowserPane,
    private readonly sequence: number,
  ) {
    this.projectId = projectId;
    this.persistentId = savedState.id;
    this.id = browserPaneRuntimeId(projectId, savedState.id);
    this.title = savedState.title;
    this.currentUrl = savedState.url;

    this.element = document.createElement("article");
    this.element.className = "terminal-pane browser-pane";
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
    this.titleElement = document.createElement("span");
    this.titleElement.className = "terminal-title";
    this.titleElement.textContent = this.title;
    this.titleElement.title = "더블 클릭하여 이름 변경";
    this.titleEditor = document.createElement("input");
    this.titleEditor.className = "terminal-title-editor";
    this.titleEditor.maxLength = 80;
    this.titleEditor.hidden = true;
    this.titleEditor.setAttribute("aria-label", "웹 패널 이름");
    this.stateLabel = document.createElement("span");
    this.stateLabel.className = "terminal-state-label";
    this.stateLabel.textContent = this.statusMessage;
    heading.append(this.titleElement, this.titleEditor, this.stateLabel);
    const actions = document.createElement("div");
    actions.className = "terminal-actions";
    this.closeButton = document.createElement("button");
    this.closeButton.className = "terminal-window-action terminal-close";
    this.closeButton.type = "button";
    this.closeButton.textContent = "×";
    this.closeButton.title = `${this.title} 닫기`;
    this.closeButton.setAttribute("aria-label", `${this.title} 닫기`);
    actions.append(this.closeButton);
    header.append(stateDot, heading, actions);

    const navigation = document.createElement("form");
    navigation.className = "browser-navigation";
    this.address = document.createElement("input");
    this.address.className = "browser-address";
    this.address.type = "text";
    this.address.value = this.currentUrl;
    this.address.spellcheck = false;
    this.address.autocomplete = "off";
    this.address.setAttribute("aria-label", "웹 주소");
    const go = document.createElement("button");
    go.className = "browser-go";
    go.type = "submit";
    go.textContent = "→";
    go.title = "이동";
    go.setAttribute("aria-label", "주소로 이동");
    navigation.append(this.address, go);

    this.viewport = document.createElement("div");
    this.viewport.className = "browser-viewport";
    const placeholder = document.createElement("div");
    placeholder.className = "browser-placeholder";
    placeholder.textContent = "브라우저를 불러오는 중입니다.";
    this.viewport.append(placeholder);

    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "terminal-resize-handle";
    this.resizeHandle.dataset.paneInteraction = "resize";
    this.resizeHandle.hidden = true;
    this.resizeHandle.tabIndex = -1;
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-orientation", "vertical");
    this.resizeHandle.setAttribute("aria-label", `${this.title} 너비 조절`);
    this.element.append(header, navigation, this.viewport, this.resizeHandle);

    this.closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.workspace.closeBrowserPane(this.id);
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
      this.workspace.activatePane(this.id, true);
    });
    header.addEventListener("pointerdown", (event) => {
      this.workspace.beginPaneDrag(event, this.id, header);
    });
    this.resizeHandle.addEventListener("pointerdown", (event) => {
      this.workspace.beginPaneResize(event, this.id, this.resizeHandle);
    });
    navigation.addEventListener("pointerdown", (event) => event.stopPropagation());
    navigation.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.navigate(this.address.value);
    });

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.viewport);
  }

  get status() {
    return { message: this.statusMessage, tone: this.statusTone } as const;
  }

  start() {
    this.navigate(this.address.value, false);
  }

  focus() {
    if (this.disposed) return;
    if (this.webview && this.layoutVisible && !this.interactionSuspended) {
      void this.webview.setFocus().catch(() => undefined);
    } else {
      this.address.focus();
    }
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

  setCatalogWritable(writable: boolean) {
    this.catalogWritable = writable;
    this.closeButton.disabled = !writable;
    this.titleEditor.disabled = !writable;
  }

  setResizeHandleEnabled(enabled: boolean) {
    this.resizeHandle.hidden = !enabled;
    this.resizeHandle.tabIndex = enabled ? 0 : -1;
  }

  setDragging(dragging: boolean) {
    this.element.dataset.dragging = String(dragging);
  }

  setLayoutVisible(visible: boolean) {
    if (this.disposed || this.layoutVisible === visible) return;
    this.layoutVisible = visible;
    if (!visible) {
      void this.webview?.hide().catch(() => undefined);
      return;
    }
    this.scheduleFit(0);
  }

  setInteractionSuspended(suspended: boolean) {
    if (this.disposed || this.interactionSuspended === suspended) return;
    this.interactionSuspended = suspended;
    if (suspended) {
      void this.webview?.hide().catch(() => undefined);
      return;
    }
    this.scheduleFit(0);
  }

  scheduleFit(delay = 35) {
    if (this.disposed) return;
    window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => this.scheduleBoundsSync(), delay);
  }

  async captureCurrentUrl(): Promise<void> {
    const webview = this.webview;
    if (this.disposed || !this.catalogWritable || !webview) return;
    let observed: string | null;
    try {
      observed = await invoke<string | null>("read_browser_webview_url", {
        label: webview.label,
      });
    } catch {
      return;
    }
    if (this.disposed || this.webview !== webview || !observed) return;
    let url: string;
    try {
      url = normalizeBrowserUrl(observed);
    } catch {
      return;
    }
    if (url === this.currentUrl) return;
    const saved = await this.workspace.updateBrowserPaneUrl(this.id, url);
    if (!saved || this.disposed || this.webview !== webview) return;
    this.currentUrl = url;
    if (document.activeElement !== this.address) this.address.value = url;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    window.clearTimeout(this.fitTimer);
    this.resizeObserver.disconnect();
    await this.operationQueue.catch(() => undefined);
    await this.boundsQueue.catch(() => undefined);
    const webview = this.webview;
    this.webview = null;
    if (webview) {
      await webview.hide().catch(() => undefined);
      await webview.close().catch(() => undefined);
    }
  }

  private navigate(rawUrl: string, persist = true) {
    if (this.disposed) return;
    let url: string;
    try {
      url = normalizeBrowserUrl(rawUrl);
    } catch (error) {
      this.setState("error", errorMessage(error), "error");
      this.address.focus();
      this.address.select();
      return;
    }
    this.address.value = url;
    this.operationQueue = this.operationQueue
      .then(async () => {
        if (persist && url !== this.currentUrl) {
          const saved = await this.workspace.updateBrowserPaneUrl(this.id, url);
          if (!saved || this.disposed) {
            if (!this.disposed) this.address.value = this.currentUrl;
            return;
          }
        }
        this.currentUrl = url;
        await this.replaceWebview(url);
      })
      .catch((error) => {
        if (!this.disposed) this.setState("error", `브라우저 열기 실패: ${errorMessage(error)}`, "error");
      });
  }

  private async replaceWebview(url: string) {
    const generation = ++this.generation;
    const previous = this.webview;
    this.webview = null;
    this.setState("starting", "페이지 불러오는 중");
    if (previous) {
      await previous.hide().catch(() => undefined);
      await previous.close().catch(() => undefined);
    }
    if (this.disposed || generation !== this.generation) return;
    await nextAnimationFrame();
    const bounds = this.viewport.getBoundingClientRect();
    const label = `ihc-browser-${this.sequence}-${generation}`;
    const webview = new Webview(getCurrentWindow(), label, {
      url,
      x: Math.max(0, Math.round(bounds.left)),
      y: Math.max(0, Math.round(bounds.top)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
      focus: this.layoutVisible && !this.interactionSuspended,
    });
    this.webview = webview;
    let created: () => void = () => undefined;
    let failed: (error: Error) => void = () => undefined;
    const creation = new Promise<void>((resolve, reject) => {
      created = resolve;
      failed = reject;
    });
    const [removeCreated, removeError] = await Promise.all([
      webview.once("tauri://created", created),
      webview.once<string>("tauri://error", (event) => failed(new Error(String(event.payload)))),
    ]);
    try {
      await Promise.race([creation, delay(250).then(() => waitForWebview(label, 5_750))]);
      if (this.disposed || generation !== this.generation || this.webview !== webview) {
        await webview.close().catch(() => undefined);
        return;
      }
      this.setState("running", "웹 브라우저");
      await this.syncBounds(generation, webview);
    } catch (error) {
      if (this.webview === webview) this.webview = null;
      await webview.hide().catch(() => undefined);
      await webview.close().catch(() => undefined);
      throw error;
    } finally {
      removeCreated();
      removeError();
    }
  }

  private scheduleBoundsSync() {
    if (this.disposed) return;
    const generation = this.generation;
    const webview = this.webview;
    if (!webview) return;
    this.boundsQueue = this.boundsQueue
      .then(() => this.syncBounds(generation, webview))
      .catch((error) => {
        if (!this.disposed && generation === this.generation) {
          this.setState("error", `브라우저 배치 실패: ${errorMessage(error)}`, "error");
        }
      });
  }

  private async syncBounds(generation: number, webview: Webview) {
    if (this.disposed || generation !== this.generation || this.webview !== webview) return;
    if (
      !this.layoutVisible ||
      this.interactionSuspended ||
      this.element.hidden ||
      !this.element.isConnected
    ) {
      await webview.hide().catch(() => undefined);
      return;
    }
    const bounds = this.viewport.getBoundingClientRect();
    if (bounds.width < 2 || bounds.height < 2) {
      await webview.hide().catch(() => undefined);
      return;
    }
    await webview.setPosition(
      new LogicalPosition(Math.round(bounds.left), Math.round(bounds.top)),
    );
    if (this.disposed || generation !== this.generation || this.webview !== webview) return;
    await webview.setSize(
      new LogicalSize(Math.round(bounds.width), Math.round(bounds.height)),
    );
    if (this.disposed || generation !== this.generation || this.webview !== webview) return;
    await webview.show();
  }

  private setState(state: PaneState, message: string, tone: StatusTone = "normal") {
    this.element.dataset.state = state;
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
    void this.workspace.renameBrowserPane(this.id, title);
  }

  private cancelTitleEdit() {
    this.titleEditor.hidden = true;
    this.titleElement.hidden = false;
    this.titleEditor.value = this.title;
    this.focus();
  }
}

type LayoutPane = TerminalPane | BrowserPane;

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
  originalOrder: string[];
  slots: PaneGeometry[];
  sourceSlotIndex: number;
  previewOrder: string[];
  acceptedSlotIndex: number;
  candidateSlotIndex: number;
  previousAcceptedSlotIndex: number;
  candidateSinceMs: number;
  lastAcceptedX: number;
  lastAcceptedY: number;
  lastAcceptedVectorX: number;
  lastAcceptedVectorY: number;
  hasValidDrop: boolean;
  layoutFrozen: boolean;
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
  private readonly browserPanes = new Map<string, BrowserPane>();
  private readonly sessionOwners = new Map<string, string>();
  private readonly scheduler = new StartScheduler();
  private readonly restoredProjects = new Set<string>();
  private readonly projectNames = new Map<string, string>();
  private readonly projectOrders = new Map<string, string[]>();
  private readonly projectRatios = new Map<string, Record<string, number[]>>();
  private readonly resumePlans = new Map<string, SafeResumePlan>();
  private readonly activeRows = new Map<string, ActiveTerminalRow>();
  private readonly rowsHost = document.createElement("div");
  private readonly inactivePaneBin = document.createElement("div");
  private readonly interactionOverlay = document.createElement("div");
  private readonly insertionLine = document.createElement("div");
  private readonly snapGuide = document.createElement("div");
  private readonly browserSuspensionReasons = new Set<string>();
  private activePaneId: string | null = null;
  private activeProjectId: string | null = null;
  private maximizedPaneId: string | null = null;
  private workspaceView: "empty" | "terminals" = "empty";
  private browserSequence = 0;
  private catalogWritable = false;
  private disposed = false;
  private nativeFileDropScaleFactor = Math.max(1, window.devicePixelRatio || 1);
  private nativeFileDropRegistrationEpoch = 0;
  private nativeFileDropTargetPaneId: string | null = null;
  private nativeFileDropCount = 0;
  private readonly nativeFileDropUnlisteners: Array<() => void> = [];
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
      this.finishPaneDrag(false, event);
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
      return;
    }
    if (
      event.key === "Enter" &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      this.activePaneId &&
      this.panes.has(this.activePaneId) &&
      !(
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable='true']")
      )
    ) {
      event.preventDefault();
      this.togglePaneMaximize(this.activePaneId);
    }
  };
  private readonly onLayoutWindowBlur = () => this.cancelLayoutInteraction();

  constructor(
    private readonly app: HTMLElement,
    private readonly terminalSurface: HTMLElement,
    private readonly addButton: HTMLButtonElement,
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
    private readonly onBrowserPaneClosedCallback: (
      projectId: string,
      paneId: string,
    ) => Promise<boolean>,
    private readonly onBrowserPaneRenamedCallback: (
      projectId: string,
      paneId: string,
      title: string,
    ) => Promise<boolean>,
    private readonly onBrowserPaneUrlChangedCallback: (
      projectId: string,
      paneId: string,
      url: string,
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
    private readonly onAgentConversationDiscoveredCallback: (
      projectId: string,
      terminalId: string,
      provider: AgentProvider,
      conversationId: string,
    ) => Promise<boolean>,
    private readonly onTerminalAgentWorkingChangedCallback: (
      projectId: string,
      terminalId: string,
      working: boolean,
    ) => void,
    private readonly onPaneCompletionCallback: (
      projectId: string,
      terminalId: string,
    ) => Promise<boolean>,
    private readonly onPaneCompletionAcknowledgedCallback: (
      projectId: string,
      terminalId: string,
    ) => Promise<boolean>,
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
    this.installNativeFileDrop();
  }

  private installNativeFileDrop() {
    const registrationEpoch = ++this.nativeFileDropRegistrationEpoch;
    const appWindow = getCurrentWindow();
    void appWindow
      .scaleFactor()
      .then((scaleFactor) => {
        if (!this.disposed && registrationEpoch === this.nativeFileDropRegistrationEpoch) {
          this.nativeFileDropScaleFactor = Math.max(1, scaleFactor);
        }
      })
      .catch(() => undefined);
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => this.handleNativeFileDrop(payload))
      .then((unlisten) => {
        if (this.disposed || registrationEpoch !== this.nativeFileDropRegistrationEpoch) {
          unlisten();
          return;
        }
        this.nativeFileDropUnlisteners.push(unlisten);
      })
      .catch((error) => {
        if (!this.disposed) {
          this.setFooterStatus(`파일 드롭 초기화 실패: ${errorMessage(error)}`, "error");
        }
      });
    void appWindow
      .onScaleChanged(({ payload }) => {
        this.nativeFileDropScaleFactor = Math.max(1, payload.scaleFactor);
      })
      .then((unlisten) => {
        if (this.disposed || registrationEpoch !== this.nativeFileDropRegistrationEpoch) {
          unlisten();
          return;
        }
        this.nativeFileDropUnlisteners.push(unlisten);
      })
      .catch(() => undefined);
  }

  private handleNativeFileDrop(payload: DragDropEvent) {
    if (this.disposed) return;
    if (payload.type === "leave") {
      this.clearNativeFileDropTarget();
      return;
    }

    if (payload.type === "enter") {
      this.nativeFileDropCount = selectDroppedFilePaths(payload.paths).paths.length;
      this.updateNativeFileDropTarget(payload.position);
      return;
    }
    if (payload.type === "over") {
      this.updateNativeFileDropTarget(payload.position);
      return;
    }

    const selection = selectDroppedFilePaths(payload.paths);
    const pane = this.terminalPaneAtNativeDropPosition(payload.position);
    this.clearNativeFileDropTarget();
    if (!pane) {
      this.setFooterStatus("파일을 첨부할 PowerShell 창 위에 놓아주세요.", "error");
      return;
    }
    if (selection.paths.length === 0) {
      this.setFooterStatus("첨부할 수 있는 파일 경로가 없습니다.", "error");
      return;
    }

    this.activatePane(pane.id, false);
    void pane.attachDroppedFiles(selection.paths).then((attached) => {
      if (this.disposed) return;
      if (attached === 0) {
        this.setFooterStatus("실행 중인 PowerShell 창에만 파일을 첨부할 수 있습니다.", "error");
        return;
      }
      const skipped = selection.skipped > 0 ? ` · ${selection.skipped}개 제외` : "";
      this.setFooterStatus(
        `${pane.title} 프롬프트에 ${attached}개 파일을 추가했습니다${skipped}.`,
      );
    });
  }

  private updateNativeFileDropTarget(
    position: Extract<DragDropEvent, { type: "over" }>["position"],
  ) {
    const pane = this.terminalPaneAtNativeDropPosition(position);
    if (pane?.id === this.nativeFileDropTargetPaneId) {
      pane?.setFileDropTarget(true, this.nativeFileDropCount);
      return;
    }
    this.clearNativeFileDropTarget(false);
    if (!pane) return;
    this.nativeFileDropTargetPaneId = pane.id;
    pane.setFileDropTarget(true, this.nativeFileDropCount);
  }

  private terminalPaneAtNativeDropPosition(
    position: Extract<DragDropEvent, { type: "over" }>["position"],
  ): TerminalPane | null {
    const logical = position.toLogical(this.nativeFileDropScaleFactor);
    const element = document.elementFromPoint(logical.x, logical.y);
    const paneElement = element?.closest<HTMLElement>(".terminal-pane");
    const paneId = paneElement?.dataset.paneId;
    const pane = paneId ? this.panes.get(paneId) : undefined;
    if (!pane || pane.element.hidden || pane.projectId !== this.activeProjectId) return null;
    return pane;
  }

  private clearNativeFileDropTarget(resetFileCount = true) {
    if (this.nativeFileDropTargetPaneId) {
      this.panes.get(this.nativeFileDropTargetPaneId)?.setFileDropTarget(false);
    }
    this.nativeFileDropTargetPaneId = null;
    if (resetFileCount) this.nativeFileDropCount = 0;
  }

  addPane(projectId: string, savedState: WorkspaceTerminal, focus = true) {
    if (this.disposed) return null;
    const existing = this.panes.get(paneRuntimeId(projectId, savedState.id));
    if (existing) return existing;
    const projectPaneCount = this.projectPaneCount(projectId);
    if (projectPaneCount >= MAX_PROJECT_PANES) {
      this.setFooterStatus(
        `PowerShell은 프로젝트마다 최대 ${MAX_PROJECT_PANES}개까지 열 수 있습니다.`,
        "error",
      );
      return null;
    }
    const plan = this.resumePlans.get(paneRuntimeId(projectId, savedState.id)) ?? {
      projectId,
      terminalId: savedState.id,
      action: "shell",
      provider: null,
      conversationId: null,
      candidates: [],
      blockingReasons: [],
      duplicateOwners: [],
    };
    const pane = new TerminalPane(this, this.scheduler, projectId, savedState, plan);
    pane.setCatalogWritable(this.catalogWritable);
    this.panes.set(pane.id, pane);
    const order = this.projectOrders.get(projectId) ?? [];
    if (!order.includes(pane.id)) this.projectOrders.set(projectId, [...order, pane.id]);
    pane.element.hidden = projectId !== this.activeProjectId;
    this.inactivePaneBin.append(pane.element);
    if (projectId === this.activeProjectId && focus) {
      this.maximizedPaneId = null;
      this.activatePane(pane.id, false);
    }
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

  addBrowserPane(
    projectId: string,
    savedState: WorkspaceBrowserPane,
    focus = true,
  ) {
    if (
      this.disposed ||
      !this.catalogWritable ||
      projectId !== this.activeProjectId
    ) {
      return null;
    }
    const existing = this.browserPanes.get(browserPaneRuntimeId(projectId, savedState.id));
    if (existing) return existing;
    if (this.projectPaneCount(projectId) >= MAX_PROJECT_PANES) {
      this.setFooterStatus(
        `터미널과 브라우저는 프로젝트마다 최대 ${MAX_PROJECT_PANES}개까지 열 수 있습니다.`,
        "error",
      );
      return null;
    }
    const pane = new BrowserPane(this, projectId, savedState, ++this.browserSequence);
    pane.setCatalogWritable(this.catalogWritable);
    pane.setInteractionSuspended(this.browserSuspensionReasons.size > 0);
    this.browserPanes.set(pane.id, pane);
    const order = this.projectOrders.get(projectId) ?? [];
    if (!order.includes(pane.id)) this.projectOrders.set(projectId, [...order, pane.id]);
    this.inactivePaneBin.append(pane.element);
    if (focus) {
      this.maximizedPaneId = null;
      this.activePaneId = pane.id;
    }
    this.updateLayout();
    for (const visible of this.visiblePanes()) {
      visible.setActive(focus && visible.id === pane.id);
    }
    pane.start();
    if (focus) requestAnimationFrame(() => pane.focus());
    this.renderActiveStatus();
    return pane;
  }

  restoreCapacity(
    project: WorkspaceProject,
    unloadingProjectId: string | null = null,
  ) {
    const current =
      project.id === unloadingProjectId
        ? 0
        : this.projectPaneCount(project.id);
    const targetRemainsRestored =
      this.restoredProjects.has(project.id) && project.id !== unloadingProjectId;
    const incoming = targetRemainsRestored
      ? 0
      : project.terminals.length + projectBrowserPanes(project).length;
    return evaluateWorkspaceRestoreCapacity(current, incoming, MAX_PROJECT_PANES);
  }

  canAddPane(projectId: string) {
    return (
      !this.disposed &&
      this.catalogWritable &&
      projectId === this.activeProjectId &&
      this.projectPaneCount(projectId) < MAX_PROJECT_PANES
    );
  }

  startPriority(projectId: string) {
    return projectId === this.activeProjectId && this.workspaceView === "terminals"
      ? 100
      : 0;
  }

  syncProject(project: WorkspaceProject) {
    this.projectNames.set(project.id, project.name);
    const savedBrowsers = projectBrowserPanes(project);
    const orderedTerminals = project.terminals.map((terminal) =>
      paneRuntimeId(project.id, terminal.id),
    );
    const orderedBrowsers = savedBrowsers.map((browser) =>
      browserPaneRuntimeId(project.id, browser.id),
    );
    const terminalIds = new Set(orderedTerminals);
    const browserIds = new Set(orderedBrowsers);
    const previous = this.projectOrders.get(project.id) ?? [];
    let terminalIndex = 0;
    const ordered = previous
      .map((paneId) => {
        if (terminalIds.has(paneId)) return orderedTerminals[terminalIndex++] ?? null;
        return browserIds.has(paneId) ? paneId : null;
      })
      .filter((paneId): paneId is string => paneId !== null);
    ordered.push(...orderedTerminals.slice(terminalIndex));
    ordered.push(...orderedBrowsers.filter((paneId) => !ordered.includes(paneId)));
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
        if (existing) {
          existing.setTitle(terminal.name);
          existing.setCompletionPending(terminal.completionPending);
        }
        else this.addPane(project.id, terminal, false);
      }
      for (const browser of savedBrowsers) {
        const existing = this.browserPanes.get(browserPaneRuntimeId(project.id, browser.id));
        if (existing) existing.setTitle(browser.title);
        else this.addBrowserPane(project.id, browser, false);
      }
      for (const existing of [...this.browserPanes.values()]) {
        if (existing.projectId === project.id && !browserIds.has(existing.id)) {
          this.browserPanes.delete(existing.id);
          existing.element.remove();
          void existing.dispose();
        }
      }
    }
  }

  setResumePlans(plans: SafeResumePlan[]) {
    this.resumePlans.clear();
    for (const plan of plans) {
      this.resumePlans.set(
        paneRuntimeId(plan.projectId, plan.terminalId),
        plan,
      );
    }
  }

  showProject(project: WorkspaceProject) {
    if (this.disposed) return false;
    this.projectNames.set(project.id, project.name);
    this.cancelLayoutInteraction();
    const capacity = this.restoreCapacity(project);
    if (!capacity.allowed) {
      this.setFooterStatus(
        `${project.name}을 열려면 PowerShell ${capacity.incoming}개 슬롯이 필요하지만 ` +
          `${capacity.available}개만 남았습니다. 이 프로젝트의 PowerShell 수를 줄이고 다시 시도하세요.`,
        "error",
      );
      return false;
    }
    const projectChanged = this.activeProjectId !== project.id;
    if (projectChanged) this.maximizedPaneId = null;
    this.activeProjectId = project.id;
    for (const pane of this.allPanes()) {
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
      for (const browser of projectBrowserPanes(project)) {
        if (!this.addBrowserPane(project.id, browser, false)) {
          void this.unloadProject(project.id);
          this.setFooterStatus(`${project.name} 웹 패널 복원을 완료하지 못했습니다.`, "error");
          return false;
        }
      }
      this.restoredProjects.add(project.id);
    }

    const visible = this.visiblePanes();
    const prior = this.activePaneId ? this.layoutPane(this.activePaneId) : null;
    this.activePaneId =
      !projectChanged && prior?.projectId === project.id ? prior.id : null;
    for (const pane of visible) pane.setActive(pane.id === this.activePaneId);
    this.workspaceView = "terminals";
    this.app.dataset.workspaceView = "terminals";
    this.updateLayout();
    this.renderActiveStatus();
    return true;
  }

  showEmptyView() {
    if (this.disposed) return;
    this.cancelLayoutInteraction();
    this.activeProjectId = null;
    this.activePaneId = null;
    this.maximizedPaneId = null;
    for (const pane of this.allPanes()) {
      pane.element.hidden = true;
      pane.setActive(false);
    }
    this.workspaceView = "empty";
    this.app.dataset.workspaceView = "empty";
    this.updateLayout();
    this.setFooterStatus("왼쪽에서 프로젝트를 선택하세요.");
  }

  setCatalogWritable(writable: boolean) {
    if (this.disposed) return;
    this.catalogWritable = writable;
    for (const pane of this.allPanes()) pane.setCatalogWritable(writable);
    this.updateControls();
  }

  phoneNotificationLabels(
    projectId: string,
    terminalId: string,
  ): PhoneNotificationLabels | null {
    const projectName = this.projectNames.get(projectId);
    const pane = this.panes.get(paneRuntimeId(projectId, terminalId));
    if (!projectName || !pane) return null;
    return { projectName, terminalName: pane.title };
  }

  clearActivePane() {
    if (this.disposed) return;
    if (this.activePaneId === null) return;
    this.activePaneId = null;
    for (const pane of this.visiblePanes()) pane.setActive(false);
    this.renderActiveStatus();
  }

  async unloadProject(projectId: string) {
    if (this.disposed) return;
    this.cancelLayoutInteraction();
    const targets = [...this.panes.values()].filter(
      (pane) => pane.projectId === projectId,
    );
    const browserTargets = [...this.browserPanes.values()].filter(
      (pane) => pane.projectId === projectId,
    );
    for (const pane of targets) {
      this.onTerminalAgentWorkingChangedCallback(
        pane.projectId,
        pane.terminalId,
        false,
      );
      this.panes.delete(pane.id);
      pane.element.remove();
    }
    for (const pane of browserTargets) {
      this.browserPanes.delete(pane.id);
      pane.element.remove();
    }
    this.restoredProjects.delete(projectId);
    this.projectNames.delete(projectId);
    this.projectOrders.delete(projectId);
    this.projectRatios.delete(projectId);
    if ([...targets, ...browserTargets].some((pane) => pane.id === this.maximizedPaneId)) {
      this.maximizedPaneId = null;
    }
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
      this.activePaneId = null;
    } else if ([...targets, ...browserTargets].some((pane) => pane.id === this.activePaneId)) {
      this.activePaneId = null;
    }
    const stops = Promise.all([...targets, ...browserTargets].map((pane) => pane.dispose())).then(
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
    const projectIds = [...new Set(this.allPanes().map((pane) => pane.projectId))];
    for (const projectId of projectIds) await this.unloadProject(projectId);
  }

  async captureBrowserPaneUrls() {
    if (this.disposed || !this.catalogWritable) return;
    // Persist sequentially so each compare-and-swap observes the revision from
    // the previous browser instead of producing cross-pane revision conflicts.
    for (const pane of [...this.browserPanes.values()]) {
      await pane.captureCurrentUrl();
    }
  }

  async closePane(paneId: string): Promise<void> {
    if (!this.catalogWritable) return;
    const pane = this.panes.get(paneId);
    if (!pane) return;

    const orderedIds = this.visiblePanes().map((item) => item.id);
    const removedIndex = orderedIds.indexOf(paneId);
    const saved = await this.onPaneClosedCallback(pane.projectId, pane.terminalId);
    if (!saved || this.disposed || !this.panes.has(paneId)) return;

    this.onTerminalAgentWorkingChangedCallback(
      pane.projectId,
      pane.terminalId,
      false,
    );
    this.panes.delete(paneId);
    if (this.maximizedPaneId === paneId) this.maximizedPaneId = null;
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
      requestAnimationFrame(() => this.layoutPane(this.activePaneId ?? "")?.focus());
    }
  }

  async closeBrowserPane(paneId: string): Promise<void> {
    if (!this.catalogWritable) return;
    const pane = this.browserPanes.get(paneId);
    if (!pane) return;
    const orderedIds = this.visiblePanes().map((item) => item.id);
    const removedIndex = orderedIds.indexOf(paneId);
    const saved = await this.onBrowserPaneClosedCallback(
      pane.projectId,
      pane.persistentId,
    );
    if (!saved || this.disposed || this.browserPanes.get(paneId) !== pane) return;
    this.browserPanes.delete(paneId);
    if (this.maximizedPaneId === paneId) this.maximizedPaneId = null;
    const order = this.projectOrders.get(pane.projectId) ?? [];
    this.projectOrders.set(
      pane.projectId,
      order.filter((candidate) => candidate !== paneId),
    );
    pane.element.remove();
    if (this.activePaneId === paneId) {
      const remainingIds = this.visiblePanes().map((item) => item.id);
      this.activePaneId =
        remainingIds[Math.min(Math.max(0, removedIndex), remainingIds.length - 1)] ?? null;
    }
    for (const item of this.visiblePanes()) item.setActive(item.id === this.activePaneId);
    this.updateLayout();
    this.renderActiveStatus();
    await pane.dispose();
    if (this.workspaceView === "terminals" && this.activePaneId) {
      requestAnimationFrame(() => this.layoutPane(this.activePaneId ?? "")?.focus());
    }
  }

  activatePane(paneId: string, suppressFocus: boolean) {
    const selected = this.layoutPane(paneId);
    if (!selected || selected.projectId !== this.activeProjectId || selected.element.hidden) {
      return;
    }
    this.activePaneId = paneId;
    for (const pane of this.visiblePanes()) pane.setActive(pane.id === paneId);
    this.renderActiveStatus();
    if (!suppressFocus && this.workspaceView === "terminals") {
      selected.focus();
    }
  }

  togglePaneMaximize(paneId: string) {
    if (this.disposed || !this.catalogWritable) return;
    const pane = this.panes.get(paneId);
    if (!pane || pane.projectId !== this.activeProjectId) return;
    this.cancelLayoutInteraction();
    this.maximizedPaneId = this.maximizedPaneId === paneId ? null : paneId;
    this.activePaneId = paneId;
    this.updateLayout();
    for (const visible of this.visiblePanes()) {
      visible.setActive(visible.id === paneId);
    }
    this.renderActiveStatus();
    requestAnimationFrame(() => pane.focus());
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

  async renameBrowserPane(paneId: string, title: string): Promise<void> {
    if (!this.catalogWritable) return;
    const pane = this.browserPanes.get(paneId);
    if (!pane) return;
    const previousTitle = pane.title;
    pane.setTitle(title);
    const saved = await this.onBrowserPaneRenamedCallback(
      pane.projectId,
      pane.persistentId,
      title,
    );
    if (!saved && !this.disposed && this.browserPanes.get(paneId) === pane) {
      pane.setTitle(previousTitle);
    }
    this.renderActiveStatus();
  }

  updateBrowserPaneUrl(paneId: string, url: string): Promise<boolean> {
    if (!this.catalogWritable) return Promise.resolve(false);
    const pane = this.browserPanes.get(paneId);
    if (!pane) return Promise.resolve(false);
    return this.onBrowserPaneUrlChangedCallback(
      pane.projectId,
      pane.persistentId,
      url,
    );
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
      const pane = this.panes.get(paneId);
      if (pane) {
        this.onTerminalAgentWorkingChangedCallback(
          pane.projectId,
          pane.terminalId,
          false,
        );
      }
    }
  }

  async associateAgentConversation(
    projectId: string,
    terminalId: string,
    runtimeSessionId: string,
    provider: AgentProvider,
    conversationId: string,
    completionObservedAtUnixMs: number | null,
  ) {
    const paneId = paneRuntimeId(projectId, terminalId);
    const pane = this.panes.get(paneId);
    if (!pane?.ownsRuntimeSession(runtimeSessionId)) return false;

    const saved = await this.onAgentConversationDiscoveredCallback(
      projectId,
      terminalId,
      provider,
      conversationId,
    );
    if (
      !saved ||
      this.disposed ||
      this.panes.get(paneId) !== pane ||
      !pane.ownsRuntimeSession(runtimeSessionId)
    ) {
      return false;
    }

    const binding = await invoke<AgentDiscoveryResponse["binding"]>(
      "bind_agent_session",
      {
        sessionId: runtimeSessionId,
        terminalKey: { projectId, terminalId },
        resume: { provider, conversationId },
        replayNotBeforeUnixMs: pane.runtimeStartTime,
      },
    );
    if (
      binding.runtimeSessionId !== runtimeSessionId ||
      binding.terminalKey.projectId !== projectId ||
      binding.terminalKey.terminalId !== terminalId ||
      binding.provider !== provider ||
      binding.conversationId.toLowerCase() !== conversationId.toLowerCase()
    ) {
      await invoke("unbind_agent_session", { sessionId: runtimeSessionId }).catch(
        () => undefined,
      );
      throw new Error("저장된 에이전트 대화를 실행 세션에 연결하지 못했습니다.");
    }

    pane.setAgentConversation(provider, conversationId);
    if (completionObservedAtUnixMs !== null) {
      pane.queueAgentCompletion(
        [provider, conversationId.toLowerCase(), completionObservedAtUnixMs].join(":"),
        {
          provider,
          runtimeSessionId,
          conversationId,
          turnId: null,
          observedAtUnixMs: completionObservedAtUnixMs,
        },
      );
    }
    return true;
  }

  setAgentTurnWorking(
    projectId: string,
    terminalId: string,
    runtimeSessionId: string,
    provider: AgentProvider,
    conversationId: string,
    working: boolean,
  ) {
    const pane = this.panes.get(paneRuntimeId(projectId, terminalId));
    if (
      !pane?.ownsRuntimeSession(runtimeSessionId) ||
      !pane.matchesAgentConversation(provider, conversationId)
    ) {
      return false;
    }
    this.onTerminalAgentWorkingChangedCallback(projectId, terminalId, working);
    return true;
  }

  setAgentContextUsage(
    projectId: string,
    terminalId: string,
    runtimeSessionId: string,
    provider: AgentProvider,
    conversationId: string,
    usedTokens: number,
    windowTokens: number,
    remainingPercent: number,
  ) {
    const pane = this.panes.get(paneRuntimeId(projectId, terminalId));
    if (!pane?.ownsRuntimeSession(runtimeSessionId)) return false;
    return pane.setAgentContextUsage(
      provider,
      conversationId,
      usedTokens,
      windowTokens,
      remainingPercent,
    );
  }

  queueAgentCompletion(
    projectId: string,
    terminalId: string,
    runtimeSessionId: string,
    provider: AgentProvider,
    conversationId: string,
    turnKey: string,
    route: PendingAgentCompletionRoute | null = null,
  ) {
    const pane = this.panes.get(paneRuntimeId(projectId, terminalId));
    if (
      pane?.ownsRuntimeSession(runtimeSessionId) &&
      pane.matchesAgentConversation(provider, conversationId)
    ) {
      pane.queueAgentCompletion(turnKey, route);
    }
  }

  commitPaneCompletion(paneId: string): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (!pane) return Promise.resolve(false);
    return this.onPaneCompletionCallback(pane.projectId, pane.terminalId);
  }

  acknowledgePaneCompletion(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane?.beginCompletionAcknowledgement()) return;
    void this.onPaneCompletionAcknowledgedCallback(
      pane.projectId,
      pane.terminalId,
    ).finally(() => pane.finishCompletionAcknowledgement());
  }

  setTerminalCompletionPending(
    projectId: string,
    terminalId: string,
    completionPending: boolean,
    playSound = false,
  ) {
    this.panes
      .get(paneRuntimeId(projectId, terminalId))
      ?.setCompletionPending(completionPending);
    if (completionPending && playSound) {
      void invoke("play_completion_sound").catch(() => undefined);
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
      event.detail > 1 ||
      this.maximizedPaneId !== null ||
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
    const pane = this.layoutPane(paneId);
    if (!pane || pane.projectId !== this.activeProjectId || pane.element.hidden) return;
    const visible = this.visiblePanes();
    if (visible.length < 2) return;
    const slots = visible.map((candidate) => {
      const rect = candidate.element.getBoundingClientRect();
      return {
        paneId: candidate.id,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });
    if (slots.some((slot) => slot.width < 1 || slot.height < 1)) return;
    const originalOrder = visible.map((candidate) => candidate.id);
    const sourceSlotIndex = originalOrder.indexOf(paneId);
    if (sourceSlotIndex < 0) return;
    const now = performance.now();
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
      originalOrder,
      slots,
      sourceSlotIndex,
      previewOrder: [...originalOrder],
      acceptedSlotIndex: sourceSlotIndex,
      candidateSlotIndex: sourceSlotIndex,
      previousAcceptedSlotIndex: -1,
      candidateSinceMs: now,
      lastAcceptedX: event.clientX,
      lastAcceptedY: event.clientY,
      lastAcceptedVectorX: 0,
      lastAcceptedVectorY: 0,
      hasValidDrop: false,
      layoutFrozen: false,
      frame: 0,
    };
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window-level pointer listeners remain active if capture is unavailable.
    }
  }

  beginPaneResize(event: PointerEvent, paneId: string, captureTarget: HTMLElement) {
    if (
      this.disposed ||
      !this.catalogWritable ||
      event.button !== 0 ||
      this.maximizedPaneId !== null ||
      this.dragState !== null ||
      this.resizeState !== null
    ) {
      return;
    }
    const pane = this.layoutPane(paneId);
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
          .map((candidateId) => this.layoutPane(candidateId)?.element.getBoundingClientRect().right)
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
    this.setBrowserSuspensionReason("layout-interaction", true);
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
      if (
        Math.abs(state.latestX - state.originX) < PANE_DRAG_START_DISTANCE_PX &&
        Math.abs(state.latestY - state.originY) < PANE_DRAG_START_DISTANCE_PX
      ) {
        return;
      }
      state.started = true;
      this.freezePaneDragLayout(state);
      this.layoutPane(state.paneId)?.setDragging(true);
      this.setBrowserSuspensionReason("layout-interaction", true);
      document.body.dataset.paneDragging = "true";
    }
    event.preventDefault();
    if (!state.frame) {
      state.frame = requestAnimationFrame(() => this.renderPaneDragFrame());
    }
  }

  private renderPaneDragFrame(forceCandidate = false) {
    const state = this.dragState;
    if (!state?.started) return;
    state.frame = 0;
    const pane = this.layoutPane(state.paneId);
    if (!pane) return;
    pane.element.style.transform = `translate3d(${state.latestX - state.originX}px, ${
      state.latestY - state.originY
    }px, 0)`;
    const surfaceRect = this.terminalSurface.getBoundingClientRect();
    if (!rectContainsPoint(surfaceRect, state.latestX, state.latestY)) {
      state.hasValidDrop = false;
      state.candidateSlotIndex = state.acceptedSlotIndex;
      state.candidateSinceMs = performance.now();
      this.insertionLine.hidden = true;
      return;
    }

    state.hasValidDrop = true;
    const sourceSlot = state.slots[state.sourceSlotIndex];
    if (!sourceSlot) return;
    const draggedCenter = {
      x:
        sourceSlot.left +
        sourceSlot.width / 2 +
        state.latestX -
        state.originX,
      y:
        sourceSlot.top +
        sourceSlot.height / 2 +
        state.latestY -
        state.originY,
    };
    let nearestSlotIndex = closestPaneSlotIndex(draggedCenter, state.slots);
    const acceptedSlot = state.slots[state.acceptedSlotIndex];
    const nearestSlot = state.slots[nearestSlotIndex];
    if (!acceptedSlot || !nearestSlot) return;
    if (
      nearestSlotIndex !== state.acceptedSlotIndex &&
      distanceToPaneCenter(draggedCenter, nearestSlot) +
        PANE_DRAG_SLOT_HYSTERESIS_PX >=
        distanceToPaneCenter(draggedCenter, acceptedSlot)
    ) {
      nearestSlotIndex = state.acceptedSlotIndex;
    }

    const now = performance.now();
    if (nearestSlotIndex === state.acceptedSlotIndex) {
      state.candidateSlotIndex = nearestSlotIndex;
      state.candidateSinceMs = now;
      this.showAcceptedPaneInsertionLine(state);
      return;
    }
    if (nearestSlotIndex !== state.candidateSlotIndex) {
      state.candidateSlotIndex = nearestSlotIndex;
      state.candidateSinceMs = now;
      if (!forceCandidate) {
        this.showAcceptedPaneInsertionLine(state);
        return;
      }
    }

    const movementX = state.latestX - state.lastAcceptedX;
    const movementY = state.latestY - state.lastAcceptedY;
    const movementLength = Math.hypot(movementX, movementY);
    if (
      movementLength < PANE_DRAG_MINIMUM_REORDER_DISTANCE_PX ||
      (!forceCandidate && now - state.candidateSinceMs < PANE_DRAG_CANDIDATE_HOLD_MS)
    ) {
      this.showAcceptedPaneInsertionLine(state);
      return;
    }
    if (
      nearestSlotIndex === state.previousAcceptedSlotIndex &&
      Math.hypot(state.lastAcceptedVectorX, state.lastAcceptedVectorY) >=
        PANE_DRAG_MINIMUM_REORDER_DISTANCE_PX &&
      vectorAngleRadians(
        state.lastAcceptedVectorX,
        state.lastAcceptedVectorY,
        movementX,
        movementY,
      ) < PANE_DRAG_BOUNCE_BACK_ANGLE_RADIANS
    ) {
      this.showAcceptedPaneInsertionLine(state);
      return;
    }

    state.previewOrder = buildPaneDragPreviewOrder(
      state.originalOrder,
      state.paneId,
      nearestSlotIndex,
    );
    this.applyPaneDragPreview(state);
    state.previousAcceptedSlotIndex = state.acceptedSlotIndex;
    state.acceptedSlotIndex = nearestSlotIndex;
    state.candidateSlotIndex = nearestSlotIndex;
    state.candidateSinceMs = now;
    state.lastAcceptedVectorX = movementX;
    state.lastAcceptedVectorY = movementY;
    state.lastAcceptedX = state.latestX;
    state.lastAcceptedY = state.latestY;
    this.showAcceptedPaneInsertionLine(state);
  }

  private finishPaneDrag(cancelled: boolean, releaseEvent: PointerEvent | null = null) {
    const state = this.dragState;
    if (!state) return;
    if (releaseEvent) {
      state.latestX = releaseEvent.clientX;
      state.latestY = releaseEvent.clientY;
    }
    if (state.frame) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    }
    if (!cancelled && state.started) this.renderPaneDragFrame(true);
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
    const pane = this.layoutPane(state.paneId);
    if (pane) pane.setDragging(false);
    if (!state.started) {
      this.setBrowserSuspensionReason("layout-interaction", false);
      return;
    }
    this.clearPaneDragLayout(state);
    const changed =
      !cancelled &&
      state.hasValidDrop &&
      !samePaneOrder(state.originalOrder, state.previewOrder);
    const next = changed ? state.previewOrder : state.originalOrder;
    this.projectOrders.set(state.projectId, [...next]);
    this.updateLayout();
    this.setBrowserSuspensionReason("layout-interaction", false);
    if (changed && pane instanceof TerminalPane) {
      const movedIndex = next.indexOf(pane.id);
      const nextTerminal = next
        .slice(movedIndex + 1)
        .map((candidateId) => this.panes.get(candidateId))
        .find((candidate) => candidate !== undefined);
      this.onPaneReorderedCallback(state.projectId, pane.terminalId, {
        beforePaneId: nextTerminal?.terminalId ?? null,
      });
    }
  }

  private freezePaneDragLayout(state: PaneDragState) {
    if (state.layoutFrozen) return;
    for (const slot of state.slots) {
      const pane = this.layoutPane(slot.paneId);
      if (!pane) continue;
      const style = pane.element.style;
      pane.element.dataset.dragFrozen = "true";
      style.position = "fixed";
      style.left = `${slot.left}px`;
      style.top = `${slot.top}px`;
      style.width = `${slot.width}px`;
      style.height = `${slot.height}px`;
    }
    state.layoutFrozen = true;
  }

  private applyPaneDragPreview(state: PaneDragState) {
    state.previewOrder.forEach((paneId, index) => {
      if (paneId === state.paneId) return;
      const pane = this.layoutPane(paneId);
      const slot = state.slots[index];
      if (!pane || !slot) return;
      pane.element.style.left = `${slot.left}px`;
      pane.element.style.top = `${slot.top}px`;
      pane.element.style.width = `${slot.width}px`;
      pane.element.style.height = `${slot.height}px`;
    });
  }

  private clearPaneDragLayout(state: PaneDragState) {
    for (const paneId of state.originalOrder) {
      const pane = this.layoutPane(paneId);
      if (!pane) continue;
      delete pane.element.dataset.dragFrozen;
      const style = pane.element.style;
      style.position = "";
      style.left = "";
      style.top = "";
      style.width = "";
      style.height = "";
      style.transform = "";
    }
    state.layoutFrozen = false;
  }

  private showAcceptedPaneInsertionLine(state: PaneDragState) {
    const slot = state.slots[state.acceptedSlotIndex];
    if (!slot) return;
    const { columns } = layoutFor(state.slots.length);
    const column = state.acceptedSlotIndex % columns;
    const rowStart = state.acceptedSlotIndex - column;
    const rowItemCount = Math.min(columns, state.slots.length - rowStart);
    const lineX = column === 0 && rowItemCount > 1 ? slot.left + slot.width + 3 : slot.left - 3;
    const surfaceRect = this.terminalSurface.getBoundingClientRect();
    this.insertionLine.style.left = `${Math.round(lineX - surfaceRect.left)}px`;
    this.insertionLine.style.top = `${Math.round(slot.top - surfaceRect.top + 8)}px`;
    this.insertionLine.style.height = `${Math.max(1, Math.round(slot.height - 16))}px`;
    this.insertionLine.hidden = false;
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
      if (!state.row.paneIds.some((paneId) => this.browserPanes.has(paneId))) {
        this.onPaneRatiosChangedCallback(
          state.projectId,
          state.row.key,
          [...state.previewRatios],
        );
      }
    }
    this.setBrowserSuspensionReason("layout-interaction", false);
    requestAnimationFrame(() => {
      for (const paneId of state.row.paneIds) this.layoutPane(paneId)?.scheduleFit(0);
    });
  }

  // Kept only as a compatibility seam for the removed full-surface browser PoC.
  // New browser instances are BrowserPane items inside the mixed project grid.
  showBrowserView() {
    this.cancelLayoutInteraction();
  }

  showTerminalView() {
    this.workspaceView = this.activeProjectId ? "terminals" : "empty";
    this.app.dataset.workspaceView = this.workspaceView;
    this.renderActiveStatus();
    requestAnimationFrame(() => {
      for (const pane of this.layoutVisiblePanes()) pane.scheduleFit(0);
      this.layoutPane(this.activePaneId ?? "")?.focus();
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
    this.nativeFileDropRegistrationEpoch += 1;
    this.clearNativeFileDropTarget();
    for (const unlisten of this.nativeFileDropUnlisteners.splice(0)) unlisten();
    this.app.removeEventListener("pointerdown", this.onAppPointerDown);
    window.removeEventListener("pointermove", this.onLayoutPointerMove, true);
    window.removeEventListener("pointerup", this.onLayoutPointerUp, true);
    window.removeEventListener("pointercancel", this.onLayoutPointerCancel, true);
    window.removeEventListener("keydown", this.onLayoutKeyDown, true);
    window.removeEventListener("blur", this.onLayoutWindowBlur);
    const stops = Promise.all(
      this.allPanes().map((pane) => pane.dispose()),
    ).then(() => undefined);
    this.panes.clear();
    this.browserPanes.clear();
    this.sessionOwners.clear();
    this.restoredProjects.clear();
    this.projectNames.clear();
    this.projectOrders.clear();
    this.projectRatios.clear();
    this.activeRows.clear();
    await this.appendStopBarrier(stops);
  }

  private updateLayout() {
    const allVisible = this.visiblePanes();
    let maximized = this.maximizedPaneId
      ? allVisible.find((pane) => pane.id === this.maximizedPaneId) ?? null
      : null;
    if (this.maximizedPaneId && !maximized) {
      this.maximizedPaneId = null;
      maximized = null;
    }
    for (const pane of this.panes.values()) {
      pane.setMaximized(pane.id === maximized?.id);
    }
    const visible = maximized ? [maximized] : allVisible;
    const { columns, rows } = layoutFor(visible.length);
    for (const pane of this.allPanes()) {
      if (pane instanceof BrowserPane) pane.setLayoutVisible(false);
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
          if (pane instanceof BrowserPane) pane.setLayoutVisible(true);
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

    this.terminalSurface.dataset.empty = String(allVisible.length === 0);
    this.updateControls();
    requestAnimationFrame(() => {
      for (const pane of visible) pane.scheduleFit(0);
    });
  }

  private updateControls() {
    const visible = this.visiblePanes();
    this.addButton.disabled =
      !this.catalogWritable ||
      this.activeProjectId === null ||
      visible.length >= MAX_PROJECT_PANES;
    for (const row of this.activeRows.values()) {
      row.paneIds.forEach((paneId, index) => {
        this.layoutPane(paneId)
          ?.setResizeHandleEnabled(
            this.catalogWritable &&
              this.maximizedPaneId === null &&
              index < row.paneIds.length - 1,
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
    if (this.workspaceView === "empty") {
      return;
    }
    const pane = this.activePaneId ? this.layoutPane(this.activePaneId) : null;
    if (!pane) {
      this.setFooterStatus(
        this.visiblePanes().length > 0
          ? "상태를 볼 PowerShell을 선택하세요."
          : "＋ PowerShell을 눌러 새 터미널을 여세요.",
      );
      return;
    }
    const status = pane.status;
    this.setFooterStatus(
      status.message ? `${pane.title} · ${status.message}` : pane.title,
      status.tone,
    );
  }

  private layoutVisiblePanes(): LayoutPane[] {
    const visible = this.visiblePanes();
    if (!this.maximizedPaneId) return visible;
    const maximized = visible.find((pane) => pane.id === this.maximizedPaneId);
    return maximized ? [maximized] : visible;
  }

  private visiblePanes(): LayoutPane[] {
    if (!this.activeProjectId) return [];
    const candidates = this.allPanes().filter(
      (pane) => pane.projectId === this.activeProjectId,
    );
    const byId = new Map(candidates.map((pane) => [pane.id, pane]));
    const ordered = (this.projectOrders.get(this.activeProjectId) ?? [])
      .map((paneId) => byId.get(paneId))
      .filter((pane): pane is LayoutPane => pane !== undefined);
    const known = new Set(ordered.map((pane) => pane.id));
    ordered.push(...candidates.filter((pane) => !known.has(pane.id)));
    return ordered;
  }

  private allPanes(): LayoutPane[] {
    return [...this.panes.values(), ...this.browserPanes.values()];
  }

  private layoutPane(paneId: string): LayoutPane | undefined {
    return this.panes.get(paneId) ?? this.browserPanes.get(paneId);
  }

  setNativeOverlayOpen(open: boolean) {
    this.setBrowserSuspensionReason("provider-usage", open);
  }

  setModalOverlayOpen(reason: string, open: boolean) {
    this.setBrowserSuspensionReason(`modal:${reason}`, open);
  }

  private projectPaneCount(projectId: string) {
    return this.allPanes().filter((pane) => pane.projectId === projectId).length;
  }

  private setBrowserSuspensionReason(reason: string, suspended: boolean) {
    if (suspended) {
      this.browserSuspensionReasons.add(reason);
    } else {
      this.browserSuspensionReasons.delete(reason);
    }
    const shouldSuspend = this.browserSuspensionReasons.size > 0;
    for (const pane of this.browserPanes.values()) {
      pane.setInteractionSuspended(shouldSuspend);
    }
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

class PaneLauncherController {
  private readonly listeners = new AbortController();
  private shuttingDown = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly toggleButton: HTMLButtonElement,
    private readonly menu: HTMLElement,
    powershellButton: HTMLButtonElement,
    browserButton: HTMLButtonElement,
    addPowerShell: () => void,
    addBrowser: () => void,
  ) {
    const signal = this.listeners.signal;
    this.toggleButton.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        if (this.shuttingDown || this.toggleButton.disabled) return;
        this.setOpen(this.menu.hidden);
      },
      { signal },
    );
    powershellButton.addEventListener(
      "click",
      () => {
        this.setOpen(false);
        addPowerShell();
      },
      { signal },
    );
    browserButton.addEventListener(
      "click",
      () => {
        this.setOpen(false);
        addBrowser();
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.root.contains(event.target as Node)) this.setOpen(false);
      },
      { signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || this.menu.hidden) return;
        event.preventDefault();
        this.setOpen(false);
        this.toggleButton.focus();
      },
      { signal },
    );
  }

  beginShutdown() {
    this.shuttingDown = true;
    this.toggleButton.disabled = true;
    this.setOpen(false);
  }

  dispose() {
    this.shuttingDown = true;
    this.setOpen(false);
    this.listeners.abort();
  }

  private setOpen(open: boolean) {
    this.menu.hidden = !open;
    this.toggleButton.setAttribute("aria-expanded", String(open));
  }
}

class ProviderUsageController {
  private timer = 0;
  private resetTimer = 0;
  private requestRunning = false;
  private disposed = false;
  private latestUsage: ProviderUsageResponse | null = null;
  private usageStale = false;
  private activeDetailProvider: AgentProvider | null = null;
  private detailOpener: HTMLButtonElement | null = null;
  private detailAccounts: ProviderAccountListResponse | null | undefined;
  private accountBusy = false;
  private accountOperation: "idle" | "adding" | "cancelling" | "switching" = "idle";
  private pendingAccountAdd: Promise<void> | null = null;
  private accountRequestSequence = 0;
  private readonly listeners = new AbortController();

  constructor(
    private readonly codexTrigger: HTMLButtonElement,
    private readonly grokTrigger: HTMLButtonElement,
    private readonly codexFiveHour: ProviderUsageLimitElements,
    private readonly codexWeekly: ProviderUsageLimitElements,
    private readonly grokWeekly: ProviderUsageLimitElements,
    private readonly detail: ProviderUsageDetailElements,
    private readonly setNativeOverlayOpen: (open: boolean) => void,
    private readonly ensureAccountSwitchReady: () => Promise<void>,
    private readonly restartForAccountSwitch: (provider: AgentProvider) => Promise<void>,
    private readonly rollbackAccountSwitchRestart: () => Promise<void>,
  ) {
    const signal = this.listeners.signal;
    this.codexTrigger.addEventListener(
      "click",
      () => this.toggleDetail("codex", this.codexTrigger),
      { signal },
    );
    this.grokTrigger.addEventListener(
      "click",
      () => this.toggleDetail("grok", this.grokTrigger),
      { signal },
    );
    this.detail.closeButton.addEventListener("click", () => this.requestCloseDetail(true), {
      signal,
    });
    this.detail.accountSelect.addEventListener(
      "change",
      () => void this.switchAccount(this.detail.accountSelect.value),
      { signal },
    );
    this.detail.addAccount.addEventListener("click", () => void this.addAccount(), { signal });
    document.addEventListener("pointerdown", (event) => this.onDocumentPointerDown(event), {
      capture: true,
      signal,
    });
    window.addEventListener("keydown", (event) => this.onWindowKeyDown(event), { signal });
    window.addEventListener("resize", () => this.positionDetail(), { signal });
  }

  start() {
    void this.refresh();
    this.timer = window.setInterval(() => {
      this.renderLatestUsage();
      void this.refresh();
    }, 15_000);
  }

  dispose() {
    this.disposed = true;
    window.clearInterval(this.timer);
    window.clearTimeout(this.resetTimer);
    this.accountRequestSequence += 1;
    this.listeners.abort();
    this.codexTrigger.setAttribute("aria-expanded", "false");
    this.grokTrigger.setAttribute("aria-expanded", "false");
    this.detailOpener = null;
    this.activeDetailProvider = null;
    this.detail.popover.hidden = true;
    this.setNativeOverlayOpen(false);
  }

  blocksAppClose() {
    return this.accountOperation === "switching";
  }

  private async refresh() {
    if (this.disposed || this.requestRunning) return;
    this.requestRunning = true;
    this.renderDetail();
    try {
      this.latestUsage = normalizeProviderUsageResponse(
        await invoke<unknown>("read_provider_usage"),
      );
      if (this.disposed) return;
      this.scheduleNextResetRefresh();
      this.setUsageStale(false);
      this.renderLatestUsage();
    } catch {
      if (this.disposed) return;
      this.setUsageStale(true);
      this.renderDetail();
    } finally {
      this.requestRunning = false;
      this.renderDetail();
    }
  }

  private scheduleNextResetRefresh() {
    window.clearTimeout(this.resetTimer);
    this.resetTimer = 0;
    if (this.disposed || !this.latestUsage) return;
    const delayMs = millisecondsUntilNextProviderUsageReset(this.latestUsage);
    if (delayMs === null) return;
    // Browser timers clamp very large delays. Re-check periodically instead of
    // allowing a distant or malformed timestamp to turn into a hot loop.
    const boundedDelayMs = Math.max(25, Math.min(delayMs + 25, 2_147_000_000));
    this.resetTimer = window.setTimeout(() => this.refreshAtKnownReset(), boundedDelayMs);
  }

  private refreshAtKnownReset() {
    this.resetTimer = 0;
    if (this.disposed) return;
    if (this.requestRunning) {
      this.resetTimer = window.setTimeout(() => this.refreshAtKnownReset(), 100);
      return;
    }
    void this.refresh();
  }

  private setUsageStale(stale: boolean) {
    this.usageStale = stale;
    const title = stale
      ? "사용량 갱신에 실패했습니다. 마지막으로 확인한 값을 표시합니다."
      : "";
    for (const trigger of [this.codexTrigger, this.grokTrigger]) {
      trigger.dataset.stale = String(stale);
      trigger.title = title;
    }
    this.detail.popover.dataset.stale = String(stale);
  }

  private renderLatestUsage() {
    const usage = this.latestUsage;
    if (!usage) return;
    this.renderLimit(this.codexFiveHour, usage.codex.fiveHour, "Codex 5시간");
    this.renderLimit(this.codexWeekly, usage.codex.weekly, "Codex 주간");
    this.renderLimit(this.grokWeekly, usage.grok.weekly, "Grok 주간");
    this.renderDetail();
  }

  private renderLimit(
    elements: ProviderUsageLimitElements,
    limit: ProviderLimitUsage | null,
    label: string,
  ) {
    if (!limit) {
      elements.root.dataset.available = "false";
      elements.root.setAttribute("aria-label", `${label} 남은 한도 정보 없음`);
      elements.meter.hidden = true;
      elements.meter.value = 0;
      elements.value.textContent = "--";
      elements.reset.hidden = true;
      elements.reset.textContent = "";
      return;
    }
    const rounded = Math.round(limit.remainingPercent);
    const reset = formatProviderResetCountdown(limit.resetsAt);
    elements.root.dataset.available = "true";
    elements.root.setAttribute("aria-label", `${label}, ${rounded}% 남음, ${reset}`);
    elements.meter.hidden = false;
    elements.meter.value = limit.remainingPercent;
    elements.value.textContent = `${rounded}% 남음`;
    elements.reset.hidden = true;
    elements.reset.textContent = "";
  }

  private toggleDetail(provider: AgentProvider, opener: HTMLButtonElement) {
    if (this.disposed) return;
    if (!this.detail.popover.hidden && this.activeDetailProvider === provider) {
      this.requestCloseDetail(false);
      return;
    }
    if (this.accountBusy) return;
    this.activeDetailProvider = provider;
    this.detailOpener = opener;
    this.codexTrigger.setAttribute("aria-expanded", String(provider === "codex"));
    this.grokTrigger.setAttribute("aria-expanded", String(provider === "grok"));
    this.codexTrigger.setAttribute(
      "aria-label",
      provider === "codex" ? "Codex 남은 한도 상세 닫기" : "Codex 남은 한도 상세 보기",
    );
    this.grokTrigger.setAttribute(
      "aria-label",
      provider === "grok" ? "Grok 남은 한도 상세 닫기" : "Grok 남은 한도 상세 보기",
    );
    this.detailAccounts = undefined;
    this.detail.popover.hidden = false;
    this.setNativeOverlayOpen(true);
    this.positionDetail();
    this.renderDetail();
    void this.refresh();
    void this.refreshAccount(provider);
  }

  private closeDetail(restoreFocus: boolean) {
    if (this.detail.popover.hidden) return;
    const opener = this.detailOpener;
    this.detail.popover.hidden = true;
    this.codexTrigger.setAttribute("aria-expanded", "false");
    this.grokTrigger.setAttribute("aria-expanded", "false");
    this.codexTrigger.setAttribute("aria-label", "Codex 남은 한도 상세 보기");
    this.grokTrigger.setAttribute("aria-label", "Grok 남은 한도 상세 보기");
    this.detailOpener = null;
    this.activeDetailProvider = null;
    this.accountRequestSequence += 1;
    this.setNativeOverlayOpen(false);
    if (restoreFocus && !this.disposed && opener?.isConnected) opener.focus();
  }

  private requestCloseDetail(restoreFocus: boolean) {
    if (this.detail.popover.hidden) return;
    if (this.accountOperation === "switching" || this.accountOperation === "cancelling") return;
    if (this.accountOperation === "adding") {
      void this.cancelAccountAddAndClose(restoreFocus);
      return;
    }
    this.closeDetail(restoreFocus);
  }

  private async cancelAccountAddAndClose(restoreFocus: boolean) {
    const provider = this.activeDetailProvider;
    if (!provider || this.accountOperation !== "adding") return;
    const pendingAdd = this.pendingAccountAdd;
    this.accountOperation = "cancelling";
    this.accountRequestSequence += 1;
    this.detail.accountState.textContent = "계정 추가를 취소하는 중";
    this.renderDetailAccount();
    try {
      await invoke<boolean>("cancel_provider_account_login", { provider });
      await pendingAdd;
      if (this.disposed) return;
      this.accountBusy = false;
      this.accountOperation = "idle";
      this.renderDetailAccount();
      this.closeDetail(restoreFocus);
    } catch (error) {
      if (this.disposed) return;
      this.accountOperation = "adding";
      this.detail.accountState.textContent = `계정 추가 취소 실패: ${errorMessage(error)}`;
      this.renderDetailAccount();
    }
  }

  private onDocumentPointerDown(event: PointerEvent) {
    if (this.detail.popover.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (
      this.detail.popover.contains(target) ||
      this.codexTrigger.contains(target) ||
      this.grokTrigger.contains(target)
    ) {
      return;
    }
    this.requestCloseDetail(false);
  }

  private onWindowKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || this.detail.popover.hidden) return;
    event.preventDefault();
    this.requestCloseDetail(true);
  }

  private positionDetail() {
    const opener = this.detailOpener;
    if (!opener || this.detail.popover.hidden) return;
    const footer = this.detail.popover.parentElement;
    if (!(footer instanceof HTMLElement)) return;
    const footerRect = footer.getBoundingClientRect();
    const openerRect = opener.getBoundingClientRect();
    const width = this.detail.popover.offsetWidth;
    const desired = openerRect.left - footerRect.left;
    const maximum = Math.max(8, footerRect.width - width - 8);
    this.detail.popover.style.left = `${Math.max(8, Math.min(desired, maximum))}px`;
  }

  private async refreshAccount(provider: AgentProvider) {
    const sequence = ++this.accountRequestSequence;
    this.detailAccounts = undefined;
    this.detail.accountState.textContent = "";
    this.renderDetail();
    try {
      const accounts = normalizeProviderAccountListResponse(
        await invoke<unknown>("list_provider_accounts", { provider }),
      );
      if (
        this.disposed ||
        sequence !== this.accountRequestSequence ||
        this.activeDetailProvider !== provider
      ) {
        return;
      }
      if (accounts.provider !== provider) throw new Error("계정 제공자가 일치하지 않습니다.");
      this.detailAccounts = accounts;
    } catch {
      if (
        this.disposed ||
        sequence !== this.accountRequestSequence ||
        this.activeDetailProvider !== provider
      ) {
        return;
      }
      this.detailAccounts = null;
    }
    this.renderDetail();
  }

  private isCurrentAccountOperation(sequence: number, provider: AgentProvider) {
    return (
      !this.disposed &&
      this.accountBusy &&
      sequence === this.accountRequestSequence &&
      this.activeDetailProvider === provider
    );
  }

  private async switchAccount(accountId: string, confirmed = false) {
    const provider = this.activeDetailProvider;
    const accounts = this.detailAccounts;
    if (
      !provider ||
      !accounts ||
      this.accountBusy ||
      accountId === accounts.activeAccountId ||
      !accounts.accounts.some((account) => account.id === accountId)
    ) {
      return;
    }
    const providerName = provider === "codex" ? "Codex" : "Grok";
    if (
      !confirmed &&
      !window.confirm(
        `${providerName} 계정을 전환하면 모든 PowerShell·CLI와 내장 브라우저가 종료되고 ` +
          "앱이 다시 시작됩니다. 재시작 후 새로 실행하는 CLI부터 선택한 계정이 적용되며, " +
          "진행 중인 입력과 브라우저 상태는 사라지고 이전 계정의 대화는 자동으로 이어지지 않습니다. " +
          "계속할까요?",
      )
    ) {
      this.detail.accountSelect.value = accounts.activeAccountId;
      return;
    }

    const sequence = ++this.accountRequestSequence;
    this.accountBusy = true;
    this.accountOperation = "switching";
    this.detail.accountState.textContent = "작업 공간 상태를 확인하는 중";
    this.renderDetailAccount();
    let registrySwitched = false;
    try {
      await this.ensureAccountSwitchReady();
      if (!this.isCurrentAccountOperation(sequence, provider)) return;
      this.detail.accountState.textContent = "계정을 전환하는 중";
      const response = normalizeProviderAccountListResponse(
        await invoke<unknown>("switch_provider_account", { provider, accountId }),
      );
      if (response.provider !== provider) throw new Error("계정 제공자가 일치하지 않습니다.");
      if (response.activeAccountId !== accountId) {
        throw new Error("선택한 계정이 활성화되지 않았습니다.");
      }
      registrySwitched = true;
      if (!this.isCurrentAccountOperation(sequence, provider)) {
        try {
          const restored = normalizeProviderAccountListResponse(
            await invoke<unknown>("switch_provider_account", {
              provider,
              accountId: accounts.activeAccountId,
            }),
          );
          if (
            restored.provider !== provider ||
            restored.activeAccountId !== accounts.activeAccountId
          ) {
            throw new Error("이전 계정이 복구되지 않았습니다.");
          }
        } catch {
          console.error("Provider account rollback after disposal failed");
        }
        return;
      }
      this.detailAccounts = response;
      if (!response.restartRequired) {
        this.accountBusy = false;
        this.accountOperation = "idle";
        this.detail.accountState.textContent = "계정을 전환했습니다.";
        this.renderDetailAccount();
        return;
      }
      this.detail.accountState.textContent = "CLI를 다시 시작하는 중";
      await this.restartForAccountSwitch(provider);
    } catch (error) {
      this.accountBusy = false;
      this.accountOperation = "idle";
      let registryRollbackFailed = false;
      let workspaceRollbackFailed = false;
      if (registrySwitched) {
        try {
          const restored = normalizeProviderAccountListResponse(
            await invoke<unknown>("switch_provider_account", {
              provider,
              accountId: accounts.activeAccountId,
            }),
          );
          if (
            restored.provider !== provider ||
            restored.activeAccountId !== accounts.activeAccountId
          ) {
            throw new Error("이전 계정이 복구되지 않았습니다.");
          }
          this.detailAccounts = restored;
        } catch {
          registryRollbackFailed = true;
        }
        if (!registryRollbackFailed) {
          try {
            await this.rollbackAccountSwitchRestart();
          } catch {
            workspaceRollbackFailed = true;
          }
        }
      }
      if (this.disposed || sequence !== this.accountRequestSequence) return;
      this.detail.accountState.textContent = registryRollbackFailed
        ? `전환 복구 실패: ${errorMessage(error)} · 새 계정 상태를 안전하게 확인하려면 앱을 직접 다시 시작해 주세요.`
        : workspaceRollbackFailed
          ? `전환 실패: ${errorMessage(error)} · 이전 대화의 자동 재개 차단은 유지됩니다.`
          : `전환 실패: ${errorMessage(error)}`;
      this.renderDetailAccount();
    }
  }

  private async addAccount() {
    const provider = this.activeDetailProvider;
    const accounts = this.detailAccounts;
    if (!provider || !accounts || this.accountBusy || accounts.accounts.length >= 32) return;
    const previousAccountId = accounts.activeAccountId;
    const existingAccountIds = new Set(accounts.accounts.map((account) => account.id));
    const providerName = provider === "codex" ? "Codex" : "Grok";
    const sequence = ++this.accountRequestSequence;
    this.accountBusy = true;
    this.accountOperation = "adding";
    this.detail.accountState.textContent = "계정 추가 가능 상태를 확인하는 중";
    this.renderDetailAccount();
    let settleAccountAdd!: () => void;
    const pendingAdd = new Promise<void>((resolve) => {
      settleAccountAdd = resolve;
    });
    this.pendingAccountAdd = pendingAdd;
    try {
      await this.ensureAccountSwitchReady();
      if (!this.isCurrentAccountOperation(sequence, provider)) return;
      this.detail.accountState.textContent = `${providerName} 브라우저 로그인을 기다리는 중`;
      const response = normalizeProviderAccountListResponse(
        await invoke<unknown>("add_provider_account", { provider }),
      );
      if (response.provider !== provider) throw new Error("계정 제공자가 일치하지 않습니다.");
      if (response.activeAccountId !== previousAccountId) {
        throw new Error("계정 추가 중 현재 계정이 변경되었습니다.");
      }
      if (!this.isCurrentAccountOperation(sequence, provider)) return;
      const addedAccounts = response.accounts.filter(
        (account) => !existingAccountIds.has(account.id),
      );
      if (addedAccounts.length > 1) throw new Error("계정 추가 결과가 올바르지 않습니다.");
      this.detailAccounts = response;
      this.accountBusy = false;
      this.accountOperation = "idle";
      this.renderDetailAccount();
      const addedAccount = addedAccounts[0];
      if (!addedAccount) {
        this.detail.accountState.textContent = "이미 등록된 계정입니다 · 기존 계정 유지";
        return;
      }
      if (
        window.confirm(
          `${providerName} 계정을 추가했습니다. 이 계정으로 전환하면 모든 PowerShell·CLI와 ` +
            "내장 브라우저가 종료되고 앱이 다시 시작됩니다. 지금 전환할까요?",
        )
      ) {
        await this.switchAccount(addedAccount.id, true);
        return;
      }
      this.detail.accountState.textContent = "계정이 추가되었습니다 · 기존 계정 유지";
    } catch (error) {
      if (
        this.disposed ||
        sequence !== this.accountRequestSequence ||
        this.activeDetailProvider !== provider
      ) {
        return;
      }
      this.accountBusy = false;
      this.accountOperation = "idle";
      this.detail.accountState.textContent = `계정 추가 실패: ${errorMessage(error)}`;
      this.renderDetailAccount();
    } finally {
      settleAccountAdd();
      if (this.pendingAccountAdd === pendingAdd) this.pendingAccountAdd = null;
    }
  }

  private renderDetail() {
    const provider = this.activeDetailProvider;
    if (!provider || this.detail.popover.hidden) return;

    const providerName = provider === "codex" ? "CODEX" : "GROK";
    this.detail.popover.dataset.provider = provider;
    this.detail.title.textContent = providerName;
    this.renderDetailAccount();

    const usage = this.latestUsage?.[provider] ?? null;
    const showFiveHour = provider === "codex" || usage?.fiveHour != null;
    this.detail.fiveHour.root.hidden = !showFiveHour;
    if (showFiveHour) {
      this.renderDetailLimit(this.detail.fiveHour, usage?.fiveHour ?? null, `${providerName} 5시간`);
    }
    this.renderDetailLimit(this.detail.weekly, usage?.weekly ?? null, `${providerName} 주간`);

    this.detail.popover.setAttribute("aria-busy", String(this.requestRunning));
    if (this.requestRunning && !this.latestUsage) {
      this.detail.usageState.textContent = "사용량을 불러오는 중";
    } else if (this.usageStale) {
      this.detail.usageState.textContent = "갱신 실패 · 마지막 확인값";
    } else {
      this.detail.usageState.textContent = "";
    }
  }

  private renderDetailAccount() {
    const accounts = this.detailAccounts;
    const provider = this.activeDetailProvider;
    const adding = this.accountOperation === "adding";
    const cancelling = this.accountOperation === "cancelling";
    const switching = this.accountOperation === "switching";
    this.codexTrigger.disabled = switching || cancelling || (adding && provider !== "codex");
    this.grokTrigger.disabled = switching || cancelling || (adding && provider !== "grok");
    this.detail.closeButton.disabled = switching || cancelling;
    this.detail.closeButton.title = adding
      ? "계정 추가 취소하고 닫기"
      : switching || cancelling
        ? "계정 작업이 끝난 뒤 닫을 수 있습니다."
        : "닫기";
    this.detail.closeButton.setAttribute(
      "aria-label",
      adding ? "계정 추가 취소하고 닫기" : "사용량 상세 닫기",
    );
    this.detail.addAccount.disabled =
      this.accountBusy || accounts == null || accounts.accounts.length >= 32;
    this.detail.addAccount.title =
      accounts && accounts.accounts.length >= 32 ? "계정은 최대 32개까지 등록할 수 있습니다." : "";
    if (accounts === undefined) {
      this.setAccountOption("", "확인 중");
      this.detail.accountSelect.disabled = true;
      return;
    }
    if (accounts === null) {
      this.setAccountOption("", "계정 조회 실패");
      this.detail.accountSelect.disabled = true;
      if (!this.detail.accountState.textContent) {
        this.detail.accountState.textContent = "계정 목록을 확인할 수 없습니다.";
      }
      return;
    }
    const options = accounts.accounts.map((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = account.displayLabel;
      return option;
    });
    this.detail.accountSelect.replaceChildren(...options);
    this.detail.accountSelect.value = accounts.activeAccountId;
    this.detail.accountSelect.title =
      accounts.accounts.find((account) => account.id === accounts.activeAccountId)?.displayLabel ??
      "";
    this.detail.accountSelect.disabled = this.accountBusy || accounts.accounts.length < 2;
  }

  private setAccountOption(value: string, label: string) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    this.detail.accountSelect.replaceChildren(option);
  }

  private renderDetailLimit(
    elements: ProviderUsageDetailLimitElements,
    limit: ProviderLimitUsage | null,
    label: string,
  ) {
    if (!limit) {
      elements.root.dataset.available = "false";
      elements.meter.hidden = true;
      elements.meter.value = 0;
      elements.meter.setAttribute("aria-label", `${label} 한도 정보 없음`);
      elements.remaining.textContent = "--";
      elements.reset.textContent = "정보 없음";
      return;
    }
    elements.root.dataset.available = "true";
    elements.meter.hidden = false;
    elements.meter.value = limit.remainingPercent;
    elements.meter.setAttribute(
      "aria-label",
      `${label} 한도 ${formatProviderUsagePercent(limit.remainingPercent)} 남음`,
    );
    elements.remaining.textContent = formatProviderUsagePercent(limit.remainingPercent);
    elements.reset.textContent = formatProviderUsageResetDetail(limit.resetsAt);
  }
}

class PhoneNotificationController {
  private settings: PhoneNotificationSettings | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly deliveryQueue: QueuedPhoneNotification[] = [];
  private readonly retryWaiters = new Map<number, () => void>();
  private deliveryRunning = false;
  private busy = false;
  private disposed = false;

  constructor(
    private readonly openButton: HTMLButtonElement,
    private readonly dialog: HTMLDialogElement,
    private readonly form: HTMLFormElement,
    private readonly enabledInput: HTMLInputElement,
    private readonly webhookInput: HTMLInputElement,
    private readonly webhookState: HTMLElement,
    private readonly successInput: HTMLInputElement,
    private readonly errorInput: HTMLInputElement,
    private readonly removeButton: HTMLButtonElement,
    private readonly testButton: HTMLButtonElement,
    private readonly closeButton: HTMLButtonElement,
    private readonly status: HTMLElement,
    private readonly setModalOpen: (open: boolean) => void,
  ) {
    this.openButton.addEventListener("click", () => this.open());
    this.closeButton.addEventListener("click", () => this.dialog.close());
    this.removeButton.addEventListener("click", () => void this.removeWebhook());
    this.testButton.addEventListener("click", () => void this.test());
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save(true);
    });
    this.dialog.addEventListener("close", () => this.setModalOpen(false));
  }

  start() {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  dispose() {
    this.disposed = true;
    this.setModalOpen(false);
    this.deliveryQueue.length = 0;
    for (const [timer, resolve] of this.retryWaiters) {
      window.clearTimeout(timer);
      resolve();
    }
    this.retryWaiters.clear();
  }

  async sendBackground(
    kind: Exclude<PhoneNotificationKind, "test">,
    eventId: string,
    labels: PhoneNotificationLabels,
  ) {
    await this.start();
    if (this.disposed) return;
    const settings = this.settings;
    if (
      !settings?.enabled ||
      !settings.webhookConfigured ||
      (kind === "success" && !settings.notifyOnSuccess) ||
      (kind === "error" && !settings.notifyOnError)
    ) {
      return;
    }
    this.deliveryQueue.push({ kind, eventId, labels });
    void this.drainDeliveryQueue();
  }

  private async drainDeliveryQueue() {
    if (this.deliveryRunning || this.disposed) return;
    this.deliveryRunning = true;
    try {
      while (!this.disposed) {
        const delivery = this.deliveryQueue.shift();
        if (!delivery) break;
        await this.deliverWithRetry(delivery);
      }
    } finally {
      this.deliveryRunning = false;
    }
  }

  private async deliverWithRetry(delivery: QueuedPhoneNotification) {
    for (let attempt = 0; !this.disposed; attempt += 1) {
      try {
        await invoke<PhoneNotificationResult>("send_phone_notification", {
          request: {
            kind: delivery.kind,
            eventId: delivery.eventId,
            projectName: delivery.labels.projectName,
            terminalName: delivery.labels.terminalName,
          },
        });
        return;
      } catch {
        const delay = PHONE_NOTIFICATION_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          console.warn("Discord notification delivery failed after bounded retries");
          return;
        }
        await this.waitBeforeRetry(delay);
      }
    }
  }

  private waitBeforeRetry(delay: number) {
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        this.retryWaiters.delete(timer);
        resolve();
      }, delay);
      this.retryWaiters.set(timer, resolve);
    });
  }

  private async load() {
    try {
      const settings = normalizePhoneNotificationSettings(
        await invoke<unknown>("load_phone_notification_settings"),
      );
      this.settings = settings;
      this.openButton.disabled = false;
      this.renderButton();
    } catch (error) {
      this.openButton.disabled = true;
      this.openButton.title = `환경설정을 불러오지 못했습니다: ${errorMessage(error)}`;
    }
  }

  private open() {
    const settings = this.settings;
    if (!settings || this.dialog.open) return;
    this.enabledInput.checked = settings.enabled;
    this.webhookInput.value = "";
    this.successInput.checked = settings.notifyOnSuccess;
    this.errorInput.checked = settings.notifyOnError;
    this.renderWebhookState();
    this.setStatus("");
    this.setModalOpen(true);
    try {
      this.dialog.showModal();
    } catch (error) {
      this.setModalOpen(false);
      throw error;
    }
    this.enabledInput.focus();
  }

  private readForm(): PhoneNotificationSettingsUpdate | null {
    this.webhookInput.value = this.webhookInput.value.trim();
    if (!this.form.reportValidity()) return null;
    const webhookUrl = this.webhookInput.value || null;
    if (
      this.enabledInput.checked &&
      !webhookUrl &&
      this.settings?.webhookConfigured !== true
    ) {
      this.setStatus("Discord 웹훅 URL을 먼저 입력하세요.", "error");
      this.webhookInput.focus();
      return null;
    }
    return {
      enabled: this.enabledInput.checked,
      webhookUrl,
      clearWebhook: false,
      notifyOnSuccess: this.successInput.checked,
      notifyOnError: this.errorInput.checked,
    };
  }

  private async save(closeAfterSave: boolean) {
    if (this.busy) return null;
    const next = this.readForm();
    if (!next) return null;
    this.busy = true;
    this.setStatus("저장 중…");
    try {
      const saved = normalizePhoneNotificationSettings(
        await invoke<unknown>("save_phone_notification_settings", { settings: next }),
      );
      this.settings = saved;
      this.webhookInput.value = "";
      this.renderButton();
      this.renderWebhookState();
      this.setStatus("저장했습니다.");
      if (closeAfterSave) this.dialog.close();
      return saved;
    } catch (error) {
      this.setStatus(`저장하지 못했습니다: ${errorMessage(error)}`, "error");
      return null;
    } finally {
      this.busy = false;
    }
  }

  private async test() {
    if (this.busy) return;
    if (!this.enabledInput.checked) {
      this.setStatus("먼저 휴대폰 알림 사용을 켜세요.", "error");
      return;
    }
    const saved = await this.save(false);
    if (!saved) return;
    if (!saved.enabled || !saved.webhookConfigured) {
      this.setStatus("Discord 웹훅을 등록하고 알림 사용을 켜세요.", "error");
      return;
    }
    this.busy = true;
    this.setStatus("테스트 알림 전송 중…");
    try {
      const result = await invoke<PhoneNotificationResult>("send_phone_notification", {
        request: {
          kind: "test",
          eventId: createPhoneNotificationEventId("test"),
          projectName: "IHATECODING",
          terminalName: "테스트 알림",
        },
      });
      this.setStatus(
        result.sent ? "테스트 알림을 보냈습니다." : "알림 설정이 꺼져 있습니다.",
        result.sent ? "normal" : "error",
      );
    } catch (error) {
      this.setStatus(`테스트 전송에 실패했습니다: ${errorMessage(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }

  private async removeWebhook() {
    if (this.busy || !this.settings?.webhookConfigured) return;
    this.busy = true;
    this.setStatus("저장된 Discord 웹훅 제거 중…");
    try {
      const saved = normalizePhoneNotificationSettings(
        await invoke<unknown>("save_phone_notification_settings", {
          settings: {
            enabled: false,
            webhookUrl: null,
            clearWebhook: true,
            notifyOnSuccess: this.successInput.checked,
            notifyOnError: this.errorInput.checked,
          } satisfies PhoneNotificationSettingsUpdate,
        }),
      );
      this.settings = saved;
      this.enabledInput.checked = false;
      this.webhookInput.value = "";
      this.renderButton();
      this.renderWebhookState();
      this.setStatus("저장된 Discord 웹훅을 제거했습니다.");
    } catch (error) {
      this.setStatus(`웹훅을 제거하지 못했습니다: ${errorMessage(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }

  private renderWebhookState() {
    const configured = this.settings?.webhookConfigured === true;
    this.webhookState.textContent = configured ? "등록됨" : "등록 안 됨";
    this.webhookState.dataset.configured = String(configured);
    this.removeButton.disabled = !configured;
  }

  private renderButton() {
    this.openButton.setAttribute("aria-label", "환경설정 열기");
    this.openButton.title = "환경설정";
  }

  private setStatus(message: string, tone: StatusTone = "normal") {
    this.status.textContent = message;
    this.status.dataset.tone = tone;
  }
}

class AgentEventController {
  private readonly channel = new Channel<unknown>();
  private readonly retryTimers = new Set<number>();
  private readonly latestLifecycleDeliveryByCorrelation = new Map<string, number>();
  private readonly latestContextDeliveryByCorrelation = new Map<string, number>();
  private readonly phoneNotifiedFinishedTurns = new Set<string>();
  private lifecycleDeliverySequence = 0;
  private contextDeliverySequence = 0;
  private disposed = false;

  constructor(
    private readonly workspace: TerminalWorkspace,
    private readonly reportError: (message: string) => void,
  ) {
    this.channel.onmessage = (value) => this.onMessage(value);
  }

  async start() {
    try {
      await invoke("subscribe_agent_events", { onEvent: this.channel });
    } catch (error) {
      if (!this.disposed) {
        this.reportError(`완료 알림 연결 실패: ${errorMessage(error)}`);
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.retryTimers) window.clearTimeout(timer);
    this.retryTimers.clear();
    this.latestLifecycleDeliveryByCorrelation.clear();
    this.latestContextDeliveryByCorrelation.clear();
    this.phoneNotifiedFinishedTurns.clear();
    this.channel.onmessage = () => undefined;
  }

  private onMessage(value: unknown) {
    if (this.disposed || !isRecord(value)) return;
    const event = value.event;
    const data = isRecord(value.data) ? value.data : null;
    if (event === "contextUpdated" && data) {
      this.onContextUpdated(data);
      return;
    }
    if ((event !== "turnStarted" && event !== "turnFinished") || !data) return;
    const terminalKey = isRecord(data.terminalKey) ? data.terminalKey : null;
    const provider = data.provider;
    const rawTurnId = data.turnId;
    const turnId = normalizeAgentTurnId(rawTurnId);
    const rawNotificationObservedAtUnixMs = data.notificationObservedAtUnixMs;
    let notificationObservedAtUnixMs: number | null = null;
    if (
      !terminalKey ||
      (provider !== "codex" && provider !== "grok") ||
      typeof data.runtimeSessionId !== "string" ||
      typeof data.conversationId !== "string" ||
      typeof terminalKey.projectId !== "string" ||
      typeof terminalKey.terminalId !== "string" ||
      typeof data.observedAtUnixMs !== "number" ||
      !Number.isSafeInteger(data.observedAtUnixMs) ||
      data.observedAtUnixMs < 0
    ) {
      return;
    }
    if (rawTurnId !== undefined && rawTurnId !== null && turnId === null) return;
    if (event === "turnFinished") {
      if (typeof data.succeeded !== "boolean") return;
      if (
        rawNotificationObservedAtUnixMs !== undefined &&
        rawNotificationObservedAtUnixMs !== null
      ) {
        if (
          typeof rawNotificationObservedAtUnixMs !== "number" ||
          !Number.isSafeInteger(rawNotificationObservedAtUnixMs) ||
          rawNotificationObservedAtUnixMs < 0
        ) {
          return;
        }
        notificationObservedAtUnixMs = rawNotificationObservedAtUnixMs;
      }
    }
    const projectId = terminalKey.projectId;
    const terminalId = terminalKey.terminalId;
    const runtimeSessionId = data.runtimeSessionId;
    const conversationId = data.conversationId;
    const observedAtUnixMs = data.observedAtUnixMs;
    const succeeded = event === "turnFinished" && data.succeeded === true;
    const correlationKey = agentLifecycleCorrelationKey(
      projectId,
      terminalId,
      runtimeSessionId,
      provider,
      conversationId,
    );
    const deliveryVersion = ++this.lifecycleDeliverySequence;
    this.latestLifecycleDeliveryByCorrelation.set(correlationKey, deliveryVersion);
    this.deliver(
      event,
      projectId,
      terminalId,
      runtimeSessionId,
      provider,
      conversationId,
      turnId,
      observedAtUnixMs,
      succeeded,
      notificationObservedAtUnixMs,
      correlationKey,
      deliveryVersion,
      0,
    );
  }

  private onContextUpdated(data: Record<string, unknown>) {
    const terminalKey = isRecord(data.terminalKey) ? data.terminalKey : null;
    const provider = data.provider;
    if (
      !terminalKey ||
      (provider !== "codex" && provider !== "grok") ||
      typeof data.runtimeSessionId !== "string" ||
      typeof data.conversationId !== "string" ||
      typeof terminalKey.projectId !== "string" ||
      typeof terminalKey.terminalId !== "string" ||
      !isSafeNonNegativeInteger(data.observedAtUnixMs) ||
      !isSafePositiveInteger(data.usedTokens) ||
      !isSafePositiveInteger(data.windowTokens) ||
      data.usedTokens > data.windowTokens ||
      !isSafeNonNegativeInteger(data.remainingPercent) ||
      data.remainingPercent > 100
    ) {
      return;
    }
    const correlationKey = agentLifecycleCorrelationKey(
      terminalKey.projectId,
      terminalKey.terminalId,
      data.runtimeSessionId,
      provider,
      data.conversationId,
    );
    const deliveryVersion = ++this.contextDeliverySequence;
    this.latestContextDeliveryByCorrelation.set(correlationKey, deliveryVersion);
    this.deliverContext(
      terminalKey.projectId,
      terminalKey.terminalId,
      data.runtimeSessionId,
      provider,
      data.conversationId,
      data.usedTokens,
      data.windowTokens,
      data.remainingPercent,
      correlationKey,
      deliveryVersion,
      0,
    );
  }

  private deliverContext(
    projectId: string,
    terminalId: string,
    runtimeSessionId: string,
    provider: AgentProvider,
    conversationId: string,
    usedTokens: number,
    windowTokens: number,
    remainingPercent: number,
    correlationKey: string,
    deliveryVersion: number,
    attempt: number,
  ) {
    if (
      this.disposed ||
      this.latestContextDeliveryByCorrelation.get(correlationKey) !== deliveryVersion
    ) {
      return;
    }
    if (
      this.workspace.setAgentContextUsage(
        projectId,
        terminalId,
        runtimeSessionId,
        provider,
        conversationId,
        usedTokens,
        windowTokens,
        remainingPercent,
      )
    ) {
      this.latestContextDeliveryByCorrelation.delete(correlationKey);
      return;
    }
    const delayMs = AGENT_EVENT_BIND_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) return;
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(timer);
      this.deliverContext(
        projectId,
        terminalId,
        runtimeSessionId,
        provider,
        conversationId,
        usedTokens,
        windowTokens,
        remainingPercent,
        correlationKey,
        deliveryVersion,
        attempt + 1,
      );
    }, delayMs);
    this.retryTimers.add(timer);
  }

  private deliver(
    event: "turnStarted" | "turnFinished",
    projectId: string,
    terminalId: string,
    runtimeSessionId: string,
    provider: AgentProvider,
    conversationId: string,
    turnId: string | null,
    observedAtUnixMs: number,
    succeeded: boolean,
    notificationObservedAtUnixMs: number | null,
    correlationKey: string,
    deliveryVersion: number,
    attempt: number,
  ) {
    if (
      this.disposed ||
      this.latestLifecycleDeliveryByCorrelation.get(correlationKey) !== deliveryVersion
    ) {
      return;
    }
    const accepted = this.workspace.setAgentTurnWorking(
      projectId,
      terminalId,
      runtimeSessionId,
      provider,
      conversationId,
      event === "turnStarted",
    );
    if (!accepted) {
      // A resume/discovery watcher can emit its initial lifecycle snapshot
      // before bind_agent_session has returned to the pane. Retry both edges.
      // The delivery version prevents an older start retry from reviving busy
      // state after a newer finish (and vice versa for a following turn).
      const delayMs = AGENT_EVENT_BIND_RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined) {
        const timer = window.setTimeout(() => {
          this.retryTimers.delete(timer);
          this.deliver(
            event,
            projectId,
            terminalId,
            runtimeSessionId,
            provider,
            conversationId,
            turnId,
            observedAtUnixMs,
            succeeded,
            notificationObservedAtUnixMs,
            correlationKey,
            deliveryVersion,
            attempt + 1,
          );
        }, delayMs);
        this.retryTimers.add(timer);
      }
      return;
    }
    if (event === "turnFinished") {
      // Use the provider lifecycle identity itself as the delivery id. A
      // duplicated Tauri subscription or a replay of the same event must hit
      // the Rust service with the same key, otherwise a timestamp/sequence id
      // turns one logical completion into two Discord webhook messages.
      const phoneTurnKey = agentTurnPhoneNotificationEventId(
        provider,
        conversationId,
        turnId,
        notificationObservedAtUnixMs ?? observedAtUnixMs,
      );
      if (!this.phoneNotifiedFinishedTurns.has(phoneTurnKey)) {
        const labels = this.workspace.phoneNotificationLabels(projectId, terminalId);
        if (labels) {
          // Do not consume the dedupe key until the stable project/terminal
          // labels exist. A lifecycle event may beat workspace initialization;
          // its retry must still be allowed to enqueue the notification.
          this.phoneNotifiedFinishedTurns.add(phoneTurnKey);
          if (this.phoneNotifiedFinishedTurns.size > 512) {
            const oldest = this.phoneNotifiedFinishedTurns.values().next().value;
            if (typeof oldest === "string") {
              this.phoneNotifiedFinishedTurns.delete(oldest);
            }
          }
          void phoneNotifications.sendBackground(
            succeeded ? "success" : "error",
            phoneTurnKey,
            labels,
          );
        } else {
          console.warn("Discord notification skipped: terminal label mapping unavailable");
        }
      }
      if (
        this.latestLifecycleDeliveryByCorrelation.get(correlationKey) === deliveryVersion
      ) {
        this.latestLifecycleDeliveryByCorrelation.delete(correlationKey);
      }
      if (!succeeded) return;
    } else {
      return;
    }
    const turnKey = agentTurnPhoneNotificationEventId(
      provider,
      conversationId,
      turnId,
      observedAtUnixMs,
    );
    this.workspace.queueAgentCompletion(
      projectId,
      terminalId,
      runtimeSessionId,
      provider,
      conversationId,
      turnKey,
      notificationObservedAtUnixMs === null
        ? null
        : {
            provider,
            runtimeSessionId,
            conversationId,
            turnId,
            observedAtUnixMs: notificationObservedAtUnixMs,
          },
    );
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
  if (isTerminalCopyShortcut(event) && hasSelection) return false;
  if (isTerminalCtrlInsertShortcut(event)) return false;
  if ((event.ctrlKey || event.metaKey) && key === "v") return false;
  if (event.shiftKey && !event.ctrlKey && !event.altKey && key === "insert") {
    return false;
  }
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

function normalizeBrowserUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("웹 주소를 입력하세요.");
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed);
  const localAddress = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(
    trimmed,
  );
  const candidate = hasScheme
    ? trimmed
    : `${localAddress ? "http" : "https"}://${trimmed}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("http 또는 https 주소만 열 수 있습니다.");
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error("로그인 정보가 포함되지 않은 웹 주소만 열 수 있습니다.");
  }
  return parsed.href;
}

function paneRuntimeId(projectId: string, terminalId: string) {
  return `${projectId.length}:${projectId}${terminalId}`;
}

function browserPaneRuntimeId(projectId: string, browserPaneId: string) {
  return `browser:${projectId.length}:${projectId}:${browserPaneId}`;
}

function agentLifecycleCorrelationKey(
  projectId: string,
  terminalId: string,
  runtimeSessionId: string,
  provider: AgentProvider,
  conversationId: string,
) {
  return JSON.stringify([
    projectId,
    terminalId,
    runtimeSessionId,
    provider,
    conversationId.toLowerCase(),
  ]);
}

function rectContainsPoint(rect: DOMRectReadOnly, x: number, y: number) {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

function paneCenter(slot: PaneGeometry) {
  return {
    x: slot.left + slot.width / 2,
    y: slot.top + slot.height / 2,
  };
}

function distanceToPaneCenter(point: { x: number; y: number }, slot: PaneGeometry) {
  const center = paneCenter(slot);
  return Math.hypot(point.x - center.x, point.y - center.y);
}

function closestPaneSlotIndex(
  point: { x: number; y: number },
  slots: readonly PaneGeometry[],
) {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  slots.forEach((slot, index) => {
    const distance = distanceToPaneCenter(point, slot);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function vectorAngleRadians(ax: number, ay: number, bx: number, by: number) {
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (lengths <= Number.EPSILON) return 0;
  const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / lengths));
  return Math.acos(cosine);
}

function buildPaneDragPreviewOrder(
  originalOrder: readonly string[],
  sourcePaneId: string,
  slotIndex: number,
) {
  const preview = originalOrder.filter((paneId) => paneId !== sourcePaneId);
  preview.splice(Math.max(0, Math.min(slotIndex, preview.length)), 0, sourcePaneId);
  return preview;
}

function samePaneOrder(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((paneId, index) => paneId === right[index])
  );
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

function normalizeAgentTurnId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= 180 &&
    /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : null;
}

function agentTurnPhoneNotificationEventId(
  provider: AgentProvider,
  conversationId: string,
  turnId: string | null,
  observedAtUnixMs: number,
) {
  if (turnId !== null) {
    return `agent-turn:v2:${provider}:${conversationId.toLowerCase()}:${turnId}`;
  }
  return `agent-turn:v1:${provider}:${conversationId.toLowerCase()}:${observedAtUnixMs}`;
}

function createPhoneNotificationEventId(prefix: "turn" | "terminal" | "test") {
  phoneNotificationEventSequence += 1;
  return `${prefix}:${Date.now()}:${phoneNotificationEventSequence}`;
}

function createTerminalArrowEvent(
  type: "keydown" | "keyup",
  key: "ArrowLeft" | "ArrowRight",
) {
  const keyCode = key === "ArrowLeft" ? 37 : 39;
  const event = new KeyboardEvent(type, {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  });
  // Chromium does not accept legacy keyCode fields in KeyboardEventInit, while
  // xterm's Win32 encoder still uses them for the virtual-key record.
  Object.defineProperties(event, {
    keyCode: { configurable: true, get: () => keyCode },
    which: { configurable: true, get: () => keyCode },
  });
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function normalizePhoneNotificationSettings(value: unknown): PhoneNotificationSettings {
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.webhookConfigured !== "boolean" ||
    typeof value.notifyOnSuccess !== "boolean" ||
    typeof value.notifyOnError !== "boolean"
  ) {
    throw new Error("휴대폰 알림 설정 형식이 올바르지 않습니다.");
  }
  return {
    enabled: value.enabled,
    webhookConfigured: value.webhookConfigured,
    notifyOnSuccess: value.notifyOnSuccess,
    notifyOnError: value.notifyOnError,
  };
}

function normalizeClipboardSnapshot(value: unknown): NativeClipboardSnapshot {
  if (!isRecord(value)) {
    throw new Error("클립보드 응답 형식이 올바르지 않습니다.");
  }
  if (value.kind === "image") return { kind: "image" };
  if (value.kind === "empty") return { kind: "empty" };
  if (value.kind === "text" && typeof value.text === "string") {
    return { kind: "text", text: value.text };
  }
  throw new Error("클립보드 응답 형식이 올바르지 않습니다.");
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

function requireSelect(id: string): HTMLSelectElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`#${id} is not a select`);
  }
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

type ProviderUsageLimitElements = {
  root: HTMLElement;
  meter: HTMLProgressElement;
  value: HTMLElement;
  reset: HTMLElement;
};

type ProviderUsageDetailLimitElements = {
  root: HTMLElement;
  meter: HTMLProgressElement;
  remaining: HTMLElement;
  reset: HTMLElement;
};

type ProviderUsageDetailElements = {
  popover: HTMLElement;
  title: HTMLElement;
  closeButton: HTMLButtonElement;
  accountSelect: HTMLSelectElement;
  addAccount: HTMLButtonElement;
  accountState: HTMLElement;
  fiveHour: ProviderUsageDetailLimitElements;
  weekly: ProviderUsageDetailLimitElements;
  usageState: HTMLElement;
};

const providerUsageTimestampFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const providerUsagePercentFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 1,
});
function formatProviderUsageTimestamp(value: string) {
  return providerUsageTimestampFormatter.format(new Date(value));
}

function formatProviderUsagePercent(value: number) {
  return `${providerUsagePercentFormatter.format(value)}%`;
}

function formatProviderUsageResetDetail(resetsAt: string) {
  const timestamp = formatProviderUsageTimestamp(resetsAt);
  const countdown = formatProviderResetCountdown(resetsAt);
  return countdown === "곧 초기화"
    ? `${timestamp} · 곧 초기화`
    : `${timestamp} · ${countdown} 후`;
}

function requireProviderUsageLimit(id: string): ProviderUsageLimitElements {
  const root = requireElement(id);
  const meter = root.querySelector(".usage-meter");
  const value = root.querySelector(".usage-value");
  const reset = root.querySelector(".usage-reset");
  if (!(meter instanceof HTMLProgressElement)) throw new Error(`#${id} has no usage meter`);
  if (!(value instanceof HTMLElement)) throw new Error(`#${id} has no usage value`);
  if (!(reset instanceof HTMLElement)) throw new Error(`#${id} has no usage reset`);
  return { root, meter, value, reset };
}

function requireProviderUsageDetailLimit(id: string): ProviderUsageDetailLimitElements {
  const root = requireElement(id);
  const meter = root.querySelector(".provider-usage-detail-meter");
  const remaining = root.querySelector(".provider-usage-detail-remaining");
  const reset = root.querySelector(".provider-usage-detail-reset");
  if (!(meter instanceof HTMLProgressElement)) throw new Error(`#${id} has no detail meter`);
  if (!(remaining instanceof HTMLElement)) throw new Error(`#${id} has no remaining value`);
  if (!(reset instanceof HTMLElement)) throw new Error(`#${id} has no reset value`);
  return { root, meter, remaining, reset };
}

function requireProviderUsageDetail(): ProviderUsageDetailElements {
  return {
    popover: requireElement("provider-usage-popover"),
    title: requireElement("provider-usage-detail-title"),
    closeButton: requireButton("close-provider-usage"),
    accountSelect: requireSelect("provider-account-select"),
    addAccount: requireButton("add-provider-account"),
    accountState: requireElement("provider-account-state"),
    fiveHour: requireProviderUsageDetailLimit("provider-usage-detail-five-hour"),
    weekly: requireProviderUsageDetailLimit("provider-usage-detail-weekly"),
    usageState: requireElement("provider-usage-detail-state"),
  };
}

const app = requireElement("app");
const terminalSurface = requireElement("terminal-surface");
const addButton = requireButton("add-terminal");
const paneLauncherRoot = requireElement("pane-launcher");
const paneLauncherMenu = requireElement("pane-launcher-menu");
const addPowerShellButton = requireButton("add-powershell-pane");
const addBrowserButton = requireButton("add-browser-pane");
const statusElement = requireElement("status");
const projectList = requireElement("project-list");
const tabList = requireElement("workspace-tab-list");
const addTabButton = requireButton("add-workspace-tab");
const createProjectButton = requireButton("create-project");
const projectDialog = requireDialog("project-dialog");
const projectForm = requireForm("project-form");
const projectName = requireInput("project-name");
const projectPath = requireInput("project-path");
const selectProjectFolderButton = requireButton("select-project-folder");
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
const codexUsageTrigger = requireButton("codex-usage-trigger");
const grokUsageTrigger = requireButton("grok-usage-trigger");
const codexFiveHourUsage = requireProviderUsageLimit("codex-five-hour-usage");
const codexWeeklyUsage = requireProviderUsageLimit("codex-weekly-usage");
const grokWeeklyUsage = requireProviderUsageLimit("grok-weekly-usage");
const providerUsageDetail = requireProviderUsageDetail();
const openSettingsButton = requireButton("open-settings");
const settingsDialog = requireDialog("settings-dialog");
const settingsForm = requireForm("settings-form");
const phoneNotificationEnabled = requireInput("phone-notification-enabled");
const phoneNotificationWebhook = requireInput("phone-notification-webhook");
const phoneNotificationWebhookState = requireElement("phone-notification-webhook-state");
const phoneNotificationSuccess = requireInput("phone-notification-success");
const phoneNotificationError = requireInput("phone-notification-error");
const removePhoneNotificationWebhookButton = requireButton(
  "remove-phone-notification-webhook",
);
const testPhoneNotificationsButton = requireButton("test-phone-notifications");
const closeSettingsButton = requireButton("close-settings");
const phoneNotificationStatus = requireElement("phone-notification-status");

let controller: Phase4WorkspaceController | null = null;
let phoneNotifications: PhoneNotificationController;
const workspace = new TerminalWorkspace(
  app,
  terminalSurface,
  addButton,
  statusElement,
  (projectId, paneId) =>
    controller?.onPaneClosed(projectId, paneId) ?? Promise.resolve(false),
  (projectId, paneId, title) =>
    controller?.onPaneRenamed(projectId, paneId, title) ?? Promise.resolve(false),
  (projectId, paneId) =>
    controller?.onBrowserPaneClosed(projectId, paneId) ?? Promise.resolve(false),
  (projectId, paneId, title) =>
    controller?.onBrowserPaneRenamed(projectId, paneId, title) ??
    Promise.resolve(false),
  (projectId, paneId, url) =>
    controller?.onBrowserPaneUrlChanged(projectId, paneId, url) ??
    Promise.resolve(false),
  (projectId, paneId, target) =>
    controller?.onPaneReordered(projectId, paneId, target),
  (projectId, layoutKey, ratios) =>
    controller?.onPaneRatiosChanged(projectId, layoutKey, ratios),
  (projectId, terminalId, provider, conversationId) =>
    controller?.onAgentConversationDiscovered(
      projectId,
      terminalId,
      provider,
      conversationId,
    ) ?? Promise.resolve(false),
  (projectId, terminalId, working) =>
    controller?.setTerminalAgentWorking(projectId, terminalId, working),
  (projectId, terminalId) =>
    controller?.onAgentTurnCompleted(projectId, terminalId) ?? Promise.resolve(false),
  (projectId, terminalId) =>
    controller?.acknowledgeTerminalCompletion(projectId, terminalId) ??
    Promise.resolve(false),
);
phoneNotifications = new PhoneNotificationController(
  openSettingsButton,
  settingsDialog,
  settingsForm,
  phoneNotificationEnabled,
  phoneNotificationWebhook,
  phoneNotificationWebhookState,
  phoneNotificationSuccess,
  phoneNotificationError,
  removePhoneNotificationWebhookButton,
  testPhoneNotificationsButton,
  closeSettingsButton,
  phoneNotificationStatus,
  (open) => workspace.setModalOverlayOpen("settings", open),
);
void phoneNotifications.start();
const agentEvents = new AgentEventController(workspace, (message) =>
  workspace.setFooterStatus(message, "error"),
);
const agentEventsReady = agentEvents.start();
const providerUsage = new ProviderUsageController(
  codexUsageTrigger,
  grokUsageTrigger,
  codexFiveHourUsage,
  codexWeeklyUsage,
  grokWeeklyUsage,
  providerUsageDetail,
  (open) => workspace.setNativeOverlayOpen(open),
  ensureProviderAccountSwitchReady,
  restartForProviderAccountSwitch,
  rollbackProviderAccountSwitchRestart,
);
providerUsage.start();
controller = createPhase4WorkspaceController(workspace, {
  projectList,
  tabList,
  addTerminalButton: addButton,
  addTabButton,
  createProjectButton,
  projectDialog,
  projectForm,
  projectName,
  projectPath,
  selectProjectFolderButton,
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
const paneLauncher = new PaneLauncherController(
  paneLauncherRoot,
  addButton,
  paneLauncherMenu,
  addPowerShellButton,
  addBrowserButton,
  () => void controller?.addTerminal(),
  () => void controller?.addBrowserPane(),
);
// The old full-surface implementation is intentionally unreachable; browser
// instances now live inside the mixed project grid.
void BrowserController;
let productionMigrationError: string | null = null;
const productionMigrationPromise = invoke("import_discovered_production_catalog").catch(
  (error) => {
    productionMigrationError = `기존 IHATECODING 프로젝트 자동 가져오기를 건너뛰었습니다. ${errorMessage(error)}`;
  },
);
const initializationPromise = Promise.all([productionMigrationPromise, agentEventsReady])
  .then(() => controller?.initialize())
  .then((result) => {
    if (productionMigrationError) {
      workspace.setFooterStatus(productionMigrationError, "error");
    }
    return result;
  });
void initializationPromise;

async function ensureProviderAccountSwitchReady() {
  await initializationPromise;
  if (!controller) throw new Error("작업 공간이 아직 준비되지 않았습니다.");
  await controller.assertProviderAccountRestartReady();
}

async function restartForProviderAccountSwitch(provider: AgentProvider) {
  await initializationPromise;
  if (!controller) throw new Error("작업 공간이 아직 준비되지 않았습니다.");
  await workspace.captureBrowserPaneUrls();
  await controller.prepareProviderAccountRestart(provider);
  let terminalEngineStopped = false;
  try {
    await invoke("shutdown_terminal_engine");
    terminalEngineStopped = true;
    await invoke("restart_application");
  } catch (error) {
    const recovery = terminalEngineStopped
      ? " 터미널 엔진이 종료되었습니다. 앱을 직접 다시 시작해 주세요."
      : "";
    throw new Error(`${errorMessage(error)}${recovery}`);
  }
}

async function rollbackProviderAccountSwitchRestart() {
  if (!controller) throw new Error("작업 공간이 아직 준비되지 않았습니다.");
  await controller.rollbackProviderAccountRestart();
}

const currentAppWindow = getCurrentWindow();
let closeBarrierRunning = false;
void currentAppWindow.onCloseRequested(async (event) => {
  event.preventDefault();
  if (providerUsage.blocksAppClose()) {
    workspace.setFooterStatus("계정 전환을 마친 뒤 앱을 종료합니다.", "error");
    return;
  }
  if (closeBarrierRunning) {
    // A backend replacement or startup IPC can be indefinitely delayed by an
    // unhealthy child/process. A second explicit close request is therefore
    // the guaranteed escape hatch; Job Object ownership cleans descendants as
    // the application process exits.
    agentEvents.dispose();
    providerUsage.dispose();
    phoneNotifications.dispose();
    controller?.dispose();
    paneLauncher.dispose();
    void workspace.dispose();
    await currentAppWindow.destroy();
    return;
  }

  closeBarrierRunning = true;
  paneLauncher.beginShutdown();
  try {
    await initializationPromise;
    await controller?.flushSaves();
    await workspace.captureBrowserPaneUrls();
    controller?.beginShutdown();
    await controller?.flushSaves();
    agentEvents.dispose();
    providerUsage.dispose();
    phoneNotifications.dispose();
    controller?.dispose();
    paneLauncher.dispose();
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
  agentEvents.dispose();
  providerUsage.dispose();
  phoneNotifications.dispose();
  controller?.dispose();
  paneLauncher.dispose();
  void workspace.dispose();
});
