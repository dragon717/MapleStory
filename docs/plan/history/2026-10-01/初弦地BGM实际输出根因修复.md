# 初弦地BGM实际输出根因修复

日期：2026-10-01。用户再次报告BGM无声，保留此前未提交成果，不提交或推送。

## 证据与修复

- 实际Safari 3010页通过Web Inspector读取现有Phaser游戏：100000000 / FloralLife已解码137.639秒、isPlaying=true、所有静音/音量正常，但context=suspended、gameLostFocus=true、document.hidden=false。点击游戏恢复running后，masterVolumeNode出口峰值0.089517。之前只检查isPlaying/running与离线振荡器，没有检测原曲最终出口，覆盖不足。
- Phaser默认pauseOnBlur=true，在窗口失焦时暂停音频，即使地图还显示在屏幕上；播放标记不会随context挂起而变为false。统一入口改为绑定游戏后关闭窗口失焦暂停，按document.visibilitychange暂停/恢复同一上下文。保留首次真实输入解锁、静音和音量选择。
- 移除Phaser原有延迟visible处理器，避免页面短暂显示后又隐藏时，100ms后的resume把后台音频重新启动；可见性由同一入口拥有，并同步gameLostFocus阻止Phaser逐帧恢复已隐藏的页面。快速显示再隐藏的反例曾抓出该逐帧恢复，修正后再验证。正常登录入口和开发预览均接入，不另起BGM播放器。
- Safari对同一策略实测：页面失焦、hidden=false、gameLostFocus=true时仍为running，原曲出口峰值0.021615。主代理负责实现；GPT-5.6 Luna / max只读核对BGM目录、地图载荷和切图调用，排除当前地图丢失BGM，未改文件/账号/服务或启动独立QA。

## 验证范围

- scripts/check_henesys_audio.cjs补充实际FloralLife主出口采样、可见页面blur、隐藏/返回/快速显示再隐藏的生命周期、2D/3D重建及出生地图→存档地图快照切换。可见性事件检查驱动真实document监听器，自动化浏览器没有真实隐藏其测试标签页，不把事件驱动冒称原生切标签验收。
- 真实原曲出口持续非零；原有单曲、空间左右/远近、脚步/落地/瞬移抑制、静音/音量、原版回退和清理检查保留。
- 没有重写素材、修改账号/存档、改变浏览器或系统音量。用户扬声器/耳机实听仍待确认；信号采样不能代替听感验收。

定向音频检查最终通过（含快速切换反例），实际出生图→存档图出口峰值0.102028，用户地图数据/BGM载荷正常。通过系统Terminal运行根目录启动3010.command，包含TypeScript/Vite构建，正式发布20261001100530-916aa1c8；健康ok、协议37/内容tms273-50，current-fresh=true。数据库dev/inode仍为16777234 / 236697939。Safari已关闭本轮打开的Web Inspector并刷新，登录页确认当前发布为新版本；服务更新后会话失效，需要用户重新登录。未填写或读取密码，账号和角色存档保留。新构建的完整Safari登录后实听待用户，不冒称已完成听感验收。

后续确认：2026-10-01用户明确“都有声音的”，原无声修复获得有声确认；脚步听感另按用户要求替换为下载录音，见同日[记录](初弦地真人录制脚步与移速适配.md)。此前音频成果随该轮用户git commit指令一并提交。
