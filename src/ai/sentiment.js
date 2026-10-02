export const SENTIMENT_STRATEGY_ID = 'sentiment_regime_v1';

export const SENTIMENT_POLICY = Object.freeze({
  intervalMinutes: 15,
  windowHours: 24,
  horizons: Object.freeze([4, 12, 24]),
  maxAgeMinutes: 30,
  minIndependentSources: 3,
  minConfidence: 0.65,
  minDirectionalScore: 0.15,
  shockConfidence: 0.8,
  confirmations: 2,
  cooldownMinutes: 360,
});

const DIRECTIONS = new Set(['bullish', 'bearish', 'mixed']);
const ATTENTION_LEVELS = new Set(['low', 'normal', 'high', 'extreme']);
const EVENT_RISKS = new Set(['none', 'positive', 'negative', 'mixed']);
const STANCES = new Set(['bullish', 'bearish', 'neutral']);

export function buildSentimentSearchPrompt({ now = Date.now(), market = 'BTC-USD' } = {}) {
  const observedAt = new Date(now).toISOString();
  const windowStart = new Date(now - SENTIMENT_POLICY.windowHours * 3_600_000).toISOString();
  return [
    `研究 ${market} 在 ${windowStart} 至 ${observedAt} 的公开市场情绪和高影响事件。`,
    '使用 X Search 和 Web Search。优先独立的一手来源、监管机构、交易所公告和有持续信誉的市场参与者。',
    '去除重复转发、搬运内容、明显机器人、无来源喊单和仅仅复述价格涨跌的帖子。不得因为价格已经上涨就判定看多。',
    '情绪只是辅助因子；请估计未来 4、12、24 小时的方向概率，不提供交易指令。',
    '只输出一个 JSON 对象，字段必须为：',
    '{"score":-1到1,"confidence":0到1,"attention":"low|normal|high|extreme","eventRisk":"none|positive|negative|mixed","highImpactEvent":true或false,"summary":"中文摘要","forecasts":[{"hours":4,"up":0到1,"down":0到1,"range":0到1},{"hours":12,"up":0到1,"down":0到1,"range":0到1},{"hours":24,"up":0到1,"down":0到1,"range":0到1}],"evidence":[{"source":"账号或站点","url":"完整链接","publishedAt":"ISO时间或空字符串","stance":"bullish|bearish|neutral","credibility":0到1,"summary":"一句话"}]}',
    'score 为去重后的净情绪，0 表示混合；confidence 必须同时反映来源数量、独立性、时效性和意见一致度。',
  ].join('\n');
}

export function buildSentimentChannelPrompt({ channel, now = Date.now(), market = 'BTC-USD' } = {}) {
  if (!['x', 'web'].includes(channel)) throw new Error('情绪搜索渠道必须是 x 或 web。');
  const observedAt = new Date(now).toISOString();
  const windowStart = new Date(now - SENTIMENT_POLICY.windowHours * 3_600_000).toISOString();
  const sourceInstruction = channel === 'x'
    ? '只使用 X Search。优先监管机构、交易所、一手记者和有持续信誉的市场参与者；去除转发、机器人和无来源喊单。'
    : '只使用 Web Search。优先监管机构、交易所公告、一手新闻和可信研究；去除聚合搬运和仅复述价格的页面。';
  return [
    `研究 ${market} 在 ${windowStart} 至 ${observedAt} 的公开信息。`,
    sourceInstruction,
    '只提取可能影响未来 4、12、24 小时方向的事实与情绪，不评分、不提供交易指令，不得因为价格已经上涨或下跌就推断情绪。',
    '用中文输出不超过 6 条相互独立的关键证据及一段总体摘要；每条写明来源、发布时间、完整 URL、偏多/偏空/中性及一句事实。只能使用搜索结果中实际存在的 URL。',
  ].join('\n');
}

