import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relative) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("the packaged runtime is wired only to the canonical Phase 4 controller", async () => {
  const [main, controller] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
  ]);
  assert.match(main, /createPhase4WorkspaceController\(workspace/);
  assert.doesNotMatch(main, /load_project_catalog|save_project_catalog|new Phase3Controller/);
  assert.match(controller, /invoke<unknown>\("load_workspace_state"\)/);
  assert.match(controller, /invoke<unknown>\("save_workspace_state"/);
  assert.match(controller, /inspect_phase3_preview_upgrade/);
  assert.match(controller, /commit_phase3_preview_upgrade/);
});

test("import and recovery replacement are coordinated with the live workspace", async () => {
  const [main, migration, controller] = await Promise.all([
    source("src/main.ts"),
    source("src/phase3b-ui.ts"),
    source("src/phase4-controller.ts"),
  ]);
  assert.match(main, /beforeReplace:[\s\S]*prepareForExternalReplacement/);
  assert.match(main, /afterReplace:[\s\S]*finishExternalReplacement/);
  assert.match(migration, /performReplacement\(generation/);
  assert.match(migration, /afterReplace\(didCommit\)/);
  assert.match(
    controller,
    /prepareForExternalReplacement[\s\S]*await this\.runtime\.unloadAllProjects\(\)/,
  );
  assert.match(
    controller,
    /const replacement = this\.externalReplacementBarrier;[\s\S]*if \(replacement\) await replacement/,
  );
});

test("durable save precedes destructive pane changes and failed drafts roll back", async () => {
  const [main, controller] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
  ]);
  assert.match(
    main,
    /const saved = await this\.onPaneClosedCallback[\s\S]*if \(!saved[\s\S]*this\.panes\.delete/,
  );
  assert.match(
    main,
    /const previousTitle = pane\.title;[\s\S]*await this\.onPaneRenamedCallback[\s\S]*pane\.setTitle\(previousTitle\)/,
  );
  assert.match(
    controller,
    /catch \(error\) \{[\s\S]*this\.session = current;[\s\S]*this\.storageFaulted = true;/,
  );
  assert.doesNotMatch(controller, /applyWorkspaceSaveError/);
});

test("every persisted project-tab activation is capacity preflighted", async () => {
  const controller = await source("src/phase4-controller.ts");
  assert.match(
    controller,
    /private async activateTab[\s\S]*canActivateWorkspaceState\(next\)[\s\S]*this\.persist\(next/,
  );
  assert.match(
    controller,
    /private async closeTab[\s\S]*canActivateWorkspaceState\(next, shouldUnload \? projectId : null\)[\s\S]*this\.persist\(next/,
  );
  assert.match(
    controller,
    /activateRelativeWorkspaceTab[\s\S]*canActivateWorkspaceState\(next\)[\s\S]*this\.persist\(next/,
  );
});

test("queued starts dynamically favor the project currently on screen", async () => {
  const [main, core] = await Promise.all([
    source("src/main.ts"),
    source("src/phase2-core.ts"),
  ]);
  assert.match(main, /scheduler\.run\([\s\S]*workspace\.startPriority\(this\.projectId\)/);
  assert.match(core, /private takeHighestPriority\(\)/);
  assert.match(core, /priority = entry\.priority\(\)/);
});

test("a second close request escapes a hung graceful-shutdown barrier", async () => {
  const main = await source("src/main.ts");
  assert.match(
    main,
    /if \(closeBarrierRunning\) \{[\s\S]*migrationUi\.dispose\(\);[\s\S]*workspace\.dispose\(\);[\s\S]*await currentAppWindow\.destroy\(\);[\s\S]*return;/,
  );
  assert.doesNotMatch(main, /forceCloseArmed/);
});

test("migration dialog cannot close or re-enter while a replacement is busy", async () => {
  const migration = await source("src/phase3b-ui.ts");
  assert.match(
    migration,
    /private open\(\): void \{\s*if \(this\.disposed \|\| this\.busy \|\| this\.dialog\.open\) return;/,
  );
  assert.match(
    migration,
    /"cancel",\s*\(event\) => \{\s*if \(this\.busy\) event\.preventDefault\(\);/,
  );
  assert.match(migration, /this\.closeButton\.disabled = busy;/);
});

test("tabs stay above actions and pane interactions use overlay-only guides", async () => {
  const [html, styles] = await Promise.all([
    source("index.html"),
    source("src/styles.css"),
  ]);
  assert.ok(html.indexOf('class="workspace-tabs"') < html.indexOf('class="toolbar"'));
  assert.match(styles, /\.terminal-rows\s*\{/);
  assert.match(styles, /\.terminal-row\s*\{[\s\S]*display:\s*flex/);
  assert.match(styles, /\.pane-interaction-overlay\s*\{[\s\S]*pointer-events:\s*none/);
  assert.match(styles, /\.terminal-resize-handle\s*\{[\s\S]*cursor:\s*col-resize/);
});
