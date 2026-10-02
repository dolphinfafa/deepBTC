import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createExchange } from './exchange/de/index.js';
import { deleteSnapshot, loadSnapshot, saveSnapshot } from './persist.js';
import { createTradingBot } from './trading-bot-factory.js';

export const PRIMARY_PAPER_INSTANCE_ID = 'paper-main';
export const MAX_PAPER_INSTANCES = 6;

export function normalizePaperInstanceRegistry(value = {}) {
  const rows = Array.isArray(value?.instances) ? value.instances : [];
  const seen = new Set();
  const instances = [];
  const add = (row) => {
    const id = String(row?.id || '').trim().toLowerCase();
    if (!/^paper-[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    instances.push({
      id,
      name: normalizeName(row?.name, id === PRIMARY_PAPER_INSTANCE_ID ? '模拟盘 1' : `模拟盘 ${instances.length + 1}`),
      selectedStrategyId: normalizeStrategyId(row?.selectedStrategyId),
      createdAt: finiteTimestamp(row?.createdAt) || Date.now(),
      autoRebalance: normalizeAutoRebalance(row?.autoRebalance),
    });
  };
  add(rows.find((row) => row?.id === PRIMARY_PAPER_INSTANCE_ID) || {
    id: PRIMARY_PAPER_INSTANCE_ID,
    name: '模拟盘 1',
    selectedStrategyId: 'range_balanced',
  });
  rows.filter((row) => row?.id !== PRIMARY_PAPER_INSTANCE_ID).slice(0, MAX_PAPER_INSTANCES - 1).forEach(add);
  return { version: 1, instances };
}

export class PaperInstanceManager {
  constructor({ root, exchangeConfig, primaryExchange, primaryBot, autoResume = true, onError = null }) {
    this.file = path.join(root, '.paper-instances.json');
    this.exchangeConfig = { ...exchangeConfig, mode: 'paper' };
    this.primaryExchange = primaryExchange;
    this.autoResume = autoResume;
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.registry = this._load();
    this.contexts = new Map();
    const primaryMeta = this.registry.instances[0];
    this.contexts.set(PRIMARY_PAPER_INSTANCE_ID, this._context(primaryMeta, primaryExchange, primaryBot, true));
  }

  async initialize() {
    for (const meta of this.registry.instances.slice(1)) await this._initializeAdditional(meta);
    this._save();
    return this.list();
  }

  get(id = PRIMARY_PAPER_INSTANCE_ID) {
    return this.contexts.get(String(id || PRIMARY_PAPER_INSTANCE_ID)) || null;
  }

  list() {
    return this.registry.instances.map((meta) => this.contexts.get(meta.id)).filter(Boolean);
  }

  async create(name) {
    if (this.registry.instances.length >= MAX_PAPER_INSTANCES) {
      throw new Error(`最多同时保留 ${MAX_PAPER_INSTANCES} 个模拟盘。`);
    }
    const id = `paper-${crypto.randomUUID().slice(0, 8)}`;
    const meta = {
      id,
      name: normalizeName(name, `模拟盘 ${this.registry.instances.length + 1}`),
      selectedStrategyId: 'range_balanced',
      createdAt: Date.now(),
      autoRebalance: normalizeAutoRebalance(),
    };
    this.registry.instances.push(meta);
    const context = await this._initializeAdditional(meta);
    this._save();
    return context;
  }

  async remove(id) {
    const key = String(id || '');
    if (key === PRIMARY_PAPER_INSTANCE_ID) throw new Error('主模拟盘不能删除。');
    const context = this.contexts.get(key);
    if (!context) throw new Error('模拟盘实例不存在。');
    const state = context.bot.getState();
    if (state.running || state.recovery || state.position || state.openOrders > 0 || state.exchangeOpenOrders > 0) {
      throw new Error('请先停止该模拟盘、平仓并撤销全部挂单。');
    }
    context.exchange.dispose?.();
    this.contexts.delete(key);
    this.registry.instances = this.registry.instances.filter((item) => item.id !== key);
    deleteSnapshot(context.snapshotKey);
    this._save();
    return true;
  }

  selectStrategy(id, strategyId) {
    const context = this.get(id);
    if (!context) throw new Error('模拟盘实例不存在。');
    const selected = normalizeStrategyId(strategyId, null);
    if (!selected) throw new Error('策略 ID 无效。');
    context.meta.selectedStrategyId = selected;
    this._save();
    return selected;
  }

  updateAutoRebalance(id, value) {
    const context = this.get(id);
    if (!context) throw new Error('模拟盘实例不存在。');
    context.meta.autoRebalance = normalizeAutoRebalance(value);
    this._save();
    return context.meta.autoRebalance;
  }

  replacePrimary(primaryExchange, primaryBot) {
    this.primaryExchange = primaryExchange;
    const current = this.contexts.get(PRIMARY_PAPER_INSTANCE_ID);
    this.contexts.set(PRIMARY_PAPER_INSTANCE_ID, this._context(current.meta, primaryExchange, primaryBot, true));
    for (const context of this.list().filter((item) => !item.primary)) context.exchange.follow?.(primaryExchange);
  }

  replaceBot(id, nextBot) {
    const context = this.get(id);
    if (!context) throw new Error('模拟盘实例不存在。');
    if (!nextBot) throw new Error('新的策略执行器无效。');
    context.bot.dispose?.();
    context.bot = nextBot;
    if (context.primary) this.primaryBot = nextBot;
    return context;
  }

  dispose() {
    for (const context of this.list()) context.bot.dispose?.();
    for (const context of this.list().filter((item) => !item.primary)) context.exchange.dispose?.();
  }

  _context(meta, exchange, bot, primary) {
    return {
      id: meta.id,
      name: meta.name,
      meta,
      exchange,
      bot,
      primary,
      snapshotKey: primary ? 'decibel' : `paper-instance:${meta.id}`,
      lastReadiness: null,
      rebalanceInFlight: false,
    };
  }

  async _initializeAdditional(meta) {
    const snapshotKey = `paper-instance:${meta.id}`;
    const exchange = createExchange(this.exchangeConfig);
    exchange.follow?.(this.primaryExchange);
    exchange.on('error', (error) => this.onError(error, meta));
    const snapshot = loadSnapshot(snapshotKey);
    const bot = createTradingBot(exchange, { onChange: (state) => saveSnapshot(snapshotKey, state) }, snapshot);
    bot.restore(snapshot);
    if (this.autoResume && snapshot?.running && snapshot?.config) {
      try { await bot.resume(snapshot); }
      catch (error) {
        this.onError(error, meta);
        exchange.restoreState?.(snapshot.exchangeState, {
          legacyMarketId: snapshot.config?.marketId,
          marketId: snapshot.config?.marketId,
        });
      }
    } else if (snapshot?.exchangeState) {
      exchange.restoreState?.(snapshot.exchangeState, {
        legacyMarketId: snapshot.config?.marketId,
        marketId: snapshot.config?.marketId,
      });
    }
    const context = this._context(meta, exchange, bot, false);
    this.contexts.set(meta.id, context);
    return context;
  }

  _load() {
    try { return normalizePaperInstanceRegistry(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { return normalizePaperInstanceRegistry(); }
  }

  _save() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.registry, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* instance metadata must not interrupt trading */ }
  }
}

function normalizeName(value, fallback) {
  const name = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
  return name || fallback;
}

function normalizeStrategyId(value, fallback = 'range_balanced') {
  const id = String(value || '').trim();
  return /^[a-z][a-z0-9_]{1,40}$/.test(id) ? id : fallback;
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function normalizeAutoRebalance(value = {}) {
  return {
    lastAdjustedAt: finiteTimestamp(value?.lastAdjustedAt),
    lastCheckAt: finiteTimestamp(value?.lastCheckAt),
    last: value?.last && typeof value.last === 'object'
      ? value.last
      : { t: null, code: 'not_running', reason: '网格尚未运行' },
  };
}
