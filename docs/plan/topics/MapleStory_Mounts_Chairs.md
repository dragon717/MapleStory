# 坐骑（30）与椅子（31）：逐文件改动与新增实现

> 依据：`docs/plan/topics/MapleStory_Replica_Audit_Code_Map_2026-09-18_c50b564.md` 第 30、31 项。
> 固定基线：`main@c50b5647a9a57fb00cd4947559d41eb5b694885f`，协议 `24`，内容 `tms273-31`。
> 路径约定同审计表：`F/`＝`client/src/features/`；`B/`＝`server/src/`；`A/`＝`server/src/auth/`；`D/`＝`shared/`。
>
> 本文只覆盖这两项。**不重写既有物品持有与穿脱**：`equip_items`/`unequip_items`、
> `auth::Store::use_item_with_max_mp` 的装备分支、`F/inventory/` 的拖动与格子渲染一律保持，
> 新代码只在其上游做**分类**与**会话状态**，并在既有函数里加**具名分支**。

---

## 0. 已核源事实（本轮逐字段读出，无一处估算）

全部读自 `参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/` 与源 WZ
（`参考/273/TMS273少爷一键端/客户端/TMS273.7/Data`，用 `scripts/tms273_wz.cjs` 探针直读）。

| 事实 | 证据 | 用途 |
| --- | --- | --- |
| 骑宠装备是**装备栏物品**，槽位 `Tm`(−18) / `Sd`(−19) | `Character/TamingMob/01902000.json`：`info.islot="Tm"`、`info.tamingMob=1`、`reqLevel=60`；`01912000.json`：`info.islot="Sd"`、名字「馬鞍」 | 复用既有 `equipment_slot`，不新造槽位 |
| 骑行数值在源档里 | `TamingMob/0001.json`：`speed=150 jump=120 fs=10 swim=100 fatigue=5` | 移动与跳跃倍率的**唯一**数值来源 |
| 骑乘有自己的动作帧 | `Character/TamingMob/01902000.img` 顶层：`info, walk1, walk2, stand1, stand2, tired, jump, prone, ladder, rope, fly`；`stand1` 6 帧 ×180ms、`walk1` 4 帧 ×120ms | 骑乘可移动；**无任何 `swing*`/`shoot*` 帧** ⇒ 骑乘不能施放攻击/技能 |
| 角色坐姿帧在源里 | `Character/00002000.img/sit`（1 帧，部件 `body/arm/face`，**无 `delay`**）；`00012000/01002067/01040002/01052095/01070000/00030020` 均有 `sit`；`Face/00020000.img` **无** `sit` | 坐姿走角色自身 `sit`，不是椅子贴图 |
| 椅子是设置栏物品 | `Item/Install/03010/03010001.json`：`inventoryType 3`、`info.price=500, slotMax=1, recoveryHP=35, reqLevel=6`；`03010018`：`recoveryHP=40, recoveryMP=20` | 恢复量用源字段，不估算 |
| 恢复**间隔**没有源字段 | 584 件 `Item/Install/03010.img/*` 全查过：**无 `sit` 节点**；`info` 无间隔键；只有 `String/Ins.json` 文案写「每N秒」（1192 件写「每10秒」，173 件有恢复字段但文案未写间隔） | 间隔按文案导出；文案没写就**不导出**，运行时按「未核定」处理 |
| 椅子自身只有图标与特效 | `03010001` 的键是 `info`(`icon,iconRaw,price,slotMax,recoveryHP,reqLevel`) + `effect`(`0,z,pos`) | 表现层不需要椅子坐姿贴图 |

---

## 1. 数据层（**已交付**）

### 1.1 新增 `scripts/export_tms273_mounts_chairs.cjs`（已落盘）

源 → 两张新表的导出器。**不**写 `items.json`：该文件是可达性驱动的
（`generate_tms273_gameplay.py` 从掉落/商店/任务/建角装备收集），而骑宠与椅子在源里是
`notSale:1 / only:1`，塞进去会改变图鉴与笔记本的「可获得分母」。因此照 `D/pets.json`
的先例单独成表，由 `B/inventory.rs` 在 `items.json` 未命中时回落。

### 1.2 新增 `D/mounts.json`、`D/chairs.json`（已生成，并镜像到 `client/public-tms273/assets/`）

实测产出（`node scripts/export_tms273_mounts_chairs.cjs`）：

```text
导出坐骑 935 件（887 件带已核定骑行数值，坐骑档 24 个）、椅子 2797 件（1192 件带已核定恢复间隔）。
未登记：非装备图 1021、无名 840、缺坐骑档 1；椅子间隔未核定 173。
```

**表里 935 件 ≠ 935 件能骑**（逐件重算得出，勿混；`_` 为两个不同判据，别相互代入）：

| 槽 | 源 `islot` | 件数 | 带 `tamingMob` | 不带 `tamingMob` | 可骑（骑行数值已核定） |
| --- | --- | --- | --- | --- | --- |
| Tm | −18 | 909 | **888** | 21 | **887** |
| Sd | −19 | 26 | **0** | 26 | **0** |
| 合计 | | 935 | 888 | 47 | 887 |

* 「带 `tamingMob`」与「可骑」**不是同一个数**（888 vs 887），因为 `1932057` 写了
  `tamingMob=16` 而坐骑档 16 在源里缺席（`skipped.missingRideStats`）：它过得了
  `is_mount_item()`（判据只看 `tamingMob` 字段在不在），但 `resolve_mount` 取不到
  骑行数值 ⇒ 骑上去会被拒。少 1 是源的事实，不是漏算。
* 不带 `tamingMob` 的 47 件**源里就没有该字段**：`1902xxxx` 现金件 21 件如
  `1902004`「小木馬」、`1912xxxx` 共 26 件即 `Sd` 槽整族，如 `1912000`「馬鞍」。
* **`Sd` 槽 26 件全部不可骑** ⇒ `resolve_mount` 的 −19 分支在现行源包下**永不命中**，
  保留它只是防御（见 §3.2）；马鞍是搭在坐骑上的饰品，`tamingMob` 由 `Tm` 件带。
* 上述 47 件穿在 `Tm`/`Sd` 槽上时，按 `is_mount_item()` 判定为「不是坐骑」，
  骑乘请求一律拒绝 `no_mount_equipped`——**不套默认速度、也不回落成普通装备**。

```jsonc
// D/mounts.json（节选）
"items": {
  "1902000": { "inventoryType": 1, "slotMax": 1,
    "info": { "islot": "Tm", "vslot": "Tm", "tuc": 0, "reqJob": 0, "reqLevel": 60,
              "tamingMob": 1, "tradeBlock": 1, "notSale": 1, "only": 1 },
    "source": "Character/TamingMob/01902000.json",
    "spriteSource": "Character/TamingMob/01902000.img/info/icon",
    "spriteSourceStatus": "wz-present-unextracted",
    "name": "野豬",
    "ride": { "speed": 150, "jump": 120, "fs": 10, "swim": 100, "fatigue": 5,
              "source": "TamingMob/0001.json" } },
  "1912000": { "info": { "islot": "Sd", "vslot": "Sd", ... }, "name": "馬鞍", ... }
},
"mobs": { "1": { "speed": 150, "jump": 120, "fs": 10, "swim": 100, "fatigue": 5,
                 "source": "TamingMob/0001.json" }, ... },
"skipped": { "nonEquipment": 1021, "unnamed": 840,
             "missingRideStats": [ { "itemId": "1932057", "tamingMob": "16" } ] }
```

```jsonc
// D/chairs.json（节选）
"items": {
  "3010001": { "inventoryType": 3, "slotMax": 1,
    "info": { "price": 500, "slotMax": 1, "recoveryHP": 35, "reqLevel": 6 },
    "source": "Item/Install/03010/03010001.json",
    "spriteSource": "Item/Install/03010.img/03010001/info/icon",
    "spriteSourceStatus": "wz-present-unextracted",
    "name": "藍色木椅",
    "description": "只有在維多利亞港製作販售的藍色木椅。坐在上面每10秒可恢復HP 35。",
    "recoveryIntervalMs": 10000,
    "recoveryIntervalSource": "P: String/Ins.json 3010001.desc「每10秒」；源 info 无间隔字段" }
},
"counts": { "total": 2797, "withInterval": 1192, "intervalUnverified": 173 }
```

自检：`chairs.json["3010001"]` 的 `source` / `spriteSource` / `info` 与既有
`items.json["3010001"]` **逐键相同**（同一件事在两份表里不打架）。

### 1.3 装配接线（三处，各一行）

```js
// scripts/assemble_tms273.cjs，紧跟 items 装配之后
// 骑宠/椅子是与 items.json 平级的两张源目录（D/pets.json 的先例）：既不并入
// items.json（会改图鉴分母），也不复制进候选版本，只镜像到浏览器侧一份。
for (const name of ['mounts', 'chairs']) {
  const value = read(name);
  write(path.join(publicRoot, 'assets', `${name}.json`), value);
}
```

