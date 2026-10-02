import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { suggestAdaptiveGrid } from '../src/adaptive-grid.js';
import { adaptiveGridChangedEnough, autoRebalanceGate } from '../src/auto-rebalance.js';
import { completeAiAutopilotAction, evaluateAiAutopilot } from '../src/ai/autopilot.js';
import { applyLargeCycleExecutionPolicy, buildLargeCycleAnalysis } from '../src/ai/regime.js';
import {
  aggregateCandles,
  analyzeHistoricalFrames,
  buildHistoricalAiAnalysis,
  completedCandleWindow,
} from '../src/ai/historical-proxy.js';
import { buildGrid, replacementFor, seedOrders } from '../src/grid.js';
import { analyzeTrend } from '../src/trend.js';
import { inventoryOrderDecision, isPassiveOpeningOrder } from '../src/strategy-guards.js';
import { resolveStrategyProfile } from '../src/strategy-profiles.js';
import { neutralRangeAdmission, neutralRebalanceEconomics } from '../src/neutral-grid.js';

const API = 'https://api.exchange.coinbase.com/products/BTC-USD/candles';
const M15_MS = 15 * 60_000;
const H1_MS = 60 * 60_000;
const H4_MS = 4 * H1_MS;
const D1_MS = 24 * H1_MS;
const MARKET = Object.freeze({ stepPrice: 1, stepSize: 0.00001, minOrderSize: 0.0001, maxLeverage: 50 });
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE_FILE = path.join(ROOT, '.cache', 'coinbase-btc-usd-15m.json');
const FUNDING_CACHE_FILE = path.join(ROOT, '.cache', 'btc-perpetual-funding.json');
const LONG_SCALE_MULTIPLIERS = Object.freeze([1, 2, 4, 6, 8, 10]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const config = configFromEnv();
  const { candles, cache } = await loadCoinbaseCandles(config);
  const series = {
    m15: candles.map((candle) => ({ ...candle, endTime: candle.time + M15_MS })),
    h1: aggregateCandles(candles, H1_MS, M15_MS),
    h4: aggregateCandles(candles, H4_MS, M15_MS),
    d1: aggregateCandles(candles, D1_MS, M15_MS),
  };
  const timeline = buildHistoricalTimeline(candles, series, config);
  const policies = candidatePolicies(config);
  if (process.env.BACKTEST_RESEARCH_STAGE === 'long_scale') {
    await printLongScaleResearch({ candles, series, timeline, config, cache });
    return;
  }
  if (process.env.BACKTEST_RESEARCH_STAGE === 'train') {
    printTrainingResearch({ candles, series, timeline, config, policies });
    return;
  }
  if (process.env.BACKTEST_RESEARCH_STAGE === 'validate') {
    printHoldoutValidation({ candles, series, timeline, config, policies });
    return;
  }
  if (process.env.BACKTEST_RESEARCH_STAGE === 'v3') {
    printV3Comparison({ candles, series, timeline, config, policies });
    return;
  }
  if (process.env.BACKTEST_RESEARCH_STAGE === 'robustness') {
    printRobustnessResearch({ candles, series, timeline, config, policies });
    return;
  }
  const neutral = runHistoricalBacktest({ candles, series, timeline, config, strategy: 'neutral' });
  const fullPeriod = Object.fromEntries(policies.map((policy) => [policy.id,
    runHistoricalBacktest({ candles, series, timeline, config: policy.config, strategy: 'rotation' })]));
  const rotation = fullPeriod.current;
  const noCosts = runHistoricalBacktest({
    candles, series, timeline, strategy: 'rotation',
    config: { ...config, feeRate: 0, slippageBps: 0, spreadBps: 0, funding8hRate: 0 },
  });
  const doubleCosts = runHistoricalBacktest({
    candles, series, timeline, strategy: 'rotation',
    config: {
      ...config,
      feeRate: config.feeRate * 2,
      slippageBps: config.slippageBps * 2,
      spreadBps: config.spreadBps * 2,
      funding8hRate: config.funding8hRate * 2,
    },
  });
  const annualWindows = buildAnnualWindows(config, candles.at(-1).time + M15_MS).map((window) => ({
    ...window,
    results: Object.fromEntries(policies.map((policy) => [policy.id, runHistoricalBacktest({
      candles,
      series,
      timeline,
      strategy: 'rotation',
      config: { ...policy.config, tradeStartTime: window.from, tradeEndTime: window.to },
    })])),
  }));

  console.log(JSON.stringify({
    source: 'Coinbase BTC-USD 15m; 1h/4h/1d candles aggregated from completed 15m bars',
    proxy: {
      name: 'deterministic large-cycle execution model',
      limitation: 'Execution uses the same completed-candle 1D/4H/1H rules as PAPER. Optional language-model output only supplies narrative and never changes the trading target.',
      pauseRule: `1h ATR >= ${config.pauseAtrPct}%`,
    },
    data: {
      candles15m: candles.length,
      candles1h: series.h1.length,
      candles4h: series.h4.length,
      candles1d: series.d1.length,
      requestedDays: config.days,
      from: new Date(config.tradeStartTime).toISOString(),
      to: new Date(candles.at(-1).time + M15_MS).toISOString(),
      cache,
    },
    policy: {
      analysisMinutes: config.analysisIntervalMs / 60_000,
      minConfidence: config.minConfidence,
      confirmations: config.confirmations,
      cooldownMinutes: config.cooldownMs / 60_000,
      minTimeframeVotes: config.minTimeframeVotes,
      neutralAsPause: config.neutralAsPause,
      cycleModel: config.cycleModel,
      autoRangeCheckMinutes: config.rebalanceIntervalMs / 60_000,
      autoRangeCooldownMinutes: config.rebalanceCooldownMs / 60_000,
      maxDirectionalNotionalPct: config.maxDirectionalNotionalPct,
      costs: costPolicy(config),
    },
    comparison: { neutralControl: neutral, aiRotation: rotation },
    costSensitivity: { noCosts, doubleCosts },
    optimization: {
      policies: Object.fromEntries(policies.map((policy) => [policy.id, policy.publicPolicy])),
      fullPeriod: Object.fromEntries(Object.entries(fullPeriod).map(([id, result]) => [id, optimizationSummary(result)])),
      annualWindows: annualWindows.map((window) => ({
        label: window.label,
        from: new Date(window.from).toISOString(),
        to: new Date(window.to).toISOString(),
        results: Object.fromEntries(Object.entries(window.results).map(([id, result]) => [id, optimizationSummary(result)])),
      })),
    },
  }, null, 2));
}

async function printLongScaleResearch({ candles, series, timeline, config, cache }) {
  const period = { from: config.tradeStartTime, to: config.tradeEndTime };
  const funding = await loadFundingHistory(config, period);
  const baseDirectionalCap = config.maxDirectionalNotionalPct;
  const scaledConfig = (multiplier, overrides = {}) => ({
    ...config,
    fundingRates: funding.rates,
    sizeScaleByMode: { long: multiplier },
    maxDirectionalNotionalPct: Math.min(100, baseDirectionalCap * multiplier),
    ...overrides,
  });
  const results = Object.fromEntries(LONG_SCALE_MULTIPLIERS.map((multiplier) => {
    return [`${multiplier}x`, runHistoricalBacktest({
      candles,
      series,
      timeline,
      config: scaledConfig(multiplier),
      strategy: 'long',
    })];
  }));
  const baselineSharpe = Number(results['1x']?.sharpe);
  const comparison = Object.fromEntries(Object.entries(results).map(([label, result]) => [label, {
    ...result,
    sharpeChangePct: Number.isFinite(baselineSharpe) && baselineSharpe !== 0 && Number.isFinite(Number(result.sharpe))
      ? round((Number(result.sharpe) / baselineSharpe - 1) * 100)
      : null,
  }]));
  const annualWindows = buildAnnualWindows(config, period.to).map((window) => ({
    label: window.label,
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    results: Object.fromEntries(LONG_SCALE_MULTIPLIERS.map((multiplier) => {
      const result = runHistoricalBacktest({
        candles,
        series,
        timeline,
        config: scaledConfig(multiplier, { tradeStartTime: window.from, tradeEndTime: window.to }),
        strategy: 'long',
      });
      return [`${multiplier}x`, longScaleSummary(result)];
    })),
  }));

  console.log(JSON.stringify({
    strategy: {
      id: 'trend_long',
      name: 'Fixed Adaptive Long Grid Position Scaling',
      invariant: 'Range, grid count, entry/exit rules, hourly parameter checks and trend guard are unchanged; only per-grid size and the matching PAPER exposure cap are scaled.',
      multipliers: LONG_SCALE_MULTIPLIERS,
    },
    data: {
      source: 'Coinbase BTC-USD 15m local cache',
      cache,
      candles15m: candles.length,
      from: new Date(period.from).toISOString(),
      to: new Date(period.to).toISOString(),
    },
    assumptions: {
      initialEquity: config.startBalance,
      feeRatePerFill: config.feeRate,
      slippageBpsPerFill: config.slippageBps,
      spreadBpsPerFill: config.spreadBps,
      fundingMode: funding.mode,
      fundingCoverage: funding.coverage,
      baseDirectionalNotionalCapPct: baseDirectionalCap,
      scaledDirectionalCap: 'min(100%, base 15% x position multiplier)',
      sharpe: 'Annualized from UTC daily mark-to-market equity returns, zero risk-free rate.',
      forcedFinalClose: true,
      limitations: [
        '15m OHLC path cannot model queue position, partial fills or sub-bar gaps exactly.',
        'No liquidation engine or nonlinear market impact is modeled; reported margin is exposure divided by configured leverage.',
      ],
    },
    results: comparison,
    independentAnnualStarts: annualWindows,
  }, null, 2));
}

