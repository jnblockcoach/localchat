# LocalChat 1.7-preview5 安全修复说明

> **⚠ 1.7-preview6 已包含本文件全部修复，并追加第二轮全量审查修复，见 [AUDIT-FIXES.md](AUDIT-FIXES.md)。**

> **版本**：`1.7.0-preview.5`（基线：1.7-preview4）
> **类型**：安全大修 —— 鉴权中间件由「默认放行」重构为「默认拒绝」，读接口全面补挂 IP 校验，修复上传鉴权顺序漏洞
> **范围**：服务器（`server/`）与随版本分发的网页版、CLI、便携版客户端

---

## 一、修复摘要

| 编号 | 级别 | 问题 | 攻击后果 | 状态 |
|---|---|---|---|---|
| **Z1** | 🔴 高 | 读接口 IP 校验大面积缺失（只覆盖写操作） | 局域网内任何人可冒用他人身份读取私聊/群历史、下载任意文件、枚举好友/黑名单/群成员 | ✅ 已修复 |
| **Z2** | 🔴 高 | `DELETE /api/groups/:id` 漏加 IP 校验（userId 在 query） | 任何人可用创建者 userId 删除他人群聊 | ✅ 已修复 |
| **Z3** | 🔴 高 | 上传接口 IP 校验被中间件顺序绕过（multer 解析前 `req.body` 为空） | 任何人可冒充任意 `uploaderId` 上传文件 | ✅ 已修复 |
| **Z4** | 🟠 中 | `GET /api/ai/status` 对服务器本机插件也强制「AI 好友」校验 | OpenClaw connector 无法发现已注册的 AI 账号（潜在历史缺陷） | ✅ 已修复 |
| **Z5** | 🟡 低 | `GET /api/users/all` 无鉴权，且全仓库无任何调用 | 用户 ID / 用户名 / IP 的枚举入口（Z1 攻击链的前置条件） | ✅ 已删除 |

---

## 二、根因分析

三个高危问题来自同一个根因——`server/middleware/auth.js` 的 `requireOwnership` 是 **fail-open（默认放行）** 设计：

```js
// 旧实现（有缺陷）
const userId = getUserId(req);
if (!userId) return next();          // ← 没声明身份 = 直接放行
const user = UserModel.findById(parseInt(userId));
if (!user) return next();            // ← 用户不存在 = 交给业务层
...
catch { return next(); }             // ← 任何异常 = 放行
```

由此派生三种表现：

1. **只挂写路由**：读接口（GET）几乎未挂中间件，「userId 参数匹配」（是不是对话方/群成员）被误当成身份验证；
2. **缺身份即放行**：远端请求只要不带 `userId`，中间件直接放行，业务层若恰好「userId 为空则跳过权限检查」（如 `if (userId && !isMember)`）就形成漏洞；
3. **鉴权顺序错误**：`POST /api/files/upload` 的中间件在 multer 之前执行，multipart 请求此时 `req.body.uploaderId` 必然为空 → 校验被绕过。

---

## 三、新的鉴权模型（`server/middleware/auth.js`）

`requireOwnership(getUserId)` 重构为 **fail-closed**，并在通过后写入 `req.authUserId` 作为业务层唯一可信身份：

| 来源 | 声明的 userId | 结果 |
|---|---|---|
| 远端 | 未提供 / 空 | **401** `缺少用户ID` |
| 远端 | 非整数、≤0 | **401** `用户ID非法` |
| 远端 | 账号不存在 | **401** `用户不存在` |
| 远端 | 账号归属其他 IP | **403** `身份验证失败：该账号不属于当前设备 IP` |
| 远端 | 账号归属本 IP | ✅ 放行，`req.authUserId = userId` |
| 服务器本机 | 未提供 | ✅ 放行，`req.authUserId = null`（插件/运维信任本机） |
| 服务器本机 | 任意合法账号 | ✅ 放行，`req.authUserId = userId` |
| 任意 | 中间件内部异常 | **403**（fail-closed，不再放行） |

补充说明：

- **双要素身份**：`账号 ID` + `来源 IP 归属`，二者必须同时成立；「参数里写了 userId」本身不再构成身份证明；
- **本机免身份**是既有信任模型（服务器进程本就能直读 `data/chat.db`，OpenClaw 插件需要免登录查询本机接口），本次保持；
- **同 IP 多账号互信**仍是设计约束（IP-序号账号体系），本次不引入密码/Token 认证；
- 所有拒绝都会记录日志（拒绝原因、来源 IP、userId、方法、URL），便于发现攻击尝试。

---

## 四、Z1：读接口逐项修复

所有 GET 接口挂 `requireOwnership((req) => req.query.userId)`，业务层改用 `req.authUserId`。

