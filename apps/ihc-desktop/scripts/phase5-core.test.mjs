import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "en-US", languages: ["en-US"] },
});

const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/phase5-core.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node18"],
  write: false,
  logLevel: "silent",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].contents,
).toString("base64")}`;
const core = await import(moduleUrl);

const CODEX_ID = "11111111-1111-4111-8111-111111111111";
const GROK_ID = "22222222-2222-4222-8222-222222222222";

function terminal(id, overrides = {}) {
  return {
    id,
    name: id.toUpperCase(),
    startDirectory: "C:\\Work\\Alpha",
    codexThreadId: null,
    grokSessionId: null,
    createdAtUtc: "2026-07-17T00:00:00Z",
    completionPending: false,
    legacyExtensions: {},
    ...overrides,
  };
}

function project(id, terminals) {
  return {
    id,
    name: id,
    folderPath: id === "project-a" ? "C:\\Work\\Alpha" : "D:\\Work\\Beta",
    terminals,
    paneWidthRatios: {},
    legacyExtensions: {},
  };
}

function projectTab(id, projectId) {
  return {
    id,
    kind: "project",
    title: projectId,
    projectId,
    browser: null,
    output: null,
    extensions: {},
  };
}

function workspace(projects, overrides = {}) {
  const tabs = projects.map((item, index) => projectTab(`tab-${index}`, item.id));
  return {
    schemaVersion: 1,
    revision: 7,
    writtenAtUtc: "2026-07-17T00:00:00Z",
    selectedProjectId: projects[0]?.id ?? null,
    projects,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    importProvenance: null,
    extensions: {},
    legacyExtensions: {},
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    provider: "codex",
    projectId: "project-a",
    terminalId: "pane-a",
    conversationId: CODEX_ID,
    routeToken: "route-a",
    paneGeneration: 3,
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    ...binding(),
    event: "turnCompleted",
    turnKey: "turn-1",
    outcome: null,
    ...overrides,
  };
}

test("resume plans distinguish plain shells and unique Codex/Grok bindings", () => {
  const state = workspace([
    project("project-a", [
      terminal("shell"),
      terminal("codex", { codexThreadId: CODEX_ID }),
      terminal("grok", { grokSessionId: GROK_ID }),
    ]),
  ]);
  const plans = core.deriveSafeResumePlans(state);
  assert.deepEqual(
    plans.map(({ terminalId, action, provider, conversationId }) => ({
      terminalId,
      action,
      provider,
      conversationId,
    })),
    [
      { terminalId: "shell", action: "shell", provider: null, conversationId: null },
      {
        terminalId: "codex",
        action: "resume",
        provider: "codex",
        conversationId: CODEX_ID,
      },
      {
        terminalId: "grok",
        action: "resume",
        provider: "grok",
        conversationId: GROK_ID,
      },
    ],
  );
  assert.equal(core.findSafeResumePlan(state, "project-a", "codex").action, "resume");
  assert.throws(
    () => core.findSafeResumePlan(state, "project-a", "missing"),
    /does not exist/,
  );
});

test("provider IDs are owned globally and case-insensitive duplicates block every owner", () => {
  const state = workspace([
    project("project-a", [terminal("pane-a", { codexThreadId: CODEX_ID })]),
    project("project-b", [
      terminal("pane-b", { codexThreadId: CODEX_ID.toUpperCase() }),
    ]),
  ]);
  const plans = core.deriveSafeResumePlans(state);
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.equal(plan.action, "blocked");
    assert.deepEqual(plan.blockingReasons, ["duplicateProviderBinding"]);
    assert.deepEqual(plan.duplicateOwners, [
      { projectId: "project-a", terminalId: "pane-a" },
      { projectId: "project-b", terminalId: "pane-b" },
    ]);
  }
});

test("the same UUID may independently belong to Codex and Grok", () => {
  const state = workspace([
    project("project-a", [terminal("pane-a", { codexThreadId: CODEX_ID })]),
    project("project-b", [terminal("pane-b", { grokSessionId: CODEX_ID })]),
  ]);
  assert.deepEqual(
    core.deriveSafeResumePlans(state).map((plan) => [plan.action, plan.provider]),
    [
      ["resume", "codex"],
      ["resume", "grok"],
    ],
  );
});

test("dual provider IDs never receive an implicit provider preference", () => {
  const state = workspace([
    project("project-a", [
      terminal("pane-a", { codexThreadId: CODEX_ID, grokSessionId: GROK_ID }),
    ]),
  ]);
  const plan = core.deriveSafeResumePlans(state)[0];
  assert.equal(plan.action, "blocked");
  assert.equal(plan.provider, null);
  assert.equal(plan.conversationId, null);
  assert.deepEqual(plan.blockingReasons, ["dualProviderBinding"]);
  assert.deepEqual(plan.candidates, [
    { provider: "codex", conversationId: CODEX_ID },
    { provider: "grok", conversationId: GROK_ID },
  ]);
});

test("legacy resumeBlocked blocks bound conversations but does not disable a plain shell", () => {
  const state = workspace([
    project("project-a", [
      terminal("blocked", {
        codexThreadId: CODEX_ID,
        legacyExtensions: { resumeBlocked: true },
      }),
      terminal("shell", { legacyExtensions: { resumeBlocked: true } }),
      terminal("string-flag", {
        grokSessionId: GROK_ID,
        legacyExtensions: { resumeBlocked: "true" },
      }),
    ]),
  ]);
  const [blocked, shell, stringFlag] = core.deriveSafeResumePlans(state);
  assert.equal(blocked.action, "blocked");
  assert.deepEqual(blocked.blockingReasons, ["legacyResumeBlocked"]);
  assert.equal(shell.action, "shell");
  assert.deepEqual(shell.blockingReasons, []);
  assert.equal(stringFlag.action, "resume");
});

test("all applicable resume blockers are reported in deterministic order", () => {
  const state = workspace([
    project("project-a", [
      terminal("pane-a", {
        codexThreadId: CODEX_ID,
        grokSessionId: GROK_ID,
        legacyExtensions: { resumeBlocked: true },
      }),
    ]),
    project("project-b", [terminal("pane-b", { codexThreadId: CODEX_ID })]),
  ]);
  const plan = core.findSafeResumePlan(state, "project-a", "pane-a");
  assert.deepEqual(plan.blockingReasons, [
    "legacyResumeBlocked",
    "dualProviderBinding",
    "duplicateProviderBinding",
  ]);
});

test("runtime event normalization accepts numeric turn numbers and validates every boundary", () => {
  assert.deepEqual(
    core.normalizeAgentRuntimeEvent(
      event({
        provider: "grok",
        conversationId: GROK_ID,
        event: "turnStarted",
        turnKey: 12,
        outcome: undefined,
      }),
    ),
    {
      provider: "grok",
      event: "turnStarted",
      projectId: "project-a",
      terminalId: "pane-a",
      conversationId: GROK_ID,
      routeToken: "route-a",
      paneGeneration: 3,
      turnKey: "12",
      outcome: null,
    },
  );

  const invalidCases = [
    [event({ provider: "other" }), /provider is invalid/],
    [event({ event: "output" }), /kind is invalid/],
    [event({ conversationId: "not-a-uuid" }), /not a UUID/],
    [event({ routeToken: "" }), /routeToken value is invalid/],
    [event({ paneGeneration: -1 }), /safe non-negative integer/],
    [event({ turnKey: -1 }), /safe non-negative integer/],
    [event({ outcome: "maybe" }), /outcome is invalid/],
    [event({ event: "turnStarted", outcome: "success" }), /cannot carry an outcome/],
  ];
  for (const [candidate, pattern] of invalidCases) {
    assert.throws(() => core.normalizeAgentRuntimeEvent(candidate), pattern);
  }
});

test("exact binding correlation rejects stale, cross-pane, and cross-provider events", () => {
  const expected = binding();
  const mismatches = [
    { provider: "grok", conversationId: GROK_ID },
    { projectId: "project-b" },
    { terminalId: "pane-b" },
    { conversationId: GROK_ID },
    { routeToken: "stale-route" },
    { paneGeneration: 2 },
  ];
  for (const mismatch of mismatches) {
    const result = core.reduceAgentRuntimeEvent(
      core.createAgentCorrelationState(),
      expected,
      event(mismatch),
    );
    assert.equal(result.disposition, "ignored");
    assert.equal(result.reason, "bindingMismatch");
    assert.deepEqual(result.state, core.createAgentCorrelationState());
  }

  const caseOnly = core.reduceAgentRuntimeEvent(
    core.createAgentCorrelationState(),
    expected,
    event({ conversationId: CODEX_ID.toUpperCase() }),
  );
  assert.equal(caseOnly.disposition, "completed");
});

test("Codex completion is correlated without requiring a synthetic start event and deduplicates", () => {
  const initial = core.createAgentCorrelationState();
  const completed = core.reduceAgentRuntimeEvent(initial, binding(), event());
  assert.equal(completed.disposition, "completed");
  assert.equal(completed.reason, null);
  assert.equal(completed.completion.turnKey, "turn-1");
  assert.deepEqual(initial, { activeTurnKeys: [], settledTurnKeys: [] });

  const duplicate = core.reduceAgentRuntimeEvent(completed.state, binding(), event());
  assert.equal(duplicate.disposition, "ignored");
  assert.equal(duplicate.reason, "duplicateEvent");
  assert.equal(duplicate.completion, null);
});

test("failed Codex completion settles the turn without producing a later false alert", () => {
  const failed = core.reduceAgentRuntimeEvent(
    core.createAgentCorrelationState(),
    binding(),
    event({ outcome: "failed" }),
  );
  assert.equal(failed.disposition, "ignored");
  assert.equal(failed.reason, "unsuccessfulOutcome");
  const lateSuccess = core.reduceAgentRuntimeEvent(
    failed.state,
    binding(),
    event({ outcome: "success" }),
  );
  assert.equal(lateSuccess.reason, "duplicateEvent");
});

test("Grok requires a correlated start and a successful completion", () => {
  const grokBinding = binding({ provider: "grok", conversationId: GROK_ID });
  const grokEvent = (overrides = {}) =>
    event({
      provider: "grok",
      conversationId: GROK_ID,
      turnKey: 44,
      ...overrides,
    });

  const missingStart = core.reduceAgentRuntimeEvent(
    core.createAgentCorrelationState(),
    grokBinding,
    grokEvent({ outcome: "success" }),
  );
  assert.equal(missingStart.reason, "missingTurnStart");

  const started = core.reduceAgentRuntimeEvent(
    missingStart.state,
    grokBinding,
    grokEvent({ event: "turnStarted", outcome: undefined }),
  );
  assert.equal(started.disposition, "started");
  const duplicateStart = core.reduceAgentRuntimeEvent(
    started.state,
    grokBinding,
    grokEvent({ event: "turnStarted", outcome: undefined }),
  );
  assert.equal(duplicateStart.reason, "duplicateEvent");

  const completed = core.reduceAgentRuntimeEvent(
    started.state,
    grokBinding,
    grokEvent({ outcome: "success" }),
  );
  assert.equal(completed.disposition, "completed");
  assert.equal(completed.completion.provider, "grok");
  assert.equal(completed.state.activeTurnKeys.length, 0);

  const duplicateEnd = core.reduceAgentRuntimeEvent(
    completed.state,
    grokBinding,
    grokEvent({ outcome: "success" }),
  );
  assert.equal(duplicateEnd.reason, "duplicateEvent");
});

test("cancelled, failed, timeout, unknown, and absent Grok outcomes never complete", () => {
  const grokBinding = binding({ provider: "grok", conversationId: GROK_ID });
  for (const outcome of ["cancelled", "failed", "timeout", "unknown", null]) {
    const turnKey = `turn-${outcome ?? "absent"}`;
    const started = core.reduceAgentRuntimeEvent(
      core.createAgentCorrelationState(),
      grokBinding,
      event({
        provider: "grok",
        conversationId: GROK_ID,
        event: "turnStarted",
        turnKey,
        outcome: undefined,
      }),
    );
    const ended = core.reduceAgentRuntimeEvent(
      started.state,
      grokBinding,
      event({
        provider: "grok",
        conversationId: GROK_ID,
        turnKey,
        outcome,
      }),
    );
    assert.equal(ended.disposition, "ignored");
    assert.equal(ended.reason, "unsuccessfulOutcome");
    assert.equal(ended.state.activeTurnKeys.length, 0);
    assert.equal(ended.state.settledTurnKeys.length, 1);
  }
});

test("correlation history remains bounded under long-running sessions", () => {
  let state = core.createAgentCorrelationState();
  for (let index = 0; index < core.MAX_AGENT_CORRELATION_TURNS + 25; index += 1) {
    state = core.reduceAgentRuntimeEvent(
      state,
      binding(),
      event({ turnKey: `turn-${index}` }),
    ).state;
  }
  assert.equal(state.settledTurnKeys.length, core.MAX_AGENT_CORRELATION_TURNS);
  assert.match(state.settledTurnKeys[0], /turn-25$/);
});

test("rectangle overlap detects a shared positive-area region", () => {
  const first = { left: 0, top: 0, right: 100, bottom: 80 };
  const second = { left: 75, top: 50, right: 150, bottom: 120 };

  assert.equal(core.rectanglesOverlap(first, second), true);
  assert.equal(core.rectanglesOverlap(second, first), true);
  assert.equal(
    core.rectanglesOverlap(first, { left: 20, top: 10, right: 40, bottom: 30 }),
    true,
  );
});

test("rectangle overlap keeps separated browser and popover regions visible", () => {
  const browser = { left: 900, top: 40, right: 1_600, bottom: 900 };

  assert.equal(
    core.rectanglesOverlap(browser, { left: 12, top: 700, right: 380, bottom: 890 }),
    false,
  );
  assert.equal(
    core.rectanglesOverlap(browser, { left: 950, top: 920, right: 1_200, bottom: 980 }),
    false,
  );
});

test("rectangle overlap treats edge and corner contact as non-overlap", () => {
  const first = { left: 10, top: 10, right: 50, bottom: 50 };

  assert.equal(
    core.rectanglesOverlap(first, { left: 50, top: 20, right: 80, bottom: 40 }),
    false,
  );
  assert.equal(
    core.rectanglesOverlap(first, { left: 20, top: 50, right: 40, bottom: 80 }),
    false,
  );
  assert.equal(
    core.rectanglesOverlap(first, { left: 50, top: 50, right: 80, bottom: 80 }),
    false,
  );
});

test("rectangle overlap rejects degenerate, inverted, and non-finite bounds", () => {
  const valid = { left: 0, top: 0, right: 100, bottom: 100 };
  const invalid = [
    { left: 20, top: 10, right: 20, bottom: 40 },
    { left: 30, top: 10, right: 20, bottom: 40 },
    { left: 10, top: 20, right: 40, bottom: 20 },
    { left: 10, top: 30, right: 40, bottom: 20 },
    { left: Number.NaN, top: 0, right: 40, bottom: 40 },
    { left: 0, top: Number.POSITIVE_INFINITY, right: 40, bottom: 40 },
    { left: 0, top: 0, right: Number.NEGATIVE_INFINITY, bottom: 40 },
  ];

  for (const bounds of invalid) {
    assert.equal(core.rectanglesOverlap(valid, bounds), false);
    assert.equal(core.rectanglesOverlap(bounds, valid), false);
  }
});

test("usage normalization computes remaining percentages and clamps provider drift", () => {
  const raw = {
    codex: {
      fiveHour: {
        usedPercent: 32.5,
        windowMinutes: 300,
        resetsAt: "2026-07-17T09:00:00Z",
        updatedAt: "2026-07-17T04:00:00Z",
      },
      weekly: {
        usedPercent: 120,
        windowMinutes: 10080,
        resetsAt: "2026-07-20T00:00:00Z",
        updatedAt: "2026-07-17T04:00:00Z",
      },
      updatedAt: "2026-07-17T04:00:00Z",
    },
    grok: {
      fiveHour: null,
      weekly: {
        usedPercent: -8,
        windowMinutes: 10080,
        resetsAt: "2026-07-21T00:00:00+09:00",
        updatedAt: "2026-07-17T04:00:00Z",
      },
      updatedAt: null,
    },
    readAt: "2026-07-17T04:00:10.123Z",
  };
  const normalized = core.normalizeProviderUsageResponse(raw);
  assert.equal(normalized.codex.fiveHour.usedPercent, 32.5);
  assert.equal(normalized.codex.fiveHour.remainingPercent, 67.5);
  assert.equal(normalized.codex.weekly.usedPercent, 100);
  assert.equal(normalized.codex.weekly.remainingPercent, 0);
  assert.equal(normalized.grok.weekly.usedPercent, 0);
  assert.equal(normalized.grok.weekly.remainingPercent, 100);
  assert.equal(normalized.grok.fiveHour, null);
  assert.equal(raw.codex.fiveHour.remainingPercent, undefined);
});

test("reset countdown matches the compact legacy day, hour, minute, and expiry format", () => {
  const now = Date.parse("2026-07-17T00:00:00Z");
  assert.equal(
    core.formatProviderResetCountdown("2026-07-23T10:59:59Z", now),
    "6d 10h",
  );
  assert.equal(
    core.formatProviderResetCountdown("2026-07-17T03:02:59Z", now),
    "3h 2m",
  );
  assert.equal(core.formatProviderResetCountdown("2026-07-17T00:00:30Z", now), "1m");
  assert.equal(core.formatProviderResetCountdown("2026-07-17T00:00:00Z", now), "Resetting soon");
  assert.equal(core.formatProviderResetCountdown("2026-07-16T23:00:00Z", now), "Resetting soon");
});

test("reset countdown honors timezone offsets, advances with time, and rejects bad inputs", () => {
  const first = Date.parse("2026-07-17T00:00:00Z");
  assert.equal(
    core.formatProviderResetCountdown("2026-07-17T12:30:00+09:00", first),
    "3h 30m",
  );
  assert.equal(
    core.formatProviderResetCountdown("2026-07-17T12:30:00+09:00", first + 60_000),
    "3h 29m",
  );
  assert.throws(() => core.formatProviderResetCountdown("invalid", first));
  assert.throws(() => core.formatProviderResetCountdown("2026-07-17T01:00:00Z", NaN));
});

test("reset countdown follows a Korean system locale", async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "ko-KR", languages: ["ko-KR"] },
  });
  try {
    const koreanCore = await import(`${moduleUrl}#ko-countdown`);
    const now = Date.parse("2026-07-17T00:00:00Z");
    assert.equal(koreanCore.formatProviderResetCountdown("2026-07-23T10:59:59Z", now), "6일 10시간");
    assert.equal(koreanCore.formatProviderResetCountdown("2026-07-17T00:00:30Z", now), "1분");
    assert.equal(koreanCore.formatProviderResetCountdown("2026-07-17T00:00:00Z", now), "곧 초기화");
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "en-US", languages: ["en-US"] },
    });
  }
});

