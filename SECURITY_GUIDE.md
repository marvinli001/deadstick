# 安全开发指南

本文件规定在本仓库编写和审查代码时必须遵守的安全要求。Deadstick 会代表用户访问不受信任的机场网站和订阅、运行代理探针，并保存订阅凭据与 Telegram 身份，以下规则针对这些风险。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 凭据与配置

- 凭据只通过环境变量提供。`.env` 已被 `.gitignore` 忽略，不得提交；`.env.example` 只写空值或明显的占位符。
- 测试与文档中的 token、订阅地址、密码一律使用虚构值，如 `YOUR_PRIVATE_TOKEN`。
- `APP_KEY` 用于加密订阅地址、PKCE verifier 与机器人原始更新。生产环境的 `APP_KEY` 必须固定，与数据库分开备份；更换后已有密文无法解密。
- 凭据泄露时：机器人 token 在 BotFather 重新生成，`TELEGRAM_WEBHOOK_SECRET` 更换后重新运行 `pnpm telegram:setup`，OIDC Client Secret 在 BotFather 重置，数据库密码同步修改 `POSTGRES_PASSWORD` 与 `DATABASE_URL`。`APP_KEY` 泄露需要重新加密全部密文，目前没有现成工具，见 [TODO.md](TODO.md)。
- `ADMIN_PASSWORD` 只供 `pnpm admin` 初始化使用，完成后从 `.env` 移除。

## 认证与权限

- 权限在服务端判断。路由通过 `preHandler: authenticated`、`reviewer` 或 `administrator` 声明访问级别，前端隐藏按钮不构成权限控制。
- 任何改变状态的操作都不得使用 `GET`、`HEAD`、`OPTIONS`。Origin 与 CSRF 校验只作用于其他方法。
- 浏览器使用 `session` cookie（`HttpOnly`、`SameSite=Lax`，生产环境 `Secure`），写请求携带 `X-CSRF-Token`。`Authorization: Bearer` 只用于非浏览器客户端，此时跳过 CSRF 校验。
- 会话令牌只以 SHA-256 摘要入库，密码使用 scrypt 加盐哈希，比较密钥、签名或令牌使用 `src/crypto.ts` 的 `equal()`。
- 公开注册不分配任何特权角色。修改角色、重设密码、禁用账号后需撤销该用户的已有会话，并保留最后一个管理员。
- 邮箱与 Telegram 是独立身份，不得根据昵称、用户名或邮箱自动合并账号。

## 输入校验

- 每个路由声明 TypeBox schema，字符串设置长度上限，枚举使用字面量联合。Ajv 配置为 `removeAdditional: false`，不要放宽。
- SQL 一律参数化。动态排序或筛选字段从固定白名单中选取，不拼接请求值。
- 公开的写接口（注册、登录、投稿、祭奠、留言等）需要单独的路由级限流：`config: { rateLimit: { max, timeWindow } }`。全局默认限流为每分钟 120 次。
- 部署在反代后面时，限流依赖 `TRUST_PROXY` 只信任受控反代地址，不要在代码中读取 `X-Forwarded-For` 自行判断客户端 IP。

## 对外请求

机场官网和订阅地址由用户提供，一律视为不可信目标。

- 访问用户提供的 URL 只能使用 `src/monitor/network.ts` 的 `safeFetch()`；TCP 连通性只能使用 `probeTcp()`。不要对这类地址直接调用 `fetch`、`undici` 或 `net.connect`。
- `safeFetch()` 负责：仅允许 HTTP(S)，端口限 80 / 443 / 8080 / 8443；拒绝带用户名密码的 URL；每一跳重定向都重新校验并重新解析 DNS；任一解析结果为非公网地址即拒绝；连接固定到已校验的 IP，防止 DNS 重绑定；禁止 HTTPS 降级；限制响应体大小与超时。修改这些行为必须附带 `test/network.test.ts` 中的对应测试。
- 扩大端口白名单、放开内网地址或增加重定向次数都属于安全变更，需要在 PR 中说明理由。
- 固定的第三方地址（Telegram Bot API、`oauth.telegram.org`、探针使用的 `https://www.gstatic.com/generate_204`）可以直接请求，但不得拼接用户输入。

