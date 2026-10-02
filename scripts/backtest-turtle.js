import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateCandles } from '../src/candles.js';
import {
  buildTurtleSignals,
  executionCostBreakdown,
  snapDown,
  turtleUnitSize,
} from '../src/turtle.js';

const M15_MS = 15 * 60_000;
const D1_MS = 24 * 60 * 60_000;
const FUNDING_MS = 8 * 60 * 60_000;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_CACHE = path.join(ROOT, '.cache', 'coinbase-btc-usd-15m.json');
const DEFAULT_FUNDING_CACHE = path.join(ROOT, '.cache', 'btc-perpetual-funding.json');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const config = configFromEnv();
  const { candles, cache } = await loadCachedCandles(config);
  const daily = aggregateCandles(candles, D1_MS, M15_MS);
  const signals = buildTurtleSignals(daily, config);
  if (!signals.length) throw new Error('Not enough complete daily candles for Turtle signals.');

  const dataEnd = candles.at(-1).time + M15_MS;
  const tradeFrom = Math.max(candles[0].time, dataEnd - config.days * D1_MS);
  const period = { from: tradeFrom, to: dataEnd };
  const funding = await loadFundingHistory(config, period);
  const effectiveConfig = { ...config, fundingRates: funding.rates };
  const normal = runTurtleBacktest({ candles, signals, config: effectiveConfig, ...period });
  const doubleCosts = runTurtleBacktest({
    candles,
    signals,
    from: tradeFrom,
    to: dataEnd,
    config: scaledCostConfig(effectiveConfig, 2),
  });
  const noCosts = runTurtleBacktest({
    candles,
    signals,
    from: tradeFrom,
    to: dataEnd,
    config: scaledCostConfig(effectiveConfig, 0),
  });
  const fixedFundingStress = runTurtleBacktest({
    candles,
    signals,
    ...period,
    config: { ...config, fundingRates: null, funding8hRate: config.funding8hRate },
  });
  const annual = calendarWindows(tradeFrom, dataEnd).map((window) => ({
    label: window.label,
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    partial: window.from !== Date.UTC(Number(window.label), 0, 1)
      || window.to !== Date.UTC(Number(window.label) + 1, 0, 1),
    result: compactResult(runTurtleBacktest({ candles, signals, config: effectiveConfig, from: window.from, to: window.to })),
  }));
  const spotHold = runPassiveLong({
    candles,
    config: { ...effectiveConfig, fundingRates: [], funding8hRate: 0 },
    from: tradeFrom,
    to: dataEnd,
  });
  const perpetualLong = runPassiveLong({ candles, config: effectiveConfig, from: tradeFrom, to: dataEnd });

  console.log(JSON.stringify({
    strategy: {
      id: 'turtle_s2_long',
      name: 'Turtle 20/10 Long Only',
      status: 'paper_enabled',
      rules: {
        signalTimeframe: '1d completed candles',
        executionTimeframe: '15m OHLC path',
        entry: `prior ${config.entryDays}-day Donchian high`,
        exit: `prior ${config.exitDays}-day Donchian low`,
        atrN: `${config.atrDays}-day Wilder ATR`,
        initialAndUnitStop: `${config.stopAtrMultiple}N below latest unit`,
        addEvery: `${config.addAtrMultiple}N`,
        maxUnits: config.maxUnits,
        unitRiskPct: config.riskPct,
        maxNotionalPct: config.maxNotionalPct,
        side: 'long_only',
      },
    },
    data: {
      source: 'Coinbase BTC-USD 15m local cache',
      cache,
      candles15m: candles.length,
      completeCandles1d: daily.length,
      signalRows: signals.length,
      from: new Date(tradeFrom).toISOString(),
      to: new Date(dataEnd).toISOString(),
      gaps15m: countGaps(candles),
    },
    assumptions: {
      intrabarPath: 'bullish: open-low-high-close; bearish: open-high-low-close',
      gapFill: 'worse of candle open and trigger',
      fundingSettlement: 'every 8h UTC using the latest available mark',
      fundingMode: funding.mode,
      fundingCoverage: funding.coverage,
      forcedFinalClose: true,
      limitations: [
        funding.mode === 'historical'
          ? 'Funding uses public BTC perpetual rates; execution prices remain Coinbase BTC-USD spot OHLC marks.'
          : 'Fixed funding rate is a stress assumption, not historical exchange funding.',
        'OHLC candles cannot reproduce queue position, partial fills, or sub-15m price order.',
      ],
    },
    costs: costPolicy(effectiveConfig),
    result: normal,
    costSensitivity: {
      noCosts: compactResult(noCosts),
      normal: compactResult(normal),
      doubleCosts: compactResult(doubleCosts),
      fixedFundingStress: compactResult(fixedFundingStress),
    },
    annual,
    benchmarks: { spotBuyAndHold: spotHold, perpetualLong: perpetualLong },
  }, null, 2));
}

