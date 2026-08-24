// Conservative BTC grid sizing from current price, ATR volatility and equity.
// Pure function so the formula can be tested without an exchange connection.
export function suggestAdaptiveGrid({ price, atrPct, equity, market, trend = 'range' }) {
  const px = Number(price);
  const balance = Number(equity);
  if (!(px > 0) || !(balance > 0)) throw new Error('缺少有效价格或账户权益，无法生成网格参数。');

  const atrFraction = clamp((Number(atrPct) || 0.8) / 100, 0.006, 0.03);
  const halfWidth = clamp(atrFraction * 4, 0.06, 0.18);
  const spacingFraction = clamp(atrFraction * 0.75, 0.004, 0.02);
  const gridCount = clamp(Math.round((halfWidth * 2) / spacingFraction), 10, 40);
  const leverage = 2;
  const stepPrice = Number(market?.stepPrice) > 0 ? Number(market.stepPrice) : 0.01;
  const stepSize = Number(market?.stepSize) > 0 ? Number(market.stepSize) : 0.0001;
  const minOrderSize = Number(market?.minOrderSize) > 0 ? Number(market.minOrderSize) : stepSize;
  const lower = snap(px * (1 - halfWidth), stepPrice);
  const upper = snap(px * (1 + halfWidth), stepPrice);
  // Reserve 8% of equity as estimated grid margin.
  const rawSize = (balance * leverage * 0.08) / (gridCount * px);
  const sizeBase = Math.max(minOrderSize, Math.floor(rawSize / stepSize) * stepSize);

  return {
    mode: 'neutral',
    lower, upper, gridCount, sizeBase: snap(sizeBase, stepSize), leverage,
    outOfRangeAction: 'close',
    maxDirectionalNotionalPct: 15,
    trendGuardEnabled: true,
    atrPct: Number((atrFraction * 100).toFixed(3)),
    halfWidthPct: Number((halfWidth * 100).toFixed(2)),
    trend,
    rationale: `基于 ATR ${Number((atrFraction * 100).toFixed(3))}%：区间半宽 ${Number((halfWidth * 100).toFixed(2))}%，${gridCount} 格，预估保证金约占权益 8%。`,
  };
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function snap(value, step) { return Math.round(value / step) * step; }
