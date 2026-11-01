# Telegram 机器人配置

本文说明 Deadstick 机器人从创建到上线的全部配置：BotFather 设置、环境变量、初始化命令、审核员与通报群绑定、群内与跨聊天的交互方式，以及排错方法。机器人基于 Bot API 10.3（grammY 1.46）。

用户入口以 **Bot + Telegram Mini App** 为主。Bot 承担搜索、状态卡片、关注、通知与快速审核；复杂表单和管理操作复用 `web/` 页面，在 TG 内打开。Mini App 自动验证 Telegram 身份，带底部导航、原生返回与安全区适配，保持项目的浅色视觉。

## 功能与依赖的配置

| 功能                               | 需要的配置                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| 命令、按钮卡片、墓园、追悼会、关注 | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、HTTPS `PUBLIC_URL`          |
| 深链、通知里的“在机器人中查看”     | `TELEGRAM_BOT_USERNAME`                                                      |
| 网站登录与账号绑定（OIDC）         | `TELEGRAM_CLIENT_ID`、`TELEGRAM_CLIENT_SECRET`，BotFather 登记回调与 origin  |
| Mini App 登录与菜单按钮            | BotFather 配置 Mini App 域名为 `PUBLIC_URL`                                  |
| `@机器人 关键词` 分享卡片          | BotFather 开启 inline mode                                                   |
| 在未加入的群里被 @ 时回复          | BotFather 开启 Guest Mode                                                    |
| 群里仅自己可见的命令与回复         | 运行 `pnpm telegram:setup`（命令带 `is_ephemeral`），客户端支持 Bot API 10.2 |
| 异常、投稿、留言的私信复核         | 审核员绑定 Telegram 后私聊 `/notify` 开启                                    |
| 群通报                             | 机器人入群后用 `/bind` 或后台接口绑定                                        |

API 与 worker 两个进程都要运行：API 接收 webhook 并把更新加密写入 `bot_updates`，worker 依次处理更新并从通知 outbox 发送消息。没有配置机器人时，网站与检测照常工作。

## 1. 在 BotFather 创建和设置机器人

