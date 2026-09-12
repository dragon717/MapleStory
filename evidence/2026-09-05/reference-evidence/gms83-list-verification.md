# GMS83 `List.wz` 核实

本次只核实 `参考/assets/gms83/83/List.wz`，没有重新下载，也没有重跑 17 个 WZ 的全量 CRC 或资源扫描。文件在磁盘上是 13,336 bytes；首 32 bytes 为 `05000000f2ae4aa425fab0903f7605610f000000fbae50a42afaf29076763461`，首个 little-endian 整数为 5，首字节不是 `PKG1`。现有验收证据中的 83.zip CRC 已为 true，List 条目期望大小为 13,336、CRC32 为 `49842554`。

已装的 `@tybys/wz@1.7.1` 没有 List 专用 reader。用它的标准 `WzFile` 读取时出现 `Position (1627747903) out of range: [0, 13336]`；这是把 headerless 索引错当 PKG1 WZ 目录后得到的伪偏移，属于特殊格式未支持，不能据此判定文件损坏。

按仓库已有的 `WzListFile.cs`、`wzlib-rs/src/wz/list_file.rs` 与 `libwz/src/Util/ListFileParser.cpp` 兼容算法（GMS IV `4d23c72b`）读取：格式为 `[i32 length][length 个 UTF-16LE u16][u16 encrypted-null]`。共消费 371 条记录，结束偏移正好为 13,336，截断/非法记录为 0。开头为 `dummy`、`mob/0100100.img`、`mob/0100101.img`、`mob/0120100.img`、`mob/0130100.img`；末尾为 `mob/9500331.img` 至 `mob/9500335.img`。

因此，17 个 WZ 中的 `List.wz` 应记录为 `special_format / parsed_by_compatibility_reader`，并从标准 PKG1 资源解析失败数中单独区分；标准 reader 的越界错误不应升级为下载或文件损坏结论。机器可读明细见 [`gms83-list-verification.json`](./gms83-list-verification.json)。
