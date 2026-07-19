import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relative) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("workspace terminals use typed resume plans instead of injected commands", async () => {
  const [main, controller] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
  ]);
  assert.match(controller, /setResumePlans\(deriveSafeResumePlans\(state\)\)/);
  assert.match(main, /terminalKey:\s*\{\s*projectId: this\.projectId,\s*terminalId: this\.terminalId/);
  assert.match(main, /resume:\s*this\.resumePlan\.action === "resume"/);
  assert.doesNotMatch(main, /write_terminal[\s\S]{0,300}codex resume/);
  assert.doesNotMatch(main, /write_terminal[\s\S]{0,300}grok --resume/);
});

test("completion decoration follows durable persistence and explicit acknowledgement", async () => {
  const [main, controller] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
  ]);
  assert.match(
    controller,
    /const saved = await this\.persistNow\([\s\S]*if \(!saved\) return false;[\s\S]*setTerminalCompletionPending/,
  );
  assert.match(main, /COMPLETION_OUTPUT_QUIET_MS = 1_000/);
  assert.match(main, /this\.workspace\.acknowledgePaneCompletion\(this\.id\)/);
  assert.match(main, /dataset\.completionPending = String\(completionPending\)/);
  assert.match(
    main,
    /const wasCompletionPending = this\.completionPending;[\s\S]*if \(wasCompletionPending && !completionPending\)/,
  );
  const inputHandlers = main.slice(
    main.indexOf("private installTerminalInputHandlers()"),
    main.indexOf("private handleTerminalEvent"),
  );
  assert.doesNotMatch(inputHandlers, /acknowledgePaneCompletion/);
  assert.doesNotMatch(main, /prompt[^\n]*(complete|idle)|OutputQuiet[^\n]*QueueCompletion/i);
});

