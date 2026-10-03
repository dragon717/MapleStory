# 天空船第三版贴图

## 2026-10-03 尖拱职业彩窗与当前木船材质

用户认可木质结构，要求船身和船头都呈现清楚木纹。当前生产模型以 `repair_sky_ship_structure.py` 为准：船身整面木板，UV跨度16×10米（顶面12×12米），支杆用 `wood.png` 沿长度铺纹；原生glTF保留木色乘数(0.64,0.42,0.31)，运行时颜色图微凹凸。旧3米平铺与源法线描述属于下节历史。修复前源网格/形态键和独立原始rig保存。

四张彩窗均由内置 image_gen 单独生成，1024×1536 RGBA，原图复制到项目；主代理生成战士，GPT-6 Luna/max三辅助按固定提示分别生成法师、弓手、盗贼。完整提示与源输出路径保存在同名 `.prompt.txt`。没有将原像素NPC贴到窗上；这些是P原创职业窗画，不冒称TMS273原版素材。

| 文件 | 色系 | SHA-256 |
| --- | --- | --- |
| [stained-glass-warrior.png](stained-glass-warrior.png) | 红 | `90c175081de836db97a582a06d40cef562cd80d9f07c9a1a0d2fd05e5a46d4e1` |
| [stained-glass-mage.png](stained-glass-mage.png) | 蓝 | `55a37de741537cb465da975ac466d36d1e3963687baba3827b6827c0cacc8c1e` |
| [stained-glass-archer.png](stained-glass-archer.png) | 绿 | `1eed4d461430b8b8f06acb2ece775679261afce85c044a7e5046eff87839b912` |
| [stained-glass-rogue.png](stained-glass-rogue.png) | 金黄 | `46084fe39bb530d091e0c2448798db59d297b2250b40ea7d17d89bb0c0279568` |

`fit_voyage_stained_glass.py`沿透明轮廓建真实窗框与墙体开孔；窗画已嵌入GLB，同时作为窄屏职业选择素材装配。运行时同图驱动彩色投射灯与体积散射；墙/床阴影和场景深度共同限制光束。光照属于RGB实时表现，并非完整光谱模拟。

## 2026-10-02 正式入口材质打磨

新增 `deck-planks.png`，内置 imagegen 生成，实际 1254×1254；用于船体木材及实体公告牌木框。原生成图逐字节复制，未重画或裁切。SHA-256：`e0a6cd8cf6b8a03f3fda4261c606c50a40b52ce72e0697b093756f3e292977c2`。旧 `wood.png` 保留。

本轮修正 MaterialUV 的主轴投影，木材以3米、帆布以0.7米为平铺尺度；小片零碎材质合并到相邻主材质，源三角面和 SourceUV 保留。奶白漆改用纯色；木材/帆布/黄铜分别调节粗糙度，原法线强度降低到0.09。新版以 `polish_user_sky_ship.py` 和 `models/sky-voyage.blend` 为准。

新增木框、立柱、底脚、斜撑、黄铜角件与纸夹均为程序建模。登录纸面保留原生 DOM 输入/按钮，透明覆盖到 `SV3_LoginSurface`，旧 UI 图仍保留给其他入口状态。

生成提示词（完整原文）：

> Use case: stylized-concept. Asset type: seamless square base-color texture for the deck of an elegant fantasy flying ship in a 3D game. Generate only the flat albedo texture, orthographic straight-on, filling every pixel. Eight long horizontal teak planks run exactly left-to-right across the entire image, staggered subtle end joints, narrow dark caulking seams, tiny recessed brass pin heads near occasional joints. Warm muted honey-walnut, restrained low-contrast fine wood grain, lovingly hand-painted high-quality storybook game material. Maintained and finely crafted, lightly worn, not rotten. Even diffuse illumination without directional light, no cast shadows, no gradients across the image, no perspective, no words or border, no frame. Seamless tileable all four edges, clean quiet grain, no exaggerated swirls. 1024 square.

## 早期材质记录（本轮调整值以上节为准）

`material-sheet.png` 由内置 imagegen 生成；实际输出为 1254×1254。`enamel.png`、`brass.png`、`wood.png`、`linen.png` 分别裁切四个等分象限，无后续重画。颜色图使用 MaterialUV（导出 TEXCOORD_1），保留的原始切线法线使用 SourceUV（TEXCOORD_0）、Non-Color，强度0.22。金属度与粗糙度按八类材质单独设置，未继续使用旧图中的烘焙阴影。

原始 OBJ、MTL 与四张 PBR 图保留在 `../vendor/user-ship/`，来源清单与 SHA-256 见其中 `source.json`。船是用户提供的生成模型，本轮没有为它编造外部授权；仅取最大的主船连通分量，另两个视图重建副本保留在导入源 blend 中。纹理颜色分类在部件内部通过共享顶点投票清理细碎色块。

`entry-panel.png`、`entry-button.png`、`maple-crest.png` 复用第二版 UI 图，原始生成说明见 `../../sky-voyage-v2/textures/ASSETS.md`。

生成提示词（完整原文）：

> Use case: stylized-concept. Asset type: square 2x2 PBR base-color texture material sheet for retexturing an existing cream-and-gold fantasy sky sailing ship. Exactly four equally sized square quadrants, full bleed, no borders or labels. Top left: warm ivory painted enamel metal, subtle cream variations and extremely delicate small wear, no panels, no seams. Top right: satin champagne brass, soft fine brushed grain, even golden color, no specular highlight or baked shadow. Bottom left: honey teak timber, fine long horizontal wood grain, tasteful hand-painted game texture, no nails, no board boundaries. Bottom right: clean warm ivory woven sail linen, small subtle tightly woven fibers, no folds, no ropes. All four are orthographic flat material scans, uniformly lit, color only with zero directional lighting, zero perspective, zero ambient occlusion; each quadrant can tile independently. Rich clean painterly realistic game finish, understated microdetail so ship geometry stays readable. No text, no symbols, no watermarks, no ship rendering. Square 2048 image.
