import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/phase3b-core.ts", import.meta.url))],
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
const SHA = "a".repeat(64);

function terminal(id = "terminal-a", overrides = {}) {
  return {
    id,
    name: "MAIN",
    startDirectory: "C:\\Work\\Alpha",
    codexThreadId: CODEX_ID,
    grokSessionId: null,
    createdAtUtc: "2026-07-17T00:00:00Z",
    completionPending: false,
    legacyExtensions: { terminalLegacy: { order: 1 } },
    futureTerminal: { color: "white" },
    ...overrides,
  };
}

function project(id = "project-a", overrides = {}) {
  return {
    id,
    name: id === "project-a" ? "Alpha" : "Beta",
    folderPath: id === "project-a" ? "C:\\Work\\Alpha" : "D:\\Work\\Beta",
    terminals: [terminal()],
    paneWidthRatios: {
      "2x1:row-0": [2, 3],
      "legacy:grid-key": [9, 8, 7],
      "2x1:row-3": [6, 4],
    },
    legacyExtensions: { projectLegacy: { source: "csharp" } },
    futureProject: { layout: "mosaic" },
    ...overrides,
  };
}

function emptyTab(id = "tab-empty") {
  return {
    id,
    kind: "empty",
    title: "Empty",
    projectId: null,
    browser: null,
    output: null,
    extensions: { tabExtension: { keep: true } },
  };
}

function projectTab(id = "tab-project") {
  return {
    id,
    kind: "project",
    title: "Alpha",
    projectId: "project-a",
    browser: null,
    output: null,
    extensions: {},
  };
}

function browserTab(id = "tab-browser", url = "https://example.com/path?q=1#hash") {
  return {
    id,
    kind: "browser",
    title: "Docs",
    projectId: "project-a",
    browser: { url, futureBrowser: { zoom: 1.25 } },
    output: null,
    extensions: {},
  };
}

function outputTab(id = "tab-output", relativeEntry = null) {
  return {
    id,
    kind: "output",
    title: "Output",
    projectId: "project-a",
    browser: null,
    output: { mode: "auto", relativeEntry, futureOutput: { renderer: "web" } },
    extensions: {},
  };
}

function unsupportedTab(id = "tab-future") {
  return {
    id,
    kind: "canvas-v2",
    title: "Future",
    projectId: "project-a",
    browser: { future: true },
    output: null,
    extensions: { futureKind: true },
    futurePayload: { nodes: [1, 2, 3] },
  };
}

function workspace(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 7,
    writtenAtUtc: "2026-07-17T00:00:00Z",
    selectedProjectId: "project-a",
    projects: [project()],
    tabs: [projectTab(), emptyTab(), browserTab(), outputTab(), unsupportedTab()],
    activeTabId: "tab-project",
    importProvenance: {
      sourceFormat: "powerWorkspace.projects/1",
      sourceSha256: SHA,
      snapshotFile: `${SHA}.projects.json`,
      importedAtUtc: "2026-07-17T00:00:00Z",
      futureProvenance: { verified: true },
    },
    extensions: { futureRoot: { enabled: true, values: [1, 2, 3] } },
    legacyExtensions: { rootLegacy: { exact: "bytes-live-in-snapshot" } },
    futureRootProperty: { nested: { sentinel: "preserve-me" } },
    ...overrides,
  };
}

function loadEnvelope(state = workspace(), recovery = null) {
  return { revision: state.revision, state, recovery };
}

function readyLoad(state = workspace()) {
  return core.normalizeWorkspaceLoadResponse(loadEnvelope(state));
}

