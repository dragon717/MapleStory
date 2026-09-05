# 当前工作计划

更新：2026-09-05。长期规范见 BUSINESS_DEVELOPMENT.md，已完成记录见 IMPLEMENTATION_STATUS.md。

## 正在执行：原版地图怪物

- `/root/life_backend`（Luna max）：server/src/world.rs 唯一写入，mapId/f/mobTime 出生配置、加载顺序、地图隔离与刷新检查；不动协议/素材。
- `/root/life_assets`（Luna max）：scripts/export_gameplay.cjs、export_inventory.py、参考素材manifest与shared/items.json；8种怪物动作/源信息和对应掉落图标导出，不动服务端/整合脚本。
- root：WZ/XML→玩法配置生成、integrate_gameplay.py、前端整合、最终定向检查及受控更新；保留既有修改。

## 实际剩余

| 剩余项 | 负责人/依赖 | 完成条件 |
| --- | --- | --- |
| 新手区域原版 life 与怪物 | root 编排，后续 Luna max 业务代理 | 按各图 WZ life 接入对应怪物、坐标、刷新与掉落；现有测试 Snail 布点不能当作原版完成 |
| NPC、教学脚本、任务与商店 | root 按参考确定逐项范围，后续 Luna max | 读取对应同版脚本与 Check/Act/Say 后接入权威业务；不把地图及店铺背景可进入当业务已实现 |
| 当前版本用户亲测 | 用户；反馈由 root 分给对应业务代理 | 新路线、普通/隐藏门按 ↑、触碰门、伤害数字、原有装备物品栏、梯绳/下跳与战斗体验 |

本轮两个 Luna max 子代理完成战斗参考核对和地图资源接入；root 完成进门触发/可恢复失败、整合与受控更新。具体成果及检查见历史。本目标“继续按参考去复刻”仍有以上业务差距，不宣称整套复刻完成。

## 当前运行环境

- 新版：http://127.0.0.1:3010/；协议3，客户端 v0.2.1，构建时间 2026年09月05日 23:11:32。
- server PID31163，唯一陪测 bot PID31224；原入口脚本托管。旧3000无监听。
- 数据库 server/data/qa-gameplay-round2.sqlite3，账号25/角色24，完整性 ok；升级备份 evidence/runtime/3010-control/pre-reference-v021.sqlite3。升级使内存 session 失效，需刷新并重新登录。
- 静态目录 client/dist-next，入口 index-Db_VXX-2.js / index-D0RTgpKK.css；资源 client/public-gameplay/assets。
- 地图共23张，出生点000010000，新增已证实的001010000、001020000、002000000、002000001。脚本训练入口和离岛NPC作为后续业务边界。
- 固定配置 evidence/runtime/gameplay-round2.json、map-round2.json、shared/maps.json；保留账号/存档与唯一bot。

## 验收边界

仅执行实际改动所需的编译和针对性自检；不启动独立QA、不创建3011、不运行额外网络账号探针。用户实玩未测不标通过。每个可运行阶段用既有脚本受控更新3010，保留数据库、真实版本和秒级构建时间。完成事项移入历史，不重复建台账。
