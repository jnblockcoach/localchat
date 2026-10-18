# LocalChat 1.7-preview6 全量审查修复说明

> **⚠ 1.7-preview7 已包含本文件全部修复，并追加第二轮全量审查修复，见 [AUDIT-FIXES-2.md](AUDIT-FIXES-2.md)。**

> **版本**：`1.7.0-preview.6`（基线：1.7-preview5）
> **类型**：全量文件审查修复 —— **5 项高危 + 7 项中危 + 10 项低危/健壮性**
> **说明**：本版包含 1.7-preview5 的 Z1-Z5 全部修复（见 [SECURITY-FIXES.md](SECURITY-FIXES.md)），并完成第二轮全量审查（server / public / cli / portable / extension 所有源码文件）发现问题的修复。

---

## 一、修复摘要

### 🔴 高危（安全）

| 编号 | 问题 | 影响 | 状态 |
|---|---|---|---|
| **H1** | 文件引用越权：WS `file_msg` 不校验上传者 | 任意用户可枚举文件 ID 劫持他人（含未发送）文件并转发给任何人 | ✅ 已修复 + 集成测试 |
| **H2** | 存储型 XSS：上传文件名注入 `download` 属性 | 恶意文件名在他人查看消息时执行脚本 | ✅ 已修复（属性安全转义） |
| **H3** | 存储型 XSS：Markdown 链接 URL 属性注入 | 恶意 `.md` 文件在预览时执行脚本 | ✅ 已修复（URL 解析 + 转义） |
| **H4** | `POST /api/users/login` 无 IP 校验 | 局域网任何人可冒名"登录"任意账号（信息泄露 + UI 身份混淆） | ✅ 已修复 + 集成测试 |
| **H5** | 同一 WS 连接重复 `auth` 身份残留 | 同 IP 多账号场景下消息投递给错误连接（B 收到 A 的私聊） | ✅ 已修复 + 集成测试 |

### 🟠 中危

| 编号 | 问题 | 状态 |
|---|---|---|
| **M1** | `@提及` 用 `\w` 匹配，中文用户名收不到提醒 | ✅ 已修复 + 集成测试 |
| **M2** | 任意登录用户可私聊/发文件给任意用户（无好友校验） | ✅ 已修复 + 集成测试 |
| **M3** | WS 消息无服务端长度上限（前端 maxlength 可绕过） | ✅ 已修复 + 集成测试 |
| **M4** | 历史消息 `limit=-1` 触发 SQLite `LIMIT -1` 返回全部历史 | ✅ 已修复 + 集成测试 |
| **M5** | AI 助理可被任意远端用户抢注 | ✅ 已修复 + 集成测试 |
| **M6** | `escapeHtml` 用于属性（不转义引号）的多处同根因问题 | ✅ 已修复（统一属性安全转义） |
| **M7** | `canAccessFile` 用 `LIMIT 1` 取最早引用消息判定权限 | ✅ 已修复（EXISTS 语义） |

### 🟡 低危 / 健壮性

| 编号 | 问题 | 状态 |
|---|---|---|
| **L1** | 登出不清除该账号本地聊天缓存 | ✅ 已修复 |
| **L2** | 上传缺文件字段时 500 | ✅ 已修复（400） |
| **L3** | 群聊参数校验缺失（memberIds 非数组、群/用户不存在→FK 500） | ✅ 已修复 |
| **L4** | 老库 users 表迁移在 FK 开启时可能失败并留下残表 | ✅ 已修复（FK 关闭 + 事务 + 列探测） |
| **L5** | WS 未认证超时计时器未在 close 清理 | ✅ 已修复 |
| **L6** | Gateway 180s 兜底定时器不可清理 | ✅ 已修复 |
| **L7** | Web 被顶替（kicked）后仍停留在主界面 | ✅ 已修复（清理登录态 + 回登录页 + 刷新） |
| **L8** | 群成员 @ 候选缓存不失效 | ✅ 已修复（成员操作失效 + 30s TTL） |
| **L9** | 文案/版本残留与失效测试脚本 | ✅ 已修复 |
| **L10** | `ai_peers.ip` 无格式校验（任意字符串入库/回显） | ✅ 已修复（IPv4/IPv6 校验 + IPv6 URL 括号） |

---

## 二、高危修复详情

### H1 · 文件引用越权（`server/websocket.js` + `server/routes/file.js`）

**原问题**：`handleFileMsg` 只检查 fileId 存在，不校验上传者；`canAccessFile` 取"最早一条引用消息"判定权限。任意用户可把他人文件 ID 塞进自己发送的消息，使接收方获得下载权（对未发送文件尤其致命）。

**修复**：

