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

test("new projects use the native single-folder picker with narrow capability", async () => {
  const [html, main, controller, styles, cargo, capabilities, rust] = await Promise.all([
    source("index.html"),
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src/styles.css"),
    source("src-tauri/Cargo.toml"),
    source("src-tauri/capabilities/default.json"),
    source("src-tauri/src/lib.rs"),
  ]);
  assert.match(html, /id="project-path"[\s\S]*readonly/);
  assert.match(html, /id="select-project-folder"[\s\S]*폴더 선택/);
  assert.match(main, /requireButton\("select-project-folder"\)/);
  assert.match(controller, /open\(\{[\s\S]*directory:\s*true,[\s\S]*multiple:\s*false/);
  assert.match(controller, /projectFolderPickerPending[\s\S]*finally/);
  assert.match(controller, /if \(!this\.elements\.projectName\.value\.trim\(\)\)/);
  assert.match(styles, /\.project-path-row\s*\{[\s\S]*grid-template-columns/);
  assert.match(cargo, /tauri-plugin-dialog\s*=\s*"2"/);
  assert.match(capabilities, /"dialog:allow-open"/);
  assert.match(rust, /\.plugin\(tauri_plugin_dialog::init\(\)\)/);
});

test("preview recovery replacement is coordinated with the live workspace", async () => {
  const controller = await source("src/phase4-controller.ts");
  assert.match(
    controller,
    /prepareForExternalReplacement[\s\S]*await this\.runtime\.unloadAllProjects\(\)/,
  );
  assert.match(controller, /commit_phase3_preview_upgrade/);
  assert.match(controller, /finishExternalReplacement\(true\)/);
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

test("project browser panes restore their saved title and last accepted address", async () => {
  const [main, controller, core, backend] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src/phase4-core.ts"),
    source("src-tauri/src/lib.rs"),
  ]);
  assert.match(core, /PROJECT_BROWSER_PANES_EXTENSION = "browserPanesV1"/);
  assert.match(
    core,
    /appendProjectBrowserPane[\s\S]*legacyExtensions\[PROJECT_BROWSER_PANES_EXTENSION\]/,
  );
  assert.match(controller, /createWorkspaceBrowserPane\(this\.idFactory\(\)\)/);
  assert.match(
    controller,
    /await this\.persist\(next, "웹 패널 상태를 저장하지 못했습니다"\)[\s\S]*runtime\.addBrowserPane/,
  );
  assert.match(main, /this\.titleElement\.addEventListener\("dblclick"/);
  assert.match(main, /this\.workspace\.renameBrowserPane\(this\.id, title\)/);
  assert.match(
    main,
    /const saved = await this\.workspace\.updateBrowserPaneUrl\(this\.id, url\)/,
  );
  assert.match(main, /start\(\) \{[\s\S]*this\.navigate\(this\.address\.value, false\)/);
  assert.match(
    main,
    /for \(const browser of projectBrowserPanes\(project\)\)[\s\S]*this\.addBrowserPane\(project\.id, browser, false\)/,
  );
  assert.match(
    main,
    /onBrowserPaneClosedCallback[\s\S]*if \(!saved[\s\S]*this\.browserPanes\.delete/,
  );
  assert.match(
    main,
    /captureCurrentUrl\(\)[\s\S]*invoke<string \| null>\("read_browser_webview_url"[\s\S]*updateBrowserPaneUrl/,
  );
  assert.match(
    main,
    /await workspace\.captureBrowserPaneUrls\(\);[\s\S]*controller\?\.beginShutdown\(\);[\s\S]*flushSaves/,
  );
  assert.match(
    backend,
    /fn read_browser_webview_url[\s\S]*is_browser_pane_webview_label[\s\S]*app\.get_webview\(&label\)[\s\S]*webview[\s\S]*\.url\(\)/,
  );
  assert.match(backend, /read_provider_usage,[\s\S]*read_browser_webview_url,/);
});

test("discovered agent conversations use the canonical CAS save path", async () => {
  const controller = await source("src/phase4-controller.ts");
  assert.match(
    controller,
    /async onAgentConversationDiscovered\([\s\S]*setTerminalAgentConversation\([\s\S]*await this\.persistNow\([\s\S]*setResumePlans\(deriveSafeResumePlans\(committed\)\)/,
  );
  assert.match(
    controller,
    /terminalAgentBindingChanged\(terminal, nextTerminal\)[\s\S]*if \(bindingChanged\)[\s\S]*await this\.persistNow\(/,
  );
  assert.match(
    controller,
    /private async persistNow[\s\S]*beginWorkspaceSave\(this\.session\)[\s\S]*expectedRevision: save\.request\.expectedRevision/,
  );
  assert.match(
    controller,
    /catch \(error\)[\s\S]*setFooterStatus\([\s\S]*에이전트 대화를 연결하지 못했습니다:/,
  );
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

test("mixed pane capacity is enforced per project without a workspace-wide pane gate", async () => {
  const [main, controller] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
  ]);

  assert.match(
    main,
    /const projectPaneCount = this\.projectPaneCount\(projectId\)[\s\S]*?projectPaneCount >= MAX_PROJECT_PANES/,
  );
  assert.match(
    main,
    /restoreCapacity\([\s\S]*?this\.projectPaneCount\(project\.id\)[\s\S]*?evaluateWorkspaceRestoreCapacity\(current, incoming, MAX_PROJECT_PANES\)/,
  );
  assert.match(
    main,
    /this\.addButton\.disabled =[\s\S]*?visible\.length >= MAX_PROJECT_PANES/,
  );
  assert.match(
    controller,
    /runtime\.canAddPane\(project\.id\)[\s\S]*?evaluateWorkspaceRestoreCapacity\([\s\S]*?project\.terminals\.length \+ projectBrowserPanes\(project\)\.length,[\s\S]*?1/,
  );
  assert.match(controller, /PowerShell은 프로젝트마다 최대 \$\{capacity\.maximum\}개/);

  for (const runtimeSource of [main, controller]) {
    assert.doesNotMatch(runtimeSource, /this\.panes\.size\s*>=/);
    assert.doesNotMatch(runtimeSource, /globalRunning/);
    assert.doesNotMatch(runtimeSource, /다른 프로젝트 탭을 닫고/);
  }
});

test("manual tabs, compact project creation, and the mixed pane launcher are wired", async () => {
  const [html, main, controller, styles, cargo, capability] = await Promise.all([
    source("index.html"),
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src/styles.css"),
    source("src-tauri/Cargo.toml"),
    source("src-tauri/capabilities/default.json"),
  ]);

  assert.doesNotMatch(html, /id="project-count"/);
  assert.match(
    html,
    /class="project-section-heading"[\s\S]*id="toggle-project-list"[\s\S]*aria-controls="project-list"[\s\S]*id="create-project"[\s\S]*id="project-list"/,
  );
  assert.match(html, /id="pane-launcher-menu"[\s\S]*id="add-powershell-pane"[\s\S]*id="add-browser-pane"/);
  assert.match(styles, /\.create-project\s*\{[\s\S]*width:\s*27px;[\s\S]*height:\s*27px/);
  assert.match(styles, /\.project-list-toggle\[aria-expanded="false"\] \.project-list-chevron/);
  assert.match(
    styles,
    /\.project-sidebar\s*\{[\s\S]*grid-template:[\s\S]*"projects" minmax\(0, 1fr\)[\s\S]*"footer" auto \/ minmax\(0, 1fr\);[\s\S]*height:\s*100%;[\s\S]*overflow:\s*hidden;/,
  );
  assert.match(styles, /\.project-list\s*\{[\s\S]*grid-area:\s*projects;/);
  assert.match(styles, /\.sidebar-footer\s*\{[\s\S]*grid-area:\s*footer;/);
  assert.match(
    styles,
    /:root\s*\{[\s\S]*--canvas:\s*#070707;[\s\S]*--line-soft:\s*#171717;[\s\S]*--text:\s*#f2f2f2;/,
  );
  assert.match(
    styles,
    /\.terminal-pane\s*\{[\s\S]*border:\s*1px solid transparent;[\s\S]*border-radius:\s*var\(--radius-small\)/,
  );
  assert.match(
    styles,
    /\.terminal-context\s*\{[\s\S]*border:\s*1px solid var\(--line-soft\);[\s\S]*border-radius:\s*999px/,
  );
  assert.match(
    styles,
    /\.project-dialog\s*\{[\s\S]*border-radius:\s*9px;[\s\S]*box-shadow:\s*0 24px 72px/,
  );
  assert.match(
    styles,
    /\.terminal-pane\[data-completion-pending="true"\][\s\S]*border-color:\s*var\(--completion-border\)/,
  );
  assert.match(
    styles,
    /\.terminal-pane\s*\{[\s\S]*container-name:\s*terminal-pane;[\s\S]*container-type:\s*inline-size;/,
  );
  assert.match(
    styles,
    /@container terminal-pane \(max-width:\s*340px\)[\s\S]*\.terminal-state-label\s*\{[\s\S]*display:\s*none;[\s\S]*\.terminal-window-action\s*\{[\s\S]*width:\s*20px;/,
  );
  const narrowPaneStyles = styles.slice(
    styles.indexOf("@container terminal-pane (max-width: 340px)"),
    styles.indexOf("@container terminal-pane (max-width: 250px)"),
  );
  assert.doesNotMatch(
    narrowPaneStyles,
    /\.terminal-context\s*\{[^}]*(?:display:\s*none|visibility:\s*hidden)/,
  );
  assert.match(
    styles,
    /\.terminal-pane\[data-active="true"\] \.terminal-header\s*\{[\s\S]*background:\s*#141414;/,
  );
  assert.match(
    styles,
    /\.settings-dialog form\s*\{[\s\S]*max-height:\s*calc\(100dvh - 32px\);[\s\S]*overflow-y:\s*auto;/,
  );
  assert.match(
    styles,
    /\.settings-dialog \.dialog-actions\s*\{[\s\S]*position:\s*sticky;[\s\S]*bottom:\s*-22px;/,
  );
  assert.match(
    controller,
    /private setProjectListExpanded\(expanded: boolean\)[\s\S]*?projectList\.hidden = !expanded;[\s\S]*?setAttribute\("aria-expanded", String\(expanded\)\)/,
  );
  assert.match(controller, /setProjectListExpanded\(!expanded\)/);
  assert.doesNotMatch(controller, /button\.title\s*=\s*project\.folderPath/);
  assert.doesNotMatch(controller, /folder\.textContent\s*=\s*project\.folderPath/);
  const sidebar = controller.slice(
    controller.indexOf("private renderSidebar()"),
    controller.indexOf("private onTabKeyDown", controller.indexOf("private renderSidebar()")),
  );
  assert.match(sidebar, /button\.append\(name\)/);
  assert.doesNotMatch(sidebar, /folderPath|createElement\("small"\)/);
  assert.match(main, /class PaneLauncherController/);
  assert.match(main, /class BrowserPane[\s\S]*new Webview\(getCurrentWindow\(\), label/);
  assert.match(
    cargo,
    /tauri\s*=\s*\{\s*version\s*=\s*"2"\s*,\s*features\s*=\s*\[[^\]]*"unstable"[^\]]*\]\s*\}/,
    "embedded child WebViews require Tauri's multiwebview feature",
  );
  assert.match(capability, /"core:webview:allow-create-webview"/);
  assert.match(main, /setBrowserSuspensionReason\("layout-interaction", true\)/);
  assert.match(main, /localAddress[\s\S]*\? "http" : "https"/);
  assert.match(main, /parsed\.username \|\| parsed\.password/);
  assert.match(
    controller,
    /migrateLegacyAutomaticProjectTabsToManual\(current\)[\s\S]*persistNow\(migrated/,
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
    /if \(closeBarrierRunning\) \{[\s\S]*workspace\.dispose\(\);[\s\S]*await currentAppWindow\.destroy\(\);[\s\S]*return;/,
  );
  assert.doesNotMatch(main, /forceCloseArmed/);
});

test("preview recovery dialog cannot close or re-enter while replacement is busy", async () => {
  const controller = await source("src/phase4-controller.ts");
  assert.match(
    controller,
    /if \(this\.mutationPending \|\| this\.externalReplacementPending\) \{\s*event\.preventDefault\(\);/,
  );
  assert.match(
    controller,
    /this\.elements\.commitUpgradeButton\.disabled =\s*this\.mutationPending \|\|\s*this\.externalReplacementPending/,
  );
  assert.match(
    controller,
    /this\.elements\.closeUpgradeButton\.disabled =\s*this\.mutationPending \|\| this\.externalReplacementPending/,
  );
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
