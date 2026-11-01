# Deadstick

机场存活监测、人工复核、Telegram 通报与赛博墓园的 **TypeScript 后端**。没有网站或管理后台的视觉页面；前端通过 REST API 接入，交互文档位于 `/docs`，OpenAPI 位于 `/openapi.json`。

## 已实现

- 邮箱密码注册 / 登录、可撤销会话、CSRF、防暴力登录、管理员 / 审核员 / 用户权限。
- Telegram 新版 **OIDC + PKCE** 登录、自动注册、已有账号绑定，以及 Mini App `initData` 验签、时效和重放保护。OIDC `sub` 和 Bot API 用户 ID 分别存储。
- 机场资料、标签、多官网、多订阅；管理员直接录入或用户投稿后审核。订阅和原始机器人更新以 AES-256-GCM 加密存储。
- 默认每 24 小时检测，按机场稳定错峰、分批入队；独立 worker、数据库队列、多 worker 抢占锁、租约、失败重试、过期任务接管、配置变更结果隔离。
- 官网 HTTP / TLS 检测、Clash YAML / sing-box / Base64 URI / Surge 订阅解析、过期与流量额度检查、节点抽样检测。
- **真实代理出网模式**：使用 Mihomo 临时进程，经抽样节点访问 HTTPS 204 探针，验证代理握手和请求。也可明确选择 TCP 连通性模式。单节点配置经过白名单重建，节点域名解析后固定到公网 IP，不执行订阅中的全局配置、规则、外部 provider 或代理链。
- 连续失败达到阈值后，创建一次异常事件，通知允许的群和绑定的审核员；只有人工提交原因及证据后才能确认跑路。自动恢复会关闭未确认异常，已确认的墓碑只能人工复活。
- 墓园列表、墓志铭、献花 / 点烛 / 上香、每天每人每种一次、审核后的追悼留言、关注和状态变更通知。
- Telegram 搜索、状态、投稿、关注、献花、追悼会、回调按钮、inline 搜索、私聊人工复核、群白名单和论坛 topic 通知。
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
# 在 .env 设置 ADMIN_EMAIL 和至少 12 位的 ADMIN_PASSWORD
pnpm admin
# 随后从 .env 移除 ADMIN_PASSWORD
pnpm dev
# 另一个终端；API 和 worker 两个进程都必须运行
pnpm dev:worker
```

`pnpm admin` 也可对已有邮箱提升管理员权限或重设其密码，会撤销该用户已有会话。公开注册永远不会自动分配管理员。

## Docker 部署

```sh
cp .env.example .env
# 填写 APP_KEY、POSTGRES_PASSWORD 和以下部署配置后运行：
docker compose up -d --build
docker compose run --rm api node dist/admin.js
```

部署时将 `.env` 的 `NODE_ENV` 设为 `production`，`PUBLIC_URL` 设为 API 的公网 HTTPS origin，`CORS_ORIGINS` 填前端允许的 origin（逗号分隔）。`DATABASE_URL` 的主机使用 `postgres`，数据库、用户名均为 `deadstick`，密码与 `POSTGRES_PASSWORD` 一致；密码包含特殊字符时按 URL 编码。API 默认只映射到宿主机 `127.0.0.1:3000`，在前面配置 HTTPS 反向代理。

Compose 包含 PostgreSQL、一次性迁移、API、worker。数据库没有暴露到宿主机。生产 `APP_KEY` 必须固定并与数据库分别备份；更换后旧订阅无法解密。按需对 Postgres 做常规备份。worker `/admin/health` 心跳超过 30 秒视为异常。

## Telegram 配置

1. 在 [BotFather](https://t.me/BotFather) 创建机器人，将 token 填到 `TELEGRAM_BOT_TOKEN`。随机生成一个 32–256 位 URL 安全字符串，填入 `TELEGRAM_WEBHOOK_SECRET`。
2. 在 BotFather 的 Login Widget 设置里获取 OIDC Client ID / Secret，填入 `TELEGRAM_CLIENT_ID`、`TELEGRAM_CLIENT_SECRET`；登记精确回调 `${PUBLIC_URL}/auth/telegram/callback` 和网站 origin。这里的 Client Secret 不是 bot token。
3. API 和 worker 上线后运行 `pnpm telegram:setup`；容器内使用 `docker compose run --rm api node dist/telegram/setup.js`。该命令设置菜单和全部更新类型的 webhook，不丢弃积压更新。需要 inline 搜索时在 BotFather 启用 inline mode。
4. 审核员登录网站并通过 `/auth/telegram/link` 绑定 Telegram，私聊机器人点击 Start；管理员调用 `PUT /admin/telegram/chats/{Telegram用户ID}`，设置 `kind=admin`。绑定接口会核对该 Telegram ID 对应的后台审核权限。
5. 把机器人加入群，再通过同一接口绑定负数群 ID，设置 `kind=group`；论坛可加 `topicId`。只有启用的白名单群会收到通报、响应群内命令。群迁移为超级群时自动更新绑定。

邮箱和 Telegram 是独立身份；系统不会根据昵称合并账号。一个 Telegram 已经属于另一个账号时，绑定返回冲突；可用 Telegram 登录原账号，由管理员给该账号分配审核权限。关闭 Telegram 配置时，普通 REST API 和监测仍可独立使用。

OIDC 登录流程：`GET /auth/telegram/start` 获得授权 URL → 浏览器打开 URL → 回调校验签名、issuer、audience、nonce、state、PKCE → 返回用户信息和会话 cookie。账号绑定使用已登录的 `POST /auth/telegram/link` 发起相同流程。Mini App 使用 `POST /auth/telegram/miniapp` 提交原始 `initData`，有效期 5 分钟且每份只能使用一次。

机器人主要命令：

```text
/search 机场名
/status airport-slug
/follow airport-slug
/unfollow airport-slug
/graveyard
/tribute airport-slug
/memorial airport-slug 追悼留言
/ceremony airport-slug
/submit 名称 | airport-slug | https://官网 | https://订阅（仅私聊）
/review 事件UUID dead https://证据地址 核验原因（仅有权限者私聊）
```

完整 API 桥：`POST /admin/telegram/api/{method}` 接收原始 JSON 参数，`POST /admin/telegram/upload/{method}` 接收 multipart（总计 20 MiB），可传 `attach://字段名`。比如 `sendRichMessage`、ephemeral 参数、Business / Mini App / 新版 polls 等直接使用官方参数。全部调用仅管理员可用，审计记录方法名，不记录凭据或文件内容。标准 Telegram API 的文件、权限、付费和时效限制仍然适用。

