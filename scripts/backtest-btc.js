import { suggestAdaptiveGrid } from '../src/adaptive-grid.js';
import { analyzeTrend } from '../src/trend.js';
import { inventoryOrderDecision, isPassiveOpeningOrder } from '../src/strategy-guards.js';

const API = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600';
const CANDLE_MS = 3_600_000;
const BACKTEST_DAYS = Number(process.env.BACKTEST_DAYS || 180);
const START_BALANCE = 10_000;
const FEE_RATE = Number(process.env.BACKTEST_FEE_RATE ?? 0.0005);
const SLIPPAGE_BPS = Number(process.env.BACKTEST_SLIPPAGE_BPS || 2);
const SPREAD_BPS = Number(process.env.BACKTEST_SPREAD_BPS || 1);
const FUNDING_8H_RATE = Number(process.env.BACKTEST_FUNDING_8H_RATE || 0.0001);
const MAX_DIRECTIONAL_NOTIONAL_PCT = Number(process.env.BACKTEST_MAX_DIRECTIONAL_NOTIONAL_PCT || 15);
const TREND_GUARD_MIN_STRENGTH = Number(process.env.BACKTEST_TREND_GUARD_MIN_STRENGTH || 0.55);
const TREND_SLOPE_THRESHOLD = positiveNumber(process.env.BACKTEST_TREND_SLOPE_THRESHOLD, 0.0015);
const TREND_CONFIRM_BARS = clampInt(positiveNumber(process.env.BACKTEST_TREND_CONFIRM_BARS, 1), 1, 48);
const FLATTEN_ADVERSE_TREND = process.env.BACKTEST_FLATTEN_ADVERSE_TREND === 'true';
const REGIME_MODE_SWITCH = process.env.BACKTEST_REGIME_MODE_SWITCH === 'true';
const GRID_SIZE_MULTIPLIER = positiveNumber(process.env.BACKTEST_GRID_SIZE_MULTIPLIER, 1);
const GRID_COUNT_MULTIPLIER = positiveNumber(process.env.BACKTEST_GRID_COUNT_MULTIPLIER, 1);
const REBALANCE_EVERY = 60;

const candles = await loadCandles();
if (candles.length < 120) throw new Error(`K 线不足：${candles.length} 根`);

let cash = START_BALANCE;
let position = 0;
let fees = 0;
let funding = 0;
let slippageCost = 0;
let spreadCost = 0;
let fills = 0;
let exposureBlocks = 0;
let trendBlocks = 0;
let deferredResumes = 0;
let openingFills = 0;
let reducingFills = 0;
let trendFlattens = 0;
let trendCandidate = 'range';
let trendCandidateBars = 0;
let regimeSwitches = 0;
let maxPosition = 0;
let peak = START_BALANCE;
let maxDrawdown = 0;
let grid = createGrid(candles.slice(0, 100), candles[99].close);
let orders = seedOrders(grid, candles[99].close);
let nextFundingAt = Math.ceil(candles[100].time / (8 * 3600_000)) * 8 * 3600_000;

