# LocalChat 1.7-rc2 发布候选第二轮修复说明

> **版本**：`1.7.0-rc.2`（基线：1.7-rc1）
> **性质**：对 rc1 新增代码的最终详细审查发现问题的收尾修复（G1-G7）
> **包含**：preview5（Z1-Z5）、preview6（H/M/L）、preview7（R1-R25）、rc1（F1-F12）全部修复。

---

## 一、修复摘要

| 编号 | 级别 | 问题（均为 rc1 新代码） | 修复 |
|---|---|---|---|
| **G1** | 🟠 中 | F4 分段节奏参数错误：服务端是「固定窗口 30 条/10 秒」，rc1 的"每 25 段停 4 秒"仍在同窗口内发 50 条 → 长回复丢段。**仿真复现：50 段丢 20、100 段丢 45** | 停顿改为 **10500ms**（>10 秒窗口）；仿真回归测试：100 段 0 丢失 |
| **G2** | 🟠 中 | 截断提示直接追加到末段：末段恰好 4000 字时变成 4012 字 → 被服务端拒绝丢失 | 新增 `fitNotice()`：先按 `4000 - notice.length` 截断再追加，保证单条 ≤4000；单测覆盖 |
| **G3** | 🟠 中 | F1 的 LRU 淘汰可被主动触发绕过限流：**实测**先打满 login 30 次，再洪泛 2 万不同路径把 login 桶挤出后，第 31 次即放行 | 全局限流改为 `keyBy: 'ip'`（按 IP 聚合，不随路径建桶）；路由限流保留 path 且仍受 2 万上限保护；新增"洪泛后限流仍生效"回归测试 |
| **G4** | 🟡 低 | F9 的 CLI 群事件处理器只调 `_refreshLists()`，该函数不重绘侧栏 → 群列表显示滞后 | 三个事件改为 `await _refreshLists()` 后 `_drawSidebar()` |
| **G5** | 🟡 低 | F5 遗漏 U+061C（ALM）、U+2028/U+2029（行/段分隔符）、U+00AD（软连字符） | 补入不可见字符正则；单测覆盖 |
| **G6** | 🟡 低 | F2 配额 `SUM(size) WHERE uploader_id` 无索引 → 每次上传全表扫描 | `db.js` 增加 `idx_files_uploader ON files(uploader_id)` |
| **G7** | 🟡 低 | F9 通知不去重：重复添加/移除非成员也发通知；删除群时操作者本人收到多余提示 | 仅成员状态实际变化时通知；群解散通知排除操作者；集成测试覆盖"重复操作无重复通知" |

---

## 二、关键修复示意

### G1 · 分段节奏（`reply-utils.js`）

```js
// 服务端固定窗口：30 条 / 10 秒
export const CHUNK_PAUSE_EVERY = 25;   // 25 < 30
export const CHUNK_PAUSE_MS = 10500;   // 必须 > 10 秒，窗口才会重置
```

仿真对比（严格按服务端窗口逻辑）：

```
50 段 / 停4s   → 丢弃 20 段     50 段 / 停10.5s → 丢弃 0
100 段 / 停4s  → 丢弃 45 段     100 段 / 停10.5s → 丢弃 0
```

### G2 · 截断提示（`reply-utils.js` / `plugin.js`）

```js
export function fitNotice(text, notice = TRUNC_NOTICE, max = REPLY_MAX) {
  const value = String(text ?? '');
  if (value.length + notice.length <= max) return value + notice;
  return value.slice(0, Math.max(0, max - notice.length)) + notice;
}
```

### G3 · 限流键（`middleware/rateLimit.js`）

```js
const key = keyBy === 'ip'
  ? `${scope}:${ip}`                             // 全局：按 IP 聚合，1 IP 1 桶
  : `${scope}:${ip}:${method}:${path}`;          // 路由：受限真实路由数量
```

---

## 三、验证

### 自动化（`npm test`，41 项全过）

| 测试 | 覆盖 |
|---|---|
| `reply-utils.test.js` | G1 参数与**固定窗口仿真 100 段 0 丢失**；G2 `fitNotice` 边界 |
| `rate-limit.test.js` | **G3 洪泛后限流仍生效**；F1 桶上限与性能；R16 429 |
| `sanitize.test.js` | **G5 新增字符** + F5 emoji ZWJ 保留 |
| `cleanup.test.js` | **G7 重复通知**（集成测试内）、R19/R12/F6 |
| `integration.test.js` | F9 群事件链路 + **G7 重复添加/移除无重复通知**；F8/F11/全部历史回归 |
| 其余 | auth（Z1-Z5）、connector-reconnect（R1）、quota（F2）、logger（F7） |

```bash
cd 1.7-rc2
npm test        # 41 pass / 0 fail
npm run lint    # 0 error
```

### 回归

- 插件链路 `test-connector.js`：**13 通过 / 0 失败**
- 测试不污染项目目录

---

## 四、文件变更清单（相对 1.7-rc1）

| 文件 | 变更 |
|---|---|
| `server/middleware/rateLimit.js` | G3 `keyBy: 'ip'` 全局按 IP 聚合；scope 含 keyBy |
| `server/index.js` | 全局限流启用 `keyBy: 'ip'` |
| `extensions/.../reply-utils.js` | G1 停顿 10500ms；G2 `fitNotice` |
| `extensions/.../plugin.js` | G1 使用新节奏；G2 截断提示安全写入 |
| `cli/term.js` | G4 群事件后重绘侧栏 |
| `server/sanitize.js` | G5 补充 U+061C/U+2028/U+2029/U+00AD |
| `server/db.js` | G6 `idx_files_uploader` |
| `server/routes/group.js` | G7 通知去重、群解散排除操作者 |
| `test/*` | G1/G2/G3/G5/G7 回归用例（共 41 项） |
| `README.md` 等文档 + 4 包/lock | 版本 `1.7.0-rc.2` 与文档链更新 |
