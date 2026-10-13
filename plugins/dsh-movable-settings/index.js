/**
 * Host half of the movable-settings bundle.
 *
 * 设置弹窗的拖动 / 缩放 / 最大化完全由 Client 半区（./client）在浏览器里以纯 DOM 增强实现：
 * 它不注册任何 Host 服务、工具、事件或配置，因此这里只需要一个空的 apply，
 * 让 Loader 有一行可激活的插件条目。
 *
 * @returns {void}
 */
export function apply() {}