export function runTurtleBacktest({ candles, signals, config, from, to }) {
  const rows = candles.filter((candle) => candle.time >= from && candle.time + M15_MS <= to);
  if (!rows.length) throw new Error('No 15m candles in requested Turtle backtest period.');
  const state = createState(config, from);
  let signalIndex = 0;
  let signal = null;
  while (signalIndex < signals.length && signals[signalIndex].availableAt <= from) {
    signal = signals[signalIndex++];
  }

  for (const candle of rows) {
    while (signalIndex < signals.length && signals[signalIndex].availableAt <= candle.time) {
      signal = signals[signalIndex++];
    }
    applyFundingThrough(state, candle.time, candle.open, config);
    const exposedAtOpen = state.position.sizeBase > 0;
    const fillsBefore = state.fills;
    if (signal) processCandle(state, candle, signal, config);
    if (exposedAtOpen || state.position.sizeBase > 0 || state.fills > fillsBefore) state.exposedBars++;
    observeEquity(state, candle.close);
  }

  const finalCandle = rows.at(-1);
  const finalAt = finalCandle.time + M15_MS;
  applyFundingThrough(state, finalAt, finalCandle.close, config);
  const markBeforeClose = equity(state, finalCandle.close);
  let forcedFinalClose = null;
  if (state.position.sizeBase > 0) {
    forcedFinalClose = closePosition(state, finalCandle.close, finalAt, 'forced_final_close', config);
    observeEquity(state, finalCandle.close);
  }
  const finalEquity = equity(state, finalCandle.close);
  const totalCosts = Object.values(state.costs).reduce((sum, value) => sum + value, 0);
  const winningTrades = state.trades.filter((trade) => trade.netPnl > 0);
  const losingTrades = state.trades.filter((trade) => trade.netPnl < 0);
  return {
    initialEquity: round(config.startBalance),
    finalEquity: round(finalEquity),
    pnl: round(finalEquity - config.startBalance),
    returnPct: round((finalEquity / config.startBalance - 1) * 100),
    maxDrawdownPct: round(state.maxDrawdownPct),
    grossTradingPnl: round(state.grossTradingPnl),
    grossPnlBeforeCosts: round(finalEquity - config.startBalance + totalCosts),
    executionCosts: {
      fees: round(state.costs.fees),
      slippage: round(state.costs.slippage),
      spread: round(state.costs.spread),
      funding: round(state.costs.funding),
      total: round(totalCosts),
    },
    entries: state.entries,
    exits: state.exits,
    addOns: state.addOns,
    fills: state.fills,
    stopExits: state.exitReasons.stop || 0,
    channelExits: state.exitReasons.channel || 0,
    forcedExits: state.exitReasons.forced_final_close || 0,
    skippedSmallEntries: state.skippedSmallEntries,
    notionalCapBlocks: state.notionalCapBlocks,
    trades: state.trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRatePct: round(state.trades.length ? winningTrades.length / state.trades.length * 100 : 0),
    averageTrade: round(state.trades.length
      ? state.trades.reduce((sum, trade) => sum + trade.netPnl, 0) / state.trades.length
      : 0),
    bestTrade: round(state.trades.length ? Math.max(...state.trades.map((trade) => trade.netPnl)) : 0),
    worstTrade: round(state.trades.length ? Math.min(...state.trades.map((trade) => trade.netPnl)) : 0),
    averageHoldingDays: round(state.trades.length
      ? state.trades.reduce((sum, trade) => sum + trade.holdingMs, 0) / state.trades.length / D1_MS
      : 0),
    timeInMarketPct: round(state.exposedBars / rows.length * 100),
    markBeforeForcedClose: round(markBeforeClose),
    forcedFinalClose,
  };
}

