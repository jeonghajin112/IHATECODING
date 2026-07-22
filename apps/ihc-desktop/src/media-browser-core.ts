export const MAX_MEDIA_SELECTION = 20;

export type MediaEntryKind = "directory" | "image" | "video" | "file";

export type ContentFileFamily =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "code"
  | "document"
  | "data"
  | "config"
  | "archive"
  | "font"
  | "executable"
  | "generic";

export type ContentFileVisual = Readonly<{
  family: ContentFileFamily;
  extension: string;
  marker: string;
  restricted: boolean;
}>;

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

const IMAGE_EXTENSIONS = new Set([
  "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tif",
  "tiff", "webp",
]);
const VIDEO_EXTENSIONS = new Set([
  "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv",
]);
const AUDIO_EXTENSIONS = new Set([
  "aac", "aiff", "alac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma",
]);
const CODE_EXTENSIONS = new Set([
  "astro", "c", "cc", "clj", "cljs", "cpp", "cs", "css", "dart", "ex", "exs", "fs",
  "fsx", "go", "h", "hpp", "html", "java", "js", "jsx", "kt", "kts", "less", "lua",
  "m", "mjs", "mm", "php", "pl", "ps1", "py", "r", "rb", "rs", "sass", "scala",
  "scss", "sh", "sol", "svelte", "swift", "tsx", "ts", "vue", "zig",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "doc", "docx", "epub", "md", "markdown", "mdown", "mdx", "mkd", "odf", "odg", "odp",
  "ods", "odt", "pdf", "ppt", "pptx", "rtf", "tex", "txt", "xls", "xlsx",
]);
const DATA_EXTENSIONS = new Set([
  "arrow", "csv", "db", "db3", "json", "jsonc", "jsonl", "ndjson", "parquet", "sqlite",
  "sqlite3", "sql", "tsv", "xml",
]);
const CONFIG_EXTENSIONS = new Set([
  "cfg", "conf", "config", "env", "ini", "lock", "properties", "toml", "yaml", "yml",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "7z", "bz2", "cab", "gz", "iso", "rar", "tar", "tar.bz2", "tar.gz", "tar.xz", "tgz",
  "xz", "zip",
]);
const FONT_EXTENSIONS = new Set([
  "eot", "otc", "otf", "ttc", "ttf", "woff", "woff2",
]);
const EXECUTABLE_EXTENSIONS = new Set([
  "apk", "appx", "appxbundle", "bin", "cmd", "com", "cpl", "dll", "dmg", "exe", "ipa",
  "jar", "lnk", "msi", "msix", "msixbundle", "reg", "scr", "sys", "wasm",
]);
const CODE_FILE_NAMES = new Set([
  "cmakelists.txt", "dockerfile", "gemfile", "justfile", "makefile", "rakefile",
]);
const CONFIG_FILE_NAMES = new Set([
  ".dockerignore", ".editorconfig", ".env", ".gitattributes", ".gitignore", ".npmrc",
  ".prettierignore", ".prettierrc", ".yarnrc", "cargo.lock", "cargo.toml", "composer.json",
  "deno.json", "deno.jsonc", "package-lock.json", "package.json", "pnpm-lock.yaml", "tsconfig.json",
  "vite.config.js", "vite.config.ts", "yarn.lock",
]);
const CONTENT_FILE_MARKERS: Readonly<Record<ContentFileFamily, string>> = {
  folder: "DIR",
  image: "IMG",
  video: "▶",
  audio: "♪",
  code: "</>",
  document: "TXT",
  data: "{}",
  config: "CFG",
  archive: "ZIP",
  font: "Aa",
  executable: ">_",
  generic: "FILE",
};

export function classifyContentFileVisual(
  entry: Pick<MediaBrowserEntry, "name" | "kind" | "openable">,
): ContentFileVisual {
  const normalizedName = entry.name.trim().toLowerCase();
  const extension = contentFileExtension(normalizedName);
  let family: ContentFileFamily;

  if (entry.kind === "directory") {
    family = "folder";
  } else if (entry.kind === "image" || IMAGE_EXTENSIONS.has(extension)) {
    family = "image";
  } else if (entry.kind === "video" || VIDEO_EXTENSIONS.has(extension)) {
    family = "video";
  } else if (AUDIO_EXTENSIONS.has(extension)) {
    family = "audio";
  } else if (CODE_FILE_NAMES.has(normalizedName)) {
    family = "code";
  } else if (CONFIG_FILE_NAMES.has(normalizedName) || isConfigFileName(normalizedName, extension)) {
    family = "config";
  } else if (CODE_EXTENSIONS.has(extension)) {
    family = "code";
  } else if (DOCUMENT_EXTENSIONS.has(extension)) {
    family = "document";
  } else if (DATA_EXTENSIONS.has(extension)) {
    family = "data";
  } else if (ARCHIVE_EXTENSIONS.has(extension)) {
    family = "archive";
  } else if (FONT_EXTENSIONS.has(extension)) {
    family = "font";
  } else if (EXECUTABLE_EXTENSIONS.has(extension) || !entry.openable) {
    family = "executable";
  } else {
    family = "generic";
  }

  return {
    family,
    extension: contentFileExtensionLabel(entry.name, entry.kind, family),
    marker: CONTENT_FILE_MARKERS[family],
    restricted: !entry.openable,
  };
}

function contentFileExtension(name: string): string {
  for (const compound of ["tar.bz2", "tar.gz", "tar.xz"] as const) {
    if (name.endsWith(`.${compound}`)) return compound;
  }
  if (name.startsWith(".") && name.indexOf(".", 1) < 0) return name.slice(1);
  const separator = name.lastIndexOf(".");
  return separator >= 0 && separator < name.length - 1 ? name.slice(separator + 1) : "";
}

function contentFileExtensionLabel(
  name: string,
  kind: MediaEntryKind,
  family: ContentFileFamily,
): string {
  const normalizedName = name.trim().toLowerCase();
  if (kind === "directory") return "DIR";
  const extension = contentFileExtension(normalizedName).replace(/[^a-z0-9.]/g, "").toUpperCase();
  if (extension === "TAR.BZ2") return "TBZ2";
  if (extension) return extension.slice(0, 6);
  if (CODE_FILE_NAMES.has(normalizedName)) return normalizedName === "dockerfile" ? "DOCKER" : "CODE";
  if (CONFIG_FILE_NAMES.has(normalizedName)) return "CONFIG";
  if (family === "image") return "IMG";
  if (family === "video") return "VID";
  if (family === "audio") return "AUDIO";
  return "FILE";
}

function isConfigFileName(name: string, extension: string): boolean {
  if (CONFIG_EXTENSIONS.has(extension)) return true;
  if (name.startsWith(".env.")) return true;
  if (/^(?:eslint|prettier|stylelint|tailwind|vite|vitest|webpack)\.config\./.test(name)) return true;
  return /(?:^|[.-])config\.(?:js|cjs|mjs|ts|json)$/.test(name);
}

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
