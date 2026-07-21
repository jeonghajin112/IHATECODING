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
  assert.match(
    controller,
    /new ProjectFileTreeView\(\{[\s\S]*\.\.\.elements\.projectFileTree,[\s\S]*onOpenFile:[\s\S]*openProjectFile/,
  );
  assert.match(
    controller,
    /if \(project\) \{[\s\S]*projectFileTree\.showProject\(project\)[\s\S]*projectFileTree\.hide\(\)/,
  );
  assert.match(view, /invoke<ProjectDirectoryResponse>\("list_project_directory", \{[\s\S]*projectId,[\s\S]*pathSegments/);
  assert.match(view, /onOpenFile\?: ProjectFileOpenHandler/);
  assert.match(
    view,
    /row\.dataset\.kind === "file" && event\.detail <= 1[\s\S]*this\.openFileRow\(row\)/,
  );
  assert.match(
    view,
    /await openFile\(\{[\s\S]*projectId,[\s\S]*projectName:[\s\S]*name: node\.name,[\s\S]*pathSegments: \[\.\.\.segments\]/,
  );
  assert.match(view, /if \(!openFile && node\.openable !== true\)/);
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

test("source files open a durable lightweight editor with conflict-aware saves and a guarded dirty-close dialog", async () => {
  const [main, controller, core, editor, styles, backend, workspaceStore, lib] =
    await Promise.all([
      source("src/main.ts"),
      source("src/phase4-controller.ts"),
      source("src/phase4-core.ts"),
      source("src/source-editor-pane.ts"),
      source("src/styles.css"),
      source("src-tauri/src/project_files.rs"),
      source("src-tauri/src/workspace_store.rs"),
      source("src-tauri/src/lib.rs"),
    ]);

  assert.match(controller, /onOpenFile:[\s\S]*openProjectFile/);
  assert.match(
    controller,
    /private async openProjectFile[\s\S]*projectEditorPanes\(project\)\.find[\s\S]*sameProjectEditorPath[\s\S]*appendProjectEditorPane[\s\S]*runtime\.addEditorPane/,
  );
  assert.match(core, /PROJECT_EDITOR_PANES_EXTENSION = "editorPanesV1"/);
  assert.match(core, /canonicalProjectPaneIds[\s\S]*projectEditorPanes\(project\)/);
  assert.match(main, /type LayoutPane = TerminalPane \| BrowserPane \| SourceEditorPane/);
  assert.match(main, /private readonly editorPanes = new Map<string, SourceEditorPane>/);
  assert.match(main, /projectEditorPanes\(project\)[\s\S]*addEditorPane/);
  assert.match(editor, /class SourceEditorPane/);
  assert.match(editor, /invoke<ProjectTextFileResponse>\("read_project_text_file"/);
  assert.match(editor, /invoke<SaveProjectTextFileResponse>\("save_project_text_file"/);
  assert.match(editor, /expectedRevision: revision/);
  assert.match(editor, /event\.key\.toLowerCase\(\) === "s"/);
  assert.match(editor, /private saving = false/);
  assert.match(editor, /this\.saving \|\|/);
  assert.match(editor, /this\.element\.dataset\.dirty = String\(this\.dirty\)/);
  assert.match(editor, /Save changes before closing/);
  assert.match(editor, /Don't Save/);
  assert.match(editor, /private async saveAndClose/);
  assert.match(editor, /savedCleanly && !this\.disposed && !this\.dirty/);
  assert.match(editor, /const closed = await this\.host\.closeEditorPane\(this\.id\)/);
  assert.match(editor, /!closed[\s\S]*this\.closeDialog\.close\(\)/);
  assert.match(editor, /cleanMessage !== undefined \|\| this\.element\.dataset\.state !== "error"/);
  assert.match(main, /async closeEditorPane\(paneId: string\): Promise<boolean>/);
  assert.match(editor, /setModalOverlayOpen\(this\.closeDialogOverlayReason\(\), true\)/);
  assert.doesNotMatch(editor, /window\.confirm|renderMarkdownPreview|Reload|Preview/);
  assert.match(styles, /\.source-editor-pane\s*\{[\s\S]*grid-template-rows/);
  assert.match(styles, /\.source-editor-close-dialog\s*\{[\s\S]*width:/);

  assert.match(backend, /async fn read_project_text_file/);
  assert.match(backend, /async fn save_project_text_file/);
  assert.match(backend, /MAX_EDITABLE_FILE_BYTES/);
  assert.match(backend, /ensure_expected_revision/);
  assert.match(backend, /ReplaceFileW/);
  assert.match(workspaceStore, /PROJECT_EDITOR_PANES_EXTENSION/);
  assert.match(workspaceStore, /validate_project_editor_panes/);
  assert.match(
    lib,
    /generate_handler!\[[\s\S]*read_project_text_file,[\s\S]*save_project_text_file/,
  );
});

test("content browser Markdown resolves through the active project before opening the durable editor", async () => {
  const [main, controller, backend, lib] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src-tauri/src/project_files.rs"),
    source("src-tauri/src/lib.rs"),
  ]);

  assert.match(
    main,
    /openMarkdownFile:\s*\(\{ grantId, pathSegments \}\)[\s\S]*openContentBrowserMarkdownFile\(grantId, pathSegments\)/,
  );
  assert.match(
    controller,
    /async openContentBrowserMarkdownFile[\s\S]*resolve_content_entry_path[\s\S]*resolve_project_file_path[\s\S]*if \(resolved === null\) return false[\s\S]*validateProjectPathSegments[\s\S]*openProjectFile\(project\.id, projectPathSegments\)/,
  );
  assert.match(
    backend,
    /async fn resolve_project_file_path\([\s\S]*absolute_path: String[\s\S]*Result<Option<Vec<String>>, ProjectFilesError>/,
  );
  assert.match(
    lib,
    /generate_handler!\[[\s\S]*resolve_project_file_path,[\s\S]*read_project_text_file/,
  );
});
