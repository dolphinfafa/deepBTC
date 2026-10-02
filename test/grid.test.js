import assert from 'node:assert/strict';
import { buildGrid, seedOrders, replacementFor, isReduceOnly, rungProfit } from '../src/grid.js';
import { normalizeProxy } from '../src/proxy.js';
import { toChainPrice, toChainSize, fromChainPrice, fromChainSize, toLeverageBps, resolvedFillSize, pickNum } from '../src/exchange/de/decibel.js';
import { evaluateStartRisk, LiveRiskState, evaluateStrategyParams } from '../src/risk.js';
import { adaptiveGridChangedEnough, autoRebalanceGate, rangeChangedEnough } from '../src/auto-rebalance.js';
import { GridBot } from '../src/bot.js';
import { suggestAdaptiveGrid } from '../src/adaptive-grid.js';
import { projectDashboardState, resolveDashboardRoute } from '../src/dashboard-routing.js';
import { DailyPnlTracker } from '../src/daily-pnl.js';
import { createNotifier } from '../src/notifier.js';
import { updateConnectionSettings, publicConnectionSettings } from '../src/connection-settings.js';
import { updateAiSettings, publicAiSettings, loadAiSettings } from '../src/ai/settings.js';
import { parseXaiSearchResponse } from '../src/ai/provider.js';
import { EventEmitter } from 'node:events';
import { decibelAuthHeaders } from '../src/exchange/de/auth.js';
import { PaperExchange } from '../src/exchange/de/paper.js';
import { directionalExposure, inventoryOrderDecision, isPassiveOpeningOrder } from '../src/strategy-guards.js';
import { executionFriction, neutralInventorySize, neutralRangeAdmission, neutralRebalanceEconomics } from '../src/neutral-grid.js';
import { aiAutopilotAllowedInMode, completeAiAutopilotAction, evaluateAiAutopilot, normalizeAiAutopilotConfig, replayAiAutopilotHistory } from '../src/ai/autopilot.js';
import { aggregateCandles, buildHistoricalAiAnalysis, completedCandleWindow } from '../src/ai/historical-proxy.js';
import { applyLargeCycleExecutionPolicy, buildLargeCycleAnalysis } from '../src/ai/regime.js';
import { assertAutomaticCandleSources } from '../src/ai/service.js';
import {
  applySentimentOverlay,
  buildSentimentChannelPrompt,
  buildSentimentMergePrompt,
  combineSentimentSearchResults,
  normalizeSentimentReport,
  SENTIMENT_POLICY,
  SENTIMENT_STRATEGY_ID,
} from '../src/ai/sentiment.js';
import { buildStrategyProfileParams, listStrategyProfiles, resolveStrategyProfile } from '../src/strategy-profiles.js';
import { annualizedSharpe, applyBacktestPolicy, applyModeSizeScale } from '../scripts/backtest-ai-rotation.js';
import { buildTurtleSignals, executionCostBreakdown, turtleUnitSize, wilderAtr } from '../src/turtle.js';
import { runTurtleBacktest } from '../scripts/backtest-turtle.js';
import { normalizePaperInstanceRegistry, PaperInstanceManager, PRIMARY_PAPER_INSTANCE_ID } from '../src/paper-instances.js';
import { TurtlePaperBot, TURTLE_PAPER_DEFAULTS } from '../src/turtle-paper-bot.js';
import { createTradingBot, strategyEngine } from '../src/trading-bot-factory.js';
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

test('Turtle PAPER defaults use completed daily candles for 20/10 channels', () => {
  const day = 24 * 60 * 60_000;
  const candles = Array.from({ length: 60 }, (_, index) => ({
    time: index * day,
    endTime: (index + 1) * day,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
  }));
  assert.equal(TURTLE_PAPER_DEFAULTS.entryDays, 20);
  assert.equal(TURTLE_PAPER_DEFAULTS.exitDays, 10);
  const signals = buildTurtleSignals(candles, TURTLE_PAPER_DEFAULTS);
  assert.equal(signals[0].availableAt, 21 * day);
  assert.equal(signals[0].entryHigh, 121);
  assert.equal(signals[0].exitLow, 110);
  assert.ok(wilderAtr(candles, 20)[20] > 0);
});

test('Turtle sizing respects stop risk and total notional cap', () => {
  const riskSized = turtleUnitSize({ equity: 10_000, price: 50_000, atrN: 1_000 });
  assert.equal(riskSized, 0.025);
  const capped = turtleUnitSize({
    equity: 10_000,
    price: 50_000,
    atrN: 100,
    currentSize: 0.19,
    stepSize: 0.00001,
    minOrderSize: 0.0001,
  });
  assert.equal(capped, 0.01);
});

test('Turtle PAPER defaults fix each unit risk at 1.5 percent', () => {
  const quantity = turtleUnitSize({ equity: 10_000, price: 50_000, atrN: 1_000, riskPct: TURTLE_PAPER_DEFAULTS.riskPct });
  assert.equal(TURTLE_PAPER_DEFAULTS.riskPct, 1.5);
  assert.equal(quantity, 0.075);
  assert.equal(quantity * 2 * 1_000, 150);
});

test('Turtle PAPER starts waiting below breakout and enters immediately above it', async () => {
  const waitingExchange = turtlePaperExchange({ price: 99, high: 100, low: 90 });
  const waiting = new TurtlePaperBot(waitingExchange);
  const breakoutExchange = turtlePaperExchange({ price: 101, high: 100, low: 90 });
  const breakout = new TurtlePaperBot(breakoutExchange);
  try {
    const waitingState = await waiting.start({ marketId: 1 });
    assert.equal(waitingState.running, true);
    assert.equal(waitingState.turtle.state, 'waiting');
    assert.equal(waitingState.position, null);
    assert.equal(waitingState.turtle.riskPct, 1.5);

    const breakoutState = await breakout.start({ marketId: 1 });
    assert.equal(breakoutState.turtle.state, 'holding');
    assert.equal(breakoutState.turtle.currentUnits, 1);
    assert.ok(breakoutState.position.sizeBase > 0);
    assert.equal(breakoutState.openOrders, 0);
  } finally {
    await waiting.stop({ closePosition: true });
    await breakout.stop({ closePosition: true });
    waiting.dispose();
    breakout.dispose();
  }
});

test('Turtle PAPER adds every 0.5N, stops at four units and exits at the active stop', async () => {
  const exchange = turtlePaperExchange({ price: 100, high: 100, low: 90, feeRate: 0.001, slippageBps: 2, spreadBps: 1 });
  const bot = new TurtlePaperBot(exchange);
  try {
    await bot.start({ marketId: 1 });
    assert.equal(bot.getState().turtle.currentUnits, 1);
    for (const price of [105, 110, 115, 130]) {
      exchange.prices.set(1, price);
      await bot._processPrice(price);
    }
    const holding = bot.getState();
    assert.equal(holding.turtle.currentUnits, 4);
    assert.equal(holding.stats.buys, 4);
    assert.ok(holding.executionCosts.fees > 0);
    assert.ok(holding.executionCosts.slippage > 0);
    assert.ok(holding.executionCosts.spread > 0);
    exchange.prices.set(1, 94);
    await bot._processPrice(94);
    const exited = bot.getState();
    assert.equal(exited.position, null);
    assert.equal(exited.turtle.state, 'waiting');
    assert.equal(exited.stats.completedRungs, 1);
    assert.equal(exited.stats.sells, 1);
  } finally {
    await bot.stop({ closePosition: true });
    bot.dispose();
  }
});