function processCandle(state, candle, signal, config) {
  let actedAtOpen = false;
  if (state.position.sizeBase > 0) {
    const exit = activeExit(state, signal);
    if (candle.open <= exit.price) {
      closePosition(state, candle.open, candle.time, exit.reason, config);
      actedAtOpen = true;
    }
  }
  if (!actedAtOpen && state.position.sizeBase <= 0 && candle.open >= signal.entryHigh) {
    openPosition(state, candle.open, signal, candle.time, config);
    actedAtOpen = state.position.sizeBase > 0;
  }
  if (state.position.sizeBase > 0 && candle.open >= state.campaign.nextAddPrice) {
    addThroughPrice(state, candle.open, candle.open, candle.time, config);
  }

  const bullish = candle.close >= candle.open;
  const points = [candle.open, bullish ? candle.low : candle.high, bullish ? candle.high : candle.low, candle.close];
  for (let index = 1; index < points.length; index++) {
    processSegment(state, points[index - 1], points[index], signal, candle.time, config);
  }
}

function processSegment(state, from, to, signal, time, config) {
  if (to > from) {
    if (state.position.sizeBase <= 0 && from < signal.entryHigh && to >= signal.entryHigh) {
      openPosition(state, signal.entryHigh, signal, time, config);
    }
    if (state.position.sizeBase > 0) addThroughPrice(state, to, null, time, config, from);
    return;
  }
  if (to >= from || state.position.sizeBase <= 0) return;
  const exit = activeExit(state, signal);
  if (from > exit.price && to <= exit.price) closePosition(state, exit.price, time, exit.reason, config);
}

function openPosition(state, referencePrice, signal, time, config) {
  const quantity = turtleUnitSize({
    equity: equity(state, referencePrice),
    price: referencePrice,
    atrN: signal.atrN,
    riskPct: config.riskPct,
    stopAtrMultiple: config.stopAtrMultiple,
    maxNotionalPct: config.maxNotionalPct,
    stepSize: config.stepSize,
    minOrderSize: config.minOrderSize,
  });
  if (!(quantity > 0)) {
    state.skippedSmallEntries++;
    return;
  }
  state.campaign = {
    atrN: signal.atrN,
    unitSize: quantity,
    units: 0,
    latestUnitPrice: referencePrice,
    nextAddPrice: referencePrice + config.addAtrMultiple * signal.atrN,
    stopPrice: referencePrice - config.stopAtrMultiple * signal.atrN,
    openedAt: time,
    grossPnl: 0,
    costs: 0,
  };
  applyFillCosts(state, 'buy', referencePrice, quantity, config);
  state.position.sizeBase = quantity;
  state.position.entryPrice = referencePrice;
  state.campaign.units = 1;
  state.entries++;
  state.fills++;
}

function addThroughPrice(state, reachedPrice, gapReference, time, config, segmentFrom = -Infinity) {
  while (state.position.sizeBase > 0
    && state.campaign.units < config.maxUnits
    && state.campaign.nextAddPrice <= reachedPrice
    && state.campaign.nextAddPrice > segmentFrom) {
    const trigger = state.campaign.nextAddPrice;
    const referencePrice = gapReference == null ? trigger : Math.max(trigger, gapReference);
    const maxSize = maxAdditionalSize(state, referencePrice, config);
    const quantity = snapDown(Math.min(state.campaign.unitSize, maxSize), config.stepSize);
    if (quantity + 1e-12 < config.minOrderSize) {
      state.notionalCapBlocks++;
      break;
    }
    const previousSize = state.position.sizeBase;
    applyFillCosts(state, 'buy', referencePrice, quantity, config);
    state.position.sizeBase += quantity;
    state.position.entryPrice = (previousSize * state.position.entryPrice + quantity * referencePrice)
      / state.position.sizeBase;
    state.campaign.units++;
    state.campaign.latestUnitPrice = referencePrice;
    state.campaign.nextAddPrice = trigger + config.addAtrMultiple * state.campaign.atrN;
    state.campaign.stopPrice = referencePrice - config.stopAtrMultiple * state.campaign.atrN;
    state.addOns++;
    state.fills++;
  }
}

function maxAdditionalSize(state, price, config) {
  const cap = Math.max(0, equity(state, price)) * config.maxNotionalPct / 100;
  return Math.max(0, cap / price - state.position.sizeBase);
}

