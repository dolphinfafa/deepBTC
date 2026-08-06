import { aiChat, extractJson, getAiConfig, publicAiConfig } from './provider.js';
import { analyzeTrend } from '../trend.js';
import { loadSnapshot, saveSnapshot } from '../persist.js';

export function createAiService({ getBot, getExchange, notify }) {
  const service = new AiService(getBot, getExchange, notify);
  service.start();
  return service;
}

class AiService {
  constructor(getBot, getExchange, notify) {
    this.getBot = getBot;
    this.getExchange = getExchange;
    this.notify = notify;
    this.sentinel = null;
    this.sentinelError = null;
    this.report = null;
    this.market = null;
    this.marketError = null;
    this.outOfRangeAdvice = null;
    this.lastRun = { sentinel: 0, market: 0 };
    this.lastReportDay = null;
    this.wasOutOfRange = false;
    this.busy = new Set();
    this.sentinelHistory = [];
    this.lastPushLevel = 'ok';
    this.lastPushAt = 0;
    const saved = loadSnapshot('ai');
    if (saved) {
      this.sentinel = saved.sentinel || null;
      this.sentinelHistory = Array.isArray(saved.sentinelHistory) ? saved.sentinelHistory.slice(0, 20) : [];
      this.report = saved.report || null;
      this.market = saved.market || null;
      this.outOfRangeAdvice = saved.outOfRangeAdvice || null;
      this.baseline = saved.baseline || null;
      this.lastReportDay = saved.lastReportDay || null;
    }
    if (!this.baseline) this.baseline = this.captureBaseline();
  }

