// OpenClaw LocalChat 插件入口（JS ESM，无需编译）
import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { localChatPlugin } from './plugin.js';

export default defineChannelPluginEntry({
  id: 'localchat',
  name: 'LocalChat',
  description: '连接局域网 LocalChat 服务器，把 OpenClaw AI 接入聊天',
  plugin: localChatPlugin,
  configSchema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      serverUrl: { type: 'string', description: 'LocalChat 服务器地址，如 http://127.0.0.1:3000' },
      botUserId: { type: ['integer', 'null'], description: 'AI 机器人账号 ID（留空自动注册）' },
      botUsername: { type: 'string', description: '机器人用户名（群聊 @ 触发，默认 AI助手）' },
      mentionOnly: { type: 'boolean', description: '群聊仅 @机器人 时响应（默认 true）' },
    },
  },
});