test("next usage reset delay selects the nearest future limit across providers", () => {
  const now = Date.parse("2026-07-17T04:00:00Z");
  const usage = core.normalizeProviderUsageResponse({
    codex: {
      fiveHour: {
        usedPercent: 10,
        windowMinutes: 300,
        resetsAt: "2026-07-17T05:30:00Z",
        updatedAt: "2026-07-17T04:00:00Z",
      },
      weekly: {
        usedPercent: 20,
        windowMinutes: 10080,
        resetsAt: "2026-07-20T00:00:00Z",
        updatedAt: "2026-07-17T04:00:00Z",
      },
      updatedAt: "2026-07-17T04:00:00Z",
    },
    grok: {
      fiveHour: null,
      weekly: {
        usedPercent: 30,
        windowMinutes: 10080,
        resetsAt: "2026-07-17T12:15:00+09:00",
        updatedAt: "2026-07-17T04:00:00Z",
      },
      updatedAt: "2026-07-17T04:00:00Z",
    },
    readAt: "2026-07-17T04:00:00Z",
  });

  assert.equal(
    core.millisecondsUntilNextProviderUsageReset(usage, now),
    90 * 60_000,
  );
});

test("next usage reset delay ignores missing and elapsed limits", () => {
  const now = Date.parse("2026-07-17T04:00:00Z");
  const usage = core.normalizeProviderUsageResponse({
    codex: {
      fiveHour: {
        usedPercent: 10,
        windowMinutes: 300,
        resetsAt: "2026-07-17T04:00:00Z",
        updatedAt: "2026-07-17T03:00:00Z",
      },
      weekly: null,
      updatedAt: "2026-07-17T03:00:00Z",
    },
    grok: {
      fiveHour: null,
      weekly: {
        usedPercent: 20,
        windowMinutes: 10080,
        resetsAt: "2026-07-16T23:59:59Z",
        updatedAt: "2026-07-16T23:00:00Z",
      },
      updatedAt: "2026-07-16T23:00:00Z",
    },
    readAt: "2026-07-17T04:00:00Z",
  });

  assert.equal(core.millisecondsUntilNextProviderUsageReset(usage, now), null);
});