```python
# scripts/generate_tms273_gameplay.py::main()，在写 items.json 之后
# 骑宠与椅子的目录与 items.json 同源同时刻产出，避免"表在物品表缺"的半装配态。
subprocess.run([sys.executable, "-c", "import subprocess,sys;subprocess.check_call(['node','scripts/export_tms273_mounts_chairs.cjs'],cwd=ROOT)"], check=True)
```

```js
// scripts/check_windows_resources.cjs 的资源清单（两个入口都要）
  'shared/mounts.json', 'shared/chairs.json',
  'client/public-tms273/assets/mounts.json', 'client/public-tms273/assets/chairs.json',
```

> `scripts/package_win_bundle.cjs` 的 `FILES`/`DIRS` 是**手写**清单：`shared/` 整目录已在
> `DIRS` 里则无需单列，但 `client/public-tms273/assets/` 若按目录整棵复制也已覆盖；
> 若清单是逐文件列举，**必须**同步四个路径，否则到 Windows 才以缺表炸在资源校验。

---

## 2. 协议契约

### 2.1 客户端意图：**复用既有 `useItem`，不新增消息类型**

| 动作 | 客户端发送（既有形状） | 服务端语义 |
| --- | --- | --- |
| 骑乘切换 | `useItem{ inventoryType:1, sourceSlot:-18\|-19, itemId }` | 双击**已装备**的骑宠：骑上／下马 |
| 坐下／起立 | `useItem{ inventoryType:3, sourceSlot, itemId }` | 双击设置栏椅子：坐下／起立 |

理由：两条路都不消耗道具、不改背包，但都需要 `requestId` 去重与重放原结果——这正是既有
`useItem` 通道已经具备的（`A/bag.rs` 的 `inventory_actions` 与世界的
`self.inventory_requests`）。新增消息类型会强制 `protocolVersion` 变更，而快照本就是
`serde_json` 拼装、可加可选字段，因此**协议版本保持 `24` 不变**。

### 2.2 快照：两个**可选**行字段（加法，不改既有字段语义）

```jsonc
// snapshot.players[i]
"mount": { "itemId": "1902000", "tamingMob": 1,
           "speed": 150, "jump": 120, "fs": 10, "fatigue": 5 },
"chair": { "itemId": "3010001", "recoveryHp": 35, "recoveryMp": 0,
           "recoveryIntervalMs": 10000, "nextRecoveryInMs": 7300 }
```

### 2.3 `shared/protocol.ts` 改动

```ts
/** 骑乘状态（协议 24 加法字段）。全部由服务端从**已装备**的骑宠行与源坐骑档推出；
 *  客户端只读，永远不能上报「我在骑」「我骑的是哪只」。 */
export interface MountState {
  /** 已装备的骑宠装备 id（源 islot Tm/Sd，身体槽 −18/−19）。 */
  itemId: string;
  /** 源 `info.tamingMob` 指向的坐骑档 id。 */
  tamingMob: number;
  /** 以下全部来自源 `TamingMob/<id>.json/info`，不是运行时系数。 */
  speed: number; jump: number; fs: number; fatigue: number;
}
/** 坐姿状态（协议 24 加法字段）。坐姿是**会话状态**：不落库，重连/换图/死亡即结束。 */
export interface ChairState {
  itemId: string;
  /** 源 `info.recoveryHP` / `recoveryMP`（缺席即 0）。 */
  recoveryHp: number; recoveryMp: number;
  /** 恢复间隔；**缺席**表示该椅子的间隔未核定（`String/Ins.json` 文案没写「每N秒」），
   *  此时服务端不恢复，客户端也不得显示倒计时。 */
  recoveryIntervalMs?: number;
  nextRecoveryInMs?: number;
}
```

`PlayerState` 追加两个可选字段：

```ts
  /** 骑乘中才有；服务端从已装备的骑宠行导出。 */
  mount?: MountState;
  /** 坐在椅子上才有；服务端从设置栏实物导出。 */
  chair?: ChairState;
```

`action` 联合类型追加 `'sit'`：

```ts
  action: 'stand' | 'walk' | 'jump' | 'attack' | 'climb' | 'ladder' | 'rope' | 'dead' | 'sit';
```

> **不给 `ride` 加 action 取值**：骑乘时的动作仍是 `stand/walk/jump`（源的
> `Character/TamingMob/01902000.img/stand1|walk1|jump` 就是这四个的对应帧），
> 骑乘是**叠加状态**而非第四种动作。这样 `F/player/` 的动作路由不需要为骑乘开新分支。

---

## 3. 服务端逐文件改动

### 3.1 `B/inventory.rs`

**(a) 新增两张源目录表 + 分类函数**（插在 `item_definition` 之后、`item_name` 之前）

```rust
/// 骑宠目录（`shared/mounts.json`）。与 `shared/pets.json` 同一先例：骑宠在源里
/// `notSale/only`、不进掉落与商店，因此不在可达性驱动的 `items.json` 里。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountItemDefinition {
    #[serde(default)]
    info: BTreeMap<String, Value>,
    #[serde(default)]
    ride: Option<RideStats>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct RideStats {
    pub speed: i64,
    pub jump: i64,
    pub fs: i64,
    pub swim: i64,
    pub fatigue: i64,
}

#[derive(Deserialize)]
struct MountCatalogFile {
    items: BTreeMap<String, MountItemDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChairItemDefinition {
    #[serde(default)]
    info: BTreeMap<String, Value>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    recovery_interval_ms: Option<i64>,
}

#[derive(Deserialize)]
struct ChairCatalogFile {
    items: BTreeMap<String, ChairItemDefinition>,
}

fn shipped_mounts() -> &'static BTreeMap<String, MountItemDefinition> {
    static SHIPPED: OnceLock<BTreeMap<String, MountItemDefinition>> = OnceLock::new();
    SHIPPED.get_or_init(|| {
        serde_json::from_str::<MountCatalogFile>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/mounts.json"
        )))
        .expect("shared/mounts.json must be valid")
        .items
    })
}

fn shipped_chairs() -> &'static BTreeMap<String, ChairItemDefinition> {
    static SHIPPED: OnceLock<BTreeMap<String, ChairItemDefinition>> = OnceLock::new();
    SHIPPED.get_or_init(|| {
        serde_json::from_str::<ChairCatalogFile>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/chairs.json"
        )))
        .expect("shared/chairs.json must be valid")
        .items
    })
}

/// 骑宠装备（源 `info.islot` 为 `Tm`/`Sd`）。
///
/// 判定只用源字段 `tamingMob`，**不用**物品名或 id 段：`Tm` 槽同时被機械師的
/// 引擎/手臂/腳/身軀/電晶體占用（`Character/Mechanic/01612000..`），按 islot 判会
/// 把機械師整套装备误认成坐骑。
pub fn is_mount_item(item_id: &str) -> bool {
    shipped_mounts()
        .get(item_id)
        .and_then(|mount| value_i64(mount.info.get("tamingMob")))
        .is_some_and(|taming_mob| taming_mob > 0)
}

/// 骑宠的已核定骑行数值。缺席 = 该件源里没有坐骑档（`skipped.missingRideStats`），
/// 此时**不**允许骑乘，而不是套一个默认速度。
pub fn ride_stats(item_id: &str) -> Option<RideStats> {
    shipped_mounts().get(item_id).and_then(|mount| mount.ride)
}

/// 骑宠指向的源坐骑档 id（`info.tamingMob`）。快照要把它带出去，客户端才能
/// 知道要画哪一只；没有它就只能显示物品名。
pub fn mount_taming_mob(item_id: &str) -> Option<i64> {
    shipped_mounts()
        .get(item_id)
        .and_then(|mount| value_i64(mount.info.get("tamingMob")))
        .filter(|taming_mob| *taming_mob > 0)
}

/// 椅子：设置栏物品（`inventoryType 3`）且有源 `info.recoveryHP/recoveryMP`。
pub fn is_chair_item(item_id: &str) -> bool {
    chair_definition(item_id).is_some()
}

fn chair_definition(item_id: &str) -> Option<&'static ChairItemDefinition> {
    shipped_chairs()
        .get(item_id)
        .filter(|chair| info_i64_of(&chair.info, "recoveryHP").unwrap_or(0) > 0
            || info_i64_of(&chair.info, "recoveryMP").unwrap_or(0) > 0)
}

/// 坐姿的恢复量与间隔。`interval_ms` 为 `None` 表示源文案没写「每N秒」⇒ 间隔未核定，
/// 调用方必须**不恢复**（见 `B/chairs.rs`）。
pub fn chair_recovery(item_id: &str) -> Option<(i64, i64, Option<i64>)> {
    let chair = chair_definition(item_id)?;
    Some((
        info_i64_of(&chair.info, "recoveryHP").unwrap_or(0),
        info_i64_of(&chair.info, "recoveryMP").unwrap_or(0),
        chair.recovery_interval_ms,
    ))
}

/// `info` 是**已经读进来**的平表，不能再走 `item_definition`（那是 items.json）。
fn info_i64_of(info: &BTreeMap<String, Value>, key: &str) -> Option<i64> {
    value_i64(info.get(key))
}
```

