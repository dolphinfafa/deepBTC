import fs from 'node:fs';
import path from 'node:path';

export class DailyPnlTracker {
  constructor(root) {
    this.file = path.join(root, '.daily-pnl.json');
    this.state = this._load();
    this._lastSaveAt = 0;
  }

  observe(equity, timezone, now = Date.now()) {
    const value = Number(equity);
    if (!Number.isFinite(value) || value <= 0) return this.summary(value, timezone, now);
    const clock = zonedClock(now, timezone);
    const newDay = this.state.day !== clock.day || !(Number(this.state.baselineEquity) > 0);
    if (newDay) {
      this.state = { day: clock.day, timezone, baselineEquity: value, latestEquity: value, updatedAt: now, lastSentKey: null, lastSentAt: null };
    } else {
      this.state.timezone = timezone;
      this.state.latestEquity = value;
      this.state.updatedAt = now;
    }
    if (newDay || now - this._lastSaveAt >= 60_000) this._save(now);
    return this.summary(value, timezone, now);
  }

  summary(equity, timezone, now = Date.now()) {
    const value = Number(equity);
    const baseline = Number(this.state.baselineEquity);
    const pnl = Number.isFinite(value) && baseline > 0 ? value - baseline : 0;
    return {
      day: this.state.day || zonedClock(now, timezone).day,
      timezone,
      baselineEquity: baseline > 0 ? round(baseline) : null,
      currentEquity: Number.isFinite(value) ? round(value) : null,
      pnl: round(pnl),
      pnlPct: baseline > 0 ? round((pnl / baseline) * 100) : 0,
      lastSentAt: this.state.lastSentAt || null,
    };
  }

  shouldSend(time, timezone, now = Date.now()) {
    const clock = zonedClock(now, timezone);
    const target = parseTime(time);
    const currentMinutes = clock.hour * 60 + clock.minute;
    const key = `${clock.day}|${time}|${timezone}`;
    return currentMinutes >= target && this.state.lastSentKey !== key;
  }

  markSent(time, timezone, now = Date.now()) {
    const clock = zonedClock(now, timezone);
    this.state.lastSentKey = `${clock.day}|${time}|${timezone}`;
    this.state.lastSentAt = now;
    this._save(now);
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; }
    catch { return {}; }
  }

  _save(now = Date.now()) {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this._lastSaveAt = now;
    } catch { /* tracking must not interrupt trading */ }
  }
}

export function validateTimezone(value) {
  const timezone = String(value || 'Asia/Shanghai');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); return timezone; }
  catch { throw new Error('时区无效，请选择受支持的时区。'); }
}

export function validateDailyTime(value) {
  const time = String(value || '23:55');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('发送时间格式必须是 HH:mm。');
  return time;
}

function zonedClock(now, timezone) {
  const tz = validateTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return {
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
  };
}

function parseTime(time) {
  const valid = validateDailyTime(time);
  const [hour, minute] = valid.split(':').map(Number);
  return hour * 60 + minute;
}

function round(value) { return Math.round(Number(value) * 100) / 100; }