test("next usage reset delay rejects non-finite current times", () => {
  const usage = core.normalizeProviderUsageResponse({
    codex: { fiveHour: null, weekly: null, updatedAt: null },
    grok: { fiveHour: null, weekly: null, updatedAt: null },
    readAt: "2026-07-17T04:00:00Z",
  });

  for (const now of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => core.millisecondsUntilNextProviderUsageReset(usage, now),
      /current time value is not finite/,
    );
  }
});

test("usage boundaries reject malformed numbers, windows, and timestamps", () => {
  const valid = {
    codex: { fiveHour: null, weekly: null, updatedAt: null },
    grok: { fiveHour: null, weekly: null, updatedAt: null },
    readAt: "2026-07-17T04:00:00Z",
  };
  const limit = {
    usedPercent: 10,
    windowMinutes: 300,
    resetsAt: "2026-07-17T09:00:00Z",
    updatedAt: "2026-07-17T04:00:00Z",
  };
  const cases = [
    { ...valid, readAt: "today" },
    { ...valid, codex: { ...valid.codex, fiveHour: { ...limit, usedPercent: NaN } } },
    { ...valid, codex: { ...valid.codex, fiveHour: { ...limit, windowMinutes: 0 } } },
    { ...valid, codex: { ...valid.codex, fiveHour: { ...limit, windowMinutes: 1.5 } } },
    { ...valid, grok: { ...valid.grok, weekly: { ...limit, resetsAt: "invalid" } } },
  ];
  for (const candidate of cases) {
    assert.throws(() => core.normalizeProviderUsageResponse(candidate));
  }
});

