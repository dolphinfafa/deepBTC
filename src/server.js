import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getConfig, saveRiskPolicy, ROOT } from './config.js';
import { createExchange } from './exchange/de/index.js';
import { analyzeTrend } from './trend.js';
import { suggestAdaptiveGrid } from './adaptive-grid.js';
import { setupProxy, checkProxy } from './proxy.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { evaluateStartRisk, LiveRiskState } from './risk.js';
import { evaluateStrategyParams, BTC_GRID_STRATEGY } from './risk.js';
import { adaptiveGridChangedEnough, autoRebalanceGate, autoRebalanceReason } from './auto-rebalance.js';
import { neutralRebalanceEconomics, readNeutralRangeAdmission } from './neutral-grid.js';
import { createAuditLog } from './audit.js';
import { createNotifier } from './notifier.js';
import { DailyPnlTracker } from './daily-pnl.js';
import { loadConnectionSettings, updateConnectionSettings, publicConnectionSettings } from './connection-settings.js';
import { getAiConfig, publicAiConfig } from './ai/provider.js';
import { loadAiSettings, updateAiSettings, publicAiSettings } from './ai/settings.js';
import { createAiService } from './ai/service.js';
import { aiAutopilotAllowedInMode, completeAiAutopilotAction, evaluateAiAutopilot, replayAiAutopilotHistory } from './ai/autopilot.js';
import { applyLargeCycleExecutionPolicy } from './ai/regime.js';
import { applySentimentOverlay, SENTIMENT_POLICY, SENTIMENT_STRATEGY_ID } from './ai/sentiment.js';
import { projectDashboardState, resolveDashboardRoute } from './dashboard-routing.js';
import { buildStrategyProfileParams, listStrategyProfiles, resolveStrategyProfile } from './strategy-profiles.js';
import { MAX_PAPER_INSTANCES, PaperInstanceManager, PRIMARY_PAPER_INSTANCE_ID } from './paper-instances.js';
import { buildTurtleSignals, turtleUnitSize } from './turtle.js';
import { TURTLE_PAPER_DEFAULTS } from './turtle-paper-bot.js';
import { createTradingBot, strategyEngine } from './trading-bot-factory.js';

const cfg = getConfig();
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(cfg.host.toLowerCase());
const audit = createAuditLog(ROOT);
const notifier = createNotifier(cfg.notifications, ROOT);
const dailyPnl = new DailyPnlTracker(ROOT);
const liveRisk = new LiveRiskState(ROOT, cfg.riskPolicy);
const AUTO_REBALANCE_FILE = path.join(ROOT, '.auto-rebalance.json');
const AI_AUTOPILOT_FILE = path.join(ROOT, '.ai-autopilot.json');
const AI_AUTOPILOT_CONFLICTING_ACTIONS = new Set([
  '/api/start', '/api/strategy-start', '/api/stop', '/api/adjust', '/api/paper-equity', '/api/cancel-orders',
  '/api/close-position', '/api/start-recovery', '/api/reconnect', '/api/restart',
]);
let lastPreflight = null;
let emergencyInFlight = false;
let restartRequestedAt = null;
let lastAlertAt = 0;
let shutdownStarted = false;
let dailyReportRetryAt = 0;
const persistedAutoRebalance = loadAutoRebalanceState();
let lastAutoRebalanceAt = Number(persistedAutoRebalance.lastAdjustedAt) || 0;
let lastAutoRebalanceCheckAt = Number(persistedAutoRebalance.lastCheckAt) || 0;
let lastAutoRebalanceStatus = persistedAutoRebalance.last || { t: null, code: 'not_running', reason: '网格尚未运行' };
let autoRebalanceInFlight = false;
let lastPaperReadiness = null;
let aiAutopilotState = loadAiAutopilotState();
let aiAutopilotInFlight = false;
let aiAutopilotBootstrapInFlight = false;

validateStartup();

const proxyResult = await setupProxy(cfg.proxy);
if (proxyResult.used) {
  console.log('[网络] 已启用代理: ' + proxyResult.used);
  const check = await checkProxy();
  if (!check.ok && cfg.decibel.mode === 'live') {
    console.error('[启动失败] 实盘代理无法联网: ' + check.error);
    process.exit(1);
  }
  console.log(check.ok ? `[网络] 出口 IP: ${check.ip}` : `[网络] 代理检测失败，模拟盘继续: ${check.error}`);
}

let exchange = createExchange(cfg.decibel);
const initialSnapshot = loadSnapshot('decibel');
let bot = createTradingBot(exchange, { onChange: (state) => saveSnapshot('decibel', state) }, initialSnapshot);
let paperInstances = null;
const aiService = createAiService({
  getBot: () => bot,
  getExchange: () => exchange,
  notify: (message) => notifier.send(message),
  onMarketAnalysis: maybeApplyAiAutopilot,
  onSentiment: (report, meta) => audit.write('grok_sentiment_observed', {
    strategyId: SENTIMENT_STRATEGY_ID,
    ...report,
    responseId: meta?.responseId || null,
    searchResponseIds: meta?.searchResponseIds || null,
  }),
  getAutopilotStatus: aiAutopilotPublicState,
});
bot.restore(initialSnapshot);
exchange.on('error', (error) => console.error('[Decibel] ' + (error?.message || error)));

await initializeExchange();
await resumeGrid();
await refreshPersistedMarket();
await restoreIdlePaperState();
if (cfg.decibel.mode === 'paper') {
  paperInstances = new PaperInstanceManager({
    root: ROOT,
    exchangeConfig: cfg.decibel,
    primaryExchange: exchange,
    primaryBot: bot,
    autoResume: cfg.autoResume,
    onError: (error, meta) => audit.write('paper_instance_error', {
      instanceId: meta?.id,
      error: error?.message || String(error),
    }, 'warn'),
  });
  await paperInstances.initialize();
  const activeStrategyId = bot.config?.strategyId;
  if (activeStrategyId) paperInstances.selectStrategy(PRIMARY_PAPER_INSTANCE_ID, activeStrategyId);
}
await refreshPaperReadiness();
await bootstrapPersistedAiAutopilot();
if (cfg.decibel.mode === 'live') liveRisk.observe(bot.getState().equity);
dailyPnl.observe(bot.getState().equity, notifier.publicSettings().timezone);
audit.write('server_started', { mode: cfg.decibel.mode, network: cfg.decibel.network, autoResume: cfg.autoResume });

