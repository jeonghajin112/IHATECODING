export type AppLanguage = "en" | "ko";

export const APP_LANGUAGE_STORAGE_KEY = "ihatecoding.language.v1";
export const APP_LANGUAGE_CHANGED_EVENT = "ihatecoding:language-changed";

type TranslationPair = Readonly<Record<AppLanguage, string>>;

const registeredPairs = new Map<string, TranslationPair>();
let currentLanguage: AppLanguage = resolveInitialLanguage();

const BACKEND_ERROR_TRANSLATIONS: Readonly<Record<string, string>> = {
  "지원하지 않는 AI 서비스입니다.": "This AI service is not supported.",
  "지원하지 않는 AI 제공자입니다.": "This AI provider is not supported.",
  "CLI 홈 디렉터리는 절대 경로여야 합니다.": "The CLI home directory must be an absolute path.",
  "웹 패널 식별자가 올바르지 않습니다.": "The web pane identifier is invalid.",
  "웹 패널의 현재 주소를 확인하지 못했습니다.": "Could not read the web pane's current address.",
  "계정 목록 작업이 완료되지 않았습니다.": "The account list operation did not complete.",
  "계정 추가 작업이 완료되지 않았습니다.": "The account addition did not complete.",
  "계정 추가 취소 작업이 완료되지 않았습니다.": "Cancelling account addition did not complete.",
  "계정 전환 작업이 완료되지 않았습니다.": "The account switch did not complete.",
  "계정 추가가 취소되었습니다.": "Account addition was cancelled.",
  "사용자 홈 디렉터리를 찾지 못했습니다.": "Could not find the user home directory.",
  "앱 데이터 디렉터리는 절대 경로여야 합니다.": "The app data directory must be an absolute path.",
  "앱 데이터 디렉터리를 만들지 못했습니다.": "Could not create the app data directory.",
  "계정 레지스트리 디렉터리를 만들지 못했습니다.": "Could not create the account registry directory.",
  "관리 계정 디렉터리를 만들지 못했습니다.": "Could not create the managed account directory.",
  "계정 writer lock 파일이 안전하지 않습니다.": "The account writer-lock file is unsafe.",
  "다른 IHATECODING 창에서 계정 설정을 변경하고 있습니다.": "Another IHATECODING window is changing account settings.",
  "계정 writer lock을 열지 못했습니다.": "Could not open the account writer lock.",
  "계정 writer lock을 확인하지 못했습니다.": "Could not inspect the account writer lock.",
  "계정 writer lock을 획득하지 못했습니다.": "Could not acquire the account writer lock.",
  "계정 추가 작업의 완료 상태가 올바르지 않습니다.": "The account-addition completion state is invalid.",
  "공식 CLI 로그인 프로세스를 시작하지 못했습니다.": "Could not start the official CLI login process.",
  "공식 CLI 로그인 프로세스가 비정상 종료되었습니다.": "The official CLI login process exited unexpectedly.",
  "공식 CLI 로그인이 제한 시간을 초과했습니다.": "The official CLI login timed out.",
  "공식 CLI 로그인 상태를 확인하지 못했습니다.": "Could not verify the official CLI login state.",
  "OAuth 로그인 보호 작업을 만들지 못했습니다.": "Could not create the OAuth login protection job.",
  "OAuth 로그인 프로세스를 보호 작업에 연결하지 못했습니다.": "Could not attach the OAuth login process to its protection job.",
  "OAuth 로그인 프로세스를 종료하지 못했습니다.": "Could not stop the OAuth login process.",
  "OAuth 로그인 보호 작업을 설정하지 못했습니다.": "Could not configure the OAuth login protection job.",
  "이 제공자에 더 이상 계정을 추가할 수 없습니다.": "No more accounts can be added for this provider.",
  "로그인한 계정 정보를 확인하지 못했습니다.": "Could not read the signed-in account information.",
  "OAuth 계정 로그인이 확인되지 않았습니다.": "The OAuth account login could not be verified.",
  "계정 추가 취소를 기다리는 시간이 초과되었습니다.": "Timed out waiting for account addition to cancel.",
  "선택한 계정을 찾지 못했습니다.": "The selected account could not be found.",
  "계정 로그인이 진행 중이라 앱을 다시 시작할 수 없습니다.": "The app cannot restart while an account login is in progress.",
  "활성 계정 메타데이터가 올바르지 않습니다.": "The active-account metadata is invalid.",
  "관리 계정 제공자 디렉터리를 만들지 못했습니다.": "Could not create the managed provider directory.",
  "관리 계정 홈을 만들지 못했습니다.": "Could not create the managed account home.",
  "고유한 관리 계정 홈을 만들지 못했습니다.": "Could not create a unique managed account home.",
  "이 제공자의 계정 로그인이 이미 진행 중입니다.": "An account login for this provider is already in progress.",
  "계정 표시 이름이 올바르지 않습니다.": "The account display name is invalid.",
  "계정 식별자가 올바르지 않습니다.": "The account identifier is invalid.",
  "지원하지 않는 계정 레지스트리 버전입니다.": "This account registry version is not supported.",
  "계정 레지스트리에 중복 식별자가 있습니다.": "The account registry contains duplicate identifiers.",
  "계정 레지스트리의 계정 수가 제한을 초과했습니다.": "The account registry exceeds the account limit.",
  "활성 계정이 레지스트리에 없습니다.": "The active account is missing from the registry.",
  "계정 레지스트리를 확인하지 못했습니다.": "Could not inspect the account registry.",
  "계정 레지스트리 파일이 안전하지 않습니다.": "The account registry file is unsafe.",
  "계정 레지스트리를 열지 못했습니다.": "Could not open the account registry.",
  "계정 레지스트리를 읽지 못했습니다.": "Could not read the account registry.",
  "계정 레지스트리 크기가 올바르지 않습니다.": "The account registry size is invalid.",
  "계정 레지스트리를 다시 확인하지 못했습니다.": "Could not recheck the account registry.",
  "계정 레지스트리가 읽는 동안 변경되었습니다.": "The account registry changed while it was being read.",
  "계정 레지스트리 형식이 올바르지 않습니다.": "The account registry format is invalid.",
  "계정 레지스트리 대상이 안전하지 않습니다.": "The account registry target is unsafe.",
  "계정 레지스트리를 직렬화하지 못했습니다.": "Could not serialize the account registry.",
  "계정 레지스트리가 너무 큽니다.": "The account registry is too large.",
  "계정 레지스트리 임시 파일을 만들지 못했습니다.": "Could not create the temporary account registry file.",
  "계정 레지스트리 임시 파일을 기록하지 못했습니다.": "Could not write the temporary account registry file.",
  "계정 레지스트리 임시 파일을 검증하지 못했습니다.": "Could not validate the temporary account registry file.",
  "계정 레지스트리 임시 파일 검증에 실패했습니다.": "Temporary account registry validation failed.",
  "Codex 계정 설정을 만들지 못했습니다.": "Could not create the Codex account configuration.",
  "Codex 계정 설정을 기록하지 못했습니다.": "Could not write the Codex account configuration.",
  "관리 계정 홈을 찾지 못했습니다.": "Could not find the managed account home.",
  "관리 계정 홈 경로가 올바르지 않습니다.": "The managed account home path is invalid.",
  "관리 계정 홈이 허용된 경로 밖에 있습니다.": "The managed account home is outside the allowed directory.",
  "관리 계정 홈을 확인하지 못했습니다.": "Could not inspect the managed account home.",
  "관리 계정 홈이 안전하지 않습니다.": "The managed account home is unsafe.",
  "관리 계정 정리 경로가 올바르지 않습니다.": "The managed account cleanup path is invalid.",
  "관리 계정 정리 대상을 확인하지 못했습니다.": "Could not inspect the managed account cleanup target.",
  "관리 계정 정리 대상이 안전하지 않습니다.": "The managed account cleanup target is unsafe.",
  "관리 계정 임시 홈을 정리하지 못했습니다.": "Could not remove the temporary managed account home.",
  "계정 저장 경로는 절대 경로여야 합니다.": "The account storage path must be absolute.",
  "계정 저장 경로에 심볼릭 링크 또는 재분석 지점이 있습니다.": "The account storage path contains a symbolic link or reparse point.",
  "계정 저장 경로를 검증하지 못했습니다.": "Could not validate the account storage path.",
  "계정 레지스트리 대상을 확인하지 못했습니다.": "Could not inspect the account registry target.",
  "계정 레지스트리를 원자적으로 교체하지 못했습니다.": "Could not replace the account registry atomically.",
  "계정 레지스트리 디렉터리를 동기화하지 못했습니다.": "Could not synchronize the account registry directory.",
  "공식 CLI 실행 파일을 찾지 못했습니다.": "Could not find the official CLI executable.",
  "Windows 명령 셸을 안전하게 찾지 못했습니다.": "Could not safely locate the Windows command shell.",
  "CLI 명령 스크립트 경로가 안전하지 않습니다.": "The CLI command-script path is unsafe.",
  "CLI 로그인 인수가 안전하지 않습니다.": "The CLI login arguments are unsafe.",
};

