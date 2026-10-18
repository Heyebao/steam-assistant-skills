# OpenCode + DeepSeek 兼容性与迁移路线

核对日期：2026-10-18。本文根据项目源码、既有项目验证记录和下列官方文档整理；没有重新运行既有测试，也没有在 OpenCode 中安装组件、配置 API Key、运行 DeepSeek 或执行 Steam 交易。

**可以用 OpenCode + DeepSeek 完成同类工作，但需要给 OpenCode 配齐实际工具，再适配浏览器执行层。** 复制 skill 能复用规则、参考文档与离线代码；更换模型不会自动获得 Codex 会话里的浏览器、Windows 桌面或其他专用工具。当前项目不应宣传为“在 OpenCode 中开箱即用的全自动挂卡上架器”。

## 已有能力和验证边界

| 组件 | 当前状态 | OpenCode 中的处理方式 |
| --- | --- | --- |
| `idle-master-extended` | Windows Idle Master Extended 的诊断、安装、修复和配置指引；不是新的掉卡采集器 | 可以复用文档；实际进程、文件、窗口操作依赖 OpenCode 所在环境提供的工具 |
| `steam-market-listing` | 市场流程规则、参考文档与卡牌脚本 | 可以加载 skill；保持原有授权、精确身份核对、持久化和对账要求 |
| `steam-card-bulk-lister.user.js` | 0.4.0，audit schema 2；只读盘点、报价和锁状态；实际浏览器仅核实过安装版本及 `readOnly` 标记 | 在用户脚本管理器中运行，不依赖 DeepSeek；需重新验证 DOM、完整扫描及契约字段，不能据此宣称上架成功 |
| `steam-market-reprice-runner.cjs` 的纯逻辑 | 项目已有四组离线 Node 测试和两项独立 mock 探针通过 | 可在有兼容 Node.js 的环境继续测试；这些结果不等于 OpenCode/MCP 集成通过 |
| `makeNativeIO` | 已实现的适配器接收专用 cua `Tab`，调用 `tab.playwright.*`、`goto/reload/url` | **不能直接传入 MCP 客户端或普通 Playwright `Page` 并声称兼容**；需要明确的新 `io` 适配器和测试 |
| OpenCode → DeepSeek → 浏览器 MCP → 本项目 | 本项目尚未端到端验证 | 下文是官方支持能力之上的实施路线，交易适配仍待开发 |

现有 runner 支持的是中文界面、人民币、Steam app `753` 卡牌，保留原始提交 context `6`，市场观测 context 可为 `16`。切勿把观测 context 改写成提交 context，或把此实现泛化为任意游戏物品。源码导入本身不开始任务；`createRunner` 仍要求具体计划批准及持久化函数。

## 1. 先确认 OpenCode 版本

