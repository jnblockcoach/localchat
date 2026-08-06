const termkit = require('terminal-kit');
const term = termkit.terminal;
const fs = require('fs');
const path = require('path');

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
    this._inMainScreen = false;
    this._loginCtrlCListener = null;
    this.contactIndex = 0;
    this.msgScroll = 0;
    this.pendingRequests = 0;
    this._reqList = [];
    this._reqIndex = 0;
    this._uiMode = 'select';       // select=选择栏导航, input=命令/消息输入, requests=好友请求视图, ai=AI助理视图
    this._selectStage = 'tab';     // tab=标签选择, list=列表选择
    this._aiStatus = null;
    this._aiPeersPending = [];
    this._gcFriends = [];
    this._gcIndex = 0;
    this._gcSelected = new Set();
    this._wsFiles = [];
    this._wsIndex = 0;
    this._wsView = false;   // false=AI主视图, true=workspace列表, 'content'=workspace内容
    this._initCommands();
    this._setupWsHandlers();
  }

  // --- Promisified terminal-kit helpers ---

  _menu(items, options = {}) {
    return new Promise((resolve) => {
      term.singleColumnMenu(items, Object.assign({ cancelable: true }, options), (err, resp) => {
        if (err || !resp || resp.canceled || resp.selectedIndex < 0) { resolve(-1); return; }
        resolve(resp.selectedIndex);
      });
    });
  }

  _input(options = {}) {
    return new Promise((resolve) => {
      term.grabInput(true);
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

    // 登录/注册界面窗口缩放时自动重绘（防抖），避免登录框错位
    this._resizeRefreshing = false;
    term.on('resize', () => {
      if (!this._inMainScreen && !this._resizeRefreshing) {
        this._resizeRefreshing = true;
        setTimeout(() => {
          this._resizeRefreshing = false;
          this._loginFlow();
        }, 200);
      }
    });

    await this._loginFlow();
  }

  // --- Drawing utilities ---

  _drawFull() {
    term.bgDefaultColor();
    term.clear();
  }

  _screenW() {
    const w = term.width;
    return Number.isFinite(w) ? w : 80;
  }

  _screenH() {
    const h = term.height;
    return Number.isFinite(h) ? h : 24;
  }
  _sidebarW() { return Math.max(16, Math.floor(this._screenW() * 0.28)); }

  _put(x, y, text, color) {
    if (y < 0 || y >= this._screenH()) return;
    // 换行符会破坏全屏布局（多行消息/公告等），统一替换为空格
    text = String(text).replace(/\n/g, ' ').slice(0, this._screenW() - x);
    term.moveTo(x, y);
    if (color) {
      if (typeof color === 'object') {
        term.colorRgb(color.r, color.g, color.b, text);
      } else {
        // 支持链式样式如 'brightWhite.bgCyan'
        const chain = String(color).split('.');
        let fn = term;
        for (const p of chain) fn = fn[p];
        if (typeof fn === 'function') fn(text);
        else term(text);
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

  _enableCtrlCExit() {
    if (this._loginCtrlCListener) return;
    this._loginCtrlCListener = (name) => {
      if (name === 'CTRL_C') this._exit();
    };
    term.on('key', this._loginCtrlCListener);
  }

  _disableCtrlCExit() {
    if (this._loginCtrlCListener) {
      term.removeListener('key', this._loginCtrlCListener);
      this._loginCtrlCListener = null;
    }
  }

  async _loginFlow() {
    this.client.wsConnect();
    this._enableCtrlCExit();

    const CW = 56;
    const CH = 16;
    const cx = Math.max(0, Math.floor((this._screenW() - CW) / 2));
    const cy = Math.max(0, Math.floor((this._screenH() - CH) / 2));

    this._drawFull();
    this._box(cx, cy, CW, CH);

    this._put(cx + 2, cy + 1, ' LocalChat - 命令行客户端 ', 'brightCyan');
    this._put(cx + 2, cy + 2, '\u2500'.repeat(CW - 4), 'gray');

    let ipUsers = [];
    let serverOk = false;
    try {
      const res = await this.client.getUsersByIp();
      if (Array.isArray(res)) {
        serverOk = true;
        ipUsers = res;
        // 服务器连接成功，通知外层记住该地址（仅成功才保存，避免错误配置残留）
        if (this.onServerReachable) this.onServerReachable();
      }
    } catch {}
    this._ipUsers = ipUsers;

    // 服务器可达性：可达显示地址，不可达明确提示并提供恢复路径
    if (serverOk) {
      this._put(cx + 2, cy + 3, ' 服务器: ' + this.client.wsUrl, 'gray');
    } else {
      this._put(cx + 2, cy + 3, ' 服务器: ' + this.client.wsUrl + '  ⚠ 无法连接', 'red');
      this._put(cx + 2, cy + CH - 4, ' ⚠ 未检测到服务器：可扫描局域网或手动修改地址', 'yellow');
    }

    // 菜单固定项 6 个（3 基础 + 扫描 + 改地址 + 退出），账号项最多 4 个，避免菜单超高溢出
    const MAX_IP_USERS = 4;
    const shownUsers = ipUsers.slice(0, MAX_IP_USERS);
    if (ipUsers.length > MAX_IP_USERS) {
      this._put(cx + 2, cy + CH - 4, ' 本机共 ' + ipUsers.length + ' 个账号，此处显示前 ' + MAX_IP_USERS + ' 个，其余可用ID登录', 'yellow');
    }

    const items = [
      '1. 创建新账号',
      '2. 用ID登录',
      '3. 用昵称查找登录',
    ];
    for (const u of shownUsers) {
      const idLabel = u.is_ai ? (u.display_id || ('openclaw-' + u.ip + '-?')) : (u.ip + '-' + (u.ip_index || '?'));
      items.push('  登录 ' + u.username + ' (#' + u.id + ') [' + idLabel + ']');
    }
    items.push('4. 扫描局域网服务器');
    items.push('5. 修改服务器地址');
    items.push('Q. 退出');

    this._put(cx + 2, cy + CH - 2, ' 箭头选择, Enter 确认, ESC 退出', 'gray');

    const idx = await this._menu(items, {
      x: cx + 3,
      y: cy + 4,
      style: term.white,
      selectedStyle: term.brightWhite.bgCyan,
      itemMaxWidth: CW - 8,
      top: cy + 3,
      height: CH - 6,
    });

    // Ensure terminal is ready for next input
    term.grabInput(true);

    if (idx < 0 || idx === items.length - 1) {
      this._exit();
      return;
    }

    const accountStart = 3;
    const scanIdx = accountStart + shownUsers.length;
    const addrIdx = scanIdx + 1;

    if (idx === 0) {
      await this._doRegister(cx, cy, CW);
    } else if (idx === 1) {
      await this._doLoginById(cx, cy, CW);
    } else if (idx === 2) {
      await this._doLoginBySearch(cx, cy, CW);
    } else if (idx >= accountStart && idx < scanIdx) {
      await this._loginAs(shownUsers[idx - accountStart].id);
    } else if (idx === scanIdx) {
      await this._doScanServer();
    } else if (idx === addrIdx) {
      await this._doChangeServer();
    } else {
      await this._loginFlow();
    }
  }

  _clientPort() {
    const m = (this.client.baseUrl || '').match(/:(\d+)$/);
    return m ? parseInt(m[1]) : 3000;
  }

  // 扫描局域网中的 LocalChat 服务器并切换连接
  async _doScanServer() {
    this._drawFull();
    const x = Math.max(0, Math.floor(this._screenW() / 2) - 22);
    const y = Math.max(0, Math.floor(this._screenH() / 2) - 2);
    this._put(x, y, '正在扫描局域网 (子网 1-254 并行探测)...', 'brightCyan');
    this._put(x, y + 1, '端口: 3000 / ' + this._clientPort() + '  请稍候...', 'gray');

    let found = [];
    try {
      const { scanLocalServers } = require('./scan');
      found = await scanLocalServers({ ports: [3000, this._clientPort()] });
    } catch { found = []; }

    if (found.length === 0) {
      this._put(x, y + 3, '未发现局域网 LocalChat 服务器', 'yellow');
      this._put(x, y + 4, '请确认服务器已启动 (npm start)', 'gray');
      await this._sleep(2000);
      await this._loginFlow();
      return;
    }

    this._drawFull();
    this._put(x, y - 1, '发现 ' + found.length + ' 台服务器，选择连接 (ESC 返回):', 'brightCyan');
    this._put(x, y, '\u2500'.repeat(44), 'gray');
    const items = found.map((f) => '  ' + f.ip + ':' + f.port);
    const sel = await this._menu(items, {
      x: x + 2,
      y: y + 1,
      style: term.white,
      selectedStyle: term.brightWhite.bgCyan,
      itemMaxWidth: 44,
    });
    if (sel >= 0 && sel < found.length) {
      const srv = found[sel];
      this.client.setServer(srv.ip, srv.port);
      this._put(x, y + found.length + 3, '已切换到 ' + srv.ip + ':' + srv.port, 'green');
      await this._sleep(1000);
    }
    await this._loginFlow();
  }

  // 手动修改服务器地址
  async _doChangeServer() {
    this._drawFull();
    const CW = 56;
    const CH = 9;
    const cx = Math.max(0, Math.floor((this._screenW() - CW) / 2));
    const cy = Math.max(0, Math.floor((this._screenH() - CH) / 2));
    this._box(cx, cy, CW, CH);
    this._put(cx + 3, cy + 1, '修改服务器地址', 'brightCyan');
    this._put(cx + 3, cy + 2, '\u2500'.repeat(CW - 6), 'gray');
    this._put(cx + 3, cy + 4, '输入地址(如 192.168.1.5:3000):', 'white');
    this._put(cx + 3, cy + 6, 'ESC 返回', 'gray');

    const val = await this._input({ x: cx + 34, y: cy + 4, width: CW - 36, cancelable: true });
    if (!val || !val.trim()) { await this._loginFlow(); return; }

    let host = val.trim();
    let port = 3000;
    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      port = parseInt(parts[1]) || 3000;
    }
    this.client.setServer(host, port);
    this._put(cx + 3, cy + 7, '已切换至 ' + host + ':' + port + ' (连接成功后自动保存)', 'green');
    await this._sleep(1200);
    await this._loginFlow();
  }

  async _doRegister(cx, cy, CW) {
    this._drawFull();
    this._box(cx, cy, CW, 9);
    this._put(cx + 3, cy + 1, '创建新账号', 'brightCyan');
    this._put(cx + 3, cy + 2, '\u2500'.repeat(CW - 6), 'gray');
    this._put(cx + 3, cy + 4, '输入昵称:', 'white');
    this._put(cx + 3, cy + 6, 'ESC 返回', 'gray');

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

    this._put(cx + 3, cy + 7, '注册成功! 账号: ' + user.ip + '-' + (user.ip_index || '?') + '  ID: ' + user.id + '  进入聊天...', 'green');
    await this._sleep(2000);
    this._showMainScreen();
  }

  async _doLoginById(cx, cy, CW) {
    this._drawFull();
    this._box(cx, cy, CW, 9);
    this._put(cx + 3, cy + 1, '用ID登录', 'brightCyan');
    this._put(cx + 3, cy + 2, '\u2500'.repeat(CW - 6), 'gray');
    this._put(cx + 3, cy + 4, '输入ID:', 'white');
    this._put(cx + 3, cy + 6, 'ESC 返回', 'gray');

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
    this._put(cx + 3, cy + 6, 'ESC 返回', 'gray');

    const q = await this._input({
      x: cx + 14,
      y: cy + 4,
      width: CW - 16,
      cancelable: true,
    });
    if (!q || !q.trim()) { await this._loginFlow(); return; }

    const results = await this.client.searchUsers(q.trim());
    if (!Array.isArray(results) || results.length === 0) {
      this._put(cx + 3, cy + 7, '未找到匹配账号或服务器不可用', 'yellow');
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
    this._inMainScreen = true;
    this._disableCtrlCExit();
    this._uiMode = 'select';
    this._selectStage = 'tab';
    this._drawFull();
    this._drawLayout();
    this._startKeyHandler();
    // 进入主界面时检查待处理好友请求并提示
    this._refreshPendingCount();
    term.hideCursor(true);
  }

  // 查询并更新待处理好友请求数（驱动状态栏徽标与顶部横幅）
  async _refreshPendingCount() {
    try {
      const res = await this.client.getPendingRequests(this.currentUser.id);
      const n = Array.isArray(res) ? res.length : 0;
      if (n !== this.pendingRequests) {
        this.pendingRequests = n;
        // 请求视图模式由视图自身重绘，避免覆盖
        if (this._uiMode !== 'requests') {
          this._drawStatusBar();
          this._drawChatArea();
        }
      }
    } catch {}
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
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') return;
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
    // 超长昵称时填充宽度最小为 0，避免 repeat 负数崩溃
    const pad = Math.max(0, W - title.length - user.length - ctx.length);
    this._put(0, 0, title + user + ctx + ' '.repeat(pad), 'brightCyan');
    this._put(0, 1, '\u2500'.repeat(W), 'gray');
  }

  _drawSidebar() {
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') return;
    const W = this._sidebarW();
    const H = this._screenH();

    // Clear entire sidebar area + separator column
    for (let y = 2; y < H - 3; y++) {
      term.moveTo(0, y);
      term.eraseLine();
      term(' '.repeat(W + 1));
    }

    // Vertical separator
    for (let y = 2; y < H - 3; y++) {
      this._put(W, y, '\u2502', 'gray');
    }

    // Tab bar（选择模式时高亮当前阶段的选中标签）
    const tabHighlight = this._selectStage === 'tab' ? 'brightWhite.bgCyan' : 'brightWhite';
    this._put(1, 2,
      this.currentTab === 'friends' ? '[好友]' : ' 好友 ',
      this.currentTab === 'friends' ? tabHighlight : 'white');
    this._put(8, 2,
      this.currentTab === 'groups' ? '[群聊]' : ' 群聊 ',
      this.currentTab === 'groups' ? tabHighlight : 'white');

    // Separator under tabs
    this._put(0, 3, '\u2500'.repeat(W), 'gray');

    const items = this.currentTab === 'friends' ? this.friends : this.groups;
    const maxItems = H - 7;

    if (this.contactIndex >= items.length) this.contactIndex = Math.max(0, items.length - 1);
    if (this.contactIndex < 0) this.contactIndex = 0;

    for (let i = 0; i < Math.min(items.length, maxItems); i++) {
      const y = 4 + i;
      this._put(0, y, ' '.repeat(W), 'white');
      const prefix = i === this.contactIndex ? '>' : ' ';
      // 列表阶段：选中项反色高亮
      const itemStyle = i === this.contactIndex && this._selectStage === 'list'
        ? 'brightWhite.bgBlue'
        : i === this.contactIndex ? 'brightWhite' : 'white';

      if (this.currentTab === 'friends') {
        const online = this.onlineUsers.has(Number(items[i].id));
        const dot = online ? '●' : '○';
        const dotColor = online ? 'green' : 'gray';
        this._put(1, y, prefix, 'brightCyan');
        this._put(3, y, dot, dotColor);
        this._put(5, y, items[i].username, itemStyle);
      } else {
        const g = items[i];
        this._put(1, y, prefix + ' ' + g.name, itemStyle);
        this._put(g.name.length + 4, y, '(' + g.member_count + ')', 'gray');
      }
    }

    // 绘制完成后把光标移回输入栏，避免停在侧栏文字后面
    this._setCursorToInput();
  }

  _drawChatArea() {
    const W = this._screenW();
    const sideW = this._sidebarW();
    const chatW = W - sideW - 1;
    const H = this._screenH();

    for (let y = 2; y < H - 3; y++) {
      this._put(sideW + 1, y, ' '.repeat(Math.max(0, chatW - 1)));
    }

    // 顶部横幅：常驻显示好友请求入口（N=0 灰色，N>0 黄色）
    const startY = 3;
    if (this.pendingRequests > 0) {
      this._put(sideW + 2, 2, '📩 收到 ' + this.pendingRequests + ' 条好友请求  [R]查看详情', 'yellow');
    } else {
      this._put(sideW + 2, 2, '📩 好友请求: 0  [R]查看', 'gray');
    }

    if (this.currentChatType && this.currentChatId) {
      const visible = this.chatMessages.slice(-(H - 6));
      for (let i = 0; i < visible.length; i++) {
        const y = startY + i;
        if (y >= H - 4) break;
        const msg = visible[i];
        const text = msg.text.slice(0, Math.max(1, chatW - 2));
        this._put(sideW + 2, y, text, msg.color || 'white');
      }
    } else if (this.chatMessages.length > 0) {
      const visible = this.chatMessages.slice(-(H - 6));
      for (let i = 0; i < visible.length; i++) {
        const y = startY + i;
        if (y >= H - 4) break;
        const msg = visible[i];
        const text = msg.text.slice(0, Math.max(1, chatW - 2));
        this._put(sideW + 2, y, text, msg.color || 'white');
      }
    } else {
      this._put(sideW + 2, Math.floor(H / 2) - 1, '选择好友或群聊开始聊天', 'gray');
      this._put(sideW + 2, Math.floor(H / 2), '/msg <ID>  打开私聊', 'gray');
      this._put(sideW + 2, Math.floor(H / 2) + 1, '/groupmsg <ID>  打开群聊', 'gray');
    }
  }

  _drawInputBar() {
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') return;
    const H = this._screenH();
    const W = this._screenW();

    this._eraseLine(H - 2);
    this._put(0, H - 2, '\u2500'.repeat(W), 'gray');
    this._eraseLine(H - 1);

    if (this._uiMode === 'select') {
      // 选择模式：仅提示按 H 查看快捷键
      if (this._selectStage === 'list') {
        const items = this.currentTab === 'friends' ? this.friends : this.groups;
        if (items.length === 0) {
          this._put(1, H - 1, (this.currentTab === 'friends' ? '暂无好友 ' : '暂无群聊 ') + '按 H 查看快捷键', 'yellow');
          return;
        }
      }
      this._put(1, H - 1, '按 H 查看快捷键', 'gray');
    } else {
      this._put(1, H - 1, '> ' + this.inputBuffer, 'white');
    }
  }

  _drawStatusBar() {
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') return;
    const H = this._screenH();
    if (H <= 3) return;
    const online = this.onlineUsers.size;
    const conn = this.client.ws && this.client.ws.readyState === 1;
    this._eraseLine(H - 3);
    this._put(0, H - 3, ' '.repeat(this._screenW()));
    let info = '在线:' + online + '  ' + (conn ? '●已连接' : '○断开');
    if (this.pendingRequests > 0) {
      info += '  📩请求:' + this.pendingRequests;
    }
    info += this._uiMode === 'select'
      ? '  [选择] 按 H 查看快捷键'
      : '  [输入] 按 H 查看快捷键';
    this._put(1, H - 3, info, this.pendingRequests > 0 ? 'yellow' : 'gray');

    // 绘制完成后把光标移回输入栏，避免停在状态栏文字后面
    this._setCursorToInput();
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
    // 视图模式（好友请求/AI助理）：只入缓冲区，不重绘主界面（避免破坏视图）
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') return;
    this._drawChatArea();
    this._drawInputBar();
    this._setCursorToInput();
  }

  _appendSystemMsg(content) {
    this.chatMessages.push({ text: content, color: 'gray' });
    if (this.chatMessages.length > 500) this.chatMessages = this.chatMessages.slice(-500);
    // 视图模式（好友请求/AI助理）：只入缓冲区，不重绘主界面（避免破坏视图）
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') return;
    this._drawChatArea();
    this._drawInputBar();
    this._setCursorToInput();
  }

  _appendErrorMsg(content) {
    this.chatMessages.push({ text: content, color: 'red' });
    if (this.chatMessages.length > 500) this.chatMessages = this.chatMessages.slice(-500);
    // 视图模式（好友请求/AI助理）：只入缓冲区，不重绘主界面（避免破坏视图）
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') return;
    this._drawChatArea();
    this._drawInputBar();
    this._setCursorToInput();
  }

  // --- Key handling ---

  // 好友请求详情视图：打开时拉取最新请求列表
  async _showRequestsView() {
    try {
      const res = await this.client.getPendingRequests(this.currentUser.id);
      this._reqList = Array.isArray(res) ? res : [];
    } catch { this._reqList = []; }
    // 加载 OpenClaw 互联请求（与好友请求同等级展示）
    try {
      const pres = await this.client.getAiPeers();
      this._aiPeersPending = (pres && Array.isArray(pres.peers)) ? pres.peers.filter((p) => p.status === 'pending') : [];
    } catch { this._aiPeersPending = []; }
    this._reqIndex = 0;
    this._uiMode = 'requests';
    term.hideCursor(true);
    this._renderRequestsView();
  }

  _renderRequestsView(errMsg) {
    this._drawFull();
    const W = this._screenW();
    const H = this._screenH();
    const cx = Math.max(0, Math.floor((W - 56) / 2));
    const cy = Math.max(0, Math.floor((H - 14) / 2));
    this._box(cx, cy, 56, 14);
    this._put(cx + 2, cy + 1, ' 好友请求 (' + this._reqList.length + ')   [Y]接受 [N]拒绝 [ESC]返回', 'brightCyan');
    this._put(cx + 2, cy + 2, '\u2500'.repeat(52), 'gray');

    const peers = this._aiPeersPending || [];
    if (this._reqList.length === 0 && peers.length === 0) {
      this._put(cx + 2, cy + 4, ' 暂无好友请求/互联请求，按 ESC 返回', 'gray');
    } else {
      let py = cy + 3;
      if (peers.length > 0) {
        this._put(cx + 2, py, ' ── OpenClaw 互联请求 ──', 'brightCyan');
        py++;
        for (const p of peers) {
          const style = 'white';
          this._put(cx + 2, py, ' 📡 机器 ' + p.ip + ' 请求互联 OpenClaw', style);
          py++;
        }
        this._put(cx + 2, py, '   Y 同意互联（无法拒绝，只能忽略）', 'gray');
        py++;
      }
      for (let i = 0; i < Math.min(this._reqList.length, 9); i++) {
        const r = this._reqList[i];
        const y = cy + 3 + i;
        const style = i === this._reqIndex ? 'brightWhite.bgBlue' : 'white';
        this._put(cx + 2, y, '  #' + r.id + ' ' + r.username + ' (' + (r.ip || '') + ')', style);
      }
    }
    this._put(cx + 2, cy + 13, errMsg ? '⚠ ' + errMsg : ' 上下键选择  Y接受  N拒绝  ESC返回', errMsg ? 'red' : 'gray');
  }

  // 请求视图按键：↑↓选择，Y接受，N拒绝，ESC返回
  async _handleRequestsKey(name) {
    if (name === 'UP') {
      if (this._reqIndex > 0) { this._reqIndex--; this._renderRequestsView(); }
      return;
    }

    if (name === 'DOWN') {
      if (this._reqIndex < this._reqList.length - 1) { this._reqIndex++; this._renderRequestsView(); }
      return;
    }

    if (name === 'Y' || name === 'y') {
      // 无好友请求时，处理互联请求
      if (this._reqList.length === 0 && this._aiPeersPending && this._aiPeersPending.length > 0) {
        const peer = this._aiPeersPending[0];
        const result = await this.client.acceptAiPeer(peer.ip, this.currentUser.id);
        if (result.error) { this._renderRequestsView(result.error); return; }
        await this._showRequestsView();
        this._appendSystemMsg('✓ 已同意与 ' + peer.ip + ' 的 OpenClaw 互联');
        return;
      }
      const r = this._reqList[this._reqIndex];
      if (!r) return;
      await this._doAcceptFriend(r.id);
      await this._refreshReqList();
      return;
    }

    if (name === 'N' || name === 'n') {
      // 互联请求无法拒绝（只能不管）；N 仅用于拒绝普通好友请求
      const r = this._reqList[this._reqIndex];
      if (!r) return;
      const result = await this.client.rejectFriend(this.currentUser.id, r.id);
      if (result.error) {
        this._renderRequestsView('拒绝失败: ' + result.error);
      } else {
        await this._refreshReqList();
      }
      return;
    }
  }

  // AI 助理视图：查询本机 OpenClaw 与已注册的 AI 账号
  async _showAiView() {
    try {
      const res = await this.client.getAiStatus(this.currentUser ? this.currentUser.id : null);
      this._aiStatus = res;
    } catch {
      this._aiStatus = { openclaw: { running: false }, account: null };
    }
    this._uiMode = 'ai';
    term.hideCursor(true);
    this._renderAiView();
  }

  _renderAiView(errMsg) {
    this._drawFull();
    const W = this._screenW();
    const H = this._screenH();
    const cx = Math.max(0, Math.floor((W - 56) / 2));
    const cy = Math.max(0, Math.floor((H - 14) / 2));
    this._box(cx, cy, 56, 14);
    this._put(cx + 2, cy + 1, ' AI 助理   [Enter]注册  [V]Workspace  [I]互联  [ESC]返回', 'brightCyan');
    this._put(cx + 2, cy + 2, '\u2500'.repeat(52), 'gray');

    const st = this._aiStatus || {};
    const oc = st.openclaw || {};
    const acc = st.account || null;

    this._put(cx + 2, cy + 4, ' 本机 OpenClaw: ' + (oc.running ? '● 运行中' : '○ 未检测到'), oc.running ? 'green' : 'red');
    if (acc) {
      const idLabel = acc.display_id || ('openclaw-' + acc.ip + '-?');
      this._put(cx + 2, cy + 5, ' 已注册 AI 助理: ' + acc.username + ' [' + idLabel + ']', 'yellow');
    } else {
      this._put(cx + 2, cy + 5, ' 未注册 AI 助理', 'gray');
    }
    if (oc.running && !acc) {
      this._put(cx + 2, cy + 7, ' 按 Enter 注册（输入名称，注册后自动加为好友）', 'gray');
    }
    if (acc) {
      this._put(cx + 2, cy + 7, ' V 查看Workspace   I 互联其他机器 OpenClaw', 'gray');
    }
    this._put(cx + 2, cy + 13, errMsg ? '⚠ ' + errMsg : ' 按 Enter 注册  V Workspace  I 互联  ESC 返回', errMsg ? 'red' : 'gray');
  }

  // Workspace 视图：文件列表 / 内容
  _renderWsView(errMsg) {
    this._drawFull();
    const W = this._screenW();
    const H = this._screenH();
    const cx = Math.max(0, Math.floor((W - 56) / 2));
    const cy = Math.max(0, Math.floor((H - 14) / 2));
    this._box(cx, cy, 56, 14);
    this._put(cx + 2, cy + 1, ' AI Workspace (本机)   ↑↓选择  Enter查看  B返回列表  ESC返回', 'brightCyan');
    this._put(cx + 2, cy + 2, '\u2500'.repeat(52), 'gray');

    if (this._wsView === 'content') {
      const file = this._wsFiles[this._wsIndex];
      const content = this._wsContent || '';
      this._put(cx + 2, cy + 3, ' ' + (file ? file.name : '') + ':', 'white');
      const lines = content.split('\n');
      for (let i = 0; i < Math.min(lines.length, 9); i++) {
        this._put(cx + 2, cy + 4 + i, ' ' + lines[i].slice(0, 52), 'gray');
      }
      if (lines.length > 9) this._put(cx + 2, cy + 13, ' … 共 ' + lines.length + ' 行', 'gray');
    } else {
      if (this._wsFiles.length === 0) {
        this._put(cx + 2, cy + 4, ' Workspace 为空或不可读', 'gray');
      } else {
        for (let i = 0; i < Math.min(this._wsFiles.length, 9); i++) {
          const f = this._wsFiles[i];
          const y = cy + 3 + i;
          const style = i === this._wsIndex ? 'brightWhite.bgBlue' : 'white';
          this._put(cx + 2, y, ' ' + f.name + '  (' + (f.size / 1024).toFixed(1) + 'KB)', style);
        }
      }
    }
    this._put(cx + 2, cy + 13, errMsg ? '⚠ ' + errMsg : (this._wsView === 'content' ? ' B 返回列表  ESC 返回' : ' ↑↓选择  Enter 查看  ESC 返回'), errMsg ? 'red' : 'gray');
  }

  // 加载 workspace 文件列表
  async _loadWsFiles() {
    let errMsg;
    try {
      const res = await this.client.getAiWorkspace(null, this.currentUser ? this.currentUser.id : null);
      this._wsFiles = (res && Array.isArray(res.files)) ? res.files : [];
      this._wsIndex = 0;
      if (res && res.error) errMsg = res.error;
    } catch {
      this._wsFiles = [];
    }
    this._wsView = 'list';
    this._wsContent = '';
    this._renderWsView(errMsg);
  }

  // Workspace 按键：↑↓选择，Enter 查看，B 返回列表，ESC 返回 AI 视图
  async _handleWsKey(name) {
    if (this._wsView === 'content') {
      if (name === 'B' || name === 'b') {
        this._wsView = 'list';
        this._renderWsView();
      }
      return;
    }
    if (name === 'UP') {
      if (this._wsIndex > 0) { this._wsIndex--; this._renderWsView(); }
      return;
    }
    if (name === 'DOWN') {
      if (this._wsIndex < this._wsFiles.length - 1) { this._wsIndex++; this._renderWsView(); }
      return;
    }
    if (name === 'ENTER') {
      const f = this._wsFiles[this._wsIndex];
      if (!f) return;
      try {
        const res = await this.client.getAiWorkspace(f.name, this.currentUser ? this.currentUser.id : null);
        if (res.error) { this._renderWsView(res.error); return; }
        this._wsContent = res.content || '';
        this._wsView = 'content';
        this._renderWsView();
      } catch {
        this._renderWsView('读取失败');
      }
      return;
    }
  }

  // AI 视图按键：Enter 注册流程，V 查看 Workspace，ESC 返回
  async _handleAiKey(name) {
    if (this._wsView) {
      await this._handleWsKey(name);
      return;
    }
    if (name === 'V' || name === 'v') {
      const st = this._aiStatus || {};
      if (!st.account) {
        this._renderAiView('请先注册 AI 助理');
        return;
      }
      await this._loadWsFiles();
      return;
    }
    if (name === 'I' || name === 'i') {
      // 机器互联：输入目标机器 IP
      const W = this._screenW();
      const H = this._screenH();
      const cx = Math.max(0, Math.floor((W - 56) / 2));
      const cy = Math.max(0, Math.floor((H - 14) / 2));
      this._put(cx + 2, cy + 9, ' 输入目标机器 IP:', 'white');
      const ip = await this._input({ x: cx + 20, y: cy + 9, width: 30, cancelable: true });
      if (!ip || !ip.trim()) { this._renderAiView(); return; }
      const res = await this.client.interconnectOpenClaw(ip.trim());
      this._renderAiView(res.error ? res.error : (res.message || '请求已发送'));
      return;
    }
    if (name === 'ENTER') {
      const st = this._aiStatus || {};
      const oc = st.openclaw || {};
      if (!oc.running) {
        this._renderAiView('未检测到本机 OpenClaw，请先启动 OpenClaw gateway');
        return;
      }
      if (st.account) {
        const idLabel = st.account.display_id || ('openclaw-' + st.account.ip + '-?');
        this._renderAiView('AI 助理已注册：' + st.account.username + ' [' + idLabel + ']');
        return;
      }
      const W = this._screenW();
      const H = this._screenH();
      const cx = Math.max(0, Math.floor((W - 56) / 2));
      const cy = Math.max(0, Math.floor((H - 14) / 2));
      this._put(cx + 2, cy + 9, ' 输入名称:', 'white');
      const val = await this._input({ x: cx + 13, y: cy + 9, width: 36, cancelable: true });
      if (!val || !val.trim()) { this._renderAiView(); return; }
      const res = await this.client.registerAi(val.trim(), this.currentUser ? this.currentUser.id : null);
      if (res.error) {
        this._renderAiView('注册失败: ' + res.error);
        return;
      }
      this._aiStatus = { openclaw: { running: true }, account: res.user };
      const idLabel = res.user.display_id || ('openclaw-' + res.user.ip + '-?');
      this._renderAiView('✓ AI 助理已注册：' + res.user.username + ' [' + idLabel + ']');
      // 注册后自动加为好友，刷新列表
      this._refreshFriendsList();
      return;
    }
    // ESC 由 _doEsc 统一处理
  }

  // 创建群聊视图：列出好友，↑↓选择，Enter 选中/撤销，C 确认创建
  async _showGroupCreateView() {
    try {
      const res = await this.client.getFriends(this.currentUser.id);
      this._gcFriends = Array.isArray(res) ? res : [];
    } catch { this._gcFriends = []; }
    this._gcIndex = 0;
    this._gcSelected = new Set();
    this._uiMode = 'groupcreate';
    term.hideCursor(true);
    this._renderGroupCreateView();
  }

  _renderGroupCreateView(errMsg) {
    this._drawFull();
    const W = this._screenW();
    const H = this._screenH();
    const cx = Math.max(0, Math.floor((W - 56) / 2));
    const cy = Math.max(0, Math.floor((H - 14) / 2));
    this._box(cx, cy, 56, 14);
    this._put(cx + 2, cy + 1, ' 创建群聊   ↑↓选择  Enter选中/撤销  C确认创建  ESC返回', 'brightCyan');
    this._put(cx + 2, cy + 2, '\u2500'.repeat(52), 'gray');

    if (this._gcFriends.length === 0) {
      this._put(cx + 2, cy + 4, ' 暂无好友，请先添加好友', 'yellow');
    } else {
      for (let i = 0; i < Math.min(this._gcFriends.length, 8); i++) {
        const f = this._gcFriends[i];
        const y = cy + 3 + i;
        const checked = this._gcSelected.has(Number(f.id)) ? '✓' : ' ';
        const style = i === this._gcIndex ? 'brightWhite.bgBlue' : 'white';
        this._put(cx + 2, y, ' [' + checked + '] ' + f.username + ' (#' + f.id + ')', style);
      }
      if (this._gcFriends.length > 8) this._put(cx + 2, cy + 11, ' … 共 ' + this._gcFriends.length + ' 位好友', 'gray');
    }
    const tip = ' 已选 ' + this._gcSelected.size + ' 人，按 C 创建群聊';
    this._put(cx + 2, cy + 13, errMsg ? '⚠ ' + errMsg : tip, errMsg ? 'red' : 'gray');
  }

  async _handleGroupCreateKey(name) {
    if (name === 'UP') {
      if (this._gcIndex > 0) { this._gcIndex--; this._renderGroupCreateView(); }
      return;
    }
    if (name === 'DOWN') {
      if (this._gcIndex < this._gcFriends.length - 1) { this._gcIndex++; this._renderGroupCreateView(); }
      return;
    }
    if (name === 'ENTER') {
      const f = this._gcFriends[this._gcIndex];
      if (!f) return;
      const id = Number(f.id);
      if (this._gcSelected.has(id)) this._gcSelected.delete(id);
      else this._gcSelected.add(id);
      this._renderGroupCreateView();
      return;
    }
    if (name === 'C' || name === 'c') {
      if (this._gcSelected.size === 0) {
        this._renderGroupCreateView('请至少选中一位好友');
        return;
      }
      // 输入群名
      const W = this._screenW();
      const H = this._screenH();
      const cx = Math.max(0, Math.floor((W - 56) / 2));
      const cy = Math.max(0, Math.floor((H - 14) / 2));
      this._put(cx + 2, cy + 11, ' 输入群名称:', 'white');
      const name = await this._input({ x: cx + 15, y: cy + 11, width: 36, cancelable: true });
      if (!name || !name.trim()) { this._renderGroupCreateView(); return; }
      const memberIds = Array.from(this._gcSelected);
      const res = await this.client.createGroup(name.trim(), this.currentUser.id, memberIds);
      if (res.error) {
        this._renderGroupCreateView('创建失败: ' + res.error);
        return;
      }
      this._uiMode = 'select';
      this._drawFull();
      this._drawLayout();
      this._appendSystemMsg('✓ 群聊已创建: #' + res.group.id + ' ' + res.group.name + '（' + memberIds.length + ' 位成员）');
      this._refreshFriendsList();
      return;
    }
    // ESC 由 _doEsc 统一处理
  }

  // 快捷键列表视图
  _showHelpView() {
    this._uiMode = 'help';
    this._drawFull();
    const W = this._screenW();
    const H = this._screenH();
    const cx = Math.max(0, Math.floor((W - 56) / 2));
    const cy = Math.max(0, Math.floor((H - 16) / 2));
    this._box(cx, cy, 56, 16);
    this._put(cx + 2, cy + 1, ' 快捷键列表   ESC 返回', 'brightCyan');
    this._put(cx + 2, cy + 2, '\u2500'.repeat(52), 'gray');
    const keys = [
      '← →         切换 好友/群聊 标签',
      '↑ ↓        列表中选择',
      'Enter       确认 / 进入聊天 / 选中',
      'Ctrl+E      输入命令',
      'ESC         返回 / 退出',
      'R           好友请求',
      'W           AI 助理（注册/Workspace）',
      'G           创建群聊',
      'H           本快捷键列表',
      'Ctrl+C      退出程序',
    ];
    for (let i = 0; i < keys.length; i++) {
      this._put(cx + 2, cy + 3 + i, ' ' + keys[i], 'white');
    }
    this._put(cx + 2, cy + 14, ' 命令: /help 查看全部斜杠命令', 'gray');
    term.hideCursor(true);
  }

  // 请求处理后刷新列表与好友
  async _refreshReqList() {
    try {
      const res = await this.client.getPendingRequests(this.currentUser.id);
      this._reqList = Array.isArray(res) ? res : [];
    } catch { this._reqList = []; }
    if (this._reqIndex >= this._reqList.length) this._reqIndex = Math.max(0, this._reqList.length - 1);
    this._refreshPendingCount();
    try { this.friends = await this.client.getFriends(this.currentUser.id); } catch {}
    this._renderRequestsView();
  }

  // 选择模式按键：←→ 切换标签，Enter 确认后 ↑↓ 列表导航，Enter 进入聊天
  _handleSelectKey(name) {
    // R: 打开好友请求详情视图（顶部横幅有标注）
    if (name === 'R' || name === 'r') {
      this._showRequestsView();
      return;
    }

    // W: 打开 AI 助理注册视图
    if (name === 'W' || name === 'w') {
      this._showAiView();
      return;
    }

    // G: 打开创建群聊视图
    if (name === 'G' || name === 'g') {
      this._showGroupCreateView();
      return;
    }

    // H: 打开快捷键列表
    if (name === 'H' || name === 'h') {
      this._showHelpView();
      return;
    }

    if (name === 'LEFT' || name === 'RIGHT' || name === 'TAB') {
      this.currentTab = this.currentTab === 'friends' ? 'groups' : 'friends';
      this.contactIndex = 0;
      this._selectStage = 'tab';
      this._drawSidebar();
      this._drawInputBar();
      return;
    }

    if (this._selectStage === 'tab') {
      if (name === 'ENTER') {
        this._selectStage = 'list';
        this._drawSidebar();
        this._drawInputBar();
      }
      return;
    }

    // list 阶段
    if (name === 'UP') {
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
      const items = this.currentTab === 'friends' ? this.friends : this.groups;
      const type = this.currentTab === 'friends' ? 'friend' : 'group';
      if (items.length > 0 && this.contactIndex < items.length) {
        const item = items[this.contactIndex];
        this.currentChatType = type;
        this.currentChatId = item.id;
        this.chatMessages = [];
        this._loadChatHistory(type, item.id);
        this._uiMode = 'input';
        this._drawStatusBar();
        this._drawHeader();
        this._drawChatArea();
        this._drawInputBar();
        this._setCursorToInput();
        term.hideCursor(false);
      }
      return;
    }
  }

  // ESC 功能本体（普通 ESC 触发，或拆散序列判定失败后执行）
  _doEsc() {
    if (this._uiMode === 'requests' || this._uiMode === 'ai' || this._uiMode === 'groupcreate' || this._uiMode === 'help') {
      // AI 视图的 workspace 子视图：ESC 先回 AI 视图（L1）
      if (this._uiMode === 'ai' && this._wsView) {
        this._wsView = false;
        this._renderAiView();
        return;
      }
      // 其他视图：返回主界面并完整重绘（侧栏/聊天区/横幅）
      this._uiMode = 'select';
      this._drawFull();
      this._drawLayout();
      term.hideCursor(true);
      return;
    }

    if (this._uiMode === 'select') {
      // 选择模式：列表阶段返回标签阶段
      if (this._selectStage === 'list') {
        this._selectStage = 'tab';
        this._drawSidebar();
        this._drawInputBar();
      }
      return;
    }

    if (this.inputBuffer.length > 0) {
      // 清空输入
      this.inputBuffer = '';
      this._drawInputBar();
      this._setCursorToInput();
    } else if (this.currentChatType && this.currentChatId) {
      // 退出当前对话，回到选择模式（列表阶段，可继续上下选择）
      this.currentChatType = null;
      this.currentChatId = null;
      this.chatMessages = [];
      this._uiMode = 'select';
      this._selectStage = 'list';
      this._drawStatusBar();
      this._drawHeader();
      this._drawChatArea();
      this._drawInputBar();
      term.hideCursor(true);
    } else {
      // 无对话无输入：回到选择模式
      this._uiMode = 'select';
      this._drawStatusBar();
      this._drawInputBar();
      term.hideCursor(true);
    }
  }

  // 切换到命令/输入模式（Ctrl+E）
  _enterInputMode() {
    if (this._uiMode === 'input') return;
    this._uiMode = 'input';
    // 确保侧栏完整渲染（防御任何残留状态）
    this._drawSidebar();
    this._drawStatusBar();
    this._drawInputBar();
    this._setCursorToInput();
    term.hideCursor(false);
  }

  _startKeyHandler() {
    if (this._keyStarted) return;
    this._keyStarted = true;
    term.grabInput(true);
    term.on('key', (name, matches, data) => {
      if (name === 'CTRL_C') { this._exit(); return; }

      // Ctrl+E: 从选择模式进入命令/输入模式（视图模式下忽略，避免界面冻结）
      if (name === 'CTRL_E') {
        if (this._uiMode === 'select') this._enterInputMode();
        return;
      }

      // ESC: 退出命令模式 / 退出当前对话 / 逐级返回
      if (name === 'ESCAPE') {
        this._doEsc();
        return;
      }

      // 好友请求视图：↑↓选择  Y接受 N拒绝  ESC返回
      if (this._uiMode === 'requests') {
        this._handleRequestsKey(name);
        return;
      }

      // AI 助理视图：Enter 注册  ESC返回
      if (this._uiMode === 'ai') {
        this._handleAiKey(name);
        return;
      }

      // 创建群聊视图：↑↓选择 Enter选中/撤销 C确认 ESC返回
      if (this._uiMode === 'groupcreate') {
        this._handleGroupCreateKey(name);
        return;
      }

      // 快捷键列表视图
      if (this._uiMode === 'help') {
        if (name === 'ESCAPE' || name === 'H' || name === 'h') {
          this._uiMode = 'select';
          this._drawFull();
          this._drawLayout();
          term.hideCursor(true);
        }
        return;
      }

      // 选择模式：方向键/Enter 导航，不处理字符输入
      if (this._uiMode === 'select') {
        this._handleSelectKey(name);
        return;
      }

      // ===== 输入模式（聊天消息 / 斜杠命令）=====

      if (name === 'ENTER') {
        if (this.inputBuffer.trim()) {
          this._submitInput();
        } else {
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

      // Printable characters (including Chinese, Unicode)
      if (data) {
        const controlKeys = ['ENTER', 'BACKSPACE', 'DELETE', 'TAB', 'ESCAPE',
          'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN',
          'CTRL_C', 'CTRL_E', 'CTRL_T', 'CTRL_R', 'CTRL_S', 'INSERT'];
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
      { name: '/unfriend <ID>',   desc: '删除好友' },
      { name: '/block <ID>',      desc: '拉黑用户' },
      { name: '/unblock <ID>',    desc: '取消拉黑' },
      { name: '/blocklist',       desc: '查看黑名单' },
      { name: '/rename <新昵称>', desc: '修改昵称' },
      { name: '/send <文件路径>', desc: '发送文件 (支持 md/txt/图片/音频/视频)' },
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
        this._appendSystemMsg('先选择聊天对象（←→选标签 Enter确认 ↑↓选人 Enter进入）或输入 /help 查看帮助');
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
        messages = await this.client.getPrivateHistory(this.currentUser.id, id, 50, this.currentUser.id);
      } else {
        messages = await this.client.getGroupHistory(id, 50, this.currentUser.id);
      }
      if (!Array.isArray(messages)) return;
      for (const msg of messages) {
        if (msg.status === 'recalled') {
          this._appendSystemMsg('[消息已撤回]');
        } else {
          const sender = Number(msg.sender_id) === Number(this.currentUser.id)
            ? '你'
            : (msg.sender_name || '#' + msg.sender_id);
          const time = this._fmtTime(msg.created_at);
          const text = msg.file_id
            ? '[文件] ' + ((msg.file && msg.file.original_name) || msg.content)
            : msg.content;
          this._appendChatMsg(sender, text, time, Number(msg.sender_id) === Number(this.currentUser.id));
        }
      }
    } catch {}
  }

  async _handleCommand(cmd) {
    const parts = cmd.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case 'help': {
        this._appendSystemMsg('── 可用命令 ──────────────────────────────');
        const maxLen = this._commands.length ? Math.max(...this._commands.map(c => c.name.length)) : 0;
        for (const cmd of this._commands) {
          this._appendSystemMsg('  ' + cmd.name + ' '.repeat(Math.max(0, maxLen - cmd.name.length + 2)) + cmd.desc);
        }
        break;
      }

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
          const res = await this.client.getOnlineUsers();
          const users = Array.isArray(res) ? res : [];
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

      case 'blocklist':
        await this._doShowBlocklist();
        break;

      case 'rename':
        if (parts.length < 2 || !parts[1].trim()) { this._appendSystemMsg('用法: /rename <新昵称>'); break; }
        await this._doRename(parts.slice(1).join(' '));
        break;

      case 'unfriend':
        if (parts.length < 2 || !parseInt(parts[1])) { this._appendSystemMsg('用法: /unfriend <用户ID>'); break; }
        await this._doUnfriend(parseInt(parts[1]));
        break;

      case 'send':
        if (parts.length < 2 || !parts[1].trim()) { this._appendSystemMsg('用法: /send <文件路径>'); break; }
        await this._doSendFile(parts.slice(1).join(' '));
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

      case 'ai':
        await this._showAiView();
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
      if (!Array.isArray(results) || results.length === 0) { this._appendSystemMsg('未找到匹配的用户'); return; }
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
      if (!Array.isArray(requests) || requests.length === 0) { this._appendSystemMsg('暂无好友请求'); this._refreshPendingCount(); return; }
      this._appendSystemMsg('--- 好友请求 (' + requests.length + ') ---');
      for (const r of requests) {
        this._appendSystemMsg('  #' + r.id + ' ' + r.username + ' (' + r.ip + ')  /accept ' + r.id);
      }
      this._refreshPendingCount();
    } catch { this._appendSystemMsg('获取失败'); }
  }

  async _doAcceptFriend(friendId) {
    try {
      const result = await this.client.acceptFriend(this.currentUser.id, friendId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已接受好友请求');
      try { this.friends = await this.client.getFriends(this.currentUser.id); } catch {}
      this._refreshPendingCount();
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

  async _doShowBlocklist() {
    try {
      const blocked = await this.client.getBlockedUsers(this.currentUser.id);
      if (!Array.isArray(blocked) || blocked.length === 0) { this._appendSystemMsg('黑名单为空'); return; }
      this._appendSystemMsg('--- 黑名单 (' + blocked.length + ') ---');
      for (const b of blocked) {
        this._appendSystemMsg('  #' + b.id + ' ' + b.username + ' (' + (b.ip || '') + ')  输入 /unblock ' + b.id + ' 取消拉黑');
      }
    } catch { this._appendSystemMsg('获取失败'); }
  }

  async _doRename(newName) {
    try {
      const result = await this.client.updateUsername(this.currentUser.id, newName);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this.currentUser = result;
      this.client.user = result;
      this._appendSystemMsg('昵称已修改为: ' + result.username);
      this._drawHeader();
    } catch { this._appendSystemMsg('修改失败'); }
  }

  async _doUnfriend(userId) {
    try {
      const result = await this.client.deleteFriend(this.currentUser.id, userId);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已删除好友 #' + userId);
      if (this.currentChatType === 'friend' && Number(this.currentChatId) === Number(userId)) {
        this.currentChatType = null;
        this.currentChatId = null;
        this.chatMessages = [];
        this._drawHeader();
        this._drawChatArea();
      }
      try { this.friends = await this.client.getFriends(this.currentUser.id); } catch {}
      this._drawSidebar();
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doSendFile(filePath) {
    if (!this.currentChatType || !this.currentChatId) {
      this._appendSystemMsg('请先选择聊天对象再发送文件');
      return;
    }

    const ALLOWED_EXTS = ['.md', '.txt', '.jpg', '.jpeg', '.png', '.bmp', '.wav', '.mp3', '.mp4'];
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      this._appendSystemMsg('不支持的文件格式: ' + (ext || '(无扩展名)') + ' (支持: ' + ALLOWED_EXTS.join(' ') + ')');
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) { this._appendSystemMsg('不是文件: ' + filePath); return; }
    } catch {
      this._appendSystemMsg('文件不存在: ' + filePath);
      return;
    }

    if (stat.size > 100 * 1024 * 1024) {
      this._appendSystemMsg('文件过大，上限 100MB');
      return;
    }

    const fileName = path.basename(filePath);
    this._appendSystemMsg('正在上传 ' + fileName + ' (' + (stat.size / 1024).toFixed(1) + ' KB) ...');
    try {
      const result = await this.client.uploadFile(filePath, this.currentUser.id);
      if (result.error) { this._appendSystemMsg('上传失败: ' + result.error); return; }

      const data = { fileId: result.file.id };
      if (this.currentChatType === 'friend') {
        data.receiverId = this.currentChatId;
      } else {
        data.groupId = this.currentChatId;
      }

      const ok = this.client.sendFileMsg(data);
      if (!ok) {
        this._appendSystemMsg('文件已上传但发送失败：连接已断开，请等待自动重连');
        return;
      }
      this._appendSystemMsg('文件已发送: ' + result.file.original_name);
    } catch (err) {
      this._appendSystemMsg('上传失败: ' + (err.message || err));
    }
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
      const result = await this.client.addGroupMember(groupId, userId, this.currentUser.id);
      if (result.error) { this._appendSystemMsg(result.error); return; }
      this._appendSystemMsg('已添加成员');
      try { this.groups = await this.client.getGroups(this.currentUser.id); } catch {}
    } catch { this._appendSystemMsg('操作失败'); }
  }

  async _doRemoveGroupMember(groupId, userId) {
    try {
      const result = await this.client.removeGroupMember(groupId, userId, this.currentUser.id);
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
        this._appendSystemMsg('  账号: ' + (user.ip || '--') + '-' + (user.ip_index || '?'));
        this._appendSystemMsg('  注册时间: ' + (user.created_at || '--'));
        return;
      }
    } catch {}

    try {
      const group = await this.client.getGroupInfo(id, this.currentUser.id);
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
      if (!this._inMainScreen) return;
      const msg = data.message;
      const time = this._fmtTime(msg.created_at);
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
      if (!this._inMainScreen) return;
      const msg = data.message;
      const time = this._fmtTime(msg.created_at);
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
      if (!this._inMainScreen) return;
      this._appendSystemMsg('[消息已撤回]');
    });

    this.client.on('new_file_msg', (data) => {
      if (!this._inMainScreen) return;
      const msg = data.message;
      const time = this._fmtTime(msg.created_at);
      const isGroup = msg.type === 'group';
      const isCurrent = isGroup
        ? this.currentChatType === 'group' && Number(this.currentChatId) === Number(msg.group_id)
        : this.currentChatType === 'friend' &&
          (Number(msg.sender_id) === Number(this.currentChatId) || Number(msg.receiver_id) === Number(this.currentChatId));

      const fileName = (msg.file && msg.file.original_name) || msg.content;
      const sender = Number(msg.sender_id) === Number(this.currentUser.id)
        ? '你' : (msg.sender_name || '#' + msg.sender_id);

      if (isCurrent) {
        this._appendChatMsg(sender, '[文件] ' + fileName, time, Number(msg.sender_id) === Number(this.currentUser.id));
      } else {
        const prefix = isGroup ? '[群聊#' + msg.group_id + '] ' : '[私聊] ';
        this._appendSystemMsg(prefix + sender + ' 发送了文件: ' + fileName);
      }
    });

    this.client.on('mention', (data) => {
      if (!this._inMainScreen) return;
      const from = data.from ? data.from.username : '';
      this._appendSystemMsg('[有人@你] ' + from + ' 在群聊#' + data.groupId + ' 提到了你');
    });

    this.client.on('ws_send_failed', () => {
      if (!this._inMainScreen) return;
      this._appendSystemMsg('发送失败：连接已断开，请等待自动重连');
    });

    // 被其他设备顶替登录：连接已关闭且不再重连
    this.client.on('kicked', () => {
      if (!this._inMainScreen) return;
      this._appendErrorMsg('⚠ 该账号已在其他设备登录，本连接已被关闭（按 Ctrl+C 退出后重新登录）');
    });

    // 断线重连成功：重新拉取当前对话历史，补偿断线期间错过的消息
    this.client.on('ws_open', () => {
      if (!this._inMainScreen) return;
      this._drawStatusBar();
      if (this.currentChatType && this.currentChatId) {
        this.chatMessages = [];
        this._loadChatHistory(this.currentChatType, this.currentChatId);
      }
    });

    // 服务器返回的业务错误（拉黑拒绝、非群成员、无效消息等）
    this.client.on('error', (data) => {
      if (!this._inMainScreen) return;
      this._appendErrorMsg('⚠ ' + ((data && data.message) || '服务器返回错误'));
    });

    this.client.on('friend_online', (data) => {
      this.onlineUsers.add(Number(data.userId));
      if (!this._inMainScreen) return;
      this._drawSidebar();
      this._drawStatusBar();
    });

    this.client.on('friend_offline', (data) => {
      this.onlineUsers.delete(Number(data.userId));
      if (!this._inMainScreen) return;
      this._drawSidebar();
      this._drawStatusBar();
    });

    this.client.on('online_users', (data) => {
      this.onlineUsers = new Set(data.userIds.map(Number));
      if (!this._inMainScreen) return;
      this._drawSidebar();
      this._drawStatusBar();
    });

    // OpenClaw 机器互联请求（实时提示，与好友请求同等级）
    this.client.on('openclaw_request', (data) => {
      if (!this._inMainScreen) return;
      const fromIp = (data && data.fromIp) || '';
      this._appendSystemMsg('📡 ' + fromIp + ' 请求互联 OpenClaw，按 R 查看并处理');
      if (this._uiMode === 'requests') this._showRequestsView();
    });

    this.client.on('openclaw_request_handled', (data) => {
      if (!this._inMainScreen) return;
      const targetIp = (data && data.targetIp) || '';
      const st = (data && data.status) || '';
      if (st === 'accepted') {
        this._appendSystemMsg('✓ 已确认与 ' + targetIp + ' 的 OpenClaw 互联（重启 gateway 后生效）');
      }
    });

    this.client.on('friend_request', () => {
      if (!this._inMainScreen) return;
      this.pendingRequests++;
      // 已在请求视图：刷新列表并重绘视图
      if (this._uiMode === 'requests') {
        this._showRequestsView();
        return;
      }
      this._drawStatusBar();
      this._appendSystemMsg('[收到好友请求] 输入 /requests 查看, /accept <ID> 接受');
    });

    this.client.on('request_handled', () => {
      if (!this._inMainScreen) return;
      this._refreshPendingCount();
      this._appendSystemMsg('[好友请求已处理]');
    });

    this.client.on('new_friend', async () => {
      if (!this._inMainScreen) return;
      try { this.friends = await this.client.getFriends(this.currentUser.id); } catch {}
      this._drawSidebar();
      this._refreshPendingCount();
      this._appendSystemMsg('[新好友已添加]');
    });

    // 好友关系被对方解除：实时提示并刷新列表
    this.client.on('friend_removed', (data) => {
      if (!this._inMainScreen) return;
      const who = (data && data.by && data.by.username) || (data && data.by && '#' + data.by.id) || '对方';
      this._appendErrorMsg('⚠ ' + who + ' 删除了好友关系');
      if (this.currentChatType === 'friend' && Number(this.currentChatId) === Number(data.by && data.by.id)) {
        this.currentChatType = null;
        this.currentChatId = null;
        this.chatMessages = [];
        this._drawHeader();
        this._drawChatArea();
      }
      this._refreshFriendsList();
    });

    this.client.on('ws_close', () => {
      if (!this._inMainScreen) return;
      this._drawStatusBar();
    });
  }

  // --- Utilities ---

  // 刷新好友/群聊列表（供事件处理器复用）
  async _refreshFriendsList() {
    try { this.friends = await this.client.getFriends(this.currentUser.id); } catch {}
    try { this.groups = await this.client.getGroups(this.currentUser.id); } catch {}
    this._drawSidebar();
  }

  // 服务器时间字段为 UTC，这里转换为本机本地时间显示（HH:MM）
  _fmtTime(createdAt) {
    if (!createdAt) return '';
    const d = new Date(createdAt + 'Z');
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

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
    this._disableCtrlCExit();
    try { if (this.client) this.client.disconnect(); } catch {}
    term.grabInput(false);
    term.fullscreen(false);
    term.styleReset();
    term.moveTo(0, term.height - 1);
    console.log('');
    process.exit(0);
  }
}

module.exports = TerminalUI;
