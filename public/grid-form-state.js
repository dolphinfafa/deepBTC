(function exposeGridFormState(root) {
  const validModes = new Set(['neutral', 'long', 'short']);

  function resolveSuggestedMode({ manualMode, currentMode, suggestedMode }) {
    if (manualMode && validModes.has(currentMode)) return currentMode;
    return validModes.has(suggestedMode) ? suggestedMode : 'neutral';
  }

  root.GridPilotForm = Object.freeze({ resolveSuggestedMode });
})(globalThis);
