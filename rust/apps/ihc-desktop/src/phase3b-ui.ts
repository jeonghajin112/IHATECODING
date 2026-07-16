import { invoke } from "@tauri-apps/api/core";
import {
  createImportPreviewSession,
  createWorkspaceSession,
  normalizeStorageCommandError,
  normalizeWorkspaceLoadResponse,
  type StorageCommandError,
  type WorkspaceSession,
} from "./phase3b-core";

type InspectionDiagnostic = {
  code: string;
  jsonPointer: string;
};

type LegacyInspection = {
  inspectToken: string;
  sourceSha256: string;
  projectCount: number;
  terminalCount: number;
  recoverableWarnings: InspectionDiagnostic[];
  blockingErrors: InspectionDiagnostic[];
};

type RecoveryCandidate = {
  candidateId: string;
  revision: number | null;
  writtenAtUtc: string | null;
  byteLength: number;
  valid: boolean;
};

type StorageDisplayMode = "loading" | "ready" | "read-only" | "recovery" | "error";

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export interface WorkspaceReplacementHooks {
  beforeReplace(): Promise<void>;
  afterReplace(committed: boolean): Promise<void>;
}

export class Phase3BMigrationUI {
  private readonly listeners = new AbortController();
  private inspection: LegacyInspection | null = null;
  private inspectedPath = "";
  private storageWritable = false;
  private importAllowed = false;
  private busy = false;
  private disposed = false;
  private operationGeneration = 0;

  private readonly panel = requireElement("storage-mode-badge").closest(".storage-panel");
  private readonly modeBadge = requireElement("storage-mode-badge");
  private readonly openButton = requireButton("open-legacy-import");
  private readonly dialog = requireDialog("legacy-import-dialog");
  private readonly form = requireForm("legacy-import-form");
  private readonly sourcePath = requireInput("legacy-source-path");
  private readonly inspectButton = requireButton("inspect-legacy-copy");
  private readonly commitButton = requireButton("commit-legacy-import");
  private readonly closeButton = requireButton("close-legacy-import");
  private readonly inspectionPanel = requireElement("legacy-inspection");
  private readonly projectCount = requireElement("legacy-project-count");
  private readonly terminalCount = requireElement("legacy-terminal-count");
  private readonly sourceSha = requireElement("legacy-source-sha");
  private readonly warningSection = requireElement("legacy-warning-section");
  private readonly warningList = requireElement("legacy-warning-list");
  private readonly blockingSection = requireElement("legacy-blocking-section");
  private readonly blockingList = requireElement("legacy-blocking-list");
  private readonly error = requireElement("legacy-import-error");
  private readonly result = requireElement("legacy-import-result");
  private readonly recoverySection = requireElement("storage-recovery");
  private readonly recoveryList = requireElement("recovery-candidate-list");

