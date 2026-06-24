const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const FileModel = require('../models/file');
const logger = require('../logger');

const router = express.Router();

const ALLOWED_EXTS = ['.md', '.txt', '.jpg', '.jpeg', '.png', '.bmp', '.wav', '.mp3', '.mp4'];
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'files');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      return cb(new Error(`不支持的文件格式: ${ext}`));
    }
    cb(null, true);
  },
});

router.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      logger.error(`文件上传失败: ${err.message}`);
      return res.status(400).json({ error: err.message });
    }
    try {
      const { uploaderId } = req.body;
      if (!uploaderId) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: '缺少上传者ID' });
      }

      const file = FileModel.create(
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        uploaderId
      );

      logger.info(`文件上传: id=${file.id} name=${file.original_name} size=${file.size} uploader=${uploaderId}`);
      res.json({ file });
    } catch (e) {
      logger.error(`文件上传处理失败: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
});

router.get('/:id/download', (req, res) => {
  try {
    const file = FileModel.getById(parseInt(req.params.id));
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

    res.download(filePath, file.original_name);
  } catch (err) {
    logger.error(`文件下载失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/info', (req, res) => {
  try {
    const file = FileModel.getById(parseInt(req.params.id));
    if (!file) return res.status(404).json({ error: '文件不存在' });
    res.json(file);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/preview', (req, res) => {
  try {
    const file = FileModel.getById(parseInt(req.params.id));
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const ext = path.extname(file.original_name).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.bmp'].includes(ext)) {
      const filePath = path.join(UPLOAD_DIR, file.stored_name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
      res.sendFile(filePath);
    } else if (['.md', '.txt'].includes(ext)) {
      const filePath = path.join(UPLOAD_DIR, file.stored_name);
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
