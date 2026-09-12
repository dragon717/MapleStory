# 风铃桥／风铃岛原创声音包

状态：已生成本地可播放资产；尚未接入游戏运行时。资产是原创程序作曲与合成，不是模型音频，也没有截取或改写冒险岛现有旋律。

## 交付物

生成入口为 [`generate_windbell_audio.py`](../../../scripts/creative/audio/generate_windbell_audio.py)。它只依赖仓库当前 Python 3.7 的 NumPy 与已安装的 ffmpeg，使用固定随机种子，可在仓库根目录重建全部文件：

```sh
python3 scripts/creative/audio/generate_windbell_audio.py
```

两首曲子都按设计稿使用 96 BPM、4/4、32 小节、80 秒、44.1 kHz、立体声。每个 stem 从样本 0 开始、长度都是 3,528,000 样本；循环接缝使用 80 ms 的边界平滑，混音不会因为“播放完成”触发游戏事实。

| 场景 | 混音预览 | 同步分层 |
| --- | --- | --- |
| 风铃岛 | [`island_mix.ogg`](../../../resources/creative/windbell/audio/island/island_mix.ogg) / [`island_mix.wav`](../../../resources/creative/windbell/audio/island/island_mix.wav) | [`island_m1_forest_floor`](../../../resources/creative/windbell/audio/island/island_m1_forest_floor.ogg)、[`island_m2_travel`](../../../resources/creative/windbell/audio/island/island_m2_travel.ogg)、[`island_m3_high_canopy`](../../../resources/creative/windbell/audio/island/island_m3_high_canopy.ogg)、[`island_m4_discovery`](../../../resources/creative/windbell/audio/island/island_m4_discovery.ogg)；每条同时有 `.wav` |
| 风铃桥 | [`bridge_mix.ogg`](../../../resources/creative/windbell/audio/bridge/bridge_mix.ogg) / [`bridge_mix.wav`](../../../resources/creative/windbell/audio/bridge/bridge_mix.wav) | [`bridge_m1_base`](../../../resources/creative/windbell/audio/bridge/bridge_m1_base.ogg)、[`bridge_m2_construction`](../../../resources/creative/windbell/audio/bridge/bridge_m2_construction.ogg)、[`bridge_m3_transport`](../../../resources/creative/windbell/audio/bridge/bridge_m3_transport.ogg)、[`bridge_m4_arrival`](../../../resources/creative/windbell/audio/bridge/bridge_m4_arrival.ogg)；每条同时有 `.wav` |

岛的四层严格对应设计稿：M1 林下是风床、柔和 pad 和拨弦；M2 行进是连续的木质脉动；M3 高处是带气息与轻微颤音的木管；M4 发现是稀疏钟琴回答。M4 仍然是等长 stem，客户端只在 `discovery_fact` 成立后淡入，并另播一次短发现音型。桥曲沿用时钟和四层协议：基础、施工、运输、到货；施工／运输层不按单步输入开关，而由世界状态平滑进入。

完整的作曲参数、原创动机 MIDI 音高、和弦循环和来源声明在 [`composition.json`](../../../resources/creative/windbell/audio/composition.json)。这里的音色由加性部分、包络、滤波噪声和空间声像合成，包含拨弦、木质击音、钟琴／木琴、气息木管、柔和持续音与叶风纹理，避免用单纯正弦波冒充 BGM。

## 因果音效

[`sfx/`](../../../resources/creative/windbell/audio/sfx/) 下每个事件都有 PCM WAV 和网页 OGG：

| 设计事件 | 资产键 |
| --- | --- |
| 草地／木面／石面脚步、起跳落地 | `step_grass`, `step_wood`, `step_stone`, `jump_land` |
| 断丝、支撑断开、木桥运动与落地 | `cut_rope`, `rope_sever`, `bridge_land` |
| 扶车木响、材料交接、工匠安装 | `cart_wood_support`, `material_handoff`, `craftsman_install` |
| 货车滚轮、到货 | `cart_wheels`, `arrival` |
| 湿物受热、火起／持续／熄灭 | `heat_damp`, `fire_ignite`, `fire_loop`, `fire_extinguish` |
| 叶翼展开／收起、热流托举、远方龙翼 | `wing_open`, `wing_close`, `updraft`, `dragon_wing` |
| 风铃、小生物、NPC 轻提示、发现 | `bell`, `creature`, `npc_hint`, `discover` |

动作、材料和结果分开：例如 `cut_rope` 只表示有效接触，`rope_sever` 只在支撑事实跨过断裂阈值时播一次；`bridge_land` 由桥的实际运动／碰撞触发。`fire_loop` 可作为有限燃料的环境层聚合播放，不能为每根枯枝无限开声道。`bell` 随真实摆动或触碰触发，不能把固定成功音当作风铃。

## 状态接入约定

客户端保持一份音乐时钟，所有等长 stem 用同一播放游标，使用约 1–2 秒淡入淡出与回滞：

```text
岛：M1 常驻；motion 有效时 M2；height/sky_visibility 满足时 M3；
    discovery_fact 首次确认后 M4 淡入，并按角色／发现事实最多播一次 discover。
桥：M1 常驻；施工 Job 工作时 M2；真实货车可通行并在途时 M3；
    FirstShipmentArrived 或公共停留事实成立时 M4。
```

服务端只提供事实与时间基准，音量、设备延迟和层的平滑由客户端负责。重要因果仍必须有视觉或交互反馈；音乐和音效分别提供可调音量，音频未准备好不阻止进入地图。

## 验证

[`validation.json`](../../../resources/creative/windbell/audio/validation.json) 是本次实际生成后的检查结果，记录每个 WAV 的采样率、声道、样本数、时长、峰值、RMS、非静音比例和音乐循环边界。当前结果：10 个音乐 WAV（两场景各 4 stem＋1 mix）与 24 个音效 WAV 均可读，且各自有对应 OGG；两场景 stem 和 mix 都是 80.000 秒，首尾样本跳变为 0，循环检查通过。`ffmpeg` 使用当前构建的原生 Vorbis 编码器生成 OGG；`ffprobe` 可读取其容器和音频流。

本轮做了波形／指标验证，没有把音频播放到用户扬声器，因此音色审美、游戏内层间平衡和实际设备听感仍待接入后的用户试听。
