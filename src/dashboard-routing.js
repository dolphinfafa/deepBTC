export function resolveDashboardRoute(requestPath = '/') {
  let decoded;
  try { decoded = decodeURIComponent(String(requestPath || '/')); }
  catch { return { matched: false, view: null }; }

  const normalized = ('/' + decoded.split('?')[0].replace(/^\/+|\/+$/g, '')).toLowerCase();
  if (normalized === '/' || normalized === '/index.html') return { matched: true, view: null };
  if (normalized === '/paper' || normalized === '/paper.html') return { matched: true, view: 'paper' };
  if (normalized === '/live' || normalized === '/live.html') return { matched: true, view: 'live' };
  return { matched: false, view: null };
}

export function projectDashboardState(state = {}, runtimeMode = 'paper', requestedMode = null) {
  const runtime = runtimeMode === 'live' ? 'live' : 'paper';
  const requested = requestedMode === 'live' || requestedMode === 'paper' ? requestedMode : runtime;

  if (requested === runtime) {
    return { ...state, requestedMode: requested, runtimeMode: runtime, runtimeAvailable: true };
  }

  const label = requested === 'live' ? '实盘' : '模拟盘';
  return {
    ...state,
    mode: requested,
    requestedMode: requested,
    runtimeMode: runtime,
    runtimeAvailable: false,
    recovery: false,
    running: false,
    config: null,
    grid: null,
    outOfRange: false,
    risk: null,
    stats: { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 },
    openOrders: 0,
    exchangeOpenOrders: 0,
    openByLevel: {},
    health: { status: 'idle', reason: `${label}服务未启动`, dataSource: state.health?.dataSource ?? null },
    position: null,
    realizedPnl: null,
    unrealizedPnl: null,
    totalPnl: null,
    returnPct: null,
    equity: null,
    balance: null,
    volume: null,
    fills: [],
    alerts: [],
    activity: [],
    strategyGuard: null,
    executionCosts: null,
    measurement: null,
    measurementHistory: [],
    liveRisk: null,
    dailyPnl: null,
    preflight: null,
    paperReadiness: null,
  };
}
