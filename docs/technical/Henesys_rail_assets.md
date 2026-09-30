# 初弦地 rail-v1 素材来源

更新时间：2026-09-30

正式场景名称为「初弦地」；Henesys 与现有资源路径仅保留为技术标识和原版来源记录。

## 官方来源与许可证

| 素材包 | 官方页面 | 本地路径 | 格式 |
| --- | --- | --- | --- |
| Quaternius Stylized Nature MegaKit Standard | [Quaternius 官方页](https://quaternius.com/packs/stylizednaturemegakit.html) · [Itch 下载页](https://quaternius.itch.io/stylized-nature-megakit) | `resources/scenes/henesys/rail-v1/vendor/nature/Stylized Nature MegaKit[Standard]` | glTF、FBX、OBJ |
| Quaternius Medieval Village MegaKit Standard | [Quaternius 官方页](https://quaternius.com/packs/medievalvillagemegakit.html) · [Itch 下载页](https://quaternius.itch.io/medieval-village-megakit) | `resources/scenes/henesys/rail-v1/vendor/village/Medieval Village MegaKit[Standard]` | glTF、FBX、OBJ |

两个包均在解压目录内提供 `License_Standard.txt`，明确声明 **CC0 1.0 Universal / Public Domain Dedication**，并链接到 <https://creativecommons.org/publicdomain/zero/1.0/>。对应来源记录保存在：

- `resources/scenes/henesys/rail-v1/vendor/nature/license-source.json`
- `resources/scenes/henesys/rail-v1/vendor/village/license-source.json`

## 可复现下载步骤

1. 打开对应 Itch 官方下载页，进入购买提示页。
2. 选择 `No thanks, just take me to the downloads`，不支付、不注册。
3. 在文件清单中只下载免费的 `Standard.zip`；不要选择 Pro 或 Source。
4. 浏览器完成下载后解压，并保留包内的 `License_Standard.txt`。Safari 会自动解压；手动解压时保持包名目录即可。
5. 将两个解压目录分别放入上表本地路径，并检查 glTF 文件旁的 `.bin` 与纹理文件仍在原目录。

下载页生成的文件直链是短时签名 URL，因此复现时应从官方 Itch 页面重新生成，不要缓存旧直链。

## 当前场景用途

- Nature 包提供现成的树、草、石、花和蘑菇；当前优先使用 `glTF/CommonTree_*`、`glTF/TwistedTree_*`、草和岩石资源。
- Village 包仅保留来源记录；当前构建不再依赖它。射手村蘑菇建筑复用之前已实现的造型函数，按已查看的273原图重布置，不再使用通用中世纪屋顶。
- 曲线轨道地形与平台由 Blender 生成；上述素材只作为场景装饰和模块组件，不替代地形生成逻辑。
