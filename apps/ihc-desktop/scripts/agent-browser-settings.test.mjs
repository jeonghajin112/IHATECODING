import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/agent-browser-settings.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText;
const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;

function installBrowser(stored = null) {
  const values = new Map();
  if (stored !== null) values.set("ihatecoding.agent-browser.v1", stored);
  const listeners = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
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
  return import(`${url}#${suffix}`);
}

test("embedded browser tools are enabled by default and invalid storage fails to the default", async () => {
  installBrowser();
  const settings = await loadModule("default");
  assert.equal(settings.getUseEmbeddedBrowserTools(), true);
  for (const invalid of ["false", "{}", "[]", "not-json"]) {
    assert.equal(settings.resolveAgentBrowserSettings(invalid).useEmbeddedBrowserTools, true);
  }
});

test("the opt-out persists and notifies without changing global browser configuration", async () => {
  const values = installBrowser();
  const settings = await loadModule("opt-out");
  const observed = [];
  const unsubscribe = settings.subscribeAgentBrowserSettings((next) => observed.push(next));
  settings.setUseEmbeddedBrowserTools(false);
  settings.setUseEmbeddedBrowserTools(false);
  unsubscribe();
  assert.equal(settings.getUseEmbeddedBrowserTools(), false);
  assert.deepEqual(JSON.parse(values.get(settings.AGENT_BROWSER_SETTINGS_STORAGE_KEY)), {
    useEmbeddedBrowserTools: false,
  });
  assert.deepEqual(observed, [{ useEmbeddedBrowserTools: false }]);
});

test("a valid stored choice is restored", async () => {
  installBrowser(JSON.stringify({ useEmbeddedBrowserTools: false }));
  const settings = await loadModule("stored");
  assert.equal(settings.getUseEmbeddedBrowserTools(), false);
});
