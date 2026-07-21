export type AgentBrowserSettings = Readonly<{
  useEmbeddedBrowserTools: boolean;
}>;

export const AGENT_BROWSER_SETTINGS_STORAGE_KEY = "ihatecoding.agent-browser.v1";
export const AGENT_BROWSER_SETTINGS_CHANGED_EVENT =
  "ihatecoding:agent-browser-settings-changed";

export const DEFAULT_AGENT_BROWSER_SETTINGS: AgentBrowserSettings = Object.freeze({
  // Sessions started inside IHATECODING should use the browser that the user
  // can actually see in the workspace. The setting remains optional and can
  // be disabled without changing the user's global Codex/Chrome configuration.
  useEmbeddedBrowserTools: true,
});

let currentSettings = loadAgentBrowserSettings();

export function resolveAgentBrowserSettings(
  storedValue: string | null | undefined,
): AgentBrowserSettings {
  if (!storedValue) return DEFAULT_AGENT_BROWSER_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (!isRecord(parsed) || typeof parsed.useEmbeddedBrowserTools !== "boolean") {
      return DEFAULT_AGENT_BROWSER_SETTINGS;
    }
    return Object.freeze({
      useEmbeddedBrowserTools: parsed.useEmbeddedBrowserTools,
    });
  } catch {
    return DEFAULT_AGENT_BROWSER_SETTINGS;
  }
}

export function getUseEmbeddedBrowserTools(): boolean {
  return currentSettings.useEmbeddedBrowserTools;
}

export function setUseEmbeddedBrowserTools(enabled: boolean): AgentBrowserSettings {
  if (currentSettings.useEmbeddedBrowserTools === enabled) return currentSettings;
  currentSettings = Object.freeze({ useEmbeddedBrowserTools: enabled });
  persistAgentBrowserSettings(currentSettings);
  dispatchAgentBrowserSettingsChanged(currentSettings);
  return currentSettings;
}

export function subscribeAgentBrowserSettings(
  listener: (settings: AgentBrowserSettings) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    listener((event as CustomEvent<AgentBrowserSettings>).detail);
  };
  window.addEventListener(AGENT_BROWSER_SETTINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(AGENT_BROWSER_SETTINGS_CHANGED_EVENT, handler);
}

function loadAgentBrowserSettings(): AgentBrowserSettings {
  try {
    if (typeof window !== "undefined") {
      return resolveAgentBrowserSettings(
        window.localStorage.getItem(AGENT_BROWSER_SETTINGS_STORAGE_KEY),
      );
    }
  } catch {
    // A locked-down WebView profile still gets the safe in-app default.
  }
  return DEFAULT_AGENT_BROWSER_SETTINGS;
}

function persistAgentBrowserSettings(settings: AgentBrowserSettings): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        AGENT_BROWSER_SETTINGS_STORAGE_KEY,
        JSON.stringify(settings),
      );
    }
  } catch {
    // The in-memory choice remains effective for newly started sessions.
  }
}

function dispatchAgentBrowserSettingsChanged(settings: AgentBrowserSettings): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AgentBrowserSettings>(AGENT_BROWSER_SETTINGS_CHANGED_EVENT, {
      detail: settings,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
