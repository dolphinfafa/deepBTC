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
- Decibel 实盘下单、撤单、杠杆设置、持仓同步、成交识别和订单对账。
- “自动参数”按钮一键填入固定 BTC 中性网格，并保留手动自由调参能力。
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

打开 `http://127.0.0.1:8080`。模拟盘初始权益默认为 10,000 USDC，不会发送真实订单。

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

点击“自动参数”只会自动填入数值：中性网格、现价上下各 3000 USDC、80 格、每格 0.002 BTC、30x。它不会自动启动，点“启动网格”才会开始运行；启动后不做任何每日或边界的自动重设，出区间动作按下拉框选择执行，想换区间用“调整区间”手动调整（持仓保留）。

实盘启动时服务器会计算完整名义价值、预估保证金和预计维持保证金率。自动参数为模拟盘示例的 `30x / 80格`，不会绕过交易所市场上限或项目实盘风控；用于实盘前应先调整为符合账户规模的参数，并重新完成预检。

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

使用 `http://设备IP:8080/?token=你的令牌` 打开。不要把端口直接暴露到公网。

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
