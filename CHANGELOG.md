# 更新日志

本项目的所有重要变更都记录在此文件中。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。记录规则见 [CONTRIBUTING.md](CONTRIBUTING.md#更新日志)。

## [Unreleased]

### 新增

- 账号系统：邮箱密码注册与登录、可撤销会话、CSRF 校验、登录限流，以及用户、审核员、管理员三级权限。
- Telegram 身份：OIDC + PKCE 登录、自动注册与已有账号绑定；Mini App `initData` 验签、时效与重放保护。
- 机场资料库：标签、多官网、多订阅；管理员直接录入，或用户投稿后审核。订阅地址与原始机器人更新以 AES-256-GCM 加密存储。
- 检测调度：默认每 24 小时检测，按机场错峰分批入队；独立 worker、数据库队列、租约、失败重试、过期任务接管与配置变更结果隔离。
- 检测项：官网 HTTP / TLS，Clash YAML / sing-box / Base64 URI / Surge 订阅解析，过期与流量额度，节点抽样。节点支持 Mihomo 真实代理出网模式与 TCP 连通性模式。
- 网络边界：仅允许公网 HTTP(S) 与指定端口，逐跳校验 DNS 解析结果，阻止内网、回环、云元数据地址与 HTTPS 降级。
- 异常与复核：连续失败达到阈值后创建异常事件，通知白名单群与绑定的审核员；确认跑路必须提交原因与证据，自动恢复关闭未确认事件，墓碑仅可人工复活。
- 赛博墓园：墓园列表、墓志铭、献花 / 点烛 / 上香、审核后的追悼留言、关注与状态变更通知。
- Telegram 机器人：搜索、状态、投稿、关注、献花、追悼会、inline 搜索、私聊复核、群白名单与论坛 topic 通知；管理员可用的完整 Bot API JSON / multipart 调用入口。
- 运维：通知 outbox 与死信重发、429 `retry_after` 处理、管理审计、worker 心跳、健康检查、数据保留期、Docker Compose 部署与 GitHub CI。
- 协作文档：`CONTRIBUTING.md`、`SECURITY.md`、`SECURITY_GUIDE.md`、`TODO.md` 与本文件。
- 接口：`GET /providers/slug/:slug`；`GET /providers`、`GET /graveyard`、`GET /admin/providers` 返回 `total`；机场详情返回 `follower_count`、`memorial_count` 与当前用户的 `following`；`PATCH /auth/me` 修改昵称，`DELETE /auth/telegram` 解绑 Telegram（需已设置邮箱密码），`GET /auth/me` 返回 `has_password`；`/admin/users` 支持 `q`、`role` 筛选，`/admin/memorials` 支持 `status` 筛选。
- 通报：手动发起复核和墓碑复活会通知通报群、审核员与关注者；新投稿和待审留言私信审核员并附审核按钮；投稿审核结果私信投稿人；事件、投稿或留言处理后自动移除其他审核员消息上的按钮。迁移 `002_notification_methods.sql` 为通知 outbox 增加 `method`、`subject`、`message_id`。
- Telegram 机器人：HTML 卡片与彩色按钮、墓园分页、深链（`p_`、`c_`、`r_`、`graveyard`、`submit`、`pending`）、追悼会实时计数、`/following`；群内 ephemeral 命令与仅本人可见的按钮结果（Bot API 10.2+）；Guest Mode 只读回复（Bot API 10.0）；rich message 检测报告并自动回退普通消息（Bot API 10.1）；inline 结果分页与祭奠按钮。
- 审核员机器人控制台：`/pending`、`/notify`，异常复核按钮加 force reply 提交证据，投稿通过 / 驳回、留言公开 / 隐藏按钮；`/bind`、`/unbind` 与入群提醒绑定通报群，机器人被移出时自动停用绑定。
- `pnpm telegram:setup` 按作用域设置命令菜单（私聊、群、群管理员、审核员），设置短简介与 Mini App 菜单按钮，并输出 webhook 状态与 BotFather 缺失设置提示。新增 [docs/telegram.md](docs/telegram.md) 配置文档。

### 变更

- **破坏性：**`pnpm telegram:setup` 现在要求设置 `TELEGRAM_BOT_USERNAME`，且必须与 token 对应的机器人一致。
- 机器人消息由纯文本改为 HTML，状态显示为中文（存活 / 疑似跑路 / 已入土）。`/admin/providers/:id/incidents` 在已有未处理事件时返回 `409 INCIDENT_OPEN`。

### 修复

- 机器人 `/submit` 因 TypeBox 未注册 `uri` 格式而拒绝所有投稿。

[Unreleased]: https://github.com/marvinli001/deadstick/commits/main
