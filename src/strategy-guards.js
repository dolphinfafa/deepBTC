export const STRATEGY_GUARD_DEFAULTS = Object.freeze({
  maxDirectionalNotionalPct: 15,
  trendGuardEnabled: true,
  trendGuardMinStrength: 0.55,
  trendGuardRefreshMs: 5 * 60_000,
});

export function directionalExposure({ positionSize = 0, price, equity, maxDirectionalNotionalPct } = {}) {
  const size = Number(positionSize) || 0;
  const mark = Number(price);
  const accountEquity = Number(equity);
  const maxPct = finitePositive(maxDirectionalNotionalPct)
    ? Number(maxDirectionalNotionalPct)
    : STRATEGY_GUARD_DEFAULTS.maxDirectionalNotionalPct;
  const notional = Number.isFinite(mark) && mark > 0 ? Math.abs(size) * mark : 0;
  const capNotional = Number.isFinite(accountEquity) && accountEquity > 0
    ? accountEquity * maxPct / 100
    : 0;
  return {
    side: size > 0 ? 'long' : size < 0 ? 'short' : 'flat',
    sizeBase: size,
    notional: round(notional),
    pct: accountEquity > 0 ? round(notional / accountEquity * 100) : null,
    capNotional: round(capNotional),
    capPct: maxPct,
    remainingNotional: round(Math.max(0, capNotional - notional)),
    atCap: capNotional > 0 && notional >= capNotional,
  };
}

/**
 * Decide whether an order may increase inventory. Explicit closing legs remain
 * reduce-only even when the adapter's position cache has not caught up yet.
 */
export function inventoryOrderDecision({
  side,
  sizeBase,
  positionSize = 0,
  price,
  equity,
  maxDirectionalNotionalPct,
  forceReduceOnly = false,
  trendGuardEnabled = STRATEGY_GUARD_DEFAULTS.trendGuardEnabled,
  trend = 'range',
  trendStrength = 0,
  trendGuardMinStrength = STRATEGY_GUARD_DEFAULTS.trendGuardMinStrength,
} = {}) {
  const orderSide = side === 'sell' ? 'sell' : 'buy';
  const requestedSize = Number(sizeBase);
  const position = Number(positionSize) || 0;
  const reducing = (position > 0 && orderSide === 'sell') || (position < 0 && orderSide === 'buy');

  if (!(requestedSize > 0)) return blocked('invalid_size', orderSide, requestedSize);

  if (forceReduceOnly) {
    return {
      allowed: true,
      reason: 'explicit_exit',
      side: orderSide,
      sizeBase: requestedSize,
      opening: false,
      reduceOnly: true,
      reducing,
    };
  }

  if (reducing) {
    return {
      allowed: true,
      reason: 'reducing_inventory',
      side: orderSide,
      sizeBase: Math.min(requestedSize, Math.abs(position)),
      opening: false,
      reduceOnly: true,
      reducing: true,
    };
  }

  const strongTrend = Boolean(trendGuardEnabled)
    && Number(trendStrength) >= Number(trendGuardMinStrength);
  if (strongTrend && trend === 'up' && orderSide === 'sell') {
    return blocked('trend_up_blocks_short', orderSide, requestedSize);
  }
  if (strongTrend && trend === 'down' && orderSide === 'buy') {
    return blocked('trend_down_blocks_long', orderSide, requestedSize);
  }

  const signedOrder = orderSide === 'buy' ? requestedSize : -requestedSize;
  const projectedSize = position + signedOrder;
  const exposure = directionalExposure({ positionSize: projectedSize, price, equity, maxDirectionalNotionalPct });
  if (!(exposure.capNotional > 0)) return blocked('invalid_equity', orderSide, requestedSize, exposure);
  if (exposure.notional > exposure.capNotional + 1e-8) {
    return blocked('exposure_cap', orderSide, requestedSize, exposure);
  }

  return {
    allowed: true,
    reason: 'opening_allowed',
    side: orderSide,
    sizeBase: requestedSize,
    opening: true,
    reduceOnly: false,
    reducing: false,
    projectedExposure: exposure,
  };
}

/** A resumed opening limit must still rest away from the market, not cross it. */
export function isPassiveOpeningOrder({ side, price, marketPrice } = {}) {
  const orderPrice = Number(price);
  const mark = Number(marketPrice);
  if (!(orderPrice > 0) || !(mark > 0)) return false;
  return side === 'sell' ? orderPrice > mark : orderPrice < mark;
}

export function guardReasonText(reason) {
  return ({
    invalid_size: '下单数量无效',
    invalid_equity: '账户权益无效，暂停新增仓位',
    exposure_cap: '已达到方向敞口上限',
    trend_up_blocks_short: '强上升趋势，暂停新增空头',
    trend_down_blocks_long: '强下降趋势，暂停新增多头',
  })[reason] || reason || '策略保护已阻止新增仓位';
}

function blocked(reason, side, sizeBase, projectedExposure = null) {
  return {
    allowed: false,
    reason,
    side,
    sizeBase,
    opening: true,
    reduceOnly: false,
    reducing: false,
    projectedExposure,
  };
}

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
