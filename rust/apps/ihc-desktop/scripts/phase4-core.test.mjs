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
  entryPoints: [fileURLToPath(new URL("../src/phase4-core.ts", import.meta.url))],
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

function pane(id, overrides = {}) {
  return {
    id,
    name: id.toUpperCase(),
    startDirectory: "C:\\Work\\Alpha",
    codexThreadId: null,
    grokSessionId: null,
    createdAtUtc: "2026-07-17T00:00:00Z",
    completionPending: false,
    legacyExtensions: { legacyPane: id },
    futurePane: { color: "gray" },
    ...overrides,
  };
}

function project(id, paneIds = ["pane-a", "pane-b", "pane-c"], overrides = {}) {
  return {
    id,
    name: id === "project-a" ? "Alpha" : "Beta",
    folderPath: id === "project-a" ? "C:\\Work\\Alpha" : "D:\\Work\\Beta",
    lastModifiedAtUtc: null,
    terminals: paneIds.map((paneId) => pane(paneId)),
    paneWidthRatios: {
      "3x1:row-0": [1 / 3, 1 / 3, 1 / 3],
      "legacy:grid-key": [2, 1],
    },
    legacyExtensions: { projectLegacy: id },
    futureProject: { theme: "mono" },
    ...overrides,
  };
}

function blankTab(id = "tab-blank", overrides = {}) {
  return {
    id,
    kind: "empty",
    title: "New tab",
    projectId: null,
    browser: null,
    output: null,
    extensions: { retained: id },
    futureTab: { keep: true },
    ...overrides,
  };
}

function projectTab(id, projectId, overrides = {}) {
  return {
    id,
    kind: "project",
    title: projectId === "project-a" ? "Alpha" : "Beta",
    projectId,
    browser: null,
    output: null,
    extensions: { retained: id },
    futureTab: { keep: true },
    ...overrides,
  };
}

function browserTab(id = "tab-browser", overrides = {}) {
  return {
    id,
    kind: "browser",
    title: "Browser",
    projectId: "project-a",
    browser: {
      url: "https://example.com/docs",
      futureBrowser: { retained: true },
    },
    output: null,
    extensions: { retained: id },
    futureTab: { keep: true },
    ...overrides,
  };
}

function outputTab(id = "tab-output", overrides = {}) {
  return {
    id,
    kind: "output",
    title: "Output",
    projectId: "project-a",
    browser: null,
    output: {
      mode: "auto",
      relativeEntry: "dist/index.html",
      futureOutput: { retained: true },
    },
    extensions: { retained: id },
    futureTab: { keep: true },
    ...overrides,
  };
}

function workspace(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 4,
    writtenAtUtc: "2026-07-17T00:00:00Z",
    selectedProjectId: null,
    projects: [
      project("project-a"),
      project("project-b", ["pane-d", "pane-e"]),
    ],
    tabs: [blankTab()],
    activeTabId: "tab-blank",
    importProvenance: null,
    extensions: { rootExtension: { opaque: true } },
    legacyExtensions: { rootLegacy: [1, 2, 3] },
    futureRoot: { preserve: "exactly" },
    ...overrides,
  };
}

const ids = (state, projectId = "project-a") =>
  state.projects.find((item) => item.id === projectId).terminals.map((item) => item.id);

const geometry = [
  { paneId: "pane-a", left: 0, top: 0, width: 100, height: 80 },
  { paneId: "pane-b", left: 100, top: 0, width: 100, height: 80 },
  { paneId: "pane-c", left: 200, top: 0, width: 100, height: 80 },
];

test("legacy automatic project tabs collapse once to the active stable tab", () => {
  const source = workspace({
    selectedProjectId: "project-a",
    tabs: [
      projectTab("tab-alpha", "project-a", {
        futureTab: { keep: "alpha" },
      }),
      projectTab("tab-beta", "project-b", {
        extensions: { retained: "beta", nested: { opaque: true } },
        futureTab: { keep: "beta" },
      }),
    ],
    activeTabId: "tab-beta",
    legacyExtensions: {
      rootLegacy: [1, 2, 3],
      manualProjectTabsV1: false,
    },
  });
  const before = structuredClone(source);

  const result = core.migrateLegacyAutomaticProjectTabsToManual(source);

  assert.deepEqual(source, before);
  assert.equal(result.legacyExtensions.manualProjectTabsV1, true);
  assert.deepEqual(result.legacyExtensions.rootLegacy, [1, 2, 3]);
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].id, "tab-beta");
  assert.equal(result.tabs[0].projectId, "project-b");
  assert.deepEqual(result.tabs[0].extensions, before.tabs[1].extensions);
  assert.deepEqual(result.tabs[0].futureTab, before.tabs[1].futureTab);
  assert.equal(result.activeTabId, "tab-beta");
  assert.equal(result.selectedProjectId, "project-b");
});

test("manual project tab migration marker makes repeated calls a no-op", () => {
  const source = workspace({
    selectedProjectId: "project-a",
    tabs: [
      projectTab("tab-alpha", "project-a"),
      projectTab("tab-beta", "project-b"),
    ],
    activeTabId: "tab-alpha",
    legacyExtensions: {
      rootLegacy: [1, 2, 3],
      manualProjectTabsV1: true,
    },
  });
  const before = structuredClone(source);

  const result = core.migrateLegacyAutomaticProjectTabsToManual(source);

  assert.deepEqual(source, before);
  assert.deepEqual(result, before);
});

