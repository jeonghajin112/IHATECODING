import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/project-file-tree.ts", import.meta.url))],
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
const tree = await import(moduleUrl);

function entry(name, kind = "file", parent = [], extras = {}) {
  return { name, kind, segments: [...parent, name], ...extras };
}

function response(entries, truncated = false) {
  return { entries, truncated };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("directory responses are validated, cloned, and sorted directory-first naturally", () => {
  const source = response([
    entry("file10.txt"),
    entry("README.md"),
    entry("src", "directory", [], { hidden: false }),
    entry("file2.txt"),
    entry(".git", "directory", [], { hidden: true }),
    entry("한글.md"),
  ], true);
  const normalized = tree.normalizeProjectDirectoryResponse(source, []);
  assert.deepEqual(
    normalized.entries.map(({ name }) => name),
    [".git", "src", "file2.txt", "file10.txt", "README.md", "한글.md"],
  );
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.entries[0].hidden, true);

  source.entries[0].segments[0] = "mutated";
  assert.equal(normalized.entries.some(({ name }) => name === "mutated"), false);

  assert.throws(
    () => tree.normalizeProjectDirectoryResponse(response([entry("escape", "file", [".."]) ]), []),
    /invalid segment|outside/i,
  );
  assert.throws(
    () => tree.normalizeProjectDirectoryResponse(response([entry("same"), entry("same")]), []),
    /duplicate/i,
  );
});

test("activation lazily loads only the root and deduplicates an in-flight request", async () => {
  const root = deferred();
  const calls = [];
  const model = new tree.ProjectFileTreeModel((request) => {
    calls.push(request);
    return root.promise;
  });

  const first = model.activateProject("project-a");
  const duplicate = model.activateProject("project-a");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { projectId: "project-a", pathSegments: [] });
  assert.equal(model.snapshot().root.loadState, "loading");

  root.resolve(response([
    entry("src", "directory"),
    entry("README.md"),
  ]));
  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    model.snapshot().visibleNodes.map(({ name, depth }) => [name, depth]),
    [["src", 1], ["README.md", 1]],
  );
  assert.equal(model.snapshot().visibleNodes[0].loadState, "idle");
});

test("expanded directories load one level, collapse hides descendants, and re-expand uses cache", async () => {
  const calls = [];
  const model = new tree.ProjectFileTreeModel(async (request) => {
    calls.push(request.pathSegments.join("/"));
    if (request.pathSegments.length === 0) {
      return response([entry("src", "directory"), entry("README.md")]);
    }
    if (request.pathSegments.join("/") === "src") {
      return response([
        entry("components", "directory", ["src"]),
        entry("main.ts", "file", ["src"]),
      ]);
    }
    throw new Error("An unopened grandchild must not load.");
  });

  await model.activateProject("project-a");
  assert.equal(await model.expand(["src"]), true);
  assert.deepEqual(calls, ["", "src"]);
  assert.deepEqual(
    model.snapshot().visibleNodes.map(({ name, depth, expanded }) => [name, depth, expanded]),
    [
      ["src", 1, true],
      ["components", 2, false],
      ["main.ts", 2, false],
      ["README.md", 1, false],
    ],
  );

  assert.equal(model.collapse(["src"]), true);
  assert.deepEqual(
    model.snapshot().visibleNodes.map(({ name }) => name),
    ["src", "README.md"],
  );
  assert.equal(await model.expand(["src"]), true);
  assert.deepEqual(calls, ["", "src"]);
  assert.equal(await model.expand(["README.md"]), false);
  assert.deepEqual(calls, ["", "src"]);
});

test("a folder error is visible and retry replaces it without losing expansion", async () => {
  let sourceAttempts = 0;
  const model = new tree.ProjectFileTreeModel(async ({ pathSegments }) => {
    if (pathSegments.length === 0) return response([entry("src", "directory")]);
    sourceAttempts += 1;
    if (sourceAttempts === 1) throw new Error("Folder temporarily unavailable");
    return response([entry("main.ts", "file", ["src"])], true);
  });

  await model.activateProject("project-a");
  assert.equal(await model.expand(["src"]), false);
  let source = model.snapshot().visibleNodes[0];
  assert.equal(source.expanded, true);
  assert.equal(source.loadState, "error");
  assert.equal(source.error, "Folder temporarily unavailable");

  assert.equal(await model.retry(["src"]), true);
  source = model.snapshot().visibleNodes[0];
  assert.equal(source.expanded, true);
  assert.equal(source.loadState, "loaded");
  assert.equal(source.error, null);
  assert.equal(source.truncated, true);
  assert.equal(model.snapshot().visibleNodes[1].name, "main.ts");
  assert.equal(sourceAttempts, 2);
});

test("project switches invalidate stale responses even when the old project is activated again", async () => {
  const firstA = deferred();
  const projectB = deferred();
  const secondA = deferred();
  const queues = new Map([
    ["project-a", [firstA, secondA]],
    ["project-b", [projectB]],
  ]);
  const model = new tree.ProjectFileTreeModel(({ projectId }) => queues.get(projectId).shift().promise);

  const staleA = model.activateProject("project-a");
  await Promise.resolve();
  const loadB = model.activateProject("project-b");
  await Promise.resolve();
  projectB.resolve(response([entry("b.txt")]));
  assert.equal(await loadB, true);
  assert.equal(model.snapshot().projectId, "project-b");
  assert.equal(model.snapshot().visibleNodes[0].name, "b.txt");

  const currentA = model.activateProject("project-a");
  await Promise.resolve();
  firstA.resolve(response([entry("stale-a.txt")]));
  assert.equal(await staleA, false);
  assert.equal(model.snapshot().projectId, "project-a");
  assert.equal(model.snapshot().root.loadState, "loading");

  secondA.resolve(response([entry("current-a.txt")]));
  assert.equal(await currentA, true);
  assert.deepEqual(
    model.snapshot().visibleNodes.map(({ name }) => name),
    ["current-a.txt"],
  );
});

test("snapshots are isolated from callers and subscriptions stop after unsubscribe", async () => {
  const model = new tree.ProjectFileTreeModel(async () => response([entry("src", "directory")]));
  let notifications = 0;
  const unsubscribe = model.subscribe(() => {
    notifications += 1;
  });
  await model.activateProject("project-a");
  assert.ok(notifications >= 2);

  const snapshot = model.snapshot();
  snapshot.root.entries[0].segments[0] = "mutated";
  snapshot.visibleNodes[0].name = "mutated";
  assert.equal(model.snapshot().visibleNodes[0].name, "src");

  unsubscribe();
  const before = notifications;
  model.collapse(["src"]);
  model.clearProject();
  assert.equal(notifications, before);
  assert.deepEqual(model.snapshot(), {
    projectId: null,
    root: {
      pathSegments: [],
      loadState: "idle",
      entries: [],
      truncated: false,
      error: null,
    },
    visibleNodes: [],
  });
});
