# LocalChat — 局域网即时通讯

基于 Node.js 的局域网即时通讯系统，支持 **网页版** 和 **命令行版**，满足桌面和终端的不同使用习惯。

## 功能

### 网页版
- **用户系统** — 注册/登录，多账号管理，用 ID 或昵称登录
- **好友系统** — 搜索用户、发送/接受好友请求、删除好友、拉黑/取消拉黑
- **实时私聊** — WebSocket 实时推送，消息历史（最近 100 条）
- **群聊** — 创建群聊、添加/移除成员、群公告、群管理员转让、群聊免打扰、删除群聊
- **消息撤回** — 发送后 2 分钟内可撤回
- **在线状态** — 实时显示好友在线/离线
- **在线主机** — 列出所有在线用户，一键发送好友请求
- **个人信息** — 点击头像查看 ID/IP/注册时间/在线状态
- **文件发送** — 支持图片/音频/视频/文本文件预览和下载
- **客户端缓存** — localStorage 缓存，去重，上限 100 条/会话，支持清除缓存
- **自动重连** — 断线 3 秒自动重连
- **响应式暗色主题** — 适配桌面与移动端

### 命令行版
- 全屏终端交互界面（`terminal-kit`），键盘导航
- 注册/登录（ID 登录、昵称查找、本机已有账号）
- 好友/群聊列表（方向键导航，Enter 选中）
- 实时收发消息，中文输入支持
- 所有群管功能：创建/删除/公告/免打扰/成员管理/转让
- 好友管理：搜索、添加、拉黑、接受请求
- 在线用户查看、个人/群聊信息查看
- 键盘快捷键：Tab 切换好友/群聊，方向键导航，Enter 选中/发送

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js 22+ |
| HTTP 服务 | Express |
| 实时通信 | ws (WebSocket) |
| 数据库 | SQLite (node:sqlite) |
| 网页前端 | 纯 HTML/CSS/JS |
| 命令行前端 | terminal-kit, chalk |

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务
npm start
```

服务默认监听 `3000` 端口，启动后会自动显示本机局域网 IP 地址，同局域网设备可通过 `http://<你的IP>:3000` 访问。

### 命令行客户端

```bash
# 在同项目目录下运行
npm run localchat

# 或安装为全局命令
npm link
localchat --server 192.168.1.100:3000

# 指定服务器
localchat --server 192.168.1.100
```

其他局域网用户访问 `http://<服务器IP>:3000/cli` 查看安装指引。

## 项目结构

```
localchat/
├── public/                  # 网页前端
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js           # REST API 封装
│       ├── app.js           # 主应用逻辑
│       ├── cache.js         # 客户端缓存
│       ├── ui.js            # DOM 渲染
│       └── ws.js            # WebSocket 客户端
├── cli/                     # 命令行客户端
│   ├── index.js             # 入口（已配置 bin）
│   ├── term.js              # 全屏终端 UI（terminal-kit）
│   ├── client.js            # HTTP + WebSocket 通信
│   ├── config.js            # 配置管理
│   └── package.json         # 独立为 npm 包
├── server/                  # 后端
│   ├── index.js             # Express + WS 入口
│   ├── db.js                # SQLite 初始化 + 迁移
│   ├── websocket.js         # WebSocket 事件处理
│   ├── logger.js            # 日志
│   ├── models/              # 数据模型
│   │   ├── user.js
│   │   ├── friend.js
│   │   ├── group.js         # 含公告/免打扰/转让管理
│   │   ├── message.js
│   │   ├── block.js
│   │   └── file.js
│   └── routes/              # API 路由
│       ├── user.js
│       ├── friend.js
│       ├── group.js
│       ├── message.js
│       ├── block.js
│       ├── file.js
│       └── cli.js           # CLI 安装指引页
├── data/                    # SQLite 数据库 + 上传文件
└── package.json
```
