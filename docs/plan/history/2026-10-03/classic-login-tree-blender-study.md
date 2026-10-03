# 经典登录树 Blender 3D 作品归档

日期：2026-10-03。用户已查看并认可最终渲染，明确要求将本次作品上传至 dragon717/MapleStory。

本次仅归档独立美术成果。没有替换天空航船登录入口，没有修改业务、协议、账号、在线服务或部署内容。经典登录树为早期画面的 3D 视觉研究，不冒称 TMS273 当前资源或逐像素复刻。

## 文件

- [最终渲染 PNG](../../../../resources/blender/classic-login-tree/MapleStory_Classic_Login_Tree_Blender.png)：1400 × 1650，Cycles 256 采样，5,120,286 bytes。
- [可编辑 Blender 工程](../../../../resources/blender/classic-login-tree/Classic_MapleStory_Login_Tree.blend)：压缩保存，6,058,769 bytes，无外部图片纹理依赖。
- [独立重建脚本](../../../../scripts/blender/build_classic_login_tree.py)：只生成本作品，默认不渲染。

![经典登录树真实 Blender 渲染](../../../../resources/blender/classic-login-tree/MapleStory_Classic_Login_Tree_Blender.png)

## 打开与重建

使用 Blender 4.3.2 或更新版本打开工程即可编辑。工程包含 1,461 个对象、797 个网格、12 个集合及 34 个材质。主相机为 `CAMERA · Login forest hero`，另保留树根近景相机。

在仓库根目录执行：

```sh
blender -b --factory-startup -P scripts/blender/build_classic_login_tree.py -- --output-dir ./build/tmp/classic-login-tree
```

上述命令仅重建工程；追加 `--render` 同时生成最终图。目标目录的同名文件会被覆盖，建议先使用新的临时目录。工程中渲染输出采用相对路径，按 F12 后保存到工程旁的 `MapleStory_Classic_Login_Tree_Blender.png`。

## 本次核验

- 最终 PNG 已实际查看，归档字节与用户确认的图一致。
- 压缩工程已重新打开；生成脚本从空场景执行成功。
- 原工程与重建工程的对象、变换、网格计数及渲染配置结构检查一致，无外部图片依赖。
- Python 语法、Git 差异、仓库体积守卫、iCloud 冲突副本检查与现有忽略规则检查通过。
- 本次不涉及游戏代码，未启动游戏、运行浏览器验收或部署。

## 归档边界

仓库默认不提交 `resources/` 和图片。本次依据用户对这两份成果的明确上传要求，仅在 `.gitignore` 为上述两个精确资产路径增加例外；其他资源、截图、草稿、日志、缓存和备份继续忽略。没有修改 Git LFS 配置，资产均低于现有 90 MiB 单文件守卫限制。

## 视觉依据

- [原版完整登录树拼图](https://www.inven.co.kr/board/maple/2316/2135)
- [Nexon Peak 引用说明](https://peak.nexon.com/en/post/1208)

保留了黄绿色扭绞巨干、根部橙黄蘑菇、两层蘑菇屋、绿拱门及圆木绳桥等辨识特征。模型由 Blender 网格、曲线和材质构建，最终图来自真实渲染；未将图像生成结果冒充 3D 渲染。下载的原版参考图片未进入仓库。本作品仍带有 MapleStory 原作视觉参考属性，不声明对原作知识产权拥有权利。

## SHA-256

- `resources/blender/classic-login-tree/Classic_MapleStory_Login_Tree.blend`：`d3e9f7488516de5620f8ded99e10924758eaaff9f9133e0faeff98dff6124c3b`
- `resources/blender/classic-login-tree/MapleStory_Classic_Login_Tree_Blender.png`：`60ba4f1af793c16b50f56714fee508075d997c638d9168b08cc032d493d25714`
- `scripts/blender/build_classic_login_tree.py`：`248d0416ee8edb403b9a15a0ce59386209e2d2bb453914c50013293061857fff`