const streamClients = new Map();
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  // Keep the source project's Decibel namespace usable for scripts and tools
  // that still call /api/de/*, while the single-exchange UI uses /api/*.
  const deAlias = {
    '/markets': '/api/markets',
    '/trend': '/api/trend',
    '/state': '/api/state',
    '/start': '/api/start',
    '/strategy-start': '/api/strategy-start',
    '/stop': '/api/stop',
    '/adjust': '/api/adjust',
    '/reset': '/api/reset',
    '/paper-equity': '/api/paper-equity',
    '/cancel-orders': '/api/cancel-orders',
    '/start-recovery': '/api/start-recovery',
    '/close-position': '/api/close-position',
    '/reconnect': '/api/reconnect',
    '/stream': '/api/stream',
  };
  if (url.pathname.startsWith('/api/de/')) {
    const mapped = deAlias[url.pathname.slice('/api/de'.length)];
    if (mapped) url.pathname = mapped;
  }
  setSecurityHeaders(response);

  try {
    if (!authorized(request, url)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="GridPilot"');
      return send(response, 401, { error: '需要管理员用户名和密码。' });
    }

    if (url.pathname === '/api/paper-instances') {
      ensurePaperInstanceService();
      if (request.method === 'POST') {
        return runAction(response, async () => {
          const body = await readBody(request);
          const context = await paperInstances.create(body.name);
          audit.write('paper_instance_created', { instanceId: context.id, name: context.name });
          return { instances: paperInstanceSummaries(), selectedId: context.id, maxInstances: MAX_PAPER_INSTANCES };
        }, url.pathname);
      }
      return send(response, 200, {
        instances: paperInstanceSummaries(),
        selectedId: requestedPaperInstanceId(url),
        maxInstances: MAX_PAPER_INSTANCES,
      });
    }

    if (url.pathname === '/api/paper-instances/select-strategy' && request.method === 'POST') {
      return runAction(response, async () => {
        ensurePaperInstanceService();
        const body = await readBody(request);
        const context = paperContext(body.paperInstanceId);
        const profile = resolvePaperInstanceProfile(body.strategyId, context);
        paperInstances.selectStrategy(context.id, profile.id);
        return { instance: paperInstanceSummary(context) };
      }, url.pathname);
    }

    if (url.pathname === '/api/paper-instances/delete' && request.method === 'POST') {
      return runAction(response, async () => {
        ensurePaperInstanceService();
        const body = await readBody(request);
        const context = paperContext(body.paperInstanceId);
        await paperInstances.remove(context.id);
        audit.write('paper_instance_deleted', { instanceId: context.id, name: context.name }, 'warn');
        return { instances: paperInstanceSummaries(), selectedId: PRIMARY_PAPER_INSTANCE_ID, maxInstances: MAX_PAPER_INSTANCES };
      }, url.pathname);
    }

    if (url.pathname === '/api/app') {
      return send(response, 200, {
        name: cfg.appName,
        owner: cfg.ownerName,
        exchange: 'Decibel',
        mode: cfg.decibel.mode,
        network: cfg.decibel.network,
        dataNetwork: exchange.network || null,
        authRequired: Boolean(cfg.adminUsername && cfg.adminPassword) || !isLoopback,
        liveEnabled: cfg.enableLiveTrading,
        autoResume: cfg.autoResume,
        autoRebalance: cfg.autoRebalance && (cfg.decibel.mode !== 'live' || cfg.autoLiveRebalance),
        autoRebalanceIntervalMs: cfg.autoRebalanceIntervalMs,
        autoRebalanceCooldownMs: cfg.autoRebalanceCooldownMs,
        btcOnly: cfg.decibel.btcOnly,
        dashboardPages: ['paper', 'live'],
        multiPaper: cfg.decibel.mode === 'paper',
        maxPaperInstances: MAX_PAPER_INSTANCES,
        strategy: cfg.decibel.strategy,
        paperExecution: cfg.decibel.mode === 'paper' ? {
          feeRate: cfg.decibel.paperFeeRate,
          slippageBps: cfg.decibel.paperSlippageBps,
          spreadBps: cfg.decibel.paperSpreadBps,
          fundingRate: cfg.decibel.paperFundingRate,
          fundingIntervalMs: cfg.decibel.paperFundingIntervalMs,
          fillDelayMs: cfg.decibel.paperFillDelayMs,
          partialFillProbability: cfg.decibel.paperPartialFillProbability,
          partialFillRatio: cfg.decibel.paperPartialFillRatio,
        } : null,
        requireFreshPreflight: cfg.requireFreshPreflight,
        riskPolicy: cfg.riskPolicy,
        notificationsEnabled: notifier.enabled,
        ai: publicAiConfig(),
        version: '1.0.0',
      });
    }

    if (url.pathname === '/api/ai-config') {
      if (request.method === 'POST') {
        return runAction(response, async () => {
          const input = await readBody(request);
          if (aiAutopilotInFlight) throw new Error('大周期自动轮动正在执行，请等待本轮动作完成后再修改设置。');
          if (input.autopilotEnabled === true && strategyEngine(bot) === 'turtle' && bot.running) {
            throw new Error('海龟策略运行中不能启用大周期自动轮动，请先停止并平仓。');
          }
          if (input.autopilotEnabled === true && !aiAutopilotAllowedInMode(cfg.decibel.mode)) {
            throw new Error('大周期自动轮动仅允许 PAPER 模拟盘，实盘禁止启用。');
          }
          const selectedAutopilotStrategyId = activeAiAutopilotProfile().id;
          if (input.autopilotEnabled === true) Object.assign(input, largeCycleAutopilotSettings(selectedAutopilotStrategyId));
          if (input.autopilotEnabled === true) {
            const currentConfig = getAiConfig();
            const proposedProvider = String(input.provider || currentConfig.provider).toLowerCase();
            const proposedHasKey = input.clearApiKey === true
              ? false
              : Boolean(String(input.apiKey || '').trim() || currentConfig.apiKey);
            const proposedProfile = listStrategyProfiles({
              runtimeMode: cfg.decibel.mode,
              aiConfigured: proposedHasKey,
              aiProvider: proposedProvider,
            }).find((profile) => profile.id === selectedAutopilotStrategyId);
            if (!proposedProfile?.available) {
              throw new Error(proposedProfile?.unavailableReason || '当前自动轮动策略不可用。');
            }
          }
          const saved = updateAiSettings(ROOT, input);
          if (saved.autopilotEnabled !== true) {
            aiAutopilotState = { ...aiAutopilotState, strategyId: null, candidate: null, candidateCount: 0, lastReason: 'disabled', lastMessage: '大周期自动轮动已关闭' };
            saveAiAutopilotState();
          } else {
            const selectedProfile = listStrategyProfiles({
              runtimeMode: cfg.decibel.mode,
              aiConfigured: Boolean(saved.apiKey),
              aiProvider: saved.provider,
            })
              .find((profile) => profile.id === selectedAutopilotStrategyId);
            aiAutopilotState = {
              ...aiAutopilotState,
              strategyId: selectedAutopilotStrategyId,
              candidate: null,
              candidateCount: 0,
              lastSignalTime: 0,
              historyEvaluatedAt: 0,
              historySignalsEvaluated: 0,
              lastSentimentDecision: null,
              lastSentimentReason: null,
              historyBootstrapPending: selectedProfile.requiresLiveSentiment !== true,
              lastReason: 'waiting',
              lastMessage: selectedProfile.requiresLiveSentiment
                ? `${selectedProfile.name}已启用，等待 Grok 实时情绪确认`
                : `${selectedProfile.name}已启用，等待历史行情确认`,
            };
            saveAiAutopilotState();
          }
          audit.write('ai_settings_updated', {
            provider: saved.provider,
            hasApiKey: Boolean(saved.apiKey),
            autopilotEnabled: saved.autopilotEnabled === true,
          });
          return { settings: publicAiSettings(saved), config: publicAiConfig(), autopilot: aiAutopilotPublicState() };
        }, url.pathname);
      }
      return send(response, 200, { settings: publicAiSettings(loadAiSettings(ROOT)), config: publicAiConfig(), autopilot: aiAutopilotPublicState() });
    }

    if (['/api/ai-analyze', '/api/ai/analyze', '/api/ai/market-run'].includes(url.pathname) && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const result = await aiService.analyze(body.marketId);
        audit.write('ai_analysis_completed', { market: result.market, regime: result.regime, suitable: result.suitable });
        return result;
      }, url.pathname);
    }

    if (['/api/ai-status', '/api/ai/status'].includes(url.pathname)) return send(response, 200, aiService.status());

    if (['/api/ai-sentiment', '/api/ai/sentiment-run'].includes(url.pathname) && request.method === 'POST') {
      return runAction(response, async () => {
        const result = await aiService.analyzeSentiment({ force: true });
        return { sentiment: result, autopilot: aiAutopilotPublicState() };
      }, url.pathname);
    }

    if (['/api/ai-test', '/api/ai/test'].includes(url.pathname) && request.method === 'POST') {
      return runAction(response, async () => aiService.test(), url.pathname);
    }

    if (['/api/ai-sentinel', '/api/ai/sentinel-run'].includes(url.pathname) && request.method === 'POST') {
      return runAction(response, async () => aiService.runSentinel(false), url.pathname);
    }

    if (['/api/ai-report', '/api/ai/report'].includes(url.pathname) && request.method === 'POST') {
      return runAction(response, async () => aiService.makeReport(false), url.pathname);
    }

    if (['/api/ai-out-of-range', '/api/ai/oor-advice'].includes(url.pathname) && request.method === 'POST') {
      return runAction(response, async () => aiService.adviseOutOfRange(), url.pathname);
    }

    if (['/api/ai-chat', '/api/ai/chat'].includes(url.pathname) && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        if (!String(body.message || '').trim()) throw new Error('请输入问题。');
        return aiService.chat(body.message, Array.isArray(body.history) ? body.history : []);
      }, url.pathname);
    }

    if (url.pathname === '/api/state') return send(response, 200, publicState(requestedConsoleMode(url), requestedPaperInstanceId(url)));

    if (url.pathname === '/api/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const consoleMode = requestedConsoleMode(url);
      const paperInstanceId = requestedPaperInstanceId(url);
      writeEvent(response, publicState(consoleMode, paperInstanceId));
      streamClients.set(response, { consoleMode, paperInstanceId });
      request.on('close', () => streamClients.delete(response));
      return;
    }

    if (url.pathname === '/api/markets') {
      const markets = await exchange.getMarkets();
      return send(response, 200, {
        exchange: 'Decibel',
        mode: cfg.decibel.mode,
        network: exchange.network || cfg.decibel.network,
        apiUrl: exchange.apiUrl || cfg.decibel.apiUrl,
        dataSource: exchange.dataSource || (cfg.decibel.mode === 'live' ? 'real' : 'synthetic'),
        markets,
      });
    }

    if (url.pathname === '/api/trend') {
      const marketId = positiveNumber(url.searchParams.get('marketId'), 1);
      const intervalSec = positiveNumber(url.searchParams.get('intervalSec'), 3600);
      let candles = [];
      let price = null;
      try { candles = await exchange.getCandles(marketId, intervalSec, 200); } catch { /* fallback below */ }
      try { price = await exchange.getPrice(marketId); } catch { /* state can still render */ }
      const analysis = candles.length >= 20
        ? analyzeTrend(candles)
        : { trend: 'range', recommended: 'neutral', strength: 0, atrPct: null, price, detail: 'K 线不足，暂按中性网格处理。' };
      return send(response, 200, { analysis, price, candles: candles.slice(-120) });
    }

    if (url.pathname === '/api/strategy-suggestion') {
      const marketId = positiveNumber(url.searchParams.get('marketId'), 1);
      const market = (await exchange.getMarkets()).find((item) => Number(item.marketId) === marketId);
      if (!market) throw new Error('BTC 市场不存在，请刷新市场列表。');
      const candles = await exchange.getCandles(marketId, 3600, 200);
      const analysis = candles.length >= 20 ? analyzeTrend(candles) : { atrPct: null, trend: 'range' };
      const price = await exchange.getPrice(marketId);
      return send(response, 200, {
        market: market.displayName,
        suggestion: suggestAdaptiveGrid({
          price, atrPct: analysis.atrPct, equity: bot.getState().equity, market,
          trend: analysis.trend, mode: analysis.recommended, execution: exchangeExecutionAssumptions(exchange),
        }),
      });
    }

    if (url.pathname === '/api/strategy-profiles') {
      const runtimeMode = requestedConsoleMode(url) || cfg.decibel.mode;
      const context = runtimeMode === 'paper' && cfg.decibel.mode === 'paper'
        ? paperContext(requestedPaperInstanceId(url))
        : null;
      return send(response, 200, {
        runtimeMode,
        profiles: paperProfiles(context, runtimeMode),
      });
    }

    if (url.pathname === '/api/strategy-preview') {
      const requestedMode = requestedConsoleMode(url);
      if (requestedMode && requestedMode !== cfg.decibel.mode) {
        return send(response, 409, { error: '页面与服务模式不一致，不能读取另一模式的账户策略预览。' });
      }
      const strategyId = url.searchParams.get('strategyId');
      const marketId = positiveNumber(url.searchParams.get('marketId'), 1);
      return send(response, 200, await buildNamedStrategyPreview(strategyId, marketId, {
        context: paperContextFromUrl(url),
      }));
    }

    if (url.pathname === '/api/preflight') {
      if (request.method === 'POST') return send(response, 200, await runPreflight());
      return send(response, 200, lastPreflight || { ready: false, t: null, checks: [], message: '尚未运行实盘预检。' });
    }

    if (url.pathname === '/api/paper-readiness') {
      const body = request.method === 'POST' ? await readBody(request) : {};
      const context = paperContext(body.paperInstanceId || requestedPaperInstanceId(url));
      return send(response, 200, await buildPaperReadiness(body.params || body, context));
    }

    if (url.pathname === '/api/audit') {
      return send(response, 200, { entries: audit.recent(100) });
    }

    if (url.pathname === '/api/connection-settings') {
      if (request.method === 'POST') {
        return runAction(response, async () => {
          const body = await readBody(request);
          const saved = updateConnectionSettings(ROOT, body, connectionEffective());
          const settings = publicConnectionSettings(saved, connectionEffective());
          audit.write('connection_settings_updated', {
            targetMode: settings.targetMode,
            targetNetwork: settings.targetNetwork,
            hasApiKey: settings.hasApiKey,
            hasPrivateKey: settings.hasPrivateKey,
            hasSubaccount: settings.hasSubaccount,
          }, settings.targetMode === 'live' ? 'warn' : 'info');
          return { settings, restartRequired: true };
        }, url.pathname);
      }
      return send(response, 200, {
        settings: publicConnectionSettings(loadConnectionSettings(ROOT), connectionEffective()),
        restartRequired: false,
      });
    }

    if (url.pathname === '/api/restart' && request.method === 'POST') {
      return runAction(response, async () => {
        if (cfg.decibel.mode === 'live') throw new Error('实盘模式不允许从页面重启，请在命令行手动重启。');
        if (paperInstances?.list().some((context) => context.bot.running)) {
          throw new Error('仍有模拟盘正在运行，请先逐个停止并平仓后再重启。');
        }
        if (restartRequestedAt) throw new Error('正在重启中，请稍候。');
        restartRequestedAt = Date.now();
        audit.write('restart_requested', { mode: cfg.decibel.mode, network: cfg.decibel.network }, 'warn');
        try {
          await performPaperRestart();
        } finally {
          restartRequestedAt = null;
        }
        audit.write('restart_completed', { dataSource: exchange.dataSource }, 'info');
        return { restarted: true, dataSource: exchange.dataSource, message: '模拟盘已原地重启，连接设置与行情已重新加载。' };
      }, url.pathname);
    }

    if (url.pathname === '/api/notification-settings') {
      if (request.method === 'POST') {
        return runAction(response, async () => {
          const settings = notifier.update(await readBody(request));
          const summary = dailyPnl.observe(bot.getState().equity, settings.timezone);
          audit.write('notification_settings_updated', {
            telegramReady: settings.telegramReady,
            dailyEnabled: settings.dailyEnabled,
            dailyTime: settings.dailyTime,
            timezone: settings.timezone,
          });
          return { settings, dailyPnl: summary };
        }, url.pathname);
      }
      const settings = notifier.publicSettings();
      return send(response, 200, {
        settings,
        dailyPnl: dailyPnl.summary(bot.getState().equity, settings.timezone),
      });
    }

    if (url.pathname === '/api/notify-test' && request.method === 'POST') {
      return runAction(response, async () => {
        const result = await notifier.send(`[${cfg.appName}] 通知测试成功 · ${new Date().toISOString()}`);
        audit.write('notification_test', { result });
        return result;
      }, url.pathname);
    }

    if (url.pathname === '/api/daily-report' && request.method === 'POST') {
      return runAction(response, async () => {
        const state = bot.getState();
        const settings = notifier.publicSettings();
        const summary = dailyPnl.observe(state.equity, settings.timezone);
        const result = await notifier.send(formatDailyReport(summary, state, '手动发送'));
        audit.write('daily_report_sent', { trigger: 'manual', summary, result });
        return { ok: true, settings, dailyPnl: summary };
      }, url.pathname);
    }

    if (url.pathname === '/api/strategy-start' && request.method === 'POST') {
      return runAction(response, async () => activateNamedStrategy(await readBody(request)), url.pathname);
    }
    if (url.pathname === '/api/start' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        if (!context || context.primary) await disableAiAutopilot('已选择固定策略，大周期自动轮动已关闭');
        return startGrid(body, context);
      }, url.pathname);
    }
    if (url.pathname === '/api/stop' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        const targetBot = context?.bot || bot;
        if (!context || context.primary) await disableAiAutopilot('已人工停止网格，大周期自动轮动已关闭');
        const result = await targetBot.stop(body);
        await refreshPaperReadiness(context);
        audit.write('grid_stopped', { paperInstanceId: context?.id || null, closePosition: body.closePosition !== false, state: compactState(result) });
        await notifySafe(`GridPilot 已停止网格${body.closePosition === false ? '，持仓保留' : '并执行平仓'}。`);
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/adjust' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        const targetBot = context?.bot || bot;
        await validateRangeRisk(body, context);
        const result = await targetBot.adjustRange(body);
        await refreshPaperReadiness(context);
        audit.write('range_adjusted', { paperInstanceId: context?.id || null, lower: body.lower, upper: body.upper, state: compactState(result) });
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/reset' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        const result = (context?.bot || bot).resetStats();
        audit.write('stats_reset', { paperInstanceId: context?.id || null, state: compactState(result) });
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/paper-equity' && request.method === 'POST') {
      return runAction(response, async () => {
        if (cfg.decibel.mode !== 'paper') throw new Error('账户权益调整仅适用于 PAPER 模拟盘。');
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        const targetExchange = context?.exchange || exchange;
        const targetBot = context?.bot || bot;
        await targetExchange.refreshPositions?.();
        const previousEquity = targetBot.getState().equity;
        const result = targetBot.setPaperEquity(body.equity);
        const dailySummary = context?.primary === false
          ? null
          : dailyPnl.rebaseline(result.equity, notifier.publicSettings().timezone);
        await refreshPaperReadiness(context);
        audit.write('paper_equity_adjusted', {
          paperInstanceId: context?.id || null,
          previousEquity,
          equity: result.equity,
          delta: Number(result.equity) - Number(previousEquity),
          measurementId: result.measurement?.id || null,
          dailySummary,
        }, 'warn');
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/cancel-orders' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        const targetBot = context?.bot || bot;
        if (!context || context.primary) await disableAiAutopilot('已人工撤销挂单，大周期自动轮动已关闭');
        const result = await targetBot.cancelAllOrders();
        audit.write('orders_cancelled', { paperInstanceId: context?.id || null, state: compactState(result) }, 'warn');
        await notifySafe('GridPilot 已撤销全部网格挂单，当前持仓保留。');
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/close-position' && request.method === 'POST') {
      const body = await readBody(request);
      return runAction(response, async () => {
        const context = paperContextFromBody(body);
        const targetBot = context?.bot || bot;
        if (cfg.decibel.mode === 'live') {
          const market = await marketById(body.marketId);
          if (body.liveConfirmation !== `CLOSE ${market.displayName}`) {
            throw new Error(`实盘平仓确认短语不正确，应输入：CLOSE ${market.displayName}`);
          }
        }
        if (!context || context.primary) await disableAiAutopilot('已人工平仓，大周期自动轮动已关闭');
        const result = await targetBot.closePositionNow(body.marketId);
        audit.write('position_closed', { paperInstanceId: context?.id || null, marketId: body.marketId, state: compactState(result) }, 'warn');
        await notifySafe('GridPilot 已执行撤单和平仓，请到 Decibel 再次核对。');
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/start-recovery' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        const targetBot = context?.bot || bot;
        if (cfg.decibel.mode === 'live') {
          const market = await marketById(body.marketId);
          if (body.liveConfirmation !== `RECOVER ${market.displayName}`) {
            throw new Error(`实盘回收确认短语不正确，应输入：RECOVER ${market.displayName}`);
          }
        }
        if (!context || context.primary) await disableAiAutopilot('已人工启动回收策略，大周期自动轮动已关闭');
        delete body.liveConfirmation;
        delete body.paperInstanceId;
        const result = await targetBot.startRecovery(body);
        audit.write('recovery_started', { paperInstanceId: context?.id || null, marketId: body.marketId, spacing: body.spacing, sizeBase: body.sizeBase, aboveEntryOnly: !!body.aboveEntryOnly }, 'warn');
        await notifySafe('GridPilot 已启动只减仓回收阶梯。');
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/emergency-stop' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        if (body.confirmation !== 'EMERGENCY STOP') throw new Error('紧急停止确认短语不正确。');
        const context = paperContextFromBody(body);
        if (context && !context.primary) {
          await context.bot.stop({ closePosition: true });
          audit.write('paper_instance_emergency_stop', { paperInstanceId: context.id }, 'warn');
        } else {
          await disableAiAutopilot('已人工紧急停止，大周期自动轮动已关闭');
          await emergencyStop('用户手动触发紧急停止');
        }
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/risk-policy') {
      if (request.method === 'POST') {
        return runAction(response, async () => {
          const body = await readBody(request);
          const next = {
            maxLeverage: clamp(Number(body.maxLeverage), 0, 50, cfg.riskPolicy.maxLeverage),
            maxGridCount: Math.round(clamp(Number(body.maxGridCount), 0, 200, cfg.riskPolicy.maxGridCount)),
            maxNotional: clamp(Number(body.maxNotional), 0, 100000000, cfg.riskPolicy.maxNotional),
            maxMarginPct: clamp(Number(body.maxMarginPct), 1, 100, cfg.riskPolicy.maxMarginPct),
            minMaintenanceMarginRatio: clamp(Number(body.minMaintenanceMarginRatio), 100, 100000, cfg.riskPolicy.minMaintenanceMarginRatio),
            dailyLossLimit: clamp(Number(body.dailyLossLimit), 1, 100000000, cfg.riskPolicy.dailyLossLimit),
            maxDrawdownPct: clamp(Number(body.maxDrawdownPct), 0.1, 100, cfg.riskPolicy.maxDrawdownPct),
          };
          Object.assign(cfg.riskPolicy, next); // same object is referenced by liveRisk
          saveRiskPolicy(cfg.riskPolicy);
          audit.write('risk_policy_updated', { ...next, mode: cfg.decibel.mode }, 'warn');
          return { riskPolicy: cfg.riskPolicy };
        }, url.pathname);
      }
      return send(response, 200, { riskPolicy: cfg.riskPolicy });
    }
    if (url.pathname === '/api/risk-reset' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        if (body.confirmation !== 'RESET RISK') throw new Error('风险基线确认短语不正确。');
        if (bot.running) throw new Error('网格运行中不能重置风险基线。');
        const status = liveRisk.reset(bot.getState().equity);
        audit.write('risk_baseline_reset', { status }, 'warn');
        return { ok: true, liveRisk: status };
      }, url.pathname);
    }
    if (url.pathname === '/api/reconnect' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const context = paperContextFromBody(body);
        const targetExchange = context?.exchange || exchange;
        const targetBot = context?.bot || bot;
        await targetExchange.reconnect?.();
        if (!targetBot.running && cfg.autoResume) {
          const snapshot = loadSnapshot(context?.snapshotKey || 'decibel');
          if (snapshot?.running && snapshot?.config) await targetBot.resume(snapshot);
        }
        if (targetBot.running) await targetBot.reconcileOpenOrders().catch(() => {});
        audit.write('exchange_reconnected', { paperInstanceId: context?.id || null, resumed: targetBot.running });
        return publicState(null, context?.id);
      }, url.pathname);
    }
    if (url.pathname === '/api/proxy-check') return send(response, 200, await checkProxy());

    const dashboardRoute = resolveDashboardRoute(url.pathname);
    return serveStatic(dashboardRoute.matched ? '/index.html' : url.pathname, response);
  } catch (error) {
    audit.write('api_request_failed', { path: url.pathname, error: error?.message || String(error) }, 'error');
    return send(response, 500, { error: error?.message || String(error) });
  }
});

setInterval(() => {
  for (const [client, subscription] of streamClients) {
    try { writeEvent(client, publicState(subscription.consoleMode, subscription.paperInstanceId)); }
    catch { streamClients.delete(client); }
  }
}, 1000).unref();

