// Pure gates for the hourly adaptive-range scheduler.
export function autoRebalanceGate({
  enabled = false,
  running = false,
  hasConfig = false,
  now = Date.now(),
  lastCheckAt = 0,
  intervalMs = 60 * 60_000,
  lastAdjustedAt = 0,
  cooldownMs = 240 * 60_000,
  price,
  lower,
  upper,
  edgePct = 20,
  requireEdge = true,
} = {}) {
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (!running) return { ok: false, reason: 'not_running' };
  if (!hasConfig) return { ok: false, reason: 'no_config' };
  if (lastCheckAt > 0 && now - lastCheckAt < intervalMs) return { ok: false, reason: 'check_interval' };
  if (lastAdjustedAt > 0 && now - lastAdjustedAt < cooldownMs) return { ok: false, reason: 'cooldown' };
  const px = Number(price), lo = Number(lower), hi = Number(upper);
  if (!(px > 0) || !(hi > lo)) return { ok: false, reason: 'invalid_range' };
  if (requireEdge && !priceNearRangeEdge({ price: px, lower: lo, upper: hi, edgePct })) {
    return { ok: false, reason: 'not_near_edge' };
  }
  return { ok: true, reason: 'eligible' };
}

export function rangeChangedEnough({ previous, next, minChangePct = 10 } = {}) {
  const lower = Number(previous?.lower), upper = Number(previous?.upper);
  const nextLower = Number(next?.lower), nextUpper = Number(next?.upper);
  const span = upper - lower;
  if (!(span > 0) || !(nextUpper > nextLower)) return false;
  const threshold = span * (Number(minChangePct) / 100);
  return Math.abs(nextLower - lower) >= threshold || Math.abs(nextUpper - upper) >= threshold;
}

export function adaptiveGridChangedEnough({
  previous,
  next,
  price,
  edgePct = 20,
  minRangeChangePct = 10,
  minGridCountChangePct = 20,
  minSizeChangePct = 20,
} = {}) {
  const reasons = [];
  const nearEdge = priceNearRangeEdge({ price, lower: previous?.lower, upper: previous?.upper, edgePct });
  if (nearEdge && rangeChangedEnough({ previous, next, minChangePct: minRangeChangePct })) reasons.push('range');

  const oldCount = Number(previous?.gridCount);
  const newCount = Number(next?.gridCount);
  const countChangePct = oldCount > 0 && Number.isFinite(newCount) ? Math.abs(newCount - oldCount) / oldCount * 100 : 0;
  if (countChangePct >= Number(minGridCountChangePct)) reasons.push('grid_count');

  const oldSize = Number(previous?.sizeBase);
  const newSize = Number(next?.sizeBase);
  const sizeChangePct = oldSize > 0 && newSize > 0 ? Math.abs(newSize - oldSize) / oldSize * 100 : 0;
  if (sizeChangePct >= Number(minSizeChangePct)) reasons.push('size');

  const leverageChanged = Number(next?.leverage) > 0 && Number(next.leverage) !== Number(previous?.leverage);
  if (leverageChanged) reasons.push('leverage');

  return {
    ok: reasons.length > 0,
    reasons,
    nearEdge,
    countChangePct: round(countChangePct),
    sizeChangePct: round(sizeChangePct),
  };
}

export function priceNearRangeEdge({ price, lower, upper, edgePct = 20 } = {}) {
  const px = Number(price), lo = Number(lower), hi = Number(upper);
  if (!(px > 0) || !(hi > lo)) return false;
  const edge = (hi - lo) * Math.min(0.5, Math.max(0, Number(edgePct) / 100));
  return px <= lo + edge || px >= hi - edge;
}

export function autoRebalanceReason(code, detail = '') {
  const labels = {
    disabled: '自动调区间未开启',
    not_running: '网格未运行，不自动启动或调整',
    no_config: '没有可调整的网格参数',
    check_interval: '尚未到下一次 60 分钟检查时间',
    cooldown: '上次调整后仍在 240 分钟冷却期',
    invalid_range: '当前价格或区间无效',
    not_near_edge: '价格尚未进入区间边缘 20%',
    insufficient_change: '区间、格数、单格数量和杠杆变化均未达到更新阈值',
    uneconomic_change: '预计改善不足以覆盖重挂后的执行摩擦准备金，跳过本次更新',
    risk_rejected: '新区间未通过保证金/风险检查',
    adjusted: '已完成自动参数更新',
    failed: '自动参数更新失败',
  };
  return `${labels[code] || code}${detail ? `：${detail}` : ''}`;
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}
