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

实测支持 `open.bigmodel.cn/api/mcp/<service>/mcp` 形态的
streamable-http MCP 服务(需 Bearer 鉴权 + MCP 会话握手):

| service | mcpURL | tool |
|---|---|---|
| 智能搜索 | `.../web_search_prime/mcp` | `web_search_prime`(默认) |
| 网页阅读 | `.../web_reader/mcp` | (非搜索语义,不建议) |

其他同形态服务改 `mcpURL` + `tool` 即可,参数进 `arguments` 由
`toolArguments` 扩展(见下)。

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
