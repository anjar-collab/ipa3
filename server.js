#!/usr/bin/env node
/* ===========================================================================
   server.js - DATABASE + HOSTING untuk Buku Tahunan Digital (alumni1.html)
   ---------------------------------------------------------------------------
   CARA PAKAI
     1. Pastikan Node.js terpasang (versi 22.5 ke atas, disarankan 24).
     2. Dari folder ini jalankan:      node server.js
        atau double-click             start-server.bat
     3. Buka                         http://localhost:8080/alumni1.html

   APA YANG DISIMPAN (database)
     data/alumni.db     -> database SQLite: metadata foto, video, dan data siswa
     data/uploads/      -> berkas foto & video asli

   Frontend (alumni1.html) mendeteksi server ini otomatis lewat /api/health.
   Kalau server aktif, semua admin & pengunjung memakai database yang sama,
   jadi video/foto yang diunggah langsung terlihat oleh semua orang.
   Kalau server tidak aktif, halaman otomatis memakai database browser
   (IndexedDB) sehingga tetap berfungsi.

   PENGATURAN (opsional, lewat environment variable)
     PORT=8080            porta server
     HOST=0.0.0.0         buka untuk perangkat lain di jaringan (mis. HP)
     ADMIN_CODE=smakam    kode admin, samakan dengan ADMIN_CODE di alumni1.html
     MAX_UPLOAD_MB=3072   batas ukuran satu video (default 3 GB)

   Tidak perlu `npm install`: semua memakai modul bawaan Node (node:sqlite).
   =========================================================================== */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('\n[!] Node.js ini belum punya modul "node:sqlite".');
  console.error('    Gunakan Node.js 22.5 atau lebih baru (disarankan Node 24).');
  console.error('    Unduh: https://nodejs.org\n');
  process.exit(1);
}

/* ---------------------------------------------------------------- konfigurasi */
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const INTRO_TTS_CACHE_DIR = path.join(DATA_DIR, 'intro-tts-cache');
const DB_FILE = path.join(DATA_DIR, 'alumni.db');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_CODE = process.env.ADMIN_CODE || 'smakam';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 3072) * 1024 * 1024;
const MAX_KV = 64 * 1024 * 1024;
const introTtsRequests = new Map();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(INTRO_TTS_CACHE_DIR, { recursive: true });

/* ------------------------------------------------------------------- database */
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS media (
    id        TEXT PRIMARY KEY,
    kind      TEXT NOT NULL,
    caption   TEXT,
    name      TEXT,
    mime      TEXT,
    size      INTEGER DEFAULT 0,
    width     INTEGER DEFAULT 0,
    height    INTEGER DEFAULT 0,
    duration  REAL    DEFAULT 0,
    file      TEXT,
    poster    TEXT,
    ts        INTEGER
  );
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT,
    ts    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind, ts DESC);
`);

const q = {
  insertMedia: db.prepare(
    `INSERT OR REPLACE INTO media (id, kind, caption, name, mime, size, width, height, duration, file, poster, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  allMedia: db.prepare('SELECT * FROM media ORDER BY ts DESC'),
  mediaByKind: db.prepare('SELECT * FROM media WHERE kind = ? ORDER BY ts DESC'),
  mediaById: db.prepare('SELECT * FROM media WHERE id = ?'),
  setPoster: db.prepare("UPDATE media SET poster = '1' WHERE id = ?"),
  delMedia: db.prepare('DELETE FROM media WHERE id = ?'),
  getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
  putKv: db.prepare('INSERT OR REPLACE INTO kv (key, value, ts) VALUES (?, ?, ?)'),
  delKv: db.prepare('DELETE FROM kv WHERE key = ?'),
  allKvKeys: db.prepare('SELECT key FROM kv'),
  sumSize: db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM media'),
  countKind: db.prepare('SELECT COUNT(*) AS n FROM media WHERE kind = ?')
};

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