test("ambiguous or user-authored tab layouts only receive the migration marker", () => {
  const cases = [
    {
      name: "blank",
      tabs: [projectTab("tab-alpha", "project-a"), blankTab("tab-blank")],
      activeTabId: "tab-blank",
      selectedProjectId: null,
    },
    {
      name: "browser",
      tabs: [projectTab("tab-alpha", "project-a"), browserTab("tab-browser")],
      activeTabId: "tab-browser",
      selectedProjectId: null,
    },
    {
      name: "output",
      tabs: [projectTab("tab-alpha", "project-a"), outputTab("tab-output")],
      activeTabId: "tab-output",
      selectedProjectId: null,
    },
    {
      name: "duplicate project",
      tabs: [
        projectTab("tab-alpha", "project-a"),
        projectTab("tab-alpha-copy", "project-a"),
      ],
      activeTabId: "tab-alpha-copy",
      selectedProjectId: "project-a",
    },
    {
      name: "partial project set",
      tabs: [projectTab("tab-alpha", "project-a")],
      activeTabId: "tab-alpha",
      selectedProjectId: "project-a",
    },
    {
      name: "user-created extra tab",
      tabs: [
        projectTab("tab-alpha", "project-a"),
        projectTab("tab-beta", "project-b"),
        blankTab("tab-extra", { futureTab: { userOwned: true } }),
      ],
      activeTabId: "tab-extra",
      selectedProjectId: null,
    },
  ];

  for (const candidate of cases) {
    const source = workspace({
      tabs: candidate.tabs,
      activeTabId: candidate.activeTabId,
      selectedProjectId: candidate.selectedProjectId,
      legacyExtensions: { rootLegacy: candidate.name },
    });
    const before = structuredClone(source);
    const result = core.migrateLegacyAutomaticProjectTabsToManual(source);

    assert.deepEqual(source, before, `${candidate.name}: source`);
    assert.deepEqual(result.tabs, before.tabs, `${candidate.name}: tabs`);
    assert.equal(result.activeTabId, before.activeTabId, `${candidate.name}: active`);
    assert.equal(
      result.selectedProjectId,
      before.selectedProjectId,
      `${candidate.name}: selected project`,
    );
    assert.equal(result.legacyExtensions.manualProjectTabsV1, true);
    assert.equal(result.legacyExtensions.rootLegacy, candidate.name);
  }
});

test("project selection assigns or replaces the active tab without creating tabs", () => {
  const source = workspace();
  const before = structuredClone(source);
  const assigned = core.openProjectWorkspaceTab(source, "project-a", "unused-id");
  assert.deepEqual(source, before);
  assert.equal(assigned.tabs.length, 1);
  assert.equal(assigned.tabs[0].id, "tab-blank");
  assert.equal(assigned.tabs[0].kind, "project");
  assert.equal(assigned.tabs[0].futureTab.keep, true);
  assert.equal(assigned.activeTabId, "tab-blank");
  assert.equal(assigned.selectedProjectId, "project-a");

  const second = core.openProjectWorkspaceTab(assigned, "project-b", "tab-beta");
  assert.equal(second.tabs.length, 1);
  assert.equal(second.tabs[0].id, "tab-blank");
  assert.equal(second.tabs[0].projectId, "project-b");
  assert.equal(second.tabs[0].futureTab.keep, true);
  assert.equal(second.activeTabId, "tab-blank");
  assert.equal(second.selectedProjectId, "project-b");
});

test("selecting an already-open project activates it without deleting the active blank", () => {
  const state = workspace({
    selectedProjectId: null,
    tabs: [projectTab("tab-alpha", "project-a"), blankTab("tab-new")],
    activeTabId: "tab-new",
  });
  const result = core.assignBlankWorkspaceTabToProject(state, "tab-new", "project-a");
  assert.deepEqual(result.tabs.map((tab) => tab.id), ["tab-alpha", "tab-new"]);
  assert.equal(result.activeTabId, "tab-alpha");
  assert.equal(result.selectedProjectId, "project-a");
  assert.equal(result.tabs[1].kind, "empty");
  assert.equal(result.tabs[1].futureTab.keep, true);
});

test("an already-open project wins while another project tab remains unchanged", () => {
  const state = workspace({
    selectedProjectId: "project-a",
    tabs: [
      projectTab("tab-alpha", "project-a"),
      projectTab("tab-beta", "project-b"),
    ],
    activeTabId: "tab-alpha",
  });
  const before = structuredClone(state);
  const result = core.openProjectWorkspaceTab(state, "project-b", "must-not-be-used");
  assert.deepEqual(result.tabs, before.tabs);
  assert.equal(result.activeTabId, "tab-beta");
  assert.equal(result.selectedProjectId, "project-b");
});

