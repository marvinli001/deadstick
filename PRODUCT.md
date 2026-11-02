# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React 19 + Vite SPA in `web/`, built from Arc UI (uiarc.dev) free components via the shadcn registry. Fastify serves the built SPA and the REST API from one origin, shipped in one Docker image. Chosen with the user: frontend and backend deploy together, never as separate services.

## Users and jobs

- **机场用户（Telegram 上的翻墙服务买家）**：买之前查一个机场还活着没有、最近有没有异常；用过的机场跑路后来墓园看确认结果、献花点烛、留追悼留言；关注机场，状态变了收到 Telegram 通知。多数人从 Telegram 群、机器人或 Mini App 进来，手机上看。
- **投稿人**：发现新机场或可疑机场，提交名称、官网和订阅链接，等待审核，在用户中心看审核结果。
- **审核员（moderator）**：处理连续检测失败生成的异常事件，凭证据人工确认跑路、恢复或排除；审核投稿和追悼留言；手动录入机场、触发检测、复活误判的墓碑。
- **管理员（admin）**：以上全部，再加用户角色、监测参数、worker 心跳、通知 outbox、审计日志、Telegram 群绑定、原始更新和完整 Bot API 调用。

## What it does

自动定时检测机场官网、订阅解析与节点抽样出网；连续失败才开异常事件；只有人工提交原因和证据后才确认跑路、立碑进墓园。墓园是社区仪式：献花、点烛、上香（每人每天每种一次）、审核后的追悼留言。

## Product truth to preserve

- 名称：Deadstick。中文语境：机场、跑路、墓园、墓碑、墓志铭、献花、点烛、上香、追悼会、复活。
- 确认跑路永远是人工结论，不能让界面暗示“自动判死”。自动检测只会把机场标成“疑似”。
- 生命周期 `active`（存活）/ `suspected`（疑似跑路）/ `dead`（已入土）；健康 `healthy`/`degraded`/`down`/`unknown`。
- 订阅链接加密存储，任何公开页面不显示订阅地址；编辑机场时订阅需要重新填写。
- 祭奠和留言只对已确认跑路的机场开放；留言需要审核后才公开。
- 登录方式：邮箱密码、Telegram OIDC、Telegram Mini App initData。

## Brand brief from the user

赛博坟场：给 Telegram 上的机场做的赛博墓园。视觉要高级、炫酷、年轻化、扁平化。组件全部用 Arc UI 免费组件。

- 明亮风格：浅色底。暗色赛博朋克、暗色像素街机、暗色航显屏方向已被用户否决。
- 文案极简：不写说明性的大白话，不加子标题和眉标；界面靠结构、数字和状态说话。

## Language

简体中文，仅此一种。

## Accessibility

键盘可达、可见焦点、对比度达标、尊重 `prefers-reduced-motion`。手机优先，桌面完整。

## Open decisions

- 品牌标志与插画资产：暂无，由设计阶段自绘，用户可替换。
