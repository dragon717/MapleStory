# Rust 权威世界模型：物品、邮件、拍卖、托管与离线世界

> 目标：给 Agent 一套可落地的 Rust 权威世界建模原则。  
> 核心思想不是“把所有系统统一成一个接口”，而是：
>
> **先定义世界事实，再定义谁有权修改事实；业务系统只表达业务意图，底层领域服务负责保证世界始终处于合法状态。**

---

## 1. 第一原则：服务器保存的是“世界事实”

权威服务器不应该把业务系统理解成一堆互相调用的功能模块：

```text
Inventory
Warehouse
Mail
Auction
OfflineReward
```

更重要的是明确：

```text
世界中发生了什么事实？
```

对于一个物品，最核心的事实通常不是“它在哪个系统里”，而是：

```text
Item
├── Owner      谁拥有它
├── Location   它在哪里
└── State      它当前是否可操作
```

例如：

```text
Sword #10086

Owner    = Player(1001)
Location = Inventory(1001)
State    = Normal
```

把它放进仓库：

```text
Owner    = Player(1001)
Location = Warehouse(1001)
State    = Normal
```

注意：

```text
Owner 没变
Location 变了
```

因此：

> 背包 → 仓库，本质上通常不是所有权转移，而是位置变化。

---

# 2. Owner、Location、State 必须分开

这是整个模型最重要的拆分。

不要建立：

```text
Container == Owner
```

因为现实业务中会出现：

```text
仓库中的物品：
Owner = Player
Location = Warehouse

拍卖中的物品：
Owner = Seller
Location = AuctionEscrow
State = Locked

邮件中的奖励：
可能还未真正属于玩家
或者已经属于玩家但处于 MailAttachment 位置
```

所以必须独立建模。

---

# 3. Rust 推荐的数据模型

Rust 的 `enum` 很适合表达权威世界中的有限状态。

## 3.1 Owner

```rust
pub enum Owner {
    Player(PlayerId),
    System,
}
```

自然语言理解：

```text
Owner 只能是：
- 某个玩家
- 系统
```

不要用：

```rust
struct Owner {
    owner_type: u8,
    player_id: Option<PlayerId>,
}
```

因为这种结构很容易形成非法组合。

---

## 3.2 ItemLocation

```rust
pub enum ItemLocation {
    Inventory(PlayerId),
    Warehouse(PlayerId),
    Mail(MailId),
    AuctionEscrow(ListingId),
    TradeEscrow(TradeId),
    ContractEscrow(ContractId),
}
```

这意味着：

```text
Inventory 天生携带 PlayerId
Mail 天生携带 MailId
AuctionEscrow 天生携带 ListingId
```

而不会出现：

```text
location_type = Inventory
mail_id = 100
listing_id = 200
```

这种逻辑上不可能存在的状态。

---

## 3.3 ItemState

```rust
pub enum ItemState {
    Normal,
    Locked(LockReason),
}
```

```rust
pub enum LockReason {
    Auction(ListingId),
    Trade(TradeId),
    Contract(ContractId),
}
```

例如：

```rust
Item {
    owner: Owner::Player(1001),
    location: ItemLocation::AuctionEscrow(888),
    state: ItemState::Locked(
        LockReason::Auction(888)
    ),
}
```

代码本身已经能表达：

```text
这是玩家 1001 的物品，
当前被拍卖单 888 托管，
并处于不可自由操作状态。
```

---

# 4. Item 是事实实体，而不是业务系统

```rust
pub struct Item {
    pub id: ItemId,

    owner: Owner,
    location: ItemLocation,
    state: ItemState,
}
```

注意：

```rust
owner
location
state
```

不应该直接 `pub`。

原因：

> 如果业务模块可以直接修改这些字段，那么世界规则实际上没有权威中心。

错误：

```rust
item.owner = buyer;
item.location = ItemLocation::Inventory(buyer);
```

正确方向：

```text
业务系统
    ↓
领域服务
    ↓
内部修改事实
```

---

# 5. 权限模型：修改世界的能力必须逐层收窄

推荐分三层。

