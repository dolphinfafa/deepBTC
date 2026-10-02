import { analyzeTrend } from '../trend.js';
export { aggregateCandles, completedCandleWindow } from '../candles.js';
import { completedCandleWindow } from '../candles.js';

const TARGET_BY_TREND = Object.freeze({ up: 'long', down: 'short', range: 'neutral' });
const REGIME_BY_TREND = Object.freeze({ up: '上涨', down: '下跌', range: '震荡' });

export function analyzeHistoricalFrames(series, at, limit = 200) {
  const frames = {};
  for (const [label, candles] of Object.entries(series || {})) {
    const completed = completedCandleWindow(candles || [], at, limit);
    if (completed.length >= 51) frames[label] = analyzeTrend(completed);
  }
  return frames;
}

/**
 * Deterministic stand-in for the language-model classification used in PAPER.
 * It is intentionally simple and auditable: two agreeing timeframes are enough
 * for a 0.80 confidence decision; three agreeing frames produce 0.95.
 */
export function buildHistoricalAiAnalysis(frames, { pauseAtrPct = 3 } = {}) {
  const available = Object.entries(frames || {})
    .filter(([, frame]) => ['up', 'down', 'range'].includes(frame?.trend));
  const publicFrames = Object.fromEntries(available);
  const h1AtrPct = Number(frames?.h1?.atrPct);
  if (Number.isFinite(h1AtrPct) && h1AtrPct >= Number(pauseAtrPct)) {
    return {
      regime: '剧烈波动', suitable: false, mode: 'neutral', confidence: 0.9,
      frames: publicFrames,
      proxyReason: `1h ATR ${round(h1AtrPct, 3)}% 达到暂停阈值 ${Number(pauseAtrPct)}%。`,
      proxy: true,
    };
  }

  const votes = { up: 0, down: 0, range: 0 };
  for (const [, frame] of available) votes[frame.trend]++;
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [winner, winnerVotes] = ranked[0] || ['range', 0];
  const tied = ranked.length > 1 && ranked[1][1] === winnerVotes;
  const consensus = available.length ? winnerVotes / available.length : 0;
  const confidence = tied || winnerVotes < 2 ? 0.5 : Math.min(0.95, 0.5 + consensus * 0.45);

  return {
    regime: REGIME_BY_TREND[winner],
    suitable: available.length >= 2,
    mode: TARGET_BY_TREND[winner],
    confidence: round(confidence, 3),
    frames: publicFrames,
    proxyReason: winnerVotes >= 2 && !tied
      ? `${winnerVotes}/${available.length} 个周期判断为${REGIME_BY_TREND[winner]}。`
      : '多周期没有形成至少两票的一致方向。',
    proxy: true,
  };
}

function validCandle(candle) {
  return Number.isFinite(Number(candle?.time))
    && Number.isFinite(Number(candle?.open))
    && Number.isFinite(Number(candle?.high))
    && Number.isFinite(Number(candle?.low))
    && Number.isFinite(Number(candle?.close));
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}