function activeExit(state, signal) {
  if (state.campaign.stopPrice >= signal.exitLow) return { price: state.campaign.stopPrice, reason: 'stop' };
  return { price: signal.exitLow, reason: 'channel' };
}

function closePosition(state, referencePrice, time, reason, config) {
  const quantity = state.position.sizeBase;
  if (!(quantity > 0)) return null;
  const grossPnl = quantity * (referencePrice - state.position.entryPrice);
  state.balance += grossPnl;
  state.grossTradingPnl += grossPnl;
  state.campaign.grossPnl += grossPnl;
  const cost = applyFillCosts(state, 'sell', referencePrice, quantity, config);
  state.fills++;
  state.exits++;
  increment(state.exitReasons, reason);
  const trade = {
    openedAt: new Date(state.campaign.openedAt).toISOString(),
    closedAt: new Date(time).toISOString(),
    units: state.campaign.units,
    grossPnl: round(state.campaign.grossPnl),
    executionCosts: round(state.campaign.costs),
    netPnl: round(state.campaign.grossPnl - state.campaign.costs),
    holdingMs: Math.max(0, time - state.campaign.openedAt),
    exitReason: reason,
  };
  state.trades.push(trade);
  state.position = { sizeBase: 0, entryPrice: 0 };
  state.campaign = null;
  return {
    quantity: round(quantity, 8),
    referencePrice: round(referencePrice),
    executionPrice: round(cost.executionPrice),
    fee: round(cost.fees),
    reason,
  };
}

function applyFillCosts(state, side, price, quantity, config) {
  const cost = executionCostBreakdown({
    side,
    referencePrice: price,
    quantity,
    feeRate: config.feeRate,
    slippageBps: config.slippageBps,
    spreadBps: config.spreadBps,
  });
  state.balance -= cost.total;
  state.costs.fees += cost.fees;
  state.costs.slippage += cost.slippage;
  state.costs.spread += cost.spread;
  if (state.campaign) state.campaign.costs += cost.total;
  return cost;
}

function applyFundingThrough(state, through, price, config) {
  if (Array.isArray(config.fundingRates)) {
    while (state.fundingIndex < config.fundingRates.length
      && config.fundingRates[state.fundingIndex].time <= through) {
      const row = config.fundingRates[state.fundingIndex++];
      if (row.time <= state.fundingFrom || state.position.sizeBase <= 0) continue;
      applyFundingPayment(state, price, row.rate);
    }
    return;
  }
  while (state.nextFundingAt <= through) {
    if (state.position.sizeBase > 0) applyFundingPayment(state, price, config.funding8hRate);
    state.nextFundingAt += FUNDING_MS;
  }
}

function applyFundingPayment(state, price, rate) {
  const payment = state.position.sizeBase * price * rate;
  state.balance -= payment;
  state.costs.funding += payment;
  if (state.campaign) state.campaign.costs += payment;
}

function observeEquity(state, price) {
  const current = equity(state, price);
  state.peakEquity = Math.max(state.peakEquity, current);
  if (state.peakEquity > 0) {
    state.maxDrawdownPct = Math.max(state.maxDrawdownPct, (state.peakEquity - current) / state.peakEquity * 100);
  }
}

function equity(state, price) {
  return state.balance + state.position.sizeBase * (price - state.position.entryPrice);
}

function createState(config, from) {
  return {
    balance: config.startBalance,
    peakEquity: config.startBalance,
    maxDrawdownPct: 0,
    position: { sizeBase: 0, entryPrice: 0 },
    campaign: null,
    costs: { fees: 0, slippage: 0, spread: 0, funding: 0 },
    grossTradingPnl: 0,
    fills: 0,
    entries: 0,
    exits: 0,
    addOns: 0,
    exposedBars: 0,
    skippedSmallEntries: 0,
    notionalCapBlocks: 0,
    exitReasons: {},
    trades: [],
    fundingFrom: from,
    fundingIndex: lowerBoundFunding(config.fundingRates, from),
    nextFundingAt: (Math.floor(from / FUNDING_MS) + 1) * FUNDING_MS,
  };
}

