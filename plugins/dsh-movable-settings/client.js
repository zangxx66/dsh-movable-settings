/**
 * dsh-movable-settings —— 让内置「设置」弹窗可拖动 / 八向缩放 / 双击最大化 / 记忆几何。
 *
 * 设计要点（与目标判据一一对应）：
 * - 纯客户端 DOM 增强：不遮蔽、不重写任何 shipped slot，不接管键盘与焦点陷阱；
 *   只把面板的定位方式改为相对 overlay 的绝对定位并附加自己的交互层。
 * - 锚点只用语义属性 `[data-shortcut-modal="settings"][role="dialog"][aria-modal="true"]`，
 *   绝不依赖上游构建期生成的 hash 类名（它们随上游构建变化）。
 * - 上游结构不匹配时静默降级：不改原样式、不留多余节点、不抛异常，只留一条 console.warn。
 * - 所有注入的 <style>、监听器、observer、临时节点与内联样式都在 dispose 时回收。
 */
window.__ModuleLoader__.load({
  id: 'dsh-movable-settings',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 插件命名空间：locale 字典键与可选 slot 条目共用。 */
    const NS = 'dsh-movable-settings';
    /** 几何持久化键（带插件命名空间与版本，便于将来迁移）。 */
    const STORAGE_KEY = 'dsh-movable-settings:v1';
    /** 面板最小尺寸（可用区比它还小时按可用区收缩）。 */
    const MIN_W = 480;
    const MIN_H = 360;
    /** 视口四周留白下限：与上游 `max(24px, --dsh-frame-overlay-top)` 语义一致。 */
    const FALLBACK_MARGIN = 24;
    /** 可拖动条带高度：nav 标题区（22 + 24）与 content header（54）的交集。 */
    const DRAG_STRIP = 54;
    /** 位移超过该阈值才算拖动/缩放，避免吞掉单击与双击。 */
    const DRAG_THRESHOLD = 3;
    const SAVE_DEBOUNCE_MS = 200;
    /** 拖动结束后「同一位置残留 click」的判定半径（px）：超过它的一律是用户的新点击，必须放行。 */
    const CLICK_SLOP = 4;
    /** 残留 click 的兜底时间窗（ms）。 */
    const SWALLOW_WINDOW_MS = 120;

    const PANEL_SELECTOR = 'div[data-shortcut-modal="settings"][role="dialog"][aria-modal="true"]';
    const ANCHOR_SELECTOR = '[data-shortcut-modal="settings"]';
    /** 命中即不启动拖动：按钮 / 表单控件 / 链接 / slot 内容。 */
    const INTERACTIVE_SELECTOR = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'label',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[contenteditable="true"]',
      '[data-slot]',
      '[data-dsh-ms-slot-reset]',
    ].join(',');

    const EDGE_DIRECTIONS = ['n', 's', 'w', 'e'];
    const CORNER_DIRECTIONS = ['nw', 'ne', 'sw', 'se'];
    const DIRECTIONS = EDGE_DIRECTIONS.concat(CORNER_DIRECTIONS);
    const HANDLE_SIZE = 6;
    const CORNER_SIZE = 14;

    const CSS_TEXT = [
      '.dsh-ms-layer{position:fixed;inset:0;pointer-events:none;z-index:2147482000}',
      '.dsh-ms-handle{position:absolute;pointer-events:auto;touch-action:none;background:transparent;border-radius:3px;transition:background-color .12s ease}',
      '.dsh-ms-handle:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent)}',
      '.dsh-ms-handle[data-dsh-ms-handle="n"],.dsh-ms-handle[data-dsh-ms-handle="s"]{cursor:ns-resize}',
      '.dsh-ms-handle[data-dsh-ms-handle="w"],.dsh-ms-handle[data-dsh-ms-handle="e"]{cursor:ew-resize}',
      '.dsh-ms-handle[data-dsh-ms-handle="nw"],.dsh-ms-handle[data-dsh-ms-handle="se"]{cursor:nwse-resize}',
      '.dsh-ms-handle[data-dsh-ms-handle="ne"],.dsh-ms-handle[data-dsh-ms-handle="sw"]{cursor:nesw-resize}',
      'html.dsh-ms-drag,html.dsh-ms-drag *{cursor:grabbing !important}',
      'html.dsh-ms-drag,html.dsh-ms-drag *{user-select:none}',
      'html.dsh-ms-resizing,html.dsh-ms-resizing *{cursor:var(--dsh-ms-cursor,default) !important}',
      'html.dsh-ms-resizing,html.dsh-ms-resizing *{user-select:none}',
      '.dsh-ms-action{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;font-family:inherit;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}',
      '.dsh-ms-action svg{display:block;flex:none}',
      '.dsh-ms-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ms-fallback{box-sizing:border-box;position:absolute;pointer-events:auto;display:inline-flex;align-items:center;height:28px;padding:0 10px;font-family:inherit;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 86%,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap;opacity:.78}',
      '.dsh-ms-fallback:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}',
    ].join('\n');

    const zh = {
      'action.reset': '重置设置弹窗的位置与尺寸',
      'action.reset.short': '重置位置',
      'action.maximize': '最大化设置弹窗（也可双击标题栏）',
      'action.maximize.short': '最大化',
      'action.restore': '还原设置弹窗（也可双击标题栏）',
      'action.restore.short': '还原',
      'tooltip.dragMaximize': '拖动移动 · 双击最大化',
      'tooltip.dragRestore': '拖动移动 · 双击还原',
    };
    const en = {
      'action.reset': 'Reset settings dialog position and size',
      'action.reset.short': 'Reset position',
      'action.maximize': 'Maximize the settings dialog (or double-click its title bar)',
      'action.maximize.short': 'Maximize',
      'action.restore': 'Restore the settings dialog (or double-click its title bar)',
      'action.restore.short': 'Restore',
      'tooltip.dragMaximize': 'Drag to move · double-click to maximize',
      'tooltip.dragRestore': 'Drag to move · double-click to restore',
    };
    const de = {
      'action.reset': 'Position und Größe des Einstellungsdialogs zurücksetzen',
      'action.reset.short': 'Position zurücksetzen',
      'action.maximize': 'Einstellungsdialog maximieren (auch per Doppelklick auf die Titelleiste)',
      'action.maximize.short': 'Maximieren',
      'action.restore': 'Einstellungsdialog wiederherstellen (auch per Doppelklick auf die Titelleiste)',
      'action.restore.short': 'Wiederherstellen',
      'tooltip.dragMaximize': 'Ziehen zum Verschieben · Doppelklick zum Maximieren',
      'tooltip.dragRestore': 'Ziehen zum Verschieben · Doppelklick zum Wiederherstellen',
    };
    const es = {
      'action.reset': 'Restablecer la posición y el tamaño del diálogo de ajustes',
      'action.reset.short': 'Restablecer posición',
      'action.maximize': 'Maximizar el diálogo de ajustes (también con doble clic en la barra de título)',
      'action.maximize.short': 'Maximizar',
      'action.restore': 'Restaurar el diálogo de ajustes (también con doble clic en la barra de título)',
      'action.restore.short': 'Restaurar',
      'tooltip.dragMaximize': 'Arrastrar para mover · doble clic para maximizar',
      'tooltip.dragRestore': 'Arrastrar para mover · doble clic para restaurar',
    };
    const fr = {
      'action.reset': 'Réinitialiser la position et la taille de la boîte de dialogue des paramètres',
      'action.reset.short': 'Réinitialiser la position',
      'action.maximize': 'Agrandir la boîte de dialogue des paramètres (ou double-clic sur la barre de titre)',
      'action.maximize.short': 'Agrandir',
      'action.restore': 'Restaurer la boîte de dialogue des paramètres (ou double-clic sur la barre de titre)',
      'action.restore.short': 'Restaurer',
      'tooltip.dragMaximize': 'Glisser pour déplacer · double-clic pour agrandir',
      'tooltip.dragRestore': 'Glisser pour déplacer · double-clic pour restaurer',
    };
    const ja = {
      'action.reset': '設定ダイアログの位置とサイズをリセット',
      'action.reset.short': '位置をリセット',
      'action.maximize': '設定ダイアログを最大化（タイトルバーのダブルクリックでも可）',
      'action.maximize.short': '最大化',
      'action.restore': '設定ダイアログを元に戻す（タイトルバーのダブルクリックでも可）',
      'action.restore.short': '元に戻す',
      'tooltip.dragMaximize': 'ドラッグで移動 · ダブルクリックで最大化',
      'tooltip.dragRestore': 'ドラッグで移動 · ダブルクリックで元に戻す',
    };
    const pt = {
      'action.reset': 'Redefinir a posição e o tamanho da caixa de diálogo de configurações',
      'action.reset.short': 'Redefinir posição',
      'action.maximize': 'Maximizar a caixa de diálogo de configurações (ou clique duplo na barra de título)',
      'action.maximize.short': 'Maximizar',
      'action.restore': 'Restaurar a caixa de diálogo de configurações (ou clique duplo na barra de título)',
      'action.restore.short': 'Restaurar',
      'tooltip.dragMaximize': 'Arraste para mover · clique duplo para maximizar',
      'tooltip.dragRestore': 'Arraste para mover · clique duplo para restaurar',
    };
    const ru = {
      'action.reset': 'Сбросить положение и размер диалога настроек',
      'action.reset.short': 'Сбросить положение',
      'action.maximize': 'Развернуть диалог настроек (или дважды щёлкните по заголовку)',
      'action.maximize.short': 'Развернуть',
      'action.restore': 'Восстановить диалог настроек (или дважды щёлкните по заголовку)',
      'action.restore.short': 'Восстановить',
      'tooltip.dragMaximize': 'Перетащите, чтобы переместить · двойной щелчок — развернуть',
      'tooltip.dragRestore': 'Перетащите, чтобы переместить · двойной щелчок — восстановить',
    };

    /** 兜底翻译：locale 服务未就绪时仍给出可读文案。 */
    function fallbackTranslate(key) {
      return Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
    }

    /** 包一层 locale 服务返回的 t：取不到或回落到 key 时用内置中文兜底。 */
    function wrapTranslator(t) {
      return function (key) {
        try {
          const value = t(key);
          if (typeof value === 'string' && value !== '' && value !== key) return value;
        } catch (error) {
          /* 落到内置文案 */
        }
        return fallbackTranslate(key);
      };
    }

    // ------------------------------------------------------------------ 纯几何

    function clamp(value, lo, hi) {
      const low = Math.min(lo, hi);
      const high = Math.max(lo, hi);
      return Math.min(Math.max(value, low), high);
    }

    function readVarPx(el, name, fallback) {
      try {
        const raw = window.getComputedStyle(el).getPropertyValue(name);
        const value = Number.parseFloat(raw);
        return Number.isFinite(value) ? value : fallback;
      } catch (error) {
        return fallback;
      }
    }

    /**
     * 视口可用区：四边各留 max(24px, --dsh-frame-overlay-top, --dsh-frame-chrome-top)。
     * 上游默认面板高度正是 `100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))`，
     * 因此四边同留白在语义上与上游一致。
     */
    function availableArea(el) {
      const margin = Math.max(
        FALLBACK_MARGIN,
        readVarPx(el, '--dsh-frame-overlay-top', FALLBACK_MARGIN),
        readVarPx(el, '--dsh-frame-chrome-top', 0),
      );
      const width = Math.max(0, window.innerWidth - margin * 2);
      const height = Math.max(0, window.innerHeight - margin * 2);
      return { left: margin, top: margin, right: margin + width, bottom: margin + height, width, height };
    }

    function fitGeometry(geo, avail) {
      const minW = Math.min(MIN_W, avail.width);
      const minH = Math.min(MIN_H, avail.height);
      const w = clamp(geo.w, minW, Math.max(minW, avail.width));
      const h = clamp(geo.h, minH, Math.max(minH, avail.height));
      const x = clamp(geo.x, avail.left, Math.max(avail.left, avail.right - w));
      const y = clamp(geo.y, avail.top, Math.max(avail.top, avail.bottom - h));
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }

    function isInteractive(node, root) {
      let el = node && typeof node.matches === 'function' ? node : null;
      while (el && el !== root) {
        try {
          if (el.matches(INTERACTIVE_SELECTOR)) return true;
        } catch (error) {
          return false;
        }
        el = el.parentElement;
      }
      return false;
    }

    // ------------------------------------------------------------------ 控制器

    function createEnhancer() {
      let active = false;
      let styleEl = null;
      let observer = null;
      let frame = 0;
      let warned = false;
      let bound = null;
      let originalStyle = null;
      let layer = null;
      let fallbackButton = null;
      let geometry = null;
      let restore = null;
      let interaction = null;
      let swallowClick = false;
      /** 触发吞点的 pointerup 终点坐标；click 离它太远就说明是用户的新点击。 */
      let swallowPoint = null;
      let swallowTimer = 0;
      let saveTimer = 0;
      const handles = new Map();
      /** 最大化状态的订阅者（settings.action 里的最大化/还原按钮）。 */
      const subscribers = new Set();
      /** 被本插件改过 title 的节点 → 原值（null 表示原本没有该属性）。 */
      const titleBackups = new Map();
      /** 本次实际被改写 title 的节点；还原时遍历它，保证不留残留。 */
      const titleTouched = new Set();
      /** 提示与按钮文案的翻译函数；locale 服务就绪后由外部替换。 */
      let translator = fallbackTranslate;

      // -------- 最大化状态与订阅

      function isMaximized() {
        return restore !== null;
      }

      function notifyState() {
        const maximized = isMaximized();
        subscribers.forEach(function (subscriber) {
          try {
            subscriber(maximized);
          } catch (error) {
            /* 单个订阅者出错不影响其它订阅者与插件本身 */
          }
        });
        ensureTooltip();
        updateLayer();
      }

      /** 只注册；当前值由订阅者用 isMaximized() 自行取初值。 */
      function subscribe(subscriber) {
        if (typeof subscriber !== 'function') return function () {};
        subscribers.add(subscriber);
        return function () { subscribers.delete(subscriber); };
      }

      function dragTipText() {
        return translator(isMaximized() ? 'tooltip.dragRestore' : 'tooltip.dragMaximize');
      }

      /**
       * 拖动条带的可发现性提示：原生 title 气泡。
       *
       * title 会被浏览器逐元素继承，因此**只**把它挂在条带容器上：
       *   - `nav` 的第一个子元素（settings.header 标题容器）
       *   - `content` 的第一个子元素（54px 的 header 容器，含 actions 与 Close）
       * 这两个容器内部的交互后代若自身没有 title，会被写成 `title=""` 阻断继承，
       * 避免气泡落到上游控件上；nav 的列表区与 content 的 options 滚动区不在容器内，
       * 天然不会出现提示。scan() 每次都会重做一遍（React 可能重建节点）。
       */
      /**
       * 条带结构：panel 的两个直接子元素（nav / content）各自的第一个元素子元素。
       * 结构异常（缺列或缺标题/header 容器）时返回 null，调用方走静默降级。
       */
      function stripStructureOf(panel) {
        if (!panel) return null;
        const nav = panel.firstElementChild;
        const content = nav ? nav.nextElementSibling : null;
        const titleHost = nav ? nav.firstElementChild : null;
        const headerHost = content ? content.firstElementChild : null;
        if (!titleHost || !headerHost) return null;
        return { titleHost: titleHost, headerHost: headerHost };
      }

      function stripContainers() {
        const structure = stripStructureOf(bound);
        if (!structure) return [];
        return [structure.titleHost, structure.headerHost];
      }

      function rememberTitle(el) {
        if (!el) return;
        if (!titleBackups.has(el)) titleBackups.set(el, el.getAttribute('title'));
        titleTouched.add(el);
      }

      function ensureTooltip() {
        if (!bound) return;
        const text = dragTipText();
        stripContainers().forEach(function (container) {
          rememberTitle(container);
          if (container.getAttribute('title') !== text) container.setAttribute('title', text);
          let descendants = [];
          try {
            descendants = container.querySelectorAll(INTERACTIVE_SELECTOR);
          } catch (error) {
            descendants = [];
          }
          Array.prototype.forEach.call(descendants, function (node) {
            if (node.hasAttribute('title')) return;
            rememberTitle(node);
            node.setAttribute('title', '');
          });
        });
      }

      /**
       * 还原所有被本插件改写过的 title。
       * 遍历「实际改写集合」而不是备份表：即使某节点的原值记录不再可用（例如它中途离开过文档），
       * 也一定会被 removeAttribute，不会残留我们写下的 `title=""` 或提示文案。
       */
      function restoreTitles() {
        titleTouched.forEach(function (el) {
          try {
            const previous = titleBackups.has(el) ? titleBackups.get(el) : null;
            if (previous === null || previous === undefined) el.removeAttribute('title');
            else el.setAttribute('title', previous);
          } catch (error) {
            /* 节点可能已随弹窗卸载 */
          }
        });
        titleBackups.clear();
        titleTouched.clear();
      }

      // -------- 持久化

      function sanitize(value) {
        if (!value || typeof value !== 'object') return null;
        const nums = ['x', 'y', 'w', 'h'].map(function (key) { return Number(value[key]); });
        if (!nums.every(function (n) { return Number.isFinite(n); })) return null;
        if (nums[2] <= 0 || nums[3] <= 0) return null;
        return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
      }

      function readStore() {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object') return null;
          const stored = sanitize(parsed.geometry);
          if (!stored) return null;
          return { geometry: stored, restore: sanitize(parsed.restore) };
        } catch (error) {
          return null;
        }
      }

      function writeStore() {
        if (!geometry) return;
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
            v: 1,
            geometry: geometry,
            restore: restore,
          }));
        } catch (error) {
          /* 存储不可用时静默降级：本次会话内的拖动仍然有效。 */
        }
      }

      function clearStore() {
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch (error) {
          /* 同上。 */
        }
      }

      function scheduleSave() {
        if (saveTimer) return;
        saveTimer = window.setTimeout(function () {
          saveTimer = 0;
          writeStore();
        }, SAVE_DEBOUNCE_MS);
      }

      // -------- 几何落盘

      function paint() {
        if (!bound || !geometry) return;
        const style = bound.style;
        style.position = 'absolute';
        style.left = geometry.x + 'px';
        style.top = geometry.y + 'px';
        style.width = geometry.w + 'px';
        style.height = geometry.h + 'px';
        style.margin = '0';
        style.maxWidth = 'none';
        updateLayer();
      }

      function restoreOriginalStyle() {
        if (!bound) return;
        if (originalStyle === null || originalStyle === undefined) bound.removeAttribute('style');
        else bound.setAttribute('style', originalStyle);
      }

      /** 从当前实际布局接管几何（首次打开、重置之后都走这里）。 */
      function adoptCurrentRect() {
        if (!bound) return false;
        const rect = bound.getBoundingClientRect();
        const avail = availableArea(bound);
        geometry = fitGeometry({
          x: rect.left,
          y: rect.top,
          w: rect.width || 800,
          h: rect.height || 600,
        }, avail);
        return true;
      }

      // -------- 手柄层（自管理节点，绝不进入 React 管理的子列表）

      function setHandleRect(dir, left, top, width, height) {
        const handle = handles.get(dir);
        if (!handle) return;
        handle.style.left = Math.round(left) + 'px';
        handle.style.top = Math.round(top) + 'px';
        handle.style.width = Math.round(Math.max(1, width)) + 'px';
        handle.style.height = Math.round(Math.max(1, height)) + 'px';
      }

      function updateLayer() {
        if (!layer) return;
        if (!geometry) {
          layer.style.display = 'none';
          return;
        }
        layer.style.display = '';
        const x = geometry.x;
        const y = geometry.y;
        const w = geometry.w;
        const h = geometry.h;
        const pad = 8;
        const half = HANDLE_SIZE / 2;
        const over = 4;
        setHandleRect('n', x + pad, y - half, w - pad * 2, HANDLE_SIZE);
        setHandleRect('s', x + pad, y + h - half, w - pad * 2, HANDLE_SIZE);
        setHandleRect('w', x - half, y + pad, HANDLE_SIZE, h - pad * 2);
        setHandleRect('e', x + w - half, y + pad, HANDLE_SIZE, h - pad * 2);
        setHandleRect('nw', x - over, y - over, CORNER_SIZE, CORNER_SIZE);
        setHandleRect('ne', x + w - CORNER_SIZE + over, y - over, CORNER_SIZE, CORNER_SIZE);
        setHandleRect('sw', x - over, y + h - CORNER_SIZE + over, CORNER_SIZE, CORNER_SIZE);
        setHandleRect('se', x + w - CORNER_SIZE + over, y + h - CORNER_SIZE + over, CORNER_SIZE, CORNER_SIZE);
        if (fallbackButton && !fallbackButton.hidden) {
          const nav = bound && bound.firstElementChild;
          const navWidth = nav ? nav.getBoundingClientRect().width : 188;
          fallbackButton.style.left = Math.round(x + navWidth + 10) + 'px';
          fallbackButton.style.top = Math.round(y + 13) + 'px';
        }
      }

      function buildLayer() {
        if (layer) return;
        layer = document.createElement('div');
        layer.className = 'dsh-ms-layer';
        layer.setAttribute('data-dsh-ms-layer', '');
        DIRECTIONS.forEach(function (dir) {
          const handle = document.createElement('div');
          handle.className = 'dsh-ms-handle';
          handle.setAttribute('data-dsh-ms-handle', dir);
          handle.setAttribute('aria-hidden', 'true');
          handle.addEventListener('pointerdown', function (event) { onHandlePointerDown(event, dir); });
          handle.addEventListener('pointermove', onPointerMove);
          handle.addEventListener('pointerup', onPointerUp);
          handle.addEventListener('pointercancel', onPointerUp);
          handles.set(dir, handle);
          layer.appendChild(handle);
        });
        fallbackButton = document.createElement('button');
        fallbackButton.type = 'button';
        fallbackButton.className = 'dsh-ms-fallback';
        fallbackButton.setAttribute('data-dsh-ms-fallback', '');
        fallbackButton.hidden = true;
        fallbackButton.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
        fallbackButton.addEventListener('click', function (event) {
          event.stopPropagation();
          reset();
        });
        layer.appendChild(fallbackButton);
        document.body.appendChild(layer);
      }

      /** 正规扩展点不可用时才显示自管理的浮层重置按钮。 */
      function updateFallbackButton() {
        if (!fallbackButton || !bound) return;
        const inSlot = bound.querySelector('[data-dsh-ms-slot-reset]');
        const shouldShow = inSlot === null;
        if (fallbackButton.hidden !== !shouldShow) fallbackButton.hidden = !shouldShow;
        updateLayer();
      }

      // -------- 指针交互

      function setInteractionCursor(dir) {
        const html = document.documentElement;
        if (dir === null) {
          html.classList.add('dsh-ms-drag');
          return;
        }
        const cursors = {
          n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize',
          nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
        };
        html.classList.add('dsh-ms-resizing');
        html.style.setProperty('--dsh-ms-cursor', cursors[dir] || 'default');
      }

      function clearInteractionCursor() {
        const html = document.documentElement;
        html.classList.remove('dsh-ms-drag');
        html.classList.remove('dsh-ms-resizing');
        html.style.removeProperty('--dsh-ms-cursor');
      }

      function onPanelPointerDown(event) {
        if (event.button !== 0 || !bound || interaction) return;
        const rect = bound.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        if (offsetX < 0 || offsetX > rect.width || offsetY < 0 || offsetY > DRAG_STRIP) return;
        if (isInteractive(event.target, bound)) return;
        if (!geometry && !adoptCurrentRect()) return;
        event.stopPropagation();
        interaction = {
          kind: 'move', dir: null, pointerId: event.pointerId,
          startX: event.clientX, startY: event.clientY,
          origin: { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h },
          moved: false,
        };
        try { bound.setPointerCapture(event.pointerId); } catch (error) { /* 忽略：capture 只是优化 */ }
        setInteractionCursor(null);
      }

      function onHandlePointerDown(event, dir) {
        if (event.button !== 0 || !bound || interaction) return;
        event.preventDefault();
        event.stopPropagation();
        if (!geometry && !adoptCurrentRect()) return;
        paint();
        interaction = {
          kind: 'resize', dir: dir, pointerId: event.pointerId,
          startX: event.clientX, startY: event.clientY,
          origin: { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h },
          moved: false,
        };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* 同上 */ }
        setInteractionCursor(dir);
      }

      function onPointerMove(event) {
        if (!interaction || event.pointerId !== interaction.pointerId) return;
        const dx = event.clientX - interaction.startX;
        const dy = event.clientY - interaction.startY;
        if (!interaction.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        interaction.moved = true;
        if (event.cancelable !== false && typeof event.preventDefault === 'function') event.preventDefault();
        if (!bound || !geometry) return;
        const avail = availableArea(bound);
        const origin = interaction.origin;
        if (interaction.kind === 'move') {
          geometry = fitGeometry({ x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h }, avail);
        } else {
          const dir = interaction.dir;
          let left = origin.x;
          let top = origin.y;
          let right = origin.x + origin.w;
          let bottom = origin.y + origin.h;
          const minW = Math.min(MIN_W, avail.width);
          const minH = Math.min(MIN_H, avail.height);
          if (dir.indexOf('e') >= 0) right = clamp(origin.x + origin.w + dx, left + minW, avail.right);
          if (dir.indexOf('w') >= 0) left = clamp(origin.x + dx, avail.left, Math.max(avail.left, right - minW));
          if (dir.indexOf('s') >= 0) bottom = clamp(origin.y + origin.h + dy, top + minH, avail.bottom);
          if (dir.indexOf('n') >= 0) top = clamp(origin.y + dy, avail.top, Math.max(avail.top, bottom - minH));
          geometry = { x: left, y: top, w: right - left, h: bottom - top };
        }
        if (restore) {
          restore = null;
          notifyState();
        }
        paint();
      }

      function onPointerUp(event) {
        if (!interaction || event.pointerId !== interaction.pointerId) return;
        const moved = interaction.moved;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
        interaction = null;
        clearInteractionCursor();
        if (!moved) return;
        swallowClick = true;
        swallowPoint = { x: event.clientX, y: event.clientY };
        if (swallowTimer) window.clearTimeout(swallowTimer);
        swallowTimer = window.setTimeout(function () {
          swallowClick = false;
          swallowPoint = null;
          swallowTimer = 0;
        }, SWALLOW_WINDOW_MS);
        writeStore();
      }

      function onPanelPointerMove(event) {
        if (interaction) {
          onPointerMove(event);
          return;
        }
        if (!bound || !geometry) return;
        const rect = bound.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const onStrip = offsetX >= 0 && offsetX <= rect.width && offsetY >= 0 && offsetY <= DRAG_STRIP;
        const next = onStrip && !isInteractive(event.target, bound) ? 'move' : '';
        if (bound.style.cursor !== next) bound.style.cursor = next;
      }

      function onPanelPointerLeave() {
        if (interaction || !bound) return;
        if (bound.style.cursor !== '') bound.style.cursor = '';
      }

      /**
       * 只吞「拖动结束瞬间、与抬手点几乎重合」的那一次残留 click（浏览器在 pointerup
       * 之后补发、可能误触条带下方控件的噪声）。用户抬手后在新位置的正常点击距离较远，
       * 一律放行 —— 判据「拖动/缩放结束后紧接着的第一次点击必须一次生效」。
       */
      function isResidualClick(event) {
        if (!swallowPoint) return false;
        const x = Number(event.clientX);
        const y = Number(event.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return Math.abs(x - swallowPoint.x) <= CLICK_SLOP && Math.abs(y - swallowPoint.y) <= CLICK_SLOP;
      }

      function onPanelClickCapture(event) {
        if (!swallowClick) return;
        swallowClick = false;
        if (!isResidualClick(event)) {
          swallowPoint = null;
          return;
        }
        swallowPoint = null;
        event.stopPropagation();
        if (typeof event.preventDefault === 'function') event.preventDefault();
      }

      function toggleMaximize() {
        if (!bound || !geometry) return;
        const avail = availableArea(bound);
        if (restore) {
          geometry = fitGeometry(restore, avail);
          restore = null;
        } else {
          restore = { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h };
          geometry = {
            x: avail.left,
            y: avail.top,
            w: Math.max(1, avail.width),
            h: Math.max(1, avail.height),
          };
        }
        paint();
        writeStore();
        notifyState();
      }

      function onPanelDblClick(event) {
        if (event.button !== 0 || !bound || !geometry) return;
        const rect = bound.getBoundingClientRect();
        const offsetY = event.clientY - rect.top;
        if (offsetY < 0 || offsetY > DRAG_STRIP) return;
        if (isInteractive(event.target, bound)) return;
        event.stopPropagation();
        toggleMaximize();
      }

      function onWindowResize() {
        if (!bound || !geometry) return;
        const avail = availableArea(bound);
        if (restore) {
          restore = fitGeometry(restore, avail);
          geometry = {
            x: avail.left,
            y: avail.top,
            w: Math.max(1, avail.width),
            h: Math.max(1, avail.height),
          };
        } else {
          geometry = fitGeometry(geometry, avail);
        }
        paint();
        scheduleSave();
      }

      // -------- 绑定 / 清理

      function bind(panel) {
        // 结构异常（缺 nav/content 或缺少标题/header 容器）时不接管：不改样式、不留节点。
        if (!stripStructureOf(panel)) return;
        bound = panel;
        originalStyle = panel.getAttribute('style');
        const stored = readStore();
        const avail = availableArea(panel);
        if (stored) {
          if (stored.restore) {
            restore = fitGeometry(stored.restore, avail);
            geometry = {
              x: avail.left,
              y: avail.top,
              w: Math.max(1, avail.width),
              h: Math.max(1, avail.height),
            };
          } else {
            restore = null;
            geometry = fitGeometry(stored.geometry, avail);
          }
        } else {
          restore = null;
          adoptCurrentRect();
        }
        buildLayer();
        paint();
        panel.addEventListener('pointerdown', onPanelPointerDown);
        panel.addEventListener('pointermove', onPanelPointerMove);
        panel.addEventListener('pointerup', onPointerUp);
        panel.addEventListener('pointercancel', onPointerUp);
        panel.addEventListener('pointerleave', onPanelPointerLeave);
        panel.addEventListener('dblclick', onPanelDblClick);
        panel.addEventListener('click', onPanelClickCapture, true);
        updateFallbackButton();
        ensureTooltip();
        notifyState();
      }

      function unbind() {
        const panel = bound;
        if (panel) {
          panel.removeEventListener('pointerdown', onPanelPointerDown);
          panel.removeEventListener('pointermove', onPanelPointerMove);
          panel.removeEventListener('pointerup', onPointerUp);
          panel.removeEventListener('pointercancel', onPointerUp);
          panel.removeEventListener('pointerleave', onPanelPointerLeave);
          panel.removeEventListener('dblclick', onPanelDblClick);
          panel.removeEventListener('click', onPanelClickCapture, true);
          try {
            restoreOriginalStyle();
            restoreTitles();
          } catch (error) { /* 节点可能已随弹窗卸载 */ }
        }
        bound = null;
        originalStyle = null;
        geometry = null;
        restore = null;
        interaction = null;
        if (swallowTimer) {
          window.clearTimeout(swallowTimer);
          swallowTimer = 0;
        }
        swallowClick = false;
        swallowPoint = null;
        clearInteractionCursor();
        if (layer) {
          layer.remove();
          layer = null;
        }
        handles.clear();
        fallbackButton = null;
        notifyState();
      }

      /**
       * 重置为上游默认的居中布局：清空持久化 → 撤掉本插件的内联覆盖 → 以原生
       * 布局算出的矩形重新接管（视觉零跳变，手柄依旧可用）。
       */
      function reset() {
        clearStore();
        restore = null;
        geometry = null;
        if (!bound) {
          notifyState();
          return;
        }
        restoreOriginalStyle();
        adoptCurrentRect();
        paint();
        notifyState();
      }

      // -------- 发现面板

      function schedule() {
        if (!active || frame) return;
        frame = window.requestAnimationFrame(function () {
          frame = 0;
          scan();
        });
      }

      function scan() {
        if (!active) return;
        const panel = document.querySelector(PANEL_SELECTOR);
        // 锚点命中但内部结构异常（缺 nav/content 或缺少标题/header 容器）同样走静默降级。
        const usable = panel && stripStructureOf(panel) ? panel : null;
        if (usable) {
          if (usable !== bound) {
            if (bound) unbind();
            bind(usable);
          } else {
            updateFallbackButton();
            ensureTooltip();
          }
          return;
        }
        if (bound) unbind();
        if (!warned && (panel || document.querySelector(ANCHOR_SELECTOR))) {
          warned = true;
          console.warn(
            '[dsh-movable-settings] 设置弹窗的 DOM 结构与本插件预期不符（期望 ' + PANEL_SELECTOR +
            ' 且含 nav / content 两列各自的标题与 header 容器），已静默降级：本次不改动弹窗的任何样式与行为。',
          );
        }
      }

      return {
        start: function () {
          if (active) return;
          active = true;
          styleEl = document.createElement('style');
          styleEl.setAttribute('data-plugin', 'dsh-movable-settings');
          styleEl.setAttribute('data-plugin-css', 'dsh-movable-settings/movable.css');
          styleEl.textContent = CSS_TEXT;
          document.head.appendChild(styleEl);
          observer = new window.MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true });
          window.addEventListener('resize', onWindowResize);
          schedule();
        },
        dispose: function () {
          if (!active) return;
          active = false;
          if (frame) {
            window.cancelAnimationFrame(frame);
            frame = 0;
          }
          if (observer) {
            observer.disconnect();
            observer = null;
          }
          window.removeEventListener('resize', onWindowResize);
          unbind();
          if (styleEl) {
            styleEl.remove();
            styleEl = null;
          }
          if (saveTimer) {
            window.clearTimeout(saveTimer);
            saveTimer = 0;
          }
        },
        reset: reset,
        /** 当前是否处于最大化状态（对外唯一判据）。 */
        isMaximized: isMaximized,
        /** 最大化 / 还原切换；按钮、双击与内部路径共用同一实现。 */
        toggleMaximize: toggleMaximize,
        /** 订阅最大化状态；返回退订函数。 */
        subscribe: subscribe,
        /** locale 服务就绪后注入翻译函数（未注入时用内置中文兜底）。 */
        setTranslator: function (fn) {
          if (typeof fn !== 'function') return;
          translator = wrapTranslator(fn);
          ensureTooltip();
        },
        /** 仅供测试与诊断：当前是否绑定到面板。 */
        isBound: function () { return bound !== null; },
      };
    }

    // ------------------------------------------------------------------ header 按钮

    /** 内联 SVG 图标：全部用 currentColor 与主题 token，不引入任何上游 Client 包。 */
    function actionIcon(kind) {
      const path = kind === 'maximize'
        ? h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 1.5 })
        : kind === 'restore'
          ? h('g', null,
            h('rect', { x: 3, y: 6.5, width: 6.5, height: 6.5, rx: 1.5 }),
            h('path', { d: 'M6.5 6.5V4.5a1.5 1.5 0 0 1 1.5-1.5h4.5a1.5 1.5 0 0 1 1.5 1.5V9a1.5 1.5 0 0 1-1.5 1.5h-2' }))
          : h('g', null,
            h('path', { d: 'M3.2 7.5a5 5 0 1 1 1.6 3.7' }),
            h('path', { d: 'M3 12.2V8.6h3.6' }));
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, path);
    }

    /**
     * `settings.action`（list slot，位于内容列 header、Close 之前）里的最大化 / 还原按钮。
     * 图标与文案完全由 enhancer 的订阅状态驱动，任何改变最大化状态的路径都会同步。
     */
    function createMaximizeAction(enhancer) {
      return function MaximizeAction(props) {
        const t = props && typeof props.t === 'function' ? props.t : function (key) { return key; };
        const [maximized, setMaximized] = React.useState(function () { return enhancer.isMaximized(); });
        React.useEffect(function () { return enhancer.subscribe(setMaximized); }, []);
        const key = maximized ? 'action.restore' : 'action.maximize';
        const shortKey = maximized ? 'action.restore.short' : 'action.maximize.short';
        const label = t(key);
        return h('button', {
          type: 'button',
          className: 'dsh-ms-action',
          'data-dsh-ms-slot-maximize': '',
          title: label,
          'aria-label': label,
          'aria-pressed': maximized ? 'true' : 'false',
          onClick: function (event) {
            event.stopPropagation();
            enhancer.toggleMaximize();
          },
          onPointerDown: function (event) { event.stopPropagation(); },
        }, actionIcon(maximized ? 'restore' : 'maximize'), h('span', null, t(shortKey)));
      };
    }

    function createResetAction(enhancer) {
      /**
       * `settings.action` 里的重置按钮。走正规扩展点，绝不 appendChild 进 React 管理的子列表。
       */
      return function ResetAction(props) {
        const t = props && typeof props.t === 'function' ? props.t : function (key) { return key; };
        return h('button', {
          type: 'button',
          className: 'dsh-ms-action',
          'data-dsh-ms-slot-reset': '',
          title: t('action.reset'),
          'aria-label': t('action.reset'),
          onClick: function (event) {
            event.stopPropagation();
            enhancer.reset();
          },
          onPointerDown: function (event) { event.stopPropagation(); },
        }, actionIcon('reset'), h('span', null, t('action.reset.short')));
      };
    }

    return {
      apply(ctx) {
        const enhancer = createEnhancer();
        ctx.effect(function () {
          enhancer.start();
          return function () { enhancer.dispose(); };
        }, 'dsh-movable-settings: movable settings panel');

        const MaximizeAction = createMaximizeAction(enhancer);
        const ResetAction = createResetAction(enhancer);
        const registerAction = function (scope) {
          if (!scope || typeof scope.effect !== 'function' || !scope.slots || !scope.locale) return;
          scope.effect(function () {
            return scope.locale.register(NS, { zh, en, de, es, fr, ja, pt, ru });
          }, 'dsh-movable-settings: dictionary');
          if (typeof scope.locale.bind === 'function') enhancer.setTranslator(scope.locale.bind(NS));
          scope.slots.inject('settings.action', function () {
            return scope.slots.register({
              name: 'settings.action',
              id: 'movable-settings-maximize',
              order: 19,
              locale: NS,
            }, MaximizeAction);
          });
          scope.slots.inject('settings.action', function () {
            return scope.slots.register({
              name: 'settings.action',
              id: 'movable-settings-reset',
              order: 20,
              locale: NS,
            }, ResetAction);
          });
        };
        if (typeof ctx.inject === 'function') {
          ctx.inject(['slots', 'locale'], function (scope) {
            try {
              registerAction(scope);
            } catch (error) {
              console.warn('[dsh-movable-settings] header 按钮注册失败，已退化为浮层入口：', error);
            }
          });
        } else {
          try {
            registerAction(ctx);
          } catch (error) {
            console.warn('[dsh-movable-settings] 重置按钮注册失败，已退化为浮层入口：', error);
          }
        }
      },
    };
  },
});
