/**
 * dsh-movable-settings 的行为测试：在最小 DOM 桩上跑真实的 client.js 工厂。
 *
 * 覆盖：锚点识别与静默降级、拖动、八向缩放与最小尺寸、视口钳制、双击最大化/还原、
 * 持久化、resize 自适应、重置入口、卸载清理、既有交互不被接管。
 * 结论口径：这是 DOM 桩上的可复现验证，不等价于真机浏览器目视核验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createEnvironment, mountSettings, fire } from './dom-stub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(path.join(here, '..', 'client.js'), 'utf8');

const VIEW = { width: 1200, height: 800, margin: 24 };
const AVAIL = {
  left: VIEW.margin,
  top: VIEW.margin,
  right: VIEW.width - VIEW.margin,
  bottom: VIEW.height - VIEW.margin,
  width: VIEW.width - VIEW.margin * 2,
  height: VIEW.height - VIEW.margin * 2,
};
const STORAGE_KEY = 'dsh-movable-settings:v1';

function boot(env) {
  const spec = { current: null };
  env.window.__ModuleLoader__ = { load(loaded) { spec.current = loaded; } };
  vm.runInNewContext(clientSource, env.sandbox, { filename: 'client.js' });
  assert.ok(spec.current, 'client.js 应通过 __ModuleLoader__ 注册工厂');
  assert.equal(spec.current.id, 'dsh-movable-settings');
  const module = spec.current.factory((name) => {
    if (name === 'react') return env.react;
    throw new Error('unexpected require: ' + name);
  });
  const effects = [];
  const registered = [];
  const scope = {
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; },
    slots: {
      inject(_key, factory) { return factory(); },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    },
    locale: { register() { return () => {}; } },
  };
  module.apply({
    effect: scope.effect,
    inject(_deps, callback) { callback(scope); },
  });
  env.flush();
  return { effects, registered };
}

function rectOf(dialog) {
  return {
    left: Number.parseFloat(dialog.style.left),
    top: Number.parseFloat(dialog.style.top),
    width: Number.parseFloat(dialog.style.width),
    height: Number.parseFloat(dialog.style.height),
  };
}

function stored(env) {
  const raw = env.window.localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

/** 在当前标题条带上双击：最大化后条带会随面板移到视口顶部，坐标必须跟随。 */
function dblclickStrip(dom) {
  fire(dom.navTitle, 'dblclick', 210, rectOf(dom.dialog).top + 20);
}

/**
 * 模拟浏览器对 `title` 的逐元素继承：返回该节点或它最近带 title 属性的祖先的值；
 * 一路向上都没有 title 时返回 null。stop 为边界（不含）。
 */
