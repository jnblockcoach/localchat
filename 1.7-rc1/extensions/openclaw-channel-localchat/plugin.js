// OpenClaw LocalChat channel 插件
// 1.7-snapshot9：完整收发链路——LocalChat 消息注入 OpenClaw 会话，AI 回复发回 LocalChat。
import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { getChatChannelMeta } from 'openclaw/plugin-sdk/channel-plugin-common';
import { LocalChatConnector } from './connector.js';
import { GatewayChat } from './gateway-client.js';
import { splitReply, chunkDelayMs, REPLY_CHUNK_LIMIT } from './reply-utils.js';

const CHANNEL_ID = 'localchat';
const DEFAULT_AGENT = 'main';

// 模块级单例：startAccount 可能被 gateway 多次调用，避免产生多套连接互踢
let sharedConnector = null;
let sharedGateway = null;
let sharedPeerPoll = null;

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

// 通过 HTTP 查询服务器接口（不依赖 connector 连接状态；M6：5 秒超时防挂起）
async function connectorApi(cfg, path) {
  const account = resolveAccount(cfg);
  const serverUrl = String(account.serverUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${serverUrl}${path}`, { signal: controller.signal });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 将 LocalChat 消息发送给 OpenClaw agent 会话，并把 AI 回复发回 LocalChat
// 实现方式：插件作为 Gateway WebChat 客户端（chat.send RPC + assistant 事件流）
async function handleInbound({ connector, gateway, inbound }) {
  const isDirect = inbound.type === 'private';
  const sessionKey = `agent:${DEFAULT_AGENT}:localchat:${isDirect ? 'dm' : 'group'}:${inbound.chatId}`;

  const replyText = await gateway.sendChat({
    sessionKey,
    message: inbound.content,
  });

  // R2：服务端消息上限 4000 字，超长回复分段发送，避免整条被拒绝后内容丢失
  // F4：分段之间按限流节奏停顿；超过分段上限时截断并明确提示
  let chunks = splitReply(replyText.trim());
  if (chunks.length > 0) {
    const truncated = chunks.length > REPLY_CHUNK_LIMIT;
    if (truncated) chunks = chunks.slice(0, REPLY_CHUNK_LIMIT);
    const suffix = chunks.length > 1 ? ` …（共 ${chunks.length} 段${truncated ? '，已截断' : ''}）` : '';
    connector.log(`[localchat:outbound] ${inbound.type} chat=${inbound.chatId}: ${chunks[0].slice(0, 60)}${suffix}`);
    for (let i = 0; i < chunks.length; i++) {
      const delay = chunkDelayMs(i);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      let content = chunks[i];
      if (truncated && i === chunks.length - 1) content += '\n…（回复过长，已截断）';
      const ok = connector.sendText({ type: inbound.type, chatId: inbound.chatId, content });
      if (!ok) {
        connector.log(`[localchat] 分段发送中断（连接断开），剩余 ${chunks.length - i - 1} 段被丢弃`);
        break;
      }
    }
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
          // M3：复用共享轮询定时器，避免泄漏
          if (sharedPeerPoll) ctx.peerPollTimer = sharedPeerPoll;
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

        // 连接 OpenClaw Gateway：优先已确认互联的远程机器（含对方 token），否则本机
        let gwHost = '127.0.0.1';
        let peerToken = null;
        try {
          const peersRes = await connectorApi(ctx.cfg, '/api/ai/peers');
          const peers = (peersRes && Array.isArray(peersRes.peers)) ? peersRes.peers : [];
          const accepted = peers.find((p) => p.status === 'accepted');
          if (accepted) {
            gwHost = accepted.ip;
            peerToken = accepted.token || null;
            log(`[localchat] 使用互联 OpenClaw: ${accepted.ip}${peerToken ? '' : '（无 token，可能认证失败）'}`);
          }
        } catch (e) {
          log('[localchat] 查询互联配置失败（使用本机 OpenClaw）: ' + e.message);
        }
        const gatewayCfg = (ctx.cfg && ctx.cfg.gateway) || {};
        const gwPort = gatewayCfg.port || 18789;
        let gwUrl = `ws://${gwHost}:${gwPort}`;
        let gateway = new GatewayChat({
          url: gwUrl,
          token: peerToken || (gatewayCfg.auth && gatewayCfg.auth.token),
          log,
        });
        // 连接 Gateway（远程失败回退本机）；token 可选（互联机器使用对方提供的 token）
        const connectGateway = async (host, useToken) => {
          const url = `ws://${host}:${gwPort}`;
          if (gateway) { try { gateway.stop(); } catch {} }
          const authToken = useToken || (gatewayCfg.auth && gatewayCfg.auth.token);
          gateway = new GatewayChat({ url, token: authToken, log });
          await gateway.start();
          // M1：同步 ctx/shared 引用，stopAccount 才能停到活跃连接
          ctx.gateway = gateway;
          sharedGateway = gateway;
          log(`[localchat] Gateway 已连接 (${url})`);
          return host;
        };
        let currentGwHost = gwHost;
        try {
          await connectGateway(gwHost);
        } catch (e) {
          if (gwHost !== '127.0.0.1') {
            log(`[localchat] 远程 Gateway 连接失败（${e.message}），回退本机`);
            currentGwHost = '127.0.0.1';
            await connectGateway('127.0.0.1');
          } else {
            log(`[localchat] Gateway 连接失败: ${e.message}`);
            throw e;
          }
        }
        // 轮询互联配置：对方确认/取消互联后自动切换，无需重启 gateway
        let pollStopped = false; // N2：stopAccount 后阻止进行中的 tick 重建连接
        const peerPoll = setInterval(async () => {
          if (pollStopped) return;
          try {
            const peersRes = await connectorApi(ctx.cfg, '/api/ai/peers');
            if (pollStopped) return;
            const peers = (peersRes && Array.isArray(peersRes.peers)) ? peersRes.peers : [];
            const acceptedList = peers.filter((p) => p.status === 'accepted');
            // L-b：多个 accepted 时只用第一个（服务器已限制单互联，此处兜底提示）
            if (acceptedList.length > 1) {
              log(`[localchat] 检测到 ${acceptedList.length} 个已互联，仅使用第一个: ${acceptedList[0].ip}`);
            }
            const accepted = acceptedList[0];
            const nextHost = accepted ? accepted.ip : '127.0.0.1';
            if (nextHost !== currentGwHost) {
              log(`[localchat] 互联配置变化: ${currentGwHost} -> ${nextHost}，切换 Gateway`);
              const peerToken = accepted ? (accepted.token || null) : null;
              currentGwHost = nextHost;
              await connectGateway(nextHost, peerToken);
            }
          } catch (e) {
            log('[localchat] 互联配置轮询失败: ' + e.message);
          }
        }, 30000);
        ctx.peerPollStopped = () => { pollStopped = true; };
        sharedPeerPoll = peerPoll;

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
          ctx.peerPollTimer = peerPoll;
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
        ctx.peerPollTimer = peerPoll;
        sharedConnector = connector;
        sharedGateway = gateway;
        if (ctx.ready) ctx.ready();
      },

      stopAccount: async (ctx) => {
        if (ctx.connector) {
          if (ctx.connector._pollTimer) clearInterval(ctx.connector._pollTimer);
          ctx.connector.stop();
        }
        if (ctx.peerPollStopped) ctx.peerPollStopped();
        if (ctx.gateway) ctx.gateway.stop();
        if (ctx.peerPollTimer) clearInterval(ctx.peerPollTimer);
        if (sharedPeerPoll) { clearInterval(sharedPeerPoll); sharedPeerPoll = null; }
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