export function combineSentimentSearchResults(xResult, webResult) {
  if (!xResult?.text || !webResult?.text) throw new Error('X 与网页搜索结果必须同时存在。');
  const xCitations = Array.isArray(xResult.citations) ? xResult.citations.slice(0, 10) : [];
  const webCitations = Array.isArray(webResult.citations) ? webResult.citations.slice(0, 10) : [];
  const citations = [];
  const seen = new Set();
  const longest = Math.max(xCitations.length, webCitations.length);
  for (let index = 0; index < longest; index++) {
    for (const item of [xCitations[index], webCitations[index]]) {
      const url = typeof item === 'string' ? item : item?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      citations.push(item);
    }
  }
  return {
    xText: String(xResult.text).slice(0, 8_000),
    webText: String(webResult.text).slice(0, 8_000),
    citations,
    responseIds: { x: xResult.responseId || null, web: webResult.responseId || null },
    usage: { x: xResult.usage || null, web: webResult.usage || null },
    models: [...new Set([xResult.model, webResult.model].filter(Boolean))],
  };
}

export function buildSentimentMergePrompt({ now = Date.now(), market = 'BTC-USD', searchResults } = {}) {
  if (!searchResults?.xText || !searchResults?.webText) throw new Error('缺少可合并的 X 或网页搜索摘要。');
  return [
    `现在是 ${new Date(now).toISOString()}，请合并 ${market} 的两份独立搜索摘要。`,
    '交叉核对重复消息，不按证据条数机械投票；一手重大事件优先于普通观点。最终 evidence 只能使用允许引用中的 URL。',
    `允许引用：${JSON.stringify(searchResults.citations || [])}`,
    `X Search 摘要：${searchResults.xText}`,
    `Web Search 摘要：${searchResults.webText}`,
    '估计未来 4、12、24 小时的方向概率。confidence 必须反映来源独立性、时效性、两渠道一致度和冲突程度。',
    '只输出一个 JSON 对象，字段必须为：',
    sentimentReportSchema(),
  ].join('\n');
}

export function normalizeSentimentReport(input, {
  now = Date.now(),
  citations = [],
  model = null,
  windowHours = SENTIMENT_POLICY.windowHours,
} = {}) {
  if (!input || typeof input !== 'object') throw new Error('Grok 情绪结果不是有效 JSON。');
  const score = finite(input.score);
  const confidence = finite(input.confidence);
  if (score == null || confidence == null) throw new Error('Grok 情绪结果缺少 score 或 confidence。');

  const citationRows = normalizeCitations(citations);
  const citedUrls = new Set(citationRows.map((item) => item.url));
  const described = Array.isArray(input.evidence) ? input.evidence : [];
  const evidenceByUrl = new Map();
  for (const item of described) {
    const url = cleanUrl(item?.url);
    if (!url || !citedUrls.has(url)) continue;
    evidenceByUrl.set(url, normalizeEvidence(item, url));
  }
  for (const item of citationRows) {
    const existing = evidenceByUrl.get(item.url);
    evidenceByUrl.set(item.url, {
      source: existing?.source || item.title || sourceIdentity(item.url),
      url: item.url,
      publishedAt: existing?.publishedAt || null,
      stance: existing?.stance || 'neutral',
      credibility: existing?.credibility ?? null,
      summary: existing?.summary || item.title || '',
    });
  }
  const evidence = [...evidenceByUrl.values()].slice(0, 12);
  const identities = new Set(evidence.map((item) => sourceIdentity(item.url)).filter(Boolean));
  const normalizedScore = clamp(score, -1, 1);
  const direction = normalizedScore >= SENTIMENT_POLICY.minDirectionalScore
    ? 'bullish'
    : normalizedScore <= -SENTIMENT_POLICY.minDirectionalScore ? 'bearish' : 'mixed';
  const observedAt = Number(now);
  const report = {
    observedAt,
    windowStart: observedAt - Number(windowHours) * 3_600_000,
    expiresAt: observedAt + SENTIMENT_POLICY.maxAgeMinutes * 60_000,
    score: round(normalizedScore, 4),
    direction,
    confidence: round(clamp(confidence, 0, 0.95), 4),
    attention: ATTENTION_LEVELS.has(input.attention) ? input.attention : 'normal',
    eventRisk: EVENT_RISKS.has(input.eventRisk) ? input.eventRisk : 'none',
    highImpactEvent: input.highImpactEvent === true,
    summary: cleanText(input.summary, 600),
    forecasts: normalizeForecasts(input.forecasts),
    independentSourceCount: identities.size,
    evidence,
    model: model ? String(model) : null,
  };
  report.valid = report.independentSourceCount >= SENTIMENT_POLICY.minIndependentSources
    && report.confidence >= SENTIMENT_POLICY.minConfidence;
  return report;
}

