import { resolveAssetUrl } from '../../assets/resource-url';
import type { Manifest } from '../../assets/manifest';
import { EntryVoyage } from '../entry/voyage';
import type { ShipControls } from '../entry/voyage-ship';
import { DEFAULT_ENVIRONMENT, SEASONS, TIMES, WEATHERS, type EnvironmentSettings } from '../henesys/environment-settings';
import { bringToFront, clampIntoHost, createAssetButton, installWindowDrag } from '../ui/window-shell';
import './style.css';

/** The scene-facing part of the old Activities callback, now owned by this window. */
export type SceneDisplay = {
  enabled: () => boolean;
  available: () => boolean;
  setEnabled: (enabled: boolean) => void;
  resetCamera: () => void;
  toggleQuality?: () => void;
  previewSky?: (enabled: boolean) => void;
  environment?: { get: () => EnvironmentSettings; set: (value: Partial<EnvironmentSettings>) => void };
  audio?: { available?:()=>boolean; spatial: () => boolean; setSpatial: (enabled: boolean) => void; volume: () => number; setVolume: (volume: number) => void };
  /** Existing keyboard-window action carried with the extracted controls. */
  openKeys?: () => void;
};

type AdminBookTab = 'lighting' | 'ship';
type ShipShot = 'ship' | 'deck' | 'cabin' | 'berths';
type ShipControlKey = keyof ShipControls;

const SHIP_DEFAULTS: ShipControls = { sail: 1, wind: 8, throttle: .5, steering: 0 };
const SHIP_SHOTS: readonly [ShipShot, string][] = [
  ['ship', '航船总览'],
  ['deck', '甲板'],
  ['cabin', '船舱'],
  ['berths', '铺位'],
];

/**
 * A small, keyboard-accessible administrator window for scene lighting and the
 * existing sky-voyage renderer.  It intentionally owns no world or account
 * state; the scene callbacks and EntryVoyage remain the sources of truth.
 */
