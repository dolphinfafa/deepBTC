export const STRATEGY_PROFILES = Object.freeze([
  Object.freeze({
    id: 'range_balanced',
    name: '区间平衡',
    mode: 'neutral',
    description: '仅在大周期宽幅震荡时运行，按执行成本设置格距，并动态降低加重单边库存的订单。',
  }),
  Object.freeze({
    id: 'trend_long',
    name: '顺势多头',
    mode: 'long',
    paperDescription: '适合已确认的上涨趋势；PAPER 使用 6 倍仓位测试，只建立多头网格并使用只减仓卖单退出。',
    paperGridPolicy: Object.freeze({
      sizeMultiplierByMode: Object.freeze({ long: 6 }),
      maxTargetMarginPct: 55,
      maxDirectionalNotionalPctByMode: Object.freeze({ long: 90 }),
    }),
    paperRiskPolicy: Object.freeze({ maxMarginPct: 55 }),
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
    name: '大周期自动轮动',
    mode: 'dynamic',
    paperOnly: true,
    requiresAi: false,
    description: '用 1D、4H、1H 已完成 K 线识别上涨、下跌或震荡大周期，并运行对应网格。',
  }),
  Object.freeze({
    id: 'ai_rotation_v3',
    name: 'V3 保持型轮动（试验）',
    mode: 'dynamic',
    paperOnly: true,
    experimental: true,
    requiresAi: false,
    executionPolicy: Object.freeze({
      shortMinStrength: 0.4,
      neutralMinAtrPct: 0.7,
      blockedAction: 'hold',
    }),
    gridPolicy: Object.freeze({
      minSpacingFractionByMode: Object.freeze({ neutral: 0.008 }),
      marginPctByMode: Object.freeze({ neutral: 4, long: 8, short: 2 }),
    }),
    description: 'PAPER 前向试验：新方向未通过门槛时保持现有策略，并过滤弱下跌和低波动中性网格；历史回测尚未达到晋级标准。',
  }),
  Object.freeze({
    id: 'sentiment_regime_v1',
    name: 'Grok 情绪增强轮动（试验）',
    mode: 'dynamic',
    paperOnly: true,
    experimental: true,
    requiresAi: true,
    requiredProvider: 'xai',
    requiresLiveSentiment: true,
    executionPolicy: Object.freeze({
      shortMinStrength: 0.4,
      neutralMinAtrPct: 0.7,
      blockedAction: 'hold',
    }),
    gridPolicy: Object.freeze({
      minSpacingFractionByMode: Object.freeze({ neutral: 0.008 }),
      marginPctByMode: Object.freeze({ neutral: 4, long: 8, short: 2 }),
    }),
    description: 'PAPER 前向试验：1D/4H/1H 确定大周期，Grok 每 15 分钟读取 X 与网页情绪；至少 3 个独立来源并连续确认 2 次才执行，情绪不能单独反手。',
  }),
  Object.freeze({
    id: 'turtle_s2_long',
    name: '海龟突破做多',
    mode: 'long',
    engine: 'turtle',
    paperOnly: true,
    requiresAi: false,
    description: '20 日突破、10 日退出、20 日 ATR，单单位风险 1.5%，每 0.5N 加仓，最多 4 个单位。',
  }),
]);

export function listStrategyProfiles({ runtimeMode = 'paper', aiConfigured = false, aiProvider = null } = {}) {
  return STRATEGY_PROFILES.map((profile) => {
    const modeAllowed = !profile.paperOnly || runtimeMode === 'paper';
    const aiAllowed = !profile.requiresAi || aiConfigured;
    const providerAllowed = !profile.requiredProvider || profile.requiredProvider === aiProvider;
    const available = modeAllowed && aiAllowed && providerAllowed;
    let unavailableReason = null;
    if (!modeAllowed) unavailableReason = profile.engine === 'turtle'
      ? '海龟突破策略目前仅允许 PAPER 模拟盘。'
      : '大周期自动轮动仅允许 PAPER 模拟盘。';
    else if (!aiAllowed) unavailableReason = profile.requiredProvider === 'xai'
      ? '请先在 AI 助手中配置并测试 xAI API Key。'
      : '请先在 AI 助手中配置并测试 API Key。';
    else if (!providerAllowed) unavailableReason = `该策略要求 AI Provider 为 ${profile.requiredProvider}。`;
    const paperOverrides = runtimeMode === 'paper';
    const gridPolicy = mergeGridPolicy(profile.gridPolicy, paperOverrides ? profile.paperGridPolicy : null);
    const riskPolicy = paperOverrides && profile.paperRiskPolicy
      ? { ...profile.paperRiskPolicy }
      : (profile.riskPolicy ? { ...profile.riskPolicy } : undefined);
    return {
      ...profile,
      description: paperOverrides && profile.paperDescription ? profile.paperDescription : profile.description,
      gridPolicy,
      riskPolicy,
      available,
      unavailableReason,
    };
  });
}

export function resolveStrategyProfile(strategyId, options = {}) {
  const id = String(strategyId || '').trim();
  const profile = listStrategyProfiles(options).find((item) => item.id === id);
  if (!profile) throw new Error('策略不存在，请刷新策略列表后重试。');
  if (!profile.available) throw new Error(profile.unavailableReason || '当前不能使用该策略。');
  return profile;
}

export function buildStrategyProfileParams({ strategyId, suggestion, marketId, runtimeMode = 'paper', aiConfigured = false, aiProvider = null }) {
  const profile = resolveStrategyProfile(strategyId, { runtimeMode, aiConfigured, aiProvider });
  if (!suggestion || !(Number(suggestion.lower) > 0) || !(Number(suggestion.upper) > Number(suggestion.lower))) {
    throw new Error('自动策略参数无效，请重新读取行情。');
  }
  const mode = profile.mode === 'dynamic' ? 'neutral' : profile.mode;
  const optimizedNeutral = mode === 'neutral';
  return {
    marketId: Number(marketId),
    strategyId: profile.id,
    mode,
    lower: Number(suggestion.lower),
    upper: Number(suggestion.upper),
    gridCount: Number(suggestion.gridCount),
    sizeBase: Number(suggestion.sizeBase),
    leverage: Number(suggestion.leverage),
    outOfRangeAction: suggestion.outOfRangeAction === 'recover' ? 'recover' : 'close',
    maxDirectionalNotionalPct: Number(suggestion.maxDirectionalNotionalPct),
    trendGuardEnabled: suggestion.trendGuardEnabled !== false,
    neutralRangeAdmissionEnabled: optimizedNeutral && suggestion.neutralRangeAdmissionEnabled === true,
    rangeAdmissionMinAtrPct: Number(suggestion.rangeAdmissionMinAtrPct),
    inventorySkewEnabled: optimizedNeutral && suggestion.inventorySkewEnabled === true,
    inventorySkewStartPctOfCap: Number(suggestion.inventorySkewStartPctOfCap),
    inventorySkewMinScale: Number(suggestion.inventorySkewMinScale),
    minRoundTripCostMultiple: Number(suggestion.minRoundTripCostMultiple),
  };
}

function mergeGridPolicy(base, override) {
  if (!base && !override) return undefined;
  const merged = { ...(base || {}), ...(override || {}) };
  for (const key of ['marginPctByMode', 'minSpacingFractionByMode', 'sizeMultiplierByMode', 'maxDirectionalNotionalPctByMode']) {
    if (base?.[key] || override?.[key]) merged[key] = { ...(base?.[key] || {}), ...(override?.[key] || {}) };
  }
  return merged;
}