## 前端接入

以 `/docs` 中的输入 schema 和 `/openapi.json` 为准。返回字段采用 snake_case；请求参数采用文档里的 camelCase。

| 用途                            | 接口                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| 注册 / 登录 / 当前用户 / 退出   | `POST /auth/register`、`POST /auth/login`、`GET /auth/me`、`POST /auth/logout`                  |
| 机场库 / 详情 / 检测记录 / 统计 | `GET /providers`、`GET /providers/:id`、`GET /providers/:id/checks`、`GET /stats`               |
| 墓园 / 祭奠 / 留言              | `GET /graveyard`、`POST /providers/:id/tributes`、`GET/POST /providers/:id/memorials`           |
| 投稿 / 我的投稿                 | `POST /submissions`、`GET /submissions/mine`                                                    |
| 关注                            | `PUT/DELETE /providers/:id/follow`、`GET /follows`                                              |
| 管理录入 / 修改 / 停启监测      | `POST /admin/providers`、`PUT /admin/providers/:id`、`PATCH /admin/providers/:id/monitoring`    |
| 投稿审核                        | `GET /admin/submissions`、`POST /admin/submissions/:id/review`                                  |
| 事件 / 人工复核 / 复活          | `GET /admin/incidents`、`POST /admin/incidents/:id/resolve`、`POST /admin/providers/:id/revive` |
| 手动检测 / 任务 / 结果          | `POST /admin/providers/:id/check`、`GET /admin/jobs`、`GET /admin/checks/:id/results`           |
| 设置 / 心跳 / 通知 / 审计       | `/admin/settings/monitor`、`/admin/health`、`/admin/notifications`、`/admin/audit`              |
| 用户角色 / 留言审核             | `/admin/users`、`/admin/memorials`                                                              |
| 机器人绑定 / 完整 API / 事件    | `/admin/telegram/chats`、`/admin/telegram/api/:method`、`/admin/telegram/updates`               |

登录响应设置 `HttpOnly`、`SameSite=Lax` cookie（生产增加 `Secure`）并返回 `csrfToken`。前端请求启用 `credentials: include`，写操作在 `X-CSRF-Token` 中发送该值；刷新后从 `/auth/me` 读取。建议网站与 API 使用同一主域的子域或同源反代，不支持第三方站点跨站 cookie 登录。非浏览器客户端可从登录响应取会话 cookie，作为 `Authorization: Bearer <session>` 使用。

分页使用 `limit`（1–100）和 `offset`。`GET /providers` 还支持 `q`、`tag`、`lifecycle=active|suspected|dead`。异常响应为 `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`。

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