test("provider account summaries expose only bounded public login metadata", () => {
  assert.deepEqual(
    core.normalizeProviderAccountSummary({
      displayLabel: "person@example.test",
      plan: "plus",
      authMode: "chatgpt",
    }),
    {
      displayLabel: "person@example.test",
      plan: "plus",
      authMode: "chatgpt",
    },
  );
  assert.deepEqual(
    core.normalizeProviderAccountSummary({
      displayLabel: "OpenAI API key",
      plan: null,
      authMode: "apiKey",
    }),
    {
      displayLabel: "OpenAI API key",
      plan: null,
      authMode: "apiKey",
    },
  );
  assert.equal(core.normalizeProviderAccountSummary(null), null);
});

test("provider account boundaries reject hidden, oversized, and unknown metadata", () => {
  for (const candidate of [
    undefined,
    {},
    { displayLabel: "", plan: null, authMode: "xai" },
    { displayLabel: " padded@example.test ", plan: null, authMode: "xai" },
    { displayLabel: "bad\nlabel", plan: null, authMode: "xai" },
    { displayLabel: "safe@example.test\u202eevil", plan: null, authMode: "xai" },
    { displayLabel: "x".repeat(255), plan: null, authMode: "xai" },
    { displayLabel: "person@example.test", plan: "x".repeat(65), authMode: "chatgpt" },
    { displayLabel: "person@example.test", plan: null, authMode: "oauth" },
  ]) {
    assert.throws(() => core.normalizeProviderAccountSummary(candidate));
  }
});