```text
第一层：公开业务 API
─────────────────────────
MoveToWarehouse
ClaimMail
ListAuction
BuyAuction
CancelAuction

          ↓

第二层：领域事务能力
─────────────────────────
MoveItem
TransferOwnership
LockItem
UnlockItem
GrantReward
CreateEscrow
ResolveEscrow

          ↓

第三层：内部原语
─────────────────────────
put
take
change_owner
move_to
set_state
```

原则：

> 越底层的操作越危险、语义越弱、越不应该公开。

---

# 6. Put / Take 应该是内部实现细节

`put/take` 不应该成为业务 API。

错误：

```rust
let item = inventory.take(item_id)?;
warehouse.put(item)?;
```

因为会产生：

```text
take 成功
↓
put 失败
↓
Item 处于悬空状态
```

单独的 `take()` 并不能保证：

```text
物品去哪了？
Location 是否更新？
是否持久化？
是否记录日志？
是否发事件？
失败是否回滚？
```

因此：

> `Put/Take` 是容器实现原语，不是完整业务动作。

---

# 7. Rust 中 put/take 默认应保持私有

```rust
pub struct Inventory {
    items: Vec<ItemId>,
}

impl Inventory {
    fn put(&mut self, item: Item) -> Result<(), DomainError> {
        Ok(())
    }

    fn take(&mut self, item_id: ItemId) -> Result<Item, DomainError> {
        todo!()
    }
}
```

Rust 中：

```text
pub fn xxx()
```

≈ Go 中：

```go
func Xxx()
```

Rust：

```text
fn xxx()
```

≈ Go 中：

```go
func xxx()
```

但 Rust 私有边界更细。

---

# 8. Rust 可见性建议

## `pub`

真正对其他领域公开的稳定能力。

例如：

```rust
pub fn list_auction(...)
pub fn buy_auction(...)
pub fn claim_mail(...)
```

---

## `pub(crate)`

只允许当前服务端 crate 内调用。

例如：

```rust
pub(crate) fn transfer_item(...)
```

适合：

```text
mail
auction
trade
contract
```

等服务器内部业务模块共享。

---

## `pub(super)`

只允许父模块使用。

适合更细的模块内部协作。

---

## private

默认最小权限。

例如：

```rust
fn put(...)
fn take(...)
fn change_owner(...)
fn move_to(...)
```

---

# 9. 核心规则：不能单独维持世界不变量的函数，不公开

这是整个权威世界最重要的工程规则之一：

> **任何无法独立保证世界合法性的操作，都不应该暴露给业务方。**

例如：

```rust
fn take(...)
fn set_owner(...)
fn set_location(...)
```

都不能独立保证完整性。

而：

```text
MoveItem
TransferOwnership
ListAuction
BuyAuction
ClaimAttachment
```

可以围绕一个完整事务定义：

```text
检查
修改
持久化
事件
日志
回滚
```

所以应该公开完整动作，而隐藏内部原语。

---

# 10. Container 是内部能力，不一定是公共领域接口

背包和仓库确实具有类似能力：

```rust
trait Container {
    fn can_put(&self, item: &Item) -> Result<(), DomainError>;

    fn put(&mut self, item: Item)
        -> Result<(), DomainError>;

    fn take(&mut self, item_id: ItemId)
        -> Result<Item, DomainError>;
}
```

但这个 trait 完全可以是：

```rust
trait Container
```

而不是：

```rust
pub trait Container
```

也就是说：

> `Container` 可以只是 Item Domain 内部为了实现 Transfer 而存在的抽象。

业务系统根本不需要知道它。

---

# 11. 不要为了统一而让所有系统实现 Container

错误方向：

```text
Inventory implements Container
Warehouse implements Container
Mail implements Container
Auction implements Container
```

这看似统一，实际上破坏了业务语义。

因为：

```text
Inventory / Warehouse
```

主要表达：

```text
Where is the item?
```

而：

```text
Mail
Auction
Contract
Trade
```

表达的是：

```text
为什么物品发生变化？
变化依据什么业务规则？
谁在什么时候获得操作权？
```

