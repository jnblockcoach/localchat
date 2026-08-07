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

  // 查找已手工注册的 AI 助理账号（不自动注册；未注册返回 null）
  async findAiAccount() {
    const res = await this.api('/api/ai/status');
    if (res && res.account && res.account.id) {
      this.botUserId = res.account.id;
      this.user = res.account;
      return this.user;
    }
    return null;
  }

  // 安全重连：先确认 AI 助理账号再连接（避免 auth 失败循环）
  async _safeReconnect() {
    try {
      const ai = await this.findAiAccount();
      if (!ai) {
        this.log('[localchat] AI 助理账号不存在（等待手工注册）');
        return;
      }
      this.connect();
    } catch (e) {
      this.log('[localchat] 重连前检查失败: ' + e.message + '，5 秒后重试');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this._safeReconnect(), 5000);
    }
  }

  // 启动：查找 AI 助理账号 → 连接 WS → 认证；未注册返回 null（由调用方轮询）
  async start() {
    const ai = await this.findAiAccount();
    if (!ai) {
      this.log('[localchat] 尚未注册 AI 助理（请在 LocalChat 界面手动注册）');
      return null;
    }
    this.log(`[localchat] AI 助理就绪: ${this.user.username} (#${this.user.id}) @ ${this.serverUrl}`);
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
        this.reconnectTimer = setTimeout(() => this._safeReconnect(), 3000);
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
    // H1：整体异常防护，任何消息处理异常都不能崩溃 gateway 进程
    try {
      this._handleMessage(data);
    } catch (e) {
      this.log('[localchat] 消息处理异常: ' + e.message);
    }
  }

  _handleMessage(data) {
    if (!this.user) {
      // 账号未就绪时仅记录，不处理业务
      this.log('[localchat] 账号未就绪，忽略消息: ' + (data.type || ''));
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