test("provider account lists expose one active bounded profile without paths or tokens", () => {
  const response = core.normalizeProviderAccountListResponse({
    provider: "codex",
    accounts: [
      {
        id: CODEX_ID,
        displayLabel: "first@example.test",
        active: false,
        managed: false,
      },
      {
        id: GROK_ID,
        displayLabel: "second@example.test",
        active: true,
        managed: true,
      },
    ],
    activeAccountId: GROK_ID,
    restartRequired: true,
  });
  assert.equal(response.provider, "codex");
  assert.equal(response.accounts.length, 2);
  assert.equal(response.activeAccountId, GROK_ID);
  assert.equal(response.restartRequired, true);
  assert.deepEqual(Object.keys(response.accounts[1]).sort(), [
    "active",
    "displayLabel",
    "id",
    "managed",
  ]);
});

test("provider account lists reject duplicate, mismatched, and unbounded profiles", () => {
  const valid = {
    provider: "grok",
    accounts: [
      {
        id: CODEX_ID,
        displayLabel: "person@example.test",
        active: true,
        managed: false,
      },
    ],
    activeAccountId: CODEX_ID,
    restartRequired: false,
  };
  for (const candidate of [
    { ...valid, provider: "other" },
    { ...valid, accounts: [] },
    { ...valid, activeAccountId: GROK_ID },
    { ...valid, accounts: [{ ...valid.accounts[0], active: false }] },
    { ...valid, accounts: [{ ...valid.accounts[0], managed: "yes" }] },
    { ...valid, accounts: [valid.accounts[0], valid.accounts[0]] },
    {
      ...valid,
      accounts: Array.from({ length: 33 }, (_, index) => ({
        id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        displayLabel: `account-${index}@example.test`,
        active: index === 0,
        managed: true,
      })),
    },
  ]) {
    assert.throws(() => core.normalizeProviderAccountListResponse(candidate));
  }
});

