const WebSocket = require('ws');

class Client {
  constructor(host, port) {
    this.baseUrl = `http://${host}:${port}`;
    this.wsUrl = `ws://${host}:${port}`;
    this.ws = null;
    this.user = null;
    this.handlers = {};
  }

  api(path, options = {}) {
    return fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    })
      .then(async (r) => {
        const text = await r.text();
        try {
          return JSON.parse(text);
        } catch {
          return { error: `服务器响应异常 (HTTP ${r.status})` };
        }
      })
      .catch((err) => ({ error: err.message }));
  }

  register(username) {
    return this.api('/api/users/register', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  }

  login(id) {
    return this.api('/api/users/login', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  }

  getUsersByIp() {
    return this.api('/api/users/by-ip');
  }

  getUser(id) {
    return this.api(`/api/users/me?id=${id}`);
  }

  getFriends(userId) {
    return this.api(`/api/friends?userId=${userId}`);
  }

  getPendingRequests(userId) {
    return this.api(`/api/friends/pending?userId=${userId}`);
  }

  addFriend(userId, friendId) {
    return this.api('/api/friends/add', {
      method: 'POST',
      body: JSON.stringify({ userId, friendId }),
    });
  }

  acceptFriend(userId, friendId) {
    return this.api('/api/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ userId, friendId }),
    });
  }

  getPrivateHistory(user1, user2, limit = 50, userId) {
    return this.api(`/api/messages/private/${user1}/${user2}?limit=${limit}&userId=${userId || ''}`);
  }

  connect() {
    if (this._manualClose) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.emit('ws_open');
      if (this.user) {
        this.ws.send(JSON.stringify({ type: 'auth', userId: this.user.id }));
      }
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        // 被其他设备顶替登录：停止自动重连，避免互踢死循环
        if (data.type === 'kicked') this._kicked = true;
        const handler = this.handlers[data.type];
        if (handler) handler(data);
      } catch {}
    });

    this.ws.on('close', () => {
      this.emit('ws_close');
      if (this._manualClose || this._kicked) return;
      setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', () => {});
  }

  wsAuth() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.user) {
      this.ws.send(JSON.stringify({ type: 'auth', userId: this.user.id }));
    }
  }

  wsSend(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  sendPrivateMsg(receiverId, content) {
    return this.wsSend({ type: 'private_msg', receiverId, content });
  }

  getAiStatus() {
    return this.api('/api/ai/status');
  }

  registerAi(username, registrantId) {
    return this.api('/api/ai/register', {
      method: 'POST',
      body: JSON.stringify({ username, registrantId }),
    });
  }

  getAiWorkspace(file) {
    return this.api(`/api/ai/workspace${file ? '?file=' + encodeURIComponent(file) : ''}`);
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  emit(type, data) {
    const handler = this.handlers[type];
    if (handler) handler(data);
  }

  disconnect() {
    this._manualClose = true;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

module.exports = Client;
