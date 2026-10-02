const MODE_BY_TREND = Object.freeze({ up: 'long', down: 'short', range: 'neutral' });
const REGIME_BY_TREND = Object.freeze({ up: '上涨周期', down: '下跌周期', range: '震荡周期' });

export const LARGE_CYCLE_TIMEFRAMES = Object.freeze([
  Object.freeze({ id: 'd1', seconds: 86400, label: '1天' }),
  Object.freeze({ id: 'h4', seconds: 14400, label: '4小时' }),
  Object.freeze({ id: 'h1', seconds: 3600, label: '1小时' }),
]);

/**
 * Produce the deterministic decision used by both PAPER and historical replay.
 * 1D and 4H define the large cycle; 1H must confirm before the candidate can
 * enter the consecutive-confirmation state machine. Disagreement means hold.
 */
export function buildLargeCycleAnalysis(frames = {}, { pauseAtrPct = 3, allowRangeConfirmation = false } = {}) {
  const normalized = normalizeLargeCycleFrames(frames);
  const missing = LARGE_CYCLE_TIMEFRAMES.map((frame) => frame.id).filter((id) => !validTrend(normalized[id]?.trend));
  if (missing.length) {
    return holdDecision(normalized, '周期数据不足', `缺少 ${missing.join('/')} 已完成 K 线，本轮保持当前策略。`);
  }

  const h1AtrPct = Number(normalized.h1.atrPct);
  if (Number.isFinite(h1AtrPct) && h1AtrPct >= Number(pauseAtrPct)) {
    return {
      regime: '剧烈波动', suitable: false, mode: 'neutral', confidence: 0.95,
      frames: normalized,
      reasoning: `1H ATR ${round(h1AtrPct, 3)}% 达到安全暂停阈值 ${Number(pauseAtrPct)}%。`,
      caution: '剧烈波动时优先撤单平仓，暂停新网格。',
      decisionSource: 'large_cycle_rules',
    };
  }

  const primary = normalized.d1.trend;
  if (normalized.h4.trend !== primary) {
    return holdDecision(normalized, '周期过渡', '1D 与 4H 周期方向不一致，本轮保持当前策略。');
  }
  const rangeConfirmsDirection = allowRangeConfirmation && primary !== 'range' && normalized.h1.trend === 'range';
  if (normalized.h1.trend !== primary && !rangeConfirmsDirection) {
    return holdDecision(normalized, '等待确认', `1D/4H 已判断为${REGIME_BY_TREND[primary]}，1H 尚未确认，本轮保持当前策略。`);
  }

  return {
    regime: REGIME_BY_TREND[primary],
    suitable: true,
    mode: MODE_BY_TREND[primary],
    confidence: rangeConfirmsDirection ? 0.85 : 0.95,
    frames: normalized,
    reasoning: rangeConfirmsDirection
      ? `1D、4H 已一致确认${REGIME_BY_TREND[primary]}，1H 处于震荡且没有反向否决。`
      : `1D、4H、1H 已一致确认${REGIME_BY_TREND[primary]}。`,
    caution: '周期信号仍可能滞后，执行前必须通过仓位、保证金和遗留挂单检查。',
    decisionSource: 'large_cycle_rules',
  };
}

export function applyLargeCycleExecutionPolicy(analysis = {}, {
  shortMinStrength = 0,
  neutralMinAtrPct = 0,
  blockedAction = 'pause',
} = {}) {
  if (analysis.suitable !== true) return analysis;
  const frames = normalizeLargeCycleFrames(analysis.frames);

  if (analysis.mode === 'short' && Number(shortMinStrength) > 0) {
    const required = ['d1', 'h4'];
    const weak = required.filter((id) => !(Number(frames[id]?.strength) >= Number(shortMinStrength)));
    if (weak.length) {
      return policyBlock(analysis, '弱下跌过滤', `下跌周期的 ${weak.join('/')} 趋势强度未达到 ${Number(shortMinStrength)}，本轮不建立做空网格。`, 'weak_short', blockedAction);
    }
  }

  const h1AtrPct = Number(frames.h1?.atrPct);
  if (analysis.mode === 'neutral' && Number(neutralMinAtrPct) > 0
    && Number.isFinite(h1AtrPct) && h1AtrPct < Number(neutralMinAtrPct)) {
    return policyBlock(analysis, '低波动过滤', `1H ATR ${round(h1AtrPct, 3)}% 低于中性网格门槛 ${Number(neutralMinAtrPct)}%，预期格差不足以覆盖执行损耗。`, 'low_volatility', blockedAction);
  }

  return analysis;
}

export function normalizeLargeCycleFrames(frames = {}) {
  return {
    d1: pickFrame(frames, ['d1', '1d', '1天', '日线']),
    h4: pickFrame(frames, ['h4', '4h', '4小时']),
    h1: pickFrame(frames, ['h1', '1h', '1小时']),
  };
}

function holdDecision(frames, regime, reasoning) {
  return {
    regime,
    suitable: null,
    mode: null,
    confidence: 0,
    frames,
    reasoning,
    caution: '大周期没有完成确认，不启动、退出或切换网格。',
    decisionSource: 'large_cycle_rules',
  };
}

function policyBlock(analysis, regime, reasoning, policyReason, action) {
  if (action === 'hold') {
    return {
      ...analysis,
      regime,
      suitable: null,
      mode: null,
      confidence: 0,
      reasoning: `${reasoning} 保持当前策略，等待新的合格方向完成确认。`,
      caution: '门槛不足不触发平仓或切换；已有策略继续接受原风控与区间外止损。',
      policyReason,
      policyAction: 'hold',
    };
  }
  return {
    ...analysis,
    regime,
    suitable: false,
    mode: 'neutral',
    confidence: 0.95,
    reasoning,
    caution: '策略边际不足时保持空仓，等待下一轮大周期确认。',
    policyReason,
    policyAction: 'pause',
  };
}

function pickFrame(frames, aliases) {
  for (const alias of aliases) if (frames?.[alias]) return frames[alias];
  return null;
}

function validTrend(value) {
  return value === 'up' || value === 'down' || value === 'range';
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}
