import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function savedSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.ai-settings.json'), 'utf8')) || {};
  } catch { return {}; }
}

export function getAiConfig() {
  const saved = savedSettings();
  const requested = String(saved.provider || process.env.AI_PROVIDER || 'openai').toLowerCase();
  const provider = DEFAULTS[requested] ? requested : 'openai';
  const defaults = DEFAULTS[provider];
  return {
    provider,
    apiKey: saved.apiKey || process.env.AI_API_KEY || '',
    baseUrl: String(saved.baseUrl || process.env.AI_BASE_URL || defaults.baseUrl).replace(/\/$/, ''),
    model: saved.model || process.env.AI_MODEL || defaults.model,
    modelSmall: saved.modelSmall || process.env.AI_MODEL_SMALL || process.env.AI_MODEL || defaults.model,
    sentinelMinutes: number(saved.sentinelMinutes ?? process.env.AI_SENTINEL_MINUTES, 5),
    marketMinutes: number(saved.marketMinutes ?? process.env.AI_MARKET_MINUTES, 30),
    reportHour: number(saved.reportHour ?? process.env.AI_REPORT_HOUR, 20),
    autopilotEnabled: bool(saved.autopilotEnabled ?? process.env.AI_AUTOPILOT, false),
    autopilotMinConfidence: boundedNumber(saved.autopilotMinConfidence ?? process.env.AI_AUTOPILOT_MIN_CONFIDENCE, 0.75, 0.5, 0.95),
    autopilotConfirmations: Math.round(boundedNumber(saved.autopilotConfirmations ?? process.env.AI_AUTOPILOT_CONFIRMATIONS, 2, 2, 6)),
    autopilotCooldownMinutes: Math.round(boundedNumber(saved.autopilotCooldownMinutes ?? process.env.AI_AUTOPILOT_COOLDOWN_MINUTES, 240, 60, 1440)),
  };
}

export function publicAiConfig() {
  const config = getAiConfig();
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    modelSmall: config.modelSmall,
    sentinelMinutes: config.sentinelMinutes,
    marketMinutes: config.marketMinutes,
    reportHour: config.reportHour,
    autopilotEnabled: config.autopilotEnabled,
    autopilotMinConfidence: config.autopilotMinConfidence,
    autopilotConfirmations: config.autopilotConfirmations,
    autopilotCooldownMinutes: config.autopilotCooldownMinutes,
    configured: Boolean(config.apiKey),
  };
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

export async function aiChat({ system = '', messages = [], small = false, json = false, maxTokens = 1200, temperature = 0.3, timeoutMs = 60000 }) {
  const config = getAiConfig();
  if (!config.apiKey) throw new Error('未配置 AI_API_KEY，请在 .env 中填写后重启服务。');
  const model = small ? config.modelSmall : config.model;
  const signal = AbortSignal.timeout(timeoutMs);
  const prompt = json ? `${system}\n必须只输出一个合法 JSON 对象，不要任何其他文字。` : system;

  if (config.provider === 'anthropic') {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system: prompt, messages }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Anthropic 接口错误 HTTP ${response.status}: ${body?.error?.message || ''}`);
    const text = (body?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
    if (!text) throw new Error('AI 返回为空。');
    return text;
  }

  if (config.provider === 'gemini') {
    const contents = messages.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
    const response = await fetch(`${config.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(prompt ? { system_instruction: { parts: [{ text: prompt }] } } : {}),
        contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Gemini 接口错误 HTTP ${response.status}: ${body?.error?.message || ''}`);
    const text = (body?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
    if (!text) throw new Error('AI 返回为空。');
    return text;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature,
      messages: [...(prompt ? [{ role: 'system', content: prompt }] : []), ...messages],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`AI 接口错误 HTTP ${response.status}: ${body?.error?.message || JSON.stringify(body || {}).slice(0, 200)}`);
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI 返回为空。');
  return text;
}

export function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}