function nearestTitle(el, stop) {
  let node = el;
  while (node && node !== stop) {
    const value = node.getAttribute('title');
    if (value !== null) return value;
    node = node.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------- 发现与降级

test('无设置弹窗时不注入节点、不告警', () => {
  const env = createEnvironment();
  boot(env);
  env.flush();
  assert.equal(env.warnings.length, 0);
  assert.equal(env.document.body.querySelector('[data-dsh-ms-layer]'), null);
});

test('上游锚点结构不匹配时静默降级：原样式不变、恰好一条 warn、无异常', () => {
  const env = createEnvironment();
  boot(env);
  const broken = env.element('div');
  broken.setAttribute('data-shortcut-modal', 'settings');
  env.document.body.appendChild(broken);
  env.flush();
  env.flush();

  assert.equal(env.warnings.length, 1, '应恰好一条 warn');
  assert.match(env.warnings[0], /dsh-movable-settings/);
  assert.equal(broken.getAttribute('style'), null, '不匹配时不得改动原样式');
  assert.equal(env.document.body.querySelector('[data-dsh-ms-layer]'), null, '不匹配时不得留下多余节点');
  assert.equal(env.errors.length, 0);
});

test('锚点命中但内部结构异常（无子元素）时同样降级：一条 warn、零改动', () => {
  const env = createEnvironment();
  boot(env);
  const broken = env.element('div');
  broken.setAttribute('data-shortcut-modal', 'settings');
  broken.setAttribute('role', 'dialog');
  broken.setAttribute('aria-modal', 'true');
  broken.baseRect = { left: 200, top: 100, width: 800, height: 600 };
  env.document.body.appendChild(broken);
  env.flush();
  env.flush();

  assert.equal(env.warnings.length, 1, '结构异常应恰好一条 warn');
  assert.match(env.warnings[0], /dsh-movable-settings/);
  assert.equal(broken.getAttribute('style'), null, '结构异常时不得写入任何样式');
  assert.equal(broken.getAttribute('title'), null);
  assert.equal(env.document.body.querySelector('[data-dsh-ms-layer]'), null);
  assert.equal(env.errors.length, 0);
});

test('锚点命中但只有单列（缺 content）时同样降级', () => {
  const env = createEnvironment();
  boot(env);
  const broken = env.element('div');
  broken.setAttribute('data-shortcut-modal', 'settings');
  broken.setAttribute('role', 'dialog');
  broken.setAttribute('aria-modal', 'true');
  broken.baseRect = { left: 200, top: 100, width: 800, height: 600 };
  const nav = env.element('nav');
  nav.appendChild(env.element('div'));
  broken.appendChild(nav);
  env.document.body.appendChild(broken);
  env.flush();

  assert.equal(env.warnings.length, 1, '缺 content 列应恰好一条 warn');
  assert.equal(broken.getAttribute('style'), null, '不得接管半残面板');
  assert.equal(env.document.body.querySelector('[data-dsh-ms-layer]'), null);
});

test('面板出现后接管为绝对定位并挂出 8 向手柄', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  assert.equal(env.warnings.length, 0);
  assert.equal(dom.dialog.style.position, 'absolute');
  assert.deepEqual(rectOf(dom.dialog), { left: 200, top: 100, width: 800, height: 600 });
  assert.equal(dom.dialog.style.maxWidth, 'none');
  const layer = env.document.body.querySelector('[data-dsh-ms-layer]');
  assert.ok(layer, '应存在自管理的交互层');
  for (const dir of ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']) {
    assert.ok(layer.querySelector(`[data-dsh-ms-handle="${dir}"]`), `缺少 ${dir} 手柄`);
  }
});

test('可用区顶部留白跟随 --dsh-frame-overlay-top', () => {
  const env = createEnvironment();
  env.setVar('--dsh-frame-overlay-top', '40px');
  boot(env);
  const dom = mountSettings(env);
  env.flush();
  // 面板初始矩形在钳制范围内，不应被改动；手柄与层按 40px 留白对齐
  assert.equal(dom.dialog.style.left, '200px');
  const handleN = env.document.body.querySelector('[data-dsh-ms-handle="n"]');
  assert.equal(Number.parseFloat(handleN.style.top), 100 - 3);
});

// ---------------------------------------------------------------- 拖动

test('拖拽顶部条带移动面板，结束后落盘', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  let documentPointerDown = 0;
  env.document.addEventListener('pointerdown', () => { documentPointerDown += 1; });

  fire(dom.navTitle, 'pointerdown', 210, 110);
  assert.equal(documentPointerDown, 0, '拖动条的 pointerdown 必须 stopPropagation，避免误触遮罩/焦点逻辑');

  fire(dom.dialog, 'pointermove', 310, 160);
  assert.deepEqual(rectOf(dom.dialog), { left: 300, top: 150, width: 800, height: 600 });

  fire(dom.dialog, 'pointerup', 310, 160);
  const saved = stored(env);
  assert.ok(saved, '松手后应写入 localStorage');
  assert.deepEqual(saved.geometry, { x: 300, y: 150, w: 800, h: 600 });
});

test('命中按钮/输入框等交互元素时不启动拖动', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  fire(dom.closeButton, 'pointerdown', 950, 130);
  fire(dom.dialog, 'pointermove', 1050, 180);
  fire(dom.dialog, 'pointerup', 1050, 180);

  assert.deepEqual(rectOf(dom.dialog), { left: 200, top: 100, width: 800, height: 600 });
  assert.equal(stored(env), null);
});

test('拖动被钳制在视口可用区内', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', -5000, -5000);
  assert.deepEqual(rectOf(dom.dialog), {
    left: AVAIL.left, top: AVAIL.top, width: 800, height: 600,
  });

  fire(dom.dialog, 'pointermove', 5000, 5000);
  fire(dom.dialog, 'pointerup', 5000, 5000);
  const rect = rectOf(dom.dialog);
  assert.equal(rect.left + rect.width, AVAIL.right);
  assert.equal(rect.top + rect.height, AVAIL.bottom);
});

