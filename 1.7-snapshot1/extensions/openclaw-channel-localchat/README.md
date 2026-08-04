# openclaw-channel-localchat

把 **OpenClaw AI 助手** 接入 **局域网 LocalChat** 的 Channel 插件（1.7-snapshot1：连接测试版）。

```
[局域网用户] ←→ LocalChat 服务器 (现有 WS/HTTP，零改动)
                    ↑ WS (机器人账号)
[本插件 connector.js] ←→ OpenClaw Gateway ←→ LLM (暂未接入模型)
```

## 当前状态（1.7-snapshot1）

| 能力 | 状态 |
|---|---|
| 机器人账号自动注册/复用（IP-序号体系） | ✅ 已实现并测试 |
| LocalChat WS 收发（私聊/群聊） | ✅ 已实现并测试（12 项） |
| 群聊 `@机器人名` 触发 | ✅ 已实现并测试 |
| 断线自动重连 | ✅ |
| OpenClaw inbound 注入 | 🚧 骨架（标注验证点，待真实环境） |
| OpenClaw outbound 适配器 | 🚧 骨架（当前由 connector.sendText 承担） |
| LLM 模型接入 | ⏸ 未接入（连接测试阶段） |

## 快速开始

### 1. 配置 OpenClaw（Node 22.22.3+，本机 22.22.1 需用 `npx -p node@24`）

```bash
npm install -g openclaw
npx -p node@24.15.0 node $(which openclaw) gateway start   # 或正常 onboard 后 gateway
```

### 2. 启用插件

将本目录作为 OpenClaw 插件安装（外部插件发布 ClawHub 前，可先本地链接）：

```bash
# 在插件目录
npm install
# 在 OpenClaw 配置中启用频道：
#   channels.localchat.serverUrl = http://127.0.0.1:3000
#   channels.localchat.botUsername = AI助手
#   channels.localchat.mentionOnly = true
openclaw gateway restart
```

### 3. 连接测试（不需要 OpenClaw，直接验证 LocalChat 侧链路）

```bash
cd extensions/openclaw-channel-localchat
npm run test:connector            # 默认连 http://127.0.0.1:3000
npm run test:connector -- http://192.168.1.100:3000   # 指定服务器
```

预期输出：12 项全过（机器人注册 → 私聊双向 → 群聊 @ 触发 → 群聊回复）。

## 配置项

| 键 | 说明 | 默认 |
|---|---|---|
| `serverUrl` | LocalChat 服务器地址（必填） | — |
| `botUserId` | 机器人账号 ID（留空自动注册/复用同名账号） | null |
| `botUsername` | 机器人用户名（群聊 @ 触发用） | `AI助手` |
| `mentionOnly` | 群聊仅 @机器人 时响应 | true |

## 使用方式（连接打通后）

- **私聊**：局域网用户给机器人账号发消息 → AI 回复
- **群聊**：`@AI助手 问题` → AI 在群里回复（注意：群聊必须 @ 机器人名，避免刷屏）

## 1.7 后续规划

- [ ] 接入 LLM 模型（DeepSeek/OpenAI/Claude/Ollama，OpenClaw 模型提供商配置）
- [ ] 补齐 OpenClaw inbound/outbound 官方适配器（在真实 gateway 环境验证）
- [ ] DM 配对审批（安全收紧，替换当前的 allow 全部）
- [ ] 媒体/文件消息转发
- [ ] 1.8：异服务器部署（OpenClaw 不在 LocalChat 同机时）

## 架构说明

- `connector.js`：LocalChat 连接核心（注册 bot、WS 收发、@ 过滤、重连）——**无 OpenClaw 依赖，独立可测**
- `plugin.js`：OpenClaw channel 插件（createChatChannelPlugin 骨架 + gateway 接线）
- `index.js`：插件入口（defineChannelPluginEntry）
