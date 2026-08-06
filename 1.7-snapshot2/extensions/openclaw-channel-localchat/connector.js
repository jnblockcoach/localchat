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

  // 确保机器人账号存在（注册/复用/校验），断线重连时也会调用
  async ensureBot() {
    if (this.botUserId) {
      const me = await this.api(`/api/users/me?id=${this.botUserId}`);
      if (me && !me.error) {
        this.user = me;
        return this.user;
      }
      // 账号已不存在（如服务器清库）：重新注册
    }
    const res = await this.api('/api/users/by-ip');
    const users = Array.isArray(res) ? res : [];
    const existing = users.find((u) => u.username === this.botUsername);
    if (existing) {
      this.botUserId = existing.id;
      this.user = existing;
      return this.user;
    }
    const reg = await this.api('/api/users/register', {
      method: 'POST',
      body: JSON.stringify({ username: this.botUsername }),
    });
    if (reg.error) throw new Error(`注册机器人账号失败: ${reg.error}`);
    this.botUserId = reg.user.id;
    this.user = reg.user;
    return this.user;
  }

  // 启动：确保机器人账号存在 → 连接 WS → 认证
  async start() {
    await this.ensureBot();
    this.log(`[localchat] 机器人就绪: ${this.user.username} (#${this.user.id}) @ ${this.serverUrl}`);
    this.connect();
    return this.user;
  }

  connect() {
    if (this.stopped) return;
    // 先关闭旧连接，避免新旧并存导致重复登录互踢循环
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.log('[localchat] WS 已连接');
      ws.send(JSON.stringify({ type: 'auth', userId: this.user.id }));
    });

    ws.on('message', (raw) => this._onMessage(raw));

    ws.on('close', () => {
      // 仅当前连接关闭才触发重连（旧连接被替换时的 close 不重连）
      if (this.ws !== ws) return;
      this.log('[localchat] WS 断开，3 秒后重连');
      if (!this.stopped) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(async () => {
          try {
            // 重连前确保机器人账号仍存在（服务器重启/清库后自动重新注册）
            await this.ensureBot();
            this.connect();
          } catch (e) {
            this.log('[localchat] 重连前检查失败: ' + e.message + '，5 秒后重试');
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.connect(), 5000);
          }
        }, 3000);
      }
    });

    ws.on('error', () => {});
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
    } else if (data.type === 'friend_request') {
      // 自动接受好友请求，使用户可以立即与 AI 对话
      const fromId = data.from && data.from.id;
      if (fromId) {
        this.api('/api/friends/accept', {
          method: 'POST',
          body: JSON.stringify({ userId: this.user.id, friendId: fromId }),
        })
          .then((r) => {
            if (r.error) this.log('[localchat] 自动接受好友失败: ' + r.error);
            else this.log('[localchat] 已自动接受好友: ' + ((data.from && data.from.username) || '#' + fromId));
          })
          .catch((e) => this.log('[localchat] 自动接受好友异常: ' + e.message));
      }
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
