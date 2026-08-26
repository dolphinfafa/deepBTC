export const STRATEGY_PROFILES = Object.freeze([
  Object.freeze({
    id: 'range_balanced',
    name: '区间平衡',
    mode: 'neutral',
    description: '适合震荡行情，围绕现价同时布置买卖网格，并启用趋势与方向敞口保护。',
  }),
  Object.freeze({
    id: 'trend_long',
    name: '顺势多头',
    mode: 'long',
    description: '适合已确认的上涨趋势，只建立多头网格并使用只减仓卖单退出。',
  }),
  Object.freeze({
    id: 'trend_short',
    name: '顺势空头',
    mode: 'short',
    description: '适合已确认的下跌趋势，只建立空头网格并使用只减仓买单退出。',
  }),
  Object.freeze({
    id: 'ai_rotation',
    name: 'AI 趋势轮动',
    mode: 'dynamic',
    paperOnly: true,
    requiresAi: true,
    description: '由 AI 定时判断震荡、上涨、下跌或暂停，经过多周期确认后自动切换策略。',
  }),
]);

export function listStrategyProfiles({ runtimeMode = 'paper', aiConfigured = false } = {}) {
  return STRATEGY_PROFILES.map((profile) => {
    const modeAllowed = !profile.paperOnly || runtimeMode === 'paper';
    const aiAllowed = !profile.requiresAi || aiConfigured;
    const available = modeAllowed && aiAllowed;
    let unavailableReason = null;
    if (!modeAllowed) unavailableReason = 'AI 趋势轮动仅允许 PAPER 模拟盘。';
    else if (!aiAllowed) unavailableReason = '请先在 AI 助手中配置并测试 API Key。';
    return { ...profile, available, unavailableReason };
  });
}

export function resolveStrategyProfile(strategyId, options = {}) {
  const id = String(strategyId || '').trim();
  const profile = listStrategyProfiles(options).find((item) => item.id === id);
  if (!profile) throw new Error('策略不存在，请刷新策略列表后重试。');
  if (!profile.available) throw new Error(profile.unavailableReason || '当前不能使用该策略。');
  return profile;
}

export function buildStrategyProfileParams({ strategyId, suggestion, marketId, runtimeMode = 'paper', aiConfigured = false }) {
  const profile = resolveStrategyProfile(strategyId, { runtimeMode, aiConfigured });
  if (!suggestion || !(Number(suggestion.lower) > 0) || !(Number(suggestion.upper) > Number(suggestion.lower))) {
    throw new Error('自动策略参数无效，请重新读取行情。');
  }
  return {
    marketId: Number(marketId),
    strategyId: profile.id,
    mode: profile.mode === 'dynamic' ? 'neutral' : profile.mode,
    lower: Number(suggestion.lower),
    upper: Number(suggestion.upper),
    gridCount: Number(suggestion.gridCount),
    sizeBase: Number(suggestion.sizeBase),
    leverage: Number(suggestion.leverage),
    outOfRangeAction: suggestion.outOfRangeAction === 'recover' ? 'recover' : 'close',
    maxDirectionalNotionalPct: Number(suggestion.maxDirectionalNotionalPct),
    trendGuardEnabled: suggestion.trendGuardEnabled !== false,
  };
}