function longScaleSummary(result) {
  return {
    pnl: result.pnl,
    returnPct: result.returnPct,
    maxDrawdownPct: result.maxDrawdownPct,
    sharpe: result.sharpe,
    executionCosts: result.executionCosts.total,
    fills: result.fills,
    timeInMarketPct: result.timeInMarketPct,
    maxNotionalPct: result.maxNotionalPct,
    maxMarginPct: result.maxMarginPct,
    outOfRangeStops: result.outOfRangeStops,
  };
}

export function buildHistoricalTimeline(candles, series, config) {
  const guards = new Array(candles.length);
  const legacyAnalyses = new Array(candles.length);
  const largeCycleAnalyses = new Array(candles.length);
  let h1 = null;
  let h4 = null;
  let d1 = null;
  let h1End = 0;
  let h4End = 0;
  let d1End = 0;

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    const h1Window = completedCandleWindow(series.h1, candle.time, 200);
    const latestH1End = Number(h1Window.at(-1)?.endTime) || 0;
    if (latestH1End && latestH1End !== h1End) {
      h1End = latestH1End;
      h1 = h1Window.length >= 51 ? analyzeTrend(h1Window) : null;
    }
    guards[index] = h1;

    const h4Window = completedCandleWindow(series.h4, candle.time, 200);
    const latestH4End = Number(h4Window.at(-1)?.endTime) || 0;
    if (latestH4End && latestH4End !== h4End) {
      h4End = latestH4End;
      h4 = h4Window.length >= 51 ? analyzeTrend(h4Window) : null;
    }
    if (candle.time % (30 * 60_000) === 0) {
      const m15Window = completedCandleWindow(series.m15, candle.time, 200);
      const m15 = m15Window.length >= 51 ? analyzeTrend(m15Window) : null;
      legacyAnalyses[index] = compactAnalysis(buildHistoricalAiAnalysis(
        Object.fromEntries(Object.entries({ h4, h1, m15 }).filter(([, frame]) => frame)),
        { pauseAtrPct: config.pauseAtrPct },
      ));
    }

    if (candle.time % H1_MS === 0) {
      const d1Window = completedCandleWindow(series.d1, candle.time, 200);
      const latestD1End = Number(d1Window.at(-1)?.endTime) || 0;
      if (latestD1End && latestD1End !== d1End) {
        d1End = latestD1End;
        d1 = d1Window.length >= 51 ? analyzeTrend(d1Window) : null;
      }
      largeCycleAnalyses[index] = compactAnalysis(buildLargeCycleAnalysis(
        Object.fromEntries(Object.entries({ d1, h4, h1 }).filter(([, frame]) => frame)),
        { pauseAtrPct: config.pauseAtrPct },
      ));
    }
  }
  return { guards, analyses: { legacy: legacyAnalyses, large_cycle: largeCycleAnalyses } };
}

function compactAnalysis(analysis) {
  return {
    ...analysis,
    frames: Object.fromEntries(Object.entries(analysis.frames || {}).map(([label, frame]) => [label, {
      trend: frame?.trend,
      strength: frame?.strength,
      atrPct: frame?.atrPct,
    }])),
  };
}

function candidatePolicies(config) {
  const paperV3 = resolveStrategyProfile('ai_rotation_v3', { runtimeMode: 'paper', aiConfigured: false });
  const grid = (overrides = {}) => ({
    spacingAtrMultiplier: 1,
    minSpacingFraction: 0.006,
    marginPctByMode: { neutral: 4, long: 8, short: 2 },
    ...overrides,
  });
  const definitions = [
    { id: 'legacy', cycleModel: 'legacy', analysisMinutes: 30, minConfidence: 0.75, confirmations: 2, cooldownMinutes: 240, minTimeframeVotes: 2, neutralAsPause: false },
    { id: 'previous_low_frequency', cycleModel: 'legacy', analysisMinutes: 30, minConfidence: 0.8, confirmations: 3, cooldownMinutes: 1440, minTimeframeVotes: 3, neutralAsPause: true },
    { id: 'current', cycleModel: config.cycleModel, analysisMinutes: config.analysisIntervalMs / 60_000, minConfidence: config.minConfidence, confirmations: config.confirmations, cooldownMinutes: config.cooldownMs / 60_000, minTimeframeVotes: config.minTimeframeVotes, neutralAsPause: config.neutralAsPause },
    { id: 'short_strength_040', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, gridPolicy: grid() },
    { id: 'short_strength_055', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.55, gridPolicy: grid() },
    { id: 'neutral_spacing_008', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'neutral_pause_055', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, neutralMinAtrPct: 0.55, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'neutral_pause_070', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, neutralMinAtrPct: 0.7, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_strength040', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.55, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 }, volatilityTargetAtrPct: 1, minVolatilityScale: 0.5, maxVolatilityScale: 1 }) },
    { id: 'v2_strength055', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.55, neutralMinAtrPct: 0.55, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 }, volatilityTargetAtrPct: 1, minVolatilityScale: 0.5, maxVolatilityScale: 1 }) },
    { id: 'v2_no_early_exit', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.55, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 }, volatilityTargetAtrPct: 1, minVolatilityScale: 0.5, maxVolatilityScale: 1 }) },
    { id: 'v2_filter060', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.6, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_filter070', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.7, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_filter070_no_exit', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.7, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_filter065', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.65, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_filter075', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.75, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_short035', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.35, neutralMinAtrPct: 0.7, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_short050', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.5, neutralMinAtrPct: 0.7, exitConfirmationsByMode: { short: 6 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_exit003', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.7, exitConfirmationsByMode: { short: 3 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v2_exit012', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: 0.4, neutralMinAtrPct: 0.7, exitConfirmationsByMode: { short: 12 }, gridPolicy: grid({ minSpacingFractionByMode: { neutral: 0.008 } }) },
    { id: 'v3_hold_current', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: paperV3.executionPolicy.shortMinStrength, neutralMinAtrPct: paperV3.executionPolicy.neutralMinAtrPct, blockedPolicyAction: paperV3.executionPolicy.blockedAction, gridPolicy: grid(paperV3.gridPolicy) },
    { id: 'v3_no_short', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: paperV3.executionPolicy.shortMinStrength, neutralMinAtrPct: paperV3.executionPolicy.neutralMinAtrPct, blockedPolicyAction: paperV3.executionPolicy.blockedAction, shortPolicyAction: 'pause', gridPolicy: grid(paperV3.gridPolicy) },
    { id: 'v3_short_half', cycleModel: 'large_cycle', analysisMinutes: 60, minConfidence: 0.8, confirmations: 12, cooldownMinutes: 2880, minTimeframeVotes: 3, shortMinStrength: paperV3.executionPolicy.shortMinStrength, neutralMinAtrPct: paperV3.executionPolicy.neutralMinAtrPct, blockedPolicyAction: paperV3.executionPolicy.blockedAction, sizeScaleByMode: { short: 0.5 }, gridPolicy: grid(paperV3.gridPolicy) },
  ];
  return definitions.map((definition) => ({
    id: definition.id,
    publicPolicy: {
      minConfidence: definition.minConfidence,
      cycleModel: definition.cycleModel,
      analysisMinutes: definition.analysisMinutes,
      confirmations: definition.confirmations,
      cooldownMinutes: definition.cooldownMinutes,
      minTimeframeVotes: definition.minTimeframeVotes,
      uncertainExitConfirmations: definition.uncertainExitConfirmations || 0,
      neutralAsPause: definition.neutralAsPause === true,
      minDirectionalStrength: definition.minDirectionalStrength || 0,
      shortMinStrength: definition.shortMinStrength || 0,
      neutralMinAtrPct: definition.neutralMinAtrPct || 0,
      blockedPolicyAction: definition.blockedPolicyAction || 'pause',
      shortPolicyAction: definition.shortPolicyAction || 'trade',
      sizeScaleByMode: definition.sizeScaleByMode || null,
      exitConfirmationsByMode: definition.exitConfirmationsByMode || null,
      gridPolicy: definition.gridPolicy || null,
      rebalanceCooldownMinutes: definition.rebalanceCooldownMinutes || config.rebalanceCooldownMs / 60_000,
      minGridCountChangePct: definition.minGridCountChangePct || config.minGridCountChangePct,
      minSizeChangePct: definition.minSizeChangePct || config.minSizeChangePct,
    },
    config: {
      ...config,
      cycleModel: definition.cycleModel,
      analysisIntervalMs: definition.analysisMinutes * 60_000,
      minConfidence: definition.minConfidence,
      confirmations: definition.confirmations,
      cooldownMs: definition.cooldownMinutes * 60_000,
      minTimeframeVotes: definition.minTimeframeVotes,
      uncertainExitConfirmations: definition.uncertainExitConfirmations || 0,
      neutralAsPause: definition.neutralAsPause === true,
      minDirectionalStrength: definition.minDirectionalStrength || 0,
      shortMinStrength: definition.shortMinStrength || 0,
      neutralMinAtrPct: definition.neutralMinAtrPct || 0,
      blockedPolicyAction: definition.blockedPolicyAction || 'pause',
      shortPolicyAction: definition.shortPolicyAction || 'trade',
      sizeScaleByMode: definition.sizeScaleByMode || {},
      exitConfirmationsByMode: definition.exitConfirmationsByMode || {},
      gridPolicy: definition.gridPolicy || config.gridPolicy,
      rebalanceCooldownMs: (definition.rebalanceCooldownMinutes || config.rebalanceCooldownMs / 60_000) * 60_000,
      minGridCountChangePct: definition.minGridCountChangePct || config.minGridCountChangePct,
      minSizeChangePct: definition.minSizeChangePct || config.minSizeChangePct,
    },
  }));
}

