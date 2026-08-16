# dsh-web-search-zhipu

Zhipu BigModel 网页搜索 provider,接入 DeepSeek Harness (dsh) 的 web
能力缝(`ctx.web`)—— 与官方 `web-search-deepseek`、社区
`@tonydua/dsh-web-search-exa` 同一缝位,可被 `searchProvider` 选择器
选中/互切。

与 exa 包的设计差别:**零内置配置**。端点、密钥、工具参数全部由
用户在自己层里给(profile patch config / Settings 命名空间 /
环境变量)—— 包只注册 provider,不做任何缺省假定。默认值仅为
可直接跑的示例(web_search_prime 服务),每个字段都可覆盖。

## 端点(用户可配)

搜索语义的 streamable-http MCP 服务(需 Bearer 鉴权 + MCP 会话握手),
实测 `open.bigmodel.cn/api/mcp/web_search_prime/mcp`:

- `mcpURL`(默认即上式)与 `tool`(默认 `web_search_prime`)可配,是为
  Zhipu 将来其他**搜索**端点留的逃生口
- 同域的 `web_reader` 是**阅读**语义(URL→正文),属 `ctx.web` 的
  fetch 缝位(`registerFetchProvider`),与本包无关 —— 继续走
  mcpServers 直挂或另做 fetch provider 包

参数进 `arguments` 由 `toolArguments` 扩展(见下)。

## 配置

三个来源,优先级:Settings 命名空间 `web-search-zhipu`(热改)>
profile patch 行 `config` > 环境变量(仅 key)。

```yaml
# 用户 profile cordis.patch.yml(patch 行 config,或 settings 段同形)
- id: web-search-zhipu
  config:
    providerId: zhipu        # ctx.web 注册 id;多 Zhipu 型 provider 共存时才需改
    # apiKey: <literal>      # 二选一:字面 key(角色 secret)
    apiKeyEnv: ZHIPU_API_KEY # 或环境变量名(推荐,零明文)
    mcpURL: https://open.bigmodel.cn/api/mcp/web_search_prime/mcp
    tool: web_search_prime
    count: 5                 # 请求未带 maxResults 时的缺省条数
```

会话管理:Zhipu MCP 要求 initialize → `mcp-session-id` →
`notifications/initialized` 握手后才接受 `tools/call`(无状态直调
拒以 -401,实测)。provider 缓存会话并复用;端点/key 变更或服务端
丢弃会话时透明重握手,一次搜索内不会混用两个会话。

可观测:每次搜索调用记入发起 agent 的会话,事件
`web/zhipu-search-mcp-request` 载 `{ mcpURL, tool, arguments }` ——
合并后的最终参数(`toolArguments` 覆盖可见;官方 deepseek provider
同模式,其事件为 `web/deepseek-search-llm-request`)。

## Nix(nixdsh 消费)

```nix
programs.dsh = {
  webSearch = "zhipu";   # 选择器:选中此 provider
  webSearchProviders.zhipu.row = {
    name = "@fww/dsh-web-search-zhipu";
    config.apiKeyEnv = "ZHIPU_API_KEY";  # 其余字段走默认
  };
};
```

## 致谢

结构跟随 @tonydua/dsh-web-search-exa(MIT);seam 契约
(`WebSearchProvider`/`WebError` 稳定错误码/`installSettingsSection`)
来自 @deepseek-ai/dsh-web。

## License

MIT
