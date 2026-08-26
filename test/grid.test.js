import assert from 'node:assert/strict';
import { buildGrid, seedOrders, replacementFor, isReduceOnly, rungProfit } from '../src/grid.js';
import { normalizeProxy } from '../src/proxy.js';
import { toChainPrice, toChainSize, fromChainPrice, fromChainSize, toLeverageBps, resolvedFillSize, pickNum } from '../src/exchange/de/decibel.js';
import { evaluateStartRisk, LiveRiskState, evaluateStrategyParams } from '../src/risk.js';
import { autoRebalanceGate, rangeChangedEnough } from '../src/auto-rebalance.js';
import { GridBot } from '../src/bot.js';
import { suggestAdaptiveGrid } from '../src/adaptive-grid.js';
import { projectDashboardState, resolveDashboardRoute } from '../src/dashboard-routing.js';
import { DailyPnlTracker } from '../src/daily-pnl.js';
import { createNotifier } from '../src/notifier.js';
import { updateConnectionSettings, publicConnectionSettings } from '../src/connection-settings.js';
import { updateAiSettings, publicAiSettings, loadAiSettings } from '../src/ai/settings.js';
import { EventEmitter } from 'node:events';
import { decibelAuthHeaders } from '../src/exchange/de/auth.js';
import { PaperExchange } from '../src/exchange/de/paper.js';
import { directionalExposure, inventoryOrderDecision, isPassiveOpeningOrder } from '../src/strategy-guards.js';
import '../public/grid-form-state.js';
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

