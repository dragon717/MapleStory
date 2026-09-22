# 宠物上下平台收口：垂直 leash（含贴图派生物复核）

- 日期：2026-09-23
- 用户指令：
  1. 「宠物贴图消失（根因修复）」——上一轮已定位为派生物过期，本轮复核。
  2. 「宠物会卡在上下的平台，收紧上下的距离限制，目的是为了既让宠物能脱离角色拾取东西，但又能瞬移回角色附近。」
- 遵循 AGENTS.md / BUSINESS_DEVELOPMENT.md：只做定向验证、不启动独立 QA、不重启在线服务。

## 结论

- 贴图：复核通过，`client/public-tms273/assets/manifest.json` 的 `petUi.buttons.character`
  已是四态（`normal/pressed/disabled/mouseOver`）、`pets` 1002 项，`check_tms273_runtime.cjs` exit 0。
- 卡平台：根因是宠物移动**只有平面 leash**（`PET_OWNER_TELEPORT_DISTANCE = 1000`），
  没有垂直口径。宠物既不复制主人的 y（`goal_y` 只作跳跃触发用），落地后也不再有
  回主人那一层的路径 ⇒ 一旦落到另一层平台（桥面／桥下）就永远停在那里，表现为
  「卡在上下的平台」。

## 做了什么

### ① 垂直 leash（`server/src/pet_motion.rs`）

- 新增 `pub(super) const PET_VERTICAL_LEASH: f64 = 64.0;`
- `PetMotion::step` 新增 `owner_grounded: bool` 形参，并在平面 leash 之后加一条：
  宠物**和主人都在地面上**且 `|owner_y - pet.y| > PET_VERTICAL_LEASH` ⇒ `reset(owner_x, owner_y, owner_facing)`
  + `mode = "follow"`（即瞬移回主人身边）。
- 取值依据（不是拍脑袋）：`JUMP_SPEED = 555` / `GRAVITY = 2000`、`TICK_MS = 50` 下，
  离散积分的跳跃峰值是 **63.75px**（主人与宠物共用同一条曲线）⇒
  - 一个跳跃以内（≤64）宠物能自己走／跳回主人那一层，不该瞬移；
  - 超过一个跳跃高度，它物理上回不去，只能瞬移。
- 为什么必须同时要求「主人也在地面上」：主人起跳（峰值同为 63.75）、上绳、游泳时
  `state.grounded == false`，此时按 y 收宠物会把它拉进半空或水里。
- 由于平面 leash 未动，`pet_follows_independently_and_recovers_beyond_leash`（1000 平面回归）
  行为不变。

### ② 寻物口径同口径收紧（`server/src/pets.rs`）

- 掉落搜索在原有 1000 平面距离之外，新增
  `(drop.y - motion.y).abs() > pet_motion::PET_VERTICAL_LEASH ⇒ 不算目标`。
- 理由：另一层平台上的掉落宠物够不到，若仍算目标，宠物会为它反复离层、再被地面 leash
  收回来（可见的来回瞬移）。收紧后宠物只捡自己这一层（含一次跳跃以内）的掉落。
- `step` 调用点补传 `player.state.grounded`。

### ③ 测试

- `pet_motion.rs` 新增 2 条：分层平台上主人落地 ⇒ 宠物瞬移回同层；主人**空中**时 ⇒ 不拉宠物；
  以及「一次跳跃以内（40px）算跳上去、不算分层」。
- `pet_acceptance.rs` 新增 1 条端到端：分层地图（下层 y=100／上层 y=20，差 80）里，
  上层掉落不是目标（`mode != "loot"` 且掉落留在地上），主人站到上层后宠物 x/y 落到主人处、
  `mode == "follow"`。

## 验收

- `cargo test`：**648 过 / 0 失败**（基线 645 + 3 条新用例）。
- `cargo fmt -- --check`：`pet_motion.rs` / `pets.rs` / `pet_acceptance.rs` **无新增 diff**
  （全仓仍有既有 diff，未动）。
- `node scripts/check_tms273_runtime.cjs`：exit 0（`211 maps; 126932 source references`）。
- 内容版本 `tms273-39` 与协议 34 **均未变**（只改服务端实现 + 测试，零 `shared/**` 字节，
  无需重跑装配器）。

## 遗留

- **未统一加载实玩**：需重跑一次 `启动3010.command` 让服务端改动生效；实玩观察
  桥面／上下层平台、跨层掉落、正常同层跟随时宠物是否只在真正分层时瞬移。
- 未重启在线服务、未提交。
- 已登记边界：宠物没有游泳模型，主人游泳时按「不在平台」处理 ⇒ 宠物留岸（本轮之后
  不会再把宠物拉进水里，但也不会跟下水）。