**(b) 改 `equipment_slot`：`items.json` 未命中时回落到骑宠表**

```rust
pub fn equipment_slot(item_id: &str) -> Option<i16> {
    // 骑宠的 `islot` 在 mounts.json 而不在 items.json（见 shipped_mounts 的注释）。
    // 这一层回落**不改**既有映射表：Tm/Sd 仍在下面同一张 match 里，两句都指向
    // −18/−19，不存在第二套槽位口径。
    let slot = item_definition(item_id)
        .and_then(|item| item.info.get("islot"))
        .and_then(Value::as_str)
        .or_else(|| {
            shipped_mounts()
                .get(item_id)
                .and_then(|mount| mount.info.get("islot"))
                .and_then(Value::as_str)
        })?;
    let slot = match slot {
        // ... 既有 22 行映射**一字不动** ...
        "Tm" => -18,
        "Sd" => -19,
        _ => return None,
    };
    Some(slot)
}
```

**(c) 两处收口，让下游不必各自记得两张新表**

```rust
/// 物品目录（含骑宠/椅子）里是否有这件东西。GM `/add` 走它，因此骑宠与椅子
/// 可以像源里那样被发放用于验证——与「槽位扩充券在杂货店售卖作为可双测入口」
/// 同一种 P 级适配，区别只是发放通道。
pub fn catalog_contains(item_id: &str) -> bool {
    catalog().contains_key(item_id)
        || shipped_mounts().contains_key(item_id)
        || shipped_chairs().contains_key(item_id)
}

/// 显示名：items.json → 骑宠 → 椅子 → 宠物 → id。
pub fn item_name(item_id: &str) -> Option<&'static str> {
    if let Some(name) = item_definition(item_id).and_then(|item| item.name.as_deref()) {
        return Some(name);
    }
    shipped_mounts()
        .get(item_id)
        .and_then(|mount| mount.name.as_deref())
        .or_else(|| shipped_chairs().get(item_id).and_then(|chair| chair.name.as_deref()))
}
```

**(d) 新增错误码：** `InventoryError` 追加一个变体（第 3.5、3.6 节要用）

```rust
    /// 骑乘与坐姿是服务器**会话状态**，没有可落库的字段，因此不存在
    /// 「持久化事务里的使用分支」。走到这里说明调用方绕过了世界侧，
    /// 需要一个**具名**结果：末尾那个 `InvalidInventoryType` 的含义是
    /// 「栏位非法」，而设置栏(3)与装备槽(−18/−19)都是合法栏位。
    SessionStateOnly,
```

`code()` 追加：

```rust
            Self::SessionStateOnly => "session_state_only",
```

> 客户端文案表与 `scripts/check_protocol_errors.cjs` 门禁必须同步补该码，否则门禁红。

### 3.2 新增 `B/mounts.rs`

```rust
//! 坐骑（第 30 项）：装备层基础之上的**骑乘切换 / 骑乘状态 / 移动 / 表现**。
//!
//! 边界（与既有模块的分工）：
//! * 持有与穿脱仍归 `inventory::equip_items` / `unequip_items` 与
//!   `auth::Store` —— 本模块**不**移动任何物品；
//! * 骑乘数值（speed/jump/fs/swim/fatigue）来自源档 `TamingMob/<id>.json/info`，
//!   由 `inventory::ride_stats` 提供，本模块不估算、不设默认值；
//! * 骑乘状态是**会话状态**：不落库，且有唯一的结束点 `end()`。
//!
//! 源的硬约束（探针直读 `Character/TamingMob/01902000.img`）：骑宠的动作集合是
//! `stand1 stand2 walk1 walk2 jump tired prone ladder rope fly`，**没有任何
//! `swing*`/`shoot*` 帧** ⇒ 骑乘中不能发动普攻与技能，这是源数据支持的事实，
//! 不是设计取舍。
//!
//! 未核定（P，逐条注明依据，不冒充官方规则）：
//! * 骑乘的**开关条件**（等级/地图/疲劳）：源包没有可执行规则，本实现只要求
//!   「装备栏里确实有该骑宠 + 骑行数值已核定 + 不在空中/绳上/水中/坐姿/死亡」；
//! * `fatigue` 的消耗节奏：源只给初始值 `5`，没有衰减公式 ⇒ **只上快照、不扣减**；
//! * `ladder`/`rope`/`fly` 帧虽存在，但「骑乘中能否上下绳/飞行」源里没有规则 ⇒
//!   一律按「上绳、入水即下马」收口。

use super::*;

/// 骑宠的身体槽（正数，与 `PlayerState.equipped[].slot` 同一口径：
/// `equip_items` 写入的是 `to_slot.unsigned_abs()`）。
pub(super) const MOUNT_BODY_SLOTS: [u16; 2] = [18, 19];

/// 一次骑乘会话的权威状态。**只**由 `Player::state.equipped` 里的实物重建，
/// 因此「卸下坐骑」这一类外部改动不需要额外的失效通知：每拍 `step` 都对账。
#[derive(Clone, Debug, PartialEq)]
pub(super) struct MountRuntime {
    pub item_id: String,
    pub taming_mob: i64,
    pub ride: inventory::RideStats,
}

impl World {
    /// 从权威装备解析骑宠。**任一** −18/−19 槽上是带 `tamingMob` 的装备行即成骑宠；
    /// 骑行数值未核定的那一件（源里引用不存在的坐骑档）**不算**，因为它没有速度可依。
    ///
    /// 现行源包里 `Sd` 槽 26 件**全不带** `tamingMob`（§1.2 表），所以 −19 这一步实际
    /// 永不命中；留着它是防御，不是第二条规则。`Tm` 槽里另有 21 件非坐骑（现金件），
    /// 它们被 `is_mount_item` 挡在门外——按 islot 判会把这 21 件与機械師整套一起误认成坐骑。
    pub(super) fn resolve_mount(equipped: &[InventoryItem]) -> Option<MountRuntime> {
        MOUNT_BODY_SLOTS.iter().find_map(|slot| {
            let item = equipped.iter().find(|item| item.slot == *slot)?;
            if !inventory::is_mount_item(&item.item_id) {
                return None;
            }
            let ride = inventory::ride_stats(&item.item_id)?;
            let taming_mob = inventory::mount_taming_mob(&item.item_id)?;
            Some(MountRuntime {
                item_id: item.item_id.clone(),
                taming_mob,
                ride,
            })
        })
    }

    /// 骑上／下马。`toggle` 是纯粹的开关：**不**消耗物品、**不**改装备。
    ///
    /// 拒绝码沿用本仓既有的拒绝通道（`send_inventory_outcome` 的 `success:false`
    /// + code），不新造拒绝消息。
    ///
    /// 借用形状：判据只在**不可变**借用里算完，答复/落台账在借用结束之后。
    /// `Player` 与 `World` 在 `self` 里是两块独立字段，但同时借会撞借用检查器；
    /// 「先判定、后落地」也让这段逻辑没有中间态。
    pub(super) fn mount_toggle(
        &mut self,
        id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
    ) {
        let tick = self.tick;
        enum Decision {
            Toggle,
            Reject(&'static str),
        }
        let decision = {
            let Some(player) = self.players.get(id) else {
                return;
            };
            match World::resolve_mount(&player.state.equipped) {
                None => Decision::Reject("no_mount_equipped"),
                Some(mounted) => {
                    // ① 身份复核：请求里的槽与 id 必须与**权威装备**逐字对上。
                    //    客户端只说"我双击了 −18 槽上的这件"，那一槽现在是什么由
                    //    服务端自己决定，因此伪造一个 id 只会拿到 `mount_mismatch`。
                    let actual_slot = player
                        .state
                        .equipped
                        .iter()
                        .find(|item| item.item_id == mounted.item_id)
                        .map_or(0, |item| item.slot);
                    let claimed_slot = u16::try_from(source_slot.unsigned_abs()).unwrap_or(0);
                    if mounted.item_id != item_id || claimed_slot != actual_slot {
                        Decision::Reject("mount_mismatch")
                    } else if player.mount.is_some() {
                        // 下马永远允许：唯一一条不受状态限制的路径。
                        Decision::Toggle
                    } else if player.state.hp <= 0 || player.state.action == "dead" {
                        Decision::Reject("mount_dead")
                    } else if player.state.climbing {
                        Decision::Reject("mount_climbing")
                    } else if !player.state.grounded {
                        Decision::Reject("mount_airborne")
                    } else if player.swimming {
                        Decision::Reject("mount_swimming")
                    } else if player.chair.is_some() {
                        Decision::Reject("mount_seated")
                    } else if player.channel_until > tick {
                        Decision::Reject("mount_busy")
                    } else {
                        Decision::Toggle
                    }
                }
            }
        };
        let (success, code) = match decision {
            Decision::Reject(code) => (false, code.to_owned()),
            Decision::Toggle => {
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                if player.mount.is_some() {
                    player.mount = None;
                } else {
                    // 再解析一次：上面那段只读借用已经结束，`mount` 只可能从
                    // 权威装备派生，不存在"客户端说骑哪只就骑哪只"。
                    player.mount = World::resolve_mount(&player.state.equipped);
                }
                // 开关必然改变姿态：起始拍换掉，否则客户端会沿用上一个姿态的
                // 已播帧（与 `reset_player_to_spawn` 同一手法）。
                player.state.action_started_tick = tick;
                (true, String::new())
            }
        };
        let outcome = mount_outcome(request_id, inventory_type, source_slot, item_id, success, &code);
        self.inventory_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        self.send_inventory_outcome(id, &outcome);
        if success {
            self.send_snapshot(id);
        }
    }

    /// 每拍对账：装备里的骑宠没了（卸下/换装→地面掉落/交易）就下马。
    /// 这条是**唯一**能让骑乘在无输入情况下结束的路径，因此必须是「对账」而不是
    /// 「事件」——任何能在别处移动装备的代码路径都自动被覆盖。
    pub(super) fn step_mount(&mut self, id: &str) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        if player.mount.is_none() {
            return;
        }
        match World::resolve_mount(&player.state.equipped) {
            Some(current) => {
                if player.mount.as_ref() != Some(&current) {
                    player.mount = Some(current);
                }
            }
            None => player.mount = None,
        }
    }

    /// 结束骑乘的唯一出口。`rationale` 只进日志/诊断，不改变行为。
    pub(super) fn dismount(&mut self, id: &str, rationale: &'static str) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        if player.mount.take().is_some() {
            player.state.action_started_tick = self.tick;
            let _ = rationale;
        }
    }

    /// `mount` 快照行。只在骑乘中出现，因此健康/未骑乘的玩家行不变形。
    pub(super) fn mount_snapshot_field(player: &Player) -> Option<serde_json::Value> {
        let mount = player.mount.as_ref()?;
        Some(serde_json::json!({
            "itemId": mount.item_id,
            "tamingMob": mount.taming_mob,
            "speed": mount.ride.speed,
            "jump": mount.ride.jump,
            "fs": mount.ride.fs,
            "fatigue": mount.ride.fatigue,
        }))
    }

    /// 骑乘对移动的作用：源 `speed`/`jump` 是**百分比口径**的坐骑属性
    /// （100 = 常规），角色的基础位移常量保持不变，乘数只在这里出现一次。
    ///
    /// 取整只在末端一次：先乘再一次性截断，不在中间步骤各自 round。
    pub(super) fn mount_walk_speed(player: &Player, base: f64) -> f64 {
        match player.mount.as_ref() {
            Some(mount) => base * (mount.ride.speed as f64 / 100.0),
            None => base,
        }
    }

    pub(super) fn mount_jump_speed(player: &Player, base: f64) -> f64 {
        match player.mount.as_ref() {
            Some(mount) => base * (mount.ride.jump as f64 / 100.0),
            None => base,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn mount_outcome(
    request_id: &str,
    inventory_type: u8,
    source_slot: i16,
    item_id: &str,
    success: bool,
    code: &str,
) -> auth::InventoryOutcome {
    auth::InventoryOutcome {
        request_id: request_id.to_owned(),
        // 具名操作：既有的 `["use","equip","unequip"]` 重放白名单不含它，
        // 因此重放走的是**本请求自己的台账**，不可能被误当成一次 `use`。
        operation: "mount".to_owned(),
        inventory_type: Some(inventory_type),
        from_slot: source_slot,
        to_slot: None,
        item_id: item_id.to_owned(),
        quantity: 1,
        drop_id: None,
        success,
        code: code.to_owned(),
    }
}
```

