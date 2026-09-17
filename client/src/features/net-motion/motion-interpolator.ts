/**
 * 权威快照运动插值（Net Motion）。
 *
 * ## 为什么需要这一层
 * 服务端每 tick（`TICK_MS = 50`，即 20 Hz）推一份权威快照，而浏览器按 60 fps 绘制。
 * 改之前每个 actor 都直接画在快照坐标上（`PlayerView.update` 里
 * `setPosition(Math.round(player.x), ...)`），于是走路的角色每 50ms 才跳一步，
 * 相机（它以自角色为中心）跟着一起走楼梯。
 *
 * ## 这一层做什么
 * 为每个 actor 保留最近两份权威样本，用一个**按服务端 tick 速率前进的客户端时钟**
 * 在两者之间取位置。渲染点始终落在「服务端已经给出的两个点之间」，所以
 * 插值不可能把任何 actor 送到服务端没有放过的地方——**权威没有让位给流畅**。
 * 客户端依旧只提交意图（方向/跳跃/技能），从不提交坐标。
 *
 * ## 时钟
 * 时钟自由前进（每帧 `delta / tickMs` 个 tick），并被温和地拉向
 * `最新样本 tick - delayTicks`：
 * - 稳态下时钟落在目标上，`f` 在 0..1 之间连续变化 ⇒ 位置连续；
 * - 丢包/卡顿后靠 **速率微调**（±`maxSlew`）追平，`Math.abs(error) > resyncTicks`
 *   才硬对表；速率永远为正 ⇒ **时钟不倒流**，绝不出现"为了对齐把角色往回拽"；
 * - 时钟不会超过最新样本（`Math.min(..., latestTick)`）⇒ **不外推**，
 *   宁可在数据用完时停半拍，也不凭速度猜一个服务端没给出的位置。
 *
 * ## 不做什么
 * - 不做本地预测（客户端没有地形与物理，预测出来的位置不是权威的）；
 * - 不插值动作、朝向、血量等离散状态——只插值 `x`/`y`，其余一律取最新样本；
 * - 不参与任何判定（门、采集、拾取范围仍由服务端裁定）。
 */

/** 参与插值的实体只需要 id 与脚点坐标；其余字段原样透传。 */
export interface MotionEntity {
  id: string;
  x: number;
  y: number;
}

/** 一份权威样本：服务端 tick + 该 tick 的权威脚点。 */
export interface MotionSample {
  tick: number;
  x: number;
  y: number;
}

export interface MotionTrack {
  prev: MotionSample;
  latest: MotionSample;
  /**
   * 这一对样本之间发生了"位移类事件"（换图／传送门／复活／长时间断流）。
   * 插值会画出一条横穿地图的直线，所以这一类必须**直接落到最新点**。
   */
  teleported: boolean;
}

export interface MotionOptions {
  /** 渲染时钟瞄准「最新样本往前数第几拍」。0.5 = 半个 tick（约 25ms）延迟。 */
  delayTicks?: number;
  /** 单拍位移超过这个距离就认定为瞬移（世界单位，与 foothold 同一坐标系）。 */
  teleportDistance?: number;
  /** 样本间隔超过这么多拍就不再插值（后台标签页 / 断流恢复）。 */
  maxInterpTicks?: number;
  /** 时钟追平增益：误差每 1 拍调多少速率。 */
  slewGain?: number;
  /** 速率微调上限（0.25 = 允许 0.75x~1.25x）。 */
  maxSlew?: number;
  /** 误差超过这么多拍直接硬对表，不再滑行。 */
  resyncTicks?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export const DEFAULT_TICK_MS = 50;
/**
 * 自角色的渲染延迟比远端小：自己按下的键要尽快看见，而远端角色宁可多缓冲
 * 一拍换取绝对平滑（远端本来就没有"手感"只有"观感"）。两者都在 (0, 1] 内，
 * 都仍然是"在两个权威点之间取值"。
 */
export const SELF_DELAY_TICKS = 0.5;
export const PEER_DELAY_TICKS = 1;

export class MotionInterpolator<T extends MotionEntity> {
  private readonly tracks = new Map<string, MotionTrack>();
  private clock = 0;
  private latestTick = 0;
  private tickMs = DEFAULT_TICK_MS;
  private started = false;
  private readonly delayTicks: number;
  private readonly teleportDistance: number;
  private readonly maxInterpTicks: number;
  private readonly slewGain: number;
  private readonly maxSlew: number;
  private readonly resyncTicks: number;

