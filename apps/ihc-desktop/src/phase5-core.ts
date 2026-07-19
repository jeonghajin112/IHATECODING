import { normalizeWorkspaceState } from "./phase3b-core";
import { formatAppNumber, tr } from "./i18n";

export type AgentProvider = "codex" | "grok";

export type RectangleBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function rectanglesOverlap(first: RectangleBounds, second: RectangleBounds) {
  const edges = [
    first.left,
    first.top,
    first.right,
    first.bottom,
    second.left,
    second.top,
    second.right,
    second.bottom,
  ];
  if (!edges.every(Number.isFinite)) return false;
  if (
    first.left >= first.right ||
    first.top >= first.bottom ||
    second.left >= second.right ||
    second.top >= second.bottom
  ) {
    return false;
  }
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

export type ResumeBlockingReason =
  | "legacyResumeBlocked"
  | "dualProviderBinding"
  | "duplicateProviderBinding";

export type ResumeCandidate = {
  provider: AgentProvider;
  conversationId: string;
};

export type ResumeOwner = {
  projectId: string;
  terminalId: string;
};

export type SafeResumePlan = {
  projectId: string;
  terminalId: string;
  action: "shell" | "resume" | "blocked";
  provider: AgentProvider | null;
  conversationId: string | null;
  candidates: ResumeCandidate[];
  blockingReasons: ResumeBlockingReason[];
  duplicateOwners: ResumeOwner[];
};

export type AgentRuntimeEventKind = "turnStarted" | "turnCompleted";
export type AgentTurnOutcome =
  | "success"
  | "cancelled"
  | "failed"
  | "timeout"
  | "unknown";

export type AgentRuntimeEvent = {
  provider: AgentProvider;
  event: AgentRuntimeEventKind;
  projectId: string;
  terminalId: string;
  conversationId: string;
  routeToken: string;
  paneGeneration: number;
  turnKey: string;
  outcome: AgentTurnOutcome | null;
};

export type AgentRuntimeBinding = {
  provider: AgentProvider;
  projectId: string;
  terminalId: string;
  conversationId: string;
  routeToken: string;
  paneGeneration: number;
};

export type AgentCorrelationState = {
  activeTurnKeys: string[];
  settledTurnKeys: string[];
};

export type AgentCorrelationIgnoreReason =
  | "bindingMismatch"
  | "duplicateEvent"
  | "missingTurnStart"
  | "unsuccessfulOutcome";

export type AgentCorrelationResult = {
  state: AgentCorrelationState;
  disposition: "started" | "completed" | "ignored";
  reason: AgentCorrelationIgnoreReason | null;
  completion: AgentRuntimeEvent | null;
};

export type ProviderLimitUsage = {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt: string;
  updatedAt: string;
};

export type ProviderAccountAuthMode = "chatgpt" | "apiKey" | "xai";

export type ProviderAccountSummary = {
  displayLabel: string;
  plan: string | null;
  authMode: ProviderAccountAuthMode;
};

export type ProviderAccountProfile = {
  id: string;
  displayLabel: string;
  active: boolean;
  managed: boolean;
};

export type ProviderAccountListResponse = {
  provider: AgentProvider;
  accounts: ProviderAccountProfile[];
  activeAccountId: string;
  restartRequired: boolean;
};

export type ProviderUsage = {
  fiveHour: ProviderLimitUsage | null;
  weekly: ProviderLimitUsage | null;
  updatedAt: string | null;
};

export type ProviderUsageResponse = {
  codex: ProviderUsage;
  grok: ProviderUsage;
  readAt: string;
};

export type WorkspaceUnreadSummary = {
  total: number;
  projects: Record<string, number>;
  tabs: Record<string, number>;
};

export type TerminalLaunchPaintDecision = "idle" | "waiting" | "recover";

const TERMINAL_LAUNCH_ESCAPE_TAIL_LENGTH = 16;
const TERMINAL_LAUNCH_CONTROL_PATTERN =
  /(?:\x1b\[|\u009b)\?(?:47|1047|1049|2026)h/;

export function scanTerminalLaunchControl(tail: string, data: string) {
  const combined = tail.slice(-TERMINAL_LAUNCH_ESCAPE_TAIL_LENGTH) + data;
  return {
    detected: TERMINAL_LAUNCH_CONTROL_PATTERN.test(combined),
    tail: combined.slice(-TERMINAL_LAUNCH_ESCAPE_TAIL_LENGTH),
  };
}

export type TerminalDirectPaintState = {
  documentVisible: boolean;
  connected: boolean;
  hidden: boolean;
  paneActive: boolean;
  focusInside: boolean;
};

export function shouldDirectPaintTerminalOutput(state: TerminalDirectPaintState) {
  return (
    state.documentVisible &&
    state.connected &&
    !state.hidden &&
    (state.paneActive || state.focusInside)
  );
}

export type TerminalDirectRefreshState = {
  hasUnpaintedOutput: boolean;
  firstBatchAfterIdle: boolean;
  millisecondsSinceLastForcedRefresh: number;
};

export function shouldForceDirectTerminalRefresh(
  state: TerminalDirectRefreshState,
  minimumIntervalMs: number,
) {
  return (
    state.hasUnpaintedOutput &&
    (state.firstBatchAfterIdle ||
      state.millisecondsSinceLastForcedRefresh >= minimumIntervalMs)
  );
}

/**
 * Tracks one bounded paint checkpoint at a time. Enter arms the first output;
 * the raw-output scanner independently re-arms immediately before an alternate
 * buffer control is parsed. Normal streaming output does not retain a launch
 * watchdog after its first visible paint.
 */
export class TerminalLaunchPaintWatchdog {
  private armedEpoch: number | null = null;
  private firstOutputObserved = false;
  private alternateBufferObserved = false;
  private expectedRenderVersion = 0;
  private synchronizationDeadline = 0;
  private recoveryUsed = false;

  constructor(private readonly synchronizationLimitMs: number) {
    if (!Number.isFinite(synchronizationLimitMs) || synchronizationLimitMs <= 0) {
      throw new Error("The terminal paint synchronization limit must be positive.");
    }
  }

  arm(epoch: number) {
    this.clear();
    this.armedEpoch = epoch;
  }

  clear() {
    this.armedEpoch = null;
    this.firstOutputObserved = false;
    this.alternateBufferObserved = false;
    this.expectedRenderVersion = 0;
    this.synchronizationDeadline = 0;
    this.recoveryUsed = false;
  }

  expire(epoch: number) {
    if (this.armedEpoch === epoch) this.clear();
  }

  observeOutput(
    epoch: number,
    renderVersion: number,
    enteredAlternateBuffer: boolean,
    now: number,
  ) {
    if (this.armedEpoch !== epoch || this.recoveryUsed) return false;
    const isFirstOutput = !this.firstOutputObserved;
    const isFirstAlternateBuffer =
      enteredAlternateBuffer && !this.alternateBufferObserved;
    if (!isFirstOutput && !isFirstAlternateBuffer) return false;

    this.firstOutputObserved = true;
    if (isFirstAlternateBuffer) this.alternateBufferObserved = true;
    this.expectedRenderVersion = Math.max(1, renderVersion);
    this.synchronizationDeadline = now + this.synchronizationLimitMs;
    return true;
  }

  observePaint(renderVersion: number) {
    if (
      this.expectedRenderVersion === 0 ||
      renderVersion < this.expectedRenderVersion
    ) {
      return false;
    }
    this.clear();
    return true;
  }

  poll(
    epoch: number,
    paintedRenderVersion: number,
    synchronizedOutputMode: boolean,
    now: number,
  ): TerminalLaunchPaintDecision {
    if (this.armedEpoch !== epoch || this.expectedRenderVersion === 0) {
      return "idle";
    }
    if (paintedRenderVersion >= this.expectedRenderVersion) {
      this.observePaint(paintedRenderVersion);
      return "idle";
    }
    if (synchronizedOutputMode && now < this.synchronizationDeadline) {
      return "waiting";
    }

    // One recovery is enough to wake a stalled WebView/xterm paint pipeline.
    // Never turn this into a periodic repaint loop for normal terminal output.
    this.recoveryUsed = true;
    this.expectedRenderVersion = 0;
    this.synchronizationDeadline = 0;
    return "recover";
  }

  get isArmed() {
    return this.armedEpoch !== null;
  }

  /**
   * Output that belongs to a just-submitted command must not wait behind a
   * WebView timer. xterm normally uses timers to batch writes, but WebView2 can
   * leave those timers parked after a terminal has been re-laid out. Keep the
   * direct path active until that checkpoint paints (or the bounded probe
   * expires). A delayed alternate-buffer control re-arms through the raw scan.
   */
  get shouldBypassRenderTimers() {
    return this.armedEpoch !== null && !this.recoveryUsed;
  }

  get hasPendingPaint() {
    return this.expectedRenderVersion !== 0;
  }
}

export class ProjectActivityTracker {
  private readonly activeTerminalIdsByProject = new Map<string, Set<string>>();

  setTerminalWorking(
    projectId: string,
    terminalId: string,
    working: boolean,
  ): boolean {
    if (working) {
      const activeTerminalIds =
        this.activeTerminalIdsByProject.get(projectId) ?? new Set<string>();
      activeTerminalIds.add(terminalId);
      this.activeTerminalIdsByProject.set(projectId, activeTerminalIds);
    } else {
      const activeTerminalIds = this.activeTerminalIdsByProject.get(projectId);
      if (activeTerminalIds) {
        activeTerminalIds.delete(terminalId);
        if (activeTerminalIds.size === 0) {
          this.activeTerminalIdsByProject.delete(projectId);
        }
      }
    }

    return this.isProjectWorking(projectId);
  }

  isProjectWorking(projectId: string): boolean {
    return (this.activeTerminalIdsByProject.get(projectId)?.size ?? 0) > 0;
  }

  clearProject(projectId: string): boolean {
    return this.activeTerminalIdsByProject.delete(projectId);
  }

  clear(): void {
    this.activeTerminalIdsByProject.clear();
  }
}

export const MAX_AGENT_CORRELATION_TURNS = 512;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const MAX_OPAQUE_TEXT_LENGTH = 256;

export function deriveSafeResumePlans(stateValue: unknown): SafeResumePlan[] {
  const state = normalizeWorkspaceState(stateValue);
  const ownership = new Map<string, ResumeOwner[]>();

  for (const project of state.projects) {
    for (const terminal of project.terminals) {
      for (const candidate of terminalResumeCandidates(terminal)) {
        const key = providerConversationKey(candidate.provider, candidate.conversationId);
        const owners = ownership.get(key) ?? [];
        owners.push({ projectId: project.id, terminalId: terminal.id });
        ownership.set(key, owners);
      }
    }
  }

  return state.projects.flatMap((project) =>
    project.terminals.map((terminal) => {
      const candidates = terminalResumeCandidates(terminal);
      const blockingReasons: ResumeBlockingReason[] = [];
      if (candidates.length > 0 && terminal.legacyExtensions.resumeBlocked === true) {
        blockingReasons.push("legacyResumeBlocked");
      }
      if (candidates.length > 1) blockingReasons.push("dualProviderBinding");

      const duplicateOwners = uniqueOwners(
        candidates.flatMap((candidate) => {
          const owners = ownership.get(
            providerConversationKey(candidate.provider, candidate.conversationId),
          );
          return owners && owners.length > 1 ? owners : [];
        }),
      );
      if (duplicateOwners.length > 0) {
        blockingReasons.push("duplicateProviderBinding");
      }

      const single = candidates.length === 1 ? candidates[0] : null;
      return {
        projectId: project.id,
        terminalId: terminal.id,
        action:
          blockingReasons.length > 0
            ? "blocked"
            : single
              ? "resume"
              : "shell",
        provider: single?.provider ?? null,
        conversationId: single?.conversationId ?? null,
        candidates,
        blockingReasons,
        duplicateOwners,
      } satisfies SafeResumePlan;
    }),
  );
}

export function findSafeResumePlan(
  stateValue: unknown,
  projectId: string,
  terminalId: string,
): SafeResumePlan {
  const plan = deriveSafeResumePlans(stateValue).find(
    (candidate) =>
      candidate.projectId === projectId && candidate.terminalId === terminalId,
  );
  if (!plan) throw new Error("The requested workspace terminal does not exist.");
  return plan;
}

export function normalizeAgentRuntimeEvent(value: unknown): AgentRuntimeEvent {
  const event = requireRecord(value, "agent runtime event");
  const provider = requireProvider(event.provider, "provider");
  const eventKind = requireEventKind(event.event, "event");
  const outcome = normalizeOutcome(event.outcome, eventKind);
  return {
    provider,
    event: eventKind,
    projectId: requireOpaqueText(event.projectId, "projectId"),
    terminalId: requireOpaqueText(event.terminalId, "terminalId"),
    conversationId: requireUuid(event.conversationId, "conversationId"),
    routeToken: requireOpaqueText(event.routeToken, "routeToken"),
    paneGeneration: requireSafeNonNegativeInteger(
      event.paneGeneration,
      "paneGeneration",
    ),
    turnKey: normalizeTurnKey(event.turnKey),
    outcome,
  };
}

export function createAgentCorrelationState(): AgentCorrelationState {
  return { activeTurnKeys: [], settledTurnKeys: [] };
}

export function reduceAgentRuntimeEvent(
  stateValue: AgentCorrelationState,
  bindingValue: AgentRuntimeBinding,
  eventValue: unknown,
): AgentCorrelationResult {
  const state = normalizeCorrelationState(stateValue);
  const binding = normalizeAgentRuntimeBinding(bindingValue);
  const event = normalizeAgentRuntimeEvent(eventValue);
  if (!eventMatchesBinding(event, binding)) {
    return ignored(state, "bindingMismatch");
  }

  const key = correlationKey(event);
  if (state.settledTurnKeys.includes(key)) {
    return ignored(state, "duplicateEvent");
  }

  if (event.event === "turnStarted") {
    if (state.activeTurnKeys.includes(key)) {
      return ignored(state, "duplicateEvent");
    }
    return {
      state: {
        activeTurnKeys: appendBounded(state.activeTurnKeys, key),
        settledTurnKeys: [...state.settledTurnKeys],
      },
      disposition: "started",
      reason: null,
      completion: null,
    };
  }

  if (event.provider === "grok" && !state.activeTurnKeys.includes(key)) {
    return ignored(state, "missingTurnStart");
  }

  const nextState = settleTurn(state, key);
  if (!isSuccessfulCompletion(event)) {
    return ignored(nextState, "unsuccessfulOutcome");
  }
  return {
    state: nextState,
    disposition: "completed",
    reason: null,
    completion: event,
  };
}

export function normalizeProviderUsageResponse(value: unknown): ProviderUsageResponse {
  const response = requireRecord(value, "provider usage response");
  return {
    codex: normalizeProviderUsage(response.codex, "codex"),
    grok: normalizeProviderUsage(response.grok, "grok"),
    readAt: requireRfc3339(response.readAt, "readAt"),
  };
}

/**
 * Returns the exact delay until the nearest future reset represented by an
 * already-normalized provider usage snapshot. Missing limits and reset times
 * that have already elapsed cannot schedule a refresh.
 */
export function millisecondsUntilNextProviderUsageReset(
  usage: ProviderUsageResponse,
  nowUnixMs = Date.now(),
): number | null {
  requireFiniteNumber(nowUnixMs, "current time");
  let nearestDelayMs: number | null = null;

  for (const provider of [usage.codex, usage.grok]) {
    for (const limit of [provider.fiveHour, provider.weekly]) {
      if (limit === null) continue;
      const delayMs = Date.parse(limit.resetsAt) - nowUnixMs;
      if (delayMs <= 0) continue;
      if (nearestDelayMs === null || delayMs < nearestDelayMs) {
        nearestDelayMs = delayMs;
      }
    }
  }

  return nearestDelayMs;
}

export function normalizeProviderAccountSummary(value: unknown): ProviderAccountSummary | null {
  if (value === null) return null;
  const account = requireRecord(value, "provider account summary");
  const authMode = account.authMode;
  if (authMode !== "chatgpt" && authMode !== "apiKey" && authMode !== "xai") {
    throw new Error("The provider account authMode is invalid.");
  }
  return {
    displayLabel: requireProviderAccountText(account.displayLabel, "displayLabel", 254),
    plan:
      account.plan === null
        ? null
        : requireProviderAccountText(account.plan, "plan", 64),
    authMode,
  };
}

export function normalizeProviderAccountListResponse(
  value: unknown,
): ProviderAccountListResponse {
  const response = requireRecord(value, "provider account list");
  const provider = requireProvider(response.provider, "provider account list");
  if (!Array.isArray(response.accounts) || response.accounts.length === 0) {
    throw new Error("The provider account list must contain an account.");
  }
  if (response.accounts.length > 32) {
    throw new Error("The provider account list is too large.");
  }
  const ids = new Set<string>();
  const accounts = response.accounts.map((entry, index) => {
    const account = requireRecord(entry, `provider account ${index}`);
    const id = requireUuid(account.id, `provider account ${index} id`);
    if (ids.has(id)) throw new Error("The provider account list contains duplicate ids.");
    ids.add(id);
    if (typeof account.active !== "boolean" || typeof account.managed !== "boolean") {
      throw new Error("The provider account flags are invalid.");
    }
    return {
      id,
      displayLabel: requireProviderAccountText(
        account.displayLabel,
        `accounts[${index}].displayLabel`,
        254,
      ),
      active: account.active,
      managed: account.managed,
    };
  });
  const activeAccountId = requireUuid(response.activeAccountId, "activeAccountId");
  if (!ids.has(activeAccountId)) {
    throw new Error("The active provider account is missing from the account list.");
  }
  if (accounts.filter((account) => account.active).length !== 1) {
    throw new Error("The provider account list must have one active account.");
  }
  if (!accounts.find((account) => account.active && account.id === activeAccountId)) {
    throw new Error("The active provider account flags do not match.");
  }
  if (typeof response.restartRequired !== "boolean") {
    throw new Error("The provider account restart flag is invalid.");
  }
  return { provider, accounts, activeAccountId, restartRequired: response.restartRequired };
}

export function formatProviderResetCountdown(
  resetsAt: string,
  nowUnixMs = Date.now(),
): string {
  const normalizedReset = requireRfc3339(resetsAt, "provider reset time");
  requireFiniteNumber(nowUnixMs, "current time");
  const remainingMs = Date.parse(normalizedReset) - nowUnixMs;
  if (remainingMs <= 0) return tr("Resetting soon", "곧 초기화");

  const totalMinutes = Math.max(1, Math.floor(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  if (days >= 1) {
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const localizedDays = formatAppNumber(days);
    const localizedHours = formatAppNumber(hours);
    return tr(
      `${localizedDays}d ${localizedHours}h`,
      `${localizedDays}일 ${localizedHours}시간`,
    );
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 1) {
    const localizedHours = formatAppNumber(hours);
    const localizedMinutes = formatAppNumber(totalMinutes % 60);
    return tr(
      `${localizedHours}h ${localizedMinutes}m`,
      `${localizedHours}시간 ${localizedMinutes}분`,
    );
  }
  const localizedMinutes = formatAppNumber(totalMinutes);
  return tr(`${localizedMinutes}m`, `${localizedMinutes}분`);
}

export function selectClipboardImageSequence(
  provider: AgentProvider | null | undefined,
): string | null {
  if (provider === "codex") return "\u0016";
  if (provider === "grok") return "\u001bv";
  return null;
}

/**
 * UI Pick owns a compact local-file reference, never terminal control input.
 * The system clipboard is globally writable, so strip every C0/DEL control
 * even when the marker appears valid before handing the text to a PTY.
 */
export function sanitizeUiPickClipboardText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 32_768);
}

export const MAX_DROPPED_FILE_REFERENCES = 20;
const MAX_DROPPED_FILE_PATH_CHARS = 32_768;
const MAX_DROPPED_FILE_TOTAL_CHARS = 128 * 1_024;
const IMAGE_FILE_EXTENSIONS = new Set([
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

export type DroppedFilePathSelection = Readonly<{
  paths: string[];
  skipped: number;
}>;

/**
 * Accept only native absolute Windows paths and remove control characters,
 * duplicates, and oversized batches before they can reach a PTY.
 */
export function selectDroppedFilePaths(
  candidates: readonly string[],
  maxFiles = MAX_DROPPED_FILE_REFERENCES,
): DroppedFilePathSelection {
  const paths: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let totalCharacters = 0;
  const boundedMaximum = Math.max(0, Math.min(MAX_DROPPED_FILE_REFERENCES, maxFiles));

  for (const candidate of candidates) {
    const path = typeof candidate === "string" ? candidate.trim() : "";
    const absoluteWindowsPath =
      /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
    const invalid =
      !path ||
      !absoluteWindowsPath ||
      path.length > MAX_DROPPED_FILE_PATH_CHARS ||
      /[\u0000-\u001f\u007f]/.test(path);
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (
      invalid ||
      seen.has(key) ||
      paths.length >= boundedMaximum ||
      totalCharacters + path.length > MAX_DROPPED_FILE_TOTAL_CHARS
    ) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    paths.push(path);
    totalCharacters += path.length;
  }

  return { paths, skipped };
}

export function isLikelyImageFilePath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") && IMAGE_FILE_EXTENSIONS.has(extension);
}

/**
 * Codex turns a pasted image path into a real image attachment. Other agent
 * files use their @-file reference syntax; a plain shell receives only an
 * inert quoted path. Windows file names cannot contain a double quote.
 */
export function formatDroppedFileReference(
  provider: AgentProvider | null | undefined,
  path: string,
): string {
  const quotedPath = `"${path}"`;
  if (provider === "codex" && isLikelyImageFilePath(path)) return quotedPath;
  if (provider === "codex" || provider === "grok") return `@${quotedPath}`;
  return quotedPath;
}

export type TerminalShortcutEvent = Readonly<{
  key: string;
  code?: string;
  keyCode?: number;
  which?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}>;

/**
 * Keeps the last real xterm selection alive across the short interval where
 * Chromium/xterm can clear its live selection while dispatching a copy key.
 * A new pointer gesture or non-copy input intent explicitly invalidates it.
 */
export class TerminalSelectionCopyGuard {
  private retainedSelection = "";

  captureLiveSelection(selection: string): void {
    if (selection.length > 0) this.retainedSelection = selection;
  }

  beginPointerGesture(): void {
    this.retainedSelection = "";
  }

  invalidate(): void {
    this.retainedSelection = "";
  }

  hasCopySelection(liveSelection: string): boolean {
    return this.selectionForCopy(liveSelection) !== null;
  }

  selectionForCopy(liveSelection: string): string | null {
    this.captureLiveSelection(liveSelection);
    return liveSelection || this.retainedSelection || null;
  }

  selectionForShortcut(
    event: TerminalShortcutEvent,
    liveSelection: string,
  ): string | null {
    if (!isTerminalCopyShortcut(event) && !isTerminalCtrlInsertShortcut(event)) {
      return null;
    }
    return this.selectionForCopy(liveSelection);
  }

  selectionForTerminalInput(
    data: string,
    liveSelection: string,
  ): string | null {
    if (!isTerminalEncodedCopyInput(data)) return null;
    return this.selectionForCopy(liveSelection);
  }
}

export function isTerminalCopyShortcut(event: TerminalShortcutEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  return (
    event.key.toLowerCase() === "c" ||
    event.code?.toLowerCase() === "keyc" ||
    event.keyCode === 67 ||
    event.which === 67
  );
}

export function isTerminalCtrlInsertShortcut(
  event: TerminalShortcutEvent,
): boolean {
  if (!event.ctrlKey) return false;
  return (
    event.key.toLowerCase() === "insert" ||
    event.code?.toLowerCase() === "insert" ||
    event.keyCode === 45 ||
    event.which === 45
  );
}

/**
 * Recognizes the input records xterm can emit for Ctrl+C/Ctrl+Insert.  The
 * ordinary terminal path is ETX, while Codex can enable Kitty keyboard or
 * Win32 input mode at runtime.  This is a final data-plane safety net: when a
 * selection exists these records are clipboard commands and must never reach
 * the PTY, even if WebView2 dispatched the DOM key outside the terminal.
 */
export function isTerminalEncodedCopyInput(data: string): boolean {
  if (data === "\u0003") return true;

  const win32 = /^\u001b\[(\d+);(\d+);(\d+);([01]);(\d+);(\d+)_$/.exec(data);
  if (win32) {
    const virtualKey = Number(win32[1]);
    const controlState = Number(win32[5]);
    const ctrlPressed = (controlState & 0b1100) !== 0;
    return ctrlPressed && (virtualKey === 67 || virtualKey === 45);
  }

  const kittyCsiU = /^\u001b\[(\d+)(?::\d+(?::\d+)?)?(?:;(\d+)(?::[123])?)?(?:;\d+(?::\d+)*)?u$/.exec(
    data,
  );
  if (kittyCsiU) {
    const keyCode = Number(kittyCsiU[1]);
    const modifiers = Number(kittyCsiU[2] ?? 1) - 1;
    return keyCode === 99 && (modifiers & 0b0100) !== 0;
  }

  const kittyInsert = /^\u001b\[2;(\d+)(?::[123])?~$/.exec(data);
  if (kittyInsert) {
    const modifiers = Number(kittyInsert[1]) - 1;
    return (modifiers & 0b0100) !== 0;
  }

  return false;
}

/**
 * Detects the standalone modifier records emitted by xterm's enhanced keyboard
 * protocols. In Win32 input mode xterm emits a Control-key record before the
 * following Ctrl+C record. That first record is protocol state, not an editing
 * intent, so hosts must not clear an existing terminal selection when relaying
 * it to the PTY.
 */
export function isTerminalModifierOnlyInput(data: string): boolean {
  const win32 = /^\u001b\[(\d+);\d+;\d+;[01];\d+;\d+_$/.exec(data);
  if (win32) {
    const virtualKey = Number(win32[1]);
    return [16, 17, 18, 91, 92, 93, 224].includes(virtualKey);
  }

  const kittyCsiU = /^\u001b\[(\d+)(?::\d+(?::\d+)?)?(?:;\d+(?::[123])?)?(?:;\d+(?::\d+)*)?u$/.exec(
    data,
  );
  if (!kittyCsiU) return false;

  const keyCode = Number(kittyCsiU[1]);
  return [57441, 57447, 57442, 57448, 57443, 57449, 57444, 57450].includes(
    keyCode,
  );
}

export function shouldOwnTerminalCopyFallback(
  context: Readonly<{
    paneActive: boolean;
    hasCopySelection: boolean;
    passiveDocumentTarget: boolean;
    nativeTerminalSelection: boolean;
    externalEditableTarget: boolean;
    externalDocumentSelection: boolean;
  }>,
): boolean {
  return (
    context.paneActive &&
    context.hasCopySelection &&
    !context.externalEditableTarget &&
    !context.externalDocumentSelection &&
    (context.passiveDocumentTarget || context.nativeTerminalSelection)
  );
}

export function shouldManuallySendTerminalInterrupt(
  event: TerminalShortcutEvent,
  hasSelection: boolean,
): boolean {
  if (
    hasSelection ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    !isTerminalCopyShortcut(event)
  ) {
    return false;
  }
  return (
    event.isComposing === true ||
    event.keyCode === 229 ||
    event.which === 229 ||
    event.key.toLowerCase() !== "c"
  );
}

export function deriveWorkspaceUnreadSummary(
  stateValue: unknown,
): WorkspaceUnreadSummary {
  const state = normalizeWorkspaceState(stateValue);
  const projects = Object.fromEntries(
    state.projects.map((project) => [
      project.id,
      project.terminals.filter((terminal) => terminal.completionPending).length,
    ]),
  );
  const tabs = Object.fromEntries(
    state.tabs.map((tab) => [
      tab.id,
      tab.projectId === null ? 0 : projects[tab.projectId] ?? 0,
    ]),
  );
  return {
    total: Object.values(projects).reduce((sum, count) => sum + count, 0),
    projects,
    tabs,
  };
}

function terminalResumeCandidates(terminal: {
  codexThreadId: string | null;
  grokSessionId: string | null;
}): ResumeCandidate[] {
  const candidates: ResumeCandidate[] = [];
  if (terminal.codexThreadId !== null) {
    candidates.push({ provider: "codex", conversationId: terminal.codexThreadId });
  }
  if (terminal.grokSessionId !== null) {
    candidates.push({ provider: "grok", conversationId: terminal.grokSessionId });
  }
  return candidates;
}

function providerConversationKey(provider: AgentProvider, conversationId: string) {
  return `${provider}:${conversationId.toLowerCase()}`;
}

function uniqueOwners(owners: readonly ResumeOwner[]): ResumeOwner[] {
  const seen = new Set<string>();
  return owners.filter((owner) => {
    const key = `${owner.projectId}\0${owner.terminalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAgentRuntimeBinding(
  value: AgentRuntimeBinding,
): AgentRuntimeBinding {
  const binding = requireRecord(value, "agent runtime binding");
  return {
    provider: requireProvider(binding.provider, "provider"),
    projectId: requireOpaqueText(binding.projectId, "projectId"),
    terminalId: requireOpaqueText(binding.terminalId, "terminalId"),
    conversationId: requireUuid(binding.conversationId, "conversationId"),
    routeToken: requireOpaqueText(binding.routeToken, "routeToken"),
    paneGeneration: requireSafeNonNegativeInteger(
      binding.paneGeneration,
      "paneGeneration",
    ),
  };
}

function normalizeCorrelationState(value: AgentCorrelationState): AgentCorrelationState {
  const state = requireRecord(value, "agent correlation state");
  return {
    activeTurnKeys: requireStringArray(state.activeTurnKeys, "activeTurnKeys"),
    settledTurnKeys: requireStringArray(state.settledTurnKeys, "settledTurnKeys"),
  };
}

function eventMatchesBinding(
  event: AgentRuntimeEvent,
  binding: AgentRuntimeBinding,
) {
  return (
    event.provider === binding.provider &&
    event.projectId === binding.projectId &&
    event.terminalId === binding.terminalId &&
    event.conversationId.toLowerCase() === binding.conversationId.toLowerCase() &&
    event.routeToken === binding.routeToken &&
    event.paneGeneration === binding.paneGeneration
  );
}

function correlationKey(event: AgentRuntimeEvent) {
  return [
    event.provider,
    event.conversationId.toLowerCase(),
    event.routeToken,
    String(event.paneGeneration),
    event.turnKey,
  ].join("\0");
}

function settleTurn(state: AgentCorrelationState, key: string): AgentCorrelationState {
  return {
    activeTurnKeys: state.activeTurnKeys.filter((candidate) => candidate !== key),
    settledTurnKeys: appendBounded(state.settledTurnKeys, key),
  };
}

function appendBounded(values: readonly string[], value: string): string[] {
  return [...values, value].slice(-MAX_AGENT_CORRELATION_TURNS);
}

function ignored(
  state: AgentCorrelationState,
  reason: AgentCorrelationIgnoreReason,
): AgentCorrelationResult {
  return {
    state,
    disposition: "ignored",
    reason,
    completion: null,
  };
}

function isSuccessfulCompletion(event: AgentRuntimeEvent) {
  if (event.event !== "turnCompleted") return false;
  if (event.provider === "grok") return event.outcome === "success";
  return event.outcome === null || event.outcome === "success";
}

function normalizeProviderUsage(value: unknown, pointer: string): ProviderUsage {
  const usage = requireRecord(value, `${pointer} usage`);
  return {
    fiveHour: normalizeNullableLimit(usage.fiveHour, `${pointer}.fiveHour`),
    weekly: normalizeNullableLimit(usage.weekly, `${pointer}.weekly`),
    updatedAt:
      usage.updatedAt === null
        ? null
        : requireRfc3339(usage.updatedAt, `${pointer}.updatedAt`),
  };
}

function normalizeNullableLimit(value: unknown, pointer: string) {
  if (value === null) return null;
  const limit = requireRecord(value, `${pointer} limit`);
  const usedPercent = clampPercent(requireFiniteNumber(limit.usedPercent, `${pointer}.usedPercent`));
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowMinutes: requirePositiveInteger(limit.windowMinutes, `${pointer}.windowMinutes`),
    resetsAt: requireRfc3339(limit.resetsAt, `${pointer}.resetsAt`),
    updatedAt: requireRfc3339(limit.updatedAt, `${pointer}.updatedAt`),
  } satisfies ProviderLimitUsage;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function normalizeOutcome(
  value: unknown,
  event: AgentRuntimeEventKind,
): AgentTurnOutcome | null {
  if (event === "turnStarted") {
    if (value !== undefined && value !== null) {
      throw new Error("A turnStarted event cannot carry an outcome.");
    }
    return null;
  }
  if (value === undefined || value === null) return null;
  if (
    value === "success" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "timeout" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new Error("The agent runtime event outcome is invalid.");
}

function normalizeTurnKey(value: unknown): string {
  if (typeof value === "number") {
    return String(requireSafeNonNegativeInteger(value, "turnKey"));
  }
  return requireOpaqueText(value, "turnKey");
}

function requireProvider(value: unknown, pointer: string): AgentProvider {
  if (value === "codex" || value === "grok") return value;
  throw new Error(`The ${pointer} provider is invalid.`);
}

function requireEventKind(value: unknown, pointer: string): AgentRuntimeEventKind {
  if (value === "turnStarted" || value === "turnCompleted") return value;
  throw new Error(`The ${pointer} kind is invalid.`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireOpaqueText(value: unknown, pointer: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    value.length > MAX_OPAQUE_TEXT_LENGTH
  ) {
    throw new Error(`The ${pointer} value is invalid.`);
  }
  return value;
}

function requireProviderAccountText(
  value: unknown,
  pointer: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)
  ) {
    throw new Error(`The provider account ${pointer} is invalid.`);
  }
  return value;
}

function requireUuid(value: unknown, pointer: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`The ${pointer} value is not a UUID.`);
  }
  return value;
}

function requireSafeNonNegativeInteger(value: unknown, pointer: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`The ${pointer} value is not a safe non-negative integer.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, pointer: string): number {
  const result = requireSafeNonNegativeInteger(value, pointer);
  if (result === 0) throw new Error(`The ${pointer} value must be positive.`);
  return result;
}

function requireFiniteNumber(value: unknown, pointer: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`The ${pointer} value is not finite.`);
  }
  return value;
}

function requireRfc3339(value: unknown, pointer: string): string {
  if (
    typeof value !== "string" ||
    !RFC3339_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`The ${pointer} value is not an RFC 3339 timestamp.`);
  }
  return value;
}

function requireStringArray(value: unknown, pointer: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_CORRELATION_TURNS) {
    throw new Error(`The ${pointer} value is invalid.`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_OPAQUE_TEXT_LENGTH * 5 + 32
    ) {
      throw new Error(`The ${pointer} value is invalid.`);
    }
    return entry;
  });
}
