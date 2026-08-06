// OpenClaw LocalChat channel 插件
// 1.7-snapshot2：完整收发链路——LocalChat 消息注入 OpenClaw 会话，AI 回复发回 LocalChat。
import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { getChatChannelMeta } from 'openclaw/plugin-sdk/channel-plugin-common';
import { LocalChatConnector } from './connector.js';
import { GatewayChat } from './gateway-client.js';

const CHANNEL_ID = 'localchat';
const DEFAULT_AGENT = 'main';

// 模块级单例：startAccount 可能被 gateway 多次调用，避免产生多套连接互踢
let sharedConnector = null;
let sharedGateway = null;

function resolveAccount(cfg) {
  const c = (cfg && cfg.channels && cfg.channels.localchat) || {};
  return {
    accountId: 'default',
    enabled: true,
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

// 将 LocalChat 消息发送给 OpenClaw agent 会话，并把 AI 回复发回 LocalChat
// 实现方式：插件作为 Gateway WebChat 客户端（chat.send RPC + assistant 事件流）
async function handleInbound({ connector, gateway, inbound }) {
  const isDirect = inbound.type === 'private';
  const sessionKey = `agent:${DEFAULT_AGENT}:localchat:${isDirect ? 'dm' : 'group'}:${inbound.chatId}`;

  const replyText = await gateway.sendChat({
    sessionKey,
    message: inbound.content,
  });

  if (replyText.trim()) {
    connector.log(`[localchat:outbound] ${inbound.type} chat=${inbound.chatId}: ${replyText.slice(0, 60)}`);
    connector.sendText({ type: inbound.type, chatId: inbound.chatId, content: replyText });
  }
}

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
    // gateway 适配器必须放在 base 内
    gateway: {
      startAccount: async (ctx) => {
        const account = resolveAccount(ctx.cfg);
        // 复用已建立的连接（gateway 重启/恢复时会重复调用 startAccount）
        if (sharedConnector && sharedGateway) {
          ctx.connector = sharedConnector;
          ctx.gateway = sharedGateway;
          if (ctx.ready) ctx.ready();
          return;
        }
        const log = (m) => {
          try {
            const logger = ctx.runtime && ctx.runtime.logging
              ? ctx.runtime.logging.getChildLogger({ plugin: CHANNEL_ID })
              : null;
            if (logger && logger.info) logger.info(m);
            else console.log(m);
          } catch { console.log(m); }
        };

        // 连接 OpenClaw Gateway（WebChat 客户端身份）
        const gatewayCfg = (ctx.cfg && ctx.cfg.gateway) || {};
        const gwUrl = `ws://127.0.0.1:${gatewayCfg.port || 18789}`;
        const gateway = new GatewayChat({
          url: gwUrl,
          token: gatewayCfg.auth && gatewayCfg.auth.token,
          log,
        });
        try {
          await gateway.start();
          log(`[localchat] Gateway 已连接 (${gwUrl})`);
        } catch (e) {
          log(`[localchat] Gateway 连接失败: ${e.message}`);
          throw e;
        }

        const connector = new LocalChatConnector({
          serverUrl: account.serverUrl,
          botUserId: account.botUserId,
          botUsername: account.botUsername,
          mentionOnly: account.mentionOnly,
          log,
        });
        const started = await connector.start();
        if (!started) {
          // AI 助理尚未手工注册：轮询等待（LocalChat 界面注册后自动连接）
          connector._pollTimer = setInterval(async () => {
            try {
              const ok = await connector.start();
              if (ok) {
                clearInterval(connector._pollTimer);
                log('[localchat] AI 助理已注册并连接');
              }
            } catch (e) {
              log('[localchat] 轮询检查失败: ' + e.message);
            }
          }, 30000);
          ctx.connector = connector;
          ctx.gateway = gateway;
          sharedConnector = connector;
          sharedGateway = gateway;
          if (ctx.ready) ctx.ready();
          return;
        }

        connector.onMessage((inbound) => {
          handleInbound({ connector, gateway, inbound }).catch((e) => {
            log(`[localchat] inbound 处理失败: ${e.message}`);
          });
        });

        ctx.connector = connector;
        ctx.gateway = gateway;
        sharedConnector = connector;
        sharedGateway = gateway;
        if (ctx.ready) ctx.ready();
      },

      stopAccount: async (ctx) => {
        if (ctx.connector) {
          if (ctx.connector._pollTimer) clearInterval(ctx.connector._pollTimer);
          ctx.connector.stop();
        }
        if (ctx.gateway) ctx.gateway.stop();
        sharedConnector = null;
        sharedGateway = null;
      },
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
});