// ---------------------------------------------------------------- 缩放

const RESIZE_CASES = [
  { dir: 'e', dx: 50, dy: 0, expect: { left: 200, top: 100, width: 850, height: 600 } },
  { dir: 'w', dx: 50, dy: 0, expect: { left: 250, top: 100, width: 750, height: 600 } },
  { dir: 's', dx: 0, dy: 30, expect: { left: 200, top: 100, width: 800, height: 630 } },
  { dir: 'n', dx: 0, dy: 30, expect: { left: 200, top: 130, width: 800, height: 570 } },
  { dir: 'se', dx: 50, dy: 30, expect: { left: 200, top: 100, width: 850, height: 630 } },
  { dir: 'nw', dx: 50, dy: 30, expect: { left: 250, top: 130, width: 750, height: 570 } },
  { dir: 'ne', dx: 50, dy: 30, expect: { left: 200, top: 130, width: 850, height: 570 } },
  { dir: 'sw', dx: 50, dy: 30, expect: { left: 250, top: 100, width: 750, height: 630 } },
];

for (const item of RESIZE_CASES) {
  test(`8 向缩放：${item.dir}`, () => {
    const env = createEnvironment();
    boot(env);
    const dom = mountSettings(env);
    env.flush();

    const handle = env.document.body.querySelector(`[data-dsh-ms-handle="${item.dir}"]`);
    fire(handle, 'pointerdown', 0, 0);
    fire(handle, 'pointermove', item.dx, item.dy);
    assert.deepEqual(rectOf(dom.dialog), item.expect);
    fire(handle, 'pointerup', item.dx, item.dy);
    assert.ok(stored(env), '缩放结束后应落盘');
  });
}

test('缩放不小于最小尺寸 480x360', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  const handle = env.document.body.querySelector('[data-dsh-ms-handle="se"]');
  fire(handle, 'pointerdown', 0, 0);
  fire(handle, 'pointermove', -5000, -5000);
  const rect = rectOf(dom.dialog);
  assert.equal(rect.width, 480);
  assert.equal(rect.height, 360);
  assert.equal(rect.left, 200);
  assert.equal(rect.top, 100);
});

test('缩放不越过视口可用区边界', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  const handle = env.document.body.querySelector('[data-dsh-ms-handle="se"]');
  fire(handle, 'pointerdown', 0, 0);
  fire(handle, 'pointermove', 5000, 5000);
  const rect = rectOf(dom.dialog);
  assert.equal(rect.left + rect.width, AVAIL.right);
  assert.equal(rect.top + rect.height, AVAIL.bottom);
});

// ---------------------------------------------------------------- 最大化

test('双击顶部条带最大化到可用区，再次双击还原', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  fire(dom.navTitle, 'dblclick', 210, 110);
  assert.deepEqual(rectOf(dom.dialog), {
    left: AVAIL.left, top: AVAIL.top, width: AVAIL.width, height: AVAIL.height,
  });

  // 最大化后标题栏移到视口顶部，第二次双击落在新的条带上
  const maxRect = rectOf(dom.dialog);
  fire(dom.navTitle, 'dblclick', maxRect.left + 40, maxRect.top + 20);
  assert.deepEqual(rectOf(dom.dialog), { left: 200, top: 100, width: 800, height: 600 });
});

test('双击 header 内容列空白处同样最大化；命中按钮则否', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  fire(dom.closeButton, 'dblclick', 950, 130);
  assert.deepEqual(rectOf(dom.dialog), { left: 200, top: 100, width: 800, height: 600 });

  const header = dom.header;
  fire(header, 'dblclick', 600, 130);
  assert.equal(rectOf(dom.dialog).width, AVAIL.width);
});

// ---------------------------------------------------------------- 持久化

