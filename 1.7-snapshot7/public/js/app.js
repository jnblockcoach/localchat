let mentionState = null;

window.APP = {
  async init() {
    this.setupEventListeners();
    this.setupWebSocketHandlers();
    WS.connect();

    CACHE.checkVersion();
    this.loadExistingAccounts();
  },

  async loadExistingAccounts() {
    try {
      const users = await API.getUsersByIp();
      const container = UI.getEl('existing-accounts');
      if (users.length > 0) {
        container.innerHTML = '<div class="existing-accounts-label">本机已有账号（点击登录）：</div>' + users
          .map((u) => {
            const idLabel = u.is_ai ? (u.display_id || ('openclaw-' + u.ip + '-?')) : (u.ip + '-' + (u.ip_index || '?'));
            return `<button class="existing-account-btn" data-user-id="${u.id}" data-username="${UI.escapeHtml(u.username)}"><strong>#${u.id}</strong> ${UI.escapeHtml(u.username)} <span style="color:#888;font-size:12px">(${UI.escapeHtml(idLabel)})</span></button>`;
          })
          .join('');
        container.querySelectorAll('.existing-account-btn').forEach((btn) => {
          btn.addEventListener('click', () => this.loginWithExisting(Number(btn.dataset.userId), btn.dataset.username));
        });
      }
    } catch {}
  },

  async loginWithExisting(id, _username) {
    UI.getEl('login-info').textContent = '';
    const result = await API.login(id);
    if (result && !result.error) {
      this.enterApp(result.user);
    } else {
      UI.getEl('login-info').textContent = result.error || '登录失败';
    }
  },

  setupEventListeners() {
    const $ = UI.getEl;

    $('login-btn').addEventListener('click', () => this.login());
    $('login-username').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.login();
    });
    $('login-id-btn').addEventListener('click', () => this.loginWithId());
    $('login-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.loginWithId();
    });
    $('login-search-btn').addEventListener('click', () => this.searchLogin());
    $('login-search-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.searchLogin();
    });

    $('my-username').addEventListener('click', () => {
      $('rename-input').value = currentUser.username;
      UI.show('rename-modal');
      setTimeout(() => $('rename-input').focus(), 100);
    });
    $('my-avatar').addEventListener('click', () => this.showProfile());
    $('confirm-rename').addEventListener('click', () => this.renameUser());
    $('rename-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.renameUser();
    });

    $('logout-btn').addEventListener('click', () => this.logout());

    $('file-btn').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => this.handleFileSelect(e));

    $('send-btn').addEventListener('click', () => this.sendMessage());
    $('message-input').addEventListener('keydown', (e) => {
      if (mentionState && e.key === 'Enter') {
        e.preventDefault();
        this.selectMention();
        return;
      }
      if (mentionState && e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveMention(1);
        return;
      }
      if (mentionState && e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveMention(-1);
        return;
      }
      if (mentionState && (e.key === 'Escape' || e.key === 'Backspace')) {
        this.hideMention();
        if (e.key === 'Escape') e.preventDefault();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    $('message-input').addEventListener('input', () => this.handleMentionInput());

    $('search-btn').addEventListener('click', () => this.searchUsers());
    $('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.searchUsers();
    });

    $('add-friend-btn').addEventListener('click', () => {
      $('add-friend-input').value = '';
      $('add-friend-id-input').value = '';
      $('add-friend-results').innerHTML = '';
      UI.show('add-friend-modal');
    });
    $('add-friend-id-btn').addEventListener('click', () => this.addFriendById());
    $('add-friend-id-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addFriendById();
    });

    $('add-friend-search-btn').addEventListener('click', async () => {
      const q = $('add-friend-input').value.trim();
      if (!q) return;
      const results = await API.searchUsers(q);
      const filtered = results.filter((u) => Number(u.id) !== Number(currentUser.id));

      const byIp = {};
      for (const u of filtered) {
        if (!byIp[u.ip]) byIp[u.ip] = [];
        byIp[u.ip].push(u);
      }

      const ipKeys = Object.keys(byIp);
      if (ipKeys.length === 0) {
        $('add-friend-results').innerHTML = '<div class="no-results">未找到匹配用户</div>';
        return;
      }

      let html = '';
      for (const ip of ipKeys) {
        const accounts = byIp[ip];
        if (accounts.length === 1) {
          const u = accounts[0];
          html += `
            <div class="search-result-item">
              <div class="search-result-info">
                <div class="search-result-name">${UI.escapeHtml(u.username)}</div>
                <div class="search-result-ip">IP: ${UI.escapeHtml(u.ip)}</div>
              </div>
              <button class="search-result-action" onclick="APP.addFriend(${u.id})">添加好友</button>
            </div>`;
        } else {
          html += `<div class="search-result-ip-group">
            <div class="search-result-ip-header">IP: ${UI.escapeHtml(ip)} (${accounts.length}个账号)</div>`;
          for (const u of accounts) {
            html += `
              <div class="search-result-item search-result-sub-item">
                <div class="search-result-info">
                  <div class="search-result-name">${UI.escapeHtml(u.username)}</div>
                </div>
                <button class="search-result-action" onclick="APP.addFriend(${u.id})">添加好友</button>
              </div>`;
          }
          html += '</div>';
        }
      }
      $('add-friend-results').innerHTML = html;
    });

    $('online-hosts-btn').addEventListener('click', () => this.showOnlineHosts());

    // 注册 AI 助理：检测本机 OpenClaw → 输入名称 → 注册并自动加为好友
    $('ai-setup-btn').addEventListener('click', () => this.aiSetup());

    $('create-group-btn').addEventListener('click', async () => {
      try {
        const friends = await API.getFriends(currentUser.id);
        UI.showCreateGroupModal(friends);
      } catch {
        alert('获取好友列表失败');
      }
    });

    $('confirm-create-group').addEventListener('click', () => this.createGroup());

    $('clear-cache-btn').addEventListener('click', () => this.clearLocalCache());

    $('friend-requests-badge').addEventListener('click', async () => {
      const requests = await API.getPendingRequests(currentUser.id);
      UI.showFriendRequests(requests);
    });

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => {
        UI.hide(btn.dataset.close);
      });
    });

    document.querySelectorAll('.modal-overlay').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target === el) el.classList.add('hidden');
      });
    });
  },

  setupWebSocketHandlers() {
    WS.on('authenticated', (data) => {
      console.log('WS认证成功, userId:', data.userId);
    });

    WS.on('new_private_msg', (data) => {
      if (!currentUser) return;
      const msg = data.message;
      CACHE.addMessage(
        currentUser.id,
        'friend',
        Number(msg.sender_id) === Number(currentUser.id) ? msg.receiver_id : msg.sender_id,
        msg
      );
      CACHE.addMessage(
        currentUser.id,
        'friend',
        Number(msg.sender_id) === Number(currentUser.id) ? msg.sender_id : msg.receiver_id,
        msg
      );

      const convId =
        Number(msg.sender_id) === Number(currentUser.id)
          ? Number(msg.receiver_id)
          : Number(msg.sender_id);

      if (UI.currentChatType === 'friend' && Number(UI.currentChat) === convId) {
        UI.appendMessage(msg);
      }
    });

    WS.on('new_group_msg', (_data) => {
      if (!currentUser) return;
      const msg = _data.message;
      CACHE.addMessage(currentUser.id, 'group', msg.group_id, msg);

      if (UI.currentChatType === 'group' && Number(UI.currentChat) === Number(msg.group_id)) {
        UI.appendMessage(msg);
      }
    });

    WS.on('msg_recalled', (data) => {
      if (!currentUser) return;
      const msg = data.message;
      const type = msg.type === 'group' ? 'group' : 'friend';
      const id = type === 'group'
        ? msg.group_id
        : Number(msg.sender_id) === Number(currentUser.id)
          ? msg.receiver_id
          : msg.sender_id;

      CACHE.updateMessage(currentUser.id, type, id, msg.id, { status: 'recalled' });

      if (UI.currentChatType === type && Number(UI.currentChat) === Number(id)) {
        UI.updateMessageRecall(msg.id);
      }
    });

    WS.on('new_file_msg', (_data) => {
      if (!currentUser) return;
      const msg = _data.message;
      const type = msg.type === 'group' ? 'group' : 'friend';
      const id = type === 'group' ? msg.group_id : (
        Number(msg.sender_id) === Number(currentUser.id) ? msg.receiver_id : msg.sender_id
      );
      CACHE.addMessage(currentUser.id, type, id, msg);

      if (UI.currentChatType === type && Number(UI.currentChat) === Number(id)) {
        UI.appendMessage(msg);
      }
    });

    WS.on('friend_online', (data) => {
      UI.updateOnlineStatus(data.userId, true);
    });

    WS.on('friend_offline', (data) => {
      UI.updateOnlineStatus(data.userId, false);
    });

    WS.on('online_users', (data) => {
      data.userIds.forEach((uid) => UI.updateOnlineStatus(uid, true));
    });

    WS.on('friend_request', () => {
      this.refreshFriendRequestsBadge();
    });

    // OpenClaw 机器互联请求（与好友请求同等级）
    WS.on('openclaw_request', (data) => {
      const ip = (data && data.fromIp) || '';
      const errEl = document.createElement('div');
      errEl.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);padding:8px 20px;background:#f59e0b;color:#fff;border-radius:6px;font-size:13px;z-index:9999';
      errEl.textContent = `📡 ${ip} 请求互联 OpenClaw，请到「好友请求」中处理`;
      document.body.appendChild(errEl);
      setTimeout(() => errEl.remove(), 6000);
    });

    WS.on('request_handled', () => {
      this.refreshFriendRequestsBadge();
    });

    WS.on('new_friend', async () => {
      if (UI.currentTab === 'friends') {
        await this.refreshFriendList();
      }
    });

    // 好友关系被对方解除：提示并刷新
    WS.on('friend_removed', (data) => {
      if (!currentUser) return;
      const by = (data && data.by) || {};
      const errEl = document.createElement('div');
      errEl.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);padding:10px 24px;background:#e94560;color:#fff;border-radius:6px;font-size:14px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
      errEl.textContent = `⚠ ${by.username || ('#' + by.id) || '对方'} 已解除好友关系`;
      document.body.appendChild(errEl);
      setTimeout(() => errEl.remove(), 4000);
      if (UI.currentChatType === 'friend' && Number(UI.currentChat) === Number(by.id)) {
        UI.currentChat = null;
        UI.currentChatType = null;
        UI.getEl('messages').innerHTML = '<div class="no-chat-selected"><p>选择一个好友或群聊开始聊天</p></div>';
        UI.getEl('chat-title').textContent = '选择一个好友或群聊开始聊天';
        UI.getEl('chat-members').textContent = '';
        UI.getEl('chat-input-area').classList.add('hidden');
      }
      if (UI.currentTab === 'friends') {
        this.refreshFriendList();
      }
    });

    WS.on('mention', (data) => {
      const membersEl = UI.getEl('chat-members');
      if (UI.currentChatType === 'group' && Number(UI.currentChat) === Number(data.groupId)) {
        const notice = document.createElement('div');
        notice.className = 'mention-notice';
        notice.textContent = `${data.from.username} @了你`;
        notice.onclick = () => {
          UI.getEl('message-input').focus();
          notice.remove();
        };
        membersEl.parentNode.insertBefore(notice, membersEl.nextSibling);
        setTimeout(() => notice.remove(), 6000);
      }
    });

    WS.on('error', (data) => {
      const msg = (data && data.message) || '操作失败，请重试';
      console.error('WS错误:', msg);
      // 用可见的 toast 提示，而不是只写控制台
      const errEl = document.createElement('div');
      errEl.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);padding:8px 20px;background:#e94560;color:#fff;border-radius:6px;font-size:13px;z-index:999;max-width:80%';
      errEl.textContent = '⚠ ' + msg;
      document.body.appendChild(errEl);
      setTimeout(() => errEl.remove(), 3000);
    });

    WS.on('ws_connected', () => {
      const el = document.getElementById('connection-status');
      if (el) { el.textContent = '已连接'; el.style.color = '#4ade80'; }
      // 断线重连成功后重新加载当前对话，补偿错过的消息
      if (UI.currentChatType && UI.currentChat) {
        UI.loadChatView(UI.currentChatType, UI.currentChat);
      }
    });

    // 被其他设备顶替登录：连接已关闭且不再重连
    WS.on('kicked', () => {
      const errEl = document.createElement('div');
      errEl.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);padding:10px 24px;background:#e94560;color:#fff;border-radius:6px;font-size:14px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
      errEl.textContent = '⚠ 该账号已在其他设备登录，本页面已断开连接，请刷新页面重新登录';
      document.body.appendChild(errEl);
    });

    WS.on('ws_disconnected', () => {
      let el = document.getElementById('connection-status');
      if (!el) {
        el = document.createElement('div');
        el.id = 'connection-status';
        el.style.cssText = 'position:fixed;top:0;right:0;padding:4px 12px;font-size:12px;z-index:999;background:#e94560;color:#fff;border-radius:0 0 0 4px';
        document.body.appendChild(el);
      }
      el.textContent = '连接断开，正在重连...';
      el.style.color = '#fff';
      el.style.background = '#e94560';
    });

    WS.on('send_error', () => {
      const errEl = document.createElement('div');
      errEl.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);padding:8px 20px;background:#e94560;color:#fff;border-radius:6px;font-size:13px;z-index:999';
      errEl.textContent = '消息发送失败，请检查连接';
      document.body.appendChild(errEl);
      setTimeout(() => errEl.remove(), 3000);
    });
  },

  async enterApp(user) {
    // 取消注册后挂起的自动进入定时器，避免覆盖手动登录的账号
    clearTimeout(this._enterAppTimer);
    currentUser = user;
    CACHE.saveUser(user);

    UI.getEl('my-username').textContent = user.username;
    UI.getEl('my-ip').textContent = `IP: ${user.ip}${user.ip_index ? '-' + user.ip_index : ''}`;
    UI.getEl('my-avatar').textContent = user.username.charAt(0).toUpperCase();

    UI.hide('login-page');
    UI.show('app');

    WS.connect();
    WS.auth(currentUser.id);

    await this.refreshBlockedUsers();
    await this.refreshFriendList();
    await this.refreshGroupList();
    await this.refreshFriendRequestsBadge();
  },

  async login() {
    const input = UI.getEl('login-username');
    const username = input.value.trim();
    if (!username) {
      UI.getEl('login-info').textContent = '请输入昵称';
      return;
    }

    const result = await API.register(username);
    if (result.error) {
      UI.getEl('login-info').textContent = result.error;
      return;
    }

    const idEl = UI.getEl('new-user-id');
    idEl.style.display = 'block';
    // 显示 IP-序号 形式（如 192.168.43.4-2），即本机第 N 个账号
    const ipLabel = `${result.user.ip}-${result.user.ip_index || '?'}`;
    idEl.innerHTML = `注册成功！你的账号是 <strong>${ipLabel}</strong> (#${result.user.id})，请牢记此ID用于登录`;
    idEl.scrollIntoView({ behavior: 'smooth' });

    clearTimeout(this._enterAppTimer);
    this._enterAppTimer = setTimeout(() => this.enterApp(result.user), 3000);
  },

  async loginWithId() {
    UI.getEl('login-info').textContent = '';
    const input = UI.getEl('login-id');
    const id = input.value.trim();
    if (!id) {
      UI.getEl('login-info').textContent = '请输入ID';
      return;
    }

    const result = await API.login(parseInt(id));
    if (result.error) {
      UI.getEl('login-info').textContent = result.error;
      return;
    }

    UI.getEl('login-id').value = '';
    UI.getEl('login-info').textContent = '';
    this.enterApp(result.user);
  },

  async searchLogin() {
    const input = UI.getEl('login-search-name');
    const q = input.value.trim();
    if (!q) {
      UI.getEl('login-info').textContent = '请输入昵称';
      return;
    }
    let results = [];
    try {
      results = await API.searchUsers(q);
    } catch {
      UI.getEl('login-info').textContent = '搜索失败，请检查服务器连接';
      return;
    }
    const filtered = results.filter((u) => Number(u.id) !== Number(currentUser ? currentUser.id : -1));
    const container = UI.getEl('login-search-results');

    if (filtered.length === 0) {
      container.innerHTML = '<div class="no-results" style="padding:8px 0">未找到匹配的账号</div>';
      return;
    }

    container.innerHTML = filtered
      .map(
        (u) => `
      <div class="search-result-item" style="cursor:pointer" data-user-id="${u.id}" data-username="${UI.escapeHtml(u.username)}">
        <div class="search-result-info">
          <div class="search-result-name">${UI.escapeHtml(u.username)} <span style="color:#888;font-size:12px">#${u.id}</span></div>
          <div class="search-result-ip">IP: ${UI.escapeHtml(u.ip)}</div>
        </div>
        <button class="search-result-action">登录</button>
      </div>`
      )
      .join('');
    container.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', () => this.loginWithExisting(Number(el.dataset.userId), el.dataset.username));
    });
  },

  async renameUser() {
    const input = UI.getEl('rename-input');
    const username = input.value.trim();
    if (!username) {
      alert('昵称不能为空');
      return;
    }
    if (username === currentUser.username) {
      UI.hide('rename-modal');
      return;
    }

    const result = await API.updateUsername(currentUser.id, username);
    if (result.error) {
      alert(result.error);
      return;
    }

    currentUser = result;
    CACHE.saveUser(currentUser);
    UI.getEl('my-username').textContent = currentUser.username;
    UI.getEl('my-avatar').textContent = currentUser.username.charAt(0).toUpperCase();

    if (UI.currentTab === 'friends') {
      await this.refreshFriendList();
    }

    UI.hide('rename-modal');
  },

  logout() {
    if (!confirm('确认退出登录？')) return;
    clearTimeout(this._enterAppTimer);
    WS.disconnect();
    CACHE.clearUser();
    currentUser = null;
    // 重置界面状态，防止下一个账号看到上一个账号的残留（对话/在线/黑名单/预览缓存）
    UI.currentChat = null;
    UI.currentChatType = null;
    UI.currentTab = 'friends';
    UI.onlineUsers = new Set();
    UI.blockedUsers = new Set();
    UI._chatLoadToken++;
    UI._cachedText = {};
    UI._loadingText = new Set();
    UI._mentionMembers = null;
    mentionState = null;
    UI.hide('app');
    UI.show('login-page');
    // 清空全部输入类状态，防止账号间残留（历史单账号架构遗留）
    UI.getEl('message-input').value = '';
    UI.getEl('file-input').value = '';
    UI.getEl('search-input').value = '';
    UI.getEl('add-friend-input').value = '';
    UI.getEl('add-friend-id-input').value = '';
    UI.getEl('group-name-input').value = '';
    UI.getEl('rename-input').value = '';
    UI.getEl('announcement-input').value = '';
    UI.getEl('message-input').disabled = false;
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === 'friends');
    });
    UI.getEl('login-username').value = '';
    UI.getEl('login-id').value = '';
    UI.getEl('login-info').textContent = '';
    UI.getEl('new-user-id').style.display = 'none';
    UI.getEl('new-user-id').textContent = '';
    UI.getEl('login-search-results').innerHTML = '';
    UI.getEl('login-search-name').value = '';
    UI.getEl('messages').innerHTML = '';
    UI.getEl('sidebar-list').innerHTML = '';
    UI.getEl('chat-title').textContent = '选择一个好友或群聊开始聊天';
    UI.getEl('chat-members').textContent = '';
    this.loadExistingAccounts();
  },

  async refreshFriendList() {
    if (!currentUser) return;
    const friends = await API.getFriends(currentUser.id);
    if (UI.currentTab === 'friends') {
      UI.renderSidebarList(friends, 'friend');
    }
    return friends;
  },

  async refreshGroupList() {
    if (!currentUser) return;
    const groups = await API.getGroups(currentUser.id);
    if (UI.currentTab === 'groups') {
      UI.renderSidebarList(groups, 'group');
    }
    return groups;
  },

  async refreshFriendRequestsBadge() {
    if (!currentUser) return;
    try {
      const requests = await API.getPendingRequests(currentUser.id);
      UI.showFriendRequestBadge(requests.length);
    } catch {
      UI.showFriendRequestBadge(0);
    }
  },

  async switchTab(tab) {
    UI.currentTab = tab;

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    if (tab === 'friends') {
      await this.refreshFriendList();
    } else {
      await this.refreshGroupList();
    }
  },

  async searchUsers() {
    const input = UI.getEl('search-input');
    const q = input.value.trim();
    if (!q) return;
    try {
      const results = await API.searchUsers(q);
      UI.showSearchResults(results);
    } catch {
      alert('搜索失败，请检查网络');
    }
  },

  async addFriend(friendId) {
    const result = await API.addFriend(currentUser.id, friendId);
    if (result.error) {
      alert(result.error);
      return;
    }
    alert('好友请求已发送');
  },

  async addFriendById() {
    const input = UI.getEl('add-friend-id-input');
    const friendId = parseInt(input.value.trim());
    if (!friendId) {
      alert('请输入有效的ID');
      return;
    }
    if (friendId === currentUser.id) {
      alert('不能添加自己为好友');
      return;
    }
    await this.addFriend(friendId);
    input.value = '';
  },

  showProfile() {
    const user = currentUser;
    const colors = ['#e94560','#0f3460','#4ade80','#f59e0b','#8b5cf6','#06b6d4','#f472b6','#34d399'];
    const color = colors[user.id % colors.length];
    const isOnline = UI.onlineUsers.has(Number(user.id));

    UI.getEl('profile-content').innerHTML = `
      <div class="profile-avatar-large" style="background:${color}">${UI.escapeHtml(user.username.charAt(0).toUpperCase())}</div>
      <div class="profile-field"><span class="profile-field-label">ID</span><span class="profile-field-value">#${user.id}</span></div>
      <div class="profile-field"><span class="profile-field-label">昵称</span><span class="profile-field-value">${UI.escapeHtml(user.username)}</span></div>
      <div class="profile-field"><span class="profile-field-label">IP</span><span class="profile-field-value">${UI.escapeHtml(user.ip)}${user.ip_index ? '-' + user.ip_index : ''}</span></div>
      <div class="profile-field"><span class="profile-field-label">状态</span><span class="profile-field-value" style="color:${isOnline ? '#4ade80' : '#888'}">${isOnline ? '在线' : '离线'}</span></div>
      <div class="profile-field"><span class="profile-field-label">注册时间</span><span class="profile-field-value">${user.created_at || '--'}</span></div>
    `;
    UI.show('profile-modal');
  },

  // AI 助理管理：状态 / 注册 / 查看 Workspace
  async aiSetup() {
    let status = null;
    try {
      status = await API.getAiStatus(currentUser ? currentUser.id : null);
    } catch {
      alert('无法连接服务器');
      return;
    }
    this._aiStatus = status;

    const body = UI.getEl('ai-modal-body');
    if (status && status.error) {
      body.innerHTML = `<div style="color:#e94560;margin-bottom:10px">${UI.escapeHtml(status.error)}</div><button class="modal-btn" onclick="APP.aiSetup()">重试</button>`;
      UI.show('ai-modal');
      return;
    }
    const oc = (status && status.openclaw) || {};
    const acc = (status && status.account) || null;
    let html = `<div style="margin-bottom:10px">本机 OpenClaw：<strong style="color:${oc.running ? '#4ade80' : '#e94560'}">${oc.running ? '● 运行中' : '○ 未检测到'}</strong></div>`;
    if (acc) {
      const idLabel = acc.display_id || ('openclaw-' + acc.ip + '-?');
      html += `<div style="margin-bottom:14px">已注册 AI 助理：<strong>${UI.escapeHtml(acc.username)}</strong> <span style="color:#888">(${UI.escapeHtml(idLabel)})</span></div>`;
      html += `<button class="modal-btn" id="ai-workspace-btn">📂 查看 AI Workspace</button>`;
    } else if (oc.running) {
      html += `<div style="margin-bottom:14px;color:#888">尚未注册 AI 助理</div>`;
      html += `<button class="modal-btn" id="ai-register-btn">➕ 注册 AI 助理</button>`;
    } else {
      html += `<div style="color:#e94560">请先在本机启动 OpenClaw gateway，再注册 AI 助理</div>`;
    }
    body.innerHTML = html;

    const regBtn = document.getElementById('ai-register-btn');
    if (regBtn) {
      regBtn.addEventListener('click', async () => {
        const name = prompt('请输入 AI 助理名称：', 'AI助手');
        if (!name || !name.trim()) return;
        const result = await API.registerAi(name.trim(), currentUser ? currentUser.id : null);
        if (result.error) { alert(result.error); return; }
        alert(`AI 助理已注册：${result.user.username}（${result.user.display_id || ('openclaw-' + result.user.ip + '-?')}），已自动添加为好友`);
        await this.refreshFriendList();
        this.aiSetup();
      });
    }

    // 机器互联 OpenClaw 区域
    html += `<div style="border-top:1px solid rgba(255,255,255,0.1);margin-top:14px;padding-top:12px">
      <div style="margin-bottom:8px;font-weight:bold">机器互联 OpenClaw</div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <input id="ai-peer-ip" placeholder="目标机器 IP" style="flex:1;padding:6px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:#eee" />
        <button class="search-result-action" id="ai-peer-btn">发起互联</button>
      </div>
      <div id="ai-peer-list" style="font-size:12px;color:#888"></div>
    </div>`;
    body.innerHTML = html;

    const peerIp = document.getElementById('ai-peer-ip');
    const peerBtn = document.getElementById('ai-peer-btn');
    if (peerBtn && peerIp) {
      peerBtn.addEventListener('click', async () => {
        const ip = peerIp.value.trim();
        if (!ip) { alert('请输入目标机器 IP'); return; }
        const r = await API.interconnectOpenClaw(ip);
        if (r.error) { alert(r.error); return; }
        alert(r.message || '请求已发送');
        this.aiSetup();
      });
      this.renderAiPeers();
    }
    const wsBtn = document.getElementById('ai-workspace-btn');
    if (wsBtn) {
      wsBtn.addEventListener('click', () => this.showAiWorkspace());
    }

    UI.show('ai-modal');
  },

  // 查看 AI Workspace：文件列表 + 内容
  async showAiWorkspace() {
    const listEl = UI.getEl('workspace-file-list');
    const contentEl = UI.getEl('workspace-file-content');
    listEl.innerHTML = '加载中...';
    contentEl.textContent = '';
    let data = null;
    try {
      data = await API.getAiWorkspace(null, currentUser ? currentUser.id : null);
    } catch {}
    if (!data || !data.files) {
      listEl.innerHTML = '<div class="no-results">无法读取 Workspace</div>';
      UI.show('workspace-modal');
      return;
    }
    if (data.error) {
      listEl.innerHTML = `<div class="no-results">${UI.escapeHtml(data.error)}</div>`;
    } else if (data.files.length === 0) {
      listEl.innerHTML = '<div class="no-results">Workspace 为空</div>';
    } else {
      listEl.innerHTML = data.files.map((f) => `<button class="search-result-action" style="display:block;width:100%;margin-bottom:6px" data-ws-file="${UI.escapeHtml(f.name)}">${UI.escapeHtml(f.name)} <span style="color:#888;font-size:11px">${(f.size / 1024).toFixed(1)}KB</span></button>`).join('');
      listEl.querySelectorAll('[data-ws-file]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          contentEl.textContent = '加载中...（本机 OpenClaw workspace）';
          const r = await API.getAiWorkspace(btn.dataset.wsFile, currentUser ? currentUser.id : null);
          if (r.error) contentEl.textContent = r.error;
          else contentEl.textContent = r.content;
        });
      });
    }
    UI.show('workspace-modal');
  },

  async showOnlineHosts() {
    let result = [];
    try {
      result = await API.getOnlineUsers();
    } catch {
      UI.getEl('online-hosts-body').innerHTML = '<div class="no-results">获取在线用户失败</div>';
      UI.show('online-hosts-modal');
      return;
    }
    const body = UI.getEl('online-hosts-body');

    // 服务器返回的即为权威在线列表（此前误用 UI.onlineUsers 过滤导致只显示好友）
    const onlineUsers = result.filter((u) => Number(u.id) !== Number(currentUser.id));

    if (onlineUsers.length === 0) {
      body.innerHTML = '<div class="no-results">暂无其他在线用户</div>';
      UI.show('online-hosts-modal');
      return;
    }

    let friends = [];
    try {
      friends = await API.getFriends(currentUser.id);
    } catch {}
    const friendIds = new Set(friends.map((f) => Number(f.id)));

    body.innerHTML = onlineUsers.map((u) => {
      const isFriend = friendIds.has(Number(u.id));
      return `
        <div class="online-host-item">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="online-host-dot"></div>
            <div>
              <div><strong>#${u.id}</strong> ${UI.escapeHtml(u.username)}</div>
              <div style="font-size:12px;color:#888">${u.ip}</div>
            </div>
          </div>
          ${isFriend ? '<span style="font-size:12px;color:#888">已是好友</span>' : `<button class="search-result-action" onclick="APP.addFriend(${u.id})">添加好友</button>`}
        </div>
      `;
    }).join('');

    UI.show('online-hosts-modal');
  },

  async acceptFriend(friendId) {
    const result = await API.acceptFriend(currentUser.id, friendId);
    if (result.error) {
      alert(result.error);
      return;
    }
    alert('已接受好友请求');
    UI.hide('friend-requests-modal');
    await this.refreshFriendRequestsBadge();
    if (UI.currentTab === 'friends') {
      await this.refreshFriendList();
    }
  },

  async createGroup() {
    const name = UI.getEl('group-name-input').value.trim();
    if (!name) {
      alert('请输入群名称');
      return;
    }

    const checkedBoxes = document.querySelectorAll(
      '#group-member-list input[type="checkbox"]:checked'
    );
    const memberIds = Array.from(checkedBoxes).map((cb) => parseInt(cb.value));

    const result = await API.createGroup(name, currentUser.id, memberIds);
    if (result.error) {
      alert(result.error);
      return;
    }

    alert('群聊创建成功');
    UI.hide('create-group-modal');
    UI.getEl('group-name-input').value = '';

    if (UI.currentTab === 'groups') {
      await this.refreshGroupList();
    }

    UI.selectChat('group', result.group.id);
  },

  sendMessage() {
    const input = UI.getEl('message-input');
    const content = input.value.trim();

    if (!content) return;
    if (!UI.currentChatType || !UI.currentChat) {
      alert('请先选择一个好友或群聊');
      return;
    }

    if (UI.currentChatType === 'friend') {
      WS.sendPrivateMsg(UI.currentChat, content);
    } else {
      WS.sendGroupMsg(UI.currentChat, content);
    }

    input.value = '';
    input.focus();
  },

  async handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    if (!UI.currentChatType || !UI.currentChat) {
      alert('请先选择一个好友或群聊');
      return;
    }

    // 上传前捕获目标对话，防止上传期间切换对话导致文件发错对象
    const chatType = UI.currentChatType;
    const chatId = UI.currentChat;

    const result = await API.uploadFile(file, currentUser.id);
    if (result.error) {
      alert(result.error);
      return;
    }

    const data = { fileId: result.file.id };
    if (chatType === 'friend') {
      data.receiverId = chatId;
    } else {
      data.groupId = chatId;
    }
    WS.sendFileMsg(data);
  },

  recallMessage(messageId) {
    if (!confirm('确认撤回该消息？')) return;
    WS.recall(messageId);
  },

  handleMentionInput() {
    if (UI.currentChatType !== 'group') {
      this.hideMention();
      return;
    }

    const input = UI.getEl('message-input');
    const pos = input.selectionStart;
    const text = input.value.slice(0, pos);
    const atIdx = text.lastIndexOf('@');

    if (atIdx === -1 || (atIdx > 0 && text[atIdx - 1] !== ' ' && text[atIdx - 1] !== '\n')) {
      this.hideMention();
      return;
    }

    const query = text.slice(atIdx + 1);

    if (query.length === 0 || query.includes(' ') || query.includes('\n')) {
      this.hideMention();
      return;
    }

    this.showMention(query);
  },

  async showMention(query) {
    const groupId = UI.currentChat;
    if (!groupId) return;

    let members = this._mentionMembers;
    if (!members) {
      const data = await API.getGroupInfo(groupId, currentUser.id);
      members = data.members.filter((m) => Number(m.id) !== Number(currentUser.id));
      this._mentionMembers = members;
    }

    const filtered = members.filter((m) => m.username.toLowerCase().includes(query.toLowerCase()));
    if (filtered.length === 0) {
      this.hideMention();
      return;
    }

    const dropdown = UI.getEl('mention-dropdown');
    const colors = ['#e94560', '#0f3460', '#4ade80', '#f59e0b', '#8b5cf6', '#06b6d4', '#f472b6', '#34d399'];
    dropdown.innerHTML = filtered
      .map(
        (m, i) => `
      <div class="mention-item ${i === 0 ? 'active' : ''}" data-userid="${m.id}" data-username="${UI.escapeHtml(m.username)}">
        <span class="mention-item-avatar" style="background:${colors[Number(m.id) % colors.length]}">${UI.escapeHtml(m.username.charAt(0).toUpperCase())}</span>
        <span>${UI.escapeHtml(m.username)}</span>
      </div>
    `
      )
      .join('');

    dropdown.classList.remove('hidden');
    mentionState = { query, filtered, index: 0 };
  },

  hideMention() {
    mentionState = null;
    UI.getEl('mention-dropdown').classList.add('hidden');
  },

  moveMention(dir) {
    if (!mentionState) return;
    const items = UI.getEl('mention-dropdown').querySelectorAll('.mention-item');
    items[mentionState.index]?.classList.remove('active');
    mentionState.index = (mentionState.index + dir + items.length) % items.length;
    items[mentionState.index]?.classList.add('active');
    items[mentionState.index]?.scrollIntoView({ block: 'nearest' });
  },

  selectMention() {
    if (!mentionState) return;
    const item = UI.getEl('mention-dropdown').querySelector('.mention-item.active');
    if (!item) return;

    const username = item.dataset.username;
    const input = UI.getEl('message-input');
    const pos = input.selectionStart;
    const text = input.value;
    const atIdx = text.lastIndexOf('@', pos);

    if (atIdx === -1) {
      this.hideMention();
      return;
    }

    const before = text.slice(0, atIdx);
    const after = text.slice(pos);
    input.value = before + '@' + username + ' ' + after;
    const newPos = (before + '@' + username + ' ').length;
    input.setSelectionRange(newPos, newPos);
    input.focus();
    this.hideMention();
  },

  clearMentionCache() {
    this._mentionMembers = null;
  },

  async refreshBlockedUsers() {
    if (!currentUser) return;
    try {
      const blocked = await API.getBlockedUsers(currentUser.id);
      UI.blockedUsers = new Set(blocked.map((b) => Number(b.id)));
    } catch {
      UI.blockedUsers = new Set();
    }
  },

  async showAddGroupMember(groupId) {
    const members = await API.getGroupMembers(groupId, currentUser.id);
    const memberIds = new Set(members.map((m) => Number(m.id)));
    const friends = await API.getFriends(currentUser.id);
    const available = friends.filter((f) => !memberIds.has(Number(f.id)));

    const body = UI.getEl('add-group-member-body');
    if (available.length === 0) {
      body.innerHTML = '<div class="no-results">没有可添加的好友</div>';
    } else {
      body.innerHTML = available
        .map(
          (f) => `
        <div class="friend-request-item">
          <div class="friend-request-info">
            <div class="search-result-name">${UI.escapeHtml(f.username)}</div>
            <div class="search-result-ip">IP: ${UI.escapeHtml(f.ip)}</div>
          </div>
          <button class="friend-request-action accept" onclick="APP.addGroupMember(${groupId}, ${f.id})">添加</button>
        </div>
      `
        )
        .join('');
    }
    UI.show('add-group-member-modal');
  },

  async addGroupMember(groupId, userId) {
    const result = await API.addGroupMember(groupId, userId, currentUser.id);
    if (result.error) {
      alert(result.error);
      return;
    }
    UI.hide('add-group-member-modal');
    UI.selectChat('group', groupId);
  },

  async showRemoveGroupMember(groupId) {
    const data = await API.getGroupInfo(groupId, currentUser.id);
    const body = UI.getEl('remove-group-member-body');

    body.innerHTML = data.members
      .filter((m) => Number(m.id) !== Number(currentUser.id))
      .map(
        (m) => `
      <div class="friend-request-item">
        <div class="friend-request-info">
          <div class="search-result-name">${UI.escapeHtml(m.username)}</div>
          <div class="search-result-ip">${UI.escapeHtml(m.ip || '')}</div>
        </div>
        <button class="friend-request-action accept" style="background:#e94560" onclick="APP.removeGroupMember(${groupId}, ${m.id})">移除</button>
      </div>
    `
      )
      .join('') || '<div class="no-results">没有可移除的成员</div>';

    UI.show('remove-group-member-modal');
  },

  async removeGroupMember(groupId, userId) {
    if (!confirm('确认移除该成员？')) return;
    const result = await API.removeGroupMember(groupId, userId, currentUser.id);
    if (result.error) {
      alert(result.error);
      return;
    }
    UI.hide('remove-group-member-modal');
    UI.selectChat('group', groupId);
  },

  async toggleBlock(friendId) {
    if (!currentUser) return;
    const isBlocked = UI.blockedUsers.has(Number(friendId));
    if (isBlocked) {
      await API.unblockUser(currentUser.id, friendId);
      UI.blockedUsers.delete(Number(friendId));
    } else {
      await API.blockUser(currentUser.id, friendId);
      UI.blockedUsers.add(Number(friendId));
    }
    UI.updateBlockButton(friendId, !isBlocked);
  },

  async deleteFriend(friendId) {
    if (!currentUser) return;
    if (!confirm(`确定删除好友 #${friendId} 吗？`)) return;
    const result = await API.deleteFriend(currentUser.id, friendId);
    if (result.error) {
      alert(result.error);
      return;
    }
    if (UI.currentChatType === 'friend' && Number(UI.currentChat) === Number(friendId)) {
      UI.currentChat = null;
      UI.currentChatType = null;
      UI.getEl('messages').innerHTML = '<div class="no-chat-selected"><p>选择一个好友或群聊开始聊天</p></div>';
      UI.getEl('chat-title').textContent = '选择一个好友或群聊开始聊天';
      UI.getEl('chat-members').textContent = '';
      UI.getEl('chat-input-area').classList.add('hidden');
    }
    await this.refreshFriendList();
    alert('已删除好友');
  },

  clearLocalCache() {
    if (!confirm('确定清除所有本地缓存？这将清除所有聊天记录缓存。')) return;
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('chat_cache_')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
    alert(`已清除 ${keysToRemove.length} 个本地缓存`);
    UI.getEl('messages').innerHTML = '<div class="no-chat-selected"><p>缓存已清除，加载中...</p></div>';
    if (UI.currentChatType && UI.currentChat) {
      UI.loadChatView(UI.currentChatType, UI.currentChat);
    }
  },

  async showAnnouncement(groupId) {
    const data = await API.getGroupInfo(groupId, currentUser.id);
    const display = UI.getEl('announcement-display');
    const editArea = UI.getEl('announcement-edit-area');
    const announcement = data.group.announcement || '暂无公告';

    const isCreator = Number(data.group.creator_id) === Number(currentUser.id);
    display.innerHTML = `<div class="announcement-text">${UI.escapeHtml(announcement).replace(/\n/g, '<br>')}</div>`;

    if (isCreator) {
      editArea.classList.remove('hidden');
      UI.getEl('announcement-input').value = data.group.announcement || '';
    } else {
      editArea.classList.add('hidden');
    }

    UI.getEl('confirm-announcement').onclick = async () => {
      const text = UI.getEl('announcement-input').value.trim();
      const result = await API.setAnnouncement(groupId, currentUser.id, text);
      if (result.error) {
        alert(result.error);
        return;
      }
      alert('公告已发布');
      UI.hide('announcement-modal');
      if (UI.currentChatType === 'group' && Number(UI.currentChat) === Number(groupId)) {
        UI.loadChatView('group', groupId);
      }
    };

    UI.show('announcement-modal');
  },

  async showTransferAdmin(groupId) {
    const data = await API.getGroupInfo(groupId, currentUser.id);
    const body = UI.getEl('transfer-admin-body');
    const members = data.members.filter((m) => Number(m.id) !== Number(currentUser.id));

    if (members.length === 0) {
      body.innerHTML = '<div class="no-results">没有可转让的成员</div>';
    } else {
      body.innerHTML = members
        .map(
          (m) => `
        <div class="friend-request-item">
          <div class="friend-request-info">
            <div class="search-result-name">${UI.escapeHtml(m.username)}</div>
            <div class="search-result-ip">${UI.escapeHtml(m.ip || '')}</div>
          </div>
          <button class="friend-request-action accept" onclick="APP.confirmTransferAdmin(${groupId}, ${m.id})">转让</button>
        </div>
      `
        )
        .join('');
    }
    UI.show('transfer-admin-modal');
  },

  async confirmTransferAdmin(groupId, toUserId) {
    if (!confirm('确认将管理员权限转让给该成员？转让后你将变为普通成员。')) return;
    const result = await API.transferAdmin(groupId, currentUser.id, toUserId);
    if (result.error) {
      alert(result.error);
      return;
    }
    alert('管理员权限已转让');
    UI.hide('transfer-admin-modal');
    UI.selectChat('group', groupId);
  },

  async toggleMute(groupId) {
    const result = await API.toggleMute(currentUser.id, groupId);
    if (result.error) {
      alert(result.error);
      return;
    }
    const btn = document.querySelector(`.mute-btn[data-group-id="${groupId}"]`);
    if (btn) {
      btn.textContent = result.muted ? '取消免打扰' : '免打扰';
      btn.classList.toggle('muted', result.muted);
    }
    alert(result.muted ? '已开启免打扰' : '已取消免打扰');
  },

  async deleteGroup(groupId) {
    if (!confirm('确定删除此群聊？此操作不可撤销，所有消息将被清除！')) return;
    const result = await API.deleteGroup(groupId, currentUser.id);
    if (result.error) {
      alert(result.error);
      return;
    }
    alert('群聊已删除');
    if (UI.currentChatType === 'group' && Number(UI.currentChat) === Number(groupId)) {
      UI.currentChat = null;
      UI.currentChatType = null;
      UI.getEl('messages').innerHTML = '<div class="no-chat-selected"><p>选择一个好友或群聊开始聊天</p></div>';
      UI.getEl('chat-title').textContent = '选择一个好友或群聊开始聊天';
      UI.getEl('chat-members').textContent = '';
      UI.getEl('chat-input-area').classList.add('hidden');
    }
    await this.refreshGroupList();
  },
};

document.addEventListener('DOMContentLoaded', () => APP.init());
