import assert from 'node:assert/strict';
import { buildGrid, seedOrders, replacementFor, isReduceOnly, rungProfit } from '../src/grid.js';
import { normalizeProxy } from '../src/proxy.js';
import { toChainPrice, toChainSize, fromChainPrice, fromChainSize, toLeverageBps, resolvedFillSize, pickNum } from '../src/exchange/de/decibel.js';
import { evaluateStartRisk, LiveRiskState } from '../src/risk.js';
import { GridBot } from '../src/bot.js';
import { DailyPnlTracker } from '../src/daily-pnl.js';
import { createNotifier } from '../src/notifier.js';
import { updateConnectionSettings, publicConnectionSettings } from '../src/connection-settings.js';
import { updateAiSettings, publicAiSettings, loadAiSettings } from '../src/ai/settings.js';
import { EventEmitter } from 'node:events';
import { decibelAuthHeaders } from '../src/exchange/de/auth.js';
import { PaperExchange } from '../src/exchange/de/paper.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

console.log('GridPilot core');

test('builds an arithmetic grid', () => {
  const grid = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  assert.equal(grid.spacing, 10);
  assert.equal(grid.levels.length, 11);
  assert.deepEqual([grid.levels[0], grid.levels.at(-1)], [100, 200]);
});

test('rejects invalid grid bounds and counts', () => {
  assert.throws(() => buildGrid({ lower: 200, upper: 100, gridCount: 10 }));
  assert.throws(() => buildGrid({ lower: 100, upper: 200, gridCount: 1 }));
});

test('seeds neutral, long and short grids correctly', () => {
  const grid = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  const neutral = seedOrders({ levels: grid.levels, price: 151, mode: 'neutral', spacing: grid.spacing });
  assert.ok(neutral.every((order) => order.price < 151 ? order.side === 'buy' : order.side === 'sell'));
  assert.ok(!neutral.some((order) => order.price === 150));
  const long = seedOrders({ levels: grid.levels, price: 150, mode: 'long', spacing: grid.spacing });
  assert.ok(long.every((order) => order.side === 'buy' && !order.reduceOnly));
  const short = seedOrders({ levels: grid.levels, price: 150, mode: 'short', spacing: grid.spacing });
  assert.ok(short.every((order) => order.side === 'sell' && !order.reduceOnly));
});

test('replaces a fill one rung away', () => {
  const grid = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  assert.deepEqual(replacementFor({ side: 'buy', levelIndex: 3 }, grid.levels, 'neutral'), {
    levelIndex: 4, price: 140, side: 'sell', reduceOnly: false,
  });
  assert.deepEqual(replacementFor({ side: 'sell', levelIndex: 4 }, grid.levels, 'neutral'), {
    levelIndex: 3, price: 130, side: 'buy', reduceOnly: false,
  });
});

test('uses reduce-only exits in directional modes', () => {
  assert.equal(isReduceOnly('sell', 'long'), true);
  assert.equal(isReduceOnly('buy', 'short'), true);
  assert.equal(isReduceOnly('buy', 'neutral'), false);
});

test('calculates one-rung gross profit', () => assert.equal(rungProfit(10, 0.5), 5));

test('normalizes common proxy formats', () => {
  assert.equal(normalizeProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxy('host:1080:user:pass'), 'socks5://user:pass@host:1080');
});

test('builds the authentication headers required by Decibel', () => {
  assert.deepEqual(decibelAuthHeaders('geomi-key', 'http://127.0.0.1'), {
    Authorization: 'Bearer geomi-key',
    Origin: 'http://127.0.0.1',
  });
});

test('converts Decibel price and size units', () => {
  const market = { pxDecimals: 2, szDecimals: 4, tickSize: 5, lotSize: 10 };
  assert.equal(toChainPrice(123.47, market), 12345);
  assert.equal(fromChainPrice(12345, market), 123.45);
  assert.equal(toChainSize(0.12349, market), 1230);
  assert.equal(fromChainSize(1230, market), 0.123);
  assert.equal(toLeverageBps(30), 3000);
  assert.equal(resolvedFillSize({ orig_size: 0.001, remaining_size: 0.0006 }, 0.001), 0.0004);
  assert.equal(pickNum({ mark_px: '42.5' }, 'mid_px', 'mark_px'), 42.5);
});