test("blank add, close, keyboard activation, reorder, and ARIA roving focus stay coherent", () => {
  let state = core.openProjectWorkspaceTab(workspace(), "project-a", "unused");
  state = core.addBlankWorkspaceTab(state, "tab-new");
  state = core.openProjectWorkspaceTab(state, "project-b", "unused-beta");
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["tab-blank", "tab-new"]);
  assert.equal(state.tabs[1].projectId, "project-b");

  state = core.activateRelativeWorkspaceTab(state, "tab-new", "next");
  assert.equal(state.activeTabId, "tab-blank");
  state = core.moveWorkspaceTabByKeyboard(state, "tab-new", "first");
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["tab-new", "tab-blank"]);
  assert.equal(state.activeTabId, "tab-blank");
  assert.deepEqual(core.describeWorkspaceTabsForAccessibility(state), [
    { id: "tab-new", role: "tab", ariaSelected: false, tabIndex: -1 },
    { id: "tab-blank", role: "tab", ariaSelected: true, tabIndex: 0 },
  ]);

  state = core.closeWorkspaceTab(state, "tab-blank", "unused-replacement");
  assert.equal(state.activeTabId, "tab-new");
  assert.equal(state.selectedProjectId, "project-b");
  state = core.closeWorkspaceTab(state, "tab-new", "tab-replacement");
  assert.equal(state.tabs[0].id, "tab-replacement");
  assert.equal(state.tabs[0].kind, "empty");
  assert.equal(state.selectedProjectId, null);
});

test("each project independently persists at least sixty-four terminal panes", () => {
  let state = workspace({
    projects: [project("project-a", []), project("project-b", [])],
    tabs: [projectTab("tab-alpha", "project-a")],
    activeTabId: "tab-alpha",
    selectedProjectId: "project-a",
  });
  for (let index = 0; index < 64; index += 1) {
    state = core.appendProjectPane(state, "project-a", pane(`pane-a-${index}`));
    state = core.appendProjectPane(
      state,
      "project-b",
      pane(`pane-b-${index}`, { startDirectory: "D:\\Work\\Beta" }),
    );
  }
  assert.equal(state.projects[0].terminals.length, 64);
  assert.equal(state.projects[1].terminals.length, 64);
  assert.equal(
    state.projects.reduce((total, item) => total + item.terminals.length, 0),
    128,
  );
});

test("browser panes persist in the project extension with title, URL, and close semantics", () => {
  const source = workspace();
  const before = structuredClone(source);
  const browser = core.createWorkspaceBrowserPane(
    "browser-one",
    "  Preview  ",
    "https://example.com/docs",
  );

  let state = core.appendProjectBrowserPane(source, "project-a", browser);
  assert.deepEqual(source, before);
  assert.deepEqual(core.projectBrowserPanes(state.projects[0]), [
    {
      id: "browser-one",
      title: "Preview",
      url: "https://example.com/docs",
    },
  ]);
  assert.equal(state.projects[0].legacyExtensions.projectLegacy, "project-a");

  state = core.renameProjectBrowserPane(
    state,
    "project-a",
    "browser-one",
    "  Local app  ",
  );
  state = core.setProjectBrowserPaneUrl(
    state,
    "project-a",
    "browser-one",
    "http://localhost:3000/dashboard",
  );
  assert.deepEqual(core.projectBrowserPanes(state.projects[0]), [
    {
      id: "browser-one",
      title: "Local app",
      url: "http://localhost:3000/dashboard",
    },
  ]);

  state = core.removeProjectBrowserPane(state, "project-a", "browser-one");
  assert.deepEqual(core.projectBrowserPanes(state.projects[0]), []);
  assert.equal(state.projects[0].legacyExtensions.projectLegacy, "project-a");
});

test("browser pane restore ignores malformed entries and persists sixty-four mixed panes", () => {
  const malformed = project("project-a", ["pane-a"], {
    legacyExtensions: {
      projectLegacy: "project-a",
      browserPanesV1: [
        { id: "bad-scheme", title: "Bad", url: "file:///private" },
        { id: "good", title: "Good", url: "https://example.com/" },
        { id: "good", title: "Duplicate", url: "https://duplicate.example/" },
      ],
    },
  });
  assert.deepEqual(core.projectBrowserPanes(malformed), [
    { id: "good", title: "Good", url: "https://example.com/" },
  ]);

  let state = workspace({
    projects: [project("project-a", Array.from({ length: 32 }, (_, index) => `pane-${index}`))],
  });
  for (let index = 0; index < 32; index += 1) {
    state = core.appendProjectBrowserPane(
      state,
      "project-a",
      core.createWorkspaceBrowserPane(`browser-${index}`),
    );
  }
  assert.equal(state.projects[0].terminals.length, 32);
  assert.equal(core.projectBrowserPanes(state.projects[0]).length, 32);
  assert.throws(
    () => core.setProjectBrowserPaneUrl(state, "project-a", "browser-31", "javascript:1"),
    /not allowed/,
  );
});