1. 在 [@BotFather](https://t.me/BotFather) 发送 `/newbot`，记下 token 和用户名（不带 `@`）。
2. `/setjoingroups` 选 Enable，允许机器人被加入群。
3. `/setprivacy` 保持 Enable（隐私模式）。机器人只需要接收命令、按钮和对它的回复，不读取群聊全文。
4. `/setinline` 开启 inline mode，占位符建议填 `机场名或 slug`。需要统计分享量时再用 `/setinlinefeedback`。
5. 在 BotFather 的 Mini App（`/mybots` → 选择机器人 → Bot Settings）中：
   - 开启 **Guest Mode**，让用户在机器人不在的群里 `@机器人 机场名` 查询。
   - **Configure Mini App** 启用 **Main Mini App**，地址设为 `PUBLIC_URL`。这是群消息与通知里的 `?startapp=` 链接能直接打开 TG 内页面的前提。Bot API 10.2 起默认禁止从其他 origin 调用 Mini App 方法，保持开启即可。
6. 网站登录：在 BotFather 的 **Login Widget / Web Login** 设置里取得 OIDC Client ID 和 Client Secret，登记精确回调 `${PUBLIC_URL}/auth/telegram/callback` 和网站 origin。Client Secret 与 bot token 是两个不同的值。
7. 不需要开启 Business（Secretary Mode）、Payments、Bot-to-Bot Communication 或 Managed Bots。机器人会持久化这些更新，但没有对应的业务流程；需要时通过管理员的完整 Bot API 入口操作。

机器人的名称、头像和简介可以在 BotFather 里改；简介和短简介也会被 `telegram:setup` 覆盖为项目默认文案。

## 2. 后台配置与环境变量

推荐在管理员后台「Telegram → 配置」填写 Bot Token 和用户名，Webhook 密钥留空会自动生成。保存后点击「测试连接」，再点击「初始化 Webhook 与菜单」。同页可选填网页 Telegram 登录的 Client ID 与 Client Secret，Mini App 无需填写；Client ID 留空会关闭网页 Telegram 登录。公网地址由部署环境的 `PUBLIC_URL` 决定，页面显示对应的 Webhook 与登录回调地址。

后台配置使用 `APP_KEY` 加密保存在数据库，页面只显示密钥是否已设置。密钥输入留空保留已有值；保存后优先于下表中的环境变量，API 在下次请求读取，worker 最迟约 1.5 秒后读取，无需重启。更换 Token、用户名或 Webhook 密钥后重新初始化；初始化不会丢弃 Telegram 的待处理更新。首次尚未接入 Telegram 时，可先用邮箱管理员进入后台配置。

| 变量                      | 说明                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | BotFather 给的 token。设置后 worker 才会处理更新和发送通知。                              |
| `TELEGRAM_BOT_USERNAME`   | 机器人用户名，不带 `@`。`telegram:setup` 会核对它与 token 是否一致；深链按钮依赖它。      |
| `TELEGRAM_WEBHOOK_SECRET` | 32–256 位的 `A-Z a-z 0-9 _ -` 随机串，Telegram 每次推送都带上它，API 用常量时间比较校验。 |
| `TELEGRAM_CLIENT_ID`      | OIDC Client ID，和 `TELEGRAM_CLIENT_SECRET` 必须同时设置。                                |
| `TELEGRAM_CLIENT_SECRET`  | OIDC Client Secret。                                                                      |
| `PUBLIC_URL`              | 网站与 API 的公网 HTTPS origin。webhook、Mini App 和消息里的网站按钮都使用它。            |
| `ADMIN_TELEGRAM_ID`       | 仅由 `pnpm admin` 读取，按 Telegram 数字用户 ID 创建或提升管理员，不需要邮箱密码。        |

生成 webhook secret：

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`PUBLIC_URL` 不是 `https://` 时，消息里不会出现网站按钮（Telegram 拒绝本地地址的按钮），`telegram:setup` 也会拒绝运行。本地联调可以用 HTTPS 隧道作为 `PUBLIC_URL`。连接检查会分别显示 Main Mini App、Inline、Guest、群组与隐私模式的状态，未开启的能力需要在 BotFather 设置。

## 3. 初始化

API 和 worker 上线、迁移完成后，在后台点「初始化 Webhook 与菜单」，或运行读取相同配置的命令：

```sh
pnpm telegram:setup
# Docker
docker compose run --rm api node dist/telegram/setup.js
```

命令依次完成：

- 用 `getMe` 核对 `TELEGRAM_BOT_USERNAME`。
- 按作用域设置命令菜单：私聊（`default`、`all_private_chats`）、所有群（`all_group_chats`，个人类命令带 `is_ephemeral`）、群管理员（`all_chat_administrators`，额外显示 `/bind`、`/unbind`），以及每位绑定 Telegram 的审核员（`chat` 作用域，额外显示 `/admin`、`/pending`、`/notify`、`/review`）。审核菜单不依赖私信通知开关。
- 设置简介、短简介，把聊天菜单按钮设为打开 `PUBLIC_URL` 的 Mini App。
- 设置 webhook `${PUBLIC_URL}/telegram/webhook`，订阅全部更新类型，不丢弃积压。
- 输出 JSON 报告：

```json
{
  "bot_username": "deadstick_bot",
  "bot_name": "Deadstick",
  "webhook_url": "https://example.com/telegram/webhook",
  "pending_updates": 0,
  "last_error": null,
  "reviewer_menus": 2,
  "unreachable_reviewers": 0,
  "hints": ["Guest mode is off: BotFather Mini App > Bot Settings > Guest Mode"]
}
```

`hints` 列出 BotFather 里尚未开启的能力；`unreachable_reviewers` 是还没私聊机器人点过 Start 的审核员数量。命令列表变化、域名变化或升级版本后重新运行；它是幂等的。

## 4. 审核员接收复核私信

1. 管理员在服务器的环境变量设置自己的 `ADMIN_TELEGRAM_ID`，运行 `pnpm admin`。已有邮箱管理员也可通过“绑定 Telegram”（`POST /auth/telegram/link`）关联身份，账号不会按昵称或邮箱自动合并。
2. 私聊机器人点 **Start**，发送 `/admin` 打开 Mini App 管理台。其他用户先打开 Bot 或 Mini App，由管理员在「用户」里按 Telegram ID 分配角色。
3. Mini App「我的」点 **接收 Bot 私信**，开启 **审核待办私信**；也可私聊 `/notify` 点 **开启**。异常复核、新投稿、待审留言都会私信给你。关闭通知不会移除审核命令。

后台修改角色或停用账号后，命令菜单通过 outbox 同步，发送时重新读取当前角色；权限判断立即生效。`/start` 和 `/app` 也会刷新当前私聊的角色菜单。`GET/PUT /admin/telegram/notifications` 只管理当前审核员自己的通知开关，写入需要登录和 CSRF。

管理员也可以调用 `PUT /admin/telegram/chats/{Telegram用户ID}`，`{"kind":"admin","enabled":true}` 代为开启。接口会核对该 Telegram 账号当前是否属于审核员。账号被降级或停用后，私信与按钮操作都会立即失效，因为每次操作都按数据库里的当前角色判断。

“机器人被加入新群”“机器人离开通报群”这类提醒只发给管理员，不发给审核员。

## 5. 绑定通报群

只有已启用的绑定群会收到通报、响应群命令。三种绑定方式：

- **入群提醒**：把机器人加入群后，管理员会收到私信，点 **绑定为通报群**。操作人须同时具有 Deadstick 管理员与该群管理员权限。
- **群内命令**：管理员（网站角色 admin，已绑定 Telegram，并且是该群管理员）在群里发送 `/bind`。在论坛群的某个话题里发送时，通报会发到该话题；`/unbind` 取消。
- **后台接口**：`PUT /admin/telegram/chats/{负数群ID}`，`{"kind":"group","enabled":true,"topicId":12}`。

机器人被移出或封禁时，绑定会自动停用并提醒管理员，重新入群后再 `/bind` 一次。普通群升级为超级群时，绑定与待发通知会跟随新群 ID。

隐私模式下，机器人在群里收到的是带 `@机器人` 的命令、对机器人消息的回复和按钮回调。不需要给机器人管理员权限；如果给了管理员权限，Telegram 允许它随时向群成员发送仅本人可见的消息。

## 6. 交互方式

### 命令

| 命令                                   | 范围     | 说明                                                             |
| -------------------------------------- | -------- | ---------------------------------------------------------------- |
| `/start`                               | 私聊     | 欢迎卡片、Telegram ID、搜索 / 墓园 / Mini App 按钮；处理深链参数 |
| `/app`                                 | 私聊     | 打开 Mini App，刷新角色命令菜单                                  |
| `/me`                                  | 私聊     | 我的关注、投稿与账号入口                                         |
| `/admin`                               | 审核员   | Telegram 内管理台、异常、投稿审核；管理员另有机器人设置入口      |
| `/help`                                | 全部     | 命令说明                                                         |
| `/search 名称`                         | 全部     | 结果列表按钮；只有一个结果时直接显示卡片                         |
| `/status slug`                         | 全部     | 机场卡片：状态、最近检测、墓志铭、祭奠数，以及操作按钮           |
| `/graveyard`                           | 全部     | 墓园分页列表                                                     |
| `/ceremony slug`                       | 全部     | 电子追悼会卡片，献花 / 点烛 / 上香后计数实时刷新                 |
| `/tribute slug [献花\|点烛\|上香]`     | 全部     | 祭奠，每人每天每种一次                                           |
| `/memorial slug 留言`                  | 全部     | 追悼留言，审核后公开                                             |
| `/follow slug`、`/unfollow slug`       | 全部     | 关注后状态变化会私信通知                                         |
| `/following`                           | 全部     | 我的关注列表                                                     |
| `/submit 名称 \| slug \| 官网 \| 订阅` | 私聊     | 投稿；多个官网用空格分隔，订阅可省略                             |
| `/pending`                             | 审核员   | 待处理的异常、投稿、留言                                         |
| `/notify`                              | 审核员   | 开关复核私信                                                     |
| `/review 事件ID 结论 证据URL 原因`     | 审核员   | 文字复核，结论为 `dead`、`recovered`、`dismissed`                |
| `/bind`、`/unbind`                     | 群管理员 | 绑定或取消通报群                                                 |

### 群内仅本人可见（Bot API 10.2+）

`telegram:setup` 把 `/help`、`/search`、`/status`、`/tribute`、`/memorial`、`/follow`、`/unfollow`、`/following` 注册为 ephemeral 命令：用户在群里发送时，命令本身和机器人的回复只有他自己能看到。`/graveyard`、`/ceremony` 保持公开，方便群里一起祭奠。

在群里点卡片上的“检测记录”、列表里的机场、翻页等按钮时，结果以仅本人可见的消息显示，不改动别人看到的原消息。Telegram 要求这类回复在 15 秒内发出，机器人在发送失败时会改为提示用户到私聊里查看。

### 深链

| 链接                                 | 打开的内容       |
| ------------------------------------ | ---------------- |
| `https://t.me/<bot>?start=p_<id>`    | 机场卡片         |
| `https://t.me/<bot>?start=c_<id>`    | 电子追悼会       |
| `https://t.me/<bot>?start=r_<id>`    | 检测记录         |
| `https://t.me/<bot>?start=graveyard` | 墓园             |
| `https://t.me/<bot>?start=submit`    | 投稿说明         |
| `https://t.me/<bot>?start=pending`   | 待处理（审核员） |

`<id>` 是去掉连字符的机场 UUID（32 位十六进制），网站可以直接拼出这些链接。

Mini App 主应用链接使用 `https://t.me/<bot>?startapp=<目标>`。目标支持 `airports`、`graveyard`、`submit`、`following`、`submissions`、`me`、`admin`、`incidents`、`review_submissions`、`memorials`、`telegram`，以及 `p_<id>`（机场详情）。未知目标不会作为 URL 跳转；管理路由始终重新校验角色。私聊按钮使用 `web_app`，群消息、inline 卡片和通知使用 `startapp` 链接，避免跳到外部浏览器。

管理员工作台还提供 `users`、`jobs`、`notifications`、`audit` 入口。审核通知使用 `i_<id>`、`s_<id>`、`m_<id>` 直接定位异常、投稿和留言；记录已处理时显示当前状态。Telegram 原生设置菜单按角色打开机器人配置或账号安全页。

搜索结果使用 `search_<UTF-8 关键词的 base64url>` 目标，保留筛选关键词；内容仅作为站内搜索参数使用。

网页 Telegram 登录使用官方 OIDC Authorization Code + PKCE，并验证签名、issuer、audience 和 nonce。授权取消后回到登录页并保留原目标；状态绑定当前浏览器且只能使用一次。未配置 OIDC、已配置 Mini App 时，登录页提供「在 Telegram 中打开」入口。

### Inline、Guest 与 Mini App

- **Inline mode**：在任意聊天输入 `@机器人 关键词`，结果可翻页，已入土的机场排在前面。已入土的卡片带祭奠按钮，计数在原消息上实时刷新；其他卡片只带链接按钮。
- **Guest mode**：在机器人不在的群里发送 `@机器人 机场名`，机器人以自己的身份回复一张只读卡片，只带链接按钮。它看不到群里的其他消息，也不会因此加入白名单。
- **Mini App**：菜单按钮和欢迎卡片打开 TG 内页面，前端加载 Telegram 官方 WebApp SDK，提交原始 `initData` 给 `POST /auth/telegram/miniapp` 验签登录，不需要再注册邮箱。凭据从地址栏移除，开发模式也只提交一次。首次登录要求凭据 5 分钟内签发；同账号持有有效会话与 CSRF 时可恢复同次启动，无有效会话的重复登录会被拒绝。登录失败会停在错误页，不会沿用另一个浏览器账号。

### 消息格式

机场卡片、追悼会、检测记录、管理员工作台和业务通报使用 Bot API 10.3 原生 Rich Messages：标题、紧凑表格、折叠详情、引用、页脚与卡内按钮。Inline 和 Guest 查询也返回原生富卡片。普通提示与需要强制回复的审核输入保留 HTML 消息。机场名称、描述、墓志铭、留言、复核原因和按钮属性一律经过转义；订阅凭据不进入卡片。时间用 `<tg-time>` 显示为读者本地时间。

群命令、富卡片与仅本人可见的结果会保留所在话题。关注按钮只更新操作者的私聊或个人浮层；公开追悼会的祭奠计数通过原消息更新。

## 7. 复核与审核流程

连续失败达到阈值或审核员手动发起复核时，机器人给已开启私信的审核员发送异常卡片，按钮为 **确认跑路**、**已恢复**、**排除误报**。按钮本身不改状态：

1. 点按钮后，机器人发来一条需要回复的消息。
2. 回复它：第一行写证据链接（http/https，最多 10 个，空格分隔），第二行起写核验原因（3–2000 字）。确认跑路时可另起一行写 `墓志铭：……`。
3. 机器人按数据库里的当前角色校验权限后保存结论，并向通报群、审核员和关注者广播结果。
4. 其他审核员收到的同一事件卡片上的按钮会被自动移除，尚未发出的卡片也会去掉操作按钮；仍在按旧按钮的人会看到“已经有人处理过了”。

投稿卡片的 **通过** 直接收录并私信投稿人；**驳回** 会要求回复驳回原因，再私信告知投稿人。留言卡片的 **公开** / **隐藏** 立即生效。网站后台的同类操作效果相同，并同样会撤掉机器人消息上的按钮。

## 8. 通知

| 事件                | 接收方                   | 按钮                         |
| ------------------- | ------------------------ | ---------------------------- |
| 检测异常 / 手动复核 | 通报群、审核员、关注者   | 详情；审核员另有三个复核按钮 |
| 自动恢复            | 通报群、审核员、关注者   | 详情                         |
| 人工结论            | 通报群、审核员、关注者   | 确认跑路时附祭奠与追悼会     |
| 墓碑复活            | 通报群、审核员、关注者   | 详情                         |
| 新投稿 / 待审留言   | 审核员                   | 通过 / 驳回、公开 / 隐藏     |
| 投稿审核结果        | 已绑定 Telegram 的投稿人 | 详情                         |
| 机器人入群 / 被移出 | 管理员                   | 绑定为通报群                 |

通知先写入 outbox，再由 worker 顺序发送：遇到 429 按 `retry_after` 等待，网络错误指数退避，400/401/403 进入死信。管理员在 `GET /admin/notifications` 查看，`POST /admin/notifications/{id}/retry` 重发。关注者需要先私聊机器人点过 Start 才能收到私信。

## 9. 完整 Bot API 入口

管理员可以调用 `POST /admin/telegram/api/{method}`（JSON）和 `POST /admin/telegram/upload/{method}`（multipart，总计 20 MiB，用 `attach://字段名` 引用文件），参数原样转发，支持 `sendRichMessage`、`ephemeral_message_parameters` 等全部新字段。审计只记录方法名。`GET /admin/telegram/updates` 和 `GET /admin/telegram/updates/{id}` 可查看收到的原始更新，失败的更新可以 `POST /admin/telegram/updates/{id}/retry`。

## 10. 排错

| 现象                        | 检查                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 机器人完全不回复            | worker 是否运行（`GET /admin/health`）；`telegram:setup` 报告里的 `last_error`；反代是否转发 `/telegram/webhook` |
| webhook 返回 401            | `TELEGRAM_WEBHOOK_SECRET` 与上次 `setWebhook` 时不一致，重新运行 `telegram:setup`                                |
| 群里不响应                  | 群是否已绑定且启用；命令是否带 `@机器人`（同群有多个机器人时）                                                   |
| 群命令没有“仅自己可见”      | 重新运行 `telegram:setup`；客户端版本是否支持 ephemeral 命令                                                     |
| 消息里没有网站按钮          | `PUBLIC_URL` 必须是 HTTPS 公网地址                                                                               |
| 没有“在机器人中查看”按钮    | 设置 `TELEGRAM_BOT_USERNAME`                                                                                     |
| 审核员收不到私信            | 是否 `/notify` 开启、是否点过 Start、角色是否仍为审核员；`/admin/notifications` 里的 `error_code`                |
| `@机器人` 没有结果          | BotFather 是否开启 inline mode；未加入的群里需要开启 Guest Mode                                                  |
| Mini App 打开空白或无法登录 | BotFather 里的 Mini App 域名是否与 `PUBLIC_URL` 一致；`initData` 只能使用一次且 5 分钟内有效                     |

## 安全要点

- 订阅地址永远不会出现在机器人消息里，投稿只显示官网域名和订阅数量。投稿只在私聊处理。
- 用户身份只取自 Telegram 签名的更新（`from.id`）、OIDC `id_token` 和 Mini App `initData`。
- 复核、审核和绑定在每次操作时都按数据库里的当前角色判断；按钮数据视为用户输入，重新校验目标。
- 通知投递时再次检查接收人的当前角色、停用状态与会话绑定；降权、关闭复核私信或解绑群后，已排队但尚未发出的对应通知会停止发送。上线前需应用 `004_notification_audience.sql` 迁移。
- 原始更新以 `APP_KEY` 加密存储，仅管理员可读，保留 7 天。