test('关闭再打开沿用上次几何，刷新（重新挂载）后依然生效', () => {
  const env = createEnvironment();
  boot(env);
  let dom = mountSettings(env);
  env.flush();

  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', 310, 160);
  fire(dom.dialog, 'pointerup', 310, 160);
  assert.deepEqual(stored(env).geometry, { x: 300, y: 150, w: 800, h: 600 });

  // 关闭弹窗：面板随 overlay 一起被卸载
  dom.overlay.remove();
  env.flush();
  assert.equal(env.document.body.querySelector('[data-dsh-ms-layer]'), null, '关闭后应回收交互层');

  // 重新打开：新节点、上游默认居中矩形，但插件应恢复上次几何
  dom = mountSettings(env);
  env.flush();
  assert.deepEqual(rectOf(dom.dialog), { left: 300, top: 150, width: 800, height: 600 });
});

test('保存的几何在更小视口下按可用区钳制', () => {
  const env = createEnvironment();
  env.window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
    v: 1, geometry: { x: 900, y: 700, w: 900, h: 700 }, restore: null,
  }));
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  const rect = rectOf(dom.dialog);
  assert.ok(rect.left >= AVAIL.left && rect.left + rect.width <= AVAIL.right);
  assert.ok(rect.top >= AVAIL.top && rect.top + rect.height <= AVAIL.bottom);
});

// ---------------------------------------------------------------- resize 自适应

test('窗口 resize 后自动钳制，标题栏与手柄仍在视口内', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', 900, 700);
  fire(dom.dialog, 'pointerup', 900, 700);

  env.window.innerWidth = 600;
  env.window.innerHeight = 400;
  env.window.dispatchEvent({ type: 'resize' });
  env.flushTimers();

  const rect = rectOf(dom.dialog);
  const right = 600 - VIEW.margin;
  const bottom = 400 - VIEW.margin;
  assert.ok(rect.left >= VIEW.margin && rect.top >= VIEW.margin);
  assert.ok(rect.left + rect.width <= right, '右边缘应留在可用区内');
  assert.ok(rect.top + rect.height <= bottom, '下边缘应留在可用区内');
  const saved = stored(env);
  assert.equal(saved.geometry.x, rect.left);
});

// ---------------------------------------------------------------- header 按钮

test('settings.action 同时注册最大化/还原与重置按钮，顺序相邻', () => {
  const env = createEnvironment();
  const { registered } = boot(env);
  assert.equal(registered.length, 2, '应向 settings.action 注册两个条目');
  const maximize = registered.find((entry) => entry.options.id === 'movable-settings-maximize');
  const reset = registered.find((entry) => entry.options.id === 'movable-settings-reset');
  assert.ok(maximize, '缺少最大化按钮条目');
  assert.ok(reset, '缺少重置按钮条目');
  for (const entry of [maximize, reset]) {
    assert.equal(entry.options.name, 'settings.action');
    assert.equal(entry.options.locale, 'dsh-movable-settings');
  }
  assert.equal(maximize.options.order, 19);
  assert.equal(reset.options.order, 20);
});

test('最大化按钮：点击切换状态，文案/图标/aria 与订阅保持同步', () => {
  const env = createEnvironment();
  const { registered } = boot(env);
  const entry = registered.find((item) => item.options.id === 'movable-settings-maximize');
  const runtime = env.react.createRuntime();
  const tree = () => runtime.render(entry.component, { t: (key) => key });
  const dom = mountSettings(env);
  env.flush();

  let button = tree();
  assert.equal(button.type, 'button');
  assert.equal(button.props['data-dsh-ms-slot-maximize'], '');
  assert.equal(button.props.title, 'action.maximize', 'title 必须点明「也可双击标题栏」对应的语义键');
  assert.equal(button.props['aria-label'], 'action.maximize');
  assert.equal(button.props['aria-pressed'], 'false');
  assert.equal(button.props.children[1].props.children, 'action.maximize.short');
  assert.equal(button.props.children[0].type, 'svg', '图标必须是内联 SVG');

  button.props.onClick({ stopPropagation() {} });
  assert.deepEqual(rectOf(dom.dialog), {
    left: AVAIL.left, top: AVAIL.top, width: AVAIL.width, height: AVAIL.height,
  });

  button = tree();
  assert.equal(button.props.title, 'action.restore');
  assert.equal(button.props['aria-pressed'], 'true');
  assert.equal(button.props.children[1].props.children, 'action.restore.short');

  button.props.onClick({ stopPropagation() {} });
  button = tree();
  assert.equal(button.props.title, 'action.maximize');
  assert.equal(button.props['aria-pressed'], 'false');
  assert.deepEqual(rectOf(dom.dialog), { left: 200, top: 100, width: 800, height: 600 });
  runtime.unmount();
});

