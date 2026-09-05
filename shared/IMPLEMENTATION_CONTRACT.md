# 首版并行实现契约

权威确认：Rust 一个主逻辑状态拥有者顺序推进世界；异步网络只投递消息。tick内按服务端接收队列顺序处理输入、再固定顺序模拟并广播，有界队列本身不构成确定性保证。本版不实现分片/并行模拟/分布式；未来先讨论。

- `POST /api/register` JSON `{username,password}`，成功201，账号本机持久化；可创建多个账号。
- `POST /api/login` 同上，成功200返回 `LoginResponse`；注册后客户端再登录。错误JSON `{error:string}`，不回显密码/token。
- `GET /api/health` 可用性；`GET /ws` 升级后首包为 `hello`，token不放URL。匹配协议/内容版本后发送快照并入图；超时/非法首包关闭。
- 初次快照的selfId确定当前角色，后续快照包含同图全部玩家。浏览器输入每变化/固定心跳提交递增seq；服务器断线清掉输入并despawn，重连再hello获得权威快照。
- 普攻仅权威接受、生成实例和动作同步，不添加PVP/怪物扣血。requestId绑定认证主体+操作，重复请求不生成新动作；冷却中不同请求可拒绝。动作时長由实际样例元数据配置，未读取前暂定可配置600ms，不作为用户要求。
- 各连接只能操作认证角色；消息deny unknown fields、限制包体/队列/速率，客户端不能上传可信位置、伤害、角色ID。
- 默认同角色第二连接替换旧连接或拒绝新连接，后端选一种并记录给统筹者。
- `shared/protocol.ts` 是消息字段实现契约；Rust结构serde camelCase保持匹配。头部type判别字段如上，状态string严格一致。
- `shared/map.json` 由资源集成写入，遵照MapData；真实Map.wz 采样地面，x/y是脚点，y向下。后端从此读地图，不硬编码画地面。
- 前端目录归前端代理；server目录归后端代理；shared、根脚本/文档、bots与资源统筹归主代理。资源验证代理只写references/browser-probe与其证据。不要改其它代理目录。