test('Turtle PAPER truncates additions at the 100 percent notional cap', async () => {
  const exchange = turtlePaperExchange({ price: 50_001, high: 50_000, low: 49_000, feeRate: 0, slippageBps: 0, spreadBps: 0 });
  const bot = new TurtlePaperBot(exchange);
  try {
    await bot.start({ marketId: 1 });
    for (const price of [50_501, 51_001, 51_501, 52_001]) {
      exchange.prices.set(1, price);
      await bot._processPrice(price);
    }
    const state = bot.getState();
    assert.ok(state.turtle.currentUnits < 4);
    assert.ok(state.position.sizeBase * state.lastPrice <= state.equity + 0.01);
    assert.match(state.alerts.map((item) => item.message).join(' '), /100% 名义金额上限/);
  } finally {
    await bot.stop({ closePosition: true });
    bot.dispose();
  }
});

test('Turtle PAPER restores an active campaign and stops reacting after detach', async () => {
  const firstExchange = turtlePaperExchange({ price: 101, high: 100, low: 90 });
  const first = new TurtlePaperBot(firstExchange);
  let restored = null;
  try {
    await first.start({ marketId: 1 });
    const snapshot = first.snapshot();
    first.dispose();

    const restoredExchange = turtlePaperExchange({ price: 101, high: 100, low: 90 });
    restored = createTradingBot(restoredExchange, {}, snapshot);
    assert.equal(strategyEngine(restored), 'turtle');
    const state = await restored.resume(snapshot);
    assert.equal(state.turtle.currentUnits, 1);
    assert.ok(state.position);
    await restored.stop({ closePosition: true });
    restoredExchange.prices.set(1, 200);
    restoredExchange.emit('price', { marketId: 1, price: 200 });
    await restored._priceQueue;
    assert.equal(restored.getState().position, null);
    assert.equal(restored.getState().running, false);
  } finally {
    first.dispose();
    restored?.dispose();
  }
});

test('Turtle strategy rejects LIVE execution', async () => {
  const bot = new TurtlePaperBot(fakeLiveExchange());
  await assert.rejects(bot.start({ marketId: 1 }), /仅允许 PAPER/);
  bot.dispose();
});

test('Turtle execution costs include fee, slippage and spread separately', () => {
  const cost = executionCostBreakdown({
    side: 'buy', referencePrice: 50_000, quantity: 0.1, feeRate: 0.0005, slippageBps: 2, spreadBps: 1,
  });
  assert.equal(cost.executionPrice, 50_015);
  assert.equal(cost.slippage, 1);
  assert.equal(cost.spread, 0.5);
  assert.equal(cost.fees, 2.50075);
  assert.equal(cost.total, 4.00075);
});

test('Turtle backtest charges long funding at the 8-hour settlement', () => {
  const interval = 15 * 60_000;
  const candles = Array.from({ length: 36 }, (_, index) => ({
    time: index * interval, open: 101, high: 102, low: 100.5, close: 101,
  }));
  const result = runTurtleBacktest({
    candles,
    signals: [{ availableAt: 0, entryHigh: 100, exitLow: 50, atrN: 10 }],
    from: 0,
    to: 36 * interval,
    config: {
      startBalance: 10_000,
      riskPct: 0.5,
      stopAtrMultiple: 2,
      addAtrMultiple: 0.5,
      maxUnits: 1,
      maxNotionalPct: 100,
      stepSize: 0.00001,
      minOrderSize: 0.0001,
      feeRate: 0,
      slippageBps: 0,
      spreadBps: 0,
      funding8hRate: 0.001,
    },
  });
  assert.equal(result.entries, 1);
  assert.equal(result.forcedExits, 1);
  assert.equal(result.executionCosts.funding, 0.25);
  assert.equal(result.pnl, -0.25);
});

test('Turtle backtest uses timestamped historical funding including negative rates', () => {
  const interval = 15 * 60_000;
  const candles = Array.from({ length: 100 }, (_, index) => ({
    time: index * interval, open: 101, high: 102, low: 100.5, close: 101,
  }));
  const result = runTurtleBacktest({
    candles,
    signals: [{ availableAt: 0, entryHigh: 100, exitLow: 50, atrN: 10 }],
    from: 0,
    to: 100 * interval,
    config: {
      startBalance: 10_000,
      riskPct: 0.5,
      stopAtrMultiple: 2,
      addAtrMultiple: 0.5,
      maxUnits: 1,
      maxNotionalPct: 100,
      stepSize: 0.00001,
      minOrderSize: 0.0001,
      feeRate: 0,
      slippageBps: 0,
      spreadBps: 0,
      funding8hRate: 0.01,
      fundingRates: [
        { time: 8 * 60 * 60_000, rate: 0.001 },
        { time: 16 * 60 * 60_000, rate: -0.0005 },
      ],
    },
  });
  assert.equal(result.executionCosts.funding, 0.13);
  assert.equal(result.pnl, -0.13);
});

test('paper instance registry always keeps one valid primary and unique children', () => {
  const registry = normalizePaperInstanceRegistry({ instances: [
    { id: 'paper-child', name: '  对照盘  ', selectedStrategyId: 'trend_long' },
    { id: 'paper-child', name: '重复项', selectedStrategyId: 'trend_short' },
    { id: '../unsafe', name: '非法项' },
  ] });
  assert.equal(registry.instances[0].id, PRIMARY_PAPER_INSTANCE_ID);
  assert.equal(registry.instances[1].id, 'paper-child');
  assert.equal(registry.instances[1].name, '对照盘');
  assert.equal(registry.instances[1].selectedStrategyId, 'trend_long');
  assert.equal(registry.instances.length, 2);
});

test('paper exchanges can share prices while keeping simulated accounts isolated', async () => {
  const source = new PaperExchange({ fillDelayMs: 0, partialFillProbability: 0 });
  source.markets.set(1, { marketId: 1, displayName: 'BTC-USD', symbol: 'BTC', lastPrice: 100 });
  source.prices.set(1, 100);
  source.realTarget.set(1, 100);
  source.dataSource = 'spot';
  const follower = new PaperExchange({ fillDelayMs: 0, partialFillProbability: 0 });
  follower.follow(source);
  await follower.placeLimitOrder({ marketId: 1, side: 'sell', price: 101, sizeBase: 1 });
  source.emit('price', { marketId: 1, price: 102 });
  assert.equal(follower.getPosition(1).sizeBase, -1);
  assert.equal(source.getPosition(1), null);
  assert.equal(source.balance, 10_000);
  assert.ok(follower.balance < 10_000);
  follower.dispose();
});