test("terminal IME handling uses committed input without composition interception", async () => {
  const main = await source("src/main.ts");
  const handlerStart = main.indexOf("private installTerminalInputHandlers()");
  const handlerEnd = main.indexOf("private handleTerminalEvent", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handlers = main.slice(handlerStart, handlerEnd);

  assert.match(
    handlers,
    /terminal\.onData\(\(data\) => \{[\s\S]*?this\.noteEditableUserInput\(data\);\s*this\.resumeAutoFollowForUserIntent\(\);[\s\S]*?this\.queueInput\(\{ kind: "text", data \}\)/,
  );
  assert.match(
    handlers,
    /terminal\.onBinary\(\(data\) => \{[\s\S]*?this\.resumeAutoFollowForUserIntent\(\);[\s\S]*?this\.queueInput\(\{ kind: "binary", data: bytes \}\)/,
  );
  assert.doesNotMatch(handlers, /["']beforeinput["']/);
  assert.doesNotMatch(
    handlers,
    /["']composition(?:start|update|end)["']/,
  );
  assert.match(main, /cursorBlink:\s*false/);
  assert.match(main, /cursorStyle:\s*"bar"/);
  assert.match(main, /cursorInactiveStyle:\s*"bar"/);
  assert.doesNotMatch(main, /blinkIntervalDuration:\s*0/);
  assert.doesNotMatch(main, /cursorInactiveStyle:\s*"none"/);
  assert.match(
    main,
    /registerCsiHandler\(\s*\{ intermediates: " ", final: "q" \},\s*\(\) => true/,
  );
  assert.doesNotMatch(main, /this\.terminal\.options\.cursorStyle\s*=/);
  assert.doesNotMatch(main, /this\.terminal\.options\.cursorBlink\s*=/);
  assert.match(
    main,
    /private resumeAutoFollowForUserIntent\(\)[\s\S]*?if \(!this\.isAtBottom\(\)\) this\.terminal\.scrollToBottom\(\)/,
  );
  assert.match(
    main,
    /const inputReady = clipboardRead\.then[\s\S]*window\.setTimeout\(\(\) => \{[\s\S]*const commit = this\.reserveInputSlot\(\)/,
  );
  assert.match(main, /\(event\.ctrlKey \|\| event\.metaKey\) && key === "v"\) return false/);
});

test("terminal clicks use guarded mode-aware cursor movement", async () => {
  const [main, styles] = await Promise.all([
    source("src/main.ts"),
    source("src/styles.css"),
  ]);
  const mouseUpStart = main.indexOf("private readonly onWindowMouseUp");
  const mouseUpEnd = main.indexOf("private readonly onWindowBlur", mouseUpStart);
  assert.ok(mouseUpStart >= 0 && mouseUpEnd > mouseUpStart);
  const mouseUp = main.slice(mouseUpStart, mouseUpEnd);

  assert.match(mouseUp, /event\.button !== 0 \|\| !this\.selectionGestureActive/);
  assert.match(mouseUp, /this\.selectionGestureActive = false/);
  assert.match(mouseUp, /this\.invalidatePendingFollow\(\)/);
  assert.match(mouseUp, /this\.isAtBottom\(\)/);
  assert.doesNotMatch(main, /new MouseEvent|altKey:\s*true/);
  assert.doesNotMatch(main, /replayingCursorMoveMouseUp|selectionGestureOrigin/);
  assert.match(main, /altClickMovesCursor:\s*false/);
  assert.match(
    main,
    /vtExtensions:\s*\{\s*kittyKeyboard:\s*true,\s*win32InputMode:\s*true/,
  );
  assert.match(main, /overviewRulerBorder:\s*"#050505"/);
  assert.match(
    main,
    /this\.viewport\.addEventListener\("mousedown", \(event\) => \{[\s\S]*?event\.button === 0[\s\S]*?captureCursorClick\(event\)[\s\S]*?selectionGestureActive = true/,
  );
  assert.match(main, /!event\.isTrusted[\s\S]*?this\.terminal\.modes\.mouseTrackingMode !== "none"/);
  assert.match(main, /pointerDrift > CURSOR_CLICK_MAX_POINTER_DRIFT_PX/);
  assert.match(main, /this\.terminalRenderVersion !== snapshot\.renderVersion/);
  assert.match(main, /textarea\.dispatchEvent\(createTerminalArrowEvent\("keydown", direction\)\)/);
  assert.match(main, /const encodedMovement = captured\.join\(""\)/);
  assert.match(main, /this\.queueInput\(\{ kind: "text", data: encodedMovement \}\)/);
  assert.match(main, /window\.addEventListener\("mouseup", this\.onWindowMouseUp, true\)/);
  assert.match(main, /window\.removeEventListener\("mouseup", this\.onWindowMouseUp, true\)/);
  assert.doesNotMatch(styles, /\.terminal-viewport > \.xterm::after/);
  assert.match(
    styles,
    /\.terminal-viewport \.xterm \.xterm-viewport\s*\{[\s\S]*?overflow:\s*hidden !important;[\s\S]*?scrollbar-width:\s*none;/,
  );
  assert.match(
    styles,
    /\.terminal-viewport \.xterm \.xterm-viewport::\-webkit-scrollbar\s*\{[\s\S]*?display:\s*none;[\s\S]*?width:\s*0;/,
  );
  assert.match(
    styles,
    /> \.xterm-scrollbar\.xterm-vertical\s*\{[\s\S]*?background:\s*transparent !important;[\s\S]*?box-shadow:\s*none !important;/,
  );
  assert.match(
    styles,
    /> \.xterm-slider\s*\{[\s\S]*?left:\s*2px !important;[\s\S]*?width:\s*3px !important;[\s\S]*?background:\s*#4a4a4a !important;/,
  );
  assert.match(styles, /\.terminal-resize-handle\s*\{[\s\S]*?cursor:\s*col-resize;/);
  assert.doesNotMatch(styles, /\.xterm-cursor-blink/);
});

test("terminal answer selections expose reliable copy without resuming output follow", async () => {
  const [main, styles] = await Promise.all([
    source("src/main.ts"),
    source("src/styles.css"),
  ]);
  const handlersStart = main.indexOf("private installTerminalInputHandlers()");
  const handlersEnd = main.indexOf("private noteEditableUserInput", handlersStart);
  const handlers = main.slice(handlersStart, handlersEnd);
  const copyStart = main.indexOf("private async copySelection(retainedText?: string)");
  const copyEnd = main.indexOf("private pasteClipboard()", copyStart);
  const copy = main.slice(copyStart, copyEnd);
  const interruptStart = main.indexOf(
    "private consumeManualTerminalInterruptShortcut(event: KeyboardEvent)",
  );
  const interruptEnd = main.indexOf(
    "private forwardTerminalTextInput(data: string)",
    interruptStart,
  );
  const interrupt = main.slice(interruptStart, interruptEnd);
  assert.ok(copyStart >= 0 && copyEnd > copyStart);

  assert.match(main, /className = "terminal-window-action terminal-copy"/);
  assert.match(main, /title = tr\("Copy selected response", "선택한 답변 복사"\)/);
  assert.match(
    handlers,
    /terminal\.onSelectionChange\(\(\) => \{[\s\S]*?copyButton\.hidden = !hasSelection;[\s\S]*?if \(hasSelection\) this\.pauseAutoFollow\(\)/,
  );
  assert.doesNotMatch(handlers, /onSelectionChange[\s\S]{0,180}resumeAutoFollow/);
  assert.match(
    handlers,
    /attachCustomKeyEventHandler[\s\S]*?consumeSelectionCopyShortcut\(event\)[\s\S]*?consumeManualTerminalInterruptShortcut\(event\)[\s\S]*?event\.isComposing/,
  );
  assert.match(
    handlers,
    /"keydown",\s*\(event\) => \{\s*if \(this\.consumeSelectionCopyShortcut\(event\)\) return;/,
  );
  assert.match(
    handlers,
    /private consumeSelectionCopyShortcut\(event: KeyboardEvent, immediate = false\)[\s\S]*?liveTerminalSelection\(\)[\s\S]*?selectionCopyGuard\.selectionForShortcut[\s\S]*?event\.preventDefault\(\)[\s\S]*?stopImmediatePropagation\(\)[\s\S]*?this\.copySelection\(selection\)/,
  );
  assert.match(
    main,
    /onWindowTerminalKeyDown[\s\S]*?ownsTerminalKeyboardEvent\(event\)[\s\S]*?consumeSelectionCopyShortcut\(event, true\)/,
  );
  assert.match(
    main,
    /window\.addEventListener\("keydown", this\.onWindowTerminalKeyDown, true\)[\s\S]*?window\.removeEventListener\("keydown", this\.onWindowTerminalKeyDown, true\)/,
  );
  assert.match(
    main,
    /onWindowTerminalKeyUp[\s\S]*?copyShortcutReleasePending[\s\S]*?stopImmediatePropagation\(\)/,
  );
  assert.match(
    main,
    /window\.addEventListener\("keyup", this\.onWindowTerminalKeyUp, true\)[\s\S]*?window\.removeEventListener\("keyup", this\.onWindowTerminalKeyUp, true\)/,
  );
  assert.match(
    handlers,
    /event\.type === "keyup"[\s\S]*?copyShortcutReleasePending[\s\S]*?return false/,
  );
  assert.match(
    handlers,
    /private consumeManualTerminalInterruptShortcut\(event: KeyboardEvent\)[\s\S]*?shouldManuallySendTerminalInterrupt\(event, this\.terminal\.hasSelection\(\)\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?if \(!event\.repeat\) this\.forwardTerminalTextInput\("\\u0003"\)/,
  );
  assert.ok(interruptStart >= 0 && interruptEnd > interruptStart);
  assert.equal(
    interrupt.match(/forwardTerminalTextInput\("\\u0003"\)/g)?.length,
    1,
  );
  assert.doesNotMatch(interrupt, /copySelection\(/);
  assert.match(
    handlers,
    /terminal\.onData\(\(data\) => \{[\s\S]*?selectionCopyGuard\.selectionForTerminalInput\([\s\S]*?if \(selectedCopy !== null\) \{[\s\S]*?copySelection\(selectedCopy\);[\s\S]*?return;[\s\S]*?isTerminalModifierOnlyInput\(data\)[\s\S]*?queueInput\(\{ kind: "text", data \}\);[\s\S]*?return;[\s\S]*?this\.forwardTerminalTextInput\(data\)/,
  );
  assert.match(
    handlers,
    /terminal\.onBinary\(\(data\) => \{[\s\S]*?selectionCopyGuard\.selectionForTerminalInput\([\s\S]*?if \(selectedCopy !== null\) \{[\s\S]*?copySelection\(selectedCopy\);[\s\S]*?return;[\s\S]*?isTerminalModifierOnlyInput\(data\)[\s\S]*?queueInput\(\{ kind: "binary", data: binaryStringToRawBytes\(data\) \}\);[\s\S]*?return;/,
  );
  assert.match(
    handlers,
    /"copy",[\s\S]*?selectionCopyGuard\.selectionForCopy\([\s\S]*?clipboardData\.setData\("text\/plain", selection\)[\s\S]*?stopImmediatePropagation\(\)/,
  );
  assert.match(
    handlers,
    /private ownsTerminalKeyboardEvent[\s\S]*?passiveDocumentTarget[\s\S]*?externalEditableTarget[\s\S]*?input, textarea, select[\s\S]*?shouldOwnTerminalCopyFallback\([\s\S]*?element\.dataset\.active === "true"[\s\S]*?selectionCopyGuard\.hasCopySelection/,
  );
  assert.match(
    handlers,
    /private liveTerminalSelection\(\)[\s\S]*?terminal\.getSelection\(\)[\s\S]*?document\.getSelection\(\)[\s\S]*?viewport\.contains\(nativeSelection\.anchorNode\)[\s\S]*?viewport\.contains\(nativeSelection\.focusNode\)/,
  );
  assert.match(
    handlers,
    /private forwardTerminalTextInput\(data: string\) \{\s*this\.selectionCopyGuard\.invalidate\(\);\s*this\.armInteractiveLaunchPaintProbeForSubmittedInput\(data\);\s*this\.noteEditableUserInput\(data\);\s*this\.resumeAutoFollowForUserIntent\(\);\s*this\.queueInput\(\{ kind: "text", data \}\);\s*this\.scheduleAgentDiscovery\(data\.includes\("\\r"\) \|\| data\.includes\("\\n"\)\);/,
  );
  assert.match(copy, /await invoke\("write_clipboard_text", \{ text \}\)/);
  assert.match(copy, /catch \(nativeError\)/);
  assert.match(copy, /const clipboardEventSucceeded = this\.copySelectionThroughClipboardEvent\(text\)/);
  assert.match(copy, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(copy, /if \(clipboardEventSucceeded\) return true/);
  assert.doesNotMatch(copy, /if \(this\.copySelectionThroughClipboardEvent\(text\)\) return true/);
  assert.match(copy, /this\.pauseAutoFollow\(\)/);
  assert.doesNotMatch(copy, /clearSelection|resumeAutoFollow/);
  assert.match(copy, /document\.execCommand\("copy"\)/);
  assert.match(copy, /clipboardData\.setData\("text\/plain", text\)/);
  assert.match(
    handlers,
    /contextmenu[\s\S]*?if \(this\.terminal\.hasSelection\(\)\) void this\.copySelection\(\);[\s\S]*?else void this\.pasteClipboard\(\)/,
  );
  assert.match(styles, /\.terminal-copy\[hidden\]\s*\{\s*display:\s*none/);
});

test("terminal output coalesces adjacent TUI repaint fragments before xterm renders", async () => {
  const main = await source("src/main.ts");
  const acceptStart = main.indexOf("private acceptOutput(batch: OutputBatch)");
  const acceptEnd = main.indexOf("private async sendCumulativeAck", acceptStart);
  const rendering = main.slice(acceptStart, acceptEnd);
  assert.ok(acceptStart >= 0 && acceptEnd > acceptStart);
  assert.match(
    rendering,
    /if \(ready\.length > 0\)[\s\S]*?pendingRenderBatches\.push\(\.\.\.ready\)[\s\S]*?scheduleRenderDrain\(\)/,
  );
  assert.match(
    rendering,
    /scheduleRenderDrain\(\)[\s\S]*?renderQueue = this\.renderQueue\.then[\s\S]*?drainPendingRenderBatches\(\)/,
  );
  assert.match(
    rendering,
    /await delay\(OUTPUT_RENDER_COALESCE_MS\)[\s\S]*?takePendingRenderBatches\(\)[\s\S]*?await this\.renderOutputBatches\(rendering\)/,
  );
  assert.match(
    rendering,
    /OUTPUT_RENDER_MAX_BYTES[\s\S]*?pendingRenderBatches\.splice/,
  );
  assert.match(rendering, /batches\.map\(\(batch\) => batch\.data\)\.join\(""\)/);
  assert.doesNotMatch(rendering, /nextAnimationFrame\(\)/);
  assert.match(
    rendering,
    /for \(const batch of batches\)[\s\S]*?ackPolicy\.noteRendered\(batch\.sequence\)/,
  );
  assert.match(
    rendering,
    /shouldFollow[\s\S]*?writeEpoch === this\.interactionEpoch[\s\S]*?this\.canAutoFollow\(\)[\s\S]*?!this\.isAtBottom\(\)[\s\S]*?scrollToBottom\(\)/,
  );
  assert.match(
    rendering,
    /this\.pendingExit && this\.outputSequencer\.isFinalReady[\s\S]*?this\.scheduleExitBarrier\(\)/,
  );
  assert.doesNotMatch(main, /TerminalOutputFrameBuffer/);
  assert.match(
    main,
    /scheduleExitBarrier\(\)[\s\S]*?this\.renderQueue = this\.renderQueue[\s\S]*?nextAnimationFrame\(\)/,
  );
  assert.match(
    main,
    /scheduleSettledFollow\([\s\S]*?this\.canAutoFollow\(\)[\s\S]*?!this\.isAtBottom\(\)[\s\S]*?scrollToBottom\(\)/,
  );
});

test("interactive CLI launch recovers a missed xterm paint without polling normal output", async () => {
  const [main, packageSource] = await Promise.all([
    source("src/main.ts"),
    source("package.json"),
  ]);
  const handlersStart = main.indexOf("private installTerminalInputHandlers()");
  const handlersEnd = main.indexOf("private consumeSelectionCopyShortcut", handlersStart);
  const handlers = main.slice(handlersStart, handlersEnd);
  const recoveryStart = main.indexOf("private armInteractiveLaunchPaintProbe()");
  const recoveryEnd = main.indexOf("private noteEditableUserInput", recoveryStart);
  const recovery = main.slice(recoveryStart, recoveryEnd);
  const renderStart = main.indexOf("private async renderOutputBatches");
  const renderEnd = main.indexOf("private async sendCumulativeAck", renderStart);
  const rendering = main.slice(renderStart, renderEnd);

  assert.ok(handlersStart >= 0 && handlersEnd > handlersStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(
    handlers,
    /key === "enter"[\s\S]*?!event\.repeat[\s\S]*?buffer\.active\.type === "normal"[\s\S]*?armInteractiveLaunchPaintProbe\(\)/,
  );
  assert.match(
    main,
    /armInteractiveLaunchPaintProbeForSubmittedInput\(data: string\)[\s\S]*?buffer\.active\.type === "normal"[\s\S]*?data\.includes\("\\r"\)[\s\S]*?armInteractiveLaunchPaintProbe\(\)/,
  );
  assert.match(
    main,
    /inputReady\.then\(\(\{ input, error \}\) => \{[\s\S]*?input\?\.kind === "text"[\s\S]*?armInteractiveLaunchPaintProbeForSubmittedInput\(input\.data\)[\s\S]*?commit\(input\)/,
  );
  assert.match(
    handlers,
    /terminal\.onRender\(\(\) => \{[\s\S]*?terminalPaintedVersion = this\.terminalRenderVersion[\s\S]*?launchPaintWatchdog\.observePaint/,
  );
  assert.match(
    rendering,
    /bufferTypeBeforeWrite = this\.terminal\.buffer\.active\.type[\s\S]*?terminal\.write\(data[\s\S]*?terminalRenderVersion \+= batches\.length[\s\S]*?observeInteractiveLaunchOutput[\s\S]*?buffer\.active\.type === "alternate"/,
  );
  assert.match(
    recovery,
    /launchPaintWatchdog\.poll\([\s\S]*?synchronizedOutputMode[\s\S]*?decision === "waiting"[\s\S]*?decision === "recover"/,
  );
  assert.match(
    recovery,
    /!this\.isTerminalViewportPaintable\(\)[\s\S]*?launchProbeExpiryTimer = 0[\s\S]*?return;/,
  );
  assert.match(
    recovery,
    /isTerminalViewportPaintable\(\)[\s\S]*?element\.isConnected[\s\S]*?getClientRects\(\)\.length > 0/,
  );
  assert.match(
    recovery,
    /recoverInteractiveLaunchPaint\(\)[\s\S]*?isTerminalViewportPaintable\(\)[\s\S]*?fitTerminal\(\)[\s\S]*?queueCurrentSize\(\)[\s\S]*?core\.refresh\(0,[\s\S]*?true\)/,
  );
  assert.equal(JSON.parse(packageSource).dependencies["@xterm/xterm"], "6.1.0-beta.290");
  assert.equal(
    JSON.parse(packageSource).dependencies["@xterm/addon-web-links"],
    "0.13.0-beta.290",
  );
  assert.doesNotMatch(recovery, /terminal\.write\("\\u001b\[\?2026l"/);
  assert.match(main, /TERMINAL_LAUNCH_PROBE_TTL_MS = 12_000/);
  assert.match(main, /TERMINAL_SYNCHRONIZED_PAINT_LIMIT_MS = 1_600/);
});

test("pane maximize is a reversible workspace view and leaves sibling sessions alive", async () => {
  const main = await source("src/main.ts");
  assert.match(main, /className = "terminal-window-action terminal-maximize"/);
  assert.match(main, /this\.workspace\.togglePaneMaximize\(this\.id\)/);
  assert.match(
    main,
    /setMaximized\(maximized: boolean\)[\s\S]*?dataset\.maximized = String\(maximized\)[\s\S]*?aria-pressed", String\(maximized\)/,
  );
  const browserStart = main.indexOf("class BrowserPane");
  const browserEnd = main.indexOf("type LayoutPane", browserStart);
  assert.ok(browserStart >= 0 && browserEnd > browserStart);
  const browserPane = main.slice(browserStart, browserEnd);
  assert.match(browserPane, /private readonly maximizeButton: HTMLButtonElement/);
  assert.match(browserPane, /actions\.append\(this\.maximizeButton, this\.closeButton\)/);
  assert.match(browserPane, /this\.workspace\.togglePaneMaximize\(this\.id\)/);
  assert.match(
    browserPane,
    /setMaximized\(maximized: boolean\)[\s\S]*?aria-pressed", String\(maximized\)/,
  );

  const toggleStart = main.indexOf("togglePaneMaximize(paneId: string)");
  const toggleEnd = main.indexOf("async renamePane", toggleStart);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
  const toggle = main.slice(toggleStart, toggleEnd);
  assert.match(toggle, /const pane = this\.layoutPane\(paneId\)/);
  assert.match(toggle, /cancelLayoutInteraction\(\)/);
  assert.match(toggle, /this\.maximizedPaneId === paneId \? null : paneId/);
  assert.match(toggle, /this\.updateLayout\(\)/);
  assert.doesNotMatch(toggle, /dispose\(|closePane\(|panes\.delete/);

  const layoutStart = main.indexOf("private updateLayout()");
  const layoutEnd = main.indexOf("private updateControls()", layoutStart);
  assert.ok(layoutStart >= 0 && layoutEnd > layoutStart);
  const layout = main.slice(layoutStart, layoutEnd);
  assert.match(layout, /const allVisible = this\.visiblePanes\(\)/);
  assert.match(layout, /const visible = maximized \? \[maximized\] : allVisible/);
  assert.match(
    layout,
    /for \(const pane of this\.allPanes\(\)\) \{\s*pane\.setMaximized/,
  );
  assert.match(layout, /for \(const pane of this\.allPanes\(\)\)[\s\S]*?inactivePaneBin\.append\(pane\.element\)/);
  assert.doesNotMatch(layout, /dispose\(|panes\.delete/);
  assert.match(main, /if \(projectChanged\) this\.maximizedPaneId = null/);
  assert.match(main, /if \(this\.maximizedPaneId === paneId\) this\.maximizedPaneId = null/);

  const addPaneStart = main.indexOf("  addPane(");
  const addPane = main.slice(
    addPaneStart,
    main.indexOf("addBrowserPane(", addPaneStart),
  );
  assert.match(
    addPane,
    /projectId === this\.activeProjectId && focus[\s\S]*?this\.maximizedPaneId = null[\s\S]*?activatePane/,
  );
  const addBrowserPane = main.slice(
    main.indexOf("addBrowserPane("),
    main.indexOf("restoreCapacity(", main.indexOf("addBrowserPane(")),
  );
  assert.match(
    addBrowserPane,
    /inactivePaneBin\.append\(pane\.element\)[\s\S]*?this\.maximizedPaneId = null[\s\S]*?this\.activePaneId = pane\.id/,
  );
});

test("live pane dragging preserves stable thresholds, frozen preview, and outside rollback", async () => {
  const main = await source("src/main.ts");
  const parity = [
    ["PANE_DRAG_START_DISTANCE_PX", 8],
    ["PANE_DRAG_MINIMUM_REORDER_DISTANCE_PX", 12],
    ["PANE_DRAG_SLOT_HYSTERESIS_PX", 18],
    ["PANE_DRAG_BOUNCE_BACK_ANGLE_RADIANS", 1],
  ];
  for (const [currentName, expected] of parity) {
    assert.match(main, new RegExp(`const ${currentName} = ${expected};`));
  }
  assert.match(main, /const PANE_DRAG_CANDIDATE_HOLD_MS = 80;/);

  const beginDragStart = main.indexOf("  beginPaneDrag(");
  const beginDragEnd = main.indexOf("  beginPaneResize(", beginDragStart);
  const updateDragStart = main.indexOf("  private updatePaneDrag(");
  const updateDragEnd = main.indexOf("  private renderPaneDragFrame(", updateDragStart);
  assert.ok(beginDragStart >= 0 && beginDragEnd > beginDragStart);
  assert.ok(updateDragStart >= 0 && updateDragEnd > updateDragStart);
  const beginDrag = main.slice(beginDragStart, beginDragEnd);
  const updateDrag = main.slice(updateDragStart, updateDragEnd);
  assert.doesNotMatch(
    beginDrag,
    /setPointerCapture/,
    "a click must remain targeted at the title so its dblclick rename can fire",
  );
  assert.match(
    updateDrag,
    /state\.started = true;[\s\S]*?state\.captureTarget\.setPointerCapture\(state\.pointerId\)/,
  );

  assert.match(
    main,
    /state\.started = true;[\s\S]*?freezePaneDragLayout\(state\)[\s\S]*?setDragging\(true\)/,
  );
  assert.match(
    main,
    /private freezePaneDragLayout\(state: PaneDragState\)[\s\S]*?dataset\.dragFrozen = "true"[\s\S]*?style\.position = "fixed"[\s\S]*?style\.left = `\$\{slot\.left\}px`[\s\S]*?style\.height = `\$\{slot\.height\}px`/,
  );
  assert.match(
    main,
    /state\.previewOrder = buildPaneDragPreviewOrder\([\s\S]*?this\.applyPaneDragPreview\(state\)/,
  );
  assert.match(
    main,
    /if \(!rectContainsPoint\(surfaceRect, state\.latestX, state\.latestY\)\) \{[\s\S]*?state\.hasValidDrop = false[\s\S]*?this\.insertionLine\.hidden = true/,
  );
  const finishStart = main.indexOf("private finishPaneDrag(");
  const finishEnd = main.indexOf("private freezePaneDragLayout", finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart);
  const finish = main.slice(finishStart, finishEnd);
  assert.match(finish, /if \(!state\.started\) \{[\s\S]*?return;/);
  assert.match(
    finish,
    /const changed =[\s\S]*?!cancelled[\s\S]*?state\.hasValidDrop[\s\S]*?!samePaneOrder[\s\S]*?const next = changed \? state\.previewOrder : state\.originalOrder/,
  );
  assert.match(
    main,
    /private clearPaneDragLayout\(state: PaneDragState\)[\s\S]*?delete pane\.element\.dataset\.dragFrozen[\s\S]*?style\.transform = ""/,
  );
});

test("running terminal chrome omits connection metadata and non-alert borders stay transparent", async () => {
  const [main, styles] = await Promise.all([
    source("src/main.ts"),
    source("src/styles.css"),
  ]);
  const paneStart = main.indexOf("class TerminalPane");
  const paneEnd = main.indexOf("class BrowserPane", paneStart);
  assert.ok(paneStart >= 0 && paneEnd > paneStart);
  const terminalPane = main.slice(paneStart, paneEnd);

  assert.ok(
    [...terminalPane.matchAll(/setState\("running", ""\)/g)].length >= 2,
    "both start-result and backend-start events must hide running metadata",
  );
  assert.match(
    terminalPane,
    /private setStatusOnly\(message: string, tone: StatusTone\)[\s\S]*?stateLabel\.textContent = message[\s\S]*?stateLabel\.hidden = message\.length === 0/,
  );
  assert.doesNotMatch(terminalPane, /연결됨|\bPID\b|ConPTY 연결/);

  assert.match(styles, /\.terminal-pane\s*\{[^}]*?border:\s*1px solid transparent;/);
  assert.match(styles, /\.terminal-pane\[data-active="true"\]\s*\{[^}]*?border-color:\s*transparent;/);
  assert.match(styles, /\.terminal-pane\[data-state="error"\]\s*\{[^}]*?border-color:\s*transparent;/);
  assert.match(
    styles,
    /\.terminal-pane\[data-completion-pending="true"\][\s\S]*?border-color:\s*var\(--completion-border\)/,
  );
});

test("agent lifecycle drives project activity and durable completion", async () => {
  const [main, controller, backend, styles] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src-tauri/src/agent_runtime.rs"),
    source("src/styles.css"),
  ]);
  assert.match(main, /invoke\("subscribe_agent_events", \{ onEvent: this\.channel \}\)/);
  assert.match(main, /event !== "turnStarted" && event !== "turnFinished"/);
  assert.match(main, /setAgentTurnWorking\([\s\S]*event === "turnStarted"/);
  assert.match(
    main,
    /AGENT_EVENT_BIND_RETRY_DELAYS_MS = \[\s*80,\s*200,\s*500,\s*1_000,\s*2_000,\s*4_000,\s*8_000,\s*15_000,\s*\]/,
  );
  const agentEventController = main.slice(
    main.indexOf("class AgentEventController"),
    main.indexOf("async function stopBackendSession"),
  );
  assert.match(
    agentEventController,
    /const correlationKey = agentLifecycleCorrelationKey\([\s\S]*?const deliveryVersion = \+\+this\.lifecycleDeliverySequence;[\s\S]*?latestLifecycleDeliveryByCorrelation\.set\(correlationKey, deliveryVersion\)/,
  );
  assert.match(
    agentEventController,
    /latestLifecycleDeliveryByCorrelation\.get\(correlationKey\) !== deliveryVersion[\s\S]*?if \(!accepted\)[\s\S]*?const delayMs = AGENT_EVENT_BIND_RETRY_DELAYS_MS\[attempt\][\s\S]*?correlationKey,[\s\S]*?deliveryVersion,[\s\S]*?attempt \+ 1/,
  );
  assert.doesNotMatch(
    agentEventController,
    /event === "turnFinished" && succeeded\s*\?\s*AGENT_EVENT_BIND_RETRY_DELAYS_MS/,
  );
  assert.match(
    agentEventController,
    /if \(event === "turnFinished"\)[\s\S]*?latestLifecycleDeliveryByCorrelation\.delete\(correlationKey\)[\s\S]*?if \(!succeeded\) return/,
  );
  assert.match(
    main,
    /Promise\.all\(\[productionMigrationPromise, agentEventsReady\]\)[\s\S]*controller\?\.initialize\(\)/,
  );
  assert.ok(
    main.indexOf("const agentEventsReady = agentEvents.start()") <
      main.indexOf("controller = createPhase4WorkspaceController"),
    "the agent event subscription must start before workspace restoration",
  );
  assert.match(main, /pane\?\.ownsRuntimeSession\(runtimeSessionId\)/);
  assert.match(main, /provider,[\s\S]*conversationId\.toLowerCase\(\),[\s\S]*observedAtUnixMs/);
  assert.match(
    main,
    /rawNotificationObservedAtUnixMs !== null[\s\S]*typeof rawNotificationObservedAtUnixMs !== "number"[\s\S]*Number\.isSafeInteger\(rawNotificationObservedAtUnixMs\)[\s\S]*rawNotificationObservedAtUnixMs < 0/,
  );
  assert.match(
    agentEventController,
    /this\.workspace\.queueAgentCompletion\([\s\S]*notificationObservedAtUnixMs === null[\s\S]*provider,[\s\S]*runtimeSessionId,[\s\S]*turnId,[\s\S]*observedAtUnixMs: notificationObservedAtUnixMs/,
  );
  assert.match(controller, /new ProjectActivityTracker\(\)/);
  assert.match(controller, /className = "workspace-tab-status"/);
  assert.match(controller, /className = "workspace-tab-activity"/);
  assert.match(controller, /aria-busy/);
  assert.match(backend, /TurnStarted/);
  assert.match(backend, /TurnFinished/);
  assert.match(backend, /turn_aborted/);
  assert.match(styles, /\.workspace-tab-activity\s*\{[\s\S]*?animation:\s*workspace-tab-spin/);
  assert.match(
    styles,
    /\.workspace-tab-activity\s*\{[\s\S]*?border-top-color:\s*#c8c8c8;[\s\S]*?will-change:\s*transform;/,
  );
  const reducedMotionStart = styles.indexOf("@media (prefers-reduced-motion: reduce)");
  const reducedMotionEnd = styles.indexOf(".add-workspace-tab", reducedMotionStart);
  assert.ok(reducedMotionStart >= 0 && reducedMotionEnd > reducedMotionStart);
  const reducedMotion = styles.slice(reducedMotionStart, reducedMotionEnd);
  assert.match(reducedMotion, /\.workspace-tab-activity\s*\{[\s\S]*?animation-duration:\s*1800ms;/);
  assert.doesNotMatch(reducedMotion, /animation:\s*none/);
  assert.doesNotMatch(main, /prompt[^\n]*(working|busy)|OutputQuiet[^\n]*SetAgent/i);
});

test("agent context telemetry is correlated to its pane and rendered in the header", async () => {
  const [main, backend, styles] = await Promise.all([
    source("src/main.ts"),
    source("src-tauri/src/agent_runtime.rs"),
    source("src/styles.css"),
  ]);
  const agentEventController = main.slice(
    main.indexOf("class AgentEventController"),
    main.indexOf("async function stopBackendSession"),
  );

  assert.match(backend, /ContextUpdated\s*\{/);
  assert.match(backend, /last_token_usage[\s\S]*?total_tokens/);
  assert.match(backend, /model_context_window/);
  assert.match(backend, /MAX_CONTEXT_LOOKBACK_BYTES/);
  assert.match(backend, /read_latest_codex_context/);
  assert.match(backend, /contextTokensUsed/);
  assert.match(backend, /contextWindowTokens/);
  assert.match(agentEventController, /event === "contextUpdated"/);
  assert.match(
    agentEventController,
    /setAgentContextUsage\([\s\S]*?usedTokens,[\s\S]*?windowTokens,[\s\S]*?remainingPercent/,
  );
  assert.match(
    main,
    /contextLabel\.textContent = `Context \$\{remainingPercent\}%`/,
  );
  assert.match(main, /ownsRuntimeSession\(runtimeSessionId\)/);
  assert.match(styles, /\.terminal-context\s*\{/);
  assert.match(styles, /\.terminal-context\[data-low="true"\]/);
});

test("usage, unread badges, and the single native clipboard snapshot are wired", async () => {
  const [main, controller, html, styles, platform, backend, cargo] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("index.html"),
    source("src/styles.css"),
    source("src-tauri/src/terminal_platform.rs"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/Cargo.toml"),
  ]);
  assert.match(main, /invoke<unknown>\("read_provider_usage"\)/);
  assert.match(main, /window\.setInterval\(\(\) => \{[\s\S]*?\}, 15_000\)/);
  assert.match(
    main,
    /scheduleNextResetRefresh\(\)[\s\S]*millisecondsUntilNextProviderUsageReset\(this\.latestUsage\)[\s\S]*refreshAtKnownReset/,
  );
  assert.match(
    main,
    /refreshAtKnownReset\(\)[\s\S]*requestRunning[\s\S]*window\.setTimeout\(\(\) => this\.refreshAtKnownReset\(\), 100\)[\s\S]*void this\.refresh\(\)/,
  );
  const clipboardStart = main.indexOf("private async readClipboardInput()");
  const clipboardEnd = main.indexOf("private scheduleExitBarrier", clipboardStart);
  assert.ok(clipboardStart >= 0 && clipboardEnd > clipboardStart);
  const clipboard = main.slice(clipboardStart, clipboardEnd);
  assert.match(clipboard, /invoke<unknown>\("read_clipboard_snapshot"\)/);
  assert.match(clipboard, /snapshot\.kind === "image"/);
  assert.match(clipboard, /snapshot\.kind === "empty"/);
  assert.doesNotMatch(clipboard, /navigator\.clipboard\.readText/);
  assert.doesNotMatch(main, /clipboard_contains_image/);
  assert.match(main, /invoke<AgentProvider \| null>\("detect_terminal_agent"/);
  assert.match(main, /selectClipboardImageSequence\(provider\)/);
  assert.match(platform, /CF_DIBV5/);
  assert.match(platform, /CF_UNICODE_TEXT_FORMAT/);
  assert.match(platform, /MAX_CLIPBOARD_TEXT_BYTES/);
  assert.match(platform, /GlobalLock/);
  assert.match(platform, /ClipboardSnapshot::Image[\s\S]*has_unicode_text/);
  assert.match(platform, /detect_terminal_agent/);
  assert.match(
    backend,
    /async fn read_clipboard_snapshot\(\)[\s\S]*spawn_blocking\(terminal_platform::read_clipboard_snapshot\)/,
  );
  assert.doesNotMatch(backend, /clipboard_contains_image/);
  assert.match(cargo, /Win32_System_Memory/);
  assert.match(controller, /projectUnreadCount\(state, project\.id\)/);
  assert.match(html, /id="codex-five-hour-remaining"/);
  assert.match(html, /id="codex-weekly-remaining"/);
  assert.match(html, /id="grok-remaining"/);
  assert.equal((html.match(/class="usage-meter"/g) ?? []).length, 3);
  assert.equal((html.match(/class="usage-reset"/g) ?? []).length, 3);
  assert.match(html, /viewBox="0 0 16 16"/);
  assert.match(html, /viewBox="0 0 24 23"/);
  assert.match(main, /formatProviderResetCountdown\(limit\.resetsAt\)/);
  assert.match(main, /elements\.meter\.value = limit\.remainingPercent/);
  assert.match(
    main,
    /elements\.value\.textContent = tr\(`\$\{rounded\}% remaining`, `\$\{rounded\}% 남음`\)/,
  );
  assert.match(main, /this\.renderLatestUsage\(\);\s*void this\.refresh\(\)/);
  assert.doesNotMatch(html, /RUST · NATIVE|RUST · ConPTY/);
  assert.doesNotMatch(
    html,
    /storage-mode-badge|open-legacy-import|legacy-import-dialog|recover-project-catalog|Rust 저장소/,
  );
  assert.doesNotMatch(main, /createPhase3BMigrationUI|migrationUi/);
  assert.ok(html.indexOf('class="provider-usage"') < html.indexOf('id="status"'));
  assert.doesNotMatch(html, /close-active-terminal|session-count|현재 창 닫기/);
  assert.doesNotMatch(controller, /Rust 작업 공간 r\$\{status\.revision\}을 불러왔습니다/);
  assert.match(styles, /\.provider-usage\s*\{[\s\S]*?margin-left:\s*0/);
  assert.match(styles, /\.usage-meter\s*\{[\s\S]*?width:\s*48px;[\s\S]*?height:\s*4px/);
  assert.match(styles, /\.provider-icon\s*\{[^}]*?width:\s*13px;[^}]*?height:\s*13px/);
  assert.match(styles, /\.usage-limit \+ \.usage-limit\s*\{[\s\S]*?margin-left:\s*12px/);
  assert.match(
    styles,
    /\.provider-usage-item \+ \.provider-usage-item\s*\{[\s\S]*?margin-left:\s*16px;[\s\S]*?padding-left:\s*16px/,
  );
  assert.match(styles, /\.usage-limit\[data-available="false"\] \.usage-value/);
  assert.match(styles, /#status\[data-tone="error"\]\s*\{[\s\S]*?display:\s*block/);
  assert.match(
    styles,
    /\.terminal-pane\[data-completion-pending="true"\][\s\S]*?border-color:\s*var\(--completion-border\)/,
  );
  assert.match(
    styles,
    /\.terminal-pane\[data-completion-pending="true"\]::after\s*\{[\s\S]*?animation:\s*completion-glow-pulse 2\.8s ease-in-out infinite/,
  );
  assert.match(
    styles,
    /@keyframes completion-glow-pulse\s*\{[\s\S]*?opacity:\s*0\.35[\s\S]*?opacity:\s*0\.95/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.terminal-pane\[data-completion-pending="true"\]::after\s*\{[\s\S]*?animation:\s*completion-glow-pulse 4\.8s ease-in-out infinite/,
  );
  assert.match(
    styles,
    /\.project-item\[data-has-completion="true"\]\s*\{[\s\S]*?var\(--completion-border\)/,
  );
  assert.match(
    styles,
    /\.completion-badge\s*\{[\s\S]*?var\(--completion-badge-text\)[\s\S]*?var\(--completion-badge-surface\)/,
  );
});

test("provider usage opens a compact account-aware popover above the status bar", async () => {
  const [html, main, styles, backend, providerUsage, workspaceController] = await Promise.all([
    source("index.html"),
    source("src/main.ts"),
    source("src/styles.css"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/provider_usage.rs"),
    source("src/phase4-controller.ts"),
  ]);

  assert.match(
    html,
    /id="codex-usage-trigger"[\s\S]*type="button"[\s\S]*aria-haspopup="dialog"[\s\S]*aria-controls="provider-usage-popover"[\s\S]*aria-expanded="false"/,
  );
  assert.match(
    html,
    /id="grok-usage-trigger"[\s\S]*type="button"[\s\S]*aria-haspopup="dialog"[\s\S]*aria-controls="provider-usage-popover"[\s\S]*aria-expanded="false"/,
  );

  const popoverStart = html.indexOf('id="provider-usage-popover"');
  const popoverEnd = html.indexOf("</footer>", popoverStart);
  assert.ok(popoverStart >= 0 && popoverEnd > popoverStart);
  const popover = html.slice(popoverStart, popoverEnd);
  assert.match(
    popover,
    /class="provider-usage-popover"[\s\S]*role="dialog"[\s\S]*aria-modal="false"[\s\S]*aria-labelledby="provider-usage-detail-title"[\s\S]*hidden/,
  );
  const limitsIndex = popover.indexOf('class="provider-usage-detail-limits"');
  const accountIndex = popover.indexOf('class="provider-account-detail"');
  const accountControlsIndex = popover.indexOf('class="provider-account-controls"');
  assert.ok(limitsIndex >= 0 && accountIndex > limitsIndex && accountControlsIndex > accountIndex);
  assert.match(
    popover,
    /id="provider-account-select"[\s\S]*aria-label="Select CLI account"[\s\S]*data-i18n-aria-label-ko="CLI 계정 선택"[\s\S]*id="add-provider-account"/,
  );
  assert.match(
    popover,
    /id="close-provider-usage"[\s\S]*type="button"[\s\S]*aria-label="Close usage details"[\s\S]*data-i18n-aria-label-ko="사용량 상세 닫기"/,
  );
  assert.doesNotMatch(popover, /provider-account-plan|<dt>\s*플랜\s*<\/dt>/);
  assert.doesNotMatch(popover, /provider-usage-detail-used|<dt>\s*사용\s*<\/dt>/);
  assert.doesNotMatch(popover, /사용량 기록 시각|provider-usage-detail-updated/);
  assert.doesNotMatch(popover, /앱 확인 시각|provider-usage-detail-read-at/);
  assert.doesNotMatch(popover, /id="refresh-provider-usage"|>\s*새로고침\s*</);

  const controllerStart = main.indexOf("class ProviderUsageController");
  const controllerEnd = main.indexOf("class PhoneNotificationController", controllerStart);
  assert.ok(controllerStart >= 0 && controllerEnd > controllerStart);
  const usageController = main.slice(controllerStart, controllerEnd);
  assert.match(usageController, /toggleDetail\("codex", this\.codexTrigger\)/);
  assert.match(
    usageController,
    /this\.detail\.closeButton\.addEventListener\("click", \(\) => this\.requestCloseDetail\(true\)/,
  );
  assert.match(
    usageController,
    /if \(!this\.detail\.popover\.hidden && this\.activeDetailProvider === provider\)[\s\S]*this\.requestCloseDetail\(false\)/,
  );
  assert.match(
    usageController,
    /onDocumentPointerDown\(event: PointerEvent\)[\s\S]*this\.detail\.popover\.contains\(target\)[\s\S]*this\.codexTrigger\.contains\(target\)[\s\S]*this\.grokTrigger\.contains\(target\)[\s\S]*this\.requestCloseDetail\(false\)/,
  );
  assert.match(
    usageController,
    /onWindowKeyDown\(event: KeyboardEvent\)[\s\S]*event\.key !== "Escape"[\s\S]*this\.requestCloseDetail\(true\)/,
  );
  assert.match(
    usageController,
    /requestCloseDetail\(restoreFocus: boolean\)[\s\S]*accountOperation === "switching"[\s\S]*accountOperation === "cancelling"[\s\S]*accountOperation === "adding"[\s\S]*cancelAccountAddAndClose\(restoreFocus\)/,
  );
  assert.match(
    usageController,
    /cancelAccountAddAndClose\(restoreFocus: boolean\)[\s\S]*accountOperation = "cancelling";[\s\S]*accountRequestSequence \+= 1;[\s\S]*invoke<boolean>\("cancel_provider_account_login", \{ provider \}\)[\s\S]*await pendingAdd;[\s\S]*accountOperation = "idle";[\s\S]*renderDetailAccount\(\);[\s\S]*closeDetail\(restoreFocus\)/,
  );
  assert.match(
    usageController,
    /pendingAccountAdd: Promise<void> \| null[\s\S]*const pendingAdd = new Promise<void>[\s\S]*finally \{[\s\S]*settleAccountAdd\(\);[\s\S]*pendingAccountAdd === pendingAdd/,
  );
  assert.match(
    usageController,
    /closeButton\.disabled = switching \|\| cancelling;[\s\S]*adding[\s\S]*tr\("Cancel account addition and close", "계정 추가 취소하고 닫기"\)/,
  );
  assert.match(
    usageController,
    /closeButton\.setAttribute\([\s\S]*"aria-label",[\s\S]*adding[\s\S]*tr\("Cancel account addition and close", "계정 추가 취소하고 닫기"\)[\s\S]*tr\("Close usage details", "사용량 상세 닫기"\)/,
  );
  assert.match(
    usageController,
    /positionDetail\(\)[\s\S]*getBoundingClientRect\(\)[\s\S]*const maximum = Math\.max\(8,[\s\S]*Math\.max\(8, Math\.min\(desired, maximum\)\)/,
  );
  assert.match(
    usageController,
    /private readonly setNativeOverlayOpen: \(bounds: RectangleBounds \| null\) => void/,
  );
  const toggleStart = usageController.indexOf("private toggleDetail(");
  const toggleEnd = usageController.indexOf("private closeDetail(", toggleStart);
  const closeStart = toggleEnd;
  const closeEnd = usageController.indexOf("private requestCloseDetail(", closeStart);
  const positionStart = usageController.indexOf("private positionDetail(");
  const positionEnd = usageController.indexOf("private async refreshAccount(", positionStart);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  assert.ok(positionStart >= 0 && positionEnd > positionStart);
  const toggleDetail = usageController.slice(toggleStart, toggleEnd);
  const closeDetail = usageController.slice(closeStart, closeEnd);
  const positionDetail = usageController.slice(positionStart, positionEnd);
  assert.match(
    toggleDetail,
    /detail\.popover\.hidden = false;[\s\S]*this\.positionDetail\(\)/,
  );
  assert.match(
    positionDetail,
    /popover\.style\.left[\s\S]*this\.syncNativeOverlayBounds\(\)[\s\S]*private syncNativeOverlayBounds\(\)[\s\S]*this\.setNativeOverlayOpen\([\s\S]*this\.detail\.popover\.hidden \? null : this\.detail\.popover\.getBoundingClientRect\(\)/,
  );
  assert.match(
    closeDetail,
    /detail\.popover\.hidden = true;[\s\S]*this\.setNativeOverlayOpen\(null\)/,
  );
  assert.match(
    usageController,
    /dispose\(\)[\s\S]*detail\.popover\.hidden = true;[\s\S]*this\.setNativeOverlayOpen\(null\)/,
  );
  assert.doesNotMatch(usageController, /setNativeOverlayOpen\((?:true|false)\)/);
  assert.doesNotMatch(toggleDetail, /\.hide\(|\.close\(|\.dispose\(/);
  assert.doesNotMatch(closeDetail, /\.hide\(|\.close\(|\.dispose\(/);
  assert.doesNotMatch(usageController, /\.showModal\(\)/);

  assert.match(
    usageController,
    /invoke<unknown>\("list_provider_accounts", \{ provider \}\)/,
  );
  assert.match(
    usageController,
    /invoke<unknown>\("add_provider_account", \{ provider \}\)/,
  );
  assert.match(
    usageController,
    /invoke<unknown>\("switch_provider_account", \{ provider, accountId \}\)/,
  );
  assert.match(usageController, /await this\.restartForAccountSwitch\(provider\)/);
  assert.match(
    usageController,
    /const sequence = \+\+this\.accountRequestSequence;[\s\S]*await this\.ensureAccountSwitchReady\(\);[\s\S]*isCurrentAccountOperation\(sequence, provider\)[\s\S]*switch_provider_account/,
  );
  assert.match(
    usageController,
    /add_provider_account[\s\S]*response\.activeAccountId !== previousAccountId[\s\S]*addedAccounts[\s\S]*switchAccount\(addedAccount\.id, true\)/,
  );
  assert.match(
    usageController,
    /private async addAccount\(\)[\s\S]*await this\.ensureAccountSwitchReady\(\)[\s\S]*add_provider_account/,
  );
  assert.match(main, /\(bounds\) => workspace\.setNativeOverlayOpen\(bounds\)/);
  const browserPaneStart = main.indexOf("class BrowserPane");
  const browserPaneEnd = main.indexOf("type LayoutPane", browserPaneStart);
  assert.ok(browserPaneStart >= 0 && browserPaneEnd > browserPaneStart);
  const browserPane = main.slice(browserPaneStart, browserPaneEnd);
  assert.match(
    browserPane,
    /overlapsNativeOverlay\(bounds: RectangleBounds\)[\s\S]*rectanglesOverlap\(this\.viewport\.getBoundingClientRect\(\), bounds\)/,
  );
  const overlapStart = browserPane.indexOf("overlapsNativeOverlay(");
  const overlapEnd = browserPane.indexOf("scheduleFit(", overlapStart);
  assert.ok(overlapStart >= 0 && overlapEnd > overlapStart);
  assert.doesNotMatch(
    browserPane.slice(overlapStart, overlapEnd),
    /\.hide\(|\.close\(|\.dispose\(/,
  );

  const workspaceStart = main.indexOf("class TerminalWorkspace");
  const workspaceEnd = main.indexOf("class BrowserController", workspaceStart);
  assert.ok(workspaceStart >= 0 && workspaceEnd > workspaceStart);
  const workspace = main.slice(workspaceStart, workspaceEnd);
  assert.match(
    workspace,
    /providerUsageOverlayBounds: RectangleBounds \| null = null/,
  );
  assert.match(
    workspace,
    /setNativeOverlayOpen\(bounds: RectangleBounds \| null\)[\s\S]*providerUsageOverlayBounds = bounds/,
  );
  assert.doesNotMatch(
    workspace,
    /setNativeOverlayOpen\(bounds: RectangleBounds \| null\)[\s\S]{0,500}setBrowserSuspensionReason\("provider-usage"/,
  );
  assert.match(
    workspace,
    /const globallySuspended = this\.browserSuspensionReasons\.size > 0;[\s\S]*const overlapsProviderUsage = this\.providerUsageOverlayBounds[\s\S]*pane\.overlapsNativeOverlay\(this\.providerUsageOverlayBounds\)[\s\S]*pane\.setInteractionSuspended\(globallySuspended \|\| overlapsProviderUsage\)/,
  );
  assert.match(
    workspace,
    /setModalOverlayOpen\(reason: string, open: boolean\)[\s\S]*setBrowserSuspensionReason\(`modal:\$\{reason\}`, open\)/,
  );
  assert.match(main, /setModalOverlayOpen\("settings", open\)/);
  assert.match(
    main,
    /async function restartForProviderAccountSwitch\(provider: AgentProvider\)[\s\S]*prepareProviderAccountRestart\(provider\)[\s\S]*invoke\("shutdown_terminal_engine"\)[\s\S]*invoke\("restart_application"\)/,
  );
  assert.match(
    main,
    /restartForProviderAccountSwitch[\s\S]*rollbackProviderAccountRestart\(\)/,
  );
  assert.match(
    workspaceController,
    /assertProviderAccountRestartReady\(\)[\s\S]*prepareProviderAccountRestart[\s\S]*providerAccountRestartRollback = structuredClone\(state\)[\s\S]*rollbackProviderAccountRestart\(\)/,
  );

  assert.match(
    styles,
    /\.provider-usage-item:focus-visible\s*\{[\s\S]*?outline:/,
  );
  assert.match(
    styles,
    /\.statusbar\s*\{[\s\S]*?position:\s*relative;[\s\S]*?overflow:\s*visible;/,
  );
  assert.match(
    styles,
    /\.provider-usage-popover\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(100% \+ 7px\);[\s\S]*?max-height:\s*calc\(100vh - 52px\);[\s\S]*?animation:\s*provider-popover-rise/,
  );
  assert.match(styles, /\.provider-usage-detail-meter::-webkit-progress-value/);
  assert.match(
    styles,
    /\.provider-usage-popover-close\s*\{[\s\S]*?margin-left:\s*auto;[\s\S]*?background:\s*transparent;/,
  );
  assert.match(styles, /\.provider-usage-popover-close:disabled\s*\{[\s\S]*?cursor:\s*wait;/);
  assert.match(
    styles,
    /@keyframes provider-popover-rise\s*\{[\s\S]*?translateY\(6px\)[\s\S]*?translateY\(0\)/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.provider-usage-popover\s*\{[\s\S]*?animation-duration:\s*1ms/,
  );

  const handler = backend.match(
    /\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/,
  );
  assert.ok(handler);
  for (const command of [
    "list_provider_accounts",
    "add_provider_account",
    "cancel_provider_account_login",
    "switch_provider_account",
    "restart_application",
  ]) {
    assert.match(handler[1], new RegExp(`\\b${command}\\b`));
  }

  assert.match(
    backend,
    /fn read_provider_account\([\s\S]*webview: Webview[\s\S]*ensure_agent_main_webview\(&webview\)\?/,
  );
  assert.match(backend, /read_provider_account,[\s\S]*play_completion_sound/);
  const summaryStart = providerUsage.indexOf("pub(crate) struct ProviderAccountSummary");
  const summaryEnd = providerUsage.indexOf("pub(crate) struct ProviderLimitUsage", summaryStart);
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart);
  const summary = providerUsage.slice(summaryStart, summaryEnd);
  assert.match(summary, /display_label:[\s\S]*plan:[\s\S]*auth_mode:/);
  assert.doesNotMatch(summary, /token|account_id|user_id|team_id|path/);
  assert.match(providerUsage, /const AUTH_FILE_MAX_BYTES: usize = 128 \* 1024/);
  assert.match(providerUsage, /fn read_bounded_auth<T: DeserializeOwned>/);
  assert.match(providerUsage, /bytes\.fill\(0\)/);
  assert.match(providerUsage, /environment_api_key_account/);
});

test("native Explorer drops attach to the hit-tested terminal without submitting", async () => {
  const [main, styles] = await Promise.all([
    source("src/main.ts"),
    source("src/styles.css"),
  ]);
  assert.match(main, /getCurrentWebview,[\s\S]*?type DragDropEvent/);
  assert.match(
    main,
    /getCurrentWebview\(\)[\s\S]*?onDragDropEvent\(\(\{ payload \}\) => this\.handleNativeFileDrop\(payload\)\)/,
  );
  assert.match(
    main,
    /payload\.type === "leave"[\s\S]*?payload\.type === "enter"[\s\S]*?payload\.type === "over"[\s\S]*?selectDroppedFilePaths\(payload\.paths\)/,
  );
  assert.match(
    main,
    /position\.toLogical\(this\.nativeFileDropScaleFactor\)[\s\S]*?document\.elementFromPoint\(logical\.x, logical\.y\)[\s\S]*?closest<HTMLElement>\("\.terminal-pane"\)[\s\S]*?this\.panes\.get\(paneId\)/,
  );
  assert.match(main, /onScaleChanged\(\(\{ payload \}\)/);
  assert.match(main, /nativeFileDropUnlisteners\.splice\(0\)/);

  const attachStart = main.indexOf("async attachDroppedFiles(");
  const attachEnd = main.indexOf("setActive(active: boolean)", attachStart);
  assert.ok(attachStart >= 0 && attachEnd > attachStart);
  const attach = main.slice(attachStart, attachEnd);
  assert.match(
    attach,
    /const commit = this\.reserveInputSlot\(\)[\s\S]*?detectDroppedFileProvider\(\)[\s\S]*?paths[\s\S]*?prepareTerminalPaste\([\s\S]*?formatDroppedFileReference\(provider, path\)[\s\S]*?bracketed[\s\S]*?commit\(\{ kind: "text", data \}\)/,
  );
  assert.doesNotMatch(attach, /data:\s*["'](?:\\r|\\n)["']/);
  assert.match(
    styles,
    /\.terminal-file-drop-overlay\s*\{[\s\S]*?pointer-events:\s*none[\s\S]*?border:\s*1px dashed #4a4a4a/,
  );
  assert.match(
    styles,
    /\.terminal-pane\[data-file-drop-target="true"\] \.terminal-file-drop-overlay[\s\S]*?visibility:\s*visible[\s\S]*?opacity:\s*1/,
  );
});

test("Discord phone notifications keep webhooks private and bind display names exactly", async () => {
  const [main, html, styles, backend] = await Promise.all([
    source("src/main.ts"),
    source("index.html"),
    source("src/styles.css"),
    source("src-tauri/src/phone_notify.rs"),
  ]);

  assert.match(html, /id="open-settings"/);
  assert.match(html, /id="settings-dialog"[\s\S]*aria-labelledby="settings-title"/);
  assert.match(html, /id="settings-title"[\s\S]*data-i18n-en="Settings"[\s\S]*data-i18n-ko="환경설정"/);
  assert.match(html, /class="settings-section"[\s\S]*aria-labelledby="discord-notification-settings-title"/);
  assert.match(
    html,
    /id="discord-notification-settings-title"[\s\S]*data-i18n-en="Discord notifications"[\s\S]*data-i18n-ko="Discord 휴대폰 알림"/,
  );
  assert.doesNotMatch(html, /id="open-phone-notifications"|phone-notification-sidebar-status/);
  assert.match(html, /id="phone-notification-webhook"[\s\S]*type="password"/);
  assert.match(html, /id="remove-phone-notification-webhook"/);
  assert.match(html, /data-i18n-en="2\. Under Integrations → Webhooks[\s\S]*data-i18n-ko="2\. 연동 → 웹후크에서 웹후크를 만들고 URL 복사/);
  assert.match(
    html,
    /data-i18n-en="Only the project name, CLI name[\s\S]*data-i18n-ko="프로젝트명, CLI 이름, 완료\/오류 상태만 전송합니다[\s\S]*경로, PID, 프롬프트, 답변과 원문 오류는 보내지 않습니다/,
  );
  assert.doesNotMatch(html, /비공개 토픽|phone-notification-topic/);
  assert.match(styles, /\.settings-button\s*\{[\s\S]*grid-template-columns/);
  assert.match(styles, /\.settings-dialog\s*\{/);
  assert.match(styles, /\.settings-section\s*\{[\s\S]*border:\s*1px solid var\(--line\)/);
  assert.match(styles, /\.phone-notification-webhook-heading span\[data-configured="true"\]/);

  assert.match(main, /invoke<unknown>\("load_phone_notification_settings"\)/);
  assert.match(main, /invoke<unknown>\("save_phone_notification_settings", \{ settings: next \}\)/);
  assert.match(main, /webhookUrl:\s*string \| null/);
  assert.match(main, /clearWebhook:\s*boolean/);
  assert.match(main, /webhookConfigured:\s*boolean/);
  assert.doesNotMatch(main, /topicInput|renderAddress|copyTopic/);
  const backgroundStart = main.indexOf("async sendBackground(");
  const backgroundEnd = main.indexOf("private async load()", backgroundStart);
  assert.ok(backgroundStart >= 0 && backgroundEnd > backgroundStart);
  const backgroundSend = main.slice(backgroundStart, backgroundEnd);
  assert.match(backgroundSend, /deliveryQueue\.push\(\{ kind, eventId, labels \}\)/);
  assert.match(backgroundSend, /while \(!this\.disposed\)[\s\S]*deliveryQueue\.shift\(\)[\s\S]*await this\.deliverWithRetry\(delivery\)/);
  assert.match(backgroundSend, /projectName:\s*delivery\.labels\.projectName/);
  assert.match(backgroundSend, /terminalName:\s*delivery\.labels\.terminalName/);
  assert.match(backgroundSend, /language:\s*getAppLanguage\(\)/);
  assert.match(backgroundSend, /PHONE_NOTIFICATION_RETRY_DELAYS_MS\[attempt\]/);
  assert.match(main, /PHONE_NOTIFICATION_RETRY_DELAYS_MS = \[1_500, 4_000\]/);
  assert.match(main, /dispose\(\)[\s\S]*deliveryQueue\.length = 0[\s\S]*retryWaiters/);
  assert.doesNotMatch(backgroundSend, /projectId|terminalId|conversationId|prompt|output|path|token/);

  assert.match(
    main,
    /phoneNotificationLabels\([\s\S]*?projectNames\.get\(projectId\)[\s\S]*?panes\.get\(paneRuntimeId\(projectId, terminalId\)\)[\s\S]*?terminalName: pane\.title/,
  );

  const agentController = main.slice(
    main.indexOf("class AgentEventController"),
    main.indexOf("async function stopBackendSession"),
  );
  assert.match(
    agentController,
    /if \(event === "turnFinished"\)[\s\S]*phoneTurnKey = agentTurnPhoneNotificationEventId\([\s\S]*conversationId,[\s\S]*turnId,[\s\S]*notificationObservedAtUnixMs \?\? observedAtUnixMs[\s\S]*phoneNotifiedFinishedTurns\.has[\s\S]*phoneNotificationLabels\(projectId, terminalId\)[\s\S]*sendBackground\([\s\S]*succeeded \? "success" : "error"[\s\S]*phoneTurnKey/,
  );
  assert.match(agentController, /phoneNotifiedFinishedTurns\.size > 512/);
  assert.match(
    agentController,
    /const labels = this\.workspace\.phoneNotificationLabels\(projectId, terminalId\);[\s\S]*?if \(labels\) \{[\s\S]*?phoneNotifiedFinishedTurns\.add\(phoneTurnKey\)[\s\S]*?sendBackground/,
  );
  assert.doesNotMatch(
    agentController,
    /phoneNotifiedFinishedTurns\.add\(phoneTurnKey\)[\s\S]*?const labels = this\.workspace\.phoneNotificationLabels/,
  );
  assert.match(
    main,
    /function agentTurnPhoneNotificationEventId\([\s\S]*if \(turnId !== null\)[\s\S]*return `agent-turn:v2:\$\{provider\}:\$\{conversationId\.toLowerCase\(\)\}:\$\{turnId\}`[\s\S]*return `agent-turn:v1:\$\{provider\}:\$\{conversationId\.toLowerCase\(\)\}:\$\{observedAtUnixMs\}`/,
  );
  assert.match(
    main,
    /private notifyPhoneErrorOnce\(\)[\s\S]*phoneErrorNotifiedEpoch === this\.lifecycleEpoch[\s\S]*phoneNotificationLabels\([\s\S]*this\.projectId[\s\S]*this\.terminalId[\s\S]*createPhoneNotificationEventId\("terminal"\)/,
  );
  assert.match(
    main,
    /exit\.exitCode !== null && exit\.exitCode !== 0[\s\S]*this\.notifyPhoneErrorOnce\(\)[\s\S]*this\.setState\([\s\S]*"exited"/,
  );
  assert.match(main, /if \(this\.disposed \|\| this\.phoneErrorNotifiedEpoch === this\.lifecycleEpoch\) return/);
  assert.match(main, /return `\$\{prefix\}:\$\{Date\.now\(\)\}:\$\{phoneNotificationEventSequence\}`/);

  assert.match(backend, /protected_webhook:\s*Option<String>/);
  assert.match(backend, /CryptProtectData/);
  assert.match(backend, /Only official Discord webhook hosts are supported/);
  assert.match(backend, /project_name:\s*String/);
  assert.match(backend, /terminal_name:\s*String/);
  assert.match(backend, /language:\s*Option<String>/);
  assert.match(backend, /"allowed_mentions": \{ "parse": \[\] \}/);
  assert.doesNotMatch(backend, /WinHttpQueryDataAvailable|WinHttpReadData/);
  assert.doesNotMatch(backend, /request\.(prompt|output|path|conversation|token|error_message)/i);
});

test("new Codex and Grok conversations are discovered, saved, and resumable", async () => {
  const [main, controller, backend, notifier] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("src-tauri/src/agent_runtime.rs"),
    source("src-tauri/src/codex_notify.rs"),
  ]);
  assert.match(main, /invoke<AgentDiscoveryResponse \| null>\(\s*"discover_agent_conversation"/);
  assert.match(main, /associateAgentConversation\([\s\S]*onAgentConversationDiscoveredCallback/);
  assert.match(main, /onAgentConversationDiscoveredCallback\([\s\S]*bind_agent_session/);
  assert.match(main, /type PendingAgentCompletionRoute = \{\s*provider: AgentProvider/);
  assert.doesNotMatch(main, /PendingCodexCompletionRoute|pendingCodexCompletionRoute/);
  assert.match(main, /acknowledge_codex_completion/);
  assert.match(main, /acknowledge_grok_completion/);
  assert.match(
    main,
    /completionObservedAtUnixMs !== null[\s\S]*pane\.queueAgentCompletion\([\s\S]*\{\s*provider,\s*runtimeSessionId,\s*conversationId,\s*turnId: null,\s*observedAtUnixMs: completionObservedAtUnixMs/,
  );
  assert.match(main, /completionObservedAtUnixMs/);
  assert.match(main, /RESUME_HEALTH_DELAYS_MS = \[2_500, 5_000, 7_500, 10_000\]/);
  assert.match(
    main,
    /scheduleResumeHealthCheck\(\)[\s\S]*detect_terminal_agent[\s\S]*detachFailedResume/,
  );
  assert.match(
    main,
    /detachFailedResume\([\s\S]*unbind_agent_session[\s\S]*agentConversationBound = false[\s\S]*scheduleAgentDiscovery\(true\)/,
  );
  assert.match(
    controller,
    /onAgentConversationDiscovered\([\s\S]*setTerminalAgentConversation\([\s\S]*persistNow/,
  );
  assert.match(backend, /discover_unowned_conversation/);
  assert.match(backend, /codex_root_conversation_matches/);
  assert.match(backend, /read_codex_root_metadata/);
  assert.match(backend, /read_grok_session_metadata/);
  assert.match(notifier, /agent-turn-complete/);
  assert.match(notifier, /IHATECODING_CODEX_NOTIFY_ROUTE/);
});

test("terminal web links open a persisted browser pane without hijacking selection", async () => {
  const [main, controller, packageSource] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("package.json"),
  ]);
  assert.equal(
    JSON.parse(packageSource).dependencies["@xterm/addon-web-links"],
    "0.13.0-beta.290",
  );
  assert.match(main, /import \{ WebLinksAddon \} from "@xterm\/addon-web-links"/);
  assert.match(
    main,
    /const openWebLink = \(event: MouseEvent, uri: string\)[\s\S]*?event\.button !== 0[\s\S]*?this\.terminal\.hasSelection\(\)[\s\S]*?parsed\.protocol !== "http:"[\s\S]*?parsed\.protocol !== "https:"[\s\S]*?this\.workspace\.openTerminalWebLink\(this\.projectId, uri\)/,
  );
  assert.match(
    main,
    /const linkActivationVersion = this\.webLinkActivationVersion[\s\S]*?this\.webLinkActivationVersion !== linkActivationVersion[\s\S]*?this\.moveCursorFromClick/,
  );
  assert.match(
    main,
    /linkHandler:\s*\{[\s\S]*?activate:\s*openWebLink[\s\S]*?allowNonHttpProtocols:\s*false/,
  );
  assert.match(main, /new WebLinksAddon\(openWebLink/);
  assert.match(
    main,
    /openTerminalWebLink\(projectId: string, url: string\)[\s\S]*?projectId !== this\.activeProjectId[\s\S]*?onTerminalWebLinkOpenedCallback\(projectId, url\)/,
  );

  const linkStart = controller.indexOf("async addBrowserPaneFromLink(");
  const linkEnd = controller.indexOf("private async persist", linkStart);
  assert.ok(linkStart >= 0 && linkEnd > linkStart);
  const linkPane = controller.slice(linkStart, linkEnd);
  assert.match(linkPane, /state\.projects\.find\(\(item\) => item\.id === projectId\)/);
  assert.match(linkPane, /createWorkspaceBrowserPane\(this\.idFactory\(\), "WEB", url\)/);
  assert.match(
    linkPane,
    /appendProjectBrowserPane\(state, project\.id, browser\)[\s\S]*?await this\.persist\([\s\S]*?this\.runtime\.addBrowserPane\(project\.id, browser, true\)/,
  );
  assert.match(
    main,
    /controller\?\.addBrowserPaneFromLink\(projectId, url\) \?\? Promise\.resolve\(\)/,
  );
});

test("opt-in idle agent sleep preserves the active project and resumes only durable conversations", async () => {
  const [main, optimization, backend, pty, html] = await Promise.all([
    source("src/main.ts"),
    source("src/optimization-settings.ts"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/pty.rs"),
    source("index.html"),
  ]);
  assert.match(optimization, /autoSleepIdleAgents:\s*false/);
  assert.match(optimization, /agentTurnState !== "idle"/);
  assert.match(html, /id="settings-optimization-tab"[\s\S]*id="auto-sleep-idle-agents"/);
  assert.match(main, /pane\.projectId === this\.activeProjectId/);
  assert.match(main, /plan\?\.action === "resume"/);
  assert.match(main, /this\.agentInputAwaitingTurnStart = true[\s\S]*resolveInput\(input\)/);
  assert.match(main, /shouldReleaseAgentInputProtection\([\s\S]*this\.agentInputAwaitingTurnStart = false/);
  assert.match(main, /pane\.setAgentTurnWorking\(working, turnId, observedAtUnixMs\)/);
  assert.match(main, /!this\.agentInputAwaitingTurnStart[\s\S]*inactiveAgentSleepDeadline/);
  assert.match(main, /invoke<AgentProvider \| null>\("detect_terminal_agent"/);
  assert.match(main, /sleepingPaneIds\.has\(paneRuntimeId\(project\.id, terminal\.id\)\)/);
  assert.match(main, /sleepingPaneIds\.delete\(paneId\)[\s\S]*addPane\(project\.id, terminal, false, true\)/);
  assert.match(main, /if \(!enabled\)[\s\S]*projectTerminalStates[\s\S]*sleepingPaneIds\.delete\(paneId\)[\s\S]*addPane\(projectId, terminal, false, true\)/);
  assert.match(main, /resumedFromAutoSleep[\s\S]*this\.agentTurnState = "idle"/);
  assert.match(main, /retryDelaysMs[\s\S]*invoke\("stop_terminal_and_wait"/);
  assert.match(main, /autoSleepStopBarriers\.get\(pane\.id\)[\s\S]*pane\.startAfter/);
  assert.doesNotMatch(main, /appendStopBarrier\(stop\)[\s\S]*Automatic CLI sleep/);
  assert.match(main, /disposeForAutoSleep[\s\S]*stopBackendSessionAndWait/);
  assert.match(backend, /async fn stop_terminal_and_wait/);
  assert.match(pty, /pub\(crate\) fn stop_and_wait[\s\S]*while state\.sessions\.contains_key/);
  assert.match(
    pty,
    /agent_runtime\.unbind\(&wait_id\);[\s\S]*remove_session\(&manager_state, &manager_state_changed, &wait_id\)/,
  );

  const browserStart = main.indexOf("class BrowserPane");
  const browserEnd = main.indexOf("type LayoutPane", browserStart);
  assert.ok(browserStart >= 0 && browserEnd > browserStart);
  const browserPane = main.slice(browserStart, browserEnd);
  assert.match(optimization, /function inactiveBrowserSleepDeadline\(/);
  assert.match(
    browserPane,
    /hibernate\(\): Promise<void>[\s\S]*?this\.operationQueue[\s\S]*?this\.hibernateNow\(\)/,
    "browser sleep must be serialized with navigation and URL persistence",
  );
  assert.match(
    browserPane,
    /private async hibernateNow\(\): Promise<void>[\s\S]*?captureCurrentUrlNow\(\)[\s\S]*?this\.currentUrl !== this\.persistedUrl[\s\S]*?this\.webview = null[\s\S]*?await webview\.close\(\)/,
    "browser sleep must persist the latest address before closing only its native WebView",
  );
  const hibernateNowStart = browserPane.indexOf("private async hibernateNow()");
  const hibernateNowEnd = browserPane.indexOf("private async wakeNow()", hibernateNowStart);
  assert.ok(hibernateNowStart >= 0 && hibernateNowEnd > hibernateNowStart);
  const hibernateNow = browserPane.slice(hibernateNowStart, hibernateNowEnd);
  const boundsAwait = hibernateNow.indexOf("await this.boundsQueue");
  const closeWebview = hibernateNow.indexOf("await webview.close()");
  const finalCancellationCheck = hibernateNow.lastIndexOf("!this.desiredSleep", closeWebview);
  const unwatchWebview = hibernateNow.indexOf("await this.workspace.unwatchBrowserWebviewUrl");
  assert.ok(boundsAwait >= 0 && closeWebview > boundsAwait);
  assert.ok(
    finalCancellationCheck > boundsAwait && finalCancellationCheck < closeWebview,
    "sleep cancellation must be rechecked after all hide/bounds awaits and immediately before close",
  );
  assert.ok(
    unwatchWebview > closeWebview,
    "the URL watcher registry must be forgotten only after the native WebView closes successfully",
  );

  const closeCatchStart = hibernateNow.indexOf("} catch (error) {", closeWebview);
  const closeCatchEnd = hibernateNow.indexOf("throw error", closeCatchStart);
  assert.ok(closeCatchStart > closeWebview && closeCatchEnd > closeCatchStart);
  const closeCatch = hibernateNow.slice(closeCatchStart, closeCatchEnd);
  assert.doesNotMatch(
    closeCatch,
    /if \([^)]*desiredSleep/,
    "close failure rollback must not depend on whether a concurrent wake cleared desiredSleep",
  );
  assert.match(
    closeCatch,
    /this\.restoreHibernatingWebview\(webview, urlSyncFallbackWasEnabled\)/,
  );
  const restoreStart = hibernateNow.indexOf("private restoreHibernatingWebview(");
  const restoreEnd = hibernateNow.length;
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const restoreHibernatingWebview = hibernateNow.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(restoreHibernatingWebview, /if \([^)]*desiredSleep/);
  assert.match(restoreHibernatingWebview, /this\.webview = webview/);
  assert.match(restoreHibernatingWebview, /this\.hibernated = false/);
  assert.match(restoreHibernatingWebview, /this\.desiredSleep = false/);
  assert.match(restoreHibernatingWebview, /delete this\.element\.dataset\.hibernated/);
  assert.match(
    browserPane,
    /wake\(\): Promise<void>[\s\S]*?this\.operationQueue[\s\S]*?this\.wakeNow\(\)/,
    "browser wake must be serialized behind any pending sleep operation",
  );
  assert.match(
    browserPane,
    /private async wakeNow\(\): Promise<void>[\s\S]*?this\.currentUrl = this\.persistedUrl[\s\S]*?replaceWebview\(this\.persistedUrl\)/,
    "waking a browser pane must recreate it from its last persisted URL",
  );

  const sweepStart = main.indexOf("private async sweepInactiveAgentPanes");
  const sweepEnd = main.indexOf("private hibernateInactiveAgentPane", sweepStart);
  assert.ok(sweepStart >= 0 && sweepEnd > sweepStart);
  const sweep = main.slice(sweepStart, sweepEnd);
  assert.match(sweep, /for \(const pane of \[\.\.\.this\.browserPanes\.values\(\)\]\)/);
  assert.match(sweep, /inactiveBrowserSleepDeadline\(/);
  assert.match(sweep, /pane\.projectId === this\.activeProjectId/);
  assert.match(sweep, /await pane\.hibernate\(\)/);

  const showProjectStart = main.indexOf("showProject(project: WorkspaceProject)");
  const showProjectEnd = main.indexOf("showEmptyView()", showProjectStart);
  assert.ok(showProjectStart >= 0 && showProjectEnd > showProjectStart);
  const showProject = main.slice(showProjectStart, showProjectEnd);
  assert.match(
    showProject,
    /this\.activeProjectId = project\.id[\s\S]*?browserPanes[\s\S]*?pane\.projectId === project\.id[\s\S]*?pane\.wake\(\)/,
    "returning to a project must wake its retained browser panes",
  );

  const toggleStart = main.indexOf("setAutoSleepIdleAgents(enabled: boolean)");
  const toggleEnd = main.indexOf("syncProject(project: WorkspaceProject)", toggleStart);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
  const toggle = main.slice(toggleStart, toggleEnd);
  assert.match(
    toggle,
    /if \(!enabled\)[\s\S]*?browserPanes\.values\(\)[\s\S]*?pane\.wake\(\)/,
    "turning session sleep off must immediately wake every retained browser pane",
  );
});

test("application chrome stays monochrome except for completion alerts", async () => {
  const styles = await source("src/styles.css");
  const completionAccentColors = new Set([
    "c7a34e",
    "e7c15f",
    "8b743d",
    "f4d57a",
    "211c10",
  ]);
  const colors = [...styles.matchAll(/#([0-9a-f]{3,8})\b/gi)].map((match) => match[1]);
  assert.ok(colors.length > 0);
  for (const color of colors) {
    if (completionAccentColors.has(color.toLowerCase())) continue;
    const rgb = color.length === 3 || color.length === 4
      ? [...color.slice(0, 3)].map((channel) => Number.parseInt(channel + channel, 16))
      : [0, 2, 4].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
    assert.equal(
      Math.max(...rgb) - Math.min(...rgb),
      0,
      `non-monochrome application color #${color}`,
    );
  }
});