function isAdmin(req) {
  return safeText(header(req, 'x-admin-code'), 100) === ADMIN_CODE;
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

function apiCounts() {
  return { photo: Number(q.countKind.get('photo').n), video: Number(q.countKind.get('video').n) };
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean);      // ['api', ...]
  const section = seg[1] || '';
  const method = req.method;

  if (section === 'intro-tts') return handleIntroTts(req, res);

  if (section === 'health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'buku-tahunan-db',
      node: process.version,
      db: DB_FILE,
      uploads: UPLOAD_DIR,
      maxUploadBytes: MAX_UPLOAD,
      maxKvBytes: MAX_KV,
      counts: apiCounts()
    });
  }

  if (section === 'stats') {
    return sendJson(res, 200, {
      ok: true,
      usedBytes: Number(q.sumSize.get().total) || 0,
      maxUploadBytes: MAX_UPLOAD,
      counts: apiCounts()
    });
  }

  if (section === 'media') {
    const id = seg[2] ? decodeURIComponent(seg[2]) : '';
    const sub = seg[3] || '';

    if (method === 'GET' && !id) {
      const kind = url.searchParams.get('kind');
      const rows = kind ? q.mediaByKind.all(kind) : q.allMedia.all();
      return sendJson(res, 200, { ok: true, items: rows.map(mediaRowToJson) });
    }

    if (method === 'POST' && !id) {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, unggahan ditolak.');
      const kind = safeText(header(req, 'x-kind'), 20) || 'photo';
      if (kind !== 'photo' && kind !== 'video') return sendError(res, 400, 'Jenis media tidak dikenal.');
      const mime = safeText(header(req, 'content-type'), 120) || 'application/octet-stream';
      const idNew = safeText(header(req, 'x-id'), 80) ||
        Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const name = safeText(header(req, 'x-name'), 200) || idNew;
      const caption = safeText(header(req, 'x-caption'), 300) || name.replace(/\.[^/.]+$/, '');
      const width = Number(header(req, 'x-width')) || 0;
      const height = Number(header(req, 'x-height')) || 0;
      const duration = Number(header(req, 'x-duration')) || 0;

      const dir = path.join(UPLOAD_DIR, kind);
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(name) || EXT_BY_MIME[mime] || (kind === 'video' ? '.mp4' : '.jpg');
      const fileName = idNew + ext.replace(/[^.a-zA-Z0-9]/g, '');
      const dest = path.join(dir, fileName);

      let size;
      try {
        size = await readStreamToFile(req, dest, MAX_UPLOAD);
      } catch (err) {
        return sendError(res, err.status || 500, err.message || 'Gagal menyimpan berkas.');
      }
      if (size === 0) {
        try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
        return sendError(res, 400, 'Berkas kosong.');
      }

      const hasPoster = safeText(header(req, 'x-poster'), 4) === '1';
      q.insertMedia.run(idNew, kind, caption, name, mime, size, width, height, duration,
        path.posix.join(kind, fileName), hasPoster ? '1' : null, Date.now());
      return sendJson(res, 201, { ok: true, id: idNew, size });
    }

    if (method === 'PUT' && id && sub === 'poster') {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, poster ditolak.');
      const row = q.mediaById.get(id);
      if (!row) return sendError(res, 404, 'Media tidak ditemukan');
      const dest = path.join(UPLOAD_DIR, row.file.replace(/\.[^/.]+$/, '') + '-poster.jpg');
      try {
        const size = await readStreamToFile(req, dest, 4 * 1024 * 1024);
        q.setPoster.run(id);
        return sendJson(res, 200, { ok: true, size });
      } catch (err) {
        return sendError(res, err.status || 500, err.message || 'Gagal menyimpan poster');
      }
    }

    if (method === 'GET' && id) {
      const row = q.mediaById.get(id);
      if (!row) return sendError(res, 404, 'Media tidak ditemukan');
      if (sub === 'poster' && row.poster) {
        const posterPath = path.join(UPLOAD_DIR, row.file.replace(/\.[^/.]+$/, '') + '-poster.jpg');
        if (fs.existsSync(posterPath)) return sendFile(req, res, posterPath, 'image/jpeg');
        return sendError(res, 404, 'Poster tidak ada');
      }
      return sendFile(req, res, path.join(UPLOAD_DIR, row.file), row.mime);
    }

    if (method === 'DELETE' && id) {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, penghapusan ditolak.');
      const row = q.mediaById.get(id);
      if (!row) return sendError(res, 404, 'Media tidak ditemukan');
      q.delMedia.run(id);
      try { fs.unlinkSync(path.join(UPLOAD_DIR, row.file)); } catch (e) { /* ignore */ }
      try {
        const posterPath = path.join(UPLOAD_DIR, row.file.replace(/\.[^/.]+$/, '') + '-poster.jpg');
        if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
      } catch (e) { /* ignore */ }
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, 405, 'Metode tidak didukung untuk /api/media');
  }

  if (section === 'kv') {
    const key = seg[2] ? decodeURIComponent(seg[2]) : '';

    if (method === 'GET' && !key) {
      const prefix = url.searchParams.get('prefix') || '';
      const keys = q.allKvKeys.all().map(r => r.key).filter(k => !prefix || k.startsWith(prefix));
      return sendJson(res, 200, { ok: true, keys });
    }
    if (method === 'GET' && key) {
      const row = q.getKv.get(key);
      if (!row) return sendError(res, 404, 'Key tidak ditemukan');
      const payload = Buffer.from(String(row.value), 'utf8');
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
      q.putKv.run(key, value, Date.now());
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE' && key) {
      if (!isAdmin(req)) return sendError(res, 401, 'Kode admin salah, penghapusan ditolak.');
      q.delKv.run(key);
      return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 405, 'Metode tidak didukung untuk /api/kv');
  }

  if (section === 'admin' && method === 'POST') {
    let body = '';
    try { body = await readTextBody(req, 4096); } catch (e) { /* ignore */ }
    if (safeText(body, 100) === ADMIN_CODE) return sendJson(res, 200, { ok: true });
    return sendError(res, 401, 'Kode admin salah');
  }

  return sendError(res, 404, 'Endpoint tidak dikenal');
}

