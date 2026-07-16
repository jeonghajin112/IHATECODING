export const PHASE2_MAX_PANES = 20;
export const DEFAULT_START_CONCURRENCY = 2;

export type GridLayout = Readonly<{
  columns: number;
  rows: number;
}>;

export type ClipboardTypeSource = Readonly<{
  types: Iterable<string>;
}>;

export type TerminalEvent =
  | {
      event: "started";
      data: { sessionId: string; processId: number | null };
    }
  | {
      event: "output";
      data: { sessionId: string; sequence: number; data: string };
    }
  | {
      event: "error";
      data: { sessionId: string; message: string };
    }
  | {
      event: "exited";
      data: {
        sessionId: string;
        exitCode: number | null;
        lastSequence: number | null;
      };
    };

export type SequencedValue = Readonly<{
  sequence: number;
}>;

export function layoutFor(count: number): GridLayout {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count <= 4) return { columns: 2, rows: 2 };
  if (count <= 6) return { columns: 3, rows: 2 };
  if (count <= 8) return { columns: 4, rows: 2 };
  if (count === 9) return { columns: 3, rows: 3 };
  if (count <= 12) return { columns: 4, rows: 3 };
  if (count <= 15) return { columns: 5, rows: 3 };
  if (count === 16) return { columns: 4, rows: 4 };
  return { columns: 5, rows: 4 };
}

export function clampPaneCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(PHASE2_MAX_PANES, Math.max(1, Math.trunc(value)));
}

export function binaryStringToRawBytes(data: string): number[] {
  return Array.from(data, (character) => character.charCodeAt(0) & 0xff);
}

export function clipboardItemsContainImage(
  items: Iterable<ClipboardTypeSource>,
): boolean {
  for (const item of items) {
    for (const type of item.types) {
      if (type.toLowerCase().startsWith("image/")) return true;
    }
  }
  return false;
}

export class TerminalEventContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalEventContractError";
  }
}

export function normalizeTerminalEvent(value: unknown): TerminalEvent {
  const envelope = requireRecord(value, "terminal event");
  const event = requireString(envelope.event, "terminal event.event");
  const data = requireRecord(envelope.data, `terminal ${event} data`);
  const sessionId = requireAliasedString(data, "sessionId", "session_id");

  switch (event) {
    case "started":
      return {
        event,
        data: {
          sessionId,
          processId: requireAliasedNullableInteger(data, "processId", "process_id"),
        },
      };
    case "output":
      return {
        event,
        data: {
          sessionId,
          sequence: requireNonNegativeInteger(data.sequence, "sequence"),
          data: requireString(data.data, "data"),
        },
      };
    case "error":
      return {
        event,
        data: {
          sessionId,
          message: requireString(data.message, "message"),
        },
      };
    case "exited":
      return {
        event,
        data: {
          sessionId,
          exitCode: requireAliasedNullableInteger(data, "exitCode", "exit_code"),
          lastSequence: requireAliasedNullableInteger(
            data,
            "lastSequence",
            "last_sequence",
          ),
        },
      };
    default:
      throw new TerminalEventContractError(`unknown terminal event: ${event}`);
  }
}

export function prepareTerminalPaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  if (!bracketed) return normalized;
  return `\u001b[200~${normalized.replace(/\u001b/g, "\u241b")}\u001b[201~`;
}

export class OutputProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputProtocolError";
  }
}

export class OutputSequencer<T extends SequencedValue> {
  private readonly pending = new Map<number, T>();
  private nextSequence = 0;
  private exitObserved = false;
  private finalSequence: number | null | undefined;

  accept(value: T): T[] {
    if (this.exitObserved) {
      throw new OutputProtocolError("output arrived after the exited event");
    }
    assertSequence(value.sequence, "output sequence");
    if (value.sequence < this.nextSequence || this.pending.has(value.sequence)) {
      return [];
    }

    this.pending.set(value.sequence, value);
    const ready: T[] = [];
    while (true) {
      const next = this.pending.get(this.nextSequence);
      if (!next) break;
      this.pending.delete(this.nextSequence);
      this.nextSequence += 1;
      ready.push(next);
    }
    return ready;
  }

  observeExit(lastSequence: number | null): void {
    if (this.exitObserved) {
      throw new OutputProtocolError("duplicate exited event");
    }
    if (lastSequence !== null) assertSequence(lastSequence, "final output sequence");

    this.exitObserved = true;
    this.finalSequence = lastSequence;
    if (lastSequence === null) {
      if (this.nextSequence !== 0 || this.pending.size !== 0) {
        throw new OutputProtocolError(
          "exit declared no output after output batches were received",
        );
      }
      return;
    }

    if (this.nextSequence > lastSequence + 1) {
      throw new OutputProtocolError(
        "received output beyond the final sequence declared by exited",
      );
    }
    for (const sequence of this.pending.keys()) {
      if (sequence > lastSequence) {
        throw new OutputProtocolError(
          "pending output exceeds the final sequence declared by exited",
        );
      }
    }
  }

  get hasObservedExit(): boolean {
    return this.exitObserved;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get highestContiguousSequence(): number | null {
    return this.nextSequence === 0 ? null : this.nextSequence - 1;
  }

  get isFinalReady(): boolean {
    if (!this.exitObserved || this.finalSequence === undefined) return false;
    if (this.finalSequence === null) {
      return this.nextSequence === 0 && this.pending.size === 0;
    }
    return this.nextSequence === this.finalSequence + 1 && this.pending.size === 0;
  }

  describeFinalGap(): string {
    if (!this.exitObserved || this.finalSequence === undefined || this.isFinalReady) {
      return "";
    }
    const expected = this.nextSequence;
    const final = this.finalSequence === null ? "none" : String(this.finalSequence);
    return `expected contiguous sequence ${expected} through ${final}; pending=${this.pending.size}`;
  }
}

export class CumulativeAckPolicy {
  private highestRendered = -1;
  private highestAcknowledged = -1;
  private inFlightSequence: number | null = null;

