# GMS83 素材核验事实报告

更新：2026-09-05。原始审计JSON保留原结果；修复结果由下表新增证据覆盖，不能只读原JSON的ok字段判断当前状态。

| 项目 | 已核实结果 | 证据与边界 |
| --- | --- | --- |
| 包与成员完整性 | 83.zip为1,752,051,975字节；17/17 WZ解压、CRC/大小通过，总1,973,916,727字节 | `gms83-verification.json`；没有远端SHA256对照，不能声称与发布方hash校验一致 |
| 标准WZ | 16个PKG1文件按GMS83成功解析，actualVersion均83；16,821 IMG全部遍历，544,718 Canvas节点、724,843 UOL节点 | 节点总数不等于唯一图片，也不等于全部引用已解析/像素已解码 |
| 特殊List.wz | 13,336字节按List格式读出371条记录，完整消费，0无效/截断 | `gms83-list-verification.json`；先前PKG1解析越界是用错读法，不是文件损坏 |
| PNG初始抽检 | 16/16图片解成RGBA，字节数符合宽高 | 全部Canvas尚未像素解码 |
| 音频重新导出 | 3,980条源路径 → 3,980个唯一播放文件；3,940 MP3 + 40 WAV | `gms83-audio-repair.json`；所有payload SHA与原审计一致。40段原始PCM保留.pcm旁档，仅增加标准WAV头，未重编码 |
| 音频完整解码 | **3,980/3,980通过，0失败** | `gms83-audio-decode.json`；每个文件校验输出SHA后执行ffmpeg -v error -xerror -i 文件 -f null -，完整消费音频流 |
| 动画元数据抽样 | Mob9300348/move完整6帧×180ms；body stand1 3帧×500ms、arm、head UOL与Base zmap/smap保存 | `gms83-animation-evidence.json`；13个唯一PNG，15次RGBA解码成功（头部复用），不是全角色/装备验收 |
| 运行纸娃娃与地图 | 样例导出完成，实际游戏浏览器已登录并呈现，最终帽发截图已复查 | `../browser-probe/`；125个活动PNG全部RGBA解码/尺寸检查，stand3/walk4/jump1/attack3，298地图层与83foothold；`../../client/evidence/`保留生产页动作截图，非全资源验收 |

原音频导出以每WZ内部序号命名，24条较早记录被覆盖，只有3,956个文件。修复改为WZ名+完整节点路径，原文件保留。原ffprobe成功3,972、失败8不能作为解码结论：40条其实是44.1kHz、mono、16bit原始PCM，其中32条曾被错误当MP3探测成功。按WZ格式头恢复WAV后，40条时长与原元数据差均小于1ms，并且全部完整解码成功。

可复跑：`node 参考/tools/wz-audit/repair_audio.cjs`，然后 `python3 参考/tools/wz-audit/verify_audio_decode.py`。动画：`node 参考/tools/wz-audit/verify_animation.cjs`。依赖与源WZ已保存在本工程，无需重复下载。

现在可确认完整包已取得、16个标准WZ加1个特殊List可读取、全部音频完整解码通过。仍不声称全部Canvas已导出、所有跨文件链接闭合、完整衣柜/全地图/全技能均已浏览器呈现。
