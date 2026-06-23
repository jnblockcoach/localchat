const MessageModel = require('./models/message');
const FileModel = require('./models/file');
const FriendModel = require('./models/friend');
const GroupModel = require('./models/group');
const UserModel = require('./models/user');
const BlockModel = require('./models/block');
const logger = require('./logger');

const clients = new Map();

function setupWebSocket(wss) {
  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info(`WS 新连接: ${clientIp}`);

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        logger.warn(`WS 无效消息格式: ${raw.toString().slice(0, 100)}`);
        return sendError(ws, '无效的消息格式');
      }

      logger.info(`WS ${clientIp} -> ${data.type}${data.userId ? ` (userId=${data.userId})` : ''}`);

      switch (data.type) {
        case 'auth':
          handleAuth(ws, data, clientIp);
          break;
        case 'private_msg':
          handlePrivateMsg(ws, data);
          break;
        case 'group_msg':
          handleGroupMsg(ws, data);
          break;
        case 'file_msg':
          handleFileMsg(ws, data);
          break;
        case 'recall':
          handleRecall(ws, data);
          break;
        default:
          logger.warn(`WS 未知消息类型: ${data.type}`);
          sendError(ws, `未知消息类型: ${data.type}`);
      }
    });

    ws.on('close', () => {
      const uid = ws.userId;
      if (uid) {
        const user = UserModel.findById(uid);
        if (user) {
          clients.delete(uid);
          logger.info(`WS 断开: userId=${uid} (${user.username})`);
          broadcastToFriends(uid, { type: 'friend_offline', userId: uid });
        }
      } else {
        logger.info(`WS 断开(未认证): ${clientIp}`);
      }
    });

    ws.on('error', (err) => {
      logger.error(`WS 错误: ${err.message}`);
    });
  });
}

function handleAuth(ws, data, clientIp) {
  const uid = parseInt(data.userId);
  if (!uid) return sendError(ws, '无效的用户ID');

  const user = UserModel.findById(uid);
  if (!user) return sendError(ws, '用户不存在');

  ws.userId = uid;
  clients.set(uid, ws);
  logger.info(`WS 认证成功: userId=${uid} username=${user.username} ip=${clientIp}`);

  ws.send(JSON.stringify({ type: 'authenticated', userId: uid }));

  broadcastToFriends(uid, { type: 'friend_online', userId: uid });
  logger.info(`WS 广播上线: userId=${uid}`);

  const onlineIds = Array.from(clients.keys());
  ws.send(JSON.stringify({ type: 'online_users', userIds: onlineIds }));
}

function handlePrivateMsg(ws, data) {
  const senderId = ws.userId;
  const { receiverId, content } = data;

  if (!senderId || !receiverId || !content || !content.trim()) {
    logger.warn(`WS 私聊参数不完整: senderId=${senderId} receiverId=${receiverId}`);
    return sendError(ws, '参数不完整');
  }

  if (BlockModel.isBlockedBy(senderId, receiverId)) {
    logger.warn(`WS 私聊被拉黑: senderId=${senderId} receiverId=${receiverId}`);
    return sendError(ws, '消息发送失败：对方已将你拉黑');
  }

  const msg = MessageModel.create({
    type: 'private',
    senderId,
    receiverId,
    content: content.trim(),
  });

  logger.info(`WS 私聊消息: from=${senderId} to=${receiverId} msgId=${msg.id}`);

  const payload = { type: 'new_private_msg', message: msg };

  const receiverWs = clients.get(Number(receiverId));
  if (receiverWs && receiverWs.readyState === 1) {
    receiverWs.send(JSON.stringify(payload));
    logger.info(`WS 私聊已送达: msgId=${msg.id} to=${receiverId}`);
  }

  ws.send(JSON.stringify(payload));
}

function handleGroupMsg(ws, data) {
  const senderId = ws.userId;
  const { groupId, content } = data;

  if (!senderId || !groupId || !content || !content.trim()) {
    logger.warn(`WS 群聊参数不完整: senderId=${senderId} groupId=${groupId}`);
    return sendError(ws, '参数不完整');
  }

  const msg = MessageModel.create({
    type: 'group',
    senderId,
    groupId,
    content: content.trim(),
  });

  logger.info(`WS 群聊消息: from=${senderId} groupId=${groupId} msgId=${msg.id}`);

  const payload = { type: 'new_group_msg', message: msg };
  const members = GroupModel.getMembers(groupId);

  const atNames = content.match(/@(\S+)/g);
  const atNotices = [];
  if (atNames) {
    const nameSet = new Set(atNames.map((n) => n.slice(1)));
    for (const member of members) {
      if (Number(member.id) === Number(senderId)) continue;
      if (nameSet.has(member.username)) {
        atNotices.push(member);
      }
    }
  }

  let sentCount = 0;

  for (const member of members) {
    if (Number(member.id) === Number(senderId) || GroupModel.isMuted(member.id, groupId)) continue;
    const memberWs = clients.get(Number(member.id));
    if (memberWs && memberWs.readyState === 1) {
      memberWs.send(JSON.stringify(payload));
      sentCount++;
    }
  }

  for (const notice of atNotices) {
    if (GroupModel.isMuted(notice.id, groupId)) continue;
    const memberWs = clients.get(Number(notice.id));
    if (memberWs && memberWs.readyState === 1) {
      memberWs.send(JSON.stringify({
        type: 'mention',
        groupId,
        from: { id: senderId, username: msg.sender_name },
        content: content.trim(),
      }));
    }
  }

  if (atNotices.length) {
    logger.info(`WS @提及: msgId=${msg.id} groupId=${groupId} users=${atNotices.map((m) => m.username).join(',')}`);
  }

  logger.info(`WS 群聊已送达: msgId=${msg.id} groupId=${groupId} sent=${sentCount}/${members.length}`);
}