test("clipboard image routing is provider-specific and inert for a plain shell", () => {
  assert.equal(core.selectClipboardImageSequence("codex"), "\x16");
  assert.equal(core.selectClipboardImageSequence("grok"), "\x1bv");
  assert.equal(core.selectClipboardImageSequence(null), null);
  assert.equal(core.selectClipboardImageSequence(undefined), null);
});

test("native file drops keep safe unique Windows paths within the per-drop limit", () => {
  const first = String.raw`C:\Users\example\Documents\한글 이미지.png`;
  const unc = String.raw`\\server\share\design spec.pdf`;
  const candidates = [
    first,
    first.toUpperCase(),
    unc,
    "relative.txt",
    "C:\\unsafe\nname.txt",
    ...Array.from({ length: 25 }, (_, index) => `D:\\files\\${index}.txt`),
  ];
  const selected = core.selectDroppedFilePaths(candidates);
  assert.equal(selected.paths[0], first);
  assert.equal(selected.paths[1], unc);
  assert.equal(selected.paths.length, core.MAX_DROPPED_FILE_REFERENCES);
  assert.equal(selected.skipped, candidates.length - selected.paths.length);
});

test("dropped files use real Codex image paste and agent file references", () => {
  const image = String.raw`C:\Users\example\Pictures\화면 캡처.PNG`;
  const source = String.raw`C:\Users\example\Documents\project\src\main.ts`;
  assert.equal(core.isLikelyImageFilePath(image), true);
  assert.equal(core.isLikelyImageFilePath(source), false);
  assert.equal(core.formatDroppedFileReference("codex", image), `"${image}"`);
  assert.equal(core.formatDroppedFileReference("codex", source), `@"${source}"`);
  assert.equal(core.formatDroppedFileReference("grok", image), `@"${image}"`);
  assert.equal(core.formatDroppedFileReference(null, source), `"${source}"`);
});

test("terminal copy shortcuts survive Korean IME key labels and legacy WebView codes", () => {
  const base = {
    key: "ㅊ",
    code: "KeyC",
    keyCode: 229,
    which: 229,
    ctrlKey: true,
    metaKey: false,
  };
  assert.equal(core.isTerminalCopyShortcut(base), true);
  assert.equal(
    core.isTerminalCopyShortcut({
      ...base,
      key: "c",
      code: "",
      keyCode: 0,
      ctrlKey: false,
      metaKey: true,
    }),
    true,
  );
  assert.equal(
    core.isTerminalCopyShortcut({
      ...base,
      key: "ㅊ",
      code: "",
      keyCode: 67,
    }),
    true,
  );
  assert.equal(core.isTerminalCopyShortcut({ ...base, ctrlKey: false }), false);
  assert.equal(
    core.isTerminalCopyShortcut({ ...base, key: "v", code: "KeyV", keyCode: 86 }),
    false,
  );

  assert.equal(
    core.isTerminalCtrlInsertShortcut({
      ...base,
      key: "Unidentified",
      code: "Insert",
      keyCode: 0,
    }),
    true,
  );
  assert.equal(
    core.isTerminalCtrlInsertShortcut({
      ...base,
      key: "Unidentified",
      code: "",
      keyCode: 45,
    }),
    true,
  );
  assert.equal(core.isTerminalCtrlInsertShortcut({ ...base, ctrlKey: false }), false);

  assert.equal(core.shouldManuallySendTerminalInterrupt(base, false), true);
  assert.equal(core.shouldManuallySendTerminalInterrupt(base, true), false);
  assert.equal(
    core.shouldManuallySendTerminalInterrupt(
      {
        ...base,
        key: "c",
        code: "KeyC",
        keyCode: 67,
        which: 67,
        isComposing: false,
      },
      false,
    ),
    false,
  );
  assert.equal(
    core.shouldManuallySendTerminalInterrupt({ ...base, altKey: true }, false),
    false,
  );
  assert.equal(
    core.shouldManuallySendTerminalInterrupt(
      { ...base, ctrlKey: false, metaKey: true },
      false,
    ),
    false,
  );
  assert.equal(
    core.shouldManuallySendTerminalInterrupt({ ...base, shiftKey: true }, false),
    true,
  );
});

