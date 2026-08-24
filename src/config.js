import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnectionSettings } from './connection-settings.js';
import { BTC_GRID_STRATEGY } from './risk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    const quoted = value.match(/^(?:"([^"]*)"|'([^']*)')/);
    if (quoted) value = quoted[1] ?? quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    process.env[match[1]] = value;
  }
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const RISK_POLICY_FILE = path.join(root, '.risk-policy.json');

export function loadRiskPolicy() {
  try { return JSON.parse(fs.readFileSync(RISK_POLICY_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

export function saveRiskPolicy(policy) {
  const tmp = RISK_POLICY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2), 'utf8');
  fs.renameSync(tmp, RISK_POLICY_FILE);
}

export function getConfig() {
  loadEnv();
  const saved = loadConnectionSettings(root);
  const savedRisk = loadRiskPolicy();
  const network = String(saved.network || process.env.DECIBEL_NETWORK || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
  const apiDefault = network === 'testnet'
    ? 'https://api.testnet.aptoslabs.com/decibel'
    : 'https://api.mainnet.aptoslabs.com/decibel';
  const mode = String(saved.tradingMode || process.env.TRADING_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  const proxy = saved.proxy || process.env.DECIBEL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

  return {
    appName: (process.env.APP_NAME || 'GridPilot').slice(0, 40),
    ownerName: (process.env.OWNER_NAME || '个人版').slice(0, 40),
    host: process.env.HOST || '127.0.0.1',
    port: boundedNumber(process.env.PORT, 8080, 1, 65535),
    dashboardToken: process.env.DASHBOARD_TOKEN || '',
    adminUsername: process.env.ADMIN_USERNAME || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    enableLiveTrading: saved.tradingMode === 'live' ? !!saved.liveEnabled : bool(process.env.ENABLE_LIVE_TRADING),
    liveConfirmation: saved.tradingMode === 'live' && saved.liveEnabled ? 'I_ACCEPT_DECIBEL_LIVE_RISK' : (process.env.LIVE_CONFIRMATION || ''),
    autoResume: bool(process.env.AUTO_RESUME, true),
    autoRebalance: bool(process.env.AUTO_REBALANCE, mode === 'paper'),
    autoRebalanceIntervalMs: boundedNumber(process.env.AUTO_REBALANCE_INTERVAL_MINUTES, 60, 5, 1440) * 60_000,
    autoRebalanceCooldownMs: boundedNumber(process.env.AUTO_REBALANCE_COOLDOWN_MINUTES, 240, 15, 10080) * 60_000,
    autoLiveRebalance: bool(process.env.ENABLE_LIVE_AUTO_REBALANCE, false),
    requireFreshPreflight: bool(process.env.REQUIRE_FRESH_PREFLIGHT, true),
    riskPolicy: {
      maxLeverage: boundedNumber(savedRisk.maxLeverage ?? process.env.LIVE_MAX_LEVERAGE, 10, 1, 50),
      maxGridCount: boundedNumber(savedRisk.maxGridCount ?? process.env.LIVE_MAX_GRID_COUNT, 0, 0, 200),
      maxNotional: boundedNumber(savedRisk.maxNotional ?? process.env.LIVE_MAX_NOTIONAL, 0, 0, 100000000),
      maxMarginPct: boundedNumber(savedRisk.maxMarginPct ?? process.env.LIVE_MAX_MARGIN_PCT, 35, 1, 100),
      minMaintenanceMarginRatio: boundedNumber(savedRisk.minMaintenanceMarginRatio ?? process.env.LIVE_MIN_MAINTENANCE_RATIO, 300, 100, 100000),
      dailyLossLimit: boundedNumber(savedRisk.dailyLossLimit ?? process.env.LIVE_DAILY_LOSS_LIMIT, 20, 1, 100000000),
      maxDrawdownPct: boundedNumber(savedRisk.maxDrawdownPct ?? process.env.LIVE_MAX_DRAWDOWN_PCT, 30, 0.1, 100),
    },
    notifications: {
      telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
      telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
      webhookUrl: process.env.NOTIFY_WEBHOOK || '',
    },
    proxy,
    decibel: {
      // The first release is intentionally BTC-only. Keep the environment
      // variable documented for compatibility, but do not let it widen scope.
      btcOnly: true,
      strategy: BTC_GRID_STRATEGY,
      mode,
      network,
      apiKey: saved.apiKey || process.env.DECIBEL_API_KEY || '',
      privateKey: saved.privateKey || process.env.DECIBEL_PRIVATE_KEY || '',
      subaccount: saved.subaccount || process.env.DECIBEL_SUBACCOUNT || '',
      apiUrl: (process.env.DECIBEL_API_URL || apiDefault).replace(/\/$/, ''),
      origin: process.env.DECIBEL_ORIGIN || 'http://127.0.0.1',
      startBalance: boundedNumber(process.env.PAPER_BALANCE, 10000, 1, 100000000),
      paperFeeRate: boundedNumber(process.env.PAPER_FEE_RATE, 0.0005, 0, 0.1),
      paperSlippageBps: boundedNumber(process.env.PAPER_SLIPPAGE_BPS, 2, 0, 1000),
      paperSpreadBps: boundedNumber(process.env.PAPER_SPREAD_BPS, 1, 0, 1000),
      paperFundingRate: boundedNumber(process.env.PAPER_FUNDING_RATE, 0.0001, -0.1, 0.1),
      paperFundingIntervalMs: boundedNumber(process.env.PAPER_FUNDING_INTERVAL_HOURS, 8, 1, 168) * 3_600_000,
      paperFillDelayMs: boundedNumber(process.env.PAPER_FILL_DELAY_MS, 750, 0, 60_000),
      paperPartialFillProbability: boundedNumber(process.env.PAPER_PARTIAL_FILL_PROBABILITY, 0.35, 0, 1),
      paperPartialFillRatio: boundedNumber(process.env.PAPER_PARTIAL_FILL_RATIO, 0.5, 0.01, 0.99),
      proxy,
    },
  };
}

export const ROOT = root;
