# 2026-09-06：任务多语言 M3 v0.3.1（gms83-quest-2 / protocol 6）
> 状态：已完成（待验收）

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 211–220 行；原条目状态保留，不因迁移改判。


任务显示文本改为**服务端权威多语下发**：服务端加载 `shared/quest-text.json` 语料目录（新 `quest_text` 模块），Join 后推 `questList`、任务 start/complete 转移后推 `questUpdate`，name/summary 按玩家语言（hello 携带的 `lang`，zh 缺省/en 显式）解析，en→id 兜底。客户端 quest log 删除本地 `questTextMap` 映射（`quest-text.generated.ts` 移除）只渲染服务端文本。

服务端（Rust）：`quest_text.rs`（新增）、`protocol.rs` Hello `lang` + protocol 6、`network.rs` lang 透传 Join、`world.rs` Player/Command/World 挂 lang 与语料目录 + questList/questUpdate 推送、`main.rs` 注入语料。客户端（TS）：`shared/protocol.ts` v6/`gms83-quest-2`、`session.ts` hello 带 `lang: uiLocale()`、`quest/log.ts` 直渲服务端文本。

必要检查：`cargo test` 65/65（quest_text 4 单测 + world 3 集成）；`npm run typecheck` PASS；`git diff --check` 干净。运行文件同步 quest-2：`evidence/2026-09-12/runtime-snapshots/gameplay-round2.json`、`client/public-gameplay/assets/manifest.json`、`references/gameplay-assets/manifest.json`。

受控更新 3010：health `ok=true / protocolVersion=6 / gms83-quest-2`（server PID38678、bot PID38742 维持 TCP）。上线验证：双语 questList e2e 探针（新增 `qa/quest_i18n_probe.mjs`）en/zh PASS（1021 Roger's Apple/罗杰的苹果 等）；`qa/quest_smoke_probe.mjs` 升级到动态协议版本并补 questUpdate 断言，8/8 通过（accept/turn-in 推送 + reward 300 与到账一致）。DB 备份 `evidence/2026-09-12/runtime-recovery/pre-m3-quest-i18n.sqlite3`。M4 校对 reviewed 翻转待推进。

