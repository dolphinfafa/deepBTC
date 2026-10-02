const TARGETS = new Set(['neutral', 'long', 'short']);

export const AI_AUTOPILOT_DEFAULTS = Object.freeze({
  enabled: false,
  minConfidence: 0.8,
  confirmations: 12,
  cooldownMinutes: 2880,
  minTimeframeVotes: 3,
  neutralAsPause: false,
});

export function aiAutopilotAllowedInMode(mode) {
  return mode === 'paper';
}

export function normalizeAiAutopilotConfig(input = {}) {
  return {
    enabled: input.autopilotEnabled === true || input.enabled === true,
    minConfidence: bounded(input.autopilotMinConfidence ?? input.minConfidence, 0.5, 0.95, AI_AUTOPILOT_DEFAULTS.minConfidence),
    confirmations: Math.round(bounded(input.autopilotConfirmations ?? input.confirmations, 2, 24, AI_AUTOPILOT_DEFAULTS.confirmations)),
    cooldownMinutes: Math.round(bounded(input.autopilotCooldownMinutes ?? input.cooldownMinutes, 60, 10080, AI_AUTOPILOT_DEFAULTS.cooldownMinutes)),
    minTimeframeVotes: Math.round(bounded(input.autopilotMinTimeframeVotes ?? input.minTimeframeVotes, 2, 3, AI_AUTOPILOT_DEFAULTS.minTimeframeVotes)),
    neutralAsPause: input.autopilotNeutralAsPause === undefined && input.neutralAsPause === undefined
      ? AI_AUTOPILOT_DEFAULTS.neutralAsPause
      : input.autopilotNeutralAsPause === true || input.neutralAsPause === true,
  };
}

export function evaluateAiAutopilot({ analysis = {}, state = {}, config = {}, now = Date.now() } = {}) {
  const policy = normalizeAiAutopilotConfig(config);
  const base = {
    strategyId: typeof state.strategyId === 'string' ? state.strategyId : null,
    candidate: state.candidate || null,
    candidateCount: Number(state.candidateCount) || 0,
    lastActionAt: Number(state.lastActionAt) || 0,
    lastAction: state.lastAction || null,
    lastTarget: state.lastTarget || null,
    lastSignalTime: Number(state.lastSignalTime) || 0,
    historyBootstrapPending: state.historyBootstrapPending === true,
    historyEvaluatedAt: Number(state.historyEvaluatedAt) || 0,
    historySignalsEvaluated: Number(state.historySignalsEvaluated) || 0,
  };

  if (!policy.enabled) return result({ ...base, candidate: null, candidateCount: 0 }, false, 'disabled');

  const signalTime = Number(analysis.signalTime);
  if (Number.isFinite(signalTime) && signalTime > 0 && base.lastSignalTime >= signalTime) {
    return result({ ...base, lastAnalysisAt: now }, false, 'duplicate_signal');
  }

  const confidence = Number(analysis.confidence);
  const suitable = analysis.suitable;
  const mode = String(analysis.mode || '');
  const target = suitable === false || (policy.neutralAsPause && suitable === true && mode === 'neutral')
    ? 'paused'
    : suitable === true && TARGETS.has(mode) ? mode : null;
  const observed = {
    ...base,
    lastAnalysisAt: now,
    lastRegime: String(analysis.regime || ''),
    lastConfidence: Number.isFinite(confidence) ? confidence : null,
    lastSuggestedMode: TARGETS.has(mode) ? mode : null,
    lastSuitable: typeof suitable === 'boolean' ? suitable : null,
    lastSignalTime: Number.isFinite(signalTime) && signalTime > 0 ? signalTime : base.lastSignalTime,
  };

  if (!target) return result({ ...observed, candidate: null, candidateCount: 0 }, false, 'invalid_decision');
  if (!(confidence >= policy.minConfidence && confidence <= 1)) {
    return result({ ...observed, candidate: null, candidateCount: 0 }, false, 'low_confidence', target);
  }

  const support = timeframeSupport(analysis.frames, target, policy.minTimeframeVotes);
  if (!support.ok) {
    return result({ ...observed, candidate: null, candidateCount: 0 }, false, support.reason, target, support);
  }

  const candidateCount = observed.candidate === target ? Math.min(policy.confirmations, observed.candidateCount + 1) : 1;
  const next = { ...observed, candidate: target, candidateCount };
  if (candidateCount < policy.confirmations) return result(next, false, 'awaiting_confirmation', target, support);

  const cooldownUntil = next.lastActionAt ? next.lastActionAt + policy.cooldownMinutes * 60_000 : 0;
  if (cooldownUntil > now) return result(next, false, 'cooldown', target, support, cooldownUntil);
  return result(next, true, 'ready', target, support, cooldownUntil || null);
}

export function replayAiAutopilotHistory({ analyses = [], state = {}, config = {} } = {}) {
  let current = { ...state };
  let gate = result(current, false, 'no_history');
  let processed = 0;
  for (const analysis of analyses) {
    gate = evaluateAiAutopilot({
      analysis,
      state: current,
      config,
      now: Number(analysis?.signalTime) || Date.now(),
    });
    current = gate.state;
    processed++;
  }
  return { ...gate, state: current, processed };
}

export function completeAiAutopilotAction(state = {}, { action, target, now = Date.now() } = {}) {
  return {
    ...state,
    candidate: null,
    candidateCount: 0,
    lastActionAt: now,
    lastAction: action || null,
    lastTarget: target || null,
  };
}

function timeframeSupport(frames, target, minimumVotes) {
  if (target === 'paused') return { ok: true, reason: 'risk_reducing_pause', votes: {} };
  const trends = Object.values(frames || {}).map((frame) => frame?.trend).filter((trend) => ['up', 'down', 'range'].includes(trend));
  const votes = {
    up: trends.filter((trend) => trend === 'up').length,
    down: trends.filter((trend) => trend === 'down').length,
    range: trends.filter((trend) => trend === 'range').length,
  };
  if (trends.length < minimumVotes) return { ok: false, reason: 'insufficient_timeframes', votes, requiredVotes: minimumVotes };
  const expected = target === 'long' ? 'up' : target === 'short' ? 'down' : 'range';
  return votes[expected] >= minimumVotes
    ? { ok: true, reason: 'timeframes_confirmed', votes, requiredVotes: minimumVotes }
    : { ok: false, reason: 'timeframes_disagree', votes, requiredVotes: minimumVotes };
}

function result(state, ready, reason, target = null, support = null, cooldownUntil = null) {
  return { state, ready, reason, target, support, cooldownUntil };
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
