#!/usr/bin/env node
/* ===========================================================================
   server.js - API Buku Tahunan Digital (local Node.js + Vercel)
   ---------------------------------------------------------------------------
   CARA PAKAI
     1. Pastikan Node.js terpasang (versi 22.5 ke atas, disarankan 24).
     2. Dari folder ini jalankan:      node server.js
        atau double-click             start-server.bat
     3. Buka                         http://localhost:3000/

   APA YANG DISIMPAN (database)
     PostgreSQL cloud  -> metadata media dan data siswa
     Object storage    -> foto, video, dan poster

   Frontend (alumni2.html) mendeteksi server ini otomatis lewat /api/health.
   Kalau server aktif, semua admin & pengunjung memakai database yang sama,
   jadi video/foto yang diunggah langsung terlihat oleh semua orang.
   Kalau server tidak aktif, halaman otomatis memakai database browser
   (IndexedDB) sehingga tetap berfungsi.

   PENGATURAN (lewat environment variable)
     PORT=8080            porta server
     DATABASE_URL=...     koneksi PostgreSQL cloud
     ADMIN_CODE=...       kode login admin (hanya tersimpan di server)
     JWT_SECRET=...       kunci token admin
     S3_*                 konfigurasi object storage S3-compatible
     MAX_UPLOAD_MB=3072   batas ukuran satu video (default 3 GB)

   =========================================================================== */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

/* Load local secrets without overwriting environment variables supplied by the host. */
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  const envContents = fs.readFileSync(ENV_FILE, 'utf8');
  envContents.split(/\r?\n/).forEach(line => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) return;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  });
}

/* ---------------------------------------------------------------- konfigurasi */
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const INTRO_TTS_CACHE_DIR = process.env.VERCEL
  ? path.join('/tmp', 'intro-tts-cache')
  : path.join(DATA_DIR, 'intro-tts-cache');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 3072) * 1024 * 1024;
const MAX_KV = 64 * 1024 * 1024;
const CORS_ORIGINS = new Set((process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean));
let pool;
let s3;
let schemaReady;
const introTtsRequests = new Map();

fs.mkdirSync(INTRO_TTS_CACHE_DIR, { recursive: true });

/* ------------------------------------------------------------------- database */
function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum diatur.');
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 1 : 10)),
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000
    });
  }
  return pool;
}

