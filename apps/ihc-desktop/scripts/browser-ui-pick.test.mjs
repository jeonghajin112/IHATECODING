import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const PICKER_SOURCE_URL = new URL(
  "../src-tauri/src/browser_ui_pick.js",
  import.meta.url,
);
const MESSAGE_PREFIX = "__IHC_UI_PICK_V2__:";

const pickerSource = await readFile(PICKER_SOURCE_URL, "utf8");

const rectangle = (left, top, width, height) => ({
  x: left,
  y: top,
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

function createPickerFixture() {
  const listeners = new Map();
  const animationFrames = [];
  const cancelledAnimationFrames = new Set();
  const scheduledTimeouts = [];
  const postedMessages = [];
  let requestId = 0;
  let animationFrameId = 0;

  class FakeNode {
    constructor() {
      this.parentNode = null;
      this.childNodes = [];
    }

    get isConnected() {
      let current = this;
      while (current) {
        if (current instanceof FakeDocument) return true;
        current = current.parentNode;
      }
      return false;
    }

    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    }

    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }

    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index < 0) throw new Error("The node is not a child.");
      this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    cloneNode(deep = false) {
      if (!(this instanceof FakeElement)) {
        throw new Error("Only picker elements are cloned in this fixture.");
      }
      const clone = new FakeElement(this.localName, {
        attributes: Object.fromEntries(this.attributes),
        classes: [...this.classList],
        computedStyle: { ...this.computedStyle },
        rect: { ...this.rect },
      });
      clone.style = { ...this.style };
      clone.textContent = this.textContent;
      clone.innerText = this.innerText;
      if (deep) {
        for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
      }
      return clone;
    }
  }

  class FakeElement extends FakeNode {
    constructor(
      localName,
      {
        id = "",
        attributes = {},
        classes = [],
        computedStyle = {},
        rect = rectangle(0, 0, 0, 0),
        text = "",
      } = {},
    ) {
      super();
      this.localName = String(localName).toLowerCase();
      this.id = id;
      this.attributes = new Map(Object.entries(attributes));
      if (id) this.attributes.set("id", id);
      this.classList = [...classes];
      if (this.classList.length > 0) {
        this.attributes.set("class", this.classList.join(" "));
      }
      this.style = {};
      this.computedStyle = {
        display: "block",
        visibility: "visible",
        opacity: "1",
        position: "static",
        color: "rgb(255, 255, 255)",
        backgroundColor: "rgba(0, 0, 0, 0)",
        fontFamily: "system-ui",
        fontSize: "16px",
        fontWeight: "400",
        lineHeight: "normal",
        border: "0px none rgb(255, 255, 255)",
        borderRadius: "0px",
        padding: "0px",
        margin: "0px",
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        ...computedStyle,
      };
      this.rect = { ...rect };
      this.textContent = text;
      this.innerText = text;
      this.capturedPointers = new Set();
    }

    get parentElement() {
      return this.parentNode instanceof FakeElement ? this.parentNode : null;
    }

    get children() {
      return this.childNodes.filter((node) => node instanceof FakeElement);
    }

    setAttribute(name, value) {
      const normalized = String(value);
      this.attributes.set(name, normalized);
      if (name === "id") this.id = normalized;
      if (name === "class") {
        this.classList = normalized.split(/\s+/).filter(Boolean);
      }
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((selector) => this.matchesOne(selector.trim()));
    }

    matchesOne(selector) {
      if (!selector) return false;
      if (selector === "*") return true;
      const attributeOnly = selector.match(/^\[([\w-]+)\]$/);
      if (attributeOnly) return this.attributes.has(attributeOnly[1]);
      const tagWithAttribute = selector.match(
        /^([a-z][\w-]*)\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/i,
      );
      if (tagWithAttribute) {
        const [, tag, name, expected] = tagWithAttribute;
        if (this.localName !== tag.toLowerCase() || !this.attributes.has(name)) return false;
        return expected === undefined || this.getAttribute(name) === expected;
      }
      const idSelector = selector.match(/^([a-z][\w-]*)#([\w-]+)$/i);
      if (idSelector) {
        return this.localName === idSelector[1].toLowerCase() && this.id === idSelector[2];
      }
      return this.localName === selector.toLowerCase();
    }

    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    }

    querySelector(selector) {
      return walkElements(this).find((element) => element !== this && element.matches(selector))
        ?? null;
    }

    querySelectorAll(selector) {
      return walkElements(this)
        .filter((element) => element !== this && element.matches(selector));
    }

    getBoundingClientRect() {
      return { ...this.rect };
    }

    setPointerCapture(pointerId) {
      this.capturedPointers.add(pointerId);
    }

    releasePointerCapture(pointerId) {
      this.capturedPointers.delete(pointerId);
    }
  }

  class FakeDocument extends FakeNode {
    constructor() {
      super();
      this.title = "Picker test page";
      this.documentElement = new FakeElement("html", {
        rect: rectangle(0, 0, 800, 600),
      });
      this.body = new FakeElement("body", {
        rect: rectangle(0, 0, 800, 600),
      });
      this.appendChild(this.documentElement);
      this.documentElement.appendChild(this.body);
    }

    createElement(localName) {
      return new FakeElement(localName);
    }

    querySelectorAll(selector) {
      const elements = walkElements(this);
      if (selector === "*") return elements;
      const lastSelector = selector.split(">").at(-1)?.trim() ?? selector;
      return elements.filter((element) => element.matches(lastSelector));
    }
  }

  class FakeEvent {
    constructor(type, init = {}) {
      Object.assign(this, {
        type,
        button: 0,
        buttons: 0,
        clientX: 0,
        clientY: 0,
        pointerId: 1,
        pointerType: "mouse",
        shiftKey: false,
        isTrusted: true,
        key: "",
        ...init,
      });
      this.defaultPrevented = false;
      this.immediatePropagationStopped = false;
      this.path = init.path ?? [];
    }

    preventDefault() {
      this.defaultPrevented = true;
    }

    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    }

    composedPath() {
      return [...this.path];
    }
  }

  function walkElements(root) {
    const result = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) result.push(child);
        visit(child);
      }
    };
    visit(root);
    return result;
  }

  const document = new FakeDocument();
  const window = {
    Element: FakeElement,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    location: { href: "https://example.test/page" },
    chrome: {
      webview: {
        postMessage(message) {
          postedMessages.push(message);
        },
      },
    },
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    getComputedStyle(element) {
      return { ...element.computedStyle };
    },
    requestAnimationFrame(callback) {
      const id = ++animationFrameId;
      animationFrames.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledAnimationFrames.add(id);
    },
    setTimeout(callback, delay) {
      scheduledTimeouts.push({ callback, delay });
      return scheduledTimeouts.length;
    },
  };
  window.top = window;

  const sandbox = {
    CSS: { escape: (value) => String(value).replace(/[^\w-]/g, "\\$&") },
    Document: FakeDocument,
    Element: FakeElement,
    Event: FakeEvent,
    Node: FakeNode,
    console,
    crypto: { randomUUID: () => `request-${++requestId}` },
    document,
    window,
  };
  const context = vm.createContext(sandbox);
  const executableSource = pickerSource.replace(
    "__IHC_UI_PICK_NONCE_JSON__",
    JSON.stringify("test-nonce"),
  );
  vm.runInContext(executableSource, context, {
    filename: PICKER_SOURCE_URL.pathname,
  });

  const eventPath = (target) => {
    const path = [];
    let current = target;
    while (current) {
      path.push(current);
      current = current.parentNode;
    }
    path.push(window);
    return path;
  };

  const dispatch = (type, target, init = {}) => {
    const event = new FakeEvent(type, {
      path: eventPath(target),
      ...init,
    });
    for (const listener of [...(listeners.get(type) ?? [])]) {
      listener.call(window, event);
      if (event.immediatePropagationStopped) break;
    }
    return event;
  };

  const flushAnimationFrames = async () => {
    for (let pass = 0; pass < 8; pass += 1) {
      await Promise.resolve();
      const callbacks = animationFrames.splice(0);
      if (callbacks.length === 0) {
        await Promise.resolve();
        if (animationFrames.length === 0) break;
        continue;
      }
      for (const { id, callback } of callbacks) {
        if (!cancelledAnimationFrames.delete(id)) callback(pass * 16);
      }
    }
    await Promise.resolve();
  };

  const addElement = ({
    tag = "button",
    id,
    rect,
    attributes,
    classes,
    computedStyle,
    text = id ?? tag,
    parent = document.body,
  }) => {
    const element = new FakeElement(tag, {
      id,
      rect,
      attributes,
      classes,
      computedStyle,
      text,
    });
    parent.appendChild(element);
    return element;
  };

  const payloads = () => postedMessages.map((message) => {
    assert.equal(typeof message, "string");
    assert.ok(message.startsWith(MESSAGE_PREFIX));
    return JSON.parse(message.slice(MESSAGE_PREFIX.length));
  });

  const pickerVisuals = (kind) => document
    .querySelectorAll("*")
    .filter((element) => element.getAttribute("data-ihc-ui-pick") === kind);

  return {
    addElement,
    dispatch,
    document,
    flushAnimationFrames,
    payloads,
    pickerVisuals,
    scheduledTimeouts,
  };
}

