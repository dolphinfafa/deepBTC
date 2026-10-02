(function exposeGridFormState(root) {
  const validModes = new Set(['neutral', 'long', 'short']);

  function resolveSuggestedMode({ manualMode, currentMode, suggestedMode }) {
    if (manualMode && validModes.has(currentMode)) return currentMode;
    return validModes.has(suggestedMode) ? suggestedMode : 'neutral';
  }

  function canStartStrategy({
    consoleMode,
    busy = false,
    runtimeBlocked = false,
    running = false,
    backendReady = false,
    profileAvailable = false,
    previewReady = false,
  } = {}) {
    if (busy || runtimeBlocked || running || !backendReady || !profileAvailable) return false;
    return consoleMode === 'paper' || previewReady === true;
  }

  root.GridPilotForm = Object.freeze({ resolveSuggestedMode, canStartStrategy });
})(globalThis);
