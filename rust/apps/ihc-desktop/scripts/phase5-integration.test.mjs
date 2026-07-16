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
  assert.doesNotMatch(main, /prompt[^\n]*(complete|idle)|OutputQuiet[^\n]*QueueCompletion/i);
});

test("agent completion is routed through the backend-owned runtime session", async () => {
  const main = await source("src/main.ts");
  assert.match(main, /invoke\("subscribe_agent_events", \{ onEvent: this\.channel \}\)/);
  assert.match(main, /event !== "turnComplete"/);
  assert.match(main, /pane\?\.ownsRuntimeSession\(runtimeSessionId\)/);
  assert.match(main, /provider,[\s\S]*data\.conversationId\.toLowerCase\(\),[\s\S]*data\.observedAtUnixMs/);
});

test("usage, unread badges, and provider-specific image paste are wired", async () => {
  const [main, controller, html, styles] = await Promise.all([
    source("src/main.ts"),
    source("src/phase4-controller.ts"),
    source("index.html"),
    source("src/styles.css"),
  ]);
  assert.match(main, /invoke<unknown>\("read_provider_usage"\)/);
  assert.match(main, /window\.setInterval\(\(\) => void this\.refresh\(\), 15_000\)/);
  assert.match(main, /selectClipboardImageSequence\(this\.savedAgentProvider\)/);
  assert.match(controller, /projectUnreadCount\(state, project\.id\)/);
  assert.match(html, /id="codex-five-hour-remaining"/);
  assert.match(html, /id="codex-weekly-remaining"/);
  assert.match(html, /id="grok-remaining"/);
  assert.match(styles, /\.terminal-pane\[data-completion-pending="true"\]/);
  assert.match(styles, /\.completion-badge/);
});
