import fs from 'node:fs';
import path from 'node:path';

export function evaluateStartRisk({ params, market, equity, policy, existingPosition = null, currentPrice = null }) {
  const errors = [];
  const warnings = [];
  const lower = Number(params.lower);
  const upper = Number(params.upper);
  const gridCount = Number(params.gridCount);
  const sizeBase = Number(params.sizeBase);
  const leverage = Number(params.leverage);
  const available = Number(equity);

  if (!(upper > lower) || lower <= 0) errors.push('网格上下边界无效。');
  if (!Number.isInteger(gridCount) || gridCount < 2) errors.push('网格数量必须是至少 2 的整数。');
  if (!(sizeBase > 0)) errors.push('每格数量必须大于 0。');
  if (!(leverage >= 1)) errors.push('杠杆必须至少为 1x。');
  if (policy.maxGridCount > 0 && gridCount > policy.maxGridCount) errors.push(`网格数量 ${gridCount} 超过实盘上限 ${policy.maxGridCount}。`);
  if (policy.maxLeverage > 0 && leverage > policy.maxLeverage) errors.push(`杠杆 ${leverage}x 超过实盘上限 ${policy.maxLeverage}x。`);
  if (market?.maxLeverage && leverage > market.maxLeverage) errors.push(`杠杆超过市场上限 ${market.maxLeverage}x。`);
  if (market?.minOrderSize && sizeBase < market.minOrderSize) errors.push(`每格数量低于市场最小值 ${market.minOrderSize}。`);

  const mid = (lower + upper) / 2;
  // N grid cells have N+1 price levels. If the current price does not land in
  // the skip band, a neutral seed can rest on every level, so size for N+1.
  const maxSeedOrders = Number.isInteger(gridCount) && gridCount >= 2 ? gridCount + 1 : gridCount;
  const gridNotional = maxSeedOrders * sizeBase * mid;
  const positionPrice = Number(currentPrice) > 0 ? Number(currentPrice) : mid;
  const existingNotional = Math.abs(Number(existingPosition?.sizeBase) || 0) * positionPrice;
  const notional = gridNotional + existingNotional;
  const requiredMargin = leverage > 0 ? notional / leverage : Infinity;
  const marginPct = available > 0 ? (requiredMargin / available) * 100 : null;
  const marketMaxLeverage = Number(market?.maxLeverage);
  const maintenanceMargin = marketMaxLeverage > 0 ? notional / (marketMaxLeverage * 2) : null;
  const maintenanceMarginRatio = available > 0 && maintenanceMargin > 0 ? (available / maintenanceMargin) * 100 : null;
  const spacingPct = mid > 0 && gridCount > 0 ? (((upper - lower) / gridCount) / mid) * 100 : null;

  if (policy.maxNotional > 0 && notional > policy.maxNotional) errors.push(`名义仓位 ${round(notional)} USDC 超过上限 ${policy.maxNotional} USDC。`);
  if (marginPct != null && marginPct > policy.maxMarginPct) errors.push(`预估保证金占权益 ${round(marginPct)}%，超过上限 ${policy.maxMarginPct}%。`);
  if (maintenanceMarginRatio != null && policy.minMaintenanceMarginRatio > 0 && maintenanceMarginRatio < policy.minMaintenanceMarginRatio) {
    errors.push(`预计维持保证金率 ${round(maintenanceMarginRatio)}%，低于下限 ${policy.minMaintenanceMarginRatio}%。`);
  }
  if (!Number.isFinite(available) || available <= 0) errors.push('未读取到有效账户权益。');
  if (spacingPct != null && spacingPct < 0.15) warnings.push(`单格间距仅 ${round(spacingPct)}%，可能难以覆盖手续费和滑点。`);
  if (marginPct != null && marginPct > policy.maxMarginPct * 0.75) warnings.push(`保证金占用接近上限：${round(marginPct)}%。`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      notional: round(notional),
      gridNotional: round(gridNotional),
      existingNotional: round(existingNotional),
      maxSeedOrders,
      requiredMargin: round(requiredMargin),
      marginPct: marginPct == null ? null : round(marginPct),
      maintenanceMargin: maintenanceMargin == null ? null : round(maintenanceMargin),
      maintenanceMarginRatio: maintenanceMarginRatio == null ? null : round(maintenanceMarginRatio),
      spacingPct: spacingPct == null ? null : round(spacingPct),
    },
  };
}

export class LiveRiskState {
  constructor(root, policy) {
    this.file = path.join(root, '.risk-state.json');
    this.policy = policy;
    this.state = this._load();
  }

  observe(equity, now = Date.now()) {
    const value = Number(equity);
    if (!Number.isFinite(value) || value <= 0) return this.status(value, now);
    const day = utcDay(now);
    if (this.state.day !== day || !(this.state.baselineEquity > 0)) {
      this.state = { day, baselineEquity: value, highWaterEquity: value, halted: false, reason: null, updatedAt: now };
    } else {
      this.state.highWaterEquity = Math.max(Number(this.state.highWaterEquity) || value, value);
      this.state.updatedAt = now;
    }
    const status = this.status(value, now);
    if (!this.state.halted && !status.ok) {
      this.state.halted = true;
      this.state.reason = status.reason;
    }
    this._save();
    return this.status(value, now);
  }

  status(equity, now = Date.now()) {
    const value = Number(equity);
    const baseline = Number(this.state.baselineEquity);
    const high = Number(this.state.highWaterEquity);
    const dailyLoss = Number.isFinite(value) && baseline > 0 ? Math.max(0, baseline - value) : 0;
    const drawdownPct = Number.isFinite(value) && high > 0 ? Math.max(0, ((high - value) / high) * 100) : 0;
    let reason = this.state.reason || null;
    if (!reason && dailyLoss >= this.policy.dailyLossLimit) reason = `日内亏损达到 ${round(dailyLoss)} USDC`;
    if (!reason && drawdownPct >= this.policy.maxDrawdownPct) reason = `权益回撤达到 ${round(drawdownPct)}%`;
    return {
      ok: !this.state.halted && !reason,
      halted: !!this.state.halted || !!reason,
      reason,
      day: this.state.day || utcDay(now),
      baselineEquity: baseline || null,
      highWaterEquity: high || null,
      dailyLoss: round(dailyLoss),
      drawdownPct: round(drawdownPct),
      policy: this.policy,
    };
  }

  reset(equity, now = Date.now()) {
    const value = Number(equity);
    if (!Number.isFinite(value) || value <= 0) throw new Error('无法用无效权益重置风险基线。');
    this.state = { day: utcDay(now), baselineEquity: value, highWaterEquity: value, halted: false, reason: null, updatedAt: now };
    this._save();
    return this.status(value, now);
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; }
    catch { return {}; }
  }

  _save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* persistence must not crash order management */ }
  }
}

function utcDay(now) { return new Date(now).toISOString().slice(0, 10); }
function round(value) { return Math.round(Number(value) * 100) / 100; }
