# 待办

记录尚未完成、需要协调分工的工作。规则：

- 每项一行，开始前在条目末尾写上认领人与关联链接，如 `— @username #12`，避免重复实现。
- 较大的条目拆成可以单独合并的子项。
- 完成的条目在合并 PR 中删除，对外可见的变化记入 [CHANGELOG.md](CHANGELOG.md)。

## 用户入口

用户侧以 Telegram Bot + Mini App 为主，不再扩展独立 Web 用户功能。`web/` 复用为 Mini App 和管理员后台；Bot 负责查询、通知与快捷操作，复杂表单在 TG 内页面完成。

## 管理后台

- [ ] 机场录入与编辑、监测启停、手动检测。
- [ ] 投稿审核、追悼留言审核。
- [ ] 异常事件列表与人工复核（提交原因与证据）、墓碑复活。
- [ ] 检测任务与结果、监测设置、worker 心跳、通知队列与死信重发、审计记录。
- [ ] 用户角色管理、Telegram 群与审核员绑定。

## Telegram

- [x] Mini App 复用现有页面，接入统一 Telegram 身份、原生返回、安全区和底部导航。
- [ ] 使用真实 BotFather 配置按 [docs/telegram.md](docs/telegram.md) 联调：webhook、分作用域命令菜单、私聊查询 / 关注确认 / 报信 / 取消、inline 与 Guest Mode、群内 ephemeral 命令与 15 秒回复时限、本群设置与论坛话题通知、日报和静默、投稿补交、按钮复核与 force reply、rich message 检测报告在各客户端的显示。
- [x] 审核员角色变更通过 outbox 同步私聊命令菜单，独立于通知开关。

## 检测

- [ ] 使用真实监测订阅联调 `PROBE_MODE=proxy`，记录不可判定（`unknown`）结果的协议与传输分布。
- [ ] 根据联调结果评估扩展探针支持的插件与传输。

## 仓库与协作

- [ ] `main` 分支保护：禁止直接推送，要求 CI 通过与至少一位维护者批准。
- [ ] 前端加入后，CI 增加前端的格式、类型、测试与构建任务，并调整工作流名称 `Backend checks`。
- [ ] 添加 PR 模板与 issue 模板（缺陷、功能、检测误报）。
- [ ] 首个版本 `v0.1.0`：整理 CHANGELOG、打标签、创建 GitHub Release。
- [ ] 统一版本号来源，避免 `package.json`、OpenAPI `info.version` 与 `User-Agent` 分别维护。

## 安全

- [ ] `APP_KEY` 轮换工具：用新密钥重新加密 `endpoints`、`auth_challenges`、`bot_updates` 中的密文。
