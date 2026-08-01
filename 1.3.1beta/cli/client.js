const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

class Client {
  constructor(host, port) {
    this.baseUrl = `http://${host}:${port}`;
    this.wsUrl = `ws://${host}:${port}`;
    this.ws = null;
    this.user = null;
    this.handlers = {};
  }

  api(path, options = {}) {
    const maxRetries = 2;
    let lastErr;
    const doFetch = (attempt) => {
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
        .catch((err) => {
          lastErr = err;
          if (attempt < maxRetries) {
            return new Promise((resolve) => setTimeout(resolve, 1000 * attempt)).then(() => doFetch(attempt + 1));
          }
          return { error: lastErr.message };
        });
    };
    return doFetch(0);
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

  updateUsername(id, username) {
    return this.api('/api/users/update', {
      method: 'PUT',
      body: JSON.stringify({ id, username }),
    });
  }

  uploadFile(filePath, uploaderId) {
    const stat = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buffer]), path.basename(filePath));
    form.append('uploaderId', String(uploaderId));
    return fetch(`${this.baseUrl}/api/files/upload`, { method: 'POST', body: form })
      .then((r) => r.json())
      .catch((err) => ({ error: err.message }));
  }

  sendFileMsg(data) {
    return this.wsSend({ type: 'file_msg', ...data });
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
        const handler = this.handlers[data.type];
        if (handler) handler(data);
        this.emit('ws_message', data);
      } catch {}
    });

    this.ws.on('close', () => {
      this.emit('ws_close');
      if (this._manualClose) return;
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
      return true;
    }
    this.emit('ws_send_failed', data);
    return false;
  }

  sendPrivateMsg(receiverId, content) {
    return this.wsSend({ type: 'private_msg', receiverId, content });
  }

  sendGroupMsg(groupId, content) {
    return this.wsSend({ type: 'group_msg', groupId, content });
  }

  recall(messageId) {
    return this.wsSend({ type: 'recall', messageId });
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
