import { GridBot } from './bot.js';
import { TurtlePaperBot } from './turtle-paper-bot.js';

export function strategyEngine(value = {}) {
  const source = value?.config || value || {};
  return source.engine === 'turtle' || source.strategyType === 'turtle' || source.strategyId === 'turtle_s2_long'
    ? 'turtle'
    : 'grid';
}

export function createTradingBot(exchange, options = {}, source = {}) {
  return strategyEngine(source) === 'turtle'
    ? new TurtlePaperBot(exchange, options)
    : new GridBot(exchange, options);
}