function buildAnnualWindows(config, endTime) {
  const count = Math.min(3, Math.floor(config.days / 365));
  const windows = [];
  for (let index = count; index > 0; index--) {
    const from = endTime - index * 365 * 24 * H1_MS;
    const to = endTime - (index - 1) * 365 * 24 * H1_MS;
    if (from < config.tradeStartTime) continue;
    windows.push({
      label: `${new Date(from).toISOString().slice(0, 10)}_${new Date(to).toISOString().slice(0, 10)}`,
      from,
      to,
    });
  }
  return windows;
}

function printTrainingResearch({ candles, series, timeline, config, policies }) {
  const dayMs = 24 * H1_MS;
  const holdoutFrom = config.tradeEndTime - 365 * dayMs;
  const trainConfig = { ...config, tradeStartTime: config.tradeStartTime, tradeEndTime: holdoutFrom };
  const windows = buildFixedWindows(trainConfig.tradeStartTime, trainConfig.tradeEndTime, 182 * dayMs);
  const results = {};
  for (const policy of policies) {
    const scoped = { ...policy.config, tradeStartTime: trainConfig.tradeStartTime, tradeEndTime: trainConfig.tradeEndTime };
    const standard = runHistoricalBacktest({ candles, series, timeline, config: scoped, strategy: 'rotation' });
    const doubleCosts = runHistoricalBacktest({
      candles, series, timeline, strategy: 'rotation',
      config: {
        ...scoped,
        feeRate: scoped.feeRate * 2,
        slippageBps: scoped.slippageBps * 2,
        spreadBps: scoped.spreadBps * 2,
        funding8hRate: scoped.funding8hRate * 2,
      },
    });
    results[policy.id] = {
      policy: policy.publicPolicy,
      training: optimizationSummary(standard),
      doubleCosts: optimizationSummary(doubleCosts),
      windows: windows.map((window) => ({
        label: window.label,
        ...optimizationSummary(runHistoricalBacktest({
          candles, series, timeline, strategy: 'rotation',
          config: { ...scoped, tradeStartTime: window.from, tradeEndTime: window.to },
        })),
      })),
    };
  }
  console.log(JSON.stringify({
    stage: 'training_only',
    rule: 'Candidate selection may use only this two-year window; the final 365 days remain hidden.',
    training: { from: new Date(trainConfig.tradeStartTime).toISOString(), to: new Date(trainConfig.tradeEndTime).toISOString() },
    hiddenHoldout: { from: new Date(holdoutFrom).toISOString(), to: new Date(config.tradeEndTime).toISOString() },
    results,
  }, null, 2));
}

function printHoldoutValidation({ candles, series, timeline, config, policies }) {
  const dayMs = 24 * H1_MS;
  const holdoutFrom = config.tradeEndTime - 365 * dayMs;
  const selectedIds = ['current', 'v2_filter070'];
  const results = {};
  for (const id of selectedIds) {
    const policy = policies.find((item) => item.id === id);
    if (!policy) throw new Error(`缺少冻结策略 ${id}`);
    const scoped = { ...policy.config, tradeStartTime: holdoutFrom, tradeEndTime: config.tradeEndTime };
    const standard = runHistoricalBacktest({ candles, series, timeline, config: scoped, strategy: 'rotation' });
    const doubleCosts = runHistoricalBacktest({
      candles, series, timeline, strategy: 'rotation',
      config: {
        ...scoped,
        feeRate: scoped.feeRate * 2,
        slippageBps: scoped.slippageBps * 2,
        spreadBps: scoped.spreadBps * 2,
        funding8hRate: scoped.funding8hRate * 2,
      },
    });
    results[id] = {
      policy: policy.publicPolicy,
      holdout: optimizationSummary(standard),
      doubleCosts: optimizationSummary(doubleCosts),
    };
  }
  console.log(JSON.stringify({
    stage: 'frozen_holdout_validation',
    rule: 'Only the preselected v2_filter070 candidate and the unchanged baseline are evaluated; this window must not be used for further tuning.',
    holdout: { from: new Date(holdoutFrom).toISOString(), to: new Date(config.tradeEndTime).toISOString() },
    results,
  }, null, 2));
}

function printV3Comparison({ candles, series, timeline, config, policies }) {
  const selectedIds = ['current', 'v2_filter070', 'v3_hold_current'];
  const windows = buildFixedWindows(config.tradeStartTime, config.tradeEndTime, 182 * 24 * H1_MS);
  const results = {};
  for (const id of selectedIds) {
    const policy = policies.find((item) => item.id === id);
    if (!policy) throw new Error(`缺少 V3 对照策略 ${id}`);
    const standard = runHistoricalBacktest({ candles, series, timeline, config: policy.config, strategy: 'rotation' });
    const doubleCosts = runHistoricalBacktest({
      candles, series, timeline, strategy: 'rotation',
      config: {
        ...policy.config,
        feeRate: policy.config.feeRate * 2,
        slippageBps: policy.config.slippageBps * 2,
        spreadBps: policy.config.spreadBps * 2,
        funding8hRate: policy.config.funding8hRate * 2,
      },
    });
    results[id] = {
      policy: policy.publicPolicy,
      fullPeriod: optimizationSummary(standard),
      doubleCosts: optimizationSummary(doubleCosts),
      windows: windows.map((window) => ({
        label: window.label,
        ...optimizationSummary(runHistoricalBacktest({
          candles, series, timeline, strategy: 'rotation',
          config: { ...policy.config, tradeStartTime: window.from, tradeEndTime: window.to },
        })),
      })),
    };
  }
  console.log(JSON.stringify({
    stage: 'v3_retrospective_comparison',
    limitation: 'V3 was proposed after observing the prior holdout. These results are retrospective and are not a new out-of-sample validation.',
    period: { from: new Date(config.tradeStartTime).toISOString(), to: new Date(config.tradeEndTime).toISOString() },
    results,
  }, null, 2));
}

function printRobustnessResearch({ candles, series, timeline, config, policies }) {
  const selectedIds = ['current', 'v3_hold_current', 'v3_no_short', 'v3_short_half'];
  const selected = selectedIds.map((id) => {
    const policy = policies.find((item) => item.id === id);
    if (!policy) throw new Error(`缺少稳健性对照策略 ${id}`);
    return policy;
  });
  const halfYearMs = 182 * 24 * H1_MS;
  const fullWindows = buildFixedWindows(config.tradeStartTime, config.tradeEndTime, halfYearMs);
  const fullPeriod = Object.fromEntries(selected.map((policy) => {
    const standard = runHistoricalBacktest({ candles, series, timeline, config: policy.config, strategy: 'rotation' });
    return [policy.id, {
      policy: policy.publicPolicy,
      standard: optimizationSummary(standard),
      costSensitivity: Object.fromEntries([2, 3].map((multiplier) => [
        `${multiplier}x`,
        optimizationSummary(runHistoricalBacktest({
          candles,
          series,
          timeline,
          strategy: 'rotation',
          config: multiplyExecutionCosts(policy.config, multiplier),
        })),
      ])),
      halfYearWindows: fullWindows.map((window) => ({
        label: window.label,
        ...optimizationSummary(runHistoricalBacktest({
          candles,
          series,
          timeline,
          strategy: 'rotation',
          config: { ...policy.config, tradeStartTime: window.from, tradeEndTime: window.to },
        })),
      })),
    }];
  }));

  const walkForward = buildWalkForwardResearch({ candles, series, timeline, config, policies: selected, halfYearMs });
  const perturbations = buildParameterPerturbations(selected.find((policy) => policy.id === 'v3_short_half'));
  const perturbationResults = Object.fromEntries(perturbations.map(({ id, change, config: perturbedConfig }) => [id, {
    change,
    ...optimizationSummary(runHistoricalBacktest({
      candles,
      series,
      timeline,
      config: perturbedConfig,
      strategy: 'rotation',
    })),
  }]));
  const promotionAssessment = buildPromotionAssessment({
    fullPeriod,
    walkForward,
    perturbationResults,
    startBalance: config.startBalance,
  });

  console.log(JSON.stringify({
    stage: 'robustness_research_only',
    productionChanged: false,
    limitation: 'V3 and its short-side variants were proposed after inspecting the recent three-year history. The added older history is a post-hypothesis historical challenge set, not live out-of-sample evidence.',
    source: 'Coinbase BTC-USD 15m; completed bars only; 1h/4h/1d signals',
    period: { from: new Date(config.tradeStartTime).toISOString(), to: new Date(config.tradeEndTime).toISOString() },
    methodology: {
      candidates: selectedIds,
      candidateCount: selectedIds.length,
      rollingWindow: '18 months training followed by 6 months validation, advancing 6 months',
      trainingSelection: 'Eligible candidates need positive 2x-cost training PnL, at least 20% exposure, and worst six-month PnL above -1% of initial equity. Selection then maximizes the worst training window, followed by median window PnL, lower drawdown, lower costs, and fewer automatic actions.',
      selectionFallback: 'If no candidate passes every training gate, retain the unchanged current baseline for the next validation window.',
      costStress: ['1x', '2x', '3x'],
      perturbation: 'One parameter at a time around v3_short_half; no combinatorial parameter search.',
    },
    fullPeriod,
    walkForward,
    parameterPerturbation: {
      baseCandidate: 'v3_short_half',
      results: perturbationResults,
      summary: summarizePerturbations(perturbationResults),
    },
    promotionAssessment,
  }, null, 2));
}

