import Phaser from 'phaser';
import type { TombstoneSnapshot } from '../../../../shared/protocol';
import type { Frame } from '../../assets/avatar-types';
import { ensureTextures } from '../../assets/lazy-texture';

/**
 * 原创扩展「死亡世界」：渲染一座墓碑与其附着的虚影。
 *
 * 状态边界与 ReactorView 同一口径：服务器拥有全部权威事实（碑文、演化阶段、
 * 到期），这个视图只画快照给它的东西。虚影演化阶段（0 潜伏 → 1 游荡 → 2 凝聚）
 * 是服务端纯函数的输出，这里只把它翻译成**可观察的观感差异**：
 *
 *  - 潜伏：半隐在碑后，几乎不动，最淡；
 *  - 游荡：贴着碑缓慢徘徊，灰影渐成形；
 *  - 凝聚：浮到碑前上方，带一圈光晕，最清晰。
 *
 * 虚影的样子 = 死亡角色外观的**灰色形态**：`world.ts` 用死亡时的 `appearance`
 * 走现有纸娃娃管线（`composeAppearance`）组装出 stand 帧传进来，这里只负责把
 * 帧零件画成灰调半透明。贴图未就绪或快照没有外观时，退回抽象光点兜底——
 * 两种画法都是展示层，权威状态只有服务端那一份。
 *
 * 交互：点击碑体 = 悼念一次（意图）。是否可悼念、是否重复、距离够不够，
 * 全部由服务器裁决；这里只负责把点击上报。
 *
 * 碑体与兜底光点用 Phaser Graphics/Text 绘制而非贴图：本扩展是原创内容，
 * 刻意不占用 CONTENT_VERSION——没有新资源，就没有内容版本与资源门禁的牵连。
 */
export class TombstoneWorldView {
  private readonly container: Phaser.GameObjects.Container;
  private readonly stone: Phaser.GameObjects.Graphics;
  private readonly wisp: Phaser.GameObjects.Graphics;
  private readonly halo: Phaser.GameObjects.Graphics;
  private ghost?: Phaser.GameObjects.Container;
  private readonly nameLabel: Phaser.GameObjects.Text;
  private readonly stageLabel: Phaser.GameObjects.Text;
  private stage: TombstoneSnapshot['stage'];
  private elapsed = 0;
  private ghostReady = false;

  constructor(
    private readonly scene: Phaser.Scene,
    snapshot: TombstoneSnapshot,
    depth: number,
    private onMourn: (tombstoneId: string) => void,
    /** 死亡角色的 stand 帧（灰色形态的原料），由 world.ts 组装后传入。 */
    private readonly ghostFrames?: Frame[],
  ) {
    this.stage = snapshot.stage;
    this.container = scene.add.container(snapshot.x, snapshot.y).setDepth(depth);

    this.halo = scene.add.graphics();
    this.wisp = scene.add.graphics();
    this.stone = scene.add.graphics();
    this.drawStone();
    this.drawWisp(0);

    this.nameLabel = scene.add.text(0, 10, snapshot.characterName, {
      fontFamily: 'sans-serif', fontSize: '12px', color: '#e8e3d5',
      stroke: '#273138', strokeThickness: 3,
    }).setOrigin(0.5, 0);
    this.stageLabel = scene.add.text(0, 26, `虚影 · ${snapshot.stageName}`, {
      fontFamily: 'sans-serif', fontSize: '10px', color: '#b9c7cf',
      stroke: '#273138', strokeThickness: 3,
    }).setOrigin(0.5, 0);
    this.container.add([this.halo, this.wisp, this.stone, this.nameLabel, this.stageLabel]);

    // 点击区与碑体一致（宽 36、高 48，脚点向上）。stopPropagation 防止命中
    // 穿透到 NPC/反应器的最近者判定——一次点击只表达一种意图。
    const zone = scene.add.zone(0, -24, 36, 48).setOrigin(0.5, 1)
      .setInteractive({ useHandCursor: true });
    zone.on('pointerdown', (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
      if (pointer.button === 0) {
        event.stopPropagation();
        this.onMourn(snapshot.id);
      }
    });
    this.container.add(zone);
    this.ensureGhost();
  }

  /** 碑体：灰石圆顶碑身 + 深色描边 + 基座。绘制一次，之后不再重画。 */
  private drawStone() {
    this.stone.fillStyle(0x8d8d97, 1);
    this.stone.fillRoundedRect(-18, -48, 36, 44, { tl: 18, tr: 18, bl: 4, br: 4 });
    this.stone.fillStyle(0x76767f, 1);
    this.stone.fillRect(-18, -22, 36, 18);
    this.stone.lineStyle(2, 0x4a4a52, 1);
    this.stone.strokeRoundedRect(-18, -48, 36, 44, { tl: 18, tr: 18, bl: 4, br: 4 });
    this.stone.fillStyle(0x5c5c64, 1);
    this.stone.fillRect(-24, -4, 48, 6);
    // 碑面刻痕：三道短横示意铭文，可读性靠 nameLabel 与悼念回执。
    this.stone.lineStyle(2, 0x5f5f68, 1);
    this.stone.lineBetween(-10, -38, 10, -38);
    this.stone.lineBetween(-10, -32, 10, -32);
    this.stone.lineBetween(-6, -26, 6, -26);
  }

