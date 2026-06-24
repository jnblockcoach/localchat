const termkit = require('terminal-kit');
const term = termkit.terminal;
const ScreenBufferHD = termkit.ScreenBufferHD;

class TerminalUI {
  constructor(client) {
    this.client = client;
    this.currentUser = null;
    this.currentChatType = null;
    this.currentChatId = null;
    this.currentTab = 'friends';
    this.friends = [];
    this.groups = [];
    this.onlineUsers = new Set();
    this.chatMessages = [];
    this.inputBuffer = '';
    this.contactIndex = 0;
    this.msgScroll = 0;
    this._initCommands();
    this._setupWsHandlers();
  }

  // --- Promisified terminal-kit helpers ---

  _menu(items, options = {}) {
    return new Promise((resolve) => {
      term.singleColumnMenu(items, options, (err, resp) => {
        if (err || !resp || resp.canceled || resp.selectedIndex < 0) { resolve(-1); return; }
        resolve(resp.selectedIndex);
      });
    });
  }

  _input(options = {}) {
    return new Promise((resolve) => {
      options = Object.assign({ cancelable: true }, options);
      term.inputField(options, (err, value) => {
        resolve((err || value === undefined) ? null : value);
      });
    });
  }

  // --- Entry point ---

  async run() {
    term.fullscreen(true);
    term.grabInput(true);
    term.clear();
    term.hideCursor(false);
    this._drawFull();
    await this._loginFlow();
  }

  // --- Drawing utilities ---

  _drawFull() {
    term.bgDefaultColor();
    term.eraseScreen();
  }

  _screenW() { return term.width; }
  _screenH() { return term.height; }
  _sidebarW() { return Math.max(16, Math.floor(this._screenW() * 0.28)); }

  _put(x, y, text, color) {
    if (y < 0 || y >= this._screenH()) return;
    text = String(text).slice(0, this._screenW() - x);
    term.moveTo(x, y);
    if (color) {
      if (typeof color === 'object') {
        term.colorRgb(color.r, color.g, color.b, text);
      } else {
        term[color] ? term[color](text) : term(text);
      }
    } else {
      term(text);
    }
  }

  _eraseLine(y) {
    term.moveTo(0, y);
    term.eraseLine();
    term(' '.repeat(this._screenW()));
  }

  _box(x, y, w, h) {
    const top = '\u250C' + '\u2500'.repeat(w - 2) + '\u2510';
    const mid = '\u2502';
    const bot = '\u2514' + '\u2500'.repeat(w - 2) + '\u2518';
    this._put(x, y, top, 'brightCyan');
    for (let i = 1; i < h - 1; i++) {
      this._put(x, y + i, mid, 'brightCyan');
      this._put(x + w - 1, y + i, mid, 'brightCyan');
    }
    this._put(x, y + h - 1, bot, 'brightCyan');
  }

  // --- Login flow ---

  async _loginFlow() {
    this.client.wsConnect();

    const CW = 56;
    const CH = 16;
    const cx = Math.max(0, Math.floor((this._screenW() - CW) / 2));
    const cy = Math.max(0, Math.floor((this._screenH() - CH) / 2));

    this._drawFull();
    this._box(cx, cy, CW, CH);

    this._put(cx + 2, cy + 1, ' LocalChat - 命令行客户端 ', 'brightCyan');
    this._put(cx + 2, cy + 2, '\u2500'.repeat(CW - 4), 'gray');

    this._put(cx + 2, cy + 3, ' 服务器: ' + this.client.wsUrl, 'gray');

    let ipUsers = [];
    try { ipUsers = await this.client.getUsersByIp(); } catch {}
    this._ipUsers = ipUsers;

    const items = [
      '1. 创建新账号',
      '2. 用ID登录',
      '3. 用昵称查找登录',
    ];
    for (const u of ipUsers) {
      items.push('  登录 ' + u.username + ' (#' + u.id + ')');
    }
    items.push('Q. 退出');

    this._put(cx + 2, cy + CH - 2, ' 箭头选择, Enter 确认', 'gray');

    const idx = await this._menu(items, {
      x: cx + 3,
      y: cy + 4,
      style: term.white,
      selectedStyle: term.brightWhite.bgCyan,
      itemMaxWidth: CW - 8,
      top: cy + 3,
      height: CH - 6,
    });

    if (idx < 0 || idx === items.length - 1) {
      this._exit();
      return;
    }

    if (idx === 0) {
      await this._doRegister(cx, cy, CW);
    } else if (idx === 1) {
      await this._doLoginById(cx, cy, CW);
    } else if (idx === 2) {
      await this._doLoginBySearch(cx, cy, CW);
    } else if (idx >= 3 && ipUsers.length > 0 && idx < 3 + ipUsers.length) {
      await this._loginAs(ipUsers[idx - 3].id);
    } else {
      await this._loginFlow();
    }
  }

