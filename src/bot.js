// GridBot: orchestrates an arithmetic grid on one market. Places the initial
// ladder of limit orders, and on every fill places the opposite order one rung
// away (buy->sell up, sell->buy down), capturing `spacing * size` per round.
// Risk controls: leverage cap, margin pre-check, fee/spacing check, out-of-range
// alerts (optional auto-stop), periodic open-order reconciliation, crash-safe
// persistence with resume-on-restart, live range adjustment, and a health probe.
import { buildGrid, seedOrders, replacementFor, isReduceOnly } from './grid.js';
import { analyzeTrend } from './trend.js';
import {
  STRATEGY_GUARD_DEFAULTS,
  directionalExposure,
  guardReasonText,
  inventoryOrderDecision,
  isPassiveOpeningOrder,
} from './strategy-guards.js';
import { NEUTRAL_GRID_DEFAULTS, readNeutralRangeAdmission } from './neutral-grid.js';

const RECONCILE_MS = 30000;   // periodic open-order reconciliation cadence
const PRUNE_GRACE_MS = 20000; // don't prune a tracked order younger than this

export class GridBot {
  constructor(exchange, opts = {}) {
    this.ex = exchange;
    this.running = false;
    this.waitingForAdmission = false;
    this.config = null;
    this.grid = null;
    this.active = new Map();        // orderId -> {levelIndex, side, price, opening, placedAt}
    this.fills = [];                // recent fills (capped)
    this.alerts = [];               // recent alerts (capped)
    this.activity = [];             // complete trading operation stream (capped)
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.startBalance = null;
    this.lastPrice = null;
    this.outOfRange = false;
    this.risk = null;
    this._stopping = false;         // re-entrancy guard for auto-stop
    this._coidSeq = 0;              // monotonic client-order-id counter
    this._placeFails = 0;          // cumulative order-placement failures
    this._lastFailAt = 0;
    this._exchangeOpenOrders = null; // last reconciled real open-order count
    this._pendingLevels = new Set(); // levels with a placement in flight (dedup guard)
    this._recoveryOccupied = new Set(); // recovery: real exchange-occupied levels (from reconcile)
    this._reconTimer = null;
    this.recovery = false;          // standalone reduce-only recovery mode
    this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null; // persistence hook
    this._onFill = (f) => this._handleFill(f);
    this._onPrice = (p) => this._handlePrice(p);
    // CRITICAL: an EventEmitter that emits 'error' with no listener crashes the
    // whole Node process. Adapters emit 'error' on cancelled/rejected orders, so
    // we MUST always have a listener attached for the bot's whole lifetime.
    this._onError = (e) => this._handleExError(e);
    this.ex.on('error', this._onError);
    this._cancelTimes = [];          // timestamps of recent order cancellations
    this._refillPausedUntil = 0;     // back-off window: pause new placements until this time
    this._lastErrAlertAt = 0;
    this._lastErrLogAt = 0;
    this._retryQueue = [];           // failed CLOSING-leg placements awaiting retry (never opening legs)
    this._noPosStreak = 0;           // consecutive empty-position observations (recovery finish guard)
    this._pnlBase = null;            // realizedPnl baseline; resetStats uses an offset because some
                                     // Some adapters re-fetch realizedPnl from the exchange every poll.
    this._unrealizedBase = 0;
    this._costBase = emptyCosts();
    this.measurement = null;
    this.measurementHistory = [];
    this._measurementSeq = 0;
    this.strategyGuard = defaultGuardState();
    this._guardTimer = null;
    this._guardRefreshInFlight = null;
    this._guardSync = Promise.resolve();
    this._guardBlockAt = new Map();
    this._guardDeferred = new Map();
  }

  /**
   * Handle an 'error' emitted by the exchange adapter. Never throws (that would
   * crash the process). Records a throttled alert, and — if orders are being
   * cancelled rapidly (the tell-tale of collateral exhaustion or manual
   * intervention) — pauses auto-refill so we stop hammering the exchange and
   * burning gas on orders that just get rejected.
   */
  _handleExError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    const now = Date.now();
    if (now - this._lastErrLogAt > 3000) { this._lastErrLogAt = now; try { console.error('[交易所事件] ' + msg); } catch {} }
    if (now - this._lastErrAlertAt > 5000) { this._lastErrAlertAt = now; this._alert('交易所事件: ' + msg); }