test('paper instance strategy and rebalance state persist independently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridpilot-paper-instances-'));
  const primaryExchange = new PaperExchange({ fillDelayMs: 0, partialFillProbability: 0 });
  const primaryBot = new GridBot(primaryExchange);
  let first = null;
  let restored = null;
  try {
    first = new PaperInstanceManager({
      root: dir,
      exchangeConfig: { startBalance: 10_000 },
      primaryExchange,
      primaryBot,
      autoResume: false,
    });
    await first.initialize();
    first.selectStrategy(PRIMARY_PAPER_INSTANCE_ID, 'trend_short');
    const child = await first.create('多头对照');
    first.selectStrategy(child.id, 'trend_long');
    first.updateAutoRebalance(child.id, {
      lastCheckAt: 123,
      lastAdjustedAt: 100,
      last: { t: 123, code: 'adjusted', reason: 'test' },
    });
    first.dispose();

    restored = new PaperInstanceManager({
      root: dir,
      exchangeConfig: { startBalance: 10_000 },
      primaryExchange,
      primaryBot,
      autoResume: false,
    });
    await restored.initialize();
    assert.equal(restored.get(PRIMARY_PAPER_INSTANCE_ID).meta.selectedStrategyId, 'trend_short');
    assert.equal(restored.get(child.id).meta.selectedStrategyId, 'trend_long');
    assert.equal(restored.get(child.id).meta.autoRebalance.lastCheckAt, 123);
    assert.equal(restored.get(PRIMARY_PAPER_INSTANCE_ID).meta.autoRebalance.lastCheckAt, null);
    assert.throws(() => restored.selectStrategy('paper-missing', 'trend_long'), /不存在/);
    assert.throws(() => restored.selectStrategy(child.id, '../invalid'), /无效/);
    await restored.remove(child.id);
    assert.equal(restored.get(child.id), null);
    await assert.rejects(restored.remove(child.id), /不存在/);
  } finally {
    first?.dispose();
    restored?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('idle PAPER instances can retry start after emergency stop even when preview is not ready', () => {
  const canStart = globalThis.GridPilotForm.canStartStrategy;
  const idlePaper = {
    consoleMode: 'paper', backendReady: true, profileAvailable: true,
    running: false, runtimeBlocked: false, busy: false,
  };
  assert.equal(canStart({ ...idlePaper, previewReady: false }), true);
  assert.equal(canStart({ ...idlePaper, previewReady: true }), true);
  assert.equal(canStart({ ...idlePaper, running: true, previewReady: true }), false);
  assert.equal(canStart({ ...idlePaper, profileAvailable: false, previewReady: true }), false);
  assert.equal(canStart({ ...idlePaper, runtimeBlocked: true, previewReady: true }), false);
});

test('LIVE start remains locked until the latest strategy preview passes', () => {
  const canStart = globalThis.GridPilotForm.canStartStrategy;
  const idleLive = {
    consoleMode: 'live', backendReady: true, profileAvailable: true,
    running: false, runtimeBlocked: false, busy: false,
  };
  assert.equal(canStart({ ...idleLive, previewReady: false }), false);
  assert.equal(canStart({ ...idleLive, previewReady: true }), true);
});

test('AI autopilot requires confidence, aligned timeframes and consecutive decisions', () => {
  const config = { enabled: true, minConfidence: 0.75, confirmations: 2, cooldownMinutes: 240, minTimeframeVotes: 2, neutralAsPause: false };
  const long = {
    suitable: true, mode: 'long', confidence: 0.84, regime: '上涨',
    frames: { h4: { trend: 'up' }, h1: { trend: 'up' }, m15: { trend: 'range' } },
  };
  const first = evaluateAiAutopilot({ analysis: long, state: { strategyId: 'ai_rotation_v3' }, config, now: 1_000 });
  assert.equal(first.ready, false);
  assert.equal(first.reason, 'awaiting_confirmation');
  assert.equal(first.state.strategyId, 'ai_rotation_v3');
  assert.equal(first.state.candidateCount, 1);

  const second = evaluateAiAutopilot({ analysis: long, state: first.state, config, now: 2_000 });
  assert.equal(second.ready, true);
  assert.equal(second.target, 'long');
  assert.equal(second.state.strategyId, 'ai_rotation_v3');

  const lowConfidence = evaluateAiAutopilot({ analysis: { ...long, confidence: 0.6 }, state: second.state, config, now: 3_000 });
  assert.equal(lowConfidence.reason, 'low_confidence');
  assert.equal(lowConfidence.state.candidateCount, 0);

  const disagreement = evaluateAiAutopilot({
    analysis: { ...long, frames: { h4: { trend: 'down' }, h1: { trend: 'range' }, m15: { trend: 'up' } } },
    config, now: 4_000,
  });
  assert.equal(disagreement.reason, 'timeframes_disagree');

  const unanimousOnly = evaluateAiAutopilot({
    analysis: long,
    config: { ...config, minTimeframeVotes: 3 },
    now: 5_000,
  });
  assert.equal(unanimousOnly.reason, 'timeframes_disagree');
  assert.equal(unanimousOnly.support.requiredVotes, 3);
});

test('AI autopilot can pause and enforces its post-action cooldown', () => {
  const config = { enabled: true, minConfidence: 0.75, confirmations: 2, cooldownMinutes: 60 };
  const pause = { suitable: false, mode: 'neutral', confidence: 0.9, regime: '剧烈波动', frames: {} };
  const first = evaluateAiAutopilot({ analysis: pause, config, now: 1_000 });
  const second = evaluateAiAutopilot({ analysis: pause, state: first.state, config, now: 2_000 });
  assert.equal(second.ready, true);
  assert.equal(second.target, 'paused');

  const acted = completeAiAutopilotAction(second.state, { action: 'stopped', target: 'paused', now: 2_000 });
  const third = evaluateAiAutopilot({ analysis: pause, state: acted, config, now: 3_000 });
  const fourth = evaluateAiAutopilot({ analysis: pause, state: third.state, config, now: 4_000 });
  assert.equal(fourth.ready, false);
  assert.equal(fourth.reason, 'cooldown');
  assert.equal(fourth.cooldownUntil, 3_602_000);
});

test('AI autopilot is restricted to paper mode', () => {
  assert.equal(aiAutopilotAllowedInMode('paper'), true);
  assert.equal(aiAutopilotAllowedInMode('live'), false);
  assert.equal(aiAutopilotAllowedInMode('unknown'), false);
});

test('large-cycle autopilot defaults require 12 hourly confirmations and keep a neutral grid in ranges', () => {
  const policy = normalizeAiAutopilotConfig({ enabled: true });
  assert.deepEqual(policy, {
    enabled: true,
    minConfidence: 0.8,
    confirmations: 12,
    cooldownMinutes: 2880,
    minTimeframeVotes: 3,
    neutralAsPause: false,
  });
  const range = {
    suitable: true,
    mode: 'neutral',
    confidence: 0.9,
    regime: '震荡',
    frames: { d1: { trend: 'range' }, h4: { trend: 'range' }, h1: { trend: 'range' } },
  };
  let decision = { state: {} };
  for (let count = 1; count <= 12; count++) {
    decision = evaluateAiAutopilot({ analysis: range, state: decision.state, config: policy, now: count * 60 * 60_000 });
  }
  assert.equal(decision.ready, true);
  assert.equal(decision.target, 'neutral');
});

test('historical autopilot confirmation can become ready immediately and preserves the V3 strategy id', () => {
  const config = { enabled: true, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3 };
  const analyses = Array.from({ length: 12 }, (_, index) => ({
    signalTime: (index + 1) * 3_600_000,
    suitable: true,
    mode: 'long',
    confidence: 0.95,
    regime: '上涨周期',
    frames: { d1: { trend: 'up' }, h4: { trend: 'up' }, h1: { trend: 'up' } },
  }));
  const replay = replayAiAutopilotHistory({ analyses, state: { strategyId: 'ai_rotation_v3' }, config });
  assert.equal(replay.processed, 12);
  assert.equal(replay.ready, true);
  assert.equal(replay.target, 'long');
  assert.equal(replay.state.candidateCount, 12);
  assert.equal(replay.state.strategyId, 'ai_rotation_v3');
});

test('historical autopilot confirmation keeps only the latest consecutive suffix', () => {
  const config = { enabled: true, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3 };
  const signal = (mode, index) => {
    const trend = mode === 'long' ? 'up' : 'down';
    return {
      signalTime: (index + 1) * 3_600_000,
      suitable: true,
      mode,
      confidence: 0.95,
      frames: { d1: { trend }, h4: { trend }, h1: { trend } },
    };
  };
  const analyses = Array.from({ length: 9 }, (_, index) => signal('short', index))
    .concat(Array.from({ length: 3 }, (_, index) => signal('long', index + 9)));
  const replay = replayAiAutopilotHistory({ analyses, state: { strategyId: 'ai_rotation_v3' }, config });
  assert.equal(replay.ready, false);
  assert.equal(replay.reason, 'awaiting_confirmation');
  assert.equal(replay.target, 'long');
  assert.equal(replay.state.candidateCount, 3);
});

test('autopilot does not count the same completed H1 signal twice', () => {
  const config = { enabled: true, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3 };
  const analysis = {
    signalTime: 3_600_000,
    suitable: true,
    mode: 'neutral',
    confidence: 0.95,
    frames: { d1: { trend: 'range' }, h4: { trend: 'range' }, h1: { trend: 'range' } },
  };
  const first = evaluateAiAutopilot({
    analysis,
    state: { strategyId: 'ai_rotation_v3', historyEvaluatedAt: 123, historySignalsEvaluated: 12 },
    config,
  });
  const duplicate = evaluateAiAutopilot({ analysis, state: first.state, config });
  assert.equal(first.state.candidateCount, 1);
  assert.equal(duplicate.reason, 'duplicate_signal');
  assert.equal(duplicate.state.candidateCount, 1);
  assert.equal(duplicate.state.strategyId, 'ai_rotation_v3');
  assert.equal(duplicate.state.historyEvaluatedAt, 123);
  assert.equal(duplicate.state.historySignalsEvaluated, 12);
});

test('automatic strategy rejects synthetic candles', () => {
  assert.equal(assertAutomaticCandleSources({ d1: 'spot', h4: 'spot', h1: 'spot' }), true);
  assert.throws(
    () => assertAutomaticCandleSources({ d1: 'spot', h4: 'synthetic', h1: 'spot' }),
    /4小时公共 K 线不可用.*合成数据/,
  );
});

test('Grok sentiment normalizes citations and counts independent X accounts and sites', () => {
  const now = 2_000_000;
  const citations = [
    'https://x.com/market_alpha/status/1',
    'https://x.com/market_alpha/status/2',
    'https://example.com/research/btc',
    'https://news.example.net/bitcoin',
  ];
  const report = normalizeSentimentReport({
    score: 0.42,
    confidence: 0.82,
    attention: 'high',
    eventRisk: 'positive',
    highImpactEvent: false,
    summary: '独立来源整体偏多。',
    evidence: citations.map((url) => ({ url, stance: 'bullish', credibility: 0.8, summary: '偏多证据' })),
    forecasts: [{ hours: 4, up: 6, down: 2, range: 2 }],
  }, { now, citations });
  assert.equal(report.direction, 'bullish');
  assert.equal(report.independentSourceCount, 3);
  assert.equal(report.valid, true);
  assert.deepEqual(report.forecasts[0], { hours: 4, up: 0.6, down: 0.2, range: 0.2 });
  assert.equal(report.expiresAt, now + SENTIMENT_POLICY.maxAgeMinutes * 60_000);
});

test('Grok sentiment channel prompts reject unsupported search channels', () => {
  assert.match(buildSentimentChannelPrompt({ channel: 'x', now: 1, market: 'BTC-USD' }), /只使用 X Search/);
  assert.match(buildSentimentChannelPrompt({ channel: 'web', now: 1, market: 'BTC-USD' }), /只使用 Web Search/);
  assert.throws(() => buildSentimentChannelPrompt({ channel: 'combined' }), /必须是 x 或 web/);
});

test('Grok sentiment combines deduplicated X and Web citations without starving either channel', () => {
  const combined = combineSentimentSearchResults({
    text: '{"summary":"X 摘要"}',
    responseId: 'resp_x',
    model: 'grok-x',
    usage: { input_tokens: 10 },
    citations: [
      { url: 'https://x.com/source_a/status/1', title: 'X A' },
      { url: 'https://shared.example/event', title: 'Shared from X' },
      { url: 'https://x.com/source_b/status/2', title: 'X B' },
    ],
  }, {
    text: '{"summary":"网页摘要"}',
    responseId: 'resp_web',
    model: 'grok-web',
    usage: { input_tokens: 20 },
    citations: [
      { url: 'https://news.example/btc', title: 'Web A' },
      { url: 'https://shared.example/event', title: 'Shared from Web' },
      { url: 'https://research.example/btc', title: 'Web B' },
    ],
  });
  assert.deepEqual(combined.citations.map((item) => item.url), [
    'https://x.com/source_a/status/1',
    'https://news.example/btc',
    'https://shared.example/event',
    'https://x.com/source_b/status/2',
    'https://research.example/btc',
  ]);
  assert.deepEqual(combined.responseIds, { x: 'resp_x', web: 'resp_web' });
  assert.deepEqual(combined.usage, { x: { input_tokens: 10 }, web: { input_tokens: 20 } });
});

test('Grok sentiment merge prompt includes both channel summaries and citation allowlist', () => {
  const searchResults = {
    xText: '{"summary":"X channel marker"}',
    webText: '{"summary":"Web channel marker"}',
    citations: [
      { url: 'https://x.com/source/status/1', title: 'X source' },
      { url: 'https://news.example/btc', title: 'Web source' },
    ],
  };
  const prompt = buildSentimentMergePrompt({ now: 1, market: 'BTC-USD', searchResults });
  assert.match(prompt, /X channel marker/);
  assert.match(prompt, /Web channel marker/);
  assert.match(prompt, /https:\/\/x\.com\/source\/status\/1/);
  assert.match(prompt, /https:\/\/news\.example\/btc/);
  assert.match(prompt, /最终 evidence 只能使用允许引用中的 URL/);
});

test('xAI Responses parser collects root citations, annotations and search action sources', () => {
  const parsed = parseXaiSearchResponse({
    id: 'resp_123',
    model: 'grok-test',
    citations: ['https://root.example/a'],
    output: [{
      content: [{
        type: 'output_text',
        text: '{"score":0.2}',
        annotations: [{ type: 'url_citation', url: 'https://annotation.example/b', title: 'Annotation' }],
      }],
      action: { sources: [{ url: 'https://source.example/c', title: 'Search source' }] },
    }],
    usage: { input_tokens: 10 },
  });
  assert.equal(parsed.text, '{"score":0.2}');
  assert.equal(parsed.responseId, 'resp_123');
  assert.equal(parsed.model, 'grok-test');
  assert.deepEqual(parsed.citations.map((item) => item.url), [
    'https://root.example/a',
    'https://annotation.example/b',
    'https://source.example/c',
  ]);
});

test('Grok sentiment confirms but never creates or reverses the large-cycle direction', () => {
  const now = 3_000_000;
  const base = {
    suitable: true,
    mode: 'long',
    confidence: 0.9,
    regime: '上涨周期',
    frames: { d1: { trend: 'up' }, h4: { trend: 'up' }, h1: { trend: 'up' } },
  };
  const bullish = sentimentReport({ now, score: 0.4, direction: 'bullish' });
  const confirmed = applySentimentOverlay(base, bullish, { now: now + 1_000 });
  assert.equal(confirmed.suitable, true);
  assert.equal(confirmed.mode, 'long');
  assert.equal(confirmed.sentimentDecision, 'confirmed');
  assert.equal(confirmed.signalTime, now);

  const bearish = sentimentReport({ now: now + 10_000, score: -0.4, direction: 'bearish' });
  const blocked = applySentimentOverlay(base, bearish, { now: now + 11_000 });
  assert.equal(blocked.suitable, null);
  assert.equal(blocked.mode, null);
  assert.equal(blocked.sentimentDecision, 'sentiment_conflict');

  const noCycle = applySentimentOverlay({ suitable: null, mode: null, confidence: 0 }, bullish, { now: now + 1_000 });
  assert.equal(noCycle.suitable, null);
  assert.equal(noCycle.mode, null);
  assert.equal(noCycle.sentimentDecision, 'cycle_unconfirmed');
});

test('Grok sentiment holds on too few sources or stale evidence', () => {
  const now = 4_000_000;
  const base = {
    suitable: true,
    mode: 'short',
    confidence: 0.9,
    regime: '下跌周期',
    frames: { d1: { trend: 'down' }, h4: { trend: 'down' }, h1: { trend: 'down' } },
  };
  const insufficient = sentimentReport({ now, score: -0.4, direction: 'bearish', independentSourceCount: 2 });
  const sourceHold = applySentimentOverlay(base, insufficient, { now: now + 1_000 });
  assert.equal(sourceHold.sentimentDecision, 'insufficient_sources');
  assert.equal(sourceHold.suitable, null);

  const stale = sentimentReport({
    now: now - (SENTIMENT_POLICY.maxAgeMinutes + 1) * 60_000,
    score: -0.4,
    direction: 'bearish',
  });
  const staleHold = applySentimentOverlay(base, stale, { now });
  assert.equal(staleHold.sentimentDecision, 'sentiment_stale');
  assert.equal(staleHold.suitable, null);
});

test('high-confidence contrary Grok event requests a pause instead of reversing direction', () => {
  const now = 5_000_000;
  const analysis = {
    suitable: true,
    mode: 'long',
    confidence: 0.9,
    regime: '上涨周期',
    frames: { d1: { trend: 'up' }, h4: { trend: 'up' }, h1: { trend: 'up' } },
  };
  const shock = sentimentReport({
    now,
    score: -0.5,
    direction: 'bearish',
    confidence: 0.9,
    eventRisk: 'negative',
    highImpactEvent: true,
  });
  const result = applySentimentOverlay(analysis, shock, { now: now + 1_000 });
  assert.equal(result.suitable, false);
  assert.equal(result.mode, 'neutral');
  assert.equal(result.sentimentDecision, 'risk_pause');
  assert.notEqual(result.mode, 'short');
});

test('large-cycle classifier maps unanimous 1D/4H/1H trends and holds through disagreement', () => {
  const base = { d1: { trend: 'up', atrPct: 1 }, h4: { trend: 'up', atrPct: 0.8 }, h1: { trend: 'up', atrPct: 0.6 } };
  const long = buildLargeCycleAnalysis(base);
  assert.equal(long.mode, 'long');
  assert.equal(long.suitable, true);
  assert.equal(long.decisionSource, 'large_cycle_rules');

  const transition = buildLargeCycleAnalysis({ ...base, h1: { trend: 'range', atrPct: 0.6 } });
  assert.equal(transition.suitable, null);
  assert.equal(transition.mode, null);

  const neutral = buildLargeCycleAnalysis(Object.fromEntries(Object.keys(base).map((key) => [key, { trend: 'range', atrPct: 0.6 }])));
  assert.equal(neutral.mode, 'neutral');
  const paused = buildLargeCycleAnalysis({ ...base, h1: { trend: 'up', atrPct: 3.2 } });
  assert.equal(paused.suitable, false);
});

test('large-cycle execution policy filters weak shorts and low-volatility neutral grids', () => {
  const short = buildLargeCycleAnalysis({
    d1: { trend: 'down', strength: 0.4, atrPct: 1 },
    h4: { trend: 'down', strength: 0.7, atrPct: 0.8 },
    h1: { trend: 'down', strength: 0.8, atrPct: 0.7 },
  });
  const weakShort = applyLargeCycleExecutionPolicy(short, { shortMinStrength: 0.5 });
  assert.equal(weakShort.suitable, false);
  assert.equal(weakShort.policyReason, 'weak_short');

  const neutral = buildLargeCycleAnalysis({
    d1: { trend: 'range', strength: 0.1, atrPct: 1 },
    h4: { trend: 'range', strength: 0.1, atrPct: 0.7 },
    h1: { trend: 'range', strength: 0.1, atrPct: 0.45 },
  });
  const quiet = applyLargeCycleExecutionPolicy(neutral, { neutralMinAtrPct: 0.55 });
  assert.equal(quiet.suitable, false);
  assert.equal(quiet.policyReason, 'low_volatility');

  const held = applyLargeCycleExecutionPolicy(short, { shortMinStrength: 0.5, blockedAction: 'hold' });
  assert.equal(held.suitable, null);
  assert.equal(held.mode, null);
  assert.equal(held.policyAction, 'hold');
});

test('robustness research can pause instead of opening a confirmed short grid', () => {
  const short = buildLargeCycleAnalysis({
    d1: { trend: 'down', strength: 0.8, atrPct: 1 },
    h4: { trend: 'down', strength: 0.7, atrPct: 0.8 },
    h1: { trend: 'down', strength: 0.6, atrPct: 0.7 },
  });
  const paused = applyBacktestPolicy(short, {
    shortMinStrength: 0.4,
    neutralMinAtrPct: 0.7,
    blockedPolicyAction: 'hold',
    shortPolicyAction: 'pause',
  });
  assert.equal(paused.suitable, false);
  assert.equal(paused.mode, 'short');
  assert.equal(paused.policyReason, 'short_disabled');
});

test('robustness research scales only the configured directional order size', () => {
  const suggestion = { sizeBase: 0.01234, rationale: 'base' };
  const config = { sizeScaleByMode: { short: 0.5 } };
  assert.equal(applyModeSizeScale(suggestion, 'long', config), suggestion);
  const scaled = applyModeSizeScale(suggestion, 'short', config);
  assert.equal(scaled.sizeBase, 0.00617);
  assert.equal(scaled.sizeScale, 0.5);
});

test('daily Sharpe is invariant when every return is scaled proportionally', () => {
  const baseline = annualizedSharpe([100, 101, 100.495, 102.5049]);
  const doubled = annualizedSharpe([100, 102, 100.98, 105.0192]);
  assert.ok(Number.isFinite(baseline));
  assert.ok(Math.abs(baseline - doubled) < 0.0001);
  assert.equal(annualizedSharpe([100, 100, 100]), null);
});

test('historical AI proxy uses multi-timeframe consensus and volatility pause', () => {
  const frames = {
    h4: { trend: 'up', atrPct: 1.2 },
    h1: { trend: 'up', atrPct: 1.1 },
    m15: { trend: 'range', atrPct: 0.4 },
  };
  const long = buildHistoricalAiAnalysis(frames);
  assert.equal(long.suitable, true);
  assert.equal(long.mode, 'long');
  assert.equal(long.confidence, 0.8);

  const paused = buildHistoricalAiAnalysis({ ...frames, h1: { trend: 'up', atrPct: 3.2 } });
  assert.equal(paused.suitable, false);
  assert.equal(paused.regime, '剧烈波动');
  assert.equal(paused.confidence, 0.9);
});

test('historical candle aggregation excludes incomplete and future buckets', () => {
  const minute = 60_000;
  const rows = [0, 1, 2, 3, 4].map((index) => ({
    time: index * minute,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1,
  }));
  const aggregated = aggregateCandles(rows, 4 * minute, minute);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].endTime, 4 * minute);
  assert.equal(completedCandleWindow(aggregated, 4 * minute - 1).length, 0);
  assert.equal(completedCandleWindow(aggregated, 4 * minute).length, 1);
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
  const long = suggestAdaptiveGrid({
    price: 70000, atrPct: 1.2, equity: 10000, mode: 'long',
    market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
  });
  assert.equal(result.mode, 'neutral');
  assert.equal(long.mode, 'long');
  assert.ok(long.sizeBase > result.sizeBase);
  assert.match(result.rationale, /4%/);
  assert.match(long.rationale, /8%/);
  const costAware = suggestAdaptiveGrid({
    price: 70000, atrPct: 1.6, equity: 10000, mode: 'neutral',
    market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
    policy: {
      minSpacingFractionByMode: { neutral: 0.008 },
      volatilityTargetAtrPct: 1,
      minVolatilityScale: 0.5,
      maxVolatilityScale: 1,
    },
  });
  assert.match(costAware.rationale, /目标格距 1.6%/);
  assert.ok(costAware.sizeBase < result.sizeBase);
});