test("project and terminal helpers create, append, rename, remove, and name deterministically", () => {
  const createdProject = core.createWorkspaceProject(
    "project-new",
    "  Gamma  ",
    " C:/Work/Gamma/ ",
    "2026-07-18T03:04:05Z",
  );
  assert.deepEqual(createdProject, {
    id: "project-new",
    name: "Gamma",
    folderPath: "C:\\Work\\Gamma",
    lastModifiedAtUtc: "2026-07-18T03:04:05Z",
    terminals: [],
    paneWidthRatios: {},
    legacyExtensions: {},
  });

  let state = core.appendWorkspaceProject(workspace(), createdProject);
  assert.equal(state.projects.at(-1).id, "project-new");
  assert.equal(core.uniqueWorkspaceProjectName(state.projects, "alpha"), "alpha (2)");
  assert.equal(core.uniqueWorkspaceProjectName(state.projects, "Delta"), "Delta");
  assert.equal(
    core.findWorkspaceProjectByFolder(state.projects, "c:/work/gamma/"),
    state.projects.at(-1),
  );

  const createdPane = core.createWorkspaceTerminal(
    "pane-new",
    "  Worker  ",
    " C:/Work/Gamma/ ",
    "2026-07-17T01:02:03Z",
  );
  assert.equal(createdPane.name, "Worker");
  assert.equal(createdPane.startDirectory, "C:\\Work\\Gamma");
  assert.equal(createdPane.codexThreadId, null);
  assert.equal(createdPane.grokSessionId, null);
  assert.equal(createdPane.completionPending, false);

  state = core.appendProjectPane(state, "project-new", createdPane);
  state = core.appendProjectPane(state, "project-new", pane("pane-worker-2", {
    name: "PowerShell 1",
    startDirectory: "C:\\Work\\Gamma",
  }));
  assert.equal(core.nextWorkspacePaneName(state.projects.at(-1)), "PowerShell 2");
  state = core.renameProjectPane(state, "project-new", "pane-new", "  Coordinator  ");
  assert.equal(state.projects.at(-1).terminals[0].name, "Coordinator");
  state = core.removeProjectPane(state, "project-new", "pane-new");
  assert.deepEqual(state.projects.at(-1).terminals.map((item) => item.id), ["pane-worker-2"]);

  assert.throws(
    () => core.appendWorkspaceProject(state, { ...createdProject, id: "another-id" }),
    /already registered/,
  );
  assert.throws(
    () => core.renameProjectPane(state, "project-new", "pane-worker-2", "   "),
    /cannot be empty/,
  );
});

test("projects sort newest-first with terminal fallback and stable ties", () => {
  const source = [
    project("stable-a", [], { lastModifiedAtUtc: null }),
    project("legacy-pane", ["pane-old", "pane-new"], {
      lastModifiedAtUtc: null,
      terminals: [
        pane("pane-old", { createdAtUtc: "2026-07-18T01:00:00Z" }),
        pane("pane-new", { createdAtUtc: "2026-07-18T03:00:00Z" }),
      ],
    }),
    project("current", [], { lastModifiedAtUtc: "2026-07-18T04:00:00Z" }),
    project("stable-b", [], { lastModifiedAtUtc: null }),
    project("tie-a", [], { lastModifiedAtUtc: "2026-07-18T02:00:00Z" }),
    project("tie-b", [], { lastModifiedAtUtc: "2026-07-18T02:00:00Z" }),
  ];
  const before = structuredClone(source);

  assert.deepEqual(
    core.sortWorkspaceProjectsByRecentModification(source).map((item) => item.id),
    ["current", "legacy-pane", "tie-a", "tie-b", "stable-a", "stable-b"],
  );
  assert.deepEqual(source, before);
});

test("project mutation helpers persist an injected modification timestamp", () => {
  const source = workspace();
  const before = structuredClone(source);
  let state = core.touchWorkspaceProject(
    source,
    "project-a",
    "2026-07-18T00:00:00Z",
  );
  assert.deepEqual(source, before);
  assert.equal(state.projects[0].lastModifiedAtUtc, "2026-07-18T00:00:00Z");

  state = core.appendProjectPane(
    state,
    "project-a",
    pane("pane-new"),
    "2026-07-18T01:00:00Z",
  );
  assert.equal(state.projects[0].lastModifiedAtUtc, "2026-07-18T01:00:00Z");
  state = core.renameProjectPane(
    state,
    "project-a",
    "pane-new",
    "Worker",
    "2026-07-18T02:00:00Z",
  );
  assert.equal(state.projects[0].lastModifiedAtUtc, "2026-07-18T02:00:00Z");
  state = core.removeProjectPane(
    state,
    "project-a",
    "pane-new",
    "2026-07-18T03:00:00Z",
  );
  assert.equal(state.projects[0].lastModifiedAtUtc, "2026-07-18T03:00:00Z");

  state = core.appendProjectBrowserPane(
    state,
    "project-a",
    core.createWorkspaceBrowserPane("browser-new"),
    "2026-07-18T04:00:00Z",
  );
  state = core.renameProjectBrowserPane(
    state,
    "project-a",
    "browser-new",
    "Preview",
    "2026-07-18T05:00:00Z",
  );
  state = core.setProjectBrowserPaneUrl(
    state,
    "project-a",
    "browser-new",
    "https://example.com/preview",
    "2026-07-18T06:00:00Z",
  );
  state = core.removeProjectBrowserPane(
    state,
    "project-a",
    "browser-new",
    "2026-07-18T07:00:00Z",
  );
  assert.equal(state.projects[0].lastModifiedAtUtc, "2026-07-18T07:00:00Z");

  state = core.setTerminalAgentConversation(
    state,
    "project-a",
    "pane-a",
    "codex",
    "01981f62-94ac-7a3b-8c12-111111111111",
    "2026-07-18T08:00:00Z",
  );
  assert.equal(state.projects[0].lastModifiedAtUtc, "2026-07-18T08:00:00Z");
  state = core.applyProjectPaneInsertion(
    state,
    "project-a",
    "pane-a",
    { beforePaneId: "pane-c" },
    "2026-07-18T09:00:00Z",
  );
  state = core.moveProjectPaneByKeyboard(
    state,
    "project-a",
    "pane-a",
    "first",
    "2026-07-18T10:00:00Z",
  );
  assert.equal(state.projects[0].lastModifiedAtUtc, "2026-07-18T10:00:00Z");

  const resized = core.resizeProjectPaneBoundaryHorizontal(
    state,
    "project-a",
    {
      layoutKey: "3x1:row-0",
      rowPaneIds: ["pane-a", "pane-b", "pane-c"],
      leftPaneId: "pane-a",
      rightPaneId: "pane-b",
      totalWidthPx: 900,
      deltaX: 20,
    },
    "2026-07-18T11:00:00Z",
  );
  assert.equal(resized.state.projects[0].lastModifiedAtUtc, "2026-07-18T11:00:00Z");

  assert.throws(
    () => core.touchWorkspaceProject(state, "project-a", "not-a-timestamp"),
    /RFC 3339/,
  );
});