### 3.3 新增 `B/chairs.rs`

```rust
//! 椅子（第 31 项）：设置栏道具 → 坐姿会话状态 → 坐椅恢复。
//!
//! 边界：
//! * **持有复用背包**：椅子一直是设置栏(3)的普通堆叠 1 的物品，本模块不移动它；
//! * **坐姿是会话状态**：不落库，重连/换图/死亡/受击/移动/攻击一律结束；
//! * 恢复量与间隔全部来自 `TamingMob` 之外的源表（`D/chairs.json`，源
//!   `Item/Install/*/info.recoveryHP|recoveryMP` 与 `String/Ins.json` 文案）。
//!
//! 间隔的诚实边界：源 `info` **没有**间隔字段，只有描述文案写「每N秒」。因此
//! `chairs.json` 只在文案确实写出时给 `recoveryIntervalMs`；缺席（173 件有恢复
//! 字段但文案没写）时本模块**不恢复**，也不显示倒计时——套一个默认 10 秒就是编规则。

use super::*;

/// 坐姿会话。`next_recovery_at` 是**权威**的下一次恢复拍。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ChairRuntime {
    pub item_id: String,
    pub recovery_hp: i64,
    pub recovery_mp: i64,
    /// `None` = 间隔未核定 ⇒ 只坐不恢复。
    pub recovery_interval_ticks: Option<u64>,
    pub next_recovery_at: Option<u64>,
}

impl World {
    /// 坐下／起立。与骑乘同一开关语义：**不**消耗物品、**不**改背包。
    /// 借用形状与 `mounts::mount_toggle` 相同：先判定，后落地。
    pub(super) fn chair_toggle(
        &mut self,
        id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
    ) {
        let tick = self.tick;
        enum Decision {
            Sit,
            Stand,
            Reject(&'static str),
        }
        let decision = {
            let Some(player) = self.players.get(id) else {
                return;
            };
            // 权威复核：设置栏**该槽位**上现在确实是这件椅子。客户端只说
            // "我双击了设置栏第 N 格"，实物与服务端自己的快照对齐与否由这里判。
            let authoritative = player
                .state
                .inventory
                .iter()
                .find(|item| {
                    item.slot == u16::try_from(source_slot).unwrap_or(0)
                        && inventory::inventory_type(&item.item_id) == Some(3)
                })
                .map(|item| item.item_id.clone());
            if authoritative.as_deref() != Some(item_id) {
                Decision::Reject("chair_mismatch")
            } else if !inventory::is_chair_item(item_id) {
                // 设置栏里也有非椅子的装饰品（旗帜、告示板…）：它们没有坐姿规则，
                // 因此回一个**具名**码，而不是落进末尾的 InvalidInventoryType。
                Decision::Reject("not_a_chair")
            } else if player.chair.is_some() {
                Decision::Stand
            } else if player.state.hp <= 0 || player.state.action == "dead" {
                Decision::Reject("chair_dead")
            } else if player.mount.is_some() {
                Decision::Reject("chair_mounted")
            } else if player.state.climbing || player.swimming || !player.state.grounded {
                Decision::Reject("chair_unsupported")
            } else {
                Decision::Sit
            }
        };
        let (success, code) = match decision {
            Decision::Reject(code) => (false, code.to_owned()),
            Decision::Stand => {
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                player.chair = None;
                player.state.action_started_tick = tick;
                (true, String::new())
            }
            Decision::Sit => {
                let (recovery_hp, recovery_mp, interval_ms) =
                    inventory::chair_recovery(item_id).expect("is_chair_item 已证明存在");
                // 间隔未核定时 `next_recovery_at` 为 `None`：坐姿照常成立，
                // 只是不恢复、也不给倒计时。
                let interval_ticks = interval_ms
                    .filter(|ms| *ms > 0)
                    .map(|ms| ms / TICK_MS as i64)
                    .filter(|ticks| *ticks > 0)
                    .map(|ticks| ticks as u64);
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                player.chair = Some(ChairRuntime {
                    item_id: item_id.to_owned(),
                    recovery_hp,
                    recovery_mp,
                    recovery_interval_ticks: interval_ticks,
                    next_recovery_at: interval_ticks.map(|ticks| tick.saturating_add(ticks)),
                });
                player.state.action_started_tick = tick;
                (true, String::new())
            }
        };
        let outcome = chair_outcome(request_id, inventory_type, source_slot, item_id, success, &code);
        self.inventory_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        self.send_inventory_outcome(id, &outcome);
        if success {
            self.send_snapshot(id);
        }
    }

    /// 每拍推进坐椅恢复。恢复量只在源字段声明处取；上限只在 HP/MP 顶格处一次。
    pub(super) fn step_chairs(&mut self) {
        let tick = self.tick;
        for player in self.players.values_mut() {
            let Some(chair) = player.chair.as_mut() else {
                continue;
            };
            let (Some(interval), Some(due)) = (chair.recovery_interval_ticks, chair.next_recovery_at)
            else {
                continue;
            };
            if tick < due {
                continue;
            }
            // 一次只结算一拍，且下一拍**从现在**往后推：世界可能有很长的空档
            // （驻留角色、卡顿、进程挂起），用 `due + interval` 追赶会让一次停顿
            // 补出一叠恢复。这里宁可少给，也不给"离线也回血"的口子。
            chair.next_recovery_at = Some(tick.saturating_add(interval));
            if chair.recovery_hp > 0 {
                player.state.hp = (player.state.hp + chair.recovery_hp).min(player.state.max_hp);
            }
            if chair.recovery_mp > 0 {
                player.state.mp = (player.state.mp + chair.recovery_mp).min(player.state.max_mp);
            }
        }
    }

    /// 起立的唯一出口。
    pub(super) fn stand_up(&mut self, id: &str, _rationale: &'static str) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        if player.chair.take().is_some() {
            player.state.action_started_tick = self.tick;
        }
    }

    pub(super) fn chair_snapshot_field(player: &Player, tick: u64) -> Option<serde_json::Value> {
        let chair = player.chair.as_ref()?;
        let mut value = serde_json::json!({
            "itemId": chair.item_id,
            "recoveryHp": chair.recovery_hp,
            "recoveryMp": chair.recovery_mp,
        });
        if let (Some(interval), Some(due)) = (chair.recovery_interval_ticks, chair.next_recovery_at) {
            value["recoveryIntervalMs"] =
                serde_json::Value::from(interval.saturating_mul(TICK_MS));
            value["nextRecoveryInMs"] =
                serde_json::Value::from(due.saturating_sub(tick).saturating_mul(TICK_MS));
        }
        Some(value)
    }
}

fn chair_outcome(
    request_id: &str,
    inventory_type: u8,
    source_slot: i16,
    item_id: &str,
    success: bool,
    code: &str,
) -> auth::InventoryOutcome {
    auth::InventoryOutcome {
        request_id: request_id.to_owned(),
        operation: "chair".to_owned(),
        inventory_type: Some(inventory_type),
        from_slot: source_slot,
        to_slot: None,
        item_id: item_id.to_owned(),
        quantity: 1,
        drop_id: None,
        success,
        code: code.to_owned(),
    }
}
```

### 3.4 `B/protocol.rs`

**(a)** `PlayerState` 追加两个可选字段（与 TS 侧同名同形）：

```rust
    /// 骑乘中的权威状态；缺席＝未骑乘。客户端只读。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount: Option<MountState>,
    /// 坐姿的权威状态；缺席＝未坐。坐姿是会话状态（不落库）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chair: Option<ChairState>,
```

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountState {
    pub item_id: String,
    pub taming_mob: i64,
    pub speed: i64,
    pub jump: i64,
    pub fs: i64,
    pub fatigue: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChairState {
    pub item_id: String,
    pub recovery_hp: i64,
    pub recovery_mp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_recovery_in_ms: Option<u64>,
}
```

> 快照的 `players[]` 是 `serde_json::to_value(&player.state)` 后再插字段的（见 3.5c），
> 因此这两个字段**必须**留在 `PlayerState` 里、而不是像 `away`/`abnormalStatus` 那样
> 在拼装处 insert。理由：它们是**状态**（与 `potionCooldowns` 同类），而
> `away`/`abnormalStatus` 是**投影**（由另一处时钟字段算出）。类型化后 Rust 侧无法
> 忘记填，`F/` 也不必再猜字段名。

**(b)** `ClientMessage` **不新增变体**（见 §2.1）。

### 3.5 `B/world.rs`

**(a) 模块注册**（插在 `#[path = "monsters.rs"] mod monsters;` 之前，保持字母序）

```rust
#[path = "chairs.rs"]
mod chairs;
#[path = "mounts.rs"]
mod mounts;
```

**(b) `Player` 追加两个字段**（放在 `status: PlayerStatus,` 之上）

```rust
    /// 骑乘中的会话状态。**不落库**：重连、死亡、换图、上绳、入水、卸下坐骑
    /// 都会经 `mounts::dismount` 收掉；每拍还会对账装备里的实物（`step_mount`）。
    mount: Option<mounts::MountRuntime>,
    /// 坐姿的会话状态。持有的是设置栏里的实物 id，离开即作废（不落库）。
    chair: Option<chairs::ChairRuntime>,
```

构造 `Player { ... }` 处（`commands.rs::Join` 建立新角色的分支与 `world.rs` 的
`reset_player_to_spawn` 初值同批）补 `mount: None, chair: None,`。

**(c) 快照拼装**（`world.rs` 的 `player_rows` 循环内，紧跟 `pets` 之后）

```rust
            if let Some(mount) = World::mount_snapshot_field(player) {
                if let Some(object) = row.as_object_mut() {
                    object.insert("mount".to_owned(), mount);
                }
            }
            if let Some(chair) = World::chair_snapshot_field(player, self.tick) {
                if let Some(object) = row.as_object_mut() {
                    object.insert("chair".to_owned(), chair);
                }
            }
```

> 因为两个字段已进 `PlayerState`，也可以直接由 `serde` 序列化；本节保留 insert
> 写法是为了与 `away`/`abnormalStatus` 同一段代码风格一致。**二选一，不要两处都写**：
> 若走 `PlayerState` 字段，则此段删除；若走 insert，则 `PlayerState` 不加字段。
> 推荐**走 `PlayerState` 字段**（类型化、不会忘），本节可整体省略。

**(d) tick 主循环**（`step` 里处理玩家的位置，紧跟 `step_player` 之后）

```rust
    // 骑乘的对账与坐椅的恢复都挂在既有顺序 tick 上：世界只有一个逻辑拥有者，
    // 不给坐骑/椅子各开一个 task，也不让它们各自读时钟。
    for id in player_ids.clone() {
        self.step_mount(&id);
    }
    self.step_chairs();
```

**(e) `send_inventory_outcome_last`**：mounts/chairs 用「先入台账再答复」的两步，
需要一个小助手（也可直接用 `let outcome = ...; self.inventory_requests.insert(...); self.send_inventory_outcome(&id, &outcome);`，则本 helper 不必存在）。**推荐后者**：少一个间接层。

### 3.6 `B/inventory_ops.rs`（世界侧 `handle_use_item`）

在 `is_pet_food` 分支之后、`if let Some(store) = self.store.clone()` 之前插入：

```rust
        // 骑乘 / 坐下：**会话状态**，既不是消耗品也不改背包，因此必须挡在
        // 持久化事务之前——否则 `-18` 槽会落进下面的 unequip 分支（把坐骑脱下来），
        // 设置栏会落进 InvalidInventoryType（把合法栏位说成非法）。这与
        // `pet_toggle` 挡在 store 之前是同一个理由，区别是宠物要把 `_petActive`
        // 落库，而骑乘/坐姿没有可落库的字段（专题 §2）。
        //
        // 重放：两者的 operation 是具名的 `mount` / `chair`，不在既有的
        // `["use","equip","unequip"]` 白名单里，所以台账命中时直接回原结果。
        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if matches!(prior.operation.as_str(), "mount" | "chair") {
                self.send_inventory_outcome(&id, &prior);
                return;
            }
        }
        if inventory_type == 1
            && inventory::valid_equipment_slot(source_slot)
            && target_slot.is_none()
            && target_item_id.is_none()
            && crate::inventory::is_mount_item(&item_id)
        {
            self.mount_toggle(&id, &request_id, inventory_type, source_slot, &item_id);
            return;
        }
        if inventory_type == 3 && inventory::valid_slot(source_slot) {
            self.chair_toggle(&id, &request_id, inventory_type, source_slot, &item_id);
            return;
        }
```

不需要动 `operation` 白名单、不需要动 `plan_map_move`、不需要新分支到 store 之后。

### 3.7 `A/bag.rs`（持久化事务侧，**只加拒绝，不加分支**）

`use_item_with_max_mp` 的 `mut mutation` 之前插入：

```rust
        // 骑乘与坐姿没有可落库的字段，世界侧已在 `handle_use_item` 的持久事务
        // 之前拦截并答复。走到这里说明有调用方绕过了世界侧：要回一个**具名**结果，
        // 不能让 `-18` 槽落进下面的 unequip（把坐骑脱掉）、也不能让设置栏落进
        // 末尾的 InvalidInventoryType（3 是合法栏位）。
        if inventory_type == 1
            && inventory::valid_equipment_slot(source_slot)
            && inventory::is_mount_item(item_id)
            && target_slot.is_none()
            && target_item_id.is_none()
        {
            let outcome = InventoryOutcome {
                request_id: request_id.to_owned(),
                operation: "mount".to_owned(),
                inventory_type: Some(inventory_type),
                from_slot: source_slot,
                to_slot: None,
                item_id: result_item.clone(),
                quantity: 1,
                drop_id: None,
                success: false,
                code: inventory::InventoryError::SessionStateOnly.code().to_owned(),
            };
            insert_inventory_action(&tx, account_id, &outcome)?;
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
        if inventory_type == 3 && inventory::valid_slot(source_slot) {
            let outcome = InventoryOutcome {
                request_id: request_id.to_owned(),
                operation: "chair".to_owned(),
                inventory_type: Some(inventory_type),
                from_slot: source_slot,
                to_slot: None,
                item_id: result_item.clone(),
                quantity: 1,
                drop_id: None,
                success: false,
                code: inventory::InventoryError::SessionStateOnly.code().to_owned(),
            };
            insert_inventory_action(&tx, account_id, &outcome)?;
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
```

> 这两段是**防御性**的：正常路径永远到不了。它们同时把两条路登记进持久台账，
> 于是即使有人绕过世界侧，重发也只会拿到同一个 `session_state_only`。

### 3.8 `B/movement.rs`

**(a) 骑乘的速度与跳跃**（仅两处，改的是「基础常量乘坐骑倍率」，不是重写移动）

```rust
    // 320 行附近：步行速度
    player.state.vx = if knockback_active {
        player.knockback_vx
    } else {
        let base = player.move_speed * slow_factor;
        player.direction as f64 * World::mount_walk_speed(player, base)
    };
```

```rust
    // 跳跃：117 / 196 / 296 三处 `-JUMP_SPEED` 统一换成
    // `-World::mount_jump_speed(player, JUMP_SPEED)`
```

**(b) 坐姿与骑乘的输入解除**（`step_player` 开头，`if player.state.action == "dead"` 之后）

```rust
    // 坐姿：任一移动/跳/上下输入即起立。判据读**客户端的原始意图**（direction /
    // vertical / jump），不读位移结果——按住方向键时 vx 可能被墙吃掉，但玩家
    // 「想动」这件事本身就是起立的条件。
    if player.chair.is_some()
        && (player.direction != 0 || player.vertical != 0 || player.jump)
    {
        world.stand_up(id, "movement_input");
    }
    // 骑乘：上绳 / 入水即下马（源有 ladder/rope 帧但没有可执行的骑乘攀爬规则，
    // 见 mounts.rs 模块头「未核定」）。
    if player.mount.is_some() && (player.state.climbing || player.swimming) {
        world.dismount(id, "climb_or_swim");
    }
```

> `step_player` 目前是 `fn step_player(map, gameplay, player, tick)`——没有 `World`。
> 因此这两条**不要**塞进 `movement.rs`，而是放进 `world.rs` 的 tick 循环里、
> 在调用 `step_player` **之前**（此时 `player.state.climbing/swimming` 还是上一拍
> 的权威值，正是要判的东西）。这是本方案唯一需要在 `movement.rs` 之外处理移动
> 相关结束点的原因，也是为什么 `movement.rs` 的改动只有 (a) 两处。

**(c) 坐姿时不给行走速度**

```rust
    // 坐姿在 `step_player` 之前已由 world 侧解除，因此这里看到的 `player.chair`
    // 只可能是同一拍刚坐下的：不给位移，姿态交给 action 路由。
    player.state.vx = if player.chair.is_some() { 0.0 } else { /* 上面的表达式 */ };