## 代理探针

`src/monitor/proxy.ts` 会把订阅中的节点交给 Mihomo 运行。订阅内容可能是恶意构造的。

- 只从订阅中提取单个节点，并经 `safeProxyConfig()` 按协议、传输、字段与嵌套字段的白名单重建。订阅中的全局配置、规则、DNS、外部 provider、`dialer-proxy` 等代理链字段、插件命令一律不进入探针配置。
- 节点地址先经 `resolvePublic()` 解析为公网 IP，再写入 `server`，探针不再做域名解析。
- 探针配置必须保持：`bind-address: 127.0.0.1`、`allow-lan: false`、`external-controller` 为空、`dns.enable: false`、唯一规则 `MATCH,probe`。配置文件权限 `0600`，子进程只继承 `PATH` 与临时 `HOME`，结束时强制终止并删除临时目录。
- 向白名单添加字段前，确认该字段不能引入第二个连接目标、读取本地文件或执行命令，并在 `test/proxy.test.ts` 补充用例。
- 升级 Mihomo 版本（`Dockerfile` 中的镜像标签）单独提交 PR，并检查上游发布说明中与配置解析、监听和外部控制相关的变化。

## 敏感数据

- 订阅地址经 `encrypt()` 加密后存入 `endpoints.url_ciphertext`。公开接口只返回 `display_host`，以及官网类入口的 `public_url`；订阅的完整地址、查询参数与密文不得出现在任何响应中。
- 解密后的订阅地址、节点凭据只能在检测流程内存中使用，不得写入日志、审计 `details`、错误信息、检测结果或 Telegram 消息。
- 请求日志只记录方法、去掉查询串的路径和客户端 IP，并对 `authorization`、`cookie`、`x-csrf-token`、`x-telegram-bot-api-secret-token`、`set-cookie` 脱敏。新增承载凭据的请求头时，同步加入 `src/app.ts` 的 `redact` 列表。
- 500 错误只记录错误类型与错误码，响应只返回通用信息与 `requestId`。
- 机器人原始更新加密存入 `bot_updates`，仅管理员可读。新增存储个人数据或临时凭据的表时，同步加入 `src/monitor/queue.ts` 的 `cleanup()`。

## Telegram

- Webhook 必须校验 `X-Telegram-Bot-Api-Secret-Token`，使用常量时间比较。
- 用户身份只来自 Telegram 签名的数据：webhook 中的 `from.id`、OIDC `id_token`、Mini App `initData`。不要信任转发消息、命令参数或前端提交的用户 ID，也不要使用 Mini App 的 `initDataUnsafe`。
- OIDC 回调校验签名、issuer、audience、nonce、state 与 PKCE；站内返回路径绑定到授权挑战并拒绝外部地址。Mini App 首次登录校验签名、5 分钟时效，规范化完整字段后防止重排绕过重放保护；只有持有同账号有效会话与 CSRF 才能恢复已验证启动。修改时须保留 `test/core.test.ts` 与 `test/integration.test.ts` 中的相关测试。
- 群内命令只响应已启用的白名单群；投稿和人工复核只在私聊中处理，复核时按数据库中的当前角色判断权限。回调按钮的 `callback_data` 视为用户输入，重新校验目标与权限。
- 白名单之前只允许三类处理：`my_chat_member`（入群提醒、被移出后停用绑定）、`/bind` `/unbind`（要求网站角色为 admin）和 Guest Mode 回复。Guest Mode 与 inline 结果只读，只带链接按钮或祭奠按钮，不得加入任何改变审核、绑定或账号状态的按钮。
- 按钮不能单独改变复核结论。确认跑路、恢复、排除和驳回投稿必须由审核员回复机器人自己发出的 force reply 提示，提示必须由本机器人发送（`reply_to_message.from.id` 等于机器人 ID），保存前重新按数据库角色判断。
- 机器人消息使用 HTML `parse_mode`。所有来自用户或机场资料的内容（名称、slug、描述、墓志铭、留言、复核原因、投稿人昵称）都必须经过 `src/telegram/format.ts` 的 `escape()`；链接属性额外转义双引号。新增消息模板时附带转义测试。
- 机器人消息与通知里不得出现订阅地址或其主机名；投稿通知只显示官网域名和订阅数量。
- `/admin/telegram/api/:method` 与 `/admin/telegram/upload/:method` 只对管理员开放，审计只记录方法名，不记录参数、文件或凭据。

