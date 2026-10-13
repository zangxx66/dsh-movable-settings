# dsh-movable-settings

把 DSH Web GUI 内置的「设置」弹窗从固定居中、不可调整，变成**可拖动、可八向缩放、可双击最大化，并记住上次位置与尺寸**的浮层。

## 行为

| 交互 | 位置 | 结果 |
| --- | --- | --- |
| 拖动 | 面板顶部约 54px 的非交互条带（导航标题区 + 内容列 header 空白处） | 指针变 `move`，面板实时跟随；命中按钮 / 输入框 / 链接 / slot 内容时不启动拖动；悬停条带显示原生 `title` 气泡「拖动移动 · 双击最大化 / 还原」 |
| 缩放 | 四边 + 四角共 8 个手柄（悬停时淡淡显色） | 最小 480×360，且任意时刻不超出视口可用区 |
| 双击 | 同拖动条带 | 最大化到视口可用区；再次双击还原到最大化前的几何 |
| 最大化 / 还原 | 内容列 header 的「最大化」按钮（`settings.action` 槽位，重置按钮左侧，图标 + 文案随状态切换） | 与双击完全等价，是最大化能力的可见入口（`title` / `aria-label` 点明「也可双击标题栏」） |
| 重置 | 内容列 header 的「重置位置」按钮 | 清空记忆并回到上游默认的居中布局 |

按钮顺序：`最大化`(order 19) → `重置位置`(order 20) → 上游的 `打开配置文件` / `Close`。

拖动 / 缩放结束的瞬间，只有**与抬手点重合**（≤4px、120ms 内）的残留 click 会被吞掉；
抬手后在新位置的第一次点击一律一次生效 —— 关闭按钮、输入框、下拉都照常触发与聚焦。

`title` 气泡只挂在两个条带容器上：`nav` 的第一个子元素（标题容器）与 `content` 的第一个子元素（54px header）。
容器内没有自带 `title` 的交互后代会被写成 `title=""` 阻断继承，因此内容列 `options` 滚动区、`nav` 列表区与 header 里的上游控件都不会弹出这个提示。

视口可用区 = 视口四边各留 `max(24px, --dsh-frame-overlay-top, --dsh-frame-chrome-top)`，与上游默认面板高度
`min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))))` 的留白语义一致。

窗口 resize 后会重新钳制，标题栏、关闭按钮与缩放手柄始终留在视口内可触达。

## 设计约束

- **纯客户端 DOM 增强**：不遮蔽、不重写任何 shipped slot，不接管键盘事件与 `useModalLayer` 的焦点陷阱；只把面板改成相对 overlay 的绝对定位，并附加一个自管理的交互层。
- **锚点只用语义属性**：`div[data-shortcut-modal="settings"][role="dialog"][aria-modal="true"]`。构建期 hash 类名（`VOzbGW_*`）会随上游构建变化，一律不依赖。
- **交互层不进 React 树**：8 个手柄与兜底按钮挂在插件自建的 `body` 子节点（`position: fixed`）上，绝不 `appendChild` 进 React 管理的子列表。
- **静默降级**：锚点不匹配，或锚点命中但内部缺少 `nav` / `content` 两列及其标题 / header 容器时，插件都不改任何原样式、不留多余节点、不抛异常，仅输出一条 `console.warn`。
- **主题一致**：颜色 / 圆角 / 边框只用 `--dsw-alias-*`、`--dsw-radius-*` 主题 token。
- **提示不误报**：拖动气泡只出现在能力真正生效的条带容器上，并对容器内无自带 `title` 的交互后代写入 `title=""` 阻断继承；`unbind` / `dispose` 时按原值逐一还原所有被改过的节点（实际改写集合 `titleTouched` + 原值表 `titleBackups`），节点中途脱离文档再复用也不会残留 `title=""`。
- **完全可回收**：`dispose` 时移除注入的 `<style>`、observer、所有监听器、交互层节点与内联覆盖样式。

## 文件

```
package.json          清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml      Loader 补丁，插入 id=movable-settings 的插件行
index.js              Host 半区（空壳：能力全在 Client 半区）
client.js             核心实现（DOM 增强 + settings.action 最大化/重置按钮）
locale/zh.json        插件显示名与描述（中文）
locale/en.json        插件显示名与描述（英文）
icon.svg              插件图标
LICENSE               MIT 许可证
test/dom-stub.mjs     最小 DOM 桩
test/enhancer.test.mjs 行为测试（node:test）
```

## 安装

```
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

## 本地验证

```bash
node --check client.js
node --check index.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
node --test test/enhancer.test.mjs
node --test test/manifest.test.mjs
```

## 真机手测步骤（浏览器侧无法自动化的部分）

1. `Ctrl/Cmd+Alt+,` 或侧栏齿轮打开设置弹窗。
2. 拖动导航标题栏：面板应跟随指针移动，指针为 `move`，松手后停在新位置。
3. 把指针移到面板边缘/角落：出现细手柄，拖动可改宽高；尝试拖到极小，宽高不应小于 480×360。
4. 双击标题栏：最大化；再双击：还原。悬停标题栏时应出现原生气泡「拖动移动 · 双击最大化 / 还原」；悬停设置内容区或 header 里的「打开配置文件」按钮时**不应**出现该气泡。
5. 点内容列 header 的「最大化」按钮：与双击等价；最大化后按钮应变成「还原」并带另一枚图标，点它回到原几何。
6. 关闭再打开设置弹窗，以及整页刷新：位置与尺寸应保持。
7. 缩放浏览器窗口到很小：面板应被钳制，标题栏 / 关闭按钮 / 手柄都还能点到。
8. 点内容列 header 的「重置位置」：回到居中默认布局，且「最大化」按钮同步回到未最大化语义；重新打开也应回到默认。
9. 回归检查：关闭按钮、点击遮罩、Esc 仍能关闭；面板内滚动、Tab 焦点陷阱、设置项切换正常；拖动后不会误触面板内的按钮。
10. 在「设置 → 插件」里禁用本插件：弹窗应立刻恢复原始行为，页面无残留样式、手柄与 `title`。

## 已知边界

- 上游若连 `data-shortcut-modal="settings"` 属性一并改名，插件无从识别该弹窗，会完全静默（不改动、不告警）；这属于不可探测的结构变更。
- 缩放手柄覆盖在面板外缘 6px 上，Windows 经典滚动条（约 15px 宽）的最外侧几个像素会被手柄占用，其余滚动条区域仍可点击。
- 本仓库的自动化测试跑在最小 DOM 桩上，只覆盖插件自身的逻辑；浏览器渲染与视觉一致性仍需真机核验。

## 许可证

[MIT](LICENSE) © 2026 ricardo
