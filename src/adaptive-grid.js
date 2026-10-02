// Conservative BTC grid sizing from current price, ATR volatility and equity.
// Pure function so the formula can be tested without an exchange connection.
import { executionFriction, NEUTRAL_GRID_DEFAULTS } from './neutral-grid.js';

export function suggestAdaptiveGrid({ price, atrPct, equity, market, trend = 'range', mode = 'neutral', policy = {}, execution = {} }) {
  const px = Number(price);
  const balance = Number(equity);
  if (!(px > 0) || !(balance > 0)) throw new Error('缺少有效价格或账户权益，无法生成网格参数。');

  const atrFraction = clamp((Number(atrPct) || 0.8) / 100, 0.006, 0.03);
  const halfWidth = clamp(atrFraction * 4, 0.06, 0.18);
  const spacingAtrMultiplier = positive(policy.spacingAtrMultiplierByMode?.[mode], positive(policy.spacingAtrMultiplier, 1));
  const configuredMinSpacing = positive(policy.minSpacingFractionByMode?.[mode], positive(policy.minSpacingFraction, 0.006));
  const costCoverageMultiple = positive(policy.costCoverageMultipleByMode?.[mode], positive(policy.costCoverageMultiple, NEUTRAL_GRID_DEFAULTS.costCoverageMultiple));
  const friction = executionFriction({
    ...execution,
    costCoverageMultiple,
    absoluteMinSpacingFraction: mode === 'neutral' && policy.costAwareSpacingEnabled !== false ? configuredMinSpacing : 0,
  });
  const minSpacingFraction = mode === 'neutral' && policy.costAwareSpacingEnabled !== false
    ? friction.minSpacingFraction
    : configuredMinSpacing;
  const maxSpacingFraction = Math.max(minSpacingFraction, positive(policy.maxSpacingFraction, 0.02));
  const spacingFraction = clamp(atrFraction * spacingAtrMultiplier, minSpacingFraction, maxSpacingFraction);
  const rawGridCount = (halfWidth * 2) / spacingFraction;
  const gridCount = clamp(mode === 'neutral' ? Math.floor(rawGridCount) : Math.round(rawGridCount), 10, 40);
  const leverage = Number(atrPct) >= positive(policy.reduceLeverageAtrPct, Infinity) ? 1 : 2;
  const stepPrice = Number(market?.stepPrice) > 0 ? Number(market.stepPrice) : 0.01;
  const stepSize = Number(market?.stepSize) > 0 ? Number(market.stepSize) : 0.0001;
  const minOrderSize = Number(market?.minOrderSize) > 0 ? Number(market.minOrderSize) : stepSize;
  const lower = snap(px * (1 - halfWidth), stepPrice);
  const upper = snap(px * (1 + halfWidth), stepPrice);
  // Size each direction against its own conservative margin budget.
  const defaultMarginPct = ({ neutral: 4, long: 8, short: 4 })[mode] || 4;
  const modeMarginPct = Number(policy.marginPctByMode?.[mode]);
  const targetMarginPct = Number.isFinite(modeMarginPct) && modeMarginPct > 0
    ? modeMarginPct
    : positive(policy.targetMarginPct, defaultMarginPct);
  const sizeMultiplier = positive(policy.sizeMultiplierByMode?.[mode], positive(policy.sizeMultiplier, 1));
  const referenceAtrPct = positive(policy.volatilityTargetAtrPct, 0);
  const volatilityScale = referenceAtrPct > 0
    ? clamp(referenceAtrPct / (atrFraction * 100), positive(policy.minVolatilityScale, 0.5), positive(policy.maxVolatilityScale, 1))
    : 1;
  const maxTargetMarginFraction = clamp(positive(policy.maxTargetMarginPct, 35) / 100, 0.01, 1);
  const targetMarginFraction = clamp(targetMarginPct * sizeMultiplier * volatilityScale / 100, 0.01, maxTargetMarginFraction);
  const rawSize = (balance * leverage * targetMarginFraction) / (gridCount * px);
  const sizeBase = Math.max(minOrderSize, Math.floor(rawSize / stepSize) * stepSize);
  const maxDirectionalNotionalPct = clamp(
    positive(policy.maxDirectionalNotionalPctByMode?.[mode], positive(policy.maxDirectionalNotionalPct, 15)),
    1,
    100,
  );

  return {
    mode: ['neutral', 'long', 'short'].includes(mode) ? mode : 'neutral',
    lower, upper, gridCount, sizeBase: snap(sizeBase, stepSize), leverage,
    outOfRangeAction: 'close',
    maxDirectionalNotionalPct,
    trendGuardEnabled: true,
    neutralRangeAdmissionEnabled: mode === 'neutral',
    rangeAdmissionMinAtrPct: Number((minSpacingFraction * 100).toFixed(3)),
    inventorySkewEnabled: mode === 'neutral',
    inventorySkewStartPctOfCap: NEUTRAL_GRID_DEFAULTS.inventorySkewStartPctOfCap,
    inventorySkewMinScale: NEUTRAL_GRID_DEFAULTS.inventorySkewMinScale,
    minRoundTripCostMultiple: costCoverageMultiple,
    roundTripCostPct: Number((friction.roundTripRate * 100).toFixed(3)),
    atrPct: Number((atrFraction * 100).toFixed(3)),
    halfWidthPct: Number((halfWidth * 100).toFixed(2)),
    sizeMultiplier,
    trend,
    rationale: `基于 ATR ${Number((atrFraction * 100).toFixed(3))}%：区间半宽 ${Number((halfWidth * 100).toFixed(2))}%，${gridCount} 格，目标格距 ${Number((spacingFraction * 100).toFixed(2))}%（预计往返损耗 ${Number((friction.roundTripRate * 100).toFixed(3))}% 的 ${costCoverageMultiple} 倍保护），${sizeMultiplier === 1 ? '' : `${sizeMultiplier} 倍仓位，`}预估保证金约占权益 ${Number((targetMarginFraction * 100).toFixed(2))}%。`,
  };
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function snap(value, step) { return Math.round(value / step) * step; }
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
