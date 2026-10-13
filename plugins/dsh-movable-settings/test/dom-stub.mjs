/**
 * 最小 DOM 桩：为 client.js 的纯 DOM 增强逻辑提供可复现的运行环境。
 *
 * 只实现插件真正用到的那部分浏览器语义（选择器匹配、事件捕获/冒泡、绝对定位
 * 的 getBoundingClientRect、MutationObserver、rAF、setTimeout、localStorage、
 * getComputedStyle 自定义属性）。它不是浏览器模拟器，测试结论里必须标注这一点。
 */

const BODY_ID = Symbol('body');

function createStyle() {
  const props = new Map();
  return new Proxy({}, {
    get(_target, key) {
      if (key === '__props') return props;
      if (key === 'setProperty') return (name, value) => { props.set(name, String(value)); };
      if (key === 'removeProperty') return (name) => { props.delete(name); };
      if (key === 'getPropertyValue') return (name) => (props.has(name) ? props.get(name) : '');
      if (typeof key === 'symbol') return undefined;
      return props.has(key) ? props.get(key) : '';
    },
    set(_target, key, value) {
      if (typeof key === 'symbol') return true;
      props.set(key, value === null || value === undefined ? '' : String(value));
      return true;
    },
    has(_target, key) { return props.has(key); },
  });
}

function classListFrom(text) {
  return new Set(String(text).split(/\s+/).filter(Boolean));
}

function createClassList(initial) {
  const set = classListFrom(initial ?? '');
  return {
    add: (...names) => { names.forEach((name) => set.add(name)); },
    remove: (...names) => { names.forEach((name) => set.delete(name)); },
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const next = force === undefined ? !set.has(name) : Boolean(force);
      if (next) set.add(name); else set.delete(name);
      return next;
    },
    get size() { return set.size; },
    toString: () => [...set].join(' '),
    [Symbol.iterator]: () => set[Symbol.iterator](),
  };
}

function isCapture(options) {
  return options === true || Boolean(options && options.capture === true);
}

function serializeStyle(props) {
  const parts = [];
  for (const [key, value] of props) {
    if (value === '' || value === undefined || value === null) continue;
    parts.push(key + ': ' + value);
  }
  return parts.join('; ');
}

function applyStyleText(style, text) {
  style.__props.clear();
  String(text ?? '').split(';').forEach((chunk) => {
    const index = chunk.indexOf(':');
    if (index < 0) return;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) style.__props.set(key, value);
  });
}

function parseCompound(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([a-zA-Z][\w-]*)?((?:\[[^\]]*\])*)$/);
  if (!match) return null;
  const attrs = [];
  const re = /\[([^\]=\s]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let hit;
  while ((hit = re.exec(match[2] || ''))) {
    attrs.push({ name: hit[1], value: hit[2] ?? hit[3] ?? hit[4] ?? null });
  }
  return { tag: match[1] ? match[1].toUpperCase() : null, attrs };
}

