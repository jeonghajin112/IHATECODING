import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/media-browser-core.ts", import.meta.url))],
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
const media = await import(moduleUrl);

test("media browser wire responses are bounded and normalized", () => {
  const grant = media.normalizeMediaRootGrant({
    grantId: "grant-1",
    rootName: "Pictures",
    rootPath: String.raw`C:\Users\example\Pictures`,
    initialPathSegments: ["Users", "example", "Pictures"],
    focusFileName: "capture.png",
  });
  assert.equal(grant.rootName, "Pictures");
  assert.equal(grant.focusFileName, "capture.png");

  const volumes = media.normalizeMediaVolumeList([
    {
      grantId: "volume-c",
      rootName: "C:\\",
      rootPath: "C:\\",
    },
    {
      grantId: "volume-d",
      rootName: "D:\\",
      rootPath: "D:\\",
    },
  ]);
  assert.deepEqual(volumes.map((volume) => volume.rootPath), ["C:\\", "D:\\"]);

  const response = media.normalizeMediaDirectoryResponse({
    grantId: grant.grantId,
    rootName: grant.rootName,
    pathSegments: ["Screenshots"],
    entries: [
      {
        name: "Archive",
        pathSegments: ["Screenshots", "Archive"],
        kind: "directory",
        sizeBytes: null,
        previewPath: null,
        openable: true,
      },
      {
        name: "capture.png",
        pathSegments: ["Screenshots", "capture.png"],
        kind: "image",
        sizeBytes: 1024,
        previewPath: String.raw`C:\Users\example\Pictures\Screenshots\capture.png`,
        openable: true,
      },
      {
        name: "notes.md",
        pathSegments: ["Screenshots", "notes.md"],
        kind: "file",
        sizeBytes: 2048,
        previewPath: null,
        openable: true,
      },
    ],
    truncated: false,
  });
  assert.deepEqual(response.entries.map((entry) => entry.kind), ["directory", "image", "file"]);
  assert.notEqual(response.pathSegments, response.entries[0].pathSegments);

  assert.throws(() => media.normalizeMediaDirectoryResponse({
    ...response,
    entries: [{ ...response.entries[1], kind: "executable" }],
  }));
  assert.throws(() => media.normalizeResolvedMediaFiles(Array(21).fill("C:\\file.png")));
  assert.throws(() => media.normalizeMediaVolumeList(Array(65).fill(volumes[0])));
});

test("media selection toggles and stops at the attachment limit", () => {
  let keys = [];
  for (let index = 0; index < media.MAX_MEDIA_SELECTION; index += 1) {
    const result = media.appendMediaSelection(keys, `media-${index}`);
    assert.equal(result.changed, true);
    keys = result.keys;
  }
  const full = media.appendMediaSelection(keys, "overflow");
  assert.equal(full.changed, false);
  assert.equal(full.full, true);
  const removed = media.appendMediaSelection(keys, "media-3");
  assert.equal(removed.changed, true);
  assert.equal(removed.keys.includes("media-3"), false);
});

