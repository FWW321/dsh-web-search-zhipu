# dsh-web-search-zhipu

Zhipu BigModel 网页搜索 provider,接入 DeepSeek Harness (dsh) 的 web
能力缝(`ctx.web`)—— 与官方 `web-search-deepseek`、社区
`@tonydua/dsh-web-search-exa` 同一缝位,可被 `searchProvider` 选择器
选中/互切。

与 exa 包的设计差别:**端点固定,配置面 = 实际变量面**。端点与工具
是代码内常量(`web_search_prime`),不可配 —— 异语义组合(zread/
webReader)配不进来,Zhipu 换端点 = 改常量发版,不走配置旋钮。可配
的只有真正会变的:key、条数、额外参数。

## 端点(固定)

`open.bigmodel.cn/api/mcp/web_search_prime/mcp` 的
`web_search_prime` 工具(streamable-http MCP,Bearer 鉴权 + MCP
会话握手,实测)。同域的 `web_reader`(阅读,URL→正文)属 `ctx.web`
的 fetch 缝位(`registerFetchProvider`),与本包无关 —— 走
mcpServers 直挂或另做 fetch provider 包。

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
    count: 5                 # 请求未带 maxResults 时的缺省条数
    toolArguments:           # 额外 MCP 参数(search_domain_filter 等)
      search_domain_filter: nix.dev
```

会话管理:Zhipu MCP 要求 initialize → `mcp-session-id` →
`notifications/initialized` 握手后才接受 `tools/call`(无状态直调
拒以 -401,实测)。provider 缓存会话并复用;key 变更或服务端丢弃
会话时透明重握手,一次搜索内不会混用两个会话。

可观测:rc.6 **无**会话事件审计。官方 deepseek provider 的
`web/deepseek-search-llm-request` 之所以能写,是它注册在 harness 的
封闭已知事件集里(session-persistence KNOWN_SESSION_EVENT_TYPES);
仓库外插件事件读路径直接拒读(SessionFormatUnsupportedError,实测
中毒会话不可回放),且 ignorable 标记无公开写入口 —— 自定义审计
事件待上游开放注册面后再加。

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