test("canonical v1 load preserves unknown fields, order, layout, and clone isolation", () => {
  const source = workspace();
  const loaded = core.normalizeWorkspaceLoadResponse(loadEnvelope(source));
  assert.equal(loaded.kind, "ready");
  const state = loaded.snapshot.state;

  assert.deepEqual(state.projects.map((item) => item.id), ["project-a"]);
  assert.equal(state.projects[0].lastModifiedAtUtc, null);
  assert.deepEqual(state.tabs.map((item) => item.id), [
    "tab-project",
    "tab-empty",
    "tab-browser",
    "tab-output",
    "tab-future",
  ]);
  assert.deepEqual(state.projects[0].paneWidthRatios["2x1:row-0"], [0.4, 0.6]);
  assert.deepEqual(
    state.projects[0].paneWidthRatios["legacy:grid-key"],
    source.projects[0].paneWidthRatios["legacy:grid-key"],
  );
  assert.deepEqual(
    state.projects[0].paneWidthRatios["2x1:row-3"],
    source.projects[0].paneWidthRatios["2x1:row-3"],
  );
  assert.deepEqual(state.futureRootProperty, source.futureRootProperty);
  assert.deepEqual(state.tabs[4].futurePayload, source.tabs[4].futurePayload);

  source.futureRootProperty.nested.sentinel = "mutated-source";
  source.projects[0].futureProject.layout = "mutated-source";
  assert.equal(state.futureRootProperty.nested.sentinel, "preserve-me");
  assert.equal(state.projects[0].futureProject.layout, "mosaic");

  const cloned = core.cloneWorkspaceState(state);
  cloned.extensions.futureRoot.values.push(4);
  assert.deepEqual(state.extensions.futureRoot.values, [1, 2, 3]);
  assert.deepEqual(core.normalizeWorkspaceState(state), state);
});

test("pane ratio layout keys support arbitrary safe row counts and preserve unknown keys", () => {
  assert.deepEqual(core.parsePaneRatioLayoutKey("2x1:row-0"), {
    columns: 2,
    rows: 1,
    row: 0,
  });
  assert.deepEqual(core.parsePaneRatioLayoutKey("5x128:row-127"), {
    columns: 5,
    rows: 128,
    row: 127,
  });
  assert.deepEqual(
    core.parsePaneRatioLayoutKey("1x9007199254740991:row-9007199254740990"),
    { columns: 1, rows: 9_007_199_254_740_991, row: 9_007_199_254_740_990 },
  );

  for (const key of [
    "0x1:row-0",
    "6x1:row-0",
    "2x0:row-0",
    "2x4:row-4",
    "2x04:row-3",
    "2x4:row-03",
    "junk2x4:row-3",
    "2x4:row--1",
    "2x9007199254740992:row-0",
  ]) {
    assert.equal(core.parsePaneRatioLayoutKey(key), null, key);
  }

  const normalized = core.normalizeWorkspaceState(
    workspace({
      projects: [
        project("project-a", {
          paneWidthRatios: {
            "5x128:row-127": [1, 2, 3, 4, 5],
            "2x0:row-0": [7, 3],
          },
        }),
      ],
    }),
  );
  assert.deepEqual(
    normalized.projects[0].paneWidthRatios["5x128:row-127"].map((value) =>
      Number(value.toFixed(6))
    ),
    [0.066667, 0.133333, 0.2, 0.266667, 0.333333],
  );
  assert.deepEqual(normalized.projects[0].paneWidthRatios["2x0:row-0"], [7, 3]);
});

test("terminal launch profiles survive canonical normalization and cloning", () => {
  const source = workspace({
    projects: [
      project("project-a", {
        terminals: [
          terminal("terminal-claude", {
            legacyExtensions: {
              terminalLegacy: { order: 1 },
              launchProfileV1: "claude",
            },
          }),
          terminal("terminal-opencode", {
            name: "OPEN",
            codexThreadId: null,
            legacyExtensions: { launchProfileV1: "opencode" },
          }),
        ],
      }),
    ],
  });
  const normalized = core.normalizeWorkspaceState(source);
  const cloned = core.cloneWorkspaceState(normalized);
  assert.equal(cloned.projects[0].terminals[0].legacyExtensions.launchProfileV1, "claude");
  assert.equal(cloned.projects[0].terminals[1].legacyExtensions.launchProfileV1, "opencode");
  cloned.projects[0].terminals[0].legacyExtensions.launchProfileV1 = "powershell";
  assert.equal(
    normalized.projects[0].terminals[0].legacyExtensions.launchProfileV1,
    "claude",
  );
});

