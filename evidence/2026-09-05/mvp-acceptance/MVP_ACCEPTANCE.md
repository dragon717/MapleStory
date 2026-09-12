# 首版实测记录

日期：2026-09-05。内容：gms83-mvp-1，GMS83蘑菇村000010000。服务为Rust单一权威逻辑拥有者，50ms tick；客户端Phaser/TS/Vite。当前目录未初始化Git，未虚构提交ID。

## 阶段A：开发网络自测已通过

运行 `node bots/run.mjs selftest`，正常HTTP注册/登录后使用真实WebSocket连接。完整观察快照、玩家ID、输入seq、服务端tick、动作ID与拒绝响应保存在 `bot-selftest.json`，不含密码/token。

- 两个独立账号同图互见，非固定账号槽位。
- 服务端推进移动与跳跃，另一连接观察到对应变化。
- 双方普攻被接受并广播，实际动作时长800ms。
- 重发相同requestId返回原动作，不再次广播；重连后同进程内仍去重。
- 客户端伪造角色ID/坐标/damage被拒绝。
- 超过500ms缺输入停止持续移动；断线角色移除，重连得到权威快照。

Rust单测2项、cargo check/build/fmt通过；前端类型与生产构建通过，原始delay边界、非循环攻击及重复/过时动作回执不重播声音的检查通过。

## 浏览器开发验证

实际浏览器打开3000生产页，从表单注册/登录qa_frontend，与独立程序账号demo_bot_mto1lpaf同图。登录页、两角色、左右动作和离地跳跃截图位于 `../client/evidence/`。浏览器检查无error/warn。键盘工具的快速down/up不能代替持续按住的量化移动测试，移动同步以阶段A的快照轨迹为证据。

角色与装备按原始origin、named anchors、zmap、逐帧delay拼接并整体翻转；普攻swingO1为300/150/350ms。地图来自265块tile、27个object、6个背景与83条foothold，未用绘制矩形替代源地面。样例资源导出/检查见 `../references/browser-probe/`。帽发已按Cap vslot=CpH1H5与Base/smap的H1遮挡修复，最终截图final-world.png与final-jump-attack.png已复查，黑帽、脸部和草地脚点可见；旧过程截图不作为最终帽发依据。

地图BGM和武器音效已完整解码并集成。武器01302029的info/sfx=swordS对应Sound.wz/Weapon.img/swordS/Attack。浏览器执行用户点击与攻击的播放路径；工具不能主观听音，未填写听感验收通过。

## 阶段B：可供用户验证，尚未通过

服务与一个程序机器人已运行。用户同机访问http://127.0.0.1:3000，局域网设备访问http://192.168.1.19:3000，注册自己的账号进入。左右/A D移动，空格跳跃，X/Ctrl普攻；机器人自动往返与攻击。启动/停止步骤在根README。

没有用代理代操作的qa账号记录冒充用户验收，也没有把本机测试当作另一台物理设备的网络可达性证明。

## 当前范围

一套代表性纸娃娃外观、一张地图；角色统一绘制在本图场景层之前，未实现任意地图的通用前景遮挡。背景静态平铺，未复原滚动/视差；地图物件使用选定静态帧。物理支持foothold落地/斜坡与跳跃，未实现梯绳、墙体碰撞、向下穿平台和全部原版物理。没有伤害目标、技能、任务、掉落或PVP。音频3980/3980完整解码通过，PNG仅代表性样例，不宣称全部Canvas或全部衣柜/地图引用已验收。

最终前端构建：index-rtGJbUDD.js；build/check通过。qa_frontend已退出，5173开发服务已停止，仅保留3000游戏服务与原有demo机器人陪用户测试。资源独立浏览器探针截图与12秒录像见 `../references/evidence/browser-asset-probe.md`。
