# LocalChat 1.7.0 正式版发布说明

> **版本**：`1.7.0`（由 1.7-rc3 转正 + 发布前止血修复）
> **包含**：1.7-preview5 以来全部六轮审查修复（Z1-Z5 / H·M·L / R1-R25 / F1-F12 / G1-G7 / K1）+ 本次止血（C1/K2/S1/S2/S3）

---

## 一、本版止血修复（发布前最终审查发现）

### 🔴 C1 · 未认证 WS `null` 帧可击穿服务器进程（严重，已修复）

- **现象**：任意主机连接 WS 后发送文本帧 `null`，服务器进程立即退出（`TypeError: Cannot read properties of null (reading 'type')`）。
- **根因**：`JSON.parse('null')` 返回 `null`，`server/websocket.js` 中日志语句在 `try/catch` 之外访问 `data.type`。
- **修复**：
  1. 解析后先校验 `data` 为**非 null 的普通对象**（拒绝 null/数字/字符串/布尔/数组）；
  2. 整个 `message` 监听器纳入外层 try/catch，任何异常只记录、不击穿进程；
  3. 日志移入校验之后；业务异常对客户端仅返回通用文案；
  4. `WebSocketServer` 设置 `maxPayload: 1MB`，超大帧由 ws 直接拒绝。

### 🟠 K2 · 对象/数组类型 ID 直达 SQL 绑定导致 500（已修复）

- 命中：`DELETE /api/friends`（friendId）、`POST /api/groups/remove-member`（userId）。
- 修复：全部 body ID 统一 `parseId` 严格解析（好友删除、群添加/移除成员、公告、转让、免打扰），非法类型返回 400。

### 🟠 S1 · 数组型 query 参数导致 500（已修复）

- 命中：`GET /api/users/search?q=a&q=b` / `?q[]=a` → `q.trim is not a function`。
- 修复：`q` 先做 `typeof === 'string'` 判断，非字符串按空查询处理（200）。

### 🟠 S2 · WS 帧大小上限（已加固）

- `ws` 默认 `maxPayload` 100MB，未认证连接可发超大帧造成内存压力；已降为 **1MB**。

### 🟠 S3 · 错误边界与信息泄露（已加固）

- 新增统一 Express 错误中间件：500 只返回「服务器内部错误」，细节仅进日志；保留 body-parser 的 4xx 语义；
- 44 处 `500 { error: err.message }` 全部改为通用文案（不再泄露 SQLite 内部错误）；
- 新增 `uncaughtException` / `unhandledRejection` 进程级日志兜底（记录不崩溃）；
- WS 客户端侧错误（超大帧/协议错误）日志由 ERROR 降为 WARN。

---

## 二、验证

| 项目 | 结果 |
|---|---|
| `npm test` | **46/46 通过**（新增 C1/S2/K2/S1 用例） |
| `npm run lint` | **0 error** |
| 插件链路 `test-connector.js` | **13/13 通过** |
| WS payload 矩阵（null/数字/字符串/布尔/数组/空对象/type 异常/2MB 帧） | 全部存活、0 ERROR |
| HTTP 畸形输入扫描（19 接口 × 24 组异常 body + 畸形 JSON + PUT/DELETE + 22 组异常 GET） | **590 次请求，0 个 ≥500，0 ERROR，进程存活** |
| 功能验收（此前 rc 阶段） | 全流程 38/38 + 补充（旧库迁移/配额）6/6 |

---

## 三、升级与配置

- 目录：`1.7/`；npm 版本：`1.7.0`（根包、cli、portable、扩展、lock 文件与插件 clientVersion 全部一致）。
- 数据目录兼容：旧库自动迁移（含 `users` 表约束迁移、`messages.file_id` 与索引补齐），升级前建议备份 `data/`。
- 沿用 rc1 引入的环境变量：
  - `PORT`、`LOCALCHAT_DATA_DIR`
  - `LOCALCHAT_USER_QUOTA_MB`（默认 500）、`LOCALCHAT_TOTAL_QUOTA_MB`（默认 5120）
  - `LOCALCHAT_LOG_MAX_MB` / `LOCALCHAT_LOG_MAX_BYTES`、`LOCALCHAT_LOG_REQUESTS=0`

---

## 四、已知边界与后续计划

**设计边界（非缺陷）**：无 TLS（局域网明文）；同 IP 多账号互信；服务器本机免身份；测试套件依赖 Linux `127.0.0.x` 源地址绑定。

**本次为"止血"发布**：未引入统一参数校验层。已规划 **1.7.1**：
1. `server/validate.js` 字段级 schema，所有路由声明式校验，禁止裸 `req.body/query` 直达模型；
2. "接口 × 字段 × 类型"全排列 HTTP+WS 回归矩阵（断言无 5xx 且进程存活）纳入 `npm test` 作为发布门禁；
3. 人工过一遍浏览器渲染类交互（Markdown 预览、音视频播放、IME 输入）。

---

## 五、六轮修复文档索引

| 轮次 | 版本 | 文档 |
|---|---|---|
| 第一轮 | 1.7-preview5 | [SECURITY-FIXES.md](SECURITY-FIXES.md)（Z1-Z5） |
| 第二轮 | 1.7-preview6 | [AUDIT-FIXES.md](AUDIT-FIXES.md)（H1-H5 / M1-M7 / L1-L10） |
| 第三轮 | 1.7-preview7 | [AUDIT-FIXES-2.md](AUDIT-FIXES-2.md)（R1-R25） |
| 第四轮 | 1.7-rc1 | [RC-FIXES.md](RC-FIXES.md)（F1-F12） |
| 第五轮 | 1.7-rc2 | [RC2-FIXES.md](RC2-FIXES.md)（G1-G7） |
| 第六轮 | 1.7-rc3 | [RC3-FIXES.md](RC3-FIXES.md)（K1 + 文档） |
| 发布止血 | **1.7.0** | 本文件（C1/K2/S1/S2/S3） |
