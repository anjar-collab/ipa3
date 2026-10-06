const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/alumni.db');
const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'profilephoto:%' ORDER BY key").all();
for (const r of rows) {
  const obj = JSON.parse(r.value);
  const d = String(obj.data);
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(d);
  if (!m) { console.log(r.key, 'BUKAN data URL'); continue; }
  const buf = Buffer.from(m[2], 'base64');
  const jpegSOI = buf[0] === 0xFF && buf[1] === 0xD8;
  const jpegEOI = buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
  const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  const webp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  console.log(r.key, '| mime=' + m[1], '| bytes=' + buf.length, '| jpegSOI=' + jpegSOI, '| jpegEOI=' + jpegEOI, '| png=' + png, '| webp=' + webp);
}