function pointerGesture(
  fixture,
  {
    target,
    start,
    end = start,
    pointerId = 1,
    shiftKey = false,
    cancel = false,
  },
) {
  const pointerDown = fixture.dispatch("pointerdown", target, {
    button: 2,
    buttons: 2,
    clientX: start.x,
    clientY: start.y,
    pointerId,
    shiftKey,
  });
  if (start.x !== end.x || start.y !== end.y) {
    fixture.dispatch("pointermove", target, {
      button: -1,
      buttons: 2,
      clientX: end.x,
      clientY: end.y,
      pointerId,
      shiftKey,
    });
  }
  if (cancel) {
    fixture.dispatch("pointercancel", target, {
      button: 2,
      buttons: 0,
      clientX: end.x,
      clientY: end.y,
      pointerId,
      shiftKey,
    });
    return { pointerDown, pointerUp: null };
  }
  const pointerUp = fixture.dispatch("pointerup", target, {
    button: 2,
    buttons: 0,
    clientX: end.x,
    clientY: end.y,
    pointerId,
    shiftKey,
  });
  return { pointerDown, pointerUp };
}

function dispatchGeneratedContextMenu(fixture, target, point, shiftKey = false) {
  return fixture.dispatch("contextmenu", target, {
    button: 2,
    buttons: 0,
    clientX: point.x,
    clientY: point.y,
    shiftKey,
  });
}

