# 素材版本与 Git 分发

现行文件清单见 [最近素材批次](current-asset-batch.json)，文件的字节数、SHA-256 与存储位置以清单为准。资源只保留当前可用版及必需源输入；素材历史快照和自动备份删除，代码历史由 Git 保存，计划和交付日志保留。

## 本轮批次

- 普通 Git：最近航船的 13 张图片/贴图、生成说明、布局和来源记录，以及小型魔法书 Blender/GLB；经典登录树工程、渲染和重建脚本已经合入。
- 当前航船/天空之城大模型暂存本地。本轮按用户“先上传最近且不大的素材”分批，不把完整素材树或大模型塞入普通 Git。
- 音乐及音效暂不上传、不清理；其他场景、原始来源、vendor 与运行资源导出本轮保留。后续批次和定时任务尚未安排。
- 当前 Blender 中供修复使用的原始部件是必要输入，不属于独立历史文件快照。带 v1/v2 名称的共享 vendor、参考图和仍被脚本读取的输入同样不按名称清理。

## 大文件的后续方式

| 内容 | 分发方式 | 克隆后的边界 |
| --- | --- | --- |
| 小型原创图片、贴图、源输入和来源说明 | 逐文件加入 Git 白名单 | 普通 clone 可取得 |
| 需要协作修改的当前大型 Blender/GLB | 后续批次启用 Git LFS，提交指针并上传实际对象 | 需安装 Git LFS；本轮尚未上传这些对象 |
| 可再生的大量运行素材 | 现有资源打包脚本生成 ZIP 与 SHA-256；单独传输，或后续放 GitHub Release | 需取得与源码匹配的资源包，Git clone 不包含它 |
| 原版 WZ、来源包、账号数据库、凭据、日志和缓存 | 保留现有本地归属与忽略边界 | 不属于本轮素材提交 |
| 独立历史素材快照与自动备份 | 按只留当前版的授权清理 | 保留计划/交付记录，不再保留快照二进制 |

GitHub 对普通 Git 中超过 50 MiB 的文件给出警告，超过 100 MiB 拒绝；本项目提交守卫更保守，拒绝超过 **90 MiB** 的普通 Git blob。LFS 的 Git 指针和实际对象需要一起可用，不能只提交一个指针就声称大文件已经上传。GitHub Release 单个附件需小于 2 GiB；更大的运行包按功能分包，并为各包保留 SHA-256。[GitHub 大文件说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)、[Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)、[Release 限制](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。

LFS 有独立存储与下载用量，历史对象仍可能占空间；开始上传大模型前核对仓库所有者的实际用量和预算，不购买额度或启用付费。[Git LFS 计费](https://docs.github.com/en/billing/concepts/product-billing/git-lfs)。

## 维护

新增一批素材时先核对实际消费者、来源与大小，只对确认文件增加白名单，再更新最近批次清单。不要放开整个 resources 目录。提交前运行现有 Git 忽略边界、体积和冲突副本检查；素材整理不需要重新构建或重启游戏。
