import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relative) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

function method(sourceText, startMarker, endMarker) {
  const start = sourceText.indexOf(startMarker);
  const end = sourceText.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker}`);
  return sourceText.slice(start, end);
}

function assertOrdered(sourceText, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = sourceText.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must follow the previous preview step`);
    cursor = next;
  }
}

test("settings captures and paints visible browser previews before awaiting native hide", async () => {
  const main = await source("src/main.ts");
  const paneCapture = method(
    main,
    "  async prepareSettingsPreview(): Promise<void>",
    "  async waitUntilNativeHiddenForSettings(): Promise<void>",
  );
  assertOrdered(paneCapture, [
    'invoke<string>("capture_browser_webview_preview"',
    "await image.decode()",
    "this.viewport.append(preview)",
    "await nextAnimationFrame()",
  ]);
  assert.match(paneCapture, /renderSettingsPreviewUnavailable\(preview\)/);

  const workspaceCapture = method(
    main,
    "  async prepareSettingsModal(): Promise<void>",
    "  async restoreSettingsModal(): Promise<void>",
  );
  assertOrdered(workspaceCapture, [
    "pane.prepareSettingsPreview()",
    'this.setBrowserSuspensionReason("modal:settings", true)',
    "pane.waitUntilNativeHiddenForSettings()",
  ]);
});

test("settings restores native panes before releasing in-memory previews", async () => {
  const main = await source("src/main.ts");
  const paneRestore = method(
    main,
    "  async restoreNativeAfterSettings(): Promise<void>",
    "  clearSettingsPreview() {",
  );
  assertOrdered(paneRestore, [
    "await this.syncBounds(generation, webview)",
    "await nextAnimationFrame()",
    "this.clearSettingsPreview()",
  ]);

  const workspaceRestore = method(
    main,
    "  async restoreSettingsModal(): Promise<void>",
    "  private projectPaneCount",
  );
  assertOrdered(workspaceRestore, [
    'this.setBrowserSuspensionReason("modal:settings", false)',
    "pane.restoreNativeAfterSettings()",
  ]);
  assert.match(
    main,
    /open \? workspace\.prepareSettingsModal\(\) : workspace\.restoreSettingsModal\(\)/,
  );
});

test("preview capture stays in memory and capture failure has a non-black explanation", async () => {
  const [nativePreview, nativeLib, main, styles, controller] = await Promise.all([
    source("src-tauri/src/browser_preview.rs"),
    source("src-tauri/src/lib.rs"),
    source("src/main.ts"),
    source("src/styles.css"),
    source("src/phase4-controller.ts"),
  ]);
  assert.match(nativePreview, /Page\.captureScreenshot/);
  assert.match(nativePreview, /data:image\/png;base64/);
  assert.match(nativePreview, /MAX_BROWSER_PREVIEW_BYTES/);
  assert.doesNotMatch(nativePreview, /std::fs|File::|write_all/);
  assert.match(nativeLib, /capture_browser_webview_preview,/);
  assert.match(main, /Browser preview unavailable/);
  assert.match(
    styles,
    /\.browser-settings-preview\[data-available="false"\][\s\S]*?background:\s*var\(--surface-active\)/,
  );

  assert.match(main, /setModalOverlayOpen\(reason: string, open: boolean\)/);
  assert.match(controller, /setModalOverlayOpen\("project", true\)/);
  assert.match(controller, /setModalOverlayOpen\("upgrade", true\)/);
});
