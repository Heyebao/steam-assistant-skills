# Compatibility / 兼容性

|功能|支持与验证范围|限制|
|---|---|---|
|只读 helper|Chrome用户脚本；0.4.0/schema 2；卡牌|实际仅加载检查；扫描/DOM依赖Steam页面；不提交|
|native runner|中文/CNY；app753；提交context6；市场观察context16；宿主cua Tab|四套mock主测试和两套独立回归；无真实交易验证|
|Idle技能|Windows；文档诊断和授权维护流程|没有新collector；未实际运行挂卡维护；外部二进制版本须核对|
|OpenCode + DeepSeek|技能文档和离线逻辑可复用，官方工具链有相应能力|MCP IO adapter未实现/端到端未验证；不是直接替换Tab|
|其他语言/币种/物品/浏览器|未承诺支持|需要独立验证原生流程|

完整评估及官方来源见 [OpenCode + DeepSeek](opencode-deepseek.md)。配置只是待验证路线，未安装工具或索取密钥。OpenCode V2有推荐新字段及受支持V1兼容规范化，不能笼统认为旧配置必然无效。