export function createEnvironment(options = {}) {
  const observers = [];
  const rafQueue = [];
  const timers = new Map();
  const vars = new Map();
  const warnings = [];
  const errors = [];
  let rafSeq = 0;
  let timerSeq = 0;
  let doc = null;

  class Element {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.style = createStyle();
      this.classList = createClassList('');
      this.listeners = new Map();
      this.hidden = false;
      this.baseRect = null;
      this.captured = null;
    }

    get className() { return this.attributes.get('class') ?? ''; }

    set className(value) {
      this.setAttribute('class', value);
    }

    get firstElementChild() {
      return this.children.find((child) => child.nodeType === 1) ?? null;
    }

    get nextElementSibling() {
      const parent = this.parentElement;
      if (!parent) return null;
      const siblings = parent.children;
      const index = siblings.indexOf(this);
      if (index < 0) return null;
      for (let i = index + 1; i < siblings.length; i += 1) {
        if (siblings[i].nodeType === 1) return siblings[i];
      }
      return null;
    }

    get isConnected() {
      let node = this;
      while (node.parentElement) node = node.parentElement;
      return node === doc.documentElement;
    }

    setAttribute(name, value) {
      if (name === 'style') {
        applyStyleText(this.style, String(value));
        this.attributes.set('style', String(value));
        return;
      }
      this.attributes.set(name, String(value));
      if (name === 'class') this.classList = createClassList(value);
    }

    getAttribute(name) {
      if (name === 'style') {
        const text = serializeStyle(this.style.__props);
        return text === '' ? null : text;
      }
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
      if (name === 'style') return serializeStyle(this.style.__props) !== '';
      return this.attributes.has(name);
    }

    removeAttribute(name) {
      if (name === 'style') this.style.__props.clear();
      this.attributes.delete(name);
      if (name === 'class') this.classList = createClassList('');
    }

    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    remove() {
      const parent = this.parentElement;
      if (parent) {
        const index = parent.children.indexOf(this);
        if (index >= 0) parent.children.splice(index, 1);
      }
      this.parentElement = null;
    }

    contains(node) {
      let cursor = node;
      while (cursor) {
        if (cursor === this) return true;
        cursor = cursor.parentElement;
      }
      return false;
    }

    matches(selector) {
      return String(selector).split(',').some((part) => {
        const compound = parseCompound(part);
        if (!compound) return false;
        if (compound.tag && this.tagName !== compound.tag) return false;
        return compound.attrs.every((attr) => (
          this.attributes.has(attr.name)
          && (attr.value === null || this.getAttribute(attr.name) === attr.value)
        ));
      });
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.nodeType !== 1) continue;
          if (child.matches(selector)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }

    getBoundingClientRect() {
      const props = this.style.__props;
      const num = (key) => {
        const value = props.get(key);
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const base = this.baseRect || { left: 0, top: 0, width: 0, height: 0 };
      const left = num('left') ?? base.left;
      const top = num('top') ?? base.top;
      const width = num('width') ?? base.width;
      const height = num('height') ?? base.height;
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
    }

    setPointerCapture(id) { this.captured = id; }
    releasePointerCapture(id) { if (this.captured === id) this.captured = null; }

    addEventListener(type, handler, options) {
      const capture = isCapture(options);
      const list = this.listeners.get(type) || [];
      list.push({ handler, capture });
      this.listeners.set(type, list);
    }

    removeEventListener(type, handler, options) {
      const capture = isCapture(options);
      const list = (this.listeners.get(type) || []).filter((entry) => !(entry.handler === handler && entry.capture === capture));
      this.listeners.set(type, list);
    }

    dispatchEvent(event) {
      const path = [];
      let node = this;
      while (node) {
        path.push(node);
        node = node.parentElement;
      }
      if (!path.includes(doc)) path.push(doc);
      let stopped = false;
      event.target = this;
      event.currentTarget = this;
      event.stopPropagation = () => { stopped = true; };
      event.preventDefault = () => { event.defaultPrevented = true; };
      const fire = (target, capture) => {
        for (const entry of [...(target.listeners.get(event.type) || [])]) {
          if (entry.capture !== capture) continue;
          event.currentTarget = target;
          entry.handler(event);
        }
      };
      for (let i = path.length - 1; i >= 0 && !stopped; i -= 1) fire(path[i], true);
      for (let i = 0; i < path.length && !stopped; i += 1) fire(path[i], false);
      return !event.defaultPrevented;
    }
  }

  const documentElement = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  void BODY_ID;

  doc = {
    nodeType: 9,
    parentElement: null,
    documentElement,
    head,
    body,
    listeners: new Map(),
    createElement: (tagName) => new Element(tagName),
    querySelector(selector) { return documentElement.querySelector(selector); },
    querySelectorAll(selector) { return documentElement.querySelectorAll(selector); },
    addEventListener(type, handler, options) {
      const capture = isCapture(options);
      const list = this.listeners.get(type) || [];
      list.push({ handler, capture });
      this.listeners.set(type, list);
    },
    removeEventListener(type, handler, options) {
      const capture = isCapture(options);
      const list = (this.listeners.get(type) || []).filter((entry) => !(entry.handler === handler && entry.capture === capture));
      this.listeners.set(type, list);
    },
    dispatchEvent: Element.prototype.dispatchEvent,
  };

  const storage = new Map();
  const winListeners = new Map();

  const window = {
    innerWidth: options.width ?? 1200,
    innerHeight: options.height ?? 800,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => storage.clear(),
    },
    getComputedStyle: (el) => ({
      getPropertyValue: (name) => {
        const own = el && el.style && el.style.__props.has(name) ? el.style.__props.get(name) : null;
        if (own) return own;
        return vars.has(name) ? vars.get(name) : '';
      },
    }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(target, config) { this.target = target; this.config = config; }
      disconnect() { this.disconnected = true; }
    },
    requestAnimationFrame: (callback) => {
      rafSeq += 1;
      rafQueue.push({ id: rafSeq, callback });
      return rafSeq;
    },
    cancelAnimationFrame: (id) => {
      const index = rafQueue.findIndex((entry) => entry.id === id);
      if (index >= 0) rafQueue.splice(index, 1);
    },
    setTimeout: (callback) => {
      timerSeq += 1;
      timers.set(timerSeq, callback);
      return timerSeq;
    },
    clearTimeout: (id) => { timers.delete(id); },
    addEventListener: (type, handler) => {
      const list = winListeners.get(type) || [];
      list.push(handler);
      winListeners.set(type, list);
    },
    removeEventListener: (type, handler) => {
      const list = (winListeners.get(type) || []).filter((entry) => entry !== handler);
      winListeners.set(type, list);
    },
    dispatchEvent: (event) => {
      for (const handler of [...(winListeners.get(event.type) || [])]) handler(event);
      return true;
    },
  };

  const sandboxConsole = {
    warn: (...args) => { warnings.push(args.join(' ')); },
    error: (...args) => { errors.push(args.join(' ')); },
    log: () => {},
  };

  /** 跑一轮 observer + rAF（插件用 rAF 合帧扫描）。 */
  function flush() {
    let guard = 0;
    do {
      for (const observer of observers) {
        if (!observer.disconnected) observer.callback([]);
      }
      let rafGuard = 0;
      while (rafQueue.length && rafGuard < 50) {
        const batch = rafQueue.splice(0);
        for (const entry of batch) entry.callback(0);
        rafGuard += 1;
      }
      guard += 1;
    } while (rafQueue.length && guard < 20);
  }

  /** 执行排队中的 setTimeout（插件用它做写入节流与 click 吞掉复位）。 */
  function flushTimers() {
    const batch = [...timers.entries()];
    timers.clear();
    for (const [, callback] of batch) callback();
  }

  const sandbox = {
    window,
    document: doc,
    console: sandboxConsole,
    JSON,
    Math,
    Number,
    Object,
    Array,
    String,
    Boolean,
    Error,
    Map,
    Set,
    Date,
    Symbol,
    parseFloat,
    parseInt,
    isFinite,
    Promise,
  };

  /**
   * 极简 React 桩：createElement + 一个可按需重放的 hooks 运行时。
   * `runtime.render(component, props)` 重放一次渲染；setState 只改内部槽位，
   * 由测试再次 render 后读取（不实现自动重渲染）。
   */
  let activeRuntime = null;

  function createRuntime() {
    const state = [];
    const cleanups = [];
    const deps = [];
    let cursor = 0;
    const runtime = {
      render(component, props) {
        const previous = activeRuntime;
        activeRuntime = runtime;
        cursor = 0;
        try {
          return component(props);
        } finally {
          activeRuntime = previous;
        }
      },
      useState(initial) {
        const index = cursor;
        cursor += 1;
        if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
        const setState = (next) => {
          state[index] = typeof next === 'function' ? next(state[index]) : next;
        };
        return [state[index], setState];
      },
      useEffect(effect, nextDeps) {
        const index = cursor;
        cursor += 1;
        const previous = deps[index];
        const changed = nextDeps === undefined
          || previous === undefined
          || nextDeps.length !== previous.length
          || nextDeps.some((value, position) => value !== previous[position]);
        if (!changed) return;
        if (typeof cleanups[index] === 'function') cleanups[index]();
        cleanups[index] = effect() || null;
        deps[index] = nextDeps;
      },
      unmount() {
        for (const cleanup of cleanups) {
          if (typeof cleanup === 'function') cleanup();
        }
        cleanups.length = 0;
        state.length = 0;
        deps.length = 0;
        cursor = 0;
      },
    };
    return runtime;
  }

  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } };
    },
    useState(initial) {
      if (!activeRuntime) throw new Error('useState 必须在 runtime.render 内调用');
      return activeRuntime.useState(initial);
    },
    useEffect(effect, deps) {
      if (!activeRuntime) throw new Error('useEffect 必须在 runtime.render 内调用');
      return activeRuntime.useEffect(effect, deps);
    },
    createRuntime,
  };

  return {
    window, document: doc, sandbox, react, vars, warnings, errors, Element,
    flush, flushTimers, storage,
    setVar: (name, value) => vars.set(name, value),
    element: (tagName) => new Element(tagName),
  };
}

