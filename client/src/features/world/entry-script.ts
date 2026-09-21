/**
 * 源地图入口脚本（`Map.wz .../info/onFirstUserEnter` / `onUserEnter`）的运行时消费者。
 *
 * ## 为什么需要它
 * 导出器把源的两个字段原样装配成 `manifest.mapCatalog.maps[].entryScripts`
 * （顶层 `manifest.map.entryScripts` 同样），`scripts/export_tms273.cjs` 是唯一生产者。
 * 但在本次改动之前**没有任何消费者**：客户端与服务端都不读它，于是「源地图自己声明的
 * 入图行为」整类静默失效——地图声明了什么都不会发生。
 *
 * ## 只落地一个脚本：`warning_MobLevel`
 * 它是源作者给「图内怪物等级明显高于玩家」的地图挂的越级警告。全装配目录 198 张图里
 * 只有两张声明了它，恰好是 Perion 片区唯一的越级图，且都与低等级区只隔**一个**传送门：
 *   - `102030000 黑肥肥領土`：22 × `2230102 黑肥肥` + 16 × `2230112`，Lv55 / HP8000；
 *     西邻 `102020100 風塵山丘`（Lv2x 区）。是 `job-211`/`job-231`（**三转 Lv60**）试炼
 *     要求击杀 30 只的目标怪，即这张图本是为 Lv60 角色准备的猎场。
 *   - `102040000 初期挖掘地區`：Lv60 区。
 * 两条线索都是源作者的设计（那扇门在源 `portal` 里就有，不是装配错误），**缺的只是
 * 这条提示**：没有它，玩家会一声不响走进 +1x 级区域，把「打不动」当成怪物坏了。
 *
 * ## 判据：只用可核事实，不设阈值
 *   1. 该图声明了 `warning_MobLevel`；
 *   2. 该图内**当前已刷新**的怪物里，最高等级确实高于玩家等级。
 * 两条都成立才出提示，所以提示永远为真——等级够的玩家不会被无意义地打扰。
 *
 * **为什么第 1 条不能换成一个等级差阈值**：全装配目录里有 59 张图的最高怪等级 ≥ 55
 * （愛奧斯塔 22102xxxx、危險地帶 22103xxxx、苔蘚森林 300xxxxx…），而声明了本脚本的
 * 只有 2 张。也就是说它绝对是源作者**逐图手工**挂的提示，不是可以推导出来的通用规则。
 * 任何「等级差 ≥ N → 警告」的写法都会在那另外 57 张图上多出源里没有的提示。
 * `entry-script.check.mjs` 把这个包含关系（声明集 ⊊ 越级集）钉成断言。
 *
 * 源的脚本体不在 273 资源包里（`script/map/onUserEnter/` 共 167 个脚本，其中没有
 * `warning_MobLevel.js`；它是官方客户端内建），因此**「高多少级才算高」这类规则没有
 * 依据可循，本项目不发明**。本模块只做判定；显示的句子是 UI 字串，只报告事实（该图
 * 最高怪物等级 / 玩家等级），由调用方排版。
 *
 * ## 不负责
 * - 换图节奏与快照：`scenes/world.ts`（`switchMap`）。
 * - 出图与字串：`app/main.ts` 交给 `ChatView.appendSystem`。
 * - 其余入口脚本：`onFirstUserEnter`（`manifest…entryScripts.first`）与 `each` 里其它
 *   脚本名（`go*` / `enter_*` / `explorationPoint` / `VIWarmingUp_*` …）本轮不落地，
 *   它们的脚本体同样不在资源包里。
 */

/** 源 `info/onUserEnter` 里唯一的越级警告脚本名。 */
export const WARNING_MOB_LEVEL_SCRIPT = 'warning_MobLevel';

export interface MapEntryScripts {
  first?: string;
  each?: string;
}

export interface MapEntryWarning {
  /** 源脚本名原样透出，便于日志与断言。 */
  script: string;
  /** 该图内已刷新怪物的最高等级（源 `Mob/<id>.json/info/level`）。 */
  monsterLevel: number;
  playerLevel: number;
}

/**
 * 判定一次入图是否该出「怪物等级」警告；不该出时返回 `undefined`。
 *
 * `monsters` 必须是**服务端快照**里的怪物列表（权威事实），`monsterLevel` 由调用方
 * 从 `manifest.monsters[templateId].info.level` 解析——等级不在本模块猜，也不兜底成 0
 * （缺等级的模板直接跳过，宁可少警告一次，也不给一个假数字）。
 */
export function mapEntryWarning(input: {
  scripts?: MapEntryScripts | undefined;
  playerLevel?: number | undefined;
  monsters: readonly { templateId: string }[];
  monsterLevel: (templateId: string) => number | undefined;
}): MapEntryWarning | undefined {
  const script = input.scripts?.each;
  if (script !== WARNING_MOB_LEVEL_SCRIPT) return undefined;
  const playerLevel = input.playerLevel;
  if (playerLevel === undefined || !Number.isFinite(playerLevel)) return undefined;
  let monsterLevel: number | undefined;
  for (const monster of input.monsters) {
    const level = input.monsterLevel(monster.templateId);
    if (level === undefined || !Number.isFinite(level)) continue;
    if (monsterLevel === undefined || level > monsterLevel) monsterLevel = level;
  }
  if (monsterLevel === undefined || monsterLevel <= playerLevel) return undefined;
  return { script, monsterLevel, playerLevel };
}