/**
 * Sentiment confirms or blocks the deterministic large-cycle result. It may
 * reduce risk by pausing, but it can never create or reverse a direction.
 */
export function applySentimentOverlay(analysis = {}, report, {
  now = Date.now(),
  policy = SENTIMENT_POLICY,
} = {}) {
  const base = { ...analysis, sentiment: report || null, decisionSource: 'large_cycle_sentiment' };
  if (analysis.suitable === false) {
    return { ...base, sentimentDecision: 'price_risk_pause', sentimentReason: '价格波动风控优先于情绪信号。' };
  }
  if (analysis.suitable !== true || !['long', 'short', 'neutral'].includes(analysis.mode)) {
    return hold(base, 'cycle_unconfirmed', '大周期尚未确定，情绪不能独立创建方向。');
  }
  if (!report || Number(report.observedAt) <= 0) {
    return hold(base, 'sentiment_missing', '尚未取得 Grok 实时情绪证据。');
  }
  if (Number(report.expiresAt) < Number(now)
    || Number(now) - Number(report.observedAt) > Number(policy.maxAgeMinutes) * 60_000) {
    return hold(base, 'sentiment_stale', 'Grok 情绪证据已过期，等待下一次搜索。');
  }
  if (Number(report.independentSourceCount) < Number(policy.minIndependentSources)) {
    return hold(base, 'insufficient_sources', `独立来源 ${Number(report.independentSourceCount) || 0}/${policy.minIndependentSources}，不足以确认方向。`);
  }
  if (Number(report.confidence) < Number(policy.minConfidence)) {
    return hold(base, 'sentiment_low_confidence', `情绪置信度 ${percent(report.confidence)} 低于 ${percent(policy.minConfidence)}。`);
  }

  const contraryRisk = (analysis.mode === 'long' && report.eventRisk === 'negative')
    || (analysis.mode === 'short' && report.eventRisk === 'positive')
    || report.eventRisk === 'mixed';
  if (report.highImpactEvent && contraryRisk && Number(report.confidence) >= Number(policy.shockConfidence)) {
    return {
      ...base,
      signalTime: Number(report.observedAt),
      regime: '高影响情绪风险',
      suitable: false,
      mode: 'neutral',
      confidence: Math.max(0.9, Number(report.confidence)),
      sentimentDecision: 'risk_pause',
      sentimentReason: '高可信反向事件只触发撤单平仓暂停，不直接反手。',
      caution: '情绪风险退出仍需连续确认和账户风控校验。',
    };
  }

  const threshold = Number(policy.minDirectionalScore);
  const aligned = analysis.mode === 'long'
    ? Number(report.score) >= threshold && report.direction === 'bullish'
    : analysis.mode === 'short'
      ? Number(report.score) <= -threshold && report.direction === 'bearish'
      : Math.abs(Number(report.score)) < threshold && report.direction === 'mixed' && !report.highImpactEvent;
  if (!aligned) {
    return hold(base, 'sentiment_conflict', `大周期目标为${modeText(analysis.mode)}，当前情绪为${directionText(report.direction)}，本轮保持原策略。`, report.observedAt);
  }

  return {
    ...base,
    signalTime: Number(report.observedAt),
    confidence: round(Math.min(Number(analysis.confidence) || 0, Number(report.confidence)), 4),
    sentimentDecision: 'confirmed',
    sentimentReason: `大周期${modeText(analysis.mode)}与${directionText(report.direction)}情绪一致。`,
    caution: '情绪只完成方向确认；执行仍受连续确认、最短持有和账户风控约束。',
  };
}

