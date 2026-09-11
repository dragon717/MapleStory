import type { AssetFrame } from '../../assets/manifest';

/**
 * Shared window chrome for the TMS273 panels.
 *
 * Every panel in this client is a hand-built DOM window with source WZ frames
 * behind it.  The inventory window (`features/inventory/view.ts`) was the first
 * one to behave the way the original client does — you can drag it by its title
 * bar, its buttons carry hover/pressed frames, and the window never leaves the
 * play area.  This module lifts exactly that behaviour out so the other panels
 * (minimap, skills, quest, chat, menu) can share one implementation instead of
 * each re-inventing a slightly different drag.
 *
 * The spec these helpers implement is `UI_WINDOW_SYSTEM.md` §2 (R2/R3/R4).
 * Nothing here knows about a specific panel: geometry, open state and frame
 * keys are all supplied by the caller.
 */

export type AssetSet = Record<string, AssetFrame>;

export interface WindowDragOptions {
  /** Draggable strip height, measured down from the window's top edge. */
  titleHeight: number | (() => number);
  /** Dragging only applies while this is true (usually "the window is open"). */
  isOpen: () => boolean;
  /** Called when a drag actually starts; used to raise the window. */
  onActivate?: () => void;
  /**
   * Allow dragging when the pointer lands on a `button`.  Only needed when the
   * whole draggable element *is* a button (the quest tracker); clicking still
   * works because a drag only arms after `activationDistance` pixels.
   */
  allowOnButtons?: boolean;
  /** Pixels the pointer must travel before the gesture counts as a drag.
   *  Defaults to 3 so a click on a title bar never nudges the window. */
  activationDistance?: number;
}

/**
 * Make `window` draggable by its title bar inside `host`.
 *
 * Four gates before a drag may start (spec R2.1): primary button, window open,
 * the pointer is not on a `button`, and the pointer sits inside the title bar.
 * The gesture only arms after `activationDistance` pixels, so a plain click on
 * the title bar (or on the tracker) still reaches its own handler.  The first
 * real movement converts the CSS-centred window into an absolutely positioned
 * one *at its current on-screen spot*, so nothing jumps (R2.2).  Every move is
 * clamped to the host box (R2.3) and pointer capture keeps the drag alive when
 * the cursor outruns the element (R2.4).
 *
 * @returns a disposer that removes every listener it installed (R2.5).
 */
export function installWindowDrag(host: HTMLElement, window: HTMLElement, options: WindowDragOptions): () => void {
  const activationDistance = options.activationDistance ?? 3;
  let pending: { pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number } | undefined;
  let dragging: { pointerId: number; offsetX: number; offsetY: number } | undefined;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !options.isOpen()) return;
    const target = event.target;
    if (!options.allowOnButtons && target instanceof Element && target.closest('button')) return;
    const titleHeight = typeof options.titleHeight === 'function' ? options.titleHeight() : options.titleHeight;
    const rect = window.getBoundingClientRect();
    if (event.clientY - rect.top > titleHeight) return;

    pending = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    window.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (dragging) {
      if (event.pointerId !== dragging.pointerId) return;
      const hostRect = host.getBoundingClientRect();
      const width = window.getBoundingClientRect().width;
      const height = window.getBoundingClientRect().height;
      const left = Math.min(Math.max(0, hostRect.width - width), Math.max(0, event.clientX - hostRect.left - dragging.offsetX));
      const top = Math.min(Math.max(0, hostRect.height - height), Math.max(0, event.clientY - hostRect.top - dragging.offsetY));
      window.style.left = Math.round(left) + 'px';
      window.style.top = Math.round(top) + 'px';
      return;
    }
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (Math.abs(event.clientX - pending.startX) < activationDistance && Math.abs(event.clientY - pending.startY) < activationDistance) return;

    // First real movement: detach from the CSS centring at the current spot.
    if (window.dataset.windowPositioned !== 'true') {
      const hostRect = host.getBoundingClientRect();
      const rect = window.getBoundingClientRect();
      window.style.left = Math.round(rect.left - hostRect.left) + 'px';
      window.style.top = Math.round(rect.top - hostRect.top) + 'px';
      window.style.transform = 'none';
      window.dataset.windowPositioned = 'true';
    }
    dragging = { pointerId: pending.pointerId, offsetX: pending.offsetX, offsetY: pending.offsetY };
    pending = undefined;
    options.onActivate?.();
    event.preventDefault();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (pending && event.pointerId === pending.pointerId) {
      window.releasePointerCapture?.(event.pointerId);
      pending = undefined;
    }
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    window.releasePointerCapture?.(event.pointerId);
    dragging = undefined;
  };

  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  return () => {
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };
}