export function resolveAppLanguage(
  storedLanguage: string | null | undefined,
  systemLanguages: readonly string[] = [],
): AppLanguage {
  if (storedLanguage === "en" || storedLanguage === "ko") return storedLanguage;
  return systemLanguages[0]?.toLowerCase().startsWith("ko") === true
    ? "ko"
    : "en";
}

export function getAppLanguage(): AppLanguage {
  return currentLanguage;
}

export function appLocale(language = currentLanguage): string {
  return language === "ko" ? "ko-KR" : "en-US";
}

export function tr(english: string, korean: string): string {
  const pair = { en: english, ko: korean } satisfies TranslationPair;
  registeredPairs.set(english, pair);
  registeredPairs.set(korean, pair);
  return pair[currentLanguage];
}

export function formatAppNumber(value: number): string {
  return value.toLocaleString(appLocale());
}

export function localizeBackendMessage(message: string): string {
  if (currentLanguage === "ko") return message;
  let localized = message;
  for (const [korean, english] of Object.entries(BACKEND_ERROR_TRANSLATIONS)) {
    localized = localized.split(korean).join(english);
  }
  localized = localized.replace(
    /공식 CLI 로그인이 완료되지 않았습니다 \(종료 코드 ([^)]+)\)\./g,
    "The official CLI login did not complete (exit code $1).",
  );
  localized = localized.replace(/([^\s]+) 잠금이 손상되었습니다\./g, "The $1 lock is corrupted.");
  return localized;
}