for (let i = 100; i < candles.length; i++) {
  const candle = candles[i];
  const completedCandles = candles.slice(Math.max(0, i - 100), i);
  const rawTrend = analyzeTrend(completedCandles, { slopeThreshold: TREND_SLOPE_THRESHOLD });
  const strongRawTrend = rawTrend.trend !== 'range' && rawTrend.strength >= TREND_GUARD_MIN_STRENGTH;
  if (!strongRawTrend) {
    trendCandidate = 'range';
    trendCandidateBars = 0;
  } else if (rawTrend.trend === trendCandidate) {
    trendCandidateBars++;
  } else {
    trendCandidate = rawTrend.trend;
    trendCandidateBars = 1;
  }
  const trend = trendCandidateBars >= TREND_CONFIRM_BARS
    ? rawTrend
    : { ...rawTrend, trend: 'range', strength: 0 };
  while (candle.time >= nextFundingAt) {
    const payment = position * candle.open * FUNDING_8H_RATE;
    cash -= payment;
    funding += payment;
    nextFundingAt += 8 * 3600_000;
  }
  const strongTrend = trend.strength >= TREND_GUARD_MIN_STRENGTH;
  const adverseInventory = (trend.trend === 'up' && position < 0) || (trend.trend === 'down' && position > 0);
  if (FLATTEN_ADVERSE_TREND && strongTrend && adverseInventory) {
    closePosition(candle.open);
    trendFlattens++;
  }
  const desiredMode = REGIME_MODE_SWITCH
    ? (trend.trend === 'up' ? 'long' : trend.trend === 'down' ? 'short' : grid.mode)
    : 'neutral';
  if (desiredMode !== grid.mode) {
    grid.mode = desiredMode;
    orders = seedOrders(grid, candle.open);
    regimeSwitches++;
  }

  for (const order of orders.values()) {
    if (!order.deferred) continue;
    const decision = orderDecision(order, candle.open, trend);
    if (!decision.allowed) continue;
    if (decision.opening && !isPassiveOpeningOrder({
      side: order.side,
      price: order.price,
      marketPrice: candle.open,
    })) continue;
    order.deferred = false;
    order.resumedAt = i;
    deferredResumes++;
  }

  const crossed = [...orders.entries()]
    .filter(([, order]) => !order.deferred && order.resumedAt !== i && (order.side === 'buy'
      ? candle.low <= order.price
      : candle.high >= order.price))
    .sort(([, a], [, b]) => a.price - b.price);
  for (const [level, order] of crossed) {
    if (orders.get(level) !== order) continue;
    const reducing = (position > 0 && order.side === 'sell') || (position < 0 && order.side === 'buy');
    if (order.role === 'exit' && !reducing) { orders.delete(level); continue; }
    const decision = orderDecision(order, candle.open, trend);
    if (!decision.allowed) {
      if (!order.deferred) {
        if (decision.reason === 'exposure_cap') exposureBlocks++;
        else if (decision.reason.startsWith('trend_')) trendBlocks++;
      }
      order.deferred = true;
      continue;
    }
    const fillSize = decision.reduceOnly
      ? Math.min(decision.sizeBase, Math.abs(position))
      : decision.sizeBase;
    if (!(fillSize > 0)) { orders.delete(level); continue; }
    const executionPrice = order.side === 'buy'
      ? order.price * (1 + (SLIPPAGE_BPS + SPREAD_BPS) / 10000)
      : order.price * (1 - (SLIPPAGE_BPS + SPREAD_BPS) / 10000);
    const value = executionPrice * fillSize;
    const fee = value * FEE_RATE;
    if (order.side === 'buy') {
      cash -= value + fee;
      position += fillSize;
      const next = Number(level) + 1;
      if (next <= grid.gridCount) orders.set(next, {
        side: 'sell', price: grid.lower + next * (grid.upper - grid.lower) / grid.gridCount,
        role: decision.reduceOnly ? 'opening' : 'exit', deferred: false,
      });
    } else {
      cash += value - fee;
      position -= fillSize;
      const next = Number(level) - 1;
      if (next >= 0) orders.set(next, {
        side: 'buy', price: grid.lower + next * (grid.upper - grid.lower) / grid.gridCount,
        role: decision.reduceOnly ? 'opening' : 'exit', deferred: false,
      });
    }
    orders.delete(level);
    slippageCost += order.price * fillSize * SLIPPAGE_BPS / 10000;
    spreadCost += order.price * fillSize * SPREAD_BPS / 10000;
    fees += fee;
    fills++;
    if (decision.reduceOnly) reducingFills++; else openingFills++;
    maxPosition = Math.max(maxPosition, Math.abs(position));
  }

  const equity = mark(candle.close);
  peak = Math.max(peak, equity);
  maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);

  if ((i - 99) % REBALANCE_EVERY === 0) {
    const suggestion = createGrid(candles.slice(Math.max(0, i - 99), i + 1), candle.close);
    if (nearEdge(candle.close, grid)) {
      suggestion.mode = grid.mode;
      grid = suggestion;
      orders = seedOrders(grid, candle.close);
    }
  }
}

const finalPrice = candles.at(-1).close;
const markBeforeClose = mark(finalPrice);
const closeResult = closePosition(finalPrice);
const finalEquity = cash;
const totalExecutionCosts = fees + funding + slippageCost + spreadCost;
console.log(JSON.stringify({
  source: 'Coinbase BTC-USD 1h',
  candles: candles.length,
  period: { from: new Date(candles[100].time).toISOString(), to: new Date(candles.at(-1).time).toISOString() },
  initialEquity: START_BALANCE,
  finalEquity: round(finalEquity),
  pnl: round(finalEquity - START_BALANCE),
  returnPct: round((finalEquity / START_BALANCE - 1) * 100),
  maxDrawdownPct: round(maxDrawdown * 100),
  fills,
  fees: round(fees),
  funding: round(funding),
  slippageCost: round(slippageCost),
  spreadCost: round(spreadCost),
  totalExecutionCosts: round(totalExecutionCosts),
  grossPnlBeforeCosts: round(finalEquity - START_BALANCE + totalExecutionCosts),
  exposureBlocks,
  trendBlocks,
  deferredResumes,
  openingFills,
  reducingFills,
  trendFlattens,
  regimeSwitches,
  forcedClose: closeResult,
  markBeforeClose: round(markBeforeClose),
  maxPositionBtc: round(maxPosition, 8),
  gridSizeMultiplier: GRID_SIZE_MULTIPLIER,
  gridCountMultiplier: GRID_COUNT_MULTIPLIER,
  trendSlopeThreshold: TREND_SLOPE_THRESHOLD,
  trendConfirmBars: TREND_CONFIRM_BARS,
  flattenAdverseTrend: FLATTEN_ADVERSE_TREND,
  regimeModeSwitch: REGIME_MODE_SWITCH,
  note: `按 1h K 线高低价触及成交，信号和新挂单仅使用上一根已完成 K 线，保护暂停订单会在条件解除且仍为被动限价时恢复；方向敞口上限 ${MAX_DIRECTIONAL_NOTIONAL_PCT}%，趋势强度阈值 ${TREND_GUARD_MIN_STRENGTH}，斜率阈值 ${TREND_SLOPE_THRESHOLD}，连续确认 ${TREND_CONFIRM_BARS} 根，逆势库存平仓 ${FLATTEN_ADVERSE_TREND ? '开启' : '关闭'}，方向切换 ${REGIME_MODE_SWITCH ? '开启' : '关闭'}，网格数量倍率 ${GRID_COUNT_MULTIPLIER}，规模倍率 ${GRID_SIZE_MULTIPLIER}，滑点 ${SLIPPAGE_BPS} bps，点差 ${SPREAD_BPS} bps，8小时资金费率 ${FUNDING_8H_RATE}；未模拟 750ms 成交延迟、部分成交、链上延迟和强平。`,
}, null, 2));