    if (/取消|cancel|collateral|保证金|reject/i.test(msg)) {
      this._cancelTimes.push(now);
      this._cancelTimes = this._cancelTimes.filter((t) => now - t < 60000); // last 60s
      if (this._cancelTimes.length >= 5 && now >= this._refillPausedUntil) {
        this._refillPausedUntil = now + 60000;
        this._alert('⚠️ 检测到 60 秒内多笔订单被取消（疑似保证金不足或手动撤单），已暂停自动补单 60 秒，避免反复被拒、浪费手续费。请检查保证金/减小持仓。');
      }
    }
  }

  /** Notify the persistence layer (if any) that durable state changed. */
  _changed() { try { this._onChange?.(this.snapshot()); } catch { /* never let persistence break trading */ } }

  /** Durable snapshot for crash recovery / resume. Includes resting orders. */
  snapshot() {
    return {
      running: this.running, waitingForAdmission: this.waitingForAdmission,
      config: this.config, stats: this.stats,
      recovery: this.recovery, pnlBase: this._pnlBase,
      unrealizedBase: this._unrealizedBase, costBase: this._costBase,
      measurement: this.measurement, measurementHistory: this.measurementHistory,
      measurementSeq: this._measurementSeq, strategyGuard: this.strategyGuard,
      guardDeferred: [...this._guardDeferred.entries()],
      startBalance: this.startBalance, outOfRange: this.outOfRange, lastPrice: this.lastPrice,
      fills: this.fills.slice(0, 50), alerts: this.alerts.slice(0, 30),
      activity: this.activity.slice(0, 200),
      active: [...this.active.entries()],
      exchangeState: this.ex.exportState?.() ?? null,
    };
  }

  /**
   * Restore display/accounting state after a process restart WITHOUT resuming
   * trading (running stays false). Used when we only want continuity of stats.
   */
  restore(snap) {
    if (!snap || !snap.config) return;
    this.config = withGuardDefaults(snap.config);
    this.waitingForAdmission = false;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this._restoreMeasurement(snap);
    this.fills = Array.isArray(snap.fills) ? snap.fills.slice(0, 50) : [];
    this.alerts = Array.isArray(snap.alerts) ? snap.alerts.slice(0, 30) : [];
    this.activity = restoreActivity(snap);
    try {
      this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
      this._recomputeRisk();
    } catch { /* config may be incomplete */ }
  }

  /**
   * Resume a grid that was running when the process died: re-attach to the
   * orders still resting on the exchange (rebuilding both our tracking and the
   * adapter's), restart listeners, then reconcile against the real book.
   */
  async resume(snap, restoreContext = {}) {
    if (!snap || !snap.config) throw new Error('无可恢复的运行中网格快照');
    if (this.running) throw new Error('已在运行，无法重复恢复');
    // Standalone recovery ladder has no grid (gridCount=null): resume it via its
    // own path — the old code fell into buildGrid, threw, and the fallback then
    // CANCELLED the whole ladder while the position stayed open.
    if (snap.recovery || snap.config.mode === 'recovery') return this._resumeRecovery(snap, restoreContext);
    if (!Array.isArray(snap.active)) throw new Error('无可恢复的运行中网格快照');
    this.config = withGuardDefaults(snap.config);
    this.waitingForAdmission = snap.waitingForAdmission === true;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this._restoreMeasurement(snap);
    this.fills = Array.isArray(snap.fills) ? snap.fills.slice(0, 50) : [];
    this.alerts = Array.isArray(snap.alerts) ? snap.alerts.slice(0, 30) : [];
    this.activity = restoreActivity(snap);
    this.outOfRange = !!snap.outOfRange;
    this.lastPrice = snap.lastPrice ?? null;
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    this._recomputeRisk();
    this.ex.restoreState?.(snap.exchangeState, { ...restoreContext, marketId: this.config.marketId, displayName: this.config.displayName });

    // Rebuild our active map AND the adapter's order tracking so fills on these
    // pre-existing orders are detected.
    this.active.clear();
    for (const [id, info] of snap.active) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      if (!this.activity.some((item) => item.message?.includes(`#${oid}`))) {
        this._activity(`恢复接管挂单 · ${sideName(info.side)} ${round6(Number(info.sizeBase ?? this.config.sizeBase) || 0)} @ ${round2(Number(info.price) || 0)} · 网格 ${info.levelIndex} · #${oid}`, 'order');
      }
      if (typeof this.ex.adoptOrder === 'function') {
        try {
          this.ex.adoptOrder({
            orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
            side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
            remainingSize: info.sizeBase ?? this.config.sizeBase,
            reduceOnly: !!info.reduceOnly || !!info.recovery || isReduceOnly(info.side, this.config.mode),
            clientOrderId: info.clientOrderId,
          });
        } catch { /* best effort */ }
      }
    }

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this.running = true;
    this._startReconcileTimer();
    this._startGuardTimer();
    this._refreshTrendGuard(true).catch(() => {});
    this._alert(this.waitingForAdmission
      ? `已恢复 ${this.config.displayName} ${labelMode(this.config.mode)}：策略保持启动，继续等待震荡准入。`
      : `已恢复运行中的 ${this.config.displayName} ${labelMode(this.config.mode)}：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    this.reconcileOpenOrders().catch(() => {}); // immediate reconcile
    this._changed();
    return this.getState();
  }

  /** Resume a standalone reduce-only recovery ladder after a process restart. */
  async _resumeRecovery(snap, restoreContext = {}) {
    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this._restoreMeasurement(snap);
    this.fills = Array.isArray(snap.fills) ? snap.fills.slice(0, 50) : [];
    this.alerts = Array.isArray(snap.alerts) ? snap.alerts.slice(0, 30) : [];
    this.activity = restoreActivity(snap);
    this.grid = null; this.risk = null;
    this.recovery = true; this.outOfRange = false;
    this.lastPrice = snap.lastPrice ?? null;
    this.ex.restoreState?.(snap.exchangeState, { ...restoreContext, marketId: this.config.marketId, displayName: this.config.displayName });
    this._noPosStreak = 0; this._retryQueue = [];
    this.active.clear();
    for (const [id, info] of (Array.isArray(snap.active) ? snap.active : [])) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      if (!this.activity.some((item) => item.message?.includes(`#${oid}`))) {
        this._activity(`恢复接管回收挂单 · ${sideName(info.side)} ${round6(Number(info.sizeBase ?? this.config.sizeBase) || 0)} @ ${round2(Number(info.price) || 0)} · 网格 ${info.levelIndex} · #${oid}`, 'order');
      }
      try {
        this.ex.adoptOrder?.({
          orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
          side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
          reduceOnly: true,
        });
      } catch { /* best effort */ }
    }
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this.running = true;
    // seed the adapter's price watch + refresh lastPrice
    const px = await this.ex.getPrice(this.config.marketId).catch(() => null);
    if (px > 0) this.lastPrice = px;
    this._recoveryOccupied = new Set();
    this._alert(`已恢复 ${this.config.displayName} 的「只减仓回收阶梯」：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    await this.reconcileOpenOrders().catch(() => {});
    this._startReconcileTimer();
    this._changed();
    return this.getState();
  }

  /**
   * Fallback recovery: cancel any resting orders from a previous run (used when
   * resume is not desired or fails).
   */
  async recoverStrayOrders() {
    if (!this.config) return;
    await this._cancelAllTracked('异常恢复撤单').catch(() => {});
    this._alert('⚠️ 检测到上次运行未正常结束：已撤销该市场遗留挂单。请确认仓位后重新启动网格。');
    this._changed();
  }

  /** @param cfg {marketId, mode, lower, upper, gridCount, sizeBase, leverage, outOfRangeAction} */
  async start(cfg) {
    if (this.running || this._starting) throw new Error('机器人已在运行或正在启动，请勿重复点击。');
    this._starting = true;
    try { return await this._start(cfg); }
    finally { this._starting = false; }
  }

  async _start(cfg) {
    const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
    if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);

    const leverage = Math.min(Number(cfg.leverage || 3), market.maxLeverage || 50);
    const sizeBase = Math.max(Number(cfg.sizeBase), market.minOrderSize || 0);
    this.config = {
      marketId: market.marketId, displayName: market.displayName,
      strategyId: cfg.strategyId || null,
      mode: cfg.mode || 'neutral',
      lower: Number(cfg.lower), upper: Number(cfg.upper),
      gridCount: Number(cfg.gridCount), sizeBase, leverage,
      // 区间外止损策略：'close'=冲破区间平仓（撤单+平仓+停止）；'recover'=只减仓回收阶梯
      outOfRangeAction: cfg.outOfRangeAction === 'recover' ? 'recover' : 'close',
      maxDirectionalNotionalPct: bounded(cfg.maxDirectionalNotionalPct, 1, 100, STRATEGY_GUARD_DEFAULTS.maxDirectionalNotionalPct),
      trendGuardEnabled: cfg.trendGuardEnabled !== false,
      trendGuardMinStrength: bounded(cfg.trendGuardMinStrength, 0, 1, STRATEGY_GUARD_DEFAULTS.trendGuardMinStrength),
      trendGuardRefreshMs: bounded(cfg.trendGuardRefreshMs, 60_000, 60 * 60_000, STRATEGY_GUARD_DEFAULTS.trendGuardRefreshMs),
      neutralRangeAdmissionEnabled: cfg.neutralRangeAdmissionEnabled === true,
      rangeAdmissionMinAtrPct: bounded(cfg.rangeAdmissionMinAtrPct, 0.05, 10, NEUTRAL_GRID_DEFAULTS.rangeAdmissionMinAtrPct),
      inventorySkewEnabled: cfg.inventorySkewEnabled === true,
      inventorySkewStartPctOfCap: bounded(cfg.inventorySkewStartPctOfCap, 0, 95, NEUTRAL_GRID_DEFAULTS.inventorySkewStartPctOfCap),
      inventorySkewMinScale: bounded(cfg.inventorySkewMinScale, 0.05, 1, NEUTRAL_GRID_DEFAULTS.inventorySkewMinScale),
      minRoundTripCostMultiple: bounded(cfg.minRoundTripCostMultiple, 1, 10, NEUTRAL_GRID_DEFAULTS.costCoverageMultiple),
      stepSize: market.stepSize, stepPrice: market.stepPrice,
      minOrderSize: market.minOrderSize,
      maxLeverage: market.maxLeverage,
    };
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    this._recomputeRisk();
    this._refillPausedUntil = 0; this._cancelTimes = []; // fresh start clears any back-off
    this._retryQueue = []; this._noPosStreak = 0;
    this._guardDeferred.clear();
    this.waitingForAdmission = false;
    this.recovery = false;

    // record the starting equity up front (margin pre-check, returnPct, recovery)
    if (this.startBalance == null) {
      this.startBalance =
        typeof this.ex.equity === 'number' ? this.ex.equity
        : typeof this.ex.balance === 'number' ? this.ex.balance
        : null;
    }

    // ---- margin pre-check ----
    const requiredMargin = this.risk.requiredMargin;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null) {
      if (requiredMargin > available) {
        throw new Error(`保证金不足：该网格约需 ${round2(requiredMargin)} USDC（名义敞口 ${this.risk.notional}，${leverage}x），当前可用 ${round2(available)} USDC。请降低每格数量/网格数，或提高杠杆/充值后再启动。`);
      }
      if (requiredMargin > available * 0.8) {
        this._alert(`⚠️ 保证金占用偏高：约 ${round2(requiredMargin)} / 可用 ${round2(available)} USDC（>80%），价格波动时有强平风险。`);
      }
    }

    // ---- fee vs spacing sanity check ----
    const feeRate = Number(this.ex.feeRate) || 0.0005;
    const simulatedFrictionRate = this.ex.mode === 'paper'
      ? (Number(this.ex.slippageBps || 0) + Number(this.ex.spreadBps || 0)) / 10_000
      : 0;
    const roundTripCostPct = (feeRate + simulatedFrictionRate) * 2 * 100;
    const requiredCostCoveragePct = roundTripCostPct * this.config.minRoundTripCostMultiple;
    if (this.config.mode === 'neutral' && this.config.neutralRangeAdmissionEnabled
        && this.risk.spacingPct + 1e-8 < requiredCostCoveragePct) {
      throw new Error(`中性网格间距 ${this.risk.spacingPct}% 未达到预计往返执行损耗 ${round2(roundTripCostPct)}% 的 ${this.config.minRoundTripCostMultiple} 倍保护，已取消启动。`);
    } else if (this.risk.spacingPct <= roundTripCostPct) {
      this._alert(`⚠️ 网格间距 ${this.risk.spacingPct}% 不足以覆盖预计往返执行损耗（约 ${round2(roundTripCostPct)}%），每完成一格可能亏损。建议拉大间距或减少网格数。`);
    }

    const levOk = await this.ex.setLeverage(market.marketId, leverage).catch(() => false);
    if (levOk === false) {
      if (this.ex.mode === 'live') throw new Error(`Decibel 杠杆设置 ${leverage}x 未成功，已中止启动。请先在交易所网页端核实账户与市场设置。`);
      this._alert(`⚠️ 杠杆设置 ${leverage}x 未生效，将沿用交易所端该市场的当前杠杆。`);
    }
    const cancelled = await this._cancelAllTracked('启动前清理遗留挂单', market.marketId);
    if (cancelled === false && this.ex.mode === 'live') {
      throw new Error('未能确认撤销该市场的遗留挂单，已中止启动，避免重复挂单。请到 Decibel 人工核对。');
    }

    this.lastPrice = await this.ex.getPrice(market.marketId);
    if (!Number.isFinite(this.lastPrice) || this.lastPrice <= 0) {
      throw new Error('未能获取有效的最新价（行情中断），已取消启动以免错挂网格单。请稍后重试。');
    }
    if (this.lastPrice < this.config.lower * 0.5 || this.lastPrice > this.config.upper * 2) {
      throw new Error(`最新价 ${this.lastPrice} 与网格区间 [${this.config.lower}, ${this.config.upper}] 偏离过大，已取消启动。请刷新行情后重设区间。`);
    }
    this.outOfRange = this.lastPrice < this.config.lower || this.lastPrice > this.config.upper;

    await this._refreshTrendGuard(true);
    const admissionRequired = this.config.mode === 'neutral' && this.config.neutralRangeAdmissionEnabled;
    const admissionAllowed = this.strategyGuard.rangeAdmission?.allowed === true;
    if (admissionRequired && !admissionAllowed && this.ex.mode === 'live') {
      throw new Error(`当前不满足中性网格准入：${this.strategyGuard.rangeAdmission?.detail || '1D/4H 尚未共同确认宽幅震荡。'}`);
    }
    this.waitingForAdmission = admissionRequired && !admissionAllowed;

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();

    // ---- seed the ladder (every seed order is an OPENING leg) ----
    const seeds = this.waitingForAdmission
      ? []
      : seedOrders({ levels: this.grid.levels, price: this.lastPrice, mode: this.config.mode, spacing: this.grid.spacing });
    let placed = 0;
    for (const s of seeds) if (await this._place({ ...s, opening: true })) placed++;
    if (this.ex.mode === 'live' && placed !== seeds.length) {
      const rolledBack = await this._cancelAllTracked('启动失败回滚', market.marketId);
      this.active.clear();
      this._guardDeferred.clear();
      this.ex.off('fill', this._onFill);
      this.ex.off('price', this._onPrice);
      throw new Error(`初始网格仅成功挂出 ${placed}/${seeds.length} 单，已中止启动${rolledBack ? '并撤回已挂订单' : '；撤单未完全确认，请立即到 Decibel 核对'}。`);
    }

    if (this.startBalance == null && typeof this.ex.balance === 'number') this.startBalance = this.ex.balance;
    this._beginMeasurement('fresh_start');
    this.running = true;
    this._startReconcileTimer();
    this._startGuardTimer();
    this._alert(this.waitingForAdmission
      ? `已启动 ${this.config.displayName} ${labelMode(this.config.mode)}，当前等待震荡准入，暂不挂单：${this.strategyGuard.rangeAdmission?.detail || '大周期尚未共同确认震荡。'}`
      : `已启动 ${this.config.displayName} ${labelMode(this.config.mode)}，${this.grid.count} 格，间距 ${this.grid.spacing}（${this.risk.spacingPct}%），杠杆 ${leverage}x，挂出 ${this.active.size} 单。`);
    this._changed();
    return this.getState();
  }

  async stop({ closePosition = true } = {}) {
    this._stopReconcileTimer();
    this._stopGuardTimer();
    if (!this.running) {
      if (this.config) {
        const cancelled = await this._cancelAllTracked('停止并平仓');
        if (cancelled !== false) this._exchangeOpenOrders = 0;
        if (closePosition && typeof this.ex.closePosition === 'function') {
          await this._closeWithConfirm(this.config.marketId);
        }
        this._alert('已尝试撤销该市场的所有挂单并平仓。');
      }
      this.active.clear();
      this._guardDeferred.clear();
      this.waitingForAdmission = false;
      this._retryQueue = [];
      this._changed();
      return this.getState();
    }
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    const cancelled = await this._cancelAllTracked(closePosition ? '停止并平仓' : '停止网格');
    if (cancelled !== false) this._exchangeOpenOrders = 0;
    if (cancelled === false) this._alert('❌ 未能确认撤销全部挂单，请立即到交易所人工核对。');
    this.active.clear();
    this._guardDeferred.clear();
    let closeRequested = false;
    if (closePosition && typeof this.ex.closePosition === 'function') {
      await this._closeWithConfirm(this.config.marketId);
      closeRequested = true;
    }
    this.running = false;
    this.waitingForAdmission = false;
    this.recovery = false;
    this._retryQueue = [];
    this._alert(closeRequested
      ? '机器人已停止：挂单已撤销，已发送平仓指令（请在交易所确认仓位已平）。'
      : '机器人已停止，挂单已撤销（未平仓）。');
    this._changed();
    return this.getState();
  }

  /**
   * One-click: cancel ALL resting orders for this market WITHOUT touching the
   * open POSITION. Also stops the grid (running=false) and detaches handlers so
   * no later automated action (fill replacements / auto-stop) can affect the
   * position afterwards. To resume trading, start the grid again.
   */
  async cancelAllOrders() {
    if (!this.config) throw new Error('尚未配置市场，没有可撤的挂单。');
    this._stopReconcileTimer();
    this._stopGuardTimer();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    const cancelled = await this._cancelAllTracked('一键撤销挂单');
    if (cancelled !== false) this._exchangeOpenOrders = 0;
    this.active.clear();
    this._guardDeferred.clear();
    this.running = false;
    this.waitingForAdmission = false;
    this._refillPausedUntil = 0; this._cancelTimes = []; this._retryQueue = [];
    this._alert(cancelled === false
      ? '❌ 撤单未完全确认，自动网格已停止，持仓保留。请立即到交易所人工核对剩余挂单。'
      : '已一键撤销该市场全部挂单（持仓保留、未平仓）。网格已停止，如需继续请重新启动。');
    this._changed();
    return this.getState();
  }

  /**
   * Adjust the grid's price range WITHOUT stopping. Margin is re-checked against
   * the new range; if it passes, current orders are cancelled and the ladder is
   * re-seeded around the live price. The open POSITION is left untouched.
   */
  async adjustRange({ lower, upper, gridCount, sizeBase, leverage, measurementReason = 'range_adjustment' }) {
    if (!this.running || !this.config) throw new Error('网格未在运行，无法调整区间。');
    const lo = Number(lower), hi = Number(upper);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) throw new Error('上边界必须大于下边界。');
    const price = this.lastPrice;
    if (Number.isFinite(price) && (price < lo * 0.5 || price > hi * 2)) {
      throw new Error(`新区间 [${lo}, ${hi}] 与当前价 ${round2(price)} 偏离过大，已取消调整。`);
    }
    const nextGridCount = gridCount == null ? this.config.gridCount : Number(gridCount);
    const nextSizeBase = sizeBase == null ? this.config.sizeBase : Number(sizeBase);
    const nextLeverage = leverage == null ? this.config.leverage : Number(leverage);
    if (!(nextSizeBase > 0)) throw new Error('每格数量必须大于 0。');
    if (!(nextLeverage >= 1)) throw new Error('杠杆必须至少为 1x。');
    const newGrid = buildGrid({ lower: lo, upper: hi, gridCount: nextGridCount });
    const mid = (lo + hi) / 2;
    const notional = newGrid.levels.length * nextSizeBase * mid;
    const requiredMargin = notional / nextLeverage;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null && requiredMargin > available) {
      throw new Error(`保证金不足以支持新区间：约需 ${round2(requiredMargin)} USDC，当前可用 ${round2(available)} USDC。请缩小区间/减少格数后再试。`);
    }

    if (nextLeverage !== this.config.leverage) {
      const leverageOk = await this.ex.setLeverage(this.config.marketId, nextLeverage).catch(() => false);
      if (leverageOk === false && this.ex.mode === 'live') throw new Error(`Decibel 杠杆设置 ${nextLeverage}x 未成功，已取消参数更新。`);
      if (leverageOk === false) this._alert(`⚠️ 杠杆设置 ${nextLeverage}x 未生效，将沿用交易所端当前杠杆。`);
    }

    const cancelled = await this._cancelAllTracked('自动参数更新撤销旧挂单');
    if (cancelled === false) {
      throw new Error('未能确认撤销旧区间挂单，已取消调整，避免新旧网格叠加。请到 Decibel 核对。');
    }
    this.active.clear();
    this._guardDeferred.clear();
    this._refillPausedUntil = 0; this._cancelTimes = []; // user re-set the range: clear back-off
    this.config = {
      ...this.config,
      lower: lo,
      upper: hi,
      gridCount: nextGridCount,
      sizeBase: nextSizeBase,
      leverage: nextLeverage,
    };
    this.grid = newGrid;
    this._recomputeRisk();
    this.outOfRange = Number.isFinite(price) ? (price < lo || price > hi) : false;
    if (!this.waitingForAdmission && !this.outOfRange && Number.isFinite(price) && price > 0) {
      const seeds = seedOrders({ levels: newGrid.levels, price, mode: this.config.mode, spacing: newGrid.spacing });
      let placed = 0;
      for (const s of seeds) if (await this._place({ ...s, opening: true })) placed++;
      if (placed !== seeds.length) {
        const rolledBack = await this._cancelAllTracked('区间调整失败回滚');
        this.active.clear();
        this._guardDeferred.clear();
        this.running = false;
        this.ex.off('fill', this._onFill);
        this.ex.off('price', this._onPrice);
        this._stopReconcileTimer();
        this._stopGuardTimer();
        this._changed();
        throw new Error(`新区间仅成功挂出 ${placed}/${seeds.length} 单，网格已停止、持仓保留${rolledBack ? '' : '；撤单未完全确认，请立即到 Decibel 核对'}。`);
      }
    }
    this._beginMeasurement(measurementReason);
    this._alert(this.waitingForAdmission
      ? `已更新等待准入参数：[${lo}, ${hi}]，${newGrid.count} 格，每格 ${round6(nextSizeBase)}，${nextLeverage}x；条件满足前继续保持零挂单。`
      : `已更新策略参数：[${lo}, ${hi}]，${newGrid.count} 格，每格 ${round6(nextSizeBase)}，${nextLeverage}x，重新挂出 ${this.active.size} 单（持仓保留）。`);
    this._changed();
    return this.getState();
  }

  /** Zero cumulative stats and re-baseline PnL to the current equity. */
  resetStats() {
    this._beginMeasurement('manual_reset');
    this._alert('已开始新的统计周期：盈亏、执行成本、成交额和完成格数均以当前状态为新基准。');
    this._changed();
    return this.getState();
  }

  /** Adjust an idle PAPER account without counting the cash flow as strategy PnL. */
  setPaperEquity(amount) {
    if (this.ex.mode !== 'paper') throw new Error('只有 PAPER 模拟盘可以调整账户权益。');
    if (this.running) throw new Error('网格运行中不能调整模拟账户权益。');
    if (this.recovery) throw new Error('恢复流程进行中不能调整模拟账户权益。');
    if (this.active.size > 0) throw new Error('仍有机器人挂单，不能调整模拟账户权益。');
    if (typeof this.ex.setAccountEquity !== 'function') throw new Error('当前模拟交易所不支持调整账户权益。');

    const completedMeasurement = this.measurement ? {
      ...this.measurement,
      endedAt: Date.now(),
      results: this._measurementResults(),
    } : null;
    const adjustment = this.ex.setAccountEquity(amount);
    if (completedMeasurement) {
      this.measurementHistory.unshift(completedMeasurement);
      if (this.measurementHistory.length > 12) this.measurementHistory.length = 12;
    }
    this.measurement = null;
    this._beginMeasurement('paper_equity_adjustment');
    this._alert(`模拟账户权益已由 ${round2(adjustment.previousEquity)} 调整为 ${round2(adjustment.equity)} USDC，策略盈亏已重新设为零基线。`);
    this._changed();
    return this.getState();
  }

  _restoreMeasurement(snap) {
    this._unrealizedBase = Number(snap.unrealizedBase) || 0;
    this._costBase = normalizeCosts(snap.costBase);
    this.measurement = snap.measurement && typeof snap.measurement === 'object' ? snap.measurement : null;
    this.measurementHistory = Array.isArray(snap.measurementHistory) ? snap.measurementHistory.slice(0, 12) : [];
    this._measurementSeq = Number(snap.measurementSeq) || 0;
    this.strategyGuard = { ...defaultGuardState(), ...(snap.strategyGuard || {}) };
    this._guardDeferred = new Map(Array.isArray(snap.guardDeferred) ? snap.guardDeferred : []);
  }

  _beginMeasurement(reason) {
    if (this.measurement) {
      this.measurementHistory.unshift({
        ...this.measurement,
        endedAt: Date.now(),
        results: this._measurementResults(),
      });
      if (this.measurementHistory.length > 12) this.measurementHistory.length = 12;
    }
    const position = this.ex.getPosition?.(this.config?.marketId);
    const rawUnrealized = Number(position?.unrealizedPnl) || 0;
    const rawRealized = typeof this.ex.realizedPnl === 'number' ? this.ex.realizedPnl : null;
    const costs = this._executionCostsRaw();
    const equity = this._currentEquity(rawUnrealized);
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.fills = [];
    this._placeFails = 0;
    this._lastFailAt = 0;
    this._refillPausedUntil = 0;
    this._cancelTimes = [];
    this._pnlBase = rawRealized;
    this._unrealizedBase = rawUnrealized;
    this._costBase = costs;
    this.startBalance = equity;
    const sequence = ++this._measurementSeq;
    this.measurement = {
      id: `${this.ex.mode || 'grid'}-${Date.now()}-${sequence}`,
      sequence,
      parameterVersion: `v${sequence}`,
      startedAt: Date.now(),
      reason,
      baselineEquity: round2(equity),
      baselineRealizedPnl: rawRealized == null ? null : round2(rawRealized),
      baselineUnrealizedPnl: round2(rawUnrealized),
      baselineExecutionCosts: costs,
      params: parameterSnapshot(this.config),
    };
  }

  _measurementResults() {
    const position = this.ex.getPosition?.(this.config?.marketId);
    const currentUnrealized = Number(position?.unrealizedPnl) || 0;
    const unrealized = currentUnrealized - (this._unrealizedBase || 0);
    const currentEquity = this._currentEquity(currentUnrealized);
    const realized = typeof this.ex.realizedPnl === 'number'
      ? this.ex.realizedPnl - (this._pnlBase ?? 0)
      : (currentEquity != null && this.measurement?.baselineEquity != null)
        ? (currentEquity - this.measurement.baselineEquity) - unrealized
        : this.stats.gridProfit;
    return {
      realizedPnl: round2(realized),
      unrealizedPnl: round2(unrealized),
      totalPnl: round2(realized + unrealized),
      executionCosts: subtractCosts(this._executionCostsRaw(), this._costBase),
      stats: { ...this.stats },
    };
  }

  _executionCostsRaw() {
    if (typeof this.ex.getExecutionCosts === 'function') return normalizeCosts(this.ex.getExecutionCosts());
    return normalizeCosts(this.ex.executionCosts);
  }

  _currentEquity(unrealized = null) {
    if (typeof this.ex.equity === 'number') return this.ex.equity;
    const balance = typeof this.ex.balance === 'number' ? this.ex.balance : null;
    const upnl = unrealized == null
      ? Number(this.ex.getPosition?.(this.config?.marketId)?.unrealizedPnl) || 0
      : Number(unrealized) || 0;
    return balance == null ? null : balance + upnl;
  }

  async _refreshTrendGuard(force = false) {
    if (!this.config || this.recovery) return this.strategyGuard;
    const needsAdmission = this.config.mode === 'neutral' && this.config.neutralRangeAdmissionEnabled;
    if (!this.config.trendGuardEnabled && !needsAdmission) {
      this.strategyGuard = {
        ...this.strategyGuard,
        enabled: false,
        trend: 'range',
        strength: 0,
        reason: 'disabled',
        rangeAdmission: { enabled: false, allowed: true, reason: 'disabled', detail: '中性准入未开启。' },
      };
      return this.strategyGuard;
    }
    const refreshMs = this.config.trendGuardRefreshMs || STRATEGY_GUARD_DEFAULTS.trendGuardRefreshMs;
    if (!force && Date.now() - Number(this.strategyGuard.checkedAt || 0) < refreshMs) return this.strategyGuard;
    if (this._guardRefreshInFlight) return this._guardRefreshInFlight;
    this._guardRefreshInFlight = (async () => {
      try {
        let admission = { enabled: false, allowed: true, reason: 'not_required', detail: '当前方向不需要中性准入。' };
        let analysis;
        if (needsAdmission) {
          admission = await readNeutralRangeAdmission({
            exchange: this.ex,
            marketId: this.config.marketId,
            currentAllowed: this.strategyGuard.rangeAdmission?.allowed === true,
            minAtrPct: this.config.rangeAdmissionMinAtrPct,
            trendStrength: this.config.trendGuardMinStrength,
          });
          analysis = admission.frames?.h1 || { trend: 'range', strength: 0, detail: admission.detail };
        } else {
          const candles = await this.ex.getCandles(this.config.marketId, 3600, 200);
          const synthetic = this.ex.candleDataSource === 'synthetic';
          analysis = synthetic
            ? { trend: 'range', strength: 0, detail: '真实 K 线不可用，趋势保护保持中性。' }
            : analyzeTrend(Array.isArray(candles) ? candles : []);
        }
        this.strategyGuard = {
          ...this.strategyGuard,
          enabled: this.config.trendGuardEnabled,
          trend: analysis.trend || 'range',
          strength: Number(analysis.strength) || 0,
          minStrength: this.config.trendGuardMinStrength,
          checkedAt: Date.now(),
          dataSource: needsAdmission ? admission.sources : (this.ex.candleDataSource || this.ex.dataSource || null),
          reason: analysis.detail || null,
          error: null,
          rangeAdmission: admission,
        };
        if (this.running) this._scheduleGuardSync();
      } catch (error) {
        this.strategyGuard = {
          ...this.strategyGuard,
          enabled: true,
          checkedAt: Date.now(),
          error: error?.message || String(error),
          rangeAdmission: needsAdmission
            ? { enabled: true, allowed: false, reason: 'data_unavailable', detail: '大周期行情读取失败，暂停中性开仓。' }
            : this.strategyGuard.rangeAdmission,
        };
        if (this.running) this._scheduleGuardSync();
      } finally {
        this._guardRefreshInFlight = null;
      }
      return this.strategyGuard;
    })();
    return this._guardRefreshInFlight;
  }

  _startGuardTimer() {
    const needsAdmission = this.config?.mode === 'neutral' && this.config?.neutralRangeAdmissionEnabled;
    if (this._guardTimer || (!this.config?.trendGuardEnabled && !needsAdmission)) return;
    const interval = this.config.trendGuardRefreshMs || STRATEGY_GUARD_DEFAULTS.trendGuardRefreshMs;
    this._guardTimer = setInterval(() => this._refreshTrendGuard(true).catch(() => {}), interval);
    this._guardTimer.unref?.();
  }

  _stopGuardTimer() {
    if (this._guardTimer) { clearInterval(this._guardTimer); this._guardTimer = null; }
  }

  _orderDecision(order, { forceReduceOnly = false } = {}) {
    const position = this.ex.getPosition?.(this.config.marketId);
    const price = Number(this.lastPrice || order.price);
    return inventoryOrderDecision({
      side: order.side,
      sizeBase: order.sizeBase ?? this.config.sizeBase,
      positionSize: Number(position?.sizeBase) || 0,
      price,
      equity: this._currentEquity(position?.unrealizedPnl),
      maxDirectionalNotionalPct: this.config.maxDirectionalNotionalPct,
      forceReduceOnly,
      trendGuardEnabled: this.config.trendGuardEnabled,
      trend: this.strategyGuard.trend,
      trendStrength: this.strategyGuard.strength,
      trendGuardMinStrength: this.config.trendGuardMinStrength,
      mode: this.config.mode,
      rangeAdmissionEnabled: this.config.neutralRangeAdmissionEnabled,
      rangeAdmissionAllowed: this.strategyGuard.rangeAdmission?.allowed === true,
      inventorySkewEnabled: this.config.inventorySkewEnabled,
      inventorySkewStartPctOfCap: this.config.inventorySkewStartPctOfCap,
      inventorySkewMinScale: this.config.inventorySkewMinScale,
      stepSize: this.config.stepSize,
      minOrderSize: this.config.minOrderSize,
    });
  }

  _scheduleGuardSync() {
    this._guardSync = this._guardSync.then(() => this._enforceStrategyGuards()).catch(() => {});
  }

  async _enforceStrategyGuards() {
    if (!this.running || !this.config || this.recovery) return;
    if (this.waitingForAdmission) {
      await this._enterAfterAdmission();
      return;
    }
    const replacements = [];
    for (const [id, info] of [...this.active]) {
      if (info.recovery || (!info.opening && !info.inventoryManaged)) continue;
      const managedSize = info.inventoryManaged
        ? (Number(info.managedOpeningSize) || Number(info.sizeBase))
        : Number(info.sizeBase);
      const decision = this._orderDecision({ ...info, sizeBase: managedSize });
      const desiredOpening = decision.allowed ? decision.opening : null;
      const alreadyClassified = decision.allowed
        && info.opening === desiredOpening
        && Boolean(info.reduceOnly) === Boolean(decision.reduceOnly)
        && Math.abs(Number(info.sizeBase) - Number(decision.sizeBase)) < Math.max(1e-12, Number(this.config.stepSize) / 2 || 1e-12);
      if (alreadyClassified) continue;
      try {
        await this.ex.cancelOrder?.(this.config.marketId, id);
        this.active.delete(id);
        this._activity(formatCancelActivity(info, id, decision.allowed ? '库存保护重分类' : '策略保护撤单'), 'cancel');
      } catch { continue; }
      if (decision.allowed) {
        replacements.push({
          ...info,
          sizeBase: decision.sizeBase,
          opening: decision.opening,
          reduceOnly: decision.reduceOnly,
          inventoryManaged: true,
          managedOpeningSize: managedSize,
        });
      } else {
        if (info.levelIndex != null) {
          this._guardDeferred.set(info.levelIndex, {
            levelIndex: info.levelIndex,
            side: info.side,
            price: info.price,
            sizeBase: managedSize || this.config.sizeBase,
            opening: true,
          });
        }
        this._recordGuardBlock(decision, info);
      }
    }
    for (const order of replacements) await this._place(order);
    let resumed = 0;
    for (const [levelIndex, order] of [...this._guardDeferred]) {
      if ([...this.active.values()].some((active) => active.levelIndex === levelIndex)) continue;
      const decision = this._orderDecision(order);
      if (!decision.allowed) continue;
      if (decision.opening && !isPassiveOpeningOrder({
        side: order.side,
        price: order.price,
        marketPrice: this.lastPrice,
      })) continue;
      this._guardDeferred.delete(levelIndex);
      await this._place({
        ...order,
        sizeBase: decision.sizeBase,
        opening: decision.opening,
        reduceOnly: decision.reduceOnly,
        inventoryManaged: !decision.opening,
        managedOpeningSize: order.sizeBase,
      });
      resumed++;
    }
    if (replacements.length || resumed) this._changed();
  }

  async _enterAfterAdmission() {
    if (!this.waitingForAdmission || this.strategyGuard.rangeAdmission?.allowed !== true) return false;
    const price = Number(this.lastPrice);
    if (!(price > 0)) return false;
    this.outOfRange = price < this.config.lower || price > this.config.upper;
    if (this.outOfRange) return false;

    const seeds = seedOrders({ levels: this.grid.levels, price, mode: this.config.mode, spacing: this.grid.spacing });
    let placed = 0;
    for (const seed of seeds) if (await this._place({ ...seed, opening: true })) placed++;
    if (placed !== seeds.length) {
      await this._cancelAllTracked('准入后初始挂单失败回滚');
      this.active.clear();
      this._guardDeferred.clear();
      this._alert(`震荡准入已满足，但初始网格仅处理 ${placed}/${seeds.length} 单，将保持等待并在下次检查时重试。`);
      this._changed();
      return false;
    }
    this.waitingForAdmission = false;
    this._alert(`震荡准入已满足，区间平衡自动入场，挂出 ${this.active.size} 个被动限价单。`);
    this._changed();
    return true;
  }

  _recordGuardBlock(decision, order) {
    const key = `${decision.side}:${decision.reason}`;
    const now = Date.now();
    if (now - Number(this._guardBlockAt.get(key) || 0) < 30_000) return;
    this._guardBlockAt.set(key, now);
    const level = order?.levelIndex == null ? '' : ` · 网格 ${order.levelIndex}`;
    this._alert(`策略保护：${guardReasonText(decision.reason)}，未新增${decision.side === 'buy' ? '多' : '空'}头${level}。`);
  }

  _recomputeRisk() {
    if (!this.grid || !this.config) return;
    const mid = (this.config.lower + this.config.upper) / 2;
    const notional = this.grid.levels.length * this.config.sizeBase * mid;
    this.risk = {
      leverage: this.config.leverage,
      notional: round2(notional),
      requiredMargin: round2(notional / this.config.leverage),
      perRungProfit: round2(this.grid.spacing * this.config.sizeBase),
      spacingPct: round2((this.grid.spacing / mid) * 100),
    };
  }

  async _place(o) {
    const requestedOpening = o.opening !== false;
    const requestedSize = Number(o.sizeBase) > 0 ? Number(o.sizeBase) : this.config.sizeBase;
    const managedOpeningSize = Number(o.managedOpeningSize) > 0 ? Number(o.managedOpeningSize) : requestedSize;
    const explicitExit = !!o.recovery || o.opening === false || o.reduceOnly === true || isReduceOnly(o.side, this.config.mode);
    let decision = this._orderDecision({ ...o, sizeBase: requestedSize }, { forceReduceOnly: explicitExit });
    if (!decision.allowed) {
      if (!o.recovery && requestedOpening && o.levelIndex != null) {
        this._guardDeferred.set(o.levelIndex, {
          levelIndex: o.levelIndex,
          side: o.side,
          price: o.price,
          sizeBase: requestedSize,
          opening: true,
        });
      }
      this._recordGuardBlock(decision, o);
      return true;
    }
    let opening = decision.opening;
    let reduceOnly = decision.reduceOnly;
    let sizeBase = decision.sizeBase;
    // Back-off: while paused (after a burst of cancellations / collateral
    // rejections) do not place new OPENING orders. CLOSING / reduce-only /
    // recovery legs need no extra margin and are never blocked — dropping a
    // take-profit leg would strand its inventory without an exit order.
    if (opening && !o.recovery && this._refillPausedUntil && Date.now() < this._refillPausedUntil) return true;
    // INVARIANT: at most ONE resting order per grid level. If this level is
    // already covered (or a placement for it is in flight), skip. Stacking a
    // second order on an occupied level is exactly what made the open-order
    // count creep up over time (replacement-one-rung-away colliding with the
    // order already resting there).
    const lvl = o.levelIndex;
    if (this._pendingLevels.has(lvl)) return true;
    const occupied = [...this.active.entries()].find(([, active]) => active.levelIndex === lvl);
    if (occupied) {
      const [occupiedId, active] = occupied;
      // Multiple partial fills can generate exits at the same rung. Merge those
      // reduce-only quantities into one order so the one-order-per-level
      // invariant remains intact and every partial fill still has an exit.
      if (!opening && active.opening === false && active.side === o.side && !active.recovery && !o.recovery) {
        try {
          await this.ex.cancelOrder?.(this.config.marketId, occupiedId);
          this.active.delete(occupiedId);
          this._activity(formatCancelActivity(active, occupiedId, '合并部分成交退出单'), 'cancel');
          sizeBase += Number(active.sizeBase) || 0;
          decision = this._orderDecision({ ...o, sizeBase }, { forceReduceOnly: true });
          sizeBase = decision.sizeBase;
          opening = false;
          reduceOnly = true;
        } catch { return true; }
      } else {
        return true;
      }
    }
    this._pendingLevels.add(lvl);
    const seq = (++this._coidSeq) % 1_000_000;
    const clientOrderId = Number(`${Date.now() % 1_000_000_0}${String(seq).padStart(6, '0')}`);
    try {
      const r = await this.ex.placeLimitOrder({
        marketId: this.config.marketId, side: o.side, price: o.price,
        sizeBase, reduceOnly,
        levelIndex: o.levelIndex, clientOrderId,
      }).catch((e) => {
        this._placeFails++; this._lastFailAt = Date.now();
        this._alert('下单失败: ' + e.message);
        this._queueRetry({ ...o, opening, reduceOnly, sizeBase }); // closing legs get retried
        return null;
      });
      if (r?.orderId) {
        const orderId = String(r.orderId);
        const placedPrice = Number(r.price ?? o.price);
        const placedSize = Number(r.sizeBase ?? sizeBase);
        const inventoryManaged = !!o.inventoryManaged || (requestedOpening && !opening) || decision.inventorySkewApplied === true;
        this.active.set(orderId, {
          levelIndex: lvl,
          side: o.side,
          price: placedPrice,
          sizeBase: placedSize,
          opening,
          reduceOnly,
          inventoryManaged,
          managedOpeningSize: inventoryManaged ? managedOpeningSize : null,
          recovery: !!o.recovery,
          clientOrderId,
          placedAt: Date.now(),
        });
        const purpose = o.recovery ? '回收' : (opening ? '开仓' : '补挂平仓');
        this._activity(`${purpose}挂单 · ${sideName(o.side)} ${round6(placedSize)} @ ${round2(placedPrice)} · 网格 ${lvl} · #${orderId}`, 'order');
        this._changed();
        return true;
      }
      return false;
    } finally {
      this._pendingLevels.delete(lvl);
    }
  }

  /**
   * Queue a CLOSING / reduce-only order for retry after a failed placement.
   * Only closing legs are retried — they can never ADD inventory, so retrying is
   * always safe; silently dropping one (the old behavior) left inventory without
   * its take-profit order forever, since replacements are only quoted on fills.
   */
  _queueRetry(o) {
    if (o.opening !== false && !o.reduceOnly && !o.recovery) return; // opening legs: by design not retried
    const tries = (o._tries || 0) + 1;
    if (tries > 5) {
      this._alert(`❌ 补挂平仓单（level ${o.levelIndex} @ ${o.price}）连续 ${tries - 1} 次失败，已放弃。请到交易所核实并手动挂单。`);
      return;
    }
    this._retryQueue.push({ ...o, _tries: tries, _nextAt: Date.now() + 5000 * tries }); // linear back-off
  }

  /** Retry due closing-leg placements (driven by price ticks + reconcile timer). */
  _drainRetryQueue() {
    if (!this.running || !this._retryQueue.length) return;
    const now = Date.now();
    const due = [];
    this._retryQueue = this._retryQueue.filter((o) => (o._nextAt <= now ? (due.push(o), false) : true));
    for (const o of due) this._place(o); // _place re-queues on failure with tries+1
  }

  _handleFill(f) {
    if (!this.running || f.marketId !== this.config.marketId) return;
    const id = String(f.orderId);
    const act = this.active.get(id);
    const remainingSize = Number(f.remainingSize) > 1e-12 ? Number(f.remainingSize) : 0;
    if (remainingSize > 0 && act) {
      act.sizeBase = remainingSize;
      if (act.inventoryManaged) act.managedOpeningSize = remainingSize;
      act.placedAt = Date.now();
    } else {
      this.active.delete(id);
    }
    const levelIndex = act?.levelIndex ?? f.levelIndex;
    const fillPrice = Number.isFinite(f.price) ? f.price : (act?.price ?? 0);
    const fillSize = Number.isFinite(f.sizeBase) ? f.sizeBase : this.config.sizeBase;

    if (f.side === 'buy') this.stats.buys++; else this.stats.sells++;
    this.stats.volume = round2(this.stats.volume + fillPrice * fillSize);
    this.fills.unshift({
      t: Date.now(), side: f.side, price: fillPrice, size: fillSize,
      level: levelIndex, partial: remainingSize > 0, costs: f.costs || null,
    });
    if (this.fills.length > 50) this.fills.pop();
    this._activity(`订单成交 · ${sideName(f.side)} ${round6(fillSize)} @ ${round2(fillPrice)} · 网格 ${levelIndex} · #${id}`, 'fill');

    const isRecovery = !!(act && act.recovery);
    const closing = isRecovery ? true
      : (act ? act.opening === false
             : ((this.config.mode === 'short') ? f.side === 'buy' : f.side === 'sell'));
    if (closing) {
      this.stats.completedRungs++;
      // Incremental accumulation with the ACTUAL fill size: adjustRange no longer
      // rewrites history (the old code recomputed rungs × CURRENT spacing), and
      // partial fills are credited with what really executed.
      const sp = this.grid?.spacing ?? this.config.spacing ?? 0;
      this.stats.gridProfit = round2(this.stats.gridProfit + sp * fillSize);
    }

    // Recovery-ladder fills are pure reduce-only EXITS of stranded inventory —
    // never re-quote a replacement for them.
    if (!isRecovery && this.grid) {
      const repl = replacementFor({ side: f.side, levelIndex }, this.grid.levels, this.config.mode);
      if (repl && !this.outOfRange && this.running) {
        repl.opening = closing; // replacement is the opposite leg
        if (fillSize > 0) repl.sizeBase = fillSize; // partial fill: mirror the actually-filled qty
        this._place(repl).finally(() => this._scheduleGuardSync());
      }
    }
    this._scheduleGuardSync();
    this._changed();
  }

  _handlePrice(p) {
    if (p.marketId !== this.config.marketId) return;
    this.lastPrice = p.price;
    this._drainRetryQueue();
    this._refreshTrendGuard(false).catch(() => {});
    this._scheduleGuardSync();
    if (this.recovery) { this._manageRecoveryStandalone(); return; }
    const out = p.price < this.config.lower || p.price > this.config.upper;
    if (this.waitingForAdmission) {
      if (out !== this.outOfRange) {
        this.outOfRange = out;
        this._alert(out
          ? `等待准入期间价格已离开当前区间（${round2(p.price)}），策略继续运行并等待小时参数引擎更新区间，不执行平仓。`
          : `等待准入期间价格已回到区间内（${round2(p.price)}），准入满足后将自动挂单。`);
        this._changed();
      }
      return;
    }
    const action = this.config.outOfRangeAction || 'close';
    if (out && !this.outOfRange) {
      this.outOfRange = true;
      const where = p.price < this.config.lower ? '跌破下边界' : '突破上边界';
      if (action === 'recover') {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），启用「只减仓回收阶梯」：暂停补单，挂出 reduce-only 单等回调分批减仓（只减不加、不自动止损，请自行控制风险）。`);
        this._placeRecoveryLadder();
      } else {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），触发「冲破区间平仓」：撤单 + 平仓 + 停止。`);
        if (!this._stopping) {
          this._stopping = true;
          this.stop({ closePosition: true }).finally(() => { this._stopping = false; });
        }
      }
    } else if (out && this.outOfRange && action === 'recover') {
      this._placeRecoveryLadder(); // extend the ladder as price makes new extremes (dedup keeps it idempotent)
    } else if (!out && this.outOfRange) {
      this.outOfRange = false;
      this._cancelRecoveryLadder();
      this._alert(`价格回到区间内（${round2(p.price)}），撤销回收阶梯，恢复正常网格运行。`);
    }
  }

  /**
   * 只减仓回收阶梯：价格冲出区间后，在「现价 ↔ 被冲破的边界」之间挂一批 reduce-only
   * 单。价格每回调一档就分批了结被套住的库存。reduce-only 保证「只减不加」（永远不会
   * 把套牢的仓位越加越大）；本策略不自动止损 —— 趋势继续单边延续会一直扛着。
   */
  _placeRecoveryLadder() {
    if (!this.running || !this.outOfRange || !this.grid) return;
    if ((this.config.outOfRangeAction || 'close') !== 'recover') return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) return; // 没有可减的持仓
    const sp = this.grid.spacing, lvl0 = this.grid.levels[0];
    const L = this.config.lower, U = this.config.upper;
    const long = pos.sizeBase > 0;
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    const maxRungs = this.grid.count;
    let placed = 0;
    const room = () => existing.size + placed < maxRungs;
    if (long && price < L) {
      // 跌破下边界、手里是多头：在「现价 ↔ 下边界」之间挂 reduce-only 卖单
      for (let lv = L - sp; lv > price && room(); lv -= sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else if (!long && price > U) {
      // 突破上边界、手里是空头：在「上边界 ↔ 现价」之间挂 reduce-only 买单
      for (let lv = U + sp; lv < price && room(); lv += sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) {
      this._alert(`回收阶梯：新挂 ${placed} 个 reduce-only ${long ? '卖' : '买'}单，等回调分批减仓。`);
      this._changed();
    }
  }

  /** Cancel all recovery-ladder orders (when price returns into range). */
  async _cancelRecoveryLadder() {
    const ids = [...this.active].filter(([, o]) => o.recovery).map(([id]) => id);
    if (!ids.length) return;
    for (const id of ids) {
      const info = this.active.get(id);
      try {
        await this.ex.cancelOrder?.(this.config.marketId, id);
        this.active.delete(id);
        this._activity(formatCancelActivity(info, id, '撤销回收阶梯'), 'cancel');
      } catch { /* leave it tracked so reconciliation can retry */ }
    }
    this._alert(`已撤销 ${ids.length} 个回收阶梯挂单。`);
    this._changed();
  }

  // ============ 未托管持仓处置（开机扫描后手动选择）============

  /**
   * 只减仓回收阶梯（独立模式）：对一笔已存在的持仓，挂 reduce-only 单在反弹时分批
   * 减仓；只减不加、不需要新保证金、不自动止损。不需要完整网格。
   */
  async startRecovery(cfg) {
    if (this.running || this._starting) throw new Error('已在运行，请先停止再操作。');
    this._starting = true;
    try {
      const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
      if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);
      const pos = this.ex.getPosition?.(market.marketId);
      if (!pos || !pos.sizeBase) throw new Error('该市场当前没有持仓，无需回收。');
      const price = await this.ex.getPrice(market.marketId);
      if (!Number.isFinite(price) || price <= 0) throw new Error('未能获取有效最新价，请稍后重试。');
      // 阶梯间距：入参 -> 上次网格间距 -> 现价的 0.15%
      let spacing = Number(cfg.spacing) || this.config?.spacing || this.grid?.spacing;
      if (!(spacing > 0)) spacing = Math.max(market.stepPrice || 0.1, price * 0.0015);
      // 每档减仓量：入参 -> 上次每格量 -> 持仓量/20
      let sizeBase = Number(cfg.sizeBase) || this.config?.sizeBase || (Math.abs(pos.sizeBase) / 20);
      sizeBase = Math.max(sizeBase, market.minOrderSize || 0);
      this.config = {
        marketId: market.marketId, displayName: market.displayName, mode: 'recovery',
        sizeBase, spacing, stepSize: market.stepSize, stepPrice: market.stepPrice,
        lower: null, upper: null, gridCount: null, leverage: pos.leverage ?? null,
        outOfRangeAction: 'recover',
        aboveEntryOnly: !!cfg.aboveEntryOnly, // 只在成本价上方(多)/下方(空)、即不亏的价位才挂减仓单
      };
      this.grid = null; this.risk = null;
      this._stopGuardTimer();
      this.recovery = true; this.outOfRange = false; this.lastPrice = price;
      this._noPosStreak = 0; this._retryQueue = [];
      this.active.clear();
      this._guardDeferred.clear();
      if (this.startBalance == null) {
        this.startBalance = typeof this.ex.equity === 'number' ? this.ex.equity
          : typeof this.ex.balance === 'number' ? this.ex.balance : null;
      }
      this.ex.on('fill', this._onFill);
      this.ex.on('price', this._onPrice);
      if (typeof this.ex.start === 'function') this.ex.start();
      this._beginMeasurement('recovery_start');
      this.running = true;
      const dir = pos.sizeBase > 0 ? '多' : '空';
      const modeTxt = this.config.aboveEntryOnly ? '仅在成本价以上(不亏)分批减仓' : '任何反弹都分批减仓';
      this._alert(`已对 ${market.displayName} 的${dir}头 ${Math.abs(round6(pos.sizeBase))} 启用「只减仓回收阶梯」：${modeTxt}（只减不加、不自动止损，请自行控制风险）。`);
      // Seed against any orders ALREADY resting on the exchange (e.g. left over from
      // a prior recovery session) so we adopt/dedup them instead of stacking a whole
      // new ladder on top — the cause of the runaway open-order count.
      this._recoveryOccupied = new Set();
      await this.reconcileOpenOrders().catch(() => {});
      this._manageRecoveryStandalone();
      this._startReconcileTimer(); // keep deduping/pruning the ladder while it runs
      this._changed();
      return this.getState();
    } finally { this._starting = false; }
  }

  /** 市价平仓：撤销该市场全部挂单并立即市价平掉持仓。 */
  async closePositionNow(marketId) {
    const mId = Number(marketId ?? this.config?.marketId);
    if (!Number.isFinite(mId)) throw new Error('未指定市场，无法平仓。');
    this._stopReconcileTimer();
    this._stopGuardTimer();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    const cancelled = await this._cancelAllTracked('立即平仓前撤单', mId);
    if (cancelled === false) this._alert('❌ 未能确认撤销全部挂单，仍将继续尝试平仓；请立即到交易所人工核对。');
    this.active.clear();
    this._guardDeferred.clear();
    this._retryQueue = [];
    let closed = false;
    if (typeof this.ex.closePosition === 'function') {
      await this._closeWithConfirm(mId);
      closed = true;
    }
    this.running = false; this.recovery = false;
    this._alert(closed ? '已发送市价平仓指令并撤销该市场挂单（请在交易所确认已平）。' : '已撤销挂单（该交易所不支持自动平仓）。');
    this._changed();
    return this.getState();
  }

  /**
   * Send a market close and CONFIRM the position is actually gone (polls the
   * adapter's position cache). Retries up to 3 times — an IOC close capped at a
   * worst-case price (±5%) can miss entirely when the market moves fast; each
   * retry re-prices from the latest mark. The old code fired once and hoped.
   */
  async _closeWithConfirm(marketId) {
    const mId = Number(marketId);
    if (typeof this.ex.closePosition !== 'function') return false;
    if (!this.ex.getPosition?.(mId)) { await this.ex.closePosition(mId).catch(() => {}); return true; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await this.ex.closePosition(mId); }
      catch (e) { this._alert('平仓指令发送失败: ' + (e?.message || e)); }
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { // wait for the adapter's position poll to reflect it
        await sleep(1000);
        const pos = this.ex.getPosition?.(mId);
        if (!pos || !pos.sizeBase) { this._alert('✅ 已确认仓位已平。'); return true; }
      }
      if (attempt < 3) this._alert(`⚠️ 平仓后仓位仍在（第 ${attempt} 次），按最新价重试市价平仓…`);
    }
    this._alert('❌ 已尝试 3 次平仓但仓位仍未平掉，请立即到交易所手动处理！');
    return false;
  }

  /** 独立回收阶梯：始终在现价的"下一档步进"处维持一排 reduce-only 退出单。 */
  _manageRecoveryStandalone() {
    if (!this.running || !this.recovery || !this.config) return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) {
      // Require several CONSECUTIVE empty observations before declaring the
      // recovery finished — a single transient empty response from the position
      // endpoint (network blip) must not tear down the whole ladder.
      if (++this._noPosStreak >= 5) this._finishRecovery();
      return;
    }
    this._noPosStreak = 0;
    const sp = this.config.spacing;
    if (!(sp > 0)) return;
    const long = pos.sizeBase > 0;
    // "只在入场价以上(不亏)减仓"：多头只在 >= 成本价挂卖，空头只在 <= 成本价挂买。
    const aboveEntry = !!this.config.aboveEntryOnly;
    const entry = Number(pos.entryPrice) || 0;
    // Rungs needed = enough to fully exit the CURRENT position (not a fixed 30).
    // As fills shrink the position, `need` shrinks too, so the ladder never
    // over-provisions. Hard ceiling guards against a pathological position/step.
    const HARD_MAX = 80;
    const perRung = this.config.sizeBase || (Math.abs(pos.sizeBase) / 20);
    const need = Math.min(HARD_MAX, Math.max(1, Math.ceil(Math.abs(pos.sizeBase) / perRung)));
    // Occupied = our tracked recovery levels UNION the exchange's real resting
    // levels (from reconcile). Using the real set means a spurious "order gone"
    // can't trick us into stacking a second order on a level that is still live.
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    for (const idx of this._recoveryOccupied) existing.add(idx);
    let placed = 0;
    if (long) {
      let lv = Math.ceil(price / sp) * sp; if (lv <= price) lv += sp;
      if (aboveEntry && entry > 0) { const eLv = Math.ceil(entry / sp) * sp; if (lv < eLv) lv = eLv; } // 不在成本价下方卖
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv += sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else {
      let lv = Math.floor(price / sp) * sp; if (lv >= price) lv -= sp;
      if (aboveEntry && entry > 0) { const eLv = Math.floor(entry / sp) * sp; if (lv > eLv) lv = eLv; } // 不在成本价上方买
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv -= sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) this._changed();
  }

  /** 持仓已减完 -> 结束回收。 */
  _finishRecovery() {
    if (!this.recovery) return;
    this.recovery = false;
    this._stopReconcileTimer();
    this._stopGuardTimer();
    this._recoveryOccupied = new Set();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    this._cancelAllTracked('回收完成撤单').catch(() => {});
    this.active.clear();
    this.running = false;
    this._alert('回收完成：持仓已全部减完，回收阶梯已停止。');
    this._changed();
  }

  /**
   * Reconcile our tracking against the exchange's REAL open orders:
   *  - prune tracked orders no longer on the book (missed fills/cancels),
   *  - refill grid levels that have no resting order on the exchange.
   * "Occupied" levels are derived from the real order prices, so this is robust
   * even when our in-memory tracking has drifted.
   */
  async reconcileOpenOrders() {
    if (!this.running || !this.config) return;
    if (typeof this.ex.fetchOpenOrders !== 'function') return;
    // Keep the adapter's price watch warm so a long-running market is never
    // pruned as "idle" (adapters drop unwatched markets after 10 min).
    this.ex.getPrice?.(this.config.marketId)?.catch?.(() => {});
    this._drainRetryQueue();
    if (this.waitingForAdmission) {
      let waitingOrders;
      try { waitingOrders = await this.ex.fetchOpenOrders(this.config.marketId); } catch { return; }
      if (!Array.isArray(waitingOrders)) return;
      this._exchangeOpenOrders = waitingOrders.length;
      if (waitingOrders.length > 0) {
        const cancelled = await this._cancelAllTracked('等待准入清理异常挂单');
        if (cancelled !== false) {
          this.active.clear();
          this._guardDeferred.clear();
          this._exchangeOpenOrders = 0;
          this._alert('等待准入期间检测到异常挂单，已全部撤销，策略继续等待。');
          this._changed();
        }
      }
      return;
    }
    const recovery = !!this.recovery;
    // Recovery has no grid: derive levels straight from price via config.spacing.
    const sp = recovery ? this.config.spacing : this.grid?.spacing;
    const lvl0 = recovery ? 0 : this.grid?.levels?.[0];
    if (!(sp > 0) || lvl0 == null) return;
    const nLevels = recovery ? Infinity : this.grid.levels.length;
    // Grid-mode recovery ladder (outOfRangeAction='recover') rests OUTSIDE the
    // grid: negative idx below the range, >= nLevels above. Widen the accepted
    // window so dedup/trim covers the ladder too (it used to be skipped, letting
    // duplicate ladder orders stack unchecked).
    const ladderPad = (!recovery && this.config.outOfRangeAction === 'recover') ? (this.grid?.count ?? 0) : 0;
    const idxLo = 0 - ladderPad, idxHi = nLevels === Infinity ? Infinity : nLevels + ladderPad;
    let real;
    try { real = await this.ex.fetchOpenOrders(this.config.marketId); } catch { return; }
    if (!Array.isArray(real)) return;
    this._exchangeOpenOrders = real.length;
    const realIds = new Set(real.map((o) => String(o.orderId)));
    const now = Date.now();

    // Guard against transient bad snapshots: an open-order endpoint can
    // been observed returning "0 orders" while dozens are really resting. An
    // all-vanished snapshot while we track many is overwhelmingly an API glitch
    // (real fills arrive via fill events anyway) — trusting it once wiped 78
    // tracked orders and orphaned them on the exchange. Skip pruning entirely on
    // such a snapshot, and in general require an order to be missing from TWO
    // consecutive reconciles before pruning it.
    const massVanish = real.length === 0 && this.active.size >= 3;
    if (massVanish && now - (this._lastVanishAlertAt || 0) > 60000) {
      this._lastVanishAlertAt = now;
      this._alert(`⚠️ 挂单对账：交易所返回 0 单但本地跟踪 ${this.active.size} 单，疑似接口异常快照，本轮不清理（等待下轮复核）。`);
    }
    let pruned = 0;
    if (!massVanish) {
      for (const [oid, info] of [...this.active]) {
        if (realIds.has(oid)) { info.goneRecon = 0; continue; }
        if (now - (info.placedAt || 0) <= PRUNE_GRACE_MS) continue;
        info.goneRecon = (info.goneRecon || 0) + 1;
        if (info.goneRecon >= 2) { this.active.delete(oid); pruned++; }
      }
    }

    // Map real orders to levels. Cancel any DUPLICATE resting order on a level so
    // we converge to one-order-per-level (the root cause of count creep). ADOPT
    // any untracked survivor into tracking — in recovery mode that's a leftover
    // ladder; in grid mode it's an order we lost track of (e.g. a bad "0 orders"
    // snapshot once wiped tracking while the orders stayed live on the exchange).
    // Adoption restores accounting AND fill handling for those orphans.
    const occupied = new Set();
    let trimmed = 0, adopted = 0;
    for (const o of real) {
      const px = Number(o.price);
      if (!Number.isFinite(px) || !(sp > 0)) continue;
      const idx = Math.round((px - lvl0) / sp);
      if (!(idx >= idxLo && idx < idxHi)) continue;
      if (!occupied.has(idx)) {
        occupied.add(idx);
        if (!this.active.has(String(o.orderId))
            && ![...this.active.values()].some((a) => a.levelIndex === idx)) { // level truly unclaimed
          const side = o.side === 'buy' ? 'buy' : 'sell';
          // opening/closing heuristic (mirrors _handleFill's fallback): in short
          // mode buys close, otherwise sells close.
          const closing = recovery ? true : ((this.config.mode === 'short') ? side === 'buy' : side === 'sell');
          const reduceOnly = !!o.reduceOnly || recovery || isReduceOnly(side, this.config.mode);
          const sizeBase = Number(o.remainingSize ?? o.sizeBase) || this.config.sizeBase;
          try { this.ex.adoptOrder?.({ orderId: o.orderId, marketId: this.config.marketId, levelIndex: idx, side, price: px, sizeBase, reduceOnly, clientOrderId: o.clientOrderId }); } catch { /* ignore */ }
          this.active.set(String(o.orderId), { levelIndex: idx, side, price: px, sizeBase, opening: !reduceOnly && !closing, reduceOnly, recovery, placedAt: now });
          adopted++;
        }
        continue;
      }
      try {
        await this.ex.cancelOrder(this.config.marketId, o.orderId);
        this.active.delete(String(o.orderId));
        this._activity(formatCancelActivity({ levelIndex: idx, side: o.side, price: px, sizeBase: o.sizeBase }, o.orderId, '对账撤除重复'), 'cancel');
        trimmed++;
      }
      catch { /* leave it; next cycle retries */ }
    }
    if (recovery) this._recoveryOccupied = occupied;

    // IMPORTANT: reconciliation no longer re-seeds opening orders. Re-seeding via
    // seedOrders re-opened a SAME-SIDE order on a level that a fill had just
    // (correctly) vacated — its take-profit order lives one rung away — which made
    // the grid open positions endlessly in one direction (runaway inventory).
    // The grid is now maintained ONLY by the normal fill -> opposite-leg
    // replacement chain. Reconcile just keeps tracking accurate (prune) and
    // enforces one-order-per-level (trim). It never opens new positions.
    if (pruned || trimmed || adopted) {
      this._alert(`挂单对账：交易所实际 ${real.length} 单；清理失效 ${pruned}，撤除重复 ${trimmed}${adopted ? `，接管 ${adopted}` : ''}。`);
      this._changed();
    }
  }

  _startReconcileTimer() {
    if (this._reconTimer) return;
    this._reconTimer = setInterval(() => { this.reconcileOpenOrders().catch(() => {}); }, RECONCILE_MS);
    this._reconTimer.unref?.();
  }
  _stopReconcileTimer() { if (this._reconTimer) { clearInterval(this._reconTimer); this._reconTimer = null; } }

  /** Cancel a market's resting orders and record every locally tracked order. */
  async _cancelAllTracked(reason, marketId = this.config?.marketId) {
    const tracked = [...this.active.entries()];
    try {
      const cancelled = await this.ex.cancelAll(marketId);
      if (cancelled === false) return false;
      if (tracked.length) {
        for (const [id, info] of tracked) this._activity(formatCancelActivity(info, id, reason), 'cancel');
      } else {
        this._activity(`${reason} · 已发送全撤指令（本地无已跟踪挂单）`, 'cancel');
      }
      this._changed();
      return cancelled;
    } catch (e) {
      this._alert(`撤单失败: ${e?.message || e}`);
      return false;
    }
  }

  _activity(message, type = 'system') {
    this.activity.unshift({ t: Date.now(), type, message });
    if (this.activity.length > 200) this.activity.pop();
  }

  _alert(message) {
    this.alerts.unshift({ t: Date.now(), message });
    if (this.alerts.length > 30) this.alerts.pop();
    this._activity(message, /失败|未能|风险|⚠|❌/.test(message) ? 'warning' : 'system');
  }

  /** Per-exchange health classification surfaced to the dashboard. */
  _health() {
    const ex = this.ex;
    const okAge = (typeof ex.lastOkAt === 'number' && ex.lastOkAt > 0) ? Date.now() - ex.lastOkAt : null;
    const priceStale = !!(ex._pxStale && this.config && typeof ex._pxStale.has === 'function' && ex._pxStale.has(this.config.marketId));
    const recentFail = this._lastFailAt && (Date.now() - this._lastFailAt < 60000);
    const paused = this._refillPausedUntil && Date.now() < this._refillPausedUntil;
    let status = 'ok', reason = this.waitingForAdmission
      ? `策略已启动，等待震荡准入：${this.strategyGuard.rangeAdmission?.detail || '条件检查中'}`
      : '正常运行';
    if (!this.running && !this.config) { status = 'idle'; reason = '未运行'; }
    else if (ex.dataSource === 'synthetic') { status = 'warn'; reason = '合成行情（未连真实交易所）'; }
    else if (okAge != null && okAge > 30000) { status = 'error'; reason = `交易所数据 ${Math.round(okAge / 1000)}s 未更新`; }
    else if (priceStale) { status = 'warn'; reason = '行情滞后（已用持仓推算价兜底）'; }
    else if (recentFail) { status = 'warn'; reason = `近1分钟下单失败 ${this._placeFails} 次`; }
    return {
      status, reason,
      dataSource: ex.dataSource ?? null,
      lastOkAgeMs: okAge,
      priceStale,
      placeFails: this._placeFails,
      exchangeOpenOrders: this._exchangeOpenOrders,
    };
  }

  /** Detach local handlers when a stopped account switches strategy engines. */
  dispose() {
    this._stopReconcileTimer();
    this._stopGuardTimer();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    this.ex.off('error', this._onError);
  }

  getState() {
    const pos = this.running || this.config ? this.ex.getPosition?.(this.config?.marketId) : null;
    const openByLevel = {};
    for (const o of this.active.values()) openByLevel[o.levelIndex] = o.side;

    const rawUnrealized = pos ? Number(pos.unrealizedPnl) || 0 : 0;
    const unrealized = round2(rawUnrealized - (this._unrealizedBase || 0));
    const balance = typeof this.ex.balance === 'number' ? round2(this.ex.balance) : null;
    const equityRaw = typeof this.ex.equity === 'number' ? this.ex.equity
      : (balance != null ? balance + unrealized : null);
    const equity = equityRaw != null ? round2(equityRaw) : null;

    let realized;
    if (typeof this.ex.realizedPnl === 'number') {
      realized = round2(this.ex.realizedPnl - (this._pnlBase ?? 0)); // offset applied by resetStats
    } else if (equityRaw != null && this.startBalance != null) {
      realized = round2((equityRaw - this.startBalance) - unrealized);
    } else {
      realized = round2(this.stats.gridProfit);
    }
    const totalPnl = round2(realized + unrealized);
    const returnPct = (this.startBalance && this.startBalance > 0)
      ? round2((totalPnl / this.startBalance) * 100)
      : ((equity && equity > 0) ? round2((totalPnl / equity) * 100) : null);
    const executionCosts = subtractCosts(this._executionCostsRaw(), this._costBase);
    const directional = directionalExposure({
      positionSize: Number(pos?.sizeBase) || 0,
      price: this.lastPrice || pos?.entryPrice,
      equity: equityRaw,
      maxDirectionalNotionalPct: this.config?.maxDirectionalNotionalPct,
    });
    const guardOrderSize = Number(this.config?.sizeBase) || 0;
    const buyDecision = this.config && guardOrderSize > 0
      ? this._orderDecision({ side: 'buy', sizeBase: guardOrderSize, price: this.lastPrice })
      : null;
    const sellDecision = this.config && guardOrderSize > 0
      ? this._orderDecision({ side: 'sell', sizeBase: guardOrderSize, price: this.lastPrice })
      : null;
    const strategyGuard = {
      ...this.strategyGuard,
      exposure: directional,
      blockedOpeningSides: [
        ...(buyDecision && !buyDecision.allowed ? ['buy'] : []),
        ...(sellDecision && !sellDecision.allowed ? ['sell'] : []),
      ],
      buyReason: buyDecision && !buyDecision.allowed ? buyDecision.reason : null,
      sellReason: sellDecision && !sellDecision.allowed ? sellDecision.reason : null,
      buySizeScale: buyDecision?.inventoryScale ?? 1,
      sellSizeScale: sellDecision?.inventoryScale ?? 1,
    };
    const measurement = this.measurement
      ? { ...this.measurement, elapsedMs: Date.now() - this.measurement.startedAt, results: this._measurementResults() }
      : null;
    return {
      mode: this.ex.mode,
      recovery: this.recovery,
      running: this.running,
      waitingForAdmission: this.waitingForAdmission,
      config: this.config,
      grid: this.grid,
      lastPrice: this.lastPrice != null ? round2(this.lastPrice) : null,
      outOfRange: this.outOfRange,
      risk: this.risk,
      stats: this.stats,
      openOrders: this.active.size,
      exchangeOpenOrders: this._exchangeOpenOrders,
      openByLevel,
      health: this._health(),
      position: pos ? { sizeBase: round6(pos.sizeBase), entryPrice: round2(pos.entryPrice), unrealizedPnl: round2(rawUnrealized), leverage: pos.leverage ?? null } : null,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      totalPnl,
      returnPct,
      equity,
      balance,
      volume: this.stats.volume,
      theoreticalProfit: round2(this.stats.gridProfit),
      executionCosts,
      strategyGuard,
      measurement,
      measurementHistory: this.measurementHistory.slice(0, 12),
      startBalance: this.startBalance != null ? round2(this.startBalance) : null,
      fills: this.fills.slice(0, 20),
      alerts: this.alerts.slice(0, 12),
      activity: this.activity.slice(0, 100),
    };
  }
}