  async _doRegister(cx, cy, CW) {
    this._drawFull();
    this._box(cx, cy, CW, 9);
    this._put(cx + 3, cy + 1, '创建新账号', 'brightCyan');
    this._put(cx + 3, cy + 2, '\u2500'.repeat(CW - 6), 'gray');
    this._put(cx + 3, cy + 4, '输入昵称:', 'white');

    const username = await this._input({
      x: cx + 14,
      y: cy + 4,
      width: CW - 16,
      cancelable: true,
    });
    if (!username || !username.trim()) { await this._loginFlow(); return; }

    const result = await this.client.register(username.trim());
    if (result.error) {
      this._put(cx + 3, cy + 7, '错误: ' + result.error, 'red');
      await this._sleep(2000);
      await this._loginFlow();
      return;
    }

    // Registration returned user data directly — no need to call login again
    const user = result.user;
    this.currentUser = user;
    this.client.user = user;
    this.client.wsAuth();

    try { this.friends = await this.client.getFriends(user.id); } catch { this.friends = []; }
    try { this.groups = await this.client.getGroups(user.id); } catch { this.groups = []; }

    this._put(cx + 3, cy + 7, '注册成功! ID: ' + user.id + '  进入聊天...', 'green');
    await this._sleep(2000);
    this._showMainScreen();
  }

  async _doLoginById(cx, cy, CW) {
    this._drawFull();
    this._box(cx, cy, CW, 9);
    this._put(cx + 3, cy + 1, '用ID登录', 'brightCyan');
    this._put(cx + 3, cy + 2, '\u2500'.repeat(CW - 6), 'gray');
    this._put(cx + 3, cy + 4, '输入ID:', 'white');

    const val = await this._input({
      x: cx + 12,
      y: cy + 4,
      width: CW - 14,
      cancelable: true,
    });
    if (!val || !val.trim()) { await this._loginFlow(); return; }
    const id = parseInt(val.trim());
    if (!id) {
      this._put(cx + 3, cy + 7, '无效ID', 'red');
      await this._sleep(2000);
      await this._loginFlow();
      return;
    }
    await this._loginAs(id);
  }

  async _doLoginBySearch(cx, cy, CW) {
    this._drawFull();
    this._box(cx, cy, CW, 9);
    this._put(cx + 3, cy + 1, '用昵称查找登录', 'brightCyan');
    this._put(cx + 3, cy + 2, '\u2500'.repeat(CW - 6), 'gray');
    this._put(cx + 3, cy + 4, '输入昵称:', 'white');

    const q = await this._input({
      x: cx + 14,
      y: cy + 4,
      width: CW - 16,
      cancelable: true,
    });
    if (!q || !q.trim()) { await this._loginFlow(); return; }

    const results = await this.client.searchUsers(q.trim());
    if (results.length === 0) {
      this._put(cx + 3, cy + 7, '未找到匹配账号', 'yellow');
      await this._sleep(2000);
      await this._loginFlow();
      return;
    }

    this._drawFull();
    this._put(cx, cy, '选择账号', 'brightCyan');
    this._put(cx, cy + 1, '\u2500'.repeat(30), 'gray');
    const items = results.map((u) => '  #' + u.id + '  ' + u.username + '  (' + u.ip + ')');
    const sel = await this._menu(items, {
      x: cx + 2,
      y: cy + 2,
      style: term.white,
      selectedStyle: term.brightWhite.bgCyan,
      itemMaxWidth: 48,
    });
    if (sel >= 0 && sel < results.length) await this._loginAs(results[sel].id);
    else await this._loginFlow();
  }

  async _loginAs(id) {
    this._drawFull();
    const x = Math.floor(this._screenW() / 2) - 12;
    const y = Math.floor(this._screenH() / 2);
    this._put(x, y, '正在登录...', 'brightCyan');

    const result = await this.client.login(id);
    if (result.error) {
      this._put(x, y + 2, '登录失败: ' + result.error, 'red');
      await this._sleep(1500);
      await this._loginFlow();
      return;
    }

    this.currentUser = result.user;
    this.client.user = result.user;
    this.client.wsAuth();

    this._put(x, y, '已登录: ' + result.user.username + ' (#' + result.user.id + ')', 'green');
    await this._sleep(1000);

    try { this.friends = await this.client.getFriends(this.currentUser.id); } catch { this.friends = []; }
    try { this.groups = await this.client.getGroups(this.currentUser.id); } catch { this.groups = []; }

    this._showMainScreen();
  }