它们不是同一种抽象。

---

# 12. 正确的稳定底层：Move / Ownership / Escrow

可以把物品领域拆成几个真正稳定的能力。

```text
MoveItem
    解决：物品在哪里

TransferOwnership
    解决：物品属于谁

Lock / Unlock
    解决：当前谁有权操作

Escrow
    解决：暂时托管，等待条件成立

GrantReward
    解决：一个奖励如何真正进入玩家世界状态
```

业务系统组合这些能力，而不是互相继承。

---

# 13. 背包与仓库

对于：

```text
Inventory → Warehouse
```

通常：

```text
Owner 不变
Location 改变
```

例如：

```text
Before

Owner    = Player(1)
Location = Inventory(1)

After

Owner    = Player(1)
Location = Warehouse(1)
```

所以这是：

```text
Move
```

而不是：

```text
TransferOwnership
```

---

# 14. 玩家交易

玩家交易：

```text
Player A → Player B
```

才是真正的所有权转移。

可能同时修改：

```text
Owner:
Player A → Player B

Location:
Inventory(A) → Inventory(B)
```

所以一个完整交易不是简单的：

```text
Take + Put
```

而是：

```text
TransferOwnership
+
MoveItem
+
Transaction
+
Audit
```

---

# 15. Auction 不应该只是 Container

拍卖的核心不是：

```text
往里面放一个物品
```

而是：

```text
建立托管关系
```

推荐：

```text
Seller
  │
  │ List
  ▼
Auction Escrow
  │
  ├── Cancel ─→ Seller
  │
  └── Buy ────→ Buyer
```

挂拍后：

```text
Owner    = Seller
Location = AuctionEscrow(ListingId)
State    = Locked(Auction(ListingId))
```

成功购买：

```text
Owner    = Buyer
Location = Inventory(Buyer)
State    = Normal
```

取消：

```text
Owner    = Seller
Location = Inventory(Seller)
State    = Normal
```

---

# 16. Auction API 应该表达业务动作

```rust
pub struct AuctionService {
    // repositories / transaction manager / etc.
}

impl AuctionService {
    pub fn list(
        &mut self,
        seller: PlayerId,
        item_id: ItemId,
        price: Money,
    ) -> Result<ListingId, DomainError> {
        todo!()
    }

    pub fn cancel(
        &mut self,
        seller: PlayerId,
        listing_id: ListingId,
    ) -> Result<(), DomainError> {
        todo!()
    }

    pub fn buy(
        &mut self,
        buyer: PlayerId,
        listing_id: ListingId,
    ) -> Result<(), DomainError> {
        todo!()
    }
}
```

业务层应该说：

```text
挂拍
取消
购买
```

而不是：

```text
auction.put()
auction.take()
```

---

# 17. Escrow 是值得抽出来的稳定概念

Escrow = 托管。

适用于：

```text
Auction
Trade
Contract
Mail COD
Guild Transaction
Deposit
Bounty
Rental
```

通用生命周期：

```text
Lock
 ↓
Escrow
 ↓
Resolve
 ├── Commit
 └── Refund
```

也就是说：

> 复用的是“托管机制”，不是强行让所有业务共用一个业务接口。

---

# 18. Mail 的核心也不是 Container

邮件业务应该表达：

```text
SendMail
ClaimAttachment
DeleteMail
ExpireMail
```

而不是：

```text
Mail.Put
Mail.Take
```

邮件系统只负责：

```text
附件是否存在
附件是否可领取
是否已经领取
什么时候过期
```

至于奖励如何真正进入玩家世界：

```text
交给 Reward Domain
```

---

# 19. MailAttachment 不一定是 Item

实际邮件附件可能包括：

```text
装备
金币
钻石
经验
Buff
徽章
称号
皮肤
宠物
活动次数
角色解锁
```

因此不推荐：

```rust
struct Mail {
    attachments: Vec<Item>,
}
```

更推荐：

```rust
pub enum Reward {
    Item {
        config_id: ItemConfigId,
        count: u32,
    },

    Currency {
        currency: CurrencyType,
        amount: u64,
    },

    Badge {
        badge_id: BadgeId,
        duration: Duration,
    },
}
```