function labelMode(m) { return m === 'long' ? '做多网格' : m === 'short' ? '做空网格' : '中性网格'; }

function sideName(side) { return side === 'buy' ? '买入' : '卖出'; }

function formatCancelActivity(info, id, reason) {
  const details = info
    ? ` · ${sideName(info.side)} ${round6(Number(info.sizeBase) || 0)} @ ${round2(Number(info.price) || 0)} · 网格 ${info.levelIndex}`
    : '';
  return `${reason}${details} · #${id}`;
}

function restoreActivity(snap) {
  if (Array.isArray(snap.activity)) return snap.activity.slice(0, 200);
  return Array.isArray(snap.alerts) ? snap.alerts.slice(0, 30).map((item) => ({ ...item, type: 'system' })) : [];
}

function withGuardDefaults(config) {
  if (!config) return config;
  const optimizedNeutral = config.mode === 'neutral'
    && ['range_balanced', 'ai_rotation', 'ai_rotation_v3'].includes(config.strategyId);
  return {
    ...config,
    maxDirectionalNotionalPct: bounded(config.maxDirectionalNotionalPct, 1, 100, STRATEGY_GUARD_DEFAULTS.maxDirectionalNotionalPct),
    trendGuardEnabled: config.trendGuardEnabled !== false,
    trendGuardMinStrength: bounded(config.trendGuardMinStrength, 0, 1, STRATEGY_GUARD_DEFAULTS.trendGuardMinStrength),
    trendGuardRefreshMs: bounded(config.trendGuardRefreshMs, 60_000, 60 * 60_000, STRATEGY_GUARD_DEFAULTS.trendGuardRefreshMs),
    neutralRangeAdmissionEnabled: config.neutralRangeAdmissionEnabled == null
      ? optimizedNeutral : config.neutralRangeAdmissionEnabled === true,
    rangeAdmissionMinAtrPct: bounded(config.rangeAdmissionMinAtrPct, 0.05, 10, NEUTRAL_GRID_DEFAULTS.rangeAdmissionMinAtrPct),
    inventorySkewEnabled: config.inventorySkewEnabled == null
      ? optimizedNeutral : config.inventorySkewEnabled === true,
    inventorySkewStartPctOfCap: bounded(config.inventorySkewStartPctOfCap, 0, 95, NEUTRAL_GRID_DEFAULTS.inventorySkewStartPctOfCap),
    inventorySkewMinScale: bounded(config.inventorySkewMinScale, 0.05, 1, NEUTRAL_GRID_DEFAULTS.inventorySkewMinScale),
    minRoundTripCostMultiple: bounded(config.minRoundTripCostMultiple, 1, 10, NEUTRAL_GRID_DEFAULTS.costCoverageMultiple),
  };
}

