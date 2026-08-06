import fs from 'node:fs';
import path from 'node:path';

export function createAuditLog(root) {
  const file = path.join(root, '.audit.jsonl');

  function write(action, detail = {}, level = 'info') {
    const entry = { t: Date.now(), level, action, detail: sanitize(detail) };
    try {
      rotate(file);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* audit failures must not crash trading */ }
    return entry;
  }

  function recent(limit = 100) {
    try {
      return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-Math.min(500, limit)).map((line) => JSON.parse(line)).reverse();
    } catch { return []; }
  }

  return { file, write, recent };
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /key|secret|token|private|password/i.test(key) ? '[REDACTED]' : sanitize(item);
  }
  return out;
}

function rotate(file) {
  try {
    if (fs.statSync(file).size < 5_000_000) return;
    fs.renameSync(file, file + '.1');
  } catch { /* no existing file */ }
}
