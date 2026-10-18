# Steam Assistant Skills

面向人工监督的 Steam 卡牌盘点、报价、原生页面改价，以及 Windows Idle Master Extended 诊断技能。包含两个可安装的 Codex 技能、只读用户脚本和离线测试。[English](docs/README.en.md) · [兼容性](docs/compatibility.md) · [变更](CHANGELOG.md) · [来源与许可](THIRD_PARTY_NOTICES.md)

**交易操作必须有具体批准。此项目不是无人审批、无人值守的市场机器人。** 不包含 Steam 登录工具、购买/交易机器人、盈利预测或第三方软件二进制。不要向模型发送密码、Cookie、验证码或认证配置。

## 组件与职责

|组件|作用|边界|
|---|---|---|
|`skills/steam-market-listing`|先盘点报价，再按批准计划操作与核对|技能通用流程覆盖可市场交易物品；附带脚本只支持卡牌|
|`steam-card-bulk-lister.user.js` 0.4.0 / schema 2|盘点、只读报价、逐资产状态与锁定摘要|不能撤单、提交或证明成交|
|`steam-market-reprice-runner.cjs`|通过宿主提供的 cua Tab 操作原生改价界面|不是独立CLI；导入不执行任务，短阶段 `runStep()`|
|`steam-card-native-preview-fix.user.js`|可选：修复丢失数字游戏前缀的预览入口|仅数量0预览，不上架|
|`skills/idle-master-extended`|Windows进程/窗口/模式诊断及明确授权的维护|文档技能，没有新增采集器，不包含 Idle Master 本体|

## 安装

1. 克隆本仓库并停留在最新 `main`。历史首提交仅供比较，不能作为建议安装版本。
2. 将 `skills/steam-market-listing` 和 `skills/idle-master-extended` 两个完整目录复制到自己的 `$CODEX_HOME/skills`（未设置时通常为 `~/.codex/skills`）。更新已有安装前备份，比较修改；不要直接覆盖私人任务台账。重新开启会话确认技能可发现。
3. 用户脚本独立安装：在用户自行选择、信任的 Chrome 用户脚本管理器中，新建脚本并粘贴 `skills/steam-market-listing/scripts/steam-card-bulk-lister.user.js` 的完整内容，审查后保存。也可仅在本机 loopback 提供该文件后用扩展安装。不要把认证信息填进脚本。
4. 在自己已登录的 Steam 库存页选择卡牌库存，刷新页面。面板应显示“Steam卡牌盘点与报价”、helper 0.4.0、schema 2、READ_ONLY。初始 NOT_SCANNED 是尚未扫描，不是成功盘点。运行盘点后检查完整性与账号；旧锁不得通过清空存储绕过。
5. 只有宿主提供所需浏览器能力时才能使用 runner；复制技能并不自动授予 Chrome 控制权。阅读 [原生 runner 说明](skills/steam-market-listing/references/native-card-reprice.md)，准备独立持久台账与已验证 Tab。布尔值 `approvedPlan: true` 只是程序输入，不替代真人批准证据。

旧安装的用户脚本名称“Steam 卡牌批量上架助手（本地审计版）”和 namespace `codex.local.steam-card-listing` 为保持安装身份而保留；名称不表示有自动上架能力。不要修改 namespace 或重置本地账本来解除锁。

## 使用例子

- “用 $steam-market-listing 只读盘点我的卡牌，按当前最低在售报价预览，分别列出买家支付、卖家实收和费用，先不要撤单或提交。”
- “针对刚才核实的账号和清单，给出将指定卡牌改价到指定价格的完整计划，列出数量、两类总额、撤单范围和手机确认方式。”完整计划经具体批准后才执行；改变账号/资产/价格/数量需要新的具体批准，未改变的批准不逐组重复请求。
- “用 $idle-master-extended 只读检查当前程序窗口/托盘状态和正常 Fast 阶段，无法观察的值写 unknown。”
- “将 Steam 好友状态设置为隐身。”仅这一明确请求授权隐身，不授权离线模式或隐私配置更改。

费用以 Steam 原生预览为准，不使用固定百分比替代。同组同价可复用校准。手机确认由用户在 Steam 官方工具中完成；未接受的条款由用户处理。大量卡牌可先讨论分批或全部，但不得扩大已批准范围。请自行阅读并遵守适用的 Steam 条款；项目不保证账号资格、页面可用性、卡牌掉落、成交或售价。

## 测试

安装 Node.js 22 或 24，在仓库根目录执行：

```sh
node scripts/test-offline.cjs
# 或已安装 npm 时
npm test
```

无需 npm install、账号、密钥或 Steam 连接。四套主测试加两个独立回归使用虚构数据与 mock DOM，覆盖逐资产锁、旧账迁移、超时、批准、费用、完整 cohort、上下文、持久化与不重放。CI 在 Linux/Windows、Node 22/24 上运行相同命令。离线通过不能证明真实页面选择器一直兼容。

本次发布前仅有真实浏览器的 helper 0.4.0/schema 2/READ_ONLY/NOT_SCANNED 加载检查；未进行真实交易，也未运行真实挂卡维护。

## 故障与恢复

- 429、网络失败、币种不支持、分页或扫描不完整：停止，保留错误分类；修复只读问题后重新核实完整证据。
- 提交/撤单结果未知或外层工具超时：保留原 owner、runner 和持久台账，不能重放、换执行者或启动第二 runner。先核对确切市场行及完整库存；未知结果继续锁定并停止全队列。
- pending 消失或库存缺失不证明在售或成交。分别报告待手机确认、确认后市场暂挂、在售、售出、未解决。
- 签出/身份不匹配：停下，由用户自行登录。不能读取 Cookie 或复用认证配置。
- Idle Master 托盘隐藏、零/单 helper、Fast 阶段不能直接判死。未知归属 helper 或其它实例存在时，不自动启动/重启；上游启动可能清理同用户 helper。

详见 [实时工作流](skills/steam-market-listing/references/live-workflow.md) 和 [Idle 排错](skills/idle-master-extended/references/troubleshooting.md)。

## 结构与贡献

`skills/` 保存安装单元（源码、references、agents 元数据和四套测试）；`tests/` 保存可移植独立回归；`scripts/` 是离线测试入口；`docs/` 是兼容说明；`.github/workflows/` 是无密钥 CI。

提交问题时提供版本、语言/币种、阶段、经过脱敏的最小复现。不要提交真实资产/挂单/任务台账、账号、截图、浏览器状态、配置、Cookie 或令牌。修改交易行为时加入有意义的离线回归并解释批准、持久化和未知结果语义。不要用在线真实交易作为CI。上游兼容修复应附官方来源与验证边界。

保留的历史见 [HISTORY.md](HISTORY.md)。本地原创内容使用 MIT；第三方引用和外部项目按各自许可，见 [来源](THIRD_PARTY_NOTICES.md)。