test("only an active project tab selects a sidebar project", () => {
  const tabs = [
    projectTab("tab-project", "project-a"),
    blankTab("tab-empty"),
    browserTab(),
    outputTab(),
  ];
  let state = workspace({
    selectedProjectId: "project-a",
    tabs,
    activeTabId: "tab-project",
  });

  for (const tabId of ["tab-empty", "tab-browser", "tab-output"]) {
    state = core.activateWorkspaceTab(state, tabId);
    assert.equal(state.activeTabId, tabId);
    assert.equal(state.selectedProjectId, null);
  }
  state = core.activateWorkspaceTab(state, "tab-project");
  assert.equal(state.selectedProjectId, "project-a");
});

test("closing project tabs never deletes projects and recomputes sidebar selection by tab kind", () => {
  let state = workspace({
    selectedProjectId: "project-a",
    tabs: [
      projectTab("tab-project", "project-a"),
      browserTab(),
      outputTab(),
    ],
    activeTabId: "tab-project",
  });
  const projectsBefore = structuredClone(state.projects);

  state = core.closeWorkspaceTab(state, "tab-project", "unused-replacement");
  assert.deepEqual(state.projects, projectsBefore);
  assert.equal(state.activeTabId, "tab-browser");
  assert.equal(state.selectedProjectId, null);

  state = core.closeWorkspaceTab(state, "tab-output", "unused-replacement");
  assert.equal(state.activeTabId, "tab-browser");
  assert.equal(state.selectedProjectId, null);
  state = core.closeWorkspaceTab(state, "tab-browser", "tab-fallback");
  assert.deepEqual(state.projects, projectsBefore);
  assert.equal(state.tabs[0].kind, "empty");
  assert.equal(state.selectedProjectId, null);
});

test("workspace restore has no product cap while explicit safety maxima remain atomic", () => {
  const productCapacity = core.evaluateWorkspaceRestoreCapacity(32, 32);
  assert.equal(productCapacity.allowed, true);
  assert.equal(productCapacity.required, 64);
  assert.ok(productCapacity.maximum >= 64);

  assert.deepEqual(core.evaluateWorkspaceRestoreCapacity(18, 2, 20), {
    allowed: true,
    current: 18,
    incoming: 2,
    required: 20,
    available: 2,
    maximum: 20,
  });
  assert.deepEqual(core.evaluateWorkspaceRestoreCapacity(18, 3, 20), {
    allowed: false,
    current: 18,
    incoming: 3,
    required: 21,
    available: 2,
    maximum: 20,
  });
  assert.equal(core.evaluateWorkspaceRestoreCapacity(20, 0, 20).allowed, true);
  assert.throws(() => core.evaluateWorkspaceRestoreCapacity(-1, 1), /non-negative integer/);
  assert.throws(() => core.evaluateWorkspaceRestoreCapacity(0, 0, 0), /must be positive/);
});

test("project and terminal mutations preserve all unrelated unknown fields", () => {
  const source = workspace({
    futureRoot: { nested: { value: 9 } },
    tabs: [projectTab("tab-alpha", "project-a")],
    activeTabId: "tab-alpha",
    selectedProjectId: "project-a",
  });
  const before = structuredClone(source);
  let state = core.appendWorkspaceProject(
    source,
    {
      ...project("project-new", []),
      id: "project-new",
      name: "Gamma",
      folderPath: "E:\\Work\\Gamma",
      futureProject: { created: "opaque" },
    },
  );
  state = core.appendProjectPane(state, "project-new", pane("pane-new", {
    startDirectory: "E:\\Work\\Gamma",
    futurePane: { created: "opaque" },
  }));
  state = core.renameProjectPane(state, "project-new", "pane-new", "Renamed");

  assert.deepEqual(source, before);
  assert.deepEqual(state.futureRoot, before.futureRoot);
  assert.deepEqual(state.extensions, before.extensions);
  assert.deepEqual(state.legacyExtensions, before.legacyExtensions);
  assert.deepEqual(state.projects[0].futureProject, before.projects[0].futureProject);
  assert.deepEqual(state.projects[0].terminals[0].futurePane, before.projects[0].terminals[0].futurePane);
  assert.deepEqual(state.tabs[0].futureTab, before.tabs[0].futureTab);
  assert.deepEqual(state.projects.at(-1).futureProject, { created: "opaque" });
  assert.deepEqual(state.projects.at(-1).terminals[0].futurePane, { created: "opaque" });
});