  noteRendered(sequence: number): number | null {
    assertSequence(sequence, "rendered sequence");
    if (sequence !== this.highestRendered + 1) {
      throw new OutputProtocolError(
        `rendered sequence ${sequence} is not contiguous after ${this.highestRendered}`,
      );
    }
    this.highestRendered = sequence;
    return this.reserveLatest();
  }

  complete(sequence: number): number | null {
    if (this.inFlightSequence !== sequence) {
      throw new OutputProtocolError(
        `ACK completion ${sequence} does not match in-flight ${this.inFlightSequence}`,
      );
    }
    this.highestAcknowledged = sequence;
    this.inFlightSequence = null;
    return this.reserveLatest();
  }

  get inFlight(): number | null {
    return this.inFlightSequence;
  }

  get acknowledgedThrough(): number | null {
    return this.highestAcknowledged < 0 ? null : this.highestAcknowledged;
  }

  private reserveLatest(): number | null {
    if (
      this.inFlightSequence !== null ||
      this.highestRendered <= this.highestAcknowledged
    ) {
      return null;
    }
    this.inFlightSequence = this.highestRendered;
    return this.inFlightSequence;
  }
}

export class StartAbortedError extends Error {
  constructor() {
    super("Scheduled terminal start was aborted");
    this.name = "StartAbortedError";
  }
}

/**
 * Returns the queued start's current priority. The scheduler evaluates this
 * immediately before selecting each pending job; larger values run first.
 */
export type StartPriority = () => number;

type PendingStart<T> = {
  operation: (signal?: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  priority: StartPriority;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  abortQueued: () => void;
};

const DEFAULT_START_PRIORITY: StartPriority = () => 0;

export class StartScheduler {
  private active = 0;
  private readonly pending: Array<PendingStart<unknown>> = [];

  constructor(
    private readonly maxConcurrent: number = DEFAULT_START_CONCURRENCY,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("StartScheduler concurrency must be a positive integer");
    }
  }

  run<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    priority: StartPriority = DEFAULT_START_PRIORITY,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new StartAbortedError());

    return new Promise<T>((resolve, reject) => {
      const entry: PendingStart<T> = {
        operation,
        signal,
        priority,
        resolve,
        reject,
        abortQueued: () => {
          const index = this.pending.indexOf(entry as PendingStart<unknown>);
          if (index < 0) return;
          this.pending.splice(index, 1);
          signal?.removeEventListener("abort", entry.abortQueued);
          reject(new StartAbortedError());
        },
      };
      signal?.addEventListener("abort", entry.abortQueued, { once: true });
      this.pending.push(entry as PendingStart<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const entry = this.takeHighestPriority();
      if (!entry) return;
      entry.signal?.removeEventListener("abort", entry.abortQueued);
      if (entry.signal?.aborted) {
        entry.reject(new StartAbortedError());
        continue;
      }

      this.active += 1;
      void Promise.resolve()
        .then(() => entry.operation(entry.signal))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private takeHighestPriority(): PendingStart<unknown> | undefined {
    while (this.pending.length > 0) {
      let selected: PendingStart<unknown> | undefined;
      let selectedPriority = Number.NEGATIVE_INFINITY;

      // Snapshot iteration keeps equal-priority jobs FIFO while allowing an
      // evaluator failure/abort to remove its own entry safely during the scan.
      for (const entry of [...this.pending]) {
        if (!this.pending.includes(entry)) continue;
        let priority: number;
        try {
          priority = entry.priority();
          if (!Number.isFinite(priority)) {
            throw new RangeError("StartScheduler priority must be a finite number");
          }
        } catch (error) {
          const invalidIndex = this.pending.indexOf(entry);
          if (invalidIndex >= 0) this.pending.splice(invalidIndex, 1);
          entry.signal?.removeEventListener("abort", entry.abortQueued);
          entry.reject(error);
          continue;
        }

        if (selected === undefined || priority > selectedPriority) {
          selected = entry;
          selectedPriority = priority;
        }
      }

      if (selected === undefined) continue;
      const selectedIndex = this.pending.indexOf(selected);
      if (selectedIndex < 0) continue;
      this.pending.splice(selectedIndex, 1);
      return selected;
    }
    return undefined;
  }
}

function assertSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OutputProtocolError(`${label} must be a non-negative safe integer`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TerminalEventContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TerminalEventContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TerminalEventContractError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function requireAliasedString(
  record: Record<string, unknown>,
  canonical: string,
  legacy: string,
): string {
  return requireString(readAliased(record, canonical, legacy), canonical);
}

function requireAliasedNullableInteger(
  record: Record<string, unknown>,
  canonical: string,
  legacy: string,
): number | null {
  const value = readAliased(record, canonical, legacy);
  return value === null ? null : requireNonNegativeInteger(value, canonical);
}

function readAliased(
  record: Record<string, unknown>,
  canonical: string,
  legacy: string,
): unknown {
  const hasCanonical = Object.prototype.hasOwnProperty.call(record, canonical);
  const hasLegacy = Object.prototype.hasOwnProperty.call(record, legacy);
  if (hasCanonical && hasLegacy && record[canonical] !== record[legacy]) {
    throw new TerminalEventContractError(
      `conflicting ${canonical} and ${legacy} terminal event fields`,
    );
  }
  if (hasCanonical) return record[canonical];
  if (hasLegacy) return record[legacy];
  throw new TerminalEventContractError(`missing terminal event field ${canonical}`);
}