function handleFileMsg(ws, data) {
  const senderId = ws.userId;
  const { receiverId, groupId, fileId } = data;

  if (!senderId || !fileId) {
    logger.warn(`WS 文件消息参数不完整: senderId=${senderId} fileId=${fileId}`);
    return sendError(ws, '参数不完整');
  }

  const file = FileModel.getById(fileId);
  if (!file) {
    logger.warn(`WS 文件消息文件不存在: fileId=${fileId}`);
    return sendError(ws, '文件不存在');
  }

  const msgData = {
    type: groupId ? 'group' : 'private',
    senderId,
    receiverId: receiverId || null,
    groupId: groupId || null,
    content: file.original_name,
    fileId,
  };

  const msg = MessageModel.create(msgData);
  logger.info(`WS 文件消息: from=${senderId} fileId=${fileId} ${groupId ? `group=${groupId}` : `to=${receiverId}`} msgId=${msg.id}`);

  const payload = { type: 'new_file_msg', message: msg };

  if (groupId) {
    const members = GroupModel.getMembers(groupId);
    let sentCount = 0;
    for (const member of members) {
      if (Number(member.id) === Number(senderId) || GroupModel.isMuted(member.id, groupId)) continue;
      const memberWs = clients.get(Number(member.id));
      if (memberWs && memberWs.readyState === 1) {
        memberWs.send(JSON.stringify(payload));
        sentCount++;
      }
    }
    logger.info(`WS 文件群聊已送达: msgId=${msg.id} groupId=${groupId} sent=${sentCount}/${members.length}`);
  } else {
    if (!receiverId) return sendError(ws, '缺少接收者');
    if (BlockModel.isBlockedBy(senderId, receiverId)) {
      return sendError(ws, '消息发送失败：对方已将你拉黑');
    }
    const receiverWs = clients.get(Number(receiverId));
    if (receiverWs && receiverWs.readyState === 1) {
      receiverWs.send(JSON.stringify(payload));
    }
    ws.send(JSON.stringify(payload));
  }
}

function handleRecall(ws, data) {
  const uid = ws.userId;
  const { messageId } = data;

  if (!messageId) return sendError(ws, '缺少消息ID');

  const msg = MessageModel.recall(messageId, uid);
  if (!msg) {
    logger.warn(`WS 撤回失败: messageId=${messageId} userId=${uid}`);
    return sendError(ws, '撤回失败（超过2分钟或非发送者）');
  }

  logger.info(`WS 撤回消息: messageId=${messageId} userId=${uid} type=${msg.type}`);

  const payload = { type: 'msg_recalled', message: msg };

  if (msg.type === 'private') {
    const receiverWs = clients.get(Number(msg.receiver_id));
    if (receiverWs && receiverWs.readyState === 1) {
      receiverWs.send(JSON.stringify(payload));
    }
  } else if (msg.type === 'group') {
    const members = GroupModel.getMembers(msg.group_id);
    for (const member of members) {
      if (GroupModel.isMuted(member.id, msg.group_id)) continue;
      const memberWs = clients.get(Number(member.id));
      if (memberWs && memberWs.readyState === 1) {
        memberWs.send(JSON.stringify(payload));
      }
    }
  }

  ws.send(JSON.stringify(payload));
}

function broadcastToFriends(uid, payload) {
  const friends = FriendModel.getFriends(uid);
  const json = JSON.stringify(payload);

  for (const friend of friends) {
    const friendWs = clients.get(Number(friend.id));
    if (friendWs && friendWs.readyState === 1) {
      friendWs.send(json);
    }
  }
}

function sendError(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'error', message }));
  }
}

function notifyFriendRequest(userId, friendId) {
  const friendWs = clients.get(Number(friendId));
  if (friendWs && friendWs.readyState === 1) {
    const user = UserModel.findById(userId);
    friendWs.send(
      JSON.stringify({
        type: 'friend_request',
        from: { id: user.id, ip: user.ip, username: user.username },
      })
    );
  }
}

function notifyRequestHandled(friendId, userId, status) {
  const friendWs = clients.get(Number(friendId));
  if (friendWs && friendWs.readyState === 1) {
    const user = UserModel.findById(userId);
    friendWs.send(
      JSON.stringify({
        type: 'request_handled',
        by: { id: user.id, ip: user.ip, username: user.username },
        status,
      })
    );
  }
}

function notifyNewFriend(userId, friendId) {
  const friendWs = clients.get(Number(friendId));
  if (friendWs && friendWs.readyState === 1) {
    const user = UserModel.findById(userId);
    friendWs.send(
      JSON.stringify({
        type: 'new_friend',
        user: { id: user.id, ip: user.ip, username: user.username },
      })
    );
  }
}

module.exports = {
  setupWebSocket,
  notifyFriendRequest,
  notifyRequestHandled,
  notifyNewFriend,
  clients,
};
