# 数据契约草案（项目设计，不是原作内部结构）

## 共同约束

静态定义使用稳定ID和ruleVersion；运行时实例有唯一ID。任何金额/数量在服务端校验范围、符号与溢出。表现资源ID不承担技能判定语义。技能执行与动画、物品模板与实例、任务完成与奖励领取分别建模。

模拟时钟用于战斗；业务时区和周期键用于日周刷新；真实到期时间用于需要离线消耗的期限。数据中明确单位，不把“帧”“毫秒”“时间戳”混用。

## 建议聚合与接口

| 聚合 | 持有事实 | 输入命令 | 输出事件 |
|---|---|---|---|
| WorldInstance | 地图实例、实体、生成点 | Move/EnterPortal/Spawn | EntityMoved/MapEntered |
| Combat | 施法实例、命中、资源、冷却 | Cast/Cancel/HitRequest | CastAccepted/HitResolved/EntityDied |
| Effects | 来源、层数、起止、互斥组 | Apply/Remove/Dispel | EffectChanged/StatsInvalidated |
| Quests | 接取、目标计数、完成与领取 | Accept/Progress/Claim | QuestChanged/RewardClaimRequested |
| Inventory | 物品实例、格子、货币、领取键 | Pickup/Consume/Grant/Equip | InventoryCommitted/GrantRejected |
| Progression | 核心、符文、装备改造、永久成长 | Enhance/Unlock/ApplyPreset | ProgressionCommitted |
| PeriodLedger | 业务周期及已结算事实 | ClaimForPeriod/Settle | PeriodClaimCommitted |

这些是模块边界而不是必须拆成七个微服务。首版可在单进程里实现。

## 关键定义字段

SkillDef：id、ruleVersion、activationType、resourceCost、cooldownPolicy、timeline、targetFilter、hitSchedule、movement、appliedEffects、spawnedEntities、presentation。

EffectDef：id、tags、stackGroup、stackPolicy、durationPolicy、extensionEligibility、deathPolicy、mapChangePolicy、offlinePolicy、modifiers、periodicEvents、visibility。

EffectInstance：instanceId、definitionId、sourceEntityId、targetEntityId、startTime、expiryTime、stacks、sourceSnapshot（仅明确需要快照时）。

QuestDef：id、chapterId、visibilityConditions、acceptConditions、objectives、completionConditions、rewardDefinition、repeatPolicy、skipPolicy。QuestState单独保存Accepted/ObjectivesComplete/RewardClaimed，章节与任务不是同一状态机。

MapDef：id、regionId、instancePolicy、bounds、footholds、ladders、portals、spawnGroups、hazards、respawnPolicy、cameraBounds、backgroundLayers。

EquipmentInstance：instanceId、itemDefId、scrollState、starforceState、potential、additionalPotential、additionalOptions、extensionStates、bindPolicy、expiry、locked、ruleVersion。

DropInstance：dropId、originEventId、rewardDefId、ownershipPolicy、eligibleRecipients、createdAt、expiresAt、claimedBy。角色归属/队伍归属与是否显示为地面物品是不同维度。

EnhancementRule：ruleVersion、eligibility、cost、outcomes、probabilities、protectionOptions、failurePolicy、transferPolicy。未核定原作概率用null，不用演示值顶替事实。

GuideEntry：id、visibilityConditions、priority、recommendedReason、targetContent、blockReasons、action、expectedRewardUse。

## 最关键的可靠性约定

领奖/拾取请求携带请求ID；服务端使用业务事实键（掉落ID、任务ID+角色+周期等）保证幂等，而不是仅信任客户端生成的请求ID。重试返回已有结果，不重复产出。

装备强化的扣费、实例修改和操作记录在一致边界内提交；展示动画失败/断线不改变已提交结果。跨服务时另行设计事务或补偿，首版不为了架构形式引入分布式事务。

Boss击杀与奖励可能跨实例生命周期，使用唯一遭遇战/击杀事件ID。练习标记进入结算资格校验，不能只在UI隐藏领取按钮。

日周刷新以规则版本+周期键判定；结算事实不可依赖“恰好执行到零点的一次Tick”。
