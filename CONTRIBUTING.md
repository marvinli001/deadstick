# 参与开发

本仓库包含 Deadstick 的网站、管理后台、API、检测 worker 与 Telegram 机器人。本文件规定多人协作时的开发环境、代码约定、提交与合并流程。安全相关的编码要求见 [SECURITY_GUIDE.md](SECURITY_GUIDE.md)，漏洞报告方式见 [SECURITY.md](SECURITY.md)，待办与认领见 [TODO.md](TODO.md)。

## 开发环境

- Node.js 24–26，pnpm 12.6.0（与 CI、Dockerfile 一致，可用 `corepack prepare pnpm@12.6.0 --activate`）。
- PostgreSQL 16+。集成测试使用的角色需要 `CREATE DATABASE` 权限。
- 真实代理出网检测需要 [Mihomo v1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)；只做 TCP 检测时设置 `PROBE_MODE=tcp`。

初始化步骤见 [README.md](README.md#本地运行)。本地开发同时运行 `pnpm dev`（API）和 `pnpm dev:worker`（worker）。不要使用真实机器人 token、他人的订阅地址或生产数据库调试。

## 目录结构

| 路径                       | 内容                                                      |
| -------------------------- | --------------------------------------------------------- |
| `src/server.ts`            | API 进程入口                                              |
| `src/worker.ts`            | 检测、通知、清理 worker 入口                              |
| `src/app.ts`               | Fastify 组装：插件、错误处理、路由注册                    |
| `src/config.ts`            | 环境变量读取与校验                                        |
| `src/auth/`                | 邮箱账号、会话、CSRF、Telegram OIDC 与 Mini App 验证      |
| `src/catalog/`             | 机场资料、投稿、墓园、祭奠、留言、关注，以及请求 schema   |
| `src/routes/admin.ts`      | 管理与审核接口                                            |
| `src/monitor/`             | 调度队列、检测流程、订阅解析、网络边界、代理探针          |
| `src/telegram/`            | 机器人命令、通知投递、webhook 与 Bot API 入口、初始化脚本 |
| `src/admin.ts`             | 管理员初始化命令                                          |
| `web/`                     | 网站与管理后台（建设中）                                  |
| `migrations/`              | 按序号执行的 SQL 迁移                                     |
| `test/`                    | 单元测试与 PostgreSQL 集成测试                            |
| `.github/workflows/ci.yml` | CI：格式、类型、测试、构建、镜像与部署冒烟                |

网站与管理后台为 `web/` 下的 React 19 + Vite 单页应用。构建产物由 Fastify 与 API 同源提供，两者打包进同一个 Docker 镜像，不单独部署。前端的开发命令与目录约定在 `web/` 加入后补充到本节。

## 分支与合并

- `main` 始终保持可部署状态。所有改动经 Pull Request 合并，不直接推送 `main`。
- 从最新的 `main` 建分支，命名为 `<类型>/<简短描述>`，如 `feat/web-graveyard`、`fix/worker-lease`。类型与提交信息相同。
- 一个 PR 只处理一个主题。重构与功能修改分开提交，便于审查和回滚。
- 合并条件：CI 全部通过；至少一位作者以外的维护者批准；涉及 `src/auth/`、`src/crypto.ts`、`src/monitor/network.ts`、`src/monitor/proxy.ts`、`src/telegram/routes.ts`、权限检查或迁移的改动，审查者需按 [SECURITY_GUIDE.md](SECURITY_GUIDE.md#审查清单) 逐项核对。
- 默认使用 squash merge，合并后的提交标题即 PR 标题，需符合下方提交信息格式。
- 开始较大的工作前，先在 [TODO.md](TODO.md) 认领对应条目或开 issue 说明方案，避免多人重复实现。

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

```text
<类型>(<范围>): <摘要>
```

- 类型：`feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`。
- 范围可选：`api`、`auth`、`catalog`、`monitor`、`worker`、`telegram`、`db`、`web`、`deps`、`ci`。
- 摘要用英文祈使句、小写开头、不加句号，与现有历史一致，如 `fix(monitor): bound proxy sampling`。
- 破坏性变更在类型后加 `!`，并在正文写明 `BREAKING CHANGE:` 及迁移方式。

## 代码约定

- TypeScript `strict` 与 `noUncheckedIndexedAccess` 开启；ESM 模块，相对导入带 `.js` 后缀。
- 格式以 Prettier 为准（单引号、行宽 100），提交前运行 `pnpm format`。CI 的 `pnpm format:check` 也会检查 Markdown。
- 每个路由都声明 TypeBox schema 和 `tags`，OpenAPI 由此生成。请求参数使用 camelCase，响应字段使用 snake_case。
- 业务错误抛出 `AppError(status, 'UPPER_SNAKE_CODE', message)`，由统一错误处理返回 `{ error: { code, message }, requestId }`。不要把内部异常信息返回给客户端。
- 列表接口使用 `limit`（1–100）与 `offset` 分页。
- SQL 一律使用 `$1` 参数化，不拼接用户输入。多条写操作放进 `db.transaction`。
- 管理与审核写操作调用 `audit()` 记录操作者、动作与目标，`details` 中不得包含凭据。
- Telegram 新命令在 `src/telegram/bot.ts` 实现并加入 `commands`；新增更新类型加入 `allowedUpdates`，部署后重新运行 `pnpm telegram:setup`。
- 新增依赖需在 PR 中说明用途；需要安装脚本的依赖须加入 `pnpm-workspace.yaml` 的 `allowBuilds` 并经审查。始终提交更新后的 `pnpm-lock.yaml`。

## 数据库迁移

- 新建 `migrations/NNN_描述.sql`，序号在现有最大值上加一，三位补零，描述用英文小写加下划线，如 `002_add_memorial_reports.sql`。
- 已合并到 `main` 的迁移文件不可修改或删除，修正通过新迁移完成。
- 迁移在单个事务中执行，不能使用 `CREATE INDEX CONCURRENTLY` 等无法在事务内运行的语句。
- 迁移需兼容仍在运行的上一版本进程：先新增列或表，下一个版本再删除旧结构。删除或改名列属于破坏性变更。

## 配置项

新增或修改环境变量时，同一 PR 内同步更新 `src/config.ts` 的校验、`.env.example` 的说明、README 的相关章节，必要时更新 `compose.yml`。敏感配置不得设置可用的默认值。

## 测试与检查

提交 PR 前在本地运行完整检查：

```sh
TEST_DATABASE_URL=postgres://deadstick:deadstick@localhost:5432/deadstick_test pnpm check
```

`pnpm check` 依次执行格式检查、类型检查、测试与构建。未设置 `TEST_DATABASE_URL` 时数据库测试会跳过，PR 仍以 CI 结果为准。

- 修复缺陷时附带能复现该缺陷的测试。
- 涉及权限、验签、网络边界、加密与代理配置的改动必须有对应测试，参考 `test/integration.test.ts`、`test/network.test.ts`、`test/proxy.test.ts`。
- 测试不得访问真实机器人、真实机场或外部服务；外部调用通过注入的 sender、DNS 或网络桩替代。

## API 变更

- 新增或修改接口后，更新 README「前端接入」一节的接口表。
- 删除接口、删除或改名字段、收紧校验、改变状态码均属于破坏性变更，须在 PR 描述和 CHANGELOG 中注明，并通知前端维护者。

## 更新日志

- 对用户、部署者或前端接入者可见的改动，在同一 PR 内更新 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]` 段。纯重构、测试与 CI 调整无需记录。
- 条目放入对应分类：`新增`、`变更`、`弃用`、`移除`、`修复`、`安全`。每条写变更内容及其影响，不照抄提交信息。
- 破坏性变更以「**破坏性：**」开头，并写明升级步骤（迁移、配置项、接口调整）。

## 版本发布

版本号遵循语义化版本。1.0.0 之前，破坏性变更提升次版本号，其余提升修订号。发布步骤：

1. 将 CHANGELOG 的 `[Unreleased]` 内容移至新的 `[x.y.z] - YYYY-MM-DD` 段，并更新文末的比较链接。
2. 同步更新版本号：`package.json` 的 `version`、`src/app.ts` 中 OpenAPI 的 `info.version`、`src/monitor/network.ts` 中的 `User-Agent`。
3. 合并发布 PR 后，在 `main` 上打 `vx.y.z` 标签并创建 GitHub Release，正文取自 CHANGELOG 对应段落。

## Pull Request 描述

PR 描述包含以下内容：

- 改动内容与原因，关联的 issue 或 TODO 条目。
- 验证方式：运行的命令、新增的测试、手动验证步骤；涉及页面时附截图。
- 迁移、环境变量、Telegram 设置或部署步骤的变化。
- 破坏性变更及升级方式。