| 文件 | 接口 | 修复前 | 修复后 |
|---|---|---|---|
| `server/routes/message.js` | `GET /api/messages/private/:u1/:u2` | 仅校验 `userId ∈ {u1,u2}`，无 IP 校验 | IP 归属 + 对话参与方双重校验 |
| `server/routes/message.js` | `GET /api/messages/group/:gid` | 仅校验群成员资格 | IP 归属 + 群成员资格 |
| `server/routes/file.js` | `GET /api/files/:id/download` | 仅校验文件相关方 | IP 归属 + 文件相关方（上传者/私聊双方/群成员） |
| `server/routes/file.js` | `GET /api/files/:id/preview` | 同上 | 同上 |
| `server/routes/file.js` | `GET /api/files/:id/info` | 同上 | 同上 |
| `server/routes/friend.js` | `GET /api/friends` | 无任何校验 | IP 归属（只能读自己的好友列表） |
| `server/routes/friend.js` | `GET /api/friends/pending` | 无任何校验 | IP 归属 |
| `server/routes/friend.js` | `GET /api/friends/sent` | 无任何校验 | IP 归属 |
| `server/routes/block.js` | `GET /api/block` | 无任何校验 | IP 归属（只能读自己的黑名单） |
| `server/routes/group.js` | `GET /api/groups` | 无任何校验 | IP 归属（只能读自己加入的群） |
| `server/routes/group.js` | `GET /api/groups/:id` | `userId` 为空则跳过成员校验 | IP 归属 + **强制**成员校验 |
| `server/routes/group.js` | `GET /api/groups/:id/members` | `userId` 为空则跳过成员校验 | IP 归属 + **强制**成员校验 |
| `server/routes/group.js` | `GET /api/groups/:id/muted` | 仅成员校验 | IP 归属 + 成员校验 |

---

## 五、Z2：群删除补鉴权

```js
// server/routes/group.js
router.delete('/:id', requireOwnership((req) => req.query.userId), (req, res) => { ... });
```

保留原有业务校验（`GroupModel.deleteGroup` 内要求 `creator_id === userId`），形成「来源 IP 归属 + 群创建者」双保险。

---

## 六、Z3：上传接口先鉴权后落盘（含客户端契约变更）

### 问题链路

```
requireOwnership(req.body.uploaderId)   ← multipart 尚未解析，req.body = {}
  → uploaderId undefined → 旧中间件直接放行
    → multer 解析 → handler 用 req.body.uploaderId 入库
      → IP 校验完全失效
```

### 修复方案

1. **身份移到 query**：客户端调用改为 `POST /api/files/upload?uploaderId=<id>`，中间件在 **multer 之前** 完成 IP 鉴权；未通过者 **不会产生任何磁盘写入**；
2. **表单字段保留并交叉校验**：handler 只使用已验证的 `req.authUserId` 作为上传者；若表单里的 `uploaderId` 与之不一致 → 403 并删除已落盘文件；
3. **失败清理统一**：抽出 `removeUploaded()`，鉴权失败、参数错误、异常路径都会清理临时文件，不产生孤儿文件。

### 客户端改动（随版本同步）

| 文件 | 改动 |
|---|---|
| `public/js/api.js` | `uploadFile()` 请求 URL 追加 `?uploaderId=` |
| `cli/client.js` | `uploadFile()` 请求 URL 追加 `?uploaderId=` |

> 便携版无上传功能，无需改动；旧版客户端（不带 query）访问新服务器时上传会被拒绝（401/400），属预期的安全收紧。

---

## 七、Z4：AI 状态接口的本机免登录

`GET /api/ai/status` 原来对**所有**无 userId 的调用走「AI 好友」校验，导致服务器本机的 OpenClaw connector（`connector.js:start()` → `findAiAccount()`）在 AI 已注册时拿到 403，无法发现机器人账号。

修复：仅对**远端**请求强制好友校验，本机请求放行：

```js
// server/routes/ai.js
if (account && !isLocalIp(req.ip) && !canViewAi(req.authUserId)) {
  return res.status(403).json({ error: '请先添加 AI 助理为好友' });
}
```

同时 `/api/ai/workspace` 改用 `req.authUserId` 做好友校验（行为不变，语义更明确）。

---

## 八、Z5：删除用户枚举接口

`GET /api/users/all`（`UserModel.getAllUsers()`）全仓库无任何调用，却是审计攻击链中「枚举全部用户 ID」的前置条件，已连同模型方法一并删除。

---

## 九、验证

### 自动化

```bash
cd 1.7-preview5
npm test        # 9 项中间件默认拒绝语义测试（node:test，无需启动服务器）
npm run lint    # 0 error
```