邮件保存的是：

```rust
pub struct MailAttachment {
    pub id: AttachmentId,
    pub reward: Reward,
}
```

---

# 20. RewardService 是更稳定的边界

Mail 不应该知道：

```text
装备怎么进背包
金币怎么增加
徽章怎么激活
Buff 怎么持续
```

应该：

```text
Mail
 ↓
RewardService
 ↓
具体领域状态
```

例如：

```rust
pub struct RewardService {
    // ...
}

impl RewardService {
    pub(crate) fn grant(
        &mut self,
        user_id: UserId,
        reward: &Reward,
        now: Timestamp,
    ) -> Result<(), DomainError> {
        match reward {
            Reward::Item {
                config_id,
                count,
            } => {
                // inventory domain
            }

            Reward::Currency {
                currency,
                amount,
            } => {
                // wallet domain
            }

            Reward::Badge {
                badge_id,
                duration,
            } => {
                // badge/effect domain
            }
        }

        Ok(())
    }
}
```

---

# 21. 在线领取与离线领取不是两个核心业务

在线一键领取：

```text
玩家在线
↓
点击一键领取
↓
领取所有符合条件的附件
```

离线自动领取：

```text
玩家不在线
↓
系统发现某些附件会影响离线收益
↓
自动领取
```

这两个行为底层都是：

```text
Claim Attachments
```

区别只是：

```text
选择哪些附件
```

因此应该抽象：

```text
Selector / Policy
```

而不是复制两份 Mail 领取逻辑。

---

# 22. AttachmentSelector

Rust：

```rust
trait AttachmentSelector {
    fn matches(
        &self,
        mail: &Mail,
        attachment: &MailAttachment,
        now: Timestamp,
    ) -> bool;
}
```

自然语言：

```text
给我一个附件，
我只负责回答：
“这次应该领取它吗？”
```

---

# 23. 在线一键领取策略

```rust
struct ClaimAll;

impl AttachmentSelector for ClaimAll {
    fn matches(
        &self,
        _mail: &Mail,
        _attachment: &MailAttachment,
        _now: Timestamp,
    ) -> bool {
        true
    }
}
```

---

# 24. 离线挂机收益自动领取策略

例如只领取：

```text
限时
+
会影响挂机收益
```

Rust：

```rust
struct OfflineBenefitOnly;

impl AttachmentSelector for OfflineBenefitOnly {
    fn matches(
        &self,
        _mail: &Mail,
        attachment: &MailAttachment,
        now: Timestamp,
    ) -> bool {
        attachment.is_time_limited(now)
            && attachment.affects_offline_reward()
    }
}
```

---

# 25. 统一 Claim 入口

```rust
fn claim_attachments<S: AttachmentSelector>(
    user_id: UserId,
    selector: &S,
    now: Timestamp,
) -> Result<ClaimResult, DomainError> {
    todo!()
}
```

Rust 小白可以先理解：

```rust
S: AttachmentSelector
```

就是：

```text
S 必须实现 AttachmentSelector
```

Go 大致相当于：

```go
func ClaimAttachments(
    userID UserID,
    selector AttachmentSelector,
    now int64,
) error
```

---

# 26. 不要让离线逻辑依赖在线 User 对象

危险设计：

```text
ClaimMail(user *OnlineUser)
```

以后离线时就会被迫制造：

```text
fake user
temp user
offline user
```

更合理：

```rust
pub fn claim_mail(
    user_id: UserId,
    ...
)
```

内部按需加载：

```text
MailRepository
ItemRepository
InventoryRepository
BadgeRepository
Transaction
```

这样：

```text
在线 WebSocket
后台 Job
离线结算
GM
定时任务
```

都可以复用同一个领域能力。

---

# 27. 玩家离线 ≠ 世界停止运行

这是权威世界与传统“登录时补算”思维的关键区别。

如果：

```text
01:00 玩家收到一个
持续 4 小时
挂机收益 +20% 的徽章
```

那么最自然的世界事实应该是：