test("project modification timestamps normalize legacy absence and reject invalid values", () => {
  const legacy = core.normalizeWorkspaceState(workspace());
  assert.equal(legacy.projects[0].lastModifiedAtUtc, null);

  const timestamp = "2026-07-18T08:09:10.123+09:00";
  const current = core.normalizeWorkspaceState(
    workspace({
      projects: [project("project-a", { lastModifiedAtUtc: timestamp })],
    }),
  );
  assert.equal(current.projects[0].lastModifiedAtUtc, timestamp);

  assert.throws(
    () =>
      core.normalizeWorkspaceState(
        workspace({
          projects: [project("project-a", { lastModifiedAtUtc: "yesterday" })],
        }),
      ),
    (error) =>
      error instanceof core.WorkspaceValidationError &&
      error.jsonPointer === "/projects/0/lastModifiedAtUtc",
  );
});

test("Phase 3 preview upgrade provenance remains a supported canonical source", () => {
  const source = workspace({
    importProvenance: {
      ...workspace().importProvenance,
      sourceFormat: "ihatecoding.phase3-preview/1",
    },
  });
  const loaded = core.normalizeWorkspaceLoadResponse(loadEnvelope(source));
  assert.equal(loaded.kind, "ready");
  assert.equal(
    loaded.snapshot.state.importProvenance.sourceFormat,
    "ihatecoding.phase3-preview/1",
  );
});

test("future schemas remain lossless and read-only instead of becoming empty", () => {
  const future = workspace({
    schemaVersion: 2,
    futureOnly: { opaque: ["do", "not", "downgrade"] },
  });
  const result = core.normalizeWorkspaceLoadResponse({
    revision: 91,
    state: future,
    recovery: null,
  });
  assert.equal(result.kind, "unsupportedVersion");
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.revision, 91);
  assert.deepEqual(result.rawState.futureOnly, future.futureOnly);

  const session = core.createWorkspaceSession(result);
  assert.equal(session.access, "unsupportedVersion");
  assert.equal(session.snapshot, null);
  assert.equal(session.draft, null);
  assert.throws(() => core.beginWorkspaceSave(session), /read-only/);
  future.futureOnly.opaque[0] = "mutated";
  assert.equal(session.unsupportedRawState.futureOnly.opaque[0], "do");
});

test("missing, old, mismatched, negative, and unsafe revisions fail closed", () => {
  const withoutVersion = workspace();
  delete withoutVersion.schemaVersion;
  assert.throws(
    () => core.normalizeWorkspaceLoadResponse(loadEnvelope(withoutVersion)),
    /schema version/,
  );
  assert.throws(
    () =>
      core.normalizeWorkspaceLoadResponse({
        revision: 7,
        state: workspace({ schemaVersion: 0 }),
        recovery: null,
      }),
    /schema version/,
  );
  assert.throws(
    () => core.normalizeWorkspaceLoadResponse({ revision: 8, state: workspace(), recovery: null }),
    /revisions do not match/,
  );
  assert.throws(
    () =>
      core.normalizeWorkspaceLoadResponse({
        revision: Number.MAX_SAFE_INTEGER + 1,
        state: workspace({ revision: Number.MAX_SAFE_INTEGER + 1 }),
        recovery: null,
      }),
    /safe integer/,
  );
  assert.throws(
    () =>
      core.normalizeWorkspaceLoadResponse({
        revision: -1,
        state: workspace({ revision: -1 }),
        recovery: null,
      }),
    /safe integer/,
  );
});

