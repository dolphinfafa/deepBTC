import fs from 'node:fs';
import path from 'node:path';
import { validateDailyTime, validateTimezone } from './daily-pnl.js';

export function createNotifier(config, root) {
  const file = path.join(root, '.notification-settings.json');
  let settings = load(file);
  settings = {
    telegramToken: settings.telegramToken ?? config.telegramToken ?? '',
    telegramChatId: settings.telegramChatId ?? config.telegramChatId ?? '',
    dailyEnabled: settings.dailyEnabled ?? false,
    dailyTime: settings.dailyTime || '23:55',
    timezone: settings.timezone || 'Asia/Shanghai',
    updatedAt: settings.updatedAt || null,
  };

  function hasTelegram() { return !!(settings.telegramToken && settings.telegramChatId); }
  function hasAnyChannel() { return hasTelegram() || !!config.webhookUrl; }

  async function send(text) {
    if (!hasAnyChannel()) throw new Error('尚未配置 Telegram 或 Webhook 通知。');
    const message = String(text).slice(0, 3500);
    const tasks = [];
    if (hasTelegram()) {
      tasks.push(postJson(`https://api.telegram.org/bot${settings.telegramToken}/sendMessage`, {
        chat_id: settings.telegramChatId,
        text: message,
      }));
    }
    if (config.webhookUrl) tasks.push(postJson(config.webhookUrl, { text: message }));
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) throw new Error(failed.map((result) => result.reason?.message || String(result.reason)).join('; '));
    return { ok: true, channels: results.length };
  }

  function update(input) {
    const token = String(input.telegramToken || '').trim();
    const chatId = String(input.telegramChatId ?? settings.telegramChatId ?? '').trim();
    const dailyTime = validateDailyTime(input.dailyTime ?? settings.dailyTime);
    const timezone = validateTimezone(input.timezone ?? settings.timezone);
    const dailyEnabled = !!input.dailyEnabled;
    const nextToken = token || settings.telegramToken || '';
    if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Telegram Bot Token 格式无效。');
    if (chatId && !/^-?\d+$/.test(chatId)) throw new Error('TG ID 应为数字，可包含负号。');
    if (dailyEnabled && !(nextToken && chatId) && !config.webhookUrl) {
      throw new Error('开启每日通知前必须配置 Telegram Bot Token 和 TG ID。');
    }
    settings = {
      ...settings,
      telegramToken: nextToken,
      telegramChatId: chatId,
      dailyEnabled,
      dailyTime,
      timezone,
      updatedAt: Date.now(),
    };
    save(file, settings);
    return publicSettings();
  }

  function publicSettings() {
    return {
      enabled: hasAnyChannel(),
      telegramReady: hasTelegram(),
      hasToken: !!settings.telegramToken,
      tokenMask: maskToken(settings.telegramToken),
      telegramChatId: settings.telegramChatId || '',
      dailyEnabled: !!settings.dailyEnabled,
      dailyTime: settings.dailyTime,
      timezone: settings.timezone,
      updatedAt: settings.updatedAt,
    };
  }

  return {
    get enabled() { return hasAnyChannel(); },
    get dailyEnabled() { return !!settings.dailyEnabled; },
    send,
    update,
    publicSettings,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok === false) throw new Error(result?.description || `通知接口 HTTP ${response.status}`);
  return true;
}

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
  catch { return {}; }
}
function save(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows has no POSIX mode */ }
}
function maskToken(value) {
  const text = String(value || '');
  if (!text) return '未配置';
  const colon = text.indexOf(':');
  return colon > 0 ? `${text.slice(0, Math.min(colon, 5))}:***${text.slice(-4)}` : '已保存';
}