test('双击/重置/解绑等所有路径都会同步按钮状态（不允许状态漂移）', () => {
  const env = createEnvironment();
  const { registered } = boot(env);
  const maximizeEntry = registered.find((item) => item.options.id === 'movable-settings-maximize');
  const resetEntry = registered.find((item) => item.options.id === 'movable-settings-reset');
  const maximizeRuntime = env.react.createRuntime();
  const resetRuntime = env.react.createRuntime();
  const maximizeTree = () => maximizeRuntime.render(maximizeEntry.component, { t: (key) => key });
  const dom = mountSettings(env);
  env.flush();

  assert.equal(maximizeTree().props['aria-pressed'], 'false');

  dblclickStrip(dom);
  assert.equal(maximizeTree().props['aria-pressed'], 'true', '双击最大化后按钮必须显示还原');

  dblclickStrip(dom);
  assert.equal(maximizeTree().props['aria-pressed'], 'false', '双击还原后按钮必须显示最大化');

  dblclickStrip(dom);
  assert.equal(maximizeTree().props['aria-pressed'], 'true');
  resetRuntime.render(resetEntry.component, { t: (key) => key }).props.onClick({ stopPropagation() {} });
  assert.equal(maximizeTree().props['aria-pressed'], 'false', '重置后按钮必须回到最大化语义');

  dblclickStrip(dom);
  assert.equal(maximizeTree().props['aria-pressed'], 'true');
  dom.overlay.remove();
  env.flush();
  assert.equal(maximizeTree().props['aria-pressed'], 'false', '弹窗卸载解绑后不得残留最大化状态');

  maximizeRuntime.unmount();
  resetRuntime.unmount();
  assert.equal(env.errors.length, 0);
});

test('拖动提示只落在条带容器，随最大化状态切换，被抹掉后由 scan 恢复', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  const navTitleHost = dom.nav.firstElementChild;
  const headerHost = dom.content.firstElementChild;
  assert.equal(navTitleHost, dom.navTitle, '条带容器应是 nav 的第一个子元素');
  assert.equal(headerHost, dom.header, '条带容器应是 content 的第一个子元素');

  assert.equal(dom.dialog.getAttribute('title'), null, '不得把提示设在整块 panel 上');
  assert.equal(navTitleHost.getAttribute('title'), '拖动移动 · 双击最大化');
  assert.equal(headerHost.getAttribute('title'), '拖动移动 · 双击最大化');
  assert.equal(dom.dialog.style.cursor === '' || dom.dialog.style.cursor === undefined, true, '未悬停时不得常驻 move 指针');

  dblclickStrip(dom);
  assert.equal(navTitleHost.getAttribute('title'), '拖动移动 · 双击还原');
  assert.equal(headerHost.getAttribute('title'), '拖动移动 · 双击还原');
  assert.equal(dom.dialog.getAttribute('title'), null);

  dblclickStrip(dom);
  assert.equal(navTitleHost.getAttribute('title'), '拖动移动 · 双击最大化');
  assert.equal(headerHost.getAttribute('title'), '拖动移动 · 双击最大化');

  navTitleHost.removeAttribute('title');
  env.flush();
  assert.equal(navTitleHost.getAttribute('title'), '拖动移动 · 双击最大化', 'scan 必须检测-恢复提示');
});

test('非条带区域与上游控件不得出现拖动提示（阻断 title 继承）', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  const tip = '拖动移动 · 双击最大化';
  // 内容列 options 滚动区与 nav 列表区不在条带容器内：整条祖先链都没有 title
  assert.equal(nearestTitle(dom.options, dom.dialog), null, 'options 区不得出现拖动提示');
  assert.equal(nearestTitle(dom.optionInput, dom.dialog), null);
  assert.equal(nearestTitle(dom.optionLabel, dom.dialog), null);
  assert.equal(nearestTitle(dom.navList, dom.dialog), null, 'nav 列表区不得出现拖动提示');
  assert.equal(nearestTitle(dom.navCell, dom.dialog), null);

  // header 内的上游控件：自身被阻断成空 title，最近 title 不是拖动提示
  assert.equal(dom.closeButton.getAttribute('title'), '', '交互后代应被写成空 title 阻断继承');
  assert.equal(nearestTitle(dom.closeButton, dom.dialog), '');
  assert.equal(nearestTitle(dom.upstreamButton, dom.dialog), '');
  assert.equal(nearestTitle(dom.slotHost, dom.dialog), '');
  assert.notEqual(nearestTitle(dom.upstreamButton, dom.dialog), tip, '上游按钮不得显示拖动提示');

  // 条带容器本身仍然有提示
  assert.equal(dom.header.getAttribute('title'), tip);
});