/** 构造一个与上游 `SettingsPanel` 等价的最小 DOM（含语义锚点与两列布局）。 */
export function mountSettings(env, rect = {}) {
  const base = { left: 200, top: 100, width: 800, height: 600, ...rect };
  const overlay = env.element('div');
  overlay.setAttribute('role', 'presentation');
  const mask = env.element('div');
  mask.setAttribute('aria-hidden', 'true');
  const dialog = env.element('div');
  dialog.setAttribute('data-shortcut-modal', 'settings');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.baseRect = { left: base.left, top: base.top, width: base.width, height: base.height };
  const nav = env.element('nav');
  nav.baseRect = { left: base.left, top: base.top, width: 188, height: base.height };
  const navTitle = env.element('div');
  const navList = env.element('div');
  const navCell = env.element('button');
  navList.appendChild(navCell);
  const content = env.element('div');
  const header = env.element('div');
  const actions = env.element('div');
  const slotHost = env.element('div');
  slotHost.setAttribute('data-slot', 'settings.action');
  const upstreamButton = env.element('button');
  const closeButton = env.element('button');
  slotHost.appendChild(upstreamButton);
  actions.appendChild(slotHost);
  actions.appendChild(closeButton);
  header.appendChild(actions);
  const options = env.element('div');
  const optionLabel = env.element('label');
  const optionInput = env.element('input');
  options.appendChild(optionLabel);
  options.appendChild(optionInput);
  content.appendChild(header);
  content.appendChild(options);
  nav.appendChild(navTitle);
  nav.appendChild(navList);
  dialog.appendChild(nav);
  dialog.appendChild(content);
  overlay.appendChild(mask);
  overlay.appendChild(dialog);
  env.document.body.appendChild(overlay);
  return {
    overlay, mask, dialog, nav, navTitle, navList, navCell, content,
    header, actions, slotHost, upstreamButton, options, optionLabel, optionInput, closeButton,
  };
}

/** 造一个指针/双击事件并派发到 target。 */
export function fire(target, type, x, y, extra = {}) {
  const event = {
    type,
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
    defaultPrevented: false,
    ...extra,
  };
  target.dispatchEvent(event);
  return event;
}
