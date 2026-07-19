(() => {
  "use strict";

  if (window.top !== window || !window.chrome?.webview) return;
  const installedKey = Symbol.for("ihatecoding.browser-ui-pick.v1");
  if (window[installedKey]) return;
  Object.defineProperty(window, installedKey, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  // This script is registered before the first remote navigation. Keep the
  // native bridge and event primitives captured before page code can replace
  // them, and never expose the per-webview nonce on window or the DOM.
  const bridge = window.chrome.webview;
  const postMessage = bridge.postMessage.bind(bridge);
  const safeCall = Function.prototype.call.bind(Function.prototype.call);
  const ElementType = window.Element;
  const preventDefault = Event.prototype.preventDefault;
  const stopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const composedPath = Event.prototype.composedPath;
  const elementMatches = Element.prototype.matches;
  const elementClosest = Element.prototype.closest;
  const elementQuerySelector = Element.prototype.querySelector;
  const elementGetAttribute = Element.prototype.getAttribute;
  const elementGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const documentQuerySelectorAll = Document.prototype.querySelectorAll;
  const nodeContains = Node.prototype.contains;
  const isConnectedGetter = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected")?.get;
  const computedStyleFor = window.getComputedStyle.bind(window);
  const escapeCss = CSS.escape.bind(CSS);
  const nextFrame = window.requestAnimationFrame.bind(window);
  const nonce = __IHC_UI_PICK_NONCE_JSON__;
  // Wry installs a string-only WebMessageReceived IPC handler on every child
  // WebView before this picker handler. Sending a JS object makes that handler
  // fail with E_INVALIDARG before the picker can reliably receive the event.
  // Keep this bridge string-only and use a private prefix so native code can
  // distinguish picker traffic from Tauri IPC traffic.
  const messagePrefix = "__IHC_UI_PICK_V1__:";
  let captureGeneration = 0;
  let outlineTimer = 0;

  const outline = document.createElement("div");
  outline.setAttribute("data-ihc-ui-pick", "outline");
  Object.assign(outline.style, {
    all: "initial",
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    zIndex: "2147483647",
    boxSizing: "border-box",
    border: "1px solid rgba(255, 255, 255, .92)",
    borderRadius: "3px",
    background: "rgba(255, 255, 255, .07)",
    boxShadow: "0 0 0 1px rgba(0, 0, 0, .55)",
  });

  const anchor = document.createElement("div");
  anchor.setAttribute("data-ihc-ui-pick", "anchor");
  Object.assign(anchor.style, {
    all: "initial",
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    zIndex: "2147483647",
    width: "10px",
    height: "10px",
    boxSizing: "border-box",
    border: "1px solid rgba(255, 255, 255, .96)",
    borderRadius: "50%",
    background: "transparent",
    boxShadow: "0 0 0 1px rgba(0, 0, 0, .72)",
    transform: "translate(-50%, -50%)",
  });

  const ensureMounted = () => {
    const root = document.documentElement;
    if (!root) return false;
    if (!outline.isConnected) root.append(outline);
    if (!anchor.isConnected) root.append(anchor);
    return true;
  };

  const hideOutline = () => {
    window.clearTimeout(outlineTimer);
    outline.style.display = "none";
    anchor.style.display = "none";
  };

  const isConnected = (node) => isConnectedGetter
    ? safeCall(isConnectedGetter, node)
    : safeCall(nodeContains, document, node);

  const getAttribute = (element, name) => safeCall(elementGetAttribute, element, name);
  const matches = (element, selector) => safeCall(elementMatches, element, selector);

  const safeText = (value, limit) => {
    if (typeof value !== "string") return "";
    return value
      .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  };

  const selectorPart = (element) => {
    const tag = element.localName || "element";
    if (element.id) return `${tag}#${escapeCss(element.id).slice(0, 120)}`;
    for (const attribute of ["data-testid", "data-test", "data-cy"]) {
      const testId = getAttribute(element, attribute);
      if (testId) return `${tag}[${attribute}="${escapeCss(testId).slice(0, 100)}"]`;
    }
    const classes = [...element.classList]
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))
      .slice(0, 2);
    let part = tag + classes.map((name) => `.${escapeCss(name)}`).join("");
    const parent = element.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((child) => child.localName === tag);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
    }
    return part;
  };

  const buildSelector = (element) => {
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 6; depth += 1) {
      parts.unshift(selectorPart(current));
      const candidate = parts.join(" > ");
      try {
        if (safeCall(documentQuerySelectorAll, document, candidate).length === 1) {
          return candidate.slice(0, 512);
        }
      } catch {
        // Keep the bounded structural fallback.
      }
      current = current.parentElement;
    }
    return parts.join(" > ").slice(0, 512);
  };

  const collectProperties = (pairs, limit) => pairs
    .map(([name, value]) => ({ name, value: safeText(value, 240) }))
    .filter((entry) => entry.value)
    .slice(0, limit);

  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

  const captureElement = (element, anchorX, anchorY) => {
    const rect = safeCall(elementGetBoundingClientRect, element);
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(window.innerWidth, rect.right);
    const visibleBottom = Math.min(window.innerHeight, rect.bottom);
    const visibleWidth = visibleRight - visibleLeft;
    const visibleHeight = visibleBottom - visibleTop;
    if (visibleWidth < 1 || visibleHeight < 1) return null;

    const captureWidth = Math.min(window.innerWidth, 1600, Math.max(96, visibleWidth + 48));
    const captureHeight = Math.min(window.innerHeight, 1200, Math.max(72, visibleHeight + 48));
    const centerX = clamp(anchorX, visibleLeft, visibleRight);
    const centerY = clamp(anchorY, visibleTop, visibleBottom);
    const captureLeft = clamp(centerX - captureWidth / 2, 0, window.innerWidth - captureWidth);
    const captureTop = clamp(centerY - captureHeight / 2, 0, window.innerHeight - captureHeight);
    const computed = computedStyleFor(element);
    const text = matches(element, "input, textarea, select")
      ? ""
      : safeText(element.innerText ?? element.textContent ?? "", 260);
    const accessibleName = safeText(
      getAttribute(element, "aria-label")
        ?? getAttribute(element, "alt")
        ?? getAttribute(element, "title")
        ?? "",
      180,
    );

    return {
      type: "ihc-ui-pick",
      version: 1,
      nonce,
      requestId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      pageTitle: safeText(document.title, 180),
      tag: safeText(element.localName, 32),
      role: safeText(getAttribute(element, "role") ?? "", 80),
      accessibleName,
      text,
      selector: buildSelector(element),
      attributes: collectProperties([
        ["id", element.id],
        ["class", [...element.classList].slice(0, 8).join(" ")],
        ["type", getAttribute(element, "type") ?? ""],
        ["name", getAttribute(element, "name") ?? ""],
        ["role", getAttribute(element, "role") ?? ""],
        ["aria-label", getAttribute(element, "aria-label") ?? ""],
        ["data-testid", getAttribute(element, "data-testid") ?? ""],
        ["data-test", getAttribute(element, "data-test") ?? ""],
        ["data-cy", getAttribute(element, "data-cy") ?? ""],
      ], 10),
      styles: collectProperties([
        ["display", computed.display],
        ["position", computed.position],
        ["color", computed.color],
        ["background-color", computed.backgroundColor],
        ["font-family", computed.fontFamily],
        ["font-size", computed.fontSize],
        ["font-weight", computed.fontWeight],
        ["line-height", computed.lineHeight],
        ["border", computed.border],
        ["border-radius", computed.borderRadius],
        ["padding", computed.padding],
        ["margin", computed.margin],
        ["width", computed.width],
        ["height", computed.height],
      ], 14),
      rect: {
        x: Math.round(rect.left * 10) / 10,
        y: Math.round(rect.top * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
      capture: {
        x: Math.round((captureLeft + window.scrollX) * 10) / 10,
        y: Math.round((captureTop + window.scrollY) * 10) / 10,
        width: Math.round(captureWidth * 10) / 10,
        height: Math.round(captureHeight * 10) / 10,
      },
    };
  };

  const positionOutline = (element, anchorX, anchorY) => {
    if (!ensureMounted()) return false;
    const rect = safeCall(elementGetBoundingClientRect, element);
    Object.assign(outline.style, {
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(1, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left))}px`,
      height: `${Math.max(1, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top))}px`,
      display: "block",
    });
    Object.assign(anchor.style, {
      left: `${clamp(anchorX, 0, window.innerWidth)}px`,
      top: `${clamp(anchorY, 0, window.innerHeight)}px`,
      display: "block",
    });
    return true;
  };

  const captureAfterPaint = async (element, anchorX, anchorY, generation) => {
    await new Promise((resolve) => nextFrame(() => resolve()));
    await new Promise((resolve) => nextFrame(() => resolve()));
    if (generation !== captureGeneration || !isConnected(element)) return;
    const message = captureElement(element, anchorX, anchorY);
    if (!message) {
      hideOutline();
      return;
    }
    try {
      postMessage(messagePrefix + JSON.stringify(message));
    } finally {
      outlineTimer = window.setTimeout(() => {
        if (generation === captureGeneration) hideOutline();
      }, 900);
    }
  };

  window.addEventListener("contextmenu", (event) => {
    if (event.shiftKey || !event.isTrusted) return;
    const target = safeCall(composedPath, event).find((node) => node instanceof ElementType);
    if (
      !(target instanceof ElementType)
      || safeCall(elementClosest, target, "[data-ihc-ui-pick]")
    ) return;
    if (
      matches(target, 'input[type="password"]')
      || safeCall(elementClosest, target, 'input[type="password"]')
      || safeCall(elementQuerySelector, target, 'input[type="password"]')
    ) {
      return;
    }
    safeCall(preventDefault, event);
    safeCall(stopImmediatePropagation, event);
    const generation = ++captureGeneration;
    window.clearTimeout(outlineTimer);
    if (!positionOutline(target, event.clientX, event.clientY)) return;
    void captureAfterPaint(target, event.clientX, event.clientY, generation);
  }, true);

  const cancelPendingVisual = () => {
    captureGeneration += 1;
    hideOutline();
  };
  window.addEventListener("blur", cancelPendingVisual);
  window.addEventListener("resize", cancelPendingVisual);
  window.addEventListener("pagehide", cancelPendingVisual);
})();
