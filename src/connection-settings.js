import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = '.connection-settings.json';

export function loadConnectionSettings(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, FILE_NAME), 'utf8')) || {}; }
  catch { return {}; }
}

export function updateConnectionSettings(root, input, effective = {}) {
  const current = loadConnectionSettings(root);
  const network = input.network === 'testnet' ? 'testnet' : 'mainnet';
  const tradingMode = input.tradingMode === 'live' ? 'live' : 'paper';
  const apiKey = cleanSecret(input.apiKey) || current.apiKey || effective.apiKey || '';
  const privateKey = cleanSecret(input.privateKey) || current.privateKey || effective.privateKey || '';
  const subaccount = cleanSecret(input.subaccount) || current.subaccount || effective.subaccount || '';
  const submittedProxy = cleanSecret(input.proxy);
  const proxy = input.clearProxy === true ? '' : (submittedProxy || current.proxy || effective.proxy || '');

  if (apiKey && apiKey.length < 8) throw new Error('Decibel API Key 格式过短。');
  if (privateKey && !validPrivateKey(privateKey)) throw new Error('API 钱包私钥格式无效，应为 Ed25519 私钥。');
  if (subaccount && !/^0x[0-9a-fA-F]{64}$/.test(subaccount)) throw new Error('Trading Account 必须是 0x 开头的 64 位十六进制地址。');
  if (proxy && proxy.length > 500) throw new Error('代理地址过长。');
  if (tradingMode === 'live') {
    if (input.liveConfirmation !== 'ENABLE DECIBEL LIVE') throw new Error('实盘保存确认短语不正确。');
    if (!apiKey || !privateKey || !subaccount) throw new Error('切换实盘前必须完整配置 API Key、API 钱包私钥和 Trading Account。');
  }

  const next = {
    ...current,
    network,
    tradingMode,
    liveEnabled: tradingMode === 'live',
    updatedAt: Date.now(),
  };
  if (cleanSecret(input.apiKey)) next.apiKey = cleanSecret(input.apiKey);
  if (cleanSecret(input.privateKey)) next.privateKey = cleanSecret(input.privateKey);
  if (cleanSecret(input.subaccount)) next.subaccount = cleanSecret(input.subaccount);
  if (input.clearProxy === true) delete next.proxy;
  else if (submittedProxy) next.proxy = submittedProxy;
  saveSecure(path.join(root, FILE_NAME), next);
  return next;
}

export function publicConnectionSettings(saved, effective) {
  const apiKey = saved.apiKey || effective.apiKey || '';
  const privateKey = saved.privateKey || effective.privateKey || '';
  const subaccount = saved.subaccount || effective.subaccount || '';
  const proxy = saved.proxy || effective.proxy || '';
  return {
    effectiveMode: effective.mode,
    effectiveNetwork: effective.network,
    targetMode: saved.tradingMode || effective.mode,
    targetNetwork: saved.network || effective.network,
    hasApiKey: !!apiKey,
    apiKeyMask: mask(apiKey),
    hasPrivateKey: !!privateKey,
    privateKeyMask: privateKey ? '已安全保存' : '未配置',
    hasSubaccount: !!subaccount,
    subaccountMask: mask(subaccount),
    hasProxy: !!proxy,
    proxyMask: maskProxy(proxy),
    updatedAt: saved.updatedAt || null,
  };
}

function cleanSecret(value) { return String(value || '').trim(); }
function validPrivateKey(value) {
  const text = String(value || '').trim();
  if (text.startsWith('ed25519-priv-')) return text.length > 30;
  return /^(?:0x)?[0-9a-fA-F]{64}$/.test(text);
}
function mask(value) {
  const text = String(value || '');
  if (!text) return '未配置';
  if (text.length <= 12) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, 6)}...${text.slice(-5)}`;
}
function maskProxy(value) {
  if (!value) return '未配置';
  try {
    const normalized = /^\w+:\/\//.test(value) ? value : `http://${value}`;
    const url = new URL(normalized);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch { return '已配置'; }
}
function saveSecure(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows has no POSIX mode */ }
}
