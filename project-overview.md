# GridPilot BTC 量化交易项目概览

## 当前范围

首阶段只运行 BTC 永续合约，默认模拟盘。`BTC_ONLY=true` 由配置层传入交易所适配器，模拟盘和实盘均只保留 BTC 市场。

## 架构

```text
public/index.html
        |
src/server.js -- GridBot -- grid.js / strategy-guards.js
        |             |
        |             +-- risk.js / persist.js / audit.js
        |
        +-- exchange/de/paper.js    (模拟盘)
        +-- exchange/de/decibel.js  (Decibel 实盘)
        +-- notifier.js / daily-pnl.js / ai/
```

## 运行方式

```bash
npm ci
cp .env.example .env
npm test
npm start
```

模拟盘入口为 `http://127.0.0.1:15000/paper`，实盘入口为 `http://127.0.0.1:15000/live`。两个页面使用不同配色和模式专属控件；页面与服务实际模式不一致时交易操作保持锁定。Python 不参与本项目运行。公网部署通过 Nginx 映射到 `/deepBTC/`，应用层使用 HTTP Basic Auth。

## BTC 网格约束

- 中性等差网格优先
- 首次模拟盘建议 1-3 倍杠杆、10-30 格
- 总保证金占用不超过账户权益 20%-30%
- 区间外执行停止、撤单、只减仓或平仓策略
- 模拟盘可按 ATR 自动调区间；默认每小时检查，触发后至少冷却 4 小时
- 单边净敞口默认不超过权益 15%，退出单使用 reduce-only
- 趋势守卫每 5 分钟检查 BTC 1h K 线，只暂停强趋势中的危险开仓方向
- 模拟盘计入手续费、滑点、点差、资金费率、成交延迟与部分成交
- 每次启动和调区间建立独立统计周期，保留最近 12 个周期记录
- 实盘必须通过 API 钱包、网络、Gas、账户权益和风险预检

## 敏感信息与运行状态

凭据放在 `.env` 或本地运行设置文件，均已加入 `.gitignore`。链上订单状态优先于本地快照，重启和退出后需要人工核对交易所挂单与仓位。
