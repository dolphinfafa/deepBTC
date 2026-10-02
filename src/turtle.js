function finitePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive.`);
  return number;
}
export function trueRange(candle, previousClose) {
  const high = finitePositive(candle?.high, 'high');
  const low = finitePositive(candle?.low, 'low');
  if (high < low) throw new Error('high must be greater than or equal to low.');
  const prior = Number(previousClose);
  if (!Number.isFinite(prior)) return high - low;
  return Math.max(high - low, Math.abs(high - prior), Math.abs(low - prior));
}

/** Classic Wilder-smoothed N values, aligned with the input candles. */
export function wilderAtr(candles, period = 20) {
  const length = Math.max(1, Math.round(finitePositive(period, 'period')));
  const values = new Array(candles.length).fill(null);
  if (candles.length < length + 1) return values;

  const ranges = [];
  for (let index = 1; index < candles.length; index++) {
    ranges.push(trueRange(candles[index], candles[index - 1].close));
  }
  let current = ranges.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  values[length] = current;
  for (let index = length + 1; index < candles.length; index++) {
    current = ((length - 1) * current + ranges[index - 1]) / length;
    values[index] = current;
  }
  return values;
}

/**
 * Build levels that become usable only after the source daily candle closes.
 * The returned Donchian windows therefore never include an in-progress day.
 */
export function buildTurtleSignals(candles, { entryDays = 55, exitDays = 20, atrDays = 20 } = {}) {
  const entryLength = Math.max(2, Math.round(finitePositive(entryDays, 'entryDays')));
  const exitLength = Math.max(2, Math.round(finitePositive(exitDays, 'exitDays')));
  const atrLength = Math.max(2, Math.round(finitePositive(atrDays, 'atrDays')));
  const nValues = wilderAtr(candles, atrLength);
  const signals = [];

  for (let index = 0; index < candles.length; index++) {
    if (index + 1 < Math.max(entryLength, exitLength) || !(nValues[index] > 0)) continue;
    const entryWindow = candles.slice(index - entryLength + 1, index + 1);
    const exitWindow = candles.slice(index - exitLength + 1, index + 1);
    const source = candles[index];
    const availableAt = Number(source.endTime);
    if (!Number.isFinite(availableAt)) throw new Error('Daily candles must include endTime.');
    signals.push({
      availableAt,
      sourceTime: Number(source.time),
      entryHigh: Math.max(...entryWindow.map((candle) => Number(candle.high))),
      exitLow: Math.min(...exitWindow.map((candle) => Number(candle.low))),
      atrN: nValues[index],
    });
  }
  return signals;
}

export function snapDown(value, stepSize) {
  const step = finitePositive(stepSize, 'stepSize');
  const steps = Math.floor(Number(value) / step + 1e-9);
  if (!Number.isFinite(steps) || steps <= 0) return 0;
  return Number((steps * step).toFixed(12));
}

export function turtleUnitSize({
  equity,
  price,
  atrN,
  riskPct = 0.5,
  stopAtrMultiple = 2,
  maxNotionalPct = 100,
  currentSize = 0,
  stepSize = 0.00001,
  minOrderSize = 0.0001,
}) {
  const accountEquity = finitePositive(equity, 'equity');
  const markPrice = finitePositive(price, 'price');
  const n = finitePositive(atrN, 'atrN');
  const riskFraction = finitePositive(riskPct, 'riskPct') / 100;
  const stopDistance = n * finitePositive(stopAtrMultiple, 'stopAtrMultiple');
  const riskSized = accountEquity * riskFraction / stopDistance;
  const notionalCap = accountEquity * finitePositive(maxNotionalPct, 'maxNotionalPct') / 100;
  const available = Math.max(0, notionalCap / markPrice - Math.max(0, Number(currentSize) || 0));
  const quantity = snapDown(Math.min(riskSized, available), stepSize);
  return quantity + 1e-12 >= finitePositive(minOrderSize, 'minOrderSize') ? quantity : 0;
}

export function executionCostBreakdown({
  side,
  referencePrice,
  quantity,
  feeRate = 0.0005,
  slippageBps = 2,
  spreadBps = 1,
}) {
  if (!['buy', 'sell'].includes(side)) throw new Error('side must be buy or sell.');
  const price = finitePositive(referencePrice, 'referencePrice');
  const size = finitePositive(quantity, 'quantity');
  const fee = Number(feeRate);
  const slippage = Number(slippageBps);
  const spread = Number(spreadBps);
  if (![fee, slippage, spread].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Execution cost inputs must be non-negative.');
  }
  const direction = side === 'buy' ? 1 : -1;
  const executionPrice = price * (1 + direction * (slippage + spread) / 10_000);
  const feeCost = executionPrice * size * fee;
  const slippageCost = price * size * slippage / 10_000;
  const spreadCost = price * size * spread / 10_000;
  return {
    referencePrice: price,
    executionPrice,
    notional: price * size,
    fees: feeCost,
    slippage: slippageCost,
    spread: spreadCost,
    total: feeCost + slippageCost + spreadCost,
  };
}