```js
// websocket.js：只允许发送自己上传的文件
if (Number(file.uploader_id) !== Number(senderId)) {
  return sendError(ws, '无权发送该文件');
}
```

```js
// file.js：权限 = 上传者本人 OR 存在一条“本人是相关方”的引用消息
SELECT 1 FROM messages m
WHERE m.file_id = ? AND (
  (m.type = 'private' AND (m.sender_id = ? OR m.receiver_id = ?))
  OR (m.type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = m.group_id AND gm.user_id = ?))
) LIMIT 1
```

### H2/H3 · 存储型 XSS（`public/js/ui.js`）

**根因**：`escapeHtml` 基于 `div.textContent → innerHTML`，**不转义双引号**，被用于 HTML 属性；Markdown 链接仅用 `startsWith('http')` 白名单后直接拼 `href`。

**修复**：
- `escapeHtml` 改为字符映射，转义 `& < > " '`，文本渲染不受影响，属性场景安全；
- 文件名等属性位置显式 `escapeHtml`；
- Markdown 链接先 `new URL()` 解析并校验协议白名单，再用转义后的 `href` 拼接，附 `rel="noopener noreferrer"`。

### H4 · 登录 IP 校验（`server/routes/user.js`）

```js
if (!verifyAuthIp(req.ip, user)) {
  return res.status(403).json({ error: '身份验证失败：该账号不属于当前设备 IP' });
}
```

覆盖普通账号与 AI `openclaw-*` display_id 登录；前端"用昵称查找登录"同步标注"仅本机账号可登录"。

### H5 · 重复 auth 身份残留（`server/websocket.js`）

```js
if (ws.userId && Number(ws.userId) !== uid) {
  return sendError(ws, '该连接已认证为其他账号，请重新建立连接');
}
```

同一连接重复以同账号认证仍允许（幂等，兼容重连补发）。

---

## 三、中危修复详情

- **M1**：新增 `isMentioned(content, username)` 逐个成员名匹配（支持中文/空格），ASCII 用户名后做单词边界判断避免 `@bob` 误伤 `@bobby`；前端高亮同步改为 `@([^\s@]+)`。
- **M2**：私聊与私聊文件发送均要求 `friends.status === 'accepted'`，否则返回"你们还不是好友"；群聊/群文件不受影响。
- **M3**：服务端 `MESSAGE_MAX = 4000`，私聊/群聊统一校验 `typeof content === 'string'` 且超长拒绝。
- **M4**：`limit = Math.max(1, Math.min(parseInt(...) || 100, 200))`，`offset = Math.max(0, ...)`。
- **M5**：`POST /api/ai/register` 前置 `requireLocalIp`，非服务器本机 403。
- **M6**：`escapeHtml` 全量属性安全化（见 H2），并补齐 `renderAiPeers`/在线主机等处未转义的 `p.ip`、`u.ip`。
- **M7**：`canAccessFile` 改为 EXISTS 语义（见 H1）。

---

## 四、低危修复详情

| 编号 | 文件 | 修复 |
|---|---|---|
| L1 | `public/js/cache.js`、`app.js` | 新增 `CACHE.clearUserCaches(uid)`；登出/被顶替时清除该账号全部 `chat_cache_<uid>_*` |
| L2 | `server/routes/file.js` | `!req.file` → 400「缺少文件」；fileFilter 统一使用清洗后的扩展名 |
| L3 | `server/routes/group.js` | memberIds 数组化 + 合法性/存在性过滤 + 200 人上限；add/remove-member 校验群与用户存在；公告类型校验 |
| L4 | `server/db.js` | 迁移整体事务化，迁移前后关闭/恢复外键，`DROP TABLE IF EXISTS users_new`，按 `pragma_table_info` 探测列避免丢 is_ai/display_id |
| L5 | `server/websocket.js` | `close` 时 `clearTimeout(ws._authTimer)` |
| L6 | `extensions/.../gateway-client.js` | 180s 兜底定时器存入 `entry.hardTimer`，`_finish`/断线/stop 均可清理 |
| L7 | `public/js/app.js` | kicked 后清理 currentUser/缓存/界面状态并返回登录页，4 秒后刷新 |
| L8 | `public/js/app.js` | mention 候选缓存 30 秒过期；添加/移除成员后立即失效 |
| L9 | `portable/index.js`、`gateway-client.js`、`ai.js`、`test-connector.js` | 修正 "(1.4beta)" 文案与 `clientVersion`；删除未用导入；测试脚本改为"手工注册 AI"流程（本机自动注册，失败时给出明确指引而非崩溃） |
| L10 | `server/routes/ai.js` | `targetIp` 必须是合法 IPv4/IPv6（interconnect/accept/reject/disconnect 全部校验）；IPv6 探针 URL 加方括号 |