  constructor(private readonly replacementHooks?: WorkspaceReplacementHooks) {
    if (!(this.panel instanceof HTMLElement)) {
      throw new Error("Missing storage panel");
    }

    const signal = this.listeners.signal;
    this.openButton.addEventListener("click", () => this.open(), { signal });
    this.closeButton.addEventListener(
      "click",
      () => {
        if (!this.busy) this.dialog.close();
      },
      { signal },
    );
    this.form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.inspectCopy();
      },
      { signal },
    );
    this.commitButton.addEventListener("click", () => void this.commitImport(), { signal });
    this.sourcePath.addEventListener("input", () => this.invalidateInspection(), { signal });
    this.dialog.addEventListener(
      "cancel",
      (event) => {
        if (this.busy) event.preventDefault();
      },
      { signal },
    );
    this.dialog.addEventListener(
      "close",
      () => {
        this.error.textContent = "";
      },
      { signal },
    );
  }

  async initialize(): Promise<void> {
    await this.refreshStorage();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.operationGeneration += 1;
    this.listeners.abort();
    if (this.dialog.open) this.dialog.close();
  }

  private open(): void {
    if (this.disposed || this.busy || this.dialog.open) return;
    this.error.textContent = "";
    this.result.textContent = "";
    this.dialog.showModal();
    this.sourcePath.focus();
    void this.refreshStorage();
  }

  private async refreshStorage(): Promise<void> {
    const generation = ++this.operationGeneration;
    this.storageWritable = false;
    this.importAllowed = false;
    this.setStorageMode("loading", "저장소 확인 중");

    try {
      const statusValue = await invoke<unknown>("storage_status");
      if (!this.isCurrent(generation)) return;
      const status = normalizeStatus(statusValue);
      this.storageWritable = status.writable;

      const loadValue = await invoke<unknown>("load_workspace_state");
      if (!this.isCurrent(generation)) return;
      const load = normalizeWorkspaceLoadResponse(loadValue);
      const requestedAccess = status.writable ? "ready" : "readOnly";
      const session = createWorkspaceSession(load, requestedAccess);

      this.storageWritable = status.writable;
      this.importAllowed = status.writable && session.access === "ready";
      if (
        session.access === "recoveryRequired" ||
        session.access === "recoveryPreview" ||
        status.mode === "recoveryrequired"
      ) {
        this.importAllowed = false;
        this.setStorageMode("recovery", "복구 필요");
        await this.refreshRecoveryCandidates(generation);
      } else if (session.access === "unsupportedVersion") {
        this.storageWritable = false;
        this.setStorageMode("read-only", "새 버전 저장소 · 읽기 전용");
        this.hideRecovery();
      } else if (!this.storageWritable) {
        this.importAllowed = false;
        this.setStorageMode("read-only", "읽기 전용 · 다른 창 사용 중");
        this.hideRecovery();
      } else {
        const revision = session.snapshot?.revision ?? status.revision;
        this.setStorageMode(
          "ready",
          revision === null ? "Rust 저장소 준비됨" : `Rust 저장소 · r${revision}`,
        );
        this.hideRecovery();
      }
      this.updateActions();
    } catch (value) {
      if (!this.isCurrent(generation)) return;
      const commandError = toStorageError(value);
      this.importAllowed = false;
      if (commandError.code === "recoveryRequired") {
        this.setStorageMode("recovery", "복구 필요");
        await this.refreshRecoveryCandidates(generation);
      } else if (commandError.code === "unsupportedVersion") {
        this.storageWritable = false;
        this.setStorageMode("read-only", "새 버전 저장소 · 읽기 전용");
        this.hideRecovery();
      } else {
        this.storageWritable = false;
        this.setStorageMode("error", "저장소 확인 실패");
        this.hideRecovery();
      }
      if (this.dialog.open) this.showError(commandError);
      this.updateActions();
    }
  }

  private async inspectCopy(): Promise<void> {
    if (this.busy || this.disposed) return;
    const sourcePath = this.sourcePath.value.trim();
    if (!isAbsoluteWindowsPath(sourcePath)) {
      this.showError({
        code: "invalidSource",
        message: "분리된 복사본의 Windows 절대 경로를 입력하세요.",
        retryable: false,
        jsonPointer: "/sourcePath",
      });
      return;
    }

    const generation = ++this.operationGeneration;
    this.setBusy(true);
    this.invalidateInspection(false);
    this.error.textContent = "";
    this.result.textContent = "복사본을 읽기 전용으로 검사하고 있습니다…";

    try {
      const value = await invoke<unknown>("inspect_legacy_catalog", {
        sourcePath,
        sourceIsDetachedCopy: true,
      });
      if (!this.isCurrent(generation)) return;
      const inspection = normalizeInspection(value);
      this.inspection = inspection;
      this.inspectedPath = sourcePath;
      this.renderInspection(inspection);
      this.result.textContent =
        inspection.blockingErrors.length === 0
          ? "검사가 끝났습니다. 아래 교체 버튼을 눌러야만 Rust Preview 저장소가 변경됩니다."
          : "차단 항목을 해결한 새 복사본을 다시 검사하세요.";
    } catch (value) {
      if (!this.isCurrent(generation)) return;
      this.showError(toStorageError(value));
      this.result.textContent = "";
    } finally {
      if (this.isCurrent(generation)) this.setBusy(false);
    }
  }

  private async commitImport(): Promise<void> {
    const inspection = this.inspection;
    const sourcePath = this.sourcePath.value.trim();
    if (
      this.busy ||
      this.disposed ||
      !this.importAllowed ||
      inspection === null ||
      inspection.blockingErrors.length > 0 ||
      sourcePath !== this.inspectedPath
    ) {
      return;
    }

    const generation = ++this.operationGeneration;
    this.setBusy(true);
    this.error.textContent = "";
    this.result.textContent = "검사한 복사본을 Rust Preview 저장소에 반영하고 있습니다…";

    try {
      const value = await this.performReplacement(generation, () =>
        invoke<unknown>("import_legacy_catalog", {
          inspectToken: inspection.inspectToken,
          sourcePath,
          sourceSha256: inspection.sourceSha256,
          mode: "replacePreview",
        }),
      );
      if (!this.isCurrent(generation)) return;
      const preview = normalizeImportPreview(value);
      const projects = preview.draft?.projects ?? [];
      const terminals = projects.reduce((sum, project) => sum + project.terminals.length, 0);
      this.result.textContent =
        `Rust Preview 교체 완료 · 프로젝트 ${projects.length}개 · PowerShell ${terminals}개 ` +
        "(canonical 상태로 반영했으며 Codex/Grok 세션은 자동 재개하지 않았습니다.)";
      this.inspection = null;
      this.inspectedPath = "";
      this.setBusy(false);
      this.updateActions();
      await this.refreshStorage();
    } catch (value) {
      if (!this.isCurrent(generation)) return;
      this.showError(toStorageError(value));
      this.result.textContent = "";
    } finally {
      if (this.isCurrent(generation)) this.setBusy(false);
    }
  }

  private async refreshRecoveryCandidates(parentGeneration: number): Promise<void> {
    try {
      const value = await invoke<unknown>("list_recovery_candidates");
      if (!this.isCurrent(parentGeneration)) return;
      this.renderRecoveryCandidates(normalizeRecoveryCandidates(value));
    } catch (value) {
      if (!this.isCurrent(parentGeneration)) return;
      this.renderRecoveryCandidates([]);
      if (this.dialog.open) this.showError(toStorageError(value));
    }
  }

  private renderRecoveryCandidates(candidates: RecoveryCandidate[]): void {
    this.recoveryList.replaceChildren();
    this.recoverySection.hidden = false;
    const verified = candidates.filter((candidate) => candidate.valid);
    if (verified.length === 0) {
      const empty = document.createElement("span");
      empty.className = "recovery-candidate-details";
      empty.textContent = "검증을 통과한 복구 후보가 없습니다.";
      this.recoveryList.append(empty);
      return;
    }

    for (const candidate of verified) {
      const row = document.createElement("div");
      row.className = "recovery-candidate";

      const details = document.createElement("span");
      details.className = "recovery-candidate-details";
      const title = document.createElement("strong");
      title.textContent = candidate.candidateId;
      const metadata = document.createElement("span");
      const revision = candidate.revision === null ? "revision 알 수 없음" : `r${candidate.revision}`;
      metadata.textContent = `${revision} · ${formatBytes(candidate.byteLength)}`;
      details.append(title, metadata);

      const recover = document.createElement("button");
      recover.type = "button";
      recover.textContent = "이 백업 복구";
      recover.disabled = this.busy || !this.storageWritable;
      recover.addEventListener(
        "click",
        () => void this.recoverCandidate(candidate.candidateId),
        { signal: this.listeners.signal },
      );
      row.append(details, recover);
      this.recoveryList.append(row);
    }
  }

  private async recoverCandidate(candidateId: string): Promise<void> {
    if (this.busy || this.disposed) return;
    const generation = ++this.operationGeneration;
    this.setBusy(true);
    this.error.textContent = "";
    this.result.textContent = `${candidateId} 복구를 적용하고 있습니다…`;
    try {
      await this.performReplacement(generation, () =>
        invoke<unknown>("recover_workspace_state", { candidateId }),
      );
      if (!this.isCurrent(generation)) return;
      this.result.textContent = "검증된 백업으로 복구했습니다.";
      this.setBusy(false);
      await this.refreshStorage();
    } catch (value) {
      if (!this.isCurrent(generation)) return;
      this.showError(toStorageError(value));
      this.result.textContent = "";
    } finally {
      if (this.isCurrent(generation)) this.setBusy(false);
    }
  }

  private renderInspection(inspection: LegacyInspection): void {
    this.inspectionPanel.hidden = false;
    this.projectCount.textContent = String(inspection.projectCount);
    this.terminalCount.textContent = String(inspection.terminalCount);
    this.sourceSha.textContent = inspection.sourceSha256;
    renderDiagnostics(this.warningList, inspection.recoverableWarnings);
    renderDiagnostics(this.blockingList, inspection.blockingErrors);
    this.warningSection.hidden = inspection.recoverableWarnings.length === 0;
    this.blockingSection.hidden = inspection.blockingErrors.length === 0;
    this.updateActions();
  }

  private invalidateInspection(clearResult = true): void {
    this.inspection = null;
    this.inspectedPath = "";
    this.inspectionPanel.hidden = true;
    if (clearResult) {
      this.error.textContent = "";
      this.result.textContent = "";
    }
    this.updateActions();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.closeButton.disabled = busy;
    this.sourcePath.disabled = busy;
    this.inspectButton.disabled = busy;
    this.updateActions();
  }

  private updateActions(): void {
    const inspectionCurrent =
      this.inspection !== null && this.sourcePath.value.trim() === this.inspectedPath;
    this.commitButton.disabled =
      this.busy ||
      !this.importAllowed ||
      !inspectionCurrent ||
      (this.inspection?.blockingErrors.length ?? 1) > 0;
    for (const button of this.recoveryList.querySelectorAll("button")) {
      if (button instanceof HTMLButtonElement) {
        button.disabled = this.busy || !this.storageWritable;
      }
    }
  }

  private setStorageMode(mode: StorageDisplayMode, label: string): void {
    if (!(this.panel instanceof HTMLElement)) return;
    this.panel.dataset.mode = mode;
    this.modeBadge.textContent = label;
    this.modeBadge.title = label;
  }

  private hideRecovery(): void {
    this.recoverySection.hidden = true;
    this.recoveryList.replaceChildren();
  }

  private showError(error: StorageCommandError): void {
    const pointer = error.jsonPointer ? ` (${error.jsonPointer})` : "";
    const retry = error.retryable ? " 다시 시도할 수 있습니다." : "";
    this.error.textContent = `${error.message}${pointer}${retry}`;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.operationGeneration;
  }

  private async performReplacement<T>(
    generation: number,
    replace: () => Promise<T>,
  ): Promise<T> {
    const hooks = this.replacementHooks;
    if (hooks === undefined) return replace();

    let prepared = false;
    let committed = false;
    let finalized = false;
    const finalize = async (didCommit: boolean): Promise<void> => {
      if (!prepared || finalized) return;
      finalized = true;
      await hooks.afterReplace(didCommit);
    };

    try {
      await hooks.beforeReplace();
      prepared = true;
      if (!this.isCurrent(generation)) {
        await finalize(false);
        throw new Error("Workspace replacement was superseded before commit.");
      }

      const value = await replace();
      committed = true;
      await finalize(true);
      return value;
    } catch (error) {
      if (prepared && !committed && !finalized) {
        try {
          await finalize(false);
        } catch (hookError) {
          throw new Error(
            `Workspace replacement failed and restoration also failed: ${errorMessage(error)} · ${errorMessage(hookError)}`,
          );
        }
      }
      throw error;
    }
  }
}

