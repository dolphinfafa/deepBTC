import { aiChat, extractJson, getAiConfig, publicAiConfig, xaiSearch } from './provider.js';
import { analyzeTrend } from '../trend.js';
import { buildLargeCycleAnalysis, LARGE_CYCLE_TIMEFRAMES } from './regime.js';
import { analyzeHistoricalFrames } from './historical-proxy.js';
import {
  buildSentimentChannelPrompt,
  buildSentimentMergePrompt,
  combineSentimentSearchResults,
  normalizeSentimentReport,
  SENTIMENT_POLICY,
  SENTIMENT_STRATEGY_ID,
} from './sentiment.js';
import { loadSnapshot, saveSnapshot } from '../persist.js';

export function createAiService({ getBot, getExchange, notify, onMarketAnalysis, onSentiment, getAutopilotStatus }) {
  const service = new AiService(getBot, getExchange, notify, onMarketAnalysis, onSentiment, getAutopilotStatus);
  service.start();
  return service;
}

export class AiService {
  constructor(getBot, getExchange, notify, onMarketAnalysis, onSentiment, getAutopilotStatus) {
    this.getBot = getBot;
    this.getExchange = getExchange;
    this.notify = notify;
    this.onMarketAnalysis = onMarketAnalysis;
    this.onSentiment = onSentiment;
    this.getAutopilotStatus = getAutopilotStatus;
    this.sentinel = null;
    this.sentinelError = null;
    this.report = null;
    this.market = null;
    this.marketError = null;
    this.sentiment = null;
    this.sentimentError = null;
    this.sentimentHistory = [];
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
      this.sentiment = saved.sentiment || null;
      this.sentimentHistory = Array.isArray(saved.sentimentHistory) ? saved.sentimentHistory.slice(0, 200) : [];
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
      sentiment: this.sentiment,
      sentimentError: this.sentimentError,
      sentimentHistory: this.sentimentHistory.slice(0, 20),
      outOfRangeAdvice: this.outOfRangeAdvice,
      oorAdvice: this.outOfRangeAdvice ? { de: this.outOfRangeAdvice } : {},
      autopilot: this.getAutopilotStatus?.() || null,
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
    const now = Date.now();
    if (config.apiKey && config.sentinelMinutes > 0 && now - this.lastRun.sentinel >= config.sentinelMinutes * 60_000) {
      this.lastRun.sentinel = now;
      await this.runSentinel(true).catch(() => {});
    }
    if (config.marketMinutes > 0 && now - this.lastRun.market >= config.marketMinutes * 60_000) {
      this.lastRun.market = now;
      const analysis = await this.analyze().catch(() => null);
      if (analysis) await this.onMarketAnalysis?.(analysis).catch(() => {});
    }
    const day = new Date().toISOString().slice(0, 10);
    if (config.apiKey && config.reportHour >= 0 && new Date().getHours() === config.reportHour && this.lastReportDay !== day) {
      this.lastReportDay = day;
      await this.makeReport(true).catch(() => {});
    }
  }

