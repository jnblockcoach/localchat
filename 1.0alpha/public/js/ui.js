window.UI = {
  currentChat: null,
  currentChatType: null,
  currentTab: 'friends',
  onlineUsers: new Set(),
  blockedUsers: new Set(),

  show(elementId) {
    document.getElementById(elementId).classList.remove('hidden');
  },

  hide(elementId) {
    document.getElementById(elementId).classList.add('hidden');
  },

  getEl(id) {
    return document.getElementById(id);
  },

  renderSidebarList(items, type) {
    const list = this.getEl('sidebar-list');
    if (!items || items.length === 0) {
      list.innerHTML = `<div class="no-results">暂无${type === 'friend' ? '好友' : '群聊'}</div>`;
      return;
    }

    list.innerHTML = items
      .map((item) => {
        const id = type === 'friend' ? item.id : item.id;
        const name = type === 'friend' ? item.username : item.name;
        const sub = type === 'friend' ? item.ip : `${item.member_count} 人`;
        const avatar = name.charAt(0).toUpperCase();
        const colors = [
          '#e94560',
          '#0f3460',
          '#4ade80',
          '#f59e0b',
          '#8b5cf6',
          '#06b6d4',
          '#f472b6',
          '#34d399',
        ];
        const colorIdx = id % colors.length;
        const isActive = this.currentChatType === type && Number(this.currentChat) === Number(id);
        const isOnline = type === 'friend' && this.onlineUsers.has(Number(id));
        const roleBadge = type === 'group' && item.my_role === 'admin' ? '<span class="admin-badge">管理员</span>' : '';
        const muteBadge = type === 'group' && item.is_muted ? '<span class="mute-badge">免打扰</span>' : '';

        return `
        <div class="sidebar-item ${isActive ? 'active' : ''}"
             data-type="${type}" data-id="${id}"
             onclick="UI.selectChat('${type}', ${id})">
          <div class="sidebar-item-avatar" style="background:${colors[colorIdx]}">${avatar}</div>
          <div class="sidebar-item-info">
            <div class="sidebar-item-name">${this.escapeHtml(name)} ${roleBadge} ${muteBadge}</div>
            <div class="sidebar-item-sub">${this.escapeHtml(sub)}</div>
          </div>
          <div class="sidebar-item-status ${isOnline ? 'online' : 'offline'}"></div>
        </div>
      `;
      })
      .join('');
  },

  selectChat(type, id) {
    this.currentChatType = type;
    this.currentChat = id;

    document.querySelectorAll('.sidebar-item').forEach((el) => el.classList.remove('active'));
    const activeEl = document.querySelector(`.sidebar-item[data-type="${type}"][data-id="${id}"]`);
    if (activeEl) activeEl.classList.add('active');

    APP.clearMentionCache();
    APP.hideMention();

    this.loadChatView(type, id);
  },

  async loadChatView(type, id) {
    const titleEl = this.getEl('chat-title');
    const membersEl = this.getEl('chat-members');
    const msgContainer = this.getEl('messages');
    const inputArea = this.getEl('chat-input-area');
    const typingEl = this.getEl('typing-indicator');

    msgContainer.innerHTML = '<div class="no-chat-selected"><p>加载中...</p></div>';
    inputArea.classList.remove('hidden');
    typingEl.textContent = '';

    if (type === 'friend') {
      const friend = document.querySelector(`.sidebar-item[data-type="friend"][data-id="${id}"]`);
      const name = friend ? friend.querySelector('.sidebar-item-name').textContent : '好友';
      const isOnline = this.onlineUsers.has(Number(id));
      const isBlocked = this.blockedUsers.has(Number(id));
      titleEl.textContent = name;
      membersEl.innerHTML = `${isOnline ? '🟢 在线' : '🔴 离线'}
        <button class="block-btn ${isBlocked ? 'blocked' : ''}"
          onclick="APP.toggleBlock(${id})">${isBlocked ? '已拉黑' : '拉黑'}</button>`;
    } else {
      try {
        const data = await API.getGroupInfo(id);
        titleEl.textContent = data.group.name;
        const names = data.members.map((m) => m.username).join(', ');
        const isCreator = Number(data.group.creator_id) === Number(currentUser.id);
        const myRole = data.members.find((m) => Number(m.id) === Number(currentUser.id))?.role;

        const muteStatus = await API.getMuteStatus(currentUser.id, id);
        const isMuted = muteStatus.muted;

        let adminBtns = '';
        if (isCreator || myRole === 'admin') {
          adminBtns += `
            <button class="member-btn" onclick="APP.showAddGroupMember(${id})">添加</button>
            <button class="member-btn remove" onclick="APP.showRemoveGroupMember(${id})">移除</button>
            <button class="member-btn" onclick="APP.showAnnouncement(${id})">公告</button>
            <button class="mute-btn ${isMuted ? 'muted' : ''}" data-group-id="${id}" onclick="APP.toggleMute(${id})">${isMuted ? '取消免打扰' : '免打扰'}</button>`;
        } else {
          adminBtns += `
            <button class="member-btn" onclick="APP.showAnnouncement(${id})">公告</button>
            <button class="mute-btn ${isMuted ? 'muted' : ''}" data-group-id="${id}" onclick="APP.toggleMute(${id})">${isMuted ? '取消免打扰' : '免打扰'}</button>`;
        }

        if (isCreator) {
          adminBtns += `
            <button class="member-btn" onclick="APP.showTransferAdmin(${id})">转让</button>
            <button class="member-btn remove" onclick="APP.deleteGroup(${id})">删除群聊</button>`;
        }

        membersEl.innerHTML = `成员 (${data.members.length}人): ${names} ${adminBtns}`;
      } catch {
        titleEl.textContent = '群聊';
        membersEl.textContent = '';
      }
    }

    const cached = CACHE.getMessages(type, id);
    if (cached.length > 0) {
      this.renderMessages(cached);
    }

    try {
      let messages;
      if (type === 'friend') {
        messages = await API.getPrivateHistory(currentUser.id, id);
      } else {
        messages = await API.getGroupHistory(id);
      }
      CACHE.setMessages(type, id, messages);
      this.renderMessages(messages);
    } catch {
      if (cached.length === 0) {
        msgContainer.innerHTML = '<div class="no-chat-selected"><p>暂无消息</p></div>';
      }
    }

    setTimeout(() => {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }, 50);
  },

  renderMessages(messages) {
    const container = this.getEl('messages');
    if (!messages || messages.length === 0) {
      container.innerHTML = '<div class="no-chat-selected"><p>暂无消息</p></div>';
      return;
    }

    container.innerHTML = messages.map((msg) => this.renderMessage(msg)).join('');
    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 10);
  },

  renderFileMessage(msg, _side, _time) {
    const file = msg.file;
    if (!file) return '';

    const ext = file.original_name.split('.').pop().toLowerCase();
    const fileSize = file.size > 1024 * 1024
      ? (file.size / 1024 / 1024).toFixed(1) + ' MB'
      : (file.size / 1024).toFixed(1) + ' KB';

    const previewUrl = `/api/files/${file.id}/preview`;
    const downloadUrl = `/api/files/${file.id}/download`;

    let body = '';

    if (['jpg', 'jpeg', 'png', 'bmp'].includes(ext)) {
      body = `<img src="${previewUrl}" class="file-preview-image" onclick="window.open('${downloadUrl}')" />`;
    } else if (ext === 'mp4') {
      body = `<video src="${previewUrl}" class="file-preview-video" controls preload="metadata"></video>`;
    } else if (['mp3', 'wav'].includes(ext)) {
      body = `<audio src="${previewUrl}" class="file-preview-audio" controls preload="metadata"></audio>`;
    } else if (['md', 'txt'].includes(ext)) {
      const textContent = this._cachedText[file.id];
      if (textContent) {
        body = `<div class="file-preview-text">${this.renderMarkdown(textContent)}</div>`;
      } else {
        body = '<div class="file-preview-text-loading">加载中...</div>';
        this._loadTextPreview(file.id, previewUrl);
      }
    }

    return `
      <div class="message-bubble file-message">
        <div class="file-header">
          <span class="file-icon">${this._fileIcon(ext)}</span>
          <div class="file-info">
            <div class="file-name">${this.escapeHtml(file.original_name)}</div>
            <div class="file-size">${fileSize}</div>
          </div>
          <a href="${downloadUrl}" class="file-download-btn" download="${file.original_name}" title="下载">⬇</a>
        </div>
        ${body ? `<div class="file-body">${body}</div>` : ''}
      </div>
    `;
  },

  _fileIcon(ext) {
    const icons = {
      md: '📝', txt: '📄', jpg: '🖼', jpeg: '🖼', png: '🖼', bmp: '🖼',
      mp3: '🎵', wav: '🎵', mp4: '🎬',
    };
    return icons[ext] || '📎';
  },

  _cachedText: {},
  _loadingText: new Set(),

  async _loadTextPreview(fileId, url) {
    if (this._loadingText.has(fileId)) return;
    this._loadingText.add(fileId);
    try {
      const res = await fetch(url);
      const text = await res.text();
      this._cachedText[fileId] = text;
      const el = document.querySelector('.message-bubble .file-preview-text-loading');
      if (el) {
        el.outerHTML = `<div class="file-preview-text">${this.renderMarkdown(text)}</div>`;
      }
    } catch {
      const el = document.querySelector('.message-bubble .file-preview-text-loading');
      if (el) el.textContent = '加载失败';
    }
  },

  renderMarkdown(text) {
    let html = this.escapeHtml(text);

    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/\$\$(.+?)\$\$/g, '<div class="latex-block">$$$1$$</div>');
    html = html.replace(/\$(.+?)\$/g, '<span class="latex-inline">$$$1$$</span>');
    html = html.replace(/\n/g, '<br>');

    return html;
  },

  renderMessage(msg) {
    const isOutgoing = Number(msg.sender_id) === Number(currentUser.id);
    const isRecalled = msg.status === 'recalled';
    const time = msg.created_at ? this.formatTime(msg.created_at) : '';
    const side = isOutgoing ? 'outgoing' : 'incoming';

    if (isRecalled) {
      return `
        <div class="message ${side} recalled" data-id="${msg.id}">
          <div class="message-sender">${isOutgoing ? '' : this.escapeHtml(msg.sender_name || '')}</div>
          <div class="message-bubble recalled-text">[消息已撤回]</div>
          <div class="message-time">${time}</div>
        </div>
      `;
    }

    const canRecall = isOutgoing && this.canRecall(msg.created_at);
    const recallBtn = canRecall
      ? `<span class="message-status" style="cursor:pointer;color:#e94560" onclick="APP.recallMessage(${msg.id})">撤回</span>`
      : '';

    if (msg.file_id) {
      const fileContent = this.renderFileMessage(msg, side, time);
      return `
        <div class="message ${side}" data-id="${msg.id}">
          <div class="message-sender">${isOutgoing ? '' : this.escapeHtml(msg.sender_name || '')}</div>
          ${fileContent}
          <div style="display:flex;gap:8px;align-items:center">
            <span class="message-time">${time}</span>
            ${recallBtn}
          </div>
        </div>
      `;
    }

    const highlighted = this.escapeHtml(msg.content).replace(
      /@(\S+)/g,
      '<span class="mention-highlight">@$1</span>'
    );

    return `
      <div class="message ${side}" data-id="${msg.id}">
        <div class="message-sender">${isOutgoing ? '' : this.escapeHtml(msg.sender_name || '')}</div>
        <div class="message-bubble">${highlighted}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="message-time">${time}</span>
          ${recallBtn}
        </div>
      </div>
    `;
  },

  appendMessage(msg) {
    const container = this.getEl('messages');
    const noChat = container.querySelector('.no-chat-selected');
    if (noChat) container.innerHTML = '';

    container.insertAdjacentHTML('beforeend', this.renderMessage(msg));
    container.scrollTop = container.scrollHeight;
  },

  updateMessageRecall(messageId) {
    const msgEl = document.querySelector(`.message[data-id="${messageId}"]`);
    if (!msgEl) return;

    const bubble = msgEl.querySelector('.message-bubble');
    const statusEl = msgEl.querySelector('.message-status');
    bubble.textContent = '[消息已撤回]';
    bubble.className = 'message-bubble recalled-text';
    if (statusEl) statusEl.remove();
    msgEl.classList.add('recalled');
  },

  canRecall(createdAt) {
    const msgTime = new Date(createdAt + 'Z').getTime();
    const now = Date.now();
    return now - msgTime <= 120000;
  },

  formatTime(dateStr) {
    try {
      const d = new Date(dateStr + 'Z');
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      if (isToday) return `${h}:${m}`;
      return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`;
    } catch {
      return dateStr;
    }
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  showSearchResults(results) {
    const body = this.getEl('search-results-body');
    if (results.length === 0) {
      body.innerHTML = '<div class="no-results">未找到匹配的用户</div>';
    } else {
      body.innerHTML = results
        .map(
          (u) => `
        <div class="search-result-item">
          <div class="search-result-info">
            <div class="search-result-name">${this.escapeHtml(u.username)}</div>
            <div class="search-result-ip">IP: ${this.escapeHtml(u.ip)}</div>
          </div>
          <button class="search-result-action" onclick="APP.addFriend(${u.id})" ${Number(u.id) === Number(currentUser.id) ? 'disabled' : ''}>
            ${Number(u.id) === Number(currentUser.id) ? '自己' : '添加好友'}
          </button>
        </div>
      `
        )
        .join('');
    }
    this.show('search-results-modal');
  },

  showFriendRequests(requests) {
    const body = this.getEl('friend-requests-body');
    if (!requests || requests.length === 0) {
      body.innerHTML = '<div class="no-results">暂无好友请求</div>';
    } else {
      body.innerHTML = requests
        .map(
          (r) => `
        <div class="friend-request-item" data-request-id="${r.request_id}">
          <div class="friend-request-info">
            <div class="search-result-name">${this.escapeHtml(r.username)}</div>
            <div class="search-result-ip">IP: ${this.escapeHtml(r.ip)}</div>
          </div>
          <button class="friend-request-action accept" onclick="APP.acceptFriend(${r.id})">接受</button>
        </div>
      `
        )
        .join('');
    }
    this.show('friend-requests-modal');
  },

  showCreateGroupModal(friends) {
    const list = this.getEl('group-member-list');
    if (!friends || friends.length === 0) {
      list.innerHTML = '<div class="no-results">暂无好友可选，请先添加好友</div>';
      return;
    }

    list.innerHTML = friends
      .map(
        (f) => `
      <div class="member-checkbox-item">
        <input type="checkbox" id="gm-${f.id}" value="${f.id}">
        <label for="gm-${f.id}">${this.escapeHtml(f.username)} (${this.escapeHtml(f.ip)})</label>
      </div>
    `
      )
      .join('');

    this.show('create-group-modal');
  },

  updateOnlineStatus(userId, isOnline) {
    if (isOnline) {
      this.onlineUsers.add(Number(userId));
    } else {
      this.onlineUsers.delete(Number(userId));
    }

    const el = document.querySelector(`.sidebar-item[data-type="friend"][data-id="${userId}"]`);
    if (el) {
      const statusDot = el.querySelector('.sidebar-item-status');
      if (statusDot) {
        statusDot.className = `sidebar-item-status ${isOnline ? 'online' : 'offline'}`;
      }
      if (this.currentChatType === 'friend' && Number(this.currentChat) === Number(userId)) {
        const membersEl = this.getEl('chat-members');
        membersEl.textContent = isOnline ? '🟢 在线' : '🔴 离线';
      }
    }
  },

  updateBlockButton(friendId, isBlocked) {
    if (this.currentChatType === 'friend' && Number(this.currentChat) === Number(friendId)) {
      const membersEl = this.getEl('chat-members');
      const isOnline = this.onlineUsers.has(Number(friendId));
      membersEl.innerHTML = `${isOnline ? '🟢 在线' : '🔴 离线'}
        <button class="block-btn ${isBlocked ? 'blocked' : ''}"
          onclick="APP.toggleBlock(${friendId})">${isBlocked ? '已拉黑' : '拉黑'}</button>`;
    }
  },

  showFriendRequestBadge(count) {
    const badge = this.getEl('friend-requests-badge');
    if (count > 0) {
      badge.classList.remove('hidden');
      badge.innerHTML = `📩 ${count} 个好友请求待处理 <span style="font-size:11px">(点击查看)</span>`;
    } else {
      badge.classList.add('hidden');
    }
  },
};
