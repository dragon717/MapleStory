import type Phaser from 'phaser';
import type { WindbellState, PlayerState } from '../../../../shared/protocol';
import config from '../../../../shared/windbell.json';
import { frameAt } from '../player/animation';
import { WINDBELL_ASSETS as A } from './maps';

type Frame = { url: string; width: number; height: number; origin: { x: number; y: number }; delay: number };
type Assets = Record<string, Frame[]>;
type Surface = { x1: number; y1: number; x2: number; y2: number };
// Re-anchor the original house fire layer to the fuel pile; keep each frame origin unchanged.
const FIRE_OFFSET = { x: -50, y: 50 };
const CATALOG = A + 'tms273.json';

/** Hand-painted sprites share the same XY camera and foot coordinates as the actors. */
export class WindbellScene {
  static readonly sounds = ['cut_rope','bridge_land','fire_ignite','fire_extinguish','wing_open','material_handoff','cart_wood_support','craftsman_install','arrival','bell'];
  static preload(scene: Phaser.Scene, kind: 'island'|'bridge') {
    for (const name of [`${kind}-distant-background`, 'island-ancient-tree', 'island-floating-ground', 'prop-waystation', 'prop-leafwing', 'prop-dragon', 'prop-cart', 'prop-materials', 'prop-bell']) {
      const url = `${A}${name}.png`;
      if (!scene.textures.exists(url)) scene.load.image(url, url);
    }
    const queue = (assets: Assets) => {
      const urls = new Set(Object.values(assets).flatMap(frames => frames.map(frame => frame.url)));
      for (const url of urls) if (!scene.textures.exists(url)) scene.load.image(url, url);
    };
    if (scene.cache.json.exists(CATALOG)) queue(scene.cache.json.get(CATALOG));
    else {
      scene.load.once(`filecomplete-json-${CATALOG}`, (_key: string, _type: string, assets: Assets) => queue(assets));
      scene.load.json(CATALOG, CATALOG);
    }
  }

  private previous?: WindbellState;
  private objects: Phaser.GameObjects.GameObject[] = [];
  private assets: Assets;
  private bridge?: Phaser.GameObjects.Container;
  private segments: Phaser.GameObjects.Container[] = [];
  private fire?: Phaser.GameObjects.Image;
  private wing?: Phaser.GameObjects.Image;
  private cart?: Phaser.GameObjects.Image;
  private dragon?: Phaser.GameObjects.Image;
  private clouds: { image: Phaser.GameObjects.Image; x: number }[] = [];
  private clock = 0;
  private fireElapsed = 0;
  private fallElapsed = 0;
  private fallStart = 0;
  private dead = false;

  constructor(private scene: Phaser.Scene, private kind: 'island'|'bridge', onReady: () => void, _onError: (message: string) => void) {
    this.assets = scene.cache.json.get(CATALOG) as Assets;
    for (const key of ['fire', 'branch', 'cloud', 'bridge', 'ground', 'rock', 'rope']) {
      if (!this.assets?.[key]?.length) throw new Error(`缺少 TMS273 素材：${key}`);
    }
    this.picture(`${kind}-distant-background`, 1300, 750, 3100, -30).setScrollFactor(.75);
    for (let i = 0; i < 5; i++) {
      const frame = this.assets.cloud[0];
      const image = this.original('cloud', i * 630, 450 + i % 2 * 360, -25).setScale(.55).setAlpha(.65).setScrollFactor(.85);
      image.setPosition(i * 630 - frame.origin.x * .55, 450 + i % 2 * 360 - frame.origin.y * .55);
      this.clouds.push({ image, x: image.x });
    }
    const tree = this.picture('island-ancient-tree', 370, kind === 'island' ? 650 : 100, 1400, -12);
    if (kind === 'bridge') this.picture('island-ancient-tree', 2360, 150, 1100, -13).setFlipX(true);
    tree.setAlpha(1);
    for (const surface of config.maps[kind].footholds) this.surface(surface, 'ground', true);
    if (kind === 'island') {
      this.picture('island-ancient-tree', 2460, 180, 800, -13).setFlipX(true);
      this.picture('prop-waystation', 2290, 550, 650, -4).setOrigin(.5, .8);
      this.dragon = this.picture('prop-dragon', 700, 300, 235, -14);
      const ladder = config.maps.island.ladders[0];
      const rope = this.assets.rope[0];
      this.track(scene.add.tileSprite(ladder.x, ladder.y1, rope.width, ladder.y2 - ladder.y1, rope.url).setOrigin(.5, 0).setDepth(-1));
      this.bridge = this.surface(config.island.treeBridge.dynamicFoothold, 'bridge', false);
      const branch = config.island.heat.branch;
      this.original('rock', branch.x, branch.y + 12, -1);
      const fuel = this.track(scene.add.container(branch.x, branch.y).setDepth(-1));
      for (let i = 0; i < 3; i++) {
        const frame = this.assets.branch[i % this.assets.branch.length];
        fuel.add(scene.add.image((i - 1) * 20, 0, frame.url).setOrigin(.5, 1).setScale(2).setRotation((i - 1) * .3));
      }
      this.fire = this.original('fire', branch.x, branch.y, 2).setVisible(false);
      this.wing = this.picture('prop-leafwing', 0, 0, 155, .5).setVisible(false);
      this.picture('prop-bell', 560, 575, 45, -1);
    } else {
      this.picture('prop-waystation', 2210, 700, 580, -4).setOrigin(.5, .8);
      this.cart = this.picture('prop-cart', config.bridge.cart.x, config.bridge.cart.y, 190, 0).setOrigin(.5, 1);
      this.picture('prop-materials', config.bridge.material.x, config.bridge.material.y - 30, 130, 0);
      this.segments = config.bridge.segments.map(surface => this.surface(surface, 'bridge', false).setVisible(false));
    }
    onReady();
  }

