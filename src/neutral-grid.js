import { analyzeTrend } from './trend.js';

export const NEUTRAL_GRID_DEFAULTS = Object.freeze({
  costCoverageMultiple: 3,
  rangeAdmissionMinAtrPct: 0.6,
  rangeAdmissionTrendStrength: 0.55,
  inventorySkewStartPctOfCap: 25,
  inventorySkewMinScale: 0.25,
  inventorySkewStep: 0.1,
  rebalanceBenefitCostRatio: 1,
});

const ADMISSION_FRAMES = Object.freeze([
  Object.freeze({ id: 'd1', seconds: 86400 }),
  Object.freeze({ id: 'h4', seconds: 14400 }),
  Object.freeze({ id: 'h1', seconds: 3600 }),
]);

export function executionFriction({
  feeRate = 0.0005,
  slippageBps = 0,
  spreadBps = 0,
  costCoverageMultiple = NEUTRAL_GRID_DEFAULTS.costCoverageMultiple,
  absoluteMinSpacingFraction = 0,
} = {}) {
  const oneWayRate = Math.max(0, finite(feeRate, 0.0005))
    + (Math.max(0, finite(slippageBps, 0)) + Math.max(0, finite(spreadBps, 0))) / 10_000;
  const roundTripRate = oneWayRate * 2;
  const multiple = Math.max(1, finite(costCoverageMultiple, NEUTRAL_GRID_DEFAULTS.costCoverageMultiple));
  return {
    oneWayRate,
    roundTripRate,
    costCoverageMultiple: multiple,
    minSpacingFraction: Math.max(0, finite(absoluteMinSpacingFraction, 0), roundTripRate * multiple),
  };
}

/**
 * Admit a neutral grid only after both large frames identify a range. Once
 * admitted, disagreement is treated as a transition and preserves the prior
 * state; two strong frames in the same direction revoke admission.
 */
export function neutralRangeAdmission({
  frames = {},
  currentAllowed = false,
  minAtrPct = NEUTRAL_GRID_DEFAULTS.rangeAdmissionMinAtrPct,
  trendStrength = NEUTRAL_GRID_DEFAULTS.rangeAdmissionTrendStrength,
  dataValid = true,
} = {}) {
  const d1 = frames.d1;
  const h4 = frames.h4;
  const h1 = frames.h1;
  if (!dataValid || !validFrame(d1) || !validFrame(h4) || !validFrame(h1)) {
    return admission(false, 'data_unavailable', '1D/4H/1H 已完成 K 线不足，暂停中性开仓。', frames);
  }

  const atrPct = Number(h1.atrPct);
  if (!(Number.isFinite(atrPct) && atrPct >= Number(minAtrPct))) {
    return admission(false, 'volatility_too_low', `1H ATR ${round(atrPct, 3)}% 低于 ${Number(minAtrPct)}% 的成本覆盖门槛。`, frames);
  }

  if (d1.trend === 'range' && h4.trend === 'range') {
    return admission(true, 'broad_range_confirmed', '1D 与 4H 均确认震荡，中性开仓准入。', frames);
  }

  const sameDirectionalTrend = d1.trend === h4.trend && ['up', 'down'].includes(d1.trend);
  const strongDirectionalTrend = sameDirectionalTrend
    && Number(d1.strength) >= Number(trendStrength)
    && Number(h4.strength) >= Number(trendStrength);
  if (strongDirectionalTrend) {
    return admission(false, `large_cycle_${d1.trend}`, `1D 与 4H 已确认${d1.trend === 'up' ? '上涨' : '下跌'}趋势，暂停中性开仓。`, frames);
  }

  return admission(Boolean(currentAllowed), currentAllowed ? 'transition_hold' : 'awaiting_range',
    currentAllowed ? '大周期处于过渡，沿用已有震荡准入状态。' : '大周期尚未共同确认震荡，暂不开放中性开仓。', frames);
}

export async function readNeutralRangeAdmission({
  exchange,
  marketId,
  currentAllowed = false,
  minAtrPct = NEUTRAL_GRID_DEFAULTS.rangeAdmissionMinAtrPct,
  trendStrength = NEUTRAL_GRID_DEFAULTS.rangeAdmissionTrendStrength,
  now = Date.now(),
} = {}) {
  const frames = {};
  const sources = {};
  let dataValid = true;
  for (const { id, seconds } of ADMISSION_FRAMES) {
    try {
      const candles = await exchange.getCandles(marketId, seconds, 200);
      const source = exchange.candleDataSource || exchange.dataSource || 'unknown';
      sources[id] = source;
      const completed = normalizeCompleted(candles, seconds, now);
      if (source === 'synthetic' || completed.length < 51) {
        dataValid = false;
        continue;
      }
      frames[id] = analyzeTrend(completed);
    } catch {
      dataValid = false;
    }
  }
  return {
    ...neutralRangeAdmission({ frames, currentAllowed, minAtrPct, trendStrength, dataValid }),
    sources,
    checkedAt: now,
  };
}