export function setAppLanguage(language: AppLanguage): void {
  if (currentLanguage === language) return;
  currentLanguage = language;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, language);
    }
  } catch {
    // A read-only WebView profile must not make the language selector unusable.
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    applyDocumentLanguage();
    window.dispatchEvent(
      new CustomEvent<AppLanguage>(APP_LANGUAGE_CHANGED_EVENT, { detail: language }),
    );
  }
}

export function subscribeAppLanguage(listener: (language: AppLanguage) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    listener((event as CustomEvent<AppLanguage>).detail);
  };
  window.addEventListener(APP_LANGUAGE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(APP_LANGUAGE_CHANGED_EVENT, handler);
}

export function applyDocumentLanguage(root: ParentNode = document): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = currentLanguage;

  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-en][data-i18n-ko]")) {
    const value = element.getAttribute(`data-i18n-${currentLanguage}`);
    if (value !== null) element.textContent = value;
  }

  const localizedAttributes = ["aria-label", "title", "placeholder"] as const;
  for (const attribute of localizedAttributes) {
    const selector =
      `[data-i18n-${attribute}-en][data-i18n-${attribute}-ko]`;
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const value = element.getAttribute(`data-i18n-${attribute}-${currentLanguage}`);
      if (value !== null) element.setAttribute(attribute, value);
    }
  }

  translateRegisteredDomValues(root);
}

export function initializeAppLanguage(): AppLanguage {
  applyDocumentLanguage();
  return currentLanguage;
}

function resolveInitialLanguage(): AppLanguage {
  let stored: string | null = null;
  try {
    if (typeof window !== "undefined") {
      stored = window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
    }
  } catch {
    // Use the system language when persistent WebView storage is unavailable.
  }
  const systemLanguages =
    typeof navigator === "undefined"
      ? ["en-US"]
      : navigator.languages ?? [navigator.language];
  return resolveAppLanguage(stored, systemLanguages);
}

function translateRegisteredDomValues(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  while (textNode) {
    const parent = textNode.parentElement;
    if (parent && !shouldSkipDomTranslation(parent)) {
      const text = textNode.textContent ?? "";
      const pair = registeredPairs.get(text);
      if (pair) textNode.textContent = pair[currentLanguage];
    }
    textNode = walker.nextNode();
  }

  const attributes = ["aria-label", "title", "placeholder"] as const;
  for (const element of root.querySelectorAll<HTMLElement>("[aria-label], [title], [placeholder]")) {
    if (shouldSkipDomTranslation(element)) continue;
    for (const attribute of attributes) {
      const current = element.getAttribute(attribute);
      if (current === null) continue;
      const pair = registeredPairs.get(current);
      if (pair) element.setAttribute(attribute, pair[currentLanguage]);
    }
  }
}

function shouldSkipDomTranslation(element: Element): boolean {
  return Boolean(
    element.closest(
      ".xterm, .terminal-host, [data-i18n-skip]",
    ),
  );
}