export function createPhase3BMigrationUI(
  replacementHooks?: WorkspaceReplacementHooks,
): Phase3BMigrationUI {
  return new Phase3BMigrationUI(replacementHooks);
}

function normalizeStatus(
  value: unknown,
): { mode: string; writable: boolean; revision: number | null } {
  const record = asRecord(value);
  const mode = typeof record.mode === "string" ? record.mode.toLowerCase() : "";
  const explicitlyWritable = typeof record.writable === "boolean" ? record.writable : null;
  const writable =
    explicitlyWritable ??
    (mode === "ready" ||
      mode === "absent" ||
      mode === "writable" ||
      mode === "recoveryrequired");
  const revision = safeNonNegativeInteger(record.revision);
  return { mode, writable, revision };
}

function normalizeInspection(value: unknown): LegacyInspection {
  const record = asRecord(value);
  const inspectToken = requireNonEmptyString(record.inspectToken, "검사 토큰");
  const sourceSha256 = requireNonEmptyString(record.sourceSha256, "SHA-256");
  if (!SHA256_PATTERN.test(sourceSha256)) throw new Error("검사 결과의 SHA-256이 올바르지 않습니다.");
  return {
    inspectToken,
    sourceSha256: sourceSha256.toLowerCase(),
    projectCount: requireCount(record.projectCount, "프로젝트 수"),
    terminalCount: requireCount(record.terminalCount, "PowerShell 수"),
    recoverableWarnings: normalizeDiagnostics(record.recoverableWarnings),
    blockingErrors: normalizeDiagnostics(record.blockingErrors),
  };
}