test('neutral grid spacing expands when three times execution friction exceeds the static floor', () => {
  const friction = executionFriction({ feeRate: 0.002, slippageBps: 0, spreadBps: 0 });
  assert.equal(friction.roundTripRate, 0.004);
  assert.equal(friction.minSpacingFraction, 0.012);
  const result = suggestAdaptiveGrid({
    price: 70_000,
    atrPct: 0.8,
    equity: 10_000,
    mode: 'neutral',
    market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
    execution: { feeRate: 0.002 },
  });
  assert.equal(result.roundTripCostPct, 0.4);
  assert.equal(result.rangeAdmissionMinAtrPct, 1.2);
  assert.match(result.rationale, /3 倍保护/);
});

test('neutral range admission requires broad ranges and holds its state through transitions', () => {
  const range = { trend: 'range', strength: 0.2, atrPct: 0.8 };
  const up = { trend: 'up', strength: 0.8, atrPct: 0.8 };
  assert.equal(neutralRangeAdmission({ frames: { d1: range, h4: range, h1: range } }).allowed, true);
  assert.equal(neutralRangeAdmission({ frames: { d1: up, h4: up, h1: range }, currentAllowed: true }).allowed, false);
  const transition = neutralRangeAdmission({ frames: { d1: up, h4: range, h1: range }, currentAllowed: true });
  assert.equal(transition.allowed, true);
  assert.equal(transition.reason, 'transition_hold');
  assert.equal(neutralRangeAdmission({ frames: { d1: range, h4: range, h1: { ...range, atrPct: 0.3 } } }).reason, 'volatility_too_low');
});

