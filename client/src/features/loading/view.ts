/*
 * LoadingOverlay — full-bleed loading screen shown while the game view boots.
 *
 * The overlay sits on top of the Phaser canvas inside `#game-shell`.  It uses
 * the authored TMS273 `CustomizeChar` login backdrop (1366x768) as its
 * background, scales with the viewport, and renders a modern, glassy progress
 * bar at the bottom.  The bar is driven by the same messages the rest of the
 * app already produces (`status`), so wiring it into the boot pipeline does
 * not require inventing a new progress channel:
 *
 *   - "正在读取资源清单…" / "Loading resources…" → stage `manifest`
 *   - "正在装载地图与角色 · NN%" / "Loading map & avatar · NN%" → stage `assets`
 *     with percentage parsed from the trailing number.
 *   - "地图已就绪…" / "Map ready…" → stage `ready` (indeterminate).
 *   - anything else (including errors) is forwarded as the headline.
 *
 * The overlay intentionally does not trap focus, does not own pointer events
 * for the buttons it does not render, and removes itself on `hide()` so the
 * Phaser canvas receives input again.
 */

import { uiLocale } from '../../app/i18n';
import './style.css';

/* eslint-disable no-restricted-syntax */
/* LoadingOverlay is intentionally side-effect-free outside its host: it only
   mutates the DOM nodes passed to it.  The framework-level callers already
   keep the overlay in sync with the rest of the boot pipeline. */

const english = (): boolean => uiLocale() === 'en';

const STAGE_LABELS: Record<LoadingStage, { zh: string; en: string }> = {
  manifest: { zh: '正在读取资源清单…', en: 'Loading resources…' },
  assets:   { zh: '正在装载地图与角色', en: 'Loading map & avatar' },
  ready:    { zh: '地图已就绪，等待快照…', en: 'Map ready · awaiting snapshot…' },
};

/** One of three loading stages reported by the boot pipeline. */
export type LoadingStage = 'manifest' | 'assets' | 'ready';

/**
 * Public surface of the loading overlay.
 *
 * Construct one against any host element, then call `show()` to mount the
 * overlay, `update()` to push a new (stage, progress, headline) triple, and
 * `hide()` to tear it down.  The overlay does not own a clock: callers are
 * responsible for keeping `update()` invocations in sync with the boot
 * pipeline so the progress bar never appears to run backwards.
 */
export class LoadingOverlay {
  private root?: HTMLElement;
  private backdrop?: HTMLElement;
  private headline?: HTMLElement;
  private stageChip?: HTMLElement;
  private bar?: HTMLElement;
  private barFill?: HTMLElement;
  private percent?: HTMLElement;
  private removed = false;
  private currentStage: LoadingStage = 'manifest';
  private currentProgress = 0;

  constructor(private host: HTMLElement) {}

  /** Mount the overlay above the game canvas.  Safe to call repeatedly. */
  show(): void {
    if (this.root) return;
    this.removed = false;
    const root = document.createElement('div');
    root.className = 'loading-overlay';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    // Backdrop is the source-backed CustomizeChar canvas (1366x768); the
    // responsive stylesheet scales it to the viewport while keeping the
    // village / tree centered.  The URL lives here (inline style) rather
    // than in the stylesheet so offline esbuild bundles never try to
    // resolve the absolute /assets path on disk.
    const backdrop = document.createElement('div');
    backdrop.className = 'loading-overlay-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.style.backgroundImage = "url('/assets/entry/UI__Canvas_customLoginTheme.img_0_image_back_0_0-88919c5ab2.png')";
    root.appendChild(backdrop);

    // The card carries the live progress UI.  It is a flat DOM tree of named
    // hooks (`.loading-overlay-stage`, `.loading-overlay-headline`, etc.) so
    // the stylesheet can target each piece without inline styles.
    const card = document.createElement('div');
    card.className = 'loading-overlay-card';
    root.appendChild(card);

    const stage = document.createElement('div');
    stage.className = 'loading-overlay-stage';
    stage.dataset.stage = 'manifest';
    const chip = document.createElement('span');
    chip.className = 'loading-overlay-chip';
    chip.textContent = english() ? 'CONNECTING' : '正在连接';
    stage.appendChild(chip);
    card.appendChild(stage);

    const headline = document.createElement('div');
    headline.className = 'loading-overlay-headline';
    headline.textContent = english() ? 'Loading resources…' : '正在读取资源清单…';
    card.appendChild(headline);

    const bar = document.createElement('div');
    bar.className = 'loading-overlay-bar';
    bar.setAttribute('aria-hidden', 'true');
    const barFill = document.createElement('div');
    barFill.className = 'loading-overlay-bar-fill';
    barFill.style.width = '0%';
    bar.appendChild(barFill);
    card.appendChild(bar);

    const meta = document.createElement('div');
    meta.className = 'loading-overlay-meta';
    const percent = document.createElement('span');
    percent.className = 'loading-overlay-percent';
    percent.textContent = '0%';
    const hint = document.createElement('span');
    hint.className = 'loading-overlay-hint';
    hint.textContent = english() ? 'First load may take a moment.' : '首次加载稍候片刻。';
    meta.appendChild(percent);
    meta.appendChild(hint);
    card.appendChild(meta);

    this.host.appendChild(root);
    this.root = root;
    this.backdrop = backdrop;
    this.headline = headline;
    this.stageChip = stage;
    this.bar = bar;
    this.barFill = barFill;
    this.percent = percent;
    this.applyStage('manifest');
    this.applyProgress(0);
  }

