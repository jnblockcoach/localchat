window.WS = {
  socket: null,
  handlers: {},

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${location.host}`);

    this.socket.onopen = () => {
      console.log('WebSocket 已连接');
      const handler = this.handlers['ws_connected'];
      if (handler) handler();
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
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
      setTimeout(() => this.connect(), 3000);
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
    this.send({ type: 'auth', userId });
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