test('dashboard suggestions preserve a manually selected grid direction', () => {
  const resolve = globalThis.GridPilotForm.resolveSuggestedMode;
  assert.equal(resolve({ manualMode: true, currentMode: 'long', suggestedMode: 'neutral' }), 'long');
  assert.equal(resolve({ manualMode: true, currentMode: 'short', suggestedMode: 'neutral' }), 'short');
  assert.equal(resolve({ manualMode: false, currentMode: 'long', suggestedMode: 'neutral' }), 'neutral');
  assert.equal(resolve({ manualMode: false, currentMode: 'neutral', suggestedMode: 'short' }), 'short');
  assert.equal(resolve({ manualMode: false, currentMode: 'neutral', suggestedMode: 'invalid' }), 'neutral');
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

test('suggests a conservative BTC grid from ATR and equity', () => {
  const result = suggestAdaptiveGrid({
    price: 70000, atrPct: 1.2, equity: 10000,
    market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
  });
  assert.equal(result.mode, 'neutral');
  assert.ok(result.lower < 70000 && result.upper > 70000);
  assert.ok(result.gridCount >= 10 && result.gridCount <= 40);
  assert.ok(result.sizeBase >= 0.0001);
  assert.equal(result.leverage, 2);
});

test('locks the first strategy to BTC-USD and 10-40 grids', () => {
  const market = { displayName: 'BTC-USD' };
  assert.equal(evaluateStrategyParams({ params: { mode: 'neutral', gridCount: 20 }, market }).ok, true);
  assert.equal(evaluateStrategyParams({ params: { mode: 'neutral', gridCount: 9 }, market }).ok, false);
  assert.equal(evaluateStrategyParams({ params: { mode: 'neutral', gridCount: 41 }, market }).ok, false);
  assert.equal(evaluateStrategyParams({ params: { mode: 'neutral', gridCount: 20 }, market: { displayName: 'ETH-USD' } }).ok, false);
});

test('directional exposure uses account equity as its cap basis', () => {
  const exposure = directionalExposure({
    positionSize: -0.02,
    price: 75_000,
    equity: 10_000,
    maxDirectionalNotionalPct: 15,
  });
  assert.equal(exposure.side, 'short');
  assert.equal(exposure.notional, 1_500);
  assert.equal(exposure.pct, 15);
  assert.equal(exposure.atCap, true);
});

test('inventory guard makes exits reduce-only and caps their size', () => {
  const decision = inventoryOrderDecision({
    side: 'sell', sizeBase: 0.01, positionSize: 0.004,
    price: 75_000, equity: 10_000, maxDirectionalNotionalPct: 15,
    trendGuardEnabled: true, trend: 'up', trendStrength: 0.9,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reduceOnly, true);
  assert.equal(decision.opening, false);
  assert.equal(decision.sizeBase, 0.004);
});

test('inventory guard blocks the order that would exceed directional exposure', () => {
  const decision = inventoryOrderDecision({
    side: 'sell', sizeBase: 0.005, positionSize: -0.02,
    price: 75_000, equity: 10_000, maxDirectionalNotionalPct: 15,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'exposure_cap');
});

test('trend guard pauses only the dangerous opening direction', () => {
  const base = {
    sizeBase: 0.001, positionSize: 0, price: 75_000, equity: 10_000,
    maxDirectionalNotionalPct: 15, trendGuardEnabled: true,
    trend: 'up', trendStrength: 0.8, trendGuardMinStrength: 0.55,
  };
  assert.equal(inventoryOrderDecision({ ...base, side: 'sell' }).reason, 'trend_up_blocks_short');
  assert.equal(inventoryOrderDecision({ ...base, side: 'buy' }).allowed, true);
});

test('guard resumes only opening limits that remain passive to the market', () => {
  assert.equal(isPassiveOpeningOrder({ side: 'buy', price: 99, marketPrice: 100 }), true);
  assert.equal(isPassiveOpeningOrder({ side: 'buy', price: 101, marketPrice: 100 }), false);
  assert.equal(isPassiveOpeningOrder({ side: 'sell', price: 101, marketPrice: 100 }), true);
  assert.equal(isPassiveOpeningOrder({ side: 'sell', price: 99, marketPrice: 100 }), false);
});

test('bot keeps a stale deferred opening order paused until it is passive again', async () => {
  const exchange = fakeLiveExchange();
  const bot = new GridBot(exchange);
  bot.running = true;
  bot.config = {
    ...gridConfig(),
    maxDirectionalNotionalPct: 15,
    trendGuardEnabled: true,
    trendGuardMinStrength: 0.55,
  };
  bot.lastPrice = 100;
  bot._guardDeferred.set(3, {
    levelIndex: 3,
    side: 'sell',
    price: 99,
    sizeBase: 1,
    opening: true,
  });

  await bot._enforceStrategyGuards();
  assert.equal(exchange.placed, 0);
  assert.equal(bot._guardDeferred.has(3), true);

  bot.lastPrice = 98;
  await bot._enforceStrategyGuards();
  assert.equal(exchange.placed, 1);
  assert.equal(bot._guardDeferred.has(3), false);
});

test('paper exchange exposes only the exact BTC-USD market', async () => {
  const exchange = new PaperExchange({ btcOnly: true });
  exchange._setMarkets([
    { marketId: 4, displayName: 'ETH-USD', symbol: 'ETH' },
    { marketId: 5, displayName: 'BTC-USDC', symbol: 'BTC' },
    { marketId: 6, displayName: 'BTC-USD', symbol: 'BTC' },
  ]);
  assert.deepEqual((await exchange.getMarkets()).map((market) => market.displayName), ['BTC-USD']);
});

test('auto rebalance gates require a running grid, edge, interval and cooldown', () => {
  const base = { enabled: true, running: true, hasConfig: true, now: 1_000_000, price: 101, lower: 90, upper: 110 };
  assert.equal(autoRebalanceGate({ ...base, running: false }).reason, 'not_running');
  assert.equal(autoRebalanceGate({ ...base, price: 100 }).reason, 'not_near_edge');
  assert.equal(autoRebalanceGate({ ...base, lastCheckAt: 999_000, intervalMs: 60_000 }).reason, 'check_interval');
  assert.equal(autoRebalanceGate({ ...base, lastAdjustedAt: 999_000, cooldownMs: 120_000 }).reason, 'cooldown');
  assert.equal(autoRebalanceGate({ ...base, price: 91 }).ok, true);
});

test('range changes below ten percent are skipped', () => {
  assert.equal(rangeChangedEnough({ previous: { lower: 90, upper: 110 }, next: { lower: 91, upper: 109 } }), false);
  assert.equal(rangeChangedEnough({ previous: { lower: 90, upper: 110 }, next: { lower: 92, upper: 110 } }), true);
});

test('routes paper and live dashboards to distinct page views', () => {
  assert.deepEqual(resolveDashboardRoute('/'), { matched: true, view: null });
  assert.deepEqual(resolveDashboardRoute('/paper'), { matched: true, view: 'paper' });
  assert.deepEqual(resolveDashboardRoute('/paper.html'), { matched: true, view: 'paper' });
  assert.deepEqual(resolveDashboardRoute('/live/'), { matched: true, view: 'live' });
  assert.deepEqual(resolveDashboardRoute('/api/state'), { matched: false, view: null });
});

test('dashboard state never exposes a running paper bot as a running live bot', () => {
  const paperState = {
    mode: 'paper', running: true, config: { displayName: 'BTC-USD' },
    openOrders: 28, exchangeOpenOrders: 28, equity: 10_000,
    position: { sizeBase: 0.01 }, totalPnl: 12.5,
    strategyGuard: { exposure: { pct: 12 } }, executionCosts: { total: 3 },
    measurement: { id: 'paper-run' }, measurementHistory: [{ id: 'old-paper-run' }],
    activity: [{ t: 1, message: 'paper fill' }], lastPrice: 77_000,
  };
  const liveView = projectDashboardState(paperState, 'paper', 'live');

  assert.equal(liveView.runtimeAvailable, false);
  assert.equal(liveView.runtimeMode, 'paper');
  assert.equal(liveView.mode, 'live');
  assert.equal(liveView.running, false);
  assert.equal(liveView.config, null);
  assert.equal(liveView.openOrders, 0);
  assert.equal(liveView.position, null);
  assert.equal(liveView.equity, null);
  assert.equal(liveView.totalPnl, null);
  assert.deepEqual(liveView.activity, []);
  assert.equal(liveView.strategyGuard, null);
  assert.equal(liveView.executionCosts, null);
  assert.equal(liveView.measurement, null);
  assert.equal(liveView.lastPrice, 77_000);
  assert.equal(liveView.health.reason, '实盘服务未启动');
});

test('dashboard state keeps the active mode state unchanged', () => {
  const state = { mode: 'paper', running: true, openOrders: 12, equity: 10_001 };
  const paperView = projectDashboardState(state, 'paper', 'paper');
  assert.equal(paperView.runtimeAvailable, true);
  assert.equal(paperView.running, true);
  assert.equal(paperView.openOrders, 12);
  assert.equal(paperView.equity, 10_001);
});

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

test('bot starts long and short grids with only the submitted opening side', async () => {
  for (const [mode, side] of [['long', 'buy'], ['short', 'sell']]) {
    const exchange = fakeLiveExchange();
    const bot = new GridBot(exchange);
    await bot.start({ ...gridConfig(), mode });

    assert.equal(bot.config.mode, mode);
    assert.ok(bot.active.size > 0);
    assert.ok([...bot.active.values()].every((order) => order.side === side && !order.reduceOnly));

    await bot.stop({ closePosition: false });
  }
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

test('daily PnL rebaseline excludes a paper deposit from daily profit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridpilot-daily-rebaseline-'));
  try {
    const tracker = new DailyPnlTracker(dir);
    const now = Date.UTC(2026, 7, 5, 12, 0, 0);
    tracker.observe(1000, 'UTC', now);
    tracker.markSent('11:00', 'UTC', now);
    const summary = tracker.rebaseline(5000, 'UTC', now + 1000);
    assert.equal(summary.baselineEquity, 5000);
    assert.equal(summary.currentEquity, 5000);
    assert.equal(summary.pnl, 0);
    assert.equal(tracker.shouldSend('11:00', 'UTC', now + 2000), false);
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

test('paper equity adjustment requires an empty account and valid amount', async () => {
  const exchange = new PaperExchange({ startBalance: 10000 });
  assert.throws(() => exchange.setAccountEquity(0), /1-100,000,000/);
  assert.throws(() => exchange.setAccountEquity(Number.NaN), /1-100,000,000/);

  const order = await exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 100, sizeBase: 1 });
  assert.throws(() => exchange.setAccountEquity(20000), /仍有模拟挂单/);
  await exchange.cancelOrder(1, order.orderId);

  exchange.positions.set(1, { sizeBase: 1, entryPrice: 100 });
  assert.throws(() => exchange.setAccountEquity(20000), /仍有模拟持仓/);
  exchange.positions.set(1, { sizeBase: 0, entryPrice: 0 });

  const result = exchange.setAccountEquity(20000.129);
  assert.equal(result.previousEquity, 10000);
  assert.equal(result.equity, 20000.13);
  assert.equal(exchange.balance, 20000.13);
});

test('paper equity adjustment starts a clean strategy measurement', () => {
  const exchange = new PaperExchange({
    startBalance: 10000,
    feeRate: 0.001,
    slippageBps: 0,
    spreadBps: 0,
    fundingRate: 0,
  });
  exchange.markets.set(1, { marketId: 1, displayName: 'BTC-USD' });
  exchange.prices.set(1, 100);
  let persisted = null;
  const bot = new GridBot(exchange, { onChange: (snapshot) => { persisted = snapshot; } });
  bot.restore({ config: gridConfig() });
  bot.resetStats();
  exchange._applyFill(1, 'buy', 100, 1);
  exchange._applyFill(1, 'sell', 100, 1);
  assert.equal(bot.getState().totalPnl, -0.2);

  const state = bot.setPaperEquity(20000);
  assert.equal(state.equity, 20000);
  assert.equal(state.totalPnl, 0);
  assert.equal(state.returnPct, 0);
  assert.equal(state.measurement.reason, 'paper_equity_adjustment');
  assert.equal(state.measurement.baselineEquity, 20000);
  assert.equal(state.measurementHistory[0].results.totalPnl, -0.2);
  assert.equal(exchange.realizedPnl, -0.2);
  assert.equal(persisted.exchangeState.balance, 20000);
});

test('bot rejects paper equity adjustment while trading or in live mode', () => {
  const paper = new PaperExchange({ startBalance: 10000 });
  const bot = new GridBot(paper);
  bot.running = true;
  assert.throws(() => bot.setPaperEquity(20000), /网格运行中/);
  bot.running = false;
  bot.recovery = true;
  assert.throws(() => bot.setPaperEquity(20000), /恢复流程进行中/);

  const liveBot = new GridBot(fakeLiveExchange());
  assert.throws(() => liveBot.setPaperEquity(20000), /只有 PAPER/);
});

test('paper exchange reports fees, slippage, spread and funding separately', () => {
  const exchange = new PaperExchange({
    startBalance: 10_000,
    feeRate: 0.001,
    slippageBps: 10,
    spreadBps: 5,
    fundingRate: 0.001,
    fundingIntervalMs: 8 * 3_600_000,
  });
  exchange.prices.set(1, 100);
  exchange.lastFundingAt = 0;
  exchange._applyFill(1, 'buy', 100, 2);
  exchange._applyFunding(8 * 3_600_000);
  const costs = exchange.getExecutionCosts();
  assert.equal(costs.fees, 0.2);
  assert.equal(costs.slippage, 0.2);
  assert.equal(costs.spread, 0.1);
  assert.equal(costs.funding, 0.2);
  assert.equal(costs.total, 0.7);
  assert.equal(exchange.balance, 9999.3);
});

test('paper partial fills retain the remaining order and expose remaining size', async () => {
  const exchange = new PaperExchange({
    fillDelayMs: 0,
    partialFillProbability: 1,
    partialFillRatio: 0.5,
    feeRate: 0,
    slippageBps: 0,
    spreadBps: 0,
    random: () => 0,
  });
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));
  await exchange.placeLimitOrder({ marketId: 1, levelIndex: 1, side: 'buy', price: 100, sizeBase: 1 });
  exchange._matchFills(1, 101, 99);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].sizeBase, 0.5);
  assert.equal(fills[0].remainingSize, 0.5);
  assert.equal(exchange.getOpenOrders(1)[0].remainingSize, 0.5);
});

