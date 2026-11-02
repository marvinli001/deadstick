---
version: 1
slug: "web-src-pages-home-tsx"
primary_target: "web/src/pages/Home.tsx"
related_targets: ["web/src/pages/Cemetery.tsx","web/src/pages/Airport.tsx"]
---

Scope: public surfaces (home `/`, cemetery `/cemetery`, airport obituary `/airports/:id` when dead). Mode: Persuade.

Audience and job: Telegram 机场用户，手机上点进链接查一个机场的死活；跑路后来献花、留言。
Constraints: 明亮；文案极简，不写说明句、不设子标题和眉标；跑路只由人工确认。

## Direction contract

THESIS: 每家跑路机场得到一张机器印的讣告：名字、生卒、享年、死因、献花。拒绝暗色霓虹赛博朋克，也拒绝白色监控状态页。

OWN-WORLD: 白纸地，10px 纯黑讣告框，零圆角零投影。朱雀仿宋写机场名和标题，Departure Mono 写日期、天数和计数。菊黄只给白菊花心和“疑似”。图形全是几何 SVG：白菊、白烛、三支线香。

STORY: 搜机场，一眼看出存活、疑似、已入土；入土的读到人工死因和证据，献一朵菊；活着的点关注。

FIRST VIEWPORT: 整屏黑框。左上 DEADSTICK，右上导航与搜索。正中最新入土机场名（仿宋，最大 6rem），上方一朵白菊，下方生卒日期与享年，再下献花、点烛、上香三个计数按钮作为主操作。底部黑线上横排其余入土机场名。

FORM: 白菊讣告, ordered list #1 (Impeccable's pick, chosen by the user), seed:eaca60955680875a. Signature interaction: 献花时一朵白菊从按钮落进名字下方花墙，计数逐位滚动；点烛火苗摇、上香烟线升。全站唯一主动画时刻。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
