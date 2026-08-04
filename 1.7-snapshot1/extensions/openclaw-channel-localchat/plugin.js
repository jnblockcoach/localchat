// OpenClaw LocalChat channel 插件
// 1.7-snapshot1：连接测试版。LocalChat 收发核心（connector.js）完整实现；
// OpenClaw inbound/outbound 接线按官方 SDK 编写，标注了真实环境验证点。
import { createChatChannelPlugin, getChatChannelMeta } from 'openclaw/plugin-sdk/channel-core';
import { LocalChatConnector } from './connector.js';

const CHANNEL_ID = 'localchat';

function resolveAccount(cfg) {
  const c = (cfg && cfg.channels && cfg.channels.localchat) || {};
  return {
    accountId: 'default',
    configured: Boolean(c.serverUrl),
    serverUrl: c.serverUrl || 'http://127.0.0.1:3000',
    botUserId: c.botUserId ?? null,
    botUsername: c.botUsername || 'AI助手',
    mentionOnly: c.mentionOnly !== false,
  };
}

const configAdapter = {
  listAccountIds: () => ['default'],
  resolveAccount: (cfg) => resolveAccount(cfg),
  defaultAccountId: () => 'default',
  isConfigured: (account) => account.configured,
  resolveAllowFrom: () => ['*'],
  resolveDefaultTo: () => null,
};

export const localChatPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: getChatChannelMeta(CHANNEL_ID),
    capabilities: {
      chatTypes: ['direct', 'group'],
      threads: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: ['channels.localchat'] },
    configSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        serverUrl: { type: 'string' },
        botUserId: { type: ['integer', 'null'] },
        botUsername: { type: 'string' },
        mentionOnly: { type: 'boolean' },
      },
    },
    config: configAdapter,
    setup: {
      label: 'LocalChat',
      description: '连接局域网 LocalChat 服务器，把 AI 接入聊天',
      getAccountParams: () => ['serverUrl'],
    },
  },

  // 连接测试阶段：默认允许所有局域网用户；正式版应改为 DM 配对审批
  security: {
    dm: {
      channelKey: 'localchat:dm',
      resolvePolicy: () => 'allow',
      resolveAllowFrom: () => ['*'],
    },
  },

  gateway: {
    // 启动账户：连接 LocalChat（注册/复用机器人账号 + WS 常驻）
    startAccount: async (ctx) => {
      const account = resolveAccount(ctx.cfg);
      const log = (m) => {
        try {
          const logger = ctx.runtime && ctx.runtime.logging
            ? ctx.runtime.logging.getChildLogger({ plugin: CHANNEL_ID })
            : null;
          if (logger && logger.info) logger.info(m);
          else console.log(m);
        } catch { console.log(m); }
      };

      const connector = new LocalChatConnector({
        serverUrl: account.serverUrl,
        botUserId: account.botUserId,
        botUsername: account.botUsername,
        mentionOnly: account.mentionOnly,
        log,
      });
      await connector.start();

      connector.onMessage(async (inbound) => {
        // —— 1.7 验证点：真实 OpenClaw 环境中的 inbound 注入 ——
        // 骨架流程（官方 API，见 docs/plugins/sdk-channel-plugins.md）：
        //   1. createChannelInboundEnvelopeBuilder({ cfg, route })({ channel, from, timestamp, body })
        //   2. runtime.channel.inbound.buildContext({ channel, accountId, messageId,
        //        timestamp, from, sender, ... })
        //   3. 将 context 交给核心 dispatch（message adapter / receive lifecycle）
        // 连接测试阶段：打印入站消息到日志，验证 LocalChat→OpenClaw 链路可达。
        log(`[localchat:inbound] ${inbound.type} chat=${inbound.chatId} from=${inbound.senderName}: ${inbound.content}`);
      });

      ctx.connector = connector;
      if (ctx.ready) ctx.ready();
    },

    stopAccount: async (ctx) => {
      if (ctx.connector) ctx.connector.stop();
    },
  },

  // —— 1.7 验证点：outbound 适配器需在真实 OpenClaw 环境按官方
  //    ChannelOutboundAdapter 形状补全（sendText 等），连接测试阶段由
  //    connector.sendText 承担发送，测试脚本可直接调用验证。
});
