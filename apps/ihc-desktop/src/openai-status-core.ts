export type OpenAiStatusLevel =
  | "operational"
  | "degraded"
  | "outage"
  | "maintenance"
  | "unknown";

export type OpenAiServiceStatus = Readonly<{
  key: "chatgpt" | "api" | "codex";
  name: string;
  status: OpenAiStatusLevel;
}>;

export type OpenAiIncident = Readonly<{
  id: string;
  name: string;
  status: string;
  impact: string;
  updatedAt: string | null;
  latestUpdate: string | null;
}>;

export type OpenAiStatusSnapshot = Readonly<{
  overallStatus: OpenAiStatusLevel;
  overallDescription: string;
  status: OpenAiStatusLevel;
  services: readonly OpenAiServiceStatus[];
  incidents: readonly OpenAiIncident[];
  sourceUpdatedAt: string | null;
  checkedAtUnixMs: number;
  stale: boolean;
}>;

const STATUS_LEVELS = new Set<OpenAiStatusLevel>([
  "operational",
  "degraded",
  "outage",
  "maintenance",
  "unknown",
]);

const SERVICE_NAMES = Object.freeze({
  chatgpt: "ChatGPT",
  api: "API",
  codex: "Codex",
} as const);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusLevel(value: unknown): OpenAiStatusLevel {
  return typeof value === "string" && STATUS_LEVELS.has(value as OpenAiStatusLevel)
    ? (value as OpenAiStatusLevel)
    : "unknown";
}

function boundedText(value: unknown, maximum: number, fallback = "") {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

function normalizeServices(value: unknown): readonly OpenAiServiceStatus[] {
  if (!Array.isArray(value)) return [];
  const services: OpenAiServiceStatus[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, 12)) {
    const source = record(candidate);
    const key = source?.key;
    if (
      !source ||
      (key !== "chatgpt" && key !== "api" && key !== "codex") ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    services.push(Object.freeze({
      key,
      // Service names are local constants. Upstream text never becomes UI markup.
      name: SERVICE_NAMES[key],
      status: statusLevel(source.status),
    }));
  }
  return Object.freeze(services);
}

function normalizeIncidents(value: unknown): readonly OpenAiIncident[] {
  if (!Array.isArray(value)) return [];
  const incidents: OpenAiIncident[] = [];
  for (const candidate of value.slice(0, 3)) {
    const source = record(candidate);
    if (!source) continue;
    const id = boundedText(source.id, 96);
    const name = boundedText(source.name, 180);
    if (!id || !name) continue;
    incidents.push(Object.freeze({
      id,
      name,
      status: boundedText(source.status, 48, "unknown"),
      impact: boundedText(source.impact, 48, "unknown"),
      updatedAt: timestamp(source.updatedAt),
      latestUpdate: boundedText(source.latestUpdate, 360) || null,
    }));
  }
  return Object.freeze(incidents);
}

export function normalizeOpenAiStatusSnapshot(value: unknown): OpenAiStatusSnapshot {
  const source = record(value);
  if (!source) throw new Error("OpenAI status response is invalid.");
  const checkedAtUnixMs = Number(source.checkedAtUnixMs);
  if (!Number.isSafeInteger(checkedAtUnixMs) || checkedAtUnixMs <= 0) {
    throw new Error("OpenAI status check time is invalid.");
  }
  return Object.freeze({
    overallStatus: statusLevel(source.overallStatus),
    overallDescription: boundedText(source.overallDescription, 240),
    status: statusLevel(source.status),
    services: normalizeServices(source.services),
    incidents: normalizeIncidents(source.incidents),
    sourceUpdatedAt: timestamp(source.sourceUpdatedAt),
    checkedAtUnixMs,
    stale: source.stale === true,
  });
}

export function openAiStatusTone(status: OpenAiStatusLevel) {
  switch (status) {
    case "operational":
      return "normal";
    case "degraded":
      return "warning";
    case "outage":
      return "error";
    case "maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}

export function shouldShowOpenAiStatusSummary(status: OpenAiStatusLevel) {
  return status !== "operational";
}

export function openAiStatusLabel(status: OpenAiStatusLevel, locale: "en" | "ko") {
  const korean = locale === "ko";
  switch (status) {
    case "operational":
      return korean ? "정상" : "Operational";
    case "degraded":
      return korean ? "성능 저하" : "Degraded";
    case "outage":
      return korean ? "장애" : "Outage";
    case "maintenance":
      return korean ? "점검 중" : "Maintenance";
    default:
      return korean ? "확인 불가" : "Unavailable";
  }
}

export function openAiIncidentStatusLabel(status: string, locale: "en" | "ko") {
  if (locale !== "ko") {
    return (boundedText(status, 48, "Unknown") || "Unknown").replace(/_/g, " ");
  }
  switch (status.toLowerCase()) {
    case "investigating":
      return "조사 중";
    case "identified":
      return "원인 확인";
    case "monitoring":
      return "모니터링 중";
    case "resolved":
      return "해결됨";
    default:
      return "상태 확인 중";
  }
}

export function isOpenAiStatusSnapshotFresh(
  snapshot: OpenAiStatusSnapshot,
  nowMs: number,
  maximumAgeMs: number,
) {
  return (
    !snapshot.stale &&
    Number.isFinite(nowMs) &&
    Number.isFinite(maximumAgeMs) &&
    maximumAgeMs >= 0 &&
    nowMs >= snapshot.checkedAtUnixMs &&
    nowMs - snapshot.checkedAtUnixMs <= maximumAgeMs
  );
}
