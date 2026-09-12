# Windbell Blender MCP 资产制作记录

本文件记录风铃桥、风铃岛资产库的 Blender MCP 安装、实测连接和交付约定。它只描述可编辑美术资产与导出物；运行时世界节点、个人状态和游戏接入仍由游戏工程负责。

## 已落地

- 使用官方上游 [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp)，通过 `/Users/muniao/.local/bin/uvx --python 3.11 blender-mcp` 启动 MCP stdio 客户端。
- 官方 addon 安装到项目目录 `resources/creative/windbell/blender/addons/blender_mcp.py`，没有覆盖用户 Blender addon。
- Codex MCP 只新增 `blender` 配置，连接 `localhost:9987`，启用 `BLENDER_MCP_SAFE_MODE=1`、`DISABLE_TELEMETRY=1`；用户已有 Blender 实例没有关闭。
- 独立 Blender 5.2.1 LTS 实例已由真实 MCP `execute_blender_code` 执行建模脚本，且由 MCP `get_addon_status`、`get_scene_info` 和后置验证调用读取结果。完整回执保存在 `resources/creative/windbell/blender/logs/mcp_evidence.json`。
- MCP 回执记录：addon `up_to_date=true`、协议版本 5、server `BlenderMCP 1.30.0`、addon 版本 1.6、telemetry consent `false`；后置查询读到 12 个场景、17 个 Windbell 资产集合、399 个 Windbell 对象和 8 个动画 rig。
- `.blend` 在场景组装完成后先保存一次，渲染与 GLB 导出完成后再次保存；因此预览失败不会丢失可编辑场景。

## 资产结构

构建入口为 [`build_windbell_assets.py`](../../../scripts/creative/blender/build_windbell_assets.py)，清单为 [`manifest.json`](../../../resources/creative/windbell/blender/manifest.json)。所有物体使用 `world_state`、`asset_kind`、`render_layer`、`axis_convention` 自定义属性；状态读取键是 `world_state`。

公共风铃桥资产库以 `WB_BridgeRoot` 组织，集合拆分为；两个主场景在渲染/GLB 时直接链接 `WB_Bridge_Common` 与目标状态集合，避免把其他状态混入画面：

- `WB_Bridge_Common`：两岸、河流、踏石、巨树、风铃棚和背景山体。
- `WB_Bridge_State_Broken`：断开的两段桥身、倾斜物料车、材料堆、完整/磨损/断开的绳索。
- `WB_Bridge_State_Working`：施工中的桥段、支架和施工绳。
- `WB_Bridge_State_Connected`：完整桥身、绞轴、止挡与完整绳索。
- `WB_Bridge_State_Inhabited`：直立货车、生活棚亭、风铃和植物。
- `WB_Bridge_State_AnimationStudy`：桥断裂到修复的动画研究对象。

个人风铃岛资产库以独立 `IS_WindbellIslandRoot` 组织，主场景直接链接公共岛集合与四个 `IS_Scene_Current_*` 当前状态包；完整变体集合仍保留在库中，集合覆盖：

- `IS_RootPath_6_to_8_Modules`：8 段根道及节点、苔藓。
- `IS_TreeBridge`：树桥桥身、支撑、绞轴和止挡。
- `IS_Rope_StateVariants`：complete / worn / severed / charred。
- `IS_StoneTrough_Dry_Heat_Burn_Ember`：dry / heated / burning / ember。
- `IS_WetWood_Wet_Steam_Dry`：wet / steaming / dry。
- `IS_LeafWing_Closed_Open_Wind_Folded`：closed / open / wind / folded。
- `IS_Station`：热流驿站棚屋、平台、风铃、灯和工具。
- `IS_Dragon_Glide_Wingbeat_Rest`：巡风龙滑翔、翼拍、停歇动画 rig。

桥 rig 在第 1、20、40 帧表达 `broken -> working -> connected`，叶翼在第 1、20、34、52、70 帧表达收拢、展开、受风和收翼研究，巡风龙使用第 1、15、30、45、60、120、240 帧表达滑翔、翼拍和停歇节奏。导出坐标约定为 X 水平、Z 向上、Y 深度；渲染使用正交相机，便于转为 2.5D 资源。

## 交付文件