function normalizeDiagnostics(value: unknown): InspectionDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      code: requireNonEmptyString(record.code, "진단 코드"),
      jsonPointer: typeof record.jsonPointer === "string" ? record.jsonPointer : "",
    };
  });
}

function normalizeRecoveryCandidates(value: unknown): RecoveryCandidate[] {
  const source = Array.isArray(value) ? value : asRecord(value).candidates;
  if (!Array.isArray(source)) throw new Error("복구 후보 응답이 올바르지 않습니다.");
  return source.map((item) => {
    const record = asRecord(item);
    return {
      candidateId: requireNonEmptyString(record.candidateId, "복구 후보 ID"),
      revision: safeNonNegativeInteger(record.revision),
      writtenAtUtc: typeof record.writtenAtUtc === "string" ? record.writtenAtUtc : null,
      byteLength: safeNonNegativeInteger(record.byteLength) ?? 0,
      valid: record.valid === true,
    };
  });
}

function normalizeImportPreview(value: unknown): WorkspaceSession {
  const record = asRecord(value);
  if (record.snapshot !== undefined) return createImportPreviewSession(record.snapshot);
  if (record.workspaceSnapshot !== undefined) {
    return createImportPreviewSession(record.workspaceSnapshot);
  }
  if (record.state !== undefined && record.revision !== undefined) {
    if (record.recovery !== undefined) {
      return createWorkspaceSession(normalizeWorkspaceLoadResponse(record), "importPreview");
    }
    return createImportPreviewSession({ revision: record.revision, state: record.state });
  }
  if (record.schemaVersion !== undefined && record.revision !== undefined) {
    return createImportPreviewSession({ revision: record.revision, state: record });
  }
  throw new Error("가져오기 결과의 작업 공간 미리보기가 올바르지 않습니다.");
}

