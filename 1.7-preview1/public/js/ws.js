window.WS = {
  socket: null,
  handlers: {},
  manualClose: false,
  pendingAuth: null,

  connect() {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.manualClose = false;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${location.host}`);

    this.socket.onopen = () => {
      console.log('WebSocket 已连接');
      const handler = this.handlers['ws_connected'];
      if (handler) handler();
      // 补发登录认证（覆盖登录时连接尚未就绪、以及断线自动重连后未认证的情况）
      if (this.pendingAuth) {
        this.socket.send(JSON.stringify({ type: 'auth', userId: this.pendingAuth }));
      }
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // 被其他设备顶替登录：停止自动重连，避免互踢死循环
        if (data.type === 'kicked') {
          this.manualClose = true;
        }
        const handler = this.handlers[data.type];
        if (handler) {
          handler(data);
        }
      } catch (err) {
        console.error('WS消息解析失败:', err);
      }
    };

    this.socket.onclose = () => {
      console.log('WebSocket 已断开，3秒后重连...');
      const handler = this.handlers['ws_disconnected'];
      if (handler) handler();
      if (!this.manualClose) {
        setTimeout(() => this.connect(), 3000);
      }
    };

    this.socket.onerror = (err) => {
      console.error('WebSocket 错误:', err);
      const handler = this.handlers['ws_error'];
      if (handler) handler(err);
    };
  },

  on(type, handler) {
    this.handlers[type] = handler;
  },

  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    } else {
      const handler = this.handlers['send_error'];
      if (handler) handler(data);
    }
  },

  auth(userId) {
    this.pendingAuth = userId;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send({ type: 'auth', userId });
    }
  },

  disconnect() {
    this.manualClose = true;
    this.pendingAuth = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  },

  sendPrivateMsg(receiverId, content) {
    this.send({ type: 'private_msg', receiverId, content });
  },

  sendGroupMsg(groupId, content) {
    this.send({ type: 'group_msg', groupId, content });
  },

  sendFileMsg(data) {
    this.send({ type: 'file_msg', ...data });
  },

  recall(messageId) {
    this.send({ type: 'recall', messageId });
  },
};