test('neutral inventory skew continuously shrinks only orders that worsen inventory', () => {
  const harmful = neutralInventorySize({
    side: 'sell', requestedSize: 0.01, positionSize: -0.012,
    price: 75_000, equity: 10_000, maxDirectionalNotionalPct: 15,
    stepSize: 0.001, minOrderSize: 0.001,
  });
  assert.equal(harmful.applied, true);
  assert.ok(harmful.sizeBase < 0.01 && harmful.sizeBase >= 0.001);
  const reducing = neutralInventorySize({
    side: 'buy', requestedSize: 0.01, positionSize: -0.012,
    price: 75_000, equity: 10_000, maxDirectionalNotionalPct: 15,
  });
  assert.deepEqual(reducing, { sizeBase: 0.01, scale: 1, applied: false });
});

test('neutral admission blocks both opening sides while exits remain available', () => {
  const base = {
    sizeBase: 0.01, price: 75_000, equity: 10_000, maxDirectionalNotionalPct: 15,
    mode: 'neutral', rangeAdmissionEnabled: true, rangeAdmissionAllowed: false,
  };
  assert.equal(inventoryOrderDecision({ ...base, side: 'buy', positionSize: 0 }).reason, 'neutral_range_not_admitted');
  assert.equal(inventoryOrderDecision({ ...base, side: 'sell', positionSize: 0 }).reason, 'neutral_range_not_admitted');
  const exit = inventoryOrderDecision({ ...base, side: 'buy', positionSize: -0.004 });
  assert.equal(exit.allowed, true);
  assert.equal(exit.reduceOnly, true);
});