  async analyze(marketId, { forceSentiment = false } = {}) {
    try {
      const result = await this.once('market', async () => {
      const bot = this.getBot();
      const exchange = this.getExchange();
      const markets = await exchange.getMarkets();
      const market = markets.find((item) => item.marketId === Number(marketId)) || markets.find((item) => /BTC/i.test(item.displayName)) || markets[0];
      if (!market) throw new Error('没有可分析的 Decibel 市场。');
      const frames = {};
      const candleSources = {};
      const completedSeries = {};
      const now = Date.now();
      for (const { id, seconds } of LARGE_CYCLE_TIMEFRAMES) {
        try {
          const candles = await exchange.getCandles(market.marketId, seconds, 200);
          candleSources[id] = exchange.candleDataSource || exchange.dataSource || 'unknown';
          assertAutomaticCandleSource(id, candleSources[id]);
          const completed = normalizeCompletedSeries(candles, seconds, now);
          completedSeries[id] = completed;
          if (completed.length >= 51) frames[id] = analyzeTrend(completed);
        } catch { /* one missing timeframe is acceptable */ }
      }
      assertAutomaticCandleSources(candleSources);
      if (!Object.keys(frames).length) throw new Error('K 线数据不足，暂时无法生成 AI 分析。');
      const price = await exchange.getPrice(market.marketId);
      const state = bot.getState();
      const cycle = buildLargeCycleAnalysis(frames);
      const signalTime = completedSeries.h1?.at(-1)?.endTime || null;
      const autopilot = this.getAutopilotStatus?.();
      let sentiment = null;
      let sentimentError = null;
      if (autopilot?.effective && autopilot.strategyId === SENTIMENT_STRATEGY_ID) {
        try {
          sentiment = await this.analyzeSentiment({ market: market.displayName, force: forceSentiment });
        } catch (error) {
          sentimentError = error?.message || String(error);
          this.sentimentError = sentimentError;
          sentiment = this.sentiment;
        }
      }
      let narrative = null;
      let narrativeError = null;
      if (getAiConfig().apiKey && !(autopilot?.effective && autopilot.strategyId === SENTIMENT_STRATEGY_ID)) {
        try {
          const response = await aiChat({
            json: true,
            system: [
              '你是 Decibel 永续合约网格策略复核助手，只解释确定性大周期状态，不决定交易方向。',
              '执行方向已经由 1D、4H、1H 已完成 K 线规则确定，不得修改 regime、suitable、mode 或 confidence。',
              '只输出 JSON：{"reasoning":"中文分析","caution":"中文风险提示"}。',
            ].join('\n'),
            messages: [{ role: 'user', content: JSON.stringify({ market: market.displayName, price, frames, cycle, grid: state.config, running: state.running, equity: state.equity, risk: state.risk }) }],
          });
          narrative = extractJson(response);
        } catch (error) {
          narrativeError = error?.message || String(error);
        }
      }
      this.market = {
        t: Date.now(), signalTime, marketId: market.marketId, market: market.displayName, price, frames, candleSources,
        ...cycle,
        sentiment,
        sentimentError,
        reasoning: String(narrative?.reasoning || cycle.reasoning),
        caution: String(narrative?.caution || cycle.caution),
        aiNarrative: Boolean(narrative),
        aiNarrativeError: narrativeError,
      };
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

  async analyzeSentiment({ market = 'BTC-USD', force = false } = {}) {
    return this.once('sentiment', async () => {
      const now = Date.now();
      const cacheMs = Math.max(60_000, (SENTIMENT_POLICY.intervalMinutes - 2) * 60_000);
      if (!force && Number(this.sentiment?.observedAt) > 0 && now - Number(this.sentiment.observedAt) < cacheMs) {
        return this.sentiment;
      }
      const config = getAiConfig();
      if (!config.apiKey) throw new Error('Grok 情绪策略尚未配置 xAI API Key。');
      if (config.provider !== 'xai') throw new Error('Grok 情绪策略要求 AI Provider 为 xAI。');
      const fromDate = new Date(now - SENTIMENT_POLICY.windowHours * 3_600_000).toISOString().slice(0, 10);
      const toDate = new Date(now).toISOString().slice(0, 10);
      const webSearchTask = () => xaiSearch({
        prompt: buildSentimentChannelPrompt({ channel: 'web', now, market }),
        tools: [{ type: 'web_search' }],
        maxTokens: 650,
        timeoutMs: 20_000,
      });
      const xSearchTask = () => xaiSearch({
          prompt: buildSentimentChannelPrompt({ channel: 'x', now, market }),
          tools: [{ type: 'x_search', from_date: fromDate, to_date: toDate }],
          maxTokens: 650,
          timeoutMs: 45_000,
        });
      const nativeXai = isNativeXaiEndpoint(config.baseUrl);
      const searches = nativeXai
        ? await Promise.allSettled([xSearchTask(), webSearchTask()])
        : await runSettledSequentially([xSearchTask, webSearchTask], [1, 0]);
      const channelNames = ['X Search', 'Web Search'];
      const failures = searches
        .map((result, index) => result.status === 'rejected' ? `${channelNames[index]}：${result.reason?.message || result.reason}` : null)
        .filter(Boolean);
      if (failures.length) throw new Error(`Grok 分渠道搜索失败：${failures.join('；')}`);
      const searchResults = combineSentimentSearchResults(searches[0].value, searches[1].value);
      const response = await xaiSearch({
        prompt: buildSentimentMergePrompt({ now, market, searchResults }),
        tools: [],
        maxTokens: 1_800,
        timeoutMs: 20_000,
      });
      const parsed = extractJson(response.text);
      if (!parsed) throw new Error('Grok 搜索没有返回可解析的情绪 JSON。');
      const report = normalizeSentimentReport(parsed, {
        now,
        citations: searchResults.citations,
        model: response.model,
      });
      this.sentiment = report;
      this.sentimentError = null;
      this.sentimentHistory.unshift(report);
      if (this.sentimentHistory.length > 200) this.sentimentHistory.length = 200;
      this.save();
      await this.onSentiment?.(report, {
        responseId: response.responseId,
        searchResponseIds: searchResults.responseIds,
        usage: { ...searchResults.usage, merge: response.usage || null },
      });
      return report;
    });
  }

  async analyzeHistory(marketId, count = 12) {
    try {
      const result = await this.once('market', async () => {
        const exchange = this.getExchange();
        const markets = await exchange.getMarkets();
        const market = markets.find((item) => item.marketId === Number(marketId))
          || markets.find((item) => /BTC/i.test(item.displayName)) || markets[0];
        if (!market) throw new Error('没有可分析的 Decibel 市场。');

        const now = Date.now();
        const series = {};
        const candleSources = {};
        for (const { id, seconds } of LARGE_CYCLE_TIMEFRAMES) {
          const candles = await exchange.getCandles(market.marketId, seconds, 200);
          candleSources[id] = exchange.candleDataSource || exchange.dataSource || 'unknown';
          assertAutomaticCandleSource(id, candleSources[id]);
          series[id] = normalizeCompletedSeries(candles, seconds, now);
        }
        assertAutomaticCandleSources(candleSources);
        const latestSignalTime = series.h1?.at(-1)?.endTime;
        if (!(latestSignalTime > 0)) throw new Error('BTC 1H 已完成 K 线不足，无法回放启动确认。');

        const requested = Math.min(24, Math.max(1, Math.round(Number(count) || 12)));
        const analyses = [];
        for (let offset = requested - 1; offset >= 0; offset--) {
          const signalTime = latestSignalTime - offset * 3_600_000;
          const frames = analyzeHistoricalFrames(series, signalTime, 200);
          const cycle = buildLargeCycleAnalysis(frames);
          const h1Window = completedWindow(series.h1, signalTime);
          analyses.push({
            t: signalTime,
            signalTime,
            marketId: market.marketId,
            market: market.displayName,
            price: h1Window.at(-1)?.close || null,
            candleSources,
            ...cycle,
          });
        }
        this.market = analyses.at(-1) || null;
        this.save();
        return analyses;
      });
      this.marketError = null;
      return result;
    } catch (error) {
      this.marketError = error?.message || String(error);
      throw error;
    }
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
      sentiment: this.sentiment,
      sentimentHistory: this.sentimentHistory.slice(0, 200),
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

export function assertAutomaticCandleSources(sources = {}) {
  for (const [timeframe, source] of Object.entries(sources)) assertAutomaticCandleSource(timeframe, source);
  return true;
}

function assertAutomaticCandleSource(timeframe, source) {
  if (source !== 'synthetic') return;
  const label = LARGE_CYCLE_TIMEFRAMES.find((frame) => frame.id === timeframe)?.label || timeframe;
  throw new Error(`${label}公共 K 线不可用，禁止使用合成数据判断自动策略。`);
}

function normalizeCompletedSeries(candles, intervalSec, now = Date.now()) {
  const intervalMs = Number(intervalSec) * 1000;
  const byTime = new Map();
  for (const item of candles || []) {
    const time = Number(item?.time);
    const endTime = Number(item?.endTime) || time + intervalMs;
    if (!(Number.isFinite(time) && Number.isFinite(endTime) && endTime <= now)) continue;
    byTime.set(time, { ...item, time, endTime });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function completedWindow(candles, at) {
  return (candles || []).filter((candle) => candle.endTime <= at);
}

function isNativeXaiEndpoint(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase() === 'api.x.ai'; }
  catch { return false; }
}

async function runSettledSequentially(tasks, order) {
  const results = Array(tasks.length);
  for (const index of order) {
    try { results[index] = { status: 'fulfilled', value: await tasks[index]() }; }
    catch (error) { results[index] = { status: 'rejected', reason: error }; }
  }
  return results;
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