`test/auth.test.js` 覆盖：远端无身份 401、冒用他人身份 403、本人身份放行、本机免身份放行、非法/不存在 ID 401、`verifyAuthIp` 与 IP 规范化。

### 手工攻击矩阵（模拟另一台机器）

Linux 下可用 `127.0.0.2` 作为「非本机来源」（`isLocalIp` 不命中），例如：

```bash
# 服务端：npm start（假设 3000 端口，账号 1 归属于 127.0.0.1）

# 1) 远端不带 userId → 期望 401
curl -i --interface 127.0.0.2 "http://127.0.0.1:3000/api/friends"

# 2) 远端冒用账号 1 → 期望 403
curl -i --interface 127.0.0.2 "http://127.0.0.1:3000/api/friends?userId=1"
curl -i --interface 127.0.0.2 "http://127.0.0.1:3000/api/messages/private/1/3?userId=1"
curl -i --interface 127.0.0.2 "http://127.0.0.1:3000/api/files/1/download?userId=1"
curl -i --interface 127.0.0.2 -X DELETE "http://127.0.0.1:3000/api/groups/1?userId=1"

# 3) 远端冒用上传 → 期望 403，且 data/files/ 无新文件
curl -i --interface 127.0.0.2 -F "file=@README.md" -F "uploaderId=1" \
  "http://127.0.0.1:3000/api/files/upload?uploaderId=1"
```

### 功能回归清单

- [ ] 网页版：注册/登录/好友/群聊/历史消息/文件上传/图片预览/下载
- [ ] 完整 CLI：登录/好友/群聊/历史/文件上传（`/upload` 或对应命令）
- [ ] 便携版：登录/私聊历史
- [ ] AI：注册 AI → `npm run test:connector`（扩展目录）→ 私聊/群聊 @ 回复
- [ ] 局域网扫描（依赖公开的 `GET /api/users/online`，本次未改动）

---

## 十、兼容性与边界

**行为变化**

- 远端缺 userId：由「业务层 400」变为「中间件 401」；远端身份不符：403；
- 上传必须带 `?uploaderId=`（本仓库 web/CLI 已同步）；
- `GET /api/users/all` 不再存在（无调用方，无影响）。

**保持不变 / 已知取舍**

- WS 认证不变（`auth` 消息本就做 `verifyAuthIp`）；
- `isLocalIp` 本机免身份、同 IP 多账号互信（IP 身份体系的设计约束）；
- `GET /api/users/online` 保持公开：CLI `scan.js` 依赖它扫描局域网服务器；
- `GET /api/users/search` 保持公开：加好友功能依赖（返回 id/ip/username，属产品内可见信息）；
- `GET /api/users/me` 保持可查任意用户：CLI `/info <id>` 功能依赖（泄漏面与 search 一致）；
- `POST /api/users/login` 未加 IP 校验：不构成越权操作（写操作已全部鉴权），后续版本可再收紧；
- 本次仍为纯 IP 身份模型，不解决 NAT 同 IP 互信、IP 变更后无法登录等固有限制。

---

## 十一、文件变更清单（相对 1.7-preview4）

| 文件 | 变更 |
|---|---|
| `server/middleware/auth.js` | 重构：fail-closed、`req.authUserId`、拒绝日志、IP 规范化比较 |
| `server/routes/message.js` | 2 个 GET 挂鉴权，改用 `req.authUserId` |
| `server/routes/file.js` | 3 个 GET 挂鉴权；上传改「query 鉴权 → multer → 交叉校验」；统一失败清理 |
| `server/routes/friend.js` | 3 个 GET 挂鉴权 |
| `server/routes/block.js` | 1 个 GET 挂鉴权 |
| `server/routes/group.js` | 4 个 GET + DELETE 挂鉴权；成员校验改为强制执行 |
| `server/routes/ai.js` | `/status` 本机免好友校验（Z4）；`/workspace` 改用 `req.authUserId` |
| `server/routes/user.js` | 删除 `GET /api/users/all` |
| `server/models/user.js` | 删除死方法 `getAllUsers()` |
| `public/js/api.js` | 上传 URL 带 `?uploaderId=` |
| `cli/client.js` | 上传 URL 带 `?uploaderId=` |
| `test/auth.test.js` | 新增：中间件安全回归测试 |
| `package.json` | 版本 `1.7.0-preview.5`；新增 `npm test` |
| `cli/package.json`、`portable/package.json`、`extensions/openclaw-channel-localchat/package.json` | 版本同步 `1.7.0-preview.5` |
| `package-lock.json` 等 lock 文件 | 版本同步（顺带修正扩展 lock 停留在 `1.7.0-snapshot.1` 的漂移） |
| `README.md` | 版本标识更新，新增安全修复入口 |
