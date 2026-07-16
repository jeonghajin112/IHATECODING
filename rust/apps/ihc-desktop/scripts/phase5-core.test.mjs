import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

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

test("clipboard image routing is provider-specific and inert for a plain shell", () => {
  assert.equal(core.selectClipboardImageSequence("codex"), "\x16");
  assert.equal(core.selectClipboardImageSequence("grok"), "\x1bv");
  assert.equal(core.selectClipboardImageSequence(null), null);
  assert.equal(core.selectClipboardImageSequence(undefined), null);
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