/* ------------------------------------------------------------- berkas statis */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (/^\.env(?:\.|$)/i.test(path.basename(rel))) {
    return sendError(res, 404, 'Berkas tidak ditemukan');
  }
  if (rel === '/' || rel === '') rel = '/alumni1.html';
  const target = path.resolve(path.join(ROOT, rel));
  const rootResolved = path.resolve(ROOT);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    return sendError(res, 403, 'Akses ditolak');
  }
  let stat = null;
  try { stat = fs.statSync(target); } catch (e) { /* ignore */ }
  if (stat && stat.isDirectory()) {
    const idx = path.join(target, 'index.html');
    if (fs.existsSync(idx)) return sendFile(req, res, idx, MIME['.html']);
    return sendError(res, 404, 'Halaman tidak ditemukan');
  }
  if (!stat) {
    const asHtml = path.join(target, target + '.html');
    if (fs.existsSync(asHtml)) return sendFile(req, res, asHtml, MIME['.html']);
    return sendError(res, 404, 'Berkas tidak ditemukan');
  }
  sendFile(req, res, target, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
}

/* ------------------------------------------------------------------- server */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', header(req, 'origin') || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Id,X-Kind,X-Caption,X-Name,X-Width,X-Height,X-Duration,X-Poster,X-Admin-Code');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, 'http://' + (header(req, 'host') || 'localhost'));
  } catch (e) {
    return sendError(res, 400, 'URL tidak valid');
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch(err => {
      console.error('[api]', err);
      sendError(res, err.status || 500, err.message || 'Terjadi kesalahan di server');
    });
  }
  serveStatic(req, res, url);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n[!] Porta ' + PORT + ' sudah dipakai program lain.');
    console.error('    Jalankan dengan porta lain:  set PORT=8081 && node server.js\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const used = Number(q.sumSize.get().total) || 0;
  const counts = apiCounts();
  console.log('');
  console.log('  ========================================================');
  console.log('   BUKU TAHUNAN DIGITAL - DATABASE SERVER');
  console.log('  ========================================================');
  console.log('   Halaman   : http://localhost:' + PORT + '/alumni1.html');
  if (HOST === '0.0.0.0') console.log('   Jaringan   : http://<IP-komputer-ini>:' + PORT + '/alumni1.html');
  console.log('   Database   : ' + DB_FILE);
  console.log('   Unggahan   : ' + UPLOAD_DIR);
  console.log('   Isi DB     : ' + counts.photo + ' foto, ' + counts.video + ' video (' + formatBytes(used) + ')');
  console.log('   Batas file : ' + formatBytes(MAX_UPLOAD) + ' per video');
  console.log('   Kode admin : ' + ADMIN_CODE);
  console.log('  -------------------------------------------------------');
  console.log('   Tekan Ctrl+C untuk menghentikan server.');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nServer dihentikan.');
  try { db.close(); } catch (e) { /* ignore */ }
  process.exit(0);
});