test("terminal selection copy guard survives a transient xterm selection clear only", () => {
  const copy = {
    key: "ㅊ",
    code: "KeyC",
    keyCode: 229,
    which: 229,
    ctrlKey: true,
    metaKey: false,
  };
  const guard = new core.TerminalSelectionCopyGuard();

  guard.captureLiveSelection("첫 번째 답변");
  assert.equal(guard.selectionForShortcut(copy, ""), "첫 번째 답변");
  assert.equal(
    guard.selectionForShortcut({ ...copy, key: "v", code: "KeyV" }, ""),
    null,
  );

  guard.invalidate();
  assert.equal(guard.selectionForShortcut(copy, ""), null);
  assert.equal(guard.selectionForShortcut(copy, "새 선택"), "새 선택");

  guard.beginPointerGesture();
  assert.equal(guard.selectionForShortcut(copy, ""), null);
  guard.captureLiveSelection("Ctrl+Insert 선택");
  assert.equal(
    guard.selectionForShortcut(
      { ...copy, key: "Insert", code: "Insert", keyCode: 45, which: 45 },
      "",
    ),
    "Ctrl+Insert 선택",
  );
});

test("terminal copy records are recognized across legacy, Kitty, and Win32 modes", () => {
  assert.equal(core.isTerminalEncodedCopyInput("\u0003"), true);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[99;5u"), true);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[99;6:2u"), true);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[2;5~"), true);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[67;46;3;1;8;1_"), true);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[45;82;0;0;4;1_"), true);

  assert.equal(core.isTerminalEncodedCopyInput("c"), false);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[99;1u"), false);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[118;5u"), false);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[67;46;3;1;0;1_"), false);
  assert.equal(core.isTerminalEncodedCopyInput("\u001b[86;47;22;1;8;1_"), false);

  const guard = new core.TerminalSelectionCopyGuard();
  guard.captureLiveSelection("복사할 답변");
  assert.equal(guard.selectionForTerminalInput("\u0003", ""), "복사할 답변");
  assert.equal(
    guard.selectionForTerminalInput("\u001b[67;46;3;1;8;1_", ""),
    "복사할 답변",
  );
  assert.equal(guard.selectionForTerminalInput("일반 입력", ""), null);
  guard.invalidate();
  assert.equal(guard.selectionForTerminalInput("\u0003", ""), null);
});

test("enhanced keyboard modifier records preserve selection until Ctrl+C", () => {
  const win32CtrlDown = "\u001b[17;29;0;1;8;1_";
  const win32CtrlUp = "\u001b[17;29;0;0;0;1_";
  const kittyCtrlDown = "\u001b[57442;5u";
  const kittyCtrlUp = "\u001b[57442;1:3u";

  assert.equal(core.isTerminalModifierOnlyInput(win32CtrlDown), true);
  assert.equal(core.isTerminalModifierOnlyInput(win32CtrlUp), true);
  assert.equal(core.isTerminalModifierOnlyInput(kittyCtrlDown), true);
  assert.equal(core.isTerminalModifierOnlyInput(kittyCtrlUp), true);
  assert.equal(
    core.isTerminalModifierOnlyInput("\u001b[67;46;3;1;8;1_"),
    false,
  );
  assert.equal(core.isTerminalModifierOnlyInput("\u001b[99;5u"), false);
  assert.equal(core.isTerminalModifierOnlyInput("\u0003"), false);

  const copy = {
    key: "c",
    code: "KeyC",
    keyCode: 67,
    which: 67,
    ctrlKey: true,
    metaKey: false,
  };
  const guard = new core.TerminalSelectionCopyGuard();
  guard.captureLiveSelection("Win32 입력 모드에서도 복사할 답변");

  // Reproduce xterm's exact order: modifier-down onData precedes C keydown.
  // The main input path now skips invalidation for this first record.
  if (!core.isTerminalModifierOnlyInput(win32CtrlDown)) guard.invalidate();
  assert.equal(
    guard.selectionForShortcut(copy, ""),
    "Win32 입력 모드에서도 복사할 답변",
  );
});

test("active terminal copy fallback never steals shortcuts from external editors", () => {
  const base = {
    paneActive: true,
    hasCopySelection: true,
    passiveDocumentTarget: true,
    nativeTerminalSelection: false,
    externalEditableTarget: false,
    externalDocumentSelection: false,
  };
  assert.equal(core.shouldOwnTerminalCopyFallback(base), true);
  assert.equal(
    core.shouldOwnTerminalCopyFallback({
      ...base,
      passiveDocumentTarget: false,
      nativeTerminalSelection: true,
    }),
    true,
  );
  assert.equal(
    core.shouldOwnTerminalCopyFallback({ ...base, externalEditableTarget: true }),
    false,
  );
  assert.equal(
    core.shouldOwnTerminalCopyFallback({ ...base, externalDocumentSelection: true }),
    false,
  );
  assert.equal(
    core.shouldOwnTerminalCopyFallback({ ...base, paneActive: false }),
    false,
  );
  assert.equal(
    core.shouldOwnTerminalCopyFallback({ ...base, hasCopySelection: false }),
    false,
  );
  assert.equal(
    core.shouldOwnTerminalCopyFallback({
      ...base,
      passiveDocumentTarget: false,
      nativeTerminalSelection: false,
    }),
    false,
  );
});

