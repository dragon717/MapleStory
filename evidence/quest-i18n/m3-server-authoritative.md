# M3 服务端权威多语源 — 落地报告

> 日期：2026-09-06 ｜ 里程碑：M3（协议 protocol 6 / content `gms83-quest-2`）
> 状态：**已实现 + 已受控上线 3010**（2026-09-06 04:59，protocol 6 / `gms83-quest-2`；e2e 双语验证通过）。

## 目标（对齐 QUEST_I18N_ROADMAP.md §3.3/§5 M3）

服务端加载 `shared/quest-text.json` 作为**唯一离线权威多语文本源**，`questList`（Join 全量推送）与
`questUpdate`（start/complete 转移推送）按**玩家语言**下发 name/summary；客户端删除本地语料映射，
只渲染服务端文本；协议与 contentVersion 递增。

## 改动清单

### 服务端（Rust）
- `server/src/quest_text.rs`（新增）— `QuestTextCorpus`：加载 `shared/quest-text.json`，`name/summary`
  按 `lang → en → 兜底(id/空串)` 解析；`normalize_lang`（仅显式 `en` 命中英文，其余 zh）。含 4 个单测
  （语言/回退/归一化/真实语料可加载且两条现行任务双语齐全）。
- `server/src/protocol.rs` — `PROTOCOL_VERSION 5→6`、`CONTENT_VERSION → gms83-quest-2`；`Hello` 新增
  可选 `lang`（`zh`/`en`，缺省 zh），`valid()` 校验。
- `server/src/network.rs` — hello 解出 `lang` 透传 `Command::Join`。
- `server/src/world.rs` —
  - `Command::Join` + `lang`；`Player` + `lang: &'static str`；`World` + `quest_text` 语料目录
    （`build` 默认空目录，测试不受影响；`with_quest_text` 供生产注入）。
  - Join 成功后 `snapshot` 之后推 `questList`（全量、按玩家语言、en→id 兜底）。
  - `apply_quest_effect` 转移成功后推 `questUpdate`（name/summary/status + 实际结算的奖励 mesos/exp/items）。
  - 新增 3 个集成测试：Join 推送按语言本地化的 questList（en）、缺省 zh 兜底、任务转移推送本地化
    questUpdate 且奖励与实际结算一致（300 mesos）。
- `server/src/main.rs` — 注册 `quest_text` 模块；启动加载语料（env `QUEST_TEXT_FILE`，缺省
  `shared/quest-text.json`）注入 world。

### 共享 / 客户端（TS）
- `shared/protocol.ts` — protocol 6 / `gms83-quest-2`；`hello` 可选 `lang?: 'zh'|'en'`。
- `client/src/network/session.ts` — hello 携带 `lang: uiLocale()`（沿用 `?lang=en`）。
- `client/src/features/quest/log.ts` — 删除 `questTextMap` 本地映射；仅渲染服务端下发文本
  （name 空时兜底 questId）；不再 import 生成的语料文件。
- `client/src/features/quest/quest-text.generated.ts` — **删除**（M3 起客户端不再内置任务语料映射；
  `scripts/quest_i18n/gen_quest_log_map.py` 已标注为 M2 时代产物，仅作离线抽查）。
- `shared/gameplay.json` — `contentVersion → gms83-quest-2`。

## 验证证据
- `cargo test`：**65 passed / 0 failed**（新增 quest_text 4 单测 + world 3 集成测试全绿；
  既有 58 项无回归——含 portal/knockback/revive/商店/背包既有用例）。
- `cargo fmt` 通过；`npm run typecheck`（tsc --noEmit）PASS。
- 定向测试抽样断言：
  - en Join：`questList[1021].name = "Roger's Apple"`、summary 为英文语料全文。
  - zh Join（缺省）：`questList[1021].name = "罗杰的苹果"`、summary 为中文语料全文。
  - 转移：start `maple-road-training` → questUpdate `active` 中文名"训练营任务确认"；complete →
    questUpdate `completed` + `reward.mesos=300`（与玩家实际到账一致）。

## 上线验证（3010，2026-09-06 04:59）
- health：`{"contentVersion":"gms83-quest-2","ok":true,"protocolVersion":6}`。
- 双语 questList e2e（`qa/quest_i18n_probe.mjs`，注册→播种 1021 active + maple-road-training
  completed→WS 带 `lang` 入服）：
  - `PASS en: Roger's Apple / Training Camp Check`（summary 为英文语料）
  - `PASS zh: 罗杰的苹果 / 训练营任务确认`（summary 为中文语料）
- 完整任务链路（升级版 `qa/quest_smoke_probe.mjs`）：**8/8**，新增断言「Server pushes
  questUpdate on accept/turn-in」（active/completed + reward 300 与到账一致）。
- 前端资源：`/` 200；`/assets/manifest.json` contentVersion `gms83-quest-2`；陪测 bot 与 3010
  TCP ESTABLISHED。
- 运行文件已同步 quest-2：`evidence/runtime/gameplay-round2.json`、`client/public-gameplay/assets/manifest.json`、
  `references/gameplay-assets/manifest.json`。
- DB 备份：`evidence/runtime/3010-control/pre-m3-quest-i18n.sqlite3`。

## 备注
- `qa/quest_smoke_probe.mjs` 由旧 protocol 4 / npc-1 常量升级为动态读登录响应版本，并补 questUpdate
  推送断言；`qa/quest_i18n_probe.mjs` 为新增双语 e2e 探针（后续 M4/新语言发布可复用）。
- M4 校对 reviewed 翻转、新语言（如需）沿用同一探针回归。
