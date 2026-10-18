# LocalChat 1.7-preview7 第二轮全量审查修复说明

> **⚠ 1.7-rc1 已包含本文件全部修复，并完成残余问题收尾（F1-F12），见 [RC-FIXES.md](RC-FIXES.md)。**

> **版本**：`1.7.0-preview.7`（基线：1.7-preview6）
> **类型**：第二轮全量审查（server / public / cli / portable / extension 全文件）发现问题的完整修复 —— **3 项高危（可靠性/功能）+ 5 项中危 + 17 项低危**
> **包含**：1.7-preview5（Z1-Z5）与 1.7-preview6（H1-H5、M1-M7、L1-L10）全部修复。

---

## 一、修复摘要

### 🔴 高危

| 编号 | 问题 | 修复 |
|---|---|---|
| **R1** | 插件断线重连一次失败即永久失联（服务器不可达被当作"AI 未注册"，不再重试） | `connector.js` 新增 `queryAiAccount()` 区分「服务器不可达」与「账号不存在」，不可达时每 5 秒退避重试；自动化测试模拟"宕机 5 秒后恢复"验证 |
| **R2** | AI 长回复 >4000 字被服务端整条拒绝后静默丢失 | 新增 `reply-utils.js` `splitReply()`，超长回复按换行边界分段（每段 ≤4000）逐条发送 |
| **R3** | 音视频内嵌预览实际不可用（`preview` 对 mp3/wav/mp4 返回 400，前端却用 `<audio>/<video>`） | `preview` 放行媒体类型（上传白名单已限制扩展名），集成测试断言 `audio/mpeg` 200 |

### 🟠 中危

| 编号 | 问题 | 修复 |
|---|---|---|
| **R4** | 互联 `reject`/`disconnect` 缺目标 IP 归属校验，任意登录用户可跨机删除他人互联 | 与 `accept` 一致，要求 `user.ip === targetIp`；集成测试覆盖本机/跨源/目标 IP 三种情况 |
| **R5** | 拉黑单向：拉黑者仍可继续给对方发消息 | 私聊与私聊文件均双向拦截（"对方已将你拉黑" / "你已拉黑对方"） |
| **R6** | Web 端登出后可能无限重连（重连定时器到点后无条件复位 `manualClose`） | 定时器回调内二次确认 `manualClose` 再连接 |
| **R7** | CLI/便携版终端注入（用户名/消息中的 ANSI、回车等控制字符） | 服务端：用户名/群名/AI 名/文件名剥离全部控制字符，消息/公告保留 `\t \n` 并剥离其余；客户端：CLI `_put` 与便携版 `_print` 均再剥离一层 |
| **R8** | 私聊消息重复缓存进"自己 id"的伪会话，浪费 localStorage | 只按对方 id 缓存一次 |

### 🟡 低危

| 编号 | 问题 | 修复 |
|---|---|---|
| R9 | OpenClaw 探针负结果不缓存 | 正负结果均缓存 5 秒 |
| R10 | 日志写流无 `error` 监听，磁盘满会崩进程 | `stream.on('error', ...)` 降级为 console |
| R11 | Gateway 会话队列 Map 永不清理 | 队尾完成后删除（仅当仍为最新队尾） |
| R12 | `created_at` 异常时 `NaN` 绕过 2 分钟撤回限制 | `Number.isFinite(diffMs)` 校验，异常按超时拒绝 |
| R13 | 上传文件名未剥离控制字符 | 复用单行控制字符清理 |
| R14 | 便携版撤回消息仍显示原文 | 展示 `[消息已撤回]` |
| R15 | `/info` 与消息 `file` 对象暴露内部 `stored_name` | 改用公开字段投影 |
| R16 | 无 HTTP/WS 限流 | 全局 300 次/分/IP；注册 30、登录 20、上传 20、加好友 30、AI 注册 5；WS 每连接 10 秒 30 条 |
| R17 | CLI `api()` 对非幂等 POST 自动重试可能重复执行 | 仅 GET 重试 |
| R18 | `messages.file_id` 无索引 | 启动时补 `idx_messages_file` |
| R19 | 上传孤儿文件无回收 | 启动/每 24h 清理：过期且无消息引用的 files 记录 + 磁盘孤儿（保留 7 天） |
| R20 | AI Workspace 跟随符号链接可读外部文件 | `lstat` 拒绝 symlink（列目录与读取均校验） |
| R21 | 缺少基础安全响应头 | 关闭 `X-Powered-By`；加 `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` / CSP（兼容内联脚本的宽松策略） |
| R22 | 上传期间登出导致 `currentUser` 空引用 | 上传前固定账号 id 并判空 |
| R23 | AI 账号登录时显示错误的 IP-序号 | AI 显示 `display_id`（顶栏与个人资料） |
| R24 | 互联拓扑对任意登录用户可见 | 远程查询需为 AI 好友（本机插件路径不受影响） |
| R25 | CLI 群聊列表用字符数定位中文名称错位 | 改用显示宽度 `_displayWidth` |

---

## 二、关键修复示意

### R1 · 重连退避（`connector.js`）