test("recovery-required, recovery-preview, read-only, and import-preview sessions never save", () => {
  const noState = core.normalizeWorkspaceLoadResponse({
    revision: null,
    state: null,
    recovery: { candidates: 2, opaqueCandidateId: "candidate-local-only" },
  });
  assert.equal(noState.kind, "recoveryRequired");
  const requiredSession = core.createWorkspaceSession(noState);
  assert.equal(requiredSession.access, "recoveryRequired");
  assert.throws(() => core.beginWorkspaceSave(requiredSession), /read-only/);

  const recovery = core.normalizeWorkspaceLoadResponse(
    loadEnvelope(workspace(), { candidateId: "opaque", source: "backup" }),
  );
  assert.equal(recovery.kind, "recoveryPreview");
  const recoverySession = core.createWorkspaceSession(recovery);
  assert.equal(recoverySession.access, "recoveryPreview");
  assert.throws(() => core.beginWorkspaceSave(recoverySession), /read-only/);

  const readOnly = core.createWorkspaceSession(readyLoad(), "readOnly");
  assert.equal(readOnly.access, "readOnly");
  assert.throws(() => core.replaceWorkspaceDraft(readOnly, workspace()), /read-only/);

  const importPreview = core.createImportPreviewSession({ revision: 7, state: workspace() });
  assert.equal(importPreview.access, "importPreview");
  assert.throws(() => core.beginWorkspaceSave(importPreview), /read-only/);
});

test("project and terminal bounds, references, UUIDs, and timestamps are validated without values in errors", () => {
  const secretId = "SECRET-PROJECT-ID";
  const secretPath = "C:\\SECRET\\CUSTOMER";
  const duplicate = workspace({
    projects: [
      project(secretId, { folderPath: secretPath }),
      project(secretId, { folderPath: secretPath }),
    ],
    selectedProjectId: secretId,
  });
  assert.throws(
    () => core.normalizeWorkspaceState(duplicate),
    (error) => {
      assert.equal(error.code, "invalidState");
      assert.equal(error.jsonPointer, "/projects/1/id");
      assert.equal(error.message.includes(secretId), false);
      assert.equal(error.message.includes(secretPath), false);
      return true;
    },
  );

  const tooManyProjects = workspace({
    projects: Array.from({ length: 257 }, (_, index) =>
      project(`project-${index}`, { terminals: [] }),
    ),
    selectedProjectId: null,
    tabs: [],
    activeTabId: null,
  });
  assert.throws(() => core.normalizeWorkspaceState(tooManyProjects), /too many projects/);

  const manyTerminals = workspace({
    projects: [
      project("project-a", {
        terminals: Array.from({ length: 64 }, (_, index) =>
          terminal(`terminal-${index}`, { codexThreadId: null }),
        ),
      }),
    ],
  });
  assert.equal(
    core.normalizeWorkspaceState(manyTerminals).projects[0].terminals.length,
    64,
  );

  const invalidUuid = workspace({
    projects: [project("project-a", { terminals: [terminal("t", { codexThreadId: "not-uuid" })] })],
  });
  assert.throws(() => core.normalizeWorkspaceState(invalidUuid), /valid UUID/);

  const invalidDate = workspace({
    projects: [project("project-a", { terminals: [terminal("t", { createdAtUtc: "2026-02-30T00:00:00Z" })] })],
  });
  assert.throws(() => core.normalizeWorkspaceState(invalidDate), /RFC 3339/);
});

