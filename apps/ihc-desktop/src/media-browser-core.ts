export const MAX_MEDIA_SELECTION = 20;

export type MediaEntryKind = "directory" | "image" | "video" | "file";

export type MediaBrowserEntry = Readonly<{
  name: string;
  pathSegments: string[];
  kind: MediaEntryKind;
  sizeBytes: number | null;
  previewPath: string | null;
  openable: boolean;
}>;

export type MediaRootGrant = Readonly<{
  grantId: string;
  rootName: string;
  rootPath: string;
  initialPathSegments: string[];
  focusFileName: string | null;
}>;

export type MediaVolumeGrant = Readonly<{
  grantId: string;
  rootName: string;
  rootPath: string;
}>;

export type MediaDirectoryResponse = Readonly<{
  grantId: string;
  rootName: string;
  pathSegments: string[];
  entries: MediaBrowserEntry[];
  truncated: boolean;
}>;

export function normalizeMediaRootGrant(value: unknown): MediaRootGrant {
  const record = requireRecord(value, "media root grant");
  const focusFileName = record.focusFileName;
  if (focusFileName !== undefined && focusFileName !== null && typeof focusFileName !== "string") {
    throw new Error("The focused media file name is invalid.");
  }
  return {
    grantId: requireBoundedString(record.grantId, "media grant identifier", 128),
    rootName: requireBoundedString(record.rootName, "media root name", 512),
    rootPath: requireBoundedString(record.rootPath, "media root path", 32_768),
    initialPathSegments: normalizeSegments(record.initialPathSegments),
    focusFileName:
      typeof focusFileName === "string"
        ? requireBoundedString(focusFileName, "focused media file name", 512)
        : null,
  };
}

export function normalizeMediaVolumeList(value: unknown): MediaVolumeGrant[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("The media volume list is invalid.");
  }
  return value.map((item) => {
    const record = requireRecord(item, "media volume");
    return {
      grantId: requireBoundedString(record.grantId, "media grant identifier", 128),
      rootName: requireBoundedString(record.rootName, "media root name", 512),
      rootPath: requireBoundedString(record.rootPath, "media root path", 32_768),
    };
  });
}

export function normalizeMediaDirectoryResponse(value: unknown): MediaDirectoryResponse {
  const record = requireRecord(value, "media directory response");
  if (!Array.isArray(record.entries) || record.entries.length > 240) {
    throw new Error("The media directory entry list is invalid.");
  }
  if (typeof record.truncated !== "boolean") {
    throw new Error("The media directory truncation state is invalid.");
  }
  return {
    grantId: requireBoundedString(record.grantId, "media grant identifier", 128),
    rootName: requireBoundedString(record.rootName, "media root name", 512),
    pathSegments: normalizeSegments(record.pathSegments),
    entries: record.entries.map(normalizeMediaEntry),
    truncated: record.truncated,
  };
}

export function normalizeResolvedMediaFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_MEDIA_SELECTION) {
    throw new Error("The resolved media file list is invalid.");
  }
  return value.map((path) => requireBoundedString(path, "media file path", 32_768));
}

export function mediaEntryKey(pathSegments: readonly string[]): string {
  return JSON.stringify(pathSegments);
}

export function appendMediaSelection(
  selectedKeys: readonly string[],
  key: string,
  maximum = MAX_MEDIA_SELECTION,
): { keys: string[]; changed: boolean; full: boolean } {
  const unique = [...new Set(selectedKeys)];
  const existing = unique.indexOf(key);
  if (existing >= 0) {
    unique.splice(existing, 1);
    return { keys: unique, changed: true, full: false };
  }
  const boundedMaximum = Math.max(0, Math.min(MAX_MEDIA_SELECTION, maximum));
  if (unique.length >= boundedMaximum) {
    return { keys: unique, changed: false, full: true };
  }
  unique.push(key);
  return { keys: unique, changed: true, full: false };
}

function normalizeMediaEntry(value: unknown): MediaBrowserEntry {
  const record = requireRecord(value, "media entry");
  const kind = record.kind;
  if (kind !== "directory" && kind !== "image" && kind !== "video" && kind !== "file") {
    throw new Error("The media entry kind is invalid.");
  }
  const sizeBytes = record.sizeBytes;
  if (
    sizeBytes !== null &&
    (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  ) {
    throw new Error("The media entry size is invalid.");
  }
  const previewPath = record.previewPath;
  if (previewPath !== null && typeof previewPath !== "string") {
    throw new Error("The media preview path is invalid.");
  }
  if (typeof record.openable !== "boolean") {
    throw new Error("The media entry openable state is invalid.");
  }
  return {
    name: requireBoundedString(record.name, "media entry name", 512),
    pathSegments: normalizeSegments(record.pathSegments),
    kind,
    sizeBytes,
    previewPath:
      typeof previewPath === "string"
        ? requireBoundedString(previewPath, "media preview path", 32_768)
        : null,
    openable: record.openable,
  };
}

function normalizeSegments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("The media path is invalid.");
  }
  return value.map((segment) => requireBoundedString(segment, "media path segment", 512));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}