test('bot keeps a partially filled order active until its remaining size is zero', () => {
  const exchange = fakeLiveExchange();
  const bot = new GridBot(exchange);
  bot.running = true;
  bot.config = { ...gridConfig(), displayName: 'TEST-USD', maxDirectionalNotionalPct: 15, trendGuardEnabled: false };
  bot.grid = buildGrid({ lower: 90, upper: 110, gridCount: 4 });
  bot.outOfRange = true;
  bot.active.set('partial-1', { levelIndex: 1, side: 'buy', price: 95, sizeBase: 1, opening: true });
  bot._handleFill({ orderId: 'partial-1', marketId: 1, levelIndex: 1, side: 'buy', price: 95, sizeBase: 0.4, remainingSize: 0.6 });
  assert.equal(bot.active.get('partial-1').sizeBase, 0.6);
  assert.equal(bot.stats.buys, 1);
  bot.running = false;
});

test('bot reclassifies exits as reduce-only and pauses opening orders beyond the exposure cap', async () => {
  const exchange = new PaperExchange({
    startBalance: 1000,
    fillDelayMs: 0,
    partialFillProbability: 0,
    feeRate: 0,
    slippageBps: 0,
    spreadBps: 0,
  });
  exchange.markets.set(1, { marketId: 1, displayName: 'BTC-USD', symbol: 'BTC', maxLeverage: 20, minOrderSize: 0.01, stepSize: 0.01, stepPrice: 0.1 });
  exchange.prices.set(1, 100);
  exchange.realTarget.set(1, 100);
  exchange.candleDataSource = 'spot';
  exchange.getCandles = async () => Array.from({ length: 60 }, (_, index) => ({ time: index, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  exchange.start = () => {};

  const bot = new GridBot(exchange);
  await bot.start({ ...gridConfig(), maxDirectionalNotionalPct: 15, trendGuardEnabled: true });
  exchange._matchFills(1, 100, 94);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(exchange.getPosition(1).sizeBase, 1);
  assert.equal([...bot.active.values()].some((order) => order.opening && order.side === 'buy'), false);
  assert.ok([...bot.active.values()].filter((order) => order.side === 'sell').every((order) => order.reduceOnly));
  assert.ok(bot.getState().strategyGuard.blockedOpeningSides.includes('buy'));

  exchange._matchFills(1, 94, 101);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exchange.getPosition(1), null);
  assert.ok([...bot.active.values()].some((order) => order.opening && order.side === 'buy'));
  assert.ok([...bot.active.values()].some((order) => order.opening && order.side === 'sell'));
  await bot.stop({ closePosition: false });
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
  assert.equal(bot.getState().measurement.sequence, 2);
  assert.equal(bot.getState().measurementHistory.length, 1);
  assert.equal(bot.getState().stats.completedRungs, 0);
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