  // --- Main screen ---

  _showMainScreen() {
    this._drawFull();
    this._drawLayout();
    this._startKeyHandler();
  }

  _drawLayout() {
    this._drawHeader();
    this._drawSidebar();
    this._drawChatArea();
    this._drawInputBar();
    this._drawStatusBar();
    this._setCursorToInput();
  }

  _drawHeader() {
    const W = this._screenW();
    this._eraseLine(0);
    const title = ' Chater';
    const user = this.currentUser
      ? ' | ' + this.currentUser.username + ' (#' + this.currentUser.id + ')'
      : '';
    const ctx = this.currentChatType === 'friend'
      ? ' | > 私聊 #' + this.currentChatId
      : this.currentChatType === 'group'
        ? ' | > 群聊 #' + this.currentChatId
        : '';
    this._put(0, 0, title + user + ctx + ' '.repeat(W - title.length - user.length - ctx.length), 'brightCyan');
    this._put(0, 1, '\u2500'.repeat(W), 'gray');
  }

  _drawSidebar() {
    const W = this._sidebarW();
    const H = this._screenH();
    const chatW = this._screenW() - W - 1;

    // Clear entire sidebar area + separator column
    for (let y = 2; y < H - 2; y++) {
      term.moveTo(0, y);
      term.eraseLine();
      term(' '.repeat(W + 1));
    }

    // Vertical separator
    for (let y = 2; y < H - 2; y++) {
      this._put(W, y, '\u2502', 'gray');
    }

    // Tab bar
    this._put(1, 2,
      this.currentTab === 'friends' ? '[好友]' : '好友',
      this.currentTab === 'friends' ? 'brightWhite' : 'white');
    this._put(8, 2,
      this.currentTab === 'groups' ? '[群聊]' : '群聊',
      this.currentTab === 'groups' ? 'brightWhite' : 'white');

    // Separator under tabs
    this._put(0, 3, '\u2500'.repeat(W), 'gray');

    const items = this.currentTab === 'friends' ? this.friends : this.groups;
    const maxItems = H - 6;

    if (this.contactIndex >= items.length) this.contactIndex = Math.max(0, items.length - 1);
    if (this.contactIndex < 0) this.contactIndex = 0;

    for (let i = 0; i < Math.min(items.length, maxItems); i++) {
      const y = 4 + i;
      this._put(0, y, ' '.repeat(W), 'white');
      const prefix = i === this.contactIndex ? '>' : ' ';

      if (this.currentTab === 'friends') {
        const online = this.onlineUsers.has(Number(items[i].id));
        const dot = online ? '●' : '○';
        const dotColor = online ? 'green' : 'gray';
        this._put(1, y, prefix, 'brightCyan');
        this._put(3, y, dot, dotColor);
        this._put(5, y, items[i].username, i === this.contactIndex ? 'brightWhite' : 'white');
      } else {
        const g = items[i];
        this._put(1, y, prefix + ' ' + g.name, i === this.contactIndex ? 'brightWhite' : 'white');
        this._put(g.name.length + 4, y, '(' + g.member_count + ')', 'gray');
      }
    }
  }

  _drawChatArea() {
    const W = this._screenW();
    const sideW = this._sidebarW();
    const chatW = W - sideW - 1;
    const H = this._screenH();

    for (let y = 2; y < H - 2; y++) {
      this._put(sideW + 1, y, ' '.repeat(chatW - 1));
    }

    if (this.currentChatType && this.currentChatId) {
      const visible = this.chatMessages.slice(-(H - 5));
      for (let i = 0; i < visible.length; i++) {
        const y = 2 + i;
        if (y >= H - 3) break;
        const msg = visible[i];
        const text = msg.text.slice(0, chatW - 2);
        this._put(sideW + 2, y, text, msg.color || 'white');
      }
    } else if (this.chatMessages.length > 0) {
      const visible = this.chatMessages.slice(-(H - 5));
      for (let i = 0; i < visible.length; i++) {
        const y = 2 + i;
        if (y >= H - 3) break;
        const msg = visible[i];
        const text = msg.text.slice(0, chatW - 2);
        this._put(sideW + 2, y, text, msg.color || 'white');
      }
    } else {
      this._put(sideW + 2, Math.floor(H / 2) - 1, '选择好友或群聊开始聊天', 'gray');
      this._put(sideW + 2, Math.floor(H / 2), '/msg <ID>  打开私聊', 'gray');
      this._put(sideW + 2, Math.floor(H / 2) + 1, '/groupmsg <ID>  打开群聊', 'gray');
    }
  }

