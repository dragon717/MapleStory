/**
 * One place decides what the Escape key means in game.
 *
 * Before this module every panel installed its own Escape listener and each one
 * only ever closed itself — which is correct for closing, but left no way to
 * *open* anything with Escape.  The user asked for the menu bar to come up on
 * Escape, so the key now has a single owner that arbitrates in this order
 * (spec R5 in `docs/technical/UI_WINDOW_SYSTEM.md`):
 *
 *   1. a panel is open        → that panel's own listener closes it; the router
 *                               stays out of the way (`blocked()` is true)
 *   2. the menu is open       → the menu's own listener closes it
 *   3. nothing is open        → the router opens (or closes) the menu bar
 *
 * The router deliberately does not call `stopPropagation`: the panel listeners
 * live on the same capture phase and must still receive the event.  It only
 * handles the case nobody else claims.
 */
export interface EscapeRouterOptions {
  /** True while some panel that owns its own Escape handling is open. */
  blocked: () => boolean;
  /** True while the menu bar is open. */
  menuOpen: () => boolean;
  /** Toggle the ESC menu bar; called only when nothing else claims the key. */
  toggleMenu: () => void;
}

export function installEscapeRouter(options: EscapeRouterOptions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;
    if (event.key !== 'Escape' && event.code !== 'Escape') return;
    const target = event.target;
    // The chat input keeps its own Escape semantics (leave whisper, then blur).
    if (target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]')) return;
    if (options.menuOpen() || options.blocked()) return;
    event.preventDefault();
    options.toggleMenu();
  };
  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}
