import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/optimization-settings.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText;
const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;

function installBrowser({ stored = null, readError = null, writeError = null } = {}) {
  const values = new Map();
  if (stored !== null) values.set("ihatecoding.optimization.v1", stored);
  const listeners = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => {
        if (readError) throw readError;
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (writeError) throw writeError;
        values.set(key, value);
      },
    },
    addEventListener: (type, listener) => {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    dispatchEvent: (event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  return values;
}

async function loadModule(suffix) {
  return import(`${url}#${suffix}`);
}

test("automatic sleep is off by default", async () => {
  installBrowser();
  const settings = await loadModule("default-off");
  assert.equal(settings.getAutoSleepIdleAgents(), false);
  assert.deepEqual(settings.getOptimizationSettings(), {
    autoSleepIdleAgents: false,
  });
});

test("only a valid stored boolean setting is restored", async () => {
  installBrowser({ stored: JSON.stringify({ autoSleepIdleAgents: true }) });
  const enabled = await loadModule("stored-enabled");
  assert.equal(enabled.getAutoSleepIdleAgents(), true);

  for (const [index, invalid] of [
    "true",
    "not-json",
    "{}",
    JSON.stringify({ autoSleepIdleAgents: "true" }),
    "[]",
  ].entries()) {
    assert.equal(
      enabled.resolveOptimizationSettings(invalid).autoSleepIdleAgents,
      false,
      `invalid setting ${index} must fail closed`,
    );
  }
});

test("changes persist and notify subscribers once", async () => {
  const values = installBrowser();
  const settings = await loadModule("persist-and-notify");
  const observed = [];
  const unsubscribe = settings.subscribeOptimizationSettings((next) => observed.push(next));

  settings.setAutoSleepIdleAgents(true);
  settings.setAutoSleepIdleAgents(true);
  unsubscribe();
  settings.setAutoSleepIdleAgents(false);

  assert.deepEqual(JSON.parse(values.get(settings.OPTIMIZATION_SETTINGS_STORAGE_KEY)), {
    autoSleepIdleAgents: false,
  });
  assert.deepEqual(observed, [{ autoSleepIdleAgents: true }]);
});

test("storage failures keep the in-memory setting usable and fail closed on load", async () => {
  installBrowser({ readError: new Error("read failed") });
  const readFailure = await loadModule("read-failure");
  assert.equal(readFailure.getAutoSleepIdleAgents(), false);

  installBrowser({ writeError: new Error("write failed") });
  const writeFailure = await loadModule("write-failure");
  assert.doesNotThrow(() => writeFailure.setAutoSleepIdleAgents(true));
  assert.equal(writeFailure.getAutoSleepIdleAgents(), true);
});

test("sleep deadline requires an inactive, settled and explicitly idle resumable agent", async () => {
  installBrowser();
  const settings = await loadModule("sleep-deadline");
  const eligible = {
    enabled: true,
    projectActive: false,
    paneRunning: true,
    runtimeSessionPresent: true,
    resumableConversation: true,
    agentTurnState: "idle",
    lifecycleSettled: true,
    projectInactiveSinceUnixMs: 1_000,
    agentIdleSinceUnixMs: 2_000,
  };
  assert.equal(settings.inactiveAgentSleepDeadline(eligible, 300), 2_300);

  for (const override of [
    { enabled: false },
    { projectActive: true },
    { paneRunning: false },
    { runtimeSessionPresent: false },
    { resumableConversation: false },
    { agentTurnState: "unknown" },
    { agentTurnState: "working" },
    { lifecycleSettled: false },
    { projectInactiveSinceUnixMs: null },
    { agentIdleSinceUnixMs: null },
  ]) {
    assert.equal(
      settings.inactiveAgentSleepDeadline({ ...eligible, ...override }, 300),
      null,
    );
  }
});

test("browser sleep deadline requires an inactive running pane", async () => {
  installBrowser();
  const settings = await loadModule("browser-sleep-deadline");
  const eligible = {
    enabled: true,
    projectActive: false,
    paneRunning: true,
    projectInactiveSinceUnixMs: 1_000,
  };

  assert.equal(settings.inactiveBrowserSleepDeadline(eligible, 300), 1_300);

  for (const override of [
    { enabled: false },
    { projectActive: true },
    { paneRunning: false },
    { projectInactiveSinceUnixMs: null },
    { projectInactiveSinceUnixMs: Number.NaN },
  ]) {
    assert.equal(
      settings.inactiveBrowserSleepDeadline({ ...eligible, ...override }, 300),
      null,
    );
  }

  assert.equal(settings.inactiveBrowserSleepDeadline(eligible, -1), null);
});

test("queued input protection survives a replayed start and clears only for a newer turn", async () => {
  installBrowser();
  const settings = await loadModule("agent-input-protection");
  const turnA = settings.agentTurnStartIdentity("turn-a", 1_000);
  assert.equal(turnA, "turn:turn-a");

  assert.equal(
    settings.shouldReleaseAgentInputProtection({
      baselineTurnStartIdentity: turnA,
      inputObservedAtUnixMs: 1_500,
      nextTurnId: "turn-a",
      nextTurnObservedAtUnixMs: 1_000,
    }),
    false,
  );
  assert.equal(
    settings.shouldReleaseAgentInputProtection({
      baselineTurnStartIdentity: turnA,
      inputObservedAtUnixMs: 1_500,
      nextTurnId: "turn-a",
      nextTurnObservedAtUnixMs: 1_700,
    }),
    false,
  );
  assert.equal(
    settings.shouldReleaseAgentInputProtection({
      baselineTurnStartIdentity: turnA,
      inputObservedAtUnixMs: 1_500,
      nextTurnId: "turn-b",
      nextTurnObservedAtUnixMs: 1_500,
    }),
    true,
  );
});

test("turns without provider ids use a stable observed-time replay identity", async () => {
  installBrowser();
  const settings = await loadModule("agent-input-protection-observed");
  const turnA = settings.agentTurnStartIdentity(null, 2_000);
  assert.equal(turnA, "observed:2000");
  assert.equal(
    settings.shouldReleaseAgentInputProtection({
      baselineTurnStartIdentity: turnA,
      inputObservedAtUnixMs: 2_100,
      nextTurnId: null,
      nextTurnObservedAtUnixMs: 2_000,
    }),
    false,
  );
  assert.equal(
    settings.shouldReleaseAgentInputProtection({
      baselineTurnStartIdentity: turnA,
      inputObservedAtUnixMs: 2_100,
      nextTurnId: null,
      nextTurnObservedAtUnixMs: 2_200,
    }),
    true,
  );
});
