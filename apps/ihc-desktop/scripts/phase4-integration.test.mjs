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

test("existing folders use the picker while scratch projects create a Documents child folder", async () => {
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
  assert.match(html, /id="project-path-field"[\s\S]*id="project-path"/);
  assert.match(html, /id="select-project-folder"[\s\S]*data-i18n-en="Choose folder"[\s\S]*Choose folder/);
  assert.match(main, /requireButton\("select-project-folder"\)/);
  assert.match(controller, /open\(\{[\s\S]*directory:\s*true,[\s\S]*multiple:\s*false/);
  assert.match(controller, /projectFolderPickerPending[\s\S]*finally/);
  assert.match(
    controller,
    /private async openExistingFolderProject\(\)[\s\S]*pickProjectFolder\(defaultPath, false\)[\s\S]*openProjectDialog\(selected, "existing"\)/,
  );
  assert.match(
    controller,
    /openProjectDialog\(null, "scratch"\)[\s\S]*projectDialogMode = mode[\s\S]*const scratch = mode === "scratch"[\s\S]*projectPathField\.hidden = scratch/,
  );
  assert.match(
    controller,
    /projectPath\.required = !scratch/,
  );
  const createProject = controller.slice(
    controller.indexOf("private async createProject"),
    controller.indexOf("async addTerminal", controller.indexOf("private async createProject")),
  );
  assert.match(
    createProject,
    /projectDialogMode === "scratch"[\s\S]*invoke<string>\("create_documents_project_directory"[\s\S]*projectName[\s\S]*createWorkspaceProject/,
  );
  assert.match(
    createProject,
    /enqueueOperation\(async \(\) =>[\s\S]*const current = this\.currentState\(\)[\s\S]*create_documents_project_directory[\s\S]*persistNow/,
  );
  assert.match(
    createProject,
    /rollbackScratchProjectDirectory[\s\S]*remove_empty_documents_project_directory/,
  );
  assert.match(
    createProject,
    /validateWorkspaceProjectDraft\(projectName, this\.elements\.projectPath\.value\)[\s\S]*createWorkspaceProject/,
  );
  assert.match(rust, /fn create_documents_project_directory\([\s\S]*document_dir\(\)/);
  assert.match(
    rust,
    /generate_handler!\[[\s\S]*create_documents_project_directory/,
  );
  assert.match(rust, /fn create_documents_project_directory_in\(/);
  assert.match(rust, /fn remove_empty_documents_project_directory_in\(/);
  assert.match(
    rust,
    /generate_handler!\[[\s\S]*remove_empty_documents_project_directory/,
  );
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
    /await this\.persist\([\s\S]*next,[\s\S]*tr\("Could not save the web pane state", "웹 패널 상태를 저장하지 못했습니다"\)[\s\S]*runtime\.addBrowserPane/,
  );
  assert.equal(
    main.match(/header\.addEventListener\("dblclick"/g)?.length,
    2,
    "terminal and browser headers must both expose double-click rename",
  );
  assert.match(
    main,
    /header\.addEventListener\("dblclick"[\s\S]*?target\.closest\("button, input, textarea, select, \[contenteditable='true'\]"\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?this\.workspace\.cancelLayoutInteraction\(\);[\s\S]*?this\.beginTitleEdit\(\)/,
  );
  assert.match(main, /this\.workspace\.renameBrowserPane\(this\.id, title\)/);
  assert.match(
    main,
    /const saved = await this\.workspace\.updateBrowserPaneUrl\(this\.id, url\)/,
  );
  assert.match(main, /start\(\) \{[\s\S]*this\.navigate\(this\.address\.value, false\)/);
  assert.match(
    core,
    /isLoopbackBrowserUrl[\s\S]*hostname === "localhost"[\s\S]*Number\(octets\[0\]\) === 127/,
  );
  assert.match(
    main,
    /replaceWebview\(url: string\)[\s\S]*isLoopbackBrowserUrl\(url\)[\s\S]*invoke<boolean>\("probe_loopback_browser_endpoint", \{ url \}\)[\s\S]*scheduleLocalBrowserRetry\(request\)/,
  );
  assert.match(
    main,
    /setLayoutVisible\(visible: boolean\)[\s\S]*clearLocalRetryTimer\(\)[\s\S]*scheduleLocalBrowserRetry\(this\.localRetryRequest, 0\)/,
  );
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
    /listen<BrowserWebviewUrlChanged>\(\s*"browser-webview-url-changed"[\s\S]*pane\.observeWebviewUrl\(payload\.label, payload\.url\)/,
  );
  assert.match(
    main,
    /await this\.syncBounds\(generation, webview\);[\s\S]*await this\.workspace\.watchBrowserWebviewUrl\(webview\.label, url\)/,
  );
  assert.match(
    main,
    /browserUrlListenerReady = this\.installBrowserUrlSync\(\)[\s\S]*async watchBrowserWebviewUrl\(label: string, targetUrl: string\): Promise<boolean>[\s\S]*await invoke\("watch_browser_webview_url", \{ label, targetUrl \}\)[\s\S]*return listenerReady/,
  );
  assert.match(
    main,
    /Promise\.race\(\[[\s\S]*this\.browserUrlListenerReady[\s\S]*delay\(BROWSER_LISTENER_READY_TIMEOUT_MS\)\.then\(\(\) => false\)[\s\S]*await invoke\("watch_browser_webview_url"/,
  );
  assert.match(
    main,
    /observeWebviewUrl\(label: string, rawUrl: string\)[\s\S]*applyObservedUrl[\s\S]*this\.operationQueue = this\.operationQueue[\s\S]*persistObservedUrl/,
  );
  assert.match(
    main,
    /private persistedUrl: string;[\s\S]*private addressDirty = false;[\s\S]*private navigationRevision = 0/,
  );
  assert.match(
    main,
    /this\.address\.addEventListener\("input"[\s\S]*this\.addressDirty = true;[\s\S]*navigation\.addEventListener\("focusout"[\s\S]*navigation\.contains\(document\.activeElement\)[\s\S]*this\.address\.value = this\.pendingNavigation\?\.url \?\? this\.currentUrl/,
  );
  assert.match(
    main,
    /private applyObservedUrl[\s\S]*normalizeBrowserUrl\(rawUrl\)[\s\S]*this\.currentUrl = url;[\s\S]*private async persistObservedUrl[\s\S]*this\.currentUrl !== url[\s\S]*updateBrowserPaneUrl/,
  );
  assert.match(
    main,
    /const update = this\.browserUrlUpdateTail\.then[\s\S]*onBrowserPaneUrlChangedCallback[\s\S]*this\.browserUrlUpdateTail = update\.then/,
  );
  assert.match(
    main,
    /setCatalogWritable\(writable: boolean\)[\s\S]*currentUrl !== this\.persistedUrl[\s\S]*observeWebviewUrl/,
  );
  assert.match(
    main,
    /private pendingNavigation:[\s\S]*queued: boolean[\s\S]*queuePendingNavigation\(\)[\s\S]*!this\.catalogWritable[\s\S]*request\.queued = false/,
  );
  assert.match(
    main,
    /const urlEventsReady = await this\.workspace\.watchBrowserWebviewUrl\(webview\.label, url\)[\s\S]*!urlEventsReady[\s\S]*urlSyncFallbackEnabled = true[\s\S]*scheduleUrlSyncFallback/,
  );
  assert.match(
    main,
    /scheduleUrlSyncFallback[\s\S]*BROWSER_URL_FALLBACK_SYNC_INTERVAL_MS[\s\S]*captureCurrentUrl/,
  );
  assert.match(
    main,
    /await workspace\.captureBrowserPaneUrls\(\);[\s\S]*controller\?\.beginShutdown\(\);[\s\S]*flushSaves/,
  );
  assert.match(
    backend,
    /fn read_browser_webview_url[\s\S]*is_browser_pane_webview_label[\s\S]*app\.get_webview\(&label\)[\s\S]*webview[\s\S]*\.url\(\)/,
  );
  assert.match(
    backend,
    /const BROWSER_WEBVIEW_URL_CHANGED_EVENT: &str = "browser-webview-url-changed"/,
  );
  assert.match(
    backend,
    /fn watch_browser_webview_url[\s\S]*install_windows_browser_url_watcher/,
  );
  assert.match(
    backend,
    /async fn probe_loopback_browser_endpoint[\s\S]*ensure_agent_main_webview[\s\S]*spawn_blocking[\s\S]*probe_loopback_browser_addresses/,
  );
  assert.match(backend, /probe_loopback_browser_endpoint,/);
});

test("pane title editing opens immediately and survives transient catalog writes", async () => {
  const main = await source("src/main.ts");
  const terminalStart = main.indexOf("class TerminalPane {");
  const browserStart = main.indexOf("class BrowserPane {");
  const layoutPaneStart = main.indexOf(
    "type LayoutPane = TerminalPane | BrowserPane | SourceEditorPane;",
  );
  assert.ok(terminalStart >= 0 && browserStart > terminalStart);
  assert.ok(layoutPaneStart > browserStart);

  const paneClasses = [
    ["terminal", main.slice(terminalStart, browserStart)],
    ["browser", main.slice(browserStart, layoutPaneStart)],
  ];
  for (const [kind, pane] of paneClasses) {
    assert.match(
      pane,
      /private titleEditCommitRequested = false;/,
      `${kind} panes must remember a deferred commit`,
    );
    const beginStart = pane.indexOf("  private beginTitleEdit()");
    const beginEnd = pane.indexOf("\n  }", beginStart);
    assert.ok(beginStart >= 0 && beginEnd > beginStart);
    const beginMethod = pane.slice(beginStart, beginEnd + 4);
    assert.doesNotMatch(
      beginMethod,
      /catalogWritable/,
      `${kind} panes must open the editor immediately even during a catalog write`,
    );
    assert.match(beginMethod, /titleEditor\.hidden = false;[\s\S]*?titleEditor\.focus\(\)/);
    assert.match(
      pane,
      /private commitTitleEdit\(\)[\s\S]*?if \(!this\.catalogWritable\) \{[\s\S]*?this\.titleEditCommitRequested = true;[\s\S]*?return;/,
      `${kind} panes must preserve typed text until the catalog becomes writable`,
    );
    assert.match(
      pane,
      /private resumeDeferredTitleEdit\(\)[\s\S]*?!this\.titleEditCommitRequested[\s\S]*?queueMicrotask\([\s\S]*?if \(this\.titleEditCommitRequested\) this\.commitTitleEdit\(\)/,
      `${kind} panes must resume a deferred commit after the catalog write`,
    );

    const writableStart = pane.indexOf("  setCatalogWritable(writable: boolean)");
    const writableEnd = pane.indexOf("\n  }", writableStart);
    assert.ok(writableStart >= 0 && writableEnd > writableStart);
    const writableMethod = pane.slice(writableStart, writableEnd + 4);
    assert.match(
      writableMethod,
      /this\.catalogWritable = writable;[\s\S]*?this\.resumeDeferredTitleEdit\(\)/,
      `${kind} panes must resume deferred title work after a save`,
    );
    assert.doesNotMatch(
      writableMethod,
      /cancelTitleEdit|titleEditor\.disabled/,
      `${kind} panes must not close or freeze an active editor during a transient save`,
    );
  }
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

test("pane restore has no fixed count gate while user mutations remain writable-gated", async () => {
  const [main, controller] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
  ]);

  assert.doesNotMatch(main, /MAX_PROJECT_PANES/);
  assert.doesNotMatch(controller, /MAX_PROJECT_PANES/);

  const addPane = main.slice(main.indexOf("  addPane("), main.indexOf("  addBrowserPane("));
  const addBrowserPane = main.slice(
    main.indexOf("  addBrowserPane("),
    main.indexOf("  restoreCapacity("),
  );
  const canAddPane = main.slice(main.indexOf("  canAddPane("), main.indexOf("  startPriority("));
  const updateControls = main.slice(
    main.indexOf("  private updateControls("),
    main.indexOf("  private applyRowRatios("),
  );

  assert.match(addPane, /if \(this\.disposed\) return null/);
  assert.doesNotMatch(addPane, /projectPaneCount|MAX_PROJECT_PANES/);
  assert.match(
    addBrowserPane,
    /if \(this\.disposed \|\| projectId !== this\.activeProjectId\)/,
  );
  assert.doesNotMatch(addBrowserPane, /if\s*\([^)]*!this\.catalogWritable/);
  assert.doesNotMatch(addBrowserPane, /projectPaneCount|MAX_PROJECT_PANES/);
  assert.match(
    main,
    /restoreCapacity\([\s\S]*?this\.projectPaneCount\(project\.id\)[\s\S]*?evaluateWorkspaceRestoreCapacity\(current, incoming\)/,
  );
  assert.match(
    canAddPane,
    /!this\.disposed[\s\S]*this\.catalogWritable[\s\S]*projectId === this\.activeProjectId/,
  );
  assert.match(
    updateControls,
    /this\.addButton\.disabled =[\s\S]*!this\.catalogWritable[\s\S]*this\.activeProjectId === null/,
  );
  assert.doesNotMatch(updateControls, /visible\.length|projectPaneCount|MAX_PROJECT_PANES/);
  assert.match(
    controller,
    /async addTerminal\([\s\S]*!state \|\| !this\.canMutate\(\)[\s\S]*runtime\.canAddPane\(project\.id\)/,
  );
  assert.match(
    controller,
    /async addBrowserPane\([\s\S]*!state \|\| !this\.canMutate\(\)[\s\S]*runtime\.canAddPane\(project\.id\)/,
  );

  for (const runtimeSource of [main, controller]) {
    assert.doesNotMatch(runtimeSource, /this\.panes\.size\s*>=/);
    assert.doesNotMatch(runtimeSource, /globalRunning/);
    assert.doesNotMatch(runtimeSource, /다른 프로젝트 탭을 닫고/);
  }
});

test("manual tabs, compact project creation, and the mixed pane launcher are wired", async () => {
  const [html, main, controller, styles, cargo, capability, build] = await Promise.all([
    source("index.html"),
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src/styles.css"),
    source("src-tauri/Cargo.toml"),
    source("src-tauri/capabilities/default.json"),
    source("scripts/build.mjs"),
  ]);

  assert.doesNotMatch(html, /id="project-count"/);
  assert.match(
    html,
    /id="project-sidebar"[\s\S]*class="sidebar-brand"[\s\S]*aria-label="IHATECODING"[\s\S]*src="\/assets\/app-icon\.png"[\s\S]*id="toggle-project-sidebar"[\s\S]*aria-controls="project-sidebar"[\s\S]*class="project-section-heading"[\s\S]*id="project-list"/,
  );
  assert.match(
    html,
    /id="create-project"[\s\S]*aria-haspopup="menu"[\s\S]*aria-controls="project-create-menu"[\s\S]*aria-expanded="false"[\s\S]*id="project-create-menu"[\s\S]*role="menu"[\s\S]*id="use-existing-project-folder"[\s\S]*data-i18n-ko="기존 폴더 사용"[\s\S]*id="start-project-from-scratch"[\s\S]*data-i18n-ko="처음부터 시작"/,
  );
  assert.match(
    build,
    /src-tauri\/icons\/32x32\.png[\s\S]*dist\/assets\/app-icon\.png/,
  );
  assert.match(
    html,
    /id="pane-launcher-menu"[\s\S]*id="add-powershell-pane"[\s\S]*id="add-codex-pane"[\s\S]*id="add-grok-pane"[\s\S]*id="add-claude-code-pane"[\s\S]*id="add-opencode-pane"[\s\S]*id="add-browser-pane"/,
  );
  const launcherStart = html.indexOf('id="pane-launcher-menu"');
  const launcherEnd = html.indexOf("</div>", launcherStart);
  assert.ok(launcherStart >= 0 && launcherEnd > launcherStart);
  const launcher = html.slice(launcherStart, launcherEnd);
  assert.doesNotMatch(
    launcher,
    /<small|AI coding CLI|AI 코딩 CLI|New terminal|새 터미널|Split pane|분할 화면/,
  );
  for (const icon of ["powershell", "codex", "grok", "claude-code", "opencode", "browser"]) {
    assert.match(
      html,
      new RegExp(`class="pane-launcher-icon"[\\s\\S]*?src="/assets/provider-icons/${icon}\\.svg"`),
    );
  }
  assert.match(controller, /onPaneOrderChanged\([\s\S]*setProjectPaneOrder/);
  assert.match(main, /type LayoutPane = TerminalPane \| BrowserPane/);
  assert.match(styles, /\.create-project\s*\{[\s\S]*width:\s*27px;[\s\S]*height:\s*27px/);
  assert.match(styles, /\.project-list-toggle\[aria-expanded="false"\] \.project-list-chevron/);
  assert.match(
    html,
    /id="toggle-project-list"[\s\S]*?<span class="project-list-label" data-i18n-en="Projects"[\s\S]*?<span class="project-list-chevron"[\s\S]*?<svg viewBox="0 0 8 8"/,
  );
  assert.match(
    styles,
    /\.project-list-toggle:hover:not\(:disabled\),[\s\S]*?\.project-list-toggle:focus-visible\s*\{[\s\S]*?border-color:\s*transparent;[\s\S]*?background:\s*transparent;[\s\S]*?outline:\s*none;[\s\S]*?box-shadow:\s*none;/,
  );
  assert.match(
    styles,
    /\.project-list-label\s*\{[\s\S]*?height:\s*12px;[\s\S]*?align-items:\s*center;[\s\S]*?\.project-list-chevron\s*\{[\s\S]*?display:\s*inline-grid;[\s\S]*?width:\s*9px;[\s\S]*?height:\s*9px;[\s\S]*?place-items:\s*center;/,
  );
  assert.match(
    styles,
    /\.project-list-chevron\s*\{[\s\S]*opacity:\s*0;[\s\S]*visibility:\s*hidden;[\s\S]*\.project-list-toggle:hover \.project-list-chevron,[\s\S]*\.project-list-toggle:focus-visible \.project-list-chevron\s*\{[\s\S]*opacity:\s*1;[\s\S]*visibility:\s*visible;/,
  );
  assert.match(
    controller,
    /for \(const project of sortWorkspaceProjectsByRecentModification\(state\.projects\)\)/,
  );
  assert.doesNotMatch(controller, /for \(const project of state\.projects\)/);
  assert.match(
    styles,
    /\.project-sidebar\s*\{[\s\S]*grid-template:[\s\S]*"brand"[\s\S]*"projects" minmax\(0, 1fr\)[\s\S]*"footer" auto \/ minmax\(0, 1fr\);[\s\S]*height:\s*100%;[\s\S]*overflow:\s*hidden;/,
  );
  assert.match(styles, /\.sidebar-brand\s*\{[\s\S]*grid-area:\s*brand;/);
  assert.match(styles, /\.sidebar-brand-identity\s*\{[\s\S]*align-items:\s*center;/);
  assert.match(styles, /\.sidebar-collapse-toggle\s*\{/);
  assert.match(
    styles,
    /\.shell\[data-sidebar-collapsed="true"\][\s\S]*grid-template-columns:[\s\S]*\.sidebar-brand-identity[\s\S]*display:\s*none;/,
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
  assert.match(
    controller,
    /createProjectButton\.addEventListener\([\s\S]*setProjectCreateMenuOpen\(elements\.projectCreateMenu\.hidden\)/,
  );
  assert.match(
    controller,
    /useExistingProjectFolderButton\.addEventListener\([\s\S]*openExistingFolderProject\(\)[\s\S]*startProjectFromScratchButton\.addEventListener\([\s\S]*openProjectDialog\(null, "scratch"\)/,
  );
  assert.match(
    controller,
    /private setProjectCreateMenuOpen\(open: boolean[\s\S]*projectCreateMenu\.hidden = !allowed[\s\S]*createProjectButton\.setAttribute\("aria-expanded", String\(allowed\)\)/,
  );
  assert.match(
    controller,
    /private async openExistingFolderProject\(\)[\s\S]*pickProjectFolder\(defaultPath, false\)[\s\S]*findWorkspaceProjectByFolder[\s\S]*openProjectDialog\(selected, "existing"\)/,
  );
  assert.match(
    styles,
    /\.project-create-menu-root\s*\{[\s\S]*position:\s*relative;[\s\S]*\.project-create-menu\s*\{[\s\S]*position:\s*absolute;/,
  );
  assert.doesNotMatch(controller, /button\.title\s*=\s*project\.folderPath/);
  assert.doesNotMatch(controller, /folder\.textContent\s*=\s*project\.folderPath/);
  const sidebar = controller.slice(
    controller.indexOf("private renderSidebar()"),
    controller.indexOf("private onTabKeyDown", controller.indexOf("private renderSidebar()")),
  );
  assert.match(sidebar, /openButton\.append\(name\)/);
  assert.doesNotMatch(sidebar, /folderPath|createElement\("small"\)/);
  assert.match(
    sidebar,
    /createElement\("div"\)[\s\S]*className = "project-item"[\s\S]*className = "project-item-open"/,
  );
  assert.match(
    sidebar,
    /className = "project-item-menu-root"[\s\S]*createProjectMenuToggle\(menuLabel, menuId\)[\s\S]*className = "project-item-menu"[\s\S]*setAttribute\("role", "menu"\)[\s\S]*createProjectMenuItem\([\s\S]*"edit"[\s\S]*createProjectMenuItem\([\s\S]*"delete"/,
  );
  assert.match(sidebar, /menuToggle\.textContent = "…"|createProjectMenuToggle/);
  assert.match(
    sidebar,
    /menuToggle\.addEventListener\("click"[\s\S]*closeProjectItemMenus\(\)[\s\S]*dataset\.menuOpen = "true"[\s\S]*menu\.hidden = false[\s\S]*setAttribute\("aria-expanded", "true"\)/,
  );
  assert.match(
    sidebar,
    /editButton\.addEventListener\("click"[\s\S]*closeProjectItemMenus\(\)[\s\S]*openProjectRenameDialog\(project\.id, menuToggle\)[\s\S]*deleteButton\.addEventListener\("click"[\s\S]*openProjectDeleteDialog\(project\.id, menuToggle\)/,
  );
  assert.doesNotMatch(sidebar, /project-name-editor|finishEditing|data\.editing|\beditor\b/);
  assert.match(sidebar, /item\.append\(openButton, menuRoot\)/);
  assert.match(
    styles,
    /\.project-item\[data-enabled="true"\]:hover \.project-item-menu-root,[\s\S]*\.project-item\[data-enabled="true"\]:focus-within \.project-item-menu-root[\s\S]*opacity:\s*1;[\s\S]*visibility:\s*visible;/,
  );
  assert.doesNotMatch(styles, /\.project-item\[data-editing="true"\]/);
  assert.match(styles, /\.project-item-menu\s*\{[\s\S]*position:\s*absolute;/);
  assert.match(styles, /\.project-item-menu-entry\s*\{/);
  assert.match(
    html,
    /id="project-rename-dialog"[\s\S]*aria-labelledby="project-rename-title"[\s\S]*id="project-rename-form"[\s\S]*id="project-rename-name"[\s\S]*maxlength="50"[\s\S]*id="project-rename-error"[\s\S]*id="cancel-project-rename"[\s\S]*id="confirm-project-rename"/,
  );
  assert.match(
    main,
    /requireDialog\("project-rename-dialog"\)[\s\S]*requireForm\("project-rename-form"\)[\s\S]*requireInput\("project-rename-name"\)[\s\S]*requireElement\("project-rename-error"\)[\s\S]*requireButton\("cancel-project-rename"\)[\s\S]*requireButton\("confirm-project-rename"\)/,
  );
  const renameDialog = controller.slice(
    controller.indexOf("private openProjectRenameDialog"),
    controller.indexOf("private async deleteProject"),
  );
  assert.match(
    renameDialog,
    /pendingProjectRenameId = projectId[\s\S]*pendingProjectRenameTrigger = trigger[\s\S]*projectRenameName\.value = project\.name[\s\S]*setModalOverlayOpen\("project-rename", true\)[\s\S]*projectRenameDialog\.showModal\(\)[\s\S]*projectRenameName\.select\(\)/,
  );
  const submitRename = renameDialog.slice(
    renameDialog.indexOf("private async submitProjectRename"),
    renameDialog.indexOf("private async renameProject"),
  );
  assert.match(
    submitRename,
    /validateWorkspaceProjectName[\s\S]*this\.renameProject[\s\S]*projectRenameDialog\.close\(\)[\s\S]*projectRenameError\.textContent = errorMessage\(error\)/,
  );
  const renameProject = renameDialog.slice(renameDialog.indexOf("private async renameProject"));
  assert.match(renameProject, /renameWorkspaceProject[\s\S]*this\.persist[\s\S]*runtime\.syncProject/);
  assert.match(
    controller,
    /projectRenameForm\.addEventListener\([\s\S]*"submit"[\s\S]*event\.preventDefault\(\)[\s\S]*submitProjectRename\(\)/,
  );
  assert.match(
    controller,
    /projectRenameDialog\.addEventListener\([\s\S]*"close"[\s\S]*pendingProjectRenameId = null[\s\S]*pendingProjectRenameTrigger = null[\s\S]*setModalOverlayOpen\("project-rename", false\)[\s\S]*trigger\?\.isConnected[\s\S]*trigger\.focus\(\)/,
  );
  const deleteProject = controller.slice(
    controller.indexOf("private async deleteProject"),
    controller.indexOf("private openProjectDeleteDialog"),
  );
  assert.match(
    deleteProject,
    /removeWorkspaceProject[\s\S]*this\.persist[\s\S]*runtime\.unloadProject[\s\S]*clearProject/,
  );
  assert.doesNotMatch(deleteProject, /window\.confirm/);
  const deleteDialog = controller.slice(
    controller.indexOf("private openProjectDeleteDialog"),
    controller.indexOf("private async openProject"),
  );
  assert.match(
    deleteDialog,
    /projectDeleteMessage\.textContent = tr[\s\S]*setModalOverlayOpen\("project-delete", true\)[\s\S]*projectDeleteDialog\.showModal\(\)[\s\S]*cancelProjectDeleteButton\.focus\(\)/,
  );
  assert.match(
    controller,
    /confirmProjectDeleteButton\.addEventListener\([\s\S]*pendingProjectDeleteId[\s\S]*projectDeleteDialog\.close\(\)[\s\S]*this\.deleteProject\(projectId\)/,
  );
  assert.match(
    controller,
    /projectDeleteDialog\.addEventListener\([\s\S]*pendingProjectDeleteTrigger[\s\S]*setModalOverlayOpen\("project-delete", false\)[\s\S]*trigger\?\.isConnected[\s\S]*trigger\.focus\(\)/,
  );
  assert.match(
    html,
    /id="project-delete-dialog"[\s\S]*aria-labelledby="project-delete-title"[\s\S]*id="project-delete-message"[\s\S]*id="project-delete-safety"[\s\S]*id="cancel-project-delete"[\s\S]*id="confirm-project-delete"/,
  );
  assert.match(
    main,
    /requireDialog\("project-delete-dialog"\)[\s\S]*requireElement\("project-delete-message"\)[\s\S]*requireButton\("cancel-project-delete"\)[\s\S]*requireButton\("confirm-project-delete"\)/,
  );
  assert.match(
    main,
    /PROJECT_SIDEBAR_COLLAPSED_KEY[\s\S]*localStorage\.getItem\(PROJECT_SIDEBAR_COLLAPSED_KEY\)[\s\S]*function renderProjectSidebarState\(\)[\s\S]*app\.dataset\.sidebarCollapsed[\s\S]*aria-expanded[\s\S]*localStorage\.setItem\(PROJECT_SIDEBAR_COLLAPSED_KEY/,
  );
  assert.match(
    main,
    /subscribeAppLanguage\([\s\S]*controller\?\.refreshLocalizedUi\(\)[\s\S]*renderProjectSidebarState\(\)/,
  );
  assert.match(
    controller,
    /element\.setAttribute\("aria-grabbed", "false"\)[\s\S]*element\.draggable = false[\s\S]*element\.dataset\.reorderable = String\(enabled\)[\s\S]*addEventListener\("pointerdown", \(event\) => this\.onTabPointerDown/,
  );
  assert.match(
    controller,
    /tabList\.addEventListener\("pointermove"[\s\S]*tabList\.addEventListener\("pointerup"[\s\S]*tabList\.addEventListener\("pointercancel"[\s\S]*"lostpointercapture"/,
  );
  assert.match(
    controller,
    /close\.draggable = false[\s\S]*close\.addEventListener\("pointerdown", \(event\) => \{[\s\S]*event\.stopPropagation\(\)/,
  );
  assert.match(
    controller,
    /refreshLocalizedUi\(\): void[\s\S]*this\.renderTabs\(\)[\s\S]*this\.renderSidebar\(\)[\s\S]*this\.setProjectListExpanded/,
  );
  assert.match(
    controller,
    /private onTabPointerDown\(event: PointerEvent, tabId: string\)[\s\S]*element\.setPointerCapture\(event\.pointerId\)[\s\S]*private onTabPointerMove\(event: PointerEvent\)[\s\S]*crossedPointerReorderThreshold\([\s\S]*horizontalReorderTarget\([\s\S]*private async onTabPointerUp\(event: PointerEvent\)[\s\S]*moveWorkspaceTabBefore\(state, draggedTabId, beforeTabId\)[\s\S]*await this\.persist\([\s\S]*this\.renderAndActivate\(\)/,
  );
  assert.match(
    controller,
    /private onTabPointerCancel\(event: PointerEvent\)[\s\S]*private onTabPointerCaptureLost\(event: PointerEvent\)[\s\S]*releasePointerCapture\(pointer\.pointerId\)/,
  );
  assert.match(
    styles,
    /\.workspace-tab\[data-reorderable="true"\]\s*\{[\s\S]*cursor:\s*grab;[\s\S]*touch-action:\s*none;/,
  );
  assert.match(
    styles,
    /\.workspace-tab\[data-dragging="true"\]\s*\{[\s\S]*transform:\s*translateX\(var\(--reorder-offset-x, 0\)\)/,
  );
  assert.match(styles, /\.workspace-tab\[data-drop-position="before"\]\s*\{/);
  assert.match(styles, /\.workspace-tab\[data-drop-position="after"\]\s*\{/);
  assert.match(main, /class PaneLauncherController/);
  assert.match(main, /controller\?\.addTerminal\("codex"\)/);
  assert.match(main, /controller\?\.addTerminal\("grok"\)/);
  assert.match(main, /controller\?\.addTerminal\("claude"\)/);
  assert.match(main, /controller\?\.addTerminal\("opencode"\)/);
  assert.match(
    controller,
    /async addTerminal\([\s\S]*launchProfile[\s\S]*createWorkspaceTerminal\([\s\S]*nextWorkspacePaneName\(project, launchProfile\)[\s\S]*launchProfile/,
  );
  assert.match(main, /class BrowserPane[\s\S]*new Webview\(getCurrentWindow\(\), label/);
  assert.match(
    cargo,
    /tauri\s*=\s*\{\s*version\s*=\s*"~?2(?:\.\d+){0,2}"\s*,\s*features\s*=\s*\[[^\]]*"unstable"[^\]]*\]\s*\}/,
    "embedded child WebViews require Tauri's multiwebview feature",
  );
  assert.match(capability, /"core:webview:allow-create-webview"/);
  assert.match(main, /setBrowserSuspensionReason\("layout-interaction", true\)/);
  assert.match(main, /localAddress[\s\S]*\? "http" : "https"/);
  assert.match(main, /parsed\.username \|\| parsed\.password/);
  assert.match(
    controller,
    /migrateLegacyAutomaticProjectTabsToManual\(current\)[\s\S]*persistNow\([\s\S]*migrated/,
  );
});

test("settings expose localized General, Optimization, Agents, and Notifications tabs", async () => {
  const [html, styles, main, agentCliStatus] = await Promise.all([
    source("index.html"),
    source("src/styles.css"),
    source("src/main.ts"),
    source("src-tauri/src/agent_cli_status.rs"),
  ]);

  assert.match(html, /<html lang="en">/);
  assert.match(
    html,
    /class="settings-tabs"[\s\S]*role="tablist"[\s\S]*id="settings-general-tab"[\s\S]*aria-controls="settings-general-panel"[\s\S]*aria-selected="true"[\s\S]*id="settings-optimization-tab"[\s\S]*aria-controls="settings-optimization-panel"[\s\S]*aria-selected="false"[\s\S]*id="settings-agents-tab"[\s\S]*aria-controls="settings-agents-panel"[\s\S]*aria-selected="false"[\s\S]*id="settings-notifications-tab"[\s\S]*aria-controls="settings-notifications-panel"[\s\S]*aria-selected="false"/,
  );
  assert.match(
    html,
    /id="settings-general-panel"[\s\S]*role="tabpanel"[\s\S]*aria-labelledby="settings-general-tab"[\s\S]*id="app-language"[\s\S]*<option value="en">English<\/option>[\s\S]*<option value="ko">한국어<\/option>/,
  );
  assert.match(
    html,
    /id="settings-optimization-panel"[\s\S]*role="tabpanel"[\s\S]*aria-labelledby="settings-optimization-tab"[\s\S]*hidden[\s\S]*id="auto-sleep-idle-agents"/,
  );
  assert.match(
    html,
    /id="auto-sleep-idle-agents"[\s\S]*role="switch"[\s\S]*class="settings-switch-track"[\s\S]*class="settings-switch-thumb"/,
  );
  assert.match(
    html,
    /id="settings-agents-panel"[\s\S]*aria-labelledby="settings-agents-tab"[\s\S]*aria-busy="false"[\s\S]*id="refresh-agent-connections"[\s\S]*data-agent-provider="codex"[\s\S]*data-agent-provider="grok"[\s\S]*data-agent-provider="claudeCode"[\s\S]*data-agent-provider="openCode"[\s\S]*data-agent-provider="cursor"/,
  );
  for (const icon of ["codex", "grok", "claude-code", "opencode", "cursor"]) {
    assert.match(html, new RegExp(`src="/assets/provider-icons/${icon}\\.svg"`));
  }
  assert.match(html, /data-agent-provider="cursor"[\s\S]*data-agent-status-only="true"/);
  assert.match(agentCliStatus, /discover_cli\("agent", path\)/);
  assert.match(agentCliStatus, /discover_cli\("cursor-agent", path\)/);
  assert.doesNotMatch(agentCliStatus, /discover_cli\("cursor", path\)/);
  assert.match(agentCliStatus, /\.arg\("status"\)/);
  assert.match(
    html,
    /id="settings-notifications-panel"[\s\S]*role="tabpanel"[\s\S]*aria-labelledby="settings-notifications-tab"[\s\S]*hidden[\s\S]*id="discord-notification-settings-title"[\s\S]*id="phone-notification-webhook"/,
  );
  for (const id of [
    "phone-notification-enabled",
    "phone-notification-success",
    "phone-notification-error",
  ]) {
    const start = html.indexOf(`id="${id}"`);
    assert.ok(start >= 0, `${id} must exist`);
    const toggle = html.slice(start, start + 320);
    assert.match(toggle, /role="switch"/);
    assert.match(toggle, /class="settings-switch-track"/);
    assert.match(toggle, /class="settings-switch-thumb"/);
  }
  assert.match(html, /data-i18n-en="Settings" data-i18n-ko="환경설정"/);
  assert.match(
    html,
    /data-i18n-placeholder-en="Enter a new webhook URL"[\s\S]*data-i18n-placeholder-ko="새 웹훅 URL을 입력하세요"/,
  );
  assert.match(
    styles,
    /\.settings-layout\s*\{[\s\S]*grid-template-columns:\s*132px minmax\(0, 1fr\)/,
  );
  assert.match(styles, /\.settings-panel\[hidden\]\s*\{[\s\S]*display:\s*none/);
  assert.match(
    styles,
    /\.agent-connection-row\s*\{[\s\S]*grid-template-columns:[\s\S]*\.agent-connections-status\[data-tone="error"\]/,
  );
  assert.match(
    styles,
    /\.settings-switch-track\s*\{[\s\S]*border-radius:\s*999px[\s\S]*\.settings-switch > input:checked \+ \.settings-switch-track[\s\S]*\.settings-switch-thumb[\s\S]*transform:\s*translateX\(14px\)/,
  );
  assert.match(
    styles,
    /@media \(max-width:\s*620px\)[\s\S]*\.settings-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/,
  );
  assert.match(main, /invoke<unknown>\("read_agent_cli_statuses"\)/);
  assert.match(
    main,
    /const generation = \+\+this\.requestGeneration;[\s\S]*generation !== this\.requestGeneration/,
  );
  assert.match(
    main,
    /typeof candidate\.installed !== "boolean"[\s\S]*!isAgentAuthenticationState\(candidate\.status\)[\s\S]*statuses\.has\(candidate\.provider\)/,
  );
  assert.match(main, /this\.panel\.setAttribute\("aria-busy", String\(this\.refreshing\)\)/);
  assert.match(
    main,
    /await this\.openAgent\(launchProfile\);[\s\S]*this\.dialog\.close\(\)/,
  );
  assert.match(main, /controller\.addTerminal\(launchProfile\)/);
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