setInterval(() => monitorLiveRisk().catch((error) => {
  console.error('[实盘风控] ' + (error?.message || error));
}), 5000).unref();

setInterval(() => maybeAutoRebalance().catch((error) => {
  audit.write('auto_rebalance_failed', { error: error?.message || String(error) }, 'warn');
}), 60_000).unref();

setInterval(() => maybeAutoRebalancePaperInstances().catch((error) => {
  audit.write('paper_instance_rebalance_failed', { error: error?.message || String(error) }, 'warn');
}), 60_000).unref();

setInterval(() => refreshAllPaperReadiness().catch((error) => {
  audit.write('paper_readiness_failed', { error: error?.message || String(error) }, 'warn');
}), 15_000).unref();

setInterval(() => processDailyReport().catch((error) => {
  audit.write('daily_report_scheduler_error', { error: error?.message || String(error) }, 'warn');
}), 30_000).unref();

setInterval(() => {
  for (const client of streamClients.keys()) {
    try { client.write(': heartbeat\n\n'); }
    catch { streamClients.delete(client); }
  }
}, 15000).unref();

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`[启动失败] 端口 ${cfg.port} 已被占用，请修改 .env 中的 PORT。`);
  else console.error('[服务器] ' + (error?.message || error));
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  const displayHost = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log('\n' + '='.repeat(56));
  console.log(`  ${cfg.appName} · ${cfg.ownerName}`);
  console.log(`  http://${displayHost}:${cfg.port}`);
  console.log(`  Decibel [${cfg.decibel.mode.toUpperCase()}] [${cfg.decibel.network}]`);
  console.log(`  自动恢复: ${cfg.autoResume ? '开启' : '关闭'}`);
  if (cfg.autoRebalance && (cfg.decibel.mode !== 'live' || cfg.autoLiveRebalance)) console.log('  小时参数引擎: 开启');
  if (aiAutopilotPublicState().effective) console.log('  大周期自动轮动: 开启（仅 PAPER）');
  if (!isLoopback) console.log('  局域网访问已启用，API 受 DASHBOARD_TOKEN 保护。');
  if (cfg.decibel.mode === 'paper') console.log('  当前为模拟盘，不会发送真实订单。');
  console.log('='.repeat(56) + '\n');
});

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

function validateStartup() {
  if (!isLoopback && cfg.dashboardToken.length < 32) {
    console.error('[启动失败] HOST 不是本机回环地址时必须设置至少 32 位的 DASHBOARD_TOKEN。');
    process.exit(1);
  }
  if (cfg.decibel.mode !== 'live') return;
  const errors = [];
  if (!cfg.enableLiveTrading) errors.push('ENABLE_LIVE_TRADING=true');
  if (cfg.liveConfirmation !== 'I_ACCEPT_DECIBEL_LIVE_RISK') errors.push('LIVE_CONFIRMATION=I_ACCEPT_DECIBEL_LIVE_RISK');
  if (!cfg.decibel.apiKey) errors.push('DECIBEL_API_KEY');
  if (!cfg.decibel.privateKey) errors.push('DECIBEL_PRIVATE_KEY');
  if (!cfg.decibel.subaccount) errors.push('DECIBEL_SUBACCOUNT');
  if (errors.length) {
    console.error('[启动失败] 实盘保护未解锁，缺少或不正确的配置:');
    for (const item of errors) console.error('  - ' + item);
    process.exit(1);
  }
}

function ensurePaperInstanceService() {
  if (cfg.decibel.mode !== 'paper' || !paperInstances) throw new Error('多模拟盘仅在 PAPER 服务中可用。');
}

function requestedPaperInstanceId(url) {
  return String(url?.searchParams?.get('paperInstanceId') || PRIMARY_PAPER_INSTANCE_ID);
}

function paperContext(id) {
  ensurePaperInstanceService();
  const context = paperInstances.get(id || PRIMARY_PAPER_INSTANCE_ID);
  if (!context) throw new Error('模拟盘实例不存在，请刷新页面。');
  return context;
}

function paperContextFromUrl(url) {
  if (cfg.decibel.mode !== 'paper' || requestedConsoleMode(url) === 'live') return null;
  return paperContext(requestedPaperInstanceId(url));
}

function paperContextFromBody(body = {}) {
  if (cfg.decibel.mode !== 'paper') return null;
  return paperContext(body.paperInstanceId || PRIMARY_PAPER_INSTANCE_ID);
}

function paperProfiles(context, runtimeMode = 'paper') {
  return listStrategyProfiles(aiStrategyOptions(runtimeMode)).map((profile) => {
    if (!context || context.primary || profile.mode !== 'dynamic') return profile;
    return {
      ...profile,
      available: false,
      unavailableReason: '大周期自动轮动暂只允许主模拟盘；其他实例可并行运行固定方向策略。',
    };
  });
}

function resolvePaperInstanceProfile(strategyId, context) {
  const profile = resolveStrategyProfile(strategyId, aiStrategyOptions(cfg.decibel.mode));
  if (context && !context.primary && profile.mode === 'dynamic') {
    throw new Error('大周期自动轮动暂只允许主模拟盘；其他实例请选择区间、做多或做空策略。');
  }
  return profile;
}

function aiStrategyOptions(runtimeMode = cfg.decibel.mode) {
  const config = getAiConfig();
  return { runtimeMode, aiConfigured: Boolean(config.apiKey), aiProvider: config.provider };
}

function ensureStrategyBot(profile, context = null) {
  const current = context?.bot || bot;
  const desiredEngine = profile?.engine === 'turtle' ? 'turtle' : 'grid';
  if (strategyEngine(current) === desiredEngine) return current;
  if (cfg.decibel.mode !== 'paper') throw new Error('实盘运行中不能切换到模拟策略执行器。');
  const state = current.getState();
  if (state.running || state.recovery || state.position || Number(state.openOrders) > 0 || Number(state.exchangeOpenOrders) > 0) {
    throw new Error('切换策略执行器前必须停止、平仓并清理全部挂单。');
  }
  const targetExchange = context?.exchange || exchange;
  const snapshotKey = context?.snapshotKey || 'decibel';
  const next = createTradingBot(targetExchange, { onChange: (snapshot) => saveSnapshot(snapshotKey, snapshot) }, {
    config: { engine: desiredEngine, strategyId: profile.id },
  });
  if (context) paperInstances.replaceBot(context.id, next);
  else current.dispose?.();
  if (!context || context.primary) bot = next;
  saveSnapshot(snapshotKey, next.snapshot());
  return next;
}

function paperInstanceSummaries() {
  if (!paperInstances) return [];
  return paperInstances.list().map(paperInstanceSummary);
}

function paperInstanceSummary(context) {
  const state = context.bot.getState();
  const strategyId = state.running
    ? (state.config?.strategyId || context.meta.selectedStrategyId)
    : context.meta.selectedStrategyId;
  const profile = listStrategyProfiles(aiStrategyOptions('paper'))
    .find((item) => item.id === strategyId);
  return {
    id: context.id,
    name: context.name,
    primary: context.primary,
    running: state.running,
    waitingForAdmission: state.waitingForAdmission === true,
    recovery: state.recovery,
    strategyId,
    strategyName: profile?.name || strategyId,
    direction: state.config?.mode || null,
    equity: state.equity,
    totalPnl: state.totalPnl,
    returnPct: state.returnPct,
    openOrders: state.openOrders,
    position: state.position,
    createdAt: context.meta.createdAt,
  };
}

async function buildNamedStrategyPreview(strategyId, marketId, { allowExistingPosition = false, context = null } = {}) {
  const targetExchange = context?.exchange || exchange;
  const targetBot = context?.bot || bot;
  const aiConfig = getAiConfig();
  const profile = resolvePaperInstanceProfile(strategyId, context);
  const markets = await targetExchange.getMarkets();
  const requestedId = Number(marketId);
  const market = markets.find((item) => Number(item.marketId) === requestedId)
    || markets.find((item) => String(item.displayName || '').toUpperCase() === 'BTC-USD');
  if (!market) throw new Error('BTC-USD 市场不存在，请刷新市场列表。');

  await targetExchange.refreshPositions?.();
  const state = targetBot.getState();
  const price = Number(await targetExchange.getPrice(market.marketId));
  if (!(price > 0)) throw new Error('未能获取有效的 BTC 最新价格，无法生成策略参数。');
  if (profile.engine === 'turtle') {
    return buildTurtleStrategyPreview({ profile, market, price, state, targetExchange, targetBot, context });
  }
  const candles = await targetExchange.getCandles(market.marketId, 3600, 200);
  const analysis = candles.length >= 20 ? analyzeTrend(candles) : { atrPct: null, trend: 'range', detail: 'K 线不足，使用保守波动率。' };
  const suggestion = suggestAdaptiveGrid({
    price,
    atrPct: analysis.atrPct,
    equity: state.equity,
    market,
    trend: analysis.trend,
    mode: profile.mode === 'dynamic' ? 'neutral' : profile.mode,
    policy: profile.gridPolicy || {},
    execution: exchangeExecutionAssumptions(targetExchange),
  });
  const params = buildStrategyProfileParams({
    strategyId: profile.id,
    suggestion,
    marketId: market.marketId,
    runtimeMode: cfg.decibel.mode,
    aiConfigured: Boolean(aiConfig.apiKey),
    aiProvider: aiConfig.provider,
  });
  const existingPosition = targetExchange.getPosition?.(market.marketId) || null;
  const strategyCheck = evaluateStrategyParams({ params, market, strategy: cfg.decibel.strategy || BTC_GRID_STRATEGY });
  const riskCheck = evaluateStartRisk({
    params,
    market,
    equity: state.equity,
    policy: strategyRiskPolicy(params.strategyId),
    existingPosition,
    currentPrice: price,
  });
  let preflight = null;
  try { preflight = await targetExchange.preflight?.(); } catch { /* reflected by the residual order check below */ }
  const positionSize = Math.abs(Number(existingPosition?.sizeBase) || 0);
  const exchangeOrders = Number(preflight?.openOrderCount ?? state.exchangeOpenOrders ?? 0);
  const accountClean = !state.recovery
    && Number(state.openOrders || 0) === 0
    && exchangeOrders === 0
    && (allowExistingPosition || positionSize === 0);
  const checks = [
    { id: 'market', label: '市场', status: strategyCheck.ok ? 'pass' : 'fail', detail: strategyCheck.ok ? market.displayName : strategyCheck.errors.join(' ') },
    { id: 'price', label: '最新价格', status: price > 0 ? 'pass' : 'fail', detail: `${price} · ${targetExchange.dataSource || 'unknown'}` },
    { id: 'adaptive', label: '自动参数', status: 'pass', detail: `ATR ${suggestion.atrPct}% · ${params.gridCount} 格 · ${params.leverage}x` },
    { id: 'risk', label: '保证金和风险', status: riskCheck.ok ? 'pass' : 'fail', detail: riskCheck.ok ? `预计 ${riskCheck.metrics.requiredMargin} USDC，占权益 ${riskCheck.metrics.marginPct}%` : riskCheck.errors.join(' ') },
    { id: 'orders', label: '仓位与遗留状态', status: accountClean ? 'pass' : 'fail', detail: accountClean ? (positionSize > 0 ? '现有仓位已纳入重新建网格计算' : '无持仓、遗留挂单或恢复状态') : '请先处理现有仓位、挂单或恢复状态' },
    { id: 'running', label: '网格状态', status: state.running ? 'fail' : 'pass', detail: state.running ? '已有网格正在运行，请先停止' : '未运行，可以启动' },
  ];
  if (profile.requiresLiveSentiment) {
    checks.splice(3, 0, {
      id: 'liveSentiment',
      label: 'Grok 实时情绪',
      status: 'pass',
      detail: `xAI ${aiConfig.model} 已配置；启动后立即搜索 X 与网页，取得 2 次连续确认后才挂单`,
    });
  }
  let rangeAdmission = null;
  if (profile.id === 'range_balanced' && params.neutralRangeAdmissionEnabled) {
    rangeAdmission = await readNeutralRangeAdmission({
      exchange: targetExchange,
      marketId: market.marketId,
      minAtrPct: params.rangeAdmissionMinAtrPct,
    });
    checks.splice(3, 0, {
      id: 'rangeAdmission',
      label: '震荡准入',
      status: rangeAdmission.allowed ? 'pass' : (targetExchange.mode === 'paper' ? 'warn' : 'fail'),
      detail: rangeAdmission.allowed
        ? rangeAdmission.detail
        : (targetExchange.mode === 'paper' ? `启动后等待准入：${rangeAdmission.detail}` : rangeAdmission.detail),
    });
  }
  if (cfg.decibel.mode === 'live') {
    const preflightReady = !cfg.requireFreshPreflight || (lastPreflight?.ready && Date.now() - lastPreflight.t <= 5 * 60_000);
    checks.push({ id: 'preflight', label: '实盘预检', status: preflightReady ? 'pass' : 'fail', detail: preflightReady ? '预检有效' : '请先完成实盘预检' });
  }
  return {
    mode: cfg.decibel.mode,
    profile,
    market: market.displayName,
    paperInstance: context ? paperInstanceSummary(context) : null,
    dataSource: targetExchange.dataSource || null,
    generatedAt: Date.now(),
    price,
    analysis: { trend: analysis.trend || 'range', atrPct: suggestion.atrPct, detail: analysis.detail || null },
    rangeAdmission,
    params,
    strategyCheck,
    riskCheck,
    accountClean,
    checks,
    ready: checks.every((check) => check.status !== 'fail'),
    autoRebalance: autoRebalancePublicState(context),
    lastAutoRebalance: context?.meta.autoRebalance?.last || lastAutoRebalanceStatus,
    rationale: suggestion.rationale,
  };
}

