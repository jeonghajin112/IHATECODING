import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/openai-status-core.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2021 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const status = await import(moduleUrl);

function snapshot(overrides = {}) {
  return {
    overallStatus: "operational",
    overallDescription: "All Systems Operational",
    status: "operational",
    services: [
      { key: "chatgpt", name: "untrusted upstream name", status: "operational" },
      { key: "api", name: "API", status: "degraded" },
      { key: "codex", name: "Codex", status: "maintenance" },
    ],
    incidents: [],
    sourceUpdatedAt: "2026-07-22T12:00:00.000Z",
    checkedAtUnixMs: 1_753_185_600_000,
    stale: false,
    ...overrides,
  };
}

test("normalizes a valid snapshot into bounded immutable UI data", () => {
  const normalized = status.normalizeOpenAiStatusSnapshot(snapshot({
    incidents: [{
      id: "incident-1",
      name: "Elevated errors",
      status: "investigating",
      impact: "minor",
      updatedAt: "2026-07-22T12:01:00.000Z",
      latestUpdate: "We are investigating.",
    }],
  }));

  assert.equal(normalized.overallStatus, "operational");
  assert.equal(normalized.status, "operational");
  assert.deepEqual(normalized.services, [
    { key: "chatgpt", name: "ChatGPT", status: "operational" },
    { key: "api", name: "API", status: "degraded" },
    { key: "codex", name: "Codex", status: "maintenance" },
  ]);
  assert.deepEqual(normalized.incidents, [{
    id: "incident-1",
    name: "Elevated errors",
    status: "investigating",
    impact: "minor",
    updatedAt: "2026-07-22T12:01:00.000Z",
    latestUpdate: "We are investigating.",
  }]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.services), true);
  assert.equal(Object.isFrozen(normalized.services[0]), true);
  assert.equal(Object.isFrozen(normalized.incidents), true);
  assert.equal(Object.isFrozen(normalized.incidents[0]), true);
});

test("rejects malformed envelopes and invalid check times", () => {
  for (const malformed of [null, undefined, [], "nope", 42]) {
    assert.throws(
      () => status.normalizeOpenAiStatusSnapshot(malformed),
      /response is invalid/,
    );
  }
  for (const checkedAtUnixMs of [undefined, null, 0, -1, 1.5, Number.MAX_VALUE, "nope"]) {
    assert.throws(
      () => status.normalizeOpenAiStatusSnapshot(snapshot({ checkedAtUnixMs })),
      /check time is invalid/,
    );
  }
});

test("unknown fields fail closed while invalid nested records are ignored", () => {
  const normalized = status.normalizeOpenAiStatusSnapshot(snapshot({
    overallStatus: "future_status",
    status: null,
    services: [
      { key: "chatgpt", status: "future_status" },
      { key: "chatgpt", status: "outage" },
      { key: "future-service", status: "operational" },
      null,
    ],
    incidents: [
      null,
      { id: "", name: "Missing id" },
      { id: "valid", name: "Valid", status: 3, impact: null, updatedAt: "not-a-date" },
    ],
    sourceUpdatedAt: "not-a-date",
    stale: "true",
  }));

  assert.equal(normalized.overallStatus, "unknown");
  assert.equal(normalized.status, "unknown");
  assert.deepEqual(normalized.services, [
    { key: "chatgpt", name: "ChatGPT", status: "unknown" },
  ]);
  assert.deepEqual(normalized.incidents, [{
    id: "valid",
    name: "Valid",
    status: "unknown",
    impact: "unknown",
    updatedAt: null,
    latestUpdate: null,
  }]);
  assert.equal(normalized.sourceUpdatedAt, null);
  assert.equal(normalized.stale, false);
});

test("maps every status to a stable tone and bilingual label", () => {
  assert.deepEqual(
    ["operational", "degraded", "outage", "maintenance", "unknown"].map((level) => [
      level,
      status.openAiStatusTone(level),
      status.openAiStatusLabel(level, "en"),
      status.openAiStatusLabel(level, "ko"),
    ]),
    [
      ["operational", "normal", "Operational", "정상"],
      ["degraded", "warning", "Degraded", "성능 저하"],
      ["outage", "error", "Outage", "장애"],
      ["maintenance", "maintenance", "Maintenance", "점검 중"],
      ["unknown", "unknown", "Unavailable", "확인 불가"],
    ],
  );
});

test("hides the compact footer summary only while OpenAI is operational", () => {
  assert.equal(status.shouldShowOpenAiStatusSummary("operational"), false);
  for (const level of ["degraded", "outage", "maintenance", "unknown"]) {
    assert.equal(status.shouldShowOpenAiStatusSummary(level), true);
  }
});

test("localizes known incident states and safely formats unknown states", () => {
  assert.equal(status.openAiIncidentStatusLabel("investigating", "ko"), "조사 중");
  assert.equal(status.openAiIncidentStatusLabel("identified", "ko"), "원인 확인");
  assert.equal(status.openAiIncidentStatusLabel("monitoring", "ko"), "모니터링 중");
  assert.equal(status.openAiIncidentStatusLabel("resolved", "ko"), "해결됨");
  assert.equal(status.openAiIncidentStatusLabel("postmortem", "ko"), "상태 확인 중");
  assert.equal(status.openAiIncidentStatusLabel("in_progress", "en"), "in progress");
  assert.equal(status.openAiIncidentStatusLabel("", "en"), "Unknown");
});

test("freshness respects stale state, clock direction, and the exact age boundary", () => {
  const checkedAtUnixMs = 10_000;
  const normalized = status.normalizeOpenAiStatusSnapshot(snapshot({ checkedAtUnixMs }));

  assert.equal(status.isOpenAiStatusSnapshotFresh(normalized, 10_000, 60_000), true);
  assert.equal(status.isOpenAiStatusSnapshotFresh(normalized, 70_000, 60_000), true);
  assert.equal(status.isOpenAiStatusSnapshotFresh(normalized, 70_001, 60_000), false);
  assert.equal(status.isOpenAiStatusSnapshotFresh(normalized, 9_999, 60_000), false);
  assert.equal(status.isOpenAiStatusSnapshotFresh(normalized, Number.NaN, 60_000), false);
  assert.equal(status.isOpenAiStatusSnapshotFresh(normalized, 10_000, -1), false);

  const stale = status.normalizeOpenAiStatusSnapshot(snapshot({ checkedAtUnixMs, stale: true }));
  assert.equal(status.isOpenAiStatusSnapshotFresh(stale, 10_000, 60_000), false);
});
