# Deadstick

机场存活监测、人工复核、Telegram 通报与赛博墓园。用户入口为 **Telegram Bot + Mini App**：Bot 提供查询、通知与快捷操作，投稿、详情与管理操作在 Telegram 内的 Mini App 完成。`web/` 为 Mini App 与管理员后台共用的前端，不再扩展独立用户网站。

## 已实现

- 邮箱密码注册 / 登录、可撤销会话、CSRF、防暴力登录、管理员 / 审核员 / 用户权限。
- Telegram 新版 **OIDC + PKCE** 登录、自动注册、已有账号绑定，以及 Mini App `initData` 验签、时效和重放保护。OIDC `sub` 和 Bot API 用户 ID 分别存储。
- 机场资料、标签、多官网、多订阅；管理员直接录入或用户投稿后审核。订阅和原始机器人更新以 AES-256-GCM 加密存储。
- Bot 私聊支持直接发机场名、别名或官网域名，以及查询、关注、退订、报信和取消；关注需确认，对话上下文保留 15 分钟并支持跨 worker 接续。
- Bot 与 Mini App 统一搜索名称、标识、别名和公开官网域名。普通投稿只需名称和官网，自动生成标识；支持查重、给已有机场补线索、审核要求补充与本人补交，草稿不保存订阅凭据。
- 群管理员可在 Mini App 配置本群查询、通知范围、事件、话题、时区、静默、实时或日报、频率与口吻；个人可选择仅收人工结论。新群默认只开查询，旧绑定保留已有通知设置。
- 默认每 24 小时检测，按机场稳定错峰、分批入队；独立 worker、数据库队列、多 worker 抢占锁、租约、失败重试、过期任务接管、配置变更结果隔离。
- 官网 HTTP / TLS 检测、Clash YAML / sing-box / Base64 URI / Surge 订阅解析。订阅成功获取并解析出节点即有效；账号过期、流量额度与节点抽测作为参考信息，不参与机场健康判定。
- **真实代理出网模式**：使用 Mihomo 临时进程，经抽样节点访问 HTTPS 204 探针，验证代理握手和请求。也可明确选择 TCP 连通性模式。单节点配置经过白名单重建，节点域名解析后固定到公网 IP，不执行订阅中的全局配置、规则、外部 provider 或代理链。
- 只有官网和订阅全部失败才计入连败；部分失败仅显示「部分异常」，不触发异常事件或通知。连续失败达到阈值后，创建一次异常事件，通知允许的群和绑定的审核员；只有人工提交原因及证据后才能确认跑路。自动恢复会关闭检测触发的未确认异常；人工线索关联的复核保留到人工处理，已确认的墓碑只能人工复活。
- 墓园列表、墓志铭、献花 / 点烛 / 上香、每天每人每种一次、审核后的追悼留言、关注和状态变更通知。
- Telegram 机器人：HTML 卡片与彩色按钮、墓园分页、深链、追悼会实时计数、inline 分享、Guest Mode 回复、群内仅本人可见的 ephemeral 命令与回复、rich message 检测报告；审核员在私聊用按钮加回复完成异常复核、投稿与留言审核；群通过 `/bind` 或入群提醒绑定，支持论坛话题。
- 完整 Bot API JSON / multipart 管理调用入口，不裁剪新参数；持久化接收所有当前更新类型并保留未知字段。应用没有为支付、商务代聊等与机场监测无关的功能设计业务流程；这些能力可通过完整 API 入口调用，原始事件可在管理接口读取。
- 通知 outbox、429 `retry_after`、失败重试、死信重发、管理审计、worker 心跳、健康检查、数据保留期和 GitHub CI。

## 本地运行

需要 Node.js 24–26、pnpm 12 和 PostgreSQL 16+。真实代理出网模式另外需要 [Mihomo v1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)；Docker 镜像已经包含该二进制。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

在 `.env` 填写生成的 `APP_KEY`、本地 `DATABASE_URL`，并将 `MIHOMO_BIN` 指向已安装的 Mihomo。只需要端口连通性检测时，明确设置 `PROBE_MODE=tcp`。

```sh
pnpm migrate
# 在 .env 设置 ADMIN_TELEGRAM_ID（你的 Telegram 数字用户 ID）
pnpm admin
pnpm dev
# 另一个终端；API 和 worker 两个进程都必须运行
pnpm dev:worker
```

`pnpm admin` 按 `ADMIN_TELEGRAM_ID` 创建或提升管理员，随后从该 Telegram 账号打开 Mini App 即可进入管理台，无需邮箱密码。已有 Bot 用户会保留关注与投稿。也可留空该变量，改用 `ADMIN_EMAIL` + `ADMIN_PASSWORD` 初始化邮箱管理员，完成后移除密码。两种方式均会撤销该账号已有会话，公开登录永远不会自动分配管理员。