test("discovered agent conversations are exclusive, durable-shaped terminal mutations", () => {
  const CODEX_ID = "01981F62-94AC-7A3B-8C12-111111111111";
  const GROK_ID = "01981F62-94AC-7A3B-8C12-222222222222";
  const source = workspace({
    projects: [
      project("project-a", ["pane-a"], {
        terminals: [
          pane("pane-a", {
            grokSessionId: GROK_ID,
            legacyExtensions: {
              resumeBlocked: true,
              opaqueLegacy: { keep: true },
            },
            futurePane: { nested: [1, 2, 3] },
          }),
        ],
      }),
      project("project-b", ["pane-b"]),
    ],
  });
  const before = structuredClone(source);

  const codex = core.setTerminalAgentConversation(
    source,
    "project-a",
    "pane-a",
    "codex",
    CODEX_ID.toUpperCase(),
  );
  const codexPane = codex.projects[0].terminals[0];
  assert.equal(codexPane.codexThreadId, CODEX_ID.toLowerCase());
  assert.equal(codexPane.grokSessionId, null);
  assert.equal(codexPane.legacyExtensions.resumeBlocked, undefined);
  assert.deepEqual(codexPane.legacyExtensions.opaqueLegacy, { keep: true });
  assert.deepEqual(codexPane.futurePane, before.projects[0].terminals[0].futurePane);
  assert.deepEqual(codex.futureRoot, before.futureRoot);
  assert.deepEqual(source, before);

  const grok = core.setTerminalAgentConversation(
    codex,
    "project-a",
    "pane-a",
    "grok",
    GROK_ID,
  );
  assert.equal(grok.projects[0].terminals[0].codexThreadId, null);
  assert.equal(grok.projects[0].terminals[0].grokSessionId, GROK_ID.toLowerCase());
});

test("account switching blocks selected-provider auto resume without losing conversation ids", () => {
  const source = workspace({
    projects: [
      project("project-a", ["pane-a"], {
        terminals: [
          pane("pane-a", {
            codexThreadId: "01981f62-94ac-7a3b-8c12-111111111111",
            grokSessionId: "01981f62-94ac-7a3b-8c12-222222222222",
          }),
        ],
      }),
    ],
  });
  const before = structuredClone(source);

  const codex = core.blockWorkspaceProviderResumeForAccountSwitch(
    source,
    "codex",
    "2026-07-18T08:00:00Z",
  );
  assert.equal(codex.projects[0].terminals[0].codexThreadId, before.projects[0].terminals[0].codexThreadId);
  assert.equal(codex.projects[0].terminals[0].grokSessionId, before.projects[0].terminals[0].grokSessionId);
  assert.equal(codex.projects[0].terminals[0].legacyExtensions.resumeBlocked, true);
  assert.equal(codex.projects[0].lastModifiedAtUtc, "2026-07-18T08:00:00Z");
  assert.deepEqual(source, before);

  const unchanged = core.blockWorkspaceProviderResumeForAccountSwitch(
    codex,
    "codex",
    "2026-07-18T09:00:00Z",
  );
  assert.equal(unchanged.projects[0].lastModifiedAtUtc, "2026-07-18T08:00:00Z");

  const grok = core.blockWorkspaceProviderResumeForAccountSwitch(
    source,
    "grok",
    "2026-07-18T10:00:00Z",
  );
  assert.equal(grok.projects[0].terminals[0].codexThreadId, before.projects[0].terminals[0].codexThreadId);
  assert.equal(grok.projects[0].terminals[0].grokSessionId, before.projects[0].terminals[0].grokSessionId);
  assert.equal(grok.projects[0].terminals[0].legacyExtensions.resumeBlocked, true);
  assert.equal(grok.projects[0].lastModifiedAtUtc, "2026-07-18T10:00:00Z");
});

test("rediscovering the same agent ID still clears the durable resume blocker", () => {
  const CODEX_ID = "01981f62-94ac-7a3b-8c12-111111111111";
  const source = workspace({
    projects: [
      project("project-a", ["pane-a"], {
        terminals: [
          pane("pane-a", {
            codexThreadId: CODEX_ID,
            legacyExtensions: {
              resumeBlocked: true,
              opaqueLegacy: { keep: true },
            },
          }),
        ],
      }),
    ],
  });
  const previous = source.projects[0].terminals[0];

  const next = core.setTerminalAgentConversation(
    source,
    "project-a",
    "pane-a",
    "codex",
    CODEX_ID.toUpperCase(),
  );
  const nextTerminal = next.projects[0].terminals[0];

  assert.equal(nextTerminal.codexThreadId, CODEX_ID);
  assert.equal(nextTerminal.grokSessionId, null);
  assert.equal(nextTerminal.legacyExtensions.resumeBlocked, undefined);
  assert.deepEqual(nextTerminal.legacyExtensions.opaqueLegacy, { keep: true });
  assert.equal(core.terminalAgentBindingChanged(previous, nextTerminal), true);

  const repeated = core.setTerminalAgentConversation(
    next,
    "project-a",
    "pane-a",
    "codex",
    CODEX_ID,
  );
  assert.equal(
    core.terminalAgentBindingChanged(nextTerminal, repeated.projects[0].terminals[0]),
    false,
  );
});