export class AdminBookView {
  private readonly root = document.createElement('section');
  private readonly body = document.createElement('div');
  private readonly lightingPanel = document.createElement('section');
  private readonly shipPanel = document.createElement('section');
  private readonly tabs = new Map<AdminBookTab, HTMLButtonElement>();
  private readonly panels = new Map<AdminBookTab, HTMLElement>();
  private readonly shipShotButtons = new Map<ShipShot, HTMLButtonElement>();
  private readonly shipStatus = document.createElement('output');
  private readonly shipPreviewStatus = document.createElement('p');
  private shipTrialButton?: HTMLButtonElement;
  private disposeDrag?: () => void;
  private resize?: ResizeObserver;
  private lightingRefresh?: () => void;
  private voyage?: EntryVoyage;
  private voyageHost?: HTMLElement;
  private tab: AdminBookTab = 'lighting';
  private shipShot: ShipShot = 'ship';
  private shipTrial = false;
  private shipControls: ShipControls = { ...SHIP_DEFAULTS };
  private skyPreview = false;
  private openState = false;
  private refreshTimer?:ReturnType<typeof setInterval>;
  private readonly escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.openState) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly manifest: Manifest,
    private readonly focus: () => void,
    private readonly sceneDisplay: SceneDisplay,
  ) {
    this.root.className = 'admin-book-root';
    for(const name of ['t','c','s']){const art=manifest.dialogUi?.[name];if(art)this.root.style.setProperty('--admin-'+name,`url("${resolveAssetUrl(art.url)}")`);}
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'false');
    this.root.setAttribute('aria-label', '管理员之书');

    const header = document.createElement('header');
    header.className = 'admin-book-header';
    const title = document.createElement('h2');
    title.className = 'admin-book-title';
    title.textContent = '管理员之书';
    header.append(title);
    const close = createAssetButton({
      assets: manifest.inventoryUi ?? {},
      base: 'AutoBuild/button:close',
      label: '关闭管理员之书',
      className: 'admin-book-close',
      action: () => this.close(),
    });
    if (close) header.append(close.button);
    else header.append(this.actionButton('关闭', () => this.close(), 'admin-book-close'));
    this.root.append(header);

    const tabBar = document.createElement('nav');
    tabBar.className = 'admin-book-tabs';
    tabBar.setAttribute('aria-label', '管理员之书分页');
    tabBar.setAttribute('role','tablist');
    tabBar.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      this.activateTab(event.key==='Home'?'lighting':event.key==='End'?'ship':this.tab==='lighting'?'ship':'lighting');
      this.tabs.get(this.tab)?.focus();
    });
    tabBar.append(this.createTab('lighting', '光照与天气'), this.createTab('ship', '天空航船观察'));
    this.root.append(tabBar);

    this.body.className = 'admin-book-body';
    this.lightingPanel.className = 'admin-book-panel admin-book-lighting';
    this.shipPanel.className = 'admin-book-panel admin-book-ship';
    this.panels.set('lighting', this.lightingPanel);
    this.panels.set('ship', this.shipPanel);
    this.buildLightingPanel();
    this.buildShipPanel();
    this.body.append(this.lightingPanel, this.shipPanel);
    this.root.append(this.body);

    this.disposeDrag = installWindowDrag(host, this.root, {
      titleHeight: 28,
      isOpen: () => this.openState,
      onActivate: () => bringToFront(host, this.root),
    });
    this.root.addEventListener('pointerdown', () => bringToFront(host, this.root));
    this.resize = new ResizeObserver(() => clampIntoHost(host, this.root));
    this.resize.observe(host);
    host.append(this.root);
    document.addEventListener('keydown', this.escape, true);
    this.activateTab('lighting');
  }

  show() {
    this.openState = true;
    clearInterval(this.refreshTimer);
    this.refreshTimer=setInterval(()=>{this.lightingRefresh?.();this.refreshShipStatus();},250);
    this.root.hidden = false;
    bringToFront(this.host, this.root);
    this.lightingRefresh?.();
    // Menu entry and the former Activities settings action both open the
    // lighting/weather page first; the ship page is reached deliberately.
    this.activateTab('lighting');
    this.tabs.get(this.tab)?.focus({ preventScroll: true });
  }

  close(restoreFocus = true) {
    clearInterval(this.refreshTimer);this.refreshTimer=undefined;
    this.stopSkyPreview();
    this.disposeVoyage();
    this.openState = false;
    this.root.hidden = true;
    if (restoreFocus) this.focus();
  }

  isOpen() { return this.openState; }

  destroy() {
    this.close(false);
    this.disposeDrag?.();
    this.resize?.disconnect();
    document.removeEventListener('keydown', this.escape, true);
    this.root.remove();
  }

  private createTab(tab: AdminBookTab, label: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'admin-book-tab';
    button.textContent = label;
    button.dataset.adminTab = tab;
    button.id = `admin-book-tab-${tab}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    button.setAttribute('aria-controls', `admin-book-panel-${tab}`);
    button.addEventListener('click', () => this.activateTab(tab));
    this.tabs.set(tab, button);
    return button;
  }

  private activateTab(tab: AdminBookTab) {
    this.tab = tab;
    for (const [name, button] of this.tabs) {
      const selected = name === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const [name, panel] of this.panels) {
      panel.hidden = name !== tab;
      panel.id = `admin-book-panel-${name}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', this.tabs.get(name)?.id ?? `admin-book-tab-${name}`);
      panel.tabIndex = 0;
    }
    if (tab === 'ship') this.ensureVoyage();
    else this.disposeVoyage();
    this.lightingRefresh?.();
    this.refreshShipStatus();
  }

  private buildLightingPanel() {
    const heading = document.createElement('h3');
    heading.textContent = '光照、天气与场景设置';
    const copy = document.createElement('p');
    copy.className = 'admin-book-copy';
    copy.textContent = '调整初弦地或天空之城的镜头、画质、声音与天气。设置由当前场景保存；窗口可以拖动。';

    const toolbar = document.createElement('div');
    toolbar.className = 'admin-book-toolbar';
    const sceneToggle = this.actionButton('切换 2D 视图', () => {
      if (!this.sceneDisplay.available()) return;
      this.sceneDisplay.setEnabled(!this.sceneDisplay.enabled());
      this.lightingRefresh?.();
    });
    const resetCamera = this.actionButton('恢复镜头', () => {
      if (this.sceneDisplay.available() && this.sceneDisplay.enabled()) this.sceneDisplay.resetCamera();
    });
    toolbar.append(sceneToggle, resetCamera);
    if (this.sceneDisplay.toggleQuality) toolbar.append(this.actionButton('切换省电画质', () => {
      if (this.sceneDisplay.available()) this.sceneDisplay.toggleQuality?.();
    }));

    const audioDetails = document.createElement('details');
    audioDetails.className = 'admin-book-details';
    const audioSummary = document.createElement('summary');
    audioSummary.textContent = '声音设置';
    audioDetails.append(audioSummary);
    if (this.sceneDisplay.audio) {
      const audio = this.sceneDisplay.audio;
      const spatial = document.createElement('input');
      spatial.type = 'checkbox';
      spatial.setAttribute('aria-label', '村落空间听感');
      const spatialLabel = document.createElement('label');
      spatialLabel.className = 'admin-book-check';
      spatialLabel.append(spatial, document.createTextNode(' 村落空间听感（关闭恢复原版）'));
      spatial.addEventListener('change', () => audio.setSpatial(spatial.checked));
      const volume = document.createElement('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '1';
      volume.step = '.05';
      volume.setAttribute('aria-label', '总音量');
      const volumeLabel = this.rangeLabel('总音量', volume);
      volume.addEventListener('input', () => audio.setVolume(Number(volume.value)));
      audioDetails.append(spatialLabel, volumeLabel);
      audioDetails.addEventListener('toggle', () => {
        if (audioDetails.open) this.lightingRefresh?.();
      });
      this.lightingRefresh = () => {
        spatial.checked = audio.spatial();
        spatial.disabled = !this.sceneDisplay.available() || !this.sceneDisplay.enabled() || audio.available?.()===false;
        volume.value = String(audio.volume());
        volume.disabled = !this.sceneDisplay.available();
        sceneToggle.disabled = !this.sceneDisplay.available();
        sceneToggle.textContent = !this.sceneDisplay.available()
          ? '进入初弦地或天空之城后可切换'
          : this.sceneDisplay.enabled() ? '切换 2D 视图' : '启用三维场景';
        resetCamera.disabled = !this.sceneDisplay.available() || !this.sceneDisplay.enabled();
      };
    }

    const environmentDetails = document.createElement('details');
    environmentDetails.className = 'admin-book-details environment-controls';
    environmentDetails.open = true;
    const environmentSummary = document.createElement('summary');
    environmentSummary.textContent = '环境与光照';
    const fields = document.createElement('fieldset');
    fields.className = 'admin-book-fieldset';
    fields.setAttribute('aria-label', '初弦地环境设置');
    environmentDetails.append(environmentSummary, fields);
    const environment = this.sceneDisplay.environment;
    const emptyEnvironment = document.createElement('p');
    emptyEnvironment.className = 'admin-book-muted';
    emptyEnvironment.textContent = '当前场景尚未提供环境控制。';
    if (!environment) fields.append(emptyEnvironment);

    const controls: Record<string, HTMLInputElement | HTMLSelectElement | undefined> = {};
    const clock = document.createElement('output');
    clock.className = 'admin-book-clock';
    clock.setAttribute('aria-live', 'off');
    if (environment) {
      const change = (value: Partial<EnvironmentSettings>) => {
        environment.set(value);
        this.lightingRefresh?.();
      };
      const select = (title: string, values: readonly (readonly [string | number, string])[], key: string, action: (value: string) => void) => {
        const input = document.createElement('select');
        input.setAttribute('aria-label', title);
        for (const [value, label] of values) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = label;
          input.append(option);
        }
        input.addEventListener('change', () => action(input.value));
        controls[key] = input;
        fields.append(this.fieldLabel(title, input));
        return input;
      };
      const range = (title: string, key: 'hour' | 'moisture' | 'grade', max: number, step: number) => {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = String(max);
        input.step = String(step);
        input.setAttribute('aria-label', title);
        input.addEventListener('input', () => change({ [key]: Number(input.value) }));
        controls[key] = input;
        fields.append(this.fieldLabel(title, input));
        return input;
      };
      controls.preset = select('时段', [['', '自定时间'], ...TIMES.map(([name, hour]) => [hour, name] as const)], 'preset', value => {
        if (value) change({ hour: Number(value) });
      });
      controls.hour = range('太阳时刻', 'hour', 24, .1);
      fields.append(clock);
      controls.weather = select('天气', WEATHERS, 'weather', value => change({ weather: value as EnvironmentSettings['weather'] }));
      controls.season = select('季节', SEASONS, 'season', value => change({ season: value as EnvironmentSettings['season'] }));
      controls.moisture = range('干燥 — 湿润', 'moisture', 1, .05);
      controls.grade = range('灰调（默认关闭）', 'grade', .2, .01);
      const hint = document.createElement('p');
      hint.className = 'admin-book-muted';
      hint.textContent = '太阳从东侧升起、西侧落下；星光和极光在夜间出现。雨天会浸湿路面。';
      fields.append(hint, this.actionButton('恢复晴朗上午', () => change({ ...DEFAULT_ENVIRONMENT })));
      if (this.sceneDisplay.previewSky) fields.append(this.actionButton('仰望天空 / 回到村路', () => {
        if (!this.sceneDisplay.available() || !this.sceneDisplay.enabled()) return;
        this.skyPreview = !this.skyPreview;
        this.sceneDisplay.previewSky?.(this.skyPreview);
      }));
    }

    const keyButton = this.actionButton('键盘设置', () => {
      if (this.sceneDisplay.openKeys) {
        this.close(false);
        this.sceneDisplay.openKeys();
      } else {
        this.setLightingMessage('键盘设置请从游戏菜单打开。');
      }
    });
    const message = document.createElement('p');
    message.className = 'admin-book-status';
    const setLightingMessage = (text: string) => { message.textContent = text; };
    this.setLightingMessage = setLightingMessage;

    const refresh = this.lightingRefresh;
    this.lightingRefresh = () => {
      refresh?.();
      if (!environment) {
        fields.disabled = true;
        return;
      }
      const settings = environment.get();
      for (const key of ['hour', 'weather', 'season', 'moisture', 'grade'] as const) {
        const control = controls[key];
        if (control) control.value = String(settings[key]);
      }
      if (controls.preset) controls.preset.value = TIMES.find(([, hour]) => Math.abs(hour - settings.hour) < .01)?.[1].toString() ?? '';
      const totalMinutes = Math.round(((settings.hour % 24) + 24) % 24 * 60) % 1440;
      clock.textContent = `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')} · ${settings.moisture >= .5 ? '湿润' : '干燥'}`;
      fields.disabled = !this.sceneDisplay.available();
    };
    this.lightingPanel.append(heading, copy, toolbar, audioDetails, environmentDetails, keyButton, message);
    this.lightingRefresh?.();
  }

  private buildShipPanel() {
    const heading = document.createElement('h3');
    heading.textContent = '天空航船观察';
    const copy = document.createElement('p');
    copy.className = 'admin-book-copy';
    copy.textContent = '观察登录航船的现有模型镜头；预览没有选中角色，方向键仍留给游戏。';
    const layout = document.createElement('div');
    layout.className = 'admin-book-voyage-layout';
    const preview = document.createElement('div');
    preview.className = 'admin-book-voyage-preview-host';
    preview.setAttribute('aria-label', '天空航船预览');
    preview.tabIndex = -1;
    this.voyageHost = preview;

    const controls = document.createElement('aside');
    controls.className = 'admin-book-voyage-controls';
    const shotHeading = document.createElement('h4');
    shotHeading.textContent = '观察镜头';
    const shotButtons = document.createElement('div');
    shotButtons.className = 'admin-book-shot-buttons';
    for (const [shot, label] of SHIP_SHOTS) {
      const button = this.actionButton(label, () => this.setShipShot(shot), 'admin-book-shot');
      button.dataset.shot = shot;
      this.shipShotButtons.set(shot, button);
      shotButtons.append(button);
    }

    const trial = this.actionButton('开始航行试验', () => {
      this.shipTrial = !this.shipTrial;
      this.voyage?.setShipTrial(this.shipTrial);
      if (this.shipTrial) this.shipShot = 'ship';
      this.refreshShipButtons();
      this.refreshShipStatus();
    });
    trial.classList.add('admin-book-trial');
    this.shipTrialButton = trial;
    const controlsHeading = document.createElement('h4');
    controlsHeading.textContent = '船舶控制';
    const controlFields = document.createElement('div');
    controlFields.className = 'admin-book-ship-fields';
    const controlInfo: readonly [ShipControlKey, string, number, number, number][] = [
      ['sail', '帆面', 0, 1, .01],
      ['wind', '风力', 0, 16, .1],
      ['throttle', '推进', 0, 1, .01],
      ['steering', '转舵', -1, 1, .01],
    ];
    for (const [key, label, min, max, step] of controlInfo) {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(this.shipControls[key]);
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => {
        const value = Number(input.value);
        this.shipControls[key] = value;
        this.voyage?.setShipControls({ [key]: value });
        this.refreshShipStatus();
      });
      controlFields.append(this.rangeLabel(label, input));
    }
    this.shipStatus.className = 'admin-book-status admin-book-ship-status';
    this.shipPreviewStatus.className = 'admin-book-status';
    this.shipPreviewStatus.textContent = '打开本页后加载航船模型。';
    controls.append(shotHeading, shotButtons, trial, controlsHeading, controlFields, this.shipStatus, this.shipPreviewStatus);
    layout.append(preview, controls);
    this.shipPanel.append(heading, copy, layout);
    this.refreshShipButtons();
  }

  private ensureVoyage() {
    if (this.voyage || !this.voyageHost) return;
    let voyage: EntryVoyage;
    voyage = new EntryVoyage(this.voyageHost, error => {
      if (this.voyage !== voyage) return;
      if (error) {
        this.shipPreviewStatus.textContent = error;
        return;
      }
      this.shipPreviewStatus.textContent = '模型已加载；可切换镜头并调整船舶控制。';
      voyage.setShipControls(this.shipControls);
      voyage.showShot(this.shipShot);
      if (this.shipTrial) voyage.setShipTrial(true);
      this.refreshShipStatus();
    });
    this.voyage = voyage;
    voyage.attach(this.voyageHost);
    voyage.setShipControls(this.shipControls);
    voyage.showShot(this.shipShot);
    this.refreshShipStatus();
  }

  private setShipShot(shot: ShipShot) {
    this.shipShot = shot;
    this.shipTrial = false;
    this.voyage?.setShipTrial(false);
    this.voyage?.showShot(shot);
    this.refreshShipButtons();
    this.refreshShipStatus();
  }

  private refreshShipButtons() {
    for (const [shot, button] of this.shipShotButtons) {
      const selected = shot === this.shipShot;
      button.dataset.selected = String(selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    if (this.shipTrialButton) {
      this.shipTrialButton.textContent = this.shipTrial ? '结束航行试验' : '开始航行试验';
      this.shipTrialButton.setAttribute('aria-pressed', String(this.shipTrial));
    }
  }

  private refreshShipStatus() {
    const status = this.voyage?.shipStatus();
    if (!status) {
      this.shipStatus.textContent = this.voyage ? '船舶模型加载中……' : '切换至本页以加载模型。';
      return;
    }
    this.shipStatus.textContent = `风帆 ${status.sail.toFixed(2)} · 风力 ${status.wind.toFixed(1)} · 推力 ${status.thrust.toFixed(1)} · 速度 ${status.speed.toFixed(1)}${status.trial ? ' · 试验中' : ''}`;
  }

  private disposeVoyage() {
    this.voyage?.destroy();
    this.voyage = undefined;
    this.voyageHost?.replaceChildren();
    this.shipTrial = false;
    this.refreshShipStatus();
  }

  private stopSkyPreview() {
    if (!this.skyPreview) return;
    this.skyPreview = false;
    this.sceneDisplay.previewSky?.(false);
  }

  private setLightingMessage: (text: string) => void = () => {};

  private actionButton(label: string, action: () => void, className = 'admin-book-button') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  private fieldLabel(label: string, control: HTMLElement) {
    const row = document.createElement('label');
    row.className = 'admin-book-field';
    const text = document.createElement('span');
    text.textContent = label;
    row.append(text, control);
    return row;
  }

  private rangeLabel(label: string, control: HTMLInputElement) {
    return this.fieldLabel(label, control);
  }
}