function mark(price) { return cash + position * price; }
function closePosition(price) {
  if (!position) return { positionBtc: 0, price: round(price), fee: 0 };
  const side = position > 0 ? 'sell' : 'buy';
  const executionPrice = side === 'buy'
    ? price * (1 + (SLIPPAGE_BPS + SPREAD_BPS) / 10000)
    : price * (1 - (SLIPPAGE_BPS + SPREAD_BPS) / 10000);
  const value = Math.abs(position) * executionPrice;
  const fee = value * FEE_RATE;
  cash += side === 'sell' ? value - fee : -value - fee;
  fees += fee;
  slippageCost += price * Math.abs(position) * SLIPPAGE_BPS / 10000;
  spreadCost += price * Math.abs(position) * SPREAD_BPS / 10000;
  const result = { positionBtc: round(position, 8), price: round(executionPrice), fee: round(fee) };
  position = 0;
  return result;
}
function nearEdge(price, current) {
  const buffer = (current.upper - current.lower) * 0.2;
  return price <= current.lower + buffer || price >= current.upper - buffer;
}
function createGrid(rows, price) {
  const suggestion = suggestAdaptiveGrid({
    price,
    atrPct: atrPct(rows),
    equity: mark(price),
    market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
  });
  const suggestedCount = suggestion.gridCount;
  suggestion.gridCount = clampInt(Math.round(suggestedCount * GRID_COUNT_MULTIPLIER), 10, 40);
  suggestion.sizeBase = snapSize(
    suggestion.sizeBase * (suggestedCount / suggestion.gridCount) * GRID_SIZE_MULTIPLIER,
  );
  return suggestion;
}
function seedOrders(config, price) {
  const out = new Map();
  for (let i = 0; i <= config.gridCount; i++) {
    const levelPrice = config.lower + i * (config.upper - config.lower) / config.gridCount;
    if (levelPrice < price && ['neutral', 'long'].includes(config.mode)) {
      out.set(i, { side: 'buy', price: levelPrice, role: 'opening', deferred: false });
    }
    if (levelPrice > price && ['neutral', 'short'].includes(config.mode)) {
      out.set(i, { side: 'sell', price: levelPrice, role: 'opening', deferred: false });
    }
  }
  return out;
}
function orderDecision(order, markPrice, trend) {
  return inventoryOrderDecision({
    side: order.side,
    sizeBase: grid.sizeBase,
    positionSize: position,
    price: order.price,
    equity: mark(markPrice),
    maxDirectionalNotionalPct: MAX_DIRECTIONAL_NOTIONAL_PCT,
    forceReduceOnly: order.role === 'exit',
    trendGuardEnabled: true,
    trend: trend.trend,
    trendStrength: trend.strength,
    trendGuardMinStrength: TREND_GUARD_MIN_STRENGTH,
  });
}
function snapSize(value) { return Math.max(0.0001, Math.floor(Number(value) / 0.00001) * 0.00001); }
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function clampInt(value, min, max) { return Math.min(max, Math.max(min, Number(value))); }
function atrPct(rows) {
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const current = rows[i], previous = rows[i - 1];
    trs.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  const period = Math.min(14, trs.length);
  const atr = trs.slice(-period).reduce((sum, value) => sum + value, 0) / period;
  return atr / rows.at(-1).close * 100;
}
function round(value, digits = 2) { return Number(Number(value).toFixed(digits)); }
async function loadCandles() {
  const end = Math.floor(Date.now() / CANDLE_MS) * (CANDLE_MS / 1000);
  const start = end - BACKTEST_DAYS * 24 * 3600;
  const chunkSeconds = 300 * 3600;
  const rows = [];
  for (let cursor = start; cursor < end; cursor += chunkSeconds) {
    const chunkEnd = Math.min(cursor + chunkSeconds, end);
    const url = `${API}&start=${cursor}&end=${chunkEnd}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'deepBTC-backtest/1.0' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Coinbase HTTP ${response.status}`);
    rows.push(...await response.json());
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const unique = new Map(rows.map(([time, low, high, open, close, volume]) => [Number(time), {
    time: Number(time) * 1000, low: Number(low), high: Number(high), open: Number(open), close: Number(close), volume: Number(volume),
  }]));
  const completedBefore = end * 1000;
  return [...unique.values()]
    .filter((candle) => candle.time + CANDLE_MS <= completedBefore)
    .sort((a, b) => a.time - b.time);
}
