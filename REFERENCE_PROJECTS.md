# 参考项目分级与去重

更新：2026-09-05。14 个仓库已经浅克隆。P0 是当前优先审核，P1 是遇到具体缺口再查，“仅索引”不继续深入；已有克隆保留，不擅自删除。停止新增重复仓库和重复素材包下载。

**优先四类：完整同版底包、Web TS 纸娃娃、Rust 资源解析、任务业务规则。** 同源关系、派生数据与用途相同分别标明，不把同一用途当成代码同源。

| 级别 | 仓库 | 主要用途 | 重叠关系与独有价值 |
| --- | --- | --- | --- |
| P0 | [MapleStoryUnity/wzData](https://github.com/MapleStoryUnity/wzData) | 完整同版 WZ 的来源索引 | 仓库仅 README；已据此下载 GMS83 的 83.zip。与 Cosmic-client 大量 v83 内容重叠，但不是同一修改包 |
| P0 | [DevenWen/maplestory_web_phaser_ts](https://github.com/DevenWen/maplestory_web_phaser_ts) | TS / Phaser 加载、动画、纸娃娃 | 与同作者 Godot 路线明确关联；直接适配 Web 研究，v079 资源规则可查。默认是 demo，非完整客户端 |
| P0 | [davipk/wzlib-rs](https://github.com/davipk/wzlib-rs) | Rust + TS WZ 解析候选 | 与 libwz 用途重复，未认定代码同源；README 声明从 MapleLib / WzComparerR2 移植，采用前须核查许可链 |
| P0 | [P0nk/Cosmic](https://github.com/P0nk/Cosmic) | 技能、任务、数值、业务规则 | 明确来自 HeavenMS / OdinMS；规则覆盖广。WZ XML 去掉图像，且有自定义 v83 修改 |
| P1 | [Sheilem/maplewright](https://github.com/Sheilem/maplewright) | Rust 纸娃娃、地图烘焙、foothold | 与其它客户端 / 解析器用途重叠；有 zmap、命名锚点与脚点模型。不用其 Rust/WASM 前端替代 TS/JS |
| P1 | [andrenogrib/gms_v83_wztoweb](https://github.com/andrenogrib/gms_v83_wztoweb) | 静态预览 / 覆盖索引 | 明确使用 Cosmic XML / SQL / 修改 WZ，是派生数据；WEB 有 21,529 预览 PNG，无完整动画和音频 |
| P1 | [toyobayashi/libwz](https://github.com/toyobayashi/libwz) | C++ / JS / WASM 解析备选 | 与 wzlib-rs 用途重叠，作者称独立实现；只在首选解析器有缺口时交叉核验，不双套接入 |
| 仅索引 | [DevenWen/maplestory_in_godot](https://github.com/DevenWen/maplestory_in_godot) | Godot 拼接思路 | Phaser README 明确指向同作者 Godot 后续方向；仅在 Web 参考解释不清时查看 |
| 仅索引 | [mikuYongh/Godot-mapleStory](https://github.com/mikuYongh/Godot-mapleStory) | Godot demo / 网盘线索 | README 明确使用 DevenWen WZ 和人物逻辑；旧 demo 已停用，资源外置 |
| 仅索引 | [MapleStoryUnity/MapleStoryUnity](https://github.com/MapleStoryUnity/MapleStoryUnity) | Unity 客户端 | 与 wzData 是同组织的工程 / 数据索引分工；不属于两份独立完整资源。已从 wzData 取得来源即可 |
| 仅索引 | [P0nk/Cosmic-client](https://github.com/P0nk/Cosmic-client) | Cosmic 配套修改客户端 / WZ | 与 Cosmic 明确配套；缺 Sound / Effect 底包。当前克隆保留 14 个 LFS 指针，不算实际 WZ |
| 仅索引 | [roshanlodha/mapleweb](https://github.com/roshanlodha/mapleweb) | C++ / WASM 网页客户端 | 与 Maplewright 功能重叠，本次未建立两者代码同源证据；自备 NX，默认 v83 + v153+ UI 混版，不作统一素材源 |
| 仅索引 | [neeerp/RustMS](https://github.com/neeerp/RustMS) | 早期 Rust 旧协议服务端 | README 明确内嵌整个 HeavenClient；Rust 服务端与 Cosmic 仅用途重叠，不认定同源 |
| 仅索引 | [liwenone/maplestory](https://github.com/liwenone/maplestory) | HTML5 demo / 有限素材 | README 称来自 MapleSimulator；1,110 PNG、4 MP3，未保证原始版本，不作完整素材底包 |

## 实际资源状态

GMS83 的 83.zip 已下载，精确大小 1,752,051,975 字节；17 个 WZ 已解压，共 1,973,916,727 字节。现有校验 JSON 记录 ZIP CRC 和各 WZ SHA256；素材解码与动画完整性由单独审计复核。**下载完成不等于全量像素、动画链接和声音均验收完成。** 用户尚未选定最终游戏版本，v83 是当前优先核验候选。

Cosmic 的 22,190 个 XML 不是图像；wztoweb 全库 21,530 个 PNG 包含一张额外截图，WEB 的 21,529 张是预览，不是全部动画帧。Godot JSON 可能内嵌 base64 Canvas，不能仅按文件扩展名断言有没有真实图像。

## 补充检索：只记录，不继续克隆

- [ZeromaXHe/MapleStoryCopy](https://github.com/ZeromaXHe/MapleStoryCopy)：Godot C#，可见 Tile PNG、小地图 PNG、FloralLife.mp3，README 提及 079 / 083。与现有案例用途重叠，未实测完整同版资源。
- [TurbosauceDev/MapleSurvivors](https://github.com/TurbosauceDev/MapleSurvivors)：Godot 衍生玩法，MapleSim / BannedStory 与作者自制素材混用，不能作为原版完整包。
- [PShocker/StudyMS](https://github.com/PShocker/StudyMS)：已归档，Data.7z 通过群渠道，未取得可核验完整包。
- [AcNEO/maplestory](https://gitlab.com/AcNEO/maplestory)：GitLab HTML5 项目，有角色、map、music 目录；未全量比较，不认定独立完整源。
- [MapleStory.io](https://maplestory.io/)：按地区 / 版本访问素材的 API，适合查验；LAN MVP 不依赖外站实时供图。
- [wzbrowser](https://wzbrowser.poofcakes.com/)：浏览器解析自备 WZ 的工具，不是素材分发包。
- [Maplit Life](https://ocuc.itch.io/maplit-life)：作者称原创 code-art 的浏览器原型，不能补原冒险岛素材。

## 来源和许可证

GitHub API 标记：Cosmic / Maplewright / Mapleweb 为 AGPL-3.0，RustMS / MapleStoryUnity 为 GPL-3.0，DevenWen 两库 / libwz / wzlib-rs 为 MIT。其余已克隆仓库 API 未识别许可证。原始记录见 references/evidence/*-repo.json。

以上是代码仓库声明，不自动覆盖 MapleStory 图片、音频及内容的再分发权限。目前没有权利人单独授权这些素材的证据；wzlib-rs 的移植来源许可需另核。所有参考库保留独立目录，未执行安装脚本或游戏 EXE。

## 已固定提交

详细提交、时间、工作树字节、扩展名、LFS 指针和未拉取子模块信息在 references/evidence/repository-inventory.json。以下是可复查的提交摘要。

| 仓库 | 固定提交 |
| --- | --- |
| DevenWen/maplestory_in_godot | `8b6c335586fb1714f1602168197b762c55532f81` |
| DevenWen/maplestory_web_phaser_ts | `729153c3933d04078fd0c442654ef8ec36fdc288` |
| MapleStoryUnity/MapleStoryUnity | `ef4b81bb0cef611fb1c6f7f90dc238a0f555432e` |
| MapleStoryUnity/wzData | `1c763ae22a1aa3e228cf14bd8d9bdf0b5abe4056` |
| P0nk/Cosmic | `fec53bc7714dc0f1ae3f50b2986cdf2727e0912a` |
| P0nk/Cosmic-client | `6b7328b1593d34a4b134fe6b8a6d20119e526030` |
| Sheilem/maplewright | `79b3e8fb25c84c45212c12b45235cdc00c6f6f3c` |
| andrenogrib/gms_v83_wztoweb | `58c0c763b2eb4a868e5aeb198e6ead3313f229df` |
| davipk/wzlib-rs | `dc129ee89c1048a7d30aa79de68e1eda60194b78` |
| liwenone/maplestory | `63c163adeae6088d329bb445ebf11bbbe41ec197` |
| mikuYongh/Godot-mapleStory | `5db1f7d8c4be389aa44b8a401e840f87e3a68bf3` |
| neeerp/RustMS | `171c73df73ebff6f1939b73d0eed3f6ad8e931ce` |
| roshanlodha/mapleweb | `bc0234fe7c7f53322453e7bdd79564d9aca4cd8b` |
| toyobayashi/libwz | `98e69cd50504a55feecc4277cc041c52c1cc538d` |

文档导航：[计划](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/PLAN.md>) · [共同契约](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/SHARED_ARCHITECTURE.md>) · [前端](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/FRONTEND_ARCHITECTURE.md>) · [后端](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/BACKEND_ARCHITECTURE.md>) · [验收标准](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/ARCHITECTURE_ACCEPTANCE.md>)