function buildWalkForwardResearch({ candles, series, timeline, config, policies, halfYearMs }) {
  const trainWidthMs = 3 * halfYearMs;
  const folds = [];
  for (let validationFrom = config.tradeStartTime + trainWidthMs;
    validationFrom + halfYearMs <= config.tradeEndTime;
    validationFrom += halfYearMs) {
    const training = { from: validationFrom - trainWidthMs, to: validationFrom };
    const validation = { from: validationFrom, to: validationFrom + halfYearMs };
    const trainingResults = {};
    const validationResults = {};
    for (const policy of policies) {
      const trainingConfig = { ...policy.config, tradeStartTime: training.from, tradeEndTime: training.to };
      const trainingWindows = buildFixedWindows(training.from, training.to, halfYearMs).map((window) =>
        runHistoricalBacktest({
          candles,
          series,
          timeline,
          strategy: 'rotation',
          config: { ...policy.config, tradeStartTime: window.from, tradeEndTime: window.to },
        }));
      trainingResults[policy.id] = robustTrainingSummary({
        standard: runHistoricalBacktest({ candles, series, timeline, config: trainingConfig, strategy: 'rotation' }),
        doubleCosts: runHistoricalBacktest({
          candles,
          series,
          timeline,
          config: multiplyExecutionCosts(trainingConfig, 2),
          strategy: 'rotation',
        }),
        windows: trainingWindows,
        startBalance: config.startBalance,
      });
      validationResults[policy.id] = optimizationSummary(runHistoricalBacktest({
        candles,
        series,
        timeline,
        strategy: 'rotation',
        config: { ...policy.config, tradeStartTime: validation.from, tradeEndTime: validation.to },
      }));
    }
    const selectedId = selectRobustCandidate(trainingResults);
    folds.push({
      label: `${new Date(validation.from).toISOString().slice(0, 10)}_${new Date(validation.to).toISOString().slice(0, 10)}`,
      training: { from: new Date(training.from).toISOString(), to: new Date(training.to).toISOString() },
      validation: { from: new Date(validation.from).toISOString(), to: new Date(validation.to).toISOString() },
      trainingResults,
      selectedByTraining: selectedId,
      validationResults,
      selectedValidation: validationResults[selectedId],
    });
  }
  const aggregateByCandidate = Object.fromEntries(policies.map((policy) => [
    policy.id,
    aggregateValidationResults(folds.map((fold) => fold.validationResults[policy.id])),
  ]));
  return {
    folds,
    aggregateByCandidate,
    trainSelectedAggregate: aggregateValidationResults(folds.map((fold) => fold.selectedValidation)),
    selections: countValues(folds.map((fold) => fold.selectedByTraining)),
  };
}

function robustTrainingSummary({ standard, doubleCosts, windows, startBalance }) {
  const windowPnls = windows.map((result) => Number(result.pnl));
  const worstWindowPnl = Math.min(...windowPnls);
  const medianWindowPnl = median(windowPnls);
  const summary = optimizationSummary(standard);
  return {
    ...summary,
    doubleCostPnl: doubleCosts.pnl,
    medianWindowPnl: round(medianWindowPnl),
    worstWindowPnl: round(worstWindowPnl),
    profitableWindows: windowPnls.filter((pnl) => pnl > 0).length,
    windowCount: windowPnls.length,
    eligible: doubleCosts.pnl > 0
      && summary.timeInMarketPct >= 20
      && worstWindowPnl > -startBalance * 0.01,
  };
}

function selectRobustCandidate(results) {
  const entries = Object.entries(results);
  const eligible = entries.filter(([, result]) => result.eligible);
  if (!eligible.length) return results.current ? 'current' : entries[0][0];
  eligible.sort(([, left], [, right]) =>
    right.worstWindowPnl - left.worstWindowPnl
    || right.medianWindowPnl - left.medianWindowPnl
    || left.maxDrawdownPct - right.maxDrawdownPct
    || left.executionCosts - right.executionCosts
    || left.totalAutomaticActions - right.totalAutomaticActions);
  return eligible[0][0];
}

function aggregateValidationResults(results) {
  const usable = results.filter(Boolean);
  if (!usable.length) {
    return {
      folds: 0,
      totalPnl: 0,
      medianPnl: 0,
      worstPnl: null,
      profitableFolds: 0,
      maxDrawdownPct: null,
      executionCosts: 0,
      totalAutomaticActions: 0,
      averageTimeInMarketPct: 0,
    };
  }
  const pnls = usable.map((result) => Number(result.pnl));
  return {
    folds: usable.length,
    totalPnl: round(pnls.reduce((sum, value) => sum + value, 0)),
    medianPnl: round(median(pnls)),
    worstPnl: round(Math.min(...pnls)),
    profitableFolds: pnls.filter((value) => value > 0).length,
    maxDrawdownPct: round(Math.max(...usable.map((result) => Number(result.maxDrawdownPct)))),
    executionCosts: round(usable.reduce((sum, result) => sum + Number(result.executionCosts), 0)),
    totalAutomaticActions: usable.reduce((sum, result) => sum + Number(result.totalAutomaticActions), 0),
    averageTimeInMarketPct: round(usable.reduce((sum, result) => sum + Number(result.timeInMarketPct), 0) / Math.max(1, usable.length)),
  };
}

function buildParameterPerturbations(policy) {
  if (!policy) throw new Error('缺少 V3 缩小做空候选。');
  const base = policy.config;
  return [
    { id: 'confirmations_minus17pct', change: 'confirmations 12 -> 10', config: { ...base, confirmations: 10 } },
    { id: 'confirmations_plus17pct', change: 'confirmations 12 -> 14', config: { ...base, confirmations: 14 } },
    { id: 'cooldown_minus20pct', change: 'cooldown 2880m -> 2304m', config: { ...base, cooldownMs: 2304 * 60_000 } },
    { id: 'cooldown_plus20pct', change: 'cooldown 2880m -> 3456m', config: { ...base, cooldownMs: 3456 * 60_000 } },
    { id: 'short_strength_minus20pct', change: 'short strength 0.40 -> 0.32', config: { ...base, shortMinStrength: 0.32 } },
    { id: 'short_strength_plus20pct', change: 'short strength 0.40 -> 0.48', config: { ...base, shortMinStrength: 0.48 } },
    { id: 'neutral_atr_minus20pct', change: 'neutral ATR 0.70% -> 0.56%', config: { ...base, neutralMinAtrPct: 0.56 } },
    { id: 'neutral_atr_plus20pct', change: 'neutral ATR 0.70% -> 0.84%', config: { ...base, neutralMinAtrPct: 0.84 } },
    { id: 'short_size_minus20pct', change: 'short size scale 0.50 -> 0.40', config: { ...base, sizeScaleByMode: { ...base.sizeScaleByMode, short: 0.4 } } },
    { id: 'short_size_plus20pct', change: 'short size scale 0.50 -> 0.60', config: { ...base, sizeScaleByMode: { ...base.sizeScaleByMode, short: 0.6 } } },
  ];
}

function summarizePerturbations(results) {
  const values = Object.values(results);
  const pnls = values.map((result) => Number(result.pnl));
  return {
    variants: values.length,
    profitableVariants: pnls.filter((pnl) => pnl > 0).length,
    pnlRange: { min: round(Math.min(...pnls)), median: round(median(pnls)), max: round(Math.max(...pnls)) },
    worstMaxDrawdownPct: round(Math.max(...values.map((result) => Number(result.maxDrawdownPct)))),
  };
}

function buildPromotionAssessment({ fullPeriod, walkForward, perturbationResults, startBalance }) {
  const maximumWindowLoss = startBalance * 0.01;
  const assessments = Object.fromEntries(Object.entries(fullPeriod).map(([id, result]) => {
    const halfYearPnls = result.halfYearWindows.map((window) => Number(window.pnl));
    const rolling = walkForward.aggregateByCandidate[id];
    const requiredGates = {
      positiveFullPeriod: result.standard.pnl > 0,
      positiveDoubleCost: result.costSensitivity['2x'].pnl > 0,
      worstHalfYearWithinOnePct: Math.min(...halfYearPnls) > -maximumWindowLoss,
      rollingWorstWithinOnePct: rolling.worstPnl > -maximumWindowLoss,
      atLeastSeventyPctProfitableRollingFolds: rolling.profitableFolds / Math.max(1, rolling.folds) >= 0.7,
    };
    if (id === 'v3_short_half') {
      requiredGates.allSingleParameterPerturbationsProfitable = Object.values(perturbationResults)
        .every((variant) => Number(variant.pnl) > 0);
    }
    return [id, {
      requiredGates,
      passed: Object.values(requiredGates).every(Boolean),
      diagnosticThreeXCostPositive: result.costSensitivity['3x'].pnl > 0,
    }];
  }));
  const passedCandidates = Object.entries(assessments).filter(([, assessment]) => assessment.passed).map(([id]) => id);
  return {
    rule: 'Research candidates must pass every required gate. Three-times-cost PnL is reported as an additional stress diagnostic, not used to rescue or reject a candidate.',
    maximumAllowedHalfYearLoss: round(maximumWindowLoss),
    assessments,
    promoteCandidate: passedCandidates.length === 1 ? passedCandidates[0] : null,
    productionChanged: false,
  };
}