test("Ctrl+Space drawer is wired to secure media IPC and the active terminal attachment path", async () => {
  const [html, main, drawer, backend, lib, picker, styles, config, cargo] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/media-drawer.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/media_browser.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/browser_ui_pick.js", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="workspace-stage"[\s\S]*id="terminal-surface"[\s\S]*id="media-drawer-layer"[\s\S]*role="listbox"/);
  assert.match(html, /aria-keyshortcuts="Control\+Space"/);
  assert.match(html, /id="media-drawer"[\s\S]*role="region"[\s\S]*id="media-drawer-grid"[\s\S]*tabindex="-1"/);
  assert.match(html, /id="media-drawer-title"[\s\S]*Content browser/);
  assert.match(html, /id="media-drawer-path-form"[\s\S]*id="media-drawer-path"[\s\S]*type="text"/);
  assert.match(html, /id="media-drawer-collapse"[\s\S]*>ㅡ<\/button>/);
  assert.match(
    html,
    /id="content-entry-menu"[\s\S]*id="content-entry-attach"[\s\S]*id="content-entry-open"[\s\S]*id="content-entry-reveal"[\s\S]*id="content-entry-copy-path"[\s\S]*id="content-entry-copy-name"[\s\S]*id="content-entry-delete"/,
  );
  assert.match(
    html,
    /id="content-file-delete-dialog"[\s\S]*id="cancel-content-file-delete"[\s\S]*id="confirm-content-file-delete"/,
  );
  assert.doesNotMatch(html, /id="media-drawer-(?:project|folder|up|scrim)"/);
  assert.doesNotMatch(html, /media-drawer-(?:footer|selection|status|shortcut|attach|refresh|close)/);
  assert.match(main, /new MediaDrawer\([\s\S]*attachFiles:\s*\(paths\) => workspace\.attachFilesToActivePane\(paths\)/);
  assert.match(main, /attachFilesToActivePane\([\s\S]*selectDroppedFilePaths\(candidates\)[\s\S]*pane\.attachDroppedFiles/);
  assert.match(
    main,
    /previewDropTarget:\s*\(paneId\) => workspace\.setContentBrowserFileDropTarget\(paneId\)[\s\S]*attachFilesToPane:\s*\(paneId, paths\) => workspace\.attachFilesToPane\(paneId, paths\)/,
  );
  assert.match(drawer, /private onWindowKeyDown[\s\S]*preventDefault\(\)[\s\S]*stopImmediatePropagation\(\)/);
  assert.match(drawer, /private isToggleShortcut[\s\S]*event\.code === "Space"/);
  assert.match(drawer, /listen\("media-drawer-toggle-requested"/);
  assert.match(drawer, /invoke<unknown>\("open_media_location"/);
  assert.match(drawer, /invoke<unknown>\("list_media_volumes"/);
  assert.match(drawer, /invoke<unknown>\("list_media_directory"/);
  assert.match(drawer, /invoke<unknown>\("resolve_media_files"/);
  assert.match(drawer, /Math\.hypot\([\s\S]*< 6/);
  assert.match(drawer, /setPointerCapture\(event\.pointerId\)/);
  assert.match(drawer, /document\.elementsFromPoint\(clientX, clientY\)[\s\S]*\.terminal-pane\[data-pane-id\]/);
  assert.match(drawer, /this\.callbacks\.attachFilesToPane\(paneId, \[path\]\)/);
  assert.doesNotMatch(
    drawer,
    /\.draggable\s*=\s*true|setAttribute\(["']draggable["'],\s*["']true["']/,
  );
  for (const command of [
    "open_content_entry",
    "reveal_content_entry",
    "resolve_content_entry_path",
    "delete_content_file",
  ]) {
    assert.match(drawer, new RegExp(`invoke(?:<unknown>)?\\(\\"${command}\\"`));
  }
  assert.match(drawer, /pathInput\.addEventListener\("paste"/);
  assert.match(drawer, /grant\.focusFileName/);
  assert.match(drawer, /private renderVolumes/);
  assert.match(drawer, /IntersectionObserver/);
  assert.match(drawer, /card\.tabIndex = initiallyFocusable \? 0 : -1/);
  assert.match(drawer, /dataset\.action = "parent"/);
  assert.match(drawer, /this\.elements\.stage\.dataset\.mediaDrawerOpen = "true"/);
  assert.doesNotMatch(drawer, /setOverlayOpen|chooseExternalFolder|openProjectFolder/);
  assert.match(drawer, /this\.requestGeneration \+= 1;\s*this\.loading = false;/);
  assert.match(drawer, /if \(!this\.opened \|\| this\.disposed \|\| generation !== this\.requestGeneration\) return;/);
  assert.doesNotMatch(drawer, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(backend, /struct MediaBrowserService/);
  assert.match(backend, /MAX_CONTENT_SELECTIONS:\s*usize\s*=\s*20/);
  assert.match(backend, /MAX_IMAGE_PREVIEW_BYTES/);
  assert.match(backend, /asset_protocol_scope\(\)/);
  assert.match(lib, /mod media_browser;/);
  assert.match(
    lib,
    /generate_handler!\[[\s\S]*open_media_location[\s\S]*list_media_volumes[\s\S]*list_media_directory[\s\S]*resolve_media_files[\s\S]*open_content_entry[\s\S]*reveal_content_entry[\s\S]*resolve_content_entry_path[\s\S]*delete_content_file/,
  );
  assert.match(backend, /MediaEntryKind::File/);
  assert.match(backend, /openable:\s*bool/);
  assert.match(backend, /metadata\.is_file\(\)[\s\S]*content_entry_kind/);
  assert.match(backend, /is_unsafe_open_path[\s\S]*UnsafeFileType/);
  assert.match(backend, /ExpectedMediaPathKind::File[\s\S]*fs::remove_file/);
  assert.match(
    backend,
    /delete_verified_regular_file[\s\S]*FILE_FLAG_OPEN_REPARSE_POINT[\s\S]*SetFileInformationByHandle/,
  );
  assert.match(picker, /event\.isTrusted[\s\S]*ihc-media-drawer-toggle/);
  assert.match(styles, /\.workspace-stage\[data-media-drawer-open="true"\][\s\S]*grid-template-rows/);
  assert.match(styles, /\.media-drawer-layer\s*\{[\s\S]*grid-area:\s*2 \/ 1/);
  assert.match(styles, /\.media-drawer\s*\{[\s\S]*transform:\s*translateY/);
  assert.match(styles, /\.media-drawer-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fill/);
  assert.match(styles, /\.content-entry-menu\s*\{[\s\S]*position:\s*fixed/);
  assert.match(styles, /\.content-file-drag-ghost\s*\{[\s\S]*pointer-events:\s*none/);
  const parsedConfig = JSON.parse(config);
  assert.equal(parsedConfig.app.security.assetProtocol.enable, true);
  assert.match(parsedConfig.app.security.csp, /img-src 'self' asset: http:\/\/asset\.localhost https:\/\/asset\.localhost/);
  assert.match(parsedConfig.app.security.csp, /media-src 'self' asset: http:\/\/asset\.localhost https:\/\/asset\.localhost/);
  assert.match(cargo, /"protocol-asset"/);
});