test("agent conversation discovery rejects same-provider duplicate ownership", () => {
  const ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const source = workspace({
    projects: [
      project("project-a", ["pane-a"], {
        terminals: [pane("pane-a", { codexThreadId: ID })],
      }),
      project("project-b", ["pane-b"]),
    ],
  });
  const before = structuredClone(source);

  assert.throws(
    () =>
      core.setTerminalAgentConversation(
        source,
        "project-b",
        "pane-b",
        "codex",
        ID.toLowerCase(),
      ),
    /already owned/,
  );
  assert.deepEqual(source, before);

  const crossProvider = core.setTerminalAgentConversation(
    source,
    "project-b",
    "pane-b",
    "grok",
    ID.toLowerCase(),
  );
  assert.equal(crossProvider.projects[1].terminals[0].grokSessionId, ID.toLowerCase());
  assert.throws(
    () => core.setTerminalAgentConversation(source, "project-b", "pane-b", "codex", "bad"),
    /valid UUID/,
  );
  assert.throws(
    () => core.setTerminalAgentConversation(source, "project-b", "pane-b", "other", ID),
    /provider is invalid/,
  );
  assert.throws(
    () => core.setTerminalAgentConversation(source, "project-b", "missing", "grok", ID),
    /does not exist/,
  );
});

test("Windows project and terminal paths are normalized and invalid paths fail closed", () => {
  assert.deepEqual(core.validateWorkspaceProjectDraft(" Network ", " \\\\server\\share\\team\\ "), {
    name: "Network",
    folderPath: "\\\\server\\share\\team",
  });
  assert.equal(
    core.createWorkspaceTerminal("pane-root", "Root", " C:/ ", "2026-07-17T00:00:00Z")
      .startDirectory,
    "C:\\",
  );

  for (const invalid of ["relative\\folder", "C:", "C:\\bad|name", "\\\\server"]) {
    assert.throws(
      () => core.validateWorkspaceProjectDraft("Invalid", invalid),
      /folder|UNC|path/i,
    );
    assert.throws(
      () => core.createWorkspaceTerminal("pane-invalid", "Invalid", invalid, "2026-07-17T00:00:00Z"),
      /absolute Windows path/,
    );
  }
});

test("the folder picker suggestion follows Windows folder names without overwriting intent", () => {
  assert.equal(core.suggestWorkspaceProjectName("C:\\Work\\Alpha\\"), "Alpha");
  assert.equal(core.suggestWorkspaceProjectName("\\\\server\\share\\Team"), "Team");
  assert.equal(core.suggestWorkspaceProjectName("C:\\"), "New project");
});

test("drag insertion uses stable target identity even when its preview index is stale", () => {
  const source = workspace();
  const result = core.applyProjectPaneInsertion(source, "project-a", "pane-a", {
    beforePaneId: "pane-c",
    index: 99,
  });
  assert.deepEqual(ids(result), ["pane-b", "pane-a", "pane-c"]);
  assert.deepEqual(ids(source), ["pane-a", "pane-b", "pane-c"]);
  assert.equal(result.projects[0].terminals[1].futurePane.color, "gray");

  const appended = core.applyProjectPaneInsertion(
    result,
    "project-a",
    "pane-b",
    { beforePaneId: null },
  );
  assert.deepEqual(ids(appended), ["pane-a", "pane-c", "pane-b"]);
});

test("insertion preview is deterministic and hysteresis resists boundary jitter", () => {
  const first = core.resolvePaneInsertionPreview(
    geometry,
    "pane-c",
    { x: 49, y: 40 },
    null,
    { hysteresisPx: 14 },
  );
  assert.equal(first.beforePaneId, "pane-a");
  const jitter = core.resolvePaneInsertionPreview(
    geometry,
    "pane-c",
    { x: 56, y: 40 },
    first,
    { hysteresisPx: 14 },
  );
  assert.equal(jitter.beforePaneId, "pane-a");
  const decisive = core.resolvePaneInsertionPreview(
    geometry,
    "pane-c",
    { x: 80, y: 40 },
    jitter,
    { hysteresisPx: 14 },
  );
  assert.equal(decisive.beforePaneId, "pane-b");
  assert.deepEqual(
    core.resolvePaneInsertionPreview(geometry, "pane-c", { x: 50, y: 40 }),
    core.resolvePaneInsertionPreview(geometry, "pane-c", { x: 50, y: 40 }),
  );
});

test("keyboard pane movement covers adjacent and boundary commands without wrapping", () => {
  let state = workspace();
  state = core.moveProjectPaneByKeyboard(state, "project-a", "pane-b", "first");
  assert.deepEqual(ids(state), ["pane-b", "pane-a", "pane-c"]);
  state = core.moveProjectPaneByKeyboard(state, "project-a", "pane-b", "previous");
  assert.deepEqual(ids(state), ["pane-b", "pane-a", "pane-c"]);
  state = core.moveProjectPaneByKeyboard(state, "project-a", "pane-a", "next");
  assert.deepEqual(ids(state), ["pane-b", "pane-c", "pane-a"]);
  state = core.moveProjectPaneByKeyboard(state, "project-a", "pane-b", "last");
  assert.deepEqual(ids(state), ["pane-c", "pane-a", "pane-b"]);
});

