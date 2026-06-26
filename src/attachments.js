const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('./database');

const PENDING_ATTACHMENT_SOURCES = {
  PATH: 'path',
  CLIPBOARD_IMAGE: 'clipboard-image',
};

const MIME_EXTENSIONS = {
  'image/apng': '.apng',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

function saveAttachments(db, attachmentsRoot, ownerType, ownerId, files = [], projectId = null) {
  if (!Array.isArray(files) || files.length === 0) return [];

  const saved = [];
  const targetDir = path.join(attachmentsRoot, ownerType, String(ownerId));
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of files) {
    const prepared = prepareAttachment(file);
    if (!prepared) {
      continue;
    }

    const storedPath = persistAttachment(prepared, targetDir);
    const stat = fs.statSync(storedPath);
    const hash = hashFile(storedPath);
    const id = db.insert(
      `INSERT INTO attachments
       (project_id, owner_type, owner_id, original_name, stored_path, mime_type, size, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        ownerType,
        ownerId,
        prepared.originalName,
        storedPath,
        prepared.mimeType,
        stat.size,
        hash,
        nowIso(),
      ],
    );

    saved.push({
      id,
      project_id: projectId,
      owner_type: ownerType,
      owner_id: ownerId,
      original_name: prepared.originalName,
      stored_path: storedPath,
      mime_type: prepared.mimeType,
      size: stat.size,
      hash,
    });
  }

  return saved;
}

function prepareAttachment(file) {
  if (!file || typeof file !== 'object') return null;
  if (file.source === PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE || hasClipboardPayload(file)) {
    return prepareClipboardImageAttachment(file);
  }
  return preparePathAttachment(file);
}

function preparePathAttachment(file) {
  const sourcePath = file.path;
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return null;
  }

  const originalName = displayFileName(file.name, path.basename(sourcePath));
  return {
    sourcePath,
    originalName,
    mimeType: normalizeMimeType(file.type) || guessMimeType(originalName),
    hashSeed: hashFile(sourcePath),
  };
}

function prepareClipboardImageAttachment(file) {
  const payload = decodeClipboardPayload(file);
  if (!payload || payload.buffer.length === 0) return null;

  const mimeType = payload.mimeType || normalizeMimeType(file.type) || 'image/png';
  const extension = extensionForMime(mimeType) || '.png';
  const fallbackName = `clipboard-image${extension}`;
  const originalName = ensureFileExtension(displayFileName(file.name, fallbackName), extension);

  return {
    buffer: payload.buffer,
    originalName,
    mimeType,
    hashSeed: hashBuffer(payload.buffer),
  };
}

function persistAttachment(prepared, targetDir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const storedPath = buildStoredPath(targetDir, prepared.originalName, prepared.hashSeed);
    try {
      if (prepared.sourcePath) {
        fs.copyFileSync(prepared.sourcePath, storedPath, fs.constants.COPYFILE_EXCL);
      } else {
        fs.writeFileSync(storedPath, prepared.buffer, { flag: 'wx' });
      }
      return storedPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('附件保存失败：无法生成唯一文件名');
}

function buildStoredPath(targetDir, originalName, hash) {
  const randomPart = crypto.randomBytes(6).toString('hex');
  const storedName = `${Date.now()}-${randomPart}-${hash.slice(0, 12)}-${safeFileName(originalName)}`;
  return path.join(targetDir, storedName);
}

function hasClipboardPayload(file) {
  return (
    typeof file.dataUrl === 'string' ||
    typeof file.base64 === 'string' ||
    typeof file.dataBase64 === 'string' ||
    isBinaryPayload(file.bytes) ||
    isBinaryPayload(file.buffer) ||
    isBinaryPayload(file.data)
  );
}

function decodeClipboardPayload(file) {
  if (typeof file.dataUrl === 'string') {
    const decoded = decodeDataUrl(file.dataUrl);
    if (decoded) return decoded;
  }

  const base64 = typeof file.base64 === 'string' ? file.base64 : file.dataBase64;
  if (typeof base64 === 'string') {
    const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
    if (buffer.length > 0) return { buffer, mimeType: '' };
  }

  for (const value of [file.bytes, file.buffer, file.data]) {
    const buffer = bufferFromBinaryPayload(value);
    if (buffer && buffer.length > 0) return { buffer, mimeType: '' };
  }

  return null;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) return null;

  const meta = match[1] || '';
  const data = match[2] || '';
  const parts = meta.split(';').map((part) => part.trim()).filter(Boolean);
  const mimeType = normalizeMimeType(parts.find((part) => part.includes('/')) || '');
  const isBase64 = parts.some((part) => part.toLowerCase() === 'base64');

  try {
    const buffer = isBase64 ? Buffer.from(data.replace(/\s+/g, ''), 'base64') : Buffer.from(decodeURIComponent(data));
    return { buffer, mimeType };
  } catch (_error) {
    return null;
  }
}

function isBinaryPayload(value) {
  return Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value);
}

function bufferFromBinaryPayload(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value);
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return null;
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeFileName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'attachment';
}

function displayFileName(name, fallback) {
  const value = String(name || '').trim();
  if (!value) return fallback;
  const baseName = path.posix.basename(value.replace(/\\/g, '/')).trim();
  return baseName && baseName !== '.' && baseName !== '..' ? baseName : fallback;
}

function ensureFileExtension(name, extension) {
  if (!extension) return name;
  const currentExtension = path.extname(name).toLowerCase();
  if (currentExtension === extension || (extension === '.jpg' && currentExtension === '.jpeg')) {
    return name;
  }
  return `${name.slice(0, name.length - currentExtension.length) || 'clipboard-image'}${extension}`;
}

function normalizeMimeType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function extensionForMime(mimeType) {
  return MIME_EXTENSIONS[normalizeMimeType(mimeType)] || '';
}

function guessMimeType(name) {
  const ext = path.extname(name).toLowerCase();
  const types = {
    '.apng': 'image/apng',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = { saveAttachments };
