# dsh-dialog-improve

DSH Web GUI 插件开发工作区。**仓库根即工作区**，插件本体位于子目录。

A workspace for developing DSH Web GUI plugins. **The repository root is the workspace**; the plugin itself lives in a subdirectory.

## 包含什么 / What's inside

| 路径 Path | 说明 Description |
| --- | --- |
| [`plugins/dsh-movable-settings/`](plugins/dsh-movable-settings/) | 插件本体：让 DSH 设置弹窗可拖动 / 可缩放 / 可最大化（已在 npm 发布） |
| `.dsh-graph/` | 本工作区的目标看板数据，由 dsh-graph 插件管理，**不入 git** |

## 插件：dsh-movable-settings

把 DSH Web GUI 内置的「设置」弹窗从固定居中、不可调整，变成**可拖动、可八向缩放、可双击最大化**，并记住上次位置与尺寸的浮层。

Turns the built-in DSH **Settings** dialog into a movable, resizable, maximizable floating window that remembers its geometry.

- 详细说明 / Full docs： [`plugins/dsh-movable-settings/README.md`](plugins/dsh-movable-settings/README.md)
- npm： [dsh-movable-settings](https://www.npmjs.com/package/dsh-movable-settings)
- 安装 / Install（在 DSH 会话里 / inside a DSH session）：

  ```
  plugin_manager action=install_bundle target=dsh-movable-settings
  ```

  也可以直接对会话里的 Agent 说「帮我安装 dsh-movable-settings 插件」。
  Or just ask the agent in a session to install it. Then refresh the page.

## 开发 / Development

```bash
cd plugins/dsh-movable-settings
npm run check   # 语法检查 / syntax check
npm test        # 49 项断言 / 49 assertions (node:test)
```

改完 client 半区代码后需**刷新页面**（除非同时跑着 `pnpm run dev:web` 的 HMR）。
After editing the client half, **refresh the page** (unless the `pnpm run dev:web` HMR watcher is running).

## 许可证 / License

[MIT](plugins/dsh-movable-settings/LICENSE) © 2026 ricardo