function getS3() {
  const required = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_URL'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error('Konfigurasi object storage belum lengkap: ' + missing.join(', '));
  if (!s3) {
    s3 = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
      }
    });
  }
  return s3;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        caption TEXT,
        name TEXT,
        mime TEXT,
        size BIGINT DEFAULT 0,
        width INTEGER DEFAULT 0,
        height INTEGER DEFAULT 0,
        duration DOUBLE PRECISION DEFAULT 0,
        file TEXT,
        poster TEXT,
        ts BIGINT
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT,
        ts BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind, ts DESC);
    `).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
}

/* ------------------------------------------------------------------- utilitas */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};
const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv',
  'video/quicktime': '.mov'
};

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

function header(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v || '';
}

function safeText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 300);
}

function signAdminToken(expiry) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(expiry)).digest('hex');
}

function issueAdminToken() {
  const expiry = Date.now() + 12 * 60 * 60 * 1000;
  return expiry + '.' + signAdminToken(expiry);
}

function isAdmin(req) {
  const [expiryText, signature, extra] = header(req, 'x-admin-token').split('.');
  if (!expiryText || !signature || extra || !/^\d+$/.test(expiryText)) return false;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= Date.now()) return false;
  const expected = Buffer.from(signAdminToken(expiry), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function publicObjectUrl(key) {
  const base = process.env.S3_PUBLIC_URL.replace(/\/+$/, '') + '/';
  return new URL(key.split('/').map(encodeURIComponent).join('/'), base).toString();
}

async function signUpload(key, mime) {
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    ContentType: mime
  });
  return getSignedUrl(getS3(), command, { expiresIn: 900 });
}

async function objectInfo(key) {
  return getS3().send(new HeadObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key
  }));
}

async function deleteObject(key) {
  if (!key) return;
  await getS3().send(new DeleteObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key
  }));
}

function sendIntroAudio(res, audio) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': audio.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(audio);
}

/* Generate one narration file per intro playback; the API key never reaches the browser. */
async function handleIntroTts(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Gunakan POST untuk membuat narasi.');

  const now = Date.now();
  const client = req.socket.remoteAddress || 'unknown';
  const recentRequests = (introTtsRequests.get(client) || []).filter(time => now - time < 60000);
  if (recentRequests.length >= 5) {
    introTtsRequests.set(client, recentRequests);
    return sendError(res, 429, 'Terlalu banyak permintaan narasi. Silakan coba lagi sebentar.');
  }
  recentRequests.push(now);
  introTtsRequests.set(client, recentRequests);
  introTtsRequests.forEach((times,ip) => {
    if (!times.length || now - times[times.length-1] >= 60000) introTtsRequests.delete(ip);
  });

  let input;
  try {
    input = JSON.parse(await readTextBody(req, 20 * 1024));
  } catch (err) {
    return sendError(res, err.status || 400, 'Permintaan narasi tidak valid.');
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || text.length > 4000) {
    return sendError(res, 400, 'Teks narasi wajib diisi dan maksimal 4000 karakter.');
  }

  const voices = {
    onyx: 'Gunakan bahasa Indonesia dengan suara narator pria dewasa yang hangat, tenang, dan penuh nostalgia.',
    nova: 'Gunakan bahasa Indonesia dengan suara narator wanita yang hangat, jernih, dan penuh nostalgia.',
    sage: 'Gunakan bahasa Indonesia dengan suara yang sangat tenang, lembut, dan reflektif.',
    shimmer: 'Gunakan bahasa Indonesia dengan suara yang cerah, ramah, dan tetap tulus.'
  };
  const voice = typeof input.voice === 'string' ? input.voice : '';
  if (!Object.prototype.hasOwnProperty.call(voices, voice)) {
    return sendError(res, 400, 'Pilihan suara narator tidak dikenal.');
  }

  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const cacheKey = crypto.createHash('sha256')
    .update(JSON.stringify({ model, voice, text }))
    .digest('hex');
  const cachePath = path.join(INTRO_TTS_CACHE_DIR, cacheKey + '.mp3');
  if (fs.existsSync(cachePath)) {
    const cachedAudio = await fs.promises.readFile(cachePath);
    if (cachedAudio.length) return sendIntroAudio(res, cachedAudio);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your-openai-api-key') {
    return sendError(res, 503, 'API key OpenAI belum diatur. Salin .env.example menjadi .env, isi OPENAI_API_KEY dengan key baru, lalu mulai ulang server.');
  }

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        instructions: voices[voice],
        response_format: 'mp3'
      }),
      signal: AbortSignal.timeout(90000)
    });
  } catch (err) {
    console.error('[intro-tts] OpenAI request failed:', err.message);
    return sendError(res, 502, 'Layanan narasi suara tidak dapat dihubungi.');
  }

  if (!response.ok) {
    console.error('[intro-tts] OpenAI returned HTTP ' + response.status);
    return sendError(res, 502, 'OpenAI gagal membuat narasi suara (HTTP ' + response.status + ').');
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('audio/')) {
    console.error('[intro-tts] OpenAI returned a non-audio response.');
    return sendError(res, 502, 'OpenAI tidak mengembalikan berkas audio yang valid.');
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) return sendError(res, 502, 'OpenAI mengembalikan audio kosong.');
  const tempPath = cachePath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  await fs.promises.writeFile(tempPath, audio, { flag: 'wx' });
  try {
    await fs.promises.rename(tempPath, cachePath);
  } catch (err) {
    if (!fs.existsSync(cachePath)) throw err;
    await fs.promises.unlink(tempPath);
  }
  return sendIntroAudio(res, audio);
}

/* Body JSON/teks dengan batas ukuran (untuk key-value data siswa). */
function readTextBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Data terlalu besar untuk disimpan.');
        err.status = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* Unggahan media ditulis langsung ke disk (streaming) supaya video besar
   tidak pernah dimuat ke memori server. */
function readStreamToFile(req, destPath, limit) {
  return new Promise((resolve, reject) => {
    const tmp = destPath + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let broken = false;

    const fail = err => {
      if (broken) return;
      broken = true;
      try { out.destroy(); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      reject(err);
    };

    req.on('data', chunk => {
      if (broken) return;
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Ukuran berkas melebihi batas ' + formatBytes(limit) + '.');
        err.status = 413;
        fail(err);
        req.destroy();
        return;
      }
      out.write(chunk);
    });
    req.on('end', () => {
      if (broken) return;
      out.end(() => {
        try {
          fs.renameSync(tmp, destPath);
          resolve(size);
        } catch (e) {
          fail(e);
        }
      });
    });
    req.on('error', fail);
    out.on('error', fail);
  });
}

/* Kirim berkas dengan dukungan Range supaya <video> bisa di-seek. */
function sendFile(req, res, filePath, mime, downloadName) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return sendError(res, 404, 'Berkas tidak ditemukan');
  }
  const total = stat.size;
  const range = parseRange(header(req, 'range'), total);
  const base = {
    'Content-Type': mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable'
  };
  if (downloadName) base['Content-Disposition'] = 'attachment; filename="' + downloadName.replace(/"/g, '') + '"';

  if (!range) {
    res.writeHead(200, Object.assign({ 'Content-Length': total }, base));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const start = range.start;
  const end = range.end;
  res.writeHead(206, Object.assign({
    'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    'Content-Length': end - start + 1
  }, base));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function parseRange(value, total) {
  if (!value) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {           // bytes=-500 -> 500 byte terakhir
    start = Math.max(0, total - end);
    end = total - 1;
  } else if (end === null || end >= total) {
    end = total - 1;
  }
  if (start > end || start >= total) return null;
  return { start, end };
}

/* -------------------------------------------------------------- API database */
function mediaRowToJson(row) {
  return {
    id: row.id,
    kind: row.kind,
    caption: row.caption || '',
    name: row.name || '',
    mime: row.mime || '',
    size: Number(row.size) || 0,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    duration: Number(row.duration) || 0,
    ts: Number(row.ts) || 0,
    hasPoster: !!row.poster
  };
}

async function apiCounts() {
  const result = await getPool().query('SELECT kind, COUNT(*) AS n FROM media GROUP BY kind');
  return result.rows.reduce((counts, row) => {
    counts[row.kind] = Number(row.n);
    return counts;
  }, { photo: 0, video: 0 });
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean);      // ['api', ...]
  const section = seg[1] || '';
  const method = req.method;
  const database = getPool();

  if (section === 'intro-tts') return handleIntroTts(req, res);

  if (section === 'health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'buku-tahunan-api',
      node: process.version,
      maxUploadBytes: MAX_UPLOAD,
      maxKvBytes: MAX_KV,
      storage: 'postgresql+s3',
      counts: await apiCounts()
    });
  }

  if (section === 'stats') {
    const [size, counts] = await Promise.all([
      database.query('SELECT COALESCE(SUM(size),0) AS total FROM media'),
      apiCounts()
    ]);
    return sendJson(res, 200, {
      ok: true,
      usedBytes: Number(size.rows[0].total) || 0,
      maxUploadBytes: MAX_UPLOAD,
      counts
    });
  }

  if (section === 'media') {
    const id = seg[2] ? decodeURIComponent(seg[2]) : '';
    const sub = seg[3] || '';

    if (method === 'GET' && !id) {
      const kind = url.searchParams.get('kind');
      const rows = kind
        ? await database.query('SELECT * FROM media WHERE kind = $1 ORDER BY ts DESC', [kind])
        : await database.query('SELECT * FROM media ORDER BY ts DESC');
      return sendJson(res, 200, { ok: true, items: rows.rows.map(mediaRowToJson) });
    }

    if (method === 'POST' && !id) {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, unggahan ditolak.');
      const kind = safeText(header(req, 'x-kind'), 20) || 'photo';
      if (kind !== 'photo' && kind !== 'video') return sendError(res, 400, 'Jenis media tidak dikenal.');
      const mime = safeText(header(req, 'content-type'), 120) || 'application/octet-stream';
      const idNew = safeText(header(req, 'x-id'), 80) ||
        Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(idNew)) return sendError(res, 400, 'ID media tidak valid.');
      const name = safeText(header(req, 'x-name'), 200) || idNew;
      const caption = safeText(header(req, 'x-caption'), 300) || name.replace(/\.[^/.]+$/, '');
      const width = Number(header(req, 'x-width')) || 0;
      const height = Number(header(req, 'x-height')) || 0;
      const duration = Number(header(req, 'x-duration')) || 0;
      const ext = path.extname(name) || EXT_BY_MIME[mime] || (kind === 'video' ? '.mp4' : '.jpg');
      const fileName = idNew + ext.replace(/[^.a-zA-Z0-9]/g, '');
      const objectKey = path.posix.join(kind, fileName);
      try {
        await database.query(
          `INSERT INTO media (id, kind, caption, name, mime, size, width, height, duration, file, poster, ts)
           VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, NULL, $10)`,
          [idNew, kind, caption, name, mime, width, height, duration, objectKey, Date.now()]
        );
      } catch (err) {
        if (err.code === '23505') return sendError(res, 409, 'ID media sudah digunakan.');
        throw err;
      }
      try {
        const uploadUrl = await signUpload(objectKey, mime);
        return sendJson(res, 201, { ok: true, id: idNew, size: 0, uploadUrl });
      } catch (err) {
        await database.query('DELETE FROM media WHERE id = $1', [idNew]);
        throw err;
      }
    }

    if (method === 'POST' && id && sub === 'complete') {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, unggahan ditolak.');
      const result = await database.query('SELECT file FROM media WHERE id = $1', [id]);
      if (!result.rowCount) return sendError(res, 404, 'Media tidak ditemukan');
      const info = await objectInfo(result.rows[0].file);
      const size = Number(info.ContentLength) || 0;
      if (!size) return sendError(res, 400, 'Berkas kosong.');
      if (size > MAX_UPLOAD) return sendError(res, 413, 'Ukuran berkas melebihi batas ' + formatBytes(MAX_UPLOAD) + '.');
      await database.query('UPDATE media SET size = $1, ts = $2 WHERE id = $3', [size, Date.now(), id]);
      return sendJson(res, 200, { ok: true, id, size });
    }

    if (method === 'PUT' && id && sub === 'poster') {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, poster ditolak.');
      const result = await database.query('SELECT id FROM media WHERE id = $1', [id]);
      if (!result.rowCount) return sendError(res, 404, 'Media tidak ditemukan');
      const objectKey = 'poster/' + id + '-poster.jpg';
      const uploadUrl = await signUpload(objectKey, 'image/jpeg');
      return sendJson(res, 200, { ok: true, uploadUrl, objectKey });
    }

    if (method === 'POST' && id && sub === 'poster' && seg[4] === 'complete') {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, unggahan ditolak.');
      const result = await database.query('SELECT id FROM media WHERE id = $1', [id]);
      if (!result.rowCount) return sendError(res, 404, 'Media tidak ditemukan');
      const objectKey = 'poster/' + id + '-poster.jpg';
      const info = await objectInfo(objectKey);
      const size = Number(info.ContentLength) || 0;
      if (!size) return sendError(res, 400, 'Poster kosong.');
      if (size > 4 * 1024 * 1024) return sendError(res, 413, 'Ukuran poster melebihi batas 4 MB.');
      await database.query('UPDATE media SET poster = $1 WHERE id = $2', [objectKey, id]);
      return sendJson(res, 200, { ok: true, size });
    }

    if (method === 'GET' && id) {
      const result = await database.query('SELECT * FROM media WHERE id = $1', [id]);
      const row = result.rows[0];
      if (!row) return sendError(res, 404, 'Media tidak ditemukan');
      if (!sub) return sendJson(res, 200, mediaRowToJson(row));
      const objectKey = sub === 'poster' ? row.poster : row.file;
      if (!objectKey) return sendError(res, 404, sub === 'poster' ? 'Poster tidak ada' : 'Berkas tidak ditemukan');
      if (sub !== 'poster' && sub !== 'raw') return sendError(res, 404, 'Endpoint tidak dikenal');
      res.writeHead(302, {
        Location: publicObjectUrl(objectKey),
        'Cache-Control': 'public, max-age=3600'
      });
      return res.end();
    }

    if (method === 'DELETE' && id) {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, penghapusan ditolak.');
      const result = await database.query('SELECT file, poster FROM media WHERE id = $1', [id]);
      const row = result.rows[0];
      if (!row) return sendError(res, 404, 'Media tidak ditemukan');
      await Promise.all([deleteObject(row.file), deleteObject(row.poster)]);
      await database.query('DELETE FROM media WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, 405, 'Metode tidak didukung untuk /api/media');
  }

  if (section === 'kv') {
    const key = seg[2] ? decodeURIComponent(seg[2]) : '';

    if (method === 'GET' && !key) {
      const prefix = url.searchParams.get('prefix') || '';
      const result = await database.query(
        'SELECT key FROM kv WHERE $1 = \'\' OR LEFT(key, LENGTH($1)) = $1 ORDER BY key',
        [prefix]
      );
      return sendJson(res, 200, { ok: true, keys: result.rows.map(row => row.key) });
    }
    if (method === 'GET' && key) {
      const result = await database.query('SELECT value FROM kv WHERE key = $1', [key]);
      if (!result.rowCount) return sendError(res, 404, 'Key tidak ditemukan');
      const payload = Buffer.from(String(result.rows[0].value), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store'
      });
      return res.end(payload);
    }
    if (method === 'PUT' && key) {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, penyimpanan ditolak.');
      let value;
      try {
        value = await readTextBody(req, MAX_KV);
      } catch (err) {
        return sendError(res, err.status || 400, err.message || 'Data gagal dibaca');
      }
      await database.query(
        `INSERT INTO kv (key, value, ts) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, ts = EXCLUDED.ts`,
        [key, value, Date.now()]
      );
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE' && key) {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, penghapusan ditolak.');
      await database.query('DELETE FROM kv WHERE key = $1', [key]);
      return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 405, 'Metode tidak didukung untuk /api/kv');
  }

  if (section === 'admin' && method === 'POST') {
    if (!process.env.ADMIN_CODE || !process.env.JWT_SECRET) {
      return sendError(res, 503, 'Autentikasi admin belum dikonfigurasi.');
    }
    let body;
    try {
      body = await readTextBody(req, 4096);
    } catch (err) {
      return sendError(res, err.status || 400, 'Permintaan login tidak valid.');
    }
    const supplied = Buffer.from(safeText(body, 256));
    const expected = Buffer.from(process.env.ADMIN_CODE);
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
      return sendJson(res, 200, { ok: true, token: issueAdminToken() });
    }
    return sendError(res, 401, 'Kode admin salah');
  }

  return sendError(res, 404, 'Endpoint tidak dikenal');
}

/* ------------------------------------------------------------- berkas statis */
function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (err) {
    return sendError(res, 400, 'URL tidak valid');
  }
  if (rel === '/' || rel === '') rel = '/alumni2.html';
  const allowed = new Set(['/alumni2.html', '/intro.js', '/intro.css', '/api-config.js']);
  const musicPrefix = '/music/';
  if (rel.startsWith(musicPrefix)) {
    const musicPath = path.resolve(ROOT, 'music', rel.slice(musicPrefix.length));
    const musicRoot = path.resolve(ROOT, 'music') + path.sep;
    if (!musicPath.startsWith(musicRoot)) return sendError(res, 403, 'Akses ditolak');
    let stat;
    try { stat = fs.statSync(musicPath); } catch (err) { return sendError(res, 404, 'Berkas tidak ditemukan'); }
    if (!stat.isFile()) return sendError(res, 404, 'Berkas tidak ditemukan');
    return sendFile(req, res, musicPath, MIME[path.extname(musicPath).toLowerCase()] || 'application/octet-stream');
  }
  if (!allowed.has(rel)) return sendError(res, 404, 'Berkas tidak ditemukan');
  const target = path.join(ROOT, rel.slice(1));
  let stat;
  try { stat = fs.statSync(target); } catch (err) { return sendError(res, 404, 'Berkas tidak ditemukan'); }
  if (!stat.isFile()) return sendError(res, 404, 'Berkas tidak ditemukan');
  return sendFile(req, res, target, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
}

function configureCors(req, res) {
  const origin = header(req, 'origin');
  if (origin) {
    if (!CORS_ORIGINS.has(origin.replace(/\/+$/, ''))) {
      sendError(res, 403, 'Origin tidak diizinkan.');
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Id,X-Kind,X-Caption,X-Name,X-Width,X-Height,X-Duration,X-Poster,X-Admin-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  return true;
}

async function handleRequest(req, res) {
  if (!configureCors(req, res)) return;
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, 'https://application.invalid');
  } catch (err) {
    return sendError(res, 400, 'URL tidak valid');
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await ensureSchema();
      await handleApi(req, res, url);
    } catch (err) {
      console.error('[api]', err);
      sendError(res, err.status || 500, err.status ? err.message : 'Terjadi kesalahan di server.');
    }
    return;
  }
  return serveStatic(req, res, url);
}

function validateServerConfig() {
  if (!process.env.DATABASE_URL) throw new Error('Atur DATABASE_URL sebelum menjalankan server.');
  if (!process.env.ADMIN_CODE || process.env.ADMIN_CODE.length < 16) {
    throw new Error('ADMIN_CODE wajib berisi setidaknya 16 karakter.');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET wajib berisi setidaknya 32 karakter.');
  }
  getS3();
}

if (require.main === module) {
  try {
    validateServerConfig();
  } catch (err) {
    console.error('[config]', err.message);
    process.exit(1);
  }
  const server = http.createServer(handleRequest);
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error('\n[!] Porta ' + PORT + ' sudah dipakai program lain.');
      process.exit(1);
    }
    throw err;
  });
  ensureSchema().then(() => {
    server.listen(PORT, HOST, () => {
      console.log('Buku Tahunan Digital berjalan di port ' + PORT + ' dengan PostgreSQL dan object storage.');
    });
  }).catch(err => {
    console.error('[database]', err.message);
    process.exit(1);
  });
}

module.exports = { handler: handleRequest, ensureSchema, getPool, getS3 };
