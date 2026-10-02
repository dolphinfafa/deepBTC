import { GridBot } from './bot.js';
import { buildTurtleSignals, snapDown, turtleUnitSize } from './turtle.js';

const HOUR_MS = 60 * 60_000;

export const TURTLE_PAPER_DEFAULTS = Object.freeze({
  strategyId: 'turtle_s2_long',
  entryDays: 20,
  exitDays: 10,
  atrDays: 20,
  riskPct: 1.5,
  stopAtrMultiple: 2,
  addAtrMultiple: 0.5,
  maxUnits: 4,
  maxNotionalPct: 100,
  signalRefreshMs: HOUR_MS,
});

/** Long-only Turtle breakout execution for isolated PAPER accounts. */
export class TurtlePaperBot extends GridBot {
  constructor(exchange, options = {}) {
    super(exchange, options);
    this.engine = 'turtle';
    this.signal = null;
    this.campaign = null;
    this.lastSignalRefreshAt = null;
    this.nextSignalRefreshAt = 0;
    this.signalError = null;
    this._priceQueue = Promise.resolve();
    this._processing = false;
    this._onPrice = (event) => this._handlePrice(event);
  }

  snapshot() {
    return {
      engine: 'turtle',
      running: this.running,
      config: this.config,
      stats: this.stats,
      pnlBase: this._pnlBase,
      unrealizedBase: this._unrealizedBase,
      costBase: this._costBase,
      measurement: this.measurement,
      measurementHistory: this.measurementHistory,
      measurementSeq: this._measurementSeq,
      startBalance: this.startBalance,
      lastPrice: this.lastPrice,
      fills: this.fills.slice(0, 50),
      alerts: this.alerts.slice(0, 30),
      activity: this.activity.slice(0, 200),
      signal: this.signal,
      campaign: this.campaign,
      lastSignalRefreshAt: this.lastSignalRefreshAt,
      nextSignalRefreshAt: this.nextSignalRefreshAt,
      signalError: this.signalError,
      exchangeState: this.ex.exportState?.() ?? null,
    };
  }