/** Scale only orders that would add to the current inventory direction. */
export function neutralInventorySize({
  side,
  requestedSize,
  positionSize = 0,
  price,
  equity,
  maxDirectionalNotionalPct,
  startPctOfCap = NEUTRAL_GRID_DEFAULTS.inventorySkewStartPctOfCap,
  minScale = NEUTRAL_GRID_DEFAULTS.inventorySkewMinScale,
  scaleStep = NEUTRAL_GRID_DEFAULTS.inventorySkewStep,
  stepSize = 0,
  minOrderSize = 0,
} = {}) {
  const requested = Number(requestedSize);
  const position = Number(positionSize) || 0;
  const worsensInventory = (position > 0 && side === 'buy') || (position < 0 && side === 'sell');
  if (!(requested > 0) || !worsensInventory) return { sizeBase: requested, scale: 1, applied: false };

  const accountEquity = Number(equity);
  const mark = Number(price);
  const capPct = Number(maxDirectionalNotionalPct);
  const capNotional = accountEquity > 0 && capPct > 0 ? accountEquity * capPct / 100 : 0;
  if (!(mark > 0) || !(capNotional > 0)) return { sizeBase: requested, scale: 1, applied: false };

  const usage = Math.min(1, Math.abs(position) * mark / capNotional);
  const start = clamp(Number(startPctOfCap) / 100, 0, 0.95);
  if (usage <= start) return { sizeBase: requested, scale: 1, applied: false, usagePctOfCap: round(usage * 100) };

  const floor = clamp(Number(minScale), 0.05, 1);
  const rawScale = 1 - ((usage - start) / (1 - start)) * (1 - floor);
  const quantum = clamp(Number(scaleStep), 0.01, 1);
  const scale = clamp(Math.round(rawScale / quantum) * quantum, floor, 1);
  const step = Number(stepSize) > 0 ? Number(stepSize) : 0;
  const minimum = Number(minOrderSize) > 0 ? Number(minOrderSize) : step;
  let sizeBase = requested * scale;
  if (step > 0) sizeBase = Math.floor((sizeBase + 1e-12) / step) * step;
  if (minimum > 0 && sizeBase < minimum) sizeBase = 0;
  return {
    sizeBase: round(sizeBase, 12),
    scale,
    applied: scale < 1,
    usagePctOfCap: round(usage * 100),
  };
}

/**
 * Compare net grid-cycle capacity with a one-order execution reserve. Range
 * recentering and exposure reductions are risk actions, but still need a grid
 * whose spacing clears the configured cost multiple.
 */
export function neutralRebalanceEconomics({
  previous,
  next,
  price,
  reasons = [],
  nearEdge = false,
  execution = {},
  benefitCostRatio = NEUTRAL_GRID_DEFAULTS.rebalanceBenefitCostRatio,
} = {}) {
  const mark = Number(price);
  if (!(mark > 0)) return { ok: false, reason: 'invalid_price' };
  const friction = executionFriction(execution);
  const before = gridEconomics(previous, mark, friction);
  const after = gridEconomics(next, mark, friction);
  if (!after.valid || after.spacingFraction + 1e-12 < friction.minSpacingFraction) {
    return { ok: false, reason: 'cost_floor', before, after, friction };
  }

  const riskRecenter = nearEdge && reasons.includes('range');
  const riskReduction = Number(next?.sizeBase) < Number(previous?.sizeBase)
    || Number(next?.leverage) < Number(previous?.leverage);
  const expectedBenefit = after.cycleNet - before.cycleNet;
  const frictionReserve = mark * Math.max(Number(previous?.sizeBase) || 0, Number(next?.sizeBase) || 0)
    * friction.oneWayRate * Math.max(1, Number(benefitCostRatio) || 1);
  const economicallyImproved = expectedBenefit > 0 && expectedBenefit + 1e-12 >= frictionReserve;
  return {
    ok: riskRecenter || riskReduction || economicallyImproved,
    reason: riskRecenter ? 'risk_recenter' : riskReduction ? 'risk_reduction' : economicallyImproved ? 'economic_improvement' : 'benefit_below_friction',
    before,
    after,
    expectedBenefit: round(expectedBenefit, 8),
    frictionReserve: round(frictionReserve, 8),
    friction,
  };
}

function gridEconomics(params, price, friction) {
  const lower = Number(params?.lower);
  const upper = Number(params?.upper);
  const count = Number(params?.gridCount);
  const size = Number(params?.sizeBase);
  if (!(upper > lower) || !(count > 0) || !(size > 0)) return { valid: false };
  const spacing = (upper - lower) / count;
  const grossPerRung = spacing * size;
  const costPerRung = price * size * friction.roundTripRate;
  const netPerRung = grossPerRung - costPerRung;
  return {
    valid: true,
    spacing: round(spacing, 8),
    spacingFraction: round(spacing / price, 10),
    grossPerRung: round(grossPerRung, 8),
    costPerRung: round(costPerRung, 8),
    netPerRung: round(netPerRung, 8),
    cycleNet: round(netPerRung * count, 8),
  };
}

function normalizeCompleted(candles, seconds, now) {
  const intervalMs = Number(seconds) * 1000;
  return (candles || []).map((candle) => {
    const time = Number(candle?.time);
    return { ...candle, time, endTime: Number(candle?.endTime) || time + intervalMs };
  }).filter((candle) => Number.isFinite(candle.time) && candle.endTime <= now)
    .sort((a, b) => a.time - b.time);
}

function admission(allowed, reason, detail, frames) {
  return { enabled: true, allowed, reason, detail, frames };
}

function validFrame(frame) {
  return ['up', 'down', 'range'].includes(frame?.trend);
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 0;
  return Number(Number(value).toFixed(digits));
}