test('settings.action 槽位注册了重置按钮，点击后回到上游默认居中布局并清空持久化', () => {
  const env = createEnvironment();
  const { registered } = boot(env);
  const resetEntry = registered.find((entry) => entry.options.id === 'movable-settings-reset');
  assert.ok(resetEntry, '缺少重置按钮条目');
  assert.equal(resetEntry.options.name, 'settings.action');
  assert.equal(resetEntry.options.locale, 'dsh-movable-settings');

  const dom = mountSettings(env);
  env.flush();

  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', 310, 160);
  fire(dom.dialog, 'pointerup', 310, 160);
  assert.deepEqual(stored(env).geometry, { x: 300, y: 150, w: 800, h: 600 });

  const tree = resetEntry.component({ t: (key) => key });
  assert.equal(tree.type, 'button');
  tree.props.onClick({ stopPropagation() {} });

  assert.equal(env.window.localStorage.getItem(STORAGE_KEY), null, '重置应清空持久化');
  assert.deepEqual(rectOf(dom.dialog), { left: 200, top: 100, width: 800, height: 600 }, '应回到上游默认居中几何');
});

test('槽位不可用时退化为浮层重置按钮', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  const fallback = env.document.body.querySelector('[data-dsh-ms-fallback]');
  assert.ok(fallback, '应存在浮层重置按钮');
  assert.equal(fallback.hidden, false, '槽位内容缺失时应显示浮层入口');

  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', 310, 160);
  fire(dom.dialog, 'pointerup', 310, 160);
  assert.ok(stored(env));

  fallback.dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(env.window.localStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(rectOf(dom.dialog), { left: 200, top: 100, width: 800, height: 600 });
});

test('槽位内容渲染出来后浮层入口自动隐藏', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();
  assert.equal(env.document.body.querySelector('[data-dsh-ms-fallback]').hidden, false);

  const slotButton = env.element('button');
  slotButton.setAttribute('data-dsh-ms-slot-reset', '');
  dom.slotHost.appendChild(slotButton);
  env.flush();
  assert.equal(env.document.body.querySelector('[data-dsh-ms-fallback]').hidden, true);
});

// ---------------------------------------------------------------- 既有交互与清理

test('不接管键盘、不干扰遮罩与关闭按钮的既有行为', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  assert.equal(env.document.listeners.has('keydown'), false, '不应注册任何键盘监听（Esc 归 useModalLayer）');

  let closed = 0;
  dom.closeButton.addEventListener('click', () => { closed += 1; });
  fire(dom.closeButton, 'click', 950, 130);
  assert.equal(closed, 1, '未拖动时关闭按钮的点击必须原样通过');

  let masked = 0;
  dom.mask.addEventListener('click', () => { masked += 1; });
  dom.mask.dispatchEvent({ type: 'click' });
  assert.equal(masked, 1, '遮罩点击不受影响');
});

test('拖动结束：与抬手点重合的残留 click 仍被吞掉', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  let clicks = 0;
  dom.slotHost.addEventListener('click', () => { clicks += 1; });

  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', 310, 160);
  fire(dom.dialog, 'pointerup', 310, 160);

  fire(dom.slotHost, 'click', 311, 161);
  assert.equal(clicks, 0, '与抬手点重合（≤4px）的残留 click 应被吞掉');

  // 时间窗过期后，即便是同点也不再吞
  env.flushTimers();
  fire(dom.slotHost, 'click', 311, 161);
  assert.equal(clicks, 1, '窗口期过后点击恢复正常');
});

