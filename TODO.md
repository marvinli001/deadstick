# 待办

记录尚未完成、需要协调分工的工作。规则：

- 每项一行，开始前在条目末尾写上认领人与关联链接，如 `— @username #12`，避免重复实现。
- 较大的条目拆成可以单独合并的子项。
- 完成的条目在合并 PR 中删除，对外可见的变化记入 [CHANGELOG.md](CHANGELOG.md)。

## 网站

- [ ] 建立 `web/`：React 19 + Vite 工程与 pnpm workspace 配置，Fastify 同源提供构建产物，Dockerfile 一并打包。
- [ ] 机场库：列表、搜索、标签与 `lifecycle` 筛选、详情页、检测记录。
- [ ] 赛博墓园：墓碑列表、墓志铭、献花 / 点烛 / 上香、追悼留言。
- [ ] 账号：邮箱注册登录、Telegram 登录与绑定、我的投稿、关注列表。
- [ ] 投稿表单：官网与订阅入口录入，提示订阅仅用于监测且加密保存。

## 管理后台

- [ ] 机场录入与编辑、监测启停、手动检测。
- [ ] 投稿审核、追悼留言审核。
- [ ] 异常事件列表与人工复核（提交原因与证据）、墓碑复活。
- [ ] 检测任务与结果、监测设置、worker 心跳、通知队列与死信重发、审计记录。
- [ ] 用户角色管理、Telegram 群与审核员绑定。

## Telegram

- [ ] Mini App 前端页面，接入 `POST /auth/telegram/miniapp`。
- [ ] 使用真实 BotFather 配置联调：webhook、命令菜单、inline 模式、群白名单与论坛 topic 通知、私聊复核。

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