## Docker 部署

```sh
cp .env.example .env
# 填写 APP_KEY、POSTGRES_PASSWORD 和以下部署配置后运行：
docker compose up -d --build
docker compose run --rm api node dist/admin.js
```

部署时将 `.env` 的 `NODE_ENV` 设为 `production`，`PUBLIC_URL` 设为 API 的公网 HTTPS origin，`CORS_ORIGINS` 填前端允许的 origin（逗号分隔）。`DATABASE_URL` 的主机使用 `postgres`，数据库、用户名均为 `deadstick`，密码与 `POSTGRES_PASSWORD` 一致；密码包含特殊字符时按 URL 编码。API 默认只映射到宿主机 `127.0.0.1:3000`，在前面配置 HTTPS 反向代理。

Compose 包含 PostgreSQL、一次性迁移、API、worker。数据库没有暴露到宿主机。生产 `APP_KEY` 必须固定并与数据库分别备份；更换后旧订阅无法解密。按需对 Postgres 做常规备份。worker `/admin/health` 心跳超过 30 秒视为异常。

在反代后面部署时，`TRUST_PROXY` 填反代的实际 IP / CIDR，让限流按真实客户端 IP 计算；只信任受控反代，反代应覆盖客户端提供的转发头。留空时忽略转发头，同一个反代后的用户会共享 IP 限额。

## Telegram 配置

完整步骤、命令、深链、通知类型与排错见 [docs/telegram.md](docs/telegram.md)。最短路径：

