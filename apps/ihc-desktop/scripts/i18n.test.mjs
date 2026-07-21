import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText;
const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;

function installBrowser(language = "en-US", stored = null) {
  const values = new Map();
  if (stored !== null) values.set("ihatecoding.language.v1", stored);
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { language, languages: [language] },
    configurable: true,
  });
  globalThis.document = {
    documentElement: { lang: "" },
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
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

test("saved language wins over the operating-system language", async () => {
  installBrowser("ko-KR", "en");
  const i18n = await loadModule("saved");
  assert.equal(i18n.getAppLanguage(), "en");
});

test("Korean systems start in Korean and all other systems start in English", async () => {
  installBrowser("ko-KR");
  const korean = await loadModule("ko");
  assert.equal(korean.getAppLanguage(), "ko");

  installBrowser("ja-JP");
  const english = await loadModule("en");
  assert.equal(english.getAppLanguage(), "en");
});

test("invalid saved values fall back to the operating-system language", async () => {
  installBrowser("ko-KR", "invalid");
  const i18n = await loadModule("invalid");
  assert.equal(i18n.getAppLanguage(), "ko");
});

test("only the primary operating-system language controls the first-run default", async () => {
  installBrowser("en-US");
  const i18n = await loadModule("primary");
  assert.equal(i18n.resolveAppLanguage(null, ["en-US", "ko-KR"]), "en");
});

test("language changes persist and bilingual runtime strings follow the selection", async () => {
  const values = installBrowser("en-US");
  const i18n = await loadModule("change");
  assert.equal(i18n.tr("Settings", "환경설정"), "Settings");
  i18n.setAppLanguage("ko");
  assert.equal(values.get(i18n.APP_LANGUAGE_STORAGE_KEY), "ko");
  assert.equal(i18n.tr("Settings", "환경설정"), "환경설정");
});

test("static application chrome has paired English and Korean translations", () => {
  assert.match(html, /<html lang="en">/);
  for (const prefix of ["data-i18n", "data-i18n-aria-label", "data-i18n-title", "data-i18n-placeholder"]) {
    const english = html.match(new RegExp(`${prefix}-en=`, "g"))?.length ?? 0;
    const korean = html.match(new RegExp(`${prefix}-ko=`, "g"))?.length ?? 0;
    assert.equal(english, korean, `${prefix} translations must be paired`);
    assert.ok(english > 0, `${prefix} translations must be present`);
  }
});

test("settings wire immediate language and optimization changes with separate notification controls", () => {
  assert.match(mainSource, /languageSelect\.addEventListener\("change"[\s\S]*setAppLanguage\(language\)/);
  assert.match(mainSource, /autoSleepIdleAgentsInput\.addEventListener\("change"[\s\S]*setAutoSleepIdleAgents\(enabled\)/);
  assert.match(mainSource, /\["general", this\.generalTab, this\.generalPanel\][\s\S]*\["optimization", this\.optimizationTab, this\.optimizationPanel\][\s\S]*\["agents", this\.agentsTab, this\.agentsPanel\][\s\S]*\["notifications", this\.notificationsTab, this\.notificationsPanel\]/);
  assert.match(mainSource, /testButton\.hidden = !notificationsActive[\s\S]*saveButton\.hidden = !notificationsActive/);
  assert.match(mainSource, /language:\s*getAppLanguage\(\)/);
});

test("backend error text follows the selected application language", async () => {
  installBrowser("en-US");
  const english = await loadModule("backend-en");
  assert.equal(
    english.localizeBackendMessage("선택한 계정을 찾지 못했습니다."),
    "The selected account could not be found.",
  );
  assert.equal(
    english.localizeBackendMessage("공식 CLI 로그인이 완료되지 않았습니다 (종료 코드 1)."),
    "The official CLI login did not complete (exit code 1).",
  );

  installBrowser("ko-KR");
  const korean = await loadModule("backend-ko");
  assert.equal(
    korean.localizeBackendMessage("선택한 계정을 찾지 못했습니다."),
    "선택한 계정을 찾지 못했습니다.",
  );
  assert.equal(
    korean.localizeBackendMessage(
      "A file or folder with that project name already exists in Documents.",
    ),
    "문서 폴더에 같은 프로젝트 이름의 파일이나 폴더가 이미 있습니다.",
  );
  assert.equal(
    korean.localizeBackendMessage("The media preview could not be authorized."),
    "미디어 미리보기 접근을 허용하지 못했습니다.",
  );
  assert.equal(
    korean.localizeBackendMessage("The selected file could not be deleted."),
    "선택한 파일을 삭제하지 못했습니다.",
  );
});
