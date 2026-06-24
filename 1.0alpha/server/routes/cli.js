const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const host = req.headers.host || 'localhost:3000';
  res.send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>安装 LocalChat CLI</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #e0e0e0; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
    h1 { color: #e94560; }
    code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; }
    pre { background: rgba(0,0,0,0.3); padding: 16px; border-radius: 8px; overflow-x: auto; }
    .step { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; margin: 16px 0; }
    .num { display:inline-block; background:#e94560; color:#fff; width:24px; height:24px; text-align:center; border-radius:50%; font-weight:700; margin-right:8px; }
  </style>
</head>
<body>
  <h1>LocalChat 命令行客户端</h1>
  <p>在本机电脑上安装 LocalChat CLI，即可在终端中聊天。</p>

  <div class="step">
    <div><span class="num">1</span> <strong>安装 Node.js</strong></div>
    <p>访问 <a href="https://nodejs.org" style="color:#4ade80" target="_blank">nodejs.org</a> 下载安装 LTS 版本。</p>
  </div>

  <div class="step">
    <div><span class="num">2</span> <strong>把项目复制到本机</strong></div>
    <p>从服务器所有者处获取项目文件夹，或通过共享/拷贝等方式得到整个项目。</p>
  </div>

  <div class="step">
    <div><span class="num">3</span> <strong>安装依赖并启动</strong></div>
    <p>在项目目录中打开终端，运行：</p>
    <pre>npm install</pre>
    <p>然后连接服务器：</p>
    <pre>npm run localchat -- --server ${host}</pre>
    <p style="font-size:13px;color:#888">或安装为全局命令（在任何目录下使用）：</p>
    <pre>npm link
localchat --server ${host}</pre>
  </div>

  <p style="color:#888;font-size:13px;text-align:center;margin-top:40px">服务器地址: ${host}</p>
</body>
</html>`);
});

module.exports = router;