  _drawInputBar() {
    const H = this._screenH();
    const W = this._screenW();
    const sideW = this._sidebarW();

    this._eraseLine(H - 2);
    this._put(0, H - 2, '\u2500'.repeat(W), 'gray');
    this._eraseLine(H - 1);
    this._put(1, H - 1, '> ' + this.inputBuffer, 'white');
  }

  _drawStatusBar() {
    const H = this._screenH();
    const online = this.onlineUsers.size;
    const conn = this.client.ws && this.client.ws.readyState === 1;
    if (H > 0) {
      this._eraseLine(H - 1);
      this._put(0, H - 1, ' '.repeat(this._screenW()));
      this._put(1, H - 1, '在线:' + online + '  ' + (conn ? '●已连接' : '○断开') + '  Ctrl+C退出  Tab切换面板', 'gray');
    }
    this._put(this._screenW() - 12, H - 1, 'Ctrl+C 退出', 'gray');
  }

  _displayWidth(str) {
    let w = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x1100 && cp <= 0x115F) ||
          (cp >= 0x2329 && cp <= 0x232A) ||
          (cp >= 0x2E80 && cp <= 0xA4CF) ||
          (cp >= 0xA960 && cp <= 0xA97C) ||
          (cp >= 0xAC00 && cp <= 0xD7A3) ||
          (cp >= 0xF900 && cp <= 0xFAFF) ||
          (cp >= 0xFE10 && cp <= 0xFE19) ||
          (cp >= 0xFE30 && cp <= 0xFE6F) ||
          (cp >= 0xFF01 && cp <= 0xFF60) ||
          (cp >= 0xFFE0 && cp <= 0xFFE6) ||
          (cp >= 0x1F300 && cp <= 0x1F64F) ||
          (cp >= 0x1F900 && cp <= 0x1F9FF) ||
          (cp >= 0x20000 && cp <= 0x2FFFD) ||
          (cp >= 0x30000 && cp <= 0x3FFFD)) {
        w += 2;
      } else {
        w += 1;
      }
    }
    return w;
  }

  _setCursorToInput() {
    const x = 3 + this._displayWidth(this.inputBuffer);
    const y = this._screenH() - 1;
    term.moveTo(x, y);
  }

  _appendChatMsg(sender, content, time, isSelf) {
    const color = isSelf ? 'yellow' : 'brightWhite';
    const text = '[' + time + '] ' + sender + ': ' + content;
    this.chatMessages.push({ text, color });
    if (this.chatMessages.length > 500) this.chatMessages = this.chatMessages.slice(-500);
    this._drawChatArea();
    this._drawInputBar();
    this._setCursorToInput();
  }

  _appendSystemMsg(content) {
    this.chatMessages.push({ text: content, color: 'gray' });
    if (this.chatMessages.length > 500) this.chatMessages = this.chatMessages.slice(-500);
    this._drawChatArea();
    this._drawInputBar();
    this._setCursorToInput();
  }

  // --- Key handling ---

  _startKeyHandler() {
    if (this._keyStarted) return;
    this._keyStarted = true;
    term.grabInput(true);
    term.on('key', (name, matches, data) => {
      if (name === 'CTRL_C') { this._exit(); return; }

      if (name === 'TAB') {
        this.currentTab = this.currentTab === 'friends' ? 'groups' : 'friends';
        this.contactIndex = 0;
        this._drawSidebar();
        return;
      }

      if (name === 'UP') {
        const items = this.currentTab === 'friends' ? this.friends : this.groups;
        if (this.contactIndex > 0) {
          this.contactIndex--;
          this._drawSidebar();
        }
        return;
      }

      if (name === 'DOWN') {
        const items = this.currentTab === 'friends' ? this.friends : this.groups;
        if (this.contactIndex < items.length - 1) {
          this.contactIndex++;
          this._drawSidebar();
        }
        return;
      }

      if (name === 'ENTER') {
        // If user typed something, submit it first (commands like /help)
        if (this.inputBuffer.trim()) {
          this._submitInput();
          return;
        }
        // Otherwise, select the highlighted contact
        const items = this.currentTab === 'friends' ? this.friends : this.groups;
        const type = this.currentTab === 'friends' ? 'friend' : 'group';
        if (items.length > 0 && this.contactIndex < items.length) {
          const item = items[this.contactIndex];
          this.currentChatType = type;
          this.currentChatId = item.id;
          this.chatMessages = [];
          this._loadChatHistory(type, item.id);
          this._drawHeader();
          this._drawChatArea();
          this._drawInputBar();
          this._setCursorToInput();
        }
        return;
      }

      if (name === 'BACKSPACE' || name === 'DELETE') {
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this._drawInputBar();
          this._setCursorToInput();
        }
        return;
      }

      if (name === 'ESCAPE') {
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = '';
        } else {
          this.currentChatType = null;
          this.currentChatId = null;
          this.chatMessages = [];
          this._drawHeader();
          this._drawChatArea();
          this._drawInputBar();
          this._setCursorToInput();
        }
        this._drawInputBar();
        this._setCursorToInput();
        return;
      }

      // Printable characters (including Chinese, Unicode)
      if (data) {
        const controlKeys = ['ENTER', 'BACKSPACE', 'DELETE', 'TAB', 'ESCAPE',
          'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN',
          'CTRL_C', 'CTRL_T', 'CTRL_R', 'CTRL_S', 'INSERT'];
        if (controlKeys.includes(name)) return;

        const code = typeof data.code === 'number' ? data.code : 0;
        const seq = data.sequence || '';
        let ch = null;
        if (code > 31) ch = String.fromCharCode(code);
        else if (name && name.length === 1 && name.charCodeAt(0) > 31) ch = name;
        else if (seq.length > 0 && !seq.startsWith('\x1b') && !seq.startsWith('\x7f') && seq.charCodeAt(0) > 31) ch = seq;

        if (ch) {
          this.inputBuffer += ch;
          this._drawInputBar();
          this._setCursorToInput();
        }
        return;
      }
    });

    // Handle terminal resize
    term.on('resize', () => {
      this._drawLayout();
    });
  }

  _initCommands() {
    this._commands = [
      { name: '/help',            desc: '显示帮助' },
      { name: '/quit',            desc: '退出程序' },
      { name: '/friends',         desc: '刷新并显示好友列表' },
      { name: '/groups',          desc: '刷新并显示群聊列表' },
      { name: '/requests',        desc: '查看待处理的好友请求' },
      { name: '/accept <ID>',     desc: '接受好友请求' },
      { name: '/add <ID>',        desc: '添加好友' },
      { name: '/block <ID>',      desc: '拉黑用户' },
      { name: '/unblock <ID>',    desc: '取消拉黑' },
      { name: '/search <q>',      desc: '搜索用户 (昵称/IP)' },
      { name: '/online',          desc: '显示在线用户' },
      { name: '/info <ID>',       desc: '查看用户或群聊信息' },
      { name: '/msg <ID>',        desc: '打开与好友的私聊' },
      { name: '/groupmsg <ID>',   desc: '打开群聊' },
      { name: '/create <name>',   desc: '创建群聊' },
      { name: '/addmember <GID> <UID>',  desc: '添加群成员' },
      { name: '/rmmember <GID> <UID>',   desc: '移除群成员' },
      { name: '/mute <GID>',      desc: '切换群聊免打扰' },
      { name: '/announce <GID> <text>',  desc: '设置群公告' },
      { name: '/deletegroup <GID>',      desc: '删除群聊 (创建者)' },
      { name: '/transfer <GID> <UID>',   desc: '转让管理员权限' },
      { name: '/recall <MID>',    desc: '撤回消息 (2分钟内)' },
    ];
  }

  async _submitInput() {
    const content = this.inputBuffer.trim();
    this.inputBuffer = '';

    if (content.startsWith('/')) {
      await this._handleCommand(content);
    } else {
      if (!this.currentChatType || !this.currentChatId) {
        this._appendSystemMsg('先选择聊天对象 (上下键+Enter) 或输入 /help 查看帮助');
        this._drawInputBar();
        this._setCursorToInput();
        return;
      }
      if (this.currentChatType === 'friend') {
        this.client.sendPrivateMsg(this.currentChatId, content);
      } else {
        this.client.sendGroupMsg(this.currentChatId, content);
      }
    }

    this._drawInputBar();
    this._setCursorToInput();
  }

  async _loadChatHistory(type, id) {
    try {
      let messages;
      if (type === 'friend') {
        messages = await this.client.getPrivateHistory(this.currentUser.id, id);
      } else {
        messages = await this.client.getGroupHistory(id);
      }
      for (const msg of messages) {
        if (msg.status === 'recalled') {
          this._appendSystemMsg('[消息已撤回]');
        } else {
          const sender = Number(msg.sender_id) === Number(this.currentUser.id)
            ? '你'
            : (msg.sender_name || '#' + msg.sender_id);
          const time = msg.created_at ? msg.created_at.slice(11, 16) : '';
          this._appendChatMsg(sender, msg.content, time, Number(msg.sender_id) === Number(this.currentUser.id));
        }
      }
    } catch {}
  }

  async _handleCommand(cmd) {
    const parts = cmd.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case 'help':
        this._appendSystemMsg('── 可用命令 ──────────────────────────────');
        const maxLen = this._commands.length ? Math.max(...this._commands.map(c => c.name.length)) : 0;
        for (const cmd of this._commands) {
          this._appendSystemMsg('  ' + cmd.name + ' '.repeat(Math.max(0, maxLen - cmd.name.length + 2)) + cmd.desc);
        }
        break;

      case 'quit':
      case 'exit':
        this._exit();
        return;

      case 'friends':
        await this._refreshLists();
        this.currentTab = 'friends';
        this.contactIndex = 0;
        this._drawSidebar();
        this._appendSystemMsg('好友列表已刷新');
        this._drawInputBar();
        this._setCursorToInput();
        return;

      case 'groups':
        await this._refreshLists();
        this.currentTab = 'groups';
        this.contactIndex = 0;
        this._drawSidebar();
        this._appendSystemMsg('群聊列表已刷新');
        this._drawInputBar();
        this._setCursorToInput();
        return;

      case 'msg':
        if (parts.length < 2 || !parseInt(parts[1])) {
          this._appendSystemMsg('用法: /msg <好友ID>');
          break;
        }
        this.currentChatType = 'friend';
        this.currentChatId = parseInt(parts[1]);
        this.chatMessages = [];
        await this._loadChatHistory('friend', this.currentChatId);
        this._drawHeader();
        this._drawChatArea();
        break;

      case 'groupmsg':
        if (parts.length < 2 || !parseInt(parts[1])) {
          this._appendSystemMsg('用法: /groupmsg <群ID>');
          break;
        }
        this.currentChatType = 'group';
        this.currentChatId = parseInt(parts[1]);
        this.chatMessages = [];
        await this._loadChatHistory('group', this.currentChatId);
        this._drawHeader();
        this._drawChatArea();
        break;

      case 'online': {
        try {
          const users = await this.client.getOnlineUsers();
          this._appendSystemMsg('--- 在线用户 ---');
          for (const u of users) {
            if (Number(u.id) !== Number(this.currentUser.id)) {
              this._appendSystemMsg('  #' + u.id + ' ' + u.username + ' (' + u.ip + ')');
            }
          }
        } catch { this._appendSystemMsg('获取失败'); }
        break;
      }

      case 'search':
        if (parts.length < 2) { this._appendSystemMsg('用法: /search <关键词>'); break; }
        await this._doSearch(parts.slice(1).join(' '));
        break;

      case 'add':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /add <用户ID>'); break; }
        await this._doAddFriend(parseInt(parts[1]));
        break;

      case 'requests':
        await this._doShowRequests();
        break;

      case 'accept':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /accept <用户ID>'); break; }
        await this._doAcceptFriend(parseInt(parts[1]));
        break;

      case 'block':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /block <用户ID>'); break; }
        await this._doBlock(parseInt(parts[1]));
        break;

      case 'unblock':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /unblock <用户ID>'); break; }
        await this._doUnblock(parseInt(parts[1]));
        break;

      case 'create':
        if (parts.length < 2 || !parts[1].trim()) { this._appendSystemMsg('用法: /create <群名称>'); break; }
        await this._doCreateGroup(parts.slice(1).join(' '));
        break;

      case 'addmember':
        if (parts.length < 3 || !parseInt(parts[1]) || !parseInt(parts[2])) {
          this._appendSystemMsg('用法: /addmember <群ID> <用户ID>'); break;
        }
        await this._doAddGroupMember(parseInt(parts[1]), parseInt(parts[2]));
        break;

      case 'rmmember':
        if (parts.length < 3 || !parseInt(parts[1]) || !parseInt(parts[2])) {
          this._appendSystemMsg('用法: /rmmember <群ID> <用户ID>'); break;
        }
        await this._doRemoveGroupMember(parseInt(parts[1]), parseInt(parts[2]));
        break;

      case 'mute':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /mute <群ID>'); break; }
        await this._doToggleMute(parseInt(parts[1]));
        break;

      case 'announce':
        if (parts.length < 3) { this._appendSystemMsg('用法: /announce <群ID> <公告内容>'); break; }
        await this._doSetAnnouncement(parseInt(parts[1]), parts.slice(2).join(' '));
        break;

      case 'deletegroup':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /deletegroup <群ID>'); break; }
        await this._doDeleteGroup(parseInt(parts[1]));
        break;

      case 'transfer':
        if (parts.length < 3 || !parseInt(parts[1]) || !parseInt(parts[2])) {
          this._appendSystemMsg('用法: /transfer <群ID> <用户ID>'); break;
        }
        await this._doTransferAdmin(parseInt(parts[1]), parseInt(parts[2]));
        break;

      case 'info':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /info <用户ID或群ID>'); break; }
        await this._doShowInfo(parseInt(parts[1]));
        break;

      case 'recall':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /recall <消息ID>'); break; }
        this.client.recall(parseInt(parts[1]));
        this._appendSystemMsg('撤回请求已发送');
        break;

      default:
        this._appendSystemMsg('未知命令: ' + cmd + ' (输入 /help 查看帮助)');
    }

    this._drawInputBar();
    this._setCursorToInput();
  }

  async _doSearch(query) {
    try {
      const results = await this.client.searchUsers(query);
      if (results.length === 0) { this._appendSystemMsg('未找到匹配的用户'); return; }
      this._appendSystemMsg('--- 搜索结果 ---');
      for (const u of results) {
        this._appendSystemMsg('  #' + u.id + ' ' + u.username + ' (' + u.ip + ')');
      }
    } catch { this._appendSystemMsg('搜索失败'); }
  }

  async _doAddFriend(friendId) {
    try {
      const result = await this.client.addFriend(this.currentUser.id, friendId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('好友请求已发送');
    } catch { this._appendSystemMsg('发送失败'); }
  }

  async _refreshLists() {
    try { this.friends = await this.client.getFriends(this.currentUser.id); } catch { this.friends = []; }
    try { this.groups = await this.client.getGroups(this.currentUser.id); } catch { this.groups = []; }
  }

  async _doShowRequests() {
    try {
      const requests = await this.client.getPendingRequests(this.currentUser.id);
      if (requests.length === 0) { this._appendSystemMsg('暂无好友请求'); return; }
      this._appendSystemMsg('--- 好友请求 ---');
      for (const r of requests) {
        this._appendSystemMsg('  #' + r.id + ' ' + r.username + ' (' + r.ip + ')  /accept ' + r.id);
      }
    } catch { this._appendSystemMsg('获取失败'); }
  }

  async _doAcceptFriend(friendId) {
    try {
      const result = await this.client.acceptFriend(this.currentUser.id, friendId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已接受好友请求');
      try { this.friends = await this.client.getFriends(this.currentUser.id); } catch {}
      this._drawSidebar();
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doBlock(userId) {
    try {
      const result = await this.client.blockUser(this.currentUser.id, userId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已拉黑用户 #' + userId);
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doUnblock(userId) {
    try {
      const result = await this.client.unblockUser(this.currentUser.id, userId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已取消拉黑 #' + userId);
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doCreateGroup(name) {
    try {
      const result = await this.client.createGroup(name, this.currentUser.id, []);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('群聊已创建: #' + result.group.id + ' ' + result.group.name);
      this._appendSystemMsg('使用 /addmember ' + result.group.id + ' <用户ID> 添加成员');
      try { this.groups = await this.client.getGroups(this.currentUser.id); } catch {}
      this._drawSidebar();
    } catch { this._appendSystemMsg('创建失败'); }
  }

  async _doAddGroupMember(groupId, userId) {
    try {
      const result = await this.client.addGroupMember(groupId, userId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已添加成员');
      try { this.groups = await this.client.getGroups(this.currentUser.id); } catch {}
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doRemoveGroupMember(groupId, userId) {
    try {
      const result = await this.client.removeGroupMember(groupId, userId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已移除成员');
      try { this.groups = await this.client.getGroups(this.currentUser.id); } catch {}
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doToggleMute(groupId) {
    try {
      const result = await this.client.toggleMute(this.currentUser.id, groupId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg(result.muted ? '免打扰已开启' : '免打扰已关闭');
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doSetAnnouncement(groupId, text) {
    try {
      const result = await this.client.setAnnouncement(groupId, this.currentUser.id, text);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('公告已发布');
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doDeleteGroup(groupId) {
    try {
      const result = await this.client.deleteGroup(groupId, this.currentUser.id);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('群聊已删除');
      if (this.currentChatType === 'group' && Number(this.currentChatId) === Number(groupId)) {
        this.currentChatType = null;
        this.currentChatId = null;
        this.chatMessages = [];
      }
      try { this.groups = await this.client.getGroups(this.currentUser.id); } catch {}
      this._drawSidebar();
      this._drawChatArea();
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doTransferAdmin(groupId, toUserId) {
    try {
      const result = await this.client.transferAdmin(groupId, this.currentUser.id, toUserId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('管理权限已转让');
      try { this.groups = await this.client.getGroups(this.currentUser.id); } catch {}
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doShowInfo(id) {
    try {
      const user = await this.client.getUser(id);
      if (user && !user.error) {
        this._appendSystemMsg('--- 用户 #' + user.id + ' ---');
        this._appendSystemMsg('  昵称: ' + user.username);
        this._appendSystemMsg('  IP: ' + (user.ip || '--'));
        this._appendSystemMsg('  注册时间: ' + (user.created_at || '--'));
        return;
      }
    } catch {}

    try {
      const group = await this.client.getGroupInfo(id);
      if (group && group.group && !group.error) {
        this._appendSystemMsg('--- 群聊 #' + group.group.id + ' ---');
        this._appendSystemMsg('  名称: ' + group.group.name);
        this._appendSystemMsg('  成员: ' + group.members.length + '人');
        this._appendSystemMsg('  公告: ' + (group.group.announcement || '暂无'));
        this._appendSystemMsg('  创建者: #' + group.group.creator_id);
        return;
      }
    } catch {}

    this._appendSystemMsg('未找到 ID=' + id);
  }

  // --- WebSocket handlers ---

  _setupWsHandlers() {
    this.client.on('new_private_msg', (data) => {
      const msg = data.message;
      const time = msg.created_at ? msg.created_at.slice(11, 16) : '';
      const isCurrent = this.currentChatType === 'friend' &&
        (Number(msg.sender_id) === Number(this.currentChatId) || Number(msg.receiver_id) === Number(this.currentChatId));

      if (isCurrent) {
        const sender = Number(msg.sender_id) === Number(this.currentUser.id)
          ? '你' : (msg.sender_name || '#' + msg.sender_id);
        this._appendChatMsg(sender, msg.content, time, Number(msg.sender_id) === Number(this.currentUser.id));
      } else {
        this._appendSystemMsg('[私聊] ' + (msg.sender_name || '') + ': ' + msg.content);
      }
    });

    this.client.on('new_group_msg', (data) => {
      const msg = data.message;
      const time = msg.created_at ? msg.created_at.slice(11, 16) : '';
      const isCurrent = this.currentChatType === 'group' && Number(this.currentChatId) === Number(msg.group_id);

      if (isCurrent) {
        const sender = Number(msg.sender_id) === Number(this.currentUser.id)
          ? '你' : (msg.sender_name || '#' + msg.sender_id);
        this._appendChatMsg(sender, msg.content, time, Number(msg.sender_id) === Number(this.currentUser.id));
      } else {
        this._appendSystemMsg('[群聊#' + msg.group_id + '] ' + (msg.sender_name || '') + ': ' + msg.content);
      }
    });

    this.client.on('msg_recalled', () => {
      this._appendSystemMsg('[消息已撤回]');
    });

    this.client.on('friend_online', (data) => {
      this.onlineUsers.add(Number(data.userId));
      this._drawSidebar();
      this._drawStatusBar();
    });

    this.client.on('friend_offline', (data) => {
      this.onlineUsers.delete(Number(data.userId));
      this._drawSidebar();
      this._drawStatusBar();
    });

    this.client.on('online_users', (data) => {
      this.onlineUsers = new Set(data.userIds.map(Number));
      this._drawSidebar();
      this._drawStatusBar();
    });

    this.client.on('friend_request', () => {
      this._appendSystemMsg('[收到好友请求] 输入 /requests 查看, /accept <ID> 接受');
    });

    this.client.on('request_handled', () => {
      this._appendSystemMsg('[好友请求已处理]');
    });

    this.client.on('new_friend', async () => {
      try { this.friends = await this.client.getFriends(this.currentUser.id); } catch {}
      this._drawSidebar();
      this._appendSystemMsg('[新好友已添加]');
    });

    this.client.on('ws_close', () => {
      this._drawStatusBar();
    });
  }

  // --- Utilities ---

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _waitKey() {
    return new Promise((resolve) => {
      term.grabInput(true);
      term.once('key', () => {
        resolve();
      });
    });
  }

  _exit() {
    try { if (this.client) this.client.disconnect(); } catch {}
    term.styleReset();
    term.moveTo(0, this._screenH() - 1);
    term.eraseLine();
    term.fullscreen(false);
    process.exit(0);
  }
}

module.exports = TerminalUI;