function toStorageError(value: unknown): StorageCommandError {
  const unwrapped = unwrapCommandError(value);
  if (isRecord(unwrapped)) {
    const record = { ...unwrapped };
    if (!("jsonPointer" in record)) record.jsonPointer = null;
    try {
      return normalizeStorageCommandError(record);
    } catch {
      // Fall through to the safe generic envelope below.
    }
  }
  return {
    code: "io",
    message: errorMessage(unwrapped),
    retryable: false,
    jsonPointer: null,
  };
}

function unwrapCommandError(value: unknown): unknown {
  if (isRecord(value) && "error" in value) return value.error;
  return value;
}

function renderDiagnostics(list: HTMLElement, diagnostics: InspectionDiagnostic[]): void {
  list.replaceChildren();
  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    item.textContent = diagnostic.jsonPointer
      ? `${diagnostic.code} · ${diagnostic.jsonPointer}`
      : diagnostic.code;
    list.append(item);
  }
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function requireCount(value: unknown, label: string): number {
  const count = safeNonNegativeInteger(value);
  if (count === null) throw new Error(`${label}가 올바르지 않습니다.`);
  return count;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}이 올바르지 않습니다.`);
  }
  return value;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value) return value;
  if (isRecord(value) && typeof value.message === "string" && value.message) {
    return value.message;
  }
  return "저장소 명령을 완료하지 못했습니다.";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("명령 응답이 올바르지 않습니다.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function requireButton(id: string): HTMLButtonElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} is not a button`);
  return element;
}

function requireInput(id: string): HTMLInputElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`);
  return element;
}

function requireForm(id: string): HTMLFormElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLFormElement)) throw new Error(`#${id} is not a form`);
  return element;
}

function requireDialog(id: string): HTMLDialogElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLDialogElement)) throw new Error(`#${id} is not a dialog`);
  return element;
}
