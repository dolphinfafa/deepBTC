/** Aggregate complete lower-timeframe candles without filling data gaps. */
export function aggregateCandles(candles, intervalMs, sourceIntervalMs) {
  const targetMs = Number(intervalMs);
  const sourceMs = Number(sourceIntervalMs);
  if (!(targetMs >= sourceMs) || targetMs % sourceMs !== 0) {
    throw new Error('聚合周期必须是源周期的整数倍。');
  }
  const expected = targetMs / sourceMs;
  const buckets = new Map();
  for (const candle of candles || []) {
    if (!validCandle(candle)) continue;
    const time = Number(candle.time);
    const bucket = Math.floor(time / targetMs) * targetMs;
    const rows = buckets.get(bucket) || [];
    rows.push(candle);
    buckets.set(bucket, rows);
  }
  const result = [];
  for (const [time, unsorted] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const rows = [...unsorted].sort((a, b) => a.time - b.time);
    const complete = rows.length === expected
      && Number(rows[0].time) === time
      && Number(rows.at(-1).time) + sourceMs === time + targetMs
      && rows.every((row, index) => Number(row.time) === time + index * sourceMs);
    if (!complete) continue;
    result.push({
      time,
      endTime: time + targetMs,
      open: Number(rows[0].open),
      high: Math.max(...rows.map((row) => Number(row.high))),
      low: Math.min(...rows.map((row) => Number(row.low))),
      close: Number(rows.at(-1).close),
      volume: rows.reduce((sum, row) => sum + (Number(row.volume) || 0), 0),
      sourceCount: rows.length,
    });
  }
  return result;
}

/** Return only candles fully closed at `at`, preventing look-ahead in replay. */
export function completedCandleWindow(candles, at, limit = 200) {
  const timestamp = Number(at);
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const endTime = Number(candles[middle].endTime);
    if (endTime <= timestamp) low = middle + 1;
    else high = middle;
  }
  return candles.slice(Math.max(0, low - limit), low);
}

function validCandle(candle) {
  return Number.isFinite(Number(candle?.time))
    && Number.isFinite(Number(candle?.open))
    && Number.isFinite(Number(candle?.high))
    && Number.isFinite(Number(candle?.low))
    && Number.isFinite(Number(candle?.close));
}
