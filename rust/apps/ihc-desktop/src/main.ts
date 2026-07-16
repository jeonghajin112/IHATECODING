import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Webview } from "@tauri-apps/api/webview";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

type TerminalEvent =
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
      data: { sessionId: string; exitCode: number | null };
    };

type StartTerminalResponse = {
  sessionId: string;
  processId: number | null;
};

type BrowserState = "closed" | "opening" | "open" | "closing";

const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "bar",
  cursorWidth: 1,
  fontFamily: "Cascadia Mono, D2Coding, Consolas, monospace",
  fontSize: 15,
  fontWeight: "400",
  fontWeightBold: "600",
  lineHeight: 1.08,
  letterSpacing: 0,
  scrollback: 10_000,
  smoothScrollDuration: 0,
  rightClickSelectsWord: false,
  scrollbar: {
    width: 7,
  },
  theme: {
    background: "#050505",
    foreground: "#f4f4f5",
    cursor: "#f4f4f5",
    cursorAccent: "#050505",
    selectionBackground: "#3f3f46",
    scrollbarSliderBackground: "#747474",
    scrollbarSliderHoverBackground: "#8a8a8a",
    scrollbarSliderActiveBackground: "#a0a0a0",
    black: "#050505",
    red: "#f87171",
    green: "#86efac",
    yellow: "#fde68a",
    blue: "#7dd3fc",
    magenta: "#d8b4fe",
    cyan: "#67e8f9",
    white: "#e4e4e7",
    brightBlack: "#71717a",
    brightRed: "#fca5a5",
    brightGreen: "#bbf7d0",
    brightYellow: "#fef3c7",
    brightBlue: "#bae6fd",
    brightMagenta: "#e9d5ff",
    brightCyan: "#a5f3fc",
    brightWhite: "#fafafa",
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

const terminalElement = requireElement("terminal");
const terminalSurface = requireElement("terminal-surface");
const statusElement = requireElement("status");
const startButton = requireButton("start-terminal");
const stopButton = requireButton("stop-terminal");
const browserButton = requireButton("toggle-browser");

terminal.open(terminalElement);

let sessionId: string | null = null;
let browserWebview: Webview | null = null;
let browserLabel: string | null = null;
let browserState: BrowserState = "closed";
let resizeTimer = 0;
let inputQueue: Promise<unknown> = Promise.resolve();
let layoutQueue: Promise<void> = Promise.resolve();
let userBrowsingScrollback = false;
let selectionGestureActive = false;
let interactionEpoch = 0;

function setStatus(message: string, tone: "normal" | "error" = "normal") {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
}

function isAtBottom() {
  const buffer = terminal.buffer.active;
  return buffer.viewportY === buffer.baseY;
}

function canAutoFollow() {
  return (
    !userBrowsingScrollback &&
    !selectionGestureActive &&
    !terminal.hasSelection()
  );
}

function pauseAutoFollow() {
  userBrowsingScrollback = true;
  interactionEpoch += 1;
}

function resumeAutoFollowForInput() {
  userBrowsingScrollback = false;
  selectionGestureActive = false;
  interactionEpoch += 1;
  terminal.scrollToBottom();
}

function writeOutput(data: string) {
  const shouldFollow = canAutoFollow() && isAtBottom();
  const writeEpoch = interactionEpoch;
  terminal.write(data, () => {
    if (shouldFollow && writeEpoch === interactionEpoch && canAutoFollow()) {
      terminal.scrollToBottom();
    }
  });
}

function queueInput(data: string) {
  if (!sessionId || !data) return;
  const targetSession = sessionId;
  inputQueue = inputQueue
    .then(() =>
      invoke("write_terminal", {
        sessionId: targetSession,
        data,
      }),
    )
    .catch((error) => setStatus(String(error), "error"));
}

async function startTerminal() {
  if (sessionId) return;
  startButton.disabled = true;
  setStatus("Rust ConPTY에서 PowerShell을 시작하는 중…");
  let invokeResolved = false;
  let exitedBeforeInvokeResolved = false;
  let exitedSessionId: string | null = null;
  const pendingOutput: Array<Extract<TerminalEvent, { event: "output" }>["data"]> = [];

  const flushPendingOutput = (targetSessionId: string) => {
    const ready = pendingOutput
      .filter((entry) => entry.sessionId === targetSessionId)
      .sort((left, right) => left.sequence - right.sequence);
    for (const entry of ready) writeOutput(entry.data);
    for (let index = pendingOutput.length - 1; index >= 0; index -= 1) {
      if (pendingOutput[index].sessionId === targetSessionId) {
        pendingOutput.splice(index, 1);
      }
    }
  };

  const onEvent = new Channel<TerminalEvent>();
  onEvent.onmessage = (message) => {
    switch (message.event) {
      case "started":
        if (exitedSessionId === message.data.sessionId) break;
        if (!sessionId || sessionId === message.data.sessionId) {
          sessionId = message.data.sessionId;
          flushPendingOutput(message.data.sessionId);
        }
        setStatus(
          message.data.processId
            ? `ConPTY 연결됨 · PID ${message.data.processId}`
            : "ConPTY 연결됨",
        );
        break;
      case "output":
        if (message.data.sessionId === sessionId) {
          writeOutput(message.data.data);
        } else if (
          !invokeResolved &&
          exitedSessionId !== message.data.sessionId
        ) {
          pendingOutput.push(message.data);
        }
        break;
      case "error":
        setStatus(message.data.message, "error");
        break;
      case "exited":
        exitedSessionId = message.data.sessionId;
        flushPendingOutput(message.data.sessionId);
        if (!invokeResolved) exitedBeforeInvokeResolved = true;
        if (message.data.sessionId === sessionId) {
          sessionId = null;
          startButton.disabled = false;
          stopButton.disabled = true;
          setStatus(`PowerShell 종료 · code ${message.data.exitCode ?? "?"}`);
        }
        break;
    }
  };

  try {
    fitAddon.fit();
    const result = await invoke<StartTerminalResponse>("start_terminal", {
      cwd: null,
      columns: Math.max(2, terminal.cols),
      rows: Math.max(1, terminal.rows),
      onEvent,
    });
    invokeResolved = true;
    if (!exitedBeforeInvokeResolved) {
      sessionId = result.sessionId;
      flushPendingOutput(result.sessionId);
      stopButton.disabled = false;
      terminal.focus();
    }
  } catch (error) {
    invokeResolved = true;
    const startedSession = sessionId;
    sessionId = null;
    if (startedSession) {
      await invoke("stop_terminal", { sessionId: startedSession }).catch(
        () => undefined,
      );
    }
    startButton.disabled = false;
    stopButton.disabled = true;
    setStatus(String(error), "error");
  }
}

async function stopTerminal() {
  if (!sessionId) return;
  const targetSession = sessionId;
  stopButton.disabled = true;
  try {
    await invoke("stop_terminal", { sessionId: targetSession });
  } catch (error) {
    stopButton.disabled = false;
    setStatus(String(error), "error");
  }
}

function scheduleFit() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    layoutQueue = layoutQueue.then(applyLayout).catch((error) => {
      setStatus(String(error), "error");
    });
  }, 35);
}

