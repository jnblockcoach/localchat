# LocalChat 1.7-rc1 残余问题修复说明（发布候选）

> **版本**：`1.7.0-rc.1`（基线：1.7-preview7）
> **性质**：第三轮最终审查发现残余问题的收尾修复，进入正式版发布候选（RC）阶段
> **包含**：1.7-preview5（Z1-Z5）、1.7-preview6（H1-H5 / M1-M7 / L1-L10）、1.7-preview7（R1-R25）全部修复

---

## 一、修复摘要（F1-F12）

| 编号 | 级别 | 问题 | 修复 |
|---|---|---|---|
| **F1** | 🟠 中 | 全局限流器可被"任意路径"打爆：桶无上限增长 + Map>5000 后每请求全表扫描（实测 2 万路径 → 13.6MB / 5.4s） | 桶数量硬上限 2 万、只淘汰超额最旧桶（O(excess)）、过期清理改为每 1000 次摊销；新增边界与性能回归测试 |
| **F2** | 🟠 中 | 上传无单用户/全站配额，磁盘可被填满 | 新增 `server/quota.js`：单用户默认 500MB、全站默认 5GB（`LOCALCHAT_USER_QUOTA_MB` / `LOCALCHAT_TOTAL_QUOTA_MB`），超限 413 并删除已落盘文件；单元测试覆盖 |
| **F3** | 🟡 低 | 仓库根 README 仍写 1.6.1 | 根 README 更新为"最新版本 1.7-rc1"并链接各轮修复文档 |
| **F4** | 🟡 低 | AI 超长回复分段发送可能触发 WS 限流（>30 段），中途断线丢段 | `reply-utils` 新增 `chunkDelayMs()`（每 25 段停顿 4 秒）与 `REPLY_CHUNK_LIMIT=100` 截断保护；发送失败记录剩余段数；单测覆盖节奏函数 |
| **F5** | 🟡 低 | Unicode 双向控制符/零宽字符可造成显示欺骗（实测 `safe\u202Egnp.exe`、`a\u200Bb` 可注册） | `sanitize.js` 剥离 U+200B/200E/200F/202A-202E/2066-2069/FEFF；保留 U+200C/U+200D（emoji ZWJ 与部分文字需要）；单测覆盖 |
| **F6** | 🟡 低 | 同一消息可反复撤回并重复广播 | `MessageModel.recall` 对已撤回消息返回 null；单测覆盖 |
| **F7** | 🟡 低 | 日志无大小上限，攻击/高流量可写满磁盘 | 日志按大小轮转（默认 5MB，`LOCALCHAT_LOG_MAX_BYTES`/`LOCALCHAT_LOG_MAX_MB`）；改为同步追加写入避免异步流轮转竞态；支持 `LOCALCHAT_LOG_REQUESTS=0` 关闭逐请求日志；单测覆盖 |
| **F8** | 🟡 低 | 未注册 AI 时 `status` 向远端泄露 OpenClaw 运行状态 | 远端在无 AI 账号时仅返回 `{openclaw:null, account:null}`；集成测试覆盖 |
| **F9** | 🟡 低 | 群成员变更/群解散无实时通知，客户端界面残留 | 服务端新增 `group_added` / `group_removed` / `group_deleted` WS 事件；Web 与 CLI 客户端处理并刷新；集成测试覆盖三种事件 |
| **F10** | 🟡 低 | `chat.send` 状态异常路径未清理 180s 兜底定时器 | 与 `_finish` 一致清理 `timer`/`hardTimer` |
| **F11** | 🟡 低 | 路径参数用 `parseInt`，`1abc` 被当成 1 | 新增 `server/util/parse.js parseId()`（`^\d{1,15}$`），应用于文件/消息/群/用户路径与 WS auth；集成测试覆盖 |
| **F12** | 🟡 低 | 前端错误处理小缺口 | `refreshFriendList/refreshGroupList` 内部捕获网络异常；`toggleBlock` 检查接口错误后再切换 UI；新增 `showToast`/`resetChatView` 复用；`enterApp` 相关刷新不再产生未处理 rejection |