function runPassiveLong({ candles, config, from, to }) {
  const rows = candles.filter((candle) => candle.time >= from && candle.time + M15_MS <= to);
  const state = createState(config, from);
  const entry = rows[0].open;
  const quantity = snapDown(config.startBalance * config.maxNotionalPct / 100 / entry, config.stepSize);
  state.campaign = { openedAt: rows[0].time, units: 1, grossPnl: 0, costs: 0 };
  applyFillCosts(state, 'buy', entry, quantity, config);
  state.position = { sizeBase: quantity, entryPrice: entry };
  for (const candle of rows) {
    applyFundingThrough(state, candle.time, candle.open, config);
    state.exposedBars++;
    observeEquity(state, candle.close);
  }
  const last = rows.at(-1);
  const finalAt = last.time + M15_MS;
  applyFundingThrough(state, finalAt, last.close, config);
  closePosition(state, last.close, finalAt, 'forced_final_close', config);
  observeEquity(state, last.close);
  const finalEquity = equity(state, last.close);
  const totalCosts = Object.values(state.costs).reduce((sum, value) => sum + value, 0);
  return {
    finalEquity: round(finalEquity),
    pnl: round(finalEquity - config.startBalance),
    returnPct: round((finalEquity / config.startBalance - 1) * 100),
    maxDrawdownPct: round(state.maxDrawdownPct),
    grossPnlBeforeCosts: round(finalEquity - config.startBalance + totalCosts),
    executionCosts: Object.fromEntries([...Object.entries(state.costs), ['total', totalCosts]]
      .map(([key, value]) => [key, round(value)])),
  };
}

async function loadCachedCandles(config) {
  const file = process.env.BACKTEST_CACHE_FILE || DEFAULT_CACHE;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read BTC 15m cache at ${file}: ${error.message}`);
  }
  if (parsed?.granularity !== 900 || !Array.isArray(parsed.candles)) {
    throw new Error('BTC cache must contain Coinbase 15m candles.');
  }
  const candles = parsed.candles
    .map(([time, low, high, open, close, volume]) => ({
      time: Number(time), low: Number(low), high: Number(high), open: Number(open), close: Number(close), volume: Number(volume),
    }))
    .filter((candle) => [candle.time, candle.low, candle.high, candle.open, candle.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  const unique = [...new Map(candles.map((candle) => [candle.time, candle])).values()];
  if (unique.length < 96 * 60) throw new Error('BTC cache has fewer than 60 days of 15m candles.');
  return {
    candles: unique,
    cache: { file: path.relative(ROOT, file), updatedAt: parsed.updatedAt || null },
  };
}

async function loadFundingHistory(config, { from, to }) {
  if (config.fundingMode === 'fixed') {
    return {
      mode: 'fixed',
      rates: null,
      coverage: { rate: config.funding8hRate, intervalHours: 8 },
    };
  }
  const file = process.env.BACKTEST_FUNDING_CACHE_FILE || DEFAULT_FUNDING_CACHE;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read BTC funding cache at ${file}. Run npm run fetch:funding first: ${error.message}`);
  }
  const available = normalizeFundingRates(parsed?.rates);
  const byTime = new Map(available.map((row) => [row.time, row]));
  const expectedTimes = [];
  for (let time = (Math.floor(from / FUNDING_MS) + 1) * FUNDING_MS; time <= to; time += FUNDING_MS) {
    expectedTimes.push(time);
  }
  const rates = expectedTimes.map((time) => byTime.get(time)).filter(Boolean);
  if (!rates.length) throw new Error('BTC funding cache contains no rates in the requested backtest period.');
  const expected = Math.max(1, expectedTimes.length);
  const missing = expectedTimes.filter((time) => !byTime.has(time));
  const coveragePct = rates.length / expected * 100;
  if (coveragePct < config.minFundingCoveragePct) {
    throw new Error(`Historical funding coverage ${round(coveragePct)}% is below ${config.minFundingCoveragePct}%. Refresh it with npm run fetch:funding.`);
  }
  return {
    mode: 'historical',
    rates,
    coverage: {
      file: path.relative(ROOT, file),
      rows: rates.length,
      expectedRows: expected,
      missingRows: missing.length,
      coveragePct: round(Math.min(100, coveragePct)),
      from: new Date(rates[0].time).toISOString(),
      to: new Date(rates.at(-1).time).toISOString(),
      sources: parsed.sources || [],
      updatedAt: parsed.updatedAt || null,
    },
  };
}