test('live risk policy blocks excessive leverage and notional', () => {
  const result = evaluateStartRisk({
    params: { lower: 60000, upper: 70000, gridCount: 50, sizeBase: 0.01, leverage: 20 },
    market: { maxLeverage: 50, minOrderSize: 0.0001 },
    equity: 1000,
    policy: { maxLeverage: 5, maxGridCount: 40, maxNotional: 5000, maxMarginPct: 35 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('杠杆')));
  assert.ok(result.errors.some((error) => error.includes('网格数量')));
  assert.ok(result.errors.some((error) => error.includes('名义仓位')));
});

test('live risk policy accepts a conservative grid', () => {
  const result = evaluateStartRisk({
    params: { lower: 60000, upper: 70000, gridCount: 10, sizeBase: 0.001, leverage: 3 },
    market: { maxLeverage: 50, minOrderSize: 0.0001 },
    equity: 10000,
    policy: { maxLeverage: 5, maxGridCount: 40, maxNotional: 5000, maxMarginPct: 35 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.metrics.notional, 715);
});

test('live risk rejects an unsafe projected maintenance margin ratio', () => {
  const result = evaluateStartRisk({
    params: { lower: 60000, upper: 70000, gridCount: 40, sizeBase: 0.01, leverage: 10 },
    market: { maxLeverage: 5, minOrderSize: 0.0001 },
    equity: 1000,
    policy: { maxLeverage: 10, maxGridCount: 0, maxNotional: 0, maxMarginPct: 100, minMaintenanceMarginRatio: 300 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('维持保证金率')));
});

test('live risk includes an existing position when re-gridding', () => {
  const result = evaluateStartRisk({
    params: { lower: 60000, upper: 70000, gridCount: 10, sizeBase: 0.001, leverage: 3 },
    market: { maxLeverage: 50, minOrderSize: 0.0001 },
    equity: 10000,
    policy: { maxLeverage: 5, maxGridCount: 40, maxNotional: 1000, maxMarginPct: 35 },
    existingPosition: { sizeBase: 0.01 },
    currentPrice: 65000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.metrics.gridNotional, 715);
  assert.equal(result.metrics.existingNotional, 650);
  assert.ok(result.errors.some((error) => error.includes('名义仓位')));
});

test('daily loss state persists its halt across restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridpilot-risk-'));
  try {
    const policy = { dailyLossLimit: 100, maxDrawdownPct: 20 };
    const first = new LiveRiskState(dir, policy);
    first.reset(1000, Date.UTC(2026, 7, 5, 0, 0, 0));
    const halted = first.observe(890, Date.UTC(2026, 7, 5, 1, 0, 0));
    assert.equal(halted.halted, true);
    const restored = new LiveRiskState(dir, policy).status(950, Date.UTC(2026, 7, 5, 2, 0, 0));
    assert.equal(restored.halted, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live start aborts when leverage configuration fails', async () => {
  const exchange = fakeLiveExchange({ leverageOk: false });
  const bot = new GridBot(exchange);
  await assert.rejects(() => bot.start(gridConfig()), /杠杆设置.*中止/);
  assert.equal(exchange.placed, 0);
  assert.equal(bot.running, false);
});

test('live start rolls back a partially placed initial ladder', async () => {
  const exchange = fakeLiveExchange({ failAfter: 1 });
  const bot = new GridBot(exchange);
  await assert.rejects(() => bot.start(gridConfig()), /初始网格仅成功挂出/);
  assert.ok(exchange.cancelCalls >= 2);
  assert.equal(bot.active.size, 0);
  assert.equal(bot.running, false);
});

test('daily PnL tracks the selected timezone day and avoids duplicate sends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridpilot-daily-'));
  try {
    const tracker = new DailyPnlTracker(dir);
    const morning = Date.UTC(2026, 7, 5, 1, 0, 0);
    tracker.observe(1000, 'UTC', morning);
    const summary = tracker.observe(1025, 'UTC', Date.UTC(2026, 7, 5, 12, 1, 0));
    assert.equal(summary.pnl, 25);
    assert.equal(summary.pnlPct, 2.5);
    assert.equal(tracker.shouldSend('12:00', 'UTC', Date.UTC(2026, 7, 5, 12, 1, 0)), true);
    tracker.markSent('12:00', 'UTC', Date.UTC(2026, 7, 5, 12, 1, 0));
    assert.equal(tracker.shouldSend('12:00', 'UTC', Date.UTC(2026, 7, 5, 12, 2, 0)), false);
    const nextDay = tracker.observe(1100, 'UTC', Date.UTC(2026, 7, 6, 0, 1, 0));
    assert.equal(nextDay.baselineEquity, 1100);
    assert.equal(nextDay.pnl, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notification settings persist without exposing the Telegram token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridpilot-notify-'));
  try {
    const notifier = createNotifier({}, dir);
    const settings = notifier.update({
      telegramToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd',
      telegramChatId: '-1001234567890',
      dailyEnabled: true,
      dailyTime: '21:30',
      timezone: 'Asia/Shanghai',
    });
    assert.equal(settings.telegramReady, true);
    assert.equal(settings.dailyEnabled, true);
    assert.equal('telegramToken' in settings, false);
    const restored = createNotifier({}, dir).publicSettings();
    assert.equal(restored.telegramChatId, '-1001234567890');
    assert.equal(restored.hasToken, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('connection settings require explicit live confirmation and mask secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridpilot-connection-'));
  const values = {
    apiKey: 'geomi-api-key-value',
    privateKey: '1'.repeat(64),
    subaccount: `0x${'2'.repeat(64)}`,
    proxy: 'socks5://user:secret@127.0.0.1:1080',
    network: 'mainnet',
    tradingMode: 'live',
  };
  try {
    assert.throws(() => updateConnectionSettings(dir, values), /确认短语/);
    const saved = updateConnectionSettings(dir, { ...values, liveConfirmation: 'ENABLE DECIBEL LIVE' });
    const visible = publicConnectionSettings(saved, { mode: 'paper', network: 'mainnet' });
    assert.equal(visible.targetMode, 'live');
    assert.equal(visible.hasPrivateKey, true);
    assert.equal('privateKey' in visible, false);
    assert.equal(visible.hasProxy, true);
    assert.equal(visible.proxyMask, 'socks5://127.0.0.1:1080');
    assert.ok(!visible.subaccountMask.includes('22222222222222222222'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AI settings persist locally without exposing the API key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridpilot-ai-'));
  try {
    const saved = updateAiSettings(dir, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-secret',
    });
    assert.equal(saved.apiKey, 'sk-test-secret');
    const visible = publicAiSettings(loadAiSettings(dir));
    assert.equal(visible.hasApiKey, true);
    assert.equal('apiKey' in visible, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('paper exchange restores account state and advances adopted order ids', async () => {
  const first = new PaperExchange({ startBalance: 10000 });
  first.markets.set(1, { marketId: 1, displayName: 'BTC/USD', addr: 'btc-address' });
  first._applyFill(1, 'buy', 100, 2);
  first.adoptOrder({ orderId: 'paper-80', marketId: 1, levelIndex: 1, side: 'buy', price: 99, sizeBase: 1 });
  const snapshot = first.exportState();

  const restored = new PaperExchange({ startBalance: 10000 });
  restored.markets.set(7, { marketId: 7, displayName: 'BTC/USD', addr: 'btc-address' });
  restored.restoreState(snapshot);
  restored.adoptOrder({ orderId: 'paper-80', marketId: 7, levelIndex: 1, side: 'buy', price: 99, sizeBase: 1 });
  const placed = await restored.placeLimitOrder({ marketId: 7, levelIndex: 2, side: 'sell', price: 101, sizeBase: 1 });

  assert.equal(restored.getPosition(7).sizeBase, 2);
  assert.equal(restored.balance, first.balance);
  assert.equal(restored.realizedPnl, first.realizedPnl);
  assert.equal(placed.orderId, 'paper-81');
});

test('legacy paper state restores only the configured market position', () => {
  const exchange = new PaperExchange({ startBalance: 10000 });
  exchange.restoreState({
    positions: [[30, { sizeBase: 0.004, entryPrice: 64500 }], [31, { sizeBase: -0.002, entryPrice: 64400 }]],
  }, { legacyMarketId: 31, marketId: 8 });
  assert.equal(exchange.positions.size, 1);
  assert.equal(exchange.getPosition(8).sizeBase, -0.002);
  assert.equal(exchange.getPosition(30), null);
});

test('paper recovery preserves reduce-only semantics', () => {
  const exchange = new PaperExchange({ startBalance: 10000 });
  exchange.adoptOrder({ orderId: 'paper-9', marketId: 1, levelIndex: 1, side: 'sell', price: 101, sizeBase: 1, reduceOnly: true });
  exchange._matchFills(1, 100, 102);
  assert.equal(exchange.getOpenOrders(1).length, 0);
  assert.equal(exchange.getPosition(1), null);
});

test('neutral grid resume does not turn replacement orders into reduce-only orders', async () => {
  const exchange = new EventEmitter();
  exchange.mode = 'paper';
  exchange.balance = 10000;
  exchange.equity = 10000;
  exchange.feeRate = 0.0005;
  exchange.adopted = [];
  exchange.restoreState = () => true;
  exchange.adoptOrder = (order) => exchange.adopted.push(order);
  exchange.start = () => {};
  exchange.getOpenOrders = () => [];
  exchange.fetchOpenOrders = async () => exchange.adopted.map((order) => ({ orderId: order.orderId, price: order.price, side: order.side }));
  exchange.getPosition = () => null;

  const bot = new GridBot(exchange);
  await bot.resume({
    running: true,
    config: { ...gridConfig(), displayName: 'TEST-USD', stepSize: 0.01, stepPrice: 0.1 },
    active: [['paper-1', { levelIndex: 3, side: 'sell', price: 105, sizeBase: 1, opening: false }]],
  });

  assert.equal(exchange.adopted[0].reduceOnly, false);
});

test('range adjustment re-seeds orders without closing the position', async () => {
  const exchange = fakeLiveExchange();
  const bot = new GridBot(exchange);
  await bot.start(gridConfig());
  await bot.adjustRange({ lower: 95, upper: 105 });
  assert.equal(bot.config.lower, 95);
  assert.equal(bot.config.upper, 105);
  assert.equal(bot.running, true);
  assert.ok(bot.active.size > 0);
  assert.equal(exchange.closeCalls, 0);
  await bot.stop({ closePosition: false });
});

test('trading activity records orders and cancellations and survives restore', async () => {
  const exchange = fakeLiveExchange();
  const bot = new GridBot(exchange);
  await bot.start(gridConfig());
  const placed = bot.active.size;
  assert.ok(placed > 0);
  assert.equal(bot.getState().activity.filter((item) => item.type === 'order').length, placed);

  await bot.cancelAllOrders();
  const state = bot.getState();
  assert.equal(state.activity.filter((item) => item.type === 'cancel' && item.message.startsWith('一键撤销挂单')).length, placed);

  const restored = new GridBot(fakeLiveExchange());
  restored.restore(bot.snapshot());
  assert.deepEqual(restored.getState().activity, state.activity);
});

test('price beyond the range closes and stops by default', async () => {
  const exchange = fakeLiveExchange();
  const bot = new GridBot(exchange);
  await bot.start(gridConfig());
  exchange.emit('price', { marketId: 1, price: 120 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bot.running, false);
  assert.ok(exchange.closeCalls >= 1);
});

for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log('  OK ' + name);
  } catch (error) {
    failed++;
    console.error('  FAIL ' + name + '\n    ' + (error?.message || error));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

function gridConfig() {
  return { marketId: 1, mode: 'neutral', lower: 90, upper: 110, gridCount: 4, sizeBase: 1, leverage: 2, outOfRangeAction: 'close' };
}

function fakeLiveExchange({ leverageOk = true, failAfter = Infinity } = {}) {
  const exchange = new EventEmitter();
  exchange.mode = 'live';
  exchange.equity = 10000;
  exchange.balance = 10000;
  exchange.feeRate = 0.0005;
  exchange.placed = 0;
  exchange.cancelCalls = 0;
  exchange.closeCalls = 0;
  exchange.getMarkets = async () => [{ marketId: 1, displayName: 'TEST-USD', maxLeverage: 20, minOrderSize: 0.01, stepSize: 0.01, stepPrice: 0.1 }];
  exchange.setLeverage = async () => leverageOk;
  exchange.cancelAll = async () => { exchange.cancelCalls++; return true; };
  exchange.getPrice = async () => 100;
  exchange.getPosition = () => null;
  exchange.closePosition = async () => { exchange.closeCalls++; return true; };
  exchange.placeLimitOrder = async (order) => {
    if (exchange.placed >= failAfter) throw new Error('simulated reject');
    exchange.placed++;
    return { orderId: String(exchange.placed), price: order.price, sizeBase: order.sizeBase };
  };
  exchange.start = () => {};
  exchange.stop = () => {};
  return exchange;
}
