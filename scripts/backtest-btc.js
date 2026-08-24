import { suggestAdaptiveGrid } from '../src/adaptive-grid.js';
import { analyzeTrend } from '../src/trend.js';
import { inventoryOrderDecision } from '../src/strategy-guards.js';

const API = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600';
const BACKTEST_DAYS = Number(process.env.BACKTEST_DAYS || 180);
const START_BALANCE = 10_000;
const FEE_RATE = 0.0005;
const SLIPPAGE_BPS = Number(process.env.BACKTEST_SLIPPAGE_BPS || 2);
const SPREAD_BPS = Number(process.env.BACKTEST_SPREAD_BPS || 1);
const FUNDING_8H_RATE = Number(process.env.BACKTEST_FUNDING_8H_RATE || 0.0001);
const MAX_DIRECTIONAL_NOTIONAL_PCT = Number(process.env.BACKTEST_MAX_DIRECTIONAL_NOTIONAL_PCT || 15);
const TREND_GUARD_MIN_STRENGTH = Number(process.env.BACKTEST_TREND_GUARD_MIN_STRENGTH || 0.55);
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
let maxPosition = 0;
let peak = START_BALANCE;
let maxDrawdown = 0;
let grid = null;
let orders = new Map();
let nextFundingAt = Math.ceil(candles[100].time / (8 * 3600_000)) * 8 * 3600_000;

for (let i = 100; i < candles.length; i++) {
  const candle = candles[i];
  const previous = candles[i - 1].close;
  const trend = analyzeTrend(candles.slice(Math.max(0, i - 100), i + 1));
  while (candle.time >= nextFundingAt) {
    const payment = position * candle.close * FUNDING_8H_RATE;
    cash -= payment;
    funding += payment;
    nextFundingAt += 8 * 3600_000;
  }
  if (!grid || (i - 100) % REBALANCE_EVERY === 0) {
    const suggestion = suggestAdaptiveGrid({
      price: candle.close,
      atrPct: atrPct(candles.slice(Math.max(0, i - 100), i)),
      equity: mark(candle.close),
      market: { stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001 },
    });
    if (!grid || nearEdge(candle.close, grid)) {
      grid = suggestion;
      orders = seedOrders(grid, candle.close);
    }
  }

  const crossed = [...orders.entries()]
    .filter(([, order]) => order.side === 'buy'
      ? candle.low <= order.price && previous > order.price
      : candle.high >= order.price && previous < order.price)
    .sort(([, a], [, b]) => a.price - b.price);
  for (const [level, order] of crossed) {
    if (!orders.has(level)) continue;
    const reducing = (position > 0 && order.side === 'sell') || (position < 0 && order.side === 'buy');
    const forceReduceOnly = order.opening === false;
    if (forceReduceOnly && !reducing) { orders.delete(level); continue; }
    const decision = inventoryOrderDecision({
      side: order.side,
      sizeBase: grid.sizeBase,
      positionSize: position,
      price: order.price,
      equity: mark(candle.close),
      maxDirectionalNotionalPct: MAX_DIRECTIONAL_NOTIONAL_PCT,
      forceReduceOnly,
      trendGuardEnabled: true,
      trend: trend.trend,
      trendStrength: trend.strength,
      trendGuardMinStrength: TREND_GUARD_MIN_STRENGTH,
    });
    if (!decision.allowed) {
      if (decision.reason === 'exposure_cap') exposureBlocks++;
      else if (decision.reason.startsWith('trend_')) trendBlocks++;
      orders.delete(level);
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
      if (next <= grid.gridCount) orders.set(next, { side: 'sell', price: grid.lower + next * (grid.upper - grid.lower) / grid.gridCount, opening: decision.reduceOnly });
    } else {
      cash += value - fee;
      position -= fillSize;
      const next = Number(level) - 1;
      if (next >= 0) orders.set(next, { side: 'buy', price: grid.lower + next * (grid.upper - grid.lower) / grid.gridCount, opening: decision.reduceOnly });
    }
    orders.delete(level);
    slippageCost += order.price * fillSize * SLIPPAGE_BPS / 10000;
    spreadCost += order.price * fillSize * SPREAD_BPS / 10000;
    fees += fee;
    fills++;
    maxPosition = Math.max(maxPosition, Math.abs(position));
  }

  const equity = mark(candle.close);
  peak = Math.max(peak, equity);
  maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
}

const finalPrice = candles.at(-1).close;
const markBeforeClose = mark(finalPrice);
const closeResult = closePosition(finalPrice);
const finalEquity = cash;
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
  exposureBlocks,
  trendBlocks,
  forcedClose: closeResult,
  markBeforeClose: round(markBeforeClose),
  maxPositionBtc: round(maxPosition, 8),
  note: `按收盘穿越成交，方向敞口上限 ${MAX_DIRECTIONAL_NOTIONAL_PCT}%，趋势阈值 ${TREND_GUARD_MIN_STRENGTH}，滑点 ${SLIPPAGE_BPS} bps，点差 ${SPREAD_BPS} bps，8小时资金费率 ${FUNDING_8H_RATE}；未模拟成交延迟、部分成交、链上延迟和强平。`,
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
function seedOrders(config, price) {
  const out = new Map();
  for (let i = 0; i <= config.gridCount; i++) {
    const levelPrice = config.lower + i * (config.upper - config.lower) / config.gridCount;
    if (levelPrice < price) out.set(i, { side: 'buy', price: levelPrice, opening: true });
    if (levelPrice > price) out.set(i, { side: 'sell', price: levelPrice, opening: true });
  }
  return out;
}
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
  const end = Math.floor(Date.now() / 1000);
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
  return [...unique.values()].sort((a, b) => a.time - b.time);
}
