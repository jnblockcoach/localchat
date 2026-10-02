# openclaw-channel-localchat

把 **OpenClaw AI 助手** 接入 **局域网 LocalChat** 的 Channel 插件（1.7-snapshot1：连接测试版）。

```
[局域网用户] ←→ LocalChat 服务器 (现有 WS/HTTP，零改动)
                    ↑ WS (机器人账号)
[本插件 connector.js] ←→ OpenClaw Gateway ←→ LLM (暂未接入模型)
```

## 当前状态（1.7-snapshot2）

| 能力 | 状态 |
|---|---|
| 机器人账号自动注册/复用/重注册 | ✅ 已实现并实测 |
| LocalChat WS 收发（私聊/群聊） | ✅ 已实现并实测 |
| 群聊 `@机器人名` 触发 | ✅ 已实现并实测 |
| **AI 完整回复链路**（LocalChat → OpenClaw → LLM → LocalChat） | ✅ **已实测**（DeepSeek 模型） |
| 私聊回复 | ✅ 实测 |
| 群聊 @ 回复（保持群内） | ✅ 实测 |

## 真实环境实测记录（2026-08-06）

- Node 24.19.0（nvm）+ OpenClaw 2026.7.1-2 + LocalChat 1.7-snapshot2 + DeepSeek 模型
- **架构（WebChat 桥）**：LocalChat 消息 → 插件 connector → 插件 GatewayChat（官方 GatewayClient，`chat.send` RPC）→ agent 会话 → assistant 事件流收集 → connector 发回 LocalChat
- 私聊实测：发"你好"，AI 回复完整中文回答 ✅
- 群聊实测：`@AI助手 你好` → AI 在群内回复 ✅

### 接入要点（踩坑记录）

1. **gateway 适配器必须在 `base` 内**（createChatChannelPlugin 顶层只接受 base/security/pairing/threading/outbound）
2. **插件须为纯 ESM**（`require` 会直接崩溃 channel 启动）
3. 依赖须完整安装（`npm install` 后 ws 存在，openclaw peer 链接保留）
4. 连接失败会触发 OpenClaw crash-loop breaker，修复后 `openclaw gateway restart` 或 `gateway call channels.start` 验证
5. 插件顶层不要使用动态 `import()` 做同步初始化（ESM race 导致加载失败）
6. 服务器清库后机器人账号失效：重连时自动重新注册（ensureBot）
7. **startAccount 可能被多次调用**：connector/gateway 连接用模块级单例，避免多套连接互踢
8. **inbound 内部管线（dispatch/buildContext）依赖 gateway turn 上下文**，外部插件不可用——改用官方 **WebChat 通道**（GatewayClient + chat.send/事件流），更简单可靠

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