> F13（无 TLS、同 IP 互信、测试依赖 Linux 127.0.0.x 等）为既定设计边界，不在本版修改范围。

---

## 二、验证

### 自动化（`npm test`，38 项全过）

| 测试文件 | 新增/覆盖 |
|---|---|
| `test/auth.test.js` | Z1-Z5 中间件语义（9 项） |
| `test/integration.test.js` | H/M/R 全部回归 + **F8 / F9 / F11**（真实服务器 + 临时数据目录） |
| `test/connector-reconnect.test.js` | R1 宕机恢复 |
| `test/cleanup.test.js` | R19、R12、**F6 重复撤回** |
| `test/rate-limit.test.js` | R16 + **F1 桶上限与性能**（2.5 万不同路径 <5s） |
| `test/reply-utils.test.js` | R2 + **F4 分段节奏** |
| `test/sanitize.test.js`（新增） | **F5 Unicode 清洗**（含 emoji ZWJ 保留） |
| `test/quota.test.js`（新增） | **F2 单用户/全站配额** |
| `test/logger.test.js`（新增） | **F7 大小轮转与请求日志开关** |

```bash
cd 1.7-rc1
npm test        # 38 pass / 0 fail
npm run lint    # 0 error
```

### 回归

- 插件链路 `test-connector.js`：**13 通过 / 0 失败**（AI 注册→好友→私聊→群聊@→断线）
- 测试全程不污染项目目录（`data/`、`logs/` 均无残留）

---

## 三、行为变化与配置项

**新增环境变量**

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOCALCHAT_USER_QUOTA_MB` | 500 | 单用户上传总量上限 |
| `LOCALCHAT_TOTAL_QUOTA_MB` | 5120 | 全站上传总量上限 |
| `LOCALCHAT_LOG_MAX_MB` / `LOCALCHAT_LOG_MAX_BYTES` | 5MB | 单个日志文件轮转阈值 |
| `LOCALCHAT_LOG_REQUESTS` | 开启 | 设为 `0` 关闭逐请求日志 |

**行为变化（预期）**

- 上传超配额返回 413「个人存储空间不足 / 服务器存储空间不足」；
- 用户名/昵称/群名/文件名中的双向控制符与零宽字符会被剥离；
- 群成员变更/解散会实时推送并刷新客户端；
- 非法路径参数（如 `/api/files/2x/info`）返回 400；
- 同一消息不可重复撤回。

---

## 四、文件变更清单（相对 1.7-preview7）

| 文件 | 变更 |
|---|---|
| `server/middleware/rateLimit.js` | F1 桶上限 + 摊销清理 + 仅淘汰超额最旧桶 |
| `server/quota.js`（新增） | F2 存储配额 |
| `server/util/parse.js`（新增） | F11 严格 ID 解析 |
| `server/sanitize.js` | F5 不可见字符剥离 |
| `server/logger.js` | F7 大小轮转 + 同步写 + 请求日志开关 |
| `server/routes/file.js` | F2 配额检查、F11 parseId |
| `server/routes/group.js` | F9 事件通知、F11 parseId |
| `server/routes/message.js` | F11 parseId |
| `server/routes/user.js` | F11 parseId（/me） |
| `server/routes/ai.js` | F8 无 AI 时远端不泄露状态 |
| `server/websocket.js` | F9 通知导出、F11 严格 auth ID |
| `server/models/message.js` | F6 重复撤回拒绝 |
| `public/js/app.js` | F9 群事件处理、F12 错误处理与复用 |
| `cli/term.js` | F9 群事件处理 |
| `extensions/.../reply-utils.js` | F4 节奏/上限常量与 `chunkDelayMs` |
| `extensions/.../plugin.js` | F4 分段节流与截断提示 |
| `extensions/.../gateway-client.js` | F10 异常路径定时器清理 |
| `README.md`（根目录） | F3 指向 1.7-rc1 |
| 新增测试 | `sanitize` / `quota` / `logger` 三个文件，另扩展 4 个 |
| `package.json` 等 4 包 + lock | 版本 `1.7.0-rc.1` |