  restore(snapshot) {
    if (!snapshot?.config || snapshot.config.engine !== 'turtle') return;
    this.config = { ...snapshot.config };
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snapshot.stats || {}) };
    this.startBalance = snapshot.startBalance ?? null;
    this._pnlBase = snapshot.pnlBase ?? null;
    this._restoreMeasurement(snapshot);
    this.fills = Array.isArray(snapshot.fills) ? snapshot.fills.slice(0, 50) : [];
    this.alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts.slice(0, 30) : [];
    this.activity = Array.isArray(snapshot.activity) ? snapshot.activity.slice(0, 200) : [];
    this.signal = validSignal(snapshot.signal) ? { ...snapshot.signal } : null;
    this.campaign = normalizeCampaign(snapshot.campaign);
    this.lastSignalRefreshAt = finiteTimestamp(snapshot.lastSignalRefreshAt);
    this.nextSignalRefreshAt = finiteTimestamp(snapshot.nextSignalRefreshAt) || 0;
    this.signalError = snapshot.signalError || null;
    this.grid = null;
    this.active.clear();
    this._exchangeOpenOrders = 0;
    this._recomputeTurtleRisk();
  }

  async resume(snapshot, restoreContext = {}) {
    if (!snapshot?.config || snapshot.config.engine !== 'turtle') throw new Error('无可恢复的海龟策略快照。');
    if (this.ex.mode !== 'paper') throw new Error('海龟突破策略目前仅允许 PAPER 模拟盘。');
    if (this.running) throw new Error('海龟策略已在运行。');
    this.restore(snapshot);
    this.ex.restoreState?.(snapshot.exchangeState, {
      ...restoreContext,
      marketId: this.config.marketId,
      displayName: this.config.displayName,
    });
    await this._refreshSignal(true);
    this.lastPrice = Number(await this.ex.getPrice(this.config.marketId));
    const position = this.ex.getPosition?.(this.config.marketId);
    if (position && !this.campaign) throw new Error('海龟持仓缺少可恢复的单位和止损状态，已阻止自动接管。');
    if (!position) this.campaign = null;
    this.running = true;
    this.ex.on('price', this._onPrice);
    this.ex.start?.();
    this._alert(`已恢复海龟突破做多策略：${position ? `${this.campaign.unitEntries.length} 个单位持仓` : `等待 ${this.config.entryDays} 日突破`}。`);
    await this._processPrice(this.lastPrice);
    this._changed();
    return this.getState();
  }

  async start(input = {}) {
    if (this.running || this._starting) throw new Error('海龟策略已在运行或正在启动。');
    if (this.ex.mode !== 'paper') throw new Error('海龟突破策略目前仅允许 PAPER 模拟盘。');
    if (typeof this.ex.executeMarketOrder !== 'function') throw new Error('当前模拟交易所不支持海龟策略市价执行。');
    this._starting = true;
    try {
      const markets = await this.ex.getMarkets();
      const market = markets.find((item) => Number(item.marketId) === Number(input.marketId));
      if (!market || normalizeMarket(market.displayName) !== 'BTCUSD') throw new Error('海龟策略只允许 BTC-USD。');
      const preflight = await this.ex.preflight?.();
      const position = this.ex.getPosition?.(market.marketId);
      if (position || Number(preflight?.openOrderCount || 0) > 0 || this.active.size > 0) {
        throw new Error('启动海龟策略前必须没有持仓或遗留挂单。');
      }

      this.config = {
        ...TURTLE_PAPER_DEFAULTS,
        marketId: market.marketId,
        displayName: market.displayName,
        strategyId: TURTLE_PAPER_DEFAULTS.strategyId,
        engine: 'turtle',
        strategyType: 'turtle',
        mode: 'long',
        leverage: 1,
        stepSize: Number(market.stepSize) || 0.00001,
        minOrderSize: Number(market.minOrderSize) || 0.0001,
        maxDirectionalNotionalPct: 100,
        sizeBase: 0,
      };
      this.lastPrice = Number(await this.ex.getPrice(market.marketId));
      if (!(this.lastPrice > 0)) throw new Error('没有有效 BTC 最新价格，无法启动海龟策略。');
      this.signal = null;
      this.campaign = null;
      this.signalError = null;
      await this._refreshSignal(true);
      const previewSize = this._unitSize(this.lastPrice, 0);
      if (!(previewSize >= this.config.minOrderSize)) throw new Error('按 1.5% 风险计算的单位低于市场最小下单量。');
      this.config.sizeBase = previewSize;
      this.active.clear();
      this._exchangeOpenOrders = 0;
      this.recovery = false;
      this.outOfRange = false;
      this._beginMeasurement('turtle_start');
      this.running = true;
      this.ex.on('price', this._onPrice);
      this.ex.start?.();
      this._alert(`已启动海龟突破做多：${this.config.entryDays} 日入场、${this.config.exitDays} 日退出、单位风险 ${this.config.riskPct}%、最多 ${this.config.maxUnits} 单位。`);
      await this._processPrice(this.lastPrice);
      this._changed();
      return this.getState();
    } catch (error) {
      this.running = false;
      this.ex.off('price', this._onPrice);
      throw error;
    } finally {
      this._starting = false;
    }
  }

  async stop({ closePosition = true } = {}) {
    this.ex.off('price', this._onPrice);
    await this.ex.cancelAll?.(this.config?.marketId);
    this.active.clear();
    this._exchangeOpenOrders = 0;
    if (closePosition && this.config) await this._exit('manual_stop', this.lastPrice);
    this.running = false;
    this.recovery = false;
    this._alert(closePosition ? '海龟策略已停止并按模拟市价平仓。' : '海龟策略已停止，当前持仓保留且不再自动管理。');
    this._changed();
    return this.getState();
  }

  async cancelAllOrders() {
    if (!this.config) throw new Error('尚未配置策略。');
    this.ex.off('price', this._onPrice);
    await this.ex.cancelAll?.(this.config.marketId);
    this.active.clear();
    this._exchangeOpenOrders = 0;
    this.running = false;
    this._alert('海龟策略没有常驻挂单；自动交易已停止，持仓保持不变。');
    this._changed();
    return this.getState();
  }

  async closePositionNow(marketId) {
    const id = Number(marketId ?? this.config?.marketId);
    if (!Number.isFinite(id)) throw new Error('未指定市场，无法平仓。');
    this.ex.off('price', this._onPrice);
    await this.ex.cancelAll?.(id);
    await this._exit('manual_close', Number(await this.ex.getPrice(id)));
    this.running = false;
    this._alert('海龟持仓已按模拟市价平仓，自动交易已停止。');
    this._changed();
    return this.getState();
  }

  async adjustRange() { throw new Error('海龟策略没有网格区间，参数由突破通道和 ATR 自动计算。'); }
  async startRecovery() { throw new Error('海龟策略不支持网格回收阶梯；请停止并平仓或保留持仓。'); }

  setPaperEquity(amount) {
    if (this.running) throw new Error('海龟策略运行中不能调整模拟账户权益。');
    return super.setPaperEquity(amount);
  }

  dispose() {
    this.ex.off('price', this._onPrice);
    super.dispose();
  }

  _handlePrice(event) {
    if (!this.running || Number(event?.marketId) !== Number(this.config?.marketId)) return;
    const price = Number(event.price);
    if (!(price > 0)) return;
    this.lastPrice = price;
    this._priceQueue = this._priceQueue
      .then(() => this._processPrice(price))
      .catch((error) => {
        this.signalError = error?.message || String(error);
        this._alert(`海龟策略本轮执行失败：${this.signalError}`);
        this._changed();
      });
  }

  async _processPrice(price) {
    if (!this.running || this._processing) return;
    this._processing = true;
    try {
      if (Date.now() >= this.nextSignalRefreshAt) await this._refreshSignal(false);
      if (!this.signal) return;
      const position = this.ex.getPosition?.(this.config.marketId);
      if (this.campaign && !position) {
        this.campaign = null;
        this._alert('未检测到海龟持仓，已清除旧单位状态并重新等待突破。');
      }
      if (!this.campaign) {
        if (price >= this.signal.entryHigh) await this._enter(price);
        return;
      }

      const exitPrice = Math.max(Number(this.campaign.stopPrice), Number(this.signal.exitLow));
      if (price <= exitPrice) {
        const reason = Number(this.campaign.stopPrice) >= Number(this.signal.exitLow) ? 'stop' : 'channel';
        await this._exit(reason, price);
        return;
      }
      while (this.campaign && this.campaign.unitEntries.length < this.config.maxUnits && price >= this.campaign.nextAddPrice) {
        const trigger = this.campaign.nextAddPrice;
        if (!(await this._addUnit(price))) break;
        this.campaign.nextAddPrice = trigger + this.config.addAtrMultiple * this.campaign.atrN;
      }
    } finally {
      this._processing = false;
    }
  }

  async _refreshSignal(force) {
    if (!force && Date.now() < this.nextSignalRefreshAt) return this.signal;
    const candles = await this.ex.getCandles(this.config.marketId, 86400, 120);
    if (this.ex.candleDataSource === 'synthetic') throw new Error('真实日 K 线不可用，海龟策略拒绝使用合成数据交易。');
    if (!Array.isArray(candles) || candles.length < 100) throw new Error(`BTC 已完成日 K 线不足（需要 100 根，当前 ${candles?.length || 0} 根）。`);
    const signals = buildTurtleSignals(candles, this.config);
    const latest = signals.at(-1);
    if (!validSignal(latest)) throw new Error('无法从已完成日 K 线计算海龟通道。');
    this.signal = { ...latest };
    this.lastSignalRefreshAt = Date.now();
    this.nextSignalRefreshAt = this.lastSignalRefreshAt + this.config.signalRefreshMs;
    this.signalError = null;
    this._recomputeTurtleRisk();
    this._changed();
    return this.signal;
  }

  async _enter(price) {
    const quantity = this._unitSize(price, 0);
    if (!(quantity > 0)) {
      this._alert('价格已突破，但 100% 名义金额上限或最小下单量阻止了首个单位。');
      return false;
    }
    const fill = await this.ex.executeMarketOrder({ marketId: this.config.marketId, side: 'buy', sizeBase: quantity });
    this.campaign = {
      atrN: this.signal.atrN,
      unitSize: quantity,
      unitEntries: [{ t: Date.now(), price: fill.referencePrice, sizeBase: fill.sizeBase }],
      latestUnitPrice: fill.referencePrice,
      nextAddPrice: fill.referencePrice + this.config.addAtrMultiple * this.signal.atrN,
      stopPrice: fill.referencePrice - this.config.stopAtrMultiple * this.signal.atrN,
      openedAt: Date.now(),
    };
    this.config.sizeBase = quantity;
    this._recordFill(fill, `${this.config.entryDays} 日突破开仓`);
    this._alert(`突破 ${round2(this.signal.entryHigh)}，买入首个单位 ${round6(quantity)} BTC，2N 止损 ${round2(this.campaign.stopPrice)}。`);
    this._recomputeTurtleRisk();
    this._changed();
    return true;
  }

  async _addUnit(price) {
    const position = this.ex.getPosition?.(this.config.marketId);
    const currentSize = Math.max(0, Number(position?.sizeBase) || 0);
    const equity = this._accountEquity(position);
    const available = Math.max(0, equity * this.config.maxNotionalPct / 100 / price - currentSize);
    const quantity = snapDown(Math.min(this.campaign.unitSize, available), this.config.stepSize);
    if (quantity + 1e-12 < this.config.minOrderSize) {
      this._alert('价格达到加仓位，但整个持仓已接近 100% 名义金额上限，本次不再加仓。');
      return false;
    }
    const fill = await this.ex.executeMarketOrder({ marketId: this.config.marketId, side: 'buy', sizeBase: quantity });
    this.campaign.unitEntries.push({ t: Date.now(), price: fill.referencePrice, sizeBase: fill.sizeBase });
    this.campaign.latestUnitPrice = fill.referencePrice;
    this.campaign.stopPrice = fill.referencePrice - this.config.stopAtrMultiple * this.campaign.atrN;
    this._recordFill(fill, `第 ${this.campaign.unitEntries.length} 单位加仓`);
    this._alert(`上涨 0.5N 加仓：当前 ${this.campaign.unitEntries.length}/${this.config.maxUnits} 单位，最新 2N 止损 ${round2(this.campaign.stopPrice)}。`);
    this._recomputeTurtleRisk();
    this._changed();
    return true;
  }

  async _exit(reason, price) {
    const position = this.config ? this.ex.getPosition?.(this.config.marketId) : null;
    if (!position || !(Math.abs(Number(position.sizeBase)) > 0)) {
      this.campaign = null;
      return false;
    }
    const quantity = Math.abs(Number(position.sizeBase));
    const grossPnl = quantity * (price - Number(position.entryPrice));
    const fill = await this.ex.executeMarketOrder({
      marketId: this.config.marketId,
      side: 'sell',
      sizeBase: quantity,
      reduceOnly: true,
    });
    this._recordFill(fill, exitReasonText(reason));
    this.stats.completedRungs += 1;
    this.stats.gridProfit += grossPnl;
    const units = this.campaign?.unitEntries?.length || 0;
    this.campaign = null;
    this._alert(`${exitReasonText(reason)}：卖出 ${round6(quantity)} BTC，结束 ${units} 单位持仓。`);
    this._recomputeTurtleRisk();
    this._changed();
    return true;
  }

  _unitSize(price, currentSize) {
    return turtleUnitSize({
      equity: this._accountEquity(this.ex.getPosition?.(this.config.marketId)),
      price,
      atrN: this.signal.atrN,
      riskPct: this.config.riskPct,
      stopAtrMultiple: this.config.stopAtrMultiple,
      maxNotionalPct: this.config.maxNotionalPct,
      currentSize,
      stepSize: this.config.stepSize,
      minOrderSize: this.config.minOrderSize,
    });
  }

  _accountEquity(position) {
    if (typeof this.ex.equity === 'number') return this.ex.equity;
    return Math.max(0, Number(this.ex.balance) + (Number(position?.unrealizedPnl) || 0));
  }

  _recordFill(fill, reason) {
    const item = {
      t: Date.now(), side: fill.side, price: fill.referencePrice, executionPrice: fill.executionPrice,
      sizeBase: fill.sizeBase, costs: fill.costs, reason,
    };
    this.fills.unshift(item);
    if (this.fills.length > 50) this.fills.pop();
    if (fill.side === 'buy') this.stats.buys += 1;
    else this.stats.sells += 1;
    this.stats.volume += Number(fill.referencePrice) * Number(fill.sizeBase);
    this._activity(`${reason} · ${fill.side === 'buy' ? '买入' : '卖出'} ${round6(fill.sizeBase)} BTC @ ${round2(fill.referencePrice)} · 成本 ${round4(fill.costs?.total)} USDC`, 'fill');
  }

  _recomputeTurtleRisk() {
    if (!this.config) { this.risk = null; return; }
    const position = this.ex.getPosition?.(this.config.marketId);
    const size = Math.abs(Number(position?.sizeBase) || 0);
    const price = Number(this.lastPrice || position?.entryPrice) || 0;
    const atrN = Number(this.campaign?.atrN || this.signal?.atrN) || 0;
    const unitSize = Number(this.campaign?.unitSize || this.config.sizeBase) || 0;
    this.risk = {
      notional: round2(size * price),
      requiredMargin: round2(size * price),
      perRungProfit: null,
      spacingPct: price > 0 ? round4(atrN / price * 100) : null,
      unitRiskBudget: round2(this._accountEquity(position) * this.config.riskPct / 100),
      unitStopRisk: round2(unitSize * atrN * this.config.stopAtrMultiple),
      maxNotionalPct: this.config.maxNotionalPct,
    };
  }

  _health() {
    const health = super._health();
    if (health.status === 'ok') health.reason = this.running
      ? (this.campaign ? '海龟持仓管理中' : '海龟运行中，等待突破')
      : '海龟策略未运行';
    return health;
  }

  getState() {
    this._recomputeTurtleRisk();
    const state = super.getState();
    const position = state.position;
    const currentUnits = this.campaign?.unitEntries?.length || 0;
    const exitPrice = this.campaign && this.signal
      ? Math.max(Number(this.campaign.stopPrice), Number(this.signal.exitLow))
      : null;
    return {
      ...state,
      engine: 'turtle',
      grid: null,
      openOrders: 0,
      exchangeOpenOrders: 0,
      openByLevel: {},
      outOfRange: false,
      strategyGuard: {
        enabled: false,
        reason: '海龟通道和 2N 止损直接管理方向风险',
        exposure: state.strategyGuard?.exposure || null,
        blockedOpeningSides: [],
      },
      turtle: {
        state: this.running ? (position ? 'holding' : 'waiting') : 'stopped',
        entryDays: this.config?.entryDays ?? TURTLE_PAPER_DEFAULTS.entryDays,
        exitDays: this.config?.exitDays ?? TURTLE_PAPER_DEFAULTS.exitDays,
        atrDays: this.config?.atrDays ?? TURTLE_PAPER_DEFAULTS.atrDays,
        entryHigh: this.signal?.entryHigh ?? null,
        exitLow: this.signal?.exitLow ?? null,
        atrN: this.signal?.atrN ?? null,
        signalAvailableAt: this.signal?.availableAt ?? null,
        lastSignalRefreshAt: this.lastSignalRefreshAt,
        nextSignalRefreshAt: this.nextSignalRefreshAt || null,
        signalError: this.signalError,
        riskPct: this.config?.riskPct ?? TURTLE_PAPER_DEFAULTS.riskPct,
        unitSize: this.campaign?.unitSize || this.config?.sizeBase || null,
        currentUnits,
        maxUnits: this.config?.maxUnits ?? TURTLE_PAPER_DEFAULTS.maxUnits,
        nextAddPrice: this.campaign?.nextAddPrice ?? null,
        stopPrice: this.campaign?.stopPrice ?? null,
        activeExitPrice: exitPrice,
        maxNotionalPct: this.config?.maxNotionalPct ?? TURTLE_PAPER_DEFAULTS.maxNotionalPct,
      },
    };
  }
}

function validSignal(value) {
  return Number(value?.entryHigh) > 0 && Number(value?.exitLow) > 0 && Number(value?.atrN) > 0;
}

function normalizeCampaign(value) {
  if (!value || !(Number(value.atrN) > 0)) return null;
  const unitEntries = Array.isArray(value.unitEntries)
    ? value.unitEntries.filter((item) => Number(item?.price) > 0 && Number(item?.sizeBase) > 0)
    : [];
  if (!unitEntries.length) return null;
  return { ...value, unitEntries };
}

function normalizeMarket(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function finiteTimestamp(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; }
function exitReasonText(reason) {
  return ({ stop: '2N 止损退出', channel: '20 日通道退出', manual_stop: '手动停止平仓', manual_close: '手动市价平仓' })[reason] || '海龟退出';
}
function round2(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function round4(value) { return Math.round((Number(value) || 0) * 10_000) / 10_000; }
function round6(value) { return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000; }
