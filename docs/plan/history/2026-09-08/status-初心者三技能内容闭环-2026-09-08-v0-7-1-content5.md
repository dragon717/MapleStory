# 初心者三技能内容闭环（2026-09-08，v0.7.1 / content5）
> 状态：已完成（待验收）

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 624–634 行；原条目状态保留，不因迁移改判。


- 用户要求先查现有参考、缺失再联网。本地实际TMS273.7 Skill/000.img、String/Skill.img与Sound/Skill.img已核并导出：0001000嫩寶丟擲術、0001001治癒、0001002疾風之步，内容key规范1000/1001/1002，book0、max3，原前导零路径与指纹保留在resources/tms273-export/skills.json、mage-effects.json、skill-sounds.json。其余五个可见节点缺默认授予/解锁依据，未擅自免费开放。
- T数值：丢掷MP3/5/7、固定伤害10/25/40；治愈MP5/10/15、30秒恢复24/48/72HP、CD120秒；疾风MP4/7/10、持续4/8/12秒、速度+10/15/20、CD60秒。源无壳消耗字段，不套Classic/私服材料消耗。三技能图标与各级说明；丢掷每级球3帧/命中6帧、治愈13帧/疾风12帧、原Use/Hit音效均已导出。
- 复用SP/技能动作账本与MP/冷却事务，book0仅允许这三项最高3级；重放不重复扣SP/MP，转职后保留初心者学习/使用权限，已消费SP不会被旧档补偿重新加回。丢掷单目标固定伤害、不受魔攻/暴击/魔防影响，具有动作锁；治愈六次tick先持久保存再改内存HP，不超上限；疾风实际改变移动速度，死亡/离图/断线清buff，CD仍持久且重登可见。
- P适配边界：源未给1000精确距离/命中调度，复用当前远程340px与600ms动作锁，立即权威结算；回血每5秒一次由源x与30秒总量推导。针对本地缺失的执行时点已补查 https://maplestorywiki.net/w/Three_Snails 与 https://maplestorywiki.net/w/Recovery 等跨区资料，未取得TMS273精确执行证据，不采用Classic冲突数值。现有基础MP容量/成长保持原规则，未为施放免费加MP或降低源消耗。
- 前端K初心者页可学习/施放，初心者1/2/3分别丢掷/治愈/疾风；转职后快捷键恢复原职业映射，初心者页仍可操作。显示效果/CD剩余时间；skillCast/damageEvent可选skillLevel锁定对应球/命中素材。DerivedStats新增可选skillCooldowns/skillBuffs，协议7兼容，content5。运行manifest将分级效果投影为1000:1..3扁平组并去掉顶层来源对象，维持预加载数组契约；完整来源仍留原导出。
- 验证通过：auth::beginner_learning_sp_and_cooldowns_survive_replay_and_reopen；world::beginner_skill_runtime_locks_fixed_damage_and_timed_buffs；mage::bundled_catalog_is_strict_and_has_energy_bolt_geometry（真实32节点）；cargo check；client typecheck；points.check.mjs/input.check.mjs/combat/skill.check.mjs；check_tms273_runtime.cjs tms273-5（17地图、24034素材引用）；Vite生产构建到client/dist-beginner-check；定向diff空白检查。核心检查变更7文件、不到500行，无独立QA。
- 发布与用户待验：源码/资源装配已完成，未更新在线dist-tms273、未重启服务、未写在线账号库；下次根启动3010.command统一带入。待用户实际验收K加点、1/2/3施放、原素材朝向/位置、MP提示和旧账号补点到账。初心者三技能已完成，不能把更高转职或所有000事件技能算作完成。