function configFromEnv() {
  return {
    days: positiveNumber(process.env.BACKTEST_DAYS, 1825),
    startBalance: positiveNumber(process.env.BACKTEST_START_BALANCE, 10_000),
    feeRate: nonNegativeNumber(process.env.BACKTEST_FEE_RATE, 0.0005),
    slippageBps: nonNegativeNumber(process.env.BACKTEST_SLIPPAGE_BPS, 2),
    spreadBps: nonNegativeNumber(process.env.BACKTEST_SPREAD_BPS, 1),
    fundingMode: String(process.env.BACKTEST_FUNDING_MODE || 'historical').toLowerCase() === 'fixed' ? 'fixed' : 'historical',
    funding8hRate: finiteNumber(process.env.BACKTEST_FUNDING_8H_RATE, 0.0001),
    minFundingCoveragePct: positiveNumber(process.env.BACKTEST_MIN_FUNDING_COVERAGE_PCT, 95),
    entryDays: positiveInteger(process.env.TURTLE_ENTRY_DAYS, 20),
    exitDays: positiveInteger(process.env.TURTLE_EXIT_DAYS, 10),
    atrDays: positiveInteger(process.env.TURTLE_ATR_DAYS, 20),
    riskPct: positiveNumber(process.env.TURTLE_UNIT_RISK_PCT, 1.5),
    stopAtrMultiple: positiveNumber(process.env.TURTLE_STOP_N, 2),
    addAtrMultiple: positiveNumber(process.env.TURTLE_ADD_N, 0.5),
    maxUnits: positiveInteger(process.env.TURTLE_MAX_UNITS, 4),
    maxNotionalPct: positiveNumber(process.env.TURTLE_MAX_NOTIONAL_PCT, 100),
    stepSize: positiveNumber(process.env.TURTLE_STEP_SIZE, 0.00001),
    minOrderSize: positiveNumber(process.env.TURTLE_MIN_ORDER_SIZE, 0.0001),
  };
}

function scaledCostConfig(config, multiplier) {
  return {
    ...config,
    feeRate: config.feeRate * multiplier,
    slippageBps: config.slippageBps * multiplier,
    spreadBps: config.spreadBps * multiplier,
    funding8hRate: config.funding8hRate * multiplier,
    fundingRates: Array.isArray(config.fundingRates)
      ? config.fundingRates.map((row) => ({ ...row, rate: row.rate * multiplier }))
      : config.fundingRates,
  };
}

function calendarWindows(from, to) {
  const windows = [];
  for (let year = new Date(from).getUTCFullYear(); year <= new Date(to - 1).getUTCFullYear(); year++) {
    windows.push({
      label: String(year),
      from: Math.max(from, Date.UTC(year, 0, 1)),
      to: Math.min(to, Date.UTC(year + 1, 0, 1)),
    });
  }
  return windows.filter((window) => window.to > window.from);
}

function compactResult(result) {
  return {
    finalEquity: result.finalEquity,
    pnl: result.pnl,
    returnPct: result.returnPct,
    maxDrawdownPct: result.maxDrawdownPct,
    executionCosts: result.executionCosts,
    trades: result.trades,
    winRatePct: result.winRatePct,
    timeInMarketPct: result.timeInMarketPct,
  };
}

function costPolicy(config) {
  return {
    feeRatePerFill: config.feeRate,
    slippageBpsPerFill: config.slippageBps,
    spreadBpsPerFill: config.spreadBps,
    funding: Array.isArray(config.fundingRates)
      ? { mode: 'historical', rows: config.fundingRates.length }
      : { mode: 'fixed', rate8hForLongs: config.funding8hRate },
  };
}

function normalizeFundingRates(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => {
    const values = Array.isArray(row) ? row : [row?.time, row?.rate, row?.source];
    return { time: Math.round(Number(values[0]) / FUNDING_MS) * FUNDING_MS, rate: Number(values[1]), source: values[2] || null };
  }).filter((row) => Number.isFinite(row.time) && row.time > 0 && Number.isFinite(row.rate) && Math.abs(row.rate) <= 0.1);
  return [...new Map(normalized.map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time);
}

function lowerBoundFunding(rows, time) {
  if (!Array.isArray(rows)) return 0;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function countGaps(candles) {
  let gaps = 0;
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].time - candles[index - 1].time !== M15_MS) gaps++;
  }
  return gaps;
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.round(positiveNumber(value, fallback)));
}
