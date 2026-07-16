import { normalizeWorkspaceState } from "./phase3b-core";

export type AgentProvider = "codex" | "grok";

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

export function selectClipboardImageSequence(
  provider: AgentProvider | null | undefined,
): string | null {
  if (provider === "codex") return "\u0016";
  if (provider === "grok") return "\u001bv";
  return null;
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