async function applyLayout() {
  fitAddon.fit();
  const targetSession = sessionId;
  if (targetSession) {
    try {
      await invoke("resize_terminal", {
        sessionId: targetSession,
        columns: Math.max(2, terminal.cols),
        rows: Math.max(1, terminal.rows),
      });
    } catch (error) {
      if (sessionId === targetSession) throw error;
    }
  }
  await syncBrowserBounds();
}

async function syncBrowserBounds() {
  if (browserState !== "open" || !browserWebview) return;
  const bounds = terminalSurface.getBoundingClientRect();
  await browserWebview.setPosition(
    new LogicalPosition(Math.round(bounds.left), Math.round(bounds.top)),
  );
  await browserWebview.setSize(
    new LogicalSize(
      Math.max(1, Math.round(bounds.width)),
      Math.max(1, Math.round(bounds.height)),
    ),
  );
}

async function toggleBrowser() {
  if (browserState === "opening" || browserState === "closing") return;

  if (browserState === "open" && browserWebview) {
    const closing = browserWebview;
    browserState = "closing";
    browserButton.disabled = true;
    try {
      await closing.close();
      browserWebview = null;
      browserLabel = null;
      browserState = "closed";
      browserButton.textContent = "브라우저 PoC";
      terminal.focus();
      setStatus("브라우저 child WebView 닫힘 · Rust ConPTY 유지 중");
    } catch (error) {
      browserState = "open";
      browserButton.textContent = "브라우저 닫기";
      throw error;
    } finally {
      browserButton.disabled = false;
    }
    return;
  }

  const bounds = terminalSurface.getBoundingClientRect();
  const label = `phase1-browser-${Date.now()}`;
  browserState = "opening";
  browserButton.disabled = true;
  browserLabel = label;
  const webview = new Webview(getCurrentWindow(), label, {
    url: "https://example.com",
    x: Math.round(bounds.left),
    y: Math.round(bounds.top),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
    focus: true,
  });
  browserWebview = webview;
  browserButton.textContent = "브라우저 닫기";
  setStatus("격리된 child WebView를 준비하는 중…");

  let markCreated: () => void = () => undefined;
  let markFailed: (error: Error) => void = () => undefined;
  const creation = new Promise<void>((resolve, reject) => {
    markCreated = resolve;
    markFailed = reject;
  });
  let removeCreatedListener: () => void = () => undefined;
  let removeErrorListener: () => void = () => undefined;

  try {
    [removeCreatedListener, removeErrorListener] = await Promise.all([
      webview.once("tauri://created", () => markCreated()),
      webview.once<string>("tauri://error", (event) =>
        markFailed(new Error(String(event.payload))),
      ),
    ]);
    await creation;
    if (browserLabel !== label) return;
    browserState = "open";
    await syncBrowserBounds();
    setStatus("child WebView 열림 · 원격 페이지에는 Rust IPC 권한 없음");
  } catch (error) {
    if (browserLabel === label) {
      browserWebview = null;
      browserLabel = null;
      browserState = "closed";
      browserButton.textContent = "브라우저 PoC";
    }
    await webview.close().catch(() => undefined);
    throw new Error(`브라우저 생성 실패: ${String(error)}`);
  } finally {
    removeCreatedListener();
    removeErrorListener();
    browserButton.disabled = false;
  }
}

