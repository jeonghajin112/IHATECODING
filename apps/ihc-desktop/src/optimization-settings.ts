export type OptimizationSettings = Readonly<{
  autoSleepIdleAgents: boolean;
}>;

export const OPTIMIZATION_SETTINGS_STORAGE_KEY = "ihatecoding.optimization.v1";
export const OPTIMIZATION_SETTINGS_CHANGED_EVENT =
  "ihatecoding:optimization-settings-changed";

export const DEFAULT_OPTIMIZATION_SETTINGS: OptimizationSettings = Object.freeze({
  autoSleepIdleAgents: false,
});

export const INACTIVE_AGENT_SLEEP_DELAY_MS = 5 * 60 * 1_000;
export const INACTIVE_AGENT_SLEEP_SWEEP_MS = 30 * 1_000;

export type InactiveAgentSleepState = Readonly<{
  enabled: boolean;
  projectActive: boolean;
  paneRunning: boolean;
  runtimeSessionPresent: boolean;
  resumableConversation: boolean;
  agentTurnState: "unknown" | "working" | "idle";
  lifecycleSettled: boolean;
  projectInactiveSinceUnixMs: number | null;
  agentIdleSinceUnixMs: number | null;
}>;

export type InactiveBrowserSleepState = Readonly<{
  enabled: boolean;
  projectActive: boolean;
  paneRunning: boolean;
  projectInactiveSinceUnixMs: number | null;
}>;

export function agentTurnStartIdentity(
  turnId: string | null,
  observedAtUnixMs: number,
): string | null {
  if (!Number.isSafeInteger(observedAtUnixMs) || observedAtUnixMs < 0) return null;
  return turnId === null ? `observed:${observedAtUnixMs}` : `turn:${turnId}`;
}

export function shouldReleaseAgentInputProtection(input: Readonly<{
  baselineTurnStartIdentity: string | null;
  inputObservedAtUnixMs: number | null;
  nextTurnId: string | null;
  nextTurnObservedAtUnixMs: number;
}>): boolean {
  if (
    input.inputObservedAtUnixMs === null ||
    !Number.isSafeInteger(input.inputObservedAtUnixMs) ||
    input.inputObservedAtUnixMs < 0 ||
    input.nextTurnObservedAtUnixMs < input.inputObservedAtUnixMs
  ) {
    return false;
  }
  const nextIdentity = agentTurnStartIdentity(
    input.nextTurnId,
    input.nextTurnObservedAtUnixMs,
  );
  return (
    nextIdentity !== null &&
    (input.baselineTurnStartIdentity === null ||
      nextIdentity !== input.baselineTurnStartIdentity)
  );
}

export function inactiveAgentSleepDeadline(
  state: InactiveAgentSleepState,
  delayMs = INACTIVE_AGENT_SLEEP_DELAY_MS,
): number | null {
  if (
    !state.enabled ||
    state.projectActive ||
    !state.paneRunning ||
    !state.runtimeSessionPresent ||
    !state.resumableConversation ||
    state.agentTurnState !== "idle" ||
    !state.lifecycleSettled ||
    state.projectInactiveSinceUnixMs === null ||
    state.agentIdleSinceUnixMs === null ||
    !Number.isSafeInteger(state.projectInactiveSinceUnixMs) ||
    !Number.isSafeInteger(state.agentIdleSinceUnixMs) ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0
  ) {
    return null;
  }
  return Math.max(
    state.projectInactiveSinceUnixMs,
    state.agentIdleSinceUnixMs,
  ) + delayMs;
}

export function inactiveBrowserSleepDeadline(
  state: InactiveBrowserSleepState,
  delayMs = INACTIVE_AGENT_SLEEP_DELAY_MS,
): number | null {
  if (
    !state.enabled ||
    state.projectActive ||
    !state.paneRunning ||
    state.projectInactiveSinceUnixMs === null ||
    !Number.isSafeInteger(state.projectInactiveSinceUnixMs) ||
    state.projectInactiveSinceUnixMs < 0 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0
  ) {
    return null;
  }
  return state.projectInactiveSinceUnixMs + delayMs;
}

let currentSettings = loadOptimizationSettings();

export function resolveOptimizationSettings(
  storedValue: string | null | undefined,
): OptimizationSettings {
  if (!storedValue) return DEFAULT_OPTIMIZATION_SETTINGS;

  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (!isRecord(parsed) || typeof parsed.autoSleepIdleAgents !== "boolean") {
      return DEFAULT_OPTIMIZATION_SETTINGS;
    }
    return Object.freeze({
      autoSleepIdleAgents: parsed.autoSleepIdleAgents,
    });
  } catch {
    return DEFAULT_OPTIMIZATION_SETTINGS;
  }
}

export function getOptimizationSettings(): OptimizationSettings {
  return currentSettings;
}

export function getAutoSleepIdleAgents(): boolean {
  return currentSettings.autoSleepIdleAgents;
}

export function setAutoSleepIdleAgents(enabled: boolean): OptimizationSettings {
  if (currentSettings.autoSleepIdleAgents === enabled) return currentSettings;

  currentSettings = Object.freeze({ autoSleepIdleAgents: enabled });
  persistOptimizationSettings(currentSettings);
  dispatchOptimizationSettingsChanged(currentSettings);
  return currentSettings;
}

export function subscribeOptimizationSettings(
  listener: (settings: OptimizationSettings) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OptimizationSettings>).detail;
    listener(detail);
  };
  window.addEventListener(OPTIMIZATION_SETTINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(OPTIMIZATION_SETTINGS_CHANGED_EVENT, handler);
}

function loadOptimizationSettings(): OptimizationSettings {
  try {
    if (typeof window !== "undefined") {
      return resolveOptimizationSettings(
        window.localStorage.getItem(OPTIMIZATION_SETTINGS_STORAGE_KEY),
      );
    }
  } catch {
    // A missing or read-only WebView profile must keep automatic sleep safely off.
  }
  return DEFAULT_OPTIMIZATION_SETTINGS;
}

function persistOptimizationSettings(settings: OptimizationSettings): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        OPTIMIZATION_SETTINGS_STORAGE_KEY,
        JSON.stringify(settings),
      );
    }
  } catch {
    // Keep the in-memory setting usable when persistent WebView storage is unavailable.
  }
}

function dispatchOptimizationSettingsChanged(settings: OptimizationSettings): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OptimizationSettings>(OPTIMIZATION_SETTINGS_CHANGED_EVENT, {
      detail: settings,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
