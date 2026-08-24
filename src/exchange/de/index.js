import { PaperExchange } from './paper.js';
import { DecibelExchange } from './decibel.js';

/** Factory: choose adapter by mode. */
export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.apiKey || !cfg.privateKey) {
      throw new Error('LIVE 模式需要 DECIBEL_API_KEY 和 DECIBEL_PRIVATE_KEY 环境变量（API key 在 geomi.dev 创建，API 钱包在 app.decibel.trade/api 创建）。');
    }
    return new DecibelExchange({
      apiKey: cfg.apiKey,
      privateKey: cfg.privateKey,
      subaccount: cfg.subaccount,
      btcOnly: cfg.btcOnly,
      apiUrl: cfg.apiUrl, origin: cfg.origin, network: cfg.network,
    });
  }
  return new PaperExchange({
    apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, origin: cfg.origin,
    network: cfg.network, btcOnly: cfg.btcOnly, startBalance: cfg.startBalance,
    feeRate: cfg.paperFeeRate,
    slippageBps: cfg.paperSlippageBps,
    spreadBps: cfg.paperSpreadBps,
    fundingRate: cfg.paperFundingRate,
    fundingIntervalMs: cfg.paperFundingIntervalMs,
    fillDelayMs: cfg.paperFillDelayMs,
    partialFillProbability: cfg.paperPartialFillProbability,
    partialFillRatio: cfg.paperPartialFillRatio,
  });
}