先检查 `opencode --version`，再选择相同版本的官方文档。官网同时有 V1 与 V2 文档；当前公开 [JSON schema](https://opencode.ai/config.json) 推荐原生 V2 字段：`providers`、`permissions`、`mcp.servers`。V1 常见写法是 `provider`、`permission`、`mcp.<name>`。V2 会兼容并规范化受支持的 V1 配置，转换可选；原生 V2 配置不能反向交给 V1 使用。不要在单个 provider/agent 内随意混用两种结构。[官方迁移说明](https://opencode.ai/v2/docs/migrate-v1/)

Windows 可以运行原生 OpenCode。V2 下载页目前提供独立 Windows CLI 和桌面版，并注明不支持 Windows 包管理器安装。V1 Windows 文档推荐 WSL，但浏览器 MCP 要操作本机 Chrome 时，原生 Windows 进程更便于减少跨环境连接问题——这是本文的实施选择，不是官方性能结论。已有 WSL 环境也可使用，但 Node、MCP、浏览器所在系统及路径必须分别核对。[V2 下载入口](https://opencode.ai/v2/docs/)、[V1 Windows/WSL 说明](https://opencode.ai/docs/windows-wsl/)

## 2. 复用完整 skill 目录

可把两个完整目录放进项目：

```text
.opencode/skills/
├── idle-master-extended/
│   ├── SKILL.md
│   └── references/...
└── steam-market-listing/
    ├── SKILL.md
    ├── references/...
    └── scripts/...
```

也可用 `.agents/skills/<name>/SKILL.md`；全局目录包括 `~/.config/opencode/skills`、`~/.agents/skills`、`~/.claude/skills`。`~` 指 OpenCode 实际运行用户的 home，WSL 与 Windows 的 home 不同。保留 scripts/references 的相对位置并避免重复 skill ID。现有小写连字符目录名及 `name`/`description` frontmatter 适合跨版本携带。[V1 skill 规范](https://opencode.ai/docs/skills/)

V2 以路径生成 skill ID，`name` 是显示名；可在提示中用 `@steam-market-listing` 显式加载。加载 skill 不会自动执行脚本，也不把所有参考文件全文一次性注入。Codex 的 `agents/openai.yaml` 应保留为 Codex 元数据；OpenCode 文档没有承诺解析它的界面设置、依赖或权限。OpenCode 自身权限应写进其配置，而非假定 YAML 里的 Codex 配置生效。[V2 skill 加载与元数据](https://opencode.ai/v2/docs/skills/)、[OpenCode agent 定义](https://opencode.ai/v2/docs/agents/)

## 3. 连接 DeepSeek，再验证工具调用

最稳妥的起点是运行 OpenCode，输入 `/connect`，选择 DeepSeek 并由本人输入自己的 API Key，再用 `/models` 选择实际可用模型。DeepSeek 官方有 OpenCode 集成指南，建议至少 `v1.18.30`；该页面的 Flash 显示名可能落后于最新模型更名，应以当前控制台、模型目录与 API 文档交叉核对。[DeepSeek 官方 OpenCode 指南](https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/)、[OpenCode provider 设置](https://opencode.ai/docs/providers/#deepseek)

核对时 DeepSeek 官方 API 主文档使用 `deepseek-flash` 与 `deepseek-v4-pro`；`deepseek-flash` 当前映射到 DeepSeek-V4.1-Flash-1017。不要把旧文章中的 `deepseek-chat`、`deepseek-reasoner` 或历史 Flash 名称写成永久不变的配置。[当前 API 入口与模型名](https://api-docs.deepseek.com/)

DeepSeek 支持工具调用，包括 thinking 模式。模型产生工具调用参数，由 OpenCode/MCP 执行工具并返回结果；模型 API 不因此得到本机浏览器控制权。[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)

若使用 Chat Completions 的 thinking + `tools`，客户端必须按当前官方要求完整回传历史 `reasoning_content`，包括没有调用工具的轮次，否则可报 400。空字符串处理曾在 OpenCode 引发实际兼容缺陷，上游已合并相关修复；这不代表任何旧版本、代理或自定义 provider 都验证通过。优先使用内置 DeepSeek provider，先在无交易页面做两到三轮只读工具调用及一次后续提问，再接 Steam。出现此类 400 应检查客户端版本、请求格式与 provider 适配；不要用重试交易补救。[DeepSeek thinking 规则](https://api-docs.deepseek.com/guides/thinking_mode/)、[OpenCode 修复 PR #24146](https://github.com/anomalyco/opencode/pull/24146)

## 4. 给 OpenCode 连接浏览器工具

### 路线 A：Playwright MCP + 官方浏览器扩展

这是复用当前已登录 Chrome/Edge 标签页的一条直接路线：本人安装官方 Playwright 扩展；本地 MCP 启动参数加 `--extension`；首次连接由本人选择目标标签并批准连接。官方扩展支持当前会话和已有扩展，多个客户端按标签组隔离；不要因此假设它能看到浏览器全部页面。此项目不需要导出 cookies、读取 Steam 凭据或绕过连接批准。[官方扩展说明](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)

Playwright MCP 也可启动自己的持久 profile；那是独立浏览器环境，不会自动继承用户平常 Chrome 的登录态。现行连接文档还提供 `--cdp-endpoint=chrome` 等附着方式，可按固定版本选择。[Playwright MCP 仓库](https://github.com/microsoft/playwright-mcp)、[官方浏览器连接说明](https://playwright.dev/mcp/configuration/browser-extension)

### 路线 B：Chrome DevTools MCP

官方支持 Chrome 144+ 的 `--autoConnect`：本人在 `chrome://inspect/#remote-debugging` 启用相应功能，再批准浏览器提示，连接现有登录会话。旧式 `--remote-debugging-port/pipe` 路线从 Chrome 136 起受默认用户数据目录限制；不要把这条限制与新授权附着方式混为一谈。需要端口的方案仅考虑本机回环地址，不公开暴露调试端口，也不复制日常 profile/cookies。[官方附着指南](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance)、[Chrome 136 官方变更](https://developer.chrome.com/blog/remote-debugging-port)

两个 MCP 都提供页面观察和交互，但不是 Windows 桌面控制器。当前 DevTools MCP 的 `--categoryExtensions` 还支持部分扩展生命周期操作和触发扩展 action，所以不能一概说“扩展页无法操作”；具体用户脚本管理器安装页、popup、内部页面是否可访问，仍须对选定发布版本实测。Playwright 官方扩展测试示例能打开扩展 HTML 页，也不等于所有工具栏弹窗都可自动操作。看不到的 Install/Update 等扩展控件交给本人完成。[DevTools 扩展能力](https://developer.chrome.com/docs/devtools/agents/extensions)、[Playwright 扩展测试边界](https://playwright.dev/docs/chrome-extensions)

### 可选配置模板：原生 Windows，OpenCode V2

以下字段结构已对照核对日的官方 schema；**未运行此模板，未验证端到端连通性**。使用已存在的内置 DeepSeek provider，模型由 `/models` 选择。真实 API Key 只通过本人配置的环境变量或 `/connect` 输入，不写入仓库。示例默认禁用浏览器 MCP，待本人完成安装、确认版本和目标标签后再启用。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "deepseek": {
      "settings": {
        "apiKey": "{env:DEEPSEEK_API_KEY}"
      }
    }
  },
  "permissions": [
    { "action": "*", "resource": "*", "effect": "ask" },
    { "action": "skill", "resource": "idle-master-extended", "effect": "allow" },
    { "action": "skill", "resource": "steam-market-listing", "effect": "allow" },
    { "action": "playwright_*", "resource": "*", "effect": "ask" }
  ],
  "mcp": {
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["cmd", "/c", "npx", "-y", "@playwright/mcp@latest", "--extension"],
        "disabled": true,
        "codemode": false
      }
    }
  }
}
```

OpenCode 的本地 MCP 命令是“程序及参数数组”，不是其他客户端常见的 `mcpServers` + `command`/`args` 结构。`codemode: false` 让初次排查时直接暴露工具；`opencode mcp list` 可检查服务器连接。`{env:...}` 是 OpenCode 的替换语法，JSON 里的 `$NAME` 不会被当 shell 变量展开；环境变量必须提供给实际 OpenCode 服务进程。[V2 MCP 配置](https://opencode.ai/v2/docs/mcp-servers/)、[V2 环境变量替换](https://opencode.ai/v2/docs/config/#variables)

`cmd /c npx` 来自官方 Windows 子进程兼容写法；用于 Playwright 是同一启动方式的适配，仍需本机验证。示例中的 `@latest` 方便辨认官方包，实施验收后应记录并固定实际版本。核对日 Playwright MCP 主线声明 Node `>=18`，DevTools MCP 为 `^20.19.0 || ^22.12.0 || >=23`；安装时以所选版本及依赖声明为准。[Windows 启动依据](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md#windows-10-error-during-discovery-for-mcp-server-chrome-devtools-mcp-error--32000-connection-closed)、[Playwright engines](https://github.com/microsoft/playwright-mcp/blob/main/package.json)、[DevTools engines](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/package.json)

权限模板属于工具审批配置，并不是浏览器只读沙箱。获得一次工具调用许可，也不等于批准一份交易计划；特别是 evaluate 类工具既可读页面也可执行修改。项目要求的交易批准、账户检查和人工环节仍需独立遵守。V2 规则以最后匹配项生效，MCP action 名通常是 `<server>_<tool>`；使用前还需核对全局配置和所选 agent 的后续覆盖规则。[官方权限语义](https://opencode.ai/v2/docs/permissions/)

## 5. runner 真正要补的适配层

建议保留 runner 的状态机，通过已有 `createRunner({ ledger, io, persist, ... })` 的 `io` 注入点新增适配器。适配器应在受控本地进程里维护三个独立且稳定的 market/inventory/sell 页面句柄，通过所选 MCP 的工具参数和结果实现以下边界，而不是要求模型每一步临时生成交易代码：

| `io` 契约 | 新适配器必须保留的行为 |
| --- | --- |
| `readMarket`、`readInventory` | 新鲜完整快照；同账户；精确 listing/asset 标识；helper 0.4.0/schema 2；扫描 generation 和锁状态 |
| `preflightNative`、`openNative`、`prepare/priceNative` | 原生页面预检；数量零预览；完整 item hash 和前缀；按批准金额填写并校准原生费用 |
| `verifyNative` | 在真实提交表单重新校验账户、精确物品、数量、买家支付、卖家实收及条款状态 |
| `cancel`、`clickSubmit/submit` | 仅使用已核实的原生界面控件；撤单/提交前完成持久化；禁止用 DOM evaluate 或 HTTP 请求替代交易点击 |
| `readResult`、`dismissResult` | 结果弹窗只作临时证据；最终仍用精确市场行和新鲜库存对账 |
| `persist` 和单一执行所有者 | 持久化成功才继续；同一 ledger、同一 owner；超时后检查现有执行状态，不重放结果未知的写操作 |

“native” 在这里指 Steam 原生网页流程，不表示 runner 能控制 Windows 原生窗口。Idle Master Extended、Steam 桌面客户端和系统安装窗口仍需单独的 Windows UI/进程适配，或者由用户依照 skill 手动完成。Playwright MCP/DevTools MCP 本身不补齐这部分。

新适配器至少要覆盖：工具超时但页面动作可能已完成、账户或页面切换、旧扫描、helper 缺失/不兼容、未知锁、价格/费用不符、撤单后返回 asset 集合变化、手机确认待处理、持久化失败及重复执行。先跑四组现有离线套件，再用 mock MCP 做相同不变量验证；最后只读连接真浏览器并校验数量零页面。当前仓库没有宣称这些新 MCP 测试已经实现或通过。

按前文安装到项目 `.opencode/skills` 后，可从项目根目录执行已有离线套件：

```powershell
node .opencode/skills/steam-market-listing/scripts/test-steam-market-reprice.cjs
node .opencode/skills/steam-market-listing/scripts/test-steam-market-reprice-staged.cjs
node .opencode/skills/steam-market-listing/scripts/test-steam-market-native-io.cjs
node .opencode/skills/steam-market-listing/scripts/test-steam-market-helper-contract.cjs
```

## 6. 分阶段验收

1. **文档与离线代码**：OpenCode 能显式加载两个 skill、读取其参考文件并运行四个已有 Node 测试；此阶段不连接 Steam。
2. **模型与工具链**：DeepSeek 在无交易页面连续完成多轮只读工具调用；记录 OpenCode、Node、模型/provider、MCP 版本和连接方式。
3. **浏览器只读盘点**：本人登录和批准目标标签；核对 helper 版本、`readOnly`、schema、账户、完整性、generation、数量及锁；结果与可见页面人工抽查一致。
4. **适配器与预览**：新增 `io` 适配器通过离线/mock 用例，真浏览器仅做数量零预览及费用校准；还不能用“配置成功”代替交易验证。
5. **另行批准交易**：只有完整、具体、可复核的账户/物品/数量/价费/总额计划获得用户授权后，才可考虑一次小范围原生操作与完整对账。授权前不撤单、不上架。未接受条款、登录/验证码/二步验证、手机确认和不可访问的扩展控制由用户完成。

## 第三方许可和来源维护

本仓库可以只记录官方 MCP 包的配置方式，不需要复制第三方实现。若以后复制或修改 Playwright MCP/Chrome DevTools MCP 源码，两者核对时均为 Apache-2.0：分发时保留许可证及相关署名，标示修改；上游有适用 NOTICE 时一并保留。项目自身 skill/scripts 的许可证与第三方组件许可证分别记录；依赖许可也要按实际分发内容保留。[Playwright LICENSE](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE)、[Chrome DevTools MCP LICENSE](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/LICENSE)

上文链接均为官方文档或官方项目源码。网页和 `main` 分支会变化；实现适配时应补上实际 release/tag/commit、测试日期和环境，只有完成相应验证后才把本表中的“待适配/未验证”改为已支持。

## 发布验证补记

研究阶段没有重新运行既有测试。随后公开发布阶段已在本地和远端重新克隆副本运行六套离线测试，均通过；GitHub Actions 的 Linux/Windows × Node 22/24 四个任务也实际成功。该结果仅验证本项目离线代码，不改变 OpenCode/DeepSeek/MCP 端到端尚未运行的边界。首次成功的 [CI 记录](https://github.com/Heyebao/steam-assistant-skills/actions/runs/39129729624) 对应公开打包提交。
