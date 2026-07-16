import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/phase3-core.ts", import.meta.url))],
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
const startupHtml = await readFile(
  fileURLToPath(new URL("../index.html", import.meta.url)),
  "utf8",
);
const defaultCapability = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
    ),
    "utf8",
  ),
);

const terminal = (id, name = "MAIN") => ({
  Id: id,
  Name: name,
  StartDirectory: "C:\\Work\\Alpha",
  CodexThreadId: "11111111-1111-1111-1111-111111111111",
  GrokSessionId: null,
  CreatedAtUtc: "2026-01-01T00:00:00.000Z",
  CompletionPending: false,
});
const project = (id = "project-a", terminals = []) => ({
  Id: id,
  Name: id === "project-a" ? "Alpha" : "Beta",
  FolderPath: id === "project-a" ? "C:\\Work\\Alpha" : "C:\\Work\\Beta",
  Terminals: terminals,
  PaneWidthRatios: { "2x1:row-0": [0.4, 0.6] },
});

test("normalizeProjectCatalog preserves schema state and pane ratios", () => {
  const normalized = core.normalizeProjectCatalog({
    Projects: [project("project-a", [terminal("terminal-a")])],
    SelectedProjectId: "project-a",
  });
  assert.equal(normalized.Projects[0].Terminals[0].Name, "MAIN");
  assert.deepEqual(normalized.Projects[0].PaneWidthRatios["2x1:row-0"], [0.4, 0.6]);
});

test("load response requires the recovery gate and normalizes its catalog", () => {
  const loaded = core.normalizeProjectCatalogLoadResponse({
    catalog: { Projects: [project()], SelectedProjectId: "project-a" },
    recoveryRequired: true,
  });
  assert.equal(loaded.recoveryRequired, true);
  assert.equal(loaded.catalog.Projects[0].Name, "Alpha");
  assert.throws(
    () =>
      core.normalizeProjectCatalogLoadResponse({
        catalog: { Projects: [], SelectedProjectId: null },
      }),
    /recoveryRequired/,
  );
});

test("future root, project and terminal fields survive normalize, clone and mutation", () => {
  const source = {
    FutureRoot: { version: 2, flags: ["tabs"] },
    Projects: [
      {
        ...project("project-a", [
          { ...terminal("terminal-a"), FutureTerminal: { resume: "later" } },
        ]),
        FutureProject: { layout: { mode: "mosaic" } },
      },
    ],
    SelectedProjectId: "project-a",
  };
  let catalog = core.cloneProjectCatalog(core.normalizeProjectCatalog(source));
  catalog = core.renameTerminal(catalog, "project-a", "terminal-a", "RENAMED");
  catalog = core.appendTerminal(catalog, "project-a", terminal("terminal-b"));
  catalog = core.reorderTerminals(catalog, "project-a", ["terminal-b", "terminal-a"]);
  catalog = core.removeTerminal(catalog, "project-a", "terminal-b");

  assert.deepEqual(catalog.FutureRoot, source.FutureRoot);
  assert.deepEqual(catalog.Projects[0].FutureProject, source.Projects[0].FutureProject);
  assert.deepEqual(
    catalog.Projects[0].Terminals[0].FutureTerminal,
    source.Projects[0].Terminals[0].FutureTerminal,
  );
  assert.notEqual(catalog.FutureRoot, source.FutureRoot);
  assert.notEqual(catalog.Projects[0].FutureProject, source.Projects[0].FutureProject);
});

test("normalizeProjectCatalog rejects duplicate folders without touching real data", () => {
  const duplicate = { ...project("project-b"), FolderPath: "c:/work/alpha/" };
  assert.throws(
    () =>
      core.normalizeProjectCatalog({
        Projects: [project(), duplicate],
        SelectedProjectId: null,
      }),
    /duplicate project folder/,
  );
});

test("normalization clears a missing selected project and starts on a blank tab", () => {
  const catalog = core.normalizeProjectCatalog({
    Projects: [project(), project("project-b")],
    SelectedProjectId: "missing",
  });
  assert.equal(catalog.SelectedProjectId, null);
  assert.equal(core.initialProject(catalog), null);
  assert.equal(
    core.initialProject({ Projects: [project()], SelectedProjectId: "missing" }),
    null,
  );
  assert.equal(
    core.initialProject({ ...catalog, SelectedProjectId: "project-b" }).Id,
    "project-b",
  );
  const blank = core.normalizeProjectCatalog({
    Projects: [project()],
    SelectedProjectId: null,
  });
  assert.equal(blank.SelectedProjectId, null);
  assert.equal(core.initialProject(blank), null);
});

test("blank tab becomes the selected project tab", () => {
  let id = 0;
  const ids = () => `tab-${++id}`;
  const initial = core.createInitialTabState(null, ids);
  const opened = core.openProjectTab(initial, project(), ids);
  assert.equal(opened.tabs.length, 1);
  assert.equal(opened.tabs[0].id, "tab-1");
  assert.equal(opened.tabs[0].kind, "project");
  assert.equal(opened.tabs[0].projectId, "project-a");
});

test("selecting an existing project closes the active redundant blank tab", () => {
  let id = 0;
  const ids = () => `tab-${++id}`;
  let state = core.createInitialTabState(project(), ids);
  state = core.addBlankTab(state, ids);
  state = core.openProjectTab(state, project(), ids);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].projectId, "project-a");
  assert.equal(state.activeTabId, "tab-1");
});