async function buildTurtleStrategyPreview({ profile, market, price, state, targetExchange, targetBot, context }) {
  const candles = await targetExchange.getCandles(market.marketId, 86400, 120);
  const candleSource = targetExchange.candleDataSource || targetExchange.dataSource || null;
  const sourceValid = candleSource !== 'synthetic';
  const enoughCandles = Array.isArray(candles) && candles.length >= 100;
  const signals = enoughCandles ? buildTurtleSignals(candles, TURTLE_PAPER_DEFAULTS) : [];
  const signal = signals.at(-1) || null;
  const signalValid = Number(signal?.entryHigh) > 0 && Number(signal?.exitLow) > 0 && Number(signal?.atrN) > 0;
  const unitSize = signalValid ? turtleUnitSize({
    equity: state.equity,
    price,
    atrN: signal.atrN,
    riskPct: TURTLE_PAPER_DEFAULTS.riskPct,
    stopAtrMultiple: TURTLE_PAPER_DEFAULTS.stopAtrMultiple,
    maxNotionalPct: TURTLE_PAPER_DEFAULTS.maxNotionalPct,
    stepSize: Number(market.stepSize) || 0.00001,
    minOrderSize: Number(market.minOrderSize) || 0.0001,
  }) : 0;
  let preflight = null;
  try { preflight = await targetExchange.preflight?.(); } catch { /* surfaced by the account check */ }
  const position = targetExchange.getPosition?.(market.marketId) || null;
  const accountClean = !state.running && !state.recovery && !position
    && Number(state.openOrders || 0) === 0
    && Number(preflight?.openOrderCount || 0) === 0;
  const unitNotional = unitSize * price;
  const equity = Number(state.equity) || 0;
  const params = {
    ...TURTLE_PAPER_DEFAULTS,
    marketId: market.marketId,
    displayName: market.displayName,
    strategyId: profile.id,
    engine: 'turtle',
    strategyType: 'turtle',
    mode: 'long',
    leverage: 1,
    stepSize: Number(market.stepSize) || 0.00001,
    minOrderSize: Number(market.minOrderSize) || 0.0001,
    sizeBase: unitSize,
    entryHigh: signal?.entryHigh ?? null,
    exitLow: signal?.exitLow ?? null,
    atrN: signal?.atrN ?? null,
    signalAvailableAt: signal?.availableAt ?? null,
  };
  const strategyCheck = {
    ok: cfg.decibel.mode === 'paper' && sourceValid && enoughCandles && signalValid && unitSize > 0,
    errors: [
      cfg.decibel.mode === 'paper' ? null : '海龟策略仅允许 PAPER 模拟盘。',
      sourceValid ? null : '真实日 K 线不可用，拒绝使用合成数据。',
      enoughCandles ? null : `已完成日 K 线不足（需要 100 根，当前 ${candles?.length || 0} 根）。`,
      signalValid ? null : `无法计算有效的 ${TURTLE_PAPER_DEFAULTS.entryDays} 日突破、${TURTLE_PAPER_DEFAULTS.exitDays} 日退出和 ATR。`,
      unitSize > 0 ? null : '1.5% 风险单位低于最小下单量或被名义金额上限阻止。',
    ].filter(Boolean),
  };
  const riskCheck = {
    ok: unitSize > 0 && unitNotional <= equity + 1e-8,
    errors: unitSize > 0 && unitNotional <= equity + 1e-8 ? [] : ['首个单位超过账户 100% 名义金额上限。'],
    warnings: [],
    metrics: {
      requiredMargin: roundNumber(unitNotional, 2),
      marginPct: equity > 0 ? roundNumber(unitNotional / equity * 100, 2) : null,
      unitRiskBudget: roundNumber(equity * TURTLE_PAPER_DEFAULTS.riskPct / 100, 2),
      stopDistance: roundNumber((signal?.atrN || 0) * TURTLE_PAPER_DEFAULTS.stopAtrMultiple, 2),
    },
  };
  const checks = [
    { id: 'market', label: '市场', status: String(market.displayName).toUpperCase() === 'BTC-USD' ? 'pass' : 'fail', detail: market.displayName },
    { id: 'price', label: '最新价格', status: price > 0 ? 'pass' : 'fail', detail: `${price} · ${targetExchange.dataSource || 'unknown'}` },
    { id: 'dailyCandles', label: '海龟日线信号', status: sourceValid && enoughCandles && signalValid ? 'pass' : 'fail', detail: strategyCheck.ok ? `${TURTLE_PAPER_DEFAULTS.entryDays} 日突破 ${roundNumber(signal.entryHigh, 2)} · ${TURTLE_PAPER_DEFAULTS.exitDays} 日退出 ${roundNumber(signal.exitLow, 2)} · N ${roundNumber(signal.atrN, 2)}` : strategyCheck.errors.join(' ') },
    { id: 'risk', label: '1.5% 单位风险', status: riskCheck.ok ? 'pass' : 'fail', detail: riskCheck.ok ? `${unitSize} BTC · 约 ${roundNumber(unitNotional, 2)} USDC` : riskCheck.errors.join(' ') },
    { id: 'orders', label: '仓位与遗留状态', status: accountClean ? 'pass' : 'fail', detail: accountClean ? '无持仓、挂单或恢复状态' : '请先停止、平仓并清理遗留挂单' },
    { id: 'running', label: '策略状态', status: state.running ? 'fail' : 'pass', detail: state.running ? '已有策略正在运行' : '未运行，可以启动' },
  ];
  return {
    mode: cfg.decibel.mode,
    profile,
    market: market.displayName,
    paperInstance: context ? paperInstanceSummary(context) : null,
    dataSource: targetExchange.dataSource || null,
    candleDataSource: candleSource,
    generatedAt: Date.now(),
    price,
    params,
    turtle: {
      state: price >= Number(signal?.entryHigh) ? 'breakout' : 'waiting',
      entryDays: TURTLE_PAPER_DEFAULTS.entryDays,
      exitDays: TURTLE_PAPER_DEFAULTS.exitDays,
      atrDays: TURTLE_PAPER_DEFAULTS.atrDays,
      entryHigh: signal?.entryHigh ?? null,
      exitLow: signal?.exitLow ?? null,
      atrN: signal?.atrN ?? null,
      signalAvailableAt: signal?.availableAt ?? null,
      unitSize,
      unitNotional: roundNumber(unitNotional, 2),
      stopDistance: riskCheck.metrics.stopDistance,
      riskPct: TURTLE_PAPER_DEFAULTS.riskPct,
      maxUnits: TURTLE_PAPER_DEFAULTS.maxUnits,
      maxNotionalPct: TURTLE_PAPER_DEFAULTS.maxNotionalPct,
    },
    strategyCheck,
    riskCheck,
    accountClean,
    checks,
    ready: checks.every((check) => check.status !== 'fail'),
    autoRebalance: { enabled: false, last: { t: null, code: 'strategy_managed', reason: '海龟信号每小时读取已完成日 K 线，网格调区间不适用' } },
    lastAutoRebalance: { t: null, code: 'strategy_managed', reason: '海龟参数由突破通道和 ATR 管理' },
    rationale: `每单位用权益 ${TURTLE_PAPER_DEFAULTS.riskPct}% 作为 2N 止损风险预算，总名义金额不超过权益 100%。`,
  };
}

async function activateNamedStrategy(body = {}) {
  const context = paperContextFromBody(body);
  const marketId = positiveNumber(body.marketId, 1);
  const profile = resolvePaperInstanceProfile(body.strategyId, context);
  const preview = await buildNamedStrategyPreview(profile.id, marketId, {
    allowExistingPosition: body.allowExistingPosition === true,
    context,
  });
  if (!preview.ready) {
    const errors = preview.checks.filter((check) => check.status === 'fail').map((check) => check.detail);
    throw new Error(errors.join(' '));
  }
  if (context) paperInstances.selectStrategy(context.id, profile.id);

  if (profile.mode === 'dynamic') {
    if (context && !context.primary) throw new Error('大周期自动轮动暂只允许主模拟盘。');
    await enableAiAutopilot(profile.id);
    audit.write('named_strategy_activated', { strategyId: profile.id, market: preview.market, mode: cfg.decibel.mode });
    let initialAnalysis = null;
    let initialAnalysisError = null;
    try {
      if (profile.requiresLiveSentiment) {
        initialAnalysis = await aiService.analyze(marketId, { forceSentiment: true });
        await maybeApplyAiAutopilot(initialAnalysis);
      } else {
        const bootstrap = await bootstrapAiAutopilot(marketId);
        initialAnalysis = bootstrap.analysis;
      }
    } catch (error) {
      initialAnalysisError = error?.message || String(error);
      aiAutopilotState = {
        ...aiAutopilotState,
        historyBootstrapPending: profile.requiresLiveSentiment !== true,
        lastReason: 'analysis_failed',
        lastMessage: profile.requiresLiveSentiment
          ? `Grok 实时情绪读取失败，将在 15 分钟计划任务中重试：${initialAnalysisError}`
          : `历史确认失败，将按计划重试：${initialAnalysisError}`,
      };
      saveAiAutopilotState();
    }
    return {
      ...publicState(),
      strategyActivation: {
        strategyId: profile.id,
        message: aiAutopilotState.lastMessage,
        initialAnalysis: initialAnalysis ? { regime: initialAnalysis.regime, confidence: initialAnalysis.confidence } : null,
      },
    };
  }

  if (profile.engine === 'turtle') {
    if (!context) throw new Error('海龟策略仅允许 PAPER 模拟盘。');
    await disableAiAutopilot('已选择海龟突破策略，大周期自动轮动已关闭');
    const targetBot = ensureStrategyBot(profile, context);
    const result = await targetBot.start(preview.params);
    await refreshPaperReadiness(context);
    audit.write('turtle_strategy_started', {
      strategyId: profile.id,
      market: preview.market,
      paperInstanceId: context.id,
      riskPct: TURTLE_PAPER_DEFAULTS.riskPct,
      state: compactState(result),
    });
    return publicState(null, context.id);
  }

  if (!context || context.primary) await disableAiAutopilot('已选择固定策略，大周期自动轮动已关闭');
  ensureStrategyBot(profile, context);
  const params = {
    ...preview.params,
    allowExistingPosition: body.allowExistingPosition === true,
    liveConfirmation: body.liveConfirmation,
  };
  const result = await startGrid(params, context);
  audit.write('named_strategy_activated', { strategyId: profile.id, market: preview.market, mode: cfg.decibel.mode, paperInstanceId: context?.id || null });
  return result;
}

async function enableAiAutopilot(strategyId = 'ai_rotation') {
  const config = getAiConfig();
  if (!aiAutopilotAllowedInMode(cfg.decibel.mode)) throw new Error('大周期自动轮动仅允许 PAPER 模拟盘。');
  const profile = resolveStrategyProfile(strategyId, {
    runtimeMode: cfg.decibel.mode,
    aiConfigured: Boolean(config.apiKey),
    aiProvider: config.provider,
  });
  if (profile.mode !== 'dynamic') throw new Error('所选策略不是自动轮动策略。');
  updateAiSettings(ROOT, {
    provider: config.provider,
    autopilotEnabled: true,
    ...largeCycleAutopilotSettings(profile),
  });
  aiAutopilotState = {
    ...aiAutopilotState,
    strategyId: profile.id,
    candidate: null,
    candidateCount: 0,
    lastSignalTime: 0,
    historyEvaluatedAt: 0,
    historySignalsEvaluated: 0,
    lastSentimentDecision: null,
    lastSentimentReason: null,
    historyBootstrapPending: profile.requiresLiveSentiment !== true,
    lastReason: 'waiting',
    lastMessage: profile.requiresLiveSentiment
      ? `${profile.name}已启用，正在读取 Grok 实时情绪`
      : `${profile.name}已启用，正在读取历史行情`,
  };
  saveAiAutopilotState();
}

function largeCycleAutopilotSettings(profileOrId = 'ai_rotation') {
  const strategyId = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id;
  if (strategyId === SENTIMENT_STRATEGY_ID) {
    return {
      marketMinutes: SENTIMENT_POLICY.intervalMinutes,
      autopilotMinConfidence: SENTIMENT_POLICY.minConfidence,
      autopilotConfirmations: SENTIMENT_POLICY.confirmations,
      autopilotCooldownMinutes: SENTIMENT_POLICY.cooldownMinutes,
      autopilotMinTimeframeVotes: 3,
      autopilotNeutralAsPause: false,
    };
  }
  return {
    marketMinutes: 60,
    autopilotMinConfidence: 0.8,
    autopilotConfirmations: 12,
    autopilotCooldownMinutes: 2880,
    autopilotMinTimeframeVotes: 3,
    autopilotNeutralAsPause: false,
  };
}

async function disableAiAutopilot(message) {
  const config = getAiConfig();
  if (config.autopilotEnabled) updateAiSettings(ROOT, { provider: config.provider, autopilotEnabled: false });
  aiAutopilotState = {
    ...aiAutopilotState,
    strategyId: null,
    candidate: null,
    candidateCount: 0,
    historyBootstrapPending: false,
    lastReason: 'disabled',
    lastMessage: message || '大周期自动轮动已关闭',
  };
  saveAiAutopilotState();
}

async function startGrid(body, context = null) {
  const targetExchange = context?.exchange || exchange;
  const targetBot = context?.bot || bot;
  const markets = await targetExchange.getMarkets();
  const market = markets.find((item) => Number(item.marketId) === Number(body.marketId));
  if (!market) throw new Error('所选市场不存在，请刷新市场列表。');

  const params = { ...body };
  delete params.paperInstanceId;
  const strategyEvaluation = evaluateStrategyParams({ params, market, strategy: cfg.decibel.strategy || BTC_GRID_STRATEGY });
  if (!strategyEvaluation.ok) {
    audit.write('grid_start_denied', { reason: 'strategy_policy', errors: strategyEvaluation.errors, market: market.displayName }, 'warn');
    throw new Error(strategyEvaluation.errors.join(' '));
  }

  await targetExchange.refreshPositions?.();
  const existingPosition = targetExchange.getPosition?.(market.marketId) || null;
  const currentPrice = await targetExchange.getPrice(market.marketId);
  if (!(Number(currentPrice) > 0)) {
    audit.write('grid_start_denied', { reason: 'invalid_price', market: market.displayName }, 'warn');
    throw new Error('未能获取有效的 BTC 最新价格，已取消启动。');
  }

  if (cfg.decibel.mode === 'live') {
    if (!liveCapsConfigured()) {
      throw new Error('实盘风险上限未完整配置：杠杆、保证金占比和维持保证金率必须有效。');
    }
    const regrid = !!body.allowExistingPosition && !!existingPosition;
    if (existingPosition && !regrid) {
      audit.write('grid_start_denied', { reason: 'existing_position', market: market.displayName }, 'warn');
      throw new Error(`该市场已有仓位，普通启动已阻止。请使用“重新建网格”接管，或先用回收/平仓处理仓位。`);
    }
    const expected = `${regrid ? 'REGRID' : 'LIVE'} ${market.displayName}`;
    if (body.liveConfirmation !== expected) {
      audit.write('grid_start_denied', { reason: 'confirmation', market: market.displayName }, 'warn');
      throw new Error(`实盘确认短语不正确，应输入：${expected}`);
    }
    if (cfg.requireFreshPreflight && (!lastPreflight?.ready || Date.now() - lastPreflight.t > 5 * 60_000)) {
      audit.write('grid_start_denied', { reason: 'preflight', market: market.displayName }, 'warn');
      throw new Error('实盘预检未通过或已超过 5 分钟，请重新运行预检。');
    }
    const riskStatus = liveRisk.status(targetBot.getState().equity);
    if (riskStatus.halted) {
      audit.write('grid_start_denied', { reason: riskStatus.reason }, 'error');
      throw new Error(`实盘风控已锁定：${riskStatus.reason}。停止网格后手动重置风险基线才能继续。`);
    }
  }

  const evaluation = evaluateStartRisk({
    params,
    market,
    equity: targetBot.getState().equity,
    policy: strategyRiskPolicy(params.strategyId),
    existingPosition,
    currentPrice,
  });
  if (!evaluation.ok) {
    audit.write('grid_start_denied', { reason: 'risk_policy', errors: evaluation.errors, metrics: evaluation.metrics }, 'warn');
    throw new Error(evaluation.errors.join(' '));
  }
  if (evaluation.warnings.length) audit.write('grid_start_warning', { warnings: evaluation.warnings, metrics: evaluation.metrics }, 'warn');

  delete params.liveConfirmation;
  delete params.allowExistingPosition;
  const result = await targetBot.start(params);
  await refreshPaperReadiness(context);
  audit.write('grid_started', {
    market: market.displayName,
    params,
    paperInstanceId: context?.id || null,
    state: compactState(result),
  }, cfg.decibel.mode === 'live' ? 'warn' : 'info');
  if (cfg.decibel.mode === 'live') {
    liveRisk.observe(result.equity);
    lastPreflight = null;
    await notifySafe(`GridPilot 实盘已启动：${market.displayName}，${params.gridCount} 格，${params.leverage}x。`);
  }
  return publicState(null, context?.id);
}

async function validateRangeRisk(body, context = null) {
  const targetExchange = context?.exchange || exchange;
  const targetBot = context?.bot || bot;
  if (!targetBot.running || !targetBot.config) throw new Error('网格未运行，无法调整区间。');
  const markets = await targetExchange.getMarkets();
  const market = markets.find((item) => Number(item.marketId) === Number(targetBot.config.marketId));
  if (!market) throw new Error('当前模拟盘的 BTC 市场不可用。');
  const nextParams = { ...targetBot.config, ...body };
  const strategyEvaluation = evaluateStrategyParams({ params: nextParams, market, strategy: cfg.decibel.strategy || BTC_GRID_STRATEGY });
  if (!strategyEvaluation.ok) throw new Error(strategyEvaluation.errors.join(' '));
  await targetExchange.refreshPositions?.();
  const currentPrice = await targetExchange.getPrice(market.marketId);
  const evaluation = evaluateStartRisk({
    params: nextParams,
    market,
    equity: targetBot.getState().equity,
    policy: strategyRiskPolicy(nextParams.strategyId),
    existingPosition: targetExchange.getPosition?.(market.marketId) || null,
    currentPrice,
  });
  if (!evaluation.ok) {
    audit.write('range_adjust_denied', { paperInstanceId: context?.id || null, errors: evaluation.errors, metrics: evaluation.metrics }, 'warn');
    throw new Error(evaluation.errors.join(' '));
  }
}