/**
 * Raise `window` above its siblings sharing the same host.
 *
 * The counter lives on the host and the value lands in a CSS variable so the
 * stacking stays in the stylesheet (`z-index: var(--ui-window-z, 1)`) instead
 * of fighting whichever static z-index the panel already had (spec R3).
 */
export function bringToFront(host: HTMLElement, window: HTMLElement): void {
  const next = (Number(host.dataset.uiWindowZ ?? '0') || 0) + 1;
  host.dataset.uiWindowZ = String(next);
  window.style.setProperty('--ui-window-z', String(next));
}

export interface AssetButtonOptions {
  assets: AssetSet;
  /**
   * Frame key without the state segment, e.g. `AutoBuild/button:close`.
   * Pass a function when the base itself changes with a window mode.
   */
  base: string | (() => string);
  /** Accessible name; also used as the tooltip. */
  label: string;
  className?: string;
  action: () => void;
  /** When it returns true the button shows its `disabled` frame (if any). */
  disabled?: () => boolean;
}

export interface AssetButton {
  button: HTMLButtonElement;
  image: HTMLImageElement;
  setState: (state: AssetButtonState) => void;
  refresh: () => void;
}

export type AssetButtonState = 'normal' | 'mouseOver' | 'pressed' | 'disabled';

/**
 * Source-frame button with hover / pressed / disabled states (spec R4).
 *
 * Frame keys are `<base>/<state>/0`; switching a state keeps the base and
 * replaces the trailing two segments, falling back to `normal` whenever the
 * requested state was never authored.  Interaction mirrors the inventory
 * window: enter→mouseOver, leave→normal, down→pressed, up→normal.
 *
 * Returns `undefined` when even the `normal` frame is missing — callers are
 * expected to surface that as a missing-asset status rather than render a
 * dead button.
 */
export function createAssetButton(options: AssetButtonOptions): AssetButton | undefined {
  const resolveBase = () => (typeof options.base === 'function' ? options.base() : options.base);
  const keyFor = (state: string) => {
    const base = resolveBase();
    return base ? `${base}/${state}/0` : `${state}/0`;
  };
  const normal = options.assets[keyFor('normal')];
  if (!normal) return undefined;

  const button = document.createElement('button');
  button.type = 'button';
  if (options.className) button.className = options.className;
  button.dataset.state = 'normal';
  button.title = options.label;
  button.setAttribute('aria-label', options.label);

  const image = document.createElement('img');
  image.src = normal.url;
  image.width = normal.width;
  image.height = normal.height;
  image.alt = '';
  image.draggable = false;
  button.append(image);

  const setState = (state: AssetButtonState) => {
    const frame = options.assets[keyFor(state)] ?? options.assets[keyFor('normal')] ?? normal;
    button.dataset.state = state;
    image.src = frame.url;
    image.width = frame.width;
    image.height = frame.height;
  };
  const refresh = () => setState(options.disabled?.() ? 'disabled' : 'normal');

  button.addEventListener('pointerenter', () => { if (!options.disabled?.()) setState('mouseOver'); });
  button.addEventListener('pointerleave', () => refresh());
  button.addEventListener('pointerdown', event => {
    if (options.disabled?.()) return;
    setState('pressed');
    event.preventDefault();
  });
  button.addEventListener('pointerup', () => refresh());
  button.addEventListener('pointercancel', () => refresh());
  button.addEventListener('click', event => {
    if (options.disabled?.()) {
      event.preventDefault();
      return;
    }
    options.action();
  });
  refresh();
  return { button, image, setState, refresh };
}

/**
 * Position a source-frame button by its authored coordinates, widening the hit
 * box by `padding` on every side so a 10–16 px sprite stays clickable.  Copied
 * from the inventory window, which is the only panel using authored button
 * positions today.
 */
export function positionAssetButton(button: HTMLElement, frame: AssetFrame, padding = 4): void {
  button.style.left = `${frame.x - padding}px`;
  button.style.top = `${frame.y - padding}px`;
  button.style.width = `${frame.width + padding * 2}px`;
  button.style.height = `${frame.height + padding * 2}px`;
}

/** Clamp an already-positioned window back inside its host (used on resize). */
export function clampIntoHost(host: HTMLElement, window: HTMLElement): void {
  if (window.dataset.windowPositioned !== 'true') return;
  const hostRect = host.getBoundingClientRect();
  const rect = window.getBoundingClientRect();
  const left = Math.min(Math.max(0, hostRect.width - rect.width), Math.max(0, rect.left - hostRect.left));
  const top = Math.min(Math.max(0, hostRect.height - rect.height), Math.max(0, rect.top - hostRect.top));
  window.style.left = Math.round(left) + 'px';
  window.style.top = Math.round(top) + 'px';
}
