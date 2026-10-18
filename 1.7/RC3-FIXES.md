# LocalChat 1.7-rc3 发布候选第三版修复说明

> **⚠ 1.7.0 正式版已包含本文件全部修复，并完成发布前止血（C1/K2/S1/S2/S3），见 [RELEASE-NOTES.md](RELEASE-NOTES.md)。**

> **版本**：`1.7.0-rc.3`（基线：1.7-rc2）
> **性质**：发布前最终审查发现问题的修复（K1 500 错误 + 扩展文档过期描述）
> **包含**：preview5（Z1-Z5）、preview6（H/M/L）、preview7（R1-R25）、rc1（F1-F12）、rc2（G1-G7）全部修复。

---

## 一、修复摘要

### 🟠 K1 · 目标用户不存在时好友/拉黑接口返回 500（FK 约束未处理）

**发现方式**：发布前 456 次畸形输入全接口扫描（387 次首轮即命中）。

**复现**：
```
POST /api/friends/add  { userId: 1, friendId: 987654321 }        → 500 FOREIGN KEY constraint failed
POST /api/friends/add  { userId: 1, friendId: "999…(40位)" }     → 500 FOREIGN KEY constraint failed
POST /api/block/block  { userId: 1, blockedUserId: 987654321 }   → 500 FOREIGN KEY constraint failed
```

**影响**：任意登录用户可稳定触发 500 与 ERROR 日志，并泄露 SQLite 内部错误文本；服务器不崩溃、不涉越权，属健壮性与 API 语义缺陷。

**修复**：
- `server/routes/friend.js`
  - `POST /add`：`parseId(friendId)` 非法 → 400；`UserModel.findById` 不存在 → **404 用户不存在**；自加、AI 直加、关系查重、发请求全部改用校验后的 `targetId`；
  - `POST /accept`、`POST /reject`：`friendId` 改用 `parseId`（非法 400，无请求仍 404）。
- `server/routes/block.js`
  - `POST /block`：`parseId` + 存在性校验 → 非法 400 / 不存在 404；
  - `POST /unblock`：保持幂等，但参数必须是合法 ID（400）。

**回归测试**：`test/integration.test.js` 新增 K1 用例（404/400/正常加好友 200）；畸形输入扫描从 1 类 500 降至 **0**。

### 🟡 扩展文档过期描述（非功能问题）

- `openclaw.plugin.json`、`index.js`、扩展 `README.md`：`botUserId` 描述由"留空自动注册"更正为"留空则由服务器端已手工注册的 AI 助理账号决定"（snapshot3 起已改为手工注册）；
- 扩展 README「当前状态」表格更正为"AI 助理手工注册 + 插件自动发现/复用/重连"，踩坑记录第 6 条同步更正；
- 「后续规划」中已完成的 LLM 接入与回复链路标记为已完成，剩余项保留（DM 配对、媒体转发、异服务器部署）。

---

## 二、验证

### 畸形输入全接口扫描（发布前复扫）

```
扫描请求 456 次，异常(>=500/-1) 0 次
服务器存活: true
ERROR 日志: 0 条
```

覆盖：19 个 POST 接口 × 18 组异常 body、畸形 JSON/错误 Content-Type、PUT/DELETE、20 个 GET 异常参数（超长/负数/非数字/路径穿越/超长路径/%00/非法 UTF-8）。

### 自动化（`npm test`，42 项全过）

```bash
cd 1.7-rc3
npm test        # 42 pass / 0 fail（新增 K1 用例）
npm run lint    # 0 error
```

### 回归

- 插件链路 `test-connector.js`：**13 通过 / 0 失败**（好友添加/接受流程不受 K1 修复影响）
- 测试不污染项目目录

---

## 三、文件变更清单（相对 1.7-rc2）

| 文件 | 变更 |
|---|---|
| `server/routes/friend.js` | K1：add/accept/reject 严格 ID + 目标存在性校验 |
| `server/routes/block.js` | K1：block 严格 ID + 存在性校验；unblock 严格 ID |
| `test/integration.test.js` | 新增 K1 用例（42 项） |
| `extensions/.../openclaw.plugin.json`、`index.js`、`README.md` | 过期描述更正（手工注册） |
| `README.md` 等文档 + 4 包/lock | 版本 `1.7.0-rc.3` 与文档链更新 |