test('neutral rebalance requires economic improvement except for viable risk actions', () => {
  const previous = { lower: 90, upper: 110, gridCount: 20, sizeBase: 1, leverage: 2 };
  const noImprovement = neutralRebalanceEconomics({
    previous,
    next: { ...previous, leverage: 3 },
    price: 100,
    reasons: ['leverage'],
    execution: { feeRate: 0.0005, slippageBps: 2, spreadBps: 1 },
  });
  assert.equal(noImprovement.ok, false);
  assert.equal(noImprovement.reason, 'benefit_below_friction');

  const recenter = neutralRebalanceEconomics({
    previous,
    next: { ...previous, lower: 85, upper: 115 },
    price: 91,
    reasons: ['range'],
    nearEdge: true,
    execution: { feeRate: 0.0005, slippageBps: 2, spreadBps: 1 },
  });
  assert.equal(recenter.ok, true);
  assert.equal(recenter.reason, 'risk_recenter');
});

test('exposes named strategies and restricts Grok sentiment rotation to configured xAI PAPER', () => {
  const paper = listStrategyProfiles({ runtimeMode: 'paper', aiConfigured: true, aiProvider: 'xai' });
  assert.deepEqual(paper.map((profile) => profile.id), ['range_balanced', 'trend_long', 'trend_short', 'ai_rotation', 'ai_rotation_v3', SENTIMENT_STRATEGY_ID, 'turtle_s2_long']);
  assert.deepEqual(paper.map((profile) => profile.mode), ['neutral', 'long', 'short', 'dynamic', 'dynamic', 'dynamic', 'long']);
  assert.ok(paper.every((profile) => profile.available));

  const live = listStrategyProfiles({ runtimeMode: 'live', aiConfigured: true, aiProvider: 'xai' });
  assert.equal(live.find((profile) => profile.id === 'ai_rotation').available, false);
  assert.equal(live.find((profile) => profile.id === 'ai_rotation_v3').available, false);
  assert.equal(live.find((profile) => profile.id === SENTIMENT_STRATEGY_ID).available, false);
  assert.equal(live.find((profile) => profile.id === 'turtle_s2_long').available, false);
  const paperWithoutAi = listStrategyProfiles({ runtimeMode: 'paper', aiConfigured: false, aiProvider: 'xai' });
  assert.equal(paperWithoutAi.find((profile) => profile.id === 'ai_rotation').available, true);
  assert.equal(paperWithoutAi.find((profile) => profile.id === 'ai_rotation_v3').available, true);
  assert.equal(paperWithoutAi.find((profile) => profile.id === SENTIMENT_STRATEGY_ID).available, false);
  assert.match(paperWithoutAi.find((profile) => profile.id === SENTIMENT_STRATEGY_ID).unavailableReason, /xAI API Key/);
  const paperWithOpenAi = listStrategyProfiles({ runtimeMode: 'paper', aiConfigured: true, aiProvider: 'openai' });
  assert.equal(paperWithOpenAi.find((profile) => profile.id === SENTIMENT_STRATEGY_ID).available, false);
  assert.match(paperWithOpenAi.find((profile) => profile.id === SENTIMENT_STRATEGY_ID).unavailableReason, /xai/i);
  const sentiment = resolveStrategyProfile(SENTIMENT_STRATEGY_ID, { runtimeMode: 'paper', aiConfigured: true, aiProvider: 'xai' });
  assert.equal(sentiment.requiresLiveSentiment, true);
  assert.equal(sentiment.requiredProvider, 'xai');
  const v3 = resolveStrategyProfile('ai_rotation_v3', { runtimeMode: 'paper', aiConfigured: false });
  assert.deepEqual(v3.executionPolicy, { shortMinStrength: 0.4, neutralMinAtrPct: 0.7, blockedAction: 'hold' });
  assert.equal(v3.gridPolicy.marginPctByMode.short, 2);
  assert.equal(v3.gridPolicy.minSpacingFractionByMode.neutral, 0.008);
  const paperLong = paper.find((profile) => profile.id === 'trend_long');
  assert.equal(paperLong.gridPolicy.sizeMultiplierByMode.long, 6);
  assert.equal(paperLong.gridPolicy.maxDirectionalNotionalPctByMode.long, 90);
  assert.equal(paperLong.riskPolicy.maxMarginPct, 55);
  assert.match(paperLong.description, /6 倍仓位/);
  const liveLong = live.find((profile) => profile.id === 'trend_long');
  assert.equal(liveLong.gridPolicy, undefined);
  assert.equal(liveLong.riskPolicy, undefined);
  assert.doesNotMatch(liveLong.description, /6 倍仓位/);
  assert.throws(() => resolveStrategyProfile('ai_rotation', { runtimeMode: 'live', aiConfigured: true }), /仅允许 PAPER/);
  assert.throws(() => resolveStrategyProfile('ai_rotation_v3', { runtimeMode: 'live', aiConfigured: true }), /仅允许 PAPER/);
  assert.throws(() => resolveStrategyProfile(SENTIMENT_STRATEGY_ID, { runtimeMode: 'live', aiConfigured: true, aiProvider: 'xai' }), /仅允许 PAPER/);
  assert.throws(() => resolveStrategyProfile('turtle_s2_long', { runtimeMode: 'live', aiConfigured: true }), /仅允许 PAPER/);
  assert.throws(() => resolveStrategyProfile('missing', { runtimeMode: 'paper', aiConfigured: true }), /策略不存在/);
});

