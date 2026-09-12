//! 背包 tooltip（计划 §8.2：R4 第一批拆分）。
//!
//! 只负责**显示**：提示窗 DOM、皮肤贴图、悬停/焦点状态、隐藏定时器与
//! 视口内定位。不拥有物品数据来源——正文文本与贴图创建经构造参数注入，
//! 因此本模块不导入 names.ts / manifest 数据，也不发起任何协议消息。

import type { InventoryItem } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';

/** One frame of the source-authored tooltip skin, if the manifest carries it. */
type TooltipSkin = {
  top?: AssetFrame;
  middle?: AssetFrame;
  bottom?: AssetFrame;
};

export interface TooltipControllerOptions {
  /** Creates a styled `<img>` for a manifest frame (shared with the host view). */
  assetImage: (frame: AssetFrame, className: string) => HTMLImageElement;
  /** Renders the tooltip body text; the caller owns the item details lookup. */
  detailsFor: (item: InventoryItem, comparison?: InventoryItem | null) => string;
}

/**
 * Owns the `#inventory-tooltip` element and its display lifecycle.  The host
 * view keeps ownership of *which* item an anchor points at; it drives this
 * controller from its own listeners, so no extra document listeners are
 * introduced (the controller only listens on its own element).
 */
export class TooltipController {
  readonly element: HTMLDivElement;
  private readonly content?: HTMLDivElement;
  private readonly detailsFor: TooltipControllerOptions['detailsFor'];
  private anchor?: HTMLElement;
  private anchorHovered = false;
  private anchorFocused = false;
  private selfHovered = false;
  private hideTimer?: number;

  constructor(root: HTMLElement, skin: TooltipSkin, options: TooltipControllerOptions) {
    this.detailsFor = options.detailsFor;
    const tooltip = document.createElement('div');
    tooltip.className = 'inventory-tooltip';
    tooltip.id = 'inventory-tooltip';
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.tabIndex = 0;
    const { top, middle, bottom } = skin;
    if (top && middle && bottom) {
      tooltip.dataset.skin = 'source';
      tooltip.style.setProperty('--inventory-tooltip-width', `${top.width}px`);
      tooltip.style.setProperty('--inventory-tooltip-top-height', `${top.height}px`);
      tooltip.style.setProperty('--inventory-tooltip-bottom-height', `${bottom.height}px`);
      const topImage = options.assetImage(top, 'inventory-tooltip-top');
      const middleLayer = document.createElement('div');
      middleLayer.className = 'inventory-tooltip-middle';
      middleLayer.style.backgroundImage = `url("${middle.url}")`;
      const bottomImage = options.assetImage(bottom, 'inventory-tooltip-bottom');
      tooltip.append(topImage, middleLayer, bottomImage);
    }
    const content = document.createElement('div');
    content.className = 'inventory-tooltip-content';
    tooltip.append(content);
    this.content = content;

    tooltip.addEventListener('pointerenter', () => {
      this.selfHovered = true;
      if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    });
    tooltip.addEventListener('pointerleave', () => {
      this.selfHovered = false;
      this.scheduleHide();
    });
    tooltip.addEventListener('focus', () => { this.selfHovered = true; });
    tooltip.addEventListener('blur', () => {
      this.selfHovered = false;
      this.scheduleHide();
    });

    root.append(tooltip);
    this.element = tooltip;
  }

  /** Slot/equipment anchors report hover so a crossing gap keeps the tip open. */
  noteAnchorEnter() {
    this.anchorHovered = true;
  }

  noteAnchorLeave() {
    this.anchorHovered = false;
    this.scheduleHide();
  }

  noteAnchorFocus() {
    this.anchorFocused = true;
  }

  noteAnchorBlur() {
    this.anchorFocused = false;
    this.scheduleHide();
  }

  /** Shows the tooltip for an item at an anchor element. */
  showForItem(item: InventoryItem, anchor: HTMLElement, comparison?: InventoryItem | null) {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.anchor = anchor;
    const text = this.detailsFor(item, comparison);
    if (this.content) this.content.textContent = text;
    else this.element.textContent = text;
    this.element.hidden = false;
    this.element.dataset.itemId = item.itemId;
    this.position(anchor);
  }

  /**
   * Re-evaluates the current anchor after a snapshot.  `keepVisible` decides
   * from the host's authoritative state whether the anchor still points at a
   * showable item; returning false hides the tip.
   */
  refresh(keepVisible: (anchor: HTMLElement) => boolean) {
    const anchor = this.anchor;
    if (!anchor || this.element.hidden) return;
    if (keepVisible(anchor)) return;
    this.hide();
  }

  /** The element an open tooltip is anchored to (for host-side re-layouts). */
  currentAnchor(): HTMLElement | undefined {
    return this.anchor;
  }

  /** Keeps the open tip pinned next to its anchor (host resize / scroll). */
  reposition() {
    if (this.anchor && !this.element.hidden) this.position(this.anchor);
  }

  /** Positions the tip beside the anchor, clamped into the viewport. */
  position(anchor: HTMLElement) {
    if (this.element.hidden) return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = Math.max(1, window.innerWidth);
    const width = Math.min(this.element.offsetWidth || 220, Math.max(1, viewportWidth - 12));
    const viewportHeight = Math.max(1, window.innerHeight);
    const height = Math.min(this.element.offsetHeight || 60, Math.max(1, viewportHeight - 12));
    const gap = 6;
    let left = rect.right + gap;
    if (left + width > viewportWidth - 6) left = rect.left - width - gap;
    const leftGutter = Math.min(6, Math.max(0, (viewportWidth - width) / 2));
    left = Math.min(viewportWidth - width - leftGutter, Math.max(leftGutter, left));
    let top = rect.top;
    if (top + height > viewportHeight - 6) top = viewportHeight - height - 6;
    const topGutter = Math.min(6, Math.max(0, (viewportHeight - height) / 2));
    top = Math.min(viewportHeight - height - topGutter, Math.max(topGutter, top));
    this.element.style.left = Math.round(left) + 'px';
    this.element.style.top = Math.round(top) + 'px';
  }

  /** Delays hiding briefly so the pointer can travel onto the tip itself. */
  scheduleHide() {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = undefined;
      if (!this.anchorHovered && !this.anchorFocused && !this.selfHovered) this.hide();
    }, 160);
  }

  hide() {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.element.hidden = true;
    this.anchor = undefined;
    this.anchorHovered = false;
    this.anchorFocused = false;
    this.selfHovered = false;
    delete this.element.dataset.itemId;
  }

  destroy() {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }
}

/** Reads the source-authored tooltip skin frames from the inventory UI manifest. */
export function tooltipSkin(ui: Manifest['inventoryUi']): TooltipSkin {
  return {
    top: ui?.['tooltip:top'],
    middle: ui?.['tooltip:mid'],
    bottom: ui?.['tooltip:btm'],
  };
}
