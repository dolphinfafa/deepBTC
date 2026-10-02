// PaperExchange: simulated trading on top of REAL Decibel prices.
// On init it probes Decibel's REST endpoints (mainnet first), loads real
// markets, then continuously polls real mark/mid prices so the dashboard
// price + candles match the live exchange. Only the order *fills* are
// simulated (matched against the real price path).
//
// NOTE: Decibel's GET API requires a (free) Geomi API key. Set
// DECIBEL_API_KEY in .env to get real prices in paper mode; without it the
// exchange anchors its prices to public spot feeds (Coinbase/Binance, no key
// needed) and falls back to a synthetic random walk only if those fail too.
import { EventEmitter } from 'node:events';
import { decibelAuthHeaders } from './auth.js';
import { aggregateCandles } from '../../candles.js';

const FALLBACK_MARKETS = [
  { marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC', lastPrice: 74000, stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001 },
  { marketId: 2, name: 'ETH-USD', displayName: 'ETH-USD', symbol: 'ETH', lastPrice: 2600, stepSize: 0.0001, stepPrice: 0.01, maxLeverage: 50, minOrderSize: 0.001 },
];
const INTERVALS = { 60: '1m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 7200: '2h', 14400: '4h', 86400: '1d' };
const COINBASE_GRANULARITIES = new Set([60, 300, 900, 3600, 21600, 86400]);
const COINBASE_CANDLE_CHUNK = 250;

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.balance = opts.startBalance ?? 10000;
    this.apiKey = opts.apiKey || '';
    this.btcOnly = opts.btcOnly !== false;
    this.origin = opts.origin || 'http://127.0.0.1';
    // Candidate REST bases: explicit override -> mainnet -> testnet.
    this.candidates = [...new Set((opts.apiUrl ? [opts.apiUrl] : []).concat([
      'https://api.mainnet.aptoslabs.com/decibel', // mainnet (real prices)
      'https://api.testnet.aptoslabs.com/decibel', // testnet fallback
    ]))];
    this.apiUrl = this.candidates[0];
    this.dataSource = 'connecting';   // 'real' | 'spot' | 'synthetic'
    this.network = null;              // 'mainnet' | 'testnet' | null
    this.tickMs = opts.tickMs ?? 1000;
    this.pollMs = opts.pollMs ?? 5000;
    this.volPerTick = opts.volPerTick ?? 0.0015; // only for synthetic fallback
    this.feeRate = finiteNumber(opts.feeRate, 0.0005);
    this.slippageBps = finiteNumber(opts.slippageBps, 2);
    this.spreadBps = finiteNumber(opts.spreadBps, 1);
    this.fundingRate = finiteNumber(opts.fundingRate, 0.0001);
    this.fundingIntervalMs = finiteNumber(opts.fundingIntervalMs, 8 * 3_600_000);
    this.fillDelayMs = finiteNumber(opts.fillDelayMs, 750);
    this.partialFillProbability = finiteNumber(opts.partialFillProbability, 0.35);
    this.partialFillRatio = finiteNumber(opts.partialFillRatio, 0.5);
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;
    this.markets = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.realizedPnl = 0;
    this.executionCosts = emptyExecutionCosts();
    this.lastFundingAt = Date.now();
    this.candleDataSource = null;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.prices = new Map();      // displayed/simulated price
    this.realTarget = new Map();  // latest real price target
    this._seq = 1;
    this._tickTimer = null;
    this._pollTimer = null;
    this._spotTimer = null;
    this._following = null;
    this._onSharedPrice = null;
  }

  /** Share one market-data clock while keeping orders, positions and PnL isolated. */
  follow(source) {
    if (!source || source === this) throw new Error('共享行情源无效。');
    this.dispose();
    this._following = source;
    this.dataSource = source.dataSource;
    this.network = source.network;
    this.apiUrl = source.apiUrl;
    this.markets = new Map([...source.markets.entries()].map(([id, market]) => [id, { ...market }]));
    this.prices = new Map(source.prices);
    this.realTarget = new Map(source.realTarget);
    this.lastOkAt = source.lastOkAt;
    this._onSharedPrice = ({ marketId, price }) => {
      const id = Number(marketId);
      const next = Number(price);
      const previous = this.prices.get(id) ?? next;
      this.dataSource = source.dataSource;
      this.network = source.network;
      this.lastOkAt = source.lastOkAt || Date.now();
      this._applyFunding(Date.now());
      this.prices.set(id, next);
      this.realTarget.set(id, next);
      const market = this.markets.get(id);
      if (market) market.lastPrice = next;
      this.emit('price', { marketId: id, price: next });
      this._matchFills(id, previous, next);
    };
    source.on('price', this._onSharedPrice);
    return true;
  }

  async init() {
    let chosen = null;
    for (const url of this.candidates) {
      const list = await this._fetchMarkets(url);
      if (list && list.length) { chosen = url; this._setMarkets(list); break; }
    }
    if (chosen) {
      this.apiUrl = chosen;
      this.dataSource = 'real';
      this.network = chosen.includes('testnet') ? 'testnet' : 'mainnet';
    } else {
      if (!this.apiKey) console.log('[模拟模式] 未配置 DECIBEL_API_KEY，无法读取 Decibel 真实行情，使用合成行情。在 geomi.dev 免费创建 API key 后填入 .env 即可显示真实价格。');
      this.dataSource = 'synthetic';
      this._setMarkets(FALLBACK_MARKETS.map((m) => ({ ...m })));
    }
    for (const [id, m] of this.markets) {
      this.prices.set(id, m.lastPrice || 100);
      this.realTarget.set(id, m.lastPrice || 100);
    }
    if (this.dataSource === 'synthetic') {
      // No Decibel key: anchor prices to public spot feeds so paper trading
      // still tracks the real market instead of an arbitrary random walk.
      if (await this._pollSpot(true)) {
        this.dataSource = 'spot';
        console.log('[模拟模式] 已改用公共现货行情（Coinbase/Binance）锚定价格。');
      }
    }
    this._startLoops();           // keep price live even before bot starts
    return true;
  }

  /** Reconnect: re-probe endpoints (upgrades synthetic->real if now reachable) and restart loops. */
  async reconnect() {
    if (this._following) return this.follow(this._following);
    try {
      for (const url of this.candidates) {
        const list = await this._fetchMarkets(url);
        if (list && list.length) {
          this.apiUrl = url;
          this.network = url.includes('testnet') ? 'testnet' : 'mainnet';
          if (this.dataSource !== 'real') { // upgrade only: never re-number live market ids
            this.dataSource = 'real';
            this._setMarkets(list);
            for (const [id, m] of this.markets) { this.prices.set(id, m.lastPrice || 100); this.realTarget.set(id, m.lastPrice || 100); }
          }
          break;
        }
      }
    } catch { /* keep current mode */ }
    this._startLoops();
    this.lastOkAt = Date.now();
    return true;
  }

  _headers() {
    return decibelAuthHeaders(this.apiKey, this.origin);
  }

  async _fetchMarkets(url) {
    try {
      const [mres, pres] = await Promise.all([
        fetch(`${url}/api/v1/markets`, { headers: this._headers(), signal: AbortSignal.timeout(8000) }),
        fetch(`${url}/api/v1/prices`, { headers: this._headers(), signal: AbortSignal.timeout(8000) }),
      ]);
      if (!mres.ok || !pres.ok) return null;
      const list = await mres.json();
      const prices = await pres.json();
      if (!Array.isArray(list) || !Array.isArray(prices)) return null;
      const pxByAddr = new Map(prices.map((p) => [String(p.market), p]));
      const out = [];
      let id = 1;
      for (const m of list) {
        if (String(m.mode ?? 'Open') !== 'Open') continue;
        const px = pxByAddr.get(String(m.market_addr));
        const price = Number(px?.mid_px || px?.mark_px || px?.oracle_px || 0);
        if (!price) continue;
        const pxDec = Number(m.px_decimals), szDec = Number(m.sz_decimals);
        out.push({
          marketId: id++, name: m.market_name, displayName: m.market_name,
          symbol: String(m.market_name).split(/[-/]/)[0], lastPrice: price,
          addr: String(m.market_addr),
          stepSize: Number(m.lot_size) / 10 ** szDec, stepPrice: Number(m.tick_size) / 10 ** pxDec,
          maxLeverage: Number(m.max_leverage || 20), minOrderSize: Number(m.min_size) / 10 ** szDec,
        });
      }
      // larger open interest first so BTC/ETH end up on top
      out.sort((a, b) => (pxByAddr.get(b.addr)?.open_interest || 0) - (pxByAddr.get(a.addr)?.open_interest || 0));
      out.forEach((m, i) => { m.marketId = i + 1; });
      return out.length ? out : null;
    } catch { return null; }
  }

  _setMarkets(list) {
    this.markets.clear();
    const selected = this.btcOnly
      ? list.filter((market) => isBtcUsd(market))
      : list;
    selected.slice(0, this.btcOnly ? 1 : selected.length).forEach((m, index) => {
      this.markets.set(this.btcOnly ? 1 : (m.marketId ?? index + 1), { ...m, marketId: this.btcOnly ? 1 : (m.marketId ?? index + 1) });
    });
  }

  async getMarkets() { return [...this.markets.values()]; }

  async preflight() {
    const first = this.markets.values().next().value;
    return {
      ok: true,
      network: this.network,
      dataSource: this.dataSource,
      marketCount: this.markets.size,
      openOrderCount: this.orders.size,
      positionCount: [...this.positions.values()].filter((position) => position.sizeBase).length,
      balance: this.balance,
      equity: this.balance + [...this.positions.entries()].reduce((sum, [marketId, position]) => {
        const price = this.prices.get(marketId) || position.entryPrice;
        return sum + position.sizeBase * (price - position.entryPrice);
      }, 0),
      priceProbe: first ? this.prices.get(first.marketId) : null,
      lastOkAt: this.lastOkAt,
      executionCosts: this.getExecutionCosts(),
    };
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    if (this._following?.getCandles) return this._following.getCandles(marketId, intervalSec, n);
    const m = this.markets.get(Number(marketId));
    if (this.dataSource === 'real' && m?.addr) {
      try {
        const interval = INTERVALS[intervalSec] || '1h';
        const end = Date.now();
        const start = end - Math.min(n, 1000) * intervalSec * 1000;
        const url = `${this.apiUrl}/api/v1/candlesticks?market=${encodeURIComponent(m.addr)}&interval=${interval}&startTime=${start}&endTime=${end}`;
        const res = await fetch(url, { headers: this._headers(), signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const j = await res.json();
          const now = Date.now();
          const data = (Array.isArray(j) ? j : []).map((c) => {
            const time = Number(c.t ?? c.T);
            return {
              time, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +(c.v ?? 0),
              endTime: time + intervalSec * 1000,
            };
          }).filter((c) => Number.isFinite(c.close) && c.endTime <= now).sort((a, b) => a.time - b.time);
          if (data.length >= 20) { this.candleDataSource = 'real'; return data; }
        }
      } catch { /* fall through */ }
    }
    if (m?.symbol) {
      const publicCandles = await this._spotCandles(m.symbol, intervalSec, n);
      if (publicCandles.length >= 20) {
        this.candleDataSource = 'spot';
        return publicCandles;
      }
    }
    this.candleDataSource = 'synthetic';
    return synthCandles(this.prices.get(Number(marketId)) || 100, n);
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }
  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = `paper-${this._seq++}`;
    const sizeBase = Number(o.sizeBase);
    this.orders.set(id, {
      orderId: id, ...o, marketId: Number(o.marketId), sizeBase,
      remainingSize: sizeBase, fillEligibleAt: null,
    });
    return { orderId: id, price: Number(o.price), sizeBase };
  }
  async cancelOrder(_m, orderId) { this.orders.delete(orderId); return true; }
  async cancelAll(marketId) { for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id); return true; }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === Number(marketId)); }
  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => Number(o.marketId) === Number(marketId))
      .map((o) => ({
        orderId: String(o.orderId), price: Number(o.price), side: o.side,
        sizeBase: Number(o.sizeBase), remainingSize: Number(o.remainingSize ?? o.sizeBase),
        reduceOnly: !!o.reduceOnly, clientOrderId: o.clientOrderId,
      }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase, remainingSize, reduceOnly = false, clientOrderId }) {
    const id = String(orderId);
    const size = Number(sizeBase);
    this.orders.set(id, {
      orderId: id, marketId: Number(marketId), levelIndex, side,
      price: Number(price), sizeBase: size,
      remainingSize: Number(remainingSize) > 0 ? Number(remainingSize) : size,
      reduceOnly: Boolean(reduceOnly), clientOrderId, fillEligibleAt: null,
    });
    const match = id.match(/^paper-(\d+)$/);
    if (match) this._seq = Math.max(this._seq, Number(match[1]) + 1);
  }

  exportState() {
    return {
      version: 3,
      balance: this.balance,
      realizedPnl: this.realizedPnl,
      executionCosts: this.getExecutionCosts(),
      lastFundingAt: this.lastFundingAt,
      positions: [...this.positions.entries()],
      positionsByMarket: [...this.positions.entries()].map(([marketId, position]) => ({
        marketKey: this._marketKey(this.markets.get(Number(marketId))),
        position,
      })).filter((item) => item.marketKey),
      sequence: this._seq,
    };
  }

  restoreState(state, context = {}) {
    if (!state || typeof state !== 'object') return false;
    if (Number.isFinite(Number(state.balance))) this.balance = Number(state.balance);
    if (Number.isFinite(Number(state.realizedPnl))) this.realizedPnl = Number(state.realizedPnl);
    this.executionCosts = normalizeExecutionCosts(state.executionCosts);
    if (Number.isFinite(Number(state.lastFundingAt))) this.lastFundingAt = Number(state.lastFundingAt);
    if (Array.isArray(state.positionsByMarket)) {
      const byKey = new Map([...this.markets.entries()].map(([marketId, market]) => [this._marketKey(market), marketId]));
      this.positions = new Map(state.positionsByMarket.flatMap((item) => {
        const marketId = byKey.get(String(item?.marketKey || ''));
        return marketId == null ? [] : [[marketId, normalizePosition(item.position)]];
      }));
    } else if (Array.isArray(state.positions)) {
      // Legacy snapshots keyed positions by the market list index. That index
      // changes when Decibel open-interest ordering changes, so restoring every
      // entry can attach a BTC position to an unrelated market. Migrate only the
      // position belonging to the grid that produced this snapshot.
      const legacyMarketId = Number(context.legacyMarketId ?? context.marketId);
      const currentMarketId = Number(context.marketId);
      const legacy = state.positions.find(([marketId]) => Number(marketId) === legacyMarketId);
      this.positions = legacy && Number.isFinite(currentMarketId)
        ? new Map([[currentMarketId, normalizePosition(legacy[1])]])
        : new Map();
    }
    if (Number.isFinite(Number(state.sequence))) this._seq = Math.max(this._seq, Number(state.sequence));
    return true;
  }

  _marketKey(market) {
    if (!market) return '';
    return String(market.addr || market.displayName || market.name || market.symbol || '').toUpperCase();
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return null;
    const last = this.prices.get(Number(marketId));
    const unrealizedPnl = Number.isFinite(last) ? p.sizeBase * (last - p.entryPrice) : 0;
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl };
  }

  async refreshPositions() { return [...this.positions.values()]; }

  getExecutionCosts() {
    return normalizeExecutionCosts(this.executionCosts);
  }

  /** Treat a stopped, empty PAPER account change as a deposit/withdrawal. */
  setAccountEquity(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 1 || amount > 100_000_000) {
      throw new Error('模拟账户权益必须在 1-100,000,000 USDC 之间。');
    }
    if (this.orders.size > 0) throw new Error('仍有模拟挂单，不能调整账户权益。');
    if ([...this.positions.values()].some((position) => Math.abs(Number(position?.sizeBase) || 0) > 1e-12)) {
      throw new Error('仍有模拟持仓，不能调整账户权益。');
    }
    const previousEquity = this.balance;
    this.balance = Math.round(amount * 100) / 100;
    return {
      previousEquity,
      equity: this.balance,
      delta: this.balance - previousEquity,
    };
  }

  /** Close any open position at the current simulated price. */
  async closePosition(marketId) {
    const id = Number(marketId);
    const pos = this.positions.get(id);
    if (!pos || pos.sizeBase === 0) return true;
    const price = this.prices.get(id);
    this._applyFill(id, pos.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(pos.sizeBase));
    return true;
  }

  /** Immediate PAPER execution used by event-driven strategies such as Turtle. */
  async executeMarketOrder({ marketId, side, sizeBase, reduceOnly = false }) {
    const id = Number(marketId);
    if (!this.markets.has(id) && !this.prices.has(id)) throw new Error('模拟市价单市场不存在。');
    if (!['buy', 'sell'].includes(side)) throw new Error('模拟市价单方向无效。');
    const price = Number(this.prices.get(id));
    let quantity = Number(sizeBase);
    if (!(price > 0)) throw new Error('没有有效价格，无法执行模拟市价单。');
    if (!(quantity > 0)) throw new Error('模拟市价单数量必须大于 0。');
    const market = this.markets.get(id);
    if (Number(market?.minOrderSize) > 0 && quantity + 1e-12 < Number(market.minOrderSize)) {
      throw new Error(`模拟市价单数量低于市场最小下单量 ${market.minOrderSize}。`);
    }
    const position = this.positions.get(id);
    if (reduceOnly) {
      const current = Number(position?.sizeBase) || 0;
      const reduces = (side === 'sell' && current > 0) || (side === 'buy' && current < 0);
      if (!reduces) throw new Error('reduce-only 市价单不会减少当前持仓。');
      quantity = Math.min(quantity, Math.abs(current));
    }
    const costs = this._applyFill(id, side, price, quantity);
    const direction = side === 'buy' ? 1 : -1;
    const executionPrice = price * (1 + direction * (this.slippageBps + this.spreadBps) / 10_000);
    const result = {
      orderId: `paper-market-${this._seq++}`,
      marketId: id,
      side,
      referencePrice: price,
      executionPrice,
      price,
      sizeBase: quantity,
      reduceOnly: Boolean(reduceOnly),
      costs,
    };
    this.emit('fill', result);
    return result;
  }

  start() { if (!this._following) this._startLoops(); }   // no-op if already running
  stop() { /* keep price feed alive across bot stop/start */ }

  /** Fully tear down timers when the exchange instance is being replaced. */
  dispose() {
    if (this._following && this._onSharedPrice) this._following.off('price', this._onSharedPrice);
    this._following = null;
    this._onSharedPrice = null;
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._spotTimer) { clearInterval(this._spotTimer); this._spotTimer = null; }
  }

  _startLoops() {
    if (!this._tickTimer) { this._tickTimer = setInterval(() => this._tick(), this.tickMs); this._tickTimer.unref?.(); }
    if (this.dataSource === 'real' && !this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollReal(), this.pollMs); this._pollTimer.unref?.();
    }
    if (this.dataSource === 'spot' && !this._spotTimer) {
      this._spotTimer = setInterval(() => this._pollSpot(false), 15000); this._spotTimer.unref?.();
    }
    if (this.dataSource === 'synthetic' && !this._spotTimer) {
      this._spotTimer = setInterval(async () => {
        if (await this._pollSpot(false)) {
          this.dataSource = 'spot';
          console.log('[模拟模式] 公共现货行情已恢复，切换到 Coinbase/Binance 价格源。');
        }
      }, 15000);
      this._spotTimer.unref?.();
    }
  }

  /** Poll public spot prices (no key needed) to anchor the simulated price path. */
  async _pollSpot(seed) {
    const markets = [...this.markets.values()].filter((m) => m.symbol);
    if (!markets.length) return false;
    let ok = false;
    for (const m of markets) {
      const price = await this._spotPrice(m.symbol);
      if (!price) continue;
      m.lastPrice = price;
      this.realTarget.set(m.marketId, price);
      if (seed) this.prices.set(m.marketId, price);
      ok = true;
    }
    return ok;
  }

  async _spotPrice(symbol) {
    const upper = String(symbol).toUpperCase();
    try {
      const res = await fetch(`https://api.coinbase.com/v2/prices/${upper}-USD/spot`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        const price = Number(j?.data?.amount);
        if (price > 0) return price;
      }
    } catch { /* try next source */ }
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${upper}USDT`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        const price = Number(j?.price);
        if (price > 0) return price;
      }
    } catch { /* no public feed reachable */ }
    return null;
  }

  async _spotCandles(symbol, intervalSec, n) {
    const upper = String(symbol).toUpperCase();
    const seconds = Number(intervalSec);
    const limit = Math.min(1000, Math.max(20, Number(n) || 200));
    if (seconds === 14400) {
      const hourly = await this._coinbaseCandles(upper, 3600, limit * 4 + 8);
      const aggregated = aggregateCandles(hourly, 14_400_000, 3_600_000)
        .filter((candle) => candle.endTime <= Date.now())
        .slice(-limit);
      if (aggregated.length >= 20) return aggregated;
    }
    if (COINBASE_GRANULARITIES.has(seconds)) {
      const candles = await this._coinbaseCandles(upper, seconds, limit);
      if (candles.length >= 20) return candles;
    }
    try {
      const interval = INTERVALS[intervalSec] || '1h';
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${upper}USDT&interval=${interval}&limit=${limit}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const rows = await res.json();
        const now = Date.now();
        return (Array.isArray(rows) ? rows : []).map((row) => ({
          time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
          low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) || 0,
          endTime: Number(row[6]) + 1,
        })).filter((candle) => validCandle(candle) && candle.endTime <= now)
          .sort((a, b) => a.time - b.time).slice(-limit);
      }
    } catch { /* no public candle feed reachable */ }
    return [];
  }

  async _coinbaseCandles(symbol, intervalSec, n) {
    const intervalMs = Number(intervalSec) * 1000;
    const wanted = Math.min(5000, Math.max(20, Number(n) || 200));
    const latestComplete = Math.floor(Date.now() / intervalMs) * intervalMs;
    const chunks = Math.ceil(wanted / COINBASE_CANDLE_CHUNK);
    const byTime = new Map();
    let cursorEnd = latestComplete;
    try {
      for (let index = 0; index < chunks; index++) {
        const remaining = wanted - index * COINBASE_CANDLE_CHUNK;
        const count = Math.min(COINBASE_CANDLE_CHUNK, remaining);
        const start = cursorEnd - count * intervalMs;
        const query = new URLSearchParams({
          granularity: String(intervalSec),
          start: new Date(start).toISOString(),
          end: new Date(cursorEnd).toISOString(),
        });
        const res = await fetch(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles?${query}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [];
        const rows = await res.json();
        for (const row of Array.isArray(rows) ? rows : []) {
          const candle = {
            time: Number(row[0]) * 1000,
            low: Number(row[1]), high: Number(row[2]),
            open: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) || 0,
          };
          candle.endTime = candle.time + intervalMs;
          if (validCandle(candle) && candle.endTime <= latestComplete) byTime.set(candle.time, candle);
        }
        cursorEnd = start;
      }
    } catch { return []; }
    return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-wanted);
  }

  // Price feed: Decibel first; if it stays unreachable (e.g. VPN dropped),
  // fall back to public spot prices so the simulated path keeps tracking the
  // real market instead of freezing at the last known target.
  async _pollReal() {
    if (await this._fetchRealTargets()) {
      this._lastRealOk = Date.now();
      return;
    }
    if (Date.now() - (this._lastRealOk || 0) > 30000) await this._pollSpot(false);
  }

  async _fetchRealTargets() {
    try {
      const res = await fetch(`${this.apiUrl}/api/v1/prices`, { headers: this._headers(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return false;
      const j = await res.json();
      if (!Array.isArray(j)) return false;
      const byAddr = new Map(j.map((p) => [String(p.market), p]));
      let found = false;
      for (const [id, m] of this.markets) {
        const px = byAddr.get(m.addr);
        const price = Number(px?.mid_px || px?.mark_px || px?.oracle_px || 0);
        if (price) { this.realTarget.set(id, price); found = true; }
      }
      return found;
    } catch { return false; }
  }

  _tick() {
    this.lastOkAt = Date.now();
    this._applyFunding(this.lastOkAt);
    for (const [id, price] of this.prices) {
      let next;
      if (this.dataSource === 'real' || this.dataSource === 'spot') {
        // ease the displayed price toward the latest real target
        const target = this.realTarget.get(id) ?? price;
        next = price + (target - price) * 0.25;
        if (Math.abs(next - target) / target < 1e-5) next = target;
      } else {
        const seed = this.markets.get(id)?.lastPrice || price;
        const drift = (seed - price) / seed * 0.02;
        const shock = (Math.random() * 2 - 1) * this.volPerTick;
        next = Math.max(0.0001, price * (1 + drift + shock));
      }
      this.prices.set(id, next);
      const market = this.markets.get(id);
      if (market) market.lastPrice = next;
      this.emit('price', { marketId: id, price: next });
      this._matchFills(id, price, next);
    }
  }

  _matchFills(marketId, prev, cur) {
    for (const o of [...this.orders.values()]) {
      if (!this.orders.has(o.orderId)) continue;
      if (o.marketId !== marketId) continue;
      const crossedBuy = o.side === 'buy' && cur <= o.price;
      const crossedSell = o.side === 'sell' && cur >= o.price;
      if (!crossedBuy && !crossedSell) continue;
      if (o.reduceOnly && !this._reduces(marketId, o.side)) { this.orders.delete(o.orderId); continue; }
      const now = Date.now();
      if (o.fillEligibleAt == null) o.fillEligibleAt = now + Math.max(0, this.fillDelayMs);
      if (now < o.fillEligibleAt) continue;
      const remainingBefore = Number(o.remainingSize ?? o.sizeBase);
      let fillSize = remainingBefore;
      if (remainingBefore > 0 && this.partialFillProbability > 0 && this.random() < this.partialFillProbability) {
        const candidate = remainingBefore * this.partialFillRatio;
        if (candidate > 1e-12 && remainingBefore - candidate > 1e-12) fillSize = candidate;
      }
      if (o.reduceOnly) {
        const position = this.positions.get(marketId);
        fillSize = Math.min(fillSize, Math.abs(Number(position?.sizeBase) || 0));
      }
      if (!(fillSize > 0)) { this.orders.delete(o.orderId); continue; }
      const remainingSize = Math.max(0, remainingBefore - fillSize);
      if (remainingSize <= 1e-12) this.orders.delete(o.orderId);
      else {
        o.remainingSize = remainingSize;
        o.sizeBase = remainingSize;
        o.fillEligibleAt = now + Math.max(0, this.fillDelayMs);
      }
      const costs = this._applyFill(marketId, o.side, o.price, fillSize);
      this.emit('fill', {
        orderId: o.orderId, marketId, side: o.side, price: o.price,
        sizeBase: fillSize, remainingSize, partial: remainingSize > 0,
        levelIndex: o.levelIndex, clientOrderId: o.clientOrderId, costs,
      });
      // Process at most one resting order per market tick. This gives inventory
      // protection a chance to cancel newly-dangerous orders after a gap move.
      break;
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty) {
    const notional = price * qty;
    const costs = {
      fees: notional * this.feeRate,
      slippage: notional * this.slippageBps / 10_000,
      spread: notional * this.spreadBps / 10_000,
      funding: 0,
    };
    const executionCost = costs.fees + costs.slippage + costs.spread;
    this.balance -= executionCost;
    this.realizedPnl -= executionCost;
    this.executionCosts.fees += costs.fees;
    this.executionCosts.slippage += costs.slippage;
    this.executionCosts.spread += costs.spread;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    if (p.sizeBase === 0 || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const newSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(newSize);
      p.sizeBase = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closeQty * (price - p.entryPrice) : closeQty * (p.entryPrice - price);
      this.realizedPnl += pnl; this.balance += pnl;
      const remaining = p.sizeBase + signed;
      if (Math.sign(remaining) === Math.sign(p.sizeBase) || remaining === 0) { p.sizeBase = remaining; if (remaining === 0) p.entryPrice = 0; }
      else { p.sizeBase = remaining; p.entryPrice = price; }
    }
    this.positions.set(marketId, p);
    return { ...costs, total: executionCost };
  }

  _applyFunding(now = Date.now()) {
    if (!(this.fundingIntervalMs > 0) || !(this.fundingRate !== 0)) return;
    if (!Number.isFinite(this.lastFundingAt)) this.lastFundingAt = now;
    const periods = Math.floor((now - this.lastFundingAt) / this.fundingIntervalMs);
    if (periods <= 0) return;
    for (let period = 0; period < periods; period++) {
      for (const [marketId, position] of this.positions) {
        if (!position?.sizeBase) continue;
        const price = this.prices.get(marketId) || position.entryPrice;
        const payment = position.sizeBase * price * this.fundingRate;
        this.balance -= payment;
        this.realizedPnl -= payment;
        this.executionCosts.funding += payment;
      }
    }
    this.lastFundingAt += periods * this.fundingIntervalMs;
  }
}

function synthCandles(start, n) {
  const out = []; let price = start; let t = Date.now() - n * 3600_000;
  const regime = Math.random() < 0.34 ? 0.0012 : Math.random() < 0.5 ? -0.0012 : 0;
  for (let i = 0; i < n; i++) {
    const open = price, close = price * (1 + regime + (Math.random() * 2 - 1) * 0.006);
    out.push({ time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close; t += 3600_000;
  }
  return out;
}

function isBtcUsd(value) {
  const label = value && (value.displayName || value.name);
  if (label) return String(label).toUpperCase().replace(/[^A-Z0-9]/g, '') === 'BTCUSD';
  return String(value?.symbol || value || '').toUpperCase() === 'BTC';
}

function normalizePosition(position) {
  return {
    sizeBase: Number(position?.sizeBase || 0),
    entryPrice: Number(position?.entryPrice || 0),
  };
}

function emptyExecutionCosts() {
  return { fees: 0, slippage: 0, spread: 0, funding: 0, total: 0 };
}

function normalizeExecutionCosts(costs) {
  const normalized = {
    fees: Number(costs?.fees) || 0,
    slippage: Number(costs?.slippage) || 0,
    spread: Number(costs?.spread) || 0,
    funding: Number(costs?.funding) || 0,
  };
  normalized.total = normalized.fees + normalized.slippage + normalized.spread + normalized.funding;
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, Math.round(value * 1e8) / 1e8]));
}

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function validCandle(candle) {
  return Number.isFinite(candle.time) && candle.time > 0
    && Number.isFinite(candle.open) && candle.open > 0
    && Number.isFinite(candle.high) && candle.high > 0
    && Number.isFinite(candle.low) && candle.low > 0
    && Number.isFinite(candle.close) && candle.close > 0;
}