## 前端

- 请求 API 时使用 `credentials: 'include'`，写请求携带登录或 `/auth/me` 返回的 `csrfToken`。不要把会话令牌存入 `localStorage`、`sessionStorage` 或 URL。
- 网站与 API 同源部署。本地开发时通过 Vite 代理转发 API 请求，或把开发服务器的 origin 加入 `CORS_ORIGINS`；不要使用通配符。
- 机场名称、描述、墓志铭、追悼留言等用户提供或可编辑的内容一律按文本渲染。不要使用 `innerHTML`、`dangerouslySetInnerHTML`、`v-html` 等方式插入这些内容；确需富文本时，使用白名单清洗库并经安全审查。
- 机场官网链接只渲染 `http:` / `https:` 地址，添加 `rel="nofollow noopener noreferrer"`，并明确标示为外部站点。
- Telegram 登录走后端的 `/auth/telegram/start` 流程；Mini App 把原始 `initData` 提交给 `POST /auth/telegram/miniapp`，前端不自行验证身份。
- 页面的 Content-Security-Policy 由 Fastify 的 helmet 下发。Mini App 仅额外允许 `https://telegram.org`，用于加载官方 `telegram-web-app.js`，不信任 `initDataUnsafe`。不引入其他未经审查的第三方脚本；确需放宽 CSP 时在 PR 中说明来源与理由。

## 依赖与构建

- 安装依赖使用 `pnpm install --frozen-lockfile`。新增依赖时检查维护状态、下载量与安装脚本；需要构建脚本的依赖须显式加入 `pnpm-workspace.yaml` 的 `allowBuilds`。
- 生产镜像以非 root 的 `node` 用户运行，API 默认只映射到宿主机 `127.0.0.1`，数据库不暴露端口。不要在 `compose.yml` 中改变这些默认值。
- CI 工作流保持 `permissions: contents: read`。新增第三方 Action 需固定版本，并在 PR 中说明用途。

## 审查清单

涉及安全相关代码的 PR，审查者逐项确认：

- [ ] 新路由声明了 schema、访问级别与必要的路由级限流；状态变更没有使用 `GET`。
- [ ] SQL 全部参数化，没有拼接请求值。
- [ ] 对用户提供的 URL 和节点只通过 `safeFetch()`、`probeTcp()`、`probeProxy()` 访问。
- [ ] 代理探针白名单与隔离配置没有被放宽，或放宽有充分理由与测试。
- [ ] 订阅地址、token、会话、密码没有进入响应、日志、审计、错误信息或 Telegram 消息。
- [ ] Telegram 身份来自签名数据，群命令遵守白名单，复核在私聊中按当前角色判断。
- [ ] 用户内容在前端按文本渲染，在 Telegram 中经过 `escape()` 转义。
- [ ] 新增环境变量有校验，敏感项没有默认值，`.env.example` 未包含真实值。
- [ ] 迁移没有删除仍在使用的列，个人数据纳入保留期清理。
- [ ] 安全行为的变化有对应测试，且测试不访问真实服务。