```text
01:00
MailReceived
 ↓
AutoClaimPolicy
 ↓
AttachmentClaimed
 ↓
BadgeActivated
```

而不是：

```text
08:00 玩家上线
↓
才突然发现七小时前发生的事情
```

---

# 28. 世界事件链

推荐理解：

```text
MailReceived
     ↓
AutoClaimPolicy
     ↓
AttachmentClaimed
     ↓
RewardGranted
     ↓
BadgeActivated
     ↓
OfflineRewardModifierChanged
```

玩家是否在线，不应该决定这个事实能否发生。

---

# 29. 离线收益必须是时间区间模型

一旦离线期间 Buff / Badge 会变化，就不能：

```text
offline_seconds × 当前倍率
```

例如：

```text
00:00      01:00          05:00        08:00
  │          │              │            │
下线       +20%徽章        徽章过期       上线
  │          │              │            │
  └── x1.0 ──┴──── x1.2 ────┴── x1.0 ────┘
```

正确收益：

```text
1h × base × 1.0
+
4h × base × 1.2
+
3h × base × 1.0
```

因此离线收益应该依赖：

```text
Modifier Timeline
```

而不是只依赖结算瞬间状态。

---

# 30. 推荐领域事件

可以逐步引入：

```rust
pub enum DomainEvent {
    MailReceived {
        mail_id: MailId,
        user_id: UserId,
    },

    MailAttachmentClaimed {
        mail_id: MailId,
        attachment_id: AttachmentId,
        user_id: UserId,
    },

    BadgeActivated {
        user_id: UserId,
        badge_id: BadgeId,
        active_from: Timestamp,
        active_until: Timestamp,
    },

    ItemMoved {
        item_id: ItemId,
        from: ItemLocation,
        to: ItemLocation,
    },

    OwnershipTransferred {
        item_id: ItemId,
        from: Owner,
        to: Owner,
    },
}
```

注意：

> 事件记录的是“已经发生的事实”，而不是命令。

命令：

```text
BuyAuction
ClaimMail
MoveToWarehouse
```

事件：

```text
AuctionPurchased
MailAttachmentClaimed
ItemMoved
```

不要混淆。

---

# 31. Command 与 Event

推荐区分：

## Command

表示：

```text
“我希望世界发生什么”
```

例如：

```text
ClaimMail
BuyAuction
MoveItem
```

## Event

表示：

```text
“世界已经发生了什么”
```

例如：

```text
MailClaimed
AuctionPurchased
ItemMoved
```

服务器执行：

```text
Command
 ↓
校验世界规则
 ↓
事务修改世界事实
 ↓
产生 Event
```

---

# 32. Transaction 是完整业务动作的一部分

对于：

```text
Move Item
Buy Auction
Claim Reward
```

必须优先保证：

```text
All or Nothing
```

逻辑模型：

```text
BEGIN

加载并锁定必要数据
校验前置条件
执行领域操作
持久化世界事实
写审计日志
记录领域事件

COMMIT
```

任何一步失败：

```text
ROLLBACK
```

不要让：

```text
Take 成功
Put 失败
```

这样的半状态存在。

---

# 33. 事务边界应该围绕业务动作，而不是仓储方法

错误思路：

```text
Inventory.Take 自己一个事务
Warehouse.Put 自己一个事务
```

这会形成两个独立提交。

正确：

```text
MoveToWarehouse
```

整个业务动作一个事务。

同理：

```text
BuyAuction
```

应该一起完成：

```text
扣买家货币
改变 Owner
改变 Location
解锁 Item
改变 Listing 状态
增加卖家收益
记录交易
```

不能各自提交。

---

# 34. Repository 不应该泄漏修改权

Repository 主要承担：

```text
加载
持久化
必要的并发控制
```

不要让业务模块获得：

```text
任意修改数据库字段
```

推荐：

```text
Repository
 ↓
加载领域实体
 ↓
领域服务修改
 ↓
Repository 持久化
```

而不是：

```text
AuctionService
↓
直接 UPDATE item SET owner = ...
```

否则领域规则绕过了。

---

