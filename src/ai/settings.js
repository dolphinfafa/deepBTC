import fs from 'node:fs';
import path from 'node:path';

const FILE = '.ai-settings.json';

function filePath(root) { return path.join(root, FILE); }

export function loadAiSettings(root) {
  try { return JSON.parse(fs.readFileSync(filePath(root), 'utf8')) || {}; }
  catch { return {}; }
}

export function updateAiSettings(root, input = {}) {
  const current = loadAiSettings(root);
  const next = { ...current };
  for (const key of ['provider', 'baseUrl', 'model', 'modelSmall']) {
    if (input[key] !== undefined) next[key] = String(input[key] || '').trim();
  }
  if (input.sentinelMinutes !== undefined) next.sentinelMinutes = bounded(input.sentinelMinutes, 0, 1440, 5);
  if (input.marketMinutes !== undefined) next.marketMinutes = bounded(input.marketMinutes, 0, 1440, 30);
  if (input.reportHour !== undefined) next.reportHour = bounded(input.reportHour, -1, 23, 20);
  if (input.apiKey !== undefined && String(input.apiKey).trim()) next.apiKey = String(input.apiKey).trim();
  if (input.clearApiKey === true) delete next.apiKey;
  if (!['openai', 'anthropic', 'gemini'].includes(next.provider)) throw new Error('AI 提供商不受支持。');
  if (next.baseUrl && !/^https?:\/\//i.test(next.baseUrl)) throw new Error('AI Base URL 必须以 http:// 或 https:// 开头。');
  fs.writeFileSync(filePath(root), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath(root), 0o600); } catch {}
  return next;
}

export function publicAiSettings(settings) {
  return {
    provider: settings.provider || 'openai',
    baseUrl: settings.baseUrl || '',
    model: settings.model || '',
    modelSmall: settings.modelSmall || '',
    sentinelMinutes: bounded(settings.sentinelMinutes, 0, 1440, 5),
    marketMinutes: bounded(settings.marketMinutes, 0, 1440, 30),
    reportHour: bounded(settings.reportHour, -1, 23, 20),
    hasApiKey: Boolean(settings.apiKey),
  };
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
