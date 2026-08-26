const TARGETS = new Set(['neutral', 'long', 'short']);

export const AI_AUTOPILOT_DEFAULTS = Object.freeze({
  enabled: false,
  minConfidence: 0.75,
  confirmations: 2,
  cooldownMinutes: 240,
});

export function aiAutopilotAllowedInMode(mode) {
  return mode === 'paper';
}

export function normalizeAiAutopilotConfig(input = {}) {
  return {
    enabled: input.autopilotEnabled === true || input.enabled === true,
    minConfidence: bounded(input.autopilotMinConfidence ?? input.minConfidence, 0.5, 0.95, AI_AUTOPILOT_DEFAULTS.minConfidence),
    confirmations: Math.round(bounded(input.autopilotConfirmations ?? input.confirmations, 2, 6, AI_AUTOPILOT_DEFAULTS.confirmations)),
    cooldownMinutes: Math.round(bounded(input.autopilotCooldownMinutes ?? input.cooldownMinutes, 60, 1440, AI_AUTOPILOT_DEFAULTS.cooldownMinutes)),
  };
}

export function evaluateAiAutopilot({ analysis = {}, state = {}, config = {}, now = Date.now() } = {}) {
  const policy = normalizeAiAutopilotConfig(config);
  const base = {
    candidate: state.candidate || null,
    candidateCount: Number(state.candidateCount) || 0,
    lastActionAt: Number(state.lastActionAt) || 0,
    lastAction: state.lastAction || null,
    lastTarget: state.lastTarget || null,
  };

  if (!policy.enabled) return result({ ...base, candidate: null, candidateCount: 0 }, false, 'disabled');

  const confidence = Number(analysis.confidence);
  const suitable = analysis.suitable;
  const mode = String(analysis.mode || '');
  const target = suitable === false ? 'paused' : suitable === true && TARGETS.has(mode) ? mode : null;
  const observed = {
    ...base,
    lastAnalysisAt: now,
    lastRegime: String(analysis.regime || ''),
    lastConfidence: Number.isFinite(confidence) ? confidence : null,
    lastSuggestedMode: TARGETS.has(mode) ? mode : null,
    lastSuitable: typeof suitable === 'boolean' ? suitable : null,
  };

  if (!target) return result({ ...observed, candidate: null, candidateCount: 0 }, false, 'invalid_decision');
  if (!(confidence >= policy.minConfidence && confidence <= 1)) {
    return result({ ...observed, candidate: null, candidateCount: 0 }, false, 'low_confidence', target);
  }

  const support = timeframeSupport(analysis.frames, target);
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

function timeframeSupport(frames, target) {
  if (target === 'paused') return { ok: true, reason: 'risk_reducing_pause', votes: {} };
  const trends = Object.values(frames || {}).map((frame) => frame?.trend).filter((trend) => ['up', 'down', 'range'].includes(trend));
  const votes = {
    up: trends.filter((trend) => trend === 'up').length,
    down: trends.filter((trend) => trend === 'down').length,
    range: trends.filter((trend) => trend === 'range').length,
  };
  if (trends.length < 2) return { ok: false, reason: 'insufficient_timeframes', votes };
  const expected = target === 'long' ? 'up' : target === 'short' ? 'down' : 'range';
  return votes[expected] >= 2
    ? { ok: true, reason: 'timeframes_confirmed', votes }
    : { ok: false, reason: 'timeframes_disagree', votes };
}

function result(state, ready, reason, target = null, support = null, cooldownUntil = null) {
  return { state, ready, reason, target, support, cooldownUntil };
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