test("unread summaries derive project, tab, and global badges without extra state", () => {
  const state = workspace([
    project("project-a", [
      terminal("a", { completionPending: true }),
      terminal("b", { completionPending: false }),
      terminal("c", { completionPending: true }),
    ]),
    project("project-b", [terminal("d", { completionPending: true })]),
  ]);
  state.tabs.push({
    id: "tab-empty",
    kind: "empty",
    title: "Empty",
    projectId: null,
    browser: null,
    output: null,
    extensions: {},
  });
  state.tabs.push({
    id: "tab-output-a",
    kind: "output",
    title: "Output",
    projectId: "project-a",
    browser: null,
    output: { mode: "auto", relativeEntry: null },
    extensions: {},
  });
  assert.deepEqual(core.deriveWorkspaceUnreadSummary(state), {
    total: 3,
    projects: { "project-a": 2, "project-b": 1 },
    tabs: { "tab-0": 2, "tab-1": 1, "tab-empty": 0, "tab-output-a": 2 },
  });
});

test("interactive launch paint watchdog observes only first output and alternate-buffer entry", () => {
  const watchdog = new core.TerminalLaunchPaintWatchdog(1_600);
  watchdog.arm(7);

  assert.equal(watchdog.observeOutput(7, 4, false, 100), true);
  assert.equal(watchdog.observeOutput(7, 5, false, 110), false);
  assert.equal(watchdog.observePaint(4), true);
  assert.equal(watchdog.poll(7, 4, false, 150), "idle");
  assert.equal(watchdog.isArmed, true);

  assert.equal(watchdog.observeOutput(7, 6, true, 200), true);
  assert.equal(watchdog.observeOutput(7, 7, true, 210), false);
  assert.equal(watchdog.observePaint(6), true);
  assert.equal(watchdog.isArmed, false);
});

test("interactive launch paint watchdog waits for synchronized output but recovers once", () => {
  const watchdog = new core.TerminalLaunchPaintWatchdog(1_600);
  watchdog.arm(3);
  assert.equal(watchdog.observeOutput(3, 10, true, 100), true);

  assert.equal(watchdog.poll(3, 9, true, 1_699), "waiting");
  assert.equal(watchdog.poll(3, 9, true, 1_700), "recover");
  assert.equal(watchdog.poll(3, 9, false, 1_800), "idle");
  assert.equal(watchdog.observeOutput(3, 11, true, 1_900), false);
});

test("interactive launch paint watchdog recovers a non-synchronized missed paint promptly", () => {
  const watchdog = new core.TerminalLaunchPaintWatchdog(1_600);
  watchdog.arm(9);
  assert.equal(watchdog.observeOutput(9, 2, false, 0), true);
  assert.equal(watchdog.poll(9, 1, false, 120), "recover");

  watchdog.arm(10);
  assert.equal(watchdog.observeOutput(9, 3, false, 200), false);
  watchdog.expire(9);
  assert.equal(watchdog.isArmed, true);
  watchdog.expire(10);
  assert.equal(watchdog.isArmed, false);
});

test("project activity remains busy until every active terminal finishes", () => {
  const activity = new core.ProjectActivityTracker();
  assert.equal(activity.isProjectWorking("project-a"), false);

  assert.equal(activity.setTerminalWorking("project-a", "pane-a", true), true);
  assert.equal(activity.setTerminalWorking("project-a", "pane-b", true), true);
  assert.equal(activity.setTerminalWorking("project-a", "pane-a", false), true);
  assert.equal(activity.isProjectWorking("project-a"), true);

  assert.equal(activity.setTerminalWorking("project-a", "pane-b", false), false);
  assert.equal(activity.isProjectWorking("project-a"), false);
});

test("project activity updates are idempotent and isolated by project", () => {
  const activity = new core.ProjectActivityTracker();
  assert.equal(activity.setTerminalWorking("project-a", "shared-pane", true), true);
  assert.equal(activity.setTerminalWorking("project-a", "shared-pane", true), true);
  assert.equal(activity.setTerminalWorking("project-b", "shared-pane", true), true);

  assert.equal(activity.setTerminalWorking("project-a", "shared-pane", false), false);
  assert.equal(activity.setTerminalWorking("project-a", "shared-pane", false), false);
  assert.equal(activity.isProjectWorking("project-a"), false);
  assert.equal(activity.isProjectWorking("project-b"), true);
});

test("project activity can clear one project or all transient state", () => {
  const activity = new core.ProjectActivityTracker();
  activity.setTerminalWorking("project-a", "pane-a", true);
  activity.setTerminalWorking("project-b", "pane-b", true);

  assert.equal(activity.clearProject("project-a"), true);
  assert.equal(activity.clearProject("project-a"), false);
  assert.equal(activity.isProjectWorking("project-a"), false);
  assert.equal(activity.isProjectWorking("project-b"), true);

  activity.clear();
  assert.equal(activity.isProjectWorking("project-b"), false);
});
