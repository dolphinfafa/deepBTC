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
} = {}) {
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (!running) return { ok: false, reason: 'not_running' };
  if (!hasConfig) return { ok: false, reason: 'no_config' };
  if (lastCheckAt > 0 && now - lastCheckAt < intervalMs) return { ok: false, reason: 'check_interval' };
  if (lastAdjustedAt > 0 && now - lastAdjustedAt < cooldownMs) return { ok: false, reason: 'cooldown' };
  const px = Number(price), lo = Number(lower), hi = Number(upper);
  if (!(px > 0) || !(hi > lo)) return { ok: false, reason: 'invalid_range' };
  const span = hi - lo;
  const edge = span * Math.min(0.5, Math.max(0, Number(edgePct) / 100));
  if (px > lo + edge && px < hi - edge) return { ok: false, reason: 'not_near_edge' };
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

export function autoRebalanceReason(code, detail = '') {
  const labels = {
    disabled: '自动调区间未开启',
    not_running: '网格未运行，不自动启动或调整',
    no_config: '没有可调整的网格参数',
    check_interval: '尚未到下一次 60 分钟检查时间',
    cooldown: '上次调整后仍在 240 分钟冷却期',
    invalid_range: '当前价格或区间无效',
    not_near_edge: '价格尚未进入区间边缘 20%',
    insufficient_change: '新旧区间变化不足 10%',
    risk_rejected: '新区间未通过保证金/风险检查',
    adjusted: '已完成自动调区间',
    failed: '自动调区间执行失败',
  };
  return `${labels[code] || code}${detail ? `：${detail}` : ''}`;
}