test('named strategy parameters come entirely from the adaptive server suggestion', () => {
  const suggestion = suggestAdaptiveGrid({
    price: 70000, atrPct: 1.2, equity: 10000,
    market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
  });
  const params = buildStrategyProfileParams({
    strategyId: 'trend_long', suggestion, marketId: 1, runtimeMode: 'paper', aiConfigured: false,
  });
  assert.equal(params.strategyId, 'trend_long');
  assert.equal(params.mode, 'long');
  assert.equal(params.lower, suggestion.lower);
  assert.equal(params.upper, suggestion.upper);
  assert.equal(params.gridCount, suggestion.gridCount);
  assert.equal(params.sizeBase, suggestion.sizeBase);
  assert.equal(params.leverage, suggestion.leverage);
  assert.equal(params.neutralRangeAdmissionEnabled, false);
  assert.equal(params.inventorySkewEnabled, false);
  assert.equal(params.minRoundTripCostMultiple, 3);
  const risk = evaluateStartRisk({
    params,
    market: { displayName: 'BTC-USD', maxLeverage: 20, minOrderSize: 0.0001 },
    equity: 10000,
    policy: { maxGridCount: 40, maxLeverage: 10, maxNotional: 0, maxMarginPct: 35, minMaintenanceMarginRatio: 300 },
    existingPosition: { sizeBase: 0.001 },
    currentPrice: 70000,
  });
  assert.equal(risk.ok, true);
  assert.ok(risk.metrics.existingNotional > 0);
});