async function marketById(marketId) {
  const markets = await exchange.getMarkets();
  const market = markets.find((item) => Number(item.marketId) === Number(marketId));
  if (!market) throw new Error('所选市场不存在，请刷新市场列表。');
  return market;
}

async function runPreflight() {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  add('mode', '运行模式', cfg.decibel.mode === 'live' ? 'pass' : 'warn', cfg.decibel.mode === 'live' ? 'LIVE 实盘' : '当前仍是 PAPER 模拟盘');
  add('gate', '实盘总闸门', cfg.enableLiveTrading ? 'pass' : 'fail', cfg.enableLiveTrading ? '已开启' : 'ENABLE_LIVE_TRADING 未开启');
  add('confirmation', '启动确认短语', cfg.liveConfirmation === 'I_ACCEPT_DECIBEL_LIVE_RISK' ? 'pass' : 'fail', cfg.liveConfirmation === 'I_ACCEPT_DECIBEL_LIVE_RISK' ? '已配置' : 'LIVE_CONFIRMATION 不正确');
  add('apiKey', 'Geomi API Key', cfg.decibel.apiKey ? 'pass' : 'fail', cfg.decibel.apiKey ? '已配置' : '未配置');
  add('privateKey', 'API 钱包私钥', cfg.decibel.privateKey ? 'pass' : 'fail', cfg.decibel.privateKey ? '已加载且不会回显' : '未配置');
  add('subaccount', 'Trading Account', /^0x[0-9a-fA-F]{64}$/.test(cfg.decibel.subaccount) ? 'pass' : 'fail', maskAddress(cfg.decibel.subaccount));
  add('riskCaps', '实盘风险上限', liveCapsConfigured() ? 'pass' : 'fail', liveCapsConfigured()
    ? `杠杆 ≤ ${cfg.riskPolicy.maxLeverage}x · 保证金占比 ≤ ${cfg.riskPolicy.maxMarginPct}% · 维持保证金率 ≥ ${cfg.riskPolicy.minMaintenanceMarginRatio}%`
    : '杠杆上限、保证金占比和维持保证金率必须有效');
  add('riskLock', '日内风险锁', liveRisk.status(bot.getState().equity).halted ? 'fail' : 'pass', liveRisk.status(bot.getState().equity).reason || '未触发');
  add('notifications', '异常通知', notifier.enabled ? 'pass' : 'warn', notifier.enabled ? '已配置' : '未配置 Telegram/Webhook');

  let probe = null;
  try {
    probe = await exchange.preflight();
    add('connection', '交易连接', probe.ok && probe.dataSource === 'real' ? 'pass' : 'fail', `${probe.dataSource || 'unknown'} · ${probe.marketCount || 0} 个市场`);
    const networkMatches = !probe.network || probe.network === cfg.decibel.network;
    add('networkMatch', '目标网络', networkMatches ? 'pass' : 'fail', networkMatches
      ? String(cfg.decibel.network).toUpperCase()
      : `配置为 ${String(cfg.decibel.network).toUpperCase()}，当前数据来自 ${String(probe.network).toUpperCase()}`);
    add('equity', '账户权益', Number(probe.equity) > 0 ? 'pass' : 'fail', `${probe.equity ?? '--'} USDC`);
    add('apiWalletGas', 'API 钱包 Gas', Number(probe.apiWalletApt) > 0 ? 'pass' : 'fail', probe.apiWalletApt == null ? '无法读取 APT 余额' : `${probe.apiWalletApt} APT · ${maskAddress(probe.apiWalletAddress)}`);
    add('price', '实时价格', Number(probe.priceProbe) > 0 ? 'pass' : 'fail', String(probe.priceProbe ?? '--'));
    add('existingOrders', '现有挂单', probe.openOrderCount > 0 ? 'warn' : 'pass', `${probe.openOrderCount || 0} 单`);
    add('existingPositions', '现有持仓', probe.positionCount > 0 ? 'warn' : 'pass', `${probe.positionCount || 0} 个市场`);
  } catch (error) {
    add('connection', '交易连接', 'fail', error?.message || String(error));
  }

  const ready = cfg.decibel.mode === 'live' && checks.every((check) => check.status !== 'fail');
  lastPreflight = { t: Date.now(), expiresAt: Date.now() + 5 * 60_000, ready, checks, probe };
  audit.write('preflight_completed', { ready, checks, probe: probe ? { ...probe, balance: probe.balance, equity: probe.equity } : null }, ready ? 'info' : 'warn');
  return lastPreflight;
}

function publicState(consoleMode = null, paperInstanceId = null) {
  const context = cfg.decibel.mode === 'paper' && paperInstances
    ? paperContext(paperInstanceId || PRIMARY_PAPER_INSTANCE_ID)
    : null;
  const state = (context?.bot || bot).getState();
  const notificationSettings = notifier.publicSettings();
  const readiness = publicPaperReadiness(state, context);
  const cachedReadiness = context?.primary === false ? context.lastReadiness : lastPaperReadiness;
  const mergedReadiness = cachedReadiness
    ? {
      ...cachedReadiness,
      ...readiness,
      price: readiness.price || cachedReadiness.price,
      priceValid: readiness.priceValid || cachedReadiness.priceValid,
      dataSource: readiness.dataSource || cachedReadiness.dataSource,
    }
    : readiness;
  const result = {
    ...state,
    paperInstance: context ? paperInstanceSummary(context) : null,
    paperInstances: context ? paperInstanceSummaries() : [],
    liveRisk: context?.primary === false ? null : liveRisk.status(state.equity),
    dailyPnl: context?.primary === false ? null : dailyPnl.summary(state.equity, notificationSettings.timezone),
    preflight: lastPreflight ? { t: lastPreflight.t, expiresAt: lastPreflight.expiresAt, ready: lastPreflight.ready } : null,
    paperReadiness: mergedReadiness,
    aiAutopilot: context?.primary === false
      ? { enabled: false, effective: false, message: '自动轮动暂只允许主模拟盘' }
      : aiAutopilotPublicState(),
  };
  return consoleMode ? projectDashboardState(result, cfg.decibel.mode, consoleMode) : result;
}

function autoRebalancePublicState(context = null) {
  const targetBot = context?.bot || bot;
  if (strategyEngine(targetBot) === 'turtle' && targetBot.config) {
    return {
      enabled: false,
      intervalMs: null,
      cooldownMs: null,
      lastCheckAt: targetBot.getState().turtle?.lastSignalRefreshAt || null,
      lastAdjustedAt: null,
      cooldownUntil: null,
      inFlight: false,
      last: { t: targetBot.getState().turtle?.lastSignalRefreshAt || null, code: 'strategy_managed', reason: '海龟信号每小时读取已完成日 K 线，网格调区间不适用' },
    };
  }
  const enabled = cfg.autoRebalance && (cfg.decibel.mode !== 'live' || cfg.autoLiveRebalance);
  if (context?.primary === false) {
    const status = context.meta.autoRebalance || {};
    return {
      enabled,
      intervalMs: cfg.autoRebalanceIntervalMs,
      cooldownMs: cfg.autoRebalanceCooldownMs,
      lastCheckAt: status.lastCheckAt || null,
      lastAdjustedAt: status.lastAdjustedAt || null,
      cooldownUntil: status.lastAdjustedAt ? status.lastAdjustedAt + cfg.autoRebalanceCooldownMs : null,
      inFlight: context.rebalanceInFlight,
      last: status.last || { t: null, code: 'not_running', reason: '网格尚未运行' },
    };
  }
  return {
    enabled,
    intervalMs: cfg.autoRebalanceIntervalMs,
    cooldownMs: cfg.autoRebalanceCooldownMs,
    lastCheckAt: lastAutoRebalanceCheckAt || null,
    lastAdjustedAt: lastAutoRebalanceAt || null,
    cooldownUntil: lastAutoRebalanceAt ? lastAutoRebalanceAt + cfg.autoRebalanceCooldownMs : null,
    inFlight: autoRebalanceInFlight,
    last: lastAutoRebalanceStatus,
  };
}