- `resources/creative/windbell/blender/windbell_world_asset_library.blend`：可编辑资产库，含公共桥、桥状态、岛资产、预览场景和动画。
- `resources/creative/windbell/blender/glb/`：桥断、桥修复、风铃岛三份 GLB。
- `resources/creative/windbell/blender/renders/`：三张主场景正交 PNG，以及桥状态、绳索、石槽、湿木、叶翼、驿站、巡风龙的透明部件预览。
- `resources/creative/windbell/blender/manifest.json`：场景、集合、状态、关键帧、输出路径和运行时交接元数据。
- `resources/creative/windbell/blender/logs/mcp_evidence.json`：MCP 初始化、工具列表、addon 状态、构建调用、场景读取、viewport 截图和独立后置查询回执。
- `resources/creative/windbell/blender/logs/export_validation.json`：读取三份 GLB 的 JSON chunk，核对单场景范围、节点数量和状态泄漏检查。

## 2D 纹理增强交付

纹理增强入口为 [`build_windbell_textured_assets.py`](../../../scripts/creative/blender/build_windbell_textured_assets.py)，由 [`mcp_texture_client.py`](../../../scripts/creative/blender/mcp_texture_client.py) 通过同一个独立 Blender MCP 实例执行。客户端先用 Pillow 检查 `resources/creative/windbell/images/clean/` 的九类最终透明 PNG，再把路径作为 UTF-8 数据传入 Blender；不会使用带 checkerboard 或外发光晕的被拒候选图。

- 桥、岸、树干、根道、棚亭、石槽和水面网格继续保留可编辑几何，并通过 `UVMap -> Mapping` 的局部矩形区域采样 `bridge-restored.png` 或 `island-keyart.png`；没有把整张 key art 当作场景贴图。
- 货车、材料堆、风铃、驿站、叶翼、巡风龙和三名 NPC 作为独立带 `0.06` 厚度的透明 2.5D 卡片放进对应场景。卡片、来源图名、UV、轴向和场景标签都写入对象自定义属性。
- 纹理图像打包进 `windbell_world_asset_library_textured.blend`。三份 textured GLB 使用 active scene 导出并内嵌图片；后置验证读取 GLB JSON，要求 `images[].bufferView`、`pbrMetallicRoughness.baseColorTexture` 和 primitive `TEXCOORD_0` 同时存在。
- 纹理增强输出、clean PNG 映射、局部采样区域和证据路径由 `manifest.json` 的 `textured_delivery` 记录。MCP 回执写入 `logs/mcp_texture_evidence.json`，离线 GLB/Pillow 检查写入 `logs/texture_export_validation.json`。

纹理增强仍是可编辑美术资产交接，运行时没有宣称已接入游戏；结构稿 `.blend` 与原始三份 GLB 保留在原路径，便于比较和回退。

## 重现与验收

保持独立 Blender 实例运行后，可在项目根目录执行：

```bash
python3 scripts/creative/blender/mcp_build_client.py
```

该客户端会通过官方 MCP stdio 调用 `get_addon_status`、`get_scene_info`、`execute_blender_code`，然后写入 UTF-8 JSON 证据。构建脚本包含 Blender 5.2 的 Eevee 枚举兼容和空 World 创建兼容；没有调用 Polyhaven、Sketchfab、Hyper3D 或其他生成/下载服务。

验收时应同时检查：

1. `mcp_evidence.json` 的 `execute_blender_code` 文本包含 `WINDBELL_BUILD_COMPLETE`，而不是只看 JSON-RPC 的 `isError` 字段。
2. 后置 scene 查询包含 `WindbellBridge_Broken`、`WindbellBridge_Repaired`、`WindbellIsland_Exploration` 和 8 个 `Preview_` 场景；桥根集合和岛根集合分别挂入对应场景。
3. `.blend`、三份 `.glb`、11 张 PNG 均存在且大小非零；至少目视检查桥断、桥修复和风铃岛主渲染。
4. `export_validation.json` 应显示每份 GLB `scene_count=1`、目标场景名正确，且 `forbidden_nodes_present=0`；broken 不含 repaired/working/animation rig，island 不含公共 WB bridge rig 和未选中的燃烧/蒸汽变体。
5. 运行时接入读取集合名与物体 `world_state` 属性，并在游戏侧决定公共桥状态和个人岛状态的持久化方式。本资产包没有把“已接入游戏”作为事实声明。

## 规划中的接入

- 将 `manifest.json` 中的集合名和 `world_state` 映射到世界节点、个人状态与交互规则。
- 将桥的断/施工/通行/生活状态接到世界事实同步；将岛的根道、树桥、石槽、湿木、叶翼、驿站和巡风龙接到个人探索实例。
- 在游戏运行时按需要拆出透明 PNG、GLB 或保留 `.blend` 的模块化源文件，并由游戏侧决定碰撞、挂点和 LOD。