test('PAPER trend long applies 6x sizing without changing LIVE defaults', () => {
  const input = {
    price: 70_000,
    atrPct: 1.2,
    equity: 10_000,
    mode: 'long',
    market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
  };
  const paperProfile = resolveStrategyProfile('trend_long', { runtimeMode: 'paper' });
  const liveProfile = resolveStrategyProfile('trend_long', { runtimeMode: 'live' });
  const paperSuggestion = suggestAdaptiveGrid({ ...input, policy: paperProfile.gridPolicy });
  const liveSuggestion = suggestAdaptiveGrid({ ...input, policy: liveProfile.gridPolicy || {} });

  assert.equal(paperSuggestion.sizeMultiplier, 6);
  assert.ok(paperSuggestion.sizeBase >= liveSuggestion.sizeBase * 5.9);
  assert.ok(paperSuggestion.sizeBase <= liveSuggestion.sizeBase * 6.1);
  assert.equal(paperSuggestion.maxDirectionalNotionalPct, 90);
  assert.equal(liveSuggestion.sizeMultiplier, 1);
  assert.equal(liveSuggestion.maxDirectionalNotionalPct, 15);
  assert.match(paperSuggestion.rationale, /6 倍仓位.*48%/);

  const params = buildStrategyProfileParams({
    strategyId: 'trend_long', suggestion: paperSuggestion, marketId: 1, runtimeMode: 'paper', aiConfigured: false,
  });
  const riskInput = {
    params,
    market: { displayName: 'BTC-USD', maxLeverage: 50, minOrderSize: 0.0001 },
    equity: 10_000,
  };
  const paperRisk = evaluateStartRisk({ ...riskInput, policy: { maxLeverage: 40, maxGridCount: 0, maxNotional: 0, maxMarginPct: paperProfile.riskPolicy.maxMarginPct, minMaintenanceMarginRatio: 300 } });
  const liveRisk = evaluateStartRisk({ ...riskInput, policy: { maxLeverage: 40, maxGridCount: 0, maxNotional: 0, maxMarginPct: 35, minMaintenanceMarginRatio: 300 } });
  assert.equal(paperRisk.ok, true);
  assert.ok(paperRisk.metrics.marginPct > 48 && paperRisk.metrics.marginPct <= 55);
  assert.equal(liveRisk.ok, false);
  assert.ok(liveRisk.errors.some((error) => error.includes('保证金占权益')));
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

test('paper exchange aggregates only completed Coinbase hours into UTC-aligned 4H candles', async () => {
  const hour = 3_600_000;
  const fourHours = 4 * hour;
  const alignedEnd = Math.floor(Date.now() / fourHours) * fourHours;
  const complete = Array.from({ length: 80 }, (_, index) => {
    const time = alignedEnd - 80 * hour + index * hour;
    return [time / 1000, 90 + index, 110 + index, 100 + index, 101 + index, 1];
  });
  const currentIncompleteHour = Math.floor(Date.now() / hour) * hour;
  const rows = [[currentIncompleteHour / 1000, 50, 60, 55, 56, 1], ...complete].reverse();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
  try {
    const exchange = new PaperExchange({ btcOnly: true });
    const candles = await exchange._spotCandles('BTC', 14400, 2);
    assert.equal(candles.length, 20);
    assert.deepEqual(candles.slice(-2).map((candle) => candle.time), [alignedEnd - 8 * hour, alignedEnd - 4 * hour]);
    assert.ok(candles.every((candle) => candle.sourceCount === 4 && candle.endTime <= alignedEnd));
    assert.equal(candles.at(-1).close, 180);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('hourly adaptive parameters ignore noise but detect meaningful range, count and size changes', () => {
  const previous = { lower: 90, upper: 110, gridCount: 20, sizeBase: 1, leverage: 2 };
  const noise = adaptiveGridChangedEnough({
    previous,
    next: { lower: 89, upper: 111, gridCount: 22, sizeBase: 1.1, leverage: 2 },
    price: 100,
  });
  assert.equal(noise.ok, false);

  const update = adaptiveGridChangedEnough({
    previous,
    next: { lower: 85, upper: 115, gridCount: 24, sizeBase: 1.25, leverage: 1 },
    price: 91,
  });
  assert.deepEqual(update.reasons, ['range', 'grid_count', 'size', 'leverage']);
  assert.equal(update.nearEdge, true);
  assert.equal(autoRebalanceGate({
    enabled: true, running: true, hasConfig: true,
    now: 1_000_000, price: 100, lower: 90, upper: 110, requireEdge: false,
  }).ok, true);
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
    mode: 'paper', running: true, config: { displayName: 'BTC-USD', strategyId: 'ai_rotation' },
    openOrders: 28, exchangeOpenOrders: 28, equity: 10_000,
    position: { sizeBase: 0.01 }, totalPnl: 12.5,
    strategyGuard: { exposure: { pct: 12 } }, executionCosts: { total: 3 },
    measurement: { id: 'paper-run' }, measurementHistory: [{ id: 'old-paper-run' }],
    aiAutopilot: { enabled: true, candidate: 'long' },
    paperInstance: { id: 'paper-main' },
    paperInstances: [{ id: 'paper-main' }, { id: 'paper-child' }],
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
  assert.equal(liveView.aiAutopilot, null);
  assert.equal(liveView.paperInstance, null);
  assert.deepEqual(liveView.paperInstances, []);
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

test('dashboard exposes only named strategy startup and keeps live connection settings off paper', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.match(html, /id="strategy-profile-select"/);
  assert.match(html, /id="legacy-strategy-fields" hidden/);
  assert.match(html, /id="connection-settings-panel" class="panel settings-panel live-page-only"/);
  assert.match(html, /action\('\/api\/strategy-start'/);
  assert.match(html, /启动海龟策略/);
  assert.match(html, /海龟通道与持仓单位/);
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

test('bot preserves the named strategy id in its runtime configuration', async () => {
  const exchange = fakeLiveExchange();
  const bot = new GridBot(exchange);
  await bot.start({ ...gridConfig(), strategyId: 'range_balanced' });
  assert.equal(bot.config.strategyId, 'range_balanced');
  assert.equal(bot.snapshot().config.strategyId, 'range_balanced');
  assert.equal(bot.getState().measurement.params.strategyId, 'range_balanced');
  await bot.stop({ closePosition: false });
});

test('PAPER neutral grid starts in admission wait and enters when conditions pass', async () => {
  const { exchange, bot } = admissionTestBot('paper', false);
  try {
    const waiting = await bot.start(admissionGridConfig());
    assert.equal(waiting.running, true);
    assert.equal(waiting.waitingForAdmission, true);
    assert.equal(waiting.openOrders, 0);
    assert.equal(exchange.placed, 0);
    assert.match(waiting.health.reason, /等待震荡准入/);

    exchange.admissionAllowed = true;
    await bot._refreshTrendGuard(true);
    await bot._guardSync;
    const entered = bot.getState();
    assert.equal(entered.running, true);
    assert.equal(entered.waitingForAdmission, false);
    assert.ok(entered.openOrders > 0);
    assert.match(entered.activity.map((item) => item.message).join(' '), /震荡准入已满足.*自动入场/);
  } finally {
    await bot.stop({ closePosition: false });
    bot.dispose();
  }
});

test('PAPER admission wait survives out-of-range prices and parameter updates without orders', async () => {
  const { exchange, bot } = admissionTestBot('paper', false);
  try {
    await bot.start(admissionGridConfig());
    exchange.emit('price', { marketId: 1, price: 120 });
    await bot._guardSync;
    assert.equal(bot.running, true);
    assert.equal(bot.waitingForAdmission, true);
    assert.equal(exchange.closeCalls, 0);
    assert.equal(bot.active.size, 0);

    await bot.adjustRange({ lower: 80, upper: 125, gridCount: 5, sizeBase: 1, leverage: 2 });
    const adjusted = bot.getState();
    assert.equal(adjusted.running, true);
    assert.equal(adjusted.waitingForAdmission, true);
    assert.equal(adjusted.openOrders, 0);
    assert.equal(exchange.placed, 0);
  } finally {
    await bot.stop({ closePosition: false });
    bot.dispose();
  }
});

test('stopping and resuming preserve the PAPER admission wait lifecycle', async () => {
  const first = admissionTestBot('paper', false);
  let restored = null;
  try {
    await first.bot.start(admissionGridConfig());
    const snapshot = first.bot.snapshot();
    assert.equal(snapshot.waitingForAdmission, true);
    first.bot.dispose();

    const second = admissionTestBot('paper', false);
    restored = second.bot;
    const resumed = await restored.resume(snapshot);
    assert.equal(resumed.running, true);
    assert.equal(resumed.waitingForAdmission, true);
    assert.equal(resumed.openOrders, 0);

    const stopped = await restored.stop({ closePosition: false });
    assert.equal(stopped.running, false);
    assert.equal(stopped.waitingForAdmission, false);
  } finally {
    first.bot.dispose();
    restored?.dispose();
  }
});

test('LIVE neutral grid still rejects a failed range admission', async () => {
  const { bot } = admissionTestBot('live', false);
  try {
    await assert.rejects(bot.start(admissionGridConfig()), /当前不满足中性网格准入/);
    assert.equal(bot.running, false);
    assert.equal(bot.waitingForAdmission, false);
  } finally {
    bot.dispose();
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
      provider: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
      apiKey: 'xai-test-secret',
      autopilotEnabled: true,
      autopilotMinConfidence: 0.8,
      autopilotConfirmations: 3,
      autopilotCooldownMinutes: 360,
    });
    assert.equal(saved.provider, 'xai');
    assert.equal(saved.apiKey, 'xai-test-secret');
    const visible = publicAiSettings(loadAiSettings(dir));
    assert.equal(visible.hasApiKey, true);
    assert.equal('apiKey' in visible, false);
    assert.equal(visible.autopilotEnabled, true);
    assert.equal(visible.autopilotMinConfidence, 0.8);
    assert.equal(visible.autopilotConfirmations, 3);
    assert.equal(visible.autopilotCooldownMinutes, 360);
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

test('adaptive parameter adjustment re-seeds orders without closing the position', async () => {
  const exchange = fakeLiveExchange();
  const bot = new GridBot(exchange);
  await bot.start(gridConfig());
  await bot.adjustRange({ lower: 95, upper: 105, gridCount: 5, sizeBase: 0.5, leverage: 3 });
  assert.equal(bot.config.lower, 95);
  assert.equal(bot.config.upper, 105);
  assert.equal(bot.config.gridCount, 5);
  assert.equal(bot.config.sizeBase, 0.5);
  assert.equal(bot.config.leverage, 3);
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

function admissionGridConfig() {
  return {
    ...gridConfig(),
    strategyId: 'range_balanced',
    neutralRangeAdmissionEnabled: true,
    trendGuardEnabled: false,
    rangeAdmissionMinAtrPct: 0.6,
  };
}

function sentimentReport({
  now,
  score,
  direction,
  confidence = 0.82,
  independentSourceCount = 3,
  eventRisk = 'none',
  highImpactEvent = false,
} = {}) {
  return {
    observedAt: now,
    expiresAt: now + SENTIMENT_POLICY.maxAgeMinutes * 60_000,
    score,
    direction,
    confidence,
    independentSourceCount,
    eventRisk,
    highImpactEvent,
    evidence: [],
  };
}

function admissionTestBot(mode = 'paper', allowed = false) {
  const exchange = fakeLiveExchange();
  exchange.mode = mode;
  exchange.admissionAllowed = allowed;
  exchange.restoreState = () => true;
  exchange.adoptOrder = () => {};
  exchange.fetchOpenOrders = async () => [];
  exchange.getOpenOrders = () => [];
  exchange.cancelOrder = async () => true;
  const bot = new GridBot(exchange);
  bot._refreshTrendGuard = async function refreshAdmissionForTest() {
    this.strategyGuard = {
      ...this.strategyGuard,
      enabled: false,
      trend: 'range',
      strength: 0,
      checkedAt: Date.now(),
      rangeAdmission: {
        enabled: true,
        allowed: exchange.admissionAllowed,
        reason: exchange.admissionAllowed ? 'broad_range_confirmed' : 'volatility_too_low',
        detail: exchange.admissionAllowed
          ? '1D 与 4H 均确认震荡，中性开仓准入。'
          : '1H ATR 0.221% 低于 0.6% 的成本覆盖门槛。',
      },
    };
    if (this.running) this._scheduleGuardSync();
    return this.strategyGuard;
  };
  return { exchange, bot };
}

function turtlePaperExchange({ price, high, low, feeRate = 0, slippageBps = 0, spreadBps = 0 } = {}) {
  const exchange = new PaperExchange({
    startBalance: 10_000,
    feeRate,
    slippageBps,
    spreadBps,
    fundingRate: 0,
    fillDelayMs: 0,
    partialFillProbability: 0,
  });
  exchange.markets.set(1, {
    marketId: 1,
    displayName: 'BTC-USD',
    symbol: 'BTC',
    lastPrice: price,
    stepSize: 0.00001,
    minOrderSize: 0.0001,
    maxLeverage: 50,
  });
  exchange.prices.set(1, price);
  exchange.realTarget.set(1, price);
  exchange.dataSource = 'spot';
  exchange.candleDataSource = 'spot';
  exchange.start = () => {};
  exchange.getCandles = async () => {
    exchange.candleDataSource = 'spot';
    const day = 24 * 60 * 60_000;
    const start = Date.now() - 121 * day;
    return Array.from({ length: 120 }, (_, index) => ({
      time: start + index * day,
      endTime: start + (index + 1) * day,
      open: (high + low) / 2,
      high,
      low,
      close: (high + low) / 2,
      volume: 1,
    }));
  };
  return exchange;
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