const selectors = (payload) => payload.targets.map((target) => target.selector);

test("a short right click submits one target once and consumes its generated context menu", async () => {
  const fixture = createPickerFixture();
  const target = fixture.addElement({
    id: "single",
    rect: rectangle(40, 40, 80, 30),
  });
  const { pointerDown, pointerUp } = pointerGesture(fixture, {
    target,
    start: { x: 60, y: 55 },
  });
  assert.equal(pointerDown.defaultPrevented, true);
  assert.equal(pointerUp.defaultPrevented, true);

  const contextMenu = dispatchGeneratedContextMenu(
    fixture,
    target,
    { x: 60, y: 55 },
  );
  assert.equal(contextMenu.defaultPrevented, true);
  assert.equal(contextMenu.immediatePropagationStopped, true);

  await fixture.flushAnimationFrames();
  const payloads = fixture.payloads();
  assert.equal(payloads.length, 1);
  assert.deepEqual(selectors(payloads[0]), ["button#single"]);
});

test("right-drag selects only fully contained elements and excludes partial intersections", async () => {
  const fixture = createPickerFixture();
  const contained = fixture.addElement({
    id: "contained",
    rect: rectangle(20, 20, 20, 20),
  });
  fixture.addElement({
    id: "partial",
    rect: rectangle(100, 20, 20, 20),
  });
  fixture.addElement({
    id: "boundary",
    rect: rectangle(90, 90, 20, 20),
  });

  pointerGesture(fixture, {
    target: contained,
    start: { x: 10, y: 10 },
    end: { x: 110, y: 110 },
  });
  dispatchGeneratedContextMenu(fixture, contained, { x: 110, y: 110 });
  await fixture.flushAnimationFrames();

  const payloads = fixture.payloads();
  assert.equal(payloads.length, 1);
  assert.deepEqual(selectors(payloads[0]), ["button#contained", "button#boundary"]);
});

