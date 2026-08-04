// LocalChat 连接核心：机器人账号注册 + WS 收发 + 群聊 @ 过滤
// 独立于 OpenClaw SDK，可单独测试（npm run test:connector）
import WebSocket from 'ws';

export class LocalChatConnector {
  constructor({ serverUrl, botUserId = null, botUsername = 'AI助手', mentionOnly = true, log = console.log }) {
    this.serverUrl = String(serverUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.wsUrl = this.serverUrl.replace(/^http/, 'ws');
    this.botUserId = botUserId;
    this.botUsername = botUsername;
    this.mentionOnly = mentionOnly;
    this.log = log;
    this.ws = null;
    this.user = null;
    this.handlers = [];
    this.stopped = false;
    this.reconnectTimer = null;
  }

  async api(path, options = {}) {
    const res = await fetch(`${this.serverUrl}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: `服务器响应异常 (HTTP ${res.status})` };
    }
  }

  // 启动：确保机器人账号存在 → 连接 WS → 认证
  async start() {
    if (!this.botUserId) {
      // 本机已有同名账号则复用，否则自动注册
      const res = await this.api('/api/users/by-ip');
      const users = Array.isArray(res) ? res : [];
      const existing = users.find((u) => u.username === this.botUsername);
      if (existing) {
        this.botUserId = existing.id;
      } else {
        const reg = await this.api('/api/users/register', {
          method: 'POST',
          body: JSON.stringify({ username: this.botUsername }),
        });
        if (reg.error) throw new Error(`注册机器人账号失败: ${reg.error}`);
        this.botUserId = reg.user.id;
      }
    }

    const me = await this.api(`/api/users/me?id=${this.botUserId}`);
    if (me.error) throw new Error(`机器人账号不存在: ${me.error}`);
    this.user = me;
    this.log(`[localchat] 机器人就绪: ${this.user.username} (#${this.user.id}) @ ${this.serverUrl}`);

    this.connect();
    return this.user;
  }

  connect() {
    if (this.stopped) return;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.log('[localchat] WS 已连接');
      this.ws.send(JSON.stringify({ type: 'auth', userId: this.user.id }));
    });

    this.ws.on('message', (raw) => this._onMessage(raw));

    this.ws.on('close', () => {
      this.log('[localchat] WS 断开，3 秒后重连');
      if (!this.stopped) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });

    this.ws.on('error', () => {});
  }

  _onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === 'new_private_msg' || data.type === 'new_group_msg') {
      const msg = data.message;
      // 过滤机器人自己的消息（服务器回显），避免自循环
      if (Number(msg.sender_id) === Number(this.user.id)) return;

      const isGroup = msg.type === 'group';
      // 群聊：默认仅 @机器人名 时响应
      if (isGroup && this.mentionOnly && !(msg.content || '').includes('@' + this.botUsername)) return;

      const chatId = isGroup
        ? msg.group_id
        : Number(msg.sender_id) === Number(this.user.id) ? msg.receiver_id : msg.sender_id;

      const inbound = {
        type: isGroup ? 'group' : 'private',
        chatId,
        groupId: isGroup ? msg.group_id : null,
        senderId: msg.sender_id,
        senderName: msg.sender_name || '#' + msg.sender_id,
        content: msg.content,
        messageId: msg.id,
        createdAt: msg.created_at,
      };

      for (const handler of this.handlers) {
        try {
          handler(inbound);
        } catch (e) {
          this.log('[localchat] 消息处理器异常: ' + e.message);
        }
      }
    } else if (data.type === 'error') {
      this.log('[localchat] 服务器错误: ' + (data.message || ''));
    }
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  // 发送文本：type = 'private' | 'group'
  sendText({ type, chatId, content }) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const payload = type === 'group'
      ? { type: 'group_msg', groupId: chatId, content }
      : { type: 'private_msg', receiverId: chatId, content };
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}
