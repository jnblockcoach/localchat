window.API = {
  async getUser(id) {
    const res = await fetch(`/api/users/me?id=${id}`);
    return res.json();
  },

  async register(username) {
    const res = await fetch('/api/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    return res.json();
  },

  async login(id) {
    const res = await fetch('/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return res.json();
  },

  async updateUsername(id, username) {
    const res = await fetch('/api/users/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username }),
    });
    return res.json();
  },

  async searchUsers(query) {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
    return res.json();
  },

  async getFriends(userId) {
    const res = await fetch(`/api/friends?userId=${userId}`);
    return res.json();
  },

  async getPendingRequests(userId) {
    const res = await fetch(`/api/friends/pending?userId=${userId}`);
    return res.json();
  },

  async addFriend(userId, friendId) {
    const res = await fetch('/api/friends/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, friendId }),
    });
    return res.json();
  },

  async acceptFriend(userId, friendId) {
    const res = await fetch('/api/friends/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, friendId }),
    });
    return res.json();
  },

  async getGroups(userId) {
    const res = await fetch(`/api/groups?userId=${userId}`);
    return res.json();
  },

  async createGroup(name, creatorId, memberIds) {
    const res = await fetch('/api/groups/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, creatorId, memberIds }),
    });
    return res.json();
  },

  async getGroupMembers(groupId) {
    const res = await fetch(`/api/groups/${groupId}/members`);
    return res.json();
  },

  async getGroupInfo(groupId) {
    const res = await fetch(`/api/groups/${groupId}`);
    return res.json();
  },

  async addGroupMember(groupId, userId) {
    const res = await fetch('/api/groups/add-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, userId }),
    });
    return res.json();
  },

  async removeGroupMember(groupId, userId) {
    const res = await fetch('/api/groups/remove-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, userId }),
    });
    return res.json();
  },

  async recallMessage(messageId, userId) {
    const res = await fetch('/api/messages/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, userId }),
    });
    return res.json();
  },

  async blockUser(userId, blockedUserId) {
    const res = await fetch('/api/block/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, blockedUserId }),
    });
    return res.json();
  },

  async unblockUser(userId, blockedUserId) {
    const res = await fetch('/api/block/unblock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, blockedUserId }),
    });
    return res.json();
  },

  async uploadFile(file, uploaderId) {
    const form = new FormData();
    form.append('file', file);
    form.append('uploaderId', uploaderId);
    const res = await fetch('/api/files/upload', { method: 'POST', body: form });
    return res.json();
  },

  async getFileInfo(fileId) {
    const res = await fetch(`/api/files/${fileId}/info`);
    return res.json();
  },

  async getBlockedUsers(userId) {
    const res = await fetch(`/api/block?userId=${userId}`);
    return res.json();
  },

  async getPrivateHistory(userId1, userId2, limit = 100) {
    const res = await fetch(`/api/messages/private/${userId1}/${userId2}?limit=${limit}`);
    return res.json();
  },

  async getGroupHistory(groupId, limit = 100) {
    const res = await fetch(`/api/messages/group/${groupId}?limit=${limit}`);
    return res.json();
  },

  async deleteGroup(groupId, userId) {
    const res = await fetch(`/api/groups/${groupId}?userId=${userId}`, {
      method: 'DELETE',
    });
    return res.json();
  },

  async setAnnouncement(groupId, userId, announcement) {
    const res = await fetch('/api/groups/announcement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, userId, announcement }),
    });
    return res.json();
  },

  async transferAdmin(groupId, fromUserId, toUserId) {
    const res = await fetch('/api/groups/transfer-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, fromUserId, toUserId }),
    });
    return res.json();
  },

  async toggleMute(userId, groupId) {
    const res = await fetch('/api/groups/toggle-mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, groupId }),
    });
    return res.json();
  },

  async getMuteStatus(userId, groupId) {
    const res = await fetch(`/api/groups/${groupId}/muted?userId=${userId}`);
    return res.json();
  },

  async getOnlineUsers() {
    const res = await fetch('/api/users/online');
    return res.json();
  },

  async getUsersByIp() {
    const res = await fetch('/api/users/by-ip');
    return res.json();
  },

};