async function copySelection() {
  const text = terminal.getSelection();
  if (!text) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

async function pasteClipboard() {
  const text = await navigator.clipboard.readText();
  if (text) terminal.paste(text);
}

terminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== "keydown") return true;
  if (event.isComposing || event.keyCode === 229) return true;
  const key = event.key.toLowerCase();

  if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) {
    void copySelection();
    event.preventDefault();
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "v") {
    void pasteClipboard();
    event.preventDefault();
    return false;
  }
  return true;
});

terminal.onData((data) => {
  resumeAutoFollowForInput();
  queueInput(data);
});
terminal.onScroll(() => {
  const browsing = !isAtBottom();
  if (browsing !== userBrowsingScrollback) {
    userBrowsingScrollback = browsing;
    interactionEpoch += 1;
  }
});
terminal.onSelectionChange(() => {
  if (terminal.hasSelection()) pauseAutoFollow();
});
terminal.element?.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) pauseAutoFollow();
}, { passive: true });
terminal.element?.addEventListener("mousedown", (event) => {
  if (event.button === 0) {
    selectionGestureActive = true;
    interactionEpoch += 1;
  }
  terminal.focus();
});
terminal.element?.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (terminal.hasSelection()) void copySelection();
  else void pasteClipboard();
});
window.addEventListener("mouseup", (event) => {
  if (event.button !== 0 || !selectionGestureActive) return;
  selectionGestureActive = false;
  interactionEpoch += 1;
  if (!terminal.hasSelection() && isAtBottom()) userBrowsingScrollback = false;
}, true);

startButton.addEventListener("click", () => void startTerminal());
stopButton.addEventListener("click", () => void stopTerminal());
browserButton.addEventListener("click", () => {
  void toggleBrowser().catch((error) => setStatus(String(error), "error"));
});
new ResizeObserver(scheduleFit).observe(terminalSurface);
window.addEventListener("resize", scheduleFit);

requestAnimationFrame(() => {
  fitAddon.fit();
  void startTerminal();
});

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function requireButton(id: string): HTMLButtonElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button`);
  }
  return element;
}