  /**
   * Push a new state to the overlay.  `stage` is the pipeline stage,
   * `progress` is a value in `[0, 1]` (or `null` for indeterminate), and
   * `headline` overrides the default stage label when provided.
   */
  update(stage: LoadingStage, progress: number | null, headline?: string): void {
    if (!this.root || this.removed) return;
    if (stage !== this.currentStage) this.applyStage(stage);
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      this.applyProgress(Math.max(0, Math.min(1, progress)));
    } else if (stage === 'ready') {
      // Indeterminate: fill the bar to communicate "this is the last step"
      // without inventing a fake percentage.
      this.applyProgress(1);
      this.root.classList.add('loading-overlay-indeterminate');
    }
    if (headline && this.headline && this.headline.textContent !== headline) {
      this.headline.textContent = headline;
    } else if (!headline) {
      const label = STAGE_LABELS[stage];
      const fallback = english() ? label.en : label.zh;
      if (this.headline && this.headline.textContent !== fallback) this.headline.textContent = fallback;
    }
  }

  /**
   * Translate a raw status line from the boot pipeline into an `update()`.
   * Returns `true` when the line was recognised (caller should suppress
   * duplicate display of the headline), `false` otherwise so the caller can
   * keep showing the original status text alongside the overlay.
   */
  applyStatus(message: string): boolean {
    if (!message) return false;
    // Once the overlay is unmounted, it should be silent: callers continue to
    // pipe their status lines through this method but the overlay has nothing
    // to render.  Returning `false` keeps the caller's own status bar as the
    // single source of truth while the game is already on screen.
    if (!this.root || this.removed) return false;
    // English / 中文双轨匹配：原版状态文案已统一用这两套前缀，进度条跟随原文。
    const assetMatch = message.match(/(?:正在装载地图与角色|Loading map & avatar)[^0-9]*(\d{1,3})\s*%/);
    if (assetMatch) {
      const pct = Number.parseInt(assetMatch[1] ?? '', 10);
      if (Number.isFinite(pct)) {
        this.update('assets', pct / 100, message);
        return true;
      }
    }
    if (/(?:正在读取资源清单|Loading resources)/.test(message)) {
      this.update('manifest', null, message);
      return true;
    }
    if (/(?:地图已就绪|Map ready)/.test(message)) {
      this.update('ready', null, message);
      return true;
    }
    // Errors and other statuses: keep the headline current but don't claim
    // ownership — the caller's status bar still mirrors the message.
    if (this.headline) this.headline.textContent = message;
    return false;
  }

  /** Tear the overlay down and return focus to the game canvas. */
  hide(): void {
    if (!this.root || this.removed) return;
    this.removed = true;
    this.root.remove();
    this.root = undefined;
    this.backdrop = undefined;
    this.headline = undefined;
    this.stageChip = undefined;
    this.bar = undefined;
    this.barFill = undefined;
    this.percent = undefined;
  }

  private applyStage(stage: LoadingStage): void {
    this.currentStage = stage;
    if (!this.stageChip) return;
    this.stageChip.dataset.stage = stage;
    const chip = english()
      ? stage === 'manifest' ? 'CONNECTING' : stage === 'assets' ? 'LOADING' : 'READY'
      : stage === 'manifest' ? '正在连接' : stage === 'assets' ? '正在装载' : '即将进入';
    const labelEl = this.stageChip.querySelector('.loading-overlay-chip');
    if (labelEl) labelEl.textContent = chip;
  }

  private applyProgress(value: number): void {
    this.currentProgress = value;
    if (this.barFill) this.barFill.style.width = `${(value * 100).toFixed(1)}%`;
    if (this.percent) this.percent.textContent = `${Math.round(value * 100)}%`;
    if (this.bar) {
      this.bar.setAttribute('aria-valuenow', String(Math.round(value * 100)));
      this.bar.setAttribute('aria-valuemin', '0');
      this.bar.setAttribute('aria-valuemax', '100');
    }
  }
}