test('拖动/缩放结束后在新位置的第一次点击必须一次生效', () => {
  const env = createEnvironment();
  boot(env);
  const dom = mountSettings(env);
  env.flush();

  let closed = 0;
  dom.closeButton.addEventListener('click', () => { closed += 1; });
  let typed = 0;
  dom.optionInput.addEventListener('click', () => { typed += 1; });

  // 拖动面板：抬手点在 (310,160)
  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', 310, 160);
  fire(dom.dialog, 'pointerup', 310, 160);

  // 拖完立刻点关闭按钮（远离抬手点）→ 必须一次生效
  fire(dom.closeButton, 'click', 950, 130);
  assert.equal(closed, 1, '拖动后紧接着点关闭按钮必须一次生效');

  // 拖完立刻点输入框 → 必须一次生效
  fire(dom.optionInput, 'click', 420, 500);
  assert.equal(typed, 1, '拖动后紧接着点输入框必须一次生效');

  // 缩放（8 向手柄）结束后同理
  const handle = env.document.body.querySelector('[data-dsh-ms-handle="se"]');
  fire(handle, 'pointerdown', 0, 0);
  fire(handle, 'pointermove', 40, 40);
  fire(handle, 'pointerup', 40, 40);
  fire(dom.closeButton, 'click', 950, 200);
  assert.equal(closed, 2, '缩放后紧接着点关闭按钮必须一次生效');
});

test('被阻断的节点脱离文档再复用后，dispose 仍不残留 title（R3）', () => {
  const env = createEnvironment();
  const { effects } = boot(env);
  const dom = mountSettings(env);
  env.flush();

  // 先被阻断成 title=""，随后离开文档并触发一次 scan，再被复用：
  // 复用后它自身已带 title，ensureTooltip 会跳过，因此只能靠「实际改写集合」保证还原。
  assert.equal(dom.closeButton.getAttribute('title'), '');
  dom.closeButton.remove();
  env.flush();
  dom.header.appendChild(dom.closeButton);
  env.flush();
  assert.equal(dom.closeButton.getAttribute('title'), '', '复用后仍是阻断状态');

  effects[0]();

  assert.equal(dom.closeButton.hasAttribute('title'), false, '复用节点不得残留插件写入的 title');
});

test('条带容器离线重排回原位置后，dispose 仍按原值还原', () => {
  const env = createEnvironment();
  const { effects } = boot(env);
  const dom = mountSettings(env);
  env.flush();

  assert.equal(dom.navTitle.getAttribute('title'), '拖动移动 · 双击最大化');
  dom.navList.remove();
  dom.navTitle.remove();
  dom.nav.appendChild(dom.navTitle);
  dom.nav.appendChild(dom.navList);
  env.flush();
  assert.equal(dom.navTitle.getAttribute('title'), '拖动移动 · 双击最大化');

  effects[0]();
  assert.equal(dom.navTitle.hasAttribute('title'), false);
});

test('dispose 后恢复原状：移除样式、层与监听', () => {
  const env = createEnvironment();
  const { effects } = boot(env);
  const dom = mountSettings(env);
  env.flush();

  fire(dom.navTitle, 'pointerdown', 210, 110);
  fire(dom.dialog, 'pointermove', 310, 160);
  fire(dom.dialog, 'pointerup', 310, 160);
  assert.equal(env.document.documentElement.classList.size, 0, '交互结束后不应残留 html class');

  effects[0]();

  assert.equal(env.document.head.querySelector('style[data-plugin="dsh-movable-settings"]'), null);
  assert.equal(env.document.body.querySelector('[data-dsh-ms-layer]'), null);
  assert.equal(dom.dialog.getAttribute('style'), null, '面板内联覆盖应被回收');
  assert.equal(dom.header.getAttribute('title'), null, '条带容器的提示应被回收');
  assert.equal(dom.navTitle.getAttribute('title'), null, '条带容器的提示应被回收');
  assert.equal(dom.closeButton.getAttribute('title'), null, '被阻断的 title="" 应被移除');
  assert.equal(env.document.documentElement.classList.size, 0);

  // observer 已断开：后续 DOM 变化不再触发任何动作
  mountSettings(env);
  env.flush();
  assert.equal(env.document.body.querySelector('[data-dsh-ms-layer]'), null);
});