```js
async queryAiAccount() {
  const res = await this.api('/api/ai/status');
  if (!res || res.error) return { reachable: false, account: null, error: res && res.error };
  return { reachable: true, account: res.account && res.account.id ? res.account : null };
}

async _safeReconnect() {
  const { reachable, account, error } = await this.queryAiAccount();
  if (!reachable) {                       // ← 服务器不可达：继续重试
    this.reconnectTimer = setTimeout(() => this._safeReconnect(), 5000);
    return;
  }
  if (!account) { /* 等待手工注册，不重试 */ return; }
  this.connect();
}
```

### R2 · 长回复分段（`reply-utils.js`）

```js
export function splitReply(text, max = REPLY_MAX) {
  // 超过 max 时优先在换行处切分，保证每段 <= max，不丢内容
}
```

### R3 · 媒体预览（`server/routes/file.js`）

```js
if (['.jpg', '.jpeg', '.png', '.bmp', '.md', '.txt', '.mp4', '.mp3', '.wav'].includes(ext)) {
  res.sendFile(filePath);   // sendFile 自带 Range 支持
}
```

### R16 · 限流键设计

限流键包含 `max:windowMs` 作用域，避免全局与路由级限流器共用计数桶导致请求被重复计数（开发过程中实际踩到并被测试捕获）。

---

## 三、行为变化与兼容性

**收紧（预期）**

- 用户名/群名/AI 名/文件名中的控制字符会被剥离（注册仍成功，只是清洗后入库）；
- 消息中的控制字符（除 `\t \n`）会被剥离；
- 拉黑后双向禁止私聊；
- 互联的 reject/disconnect 仅目标 IP 账号可操作；
- 远程查询互联列表需为 AI 好友；
- 高频请求返回 429（阈值对正常人工使用非常宽松）。

**功能恢复**

- 音视频内嵌预览恢复可用；
- AI 长回复不再丢失（分段发送）；
- 服务器重启/网络抖动后 AI 机器人自动恢复（不再需要重启 OpenClaw gateway）。

**新增文件**

- `server/sanitize.js`、`server/middleware/rateLimit.js`、`server/cleanup.js`
- `extensions/openclaw-channel-localchat/reply-utils.js`

---

## 四、验证

### 自动化（`npm test`，28 项全过）

| 测试文件 | 覆盖 |
|---|---|
| `test/auth.test.js` | Z1-Z5 中间件默认拒绝语义（9 项） |
| `test/integration.test.js` | H1/M7、H4、H5、M1-M5、R3、R4、R5、R7、R15、R21、R24（启动真实服务器 + 临时数据目录） |
| `test/connector-reconnect.test.js` | **R1**：服务器宕机 5 秒后恢复，连接器自动重连 |
| `test/cleanup.test.js` | **R19** 孤儿清理（过期未引用删除/被引用保留/磁盘孤儿删除）、**R12** 异常时间撤回 |
| `test/rate-limit.test.js` | **R16** 429 与多 IP 独立计数 |
| `test/reply-utils.test.js` | **R2** 分段不丢内容、每段 ≤4000、换行边界优先 |

```bash
cd 1.7-preview7
npm test        # 28 pass / 0 fail
npm run lint    # 0 error
```

### 插件链路回归（需本机 OpenClaw 或已注册 AI）

```bash
PORT=3212 LOCALCHAT_DATA_DIR=/tmp/lc-test npm start
cd extensions/openclaw-channel-localchat
node test/test-connector.js http://127.0.0.1:3212   # 13 通过 / 0 失败
```

---

## 五、文件变更清单（相对 1.7-preview6）

| 文件 | 变更 |
|---|---|
| `server/sanitize.js`（新增） | 控制字符清理 |
| `server/middleware/rateLimit.js`（新增） | 固定窗口限流（含作用域隔离） |
| `server/cleanup.js`（新增） | 孤儿文件清理 |
| `server/index.js` | 安全响应头、全局限流、启动+定时清理 |
| `server/routes/user.js` | R7 用户名清洗、R16 注册/登录限流 |
| `server/routes/ai.js` | R4 目标 IP 校验、R9 负缓存、R20 lstat、R24 好友校验、R7 名称清洗 |
| `server/routes/group.js` | R7 群名/公告清洗 |
| `server/routes/file.js` | R3 媒体预览、R13 文件名清洗、R15 隐藏 stored_name、R16 上传限流 |
| `server/routes/friend.js` | R16 加好友限流 |
| `server/websocket.js` | R5 双向拉黑、R7 消息清洗、R16 每连接限流 |
| `server/models/message.js` | R12 时间校验、R15 文件字段投影 |
| `server/db.js` | R18 file_id 索引 |
| `server/logger.js` | R10 写流错误处理 |
| `public/js/ws.js` | R6 重连竞态 |
| `public/js/app.js` | R8 缓存去重、R22 上传判空、R23 AI 标识 |
| `cli/term.js` | R7 终端清洗、R25 显示宽度 |
| `cli/client.js` | R17 仅 GET 重试 |
| `portable/index.js` | R7 终端清洗、R14 撤回显示 |
| `extensions/.../connector.js` | R1 重连退避 |
| `extensions/.../reply-utils.js`（新增） | R2 分段工具 |
| `extensions/.../plugin.js` | R2 分段发送 |
| `extensions/.../gateway-client.js` | R11 队列清理、版本号 |
| `test/*.test.js` | 6 个测试文件、28 项用例 |
| `package.json` 等 4 包 + lock | 版本 `1.7.0-preview.7` |
| `README.md` | 版本与文档入口更新 |
