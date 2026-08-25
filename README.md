# GridPilot · Decibel 网格交易控制台

专为 **Decibel** 永续合约打造的本地网格交易控制台，支持模拟盘、实盘执行、自由调参、仓位恢复、风险控制和 Telegram 盈亏通知。

> 合约与杠杆交易存在本金损失风险。本项目不构成投资建议，建议先运行模拟盘，并根据自身资金规模设置实盘风控参数。

## 当前状态

- 版本：`1.0.0`
- 交易所：仅 Decibel
- 默认模式：`paper` 模拟盘
- Decibel SDK：锁定 `@decibeltrade/sdk 0.7.0`
- Node.js：20 或更高版本
- 支持：Windows、macOS

## 相关网站

- [Decibel 应用](https://app.decibel.trade/)：创建或管理 API 钱包、Trading Account，并核对订单与仓位。
- [Geomi](https://geomi.dev/)：申请 Decibel 行情与交易接口使用的 API Key。

## 核心能力

- 中性、做多、做空三种等差网格。
- 模拟撮合，可接入 Decibel 真实行情；没有 API Key 时先尝试公共现货行情，公共行情不可用才使用合成行情。
- 中性网格默认限制单边净敞口不超过权益 `15%`；减仓方向自动改为 `reduceOnly`，达到上限后撤销危险方向的开仓单。
- 趋势保护每 `5` 分钟读取 BTC 1h K 线；强上升时暂停新增空头，强下降时暂停新增多头，但始终允许减仓退出。
- PAPER 成交计入手续费、滑点、点差、8 小时资金费率、成交延迟和部分成交，页面提供独立成本拆分。
- 每次启动、调区间或人工重置都会创建新的统计周期，参数版本、盈亏基线和执行成本互不混算。
- 首阶段固定 `BTC-USD` 单市场；默认 PAPER 模式使用中性网格，实盘不会被自动开启。
- Decibel 实盘下单、撤单、杠杆设置、持仓同步、成交识别和订单对账。
- “自动参数”按钮根据 BTC `ATR(1h)`、账户权益和市场精度生成保守的中性网格，并保留手动调参能力。
- 模拟盘就绪检查显示模式、BTC-only、价格源、保证金风险和遗留状态；只有人工点击“启动网格”才会运行。
- 启动快照、进程重启恢复、遗留订单接管和定期对账。
- 实盘启动前账户预检，覆盖连接、权益、API 钱包 Gas、挂单、持仓和风险状态。
- 服务端限制最大杠杆、保证金占比和维持保证金率；格数与名义金额上限可设为 `0`，交给动态风险计算。
- 持久化日内亏损与权益回撤锁；触发后自动撤单并尝试平仓。
- 初始挂单残缺时自动撤回并拒绝启动。
- 杠杆设置或遗留挂单撤销未确认时拒绝继续挂网格。
- 遗留仓位可选择重新建网格、只减仓回收或立即平仓。
- 面板录入 Decibel API Key、API 钱包私钥、Trading Account、网络和目标模式。
- Telegram / Webhook 异常通知与自定义时间的每日盈亏日报。
- 脱敏审计日志、紧急停止和异常恢复流程。

## 模拟盘启动

### Windows

双击 `启动-模拟盘.bat`。

### macOS

双击 `启动-模拟盘.command`。首次若被系统阻止，可在终端执行：

```bash
chmod +x 启动-模拟盘.command
./启动-模拟盘.command
```

打开 `http://127.0.0.1:15000/paper`。模拟盘初始权益默认为 10,000 USDC，不会发送真实订单。

PAPER 页面可手动设置模拟账户权益，作为模拟入金或出金处理。该操作仅在网格已停止、恢复流程未运行、账户无持仓且机器人与交易所均无挂单时开放；调整后策略周期和当日盈亏都会以新权益重新建立零基线，资金变动不会被计为交易利润或亏损。LIVE 页面不提供此入口。

## 页面入口

- `/paper` 是模拟盘工作台，使用明亮的白/绿配色，显示模拟盘就绪检查，不显示 API 钱包私钥和实盘预检控件。
- `/live` 是实盘交易台，使用石墨黑/红色警示配色，集中显示实盘凭据、风控上限和实盘预检。
- 根地址会根据服务实际运行模式进入对应页面。页面模式与服务实际模式不一致时，页面保持只读并锁定交易动作，同时隐藏另一模式的账户、仓位、挂单、盈亏和运行记录，只显示该模式服务尚未启动。
- 公网部署对应入口为 `/deepBTC/paper` 和 `/deepBTC/live`。

## 配置个人版本

先复制配置文件：

```bash
cp .env.example .env
```

可先修改名称和模拟余额：

```ini
APP_NAME=GridPilot
OWNER_NAME=你的名字
PAPER_BALANCE=10000
```

模拟盘如需 Decibel 真实行情，前往 [Geomi](https://geomi.dev/) 申请并填写 API Key：

```ini
TRADING_MODE=paper
DECIBEL_API_KEY=你的_API_Key
```

## BTC 回测

运行 `npm run backtest:btc` 获取 Coinbase BTC-USD 1h 数据并执行默认 180 天回测。回测严格按时间顺序运行：趋势信号和新挂单只读取上一根已完成 K 线，当前 K 线只撮合此前已存在的订单。保护暂停的订单只有在条件解除且仍位于当前价被动一侧时才恢复，避免把已经穿价的旧订单当作正常限价单追价成交。

可用环境变量做敏感性实验：`BACKTEST_DAYS`、`BACKTEST_FEE_RATE`、`BACKTEST_SLIPPAGE_BPS`、`BACKTEST_SPREAD_BPS`、`BACKTEST_FUNDING_8H_RATE`、`BACKTEST_MAX_DIRECTIONAL_NOTIONAL_PCT`、`BACKTEST_GRID_SIZE_MULTIPLIER`、`BACKTEST_GRID_COUNT_MULTIPLIER`、`BACKTEST_TREND_SLOPE_THRESHOLD`、`BACKTEST_TREND_GUARD_MIN_STRENGTH` 和 `BACKTEST_TREND_CONFIRM_BARS`。`BACKTEST_FLATTEN_ADVERSE_TREND=true` 与 `BACKTEST_REGIME_MODE_SWITCH=true` 是研究开关，不会改变正在运行的 PAPER/LIVE 策略。

1h 数据无法可靠模拟 `750ms` 成交延迟和随机部分成交。回测结果用于成本敏感性、参数排除和不同时间窗口对照，不作为盈利或上线承诺。

## 实盘配置

准备以下信息：

1. 在 [Geomi](https://geomi.dev/) 申请 Geomi API Key。
2. 在 [Decibel 应用](https://app.decibel.trade/) 创建 API 钱包；使用 API 钱包私钥，不要使用主钱包助记词或主钱包私钥。
3. 在 [Decibel 应用](https://app.decibel.trade/) 账户页获取 Trading Account 地址。
4. 已存入交易保证金的 Decibel 账户。
5. API 钱包地址中准备少量 APT，用于支付链上挂单、撤单和设置杠杆的 Gas。

在 `.env` 中填写：

```ini
TRADING_MODE=live
ENABLE_LIVE_TRADING=true
LIVE_CONFIRMATION=I_ACCEPT_DECIBEL_LIVE_RISK
DECIBEL_NETWORK=mainnet
DECIBEL_API_KEY=
DECIBEL_PRIVATE_KEY=
DECIBEL_SUBACCOUNT=
DECIBEL_ORIGIN=http://127.0.0.1
```

服务启动时会检查这些字段。缺少任意一项都会直接拒绝进入实盘模式。

也可以在操作台的“Decibel 连接”面板填写 API Key、API 钱包私钥、Trading Account、网络和重启后的目标模式。敏感内容不会回显，保存后写入本机 `.connection-settings.json`，重启服务后生效。选择实盘时必须输入 `ENABLE DECIBEL LIVE`。

同一面板可以配置 Decibel 专用 HTTP(S) 或 SOCKS5 代理。代理账号与密码不会回显，保存后随模拟盘重启生效。

模拟盘使用真实行情时，页面会显示实际数据网络（Mainnet 或 Testnet）。配置目标网络与实际数据网络不一致时，实盘预检会阻断启动。

### 实盘启动

Windows 双击 `启动-实盘.bat`，macOS 双击 `启动-实盘.command`。命令行要求再次输入 `DECIBEL`，随后页面仍需完成实盘预检和逐市场确认。

服务进入实盘模式后访问 `http://127.0.0.1:15000/live`。仅打开实盘页面不会切换服务模式，也不会启用真实下单。

正常启动网格时输入：

```text
LIVE BTC-USD
```

若该市场已有仓位，普通启动会被拒绝。使用“重新建网格”接管时输入：

```text
REGRID BTC-USD
```

市场名称以页面实际显示为准。

## 实盘预检

点击“实盘预检”，系统检查：

- 实盘模式和总闸门。
- API Key、API 钱包私钥和 Trading Account 格式。
- Decibel 连接、市场列表、实时价格和账户权益。
- API 钱包的 APT Gas 余额。
- 配置目标网络与实际数据网络是否一致。
- 现有挂单、现有仓位和日内风险锁。
- Telegram / Webhook 是否配置。

预检通过后有效 5 分钟。每次成功启动实盘网格后，预检结果立即作废，下一次启动必须重新检查。

## 风控参数

默认实盘上限：

| 配置 | 默认值 | 含义 |
|---|---:|---|
| `LIVE_MAX_LEVERAGE` | `10` | 最大杠杆；交易所市场上限仍优先 |
| `LIVE_MAX_GRID_COUNT` | `0` | 最大格数；`0` 表示交给保证金/维持保证金率动态限制 |
| `LIVE_MAX_NOTIONAL` | `0` | 最大名义价值，USDC；`0` 表示不单独限制 |
| `LIVE_MAX_MARGIN_PCT` | `35` | 预估保证金占账户权益上限 |
| `LIVE_MIN_MAINTENANCE_RATIO` | `300` | 预计维持保证金率下限；低于该值拒绝实盘启动 |
| `LIVE_DAILY_LOSS_LIMIT` | `20` | UTC 日内最大权益损失，USDC |
| `LIVE_MAX_DRAWDOWN_PCT` | `30` | 当日权益高点最大回撤百分比 |

这些值可以在 `.env` 中自由修改，可根据账户权益、交易品种和策略规模设置。

风险锁记录在 `.risk-state.json`。达到日内亏损或回撤阈值后会锁定新启动，并在网格运行时触发紧急停止。停止后必须人工核对交易所，再输入 `RESET RISK` 重置基线。

## 网格参数

| 参数 | 含义 |
|---|---|
| 中性 | 现价下方挂买单、上方挂卖单 |
| 做多 | 下方开多，成交后在上一格挂只减仓卖单 |
| 做空 | 上方开空，成交后在下一格挂只减仓买单 |
| 下/上边界 | 网格运行价格范围 |
| 网格数量 | 区间分格数量 |
| 每格数量 | 每张订单的基础币数量 |
| 杠杆 | 影响保证金占用和强平风险 |
| 撤单并平仓 | 价格出区间后停止并尝试平仓 |
| 只减仓回收 | 价格出区间后只挂减少现有仓位的退出单 |
| 最大方向敞口 | 单边净持仓名义价值占权益的上限，默认 `15%` |
| 趋势保护 | 强趋势中暂停逆势新增仓位，默认开启 |

中性网格适合震荡行情，会在上涨过程中逐格卖出，因此在持续单边上涨中仍可能积累空头。确认上涨趋势已经形成时，应人工选择“做多”网格；如果中性网格已经运行，先停止并处理已有空头，再按新的上涨区间人工启动做多网格。系统不会自动切换方向，也不会自动启动新网格。

点击“自动参数”会读取 BTC `ATR(1h)` 并填入首版策略参数：中性网格、`2x` 杠杆、区间半宽限制 `6%-18%`、`10-40` 格，预计保证金约占权益 `8%`，区间外动作为撤单并平仓。它不会自动启动，必须通过页面就绪检查后人工点击“启动网格”。

模拟盘默认开启自动调区间：网格运行时每 `60` 分钟检查，价格进入当前区间边缘 `20%` 且新旧区间变化达到 `10%` 才调整；调整成功后冷却 `240` 分钟。调整只改变价格边界，保留格数、每格数量、杠杆和方向。实盘默认关闭自动调区间。无论模式如何，启动和调整都会重新执行市场、最小下单量、保证金与风险检查。

方向敞口按 `abs(净持仓数量 × 最新价) / 账户权益` 计算。达到上限时不会强制平仓，只会停止继续增加该方向；反向退出单会使用 `reduceOnly`。趋势保护不会把中性网格切换成做多或做空模式，只会临时暂停危险的开仓方向，趋势恢复后再恢复仍有效的挂单。

模拟盘默认执行成本为：单边手续费 `0.05%`、滑点 `2 bps`、点差 `1 bp`、每 8 小时资金费率 `0.01%`、成交确认延迟 `750ms`、部分成交概率 `35%`（单次成交剩余量的 `50%`）。这些值可通过 `.env` 中的 `PAPER_*` 参数调整。正资金费率表示多头支付、空头收取；页面“PAPER 执行损耗”按当前统计周期显示手续费、滑点、点差和资金费率拆分。

每次成功启动网格、人工/自动调区间、人工重置统计或调整 PAPER 账户权益，都会开始新的参数统计周期。本周期已实现、未实现变化、总盈亏、成交量、完成格数和执行成本均从当时状态重新建立基线；最近 12 个已结束周期随快照保存，用于比较不同参数。普通统计重置不会改变账户总权益，PAPER 权益调整则会把资金变动与策略收益分开记录。

实盘启动时服务器会计算完整名义价值、预估保证金和预计维持保证金率，不会绕过交易所市场上限或项目实盘风控；请先在模拟盘观察，再按账户规模调整参数并重新完成预检。

## 遗留仓位处理

检测到有仓位但网格未运行时，页面提供三种操作：

- **重新建网格**：保留仓位并按当前参数重新挂网格。实盘需输入 `REGRID 市场名`，已有仓位名义价值会计入风控上限。
- **只减仓回收**：只挂减少仓位的退出阶梯，不新增方向仓位。实盘需输入 `RECOVER 市场名`。
- **立即平仓**：撤销该市场普通挂单并发送 reduce-only IOC 平仓单。实盘需输入 `CLOSE 市场名`。

撤单或平仓执行后，可在 Decibel 网页端核对最终订单和仓位状态。极端行情、网络中断或链上交易失败时，以链上实际结果为准。

## 紧急停止与退出

“紧急停止”要求输入 `EMERGENCY STOP`，随后撤销挂单并最多重试三次平仓。

直接关闭程序时，系统会写入审计并发送通知，但**不会擅自自动撤单或平仓**。这是为了避免关机、网络异常或重复信号导致额外交易。进程退出后，Decibel 上的订单和仓位可能继续存在，必须人工核对。

## 通知

操作台的“每日盈亏通知”面板可直接填写：

- Telegram Bot Token。
- TG ID / Chat ID。
- 每日发送时间。
- 统计时区。
- 是否开启每日推送。

Token 不会通过接口回显，保存于本机 `.notification-settings.json`。日报以所选时区当天首次记录到的账户权益作为日初基线，内容包含当日盈亏、收益率、账户权益、已实现/未实现盈亏、仓位和挂单数量。支持“测试通知”和“立即发送日报”。

Telegram Bot API 使用 `sendMessage` 向配置的 `chat_id` 发送文本。也可继续通过 `.env` 配置：

Telegram：

```ini
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

通用 JSON Webhook：

```ini
NOTIFY_WEBHOOK=https://你的地址
```

通知失败只会记录审计，不会阻断撤单和平仓流程。定时日报失败后会间隔 10 分钟重试，同一日期和计划时间成功发送后不会重复推送。

## AI 助手

操作台的“AI 助手”面板支持 OpenAI 兼容接口、Anthropic 和 Gemini。配置 API Key、Base URL 与模型后，可以：

- 基于 4 小时、1 小时和 15 分钟 K 线分析当前市场。
- 判断震荡、上涨、下跌或剧烈波动，并给出网格方向、区间和格数建议。
- 根据实时权益、持仓、挂单、盈亏和风险状态回答问题。
- 定时运行风控巡检和 BTC 市况分析，并在指定小时生成 AI 复盘。
- 价格首次冲出区间时生成处置建议并通过已配置的通知渠道推送。
- 对话可以提出填参、调区间、重连、撤单或停止建议，但必须由用户再次确认。

AI 只提供分析与建议，不会直接启动网格、撤单或平仓。API Key 保存在本机 `.ai-settings.json`，公开接口只返回是否已配置，不会回显密钥。

也可以通过 `.env` 配置：

```ini
AI_PROVIDER=openai
AI_API_KEY=
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-5.6-terra
AI_MODEL_SMALL=gpt-5.6-terra
AI_SENTINEL_MINUTES=5
AI_MARKET_MINUTES=30
AI_REPORT_HOUR=20
```

## 状态和审计文件

- `.state.json`：网格运行快照，不保存私钥。
- `.risk-state.json`：UTC 日内风险基线和锁定状态。
- `.audit.jsonl`：脱敏操作记录，达到约 5 MB 后轮换为 `.audit.jsonl.1`。
- `.connection-settings.json`：面板保存的 Decibel 连接凭据和目标模式，权限限制为当前用户。
- `.notification-settings.json`：Telegram 与日报时间设置，权限限制为当前用户。
- `.ai-settings.json`：AI 提供商、模型与 API Key，权限限制为当前用户。
- `.daily-pnl.json`：所选时区的日初权益、最新权益和最后发送记录。

这些运行文件已加入 `.gitignore`，打包交付时也应删除。

## 局域网访问

默认只监听 `127.0.0.1`。若改为 `HOST=0.0.0.0`，必须配置至少 32 位随机访问令牌：

```ini
HOST=0.0.0.0
DASHBOARD_TOKEN=至少32位随机字符串
```

使用 `http://设备IP:15000/?token=你的令牌` 打开。不要把端口直接暴露到公网。

## 验证

```bash
npm ci
npm test
```

测试覆盖网格生成、初始挂单、成交后补单、只减仓规则、代理格式、Decibel 链上精度换算、实盘风险计算、维持保证金率检查、风险锁持久化、杠杆失败中止、残缺挂单回滚、连接凭据脱敏、Telegram 与 AI 设置持久化、模拟盘恢复和跨时区日报去重。

## 部署建议

1. 先运行模拟盘，确认行情、网格、补单、调区间和通知功能正常。
2. 根据账户规模配置杠杆、保证金占比、维持保证金率和回撤上限；网格数与名义金额上限可设为 `0`，交给动态风险计算。
3. 实盘首次启动使用较小参数，并在 Decibel 页面同步核对订单与仓位。
4. 测试撤单、重启恢复、遗留仓位处理和紧急停止流程。
5. 稳定运行后再逐步调整策略参数。

## 项目结构

```text
public/index.html          中文单页操作台
src/server.js             本地服务、鉴权、预检和安全入口
src/bot.js                网格生命周期、下单回滚、对账和恢复
src/grid.js               网格数学
src/risk.js               实盘启动限制和日内风险锁
src/daily-pnl.js           按时区统计每日权益变化和发送去重
src/connection-settings.js Decibel 连接凭据安全存储
src/audit.js              脱敏审计日志
src/notifier.js           Telegram / Webhook 通知
src/ai/                   AI 提供商、分析、巡检和设置
src/exchange/de/          Decibel 模拟盘与实盘适配器
src/exchange/de/types.js  Decibel 适配器共享类型常量
src/config.js             .env 配置加载
src/persist.js            崩溃恢复快照
test/grid.test.js         核心测试
```
