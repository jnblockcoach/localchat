const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const FileModel = require('../models/file');
const { getDb } = require('../db');
const { requireOwnership } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { stripControlSingleLine } = require('../sanitize');
const { parseId } = require('../util/parse');
const { checkUploadQuota } = require('../quota');
const logger = require('../logger');

const router = express.Router();

const ALLOWED_EXTS = ['.md', '.txt', '.jpg', '.jpeg', '.png', '.bmp', '.wav', '.mp3', '.mp4'];
// 支持环境变量覆盖数据目录（自动化测试用），默认 data/
const DATA_DIR = process.env.LOCALCHAT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'files');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 文件名清洗：去掉客户端提供的路径部分（Windows/Unix），只保留纯文件名；
// R13：同时去除控制字符（防下载头/终端/日志异常）
function cleanOriginalName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = stripControlSingleLine(base).slice(0, 255);
  return cleaned || 'file';
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename(req, file, cb) {
    const ext = path.extname(cleanOriginalName(file.originalname)).toLowerCase();
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(cleanOriginalName(file.originalname)).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      return cb(new Error(`不支持的文件格式: ${ext}`));
    }
    cb(null, true);
  },
});

// 清理已落盘的上传文件（鉴权失败/参数错误时避免产生孤儿文件）
function removeUploaded(req) {
  try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch {}
}

// Z3：IP 鉴权必须在 multer 解析之前完成（multipart 下 req.body 尚未填充），
// 因此 uploaderId 由 query 提供；表单中的 uploaderId 仅作一致性交叉校验。
router.post('/upload', rateLimit({ windowMs: 60000, max: 20, message: '上传过于频繁，请稍后再试' }), requireOwnership((req) => req.query.uploaderId), (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      logger.error(`文件上传失败: ${err.message}`);
      return res.status(400).json({ error: err.message });
    }
    try {
      // L2：无文件字段时明确 400，避免解引用 req.file 抛 500
      if (!req.file) {
        return res.status(400).json({ error: '缺少文件' });
      }
      // 只信任中间件验证过的身份；query 与表单不一致时拒绝
      const uploaderId = req.authUserId;
      const bodyUploaderId = req.body.uploaderId === undefined || req.body.uploaderId === ''
        ? null
        : Number(req.body.uploaderId);
      if (!uploaderId) {
        removeUploaded(req);
        return res.status(400).json({ error: '缺少上传者ID' });
      }
      if (bodyUploaderId !== null && bodyUploaderId !== uploaderId) {
        removeUploaded(req);
        return res.status(403).json({ error: '上传者身份不一致' });
      }

      // F2：单用户/全站存储配额检查（超限则删除已落盘文件）
      const quota = checkUploadQuota(uploaderId, req.file.size);
      if (!quota.ok) {
        removeUploaded(req);
        return res.status(413).json({ error: quota.error });
      }

      const file = FileModel.create(
        cleanOriginalName(req.file.originalname),
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        uploaderId
      );

      logger.info(`文件上传: id=${file.id} name=${file.original_name} size=${file.size} uploader=${uploaderId}`);
      res.json({ file });
    } catch (e) {
      // 任何失败都清理已落盘的文件，避免产生孤儿文件
      removeUploaded(req);
      logger.error(`文件上传处理失败: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
});

// 校验文件访问权限：上传者本人，或存在一条“本人是相关方”的引用消息（私聊双方 / 群成员）
// M7：不能用 LIMIT 1 取最早一条消息判定，否则“旧引用”会误伤“新引用”的合法访问
function canAccessFile(fileId, userId) {
  if (!userId) return false;
  const file = FileModel.getById(fileId);
  if (!file) return false;
  if (Number(file.uploader_id) === Number(userId)) return true;

  const row = getDb()
    .prepare(
      `SELECT 1 FROM messages m
       WHERE m.file_id = ?
         AND (
           (m.type = 'private' AND (m.sender_id = ? OR m.receiver_id = ?))
           OR (m.type = 'group' AND EXISTS (
             SELECT 1 FROM group_members gm WHERE gm.group_id = m.group_id AND gm.user_id = ?
           ))
         )
       LIMIT 1`
    )
    .get(fileId, userId, userId, userId);
  return !!row;
}

router.get('/:id/download', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const fileId = parseId(req.params.id);
    if (!fileId) return res.status(400).json({ error: '参数不合法' });
    const userId = req.authUserId;
    if (!canAccessFile(fileId, userId)) {
      return res.status(403).json({ error: '无权访问该文件' });
    }
    const file = FileModel.getById(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

    res.download(filePath, file.original_name);
  } catch (err) {
    logger.error(`文件下载失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/info', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const fileId = parseId(req.params.id);
    if (!fileId) return res.status(400).json({ error: '参数不合法' });
    const userId = req.authUserId;
    if (!canAccessFile(fileId, userId)) {
      return res.status(403).json({ error: '无权访问该文件' });
    }
    const file = FileModel.getById(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    // R15：不向前端暴露内部存储文件名
    const pub = { ...file };
    delete pub.stored_name;
    res.json(pub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/preview', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const fileId = parseId(req.params.id);
    if (!fileId) return res.status(400).json({ error: '参数不合法' });
    const userId = req.authUserId;
    if (!canAccessFile(fileId, userId)) {
      return res.status(403).json({ error: '无权访问该文件' });
    }
    const file = FileModel.getById(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const ext = path.extname(file.original_name).toLowerCase();
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (['.jpg', '.jpeg', '.png', '.bmp', '.md', '.txt', '.mp4', '.mp3', '.wav'].includes(ext)) {
      // R3：图片/文本/音视频内嵌预览（媒体已由上传白名单限定）
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
      res.sendFile(filePath);
    } else {
      res.status(400).json({ error: '不支持预览' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