# 35. Package / Module 边界表达“谁拥有修改权”

推荐结构：

```text
src/
├── domain/
│   ├── item/
│   │   ├── mod.rs
│   │   ├── item.rs
│   │   ├── owner.rs
│   │   ├── location.rs
│   │   ├── container.rs
│   │   ├── transfer.rs
│   │   └── escrow.rs
│   │
│   ├── reward/
│   │   ├── mod.rs
│   │   └── reward.rs
│   │
│   ├── mail/
│   │   ├── mod.rs
│   │   ├── mail.rs
│   │   ├── claim.rs
│   │   └── policy.rs
│   │
│   ├── auction/
│   │   ├── mod.rs
│   │   ├── listing.rs
│   │   └── service.rs
│   │
│   ├── badge/
│   │   └── ...
│   │
│   └── offline_reward/
│       └── ...
│
├── application/
│   ├── command/
│   └── service/
│
├── infrastructure/
│   ├── persistence/
│   ├── redis/
│   └── database/
│
└── transport/
    ├── websocket/
    └── http/
```

---

# 36. 依赖方向

应该：

```text
Transport
    ↓
Application
    ↓
Domain
    ↓
Repository abstraction
```

基础设施：

```text
Infrastructure
    └── 实现 Repository
```

而不是：

```text
Domain
 ↓
MySQL / Redis / WebSocket
```

Domain 不应该知道通信协议。

---

# 37. Mail 不应该钻进 OfflineReward

错误：

```text
OfflineRewardService
   ↓
查 Mail
   ↓
领取 Mail
   ↓
操作 Badge
```

这会让挂机系统逐渐塞满邮件逻辑。

正确：

```text
Mail
 ↓
Reward
 ↓
Badge
 ↓
World State
 ↓
OfflineReward
```

原则：

> **依赖世界事实，而不是依赖别的业务系统。**

---

# 38. 业务系统不要相互修改内部数据

例如：

```text
AuctionService
```

不能：

```rust
inventory.items.push(item_id);
```

MailService 不能：

```rust
badge.active_until = ...;
```

OfflineRewardService 不能：

```rust
mail.claimed = true;
```

它们必须通过拥有该事实修改权的领域能力。

---

# 39. 让非法状态难以表达

这是 Rust 权威世界非常重要的目标。

不要只依赖：

```text
注释
代码规范
Agent Prompt
Review
```

尽量通过：

```text
enum
私有字段
私有方法
模块可见性
构造函数
领域服务
事务
```

让错误代码直接难以通过编译。

---

# 40. 不要只追求“面向对象式继承”

Rust 本身没有传统 class 继承。

这是好事。

不要强行建立：

```text
Inventory
Warehouse
Mail
Auction

继承 Container
```

更推荐：

```text
Inventory / Warehouse
拥有 Container 能力

Mail
拥有 Claim 业务

Auction
拥有 Escrow 业务

Contract
拥有 Resolve 业务
```

通过：

```text
trait + composition
```

组合真正需要的能力。

---

# 41. LSP 在这里的实际含义

里氏替换原则不是：

```text
所有“能装东西”的系统
都应该实现 Container
```

而是：

> 只有当所有实现都能遵守同一个行为契约时，才应该共享一个抽象。

例如：

```text
Inventory
Warehouse
```

都可以遵守：

```text
put 成功后：
物品确实存在于该容器

take 成功后：
物品确实从该容器移除
```

而：

```text
Auction
```

的 `put()` 实际语义是：

```text
挂拍 + 锁定 + 创建 Listing
```

那它就不应该假装是普通 Container。

---

# 42. 面向 Agent 的硬规则

建议直接写进项目 AGENTS.md / architecture.md。

## RULE-1

业务系统不得直接修改：

```text
Item.owner
Item.location
Item.state
```

---

## RULE-2

以下方法原则上不得公开：

```text
put
take
change_owner
move_to
set_state
```

---

## RULE-3

公开 API 应表达完整业务意图：

```text
MoveToWarehouse
ClaimMail
ListAuction
BuyAuction
CancelAuction
TransferOwnership
```