function multiplyExecutionCosts(config, multiplier) {
  return {
    ...config,
    feeRate: config.feeRate * multiplier,
    slippageBps: config.slippageBps * multiplier,
    spreadBps: config.spreadBps * multiplier,
    funding8hRate: config.funding8hRate * multiplier,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function countValues(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function buildFixedWindows(from, to, widthMs) {
  const windows = [];
  for (let start = from; start < to; start += widthMs) {
    const end = Math.min(to, start + widthMs);
    if (end - start < 90 * 24 * H1_MS) break;
    windows.push({
      label: `${new Date(start).toISOString().slice(0, 10)}_${new Date(end).toISOString().slice(0, 10)}`,
      from: start,
      to: end,
    });
  }
  return windows;
}

function optimizationSummary(result) {
  const directDirectionSwitches = Number(result.actions?.switched) || 0;
  const starts = Number(result.actions?.started) || 0;
  const stops = Number(result.actions?.stopped) || 0;
  return {
    pnl: result.pnl,
    returnPct: result.returnPct,
    maxDrawdownPct: result.maxDrawdownPct,
    grossPnlBeforeCosts: result.grossPnlBeforeCosts,
    executionCosts: result.executionCosts.total,
    fills: result.fills,
    timeInMarketPct: result.timeInMarketPct,
    gridStarts: result.gridStarts,
    autoRebalances: result.autoRebalances,
    parameterChanges: result.parameterChanges,
    modePerformance: result.modePerformance,
    directDirectionSwitches,
    starts,
    stops,
    totalAutomaticActions: directDirectionSwitches + starts + stops,
    forceCloses: result.forceCloses,
  };
}

export function runHistoricalBacktest({ candles, series, timeline = null, config, strategy }) {
  const state = createState(config, strategy);
  let previousClose = null;
  let finalCandle = null;
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    if (candle.time < config.tradeStartTime) {
      previousClose = candle.close;
      continue;
    }
    if (config.tradeEndTime && candle.time >= config.tradeEndTime) break;
    if (!state.startedAt) state.startedAt = candle.time;
    finalCandle = candle;
    const admissionCheckDue = strategy === 'neutral'
      ? (!state.initialized || candle.time % H1_MS === 0)
      : (state.running && state.mode === 'neutral' && candle.time % H1_MS === 0);
    const frames = !timeline || admissionCheckDue ? analyzeHistoricalFrames(series, candle.time) : null;
    const guard = timeline?.guards[index] || frames?.h1 || { trend: 'range', strength: 0, atrPct: null };

    applyFundingThrough(state, candle.time, candle.open, config);

    if (strategy === 'neutral' && !state.initialized) {
      startGrid(state, 'neutral', candle.open, guard, index, config, 'initial');
      state.initialized = true;
    }
    if (strategy === 'long' && !state.initialized) {
      startGrid(state, 'long', candle.open, guard, index, config, 'initial');
      state.initialized = true;
    }
    if (strategy === 'rotation' && candle.time % config.analysisIntervalMs === 0) {
      const analysis = timeline?.analyses?.[config.cycleModel]?.[index]
        || (config.cycleModel === 'large_cycle'
          ? buildLargeCycleAnalysis(frames, { pauseAtrPct: config.pauseAtrPct })
          : buildHistoricalAiAnalysis(frames, { pauseAtrPct: config.pauseAtrPct }));
      processRotationDecision(state, analysis, guard, candle, index, config);
    }

    if (state.running) {
      if (state.mode === 'neutral' && admissionCheckDue) updateNeutralAdmission(state, frames, config);
      maybeRebalanceRange(state, candle.open, guard, candle.time, index, config);
      syncGuardedOrders(state, candle.open, guard, config);
      processCandlePath(state, candle, previousClose, guard, index, config);
      if (state.running) state.runningBars++;
    }

    observeEquity(state, candle.close, candle.time + M15_MS);
    previousClose = candle.close;
  }

  if (!finalCandle) throw new Error('指定回测窗口没有可用 K 线。');
  if (state.position.sizeBase) closePosition(state, finalCandle.close, config, 'final');
  state.orders.clear();
  state.running = false;
  observeEquity(state, finalCandle.close, finalCandle.time + M15_MS);
  return summarize(state, finalCandle, config);
}

function processRotationDecision(state, analysis, guard, candle, index, config) {
  const effectiveAnalysis = applyBacktestPolicy(analysis, config);
  const gate = evaluateAiAutopilot({
    analysis: effectiveAnalysis,
    state: state.autopilot,
    config: {
      enabled: true,
      minConfidence: config.minConfidence,
      confirmations: config.confirmations,
      cooldownMinutes: config.cooldownMs / 60_000,
      minTimeframeVotes: config.minTimeframeVotes,
      neutralAsPause: config.neutralAsPause,
    },
    now: candle.time,
  });
  state.autopilot = gate.state;
  state.analyses++;
  increment(state.gateReasons, gate.reason);
  increment(state.regimes, effectiveAnalysis.regime || 'unknown');
  if (!gate.ready) {
    maybePauseOnLostConsensus(state, effectiveAnalysis, candle, config);
    return;
  }

  const target = gate.target;
  if ((target === 'paused' && !state.running) || (state.running && state.mode === target)) {
    state.autopilot = { ...state.autopilot, candidate: null, candidateCount: 0, lastTarget: target };
    state.lostConsensusCount = 0;
    state.alignedDecisions++;
    return;
  }

  const previousMode = state.running ? state.mode : 'paused';
  if (state.running) stopGrid(state, candle.open, config, target === 'paused' ? 'ai_pause' : 'ai_switch');
  if (target !== 'paused') {
    startGrid(state, target, candle.open, guard, index, config, previousMode === 'paused' ? 'ai_start' : 'ai_switch');
  }
  const action = target === 'paused' ? 'stopped' : previousMode === 'paused' ? 'started' : 'switched';
  state.autopilot = completeAiAutopilotAction(state.autopilot, { action, target, now: candle.time });
  increment(state.actions, action);
  increment(state.transitions, `${previousMode}->${target}`);
}

export function applyBacktestPolicy(analysis, config) {
  const cyclePolicy = applyLargeCycleExecutionPolicy(analysis, {
    shortMinStrength: config.shortMinStrength,
    neutralMinAtrPct: config.neutralMinAtrPct,
    blockedAction: config.blockedPolicyAction,
  });
  if (cyclePolicy.suitable === true && cyclePolicy.mode === 'short' && config.shortPolicyAction === 'pause') {
    return {
      ...cyclePolicy,
      suitable: false,
      regime: '下跌暂停',
      policyReason: 'short_disabled',
      policyAction: 'pause',
    };
  }
  if (config.neutralAsPause && cyclePolicy.suitable === true && cyclePolicy.mode === 'neutral') {
    return { ...cyclePolicy, suitable: false, regime: '震荡暂停' };
  }
  if (config.minDirectionalStrength > 0 && cyclePolicy.suitable === true && ['long', 'short'].includes(cyclePolicy.mode)) {
    const expected = cyclePolicy.mode === 'long' ? 'up' : 'down';
    const supporting = Object.values(cyclePolicy.frames || {}).filter((frame) => frame?.trend === expected);
    if (supporting.length < config.minTimeframeVotes
      || supporting.some((frame) => Number(frame.strength) < config.minDirectionalStrength)) {
      return { ...cyclePolicy, suitable: false, regime: '弱趋势暂停' };
    }
  }
  return cyclePolicy;
}

function maybePauseOnLostConsensus(state, analysis, candle, config) {
  const required = Number(config.exitConfirmationsByMode?.[state.mode] ?? config.uncertainExitConfirmations) || 0;
  if (!state.running || !(required > 0)) return;
  if (analysisSupportsMode(analysis, state.mode, config.minTimeframeVotes)) {
    state.lostConsensusCount = 0;
    return;
  }
  state.lostConsensusCount++;
  if (state.lostConsensusCount < required) return;
  const previousMode = state.mode;
  stopGrid(state, candle.open, config, 'lost_consensus');
  state.autopilot = completeAiAutopilotAction(state.autopilot, { action: 'stopped', target: 'paused', now: candle.time });
  state.lostConsensusCount = 0;
  increment(state.actions, 'stopped');
  increment(state.transitions, `${previousMode}->paused`);
}

function analysisSupportsMode(analysis, mode, minimumVotes) {
  const expected = ({ neutral: 'range', long: 'up', short: 'down' })[mode];
  if (!expected || analysis.suitable !== true) return false;
  const votes = Object.values(analysis.frames || {}).filter((frame) => frame?.trend === expected).length;
  return votes >= minimumVotes;
}

function startGrid(state, mode, price, trend, index, config, reason) {
  const suggestion = applyModeSizeScale(suggestAdaptiveGrid({
    price,
    atrPct: trend?.atrPct,
    equity: equity(state, price),
    market: MARKET,
    trend: trend?.trend || 'range',
    mode,
    policy: config.gridPolicy,
    execution: costPolicy(config),
  }), mode, config);
  state.config = { ...suggestion, mode };
  state.grid = buildGrid(suggestion);
  state.orders = new Map(seedOrders({
    levels: state.grid.levels,
    price,
    mode,
    spacing: state.grid.spacing,
  }).map((order) => [order.levelIndex, {
    ...order,
    sizeBase: suggestion.sizeBase,
    opening: true,
    deferred: false,
    createdIndex: index,
  }]));
  state.running = true;
  state.mode = mode;
  state.lostConsensusCount = 0;
  state.gridStarts++;
  increment(state.modeStarts, mode);
  increment(state.startReasons, reason);
}

function stopGrid(state, price, config, reason) {
  if (state.position.sizeBase) closePosition(state, price, config, reason);
  state.orders.clear();
  state.running = false;
  state.mode = null;
  state.grid = null;
  state.config = null;
  increment(state.stopReasons, reason);
}

function maybeRebalanceRange(state, price, trend, now, index, config) {
  if (state.lastRangeCheckAt && now - state.lastRangeCheckAt < config.rebalanceIntervalMs) return;
  state.lastRangeCheckAt = now;
  const gate = autoRebalanceGate({
    enabled: true,
    running: state.running,
    hasConfig: Boolean(state.config),
    now,
    lastCheckAt: 0,
    lastAdjustedAt: state.lastRangeAdjustedAt,
    cooldownMs: config.rebalanceCooldownMs,
    price,
    lower: state.config?.lower,
    upper: state.config?.upper,
    edgePct: 20,
    requireEdge: false,
  });
  if (!gate.ok) {
    increment(state.rebalanceReasons, gate.reason);
    return;
  }
  const suggestion = applyModeSizeScale(suggestAdaptiveGrid({
    price,
    atrPct: trend?.atrPct,
    equity: equity(state, price),
    market: MARKET,
    trend: trend?.trend || 'range',
    mode: state.mode,
    policy: config.gridPolicy,
    execution: costPolicy(config),
  }), state.mode, config);
  const change = adaptiveGridChangedEnough({
    previous: state.config,
    next: suggestion,
    price,
    edgePct: 20,
    minRangeChangePct: config.minRangeChangePct,
    minGridCountChangePct: config.minGridCountChangePct,
    minSizeChangePct: config.minSizeChangePct,
  });
  if (!change.ok) {
    increment(state.rebalanceReasons, 'insufficient_change');
    return;
  }
  const nextConfig = {
    ...state.config,
    lower: change.reasons.includes('range') ? suggestion.lower : state.config.lower,
    upper: change.reasons.includes('range') ? suggestion.upper : state.config.upper,
    gridCount: change.reasons.includes('grid_count') ? suggestion.gridCount : state.config.gridCount,
    sizeBase: change.reasons.includes('size') ? suggestion.sizeBase : state.config.sizeBase,
    leverage: change.reasons.includes('leverage') ? suggestion.leverage : state.config.leverage,
  };
  if (state.mode === 'neutral') {
    const economics = neutralRebalanceEconomics({
      previous: state.config,
      next: nextConfig,
      price,
      reasons: change.reasons,
      nearEdge: change.nearEdge,
      execution: {
        ...costPolicy(config),
        costCoverageMultiple: state.config.minRoundTripCostMultiple,
      },
    });
    if (!economics.ok) {
      increment(state.rebalanceReasons, 'uneconomic_change');
      return;
    }
  }
  state.config = nextConfig;
  state.grid = buildGrid(state.config);
  state.orders = new Map(seedOrders({
    levels: state.grid.levels,
    price,
    mode: state.mode,
    spacing: state.grid.spacing,
  }).map((order) => [order.levelIndex, {
    ...order,
    sizeBase: state.config.sizeBase,
    opening: true,
    deferred: false,
    createdIndex: index,
  }]));
  state.lastRangeAdjustedAt = now;
  state.autoRebalances++;
  for (const reason of change.reasons) increment(state.parameterChanges, reason);
  increment(state.rebalanceReasons, 'adjusted');
}

export function applyModeSizeScale(suggestion, mode, config = {}) {
  const configured = Number(config.sizeScaleByMode?.[mode]);
  const scale = Number.isFinite(configured) && configured > 0 ? configured : 1;
  if (scale === 1) return suggestion;
  const stepSize = MARKET.stepSize;
  const scaledSteps = Math.floor((Number(suggestion.sizeBase) * scale) / stepSize + 1e-9);
  const scaled = Math.max(MARKET.minOrderSize, scaledSteps * stepSize);
  return {
    ...suggestion,
    sizeBase: Number((Math.round(scaled / stepSize) * stepSize).toFixed(12)),
    sizeScale: scale,
    rationale: `${suggestion.rationale} ${mode} 单格数量应用研究倍率 ${scale}。`,
  };
}

function syncGuardedOrders(state, markPrice, trend, config) {
  for (const order of state.orders.values()) {
    if (order.opening === false) continue;
    const decision = orderDecision(state, order, markPrice, trend, config);
    if (!decision.allowed) {
      order.deferred = true;
      increment(state.guardBlocks, decision.reason);
      continue;
    }
    if (order.deferred && !isPassiveOpeningOrder({ side: order.side, price: order.price, marketPrice: markPrice })) continue;
    order.deferred = false;
  }
}

function updateNeutralAdmission(state, frames, config) {
  if (state.mode !== 'neutral' || !state.config?.neutralRangeAdmissionEnabled) {
    state.rangeAdmission = { enabled: false, allowed: true, reason: 'not_required' };
    return;
  }
  state.rangeAdmission = neutralRangeAdmission({
    frames: frames || {},
    currentAllowed: state.rangeAdmission?.allowed === true,
    minAtrPct: state.config.rangeAdmissionMinAtrPct,
    trendStrength: config.trendGuardMinStrength,
    dataValid: Boolean(frames?.d1 && frames?.h4 && frames?.h1),
  });
  increment(state.rangeAdmissionReasons, state.rangeAdmission.reason);
}

function processCandlePath(state, candle, previousClose, trend, index, config) {
  if (!state.running) return;
  if (candle.open < state.config.lower || candle.open > state.config.upper) {
    state.outOfRangeStops++;
    stopGrid(state, candle.open, config, 'out_of_range');
    return;
  }
  const bullish = candle.close >= candle.open;
  const points = [
    Number.isFinite(previousClose) ? previousClose : candle.open,
    candle.open,
    bullish ? candle.low : candle.high,
    bullish ? candle.high : candle.low,
    candle.close,
  ];
  for (let segment = 1; segment < points.length && state.running; segment++) {
    processSegment(state, points[segment - 1], points[segment], trend, index, config);
  }
}

function processSegment(state, from, to, trend, index, config) {
  if (from === to || !state.running) return;
  const rising = to > from;
  const boundary = rising ? state.config.upper : state.config.lower;
  const crossesBoundary = rising ? from <= boundary && to > boundary : from >= boundary && to < boundary;
  const segmentEnd = crossesBoundary ? boundary : to;
  const candidates = [...state.orders.values()]
    .filter((order) => !order.deferred && order.createdIndex < index)
    .filter((order) => rising ? order.side === 'sell' : order.side === 'buy')
    .filter((order) => rising
      ? order.price >= Math.min(from, segmentEnd) && order.price <= Math.max(from, segmentEnd)
      : order.price <= Math.max(from, segmentEnd) && order.price >= Math.min(from, segmentEnd))
    .sort((a, b) => rising ? a.price - b.price : b.price - a.price);

  for (const order of candidates) {
    if (!state.running || state.orders.get(order.levelIndex) !== order) continue;
    fillOrder(state, order, trend, index, config);
  }
  if (crossesBoundary && state.running) {
    state.outOfRangeStops++;
    stopGrid(state, boundary, config, 'out_of_range');
  }
}

function fillOrder(state, order, trend, index, config) {
  const decision = orderDecision(state, order, order.price, trend, config, order.opening === false);
  if (!decision.allowed) {
    order.deferred = true;
    increment(state.guardBlocks, decision.reason);
    return;
  }
  const reducing = (state.position.sizeBase > 0 && order.side === 'sell')
    || (state.position.sizeBase < 0 && order.side === 'buy');
  const reduceOnly = order.opening === false || decision.reduceOnly;
  const sizeBase = reduceOnly
    ? Math.min(Number(decision.sizeBase || order.sizeBase), Math.abs(state.position.sizeBase))
    : Number(decision.sizeBase || order.sizeBase);
  if (reduceOnly && !reducing || !(sizeBase > 0)) {
    state.orders.delete(order.levelIndex);
    return;
  }
  state.orders.delete(order.levelIndex);
  applyTrade(state, order.side, order.price, sizeBase, config);
  state.fills++;
  const closing = order.opening === false || decision.reduceOnly;
  if (closing) state.completedRungs++;

  const replacement = replacementFor(order, state.grid.levels, state.mode);
  if (!replacement || !state.running) return;
  const next = {
    ...replacement,
    sizeBase,
    opening: closing,
    deferred: false,
    createdIndex: index,
  };
  const occupied = state.orders.get(next.levelIndex);
  if (!occupied) state.orders.set(next.levelIndex, next);
  else if (next.opening === false && occupied.opening === false && occupied.side === next.side) occupied.sizeBase += sizeBase;
}

function orderDecision(state, order, markPrice, trend, config, forceReduceOnly = false) {
  return inventoryOrderDecision({
    side: order.side,
    sizeBase: order.sizeBase,
    positionSize: state.position.sizeBase,
    price: order.price,
    equity: equity(state, markPrice),
    maxDirectionalNotionalPct: config.maxDirectionalNotionalPct,
    forceReduceOnly,
    trendGuardEnabled: true,
    trend: trend?.trend || 'range',
    trendStrength: Number(trend?.strength) || 0,
    trendGuardMinStrength: config.trendGuardMinStrength,
    mode: state.mode,
    rangeAdmissionEnabled: state.config?.neutralRangeAdmissionEnabled,
    rangeAdmissionAllowed: state.rangeAdmission?.allowed === true,
    inventorySkewEnabled: state.config?.inventorySkewEnabled,
    inventorySkewStartPctOfCap: state.config?.inventorySkewStartPctOfCap,
    inventorySkewMinScale: state.config?.inventorySkewMinScale,
    stepSize: MARKET.stepSize,
    minOrderSize: MARKET.minOrderSize,
  });
}

function applyTrade(state, side, price, quantity, config) {
  const performance = modePerformance(state);
  const notional = price * quantity;
  const fees = notional * config.feeRate;
  const slippage = notional * config.slippageBps / 10_000;
  const spread = notional * config.spreadBps / 10_000;
  state.balance -= fees + slippage + spread;
  state.costs.fees += fees;
  state.costs.slippage += slippage;
  state.costs.spread += spread;
  performance.costs += fees + slippage + spread;
  performance.fills++;
  performance.volume += notional;
  state.volume += notional;

  const signed = side === 'buy' ? quantity : -quantity;
  const position = state.position;
  if (!position.sizeBase || Math.sign(position.sizeBase) === Math.sign(signed)) {
    const nextSize = position.sizeBase + signed;
    position.entryPrice = (Math.abs(position.sizeBase) * position.entryPrice + Math.abs(signed) * price) / Math.abs(nextSize);
    position.sizeBase = nextSize;
    return;
  }
  const closeQuantity = Math.min(Math.abs(position.sizeBase), Math.abs(signed));
  const pnl = position.sizeBase > 0
    ? closeQuantity * (price - position.entryPrice)
    : closeQuantity * (position.entryPrice - price);
  state.balance += pnl;
  state.realizedTradingPnl += pnl;
  performance.realizedPnl += pnl;
  const remaining = position.sizeBase + signed;
  if (!remaining || Math.sign(remaining) === Math.sign(position.sizeBase)) {
    position.sizeBase = remaining;
    if (!remaining) position.entryPrice = 0;
  } else {
    position.sizeBase = remaining;
    position.entryPrice = price;
  }
}

function closePosition(state, price, config, reason) {
  const quantity = Math.abs(state.position.sizeBase);
  if (!(quantity > 0)) return;
  applyTrade(state, state.position.sizeBase > 0 ? 'sell' : 'buy', price, quantity, config);
  state.forceCloses++;
  increment(state.forceCloseReasons, reason);
}

function applyFundingThrough(state, now, price, config) {
  if (Array.isArray(config.fundingRates)) {
    while (state.fundingIndex < config.fundingRates.length
      && config.fundingRates[state.fundingIndex].time <= now) {
      const row = config.fundingRates[state.fundingIndex++];
      if (row.time <= state.fundingFrom || !state.position.sizeBase) continue;
      const payment = state.position.sizeBase * price * row.rate;
      state.balance -= payment;
      state.costs.funding += payment;
      modePerformance(state).funding += payment;
    }
    return;
  }
  if (!state.nextFundingAt) state.nextFundingAt = Math.ceil(now / (8 * H1_MS)) * 8 * H1_MS;
  while (now >= state.nextFundingAt) {
    const payment = state.position.sizeBase * price * config.funding8hRate;
    state.balance -= payment;
    state.costs.funding += payment;
    modePerformance(state).funding += payment;
    state.nextFundingAt += 8 * H1_MS;
  }
}

function observeEquity(state, price, time) {
  const current = equity(state, price);
  state.peakEquity = Math.max(state.peakEquity, current);
  state.maxDrawdownPct = Math.max(state.maxDrawdownPct, state.peakEquity > 0 ? (state.peakEquity - current) / state.peakEquity * 100 : 0);
  state.lastEquity = current;
  const notional = Math.abs(state.position.sizeBase) * price;
  const currentNotionalPct = current > 0 ? notional / current * 100 : Infinity;
  const leverage = Number(state.config?.leverage) > 0 ? Number(state.config.leverage) : 1;
  state.maxNotionalPct = Math.max(state.maxNotionalPct, currentNotionalPct);
  state.maxMarginPct = Math.max(state.maxMarginPct, currentNotionalPct / leverage);
  if (Number.isFinite(time)) {
    const day = Math.floor(time / D1_MS);
    const latest = state.dailyEquity.at(-1);
    if (latest?.day === day) latest.equity = current;
    else state.dailyEquity.push({ day, equity: current });
  }
}

function equity(state, price) {
  return state.balance + state.position.sizeBase * (price - state.position.entryPrice);
}

function createState(config, strategy) {
  return {
    strategy,
    initialized: false,
    startedAt: null,
    balance: config.startBalance,
    lastEquity: config.startBalance,
    peakEquity: config.startBalance,
    maxDrawdownPct: 0,
    maxNotionalPct: 0,
    maxMarginPct: 0,
    dailyEquity: [],
    position: { sizeBase: 0, entryPrice: 0 },
    realizedTradingPnl: 0,
    costs: { fees: 0, slippage: 0, spread: 0, funding: 0 },
    volume: 0,
    orders: new Map(),
    running: false,
    runningBars: 0,
    mode: null,
    config: null,
    grid: null,
    autopilot: {},
    analyses: 0,
    alignedDecisions: 0,
    fills: 0,
    completedRungs: 0,
    gridStarts: 0,
    autoRebalances: 0,
    outOfRangeStops: 0,
    forceCloses: 0,
    lastRangeCheckAt: 0,
    lastRangeAdjustedAt: 0,
    nextFundingAt: 0,
    fundingFrom: config.tradeStartTime,
    fundingIndex: lowerBoundFunding(config.fundingRates, config.tradeStartTime),
    lostConsensusCount: 0,
    actions: {},
    transitions: {},
    gateReasons: {},
    regimes: {},
    modeStarts: {},
    startReasons: {},
    stopReasons: {},
    forceCloseReasons: {},
    guardBlocks: {},
    rebalanceReasons: {},
    parameterChanges: {},
    rangeAdmission: { enabled: false, allowed: true, reason: 'not_required' },
    rangeAdmissionReasons: {},
    modePerformance: {},
  };
}

function summarize(state, finalCandle, config) {
  const finalEquity = equity(state, finalCandle.close);
  const totalCosts = Object.values(state.costs).reduce((sum, value) => sum + value, 0);
  const totalBars = Math.max(1, Math.round((finalCandle.time - state.startedAt) / M15_MS) + 1);
  return {
    strategy: state.strategy === 'rotation'
      ? 'large-cycle rotation'
      : state.strategy === 'long' ? 'fixed adaptive long grid' : 'fixed neutral control',
    initialEquity: config.startBalance,
    finalEquity: round(finalEquity),
    pnl: round(finalEquity - config.startBalance),
    returnPct: round((finalEquity / config.startBalance - 1) * 100),
    maxDrawdownPct: round(state.maxDrawdownPct),
    sharpe: annualizedSharpe(state.dailyEquity.map((sample) => sample.equity)),
    dailyObservations: state.dailyEquity.length,
    maxNotionalPct: round(state.maxNotionalPct),
    maxMarginPct: round(state.maxMarginPct),
    grossPnlBeforeCosts: round(finalEquity - config.startBalance + totalCosts),
    executionCosts: Object.fromEntries([...Object.entries(state.costs), ['total', totalCosts]].map(([key, value]) => [key, round(value)])),
    fills: state.fills,
    completedRungs: state.completedRungs,
    volume: round(state.volume),
    timeInMarketPct: round(state.runningBars / totalBars * 100),
    gridStarts: state.gridStarts,
    autoRebalances: state.autoRebalances,
    outOfRangeStops: state.outOfRangeStops,
    forceCloses: state.forceCloses,
    analyses: state.analyses,
    alignedDecisions: state.alignedDecisions,
    actions: state.actions,
    transitions: state.transitions,
    gateReasons: state.gateReasons,
    regimes: state.regimes,
    modeStarts: state.modeStarts,
    stopReasons: state.stopReasons,
    forceCloseReasons: state.forceCloseReasons,
    guardBlocks: state.guardBlocks,
    rebalanceReasons: state.rebalanceReasons,
    parameterChanges: state.parameterChanges,
    rangeAdmissionReasons: state.rangeAdmissionReasons,
    modePerformance: Object.fromEntries(Object.entries(state.modePerformance).map(([mode, values]) => [mode, {
      realizedPnl: round(values.realizedPnl),
      executionCosts: round(values.costs + values.funding),
      netRealizedPnl: round(values.realizedPnl - values.costs - values.funding),
      fills: values.fills,
      volume: round(values.volume),
    }])),
  };
}

async function loadCoinbaseCandles(config) {
  const endSeconds = Math.floor(Date.now() / M15_MS) * (M15_MS / 1000);
  const warmupDays = 90;
  const startSeconds = endSeconds - (config.days + warmupDays) * 24 * 3600;
  config.tradeStartTime = (endSeconds - config.days * 24 * 3600) * 1000;
  config.tradeEndTime = endSeconds * 1000;
  const cacheFile = process.env.BACKTEST_CACHE_FILE || CACHE_FILE;
  const cached = await readCandleCache(cacheFile);
  const unique = new Map(cached.map((candle) => [candle.time, candle]));
  const before = [...unique.values()].sort((a, b) => a.time - b.time);
  const earliest = before[0]?.time ?? Infinity;
  const latest = before.at(-1)?.time ?? -Infinity;
  const requestedStartMs = startSeconds * 1000;
  const requestedEndMs = endSeconds * 1000;
  const cacheHit = earliest <= requestedStartMs && latest + M15_MS >= requestedEndMs;
  const ranges = [];
  if (!before.length) ranges.push([startSeconds, endSeconds]);
  else {
    if (requestedStartMs < earliest) ranges.push([startSeconds, Math.min(endSeconds, earliest / 1000)]);
    if (latest + M15_MS < requestedEndMs) ranges.push([Math.max(startSeconds, (latest + M15_MS) / 1000), endSeconds]);
  }

  const chunkSeconds = 300 * (M15_MS / 1000);
  let downloadedChunks = 0;
  for (const [rangeStart, rangeEnd] of ranges) {
    for (let cursor = rangeStart; cursor < rangeEnd; cursor += chunkSeconds) {
      const chunkEnd = Math.min(cursor + chunkSeconds, rangeEnd);
      const rows = await fetchCoinbaseChunk(cursor, chunkEnd);
      for (const [time, low, high, open, close, volume] of rows) {
        const candle = {
          time: Number(time) * 1000,
          low: Number(low),
          high: Number(high),
          open: Number(open),
          close: Number(close),
          volume: Number(volume),
        };
        unique.set(candle.time, candle);
      }
      downloadedChunks++;
      if (downloadedChunks % 25 === 0) console.error(`[AI 回测] 已下载 ${downloadedChunks} 个 K 线分片...`);
      await sleep(140);
    }
  }
  const all = [...unique.values()].sort((a, b) => a.time - b.time);
  if (downloadedChunks) await writeCandleCache(cacheFile, all);
  const candles = all
    .filter((candle) => candle.time >= requestedStartMs && candle.time + M15_MS <= requestedEndMs)
    .sort((a, b) => a.time - b.time);
  return {
    candles,
    cache: {
      file: path.relative(ROOT, cacheFile),
      hit: cacheHit,
      downloadedChunks,
      storedCandles: all.length,
    },
  };
}

async function loadFundingHistory(config, { from, to }) {
  if (config.fundingMode === 'fixed') {
    return {
      mode: 'fixed',
      rates: null,
      coverage: { rate: config.funding8hRate, intervalHours: 8 },
    };
  }
  const file = process.env.BACKTEST_FUNDING_CACHE_FILE || FUNDING_CACHE_FILE;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read BTC funding cache at ${file}. Run npm run fetch:funding first: ${error.message}`);
  }
  const available = normalizeFundingRates(parsed?.rates);
  const byTime = new Map(available.map((row) => [row.time, row]));
  const expectedTimes = [];
  for (let time = (Math.floor(from / (8 * H1_MS)) + 1) * 8 * H1_MS; time <= to; time += 8 * H1_MS) {
    expectedTimes.push(time);
  }
  const rates = expectedTimes.map((time) => byTime.get(time)).filter(Boolean);
  const expected = Math.max(1, expectedTimes.length);
  const coveragePct = rates.length / expected * 100;
  if (coveragePct < config.minFundingCoveragePct) {
    throw new Error(`Historical funding coverage ${round(coveragePct)}% is below ${config.minFundingCoveragePct}%. Refresh it with npm run fetch:funding.`);
  }
  if (!rates.length) throw new Error('BTC funding cache contains no rates in the requested backtest period.');
  return {
    mode: 'historical',
    rates,
    coverage: {
      file: path.relative(ROOT, file),
      rows: rates.length,
      expectedRows: expected,
      missingRows: expected - rates.length,
      coveragePct: round(Math.min(100, coveragePct)),
      from: new Date(rates[0].time).toISOString(),
      to: new Date(rates.at(-1).time).toISOString(),
      sources: parsed.sources || [],
      updatedAt: parsed.updatedAt || null,
    },
  };
}

async function fetchCoinbaseChunk(startSeconds, endSeconds) {
  const url = `${API}?granularity=900&start=${startSeconds}&end=${endSeconds}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'deepBTC-ai-rotation-backtest/2.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) throw new Error(`Coinbase HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(8_000, 500 * 2 ** attempt));
    } catch (error) {
      if (attempt === 5 || /Coinbase HTTP 4\d\d/.test(error.message)) throw error;
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
    }
  }
  throw new Error('Coinbase K 线下载失败。');
}