test("duplicate agent ownership is preserved but derived as resume-blocked", () => {
  const state = core.normalizeWorkspaceState(
    workspace({
      projects: [
        project("project-a", {
          terminals: [terminal("terminal-a", { codexThreadId: CODEX_ID })],
        }),
        project("project-b", {
          terminals: [
            terminal("terminal-b", {
              startDirectory: "D:\\Work\\Beta",
              codexThreadId: CODEX_ID.toUpperCase(),
              grokSessionId: GROK_ID,
            }),
            terminal("terminal-c", {
              startDirectory: "D:\\Work\\Beta",
              codexThreadId: null,
              grokSessionId: GROK_ID,
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(state.projects[1].terminals[0].codexThreadId, CODEX_ID.toUpperCase());
  const conflicts = core.deriveAgentResumeConflicts(state);
  assert.deepEqual(conflicts.map((item) => item.provider).sort(), ["codex", "grok"]);
  assert.deepEqual(conflicts.map((item) => item.owners.length).sort(), [2, 2]);
  assert.equal(Object.hasOwn(conflicts[0], "sessionId"), false);
});

test("known tabs enforce references while future tabs remain unsupported placeholders", () => {
  const state = core.normalizeWorkspaceState(workspace());
  assert.deepEqual(core.describeWorkspaceTabActivation(state, "tab-project"), {
    kind: "project",
    tabId: "tab-project",
    projectId: "project-a",
  });
  assert.deepEqual(core.describeWorkspaceTabActivation(state, "tab-browser"), {
    kind: "browser",
    tabId: "tab-browser",
    projectId: "project-a",
    url: "https://example.com/path?q=1#hash",
    restore: "lazy",
  });
  assert.deepEqual(core.describeWorkspaceTabActivation(state, "tab-output"), {
    kind: "output",
    tabId: "tab-output",
    projectId: "project-a",
    mode: "auto",
    relativeEntry: null,
    restore: "lazy",
  });
  assert.deepEqual(core.describeWorkspaceTabActivation(state, "tab-future"), {
    kind: "unsupported",
    tabId: "tab-future",
    persistedKind: "canvas-v2",
  });
  assert.equal(state.tabs[4].futurePayload.nodes.length, 3);

  const dangling = workspace({ tabs: [{ ...projectTab(), projectId: "missing" }] });
  assert.throws(() => core.normalizeWorkspaceState(dangling), /reference is not present/);
  const noActive = workspace({ activeTabId: null });
  assert.throws(() => core.normalizeWorkspaceState(noActive), /active tab reference/);
  const duplicateTabs = workspace({ tabs: [emptyTab("same"), emptyTab("same")], activeTabId: "same" });
  assert.throws(() => core.normalizeWorkspaceState(duplicateTabs), /tab identifier is duplicated/);
  const tooManyTabs = workspace({
    tabs: Array.from({ length: 129 }, (_, index) => emptyTab(`tab-${index}`)),
    activeTabId: "tab-0",
  });
  assert.throws(() => core.normalizeWorkspaceState(tooManyTabs), /too many tabs/);
});

test("browser restore policy rejects credentials and unsafe schemes without navigation", () => {
  for (const url of [
    "https://user:password@example.com/",
    "https://@example.com/",
    "file:///C:/secret.txt",
    "data:text/html,secret",
    "javascript:alert(1)",
    "custom://host/path",
    "not a url",
  ]) {
    assert.throws(
      () =>
        core.normalizeWorkspaceState(
          workspace({ tabs: [browserTab("unsafe", url)], activeTabId: "unsafe" }),
        ),
      /not allowed/,
    );
  }
  const aboutBlank = core.normalizeWorkspaceState(
    workspace({ tabs: [browserTab("blank", "about:blank")], activeTabId: "blank" }),
  );
  assert.equal(core.describeWorkspaceTabActivation(aboutBlank, "blank").restore, "lazy");
});

test("output entries remain project-relative and are never resolved by the pure core", () => {
  const safe = core.normalizeWorkspaceState(
    workspace({
      tabs: [outputTab("safe", "dist/index.html")],
      activeTabId: "safe",
    }),
  );
  assert.equal(
    core.describeWorkspaceTabActivation(safe, "safe").relativeEntry,
    "dist/index.html",
  );
  for (const entry of [
    "../secret.txt",
    "C:\\secret.txt",
    "/root/file",
    "dir//file",
    "dir/file.txt:stream",
    ".",
  ]) {
    assert.throws(
      () =>
        core.normalizeWorkspaceState(
          workspace({ tabs: [outputTab("unsafe", entry)], activeTabId: "unsafe" }),
        ),
      /remain relative/,
    );
  }
});

test("alerts and pane layout mutations preserve unknown data and do not mutate their source", () => {
  const original = core.normalizeWorkspaceState(workspace());
  const alerted = core.setTerminalCompletionPending(
    original,
    "project-a",
    "terminal-a",
    true,
    "2026-07-18T01:00:00Z",
  );
  assert.equal(original.projects[0].terminals[0].completionPending, false);
  assert.equal(alerted.projects[0].terminals[0].completionPending, true);
  assert.equal(core.projectUnreadCount(alerted, "project-a"), 1);
  assert.deepEqual(core.workspaceUnreadCounts(alerted), { "project-a": 1 });
  assert.deepEqual(alerted.futureRootProperty, original.futureRootProperty);
  assert.equal(alerted.projects[0].lastModifiedAtUtc, "2026-07-18T01:00:00Z");

  const resized = core.setProjectPaneWidthRatios(
    alerted,
    "project-a",
    "2x1:row-0",
    [1, 3],
    "2026-07-18T02:00:00Z",
  );
  assert.deepEqual(resized.projects[0].paneWidthRatios["2x1:row-0"], [0.25, 0.75]);
  const deepRow = core.setProjectPaneWidthRatios(
    resized,
    "project-a",
    "2x128:row-127",
    [3, 1],
  );
  assert.deepEqual(deepRow.projects[0].paneWidthRatios["2x128:row-127"], [0.75, 0.25]);
  assert.deepEqual(
    resized.projects[0].paneWidthRatios["legacy:grid-key"],
    original.projects[0].paneWidthRatios["legacy:grid-key"],
  );
  assert.equal(resized.projects[0].lastModifiedAtUtc, "2026-07-18T02:00:00Z");
  assert.throws(
    () => core.setProjectPaneWidthRatios(resized, "project-a", "2x1:row-3", [1, 1]),
    /applicable/,
  );
  assert.throws(
    () =>
      core.normalizeWorkspaceState(
        workspace({
          projects: [
            project("project-a", {
              paneWidthRatios: { "2x1:row-0": [0, 1] },
            }),
          ],
        }),
      ),
    /finite and positive/,
  );
});

test("save requests carry expectedRevision and omit every backend-owned field", () => {
  let session = core.createWorkspaceSession(readyLoad());
  const edited = core.setTerminalCompletionPending(
    session.draft,
    "project-a",
    "terminal-a",
    true,
  );
  session = core.replaceWorkspaceDraft(session, edited);
  const begun = core.beginWorkspaceSave(session);
  assert.equal(begun.request.expectedRevision, 7);
  assert.equal(Object.hasOwn(begun.request.state, "revision"), false);
  assert.equal(Object.hasOwn(begun.request.state, "writtenAtUtc"), false);
  assert.equal(Object.hasOwn(begun.request.state, "importProvenance"), false);
  assert.equal(begun.request.state.projects[0].terminals[0].completionPending, true);
  assert.deepEqual(
    begun.request.state.futureRootProperty,
    workspace().futureRootProperty,
  );
  assert.deepEqual(
    begun.request.state.tabs.find((tab) => tab.id === "tab-future").futurePayload,
    unsupportedTab().futurePayload,
  );

  begun.request.state.projects[0].terminals[0].name = "MUTATED REQUEST";
  assert.equal(begun.session.draft.projects[0].terminals[0].name, "MAIN");
  assert.equal(begun.session.phase, "saving");
  assert.throws(() => core.beginWorkspaceSave(begun.session), /does not allow mutation/);
});

test("frontend drafts cannot replace revision, written time, or import provenance", () => {
  const session = core.createWorkspaceSession(readyLoad());
  for (const changed of [
    workspace({ revision: 8 }),
    workspace({ writtenAtUtc: "2026-07-18T00:00:00Z" }),
    workspace({ importProvenance: null }),
  ]) {
    assert.throws(
      () => core.replaceWorkspaceDraft(session, changed),
      /Backend-owned workspace fields/,
    );
  }
  assert.throws(() => core.beginWorkspaceSave(session), /no pending mutation/);
  assert.throws(
    () => core.createSaveWorkspaceRequest(workspace(), 8),
    /base revision does not match/,
  );
});

test("save success advances the committed revision and retains provenance", () => {
  let session = core.createWorkspaceSession(readyLoad());
  session = core.replaceWorkspaceDraft(
    session,
    core.setTerminalCompletionPending(
      session.draft,
      "project-a",
      "terminal-a",
      true,
    ),
  );
  session = core.beginWorkspaceSave(session).session;
  const committed = core.applyWorkspaceSaveSuccess(session, {
    revision: 8,
    writtenAtUtc: "2026-07-17T01:02:03Z",
    futureReceipt: { durable: true },
  });
  assert.equal(committed.access, "ready");
  assert.equal(committed.phase, "idle");
  assert.equal(committed.dirty, false);
  assert.equal(committed.snapshot.revision, 8);
  assert.equal(committed.snapshot.state.revision, 8);
  assert.equal(committed.snapshot.state.writtenAtUtc, "2026-07-17T01:02:03Z");
  assert.equal(committed.snapshot.state.projects[0].terminals[0].completionPending, true);
  assert.deepEqual(committed.snapshot.state.importProvenance, workspace().importProvenance);
  assert.throws(
    () => core.applyWorkspaceSaveSuccess(session, { revision: 7, writtenAtUtc: "2026-07-17T01:02:03Z" }),
    /advance monotonically/,
  );
});

test("revisionConflict never advances or retries a stale draft automatically", () => {
  let session = core.createWorkspaceSession(readyLoad());
  session = core.replaceWorkspaceDraft(
    session,
    core.setTerminalCompletionPending(
      session.draft,
      "project-a",
      "terminal-a",
      true,
    ),
  );
  session = core.beginWorkspaceSave(session).session;
  const conflicted = core.applyWorkspaceSaveError(session, {
    code: "revisionConflict",
    message: "The workspace changed in another instance.",
    retryable: true,
    jsonPointer: null,
    currentRevision: 9,
  });
  assert.equal(conflicted.phase, "revisionConflict");
  assert.equal(conflicted.snapshot.revision, 7);
  assert.equal(conflicted.draft.revision, 7);
  assert.equal(conflicted.conflict.expectedRevision, 7);
  assert.equal(conflicted.conflict.latestRevision, 9);
  assert.equal(conflicted.dirty, true);
  assert.throws(() => core.beginWorkspaceSave(conflicted), /does not allow mutation/);

  const staleReload = readyLoad(workspace({ revision: 7 }));
  assert.throws(
    () => core.resolveRevisionConflictByReload(conflicted, staleReload),
    /does not supersede/,
  );

  const latestState = workspace({
    revision: 9,
    writtenAtUtc: "2026-07-17T02:00:00Z",
    projects: [
      project("project-a", {
        terminals: [terminal("terminal-a", { name: "REMOTE", completionPending: false })],
      }),
    ],
  });
  const resolution = core.resolveRevisionConflictByReload(conflicted, readyLoad(latestState));
  assert.equal(resolution.session.snapshot.revision, 9);
  assert.equal(resolution.session.draft.projects[0].terminals[0].name, "REMOTE");
  assert.equal(resolution.discardedLocalDraft.projects[0].terminals[0].completionPending, true);
  resolution.discardedLocalDraft.projects[0].terminals[0].name = "LOCAL MUTATION";
  assert.equal(resolution.session.draft.projects[0].terminals[0].name, "REMOTE");
});

test("retryable non-conflict errors retain the dirty draft while storage mode errors lock it", () => {
  let session = core.createWorkspaceSession(readyLoad());
  session = core.replaceWorkspaceDraft(
    session,
    core.setTerminalCompletionPending(
      session.draft,
      "project-a",
      "terminal-a",
      true,
    ),
  );
  session = core.beginWorkspaceSave(session).session;
  const retryable = core.applyWorkspaceSaveError(session, {
    code: "io",
    message: "The durable save did not complete.",
    retryable: true,
    jsonPointer: null,
  });
  assert.equal(retryable.access, "ready");
  assert.equal(retryable.phase, "idle");
  assert.equal(retryable.dirty, true);
  assert.equal(core.beginWorkspaceSave(retryable).request.expectedRevision, 7);

  const locked = core.applyWorkspaceSaveError(session, {
    code: "readOnly",
    message: "Another instance owns the writer lock.",
    retryable: false,
    jsonPointer: null,
  });
  assert.equal(locked.access, "readOnly");
  assert.equal(locked.dirty, true);
  assert.throws(() => core.beginWorkspaceSave(locked), /read-only/);
});

test("structured errors are strict and preserve safe future metadata", () => {
  const normalized = core.normalizeStorageCommandError({
    code: "busy",
    message: "Storage is busy.",
    retryable: true,
    jsonPointer: "/tabs/0",
    futureErrorMetadata: { retryAfterMs: 250 },
  });
  assert.deepEqual(normalized.futureErrorMetadata, { retryAfterMs: 250 });
  assert.throws(
    () =>
      core.normalizeStorageCommandError({
        code: "madeUp",
        message: "Unknown",
        retryable: false,
        jsonPointer: null,
      }),
    /not supported/,
  );
});

test("non-JSON, accessor, sparse-array, and cyclic extension payloads fail safely", () => {
  let rootGetterRuns = 0;
  const accessorRoot = workspace();
  Object.defineProperty(accessorRoot, "schemaVersion", {
    enumerable: true,
    get() {
      rootGetterRuns += 1;
      return 1;
    },
  });
  assert.throws(() => core.normalizeWorkspaceState(accessorRoot), /non-data property/);
  assert.equal(rootGetterRuns, 0);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => core.normalizeWorkspaceState(workspace({ extensions: { cyclic } })),
    /cycle/,
  );

  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      throw new Error("SECRET_GETTER_MUST_NOT_RUN");
    },
  });
  assert.throws(
    () => core.normalizeWorkspaceState(workspace({ extensions: accessor })),
    (error) => {
      assert.equal(error.message.includes("SECRET_GETTER_MUST_NOT_RUN"), false);
      assert.match(error.message, /non-data property/);
      return true;
    },
  );

  const sparse = [];
  sparse.length = 2;
  sparse[1] = "value";
  assert.throws(
    () => core.normalizeWorkspaceState(workspace({ extensions: { sparse } })),
    /cannot contain holes/,
  );

  let arrayGetterRuns = 0;
  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      arrayGetterRuns += 1;
      return "must-not-run";
    },
  });
  accessorArray.length = 1;
  assert.throws(
    () => core.normalizeWorkspaceState(workspace({ extensions: { accessorArray } })),
    /non-data property/,
  );
  assert.equal(arrayGetterRuns, 0);

  const arrayWithSymbol = ["visible"];
  arrayWithSymbol[Symbol("hidden")] = "must-not-drop-silently";
  assert.throws(
    () => core.normalizeWorkspaceState(workspace({ extensions: { arrayWithSymbol } })),
    /symbol properties/,
  );
  assert.throws(
    () => core.normalizeWorkspaceState(workspace({ extensions: { invalid: Infinity } })),
    /must be finite/,
  );
  assert.throws(
    () => core.normalizeWorkspaceState(workspace({ extensions: { invalid: 1n } })),
    /not JSON-compatible/,
  );
});

test("own __proto__ JSON keys remain ordinary lossless data", () => {
  const extension = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  const normalized = core.normalizeWorkspaceState(workspace({ extensions: extension }));
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(normalized.extensions, "__proto__"), true);
  assert.deepEqual(normalized.extensions.__proto__, { polluted: true });
});