---

## 五、行为变化与兼容性

**收紧（预期）**

- 登录必须来源 IP 与账号归属一致：跨 IP 登录返回 403；
- 私聊/私聊文件仅限好友（群聊不变）；Web 与 CLI/便携版均只从好友列表发起对话，无功能回归；
- WS 消息上限 4000 字（与前端一致）；超长返回"消息过长"；
- AI 助理注册仅服务器本机可操作（OpenClaw 探针本就只检查本机）；
- 文件只能由上传者发送（他人文件不可转发）；
- `limit=-1` 等非法分页被夹到合法值。

**保持**

- `GET /api/users/me` 仍可查任意用户的公开资料（与 `/search` 同级信息；CLI `/info` 依赖），真正的冒名入口已在 `/login` 封堵；
- `/api/users/online`、`/api/users/search` 保持公开（局域网发现与加好友功能）；
- 本机 IP 免身份、同 IP 多账号互信仍是设计约束。

**新增环境变量（测试/部署便利，默认行为不变）**

- `PORT`：服务器端口（默认 3000）
- `LOCALCHAT_DATA_DIR`：数据与日志目录（默认项目 `data/`、`logs/`）

---

## 六、验证

### 自动化（`npm test`，17 项全过）

- `test/auth.test.js`（9 项）：Z1-Z5 中间件默认拒绝语义；
- `test/integration.test.js`（8 项，启动真实服务器 + 临时数据目录）：H1/M7、H4、H5、M1、M2、M3、M4、M5 逐项复现验证。

```bash
cd 1.7-preview6
npm test        # 17 pass / 0 fail
npm run lint    # 0 error
```

### 插件链路回归（需本机 OpenClaw 或已注册 AI）

```bash
# 另开终端启动测试服务器
PORT=3210 LOCALCHAT_DATA_DIR=/tmp/lc-test npm start
cd extensions/openclaw-channel-localchat
node test/test-connector.js http://127.0.0.1:3210   # 13 通过 / 0 失败
```

覆盖：AI 手工注册/复用 → 好友建立 → 私聊双向 → 群聊 @ 触发/回复 → 断线停止。

### 手工攻击矩阵（可用 `--interface 127.0.0.2` 模拟异地来源）

| 攻击 | 期望 |
|---|---|
| 远端 `POST /api/users/login` 冒名 | 403 |
| 远端 `POST /api/ai/register` | 403 |
| WS 发送他人 `fileId` | error「无权发送该文件」 |
| 未引用文件 `download`/`info` | 403 |
| 同一 WS 先 auth A 再 auth B | error「该连接已认证为其他账号」 |
| 非好友私聊 | error「你们还不是好友」 |
| 4001 字消息 | error「消息过长」 |
| `?limit=-1` 历史 | 仅返回 1 条 |

---

## 七、文件变更清单（相对 1.7-preview5）

| 文件 | 变更 |
|---|---|
| `server/websocket.js` | H1 上传者校验、H5 重复 auth 拒绝、M1 中文 @、M2 好友校验、M3 长度限制、L5 计时器清理 |
| `server/routes/file.js` | H1/M7 权限判定重写（EXISTS + 上传者）、L2 缺文件 400、数据目录环境变量 |
| `server/routes/user.js` | H4 登录 IP 校验 |
| `server/routes/message.js` | M4 limit/offset 夹取 |
| `server/routes/group.js` | L3 参数与存在性校验、成员上限 |
| `server/routes/ai.js` | M5 注册限本机、L9 删除未用导入、L10 IP 校验与 IPv6 URL |
| `server/db.js` | L4 迁移事务化/外键处理/列探测；数据目录环境变量 |
| `server/index.js` | `PORT` 环境变量 |
| `server/logger.js` | 日志目录环境变量 |
| `public/js/ui.js` | H2/H3/M6 转义与 URL 校验、M1 高亮 |
| `public/js/app.js` | M6 补转义、L1 缓存清理、L7 kicked 复位、L8 mention 缓存 |
| `public/js/cache.js` | `clearUserCaches()` |
| `public/index.html` | 搜索登录提示"仅本机账号可登录" |
| `portable/index.js` | L9 文案 |
| `extensions/.../gateway-client.js` | L6 定时器清理、L9 版本号 |
| `extensions/.../test/test-connector.js` | L9 适配手工注册流程与前置条件提示 |
| `test/integration.test.js` | 新增：8 项集成回归测试 |
| `package.json` 等 4 个包 + lock | 版本 `1.7.0-preview.6` |
| `README.md` | 版本与安全入口更新 |