async function readCandleCache(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed?.granularity !== 900 || !Array.isArray(parsed.candles)) return [];
    return parsed.candles.map(([time, low, high, open, close, volume]) => ({ time, low, high, open, close, volume }));
  } catch {
    return [];
  }
}

async function writeCandleCache(file, candles) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({
    granularity: 900,
    updatedAt: new Date().toISOString(),
    candles: candles.map((candle) => [candle.time, candle.low, candle.high, candle.open, candle.close, candle.volume]),
  });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, payload, 'utf8');
  await fs.rename(temporary, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configFromEnv() {
  return {
    days: positiveNumber(process.env.BACKTEST_DAYS, 1095),
    startBalance: positiveNumber(process.env.BACKTEST_START_BALANCE, 10_000),
    feeRate: nonNegativeNumber(process.env.BACKTEST_FEE_RATE, 0.0005),
    slippageBps: nonNegativeNumber(process.env.BACKTEST_SLIPPAGE_BPS, 2),
    spreadBps: nonNegativeNumber(process.env.BACKTEST_SPREAD_BPS, 1),
    funding8hRate: finiteNumber(process.env.BACKTEST_FUNDING_8H_RATE, 0.0001),
    fundingMode: String(process.env.BACKTEST_FUNDING_MODE || 'historical').toLowerCase() === 'fixed' ? 'fixed' : 'historical',
    minFundingCoveragePct: positiveNumber(process.env.BACKTEST_MIN_FUNDING_COVERAGE_PCT, 95),
    maxDirectionalNotionalPct: positiveNumber(process.env.BACKTEST_MAX_DIRECTIONAL_NOTIONAL_PCT, 15),
    trendGuardMinStrength: nonNegativeNumber(process.env.BACKTEST_TREND_GUARD_MIN_STRENGTH, 0.55),
    analysisIntervalMs: positiveNumber(process.env.BACKTEST_AI_ANALYSIS_MINUTES, 60) * 60_000,
    minConfidence: finiteNumber(process.env.BACKTEST_AI_MIN_CONFIDENCE, 0.8),
    confirmations: Math.max(2, Math.round(positiveNumber(process.env.BACKTEST_AI_CONFIRMATIONS, 12))),
    cooldownMs: positiveNumber(process.env.BACKTEST_AI_COOLDOWN_MINUTES, 2880) * 60_000,
    minTimeframeVotes: Math.min(3, Math.max(2, Math.round(positiveNumber(process.env.BACKTEST_AI_MIN_TIMEFRAME_VOTES, 3)))),
    neutralAsPause: envBoolean(process.env.BACKTEST_AI_NEUTRAL_AS_PAUSE, false),
    cycleModel: process.env.BACKTEST_AI_CYCLE_MODEL === 'legacy' ? 'legacy' : 'large_cycle',
    pauseAtrPct: positiveNumber(process.env.BACKTEST_AI_PAUSE_ATR_PCT, 3),
    rebalanceIntervalMs: positiveNumber(process.env.BACKTEST_REBALANCE_INTERVAL_MINUTES, 60) * 60_000,
    rebalanceCooldownMs: positiveNumber(process.env.BACKTEST_REBALANCE_COOLDOWN_MINUTES, 240) * 60_000,
    minRangeChangePct: positiveNumber(process.env.BACKTEST_MIN_RANGE_CHANGE_PCT, 10),
    minGridCountChangePct: positiveNumber(process.env.BACKTEST_MIN_GRID_COUNT_CHANGE_PCT, 20),
    minSizeChangePct: positiveNumber(process.env.BACKTEST_MIN_SIZE_CHANGE_PCT, 20),
    gridPolicy: {
      spacingAtrMultiplier: positiveNumber(process.env.BACKTEST_SPACING_ATR_MULTIPLIER, 1),
      minSpacingFraction: positiveNumber(process.env.BACKTEST_MIN_SPACING_FRACTION, 0.006),
      costCoverageMultiple: positiveNumber(process.env.BACKTEST_COST_COVERAGE_MULTIPLE, 3),
      marginPctByMode: { neutral: 4, long: 8, short: 4 },
    },
    tradeStartTime: 0,
    tradeEndTime: 0,
  };
}

function costPolicy(config) {
  return {
    feeRate: config.feeRate,
    slippageBps: config.slippageBps,
    spreadBps: config.spreadBps,
    funding8hRate: config.funding8hRate,
  };
}

function increment(record, key) {
  const label = String(key || 'unknown');
  record[label] = (record[label] || 0) + 1;
}

function modePerformance(state) {
  const key = state.mode || 'paused';
  if (!state.modePerformance[key]) {
    state.modePerformance[key] = { realizedPnl: 0, costs: 0, funding: 0, fills: 0, volume: 0 };
  }
  return state.modePerformance[key];
}

export function annualizedSharpe(equityValues = []) {
  const returns = [];
  for (let index = 1; index < equityValues.length; index++) {
    const previous = Number(equityValues[index - 1]);
    const current = Number(equityValues[index]);
    if (previous > 0 && Number.isFinite(current)) returns.push(current / previous - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const deviation = Math.sqrt(Math.max(0, variance));
  return deviation > 0 ? round(mean / deviation * Math.sqrt(365), 4) : null;
}

function normalizeFundingRates(rows) {
  const interval = 8 * H1_MS;
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => {
    const values = Array.isArray(row) ? row : [row?.time, row?.rate, row?.source];
    return {
      time: Math.round(Number(values[0]) / interval) * interval,
      rate: Number(values[1]),
      source: values[2] || null,
    };
  }).filter((row) => Number.isFinite(row.time) && row.time > 0
    && Number.isFinite(row.rate) && Math.abs(row.rate) <= 0.1);
  return [...new Map(normalized.map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time);
}

function lowerBoundFunding(rows, time) {
  if (!Array.isArray(rows)) return 0;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function envBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}
