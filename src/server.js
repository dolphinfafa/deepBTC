import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getConfig, saveRiskPolicy, ROOT } from './config.js';
import { createExchange } from './exchange/de/index.js';
import { GridBot } from './bot.js';
import { analyzeTrend } from './trend.js';
import { suggestAdaptiveGrid } from './adaptive-grid.js';
import { setupProxy, checkProxy } from './proxy.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { evaluateStartRisk, LiveRiskState } from './risk.js';
import { evaluateStrategyParams, BTC_GRID_STRATEGY } from './risk.js';
import { autoRebalanceGate, rangeChangedEnough, autoRebalanceReason } from './auto-rebalance.js';
import { createAuditLog } from './audit.js';
import { createNotifier } from './notifier.js';
import { DailyPnlTracker } from './daily-pnl.js';
import { loadConnectionSettings, updateConnectionSettings, publicConnectionSettings } from './connection-settings.js';
import { publicAiConfig } from './ai/provider.js';
import { loadAiSettings, updateAiSettings, publicAiSettings } from './ai/settings.js';
import { createAiService } from './ai/service.js';
import { projectDashboardState, resolveDashboardRoute } from './dashboard-routing.js';

const cfg = getConfig();
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(cfg.host.toLowerCase());
const audit = createAuditLog(ROOT);
const notifier = createNotifier(cfg.notifications, ROOT);
const dailyPnl = new DailyPnlTracker(ROOT);
const liveRisk = new LiveRiskState(ROOT, cfg.riskPolicy);
const AUTO_REBALANCE_FILE = path.join(ROOT, '.auto-rebalance.json');
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
let bot = new GridBot(exchange, { onChange: (state) => saveSnapshot('decibel', state) });
const aiService = createAiService({ getBot: () => bot, getExchange: () => exchange, notify: (message) => notifier.send(message) });
bot.restore(loadSnapshot('decibel'));
exchange.on('error', (error) => console.error('[Decibel] ' + (error?.message || error)));