test("horizontal resize changes only adjacent ratios and enforces minimum widths", () => {
  const resized = core.computeHorizontalResize({
    ratios: [0.3, 0.4, 0.3],
    dividerIndex: 0,
    totalWidthPx: 1000,
    deltaX: 90,
    minPaneWidthPx: 200,
  });
  assert.deepEqual(resized.ratios.map((value) => Number(value.toFixed(6))), [0.39, 0.31, 0.3]);
  assert.equal(resized.dividerX, 390);

  const clamped = core.computeHorizontalResize({
    ratios: [0.3, 0.4, 0.3],
    dividerIndex: 0,
    totalWidthPx: 1000,
    deltaX: 900,
    minPaneWidthPx: 200,
  });
  assert.equal(clamped.dividerX, 500);
  assert.deepEqual(clamped.ratios.map((value) => Number(value.toFixed(6))), [0.5, 0.2, 0.3]);
  assert.throws(
    () => core.computeHorizontalResize({
      ratios: [1, 1, 1],
      dividerIndex: 0,
      totalWidthPx: 500,
      deltaX: 0,
      minPaneWidthPx: 180,
    }),
    /too narrow/,
  );
});

test("resize snaps to the nearest aligned sibling edge with deterministic ties", () => {
  const result = core.computeHorizontalResize({
    ratios: [0.5, 0.5],
    dividerIndex: 0,
    totalWidthPx: 800,
    deltaX: 26,
    minPaneWidthPx: 160,
    containerLeftPx: 100,
    siblingEdgesPx: [530, 522],
    snapDistancePx: 8,
  });
  assert.equal(result.dividerX, 522);
  assert.equal(result.snappedToPx, 522);
  assert.equal(result.appliedDeltaX, 22);
});

test("project resize requires real adjacent siblings and preserves unrelated fields", () => {
  const source = workspace();
  const before = structuredClone(source);
  const result = core.resizeProjectPaneBoundaryHorizontal(source, "project-a", {
    layoutKey: "3x1:row-0",
    rowPaneIds: ["pane-a", "pane-b", "pane-c"],
    leftPaneId: "pane-a",
    rightPaneId: "pane-b",
    totalWidthPx: 900,
    deltaX: 30,
    minPaneWidthPx: 180,
  });
  assert.deepEqual(source, before);
  assert.deepEqual(
    result.state.projects[0].paneWidthRatios["3x1:row-0"].map((value) => Number(value.toFixed(6))),
    [0.366667, 0.3, 0.333333],
  );
  assert.deepEqual(
    result.state.projects[0].paneWidthRatios["legacy:grid-key"],
    source.projects[0].paneWidthRatios["legacy:grid-key"],
  );
  assert.deepEqual(result.state.futureRoot, source.futureRoot);
  assert.deepEqual(result.state.projects[0].futureProject, source.projects[0].futureProject);
  assert.throws(
    () => core.resizeProjectPaneBoundaryHorizontal(source, "project-a", {
      layoutKey: "3x1:row-0",
      rowPaneIds: ["pane-a", "pane-b", "pane-c"],
      leftPaneId: "pane-a",
      rightPaneId: "pane-c",
      totalWidthPx: 900,
      deltaX: 10,
    }),
    /adjacent sibling/,
  );
});

test("keyboard resize shares horizontal constraints and has no vertical state", () => {
  const result = core.resizeProjectPaneBoundaryByKeyboard(
    workspace(),
    "project-a",
    {
      layoutKey: "3x1:row-0",
      rowPaneIds: ["pane-a", "pane-b", "pane-c"],
      leftPaneId: "pane-b",
      rightPaneId: "pane-c",
      totalWidthPx: 900,
      minPaneWidthPx: 180,
    },
    "shrink-left",
    18,
  );
  assert.deepEqual(
    result.state.projects[0].paneWidthRatios["3x1:row-0"].map((value) => Number(value.toFixed(6))),
    [0.333333, 0.313333, 0.353333],
  );
  assert.equal(Object.hasOwn(result.resize, "height"), false);
  assert.equal(Object.hasOwn(result.resize, "deltaY"), false);
});

test("invalid geometry, IDs, ratio keys, and stale insertion targets fail closed", () => {
  assert.throws(
    () => core.resolvePaneInsertionPreview(
      [geometry[0], { ...geometry[1], paneId: "pane-a" }],
      "pane-a",
      { x: 0, y: 0 },
    ),
    /unique/,
  );
  assert.throws(
    () => core.applyProjectPaneInsertion(workspace(), "project-a", "pane-a", {
      beforePaneId: "missing",
    }),
    /no longer exists/,
  );
  assert.throws(
    () => core.resizeProjectPaneBoundaryHorizontal(workspace(), "project-a", {
      layoutKey: "2x1:row-0",
      rowPaneIds: ["pane-a", "pane-b", "pane-c"],
      leftPaneId: "pane-a",
      rightPaneId: "pane-b",
      totalWidthPx: 900,
      deltaX: 10,
    }),
    /does not match/,
  );
});