test("right-drag keeps up to 32 roots and shares descendant context across the whole selection", async () => {
  const fixture = createPickerFixture();
  const cards = [];
  for (let index = 0; index < 40; index += 1) {
    const left = 10 + (index % 5) * 155;
    const top = 10 + Math.floor(index / 5) * 72;
    const card = fixture.addElement({
      tag: "article",
      id: `bulk-${index}`,
      rect: rectangle(left, top, 140, 64),
      computedStyle: {
        backgroundColor: "rgb(12, 12, 12)",
        border: "1px solid rgb(48, 48, 48)",
        borderRadius: "8px",
      },
      text: `Card ${index}`,
    });
    cards.push(card);
    for (let child = 0; child < 10; child += 1) {
      fixture.addElement({
        tag: "p",
        rect: rectangle(left + 4, top + 2 + child * 5, 120, 4),
        text: `Card ${index} detail ${child}`,
        parent: card,
      });
    }
  }

  pointerGesture(fixture, {
    target: cards[0],
    start: { x: 1, y: 1 },
    end: { x: 799, y: 599 },
  });
  dispatchGeneratedContextMenu(fixture, cards[0], { x: 799, y: 599 });
  await fixture.flushAnimationFrames();

  const payloads = fixture.payloads();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].targets.length, 32);
  assert.deepEqual(
    selectors(payloads[0]),
    cards.slice(0, 32).map((_, index) => `article#bulk-${index}`),
  );
  const descendantCounts = payloads[0].targets.map((target) => target.descendants.length);
  assert.ok(descendantCounts.every((count) => count > 0));
  assert.ok(Math.max(...descendantCounts) - Math.min(...descendantCounts) <= 1);
  assert.ok(payloads[0].targets.every((target) => target.descendantsTruncated));
  assert.ok(
    Buffer.byteLength(MESSAGE_PREFIX + JSON.stringify(payloads[0]), "utf8") <= 240 * 1024,
  );
});

test("32 adversarial Unicode roots keep every root under the bounded IPC payload", async () => {
  const fixture = createPickerFixture();
  const hostile = '\\\"😀한'.repeat(100);
  const roots = [];
  for (let index = 0; index < 33; index += 1) {
    const left = 8 + (index % 6) * 130;
    const top = 8 + Math.floor(index / 6) * 92;
    roots.push(fixture.addElement({
      id: `hostile-${index}`,
      rect: rectangle(left, top, 112, 72),
      text: hostile,
      attributes: {
        "aria-label": hostile,
        "data-testid": hostile,
        "data-test": hostile,
        "data-cy": hostile,
        name: hostile,
      },
      classes: Array.from({ length: 8 }, (_, classIndex) =>
        `hostile-${classIndex}-${hostile}`),
      computedStyle: {
        color: hostile,
        backgroundColor: hostile,
        fontFamily: hostile,
        fontSize: hostile,
        fontWeight: hostile,
        lineHeight: hostile,
        border: hostile,
        borderRadius: hostile,
        padding: hostile,
        margin: hostile,
        width: hostile,
        height: hostile,
      },
    }));
  }

  pointerGesture(fixture, {
    target: roots[0],
    start: { x: 1, y: 1 },
    end: { x: 799, y: 599 },
  });
  dispatchGeneratedContextMenu(fixture, roots[0], { x: 799, y: 599 });
  await fixture.flushAnimationFrames();

  const [payload] = fixture.payloads();
  assert.equal(payload.targets.length, 32);
  assert.deepEqual(
    selectors(payload),
    roots.slice(0, 32).map((_, index) => `button#hostile-${index}`),
  );
  assert.ok(payload.targets.every((target) => target.tag === "button"));
  assert.ok(payload.targets.every((target) => target.rect.width === 112));
  assert.ok(payload.targets.every((target) => target.selector));
  assert.ok(payload.targets.every((target) => target.metadataTruncated));
  assert.ok(
    Buffer.byteLength(MESSAGE_PREFIX + JSON.stringify(payload), "utf8") <= 240 * 1024,
  );
});