---

## RULE-4

任何跨多个世界事实的业务动作必须有完整事务边界。

---

## RULE-5

Mail 不负责实现具体 Reward。

---

## RULE-6

Auction 不直接修改 Inventory。

---

## RULE-7

OfflineReward 不直接读取和领取 Mail。

---

## RULE-8

离线玩家依然参与世界规则。

```text
Offline != Frozen
```

---

## RULE-9

世界事实应该在实际发生时落地，而不是等玩家登录时才临时生成。

---

## RULE-10

优先使用 Rust 类型系统阻止非法状态，而不是运行时不断 `if` 修补。

---

# 43. Rust 与 Go 概念快速对照

| Rust | Go | 初学阶段理解 |
|---|---|---|
| `trait` | `interface` | 一组行为契约 |
| `impl Trait for Type` | 隐式实现 interface | 某类型实现该能力 |
| `Result<T, E>` | `(T, error)` | 成功值或错误 |
| `enum` | `const + struct` 的加强版 | 有限状态联合类型 |
| `pub` | 首字母大写 | 对外可见 |
| private | 小写标识符 | 内部可见 |
| `pub(crate)` | Go 无完全对应 | 当前 crate 内部公开 |
| `&T` | 只读引用语义 | 借用查看 |
| `&mut T` | 可修改引用语义 | 独占修改 |
| `match` | `switch` | 穷举 enum |
| `Option<T>` | 指针 / `(value,bool)` | 可能有也可能没有 |

---

# 44. 初学 Rust 时最值得理解的三件事

暂时不需要先学完 Rust 才能设计。

对于权威世界，先理解：

## 1. enum

用来表达：

```text
这个状态只能是这些合法可能性之一
```

---

## 2. private / pub

用来表达：

```text
谁有资格修改世界
```

---

## 3. Result

用来表达：

```text
这个业务动作可能失败
```

先掌握这三个，就已经足以让 Agent 生成比“全字段 public + 到处 if”可靠得多的领域代码。

---

# 45. 推荐的 Item Domain 核心接口

可以逐步发展为：

```rust
pub struct ItemTransferService {
    // repositories / transaction abstraction / event collector
}

impl ItemTransferService {
    pub(crate) fn move_item(
        &mut self,
        item_id: ItemId,
        destination: ItemLocation,
    ) -> Result<(), DomainError> {
        todo!()
    }

    pub(crate) fn transfer_ownership(
        &mut self,
        item_id: ItemId,
        from: Owner,
        to: Owner,
    ) -> Result<(), DomainError> {
        todo!()
    }

    pub(crate) fn lock(
        &mut self,
        item_id: ItemId,
        reason: LockReason,
    ) -> Result<(), DomainError> {
        todo!()
    }

    pub(crate) fn unlock(
        &mut self,
        item_id: ItemId,
    ) -> Result<(), DomainError> {
        todo!()
    }
}
```

---

# 46. 推荐的 Mail Domain

```rust
pub struct MailService {
    // ...
}

impl MailService {
    pub fn claim_all(
        &mut self,
        user_id: UserId,
        now: Timestamp,
    ) -> Result<ClaimResult, DomainError> {
        todo!()
    }

    pub(crate) fn claim_by_selector<S: AttachmentSelector>(
        &mut self,
        user_id: UserId,
        selector: &S,
        now: Timestamp,
    ) -> Result<ClaimResult, DomainError> {
        todo!()
    }
}
```

---

# 47. 推荐的 Offline Auto Claim

不要让 OfflineReward 直接主动偷取邮件。

更推荐：

```text
MailCreated / MailReceived
↓
MailAutoClaimPolicy
↓
ClaimAttachment
↓
RewardGranted
↓
BadgeActivated
```

如果业务暂时不做实时事件，也可以在离线结算前执行：

```text
ApplyPendingAutoClaimPolicies
↓
再计算 OfflineReward
```

但这只是实现妥协。

领域语义仍然应该是：

> Badge 应从满足自动领取条件的时间点开始影响世界。

---

# 48. 推荐的离线收益状态

不要只存：

