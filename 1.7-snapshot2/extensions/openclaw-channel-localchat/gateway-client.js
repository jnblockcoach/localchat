// OpenClaw Gateway WebSocket 客户端封装
// 用官方 GatewayClient（内部模块）连接 Gateway，通过 chat.send 与 agent 会话对话，
// 收集 assistant 事件流得到完整回复。
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';

async function importInternalModule(fileName) {
  const url = new URL(`./node_modules/openclaw/dist/${fileName}`, import.meta.url);
  return await import(url.href);
}

// 探测 GatewayClient 类（内部模块导出名为压缩短名，遍历 src-*.js 按类名识别）
async function resolveGatewayClient() {
  const distDir = new URL('./node_modules/openclaw/dist/', import.meta.url);
  const files = readdirSync(distDir).filter((f) => /^src-[A-Za-z0-9]+\.js$/.test(f));
  for (const file of files) {
    const mod = await importInternalModule(file);
    const client = Object.values(mod).find(
      (v) => typeof v === 'function' && (v.name === 'GatewayClient' || /^class\s+GatewayClient/.test(Function.prototype.toString.call(v)))
    );
    if (client) return client;
  }
  throw new Error('未识别到 GatewayClient 类');
}

// 探测客户端身份常量（clientName/mode 枚举）
async function resolveClientInfo() {
  const distDir = new URL('./node_modules/openclaw/dist/', import.meta.url);
  const files = readdirSync(distDir);
  const infoFile = files.find((f) => /^client-info-[A-Za-z0-9]+\.js$/.test(f));
  if (!infoFile) return { clientName: 'cli', mode: 'cli' };
  const mod = await importInternalModule(infoFile);
  const names = Object.values(mod).find(
    (v) => v && typeof v === 'object' && typeof v.WEBCHAT_UI === 'string'
  );
  const modes = Object.values(mod).find(
    (v) => v && typeof v === 'object' && typeof v.WEBCHAT === 'string' && typeof v.CLI === 'string'
  );
  return {
    clientName: (names && names.CLI) || 'cli',
    mode: (modes && modes.CLI) || 'cli',
  };
}

let cachedClientClass = null;
let cachedClientInfo = null;

export class GatewayChat {
  constructor({ url, token, log = console.log }) {
    this.url = url;
    this.token = token;
    this.log = log;
    this.client = null;
    this.ready = false;
    // 进行中的会话回复收集：sessionKey -> { text, timer }
    this.pending = new Map();
    this._runIdToSession = new Map();
  }

  async start() {
    if (!cachedClientClass) cachedClientClass = await resolveGatewayClient();
    if (!cachedClientInfo) cachedClientInfo = await resolveClientInfo();
    const GatewayClient = cachedClientClass;

    this.client = new GatewayClient({
      url: this.url,
      token: this.token,
      preauthHandshakeTimeoutMs: 15000,
      clientName: cachedClientInfo.clientName,
      clientDisplayName: 'localchat-plugin',
      clientVersion: '1.7.0-snapshot.2',
      platform: process.platform,
      mode: cachedClientInfo.mode,
      deviceIdentity: null,
      instanceId: randomUUID(),
      minProtocol: 4,
      maxProtocol: 4,
      onHelloOk: () => {
        this.ready = true;
        this.log('[gateway] 已连接');
      },
      onEvent: (evt) => this._onEvent(evt),
      onClose: () => {
        this.ready = false;
        this.log('[gateway] 连接断开');
      },
      onGap: () => {},
    });
    this.client.start();
    // 等待 hello
    for (let i = 0; i < 50 && !this.ready; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!this.ready) throw new Error('Gateway 连接超时');
  }

  _onEvent(evt) {
    const e = evt && evt.event;
    const p = evt && evt.payload;
    if (e !== 'agent' || !p) return;

    const sessionKey = p.sessionKey;
    const stream = p.stream;

    if (stream === 'assistant' && p.data && typeof p.data.delta === 'string') {
      const entry = this.pending.get(sessionKey);
      if (entry) {
        entry.text += p.data.delta;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this._finish(sessionKey), 3000);
      }
    } else if (stream === 'lifecycle' && p.data && p.data.phase === 'end') {
      this._finish(sessionKey);
    }
  }

  _finish(sessionKey) {
    const entry = this.pending.get(sessionKey);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(sessionKey);
    this._runIdToSession.delete(entry.runId);
    const text = entry.text.trim();
    if (!text) return;
    entry.onReply(text);
  }

  // 发送消息到 agent 会话，异步返回完整回复
  async sendChat({ sessionKey, message }) {
    if (!this.ready || !this.client) throw new Error('Gateway 未连接');
    const runId = randomUUID();
    const reply = new Promise((resolve) => {
      this.pending.set(sessionKey, {
        runId,
        text: '',
        onReply: resolve,
        timer: null,
      });
      // 兜底超时（180 秒无回复则返回已收集文本）
      setTimeout(() => this._finish(sessionKey), 180000);
    });
    const res = await this.client.request('chat.send', {
      sessionKey,
      agentId: 'main',
      message,
      idempotencyKey: runId,
    });
    const status = res && res.status;
    if (status && status !== 'started') {
      this.pending.delete(sessionKey);
      throw new Error(`chat.send 状态异常: ${status}`);
    }
    return await reply;
  }

  stop() {
    if (this.client) {
      try { this.client.stop(); } catch {}
      this.client = null;
    }
    this.ready = false;
  }
}