function hold(base, decision, reason, signalTime = null) {
  return {
    ...base,
    ...(Number(signalTime) > 0 ? { signalTime: Number(signalTime) } : {}),
    suitable: null,
    mode: null,
    confidence: 0,
    sentimentDecision: decision,
    sentimentReason: reason,
    reasoning: reason,
    caution: '保持当前策略；未运行时继续等待，不由情绪单独开仓。',
  };
}

function normalizeCitations(citations) {
  const rows = [];
  for (const item of Array.isArray(citations) ? citations : []) {
    const url = cleanUrl(typeof item === 'string' ? item : item?.url);
    if (!url || rows.some((row) => row.url === url)) continue;
    rows.push({ url, title: cleanText(typeof item === 'object' ? item.title : '', 180) });
  }
  return rows.slice(0, 20);
}

function normalizeEvidence(item, url) {
  const credibility = finite(item?.credibility);
  return {
    source: cleanText(item?.source, 100) || sourceIdentity(url),
    url,
    publishedAt: validDate(item?.publishedAt),
    stance: STANCES.has(item?.stance) ? item.stance : 'neutral',
    credibility: credibility == null ? null : round(clamp(credibility, 0, 1), 3),
    summary: cleanText(item?.summary, 240),
  };
}

function normalizeForecasts(value) {
  const byHours = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const hours = Math.round(Number(item?.hours));
    if (!SENTIMENT_POLICY.horizons.includes(hours)) continue;
    const values = [finite(item.up), finite(item.down), finite(item.range)];
    if (values.some((number) => number == null || number < 0)) continue;
    const total = values.reduce((sum, number) => sum + number, 0);
    if (!(total > 0)) continue;
    byHours.set(hours, {
      hours,
      up: round(values[0] / total, 4),
      down: round(values[1] / total, 4),
      range: round(values[2] / total, 4),
    });
  }
  return SENTIMENT_POLICY.horizons.map((hours) => byHours.get(hours)).filter(Boolean);
}

function sourceIdentity(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'x.com' || host === 'twitter.com') {
      const handle = url.pathname.split('/').filter(Boolean)[0];
      return handle ? `x:${handle.toLowerCase()}` : host;
    }
    return host;
  } catch { return ''; }
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

function validDate(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function cleanText(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value))); }
function round(value, digits = 2) { const scale = 10 ** digits; return Math.round(Number(value) * scale) / scale; }
function percent(value) { return `${Math.round(Number(value) * 100)}%`; }
function modeText(mode) { return ({ long: '做多', short: '做空', neutral: '中性' })[mode] || '未知'; }
function directionText(direction) { return ({ bullish: '偏多', bearish: '偏空', mixed: '混合' })[direction] || '未知'; }

function sentimentReportSchema() {
  return '{"score":-1到1,"confidence":0到1,"attention":"low|normal|high|extreme","eventRisk":"none|positive|negative|mixed","highImpactEvent":true或false,"summary":"中文摘要","forecasts":[{"hours":4,"up":0到1,"down":0到1,"range":0到1},{"hours":12,"up":0到1,"down":0到1,"range":0到1},{"hours":24,"up":0到1,"down":0到1,"range":0到1}],"evidence":[{"source":"账号或站点","url":"完整链接","publishedAt":"ISO时间或空字符串","stance":"bullish|bearish|neutral","credibility":0到1,"summary":"一句话"}]}';
}