  status() {
    const config = publicAiConfig();
    return {
      config,
      configured: config.configured,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      modelSmall: config.modelSmall,
      sentinelMinutes: config.sentinelMinutes,
      marketMinutes: config.marketMinutes,
      reportHour: config.reportHour,
      sentinel: this.sentinel,
      sentinelError: this.sentinelError,
      sentinelHistory: this.sentinelHistory.slice(0, 10),
      report: this.report,
      market: this.market,
      marketError: this.marketError,
      outOfRangeAdvice: this.outOfRangeAdvice,
      oorAdvice: this.outOfRangeAdvice ? { de: this.outOfRangeAdvice } : {},
    };
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 60_000);
    this.timer.unref?.();
    this.outOfRangeTimer = setInterval(() => this.checkOutOfRange().catch(() => {}), 30_000);
    this.outOfRangeTimer.unref?.();
  }

  async tick() {
    const config = getAiConfig();
    if (!config.apiKey) return;
    const now = Date.now();
    if (config.sentinelMinutes > 0 && now - this.lastRun.sentinel >= config.sentinelMinutes * 60_000) {
      this.lastRun.sentinel = now;
      await this.runSentinel(true).catch(() => {});
    }
    if (config.marketMinutes > 0 && now - this.lastRun.market >= config.marketMinutes * 60_000) {
      this.lastRun.market = now;
      await this.analyze().catch(() => {});
    }
    const day = new Date().toISOString().slice(0, 10);
    if (config.reportHour >= 0 && new Date().getHours() === config.reportHour && this.lastReportDay !== day) {
      this.lastReportDay = day;
      await this.makeReport(true).catch(() => {});
    }
  }

  async analyze(marketId) {
    try {
      const result = await this.once('market', async () => {
      const bot = this.getBot();
      const exchange = this.getExchange();
      const markets = await exchange.getMarkets();
      const market = markets.find((item) => item.marketId === Number(marketId)) || markets.find((item) => /BTC/i.test(item.displayName)) || markets[0];
      if (!market) throw new Error('没有可分析的 Decibel 市场。');
      const frames = {};
      for (const [label, seconds] of [['4小时', 14400], ['1小时', 3600], ['15分钟', 900]]) {
        try {
          const candles = await exchange.getCandles(market.marketId, seconds, 200);
          if (candles?.length >= 20) frames[label] = analyzeTrend(candles);
        } catch { /* one missing timeframe is acceptable */ }
      }
      if (!Object.keys(frames).length) throw new Error('K 线数据不足，暂时无法生成 AI 分析。');
      const price = await exchange.getPrice(market.marketId);
      const state = bot.getState();
      const response = await aiChat({
        json: true,
        system: [
          '你是 Decibel 永续合约网格策略顾问。AI 只提供建议，不执行交易。',
          '结合多周期趋势、ATR、当前价格和网格状态判断是否适合运行网格。',
          '输出 JSON：{"regime":"震荡|上涨|下跌|剧烈波动","suitable":true,"mode":"neutral|long|short","confidence":0.0,"lower":0,"upper":0,"gridCount":20,"sizeBase":0.001,"reasoning":"中文分析","caution":"中文风险提示"}',
          '建议区间必须包含当前价格，格距应覆盖手续费和常见滑点；sizeBase 要结合账户权益保守估算。',
        ].join('\n'),
        messages: [{ role: 'user', content: JSON.stringify({ market: market.displayName, price, frames, grid: state.config, running: state.running, equity: state.equity, risk: state.risk }) }],
      });
      const result = extractJson(response);
      if (!result) throw new Error('AI 返回内容无法解析。');
      this.market = { t: Date.now(), marketId: market.marketId, market: market.displayName, price, frames, ...result };
      this.save();
      return this.market;
      });
      this.marketError = null;
      return result;
    } catch (error) {
      this.marketError = error?.message || String(error);
      throw error;
    }
  }

  async runMarketAnalysis() {
    return this.analyze();
  }

  async runSentinel(push = false) {
    try {
      const result = await this.once('sentinel', async () => {
      const state = compactState(this.getBot().getState());
      const response = await aiChat({
        small: true, json: true, maxTokens: 800, temperature: 0.1,
        system: [
          '你是 Decibel 网格机器人的风控值守助手。检查权益、浮亏、持仓、出区间状态、挂单同步和近期告警。',
          '输出 JSON：{"level":"ok|warn|critical","summary":"中文结论","advice":"可执行建议"}。',
          '模拟盘问题可以降级；不得声称已经执行任何交易操作。',
        ].join('\n'),
        messages: [{ role: 'user', content: JSON.stringify(state) }],
      });
      this.sentinel = { t: Date.now(), ...(extractJson(response) || { level: 'warn', summary: response.slice(0, 300), advice: '' }) };
      this.sentinelHistory.unshift(this.sentinel);
      if (this.sentinelHistory.length > 20) this.sentinelHistory.pop();
      this.save();
      const level = this.sentinel.level || 'ok';
      const shouldPush = push && level !== 'ok'
        && (level !== this.lastPushLevel || Date.now() - this.lastPushAt > 30 * 60_000);
      if (shouldPush) {
        this.lastPushAt = Date.now();
        await this.notify?.(`【GridPilot AI 风控】${this.sentinel.summary}\n${this.sentinel.advice || ''}`).catch(() => {});
      }
      this.lastPushLevel = level;
      return this.sentinel;
      });
      this.sentinelError = null;
      return result;
    } catch (error) {
      this.sentinelError = error?.message || String(error);
      throw error;
    }
  }

  async makeReport(push = false) {
    return this.once('report', async () => {
      const state = compactState(this.getBot().getState());
      const baseline = this.baseline || this.captureBaseline();
      const diff = periodDiff(state, baseline.state);
      const sinceHours = Math.round((Date.now() - baseline.t) / 3600000 * 10) / 10;
      const text = await aiChat({
        maxTokens: 1000, temperature: 0.35,
        system: '你是 Decibel 网格交易复盘助手。根据状态生成 300 字以内中文复盘：盈亏、成交活跃度、风险、下一步建议。模拟盘必须注明。不得声称执行交易。',
        messages: [{ role: 'user', content: JSON.stringify({ periodHours: sinceHours, current: state, changes: diff }) }],
      });
      this.report = { t: Date.now(), periodHours: sinceHours, changes: diff, text: text.trim() };
      this.baseline = this.captureBaseline();
      this.save();
      if (push) await this.notify?.(`【GridPilot AI 复盘】\n${this.report.text}`).catch(() => {});
      return this.report;
    });
  }

  async adviseOutOfRange() {
    return this.once('outOfRange', async () => {
      const state = compactState(this.getBot().getState());
      const response = await aiChat({
        json: true, maxTokens: 700, temperature: 0.2,
        system: '你是 Decibel 网格风险助手。价格已冲出网格区间。输出 JSON：{"suggestion":"close|recover|adjust|wait","reasoning":"中文理由","caution":"风险提示"}。只给建议，不执行交易。',
        messages: [{ role: 'user', content: JSON.stringify(state) }],
      });
      this.outOfRangeAdvice = { t: Date.now(), ...(extractJson(response) || { suggestion: 'wait', reasoning: response.slice(0, 300), caution: '' }) };
      this.save();
      return this.outOfRangeAdvice;
    });
  }

  async checkOutOfRange() {
    const state = this.getBot().getState();
    const current = Boolean(state.running && state.outOfRange);
    if (current && !this.wasOutOfRange && getAiConfig().apiKey) {
      const advice = await this.adviseOutOfRange();
      await this.notify?.(`【GridPilot 出区间建议】${advice.reasoning}\n${advice.caution || ''}`).catch(() => {});
    }
    this.wasOutOfRange = current;
  }

  async chat(message, history = []) {
    const state = compactState(this.getBot().getState());
    const response = await aiChat({
      json: true,
      system: [
        '你是 GridPilot 的 Decibel 单交易所助手。根据实时状态回答中文问题。',
        '你不能直接执行操作，只能提出一个由用户确认的 action。',
        'action.type 只允许 none|fill_params|adjust_range|reconnect|cancel_orders|stop_grid|close_position|start_recovery|start_grid；params 为参数对象。',
        'stop_grid 的 params.closePosition 必须明确为 true 或 false；start_recovery 需要 spacing、sizeBase、aboveEntryOnly；start_grid 需要完整网格参数。',
        '输出 JSON：{"reply":"中文回复","riskLevel":"ok|warn|critical","action":{"type":"none","params":{}}}。',
      ].join('\n'),
      messages: [
        ...history.slice(-8).map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content).slice(0, 2000) })),
        { role: 'user', content: `实时状态：${JSON.stringify(state)}\n用户问题：${String(message).slice(0, 2000)}` },
      ],
    });
    const result = extractJson(response) || { reply: response.slice(0, 1200), riskLevel: 'warn', action: { type: 'none', params: {} } };
    const allowed = new Set(['none', 'fill_params', 'adjust_range', 'reconnect', 'cancel_orders', 'stop_grid', 'close_position', 'start_recovery', 'start_grid']);
    if (!result.action || !allowed.has(result.action.type)) result.action = { type: 'none', params: {} };
    return result;
  }

  async chatControl(message, history = []) {
    return this.chat(message, history);
  }

  async test() {
    const startedAt = Date.now();
    const reply = await aiChat({ maxTokens: 50, temperature: 0, messages: [{ role: 'user', content: '只回复“连接正常”四个字。' }] });
    const config = getAiConfig();
    return { ok: true, ms: Date.now() - startedAt, provider: config.provider, model: config.model, reply: reply.trim().slice(0, 50) };
  }

  captureBaseline() {
    return { t: Date.now(), state: compactState(this.getBot().getState()) };
  }

  save() {
    saveSnapshot('ai', {
      sentinel: this.sentinel,
      sentinelHistory: this.sentinelHistory.slice(0, 20),
      report: this.report,
      market: this.market,
      outOfRangeAdvice: this.outOfRangeAdvice,
      baseline: this.baseline,
      lastReportDay: this.lastReportDay,
    });
  }

  async once(name, task) {
    if (this.busy.has(name)) throw new Error('同类 AI 任务正在运行，请稍候。');
    this.busy.add(name);
    try { return await task(); }
    finally { this.busy.delete(name); }
  }
}

function periodDiff(current, baseline = {}) {
  const delta = (value, previous) => Number.isFinite(Number(value)) && Number.isFinite(Number(previous))
    ? Math.round((Number(value) - Number(previous)) * 100) / 100 : null;
  return {
    equity: delta(current.equity, baseline.equity),
    realizedPnl: delta(current.realizedPnl, baseline.realizedPnl),
    unrealizedPnl: delta(current.unrealizedPnl, baseline.unrealizedPnl),
    completedRungs: delta(current.stats?.completedRungs, baseline.stats?.completedRungs),
    volume: delta(current.stats?.volume, baseline.stats?.volume),
  };
}

function compactState(state) {
  return {
    mode: state.mode,
    running: state.running,
    recovery: state.recovery,
    config: state.config,
    lastPrice: state.lastPrice,
    equity: state.equity,
    balance: state.balance,
    realizedPnl: state.realizedPnl,
    unrealizedPnl: state.unrealizedPnl,
    returnPct: state.returnPct,
    position: state.position,
    openOrders: state.openOrders,
    exchangeOpenOrders: state.exchangeOpenOrders,
    outOfRange: state.outOfRange,
    risk: state.risk,
    stats: state.stats,
    alerts: (state.alerts || []).slice(0, 8),
  };
}