await initializeExchange();
await resumeGrid();
await refreshPersistedMarket();
await restoreIdlePaperState();
await refreshPaperReadiness();
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
          const saved = updateAiSettings(ROOT, await readBody(request));
          audit.write('ai_settings_updated', { provider: saved.provider, hasApiKey: Boolean(saved.apiKey) });
          return { settings: publicAiSettings(saved), config: publicAiConfig() };
        }, url.pathname);
      }
      return send(response, 200, { settings: publicAiSettings(loadAiSettings(ROOT)), config: publicAiConfig() });
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

    if (url.pathname === '/api/state') return send(response, 200, publicState(requestedConsoleMode(url)));

    if (url.pathname === '/api/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const consoleMode = requestedConsoleMode(url);
      writeEvent(response, publicState(consoleMode));
      streamClients.set(response, consoleMode);
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
        suggestion: suggestAdaptiveGrid({ price, atrPct: analysis.atrPct, equity: bot.getState().equity, market, trend: analysis.trend }),
      });
    }

    if (url.pathname === '/api/preflight') {
      if (request.method === 'POST') return send(response, 200, await runPreflight());
      return send(response, 200, lastPreflight || { ready: false, t: null, checks: [], message: '尚未运行实盘预检。' });
    }

    if (url.pathname === '/api/paper-readiness') {
      const body = request.method === 'POST' ? await readBody(request) : {};
      return send(response, 200, await buildPaperReadiness(body.params || body));
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
        if (bot.running) throw new Error('网格正在运行，请先停止并撤销挂单后再重启。');
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

    if (url.pathname === '/api/start' && request.method === 'POST') {
      return runAction(response, async () => startGrid(await readBody(request)), url.pathname);
    }
    if (url.pathname === '/api/stop' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        const result = await bot.stop(body);
        await refreshPaperReadiness();
        audit.write('grid_stopped', { closePosition: body.closePosition !== false, state: compactState(result) });
        await notifySafe(`GridPilot 已停止网格${body.closePosition === false ? '，持仓保留' : '并执行平仓'}。`);
        return publicState();
      }, url.pathname);
    }
    if (url.pathname === '/api/adjust' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        await validateRangeRisk(body);
        const result = await bot.adjustRange(body);
        await refreshPaperReadiness();
        audit.write('range_adjusted', { lower: body.lower, upper: body.upper, state: compactState(result) });
        return publicState();
      }, url.pathname);
    }
    if (url.pathname === '/api/reset' && request.method === 'POST') {
      return runAction(response, () => {
        const result = bot.resetStats();
        audit.write('stats_reset', { state: compactState(result) });
        return publicState();
      }, url.pathname);
    }
    if (url.pathname === '/api/paper-equity' && request.method === 'POST') {
      return runAction(response, async () => {
        if (cfg.decibel.mode !== 'paper') throw new Error('账户权益调整仅适用于 PAPER 模拟盘。');
        const body = await readBody(request);
        await exchange.refreshPositions?.();
        const previousEquity = bot.getState().equity;
        const result = bot.setPaperEquity(body.equity);
        const dailySummary = dailyPnl.rebaseline(result.equity, notifier.publicSettings().timezone);
        await refreshPaperReadiness();
        audit.write('paper_equity_adjusted', {
          previousEquity,
          equity: result.equity,
          delta: Number(result.equity) - Number(previousEquity),
          measurementId: result.measurement?.id || null,
          dailySummary,
        }, 'warn');
        return publicState();
      }, url.pathname);
    }
    if (url.pathname === '/api/cancel-orders' && request.method === 'POST') {
      return runAction(response, async () => {
        const result = await bot.cancelAllOrders();
        audit.write('orders_cancelled', { state: compactState(result) }, 'warn');
        await notifySafe('GridPilot 已撤销全部网格挂单，当前持仓保留。');
        return publicState();
      }, url.pathname);
    }
    if (url.pathname === '/api/close-position' && request.method === 'POST') {
      const body = await readBody(request);
      return runAction(response, async () => {
        if (cfg.decibel.mode === 'live') {
          const market = await marketById(body.marketId);
          if (body.liveConfirmation !== `CLOSE ${market.displayName}`) {
            throw new Error(`实盘平仓确认短语不正确，应输入：CLOSE ${market.displayName}`);
          }
        }
        const result = await bot.closePositionNow(body.marketId);
        audit.write('position_closed', { marketId: body.marketId, state: compactState(result) }, 'warn');
        await notifySafe('GridPilot 已执行撤单和平仓，请到 Decibel 再次核对。');
        return publicState();
      }, url.pathname);
    }
    if (url.pathname === '/api/start-recovery' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        if (cfg.decibel.mode === 'live') {
          const market = await marketById(body.marketId);
          if (body.liveConfirmation !== `RECOVER ${market.displayName}`) {
            throw new Error(`实盘回收确认短语不正确，应输入：RECOVER ${market.displayName}`);
          }
        }
        delete body.liveConfirmation;
        const result = await bot.startRecovery(body);
        audit.write('recovery_started', { marketId: body.marketId, spacing: body.spacing, sizeBase: body.sizeBase, aboveEntryOnly: !!body.aboveEntryOnly }, 'warn');
        await notifySafe('GridPilot 已启动只减仓回收阶梯。');
        return publicState();
      }, url.pathname);
    }
    if (url.pathname === '/api/emergency-stop' && request.method === 'POST') {
      return runAction(response, async () => {
        const body = await readBody(request);
        if (body.confirmation !== 'EMERGENCY STOP') throw new Error('紧急停止确认短语不正确。');
        await emergencyStop('用户手动触发紧急停止');
        return publicState();
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
        await exchange.reconnect?.();
        if (!bot.running && cfg.autoResume) {
          const snapshot = loadSnapshot('decibel');
          if (snapshot?.running && snapshot?.config) await bot.resume(snapshot);
        }
        if (bot.running) await bot.reconcileOpenOrders().catch(() => {});
        audit.write('exchange_reconnected', { resumed: bot.running });
        return publicState();
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
  const state = publicState();
  for (const [client, consoleMode] of streamClients) {
    try { writeEvent(client, consoleMode ? projectDashboardState(state, cfg.decibel.mode, consoleMode) : state); }
    catch { streamClients.delete(client); }
  }
}, 1000).unref();

setInterval(() => monitorLiveRisk().catch((error) => {
  console.error('[实盘风控] ' + (error?.message || error));
}), 5000).unref();

setInterval(() => maybeAutoRebalance().catch((error) => {
  audit.write('auto_rebalance_failed', { error: error?.message || String(error) }, 'warn');
}), 60_000).unref();

setInterval(() => refreshPaperReadiness().catch((error) => {
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
  if (cfg.autoRebalance && (cfg.decibel.mode !== 'live' || cfg.autoLiveRebalance)) console.log('  波动率自动调区间: 开启');
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

async function startGrid(body) {
  const markets = await exchange.getMarkets();
  const market = markets.find((item) => Number(item.marketId) === Number(body.marketId));
  if (!market) throw new Error('所选市场不存在，请刷新市场列表。');

  const params = { ...body };
  const strategyEvaluation = evaluateStrategyParams({ params, market, strategy: cfg.decibel.strategy || BTC_GRID_STRATEGY });
  if (!strategyEvaluation.ok) {
    audit.write('grid_start_denied', { reason: 'strategy_policy', errors: strategyEvaluation.errors, market: market.displayName }, 'warn');
    throw new Error(strategyEvaluation.errors.join(' '));
  }

  await exchange.refreshPositions?.();
  const existingPosition = exchange.getPosition?.(market.marketId) || null;
  const currentPrice = await exchange.getPrice(market.marketId);
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
    const riskStatus = liveRisk.status(bot.getState().equity);
    if (riskStatus.halted) {
      audit.write('grid_start_denied', { reason: riskStatus.reason }, 'error');
      throw new Error(`实盘风控已锁定：${riskStatus.reason}。停止网格后手动重置风险基线才能继续。`);
    }
  }

  const evaluation = evaluateStartRisk({
    params,
    market,
    equity: bot.getState().equity,
    policy: cfg.riskPolicy,
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
  const result = await bot.start(params);
  await refreshPaperReadiness();
  audit.write('grid_started', { market: market.displayName, params, state: compactState(result) }, cfg.decibel.mode === 'live' ? 'warn' : 'info');
  if (cfg.decibel.mode === 'live') {
    liveRisk.observe(result.equity);
    lastPreflight = null;
    await notifySafe(`GridPilot 实盘已启动：${market.displayName}，${params.gridCount} 格，${params.leverage}x。`);
  }
  return publicState();
}

async function validateRangeRisk(body) {
  if (!bot.running || !bot.config) throw new Error('网格未运行，无法调整区间。');
  const market = await marketById(bot.config.marketId);
  const strategyEvaluation = evaluateStrategyParams({ params: { ...bot.config, lower: body.lower, upper: body.upper }, market, strategy: cfg.decibel.strategy || BTC_GRID_STRATEGY });
  if (!strategyEvaluation.ok) throw new Error(strategyEvaluation.errors.join(' '));
  await exchange.refreshPositions?.();
  const currentPrice = await exchange.getPrice(market.marketId);
  const evaluation = evaluateStartRisk({
    params: { ...bot.config, lower: body.lower, upper: body.upper },
    market,
    equity: bot.getState().equity,
    policy: cfg.riskPolicy,
    existingPosition: exchange.getPosition?.(market.marketId) || null,
    currentPrice,
  });
  if (!evaluation.ok) {
    audit.write('range_adjust_denied', { errors: evaluation.errors, metrics: evaluation.metrics }, 'warn');
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

function publicState(consoleMode = null) {
  const state = bot.getState();
  const notificationSettings = notifier.publicSettings();
  const readiness = publicPaperReadiness(state);
  const mergedReadiness = lastPaperReadiness
    ? {
      ...lastPaperReadiness,
      ...readiness,
      price: readiness.price || lastPaperReadiness.price,
      priceValid: readiness.priceValid || lastPaperReadiness.priceValid,
      dataSource: readiness.dataSource || lastPaperReadiness.dataSource,
    }
    : readiness;
  const result = {
    ...state,
    liveRisk: liveRisk.status(state.equity),
    dailyPnl: dailyPnl.summary(state.equity, notificationSettings.timezone),
    preflight: lastPreflight ? { t: lastPreflight.t, expiresAt: lastPreflight.expiresAt, ready: lastPreflight.ready } : null,
    paperReadiness: mergedReadiness,
  };
  return consoleMode ? projectDashboardState(result, cfg.decibel.mode, consoleMode) : result;
}

function autoRebalancePublicState() {
  const enabled = cfg.autoRebalance && (cfg.decibel.mode !== 'live' || cfg.autoLiveRebalance);
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

function publicPaperReadiness(state = bot.getState()) {
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
      policy: cfg.riskPolicy,
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
    dataSource: state.health?.dataSource || exchange.dataSource || null,
    price: price > 0 ? price : null,
    priceValid: price > 0,
    autoRebalance: autoRebalancePublicState(),
    running: !!state.running,
    paramsConfigured: !!params,
    strategyCheck,
    riskCheck,
    noOrphanState,
    recovery: !!state.recovery,
    ready: cfg.decibel.mode === 'paper' && price > 0 && strategyCheck.ok && riskCheck.ok && noOrphanState,
    lastAutoRebalance: lastAutoRebalanceStatus,
  };
}

async function buildPaperReadiness(input = {}) {
  const markets = await exchange.getMarkets();
  const requestedId = Number(input.marketId || bot.config?.marketId || 1);
  const market = markets.find((item) => Number(item.marketId) === requestedId) || markets.find((item) => String(item.displayName).toUpperCase() === 'BTC-USD');
  let price = null;
  try { price = Number(await exchange.getPrice(market?.marketId)); } catch { /* readiness reports the failed price check */ }
  const params = Object.keys(input || {}).length ? { ...input } : (bot.config || null);
  const state = bot.getState();
  const strategy = cfg.decibel.strategy || BTC_GRID_STRATEGY;
  const strategyCheck = params && market
    ? evaluateStrategyParams({ params, market, strategy })
    : { ok: false, errors: [market ? '尚未填入网格参数。' : 'BTC-USD 市场不可用。'] };
  const riskCheck = params && market
    ? evaluateStartRisk({ params, market, equity: state.equity, policy: cfg.riskPolicy, existingPosition: exchange.getPosition?.(market.marketId) || null, currentPrice: price })
    : { ok: false, errors: ['尚未配置网格参数。'], warnings: [], metrics: null };
  let preflight = null;
  try { preflight = await exchange.preflight?.(); } catch { /* readiness reports the residual-state check */ }
  const noOrphanState = state.running || (!state.recovery && Number(state.openOrders || 0) === 0 && Number(preflight?.openOrderCount || 0) === 0);
  const checks = [
    { id: 'mode', label: '运行模式', status: cfg.decibel.mode === 'paper' ? 'pass' : 'warn', detail: cfg.decibel.mode === 'paper' ? 'PAPER 模拟盘' : '当前为 LIVE 实盘' },
    { id: 'btcOnly', label: '市场范围', status: cfg.decibel.btcOnly && market && String(market.displayName).toUpperCase() === 'BTC-USD' ? 'pass' : 'fail', detail: cfg.decibel.btcOnly ? (market?.displayName || 'BTC-USD') : 'BTC-only 未锁定' },
    { id: 'source', label: '价格数据源', status: price > 0 ? 'pass' : 'fail', detail: `${exchange.dataSource || 'unknown'} · ${price > 0 ? price : '无有效价格'}` },
    { id: 'price', label: '有效 BTC 价格', status: price > 0 ? 'pass' : 'fail', detail: price > 0 ? String(price) : '未读取到有效价格' },
    { id: 'strategy', label: '策略参数范围', status: strategyCheck.ok ? 'pass' : 'fail', detail: strategyCheck.ok ? `${strategy.minGridCount}-${strategy.maxGridCount} 格约束通过` : strategyCheck.errors.join(' ') },
    { id: 'inventoryGuard', label: '方向敞口保护', status: Number(params?.maxDirectionalNotionalPct ?? strategy.maxDirectionalNotionalPct) > 0 ? 'pass' : 'fail', detail: `净方向名义价值不超过权益的 ${Number(params?.maxDirectionalNotionalPct ?? strategy.maxDirectionalNotionalPct) || '--'}%` },
    { id: 'trendGuard', label: '趋势保护', status: (params?.trendGuardEnabled ?? strategy.trendGuardEnabled) ? 'pass' : 'warn', detail: (params?.trendGuardEnabled ?? strategy.trendGuardEnabled) ? '已开启 · 每 5 分钟检查 BTC 1h K 线' : '已人工关闭' },
    { id: 'risk', label: '保证金和风险', status: riskCheck.ok ? 'pass' : 'fail', detail: riskCheck.ok ? `预计保证金 ${riskCheck.metrics?.requiredMargin ?? '--'} USDC` : riskCheck.errors.join(' ') },
    { id: 'orders', label: '遗留挂单/恢复状态', status: noOrphanState ? 'pass' : 'fail', detail: noOrphanState ? '无异常遗留状态' : '存在未托管挂单或恢复阶梯' },
    { id: 'running', label: '网格状态', status: state.running ? 'warn' : 'pass', detail: state.running ? '运行中' : '未运行，等待人工启动' },
  ];
  return {
    ...publicPaperReadiness(state),
    price: price > 0 ? price : null,
    priceValid: price > 0,
    dataSource: exchange.dataSource || null,
    market: market?.displayName || null,
    params,
    paramsConfigured: !!params,
    strategyCheck,
    riskCheck,
    checks,
    ready: cfg.decibel.mode === 'paper' && checks.every((check) => check.status !== 'fail') && !!params,
  };
}

async function refreshPaperReadiness() {
  lastPaperReadiness = await buildPaperReadiness(bot.config || {});
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
  if (autoRebalanceInFlight) return;
  const state = bot.getState();
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
    });
    if (!latestGate.ok) {
      lastAutoRebalanceStatus = { t: now, code: latestGate.reason, reason: autoRebalanceReason(latestGate.reason) };
      return;
    }
    const lower = Number(bot.config.lower), upper = Number(bot.config.upper);
    const candles = await exchange.getCandles(market.marketId, 3600, 200);
    const analysis = candles.length >= 20 ? analyzeTrend(candles) : { atrPct: null, trend: 'range' };
    const suggestion = suggestAdaptiveGrid({
      price: latestPrice,
      atrPct: analysis.atrPct,
      equity: bot.getState().equity,
      market,
      trend: analysis.trend,
    });
    const movedEnough = rangeChangedEnough({
      previous: { lower, upper },
      next: suggestion,
      minChangePct: cfg.decibel.strategy?.minRangeChangePct || BTC_GRID_STRATEGY.minRangeChangePct,
    });
    if (!movedEnough) {
      lastAutoRebalanceStatus = { t: now, code: 'insufficient_change', reason: autoRebalanceReason('insufficient_change') };
      audit.write('auto_rebalance_skipped', { reason: 'insufficient_change', previous: { lower, upper }, next: { lower: suggestion.lower, upper: suggestion.upper } });
      return;
    }
    await validateRangeRisk({ lower: suggestion.lower, upper: suggestion.upper });
    const state = await bot.adjustRange({
      lower: suggestion.lower,
      upper: suggestion.upper,
      measurementReason: 'auto_range',
    });
    lastAutoRebalanceAt = now;
    lastAutoRebalanceStatus = { t: now, code: 'adjusted', reason: autoRebalanceReason('adjusted') };
    saveAutoRebalanceState();
    audit.write('auto_rebalanced', {
      market: market.displayName,
      previous: { lower, upper },
      next: { lower: suggestion.lower, upper: suggestion.upper },
      gridCount: state.config?.gridCount,
      atrPct: suggestion.atrPct,
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
    market: state.config?.displayName || null,
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

function maskAddress(value) {
  const text = String(value || '');
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-6)}` : (text || '未配置');
}

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
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

/** In-process paper restart: reload saved connection settings, rebuild exchange+bot. */
async function performPaperRestart() {
  const snapshot = bot.snapshot();
  const fresh = getConfig();
  cfg.decibel = fresh.decibel; // pick up newly saved API key / network
  try { exchange.dispose?.(); } catch { /* old instance must not block restart */ }
  exchange = createExchange(cfg.decibel);
  bot = new GridBot(exchange, { onChange: (state) => saveSnapshot('decibel', state) });
  bot.restore(snapshot);
  exchange.on('error', (error) => console.error('[Decibel] ' + (error?.message || error)));
  await initializeExchange();
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
