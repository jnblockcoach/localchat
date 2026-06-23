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
    }).then((r) => r.json());
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

  searchUsers(query) {
    return this.api(`/api/users/search?q=${encodeURIComponent(query)}`);
  }

  getOnlineUsers() {
    return this.api('/api/users/online');
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

  deleteFriend(userId, friendId) {
    return this.api('/api/friends', {
      method: 'DELETE',
      body: JSON.stringify({ userId, friendId }),
    });
  }

  getGroups(userId) {
    return this.api(`/api/groups?userId=${userId}`);
  }

  getGroupInfo(groupId) {
    return this.api(`/api/groups/${groupId}`);
  }

  createGroup(name, creatorId, memberIds) {
    return this.api('/api/groups/create', {
      method: 'POST',
      body: JSON.stringify({ name, creatorId, memberIds }),
    });
  }

  addGroupMember(groupId, userId) {
    return this.api('/api/groups/add-member', {
      method: 'POST',
      body: JSON.stringify({ groupId, userId }),
    });
  }

  removeGroupMember(groupId, userId) {
    return this.api('/api/groups/remove-member', {
      method: 'POST',
      body: JSON.stringify({ groupId, userId }),
    });
  }

  getPrivateHistory(user1, user2, limit = 50) {
    return this.api(`/api/messages/private/${user1}/${user2}?limit=${limit}`);
  }

  getGroupHistory(groupId, limit = 50) {
    return this.api(`/api/messages/group/${groupId}?limit=${limit}`);
  }

  blockUser(userId, blockedUserId) {
    return this.api('/api/block/block', {
      method: 'POST',
      body: JSON.stringify({ userId, blockedUserId }),
    });
  }

  unblockUser(userId, blockedUserId) {
    return this.api('/api/block/unblock', {
      method: 'POST',
      body: JSON.stringify({ userId, blockedUserId }),
    });
  }

  getBlockedUsers(userId) {
    return this.api(`/api/block?userId=${userId}`);
  }

  deleteGroup(groupId, userId) {
    return this.api(`/api/groups/${groupId}?userId=${userId}`, {
      method: 'DELETE',
    });
  }

  setAnnouncement(groupId, userId, announcement) {
    return this.api('/api/groups/announcement', {
      method: 'POST',
      body: JSON.stringify({ groupId, userId, announcement }),
    });
  }

  transferAdmin(groupId, fromUserId, toUserId) {
    return this.api('/api/groups/transfer-admin', {
      method: 'POST',
      body: JSON.stringify({ groupId, fromUserId, toUserId }),
    });
  }

  toggleMute(userId, groupId) {
    return this.api('/api/groups/toggle-mute', {
      method: 'POST',
      body: JSON.stringify({ userId, groupId }),
    });
  }

  getMuteStatus(userId, groupId) {
    return this.api(`/api/groups/${groupId}/muted?userId=${userId}`);
  }

  wsConnect() {
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
        const handler = this.handlers[data.type];
        if (handler) handler(data);
        this.emit('ws_message', data);
      } catch {}
    });

    this.ws.on('close', () => {
      this.emit('ws_close');
      setTimeout(() => this.wsConnect(), 3000);
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
    }
  }

  sendPrivateMsg(receiverId, content) {
    this.wsSend({ type: 'private_msg', receiverId, content });
  }

  sendGroupMsg(groupId, content) {
    this.wsSend({ type: 'group_msg', groupId, content });
  }

  recall(messageId) {
    this.wsSend({ type: 'recall', messageId });
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  emit(type, data) {
    const handler = this.handlers[type];
    if (handler) handler(data);
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

module.exports = Client;
