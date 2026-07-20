import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("the active project owns a fixed lazy file tree in the right sidebar", async () => {
  const [html, main, controller, view, styles] = await Promise.all([
    source("index.html"),
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src/project-file-tree-view.ts"),
    source("src/styles.css"),
  ]);

  const projectListIndex = html.indexOf('id="project-list"');
  const mainShellIndex = html.indexOf('class="main-shell"');
  const fileSidebarIndex = html.indexOf('id="file-sidebar"');
  assert.ok(projectListIndex >= 0, "project list should exist");
  assert.ok(mainShellIndex > projectListIndex, "workspace should follow the project sidebar");
  assert.ok(fileSidebarIndex > mainShellIndex, "file sidebar should follow the workspace");
  assert.match(
    html,
    /id="file-sidebar"[\s\S]*id="project-files"[\s\S]*id="project-file-tree"[\s\S]*role="tree"/,
  );
  assert.match(
    html,
    /id="toggle-project-files"[\s\S]*<rect x="2\.5" y="3" width="11" height="10" rx="1\.25"><\/rect>[\s\S]*<path d="M10 3v10M5\.75 5\.5 8 8l-2\.25 2\.5"><\/path>/,
  );
  assert.match(main, /projectFileTree:\s*\{[\s\S]*section: projectFiles[\s\S]*tree: projectFileTree/);
  assert.match(controller, /new ProjectFileTreeView\(elements\.projectFileTree\)/);
  assert.match(
    controller,
    /if \(project\) \{[\s\S]*projectFileTree\.showProject\(project\)[\s\S]*projectFileTree\.hide\(\)/,
  );
  assert.match(view, /invoke<ProjectDirectoryResponse>\("list_project_directory", \{[\s\S]*projectId,[\s\S]*pathSegments/);
  assert.match(view, /invoke\("open_project_file", \{ projectId, pathSegments: segments \}\)/);
  assert.match(view, /case "ArrowDown"[\s\S]*case "ArrowRight"[\s\S]*case "ArrowLeft"[\s\S]*case "Enter"/);
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(styles, /\.project-file-tree\s*\{[\s\S]*overflow:\s*auto/);
  assert.match(styles, /\.project-file-tree-row\s*\{[\s\S]*--tree-indent/);
  assert.match(styles, /\.file-sidebar\s*\{[\s\S]*grid-column:\s*3[\s\S]*border-left:/);
  assert.match(styles, /\.file-sidebar:has\(\.project-files\[hidden\]\)\s*\{[\s\S]*width:\s*0/);
  assert.match(styles, /\.file-sidebar:has\(\.project-files\[data-expanded="false"\]:not\(\[hidden\]\)\)\s*\{[\s\S]*width:\s*34px/);
  assert.match(styles, /\.project-files-toggle\s*\{[\s\S]*width:\s*26px[\s\S]*height:\s*26px/);
  assert.match(styles, /\.project-files-toggle\[aria-expanded="false"\] svg\s*\{[\s\S]*rotate\(180deg\)/);
  assert.match(view, /PROJECT_FILES_EXPANDED_KEY[\s\S]*localStorage\.setItem\(PROJECT_FILES_EXPANDED_KEY/);
});

test("project file IPC resolves registered project IDs and rejects path escape", async () => {
  const [backend, lib] = await Promise.all([
    source("src-tauri/src/project_files.rs"),
    source("src-tauri/src/lib.rs"),
  ]);

  assert.match(backend, /async fn list_project_directory\([\s\S]*project_id: String,[\s\S]*path_segments: Vec<String>/);
  assert.match(backend, /project_root_for_id\(&store, &project_id\)/);
  assert.match(backend, /spawn_blocking/);
  assert.match(backend, /validate_path_segments[\s\S]*Component::Normal/);
  assert.match(backend, /is_within_root\(canonical_root, &canonical\)/);
  assert.match(backend, /ProjectFileKind::Symlink/);
  assert.match(backend, /ShellExecuteW/);
  assert.match(lib, /mod project_files;/);
  assert.match(
    lib,
    /generate_handler!\[[\s\S]*list_project_directory,[\s\S]*open_project_file/,
  );
});