  private track<T extends Phaser.GameObjects.GameObject>(object: T): T { this.objects.push(object); return object; }
  private picture(name: string, x: number, y: number, width: number, depth: number) {
    const image = this.track(this.scene.add.image(x, y, `${A}${name}.png`).setDepth(depth));
    return image.setScale(width / image.width);
  }
  private original(name: string, x: number, y: number, depth: number) {
    const frame = this.assets[name][0];
    return this.track(this.scene.add.image(x - frame.origin.x, y - frame.origin.y, frame.url).setOrigin(0).setDepth(depth));
  }
  private surface(surface: Surface, material: 'ground'|'bridge', rocks: boolean) {
    const { x1, y1, x2, y2 } = surface;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const group = this.track(this.scene.add.container(x1, y1).setDepth(-2).setRotation(Math.atan2(y2 - y1, x2 - x1)));
    if (rocks && this.kind === 'island') {
      const terrain = this.scene.add.image(0, 0, A + 'island-floating-ground.png').setOrigin(0, .24);
      terrain.setScale(length / terrain.width);
      group.add(terrain);
    } else if (rocks) {
      const rock = this.assets.rock[0];
      for (let x = 0; x < length; x += rock.width * .8) {
        group.add(this.scene.add.image(x, 12, rock.url).setOrigin(0, 0));
      }
    }
    if (material === 'bridge') {
      const rope = this.assets.rope[0];
      group.add(this.scene.add.tileSprite(0, -55, rope.width, length, rope.url).setOrigin(0, 0).setRotation(-Math.PI / 2));
      for (let x = 0; x <= length; x += 90) {
        group.add(this.scene.add.tileSprite(x, -55, rope.width, 55, rope.url).setOrigin(0, 0));
      }
    }
    const frame = this.assets[material][0];
    // Repeat original pixels along the authoritative surface; never stretch a plank across the entire map.
    group.add(this.scene.add.tileSprite(0, 0, length, frame.height, frame.url).setOrigin(0, 0));
    return group;
  }

  update(state: WindbellState|undefined, player: PlayerState|undefined, delta: number, tickMs = 50) {
    if (!state || this.dead) return;
    const old = this.previous;
    if (old) {
      const cues: string[] = [];
      if (state.treeBridge !== old.treeBridge) cues.push(state.treeBridge === 'falling' ? 'cut_rope' : 'bridge_land');
      if (state.heat !== old.heat) cues.push(state.heat === 'burning' ? 'fire_ignite' : 'fire_extinguish');
      if (state.leafwing && !old.leafwing) cues.push('wing_open');
      if (state.planks < old.planks || state.ropes < old.ropes) cues.push('material_handoff');
      if (state.cartUpright && !old.cartUpright) cues.push('cart_wood_support');
      if ((state.bridgeSegments ?? 0) > (old.bridgeSegments ?? 0)) cues.push('craftsman_install');
      if ((state.arrivalPath && !old.arrivalPath) || (state.bridgeStage === 'inhabited' && old.bridgeStage !== 'inhabited')) cues.push('arrival', 'bell');
      for (const cue of cues) { const key = A + 'sfx/' + cue + '.ogg'; if (this.scene.cache.audio.exists(key)) this.scene.sound.play(key, { volume: .25 }); }
    }
    this.clock += delta;
    if (this.bridge) {
      const f = config.island.treeBridge.dynamicFoothold;
      const landed = Math.atan2(f.y2 - f.y1, f.x2 - f.x1), held = landed - .42;
      if (state.treeBridge !== old?.treeBridge) { this.fallElapsed = 0; this.fallStart = held; }
      this.fallElapsed += delta;
      const t = Math.min(1, this.fallElapsed / (config.island.treeBridge.fallingTicks * tickMs));
      this.bridge.setRotation(state.treeBridge === 'held' ? held : state.treeBridge === 'landed' ? landed : this.fallStart + (landed - this.fallStart) * t);
    }
    if (this.fire) {
      if (state.heat === 'burning' && old?.heat !== 'burning') this.fireElapsed = 0;
      else this.fireElapsed += delta;
      const frames = this.assets.fire;
      const frame = frames[frameAt(frames.map(f => f.delay), this.fireElapsed, true)];
      const branch = config.island.heat.branch;
      this.fire.setVisible(state.heat === 'burning').setTexture(frame.url).setPosition(branch.x + FIRE_OFFSET.x - frame.origin.x, branch.y + FIRE_OFFSET.y - frame.origin.y);
    }
    const count = state.bridgeSegments ?? (['connected', 'inhabited'].includes(state.bridgeStage) ? 3 : 0);
    this.segments.forEach((segment, i) => segment.setVisible(count > i));
    this.cart?.setX(state.cartX ?? config.bridge.cart.x).setRotation(state.cartUpright ? 0 : -.21);
    this.wing?.setVisible(Boolean(player && state.leafwing && !player.grounded));
    if (this.wing && player) this.wing.setPosition(player.x, player.y - 38).setFlipX(player.facing < 0);
    const seconds = this.clock / 1000;
    for (const cloud of this.clouds) cloud.image.setX(cloud.x + Math.sin(seconds * .07) * 100);
    this.dragon?.setPosition(700 + Math.sin(seconds * .18) * 220, 300 + Math.sin(seconds * 1.3) * 15);
    this.previous = state;
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    for (const object of this.objects) object.destroy();
    this.objects = [];
  }
}