  /** 兜底光点：快照没有外观或贴图未就绪时的抽象虚影。 */
  private drawWisp(t: number) {
    this.wisp.clear();
    const sway = 3 + this.stage * 3;
    const x = Math.sin(t / 900) * sway;
    const y = -58 - Math.sin(t / 600) * 3;
    const alpha = [0.18, 0.45, 0.75][this.stage];
    const color = [0x9fb6c9, 0x7fd4c1, 0xf2d492][this.stage];
    const radius = [3, 5, 6][this.stage];
    if (this.stage >= 2) {
      this.wisp.fillStyle(color, 0.22);
      this.wisp.fillCircle(x, y, radius + 6);
    }
    this.wisp.fillStyle(color, alpha);
    this.wisp.fillCircle(x, y, radius);
    this.wisp.fillStyle(0xffffff, alpha * 0.6);
    this.wisp.fillCircle(x - 1, y - 1, radius * 0.4);
  }

  /** 灰色形态：备齐 stand 帧的全部贴图后，一次性拼出纸娃娃零件。
   *  ensureTextures 是同步接口（返回是否已齐，未齐则排进装载队列），
   *  所以这里只做一次尝试；未齐时由 update() 每帧重试，贴图一到即成型。
   *  失败（缺目录/缺贴图）就永远停留在光点兜底，不反复刷网络。
   *  零件坐标与 PlayerView 同一口径：compose 已烘焙锚点，origin(0) 贴放，
   *  脚点 y=0 向上生长。 */
  private ensureGhost() {
    if (this.ghostReady || !this.ghostFrames?.length) return;
    const first = this.ghostFrames[0];
    const urls = [...new Set(first.parts.map(part => part.url))];
    if (!ensureTextures(this.scene, urls)) return;
    if (!urls.every(url => this.scene.textures.exists(url))) return;
    const ghost = this.scene.add.container(0, 0).setAlpha(0);
    const parts = [...first.parts].sort((a, b) => b.z - a.z);
    for (const part of parts) {
      const image = this.scene.add.image(part.x, part.y, part.url)
        .setOrigin(0)
        // 灰色形态：一个灰蓝 tint 把原色整体压成阴冷灰，死亡观感不靠重画。
        .setTint(0x94a3ad)
        .setAlpha(0);
      ghost.add(image);
    }
    this.ghost = ghost;
    // 画进碑的后面（halo 之后、光点/碑体之前）：人站在碑后，碑遮下半身。
    this.container.addAt(ghost, 1);
    this.ghostReady = true;
    this.wisp.setVisible(false);
  }

  /** 阶段 → 灰色形态的观感参数：位置（碑后潜伏 → 徘徊 → 碑前上浮）、
   *  透明度与凝聚光晕。全部是展示层的连续函数，不推进任何权威状态。 */
  private updateGhost(t: number) {
    if (!this.ghostReady || !this.ghost) return;
    const bob = -Math.sin(t / 700) * 2;
    const sway = [0, 8, 4][this.stage] * Math.sin(t / (2600 - this.stage * 600));
    const lift = [4, 2, -10][this.stage];
    const alpha = [0.22, 0.42, 0.68][this.stage] * (0.92 + 0.08 * Math.sin(t / 500));
    this.ghost.setPosition(Math.round(sway), Math.round(lift + bob));
    this.ghost.setAlpha(alpha);
    this.halo.clear();
    if (this.stage >= 2) {
      this.halo.fillStyle(0xf2d492, 0.10 + 0.05 * Math.sin(t / 500));
      this.halo.fillCircle(sway, lift + bob - 26, 24);
    }
  }

  /** 权威状态更新：阶段变化立即落到观感上；呼吸/漂移是纯展示层。 */
  update(snapshot: TombstoneSnapshot, delta: number) {
    this.stage = snapshot.stage;
    this.stageLabel.setText(`虚影 · ${snapshot.stageName}`);
    if (this.container.x !== snapshot.x || this.container.y !== snapshot.y) {
      this.container.setPosition(snapshot.x, snapshot.y);
    }
    this.elapsed += delta;
    if (this.ghostReady) this.updateGhost(this.elapsed);
    else {
      // 贴图未齐：每帧重试一次成型；仍未齐就继续光点兜底。
      this.ensureGhost();
      if (!this.ghostReady) this.drawWisp(this.elapsed);
    }
  }

  destroy() {
    this.container.destroy();
  }
}