```text
current_rate
```

可以逐步抽象：

```rust
pub struct RewardModifierPeriod {
    pub from: Timestamp,
    pub until: Timestamp,
    pub multiplier: FixedPoint,
}
```

或者记录领域事件：

```text
OfflineModifierActivated
OfflineModifierExpired
```

结算时根据时间线切段。

---

# 49. 一张总图

```text
                         Command
                            │
                            ▼
                    Application Layer
                            │
                            ▼
                  ┌──────────────────┐
                  │   Domain Rules   │
                  └────────┬─────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
       Item             Reward            Mail
   ┌──────────┐      ┌──────────┐      ┌──────────┐
   │ Owner    │      │ Item     │      │ Claim    │
   │ Location │      │ Currency │      │ Policy   │
   │ State    │      │ Badge    │      │ Expire   │
   └────┬─────┘      └────┬─────┘      └────┬─────┘
        │                 │                 │
        │                 ▼                 │
        │              Badge               │
        │                 │                 │
        │                 ▼                 │
        │          Offline Modifier         │
        │                 │                 │
        ▼                 ▼                 ▼
   Transfer          Offline Reward      Auto Claim
   Ownership
   Escrow
        │
        ▼
     Auction
      Trade
    Contract
```

---

# 50. 最终设计原则

整个 Rust 权威世界可以压缩成以下几句话：

## 1

```text
先建模事实，
再建模系统。
```

---

## 2

```text
Owner ≠ Location ≠ State
```

不要混成一个“所属容器”。

---

## 3

```text
业务表达意图，
领域服务修改事实。
```

---

## 4

```text
Put / Take 是机制，
Transfer / Claim / Buy 是业务。
```

---

## 5

```text
机制尽量私有，
完整动作才公开。
```

---

## 6

```text
复用规则和机制，
不要强行复用业务接口。
```

---

## 7

```text
玩家离线，
世界仍然运行。
```

---

## 8

```text
世界事实应该在真正发生时落地，
登录只是观察事实，而不是创造事实。
```

---

## 9

```text
让非法状态难以表达，
比写更多校验更可靠。
```

---

## 10

```text
让 Agent 没有权限写错，
比告诉 Agent“不要写错”更重要。
```

---

# 51. 给 Agent 的最终提示词摘要

可以直接作为代码生成约束：

```text
这是一个 Rust 权威世界服务器。

设计任何业务前，优先识别并建模“世界事实”，不要从 UI 或具体系统入口出发。

必须遵守：

1. Item.owner、Item.location、Item.state 为私有字段。
2. 业务模块不得直接修改 Item 世界事实。
3. put/take/change_owner/move_to/set_state 为领域内部原语，不作为公共 API。
4. 对外 API 必须表达完整业务意图，如：
   MoveToWarehouse、ClaimMail、ListAuction、BuyAuction。
5. Inventory/Warehouse 可以共享内部 Container 能力；
   Mail/Auction 不得为了统一接口而强行实现 Container。
6. Auction、Trade、Contract 等共享 Escrow 机制，而非共享错误的业务接口。
7. MailAttachment 使用 Reward 建模，不假设所有附件都是 Item。
8. Mail 只负责 Claim，不负责具体 Reward 的落地逻辑。
9. OfflineReward 不直接读取或领取 Mail，只消费已经形成的 Badge / Modifier 世界事实。
10. 玩家离线时世界仍继续演化。
11. 任何跨多个世界事实的修改必须处于同一个事务边界。
12. 优先使用 Rust enum、private 字段、模块可见性和类型系统，使非法状态无法或难以表达。
13. Command 表达意图，Event 表达已经发生的事实，不混用。
14. Repository 负责加载/持久化，不允许业务绕过领域规则直接更新数据库字段。
15. 设计时优先保证：
    correctness > explicit world invariants > simplicity > reuse。
```

---

# 52. 一句话总纲

> **Rust 权威世界不是“所有系统都能操作数据”，而是“世界事实只有少数领域核心有权修改；其他业务只能提交合法意图”。**

这也是整个模型最值得长期坚持的原则。
