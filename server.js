const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
const HISTORY_DIR = path.join(ROOT_DIR, 'history');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const MAX_HISTORY_ITEMS = 200;
const sseClients = new Set();

for (const dir of [UPLOAD_DIR, HISTORY_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jfif': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function scoreFilename(value) {
  if (!value) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (/[一-龥]/.test(value)) score += 6;
  if (/[A-Za-z0-9]/.test(value)) score += 2;
  if (value.includes('�')) score -= 12;
  if (/Ã|Â|å|æ|ç|Ð|þ/.test(value)) score -= 4;
  if (/%[0-9A-Fa-f]{2}/.test(value)) score -= 2;
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) score -= 5;
  score += Math.min(value.length, 48) / 48;
  return score;
}

function sanitizeFilename(filename) {
  const cleaned = String(filename || '')
    .replace(/\0/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '未命名文件';
}

function fixUploadFilename(filename) {
  const rawValue = path.basename(String(filename || '').replace(/\0/g, ''));
  const candidates = new Set([rawValue]);

  if (/%[0-9A-Fa-f]{2}/.test(rawValue)) {
    try {
      candidates.add(decodeURIComponent(rawValue));
    } catch {}
  }

  try {
    candidates.add(Buffer.from(rawValue, 'latin1').toString('utf8'));
  } catch {}

  try {
    candidates.add(Buffer.from(rawValue, 'binary').toString('utf8'));
  } catch {}

  const best = [...candidates]
    .map(sanitizeFilename)
    .sort((a, b) => scoreFilename(b) - scoreFilename(a))[0];

  return best || '未命名文件';
}

function getSender(req) {
  const sender = req.body && req.body.sender;
  return sender === 'computer' ? 'computer' : 'phone';
}

function getClientId(req) {
  const clientId = req.body && req.body.clientId;
  if (!clientId) return '';
  return String(clientId);
}

function resolveFileCategory(filename, mime = '') {
  const ext = path.extname(filename).toLowerCase();

  if (/\.(jpg|jpeg|png|gif|webp|heic|heif|jfif|bmp|svg)$/i.test(ext) || mime.startsWith('image/')) {
    return 'image';
  }
  if (/\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(ext) || mime.startsWith('video/')) {
    return 'video';
  }
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(ext) || mime.startsWith('audio/')) {
    return 'audio';
  }
  return 'other';
}

function readHistoryFromDisk() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('读取历史记录失败:', error && error.message);
    return [];
  }
}

let history = readHistoryFromDisk();

function persistHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function broadcastHistoryEvent(payload) {
  const chunk = `event: history\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(chunk);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

function tsId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function addHistory(item) {
  const entry = { ...item, id: tsId() };
  history.unshift(entry);
  if (history.length > MAX_HISTORY_ITEMS) {
    history = history.slice(0, MAX_HISTORY_ITEMS);
  }
  persistHistory();
  broadcastHistoryEvent({ action: 'upsert', entry });
  return entry;
}

function fileAbsolutePath(storedName) {
  return path.join(UPLOAD_DIR, path.basename(String(storedName || '')));
}

function unlinkFileSilently(storedName) {
  if (!storedName) return;
  const absolutePath = fileAbsolutePath(storedName);
  try {
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  } catch (error) {
    console.error('删除文件失败:', absolutePath, error && error.message);
  }
}

function deleteHistoryItem(id) {
  const index = history.findIndex(item => item.id === id);
  if (index === -1) return null;
  const [removed] = history.splice(index, 1);
  if (removed && removed.type === 'file') {
    unlinkFileSilently(removed.storedName);
  }
  persistHistory();
  broadcastHistoryEvent({ action: 'delete', id });
  return removed;
}

function clearHistoryItems() {
  const items = history.slice();
  history = [];
  persistHistory();
  broadcastHistoryEvent({ action: 'clear' });
  for (const item of items) {
    if (item.type === 'file') unlinkFileSilently(item.storedName);
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeOriginalName = fixUploadFilename(file.originalname);
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    file.originalname = safeOriginalName;
    cb(null, `${ts}_${rand}_${safeOriginalName}`);
  },
});

const upload = multer({
  storage,
  limits: { files: 20 },
  fileFilter: (_req, file, cb) => {
    const safeOriginalName = fixUploadFilename(file.originalname);
    if (!safeOriginalName) {
      return cb(new Error('文件名为空'));
    }
    file.originalname = safeOriginalName;
    cb(null, true);
  },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write('retry: 2000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch (error) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT_DIR, 'public')));

app.post('/api/message', (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) {
    return res.status(400).json({ error: '文字内容不能为空' });
  }

  const entry = addHistory({
    type: 'text',
    text,
    sender: getSender(req),
    clientId: getClientId(req),
    time: new Date().toISOString(),
    size: Buffer.byteLength(text, 'utf8'),
  });

  res.json({ ok: true, entry });
});

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    return res.status(400).json({ error: '未收到任何文件' });
  }

  const sender = getSender(req);
  const clientId = getClientId(req);
  const entries = files.map(file => {
    const mime = file.mimetype && file.mimetype !== 'application/octet-stream'
      ? file.mimetype
      : guessMime(file.originalname);

    return addHistory({
      type: 'file',
      filename: file.originalname,
      storedName: file.filename,
      url: `/uploads/${encodeURIComponent(file.filename)}`,
      size: file.size,
      mime: guessMime(file.originalname),
      uploadMime: mime,
      category: resolveFileCategory(file.originalname, mime),
      sender,
      clientId,
      time: new Date().toISOString(),
    });
  });

  res.json({ ok: true, entries });
});

app.get('/api/history', (_req, res) => {
  res.json({ items: history.slice(0, MAX_HISTORY_ITEMS) });
});

app.get('/api/info', (_req, res) => {
  const ip = getLocalIP();
  res.json({ ip, port: PORT, url: `http://${ip}:${PORT}` });
});

app.delete('/api/history', (_req, res) => {
  clearHistoryItems();
  res.json({ ok: true });
});

app.delete('/api/history/:id', (req, res) => {
  const removed = deleteHistoryItem(req.params.id);
  if (!removed) {
    return res.status(404).json({ error: '记录不存在' });
  }
  res.json({ ok: true });
});

app.use((error, _req, res, next) => {
  if (!error) return next();

  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message || '上传失败' });
  }

  return res.status(400).json({ error: error.message || '请求失败' });
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('═══════════════════════════════════════════');
  console.log('  📡  WiFi 传输工具已启动');
  console.log('───────────────────────────────────────────');
  console.log(`  🖥  电脑端:     http://localhost:${PORT}`);
  console.log(`  📱 手机浏览器: http://${ip}:${PORT}`);
  console.log('═══════════════════════════════════════════');
});
