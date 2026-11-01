---
name: Deadstick
description: 白菊讣告，Telegram 机场的赛博墓园
colors:
  paper: '#ffffff'
  paper-2: '#f5f5f2'
  paper-3: '#ebebe6'
  ink: '#111111'
  ink-2: '#3b3b39'
  ink-3: '#6a6a66'
  rule: '#e2e2dc'
  border: '#d9d9d3'
  chry: '#f2c200'
  chry-ink: '#7d6300'
  chry-wash: '#fdf5d6'
  jade: '#0f7a4f'
  alarm: '#c4122f'
typography:
  display:
    fontFamily: 'Zhuque Fangsong, STFangsong, FangSong, Songti SC, serif'
    fontSize: 'clamp(3.25rem, min(9vw, 10vh), 6rem)'
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: '0.04em'
  headline:
    fontFamily: 'Zhuque Fangsong, STFangsong, FangSong, Songti SC, serif'
    fontSize: 'clamp(2.5rem, 6vw, 4rem)'
    fontWeight: 400
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, PingFang SC, HarmonyOS Sans SC, Noto Sans SC, Microsoft YaHei, sans-serif'
    fontSize: '15px'
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, PingFang SC, sans-serif'
    fontSize: '14px'
    fontWeight: 500
    lineHeight: 1.6
  mono:
    fontFamily: 'Departure Mono, ui-monospace, SFMono-Regular, Menlo, monospace'
    fontWeight: 400
rounded:
  control: '0px'
  panel: '0px'
  surface: '0px'
spacing:
  1: '0.25rem'
  2: '0.5rem'
  3: '0.75rem'
  4: '1rem'
  6: '1.5rem'
  8: '2rem'
  12: '3rem'
components:
  button-primary:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.paper}'
    rounded: '{rounded.control}'
    padding: '0 1rem'
    height: '2.75rem'
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '0 1rem'
    height: '2.75rem'
  input:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '0 0.75rem'
    height: '2.75rem'
---

# Design System: Deadstick

## Overview

**Creative North Star: "白菊讣告"**

白纸、黑框、仿宋和一枚菊黄花心。每家确认跑路的机场得到一张讣告，名字、生卒、死因和祭奠构成视觉中心。明亮、年轻、平面化；不采用暗色霓虹、街机或航显屏方向。

公开页强调仪式感，用户中心和后台强调操作效率；共享同一套 Arc UI 免费组件和语义令牌。文案只写必要的名称、状态、数字和操作，界面仅使用简体中文。

**Key Characteristics:**

- 10px 黑色外框，公开页手机端收为 6px。
- 仿宋标题，系统无衬线正文，等宽日期和计数。
- 直角控件、细分隔线、克制用色。
- 献花、点烛、上香是主要的品牌动效。

## Colors

颜色以 `web/src/styles/global.css` 为准，覆盖 Arc foundation 的语义令牌。

- **白纸 / paper**：主背景、表单和浮层；paper-2 用于悬停和弱分区，paper-3 用于未激活图形。
- **墨色 / ink**：正文、主按钮、黑框；ink-2 为次级文字，ink-3 为时间和辅助数据。rule 和 border 用于内容分隔、次级控件描边。
- **菊黄 / chry**：白菊花心、烛火和疑似状态的提示线；黄色底上的文字用 chry-ink，浅色状态底用 chry-wash。
- **玉绿 / jade**：正常、恢复、完成；**警红 / alarm**：失败、错误和危险操作。
- 生命周期和健康状态同时带文字或形状，不靠颜色单独传达。

## Typography

标题使用自托管的朱雀仿宋，正文使用系统中文无衬线字体；Departure Mono 仅用于时间、标识、数量和机器数据。字体授权文件随 `web/public/fonts/` 分发。

首页机场名最大 6rem；墓园页标题为 `clamp(2.5rem, 6vw, 4rem)`，后台标题为 `clamp(2rem, 4vw, 2.75rem)`。正文 15px、行高 1.6，表单标签 14px。长名称允许换行，表格中的日期和数量保持可扫描。

## Layout

公开页使用固定黑框和可滚动内容，桌面导航高 72px；720px 以下导航分成 60px 品牌行和 44px 导航行。内容水平留白通常为 `clamp(16px, 4vw, 48px)`。

墓园最大宽度 1120px，详情和用户中心最大宽度 960px；表单保持单列或简短的双列组合。后台侧栏宽 232px，内容最大宽度 1280px；900px 以下侧栏变为横向导航，密集表格在自身容器内横向滚动。720px 以下公开列表和用户投稿重新排为手机布局。

同一组信息靠近，组间使用 24–48px 留白；标题下方用黑线建立层级。不要把每一组数据都塞进卡片。

## Elevation & Depth

常态内容无投影，用边框、分隔线和留白组织层次。`--shadow-resting: none`；raised 仅有 1px 墨色轮廓；floating 在轮廓外加 `0 18px 40px rgb(17 17 17 / 0.12)`，用于菜单等浮层。抽屉和对话框使用遮罩保护当前操作焦点。

## Shapes

控件、面板、容器和标签均为直角；圆形保留给花心、头像、健康状态点等有明确用途的图形。品牌图形使用几何 SVG：白菊、蜡烛、三支线香，线条为 1.2–1.5px 墨色。不要添加无关装饰图案。

## Components

- **按钮**：使用 Arc Button。主按钮墨底白字，次按钮白底细边框，ghost 用于次要操作；常规高度 44px，小号 36px，大号 50px。异步操作显示 loading，防止重复提交。
- **表单**：使用 Arc Input、Textarea、TagInput、NumberField 等。白底、1px 黑边、直角；标签保持可访问名称，错误显示可执行的中文反馈。键盘焦点有 2px 墨色轮廓。
- **导航与列表**：文字链接、选中下划线或反白；公开列表以细线分行。后台使用表格和行操作，保留列标题、筛选、分页和局部横向滚动。
- **状态与反馈**：LifecycleMark、HealthMark、StatusTag 统一语义；加载用 Arc Skeleton，失败提供重试，空列表给出真实空状态。成功反馈使用 Arc ToastStack。
- **抽屉与对话框**：机场录入、编辑用 Arc Drawer；人工核验和审核用 Arc Dialog。支持 Escape、键盘焦点和手机布局。
- **祭奠**：白菊花墙最多展示 28 朵，多余数量以计数表达；献花后落入花墙，计数用 Arc SlotText 更新。烛火和香烟线仅在已点亮时运行；`prefers-reduced-motion` 下停用持续动画并简化过渡。
- **动效**：沿用 Arc 的 120/160/240/480ms 时长和 enter/standard 曲线；品牌仪式集中在祭奠操作，其他页面通过状态切换提供反馈。

## Do's and Don'ts

### Do

- 使用现有语义令牌和 Arc 免费组件，保持公开页、用户中心、后台一致。
- 保留简体中文、可见焦点、加载、失败、空白和成功状态。
- 显示人工结论及证据；自动检测只能产生疑似状态。
- 在公开页面隐藏订阅凭据，编辑时要求重新填写订阅。

### Don't

- 不添加无意义的说明句、眉标和子标题。
- 不引入暗色霓虹、渐变文字、玻璃卡片、装饰投影或大圆角。
- 不把正常、疑似和确认跑路混为同一种状态。
- 不用 emoji 代替图标，也不用等宽字体排整段中文。