1. 在 [BotFather](https://t.me/BotFather) 创建机器人，在后台「Telegram → 配置」填写 Bot Token 与用户名，Webhook 密钥留空自动生成；开启 inline mode、Guest Mode 和 **Main Mini App**，地址设为 `PUBLIC_URL`。也可通过环境变量提供初始配置，后台保存后优先生效。
2. Mini App 使用 Bot token 验签并自动登录，不需要 OIDC 凭据。管理员从外部浏览器登录时，可在同页填写 BotFather Login Widget 的 Client ID、Client Secret，登记页面显示的回调地址。
3. 保存后点「测试连接」和「初始化 Webhook 与菜单」，按页面提示补齐 BotFather 设置。也可运行 `pnpm telegram:setup`（容器内 `docker compose run --rm api node dist/telegram/setup.js`），命令会读取后台已保存的配置。
4. 用 `ADMIN_TELEGRAM_ID` 初始化管理员，私聊机器人点 Start，发送 `/admin` 打开管理台。在 Mini App「我的」开启 Bot 私信与审核待办私信；也可使用 `/notify`。其他用户先打开 Bot 或 Mini App，再由管理员按 Telegram ID 分配审核角色。
5. 把机器人加入群，本群管理员在群（论坛话题）里发送 `/bind` 或 `/groupsetup` 打开本群设置。新绑定默认只允许查询，主动通知需在 Mini App 中明确开启；普通群管不因此获得站内审核权限。

从旧版本升级时先停止旧 worker，运行迁移 `005`–`007`，再同步启动新版本 API 与 worker，并运行 `pnpm telegram:setup` 刷新 `/cancel`、`/groupsetup` 等命令菜单。旧 worker 不识别新通知策略，不可与已启用新群设置的 API 混用。没有新增环境变量。

邮箱和 Telegram 是独立身份；系统不会根据昵称合并账号。一个 Telegram 已经属于另一个账号时，绑定返回冲突；可用 Telegram 登录原账号，由管理员给该账号分配审核权限。关闭 Telegram 配置时，普通 REST API 和监测仍可独立使用。

OIDC 登录流程：`GET /auth/telegram/start?next=/console` 获得授权 URL → 浏览器打开 URL → 回调校验签名、issuer、audience、nonce、state、PKCE → 返回用户信息和会话 cookie，并回到站内目标页面。账号绑定使用已登录的 `POST /auth/telegram/link` 发起相同流程。Mini App 使用 `POST /auth/telegram/miniapp` 提交原始 `initData`，首次登录要求 5 分钟内签发，每份仅能创建一次会话；持有同账号有效会话和 CSRF 的页面可恢复该次启动。无有效会话时重复使用或重排同一凭据都会被拒绝。Bot、Mini App 与 OIDC 按 Telegram 用户 ID 对应同一账号。
已绑定 Telegram 且设置了邮箱密码的账号可以用 `DELETE /auth/telegram` 解绑；只有 Telegram 一种登录方式时返回 `LAST_LOGIN_METHOD`。

## 前端接入

以服务端路由的输入 schema 为准。返回字段采用 snake_case；请求参数采用文档里的 camelCase。

| 用途                              | 接口                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 注册 / 登录 / 当前用户 / 退出     | `POST /auth/register`、`POST /auth/login`、`GET /auth/me`、`POST /auth/logout`                                                         |
| 资料 / 改密 / 解绑 Telegram       | `PATCH /auth/me`、`POST /auth/password`、`DELETE /auth/telegram`                                                                       |
| 机场库 / 详情 / 检测记录 / 统计   | `GET /providers`、`GET /providers/:id`、`GET /providers/slug/:slug`、`GET /providers/:id/checks`、`GET /stats`                         |
| 墓园 / 祭奠 / 留言                | `GET /graveyard`、`POST /providers/:id/tributes`、`GET/POST /providers/:id/memorials`                                                  |
| 投稿 / 我的投稿                   | `POST /submissions`、`GET /submissions/mine`                                                                                           |
| 查重 / 本人投稿详情与补交         | `POST /submissions/check`、`GET/PUT /submissions/:id`                                                                                  |
| 已有机场线索                      | `POST /providers/:id/submissions`                                                                                                      |
| 关注                              | `PUT/DELETE /providers/:id/follow`、`GET /follows`                                                                                     |
| 管理列表 / 录入 / 修改 / 停启监测 | `GET/POST /admin/providers`、`GET/PUT /admin/providers/:id`、`PATCH /admin/providers/:id/monitoring`                                   |
| 投稿审核                          | `GET /admin/submissions`、`POST /admin/submissions/:id/review`                                                                         |
| 事件 / 发起复核 / 人工复核 / 复活 | `GET /admin/incidents`、`POST /admin/providers/:id/incidents`、`POST /admin/incidents/:id/resolve`、`POST /admin/providers/:id/revive` |
| 手动检测 / 任务 / 结果            | `POST /admin/providers/:id/check`、`GET /admin/jobs`、`GET /admin/checks/:id/results`                                                  |
| 设置 / 心跳 / 通知 / 审计         | `/admin/settings/monitor`、`/admin/health`、`/admin/notifications`、`/admin/audit`                                                     |
| 用户角色 / 留言审核               | `/admin/users?q=&role=`、`/admin/memorials?status=`                                                                                    |
| 机器人绑定 / 完整 API / 事件      | `/admin/telegram/chats`、`/admin/telegram/api/:method`、`/admin/telegram/updates`                                                      |
| Telegram 配置 / 个人审核私信      | `GET /auth/telegram/config`、`GET/PUT /admin/telegram/notifications`（审核员管理自己的待办私信）                                       |
| 管理员 Bot 配置 / 测试 / 初始化   | `GET/PUT /admin/telegram/settings`、`POST /admin/telegram/test`、`POST /admin/telegram/setup`                                          |
| 本群设置 / 通知测试               | `GET/PUT /telegram/groups/:id`、`POST /telegram/groups/:id/test`                                                                       |
| 个人通知偏好                      | `GET/PUT /telegram/notifications/preferences`                                                                                          |

`GET /providers`、`GET /graveyard`、`GET /admin/providers` 返回 `{ items, total, limit, offset }`。机场详情额外返回 `follower_count`、`memorial_count` 和 `following`（未登录为 `null`）。`GET /auth/me` 的 `user` 带 `has_password`，前端据此决定是否允许解绑 Telegram。

登录响应设置 `HttpOnly`、`SameSite=Lax` cookie（生产增加 `Secure`）并返回 `csrfToken`。前端请求启用 `credentials: include`，写操作在 `X-CSRF-Token` 中发送该值；刷新后从 `/auth/me` 读取。建议网站与 API 使用同一主域的子域或同源反代，不支持第三方站点跨站 cookie 登录。非浏览器客户端可从登录响应取会话 cookie，作为 `Authorization: Bearer <session>` 使用。

分页使用 `limit`（1–100）和 `offset`。`GET /providers` 还支持 `q`、`tag`、`lifecycle=active|suspected|dead`；搜索匹配名称、标识、别名和公开官网域名，按精确、前缀、包含排序，URL 查询先剥离路径和参数。异常响应为 `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`。

`POST /submissions` 的 `slug` 可省略，由服务端生成。`POST /submissions/check` 接收 `{ name, website? }`，只返回公开候选；`GET/PUT /submissions/:id` 仅限本人，只有 `needs_info` 可补交，未重新填写订阅时保留原加密订阅。已有机场线索接收 `{ kind: website|abnormal|evidence|review, body, website?, evidenceUrls? }`，内容仅本人和审核员可见。审核接口支持 `{ action: approved|rejected|needs_info, reason, revision }`，`revision` 必须对应审核员已查看的版本；版本变化返回 `409`，需要重新打开资料。原 `{ approve, reason }` 仍兼容初始版本，补交后须携带当前 `revision`。批准线索关联人工复核，不直接确认跑路。机场资料新增 `aliases`，旧管理员更新请求省略时保留原别名。

群设置接口每次校验当前本群管理员或站内管理员身份；群 ID 和 Mini App 链接不构成授权。策略字段以 `src/telegram/notification-policy.ts` 为准，查询开关与主动通知开关独立。个人通知偏好仅作用于本人的关注通知，不影响审核待办私信开关。

创建机场 / 投稿示例：

```json
{
  "name": "示例机场",
  "slug": "example-airport",
  "description": "机场公开资料",
  "tags": ["待观察"],
  "endpoints": [
    { "kind": "website", "label": "主站", "url": "https://example.com" },
    { "kind": "website", "label": "备用站", "url": "https://www.example.com" },
    {
      "kind": "subscription",
      "label": "监测订阅",
      "url": "https://sub.example.com/api?token=YOUR_PRIVATE_TOKEN"
    }
  ]
}
```

## 检测判定与边界

- 同类入口有一个通过，视为该类可用；部分失败为 `degraded`。所有官网或所有订阅失败为 `down`，不要求每个机场同时配置两类入口。默认连续两次异常后进入 `suspected`，不会自动确认跑路。
- `PROBE_MODE=proxy` 默认抽样 3 个节点，通过真实代理访问 `https://www.gstatic.com/generate_204`。Clash 支持 SS / SSR / VMess / VLESS / Trojan / Hysteria / Hysteria2 / TUIC / SOCKS5 / HTTP / AnyTLS；常见 URI、sing-box 格式转换为单节点配置。部分特殊插件、传输或未支持格式会得到不可判定的结果，不能据此宣布机场跑路。
- `PROBE_MODE=tcp` 只测试节点端口，**不能证明代理握手、凭据或实际出网可用**。`nodeSampleSize=0` 时只校验订阅内容与额度。检测结果明确记录 `probe_mode` / `nodeProbe`，不可判定的探针故障为 `unknown`，不增加机场失败次数。
- 检测只代表当前探针网络的观察结果。Cloudflare 防护、探针网络故障、单个监测订阅到期 / 没流量，均可能造成失败；人工复核须结合其它网络及公开证据。
- 官网与订阅只接受公网 HTTP(S)，端口限 80 / 443 / 8080 / 8443。DNS 所有地址和每次跳转都检查，连接固定解析结果，阻止回环、内网、链路本地、云元数据和 HTTPS 降级。节点代理端口可为任意有效端口，同样禁止连接非公网地址。
- 本地临时节点凭据文件权限为 0600，检测后销毁；Mihomo 仅监听 loopback，不开管理端口。部署进程以非 root 用户运行。
- 通知为至少一次投递；同一事件在入队时去重，但发送后立即断电等极端情况仍可能收到重复消息。无需发通知时可不配置机器人。

## 验证

```sh
# TEST_DATABASE_URL 指向专用测试数据库；角色需要 CREATE DATABASE 权限。
# 集成测试创建随机临时数据库，结束时仅删除自己创建的数据库。
TEST_DATABASE_URL=postgres://deadstick:deadstick@localhost:5432/deadstick_test pnpm check
```

包含单元测试、PostgreSQL + Fastify 请求集成测试、调度并发 / 接管、加密、SSRF、Telegram 验签与机器人交互测试。不设置 `TEST_DATABASE_URL` 时数据库测试明确跳过。CI 设置 PostgreSQL，执行完整测试、类型检查及构建，然后构建包含 Mihomo 的 Docker 镜像。

Telegram 和真实机场的在线联调需要你提供自己的 BotFather 配置与监测订阅，测试不会访问或修改任何真实机器人。

参考：[Telegram Bot API](https://core.telegram.org/bots/api)、[新版 Telegram Login](https://core.telegram.org/bots/telegram-login)、[grammY](https://grammy.dev/)、[Mihomo 源码与许可](https://github.com/MetaCubeX/mihomo/tree/v1.19.33)。

## 参与开发

- [CONTRIBUTING.md](CONTRIBUTING.md)：开发环境、代码约定、分支、提交、迁移与发布流程。
- [SECURITY_GUIDE.md](SECURITY_GUIDE.md)：编写与审查代码时的安全要求。
- [SECURITY.md](SECURITY.md)：漏洞报告方式与处理流程。
- [TODO.md](TODO.md)：待办与认领。
- [CHANGELOG.md](CHANGELOG.md)：版本变更记录。
