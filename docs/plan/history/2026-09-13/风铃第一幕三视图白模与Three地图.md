# 风铃第一幕：三视图、白模与 Three.js 地图

2026-09-13。用户已体验首版，认可基本地图但认为规模与还原不足，授权改用 Three.js 分层 3D，建模由 GPT-6 Astra / medium 执行。主代理负责接入、专用 2D 图像与整合，GPT-5.6 Luna / max 仅作只读渲染代码核对；没有独立 QA、重启在线服务或改动存档。

## 已交付

- 保留三张概念原图，新增两张美术三视图、两张工程尺寸图；先保存并核看正式白模，再上 2D 贴图。补充纯材质图册、两张独立远景，消除旧采样带入草色横条和近景黄叶的问题。提示词在 `docs/design/windbell/image-jobs.json`。
- 3D 总目录 `resources/blender/windbell/`：白模 `.blend` 与两份 GLB，贴图版 `.blend` 与两份正式 GLB，桥断/修复和岛桥升起/落下四张最终渲染，来源/裁剪/哈希/MCP 回执。旧模型实物迁至 `legacy/`，原目录保留兼容软链。
- WindbellScene 改为 Three.js：加载内嵌贴图 GLB，前中后景与大背景独立分层；可踏几何有宽度/厚度；相机俯视与投影补偿；透明演员画布放在中景 Z=0，模型执行真实深度遮挡，继续复用角色外观、NPC 和效果。视差与摇摆/云/水/火运动不改变服务端脚面。
- 落桥、公共三段桥面、断板、车、燃烧、叶翼跟随原快照；只替换风铃两图，不改服务端玩法或数据库规则。加载错误、迟到 GLB 回调与切图清理有处理。
- 内容版本为 `tms273-11`，协议仍为14。素材表与分层规范见 `docs/design/windbell/PRODUCTION.md`，系统总览同步更新。

## 必要验证

- `scripts/creative/blender/check_windbell_grand.py` 通过：白模/贴图两阶段，11条静态脚面的真实 POSITION 端点与正负深度宽度、落桥锚点、四层各有 motion、树皮 UV 按世界尺度重复、贴图内嵌（岛7/桥6）。证据 `resources/blender/windbell/logs/export-validation.json`。
- `node client/src/features/windbell/runtime.check.mjs` 通过：实际运行 GLB 存在与分层/节点/内嵌纹理、桥段/车/落桥/叶翼/音效状态、四种视口的 Three 实际矩阵脚点投影。没有将数学检查称为浏览器视觉验收。
- `node scripts/refactor_audit.cjs --deps --check` 通过，无新增依赖循环或违规。
- `node scripts/check_tms273_runtime.cjs` 通过，44张原作地图和50662条来源引用；内容资源版本已同步。
- 配对构建 `CARGO_BIN=/Users/muniao/.cargo/bin/cargo node scripts/build-release.cjs prepare` 通过，候选 `20260912175849-44994542`，输出 `build/tmp/`。构建日志 `artifacts/windbell/three-build.log`。Vite 提示主 JS 约2.51MB（gzip约677KB）超过1.6MB告警阈值，此为告警，不是编译失败；尚无真机帧率/上传耗时结论。
- 候选核对9475个 manifest 素材引用，缺失0；两份候选 GLB 与正式源 SHA-256 一致，岛10,108,796字节、桥9,618,128字节。一个此前已有的000030000小地图 PNG 在构建复制后再次缺失，已从现有发布目录只读复制补回候选/public，并逐字节核对；未将原因断言为同步软件。证据 `artifacts/windbell/three-candidate-assets.json`。

## 交付边界

模型是本次新的程序化分面版本，不声称原概念1:1精雕。树冠/云体等仍简化；岛根道保留既有直线/斜线物理坐标，因此不等同概念中的曲折路径。每帧上传一次演员画布的真机开销尚未测量。游戏内首次加载、遮挡强度、颜色、动画、比例及连续游玩由用户实玩验收；没有用 Blender 静帧冒充游戏截图。剩余行动见当前计划，不在此重复执行台账。