function parameterSnapshot(config) {
  if (!config) return null;
  return {
    marketId: config.marketId,
    displayName: config.displayName,
    strategyId: config.strategyId || null,
    mode: config.mode,
    lower: config.lower,
    upper: config.upper,
    gridCount: config.gridCount,
    sizeBase: config.sizeBase,
    leverage: config.leverage,
    outOfRangeAction: config.outOfRangeAction,
    maxDirectionalNotionalPct: config.maxDirectionalNotionalPct,
    trendGuardEnabled: config.trendGuardEnabled,
    neutralRangeAdmissionEnabled: config.neutralRangeAdmissionEnabled,
    rangeAdmissionMinAtrPct: config.rangeAdmissionMinAtrPct,
    inventorySkewEnabled: config.inventorySkewEnabled,
    inventorySkewStartPctOfCap: config.inventorySkewStartPctOfCap,
    inventorySkewMinScale: config.inventorySkewMinScale,
    minRoundTripCostMultiple: config.minRoundTripCostMultiple,
  };
}

function defaultGuardState() {
  return {
    enabled: STRATEGY_GUARD_DEFAULTS.trendGuardEnabled,
    trend: 'range',
    strength: 0,
    minStrength: STRATEGY_GUARD_DEFAULTS.trendGuardMinStrength,
    checkedAt: null,
    dataSource: null,
    reason: '尚未检查趋势',
    error: null,
    rangeAdmission: { enabled: false, allowed: true, reason: 'not_required', detail: '当前方向不需要中性准入。' },
  };
}

function emptyCosts() {
  return { fees: 0, slippage: 0, spread: 0, funding: 0, total: 0 };
}

function normalizeCosts(costs) {
  const normalized = {
    fees: Number(costs?.fees) || 0,
    slippage: Number(costs?.slippage) || 0,
    spread: Number(costs?.spread) || 0,
    funding: Number(costs?.funding) || 0,
  };
  normalized.total = normalized.fees + normalized.slippage + normalized.spread + normalized.funding;
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, Math.round(value * 1e8) / 1e8]));
}

function subtractCosts(current, baseline) {
  const now = normalizeCosts(current);
  const base = normalizeCosts(baseline);
  return normalizeCosts({
    fees: now.fees - base.fees,
    slippage: now.slippage - base.slippage,
    spread: now.spread - base.spread,
    funding: now.funding - base.funding,
  });
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function round2(x) { return Math.round(x * 100) / 100; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