test("closing the final tab always creates one blank replacement", () => {
  let id = 0;
  const ids = () => `tab-${++id}`;
  const initial = core.createInitialTabState(project(), ids);
  const closed = core.closeWorkspaceTab(initial, initial.activeTabId, ids);
  assert.equal(closed.tabs.length, 1);
  assert.equal(closed.tabs[0].kind, "empty");
  assert.equal(closed.activeTabId, closed.tabs[0].id);
});

test("restore capacity is atomic at the global twenty-pane boundary", () => {
  assert.deepEqual(core.evaluateRestoreCapacity(12, 8), {
    allowed: true,
    current: 12,
    incoming: 8,
    required: 20,
    available: 8,
    maximum: 20,
  });
  assert.equal(core.evaluateRestoreCapacity(12, 9).allowed, false);
  assert.equal(core.evaluateRestoreCapacity(20, 0).allowed, true);
  assert.throws(() => core.evaluateRestoreCapacity(-1, 1), /non-negative integer/);
});

test("catalog mutation and recovery controls start disabled", () => {
  for (const id of ["create-project", "add-workspace-tab", "add-terminal"]) {
    assert.match(startupHtml, new RegExp(`id=["']${id}["'][^>]*disabled`));
  }
  assert.match(
    startupHtml,
    /id=["']recover-project-catalog["'][^>]*disabled[^>]*hidden|id=["']recover-project-catalog["'][^>]*hidden[^>]*disabled/,
  );
});

test("graceful close can destroy the Tauri main window", () => {
  assert.ok(defaultCapability.permissions.includes("core:window:allow-destroy"));
});

test("catalog mutation gate locks every startup, transition and save transaction", () => {
  const ready = {
    initialized: true,
    writable: true,
    shuttingDown: false,
    tabTransitionPending: false,
    projectCreationPending: false,
    terminalCreationPending: false,
  };
  assert.equal(core.catalogMutationsAllowed(ready), true);
  for (const key of [
    "initialized",
    "writable",
    "shuttingDown",
    "tabTransitionPending",
    "projectCreationPending",
    "terminalCreationPending",
  ]) {
    const blockingValue = key === "initialized" || key === "writable" ? false : true;
    assert.equal(
      core.catalogMutationsAllowed({ ...ready, [key]: blockingValue }),
      false,
      key,
    );
  }
});

test("validateProjectDraft accepts drive and UNC paths and rejects relatives", () => {
  assert.deepEqual(core.validateProjectDraft(" Alpha ", " C:\\Work\\Alpha\\ "), {
    name: "Alpha",
    folderPath: "C:\\Work\\Alpha",
  });
  assert.equal(
    core.validateProjectDraft("Network", "\\\\server\\share\\repo").folderPath,
    "\\\\server\\share\\repo",
  );
  assert.throws(() => core.validateProjectDraft("Alpha", ".\\Alpha"), /절대 폴더 경로/);
});

test("drive and UNC share roots keep their root separator", () => {
  assert.equal(core.validateProjectDraft("Drive", "C:\\").folderPath, "C:\\");
  assert.equal(
    core.validateProjectDraft("Share", "\\\\server\\share\\").folderPath,
    "\\\\server\\share\\",
  );
  const roots = [
    { ...project(), FolderPath: "C:\\" },
    { ...project("project-b"), FolderPath: "\\\\server\\share\\" },
  ];
  assert.equal(core.findProjectByFolder(roots, "c:/"), roots[0]);
  assert.equal(core.findProjectByFolder(roots, "//SERVER/share"), roots[1]);
});

test("project names and folders deduplicate deterministically", () => {
  const projects = [project()];
  assert.equal(core.uniqueProjectName(projects, "alpha"), "alpha (2)");
  assert.equal(core.findProjectByFolder(projects, "c:/work/alpha/"), projects[0]);
});

test("terminal add, rename, order and removal preserve all other project state", () => {
  const alpha = project("project-a", [terminal("a"), terminal("b", "BACKEND")]);
  const beta = project("project-b", [terminal("c")]);
  let catalog = { Projects: [alpha, beta], SelectedProjectId: "project-a" };
  catalog = core.appendTerminal(catalog, "project-a", terminal("d", "QA"));
  catalog = core.renameTerminal(catalog, "project-a", "d", "QA RENAMED");
  catalog = core.reorderTerminals(catalog, "project-a", ["d", "a", "b"]);
  catalog = core.removeTerminal(catalog, "project-a", "a");
  assert.deepEqual(
    catalog.Projects[0].Terminals.map((item) => [item.Id, item.Name]),
    [["d", "QA RENAMED"], ["b", "BACKEND"]],
  );
  assert.deepEqual(catalog.Projects[0].PaneWidthRatios, alpha.PaneWidthRatios);
  assert.equal(catalog.Projects[1], beta);
});

test("new terminal records never resume Codex or Grok in Phase 3", () => {
  const created = core.createSavedTerminal(
    "terminal-new",
    "PowerShell 1",
    "C:\\Work\\Alpha",
    "2026-07-17T00:00:00.000Z",
  );
  assert.equal(created.CodexThreadId, null);
  assert.equal(created.GrokSessionId, null);
  assert.equal(created.StartDirectory, "C:\\Work\\Alpha");
});
