import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const FUNDING_MS = 8 * 60 * 60_000;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_CANDLE_CACHE = path.join(ROOT, '.cache', 'coinbase-btc-usd-15m.json');
const DEFAULT_OUTPUT = path.join(ROOT, '.cache', 'btc-perpetual-funding.json');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const range = await fundingRange();
  const binance = await fetchBinanceMonthly(range.from, range.to);
  const lastBinanceAt = binance.rates.at(-1)?.time || 0;
  const okxFrom = Math.max(range.from, lastBinanceAt + FUNDING_MS);
  const okx = okxFrom <= range.to ? await fetchOkxTail(okxFrom, range.to) : { rates: [], requests: 0 };
  const rates = mergeRates(binance.rates, okx.rates).filter((row) => row.time >= range.from && row.time <= range.to);
  if (!rates.length) throw new Error('No historical BTC perpetual funding rates were downloaded.');

  const output = process.env.FUNDING_CACHE_FILE || DEFAULT_OUTPUT;
  const payload = {
    version: 1,
    symbol: 'BTC perpetual',
    updatedAt: new Date().toISOString(),
    requestedFrom: new Date(range.from).toISOString(),
    requestedTo: new Date(range.to).toISOString(),
    sources: [
      {
        id: 'binance-btcusdt',
        label: 'Binance USD-M BTCUSDT public archive',
        rows: binance.rates.length,
        months: binance.months,
      },
      {
        id: 'okx-btc-usdt-swap',
        label: 'OKX BTC-USDT-SWAP public funding history',
        rows: okx.rates.length,
        requests: okx.requests,
      },
    ],
    rates: rates.map((row) => [row.time, row.rate, row.source]),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(payload), 'utf8');
  console.log(JSON.stringify({
    output: path.relative(ROOT, output),
    rows: rates.length,
    from: new Date(rates[0].time).toISOString(),
    to: new Date(rates.at(-1).time).toISOString(),
    sources: payload.sources,
  }, null, 2));
}

async function fundingRange() {
  const explicitFrom = parseTime(process.env.FUNDING_FROM);
  const explicitTo = parseTime(process.env.FUNDING_TO);
  if (explicitFrom && explicitTo && explicitTo > explicitFrom) return { from: explicitFrom, to: explicitTo };

  const candleFile = process.env.BACKTEST_CACHE_FILE || DEFAULT_CANDLE_CACHE;
  const candleCache = JSON.parse(await fs.readFile(candleFile, 'utf8'));
  const times = (candleCache.candles || []).map((row) => Number(row[0])).filter(Number.isFinite);
  if (!times.length) throw new Error(`Unable to infer funding range from ${candleFile}.`);
  return {
    from: explicitFrom || times.reduce((minimum, time) => Math.min(minimum, time), Infinity),
    to: explicitTo || times.reduce((maximum, time) => Math.max(maximum, time), -Infinity) + 15 * 60_000,
  };
}

async function fetchBinanceMonthly(from, to) {
  const months = monthKeys(from, to);
  const rates = [];
  let downloaded = 0;
  for (let offset = 0; offset < months.length; offset += 8) {
    const batch = months.slice(offset, offset + 8);
    const results = await Promise.all(batch.map(async (month) => {
      const url = `https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-${month}.zip`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`Binance funding archive ${month} returned HTTP ${response.status}.`);
      const csv = unzipFirstEntry(Buffer.from(await response.arrayBuffer())).toString('utf8');
      return parseBinanceCsv(csv);
    }));
    for (const rows of results) {
      if (rows.length) downloaded++;
      rates.push(...rows);
    }
  }
  return { rates: normalizeRates(rates), months: downloaded };
}

async function fetchOkxTail(from, to) {
  const rates = [];
  let cursor = null;
  let requests = 0;
  while (requests < 20) {
    const url = new URL('https://www.okx.com/api/v5/public/funding-rate-history');
    url.searchParams.set('instId', 'BTC-USDT-SWAP');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('after', String(cursor));
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`OKX funding history returned HTTP ${response.status}.`);
    const payload = await response.json();
    if (payload.code !== '0') throw new Error(`OKX funding history failed: ${payload.msg || payload.code}.`);
    const rows = (payload.data || []).map((row) => ({
      time: snapFundingTime(row.fundingTime),
      rate: Number(row.realizedRate ?? row.fundingRate),
      source: 'okx-btc-usdt-swap',
    })).filter(validRate);
    requests++;
    if (!rows.length) break;
    rates.push(...rows.filter((row) => row.time >= from && row.time <= to));
    const oldest = Math.min(...rows.map((row) => row.time));
    if (oldest <= from || oldest === cursor) break;
    cursor = oldest;
  }
  return { rates: normalizeRates(rates), requests };
}

function parseBinanceCsv(csv) {
  return String(csv).trim().split(/\r?\n/).slice(1).map((line) => {
    const [time, , rate] = line.split(',');
    return {
      time: snapFundingTime(time),
      rate: Number(rate),
      source: 'binance-btcusdt',
    };
  }).filter(validRate);
}

function unzipFirstEntry(archive) {
  if (archive.readUInt32LE(0) !== 0x04034b50) throw new Error('Funding archive has an invalid ZIP header.');
  const flags = archive.readUInt16LE(6);
  const method = archive.readUInt16LE(8);
  if (flags & 0x08) throw new Error('Funding ZIP data descriptors are not supported.');
  const compressedSize = archive.readUInt32LE(18);
  const fileNameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  const start = 30 + fileNameLength + extraLength;
  const compressed = archive.subarray(start, start + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`Funding ZIP compression method ${method} is not supported.`);
}

function mergeRates(primary, fallback) {
  const rows = new Map();
  for (const row of fallback) rows.set(row.time, row);
  for (const row of primary) rows.set(row.time, row);
  return [...rows.values()].sort((a, b) => a.time - b.time);
}

export { mergeRates, parseBinanceCsv, snapFundingTime, unzipFirstEntry };

function normalizeRates(rates) {
  return mergeRates(rates.filter(validRate), []);
}

function validRate(row) {
  return Number.isFinite(row.time) && row.time > 0 && Number.isFinite(row.rate) && Math.abs(row.rate) <= 0.1;
}

function snapFundingTime(value) {
  return Math.round(Number(value) / FUNDING_MS) * FUNDING_MS;
}

function monthKeys(from, to) {
  const keys = [];
  const cursor = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1));
  const end = new Date(to);
  while (cursor <= end) {
    keys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function parseTime(value) {
  if (!value) return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
