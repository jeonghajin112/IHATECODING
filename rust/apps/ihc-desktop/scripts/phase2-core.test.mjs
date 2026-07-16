import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const bundle = await esbuild.build({
  entryPoints: [
    fileURLToPath(new URL("../src/phase2-core.ts", import.meta.url)),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node18"],
  write: false,
  logLevel: "silent",
});

assert.equal(bundle.outputFiles.length, 1, "core bundle should have one output");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].contents,
).toString("base64")}`;
const core = await import(moduleUrl);

test("layoutFor preserves the deterministic 1-20 pane grid", () => {
  const expected = [
    "1x1",
    "2x1",
    "2x2",
    "2x2",
    "3x2",
    "3x2",
    "4x2",
    "4x2",
    "3x3",
    "4x3",
    "4x3",
    "4x3",
    "5x3",
    "5x3",
    "5x3",
    "4x4",
    "5x4",
    "5x4",
    "5x4",
    "5x4",
  ];

  for (let count = 1; count <= 20; count += 1) {
    const layout = core.layoutFor(count);
    assert.equal(
      `${layout.columns}x${layout.rows}`,
      expected[count - 1],
      `pane count ${count}`,
    );
  }
});

test("clampPaneCount returns an integer in the supported range", () => {
  assert.equal(core.clampPaneCount(Number.NaN), 1);
  assert.equal(core.clampPaneCount(Number.POSITIVE_INFINITY), 1);
  assert.equal(core.clampPaneCount(-10), 1);
  assert.equal(core.clampPaneCount(0), 1);
  assert.equal(core.clampPaneCount(1), 1);
  assert.equal(core.clampPaneCount(8.9), 8);
  assert.equal(core.clampPaneCount(20), 20);
  assert.equal(core.clampPaneCount(21), 20);
});

test("binaryStringToRawBytes preserves 00/7f/80/ff", () => {
  const binary = String.fromCharCode(0x00, 0x7f, 0x80, 0xff);
  assert.deepEqual(core.binaryStringToRawBytes(binary), [0x00, 0x7f, 0x80, 0xff]);
});

test("clipboardItemsContainImage detects image MIME types", () => {
  assert.equal(core.clipboardItemsContainImage([]), false);
  assert.equal(
    core.clipboardItemsContainImage([
      { types: ["text/plain", "text/html"] },
      { types: ["application/json"] },
    ]),
    false,
  );
  assert.equal(
    core.clipboardItemsContainImage([
      { types: ["text/plain"] },
      { types: ["image/png"] },
    ]),
    true,
  );
  assert.equal(
    core.clipboardItemsContainImage([{ types: ["IMAGE/JPEG"] }]),
    true,
  );
});

test("normalizeTerminalEvent keeps canonical camelCase channel fields", () => {
  assert.deepEqual(
    core.normalizeTerminalEvent({
      event: "started",
      data: { sessionId: "session-a", processId: 101 },
    }),
    {
      event: "started",
      data: { sessionId: "session-a", processId: 101 },
    },
  );
});

test("normalizeTerminalEvent bridges the packaged snake_case channel contract", () => {
  const sessionId = "0123456789abcdef0123456789abcdef";
  const started = core.normalizeTerminalEvent({
    event: "started",
    data: { session_id: sessionId, process_id: 4242 },
  });
  const output = core.normalizeTerminalEvent({
    event: "output",
    data: { session_id: sessionId, sequence: 0, data: "PowerShell" },
  });

  assert.equal(started.data.sessionId, sessionId);
  assert.equal(output.data.sessionId, sessionId);
  assert.equal(started.data.sessionId, output.data.sessionId);
});

test("normalizeTerminalEvent maps snake_case exited sequence metadata", () => {
  assert.deepEqual(
    core.normalizeTerminalEvent({
      event: "exited",
      data: {
        session_id: "session-a",
        exit_code: 0,
        last_sequence: 7,
      },
    }),
    {
      event: "exited",
      data: {
        sessionId: "session-a",
        exitCode: 0,
        lastSequence: 7,
      },
    },
  );
});

test("normalizeTerminalEvent rejects missing or conflicting session IDs", () => {
  assert.throws(
    () =>
      core.normalizeTerminalEvent({
        event: "output",
        data: { sequence: 0, data: "missing session" },
      }),
    /missing terminal event field sessionId/,
  );
  assert.throws(
    () =>
      core.normalizeTerminalEvent({
        event: "output",
        data: {
          sessionId: "session-a",
          session_id: "session-b",
          sequence: 0,
          data: "conflict",
        },
      }),
    /conflicting sessionId and session_id/,
  );
});

test("prepareTerminalPaste matches xterm newline and bracketed-paste behavior", () => {
  assert.equal(core.prepareTerminalPaste("a\nb\r\nc", false), "a\rb\rc");
  assert.equal(
    core.prepareTerminalPaste("a\u001bb", true),
    "\u001b[200~a\u241bb\u001b[201~",
  );
});

test("OutputSequencer releases out-of-order batches only when contiguous", () => {
  const sequencer = new core.OutputSequencer();
  const zero = { sequence: 0, data: "zero" };
  const one = { sequence: 1, data: "one" };
  const two = { sequence: 2, data: "two" };

  assert.deepEqual(sequencer.accept(two), []);
  assert.deepEqual(sequencer.accept(zero), [zero]);
  assert.deepEqual(sequencer.accept(one), [one, two]);
  assert.equal(sequencer.pendingCount, 0);
  assert.equal(sequencer.highestContiguousSequence, 2);
});

test("OutputSequencer accepts a null final sequence only for empty output", () => {
  const empty = new core.OutputSequencer();
  empty.observeExit(null);
  assert.equal(empty.isFinalReady, true);

  const nonEmpty = new core.OutputSequencer();
  nonEmpty.accept({ sequence: 0 });
  assert.throws(() => nonEmpty.observeExit(null), core.OutputProtocolError);
});

test("OutputSequencer exposes a final gap until all declared sequences exist", () => {
  const sequencer = new core.OutputSequencer();
  sequencer.accept({ sequence: 1, data: "late" });
  sequencer.observeExit(1);
  assert.equal(sequencer.isFinalReady, false);
  assert.equal(sequencer.pendingCount, 1);
  assert.match(sequencer.describeFinalGap(), /expected contiguous sequence 0 through 1/);
});

test("OutputSequencer marks a contiguous declared final sequence ready", () => {
  const sequencer = new core.OutputSequencer();
  sequencer.accept({ sequence: 0 });
  sequencer.accept({ sequence: 1 });
  sequencer.observeExit(1);
  assert.equal(sequencer.isFinalReady, true);
  assert.equal(sequencer.pendingCount, 0);
});

test("OutputSequencer treats output after exited as fatal", () => {
  const sequencer = new core.OutputSequencer();
  sequencer.observeExit(null);
  assert.throws(
    () => sequencer.accept({ sequence: 0 }),
    /output arrived after the exited event/,
  );
});

test("OutputSequencer rejects a final sequence below already received output", () => {
  const sequencer = new core.OutputSequencer();
  sequencer.accept({ sequence: 0 });
  sequencer.accept({ sequence: 1 });
  assert.throws(() => sequencer.observeExit(0), /beyond the final sequence/);
});

test("CumulativeAckPolicy coalesces rendered batches behind one in-flight ACK", () => {
  const policy = new core.CumulativeAckPolicy();
  assert.equal(policy.noteRendered(0), 0);
  assert.equal(policy.noteRendered(1), null);
  assert.equal(policy.noteRendered(2), null);
  assert.equal(policy.inFlight, 0);
  assert.equal(policy.complete(0), 2);
  assert.equal(policy.inFlight, 2);
  assert.equal(policy.complete(2), null);
  assert.equal(policy.acknowledgedThrough, 2);
});

test("CumulativeAckPolicy rejects non-contiguous render and mismatched completion", () => {
  const nonContiguous = new core.CumulativeAckPolicy();
  assert.throws(() => nonContiguous.noteRendered(1), /not contiguous/);

  const mismatch = new core.CumulativeAckPolicy();
  mismatch.noteRendered(0);
  assert.throws(() => mismatch.complete(1), /does not match in-flight/);
});

test("StartScheduler completes 50 jobs with a peak concurrency of at most two", async () => {
  const scheduler = new core.StartScheduler();
  let active = 0;
  let peak = 0;
  let completed = 0;

  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      scheduler.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1 + (index % 3)));
          completed += 1;
          return index * 2;
        } finally {
          active -= 1;
        }
      }),
    ),
  );

  assert.ok(peak <= 2, `observed peak concurrency ${peak}`);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(completed, 50);
  assert.deepEqual(
    results,
    Array.from({ length: 50 }, (_, index) => index * 2),
  );
});

test("StartScheduler removes and rejects an aborted queued job", async () => {
  const scheduler = new core.StartScheduler(1);
  let releaseFirst = () => undefined;
  const first = scheduler.run(
    () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve("first");
      }),
  );
  await Promise.resolve();

  const controller = new AbortController();
  let queuedRan = false;
  const queued = scheduler.run(async () => {
    queuedRan = true;
    return "queued";
  }, controller.signal);
  controller.abort();

  await assert.rejects(queued, core.StartAbortedError);
  assert.equal(queuedRan, false);
  releaseFirst();
  assert.equal(await first, "first");
});

test("StartScheduler recovers its slot after an operation rejects", async () => {
  const scheduler = new core.StartScheduler(1);
  const rejected = scheduler.run(async () => {
    throw new Error("expected failure");
  });
  const survivor = scheduler.run(async () => "survived");

  await assert.rejects(rejected, /expected failure/);
  assert.equal(await survivor, "survived");
});

test("StartScheduler does not release a running slot merely because its signal aborts", async () => {
  const scheduler = new core.StartScheduler(1);
  const controller = new AbortController();
  let releaseRunning = () => undefined;
  let secondStarted = false;

  const running = scheduler.run(
    async (signal) => {
      assert.equal(signal, controller.signal);
      await new Promise((resolve) => {
        releaseRunning = resolve;
      });
      return "running complete";
    },
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  const second = scheduler.run(async () => {
    secondStarted = true;
    return "second complete";
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondStarted, false);
  releaseRunning();
  assert.equal(await running, "running complete");
  assert.equal(await second, "second complete");
});
