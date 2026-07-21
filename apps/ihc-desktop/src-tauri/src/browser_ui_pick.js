(() => {
  "use strict";

  if (window.top !== window || !window.chrome?.webview) return;
  const installedKey = Symbol.for("ihatecoding.browser-ui-pick.v2");
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
  const elementQuerySelectorAll = Element.prototype.querySelectorAll;
  const elementGetAttribute = Element.prototype.getAttribute;
  const elementGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const elementSetPointerCapture = Element.prototype.setPointerCapture;
  const elementReleasePointerCapture = Element.prototype.releasePointerCapture;
  const documentQuerySelectorAll = Document.prototype.querySelectorAll;
  const nodeContains = Node.prototype.contains;
  const nodeAppendChild = Node.prototype.appendChild;
  const nodeCloneNode = Node.prototype.cloneNode;
  const nodeRemoveChild = Node.prototype.removeChild;
  const isConnectedGetter = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected")?.get;
  const computedStyleFor = window.getComputedStyle.bind(window);
  const escapeCss = CSS.escape.bind(CSS);
  const jsonStringify = JSON.stringify.bind(JSON);
  const nextFrame = window.requestAnimationFrame.bind(window);
  const cancelFrame = window.cancelAnimationFrame.bind(window);
  const TextEncoderType = window.TextEncoder;
  const textEncoder = typeof TextEncoderType === "function" ? new TextEncoderType() : null;
  const textEncoderEncode = TextEncoderType?.prototype?.encode;
  const nonce = __IHC_UI_PICK_NONCE_JSON__;
  // Wry installs a string-only WebMessageReceived IPC handler on every child
  // WebView before this picker handler. Sending a JS object makes that handler
  // fail with E_INVALIDARG before the picker can reliably receive the event.
  // Keep this bridge string-only and use a private prefix so native code can
  // distinguish picker traffic from Tauri IPC traffic.
  const messagePrefix = "__IHC_UI_PICK_V2__:";
  const maxSelectedElements = 32;
  const maxDescendantsPerTarget = 64;
  const maxDescendantsPerRequest = 256;
  const maxDescendantScanElements = 5000;
  const maxDescendantDepth = 24;
  const maxSerializedPayloadBytes = 240 * 1024;
  const maxRegionScanElements = 20000;
  const regionDragThreshold = 6;
  const scheduleTimeout = window.setTimeout.bind(window);
  let captureGeneration = 0;
  let selectedEntries = [];
  let selectionSource = "";
  let visualNodes = [];
  let rightDrag = null;
  let regionVisual = null;
  let regionFrame = 0;
  let suppressionToken = 0;
  let suppressNextContextMenu = 0;
  let suppressNextAuxClick = 0;

  const outlineTemplate = document.createElement("div");
  outlineTemplate.setAttribute("data-ihc-ui-pick", "outline");
  Object.assign(outlineTemplate.style, {
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

  const anchorTemplate = document.createElement("div");
  anchorTemplate.setAttribute("data-ihc-ui-pick", "anchor");
  Object.assign(anchorTemplate.style, {
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

  const regionTemplate = document.createElement("div");
  regionTemplate.setAttribute("data-ihc-ui-pick", "region");
  Object.assign(regionTemplate.style, {
    all: "initial",
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    zIndex: "2147483646",
    boxSizing: "border-box",
    border: "1px solid rgba(255, 255, 255, .72)",
    background: "rgba(255, 255, 255, .05)",
    boxShadow: "0 0 0 1px rgba(0, 0, 0, .5)",
  });

  const removeVisualNode = (node) => {
    const parent = node?.parentNode;
    if (parent) {
      try {
        safeCall(nodeRemoveChild, parent, node);
      } catch {
        // A page can detach the visual before cleanup.
      }
    }
  };

  const hideOutlines = () => {
    for (const node of visualNodes) removeVisualNode(node);
    visualNodes = [];
  };

  const hideRegionVisual = () => {
    if (regionFrame) cancelFrame(regionFrame);
    regionFrame = 0;
    removeVisualNode(regionVisual);
    regionVisual = null;
  };

  const clearSelection = () => {
    selectedEntries = [];
    selectionSource = "";
    hideOutlines();
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

  const containsPasswordInput = (element) =>
    matches(element, 'input[type="password"]')
    || Boolean(safeCall(elementClosest, element, 'input[type="password"]'))
    || Boolean(safeCall(elementQuerySelector, element, 'input[type="password"]'));

  const regionAtomicSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role]",
    "[data-testid]",
    "[data-test]",
    "[data-cy]",
    "img",
    "svg",
    "video",
    "canvas",
  ].join(",");
  const regionSemanticSelector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "label",
    "li",
    "td",
    "th",
  ].join(",");
  const regionIgnoredSelector = [
    "html",
    "body",
    "head",
    "script",
    "style",
    "link",
    "meta",
    "noscript",
    "template",
    "defs",
    "path",
  ].join(",");
  const regionTextOnlySelector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "label",
    "td",
    "th",
  ].join(",");
  const regionGroupContentSelector = [
    regionAtomicSelector,
    regionSemanticSelector,
  ].join(",");
  const descendantAtomicSelector = [
    regionAtomicSelector,
    "summary",
    "details",
    "[contenteditable]",
    "picture",
    "audio",
    "i",
  ].join(",");
  const descendantTextSelector = [
    regionSemanticSelector,
    "legend",
    "figcaption",
    "blockquote",
    "pre",
    "code",
    "span",
    "strong",
    "em",
    "small",
    "time",
    "dt",
    "dd",
  ].join(",");

  const normalizeRegion = (startX, startY, endX, endY) => ({
    left: clamp(Math.min(startX, endX), 0, window.innerWidth),
    top: clamp(Math.min(startY, endY), 0, window.innerHeight),
    right: clamp(Math.max(startX, endX), 0, window.innerWidth),
    bottom: clamp(Math.max(startY, endY), 0, window.innerHeight),
  });

  const rectIsFullyInside = (region, rect) =>
    rect.width >= 1
    && rect.height >= 1
    && rect.left >= region.left
    && rect.top >= region.top
    && rect.right <= region.right
    && rect.bottom <= region.bottom;

  const colorIsVisible = (value) => {
    const color = String(value ?? "").trim().toLowerCase();
    if (!color || color === "transparent") return false;
    const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
    return !rgba || Number.parseFloat(rgba[1]) > 0.01;
  };

  const borderIsVisible = (value) => {
    const border = String(value ?? "").trim().toLowerCase();
    return Boolean(border)
      && border !== "none"
      && !border.includes(" none ")
      && !border.startsWith("0px ")
      && !border.startsWith("0 ");
  };

  const regionVisualGroupScore = (element, computed, rect) => {
    if (
      matches(element, regionTextOnlySelector)
      || matches(element, "input, select, textarea, img, svg, video, canvas")
      || rect.width < 96
      || rect.height < 64
      || rect.width * rect.height < 8000
      || !safeText(element.innerText ?? element.textContent ?? "", 32)
      || !elementQuerySelectorAll
    ) return 0;
    const role = String(getAttribute(element, "role") ?? "").toLowerCase();
    const explicitGroup = matches(element, "article")
      || role === "article"
      || role === "listitem";
    const radius = Number.parseFloat(computed.borderRadius || "0");
    const visibleBorder = borderIsVisible(computed.border);
    const visibleShadow = String(computed.boxShadow ?? "").trim().toLowerCase() !== ""
      && String(computed.boxShadow).trim().toLowerCase() !== "none";
    let distinctBackground = colorIsVisible(computed.backgroundColor);
    if (distinctBackground && element.parentElement) {
      try {
        const parentBackground = computedStyleFor(element.parentElement).backgroundColor;
        distinctBackground = String(parentBackground).trim().toLowerCase()
          !== String(computed.backgroundColor).trim().toLowerCase();
      } catch {
        distinctBackground = false;
      }
    }
    if (
      !explicitGroup
      && !visibleBorder
      && !visibleShadow
      && !distinctBackground
      && !(Number.isFinite(radius) && radius >= 4)
    ) return 0;
    let descendants;
    try {
      descendants = safeCall(elementQuerySelectorAll, element, regionGroupContentSelector);
    } catch {
      return 0;
    }
    if (descendants.length < 2) return 0;
    return explicitGroup ? 6 : 5;
  };

  const regionCandidateScore = (element, computed, rect) => {
    const groupScore = regionVisualGroupScore(element, computed, rect);
    if (groupScore) return groupScore;
    if (matches(element, regionAtomicSelector)) return 4;
    if (matches(element, regionSemanticSelector)) return 3;
    if (
      element.id
      || element.classList.length > 0
      || getAttribute(element, "aria-label")
      || getAttribute(element, "title")
    ) return 2;
    return 1;
  };

  const collectRegionEntries = (region, baseEntries) => {
    const candidates = [];
    const elements = safeCall(documentQuerySelectorAll, document, "*");
    const scanCount = Math.min(elements.length, maxRegionScanElements);
    for (let index = 0; index < scanCount; index += 1) {
      const element = elements[index];
      if (
        !(element instanceof ElementType)
        || matches(element, regionIgnoredSelector)
        || safeCall(elementClosest, element, "[data-ihc-ui-pick]")
        || containsPasswordInput(element)
      ) continue;
      const rect = safeCall(elementGetBoundingClientRect, element);
      if (!rectIsFullyInside(region, rect)) continue;
      let computed;
      try {
        computed = computedStyleFor(element);
      } catch {
        continue;
      }
      if (
        computed.display === "none"
        || computed.visibility === "hidden"
        || computed.visibility === "collapse"
        || Number.parseFloat(computed.opacity || "1") <= 0.01
      ) continue;
      candidates.push({
        element,
        rect,
        score: regionCandidateScore(element, computed, rect),
        order: index,
        area: rect.width * rect.height,
      });
    }
    candidates.sort((left, right) =>
      right.score - left.score || left.area - right.area || left.order - right.order);

    const entries = baseEntries
      .filter(({ element }) => isConnected(element) && !containsPasswordInput(element))
      .slice(0, maxSelectedElements);
    const regionElements = [];
    for (const candidate of candidates) {
      if (entries.length >= maxSelectedElements) break;
      const redundant = entries.some(({ element }) => element === candidate.element)
        || regionElements.some((element) =>
          safeCall(nodeContains, candidate.element, element)
          || safeCall(nodeContains, element, candidate.element));
      if (redundant) continue;
      entries.push({
        element: candidate.element,
        anchorX: (candidate.rect.left + candidate.rect.right) / 2,
        anchorY: (candidate.rect.top + candidate.rect.bottom) / 2,
      });
      regionElements.push(candidate.element);
    }
    return entries;
  };

  const captureTarget = (element) => {
    const rect = safeCall(elementGetBoundingClientRect, element);
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(window.innerWidth, rect.right);
    const visibleBottom = Math.min(window.innerHeight, rect.bottom);
    if (visibleRight - visibleLeft < 1 || visibleBottom - visibleTop < 1) return null;
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
    };
  };

  const descendantDepthFrom = (element, root) => {
    let current = element;
    let depth = 0;
    while (current && current !== root && depth <= maxDescendantDepth) {
      current = current.parentElement;
      depth += 1;
    }
    return current === root && depth <= maxDescendantDepth ? depth : 0;
  };

  const meaningfulDescendant = (element) => {
    const accessibleName = getAttribute(element, "aria-label")
      ?? getAttribute(element, "alt")
      ?? getAttribute(element, "title")
      ?? "";
    if (matches(element, descendantAtomicSelector)) return true;
    if (
      getAttribute(element, "data-testid")
      || getAttribute(element, "data-test")
      || getAttribute(element, "data-cy")
    ) return true;
    if ([...element.classList].some((name) =>
      /(^|[-_])(icon|glyph|logo|avatar|badge)([-_]|$)/i.test(name))) return true;
    const text = safeText(accessibleName || element.innerText || element.textContent || "", 8);
    return Boolean(text)
      && (matches(element, descendantTextSelector) || element.children.length === 0);
  };

  const nearestCapturedAncestorIndex = (element, root, capturedElements) => {
    for (let current = element.parentElement; current && current !== root; current = current.parentElement) {
      for (let index = capturedElements.length - 1; index >= 0; index -= 1) {
        if (capturedElements[index] === current) return index;
      }
    }
    return null;
  };

  const collectMeaningfulDescendants = (root, maximum) => {
    let elements;
    try {
      elements = safeCall(elementQuerySelectorAll, root, "*");
    } catch {
      return { descendants: [], truncated: false };
    }
    const descendants = [];
    const capturedElements = [];
    const scanCount = Math.min(elements.length, maxDescendantScanElements);
    let truncated = elements.length > scanCount;
    for (let index = 0; index < scanCount; index += 1) {
      const element = elements[index];
      if (
        !(element instanceof ElementType)
        || matches(element, regionIgnoredSelector)
        || safeCall(elementClosest, element, "[data-ihc-ui-pick]")
        || containsPasswordInput(element)
        || !meaningfulDescendant(element)
      ) continue;
      const depth = descendantDepthFrom(element, root);
      if (depth === 0) {
        truncated = true;
        continue;
      }
      let computed;
      try {
        computed = computedStyleFor(element);
      } catch {
        continue;
      }
      if (
        computed.display === "none"
        || computed.visibility === "hidden"
        || computed.visibility === "collapse"
        || Number.parseFloat(computed.opacity || "1") <= 0.01
      ) continue;
      if (descendants.length >= maximum) {
        truncated = true;
        break;
      }
      let captured;
      try {
        captured = captureTarget(element);
      } catch {
        continue;
      }
      if (!captured) continue;
      descendants.push({
        depth,
        parentIndex: nearestCapturedAncestorIndex(element, root, capturedElements),
        element: captured,
      });
      capturedElements.push(element);
    }
    return { descendants, truncated };
  };

  const serializedPayloadBytes = (message) => {
    const serialized = messagePrefix + jsonStringify(message);
    if (textEncoder && textEncoderEncode) {
      try {
        return safeCall(textEncoderEncode, textEncoder, serialized).byteLength;
      } catch {
        // A conservative UTF-8 upper bound is enough for the fallback.
      }
    }
    return serialized.length * 3;
  };

  const markMetadataTruncated = (target) => {
    target.metadataTruncated = true;
  };

  const trimPropertyRound = (targets, field) => {
    let trimmed = false;
    for (const target of targets) {
      const properties = target[field];
      if (!Array.isArray(properties) || properties.length === 0) continue;
      properties.pop();
      markMetadataTruncated(target);
      trimmed = true;
    }
    return trimmed;
  };

  const trimStringRound = (targets, field, amount) => {
    let trimmed = false;
    for (const target of targets) {
      const value = target[field];
      if (typeof value !== "string" || value.length === 0) continue;
      const characters = [...value];
      target[field] = characters.slice(0, Math.max(0, characters.length - amount)).join("");
      markMetadataTruncated(target);
      trimmed = true;
    }
    return trimmed;
  };

  const fitCapturePayload = (message) => {
    let trimCursor = 0;
    while (serializedPayloadBytes(message) > maxSerializedPayloadBytes) {
      const maximum = Math.max(...message.targets.map((target) => target.descendants.length));
      if (maximum === 0) break;
      const batchSize = Math.max(1, Math.ceil(maximum / 16));
      const nextMaximum = Math.max(0, maximum - batchSize);
      let trimmed = false;
      for (let offset = 0; offset < message.targets.length; offset += 1) {
        const index = (trimCursor + offset) % message.targets.length;
        const target = message.targets[index];
        if (target.descendants.length !== maximum) continue;
        while (target.descendants.length > nextMaximum) target.descendants.pop();
        target.descendantsTruncated = true;
        trimmed = true;
      }
      if (!trimmed) break;
      trimCursor = (trimCursor + 1) % message.targets.length;
    }
    for (const field of ["styles", "attributes"]) {
      while (
        serializedPayloadBytes(message) > maxSerializedPayloadBytes
        && trimPropertyRound(message.targets, field)
      ) {
        // Compact one property from every root per pass to stay fair.
      }
    }
    for (const [field, amount] of [
      ["text", 64],
      ["accessibleName", 48],
      ["role", 32],
    ]) {
      while (
        serializedPayloadBytes(message) > maxSerializedPayloadBytes
        && trimStringRound(message.targets, field, amount)
      ) {
        // Preserve every root and reduce the same field evenly across roots.
      }
    }
    if (serializedPayloadBytes(message) > maxSerializedPayloadBytes && message.pageTitle) {
      message.pageTitle = "";
      for (const target of message.targets) markMetadataTruncated(target);
    }
    while (
      serializedPayloadBytes(message) > maxSerializedPayloadBytes
      && trimStringRound(message.targets, "selector", 96)
    ) {
      // Selectors are the final optional root metadata to be compacted.
    }
    return serializedPayloadBytes(message) <= maxSerializedPayloadBytes ? message : null;
  };

  const buildCaptureRect = (targets) => {
    const visibleRects = targets
      .map(({ rect }) => ({
        left: Math.max(0, rect.x),
        top: Math.max(0, rect.y),
        right: Math.min(window.innerWidth, rect.x + rect.width),
        bottom: Math.min(window.innerHeight, rect.y + rect.height),
      }))
      .filter((rect) => rect.right - rect.left >= 1 && rect.bottom - rect.top >= 1);
    if (visibleRects.length === 0) return null;
    const visibleLeft = Math.min(...visibleRects.map((rect) => rect.left));
    const visibleTop = Math.min(...visibleRects.map((rect) => rect.top));
    const visibleRight = Math.max(...visibleRects.map((rect) => rect.right));
    const visibleBottom = Math.max(...visibleRects.map((rect) => rect.bottom));
    const captureWidth = Math.min(
      window.innerWidth,
      1600,
      Math.max(96, visibleRight - visibleLeft + 48),
    );
    const captureHeight = Math.min(
      window.innerHeight,
      1200,
      Math.max(72, visibleBottom - visibleTop + 48),
    );
    const centerX = (visibleLeft + visibleRight) / 2;
    const centerY = (visibleTop + visibleBottom) / 2;
    const focus = visibleRects[visibleRects.length - 1];
    const fitFocusedStart = (desired, size, viewportSize, focusStart, focusEnd) => {
      const viewportMaximum = Math.max(0, viewportSize - size);
      if (focusEnd - focusStart <= size) {
        const minimum = Math.max(0, focusEnd - size);
        const maximum = Math.min(viewportMaximum, focusStart);
        if (minimum <= maximum) return clamp(desired, minimum, maximum);
      }
      return clamp((focusStart + focusEnd - size) / 2, 0, viewportMaximum);
    };
    const captureLeft = fitFocusedStart(
      centerX - captureWidth / 2,
      captureWidth,
      window.innerWidth,
      focus.left,
      focus.right,
    );
    const captureTop = fitFocusedStart(
      centerY - captureHeight / 2,
      captureHeight,
      window.innerHeight,
      focus.top,
      focus.bottom,
    );
    return {
      x: Math.round((captureLeft + window.scrollX) * 10) / 10,
      y: Math.round((captureTop + window.scrollY) * 10) / 10,
      width: Math.round(captureWidth * 10) / 10,
      height: Math.round(captureHeight * 10) / 10,
    };
  };

  const captureSelection = (entries) => {
    if (entries.some(({ element }) => containsPasswordInput(element))) return null;
    let remainingDescendants = maxDescendantsPerRequest;
    const targets = [];
    for (const [index, { element }] of entries.entries()) {
      const target = captureTarget(element);
      if (!target) return null;
      const remainingTargets = entries.length - index;
      const fairDescendantLimit = Math.min(
        maxDescendantsPerTarget,
        Math.floor(remainingDescendants / remainingTargets),
      );
      const hierarchy = collectMeaningfulDescendants(
        element,
        fairDescendantLimit,
      );
      remainingDescendants -= hierarchy.descendants.length;
      targets.push({
        ...target,
        metadataTruncated: false,
        descendants: hierarchy.descendants,
        descendantsTruncated: hierarchy.truncated,
      });
    }
    const capture = buildCaptureRect(targets);
    if (targets.length !== entries.length || targets.length === 0 || !capture) return null;
    return fitCapturePayload({
      type: "ihc-ui-pick",
      version: 2,
      nonce,
      requestId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      pageTitle: safeText(document.title, 180),
      targets,
      capture,
    });
  };

  const positionOutlines = (entries) => {
    const root = document.documentElement;
    if (!root) return false;
    hideOutlines();
    for (const [index, entry] of entries.entries()) {
      const rect = safeCall(elementGetBoundingClientRect, entry.element);
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const width = Math.min(window.innerWidth, rect.right) - left;
      const height = Math.min(window.innerHeight, rect.bottom) - top;
      if (width < 1 || height < 1) continue;
      const outline = safeCall(nodeCloneNode, outlineTemplate, false);
      const anchor = safeCall(nodeCloneNode, anchorTemplate, false);
      Object.assign(outline.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        display: "block",
      });
      Object.assign(anchor.style, {
        left: `${clamp(entry.anchorX, 0, window.innerWidth)}px`,
        top: `${clamp(entry.anchorY, 0, window.innerHeight)}px`,
        display: "block",
      });
      if (entries.length > 1) {
        anchor.textContent = String(index + 1);
        Object.assign(anchor.style, {
          width: "16px",
          height: "16px",
          color: "white",
          background: "rgba(0, 0, 0, .82)",
          font: "10px/14px system-ui, sans-serif",
          textAlign: "center",
        });
      }
      safeCall(nodeAppendChild, root, outline);
      safeCall(nodeAppendChild, root, anchor);
      visualNodes.push(outline, anchor);
    }
    return visualNodes.length > 0;
  };

  const positionRegionVisual = (region) => {
    const root = document.documentElement;
    if (!root) return false;
    if (!regionVisual) {
      regionVisual = safeCall(nodeCloneNode, regionTemplate, false);
      safeCall(nodeAppendChild, root, regionVisual);
    }
    Object.assign(regionVisual.style, {
      left: `${region.left}px`,
      top: `${region.top}px`,
      width: `${Math.max(1, region.right - region.left)}px`,
      height: `${Math.max(1, region.bottom - region.top)}px`,
      display: "block",
    });
    return true;
  };

  const scheduleRegionVisual = (drag) => {
    if (regionFrame) return;
    regionFrame = nextFrame(() => {
      regionFrame = 0;
      if (rightDrag !== drag || !drag.dragging) return;
      positionRegionVisual(normalizeRegion(drag.startX, drag.startY, drag.endX, drag.endY));
    });
  };

  const cancelRightDrag = () => {
    const drag = rightDrag;
    rightDrag = null;
    if (drag?.captureElement && elementReleasePointerCapture) {
      try {
        safeCall(elementReleasePointerCapture, drag.captureElement, drag.pointerId);
      } catch {
        // The browser may have released capture as part of pointerup/cancel.
      }
    }
    hideRegionVisual();
  };

  const clearGestureSuppression = () => {
    suppressionToken += 1;
    suppressNextContextMenu = 0;
    suppressNextAuxClick = 0;
  };

  const armGestureSuppression = ({ contextMenuSeen = false, auxClickSeen = false } = {}) => {
    const token = ++suppressionToken;
    suppressNextContextMenu = contextMenuSeen ? 0 : token;
    suppressNextAuxClick = auxClickSeen ? 0 : token;
    scheduleTimeout(() => {
      if (suppressNextContextMenu === token) suppressNextContextMenu = 0;
      if (suppressNextAuxClick === token) suppressNextAuxClick = 0;
    }, 750);
  };

  const captureAfterPaint = async (entries, generation) => {
    await new Promise((resolve) => nextFrame(() => resolve()));
    await new Promise((resolve) => nextFrame(() => resolve()));
    if (generation !== captureGeneration) return;
    const liveEntries = entries.filter(({ element }) => isConnected(element));
    const message = captureSelection(liveEntries);
    if (!message) {
      clearSelection();
      return;
    }
    try {
      postMessage(messagePrefix + jsonStringify(message));
    } catch {
      clearSelection();
    }
  };

  const submitSelection = () => {
    if (selectedEntries.length === 0) return;
    const generation = ++captureGeneration;
    const snapshot = selectedEntries.slice();
    if (!positionOutlines(snapshot)) return;
    void captureAfterPaint(snapshot, generation);
  };

  const prepareSelectionSource = (source) => {
    const currentSource = String(window.location.href);
    if (source !== currentSource) {
      clearSelection();
      return null;
    }
    if (selectionSource && selectionSource !== currentSource) clearSelection();
    selectedEntries = selectedEntries.filter(({ element }) => isConnected(element));
    if (selectedEntries.length === 0) selectionSource = "";
    return currentSource;
  };

  const applySingleSelection = (element, anchorX, anchorY, additive, source) => {
    if (!(element instanceof ElementType) || containsPasswordInput(element)) return;
    const currentSource = prepareSelectionSource(source);
    if (!currentSource) return;
    const existingIndex = selectedEntries.findIndex((entry) => entry.element === element);
    if (!additive) {
      selectedEntries = [{ element, anchorX, anchorY }];
    } else if (existingIndex < 0) {
      if (selectedEntries.length >= maxSelectedElements) {
        positionOutlines(selectedEntries);
        return;
      }
      selectedEntries.push({ element, anchorX, anchorY });
    } else {
      selectedEntries.splice(existingIndex, 1);
      if (selectedEntries.length === 0) {
        captureGeneration += 1;
        clearSelection();
        return;
      }
    }
    selectionSource = currentSource;
    submitSelection();
  };

  const applyRegionSelection = (drag) => {
    const currentSource = prepareSelectionSource(drag.source);
    if (!currentSource) return;
    const previous = selectedEntries.slice();
    const baseEntries = drag.additive ? previous : [];
    const region = normalizeRegion(drag.startX, drag.startY, drag.endX, drag.endY);
    const nextEntries = collectRegionEntries(region, baseEntries);
    if (nextEntries.length === 0) {
      if (!drag.additive) {
        captureGeneration += 1;
        clearSelection();
      }
      else positionOutlines(previous);
      return;
    }
    const changed = nextEntries.length !== previous.length
      || nextEntries.some((entry, index) => entry.element !== previous[index]?.element);
    selectedEntries = nextEntries;
    selectionSource = currentSource;
    if (changed || !drag.additive) submitSelection();
    else positionOutlines(selectedEntries);
  };

  const eventElement = (event) =>
    safeCall(composedPath, event).find((node) => node instanceof ElementType);

  const suppressEvent = (event) => {
    safeCall(preventDefault, event);
    safeCall(stopImmediatePropagation, event);
  };

  window.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    if (event.button === 0) {
      cancelRightDrag();
      clearGestureSuppression();
      captureGeneration += 1;
      clearSelection();
      return;
    }
    if (event.button !== 2 || (event.pointerType && event.pointerType !== "mouse")) return;
    const target = eventElement(event);
    if (
      !(target instanceof ElementType)
      || safeCall(elementClosest, target, "[data-ihc-ui-pick]")
      || containsPasswordInput(target)
    ) return;
    cancelRightDrag();
    clearGestureSuppression();
    const captureElement = document.documentElement;
    rightDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      endX: event.clientX,
      endY: event.clientY,
      target,
      additive: Boolean(event.shiftKey),
      source: String(window.location.href),
      dragging: false,
      contextMenuSeen: false,
      auxClickSeen: false,
      captureElement,
    };
    suppressEvent(event);
    if (captureElement && elementSetPointerCapture) {
      try {
        safeCall(elementSetPointerCapture, captureElement, event.pointerId);
      } catch {
        // Window-level capture listeners still finish the gesture.
      }
    }
  }, true);

  window.addEventListener("pointermove", (event) => {
    const drag = rightDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (Number.isFinite(event.buttons) && (event.buttons & 2) === 0) {
      cancelRightDrag();
      return;
    }
    drag.endX = event.clientX;
    drag.endY = event.clientY;
    if (!drag.dragging) {
      const deltaX = drag.endX - drag.startX;
      const deltaY = drag.endY - drag.startY;
      drag.dragging = deltaX * deltaX + deltaY * deltaY
        >= regionDragThreshold * regionDragThreshold;
    }
    suppressEvent(event);
    if (drag.dragging) {
      scheduleRegionVisual(drag);
    }
  }, true);

  window.addEventListener("pointerup", (event) => {
    const drag = rightDrag;
    if (!drag || event.pointerId !== drag.pointerId || event.button !== 2) return;
    drag.endX = event.clientX;
    drag.endY = event.clientY;
    drag.additive ||= Boolean(event.shiftKey);
    suppressEvent(event);
    cancelRightDrag();
    armGestureSuppression(drag);
    if (drag.dragging) {
      applyRegionSelection(drag);
    } else {
      applySingleSelection(drag.target, drag.endX, drag.endY, drag.additive, drag.source);
    }
  }, true);

  window.addEventListener("pointercancel", (event) => {
    if (rightDrag && event.pointerId === rightDrag.pointerId) cancelRightDrag();
  }, true);

  window.addEventListener("lostpointercapture", (event) => {
    if (rightDrag && event.pointerId === rightDrag.pointerId) cancelRightDrag();
  }, true);

  window.addEventListener("auxclick", (event) => {
    if (!event.isTrusted || event.button !== 2) return;
    if (rightDrag) {
      rightDrag.auxClickSeen = true;
      suppressEvent(event);
      return;
    }
    if (suppressNextAuxClick) {
      suppressNextAuxClick = 0;
      suppressEvent(event);
    }
  }, true);

  window.addEventListener("contextmenu", (event) => {
    if (!event.isTrusted) return;
    if (rightDrag) {
      rightDrag.contextMenuSeen = true;
      suppressEvent(event);
      return;
    }
    if (suppressNextContextMenu) {
      suppressNextContextMenu = 0;
      suppressEvent(event);
      return;
    }
    const target = eventElement(event);
    if (
      !(target instanceof ElementType)
      || safeCall(elementClosest, target, "[data-ihc-ui-pick]")
    ) return;
    if (containsPasswordInput(target)) return;
    suppressEvent(event);
    applySingleSelection(
      target,
      event.clientX,
      event.clientY,
      Boolean(event.shiftKey),
      String(window.location.href),
    );
  }, true);

  const cancelSelection = () => {
    captureGeneration += 1;
    cancelRightDrag();
    clearGestureSuppression();
    clearSelection();
  };
  window.addEventListener("blur", cancelSelection);
  window.addEventListener("resize", cancelSelection);
  window.addEventListener("scroll", cancelSelection, true);
  window.addEventListener("pagehide", cancelSelection);
  window.addEventListener("keydown", (event) => {
    if (
      event.isTrusted &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      (event.code === "Space" || event.key === " ")
    ) {
      suppressEvent(event);
      if (!event.repeat) {
        postMessage(messagePrefix + jsonStringify({
          type: "ihc-media-drawer-toggle",
          version: 1,
          nonce,
        }));
      }
      return;
    }
    if (event.key === "Escape") cancelSelection();
  }, true);
})();