```

**(d) 动作选择**（481–508 那段 `if tick >= player.attack_until`）追加 `sit` 分支

```rust
    if tick >= player.attack_until {
        player.state.action_id = None;
        let action = if player.chair.is_some() {
            // 坐姿是**最高优先**的姿态：它压过 walk/jump 的常规推导。
            // 起立由 world 侧在输入到达时完成，所以这里不需要"想动"的判据。
            "sit"
        } else if knockback_active {
            // ... 既有分支保持不变 ...
```

### 3.9 `B/attacks.rs` / `B/skills.rs`

**普攻**（`world.rs::handle_attack` 开头）：

```rust
        // 骑宠的动作集合（源 `Character/TamingMob/*.img`）里没有任何 `swing*`/`shoot*`
        // 帧，且源没有"骑乘中攻击"的可执行规则 ⇒ 骑乘中不发普攻。这不是数值平衡，
        // 是源数据不支持该姿态。
        if self.players.get(&id).is_some_and(|player| player.mount.is_some()) {
            self.send_reject(&id, "mounted_no_attack", "騎乘中不能攻击。", Some(&request_id));
            return;
        }
        if self.players.get(&id).is_some_and(|player| player.chair.is_some()) {
            // 坐姿同理：先起立再攻击，而不是"坐着出招"。
            self.stand_up(&id, "attack");
        }
```

**技能**（`skills.rs::handle_cast_skill` 开头）：与普攻同一判据（`mounted_no_attack`），
**外加**：坐姿先 `stand_up`。落点选在既有「白名单/冷却之前」的早退位置，保证被拒的技能
不扣 MP、不进冷却。

### 3.10 `B/commands.rs`

命中 `ClientMessage::UseItem` 的既有分支**不改**（骑乘/坐下都走它）。
`Command::Join` 的「接管驻留角色」分支追加两行：

```rust
                        // 会话状态不跨连接：新连接一律以「未骑乘、未坐姿」开始，
                        // 与 `direction/vertical/jump` 的清零同一处、同一理由。
                        existing.mount = None;
                        existing.chair = None;
```

死亡（`monsters.rs` 把玩家打成 `dead` 处，约 837 行）追加：

```rust
            self.dismount(&id, "death");
            self.stand_up(&id, "death");
```

换图 / 传送（`portals.rs::handle_portal` 落点、`inventory_ops.rs::land_player_on_return_map`）
追加同两行（`"map_change"` / `"map_scroll"`）。

受击（`monsters.rs` 的接触击退处，约 985–1023 行）追加同两行（`"contact_hit"`）。

---

## 4. 客户端逐文件改动

### 4.1 `F/inventory/names.ts`

```ts
import mountCatalog from '../../../../shared/mounts.json';
import chairCatalog from '../../../../shared/chairs.json';

/** 骑宠（D/mounts.json）。`islot` 解析与 items.json 同一张表、同一口径。 */
const MOUNTS = (mountCatalog as { items: Record<string, { name?: string; info?: CatalogInfo }> }).items;
/** 椅子（D/chairs.json）。 */
const CHAIRS = (chairCatalog as { items: Record<string, { name?: string; info?: CatalogInfo }> }).items;

function catalogInfo(itemId: string): CatalogInfo | undefined {
  const item = catalog[itemId as keyof typeof catalog] as { info?: CatalogInfo } | undefined;
  // items.json 是可达性驱动目录，骑宠与椅子不在其中（源里 notSale/only）。
  // 回落顺序与 B/inventory.rs 的 shipped_mounts → shipped_chairs 逐字同序，
  // 两端对"这件东西的 islot/名字是什么"必须给出同一个答案。
  return item?.info ?? MOUNTS[itemId]?.info ?? CHAIRS[itemId]?.info;
}

/** 名字：items.json → 骑宠 → 椅子 → 宠物 → id（与 `inventory::item_name` 同序）。 */
export function itemName(itemId: string): string {
  if (itemId === '0') return uiLocale() === 'en' ? 'Mesos' : '枫币';
  const item = catalog[itemId as keyof typeof catalog];
  if (item && 'name' in item) return displayText(item.name);
  const mountName = MOUNTS[itemId]?.name;
  if (mountName) return displayText(mountName);
  const chairName = CHAIRS[itemId]?.name;
  if (chairName) return displayText(chairName);
  const petName = PETS[itemId]?.name;
  return petName ? displayText(petName) : itemId;
}
```

`itemCategoryTab` **不改**：id 段算术已把 `0190xxxx`→装备栏(0)、`0301xxxx`→设置栏(3)。

### 4.2 `F/inventory/view-model.ts`

**不改**：`TAB_INVENTORY_TYPE` 已把可见页签 3 映射到服务端栏位 3。

### 4.3 `F/inventory/equipment-view.ts`（骑乘入口）

双击**已装备**的骑宠 → 走既有的 `useItem` 通道（负槽号 = 装备槽）：

```ts
  /** 双击已装备物品。既有语义是"卸下"，骑宠是唯一例外：源里双击坐骑是**上下马**，
   *  装备本身不动。判据只用 `equipmentSlot()`（±18/19）＋两表回落，与
   *  `inventory::is_mount_item` 同一判定，不按物品名或 id 段猜。 */
  private onSlotActivate(slotNumber: number, item: InventoryItem) {
    const slot = equipmentSlot(item.itemId);
    if (slot !== undefined && (slot === 18 || slot === 19)) {
      this.host.useItem(0, -slot, item);
      return;
    }
    this.host.unequip(item);
  }
```

### 4.4 新增 `F/mounts/`

```text
F/mounts/
├─ README.md        （成因与边界，一段话）
├─ model.ts         （纯函数：从 PlayerState 投影"可否骑乘/骑乘读数"）
├─ store.ts         （消费 snapshot 的 mount 字段；不做任何推导）
├─ view.ts          （骑乘标记：名字 + 源 speed/jump 读数，挂 HUD 一角）
└─ model.check.mjs  （门禁：见 §6）
```

`model.ts`：

```ts
//! 坐骑的客户端**只读**投影。骑乘与否、骑的是哪只、快多少，全部是服务端事实：
//! 本模块只把 `PlayerState.mount` 翻译成可显示的文字，绝不推导"我在骑"。

import type { MountState, PlayerState } from '../../../../shared/protocol';

export interface MountReadout {
  itemId: string;
  tamingMob: number;
  /** 源口径（100 = 常规）：显示用，不是运行时系数。 */
  speed: number; jump: number; fs: number; fatigue: number;
}

/** 快照投影。缺席即未骑乘——**不**用"装备里有坐骑"推出骑乘状态。 */
export function mountReadout(player: PlayerState | undefined): MountReadout | undefined {
  const mount: MountState | undefined = player?.mount;
  if (!mount) return undefined;
  return { itemId: mount.itemId, tamingMob: mount.tamingMob, speed: mount.speed, jump: mount.jump, fs: mount.fs, fatigue: mount.fatigue };
}

/** 骑乘的源读数按「100 = 常规」显示为百分比增量，不换算成像素/秒：
 *  像素系数是服务端的事，客户端再算一遍就是第二套口径。 */
export function mountSpeedLabel(readout: MountReadout): string {
  const delta = readout.speed - 100;
  return delta === 0 ? '100%' : `${readout.speed}% (${delta > 0 ? '+' : ''}${delta})`;
}
```

### 4.5 新增 `F/chairs/`

```text
F/chairs/
├─ README.md
├─ model.ts         （从 PlayerState.chair 投影响应倒计时；间隔缺席即不显示）
├─ store.ts
├─ view.ts          （坐姿提示条：椅子名 + 剩余到下一次恢复的秒数）
└─ model.check.mjs
```

`model.ts`：

```ts
//! 坐姿的客户端**只读**投影。
//! 关键诚实边界：`recoveryIntervalMs` 缺席表示**该椅子的恢复间隔未核定**
//! （源文案没写「每N秒」），此时**不得**显示倒计时、也不得按默认 10 秒推算——
//! 那正是"编规则"。

import type { ChairState, PlayerState } from '../../../../shared/protocol';

export interface ChairReadout {
  itemId: string;
  recoveryHp: number;
  recoveryMp: number;
  secondsToRecovery?: number;
}

export function chairReadout(player: PlayerState | undefined): ChairReadout | undefined {
  const chair: ChairState | undefined = player?.chair;
  if (!chair) return undefined;
  const secondsToRecovery = chair.recoveryIntervalMs !== undefined && chair.nextRecoveryInMs !== undefined
    ? Math.max(0, Math.ceil(chair.nextRecoveryInMs / 1000))
    : undefined;
  return { itemId: chair.itemId, recoveryHp: chair.recoveryHp, recoveryMp: chair.recoveryMp, secondsToRecovery };
}

export function chairIntervalVerified(readout: ChairReadout): boolean {
  return readout.secondsToRecovery !== undefined;
}
```

### 4.6 `F/player/view.ts`

**(a)** `sit` 走既有动作路由，无需新分支——但**帧来源**要注意：

```ts
    // 187 行：`renderAction` 的既有推导已支持任意 action 名，`sit` 直接落在
    // `actions.sit` 上；缺帧时下面 189 行本来就回落 `actions.stand`，
    // 因此未导出 sit 的部件（源 `Face/00020000.img` 没有 sit）不会破图。
    const renderAction = skillActive && this.skillAction && actions[this.skillAction]?.length
      ? this.skillAction
      : player.action === 'climb' ? this.climbAsset(player, actions) : player.action;
```

**(b)** 单帧动作的帧推进加固（`F/player/animation.ts`）：

```ts
export function frameAt(delays: number[], elapsed: number, loop: boolean): number {
  const duration = delays.reduce((sum, delay) => sum + delay, 0);
  // 源里的静态单帧动作（`Character/00002000.img/sit` 只有 1 帧且**没有 delay**）
  // 会让 duration 为 0，`elapsed % 0` 得到 NaN。静态动作的答案就是第 0 帧，
  // 这里显式短路，而不是依赖 NaN 比较恰好落到 length-1 的巧合。
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  let cursor = loop ? Math.max(0, elapsed) % duration : Math.min(Math.max(0, elapsed), duration - 0.001);
  for (let index = 0; index < delays.length; index++) { cursor -= delays[index]; if (cursor < 0) return index; }
  return delays.length - 1;
}
```

**(c)** 骑乘/坐姿的**表现**：不动纸娃娃的合成，只在 actor 上叠状态标记，
`F/mounts/view.ts` 与 `F/chairs/view.ts` 各自负责。骑乘的**骑宠贴图**
（源 `Character/TamingMob/<8位id>.img/{stand1,walk1,jump}`）本轮未抽取，见 §7 未完成项。

### 4.7 `scripts/export_tms273_avatar.cjs`（坐姿帧导出）

```js
// 角色坐姿来自**角色自身**的部件帧，不是椅子贴图：
//   Character/00002000.img/sit        1 帧（部件 body/arm/face，**无 delay**）
//   Character/00012000.img/sit        1 帧（head/ear/...）
//   Character/{Cap,Coat,Longcoat,Shoes,Hair}/*.img/sit   1 帧
//   Character/Face/00020000.img       **没有** sit（合成时回落 stand，见 F/player/view.ts）
const ACTIONS = [
  ['stand', 'stand1'],
  ['walk', 'walk1'],
  ['jump', 'jump'],
  ['attack', 'swingO1'],
  ['ladder', 'ladder'],
  ['rope', 'rope'],
  // 静态单帧动作：源里没有 delay，导出时写 0 并由 `frameAt` 短路（见 §4.6b）。
  // `actionSet` 的「必须正 delay」断言要放宽为「多帧动作必须正 delay」。
  ['sit', 'sit', { static: true }],
];
```

`actionSet` 的断言随之改为：

```js
    assert(frames.length, `273 action ${sourceAction} has no frames`);
    assert(delays.every(delay => Number.isFinite(delay) && delay >= 0), `273 action ${sourceAction} delay data invalid`);
    // 单帧静态动作（源 `sit`）可以没有 delay；多帧动作必须每一帧都有正 delay，
    // 否则会出现"某帧永不显示"的静默缺陷。
    assert(frames.length === 1 || delays.every(delay => delay > 0), `273 action ${sourceAction} has a non-positive delay`);
```

`ClientMessage`/`protocolVersion` 不变。

### 4.8 `F/inventory/intents.ts`

不需要新方法：坐椅走既有 `submitUseItem(tab, slot, item)`（tab 3 = 设置栏），
骑乘走 `equipment-view` 的负槽号。两者都**不**需要新的 requestId 前缀。

### 4.9 `app/main.ts`

```ts
      // snapshot 分支，紧跟 `hud?.update(self)` 之后
      mountPanel?.update(self);
      chairPanel?.update(self);
```

两个面板用与 `petPanel` 相同的构造/销毁/`clear()` 生命周期挂进同一批
（`if (error)`、`state !== 'online'`、地图切换三处清理列表），位置紧邻 `petPanel`。

---

## 5. 结束条件矩阵（唯一权威：服务端；每格都有落点）

| 事件 | 骑乘 | 坐姿 | 落点 |
| --- | --- | --- | --- |
| 方向／上下／跳输入 | 保留（骑乘可移动） | **结束** | `world.rs` tick，`step_player` 之前 |
| 上绳 / 入水 | **结束**（源有帧但无规则，未核定） | **结束** | 同上 |
| 接触受击 / 击退 | **结束** | **结束** | `monsters.rs` 接触段 |
| 普攻 | **拒绝**（`mounted_no_attack`） | **先起立**再出招 | `world.rs::handle_attack` |
| 技能 | **拒绝**（`mounted_no_attack`） | **先起立**再施放 | `skills.rs::handle_cast_skill` |
| 死亡 | **结束** | **结束** | `monsters.rs` 结算死亡处 |
| 换图 / 传送 / 回城卷 / 大地图跳转 | **结束** | **结束** | `portals.rs`、`inventory_ops.rs::land_player_on_return_map` |
| 重连（接管驻留角色） | **结束** | **结束** | `commands.rs::Command::Join` |
| 离图（Exit / 驻留到期） | 随角色消亡 | 随角色消亡 | 既有删除路径 |
| 卸下该骑宠（自己或他人路径） | **结束** | — | `mounts::step_mount` 每拍对账 |
| 骑乘时坐下 | **拒绝**（`chair_mounted`） | — | `chairs::chair_toggle` |
| 坐姿时骑上 | **拒绝**（`mount_seated`） | — | `mounts::mount_toggle` |
| 换一件骑宠（−18 → 另一件） | 保持骑乘、读数换成新的 | — | `step_mount` 对账 |

---

## 6. 验收与门禁

### 6.1 数据层（已跑）

```bash
node scripts/export_tms273_mounts_chairs.cjs
# 导出坐骑 935 件（887 件带已核定骑行数值，坐骑档 24 个）、椅子 2797 件（1192 件带已核定恢复间隔）。
shasum shared/mounts.json client/public-tms273/assets/mounts.json   # 两处必须同摘要
```

### 6.2 新增 `scripts/check_tms273_mounts_chairs.cjs`（独立重算 + 双向反向断言）

四组断言，全部**不依赖**运行时的判定结果，只重算源：

1. **表与源一致**：对 `mounts.json` 抽 20 件（含 5 件带名字、1 件 `missingRideStats` 的
   `1932057`），逐字段重读 `WZ_JSON_TW` 比对 `islot`/`tamingMob`/`reqLevel`/`ride.*`；
   椅子的 `3010001` 必须与 `items.json["3010001"]` 的 `source`/`spriteSource`/`info` 逐键相同。
2. **反向断言（缺一个都要报全）**：`mounts.json` 里每个 `info.islot ∈ {Tm,Sd}` 的 id，
   在 `equipment_slot` 侧必须解析到 ±18/±19；`chairs.json` 每个 id 的
   `recoveryIntervalMs` 必须有 `recoveryIntervalSource`，反之亦然。
3. **不得编规则**：`chairs.json` 中 `recoveryIntervalMs` 缺席而 `recoveryHP/recoveryMP`
   存在的 id 集合，必须与 `counts.intervalUnverified` 数量相等。
4. **跨文件不打架**：`mounts.json`/`chairs.json` 与 `items.json` 的同 id 行（如 `3010001`）
   不得出现 `info` 字段级冲突。
5. **可骑面锁定（§1.2 那张表就是断言）**：重算四个数——`islot=Tm` 共 909、
   其中带 `tamingMob` **888**、`islot=Sd` 共 26 且带 `tamingMob` **0**、
   带 `tamingMob` 且 `ride` 齐备（＝真可骑）**887**。任一条漂了，说明源包或
   `is_mount_item` / `resolve_mount` 的判据变了，门禁当场红，不允许"新版本顺手
   多认了一批坐骑"。

### 6.3 Rust 定向检查

```bash
cd server && cargo test --offline mounts chairs -- --nocapture
```

新增 `server/src/mounts_acceptance.rs`（与既有的 `pet_acceptance.rs` 同形）：

* 骑上→快照带 `mount`、`action` 不新增取值；下马→字段消失；
* **伪造**：`useItem(1, -18, "别的物品id")` 必须 `mount_mismatch`，且装备不变；
* **重放**：同一 `requestId` 连发两次，第二次拿回**同一个** outcome，装备/会话都不二次翻转；
* 卸下骑宠后一拍即自动下马（`step_mount` 对账）；
* 空中/绳上/水中/坐姿/死亡逐个拒绝，各自的码逐条断言；
* 骑乘中 `Attack` 被拒且**不**进入 `attack_until`。

新增 `server/src/chairs_acceptance.rs`：

* 设置栏椅子上坐/起立；快照带 `chair`；
* 移动输入一拍内起立；
* `recoveryIntervalMs` 核定的椅子（`3010001`）在 `interval` 拍后 HP 增加**恰好**
  `recoveryHP`，且不会多拍叠加；间隔未核定的椅子 HP **永不**变化；
* HP 顶格时不超过 `maxHp`（上限只在声明处一次）；
* 非椅子装饰品 → `not_a_chair`；槽位与 id 不符 → `chair_mismatch`；
* `bag.rs` 防御分支：直接调 `use_item_with_max_mp(inventory_type:3, ...)` 得
  `session_state_only` 且**不**改背包。

### 6.4 前端

```bash
cd client && npx tsc --noEmit
node ../scripts/check_tms273_client_actions.cjs
node scripts/check_inventory.mjs
node src/features/mounts/model.check.mjs
node src/features/chairs/model.check.mjs
```

`model.check.mjs` 三组断言：`mount` 缺席 ⇒ 无读数（**不**从 `equipped` 推导）；
`recoveryIntervalMs` 缺席 ⇒ `secondsToRecovery === undefined`（**不**套 10 秒）；
`mountSpeedLabel` 对 100 显示 `100%`、对 150 显示 `150% (+50)`。

### 6.5 需要一起改的门禁

* `scripts/check_protocol_errors.cjs`：新码 `session_state_only`、`mounted_no_attack`、
  `mount_dead`、`mount_climbing`、`mount_airborne`、`mount_swimming`、`mount_seated`、
  `mount_busy`、`mount_mismatch`、`no_mount_equipped`、`chair_mismatch`、`not_a_chair`、
  `chair_dead`、`chair_mounted`、`chair_unsupported` 必须**都有中英文案**，否则门禁红。
* `scripts/check_windows_resources.cjs`：四个新表路径（§1.3）。
* `scripts/package_win_bundle.cjs`：若清单逐文件列举，同步 §1.3 的四个路径；
  `shared/` 与 `client/public-tms273/assets/` 若按目录整棵复制则无需单列。
* `client/src/features/refactor_audit.cjs --check`：`F/mounts/`、`F/chairs/` 必须是
  叶子友好的（`model.ts` 零运行期导入、`store.ts` 只读快照）。

---

## 7. 未完成项（明确列出，不用"大致完成"含糊过去）

1. **骑宠贴图未抽取**。源 `Character/TamingMob/<8位id>.img/{stand1,walk1,jump,...}`
   有真实骑行帧（`stand1` 6 帧 ×180ms、`walk1` 4 帧 ×120ms），但共 **935 件**，
   本轮不批量抽；两表的 `spriteSourceStatus` 因此写 `wz-present-unextracted`
   （**不是** `wz-verified`——那个取值的含义是"字节已导出并校验过"）。
   后续钩子：`export_tms273_mounts_chairs.cjs --frames <itemId,...>` 抽指定坐骑的
   `stand1/walk1/jump` 到 `assets/tms273/`，再进 `manifest.mounts[itemId].actions`。
   在完成前，骑乘的**表现**只有状态标记与读数，纸娃娃仍用角色自身的 stand/walk 帧。
2. **椅子的坐姿贴图未抽取**。584 件 `Item/Install/03010.img/*` 全查过：**没有 `sit` 节点**，
   只有 `info/icon` 与 `effect`（`0` 帧带 `z`/`pos`）。因此椅子本体若要画，得按
   `effect/0` 的 `pos` 锚点画；默认那件 `3010001` 的图标**已经**在
   `assets/tms273/Item_Install__Canvas_03010.img_03010001_info_icon-*.png` 里，可直接用。
   装饰栏其余 2796 件的图标未抽取（`wz-present-unextracted`）。
3. **`fatigue` 只上快照，不参与任何计算**：源只给初始值，没有衰减公式。
4. **骑乘的开关条件未核定**：源包没有「谁能骑、在哪骑、何时强制下马」的可执行规则，
   本实现的判据是 P 级（见 `mounts.rs` 模块头逐条注明）。
5. **173 件椅子的恢复间隔未核定**（源文案没写「每N秒」）：坐得下，但不恢复、不显示倒计时。
6. **`Tm` 槽共用**：源里機械師的引擎/手臂/腳/身軀/電晶體（`Character/Mechanic/*`）
   与骑宠**同用 `islot = Tm`（槽 −18）**。因此 `is_mount_item` 只用 `info.tamingMob` 判定，
   不看 islot；这也意味着機械師整套装备与骑宠在该槽上互斥——这是源的行为，不是本实现的取舍。
7. **实玩未验**：本文的所有"表现"结论（姿态、朝向、脚点、读数位置）交用户亲测，
   未启动游戏、未跑浏览器验收。

---

## 8. 交付清单

| 文件 | 类型 | 状态 |
| --- | --- | --- |
| `scripts/export_tms273_mounts_chairs.cjs` | 新增 | **已落盘并跑通** |
| `shared/mounts.json`、`shared/chairs.json` | 新增 | **已生成** |
| `client/public-tms273/assets/mounts.json`、`chairs.json` | 新增（镜像） | **已生成**，与 `shared/` 同摘要 |
| `B/inventory.rs` | 改 | 本文 §3.1（新增两表 + 三处收口 + 一个错误码） |
| `B/mounts.rs`、`B/chairs.rs` | 新增 | §3.2、§3.3 |
| `B/protocol.rs` | 改 | §3.4 |
| `B/world.rs` | 改 | §3.5（注册 / 两个字段 / tick / 快照） |
| `B/inventory_ops.rs` | 改 | §3.6 |
| `A/bag.rs` | 改 | §3.7（只加具名拒绝，不加新分支） |
| `B/movement.rs` | 改 | §3.8（速度/跳跃两处 + `sit` 动作分支） |
| `B/commands.rs` | 改 | §3.10（重连清零 + 死亡/换图/受击收口） |
| `B/monsters.rs`、`B/portals.rs`、`B/skills.rs`、`B/attacks.rs`（`world.rs`） | 改 | §3.9、§3.10（各 2–4 行收口） |
| `D/protocol.ts` | 改 | §2.3 |
| `F/inventory/names.ts`、`F/inventory/equipment-view.ts` | 改 | §4.1、§4.3 |
| `F/mounts/`、`F/chairs/` | 新增 | §4.4、§4.5 |
| `F/player/animation.ts`、`F/player/view.ts` | 改 | §4.6 |
| `scripts/export_tms273_avatar.cjs` | 改 | §4.7（`sit` 动作 + 断言的静态单帧放宽） |
| `app/main.ts` | 改 | §4.9 |
| 门禁与验收 | 新增/改 | §6 |