test("right-drag selects styled card containers instead of their nested content", async () => {
  const fixture = createPickerFixture();
  const cards = [
    {
      id: "structure-card",
      left: 30,
      label: "규칙 기반 자동 검사",
      heading: "구조와 상호작용",
      description:
        "KWCAG의 웹 표준을 기준으로 대체 텍스트, 레이블, 제목 구조와 키보드 흐름을 확인합니다.",
    },
    {
      id: "readability-card",
      left: 290,
      label: "읽기 난이도 분석",
      heading: "한국어 문장 난이도",
      description:
        "긴 문장과 어려운 표현을 찾아 콘텐츠를 더 이해하기 쉬운 언어로 다듬을 단서를 제공합니다.",
    },
    {
      id: "contrast-card",
      left: 550,
      label: "WCAG 명암비 점검",
      heading: "색상과 명암비",
      description:
        "텍스트와 배경의 대비를 점검해 저시력 사용자도 읽기 어려운 영역을 빠르게 발견합니다.",
    },
  ];

  const cardElements = cards.map((card) => {
    const container = fixture.addElement({
      tag: "div",
      id: card.id,
      rect: rectangle(card.left, 40, 220, 280),
      computedStyle: {
        backgroundColor: "rgb(9, 9, 9)",
        border: "1px solid rgb(54, 54, 54)",
        borderRadius: "32px",
        padding: "28px",
      },
      text: `${card.label} ${card.heading} ${card.description}`,
    });
    fixture.addElement({
      tag: "svg",
      attributes: { "aria-hidden": "true" },
      rect: rectangle(card.left + 28, 64, 44, 44),
      text: "",
      parent: container,
    });
    fixture.addElement({
      tag: "span",
      classes: ["card-label"],
      rect: rectangle(card.left + 28, 150, 164, 20),
      text: card.label,
      parent: container,
    });
    fixture.addElement({
      tag: "h2",
      rect: rectangle(card.left + 28, 180, 164, 38),
      text: card.heading,
      parent: container,
    });
    fixture.addElement({
      tag: "p",
      rect: rectangle(card.left + 28, 232, 164, 60),
      text: card.description,
      parent: container,
    });
    return container;
  });

  pointerGesture(fixture, {
    target: cardElements[0],
    start: { x: 10, y: 10 },
    end: { x: 790, y: 350 },
  });
  dispatchGeneratedContextMenu(fixture, cardElements[0], { x: 790, y: 350 });
  await fixture.flushAnimationFrames();

  const payloads = fixture.payloads();
  assert.equal(payloads.length, 1);
  assert.deepEqual(selectors(payloads[0]), cards.map(({ id }) => `div#${id}`));
  assert.equal(payloads[0].targets.length, 3);
  for (const [index, target] of payloads[0].targets.entries()) {
    assert.ok(target.text.includes(cards[index].description));
    assert.equal(target.descendantsTruncated, false);
    assert.deepEqual(
      target.descendants.map((descendant) => descendant.element.tag),
      ["svg", "span", "h2", "p"],
    );
    assert.ok(target.descendants.every((descendant) => descendant.depth === 1));
    assert.ok(target.descendants.every((descendant) => descendant.parentIndex === null));
    assert.ok(target.descendants[0].element.selector.endsWith("svg"));
    assert.equal(target.descendants[2].element.text, cards[index].heading);
    assert.equal(target.descendants[3].element.text, cards[index].description);
    assert.ok(target.descendants[3].element.rect.height > 0);
    assert.ok(target.descendants[3].element.styles.some(({ name }) => name === "font-size"));
  }
});

test("captured descendants preserve meaningful hierarchy and stay bounded", async () => {
  const fixture = createPickerFixture();
  const card = fixture.addElement({
    tag: "article",
    id: "hierarchy-card",
    rect: rectangle(30, 30, 360, 420),
    text: "Card actions",
  });
  const action = fixture.addElement({
    tag: "button",
    id: "card-action",
    rect: rectangle(60, 70, 160, 48),
    text: "Inspect",
    parent: card,
  });
  fixture.addElement({
    tag: "span",
    rect: rectangle(76, 82, 100, 24),
    text: "Inspect",
    parent: action,
  });
  for (let index = 0; index < 70; index += 1) {
    fixture.addElement({
      tag: "span",
      classes: [`detail-${index}`],
      rect: rectangle(60, 130 + index * 3, 180, 2),
      text: `Detail ${index}`,
      parent: card,
    });
  }

  pointerGesture(fixture, {
    target: card,
    start: { x: 45, y: 45 },
  });
  dispatchGeneratedContextMenu(fixture, card, { x: 45, y: 45 });
  await fixture.flushAnimationFrames();

  const [target] = fixture.payloads()[0].targets;
  assert.equal(target.descendants.length, 64);
  assert.equal(target.descendantsTruncated, true);
  assert.equal(target.descendants[0].element.selector, "button#card-action");
  assert.equal(target.descendants[0].depth, 1);
  assert.equal(target.descendants[0].parentIndex, null);
  assert.equal(target.descendants[1].element.tag, "span");
  assert.equal(target.descendants[1].depth, 2);
  assert.equal(target.descendants[1].parentIndex, 0);
});