  constructor(options: MotionOptions = {}) {
    this.delayTicks = options.delayTicks ?? PEER_DELAY_TICKS;
    this.teleportDistance = options.teleportDistance ?? 600;
    this.maxInterpTicks = options.maxInterpTicks ?? 6;
    this.slewGain = options.slewGain ?? 0.25;
    this.maxSlew = options.maxSlew ?? 0.35;
    this.resyncTicks = options.resyncTicks ?? 10;
  }

  /**
   * 登记一份权威快照。可以每帧调用：同一个 `serverTick` 只会被记一次，
   * 旧 tick 直接忽略（重排的 UDP/WS 帧不该让角色倒退）。
   * 不在本次快照里的 id 会被清掉，避免换图后残留一条旧轨迹。
   */
  observe(entities: readonly T[], serverTick: number, tickMs: number = DEFAULT_TICK_MS): void {
    if (!Number.isFinite(serverTick) || !Number.isFinite(tickMs) || tickMs <= 0) return;
    this.tickMs = tickMs;
    const seen = new Set<string>();
    for (const entity of entities) {
      if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue;
      seen.add(entity.id);
      const track = this.tracks.get(entity.id);
      if (!track) {
        // 第一次出现：没有"上一拍"可插值，直接站在它自己的位置上。
        this.tracks.set(entity.id, {
          prev: { tick: serverTick, x: entity.x, y: entity.y },
          latest: { tick: serverTick, x: entity.x, y: entity.y },
          teleported: true,
        });
        continue;
      }
      if (serverTick < track.latest.tick) continue;
      if (serverTick === track.latest.tick) {
        // 同一拍重复投递（例如 create() 里补发的 pending 快照）：只刷新坐标。
        track.latest.x = entity.x;
        track.latest.y = entity.y;
        continue;
      }
      const gap = serverTick - track.latest.tick;
      const distance = Math.hypot(entity.x - track.latest.x, entity.y - track.latest.y);
      track.prev = track.latest;
      track.latest = { tick: serverTick, x: entity.x, y: entity.y };
      track.teleported = gap > this.maxInterpTicks || distance > this.teleportDistance;
    }
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id);
    if (serverTick > this.latestTick) {
      const first = !this.started;
      this.latestTick = serverTick;
      if (first) {
        // 首次对齐到目标而不是最新拍，否则开头几百毫秒会贴着最新样本走（无插值）。
        this.started = true;
        this.clock = serverTick - this.delayTicks;
      }
    }
  }

  /** 推进渲染时钟。`deltaMs` 是这一帧的真实耗时（毫秒）。 */
  advance(deltaMs: number): void {
    if (!this.started || this.tickMs <= 0) return;
    const step = (Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0) / this.tickMs;
    const target = this.latestTick - this.delayTicks;
    const error = target - this.clock;
    if (Math.abs(error) > this.resyncTicks) {
      // 断流恢复：滑行要几十帧才追平，直接对表代价更小。
      this.clock = target;
      return;
    }
    // 只调速率、不倒流：rate 恒为正（maxSlew < 1），落后就跑快点，超前就跑慢点。
    const rate = clamp(1 + error * this.slewGain, 1 - this.maxSlew, 1 + this.maxSlew);
    // 不超过最新样本 ⇒ 不外推。
    this.clock = Math.min(this.clock + step * rate, this.latestTick);
  }

  /**
   * 返回一份**只改了 x/y**的实体副本：动作、朝向、血量等一律取最新样本。
   * 没有轨迹／刚出现／刚瞬移时原样返回。
   */
  render(entity: T): T {
    const track = this.tracks.get(entity.id);
    if (!track || track.teleported) return entity;
    const { prev, latest } = track;
    const span = latest.tick - prev.tick;
    if (span <= 0) return entity;
    const f = clamp((this.clock - prev.tick) / span, 0, 1);
    if (f <= 0) return { ...entity, x: prev.x, y: prev.y };
    if (f >= 1) return entity;
    return {
      ...entity,
      x: prev.x + (latest.x - prev.x) * f,
      y: prev.y + (latest.y - prev.y) * f,
    };
  }

  /** 换图／重连：轨迹与时钟一起丢掉，新图的第一拍重新对齐。 */
  reset(): void {
    this.tracks.clear();
    this.clock = 0;
    this.latestTick = 0;
    this.started = false;
  }

  /** 当前渲染时钟（单位＝服务端 tick，浮点）。仅供诊断与门禁断言使用。 */
  get renderTick(): number {
    return this.clock;
  }

  /** 已收到的最新权威 tick。 */
  get newestTick(): number {
    return this.latestTick;
  }

  /** 当前保有的轨迹条数（用于门禁断言"离开视野的实体被清掉"）。 */
  get trackCount(): number {
    return this.tracks.size;
  }
}
