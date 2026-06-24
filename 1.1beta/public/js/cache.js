window.CACHE = {
  MAX_PER_CONVERSATION: 100,
  CACHE_VERSION: 2,
  VERSION_KEY: 'chat_cache_version',
  USER_KEY: 'chat_current_user',

  getKey(type, id) {
    return `chat_cache_${type}_${id}`;
  },

  getMessages(type, id) {
    try {
      const key = this.getKey(type, id);
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  setMessages(type, id, messages) {
    const key = this.getKey(type, id);
    const trimmed = messages.slice(-this.MAX_PER_CONVERSATION);
    try {
      localStorage.setItem(key, JSON.stringify(trimmed));
    } catch {}
  },

  addMessage(type, id, message) {
    const messages = this.getMessages(type, id);
    const exists = messages.some((m) => Number(m.id) === Number(message.id));
    if (!exists) {
      messages.push(message);
      this.setMessages(type, id, messages);
    }
  },

  updateMessage(type, id, messageId, updates) {
    const messages = this.getMessages(type, id);
    const idx = messages.findIndex((m) => Number(m.id) === Number(messageId));
    if (idx !== -1) {
      messages[idx] = { ...messages[idx], ...updates };
      this.setMessages(type, id, messages);
    }
  },

  clear(type, id) {
    localStorage.removeItem(this.getKey(type, id));
  },

  saveUser(user) {
    try {
      localStorage.setItem(this.USER_KEY, JSON.stringify(user));
    } catch {}
  },

  loadUser() {
    try {
      const raw = localStorage.getItem(this.USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  clearUser() {
    localStorage.removeItem(this.USER_KEY);
  },

  checkVersion() {
    const v = parseInt(localStorage.getItem(this.VERSION_KEY));
    if (v !== this.CACHE_VERSION) {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('chat_cache_')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(this.VERSION_KEY, String(this.CACHE_VERSION));
    }
  },
};