function loadAutoRebalanceState() {
  try { return JSON.parse(fs.readFileSync(AUTO_REBALANCE_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function saveAutoRebalanceState() {
  try {
    const tmp = AUTO_REBALANCE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      lastAdjustedAt: lastAutoRebalanceAt || null,
      lastCheckAt: lastAutoRebalanceCheckAt || null,
      last: lastAutoRebalanceStatus,
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, AUTO_REBALANCE_FILE);
  } catch { /* status persistence must not affect order management */ }
}

function loadAiAutopilotState() {
  try { return JSON.parse(fs.readFileSync(AI_AUTOPILOT_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function saveAiAutopilotState() {
  try {
    const tmp = AI_AUTOPILOT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(aiAutopilotState, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, AI_AUTOPILOT_FILE);
  } catch { /* status persistence must not affect order management */ }
}

function aiAutopilotPublicState() {
  const config = getAiConfig();
  const enabled = config.autopilotEnabled === true;
  const profile = activeAiAutopilotProfile();
  const effective = enabled && aiAutopilotAllowedInMode(cfg.decibel.mode) && config.marketMinutes > 0;
  let message = aiAutopilotState.lastMessage || (enabled ? '等待下一次大周期分析' : '大周期自动轮动已关闭');
  if (enabled && aiAutopilotState.lastReason === 'invalid_decision' && !bot.getState().running) {
    message = '历史回放已完成，但大周期方向未一致，暂不挂单';
  }
  if (cfg.decibel.mode === 'live') message = '实盘禁止大周期自动轮动';
  else if (!enabled) message = '大周期自动轮动已关闭';
  else if (!(config.marketMinutes > 0)) message = '大周期分析间隔已关闭';
  return {
    strategyId: enabled ? profile.id : null,
    strategyName: enabled ? profile.name : null,
    experimental: enabled ? profile.experimental === true : false,
    requiresLiveSentiment: enabled ? profile.requiresLiveSentiment === true : false,
    enabled,
    effective,
    intervalMinutes: config.marketMinutes,
    minConfidence: config.autopilotMinConfidence,
    confirmationsRequired: config.autopilotConfirmations,
    cooldownMinutes: config.autopilotCooldownMinutes,
    minTimeframeVotes: config.autopilotMinTimeframeVotes,
    neutralAsPause: config.autopilotNeutralAsPause,
    candidate: aiAutopilotState.candidate || null,
    candidateCount: Number(aiAutopilotState.candidateCount) || 0,
    lastAnalysisAt: Number(aiAutopilotState.lastAnalysisAt) || null,
    lastSignalTime: Number(aiAutopilotState.lastSignalTime) || null,
    historyEvaluatedAt: Number(aiAutopilotState.historyEvaluatedAt) || null,
    historySignalsEvaluated: Number(aiAutopilotState.historySignalsEvaluated) || 0,
    historyBootstrapPending: aiAutopilotState.historyBootstrapPending === true,
    lastRegime: aiAutopilotState.lastRegime || null,
    lastConfidence: aiAutopilotState.lastConfidence ?? null,
    lastActionAt: Number(aiAutopilotState.lastActionAt) || null,
    lastAction: aiAutopilotState.lastAction || null,
    lastTarget: aiAutopilotState.lastTarget || null,
    sentimentDecision: aiAutopilotState.lastSentimentDecision || null,
    sentimentReason: aiAutopilotState.lastSentimentReason || null,
    sentiment: profile.requiresLiveSentiment ? aiService.sentiment : null,
    sentimentError: profile.requiresLiveSentiment ? aiService.sentimentError : null,
    cooldownUntil: aiAutopilotState.lastActionAt
      ? Number(aiAutopilotState.lastActionAt) + config.autopilotCooldownMinutes * 60_000
      : null,
    lastReason: aiAutopilotState.lastReason || (enabled ? 'waiting' : 'disabled'),
    message,
    inFlight: aiAutopilotInFlight || aiAutopilotBootstrapInFlight,
  };
}

function publicPaperReadiness(state = bot.getState(), context = null) {
  const targetExchange = context?.exchange || exchange;
  if (state.engine === 'turtle') {
    const turtle = state.turtle || {};
    const noOrphanState = state.running || (!state.recovery && Number(state.openOrders || 0) === 0 && Number(state.exchangeOpenOrders || 0) <= 0);
    const signalReady = Number(turtle.entryHigh) > 0 && Number(turtle.exitLow) > 0 && Number(turtle.atrN) > 0 && !turtle.signalError;
    const strategyCheck = { ok: signalReady, errors: signalReady ? [] : [turtle.signalError || '海龟日线信号尚未就绪。'] };
    const riskCheck = {
      ok: Number(turtle.unitSize) >= Number(state.config?.minOrderSize || 0),
      errors: [], warnings: [],
      metrics: { requiredMargin: state.risk?.requiredMargin ?? 0, marginPct: state.equity > 0 ? roundNumber((state.risk?.requiredMargin || 0) / state.equity * 100, 2) : null },
    };
    return {
      mode: cfg.decibel.mode,
      isPaper: true,
      btcOnly: cfg.decibel.btcOnly,
      market: state.config?.displayName || 'BTC-USD',
      paperInstanceId: context?.id || null,
      dataSource: state.health?.dataSource || targetExchange.dataSource || null,
      price: Number(state.lastPrice) > 0 ? Number(state.lastPrice) : null,
      priceValid: Number(state.lastPrice) > 0,
      autoRebalance: autoRebalancePublicState(context),
      running: !!state.running,
      paramsConfigured: !!state.config,
      strategyCheck,
      riskCheck,
      noOrphanState,
      recovery: false,
      ready: signalReady && riskCheck.ok && noOrphanState,
      lastAutoRebalance: { t: turtle.lastSignalRefreshAt || null, code: 'strategy_managed', reason: '海龟参数由突破通道和 ATR 管理' },
    };
  }
  const params = state.config && state.config.mode !== 'recovery' ? state.config : null;
  const strategy = cfg.decibel.strategy || BTC_GRID_STRATEGY;
  const marketName = params?.displayName || 'BTC-USD';
  const strategyCheck = params
    ? evaluateStrategyParams({ params, market: { displayName: marketName }, strategy })
    : { ok: false, errors: ['尚未填入网格参数。'] };
  const price = Number(state.lastPrice);
  const riskCheck = params
    ? evaluateStartRisk({
      params,
      market: { displayName: marketName, minOrderSize: params.minOrderSize, maxLeverage: params.maxLeverage },
      equity: state.equity,
      policy: strategyRiskPolicy(params.strategyId),
      existingPosition: state.position,
      currentPrice: price,
    })
    : { ok: false, metrics: null, errors: ['尚未配置运行中的网格参数。'], warnings: [] };
  const noOrphanState = state.running || (!state.recovery && Number(state.openOrders || 0) === 0 && Number(state.exchangeOpenOrders || 0) <= 0);
  return {
    mode: cfg.decibel.mode,
    isPaper: cfg.decibel.mode === 'paper',
    btcOnly: cfg.decibel.btcOnly,
    market: marketName,
    paperInstanceId: context?.id || null,
    dataSource: state.health?.dataSource || targetExchange.dataSource || null,
    price: price > 0 ? price : null,
    priceValid: price > 0,
    autoRebalance: autoRebalancePublicState(context),
    running: !!state.running,
    paramsConfigured: !!params,
    strategyCheck,
    riskCheck,
    noOrphanState,
    recovery: !!state.recovery,
    ready: cfg.decibel.mode === 'paper' && price > 0 && strategyCheck.ok && riskCheck.ok && noOrphanState,
    lastAutoRebalance: context?.meta.autoRebalance?.last || lastAutoRebalanceStatus,
  };
}

async function buildPaperReadiness(input = {}, context = null) {
  const targetExchange = context?.exchange || exchange;
  const targetBot = context?.bot || bot;
  const markets = await targetExchange.getMarkets();
  const requestedId = Number(input.marketId || targetBot.config?.marketId || 1);
  const market = markets.find((item) => Number(item.marketId) === requestedId) || markets.find((item) => String(item.displayName).toUpperCase() === 'BTC-USD');
  let price = null;
  try { price = Number(await targetExchange.getPrice(market?.marketId)); } catch { /* readiness reports the failed price check */ }
  const cleanInput = { ...input };
  delete cleanInput.paperInstanceId;
  const params = Object.keys(cleanInput).length ? cleanInput : (targetBot.config || null);
  const state = targetBot.getState();
  if (state.engine === 'turtle') {
    const readiness = publicPaperReadiness(state, context);
    const turtle = state.turtle || {};
    const checks = [
      { id: 'mode', label: '运行模式', status: 'pass', detail: 'PAPER 模拟盘' },
      { id: 'btcOnly', label: '市场范围', status: cfg.decibel.btcOnly ? 'pass' : 'fail', detail: state.config?.displayName || 'BTC-USD' },
      { id: 'source', label: '价格数据源', status: readiness.priceValid ? 'pass' : 'fail', detail: `${targetExchange.dataSource || 'unknown'} · ${readiness.price || '无有效价格'}` },
      { id: 'signal', label: '海龟日线信号', status: readiness.strategyCheck.ok ? 'pass' : 'fail', detail: readiness.strategyCheck.ok ? `突破 ${roundNumber(turtle.entryHigh, 2)} · 退出 ${roundNumber(turtle.exitLow, 2)} · N ${roundNumber(turtle.atrN, 2)}` : readiness.strategyCheck.errors.join(' ') },
      { id: 'risk', label: '单位风险与名义上限', status: readiness.riskCheck.ok ? 'pass' : 'fail', detail: `每单位风险 ${turtle.riskPct}% · 总名义金额上限 ${turtle.maxNotionalPct}%` },
      { id: 'orders', label: '遗留挂单/恢复状态', status: readiness.noOrphanState ? 'pass' : 'fail', detail: readiness.noOrphanState ? '无异常遗留状态' : '存在未托管状态' },
      { id: 'running', label: '海龟策略状态', status: state.running ? 'pass' : 'warn', detail: state.running ? (state.position ? '持仓管理中' : '运行中，等待突破') : '未运行' },
    ];
    return { ...readiness, params: state.config, checks, ready: checks.every((check) => check.status !== 'fail') };
  }
  const strategy = cfg.decibel.strategy || BTC_GRID_STRATEGY;
  const strategyCheck = params && market
    ? evaluateStrategyParams({ params, market, strategy })
    : { ok: false, errors: [market ? '尚未填入网格参数。' : 'BTC-USD 市场不可用。'] };
  const riskCheck = params && market
    ? evaluateStartRisk({ params, market, equity: state.equity, policy: strategyRiskPolicy(params.strategyId), existingPosition: targetExchange.getPosition?.(market.marketId) || null, currentPrice: price })
    : { ok: false, errors: ['尚未配置网格参数。'], warnings: [], metrics: null };
  let preflight = null;
  try { preflight = await targetExchange.preflight?.(); } catch { /* readiness reports the residual-state check */ }
  const noOrphanState = state.running || (!state.recovery && Number(state.openOrders || 0) === 0 && Number(preflight?.openOrderCount || 0) === 0);
  const checks = [
    { id: 'mode', label: '运行模式', status: cfg.decibel.mode === 'paper' ? 'pass' : 'warn', detail: cfg.decibel.mode === 'paper' ? 'PAPER 模拟盘' : '当前为 LIVE 实盘' },
    { id: 'btcOnly', label: '市场范围', status: cfg.decibel.btcOnly && market && String(market.displayName).toUpperCase() === 'BTC-USD' ? 'pass' : 'fail', detail: cfg.decibel.btcOnly ? (market?.displayName || 'BTC-USD') : 'BTC-only 未锁定' },
    { id: 'source', label: '价格数据源', status: price > 0 ? 'pass' : 'fail', detail: `${targetExchange.dataSource || 'unknown'} · ${price > 0 ? price : '无有效价格'}` },
    { id: 'price', label: '有效 BTC 价格', status: price > 0 ? 'pass' : 'fail', detail: price > 0 ? String(price) : '未读取到有效价格' },
    { id: 'strategy', label: '策略参数范围', status: strategyCheck.ok ? 'pass' : 'fail', detail: strategyCheck.ok ? `${strategy.minGridCount}-${strategy.maxGridCount} 格约束通过` : strategyCheck.errors.join(' ') },
    { id: 'inventoryGuard', label: '方向敞口保护', status: Number(params?.maxDirectionalNotionalPct ?? strategy.maxDirectionalNotionalPct) > 0 ? 'pass' : 'fail', detail: `净方向名义价值不超过权益的 ${Number(params?.maxDirectionalNotionalPct ?? strategy.maxDirectionalNotionalPct) || '--'}%` },
    { id: 'trendGuard', label: '趋势保护', status: (params?.trendGuardEnabled ?? strategy.trendGuardEnabled) ? 'pass' : 'warn', detail: (params?.trendGuardEnabled ?? strategy.trendGuardEnabled) ? '已开启 · 每 5 分钟检查 BTC 1h K 线' : '已人工关闭' },
    { id: 'risk', label: '保证金和风险', status: riskCheck.ok ? 'pass' : 'fail', detail: riskCheck.ok ? `预计保证金 ${riskCheck.metrics?.requiredMargin ?? '--'} USDC` : riskCheck.errors.join(' ') },
    { id: 'orders', label: '遗留挂单/恢复状态', status: noOrphanState ? 'pass' : 'fail', detail: noOrphanState ? '无异常遗留状态' : '存在未托管挂单或恢复阶梯' },
    { id: 'running', label: '网格状态', status: state.running ? 'warn' : 'pass', detail: state.running ? '运行中' : '未运行，等待人工启动' },
  ];
  return {
    ...publicPaperReadiness(state, context),
    price: price > 0 ? price : null,
    priceValid: price > 0,
    dataSource: targetExchange.dataSource || null,
    market: market?.displayName || null,
    params,
    paramsConfigured: !!params,
    strategyCheck,
    riskCheck,
    checks,
    ready: cfg.decibel.mode === 'paper' && checks.every((check) => check.status !== 'fail') && !!params,
  };
}

async function refreshPaperReadiness(context = null) {
  const targetBot = context?.bot || bot;
  const readiness = await buildPaperReadiness(targetBot.config || {}, context);
  if (context?.primary === false) context.lastReadiness = readiness;
  else lastPaperReadiness = readiness;
}

async function refreshAllPaperReadiness() {
  if (cfg.decibel.mode !== 'paper' || !paperInstances) return refreshPaperReadiness();
  for (const context of paperInstances.list()) await refreshPaperReadiness(context);
}

async function monitorLiveRisk() {
  const state = bot.getState();
  dailyPnl.observe(state.equity, notifier.publicSettings().timezone);
  const freshAlerts = (state.alerts || []).filter((alert) => alert.t > lastAlertAt).sort((a, b) => a.t - b.t);
  for (const alert of freshAlerts) {
    lastAlertAt = Math.max(lastAlertAt, alert.t);
    audit.write('bot_alert', { message: alert.message }, /⚠|❌|失败|不足|异常/.test(alert.message) ? 'warn' : 'info');
    if (/⚠|❌|失败|不足|异常|平仓/.test(alert.message)) await notifySafe(`[GridPilot] ${alert.message}`);
  }
  if (cfg.decibel.mode !== 'live') return;
  const riskStatus = liveRisk.observe(state.equity);
  if (state.running && riskStatus.halted) await emergencyStop(`自动风控触发：${riskStatus.reason}`);
}

async function maybeAutoRebalance() {
  const now = Date.now();
  const enabled = cfg.autoRebalance && (cfg.decibel.mode !== 'live' || cfg.autoLiveRebalance);
  if (autoRebalanceInFlight || aiAutopilotInFlight) return;
  const state = bot.getState();
  if (state.engine === 'turtle') {
    lastAutoRebalanceStatus = { t: state.turtle?.lastSignalRefreshAt || now, code: 'strategy_managed', reason: '海龟参数由突破通道和 ATR 管理' };
    return;
  }
  const gate = autoRebalanceGate({
    enabled,
    running: state.running,
    hasConfig: !!bot.config && bot.config.mode !== 'recovery',
    now,
    lastCheckAt: lastAutoRebalanceCheckAt,
    intervalMs: cfg.autoRebalanceIntervalMs,
    lastAdjustedAt: lastAutoRebalanceAt,
    cooldownMs: cfg.autoRebalanceCooldownMs,
    price: state.lastPrice,
    lower: bot.config?.lower,
    upper: bot.config?.upper,
    edgePct: cfg.decibel.strategy?.edgeTriggerPct || BTC_GRID_STRATEGY.edgeTriggerPct,
    requireEdge: false,
  });
  if (!gate.ok) {
    // Keep the API honest about the last scheduler decision without treating a
    // skipped check as a successful adjustment or starting the cooldown.
    if (gate.reason !== 'check_interval' && gate.reason !== 'disabled') {
      lastAutoRebalanceStatus = { t: now, code: gate.reason, reason: autoRebalanceReason(gate.reason) };
    }
    return;
  }
  lastAutoRebalanceCheckAt = now;
  lastAutoRebalanceStatus = { t: now, code: 'checking', reason: '正在读取 BTC 1h K 线和 ATR' };

  autoRebalanceInFlight = true;
  try {
    const market = await marketById(bot.config.marketId);
    const latestPrice = Number(await exchange.getPrice(market.marketId));
    const latestGate = autoRebalanceGate({
      enabled, running: true, hasConfig: true, now, lastCheckAt: 0,
      lastAdjustedAt: lastAutoRebalanceAt, cooldownMs: cfg.autoRebalanceCooldownMs,
      price: latestPrice, lower: bot.config.lower, upper: bot.config.upper,
      edgePct: cfg.decibel.strategy?.edgeTriggerPct || BTC_GRID_STRATEGY.edgeTriggerPct,
      requireEdge: false,
    });
    if (!latestGate.ok) {
      lastAutoRebalanceStatus = { t: now, code: latestGate.reason, reason: autoRebalanceReason(latestGate.reason) };
      return;
    }
    const lower = Number(bot.config.lower), upper = Number(bot.config.upper);
    const previousParams = adaptiveParameterSnapshot(bot.config);
    const candles = await exchange.getCandles(market.marketId, 3600, 200);
    const analysis = candles.length >= 20 ? analyzeTrend(candles) : { atrPct: null, trend: 'range' };
    const suggestion = suggestAdaptiveGrid({
      price: latestPrice,
      atrPct: analysis.atrPct,
      equity: bot.getState().equity,
      market,
      trend: analysis.trend,
      mode: bot.config.mode,
      policy: strategyGridPolicy(bot.config.strategyId),
      execution: exchangeExecutionAssumptions(exchange),
    });
    const change = adaptiveGridChangedEnough({
      previous: bot.config,
      next: suggestion,
      price: latestPrice,
      edgePct: cfg.decibel.strategy?.edgeTriggerPct || BTC_GRID_STRATEGY.edgeTriggerPct,
      minRangeChangePct: cfg.decibel.strategy?.minRangeChangePct || BTC_GRID_STRATEGY.minRangeChangePct,
    });
    if (!change.ok) {
      lastAutoRebalanceStatus = { t: now, code: 'insufficient_change', reason: autoRebalanceReason('insufficient_change') };
      audit.write('auto_rebalance_skipped', { reason: 'insufficient_change', previous: previousParams, suggestion: adaptiveParameterSnapshot(suggestion), change });
      return;
    }
    const nextParams = {
      lower: change.reasons.includes('range') ? suggestion.lower : lower,
      upper: change.reasons.includes('range') ? suggestion.upper : upper,
      gridCount: change.reasons.includes('grid_count') ? suggestion.gridCount : bot.config.gridCount,
      sizeBase: change.reasons.includes('size') ? suggestion.sizeBase : bot.config.sizeBase,
      leverage: change.reasons.includes('leverage') ? suggestion.leverage : bot.config.leverage,
    };
    const economics = bot.config.mode === 'neutral'
      ? neutralRebalanceEconomics({
        previous: bot.config,
        next: nextParams,
        price: latestPrice,
        reasons: change.reasons,
        nearEdge: change.nearEdge,
        execution: {
          ...exchangeExecutionAssumptions(exchange),
          costCoverageMultiple: bot.config.minRoundTripCostMultiple,
        },
      })
      : { ok: true, reason: 'directional_grid' };
    if (!economics.ok) {
      lastAutoRebalanceStatus = { t: now, code: 'uneconomic_change', reason: autoRebalanceReason('uneconomic_change') };
      audit.write('auto_rebalance_skipped', { reason: 'uneconomic_change', economics, previous: previousParams, suggestion: adaptiveParameterSnapshot(suggestion), change });
      return;
    }
    await validateRangeRisk(nextParams);
    const state = await bot.adjustRange({
      ...nextParams,
      measurementReason: 'auto_parameters',
    });
    lastAutoRebalanceAt = now;
    lastAutoRebalanceStatus = { t: now, code: 'adjusted', reason: autoRebalanceReason('adjusted') };
    saveAutoRebalanceState();
    audit.write('auto_rebalanced', {
      market: market.displayName,
      previous: previousParams,
      next: adaptiveParameterSnapshot(state.config),
      changes: change.reasons,
      gridCount: state.config?.gridCount,
      sizeBase: state.config?.sizeBase,
      leverage: state.config?.leverage,
      atrPct: suggestion.atrPct,
      economics,
    }, 'warn');
    await refreshPaperReadiness();
  } catch (error) {
    const detail = error?.message || String(error);
    const code = /保证金|风险|上限|最小/.test(detail) ? 'risk_rejected' : 'failed';
    lastAutoRebalanceStatus = { t: now, code, reason: autoRebalanceReason(code, detail) };
    saveAutoRebalanceState();
    throw error;
  } finally {
    autoRebalanceInFlight = false;
  }
}

async function maybeAutoRebalancePaperInstances() {
  if (cfg.decibel.mode !== 'paper' || !paperInstances) return;
  for (const context of paperInstances.list().filter((item) => !item.primary)) {
    await maybeAutoRebalancePaperInstance(context);
  }
}

async function maybeAutoRebalancePaperInstance(context) {
  const now = Date.now();
  const enabled = cfg.autoRebalance;
  const status = context.meta.autoRebalance;
  if (context.rebalanceInFlight) return;
  const state = context.bot.getState();
  if (state.engine === 'turtle') {
    status.last = { t: state.turtle?.lastSignalRefreshAt || now, code: 'strategy_managed', reason: '海龟参数由突破通道和 ATR 管理' };
    paperInstances.updateAutoRebalance(context.id, status);
    return;
  }
  const gate = autoRebalanceGate({
    enabled,
    running: state.running,
    hasConfig: !!context.bot.config && context.bot.config.mode !== 'recovery',
    now,
    lastCheckAt: status.lastCheckAt,
    intervalMs: cfg.autoRebalanceIntervalMs,
    lastAdjustedAt: status.lastAdjustedAt,
    cooldownMs: cfg.autoRebalanceCooldownMs,
    price: state.lastPrice,
    lower: context.bot.config?.lower,
    upper: context.bot.config?.upper,
    edgePct: cfg.decibel.strategy?.edgeTriggerPct || BTC_GRID_STRATEGY.edgeTriggerPct,
    requireEdge: false,
  });
  if (!gate.ok) {
    if (gate.reason !== 'check_interval' && gate.reason !== 'disabled') {
      status.last = { t: now, code: gate.reason, reason: autoRebalanceReason(gate.reason) };
      paperInstances.updateAutoRebalance(context.id, status);
    }
    return;
  }

  status.lastCheckAt = now;
  status.last = { t: now, code: 'checking', reason: '正在读取 BTC 1h K 线和 ATR' };
  paperInstances.updateAutoRebalance(context.id, status);
  context.rebalanceInFlight = true;
  try {
    const markets = await context.exchange.getMarkets();
    const market = markets.find((item) => Number(item.marketId) === Number(context.bot.config.marketId));
    if (!market) throw new Error('BTC-USD 市场不存在。');
    const latestPrice = Number(await context.exchange.getPrice(market.marketId));
    const candles = await context.exchange.getCandles(market.marketId, 3600, 200);
    const analysis = candles.length >= 20 ? analyzeTrend(candles) : { atrPct: null, trend: 'range' };
    const suggestion = suggestAdaptiveGrid({
      price: latestPrice,
      atrPct: analysis.atrPct,
      equity: context.bot.getState().equity,
      market,
      trend: analysis.trend,
      mode: context.bot.config.mode,
      policy: strategyGridPolicy(context.bot.config.strategyId),
      execution: exchangeExecutionAssumptions(context.exchange),
    });
    const change = adaptiveGridChangedEnough({
      previous: context.bot.config,
      next: suggestion,
      price: latestPrice,
      edgePct: cfg.decibel.strategy?.edgeTriggerPct || BTC_GRID_STRATEGY.edgeTriggerPct,
      minRangeChangePct: cfg.decibel.strategy?.minRangeChangePct || BTC_GRID_STRATEGY.minRangeChangePct,
    });
    if (!change.ok) {
      status.last = { t: now, code: 'insufficient_change', reason: autoRebalanceReason('insufficient_change') };
      paperInstances.updateAutoRebalance(context.id, status);
      return;
    }
    const nextParams = {
      lower: change.reasons.includes('range') ? suggestion.lower : context.bot.config.lower,
      upper: change.reasons.includes('range') ? suggestion.upper : context.bot.config.upper,
      gridCount: change.reasons.includes('grid_count') ? suggestion.gridCount : context.bot.config.gridCount,
      sizeBase: change.reasons.includes('size') ? suggestion.sizeBase : context.bot.config.sizeBase,
      leverage: change.reasons.includes('leverage') ? suggestion.leverage : context.bot.config.leverage,
    };
    const economics = context.bot.config.mode === 'neutral'
      ? neutralRebalanceEconomics({
        previous: context.bot.config,
        next: nextParams,
        price: latestPrice,
        reasons: change.reasons,
        nearEdge: change.nearEdge,
        execution: {
          ...exchangeExecutionAssumptions(context.exchange),
          costCoverageMultiple: context.bot.config.minRoundTripCostMultiple,
        },
      })
      : { ok: true, reason: 'directional_grid' };
    if (!economics.ok) {
      status.last = { t: now, code: 'uneconomic_change', reason: autoRebalanceReason('uneconomic_change') };
      paperInstances.updateAutoRebalance(context.id, status);
      audit.write('paper_instance_auto_rebalance_skipped', { paperInstanceId: context.id, reason: 'uneconomic_change', economics, change });
      return;
    }
    await validateRangeRisk(nextParams, context);
    const adjusted = await context.bot.adjustRange({ ...nextParams, measurementReason: 'auto_parameters' });
    status.lastAdjustedAt = now;
    status.last = { t: now, code: 'adjusted', reason: autoRebalanceReason('adjusted') };
    paperInstances.updateAutoRebalance(context.id, status);
    audit.write('paper_instance_auto_rebalanced', {
      paperInstanceId: context.id,
      strategyId: adjusted.config?.strategyId,
      changes: change.reasons,
      next: adaptiveParameterSnapshot(adjusted.config),
      economics,
    }, 'warn');
    await refreshPaperReadiness(context);
  } catch (error) {
    const detail = error?.message || String(error);
    const code = /保证金|风险|上限|最小/.test(detail) ? 'risk_rejected' : 'failed';
    status.last = { t: now, code, reason: autoRebalanceReason(code, detail) };
    paperInstances.updateAutoRebalance(context.id, status);
    throw error;
  } finally {
    context.rebalanceInFlight = false;
  }
}

async function maybeApplyAiAutopilot(analysis) {
  if (strategyEngine(bot) === 'turtle' && bot.running) return;
  const config = getAiConfig();
  const profile = activeAiAutopilotProfile();
  if (config.autopilotEnabled === true
    && profile.requiresLiveSentiment !== true
    && aiAutopilotState.historyBootstrapPending === true
    && !aiAutopilotBootstrapInFlight) {
    return bootstrapAiAutopilot(analysis?.marketId);
  }
  const cycleAnalysis = applyLargeCycleExecutionPolicy(analysis, profile.executionPolicy || {});
  const effectiveAnalysis = profile.requiresLiveSentiment
    ? applySentimentOverlay(cycleAnalysis, analysis?.sentiment || aiService.sentiment)
    : cycleAnalysis;
  const policy = aiAutopilotPolicy(config);
  if (!aiAutopilotAllowedInMode(cfg.decibel.mode)) {
    aiAutopilotState = { ...aiAutopilotState, candidate: null, candidateCount: 0, lastReason: 'live_disabled', lastMessage: '实盘禁止大周期自动轮动' };
    saveAiAutopilotState();
    return;
  }

  const previousCandidate = aiAutopilotState.candidate;
  const previousCount = Number(aiAutopilotState.candidateCount) || 0;
  const gate = evaluateAiAutopilot({
    analysis: effectiveAnalysis,
    state: aiAutopilotState,
    config: policy,
    now: Number(effectiveAnalysis.signalTime) || Date.now(),
  });
  return applyAiAutopilotGate({ gate, effectiveAnalysis, profile, policy, previousCandidate, previousCount });
}

async function bootstrapAiAutopilot(marketId) {
  if (aiAutopilotBootstrapInFlight) throw new Error('历史行情确认正在执行，请稍候。');
  const config = getAiConfig();
  if (config.autopilotEnabled !== true) throw new Error('大周期自动轮动尚未启用。');
  if (!aiAutopilotAllowedInMode(cfg.decibel.mode)) throw new Error('大周期自动轮动仅允许 PAPER 模拟盘。');

  aiAutopilotBootstrapInFlight = true;
  try {
    const profile = activeAiAutopilotProfile();
    const policy = aiAutopilotPolicy(config);
    const analyses = await aiService.analyzeHistory(marketId, policy.confirmations);
    if (!analyses.length) throw new Error('没有可用于启动确认的历史行情。');
    const effectiveAnalyses = analyses.map((analysis) => applyLargeCycleExecutionPolicy(analysis, profile.executionPolicy || {}));
    const seed = {
      ...aiAutopilotState,
      strategyId: profile.id,
      candidate: null,
      candidateCount: 0,
      lastSignalTime: 0,
      historyBootstrapPending: false,
    };
    const gate = replayAiAutopilotHistory({ analyses: effectiveAnalyses, state: seed, config: policy });
    gate.state = {
      ...gate.state,
      historyBootstrapPending: false,
      historyEvaluatedAt: Date.now(),
      historySignalsEvaluated: gate.processed,
    };
    const latest = effectiveAnalyses.at(-1);
    audit.write('ai_autopilot_history_evaluated', {
      strategyId: profile.id,
      signals: gate.processed,
      signalTime: latest.signalTime,
      candidate: gate.state.candidate,
      confirmations: gate.state.candidateCount,
      required: policy.confirmations,
      reason: gate.reason,
      candleSources: latest.candleSources,
    });
    await applyAiAutopilotGate({
      gate,
      effectiveAnalysis: latest,
      profile,
      policy,
      previousCandidate: null,
      previousCount: 0,
    });
    return { analysis: latest, gate };
  } catch (error) {
    aiAutopilotState = { ...aiAutopilotState, historyBootstrapPending: true };
    saveAiAutopilotState();
    throw error;
  } finally {
    aiAutopilotBootstrapInFlight = false;
  }
}

function aiAutopilotPolicy(config = getAiConfig()) {
  return {
    enabled: config.autopilotEnabled === true,
    minConfidence: config.autopilotMinConfidence,
    confirmations: config.autopilotConfirmations,
    cooldownMinutes: config.autopilotCooldownMinutes,
    minTimeframeVotes: config.autopilotMinTimeframeVotes,
    neutralAsPause: config.autopilotNeutralAsPause,
  };
}

async function applyAiAutopilotGate({ gate, effectiveAnalysis, profile, policy, previousCandidate, previousCount }) {
  const gateMessage = aiAutopilotReason(gate.reason, gate.target, gate.state.candidateCount, policy.confirmations, bot.getState().running);
  const sentimentMessage = effectiveAnalysis.sentimentDecision && effectiveAnalysis.sentimentDecision !== 'confirmed'
    ? [effectiveAnalysis.sentimentReason, gate.reason === 'awaiting_confirmation' ? gateMessage : null].filter(Boolean).join(' · ')
    : gateMessage;
  aiAutopilotState = {
    ...gate.state,
    lastSentimentDecision: effectiveAnalysis.sentimentDecision || null,
    lastSentimentReason: effectiveAnalysis.sentimentReason || null,
    lastReason: gate.reason,
    lastMessage: sentimentMessage,
  };
  saveAiAutopilotState();

  if (gate.target && (gate.ready || previousCandidate !== gate.state.candidate || previousCount !== gate.state.candidateCount)) {
    audit.write('ai_autopilot_observed', {
      target: gate.target,
      strategyId: profile.id,
      confidence: gate.state.lastConfidence,
      regime: gate.state.lastRegime,
      confirmations: gate.state.candidateCount,
      required: policy.confirmations,
      reason: gate.reason,
      timeframeVotes: gate.support?.votes || null,
      sentimentDecision: effectiveAnalysis.sentimentDecision || null,
      sentimentScore: effectiveAnalysis.sentiment?.score ?? null,
      sentimentConfidence: effectiveAnalysis.sentiment?.confidence ?? null,
      sentimentSources: effectiveAnalysis.sentiment?.independentSourceCount ?? null,
    });
  }
  if (!gate.ready) return;
  if (aiAutopilotInFlight || autoRebalanceInFlight) {
    aiAutopilotState = { ...aiAutopilotState, lastReason: 'busy', lastMessage: '其他策略调整正在执行，本轮保持现状' };
    saveAiAutopilotState();
    return;
  }

  aiAutopilotInFlight = true;
  aiAutopilotState = { ...aiAutopilotState, lastReason: 'executing', lastMessage: `正在切换为${autopilotTargetName(gate.target)}` };
  saveAiAutopilotState();
  try {
    const outcome = await executeAiAutopilot(gate.target, effectiveAnalysis);
    if (outcome.action === 'aligned') {
      aiAutopilotState = {
        ...aiAutopilotState,
        candidate: null,
        candidateCount: 0,
        lastTarget: gate.target,
        lastReason: 'aligned',
        lastMessage: `当前已经是${autopilotTargetName(gate.target)}，保持现状`,
      };
    } else {
      aiAutopilotState = {
        ...completeAiAutopilotAction(aiAutopilotState, { action: outcome.action, target: gate.target }),
        lastReason: 'completed',
        lastMessage: outcome.message,
      };
      audit.write('ai_autopilot_executed', {
        action: outcome.action,
        strategyId: profile.id,
        target: gate.target,
        confidence: gate.state.lastConfidence,
        regime: gate.state.lastRegime,
        previous: outcome.previous,
        next: outcome.next,
        sentimentDecision: effectiveAnalysis.sentimentDecision || null,
        sentimentScore: effectiveAnalysis.sentiment?.score ?? null,
        sentimentConfidence: effectiveAnalysis.sentiment?.confidence ?? null,
        sentimentSources: effectiveAnalysis.sentiment?.independentSourceCount ?? null,
      }, 'warn');
      await notifySafe(`[GridPilot PAPER ${profile.name}] ${outcome.message}`);
    }
    saveAiAutopilotState();
  } catch (error) {
    const detail = error?.message || String(error);
    aiAutopilotState = {
      ...completeAiAutopilotAction(aiAutopilotState, { action: 'failed', target: gate.target }),
      lastReason: 'failed',
      lastMessage: `自动策略未完成：${detail}`,
    };
    saveAiAutopilotState();
    audit.write('ai_autopilot_failed', { strategyId: profile.id, target: gate.target, error: detail, state: compactState(bot.getState()) }, 'error');
    await notifySafe(`[GridPilot PAPER ${profile.name}失败] ${detail}`);
  } finally {
    aiAutopilotInFlight = false;
    await refreshPaperReadiness().catch(() => {});
  }
}

async function executeAiAutopilot(target, analysis) {
  const before = bot.getState();
  if (before.recovery || bot.recovery) throw new Error('只减仓恢复流程正在运行，禁止自动切换策略。');

  if (target === 'paused') {
    if (!before.running) {
      if (before.position || before.openOrders || before.exchangeOpenOrders) throw new Error('网格已停止但仍有仓位或挂单，需要人工处理。');
      return { action: 'aligned', previous: compactState(before), next: compactState(before) };
    }
    const stopped = await bot.stop({ closePosition: true });
    ensureAutopilotAccountClean(stopped);
    return {
      action: 'stopped',
      message: '大周期规则连续确认当前不适合网格，已撤单平仓并暂停',
      previous: compactState(before),
      next: compactState(stopped),
    };
  }

  if (before.running && before.config?.mode === target) {
    return { action: 'aligned', previous: compactState(before), next: compactState(before) };
  }
  if (!before.running && (before.position || before.openOrders || before.exchangeOpenOrders)) {
    throw new Error('空闲账户仍有仓位或挂单，禁止自动接管。');
  }

  let params = await buildAiAutopilotParams(target, analysis, before);
  if (before.running) {
    const stopped = await bot.stop({ closePosition: true });
    ensureAutopilotAccountClean(stopped);
    params = await buildAiAutopilotParams(target, analysis, bot.getState());
  }
  const started = await bot.start(params);
  return {
    action: before.running ? 'switched' : 'started',
    message: `大周期规则连续确认${analysis.regime || '当前行情'}，已${before.running ? '切换' : '启动'}${autopilotTargetName(target)}网格`,
    previous: compactState(before),
    next: compactState(started),
  };
}

async function buildAiAutopilotParams(target, analysis, state) {
  const profile = activeAiAutopilotProfile();
  const market = await marketById(state.config?.marketId ?? analysis.marketId);
  const price = Number(await exchange.getPrice(market.marketId));
  if (!(price > 0)) throw new Error('未取得有效 BTC 最新价格。');
  const candles = await exchange.getCandles(market.marketId, 3600, 200);
  if (exchange.candleDataSource === 'synthetic') {
    throw new Error('1小时公共 K 线不可用，禁止使用合成数据生成自动策略参数。');
  }
  if (!candles?.length || candles.length < 20) throw new Error('BTC 1h K 线不足，无法生成安全区间。');
  const trend = analyzeTrend(candles);
  const suggested = suggestAdaptiveGrid({
    price,
    atrPct: trend.atrPct,
    equity: state.equity,
    market,
    trend: trend.trend,
    mode: target,
    policy: profile.gridPolicy || {},
    execution: exchangeExecutionAssumptions(exchange),
  });
  const params = {
    marketId: market.marketId,
    strategyId: profile.id,
    mode: target,
    lower: suggested.lower,
    upper: suggested.upper,
    gridCount: suggested.gridCount,
    sizeBase: suggested.sizeBase,
    leverage: suggested.leverage,
    outOfRangeAction: suggested.outOfRangeAction,
    maxDirectionalNotionalPct: suggested.maxDirectionalNotionalPct,
    trendGuardEnabled: suggested.trendGuardEnabled,
  };
  await validateAiAutopilotParams(params, market, price);
  return params;
}

function activeAiAutopilotProfile() {
  const profiles = listStrategyProfiles(aiStrategyOptions());
  const ids = [aiAutopilotState.strategyId, bot?.config?.strategyId, 'ai_rotation'];
  return ids.map((id) => profiles.find((profile) => profile.id === id && profile.mode === 'dynamic')).find(Boolean)
    || profiles.find((profile) => profile.id === 'ai_rotation');
}

function strategyGridPolicy(strategyId) {
  const profile = listStrategyProfiles(aiStrategyOptions()).find((item) => item.id === strategyId);
  return profile?.gridPolicy || {};
}

function strategyRiskPolicy(strategyId) {
  const profile = listStrategyProfiles(aiStrategyOptions()).find((item) => item.id === strategyId);
  return { ...cfg.riskPolicy, ...(profile?.riskPolicy || {}) };
}

function exchangeExecutionAssumptions(targetExchange) {
  const feeRate = Number(targetExchange?.feeRate);
  const slippageBps = Number(targetExchange?.slippageBps);
  const spreadBps = Number(targetExchange?.spreadBps);
  return {
    feeRate: Number.isFinite(feeRate) ? feeRate : cfg.decibel.paperFeeRate,
    slippageBps: targetExchange?.mode === 'paper' && Number.isFinite(slippageBps) ? slippageBps : 0,
    spreadBps: targetExchange?.mode === 'paper' && Number.isFinite(spreadBps) ? spreadBps : 0,
  };
}

async function validateAiAutopilotParams(params, knownMarket = null, knownPrice = null) {
  const market = knownMarket || await marketById(params.marketId);
  const price = Number(knownPrice) > 0 ? Number(knownPrice) : Number(await exchange.getPrice(market.marketId));
  const strategyCheck = evaluateStrategyParams({ params, market, strategy: cfg.decibel.strategy || BTC_GRID_STRATEGY });
  if (!strategyCheck.ok) throw new Error(strategyCheck.errors.join(' '));
  const riskCheck = evaluateStartRisk({
    params,
    market,
    equity: bot.getState().equity,
    policy: strategyRiskPolicy(params.strategyId),
    existingPosition: null,
    currentPrice: price,
  });
  if (!riskCheck.ok) throw new Error(riskCheck.errors.join(' '));
}

function ensureAutopilotAccountClean(state) {
  if (state.position || Number(state.openOrders) > 0 || Number(state.exchangeOpenOrders) > 0) {
    throw new Error('撤单或平仓未确认，已中止自动重启。');
  }
}

function aiAutopilotReason(reason, target, count, required, running = false) {
  const targetName = autopilotTargetName(target);
  return ({
    disabled: '大周期自动轮动已关闭',
    invalid_decision: running ? '大周期方向未一致，继续保持现有策略' : '历史回放已完成，但大周期方向未一致，暂不挂单',
    low_confidence: running ? '大周期信号置信度不足，继续保持现有策略' : '大周期信号置信度不足，暂不挂单',
    insufficient_timeframes: running ? '多周期 K 线不足，继续保持现有策略' : '多周期 K 线不足，暂不挂单',
    timeframes_disagree: running ? '多周期趋势不一致，继续保持现有策略' : '多周期趋势不一致，暂不挂单',
    duplicate_signal: '当前 1H K 线已经处理，等待下一根已完成 K 线',
    awaiting_confirmation: `等待${targetName}连续确认：${count}/${required}`,
    cooldown: '当前策略仍在最短持有期，本轮保持现状',
    ready: `${targetName}确认完成，等待执行`,
  })[reason] || '等待下一次大周期分析';
}

function autopilotTargetName(target) {
  return ({ neutral: '中性', long: '做多', short: '做空', paused: '暂停' })[target] || '目标策略';
}

async function processDailyReport() {
  const settings = notifier.publicSettings();
  const state = bot.getState();
  const summary = dailyPnl.observe(state.equity, settings.timezone);
  if (!settings.dailyEnabled || !settings.enabled) return;
  if (Date.now() < dailyReportRetryAt) return;
  if (!dailyPnl.shouldSend(settings.dailyTime, settings.timezone)) return;
  try {
    const result = await notifier.send(formatDailyReport(summary, state, '定时发送'));
    dailyPnl.markSent(settings.dailyTime, settings.timezone);
    dailyReportRetryAt = 0;
    audit.write('daily_report_sent', { trigger: 'schedule', summary, result });
  } catch (error) {
    dailyReportRetryAt = Date.now() + 10 * 60_000;
    audit.write('daily_report_failed', { error: error?.message || String(error), retryAt: dailyReportRetryAt }, 'warn');
  }
}

function formatDailyReport(summary, state, trigger) {
  const pnl = Number(summary.pnl) || 0;
  const pnlPct = Number(summary.pnlPct) || 0;
  const position = state.position
    ? `${state.position.sizeBase > 0 ? '多头' : '空头'} ${Math.abs(Number(state.position.sizeBase)).toFixed(6)} 币`
    : '无仓位';
  return [
    `${cfg.appName} · 每日盈亏`,
    `日期：${summary.day} (${summary.timezone})`,
    `当日盈亏：${signedNumber(pnl, 2)} USDC (${signedNumber(pnlPct, 2)}%)`,
    `账户权益：${numberText(summary.currentEquity, 2)} USDC`,
    `日初基线：${numberText(summary.baselineEquity, 2)} USDC`,
    `已实现：${signedNumber(state.realizedPnl, 2)} USDC`,
    `未实现：${signedNumber(state.unrealizedPnl, 2)} USDC`,
    `仓位：${position}`,
    `挂单：${state.openOrders || 0} · 网格：${state.running ? '运行中' : '未运行'}`,
    `发送：${trigger}`,
  ].join('\n');
}

function connectionEffective() {
  return {
    mode: cfg.decibel.mode,
    network: cfg.decibel.network,
    apiKey: cfg.decibel.apiKey,
    privateKey: cfg.decibel.privateKey,
    subaccount: cfg.decibel.subaccount,
    proxy: cfg.decibel.proxy,
  };
}

function signedNumber(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number > 0 ? '+' : ''}${number.toFixed(digits)}` : '--';
}

function numberText(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : '--';
}

async function emergencyStop(reason) {
  if (emergencyInFlight) return;
  emergencyInFlight = true;
  try {
    audit.write('emergency_stop_started', { reason, state: compactState(bot.getState()) }, 'error');
    await notifySafe(`[GridPilot 紧急停止] ${reason}`);
    await bot.stop({ closePosition: true });
    lastPreflight = null;
    audit.write('emergency_stop_completed', { reason, state: compactState(bot.getState()) }, 'error');
    await notifySafe('[GridPilot] 紧急停止流程已结束，请立即到 Decibel 核对挂单与仓位。');
  } finally {
    emergencyInFlight = false;
  }
}

function liveCapsConfigured() {
  return Number(cfg.riskPolicy.maxLeverage) > 0
    && Number(cfg.riskPolicy.maxMarginPct) > 0
    && Number(cfg.riskPolicy.minMaintenanceMarginRatio) >= 100;
}

async function notifySafe(message) {
  try { await notifier.send(message); }
  catch (error) { audit.write('notification_failed', { message: error?.message || String(error) }, 'warn'); }
}

function compactState(state) {
  return {
    running: state.running,
    waitingForAdmission: state.waitingForAdmission === true,
    market: state.config?.displayName || null,
    strategyId: state.config?.strategyId || null,
    mode: state.config?.mode || null,
    openOrders: state.openOrders,
    positionSize: state.position?.sizeBase || 0,
    equity: state.equity,
    totalPnl: state.totalPnl,
    measurementId: state.measurement?.id || null,
    directionalExposurePct: state.strategyGuard?.exposure?.pct ?? null,
    executionCostTotal: state.executionCosts?.total ?? null,
  };
}

function adaptiveParameterSnapshot(config = {}) {
  return {
    lower: Number(config.lower) || null,
    upper: Number(config.upper) || null,
    gridCount: Number(config.gridCount) || null,
    sizeBase: Number(config.sizeBase) || null,
    leverage: Number(config.leverage) || null,
    mode: config.mode || null,
  };
}

function maskAddress(value) {
  const text = String(value || '');
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-6)}` : (text || '未配置');
}

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function roundNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

async function initializeExchange() {
  try {
    await exchange.init();
    console.log(`[Decibel] 连接成功，数据源: ${exchange.dataSource || 'real'}`);
  } catch (error) {
    console.error('[Decibel] 初始化失败: ' + (error?.message || error));
    if (cfg.decibel.mode === 'live') process.exit(1);
  }
}

async function bootstrapPersistedAiAutopilot() {
  const config = getAiConfig();
  if (strategyEngine(bot) === 'turtle') {
    if (config.autopilotEnabled === true) await disableAiAutopilot('海龟策略已恢复，大周期自动轮动保持关闭');
    return;
  }
  if (config.autopilotEnabled !== true || !aiAutopilotAllowedInMode(cfg.decibel.mode)) return;
  const profile = activeAiAutopilotProfile();
  if (profile.requiresLiveSentiment) {
    aiAutopilotState = {
      ...aiAutopilotState,
      strategyId: profile.id,
      historyBootstrapPending: false,
      lastMessage: '服务启动后正在恢复 Grok 实时情绪确认',
    };
    saveAiAutopilotState();
    try {
      const analysis = await aiService.analyze(bot.config?.marketId || 1);
      await maybeApplyAiAutopilot(analysis);
    } catch (error) {
      const detail = error?.message || String(error);
      aiAutopilotState = {
        ...aiAutopilotState,
        historyBootstrapPending: false,
        lastReason: 'analysis_failed',
        lastMessage: `Grok 实时情绪暂不可用，将在 15 分钟计划任务中重试：${detail}`,
      };
      saveAiAutopilotState();
      audit.write('grok_sentiment_restore_failed', { strategyId: profile.id, error: detail }, 'warn');
    }
    return;
  }
  if (Number(aiAutopilotState.lastSignalTime) > 0
    && Number(aiAutopilotState.historyEvaluatedAt) > 0
    && aiAutopilotState.historyBootstrapPending !== true) return;
  aiAutopilotState = {
    ...aiAutopilotState,
    strategyId: profile.id,
    historyBootstrapPending: true,
    lastMessage: '服务启动后正在恢复历史行情确认',
  };
  saveAiAutopilotState();
  try {
    await bootstrapAiAutopilot(bot.config?.marketId || 1);
  } catch (error) {
    const detail = error?.message || String(error);
    aiAutopilotState = {
      ...aiAutopilotState,
      historyBootstrapPending: true,
      lastReason: 'analysis_failed',
      lastMessage: `历史确认暂不可用，将按计划重试：${detail}`,
    };
    saveAiAutopilotState();
    audit.write('ai_autopilot_history_failed', { strategyId: aiAutopilotState.strategyId, error: detail }, 'warn');
  }
}

/** In-process paper restart: reload saved connection settings, rebuild exchange+bot. */
async function performPaperRestart() {
  const snapshot = bot.snapshot();
  const fresh = getConfig();
  cfg.decibel = fresh.decibel; // pick up newly saved API key / network
  try { exchange.dispose?.(); } catch { /* old instance must not block restart */ }
  exchange = createExchange(cfg.decibel);
  bot = createTradingBot(exchange, { onChange: (state) => saveSnapshot('decibel', state) }, snapshot);
  bot.restore(snapshot);
  exchange.on('error', (error) => console.error('[Decibel] ' + (error?.message || error)));
  await initializeExchange();
  paperInstances?.replacePrimary(exchange, bot);
  if (bot.config) await remapMarket(bot.config);
  exchange.restoreState?.(snapshot.exchangeState, {
    legacyMarketId: snapshot.config?.marketId,
    marketId: bot.config?.marketId ?? snapshot.config?.marketId,
  });
  saveSnapshot('decibel', bot.snapshot());
  dailyPnl.observe(bot.getState().equity, notifier.publicSettings().timezone);
}

async function resumeGrid() {
  const snapshot = loadSnapshot('decibel');
  if (!cfg.autoResume || !snapshot?.running || !snapshot?.config || exchange.dataSource == null) return;
  try {
    const legacyMarketId = snapshot.config.marketId;
    await remapMarket(snapshot.config);
    await bot.resume(snapshot, { legacyMarketId });
    console.log(`[恢复] 已接管 ${bot.getState().openOrders} 个挂单。`);
  } catch (error) {
    console.error('[恢复] 自动恢复失败，未执行新的交易操作: ' + (error?.message || error));
  }
}

async function refreshPersistedMarket() {
  if (!bot.config?.displayName || exchange.dataSource == null) return;
  try { await remapMarket(bot.config); } catch { /* stale display state is non-fatal */ }
}

function restoreIdlePaperState() {
  if (exchange.mode !== 'paper') return false;
  const snapshot = loadSnapshot('decibel');
  if (!snapshot?.exchangeState || snapshot.running) return false;
  const legacyMarketId = snapshot.config?.marketId;
  const marketId = bot.config?.marketId ?? legacyMarketId;
  return exchange.restoreState?.(snapshot.exchangeState, { legacyMarketId, marketId }) === true;
}

async function remapMarket(config) {
  const markets = await exchange.getMarkets();
  const wanted = normalizeMarket(config.displayName);
  const match = markets.find((market) => [market.displayName, market.name, market.symbol].some((name) => normalizeMarket(name) === wanted));
  if (match) config.marketId = match.marketId;
}

function normalizeMarket(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function authorized(request, url) {
  if (cfg.adminUsername && cfg.adminPassword) {
    const header = String(request.headers.authorization || '');
    if (!header.startsWith('Basic ')) return false;
    let decoded;
    try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
    catch { return false; }
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return constantTimeEqual(decoded.slice(0, separator), cfg.adminUsername)
      && constantTimeEqual(decoded.slice(separator + 1), cfg.adminPassword);
  }
  if (isLoopback) return true;
  const header = request.headers['x-gridpilot-token'];
  const supplied = String(header || url.searchParams.get('token') || '');
  return constantTimeEqual(supplied, cfg.dashboardToken);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
}

function send(response, code, body) {
  if (response.headersSent) return;
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}

function writeEvent(response, body) {
  const json = JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  response.write(`data: ${json}\n\n`);
}

async function readBody(request, maxBytes = 100_000) {
  return await new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求内容过大。'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('请求 JSON 格式无效。')); }
    });
    request.on('error', reject);
  });
}

async function runAction(response, action, actionName = 'api_action') {
  if (aiAutopilotInFlight && AI_AUTOPILOT_CONFLICTING_ACTIONS.has(actionName)) {
    const message = '大周期自动轮动正在撤单、平仓或重建网格，请等待本轮动作完成。';
    audit.write('api_action_rejected', { action: actionName, error: message }, 'warn');
    return send(response, 409, { error: message });
  }
  try { return send(response, 200, await action()); }
  catch (error) {
    audit.write('api_action_rejected', { action: actionName, error: error?.message || String(error) }, 'warn');
    return send(response, 400, { error: error?.message || String(error) });
  }
}

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const state = bot.getState();
  audit.write('server_stopping', {
    signal,
    state: compactState(state),
    ordersAndPositionPreserved: true,
  }, state.running ? 'warn' : 'info');
  if (state.running) {
    console.warn('[关停] 进程正在退出；不会擅自发送交易指令。Decibel 上的挂单和仓位可能仍然存在，请立即人工核对。');
    await notifySafe('[GridPilot] 程序正在退出，未自动撤单或平仓。请立即到 Decibel 核对挂单与仓位。');
  }
  exchange.stop?.();
  paperInstances?.dispose();
  for (const client of streamClients.keys()) {
    try { client.end(); } catch { /* already closed */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}

function serveStatic(requestPath, response) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); }
  catch { return send(response, 400, { error: '路径格式无效。' }); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const fullPath = path.resolve(PUBLIC_DIR, relative);
  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(response, 403, { error: '禁止访问该路径。' });
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return send(response, 404, { error: 'not found' });
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(fullPath)] || 'application/octet-stream',
    'Cache-Control': path.extname(fullPath) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  return fs.createReadStream(fullPath).pipe(response);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requestedConsoleMode(url) {
  const mode = url.searchParams.get('console');
  return mode === 'paper' || mode === 'live' ? mode : null;
}
