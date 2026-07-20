export const FOOTER_PROVIDER_IDS = Object.freeze([
  "codex",
  "grok",
  "claudeCode",
  "openCode",
] as const);

export type FooterProviderId = (typeof FOOTER_PROVIDER_IDS)[number];

export type FooterProviderSettings = Readonly<{
  order: readonly FooterProviderId[];
  visible: readonly FooterProviderId[];
}>;

export const FOOTER_PROVIDER_SETTINGS_STORAGE_KEY =
  "ihatecoding.footer-providers.v1";
export const FOOTER_PROVIDER_SETTINGS_CHANGED_EVENT =
  "ihatecoding:footer-provider-settings-changed";

export const DEFAULT_FOOTER_PROVIDER_SETTINGS = freezeSettings({
  order: FOOTER_PROVIDER_IDS,
  visible: FOOTER_PROVIDER_IDS,
});

const footerProviderIds = new Set<string>(FOOTER_PROVIDER_IDS);

let storedDocument = readStoredDocument();
let currentSettings = resolveFooterProviderSettingsDocument(storedDocument);

export function isFooterProviderId(value: unknown): value is FooterProviderId {
  return typeof value === "string" && footerProviderIds.has(value);
}

/**
 * Resolve persisted settings into the complete set of providers known by this build.
 * New providers are appended in their default order, while an empty visible list is
 * kept because hiding every footer item is a valid user choice.
 */
export function resolveFooterProviderSettings(
  storedValue: string | null | undefined,
): FooterProviderSettings {
  if (!storedValue) return DEFAULT_FOOTER_PROVIDER_SETTINGS;

  try {
    return resolveFooterProviderSettingsDocument(JSON.parse(storedValue));
  } catch {
    return DEFAULT_FOOTER_PROVIDER_SETTINGS;
  }
}

export function normalizeFooterProviderOrder(
  order: readonly unknown[],
): readonly FooterProviderId[] {
  const normalized = uniqueKnownProviders(order);
  for (const provider of FOOTER_PROVIDER_IDS) {
    if (!normalized.includes(provider)) normalized.push(provider);
  }
  return Object.freeze(normalized);
}

export function visibleFooterProviders(
  settings: FooterProviderSettings,
): readonly FooterProviderId[] {
  const visible = new Set(settings.visible);
  return Object.freeze(settings.order.filter((provider) => visible.has(provider)));
}

export function isFooterProviderVisible(
  settings: FooterProviderSettings,
  provider: FooterProviderId,
): boolean {
  return settings.visible.includes(provider);
}

export function withFooterProviderVisibility(
  settings: FooterProviderSettings,
  provider: FooterProviderId,
  visible: boolean,
): FooterProviderSettings {
  const currentlyVisible = settings.visible.includes(provider);
  if (currentlyVisible === visible) return settings;

  const visibleSet = new Set(settings.visible);
  if (visible) {
    visibleSet.add(provider);
  } else {
    visibleSet.delete(provider);
  }
  return freezeSettings({
    order: settings.order,
    visible: settings.order.filter((candidate) => visibleSet.has(candidate)),
  });
}

/**
 * Move one provider before another. Passing null as beforeProvider moves it to the
 * end. This is directly usable with pointer-based insertion markers.
 */
export function moveFooterProviderBefore(
  settings: FooterProviderSettings,
  provider: FooterProviderId,
  beforeProvider: FooterProviderId | null,
): FooterProviderSettings {
  if (provider === beforeProvider) return settings;

  const order = [...settings.order];
  const sourceIndex = order.indexOf(provider);
  if (sourceIndex < 0) return settings;
  if (beforeProvider !== null && !order.includes(beforeProvider)) return settings;

  order.splice(sourceIndex, 1);
  const insertionIndex =
    beforeProvider === null ? order.length : order.indexOf(beforeProvider);
  order.splice(insertionIndex, 0, provider);
  if (arraysEqual(order, settings.order)) return settings;

  return freezeSettings({ order, visible: settings.visible });
}

/** Keyboard-accessible equivalent of one drag-reorder step. */
export function moveFooterProviderByOffset(
  settings: FooterProviderSettings,
  provider: FooterProviderId,
  offset: -1 | 1,
): FooterProviderSettings {
  const sourceIndex = settings.order.indexOf(provider);
  if (sourceIndex < 0) return settings;
  const targetIndex = sourceIndex + offset;
  if (targetIndex < 0 || targetIndex >= settings.order.length) return settings;

  const order = [...settings.order];
  [order[sourceIndex], order[targetIndex]] = [order[targetIndex], order[sourceIndex]];
  return freezeSettings({ order, visible: settings.visible });
}

export function getFooterProviderSettings(): FooterProviderSettings {
  return currentSettings;
}