test("reverse right-drag normalizes the region before selecting", async () => {
  const fixture = createPickerFixture();
  const contained = fixture.addElement({
    id: "reverse-contained",
    rect: rectangle(30, 30, 25, 25),
  });
  fixture.addElement({
    id: "reverse-partial",
    rect: rectangle(0, 30, 20, 20),
  });

  pointerGesture(fixture, {
    target: contained,
    start: { x: 110, y: 110 },
    end: { x: 10, y: 10 },
  });
  dispatchGeneratedContextMenu(fixture, contained, { x: 10, y: 10 });
  await fixture.flushAnimationFrames();

  const payloads = fixture.payloads();
  assert.equal(payloads.length, 1);
  assert.deepEqual(selectors(payloads[0]), ["button#reverse-contained"]);
});

test("Shift-right-drag adds region targets to the existing selection", async () => {
  const fixture = createPickerFixture();
  const first = fixture.addElement({
    id: "first",
    rect: rectangle(20, 20, 30, 30),
  });
  const second = fixture.addElement({
    id: "second",
    rect: rectangle(150, 150, 25, 25),
  });
  fixture.addElement({
    id: "third",
    rect: rectangle(200, 180, 25, 25),
  });

  pointerGesture(fixture, {
    target: first,
    start: { x: 30, y: 30 },
  });
  dispatchGeneratedContextMenu(fixture, first, { x: 30, y: 30 });
  await fixture.flushAnimationFrames();

  pointerGesture(fixture, {
    target: second,
    start: { x: 130, y: 130 },
    end: { x: 240, y: 230 },
    pointerId: 2,
    shiftKey: true,
  });
  dispatchGeneratedContextMenu(fixture, second, { x: 240, y: 230 }, true);
  await fixture.flushAnimationFrames();

  const payloads = fixture.payloads();
  assert.equal(payloads.length, 2);
  assert.deepEqual(selectors(payloads[0]), ["button#first"]);
  assert.deepEqual(selectors(payloads[1]), [
    "button#first",
    "button#second",
    "button#third",
  ]);
});

test("Shift-right-click toggles an existing target off and emits only non-empty selections", async () => {
  const fixture = createPickerFixture();
  const first = fixture.addElement({
    id: "toggle-first",
    rect: rectangle(30, 30, 80, 32),
  });
  const second = fixture.addElement({
    id: "toggle-second",
    rect: rectangle(150, 30, 80, 32),
  });

  pointerGesture(fixture, { target: first, start: { x: 50, y: 45 } });
  dispatchGeneratedContextMenu(fixture, first, { x: 50, y: 45 });
  await fixture.flushAnimationFrames();

  pointerGesture(fixture, {
    target: second,
    start: { x: 170, y: 45 },
    pointerId: 2,
    shiftKey: true,
  });
  dispatchGeneratedContextMenu(fixture, second, { x: 170, y: 45 }, true);
  await fixture.flushAnimationFrames();

  pointerGesture(fixture, {
    target: first,
    start: { x: 50, y: 45 },
    pointerId: 3,
    shiftKey: true,
  });
  dispatchGeneratedContextMenu(fixture, first, { x: 50, y: 45 }, true);
  await fixture.flushAnimationFrames();

  let payloads = fixture.payloads();
  assert.equal(payloads.length, 3);
  assert.deepEqual(selectors(payloads[0]), ["button#toggle-first"]);
  assert.deepEqual(selectors(payloads[1]), [
    "button#toggle-first",
    "button#toggle-second",
  ]);
  assert.deepEqual(selectors(payloads[2]), ["button#toggle-second"]);
  assert.equal(fixture.pickerVisuals("outline").length, 1);

  pointerGesture(fixture, {
    target: second,
    start: { x: 170, y: 45 },
    pointerId: 4,
    shiftKey: true,
  });
  dispatchGeneratedContextMenu(fixture, second, { x: 170, y: 45 }, true);
  await fixture.flushAnimationFrames();

  payloads = fixture.payloads();
  assert.equal(payloads.length, 3);
  assert.equal(fixture.pickerVisuals("outline").length, 0);
  assert.equal(fixture.pickerVisuals("anchor").length, 0);
});

