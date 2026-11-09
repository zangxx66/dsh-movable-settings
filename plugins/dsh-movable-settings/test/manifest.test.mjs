/**
 * 清单与静态约束校验：不需要浏览器，验证插件包能被 Loader / Client 模块表接受，
 * 且实现没有踩到本项目明令禁止的依赖（hash 类名、上游 Client 包、越权写入等）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('package.json'));
const clientSource = read('client.js');
const patchText = read('cordis.patch.yml');

test('package.json 是合法的 Client bundle 清单', () => {
  assert.equal(manifest.name, 'dsh-movable-settings');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, 'index.js');
  assert.equal(manifest.license, 'MIT');
  assert.match(manifest.repository.url, /github\.com\/zangxx66\/dsh-movable-settings/);
  assert.equal(manifest.repository.directory, 'plugins/dsh-movable-settings');
  assert.match(manifest.homepage, /dsh-movable-settings/);
  assert.match(manifest.bugs.url, /\/issues$/);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, 'keywords 应非空');
  assert.ok(manifest.engines && typeof manifest.engines.node === 'string', 'engines.node 应声明');
  assert.equal(typeof manifest.scripts.test, 'string');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(typeof manifest.dsh.client.immediately, 'boolean');
  // dsh-client-modules 校验：inject / external 若出现必须是字符串数组
  for (const key of ['inject', 'external']) {
    if (manifest.dsh.client[key] !== undefined) {
      assert.ok(Array.isArray(manifest.dsh.client[key]) && manifest.dsh.client[key].every((v) => typeof v === 'string'));
    }
  }
});

test('exports 与 files 指向的文件都存在', () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const file = target.startsWith('./') ? target.slice(2) : target;
    if (file.includes('*')) continue;
    assert.ok(existsSync(path.join(root, file)), `exports["${subpath}"] → ${file} 不存在`);
  }
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue;
    assert.ok(existsSync(path.join(root, entry)), `files 中的 ${entry} 不存在`);
  }
});

test('cordis.patch.yml 插入的行与包名一致', () => {
  assert.match(patchText, /^- insert:\n {4}- id: movable-settings\n {6}name: 'dsh-movable-settings'\n$/m);
});

test('client.js 以包名注册工厂（模块表 id 必须等于包名）', () => {
  const match = clientSource.match(/__ModuleLoader__\.load\(\{\s*id: '([^']+)'/);
  assert.ok(match, 'client.js 必须通过 window.__ModuleLoader__.load 注册');
  assert.equal(match[1], manifest.name);
});

test('锚点只用语义属性，不依赖构建期 hash 类名', () => {
  assert.match(clientSource, /const PANEL_SELECTOR = 'div\[data-shortcut-modal="settings"\]\[role="dialog"\]\[aria-modal="true"\]';/);
  // 上游 settings-general / settings-shell 的 CSS Modules hash 前缀（随构建变化，绝不可引用）
  assert.doesNotMatch(clientSource, /\b(?:VOzbGW|UQsH|_WvWnq|yIbyla|Pt1bsG|me01iq|DOUpOa)_/);
  assert.doesNotMatch(clientSource, /querySelector\([^)]*class=/, '不得用类名选择器定位上游节点');
  assert.doesNotMatch(clientSource, /getElementsByClassName/);
});

test('不加载任何上游 Harness Client 包', () => {
  const requests = [...clientSource.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(requests, ["'react'"], '工厂只应请求 react（浏览器模块表的 baseline）');
  assert.doesNotMatch(clientSource, /dsh-client-ui-primitives/);
  assert.doesNotMatch(clientSource, /@deepseek-ai\//);
});

test('dispose 覆盖样式、observer、监听器与自建节点', () => {
  for (const token of ['removeEventListener', 'observer.disconnect()', 'styleEl.remove()', 'layer.remove()', 'restoreOriginalStyle()']) {
    assert.ok(clientSource.includes(token), `dispose 路径缺少 ${token}`);
  }
});

test('只使用主题 token 表达颜色 / 圆角', () => {
  const css = clientSource.match(/const CSS_TEXT = \[([\s\S]*?)\]\.join\('\\n'\);/);
  assert.ok(css, '应存在注入的样式表');
  const colors = [...css[1].matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(colors, [], '样式表里不得出现字面色值');
  assert.match(css[1], /var\(--dsw-alias-|var\(--dsw-radius-/);
});

const LOCALES = ['zh', 'en', 'de', 'es', 'fr', 'ja', 'pt', 'ru'];

test('locale 资源含非空 meta.title / meta.description 且覆盖 8 种内置语言', () => {
  for (const locale of LOCALES) {
    const dict = JSON.parse(read(`locale/${locale}.json`));
    assert.ok(dict.meta && typeof dict.meta.title === 'string' && dict.meta.title.length > 0, `locale/${locale}.json 缺少 meta.title`);
    assert.ok(dict.meta && typeof dict.meta.description === 'string' && dict.meta.description.length > 0, `locale/${locale}.json 缺少 meta.description`);
  }
});

test('locale 资源不含零宽字符 / BOM（U+200B / U+FEFF）', () => {
  for (const locale of LOCALES) {
    const raw = read(`locale/${locale}.json`);
    assert.doesNotMatch(raw, /[\u200B\uFEFF]/, `locale/${locale}.json 含零宽字符`);
  }
  assert.doesNotMatch(clientSource, /[\u200B\uFEFF]/, 'client.js 含零宽字符');
});

test('client.js 内置 8 种语言字典键集完全一致且覆盖可见入口', () => {
  const blocks = {};
  for (const locale of LOCALES) {
    const match = clientSource.match(new RegExp(`const ${locale} = \\{([\\s\\S]*?)\\n {4}\\};`));
    assert.ok(match, `应能定位 client.js 内的 ${locale} 字典`);
    blocks[locale] = match[1];
  }
  const entriesOf = (block) => [...block.matchAll(/'([^']+)': '([^']*)'/g)];
  const zhKeys = entriesOf(blocks.zh).map((match) => match[1]).sort();
  for (const locale of LOCALES) {
    const entries = entriesOf(blocks[locale]);
    assert.deepEqual(entries.map((match) => match[1]).sort(), zhKeys, `${locale} 字典键集必须与 zh 一致`);
    assert.equal(entries.length, zhKeys.length, `${locale} 字典含重复或多余条目`);
    for (const [key, value] of entries) {
      assert.ok(value.length > 0, `${locale} 字典 ${key} 的值不得为空`);
    }
  }
  for (const key of [
    'action.maximize', 'action.maximize.short', 'action.restore', 'action.restore.short',
    'action.reset', 'action.reset.short', 'tooltip.dragMaximize', 'tooltip.dragRestore',
  ]) {
    assert.ok(zhKeys.includes(key), `字典缺少 ${key}`);
  }
  const registerCall = clientSource.match(/scope\.locale\.register\(NS, \{([^}]*)\}\)/);
  assert.ok(registerCall, '应存在 scope.locale.register(NS, {...}) 一次性注册');
  const registered = registerCall[1].split(',').map((part) => part.trim().split(':')[0].trim()).filter(Boolean).sort();
  assert.deepEqual(registered, [...LOCALES].sort(), 'register 必须一次性注册全部 8 种语言');
});

test('icon.svg 是有效 SVG 且不超体积上限', () => {
  const icon = read('icon.svg');
  assert.match(icon.trim(), /^<svg[\s>]/);
  assert.ok(icon.includes('</svg>'));
  assert.ok(statSync(path.join(root, 'icon.svg')).size < 256 * 1024);
});