export function setFooterProviderVisible(
  provider: FooterProviderId,
  visible: boolean,
): FooterProviderSettings {
  return commitFooterProviderSettings(
    withFooterProviderVisibility(currentSettings, provider, visible),
  );
}

export function reorderFooterProvider(
  provider: FooterProviderId,
  beforeProvider: FooterProviderId | null,
): FooterProviderSettings {
  return commitFooterProviderSettings(
    moveFooterProviderBefore(currentSettings, provider, beforeProvider),
  );
}

export function moveFooterProvider(
  provider: FooterProviderId,
  offset: -1 | 1,
): FooterProviderSettings {
  return commitFooterProviderSettings(
    moveFooterProviderByOffset(currentSettings, provider, offset),
  );
}

export function subscribeFooterProviderSettings(
  listener: (settings: FooterProviderSettings) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<FooterProviderSettings>).detail;
    listener(detail);
  };
  window.addEventListener(FOOTER_PROVIDER_SETTINGS_CHANGED_EVENT, handler);
  return () =>
    window.removeEventListener(FOOTER_PROVIDER_SETTINGS_CHANGED_EVENT, handler);
}

/**
 * Merge known settings into an existing document without deleting future fields or
 * provider identifiers that this version does not understand.
 */
export function serializeFooterProviderSettings(
  settings: FooterProviderSettings,
  previousStoredValue?: string | null,
): string {
  const previous = parseRecord(previousStoredValue);
  return JSON.stringify(mergeSettingsDocument(previous, settings));
}

function commitFooterProviderSettings(
  next: FooterProviderSettings,
): FooterProviderSettings {
  if (settingsEqual(currentSettings, next)) return currentSettings;

  currentSettings = next;
  storedDocument = mergeSettingsDocument(storedDocument, next);
  persistFooterProviderSettings(storedDocument);
  dispatchFooterProviderSettingsChanged(next);
  return next;
}

function resolveFooterProviderSettingsDocument(
  document: unknown,
): FooterProviderSettings {
  if (!isRecord(document)) return DEFAULT_FOOTER_PROVIDER_SETTINGS;
  if (!Array.isArray(document.order) || !Array.isArray(document.visible)) {
    return DEFAULT_FOOTER_PROVIDER_SETTINGS;
  }

  return freezeSettings({
    order: normalizeFooterProviderOrder(document.order),
    visible: uniqueKnownProviders(document.visible),
  });
}

function uniqueKnownProviders(values: readonly unknown[]): FooterProviderId[] {
  const providers: FooterProviderId[] = [];
  for (const value of values) {
    if (isFooterProviderId(value) && !providers.includes(value)) {
      providers.push(value);
    }
  }
  return providers;
}

function mergeSettingsDocument(
  previous: Record<string, unknown>,
  settings: FooterProviderSettings,
): Record<string, unknown> {
  return {
    ...previous,
    order: mergeKnownProviderArray(previous.order, settings.order),
    visible: mergeKnownProviderArray(previous.visible, settings.visible),
  };
}

function mergeKnownProviderArray(
  previous: unknown,
  nextKnown: readonly FooterProviderId[],
): unknown[] {
  if (!Array.isArray(previous)) return [...nextKnown];

  const remaining = [...nextKnown];
  const merged: unknown[] = [];
  for (const entry of previous) {
    if (isFooterProviderId(entry)) {
      const replacement = remaining.shift();
      if (replacement !== undefined) merged.push(replacement);
    } else {
      merged.push(entry);
    }
  }
  merged.push(...remaining);
  return merged;
}

function readStoredDocument(): Record<string, unknown> {
  try {
    if (typeof window !== "undefined") {
      return parseRecord(
        window.localStorage.getItem(FOOTER_PROVIDER_SETTINGS_STORAGE_KEY),
      );
    }
  } catch {
    // A missing or read-only WebView profile falls back to safe defaults.
  }
  return {};
}

function persistFooterProviderSettings(document: Record<string, unknown>): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        FOOTER_PROVIDER_SETTINGS_STORAGE_KEY,
        JSON.stringify(document),
      );
    }
  } catch {
    // Keep in-memory preferences usable when WebView storage is unavailable.
  }
}

function dispatchFooterProviderSettingsChanged(
  settings: FooterProviderSettings,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FooterProviderSettings>(
      FOOTER_PROVIDER_SETTINGS_CHANGED_EVENT,
      { detail: settings },
    ),
  );
}

function freezeSettings(input: {
  order: readonly FooterProviderId[];
  visible: readonly FooterProviderId[];
}): FooterProviderSettings {
  return Object.freeze({
    order: Object.freeze([...input.order]),
    visible: Object.freeze([...input.visible]),
  });
}

function settingsEqual(
  first: FooterProviderSettings,
  second: FooterProviderSettings,
): boolean {
  return arraysEqual(first.order, second.order) && arraysEqual(first.visible, second.visible);
}

function arraysEqual<T>(first: readonly T[], second: readonly T[]): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