test("toggling the only target off cancels its pending capture", async () => {
  const fixture = createPickerFixture();
  const target = fixture.addElement({
    id: "pending-toggle",
    rect: rectangle(30, 30, 80, 32),
  });

  pointerGesture(fixture, { target, start: { x: 50, y: 45 } });
  pointerGesture(fixture, {
    target,
    start: { x: 50, y: 45 },
    pointerId: 2,
    shiftKey: true,
  });
  await fixture.flushAnimationFrames();

  assert.equal(fixture.payloads().length, 0);
  assert.equal(fixture.pickerVisuals("outline").length, 0);
});

test("drag context-menu suppression is one-shot and the next short right click still works", async () => {
  const fixture = createPickerFixture();
  const dragged = fixture.addElement({
    id: "dragged",
    rect: rectangle(30, 30, 30, 30),
  });
  const clicked = fixture.addElement({
    id: "clicked-after-drag",
    rect: rectangle(300, 80, 50, 30),
  });

  pointerGesture(fixture, {
    target: dragged,
    start: { x: 10, y: 10 },
    end: { x: 100, y: 100 },
  });
  const generatedAfterDrag = dispatchGeneratedContextMenu(
    fixture,
    dragged,
    { x: 100, y: 100 },
  );
  assert.equal(generatedAfterDrag.defaultPrevented, true);
  assert.equal(generatedAfterDrag.immediatePropagationStopped, true);
  await fixture.flushAnimationFrames();
  assert.equal(fixture.payloads().length, 1);

  pointerGesture(fixture, {
    target: clicked,
    start: { x: 320, y: 95 },
    pointerId: 2,
  });
  const generatedAfterClick = dispatchGeneratedContextMenu(
    fixture,
    clicked,
    { x: 320, y: 95 },
  );
  assert.equal(generatedAfterClick.defaultPrevented, true);
  assert.equal(generatedAfterClick.immediatePropagationStopped, true);
  await fixture.flushAnimationFrames();

  const payloads = fixture.payloads();
  assert.equal(payloads.length, 2);
  assert.deepEqual(selectors(payloads[1]), ["button#clicked-after-drag"]);
});

test("pointercancel removes the drag visual and leaves the next gesture usable", async () => {
  const fixture = createPickerFixture();
  const target = fixture.addElement({
    id: "cancelled",
    rect: rectangle(40, 40, 30, 30),
  });

  fixture.dispatch("pointerdown", target, {
    button: 2,
    buttons: 2,
    clientX: 10,
    clientY: 10,
    pointerId: 1,
  });
  fixture.dispatch("pointermove", target, {
    button: -1,
    buttons: 2,
    clientX: 120,
    clientY: 120,
    pointerId: 1,
  });
  await fixture.flushAnimationFrames();
  assert.equal(fixture.pickerVisuals("region").length, 1);
  assert.equal(fixture.document.documentElement.capturedPointers.has(1), true);

  fixture.dispatch("pointercancel", target, {
    button: 2,
    buttons: 0,
    clientX: 120,
    clientY: 120,
    pointerId: 1,
  });
  assert.equal(fixture.pickerVisuals("region").length, 0);
  assert.equal(fixture.document.documentElement.capturedPointers.size, 0);
  await fixture.flushAnimationFrames();
  assert.equal(fixture.payloads().length, 0);

  pointerGesture(fixture, {
    target,
    start: { x: 50, y: 50 },
    pointerId: 2,
  });
  dispatchGeneratedContextMenu(fixture, target, { x: 50, y: 50 });
  await fixture.flushAnimationFrames();
  assert.equal(fixture.payloads().length, 1);
  assert.deepEqual(selectors(fixture.payloads()[0]), ["button#cancelled"]);
});
