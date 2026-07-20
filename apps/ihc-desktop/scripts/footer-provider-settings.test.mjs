import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/footer-provider-settings.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;

function installBrowser({ stored = null, readError = null, writeError = null } = {}) {
  const values = new Map();
  if (stored !== null) values.set("ihatecoding.footer-providers.v1", stored);
  const listeners = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => {
        if (readError) throw readError;
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (writeError) throw writeError;
        values.set(key, value);
      },
    },
    addEventListener: (type, listener) => {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    dispatchEvent: (event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  return values;
}

async function loadModule(suffix) {
  return import(`${moduleUrl}#${suffix}`);
}

test("all supported providers have a stable visible default order", async () => {
  installBrowser();
  const settings = await loadModule("defaults");

  assert.deepEqual(settings.getFooterProviderSettings(), {
    order: ["codex", "grok", "claudeCode", "openCode"],
    visible: ["codex", "grok", "claudeCode", "openCode"],
  });
  assert.deepEqual(
    settings.visibleFooterProviders(settings.getFooterProviderSettings()),
    ["codex", "grok", "claudeCode", "openCode"],
  );
  assert.equal(Object.isFrozen(settings.getFooterProviderSettings()), true);
  assert.equal(Object.isFrozen(settings.getFooterProviderSettings().order), true);
});

test("invalid storage fails safely while partial known order gains new providers", async () => {
  installBrowser();
  const settings = await loadModule("normalization");

  for (const invalid of ["nope", "[]", "{}", JSON.stringify({ order: [] })]) {
    assert.deepEqual(
      settings.resolveFooterProviderSettings(invalid),
      settings.DEFAULT_FOOTER_PROVIDER_SETTINGS,
    );
  }

  assert.deepEqual(
    settings.resolveFooterProviderSettings(
      JSON.stringify({
        order: ["grok", "grok", "futureProvider", "codex"],
        visible: [],
      }),
    ),
    {
      order: ["grok", "codex", "claudeCode", "openCode"],
      visible: [],
    },
  );
});

test("visibility changes follow footer order and can hide every provider", async () => {
  installBrowser();
  const settings = await loadModule("visibility");
  const reordered = settings.moveFooterProviderBefore(
    settings.DEFAULT_FOOTER_PROVIDER_SETTINGS,
    "openCode",
    "grok",
  );
  const withoutCodex = settings.withFooterProviderVisibility(
    reordered,
    "codex",
    false,
  );

  assert.deepEqual(reordered.order, ["codex", "openCode", "grok", "claudeCode"]);
  assert.deepEqual(settings.visibleFooterProviders(withoutCodex), [
    "openCode",
    "grok",
    "claudeCode",
  ]);

  const noneVisible = settings.FOOTER_PROVIDER_IDS.reduce(
    (current, provider) =>
      settings.withFooterProviderVisibility(current, provider, false),
    settings.DEFAULT_FOOTER_PROVIDER_SETTINGS,
  );
  assert.deepEqual(settings.visibleFooterProviders(noneVisible), []);
});

test("drag and keyboard reorder helpers are stable at boundaries", async () => {
  installBrowser();
  const settings = await loadModule("reorder");
  const defaults = settings.DEFAULT_FOOTER_PROVIDER_SETTINGS;

  const beforeGrok = settings.moveFooterProviderBefore(defaults, "openCode", "grok");
  assert.deepEqual(beforeGrok.order, ["codex", "openCode", "grok", "claudeCode"]);
  assert.deepEqual(
    settings.moveFooterProviderBefore(beforeGrok, "codex", null).order,
    ["openCode", "grok", "claudeCode", "codex"],
  );
  assert.deepEqual(
    settings.moveFooterProviderByOffset(defaults, "grok", 1).order,
    ["codex", "claudeCode", "grok", "openCode"],
  );
  assert.strictEqual(
    settings.moveFooterProviderByOffset(defaults, "codex", -1),
    defaults,
  );
  assert.strictEqual(
    settings.moveFooterProviderBefore(defaults, "grok", "grok"),
    defaults,
  );
});

test("serialization preserves unknown fields and future provider entries", async () => {
  installBrowser();
  const settings = await loadModule("forward-compatible-serialization");
  const previous = JSON.stringify({
    order: ["futureProvider", "grok", "codex"],
    visible: ["futureProvider", "codex"],
    futureOptions: { density: "compact" },
  });
  const known = settings.resolveFooterProviderSettings(previous);
  const reordered = settings.moveFooterProviderBefore(known, "openCode", "grok");
  const next = JSON.parse(settings.serializeFooterProviderSettings(reordered, previous));

  assert.deepEqual(next.order, [
    "futureProvider",
    "openCode",
    "grok",
    "codex",
    "claudeCode",
  ]);
  assert.deepEqual(next.visible, ["futureProvider", "codex"]);
  assert.deepEqual(next.futureOptions, { density: "compact" });
});

test("stateful updates persist, preserve future state, and notify only on changes", async () => {
  const values = installBrowser({
    stored: JSON.stringify({
      order: ["codex", "futureProvider", "grok"],
      visible: ["codex", "futureProvider", "grok"],
      extensionData: [1, 2, 3],
    }),
  });
  const settings = await loadModule("stateful-updates");
  const observed = [];
  const unsubscribe = settings.subscribeFooterProviderSettings((next) =>
    observed.push(next),
  );

  settings.setFooterProviderVisible("grok", false);
  settings.setFooterProviderVisible("grok", false);
  settings.reorderFooterProvider("openCode", "codex");
  unsubscribe();
  settings.moveFooterProvider("openCode", 1);

  const persisted = JSON.parse(
    values.get(settings.FOOTER_PROVIDER_SETTINGS_STORAGE_KEY),
  );
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[0].visible, ["codex"]);
  assert.deepEqual(observed[1].order, [
    "openCode",
    "codex",
    "grok",
    "claudeCode",
  ]);
  assert.equal(persisted.order.includes("futureProvider"), true);
  assert.equal(persisted.visible.includes("futureProvider"), true);
  assert.deepEqual(persisted.extensionData, [1, 2, 3]);
});

test("storage failures retain safe in-memory behavior", async () => {
  installBrowser({ readError: new Error("read failed") });
  const readFailure = await loadModule("read-failure");
  assert.deepEqual(
    readFailure.getFooterProviderSettings(),
    readFailure.DEFAULT_FOOTER_PROVIDER_SETTINGS,
  );

  installBrowser({ writeError: new Error("write failed") });
  const writeFailure = await loadModule("write-failure");
  assert.doesNotThrow(() => writeFailure.setFooterProviderVisible("openCode", false));
  assert.equal(
    writeFailure.isFooterProviderVisible(
      writeFailure.getFooterProviderSettings(),
      "openCode",
    ),
    false,
  );
});
