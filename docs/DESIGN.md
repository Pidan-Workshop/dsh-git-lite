# dsh-git-lite 设计笔记

本文件是**实现者文档**：设计取舍、踩过的坑、以及为什么代码长成现在这样。
面向使用者的安装与使用说明见 [README](../README.md)。

## 设计目标与定位

面板的用途是**基础 Git 操作**，不是完整 Git 客户端。据此有几条明确的「不做」：

- **不做提交 DAG 泳道图**：完整 DAG 渲染是另一个量级的工程量，与本插件「基础功能」的定位不符。
- **不做分支管理面板**：只提供本地分支切换，不做新建 / 删除 / 重命名 / rebase。
- **不做交互式 rebase / 冲突解决**：冲突只给明确提示，让用户回终端处理。

## 安全模型

本插件把安全放在结构里，而不是放在字符串过滤里：

1. **工作目录由宿主解析，客户端最多只能"补一个候选值"。** 权威来源是 `session.header.cwd`
   —— 注意 `Session` 类**没有**顶层 `cwd`，创建元数据挂在 `header` 上（曾经误读 `session.cwd`，
   结果永远是 `no-workspace`，见下方「已知坑」）。仅当宿主没有该值时，才退回客户端上报的 `cwd`。
   **两条来源都要过同一道闸门**：`realpath` 解析 → `ctx.workspaceRegistry.resolveByPath()`
   必须是已注册工作区 → `git rev-parse --show-toplevel`（`realpath` 后）仍须落在该工作区内。
   所以客户端最多只能指向另一个*已注册工作区*，「让宿主在任意目录跑 git」这条路依然不存在。

2. **仓库根二次校验。** 上面第 3 道闸门挡住「工作区是某个更大仓库的子目录」这种越界。

3. **force push 结构上不可能。** push 的 argv 由宿主内部构造（无参数 `git push`，只推当前分支到其上游），客户端无法注入参数；另有 `assertNoForce()` 做纵深断言。

4. **两阶段 push 确认，比通用审批更严。** 没有用 `ctx.approval`：它的契约要求一个打开的 agent 轮次，而本插件的 push 是 UI 触发的、没有 open turn。两阶段确认的做法是：预览返回 HEAD sha / 分支 / 上游 / ahead 数 / commit 列表 + 一次性短期 token；确认时校验 token 未用过、未过期，且 **HEAD 与分支仍与预览时一致**（防 TOCTOU），不一致就拒绝。

5. **`GIT_TERMINAL_PROMPT=0`。** 无终端的 web 进程里，缺凭据立刻失败，不会挂死等输入。

6. **路径参数拒绝绝对路径与 `..` 逃逸**；分支名以 `-` 开头直接拒绝。

## 实现要点

- **宿主**：`inject: [webServer, sessions, workspaceRegistry]`，在 `ctx.webServer` 上挂 `/git-lite/*` 同源 JSON 路由；`llm` 与 `agentDefaultModel` 走**可选注入**，缺了它们插件其余功能照常工作。
- **浏览器**：`window.__ModuleLoader__.load({ id, factory })`，导出 `apply(ctx)` / `inject`。三个注册点：`sidebarRightTabs.register`（tab 类型）、`sidebar.right.pane.tab`（tab 主体，keyed seat，key = tab type id）、`conversation.session.header.utilities`（分支胶囊）。

  关于入口位置：胶囊曾放在 `conversation.input.dock`（输入框上方），但那里会额外占一行高度；改到会话头部右对齐的 `utilities` 区后，复用了头部本来空着的右侧空间。头部四个 seat 的分工是：`actions` 紧邻标题、`utilities` 右对齐、`corner` 最右角落且**仅容一个**控件（已被右侧栏的收回按钮占用）、`lineage` 替换面包屑标题。想改成紧邻标题，把槽位名换成 `conversation.session.header.actions` 即可。
- diff 由宿主返回 unified diff 文本，**浏览器侧解析着色** —— 宿主不做渲染，职责清晰。
- 未跟踪文件的 diff 由宿主按行合成，不依赖 `/dev/null`（跨平台）。
- 状态用 `git status --porcelain=v2 --branch -z`，重命名的原路径是独立 token，路径不被引号包裹。
- `execFile('git', args, ...)`，argv 一律用数组传，**绝不由客户端拼接**，因此不存在 shell 注入面。

## 生成提交信息：llm 调用契约

「✨ 生成信息」走可选注入的 `llm` + `agentDefaultModel`。调用形状有两条硬约束，都属于
**写错了不会报错、只会静默变空**的类型：

**1. 消息必须是块数组，且带 `id` 与 `source`。**

```js
buildUserMessage(text)
// → { id: <uuid>, role: 'user',
//     content: [{ type: 'text', text }],
//     source: { kind: 'plugin', plugin: 'dsh-git-lite' } }
```

传裸字符串不行：适配器的 `serializeMessages` 会对 `content` 调 `.filter()`，直接抛错。

**2. 必须读终止分片。**

每个流都以 `{ type: 'finish', reason }` 结束，`reason.kind` 为 `stop` / `error` / `aborted`；
失败时真正的诊断在 `reason.failure`（稳定 code + message）。只挑 `text-delta` 会把失败**整条吞掉**，
只剩空字符串，最后表现成一句与原因完全无关的「模型没有返回提交信息」。

所以 `streamToText()` 的契约是「返回文本**或抛错**」，绝不静默返回空串。空串只可能来自
「流本身没有任何内容」，此时才由上层报 `llm-empty`。

## 分支胶囊的状态机

胶囊的判定抽成了纯函数 `chipState(brief, briefErr, sessionId)`，四个状态：

| 状态 | 条件 | 渲染 |
|---|---|---|
| `ready` | `/status` 成功且带 `branch` | `⑂ <分支> *改动数 ↑ahead ↓behind` |
| `loading` | **本会话首次加载**尚未拿到任何答复 | 转圈 + 「加载中…」，避免半秒空窗 |
| `norepo` | 宿主给出**权威**错误（`not-a-repo` / `no-workspace` / `workspace-unknown` / `outside-workspace`） | 虚线弱化胶囊「无仓库」，原因在 tooltip |
| `idle` | 连 sessionId 都没有 | 不占位（没有可加载的对象，不该一直转圈） |

`loading` 的语义刻意收窄为**首次加载**，靠两件事保证：

1. 切会话时 effect **无条件先清空** `brief`（上一个会话的分支信息对新会话是错的）；
2. 失败时按 `onStatusFailure(err)` 区分，**瞬态失败保留**上一次的 `brief`。

于是轮询抖动不会把胶囊打回加载态来回闪，而切会话仍会正常出现一次加载态。

失败时「清空还是保留」的区分（`onStatusFailure`，已单测）——这是最容易写反的一处：

| 错误 | 判定 | 处理 |
|---|---|---|
| `not-a-repo` / `no-workspace` / `workspace-unknown` / `outside-workspace` | **权威**：这个目录确实没有可用仓库 | 清掉旧值 → `norepo` 弱化胶囊 |
| `session-unknown` | **瞬态**：切会话时宿主还没载入 | 保留旧值（连 loading 都不给） |
| 无 `code`（网络抖动等） | **瞬态** | 保留旧值 |

另有一条容易写反的边界：**`/status` 成功但拿不到 `branch` 不算 `ready`**（游离头等），落到 `loading` 而不是渲染一个空分支名。

配套的重试节奏（`chipRetryDelay`）：未就绪期间 500ms 快重试，连续 12 次后回常规 6 秒节奏——没有它，胶囊会被一整个轮询周期卡住，表现为「过一会才刷出来」。

## 样式与主题

### 配色全部走 DSH 设计令牌

`makeTheme()` 返回的每个颜色都是 `var(--dsw-<令牌>, <兜底>)` 形式 —— 令牌由
`dsh-client-ui-theme` 定义（实测 368 个可选），每个令牌都有明暗两套值，由
`body[data-ds-dark-theme]` 切换。

**因此这里刻意不自己维护明暗两套色板，也不需要 `useDark()` / `matchMedia`**：

| 好处 | 说明 |
|---|---|
| 配色一致 | 不再手搓一套近似色，面板与应用其它部分严格同色 |
| 明暗自动跟随 | 令牌本身随主题变，无需监听系统配色，也无需重渲染 |
| 跟随用户主题 | 第三方主题包覆盖令牌时，面板一起变 |

兜底值是**必需的**，不是装饰：令牌缺失时（被裁剪的部署、旧版本）仍要能看。有测试断言
「令牌必须写成 `var(令牌, 兜底)` 形式」以及「主按钮底色必须取蓝色填充令牌
`button-info-fill`，且不得出现 `brand-primary`」。

实际取值的令牌共 14 个：`label-primary` / `label-caption` / `label-primary-bluish` /
`border-l2` / `bg-layer-1` / `interactive-bg-hover` / **`button-info-fill`** /
**`button-info-hover`** / **`label-primary-foreground`** / `state-success-primary` /
`state-error-primary` / `scrollbar-bg-l1` / `scrollbar-hover-l1` / `font-mono`。

`brand-primary` **不在**其中 —— 它只出现在 `makeTheme()` 的注释里当反例（见下节）。

### 一个容易踩的令牌陷阱：`brand-primary` 不是「主色填充」

名字叫 brand-primary，但它和 `label-primary`（正文**文字**色）取值完全相同：

| 令牌 | 浅色 | 深色 | 性质 |
|---|---|---|---|
| `brand-primary` | `#0f1115` 近黑 | `#f9fafb` 近白 | **前景色** |
| `button-primary-fill` | 同上（= brand-primary） | 同上 | 高对比黑/白填充，**不是蓝** |
| **`button-info-fill`** | **`#4176e6` 蓝** | **`#679efe` 亮蓝** | **蓝色填充**（DSH 发送按钮用的就是它） |
| `label-primary-foreground` | `#ffffff` | `#0f1115` 近黑 | 填充之上的文字色（配对令牌） |

我一度用 `brand-primary` 当按钮底色，结果深色主题下底色变成近白、而文字色是硬编码的
`#fff` —— **白底白字，看起来是个空白方块**。DSH 自己的写法是
`background: var(--dsw-alias-button-info-fill); color: #fff`。

**文字色我没有照抄它的 `#fff`**：实测白字在深色主题的 `#679efe` 上只有 **2.66:1**（低于
WCAG AA），而配对的 `label-primary-foreground` 给出浅色 **4.23:1** / 深色 **7.11:1**，两边都达标。
（DSH 那里是个图标按钮，对对比度的要求比正文低，所以它能接受。）

有测试同时断言两件事：主按钮底色**必须**取 `button-info-fill`，且**不得**出现 `brand-primary`。

半透明的 diff 底纹没有对应令牌，取一组在明暗两边都成立的 `rgba()` 值。

### 交互态只能用样式表

内联样式表达不了伪类，所以插件注入一张固定 id 的样式表（`ensurePanelStyle()`，幂等）：

- **`:hover`** —— 按钮 / 文件行 / 提交卡片 / 分段控件 / 分支胶囊
- **`:focus-visible`** —— 键盘可达性；只在键盘操作时出现，不干扰鼠标点击
- **细滚动条** —— `::-webkit-scrollbar`，颜色取 `scrollbar-*` 令牌
- **旋转动画 keyframes** —— 加载指示

元素通过 `data-git-lite-*` 标记被样式表命中（`hoverable` / `btn` + `data-primary` /
`seg` / `scroll` / `chip`）。这样做的额外好处是**测试可以直接断言这些标记存在于渲染树里**。

## 面板布局

从上到下五段，固定段与弹性段分开：

| 段 | 伸缩 | 说明 |
|---|---|---|
| 分支下拉 + ahead/behind | `0 0 auto` | 固定 |
| 操作条（拉取/抓取/推送/刷新/stash） | `0 0 auto` | 固定 |
| 提示行（错误/成功） | `0 0 auto` | 固定，仅在有内容时出现 |
| **列表 ↔ 下方区域** | `1 1 auto` | **中间用可拖拽分隔条分配；下方无内容时整块隐藏**（连分隔条一起） |
| 提交区 | `0 0 auto` | 固定 |

### 列表 / diff 的高度分配

最初是 `列表 flex:1` : `diff flex:2` —— 结果 **diff 固定吃掉 2/3**，列表被压到只剩两行，
这是设计缺陷而不是取舍。现在：

- **默认两侧均分**（`1 1 0` : `1 1 0`），列表不再被压扁
- **分隔条可拖拽**分配上下面积（6px 高、`cursor: row-resize`），双击复位到默认比例
- 用**指针捕获**（`setPointerCapture`）而不是 window 监听器，指针移出分隔条也不会丢事件
- 高度**只存列表那一侧**（`localStorage["dsh-git-lite:list-height"]`）。只存一个值，
  diff 自动吃掉剩余空间，容器尺寸变化时不会出现"两侧之和超过容器"
- 拖拽结束才写一次 localStorage（不在 `pointermove` 里每帧写）
- 窗口变矮时用 `resize` 重新 clamp，防止列表溢出把 diff 挤没
- 既保留无障碍语义（`role="separator"` / `aria-orientation`），也留了 `title` 提示

### 下方区域无内容时整块让位

变更模式没选文件、历史模式没选提交时，下方区域**连分隔条一起隐藏**，把整个高度让给列表——
而不是让一个空 diff 区白占半屏。判断就是一个布尔量：

```js
var hasBottom = mode === 'changes' ? selected !== null : commitView !== null
```

列表的伸缩也随之切换：有下方区域时用 `listHeight`（拖拽后的固定高度），没有时回到 `1 1 0`
吃满。用户拖过的高度存着不丢，等下方区域再出现时照旧生效。

夹取逻辑抽成纯函数 `clampListHeight(next, bodyHeight, listMin, diffMin)` 并单测 6 项——
**clamp 边界写错会让某一侧塌成 0 高度，看起来像"内容不见了"**，这是真机上最难自查的一类布局
bug，所以它值得有测试钉住。空间实在不够时（`容器高 < 列表最小值 + diff 最小值`）优先保住
diff 的最小可读高度，且绝不返回负数。

## 提交历史视图

面板顶部有一个 **`变更 / 历史`** 分段控件。历史模式与变更模式**不是同构的**：

- 变更模式是 **2 层**：文件 → diff
- 历史模式天然是 **3 层**：提交 → 该提交的文件 → 文件 diff

这个层数差异与「分段切换还是独立标签页」无关 —— 独立标签页里每个面板照样只有两个区域，
3 层问题一样存在。所以解法是**把上方区域做成可下钻的导航栈**，而不是硬塞第三个纵向区域
（侧边栏只有 ~400px 宽，竖着切三段太挤）。

| 历史模式下的上方区域 | 下方区域 |
|---|---|
| ① 提交列表 | 占位「选择一条提交查看改动」 |
| ② 点某条提交 → **该提交的文件列表 + 「← 返回」** | 该提交的**完整 patch**（全部文件连在一起） |
| ③ 点其中某个文件 | 只有该文件的 diff，另有「全部文件（完整 patch）」退回 ② |

这样**布局仍然是「两个区域 + 一条分隔条」**，`变更` 与 `历史` 两个模式共用同一套布局代码，
拖拽分隔条照常工作；提交区只在变更模式显示。

### 按日期分组

提交列表按**本地日历日**分组，标题形如 `2026年9月12日 的提交` / `Commits on Sep 12, 2026`
（GitHub 仓库历史页的做法），标题行 `position: sticky` 吸顶，左侧是一条**时间轴导轨**：
竖线串起每个分组的空心节点，节点右侧一段短横线与标题衔接，提交缩进排在导轨右侧。

导轨的实现方式是**每一行各自画一小段竖线**（`railGutter(theme, hasNode)`），行与行首尾相接
自然成为连续导轨。这样做有两个理由，都是踩过才知道的：

- 不必去测量整个列表的高度，也不必用绝对定位把一条长线钉在容器上
- **分组标题是 sticky 的**：若用一条贯穿全高的长线，标题吸顶滑动时节点会与线错位；
  短线段跟着各自的行走，节点永远在线上

节点的形状是 **`—◯—`**：左右各一段**对称**的横线（各 6.5px）。所有间距由 `22px` 的 gutter 统一
提供给标题行与提交列，因此两者的文字起点严格对齐（连接线必须收在 gutter 内：
`marginLeft + width ≤ gutter/2`，否则会压到标题文字）。

**与 GitHub 观感对齐的两处结构**（都是先做错、对比截图后才改对的）：

| 项 | 错的做法 | 为什么错 | 现在的做法 |
|---|---|---|---|
| 分组标题 | 整宽 `borderBottom` | 那条线**横穿导轨**，每个分组边界形成「十」字交叉，整列看起来像梯子 | 去掉下边框；sticky 只靠不透明背景遮蔽滚动内容 |
| 节点行的竖线 | 竖线贯穿整行（含标题行） | 节点上下会露出**两小段竖线残根**，很怪 | **竖线与节点互斥**：节点行不画竖线，由 `—◯—` 自己桥接上下两段 |
| 提交之间 | 通栏 `borderBottom` 分隔线 | 分隔线紧贴导轨起笔，与导轨一起把左侧糊成网格 | 每条提交是**内缩的圆角卡片**（`border` + `borderRadius: 6` + `margin`） |

### 插件样式表（`ensurePanelStyle`）

历史视图提到的悬停底色，用的就是上面 [交互态只能用样式表](#交互态只能用样式表) 里那张
样式表（固定 id、幂等，多实例也只注入一次）。它的完整内容是四组选择器：
keyframes、`:hover`、`:focus-visible`、细滚动条。

- **提交卡片的悬停底色**取 `--dsw-alias-interactive-bg-hover` 令牌并带兜底
- **没有 `prefers-color-scheme` 分支**：颜色全部走令牌，明暗由令牌自身切换。代码注释里
  写明了这一点（*"因此明暗主题自动跟随，不再需要 prefers-color-scheme 分支"*）——
  改用令牌之前确实有这条分支，现在已经删掉了。

三个纯函数，各有单测：

- `localDayKey(iso)` —— 用**本地**日而不是 UTC 切片：用户看到的时间是本地时间，按 UTC 切会把
  晚上提交的分到前一天
- `formatDayLabel(iso, localeId)` —— 交给 `Intl.DateTimeFormat`，而不是自己维护十二个月的翻译；
  未知语言回退到日期键
- `groupCommitsByDay(commits)` —— **只合并相邻同日**，不做全局归并。列表本就是时间倒序，全局归并
  会打乱顺序，也会让分页追加时同一天出现两个分组

设计取舍：

- **一次往返拿全**：`/show` 在打开整条提交时同时返回 patch 与文件清单（`--name-status` 与
  `--numstat` 两次调用合并），避免下钻时先请求清单再请求 patch。
- **分页而不是无限滚动**：`git log -n{limit+1} --skip=N` 多取一条用于判断 `hasMore`；`limit` 由
  客户端传（默认 50，服务端钳到 1–200）。大仓库上无限滚动容易卡顿。
- **提交时间用绝对时间**（`MM-DD HH:mm`）而不是「3 天前」：绝对时间无需时区/本地化处理、不随渲染
  刷新，而相对时间会在面板长时间开着时悄悄变旧。完整时间戳放在 `title` 里。
- 两条新路由（`/log`、`/show`）是**只读**的，且与其它路由共用同一个 `resolveRepo` 鉴权闸门；
  sha 经过 `^[0-9a-fA-F]{4,40}$` 校验，同时挡掉以 `-` 开头的伪参数。

## 已知坑与排查

真机迭代踩到的坑，都已修复并补了回归测试：

| 症状 | 根因 | 修法 |
|---|---|---|
| 面板显示 `this session has no working directory` | **`Session` 类没有顶层 `cwd`**。创建元数据挂在 `session.header.cwd` 上，所以 `session.cwd` 恒为 `undefined` | 读 `session.header.cwd`，并加 `clientCwd` 兜底（同样过工作区闸门） |
| 分支胶囊在部分会话里不出现 | **不是 bug**：那些会话的 cwd 真的不是 git 仓库。实测 215 个会话里 55 个如此（42 个在 `/Users/yomob/Demo`——该目录 `fatal: not a git repository`）。宿主如实返回 `not-a-repo` | 原先静默隐藏，无法区分「没有仓库」与「插件坏了」，改为显示弱化的**「无仓库」**胶囊，原因放 tooltip |
| 会话 cwd 是工作区**子目录**时拿不到仓库 | `workspaceRegistry.resolveByPath()` 是**精确相等**匹配（`entity.path === canonical`），子目录返回 `undefined` | 加包含关系回退：取包含该 cwd 的、最长（最具体）的工作区根。边界不变——仓库根仍须落在同一工作区内 |
| Git 标签页显示「这类内容还没有可用的查看方式。」（`tab.unavailable`） | **客户端 HMR 热重载会重跑 `apply()`**。我丢弃了 `sidebarRightTabs.register` 返回的 disposer —— 而它的契约原文是 *"The caller holds the returned disposer inside its own `ctx.effect`, so a type's registration lives exactly as long as the plugin that contributed it."* 注册因此活过本代插件，重载后撞上 `tab type id "git-lite" is already registered`；旧代码的**单个 try/catch** 吞掉这一抛并**跳过了后面的主体与标题注册**，两个 seat 同时缺失 | 每个注册各自 `ctx.effect(..., label)` 持有 disposer，四次注册互不连累；并且**冲突还要重试**——HMR 下新代 `apply()` 可能早于旧代 dispose，此时 id 仍被占着，光持有 disposer 救不了当次注册。`hang()` 对 `already registered` 这类**暂时**冲突按 60ms × 20 次重试（旧代释放后即补上），其余错误立刻打日志不空等。三条回归测试：disposer 是否被持有、单点失败是否仍注册其余、冲突是否重试并最终注册上 |
| 点「✨ 生成信息」只报**「模型没有返回提交信息」**，看不出真实原因 | 两个缺陷叠加：① `messages` 传成 `[{ role: 'user', content: '<裸字符串>' }]`，而 dsh-llm 契约要求 content 是**块数组**且消息带 `id` / `source` —— 适配器 `serializeMessages` 对 content 调 `.filter()` 直接抛错；② 该失败被 runtime 包成终止分片 `{ type: 'finish', reason: { kind: 'error', failure } }`，而 `streamToText` 只挑 `text-delta`，**把终止分片整条吞掉**，于是只剩空字符串，最后报出这句与真正原因无关的话 | `buildUserMessage()` 按契约组装（块数组 + `randomUUID()` 的 id + `plugin` source）；`streamToText()` 显式读 `finish`，`reason.kind` 为 `error` / `aborted` 时抛出提供方的 `failure.code` 与 `failure.message`（缺字段时有兜底文案）。6 条回归测试钉住消息形状与终止分片处理 |
| 「提交」按钮白字看不见、其它按钮描边发黑 | **`Btn` 把 `props.t`（i18n 字典）当成 theme 用**，于是 `t.fg` / `t.accent` / `t.border` 全是 `undefined`：主按钮 `background: undefined` → 白字无底色；普通按钮 `1px solid undefined` 是**非法 CSS**，整条声明被丢弃后回退成浏览器默认边框 | `Btn` 改为同时接收 `theme`（颜色）与 `t`（文案）。并补了**渲染层**测试：渲染整棵树后断言「任何样式值都不得是 undefined」——逻辑测试全绿也发现不了这类纯 UI 症状 |
| 日期分组标题比提交文字右移 8px | 导轨的连接线**越出 gutter** 压到标题，我当时用「给标题加 `paddingLeft: 8`」来避开，而提交列没有这 8px | 把 gutter 从 18 加宽到 22，连接线收在 gutter 内（`marginLeft + width ≤ gutter/2`），标题与提交列因此共享同一文字起点。补了测试断言两处 gutter 宽度一致、线段不越界 |
| 主按钮/选中分段变成**空白方块**（白底白字） | 用 `--dsw-alias-brand-primary` 当**填充**色。它其实是品牌**前景**色（浅色近黑、深色近白），名字有误导性 | 改用 `--dsw-alias-button-info-fill`（蓝色填充）配 `--dsw-alias-label-primary-foreground`（配对文字色）；测试同时断言「必须用前者」与「不得用后者」 |
| 分支胶囊要**等几秒**才出现 | 切会话时第一次 `/status` 常常赶在宿主把会话载入之前（此时如实返回 `session-unknown`，实测响应 <1ms），而下一次轮询要等一个完整的 6 秒周期 | 未拿到权威答复期间改为 **500ms 快重试**（连续 12 次后回常规节奏，不做无限快轮询）。同时 `session-unknown` 归类为「未就绪」而非「无仓库」：不显示弱化胶囊、面板也不弹红条 |

### 快速判断某个会话为什么没有胶囊

宿主会把原因放在 `error.code` 里，逐条对应：

| code | 含义 |
|---|---|
| `no-workspace` | 会话没有 cwd，或 cwd 在磁盘上已不存在 |
| `workspace-unknown` | cwd 不在任何已注册工作区之内 |
| `not-a-repo` | cwd 所在的目录链上没有 `.git` |
| `outside-workspace` | 仓库根在工作区之外（工作区是更大仓库的子目录） |

一条命令批量体检（把会话 cwd 与 `~/.dsh/storages/workspace.json` 对照，并试跑 `git rev-parse`）：

```sh
node -e 'const fs=require("fs"),path=require("path"),zlib=require("zlib"),cp=require("child_process");
const H=process.env.HOME, R=H+"/.dsh/sessions";
const ws=Object.values(JSON.parse(fs.readFileSync(H+"/.dsh/storages/workspace.json")).tables.workspaces).map(w=>w.path);
for(const d of fs.readdirSync(R)){const dp=path.join(R,d);if(!fs.statSync(dp).isDirectory())continue;
for(const s of fs.readdirSync(dp)){const f=path.join(dp,s,"session.v3.jsonl.zstd");if(!fs.existsSync(f))continue;
try{const h=JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(f)).toString("utf8").split("\n")[0]);
const c=h.cwd;let why;
if(!fs.existsSync(c))why="目录已不存在";else if(!ws.includes(c))why="不属于任何工作区";
else{try{cp.execSync("git -C "+JSON.stringify(c)+" rev-parse --show-toplevel",{stdio:"ignore"});why="OK 有仓库"}
catch{why="不是 git 仓库"}}
if(why!=="OK 有仓库")console.log(why.padEnd(16),c)}}catch{}}}' | sort | uniq -c | sort -rn
```

排查顺序建议：

1. `POST /git-lite/status` 带一个假 sessionId —— 若返回 `session-unknown`，说明**宿主半区已加载且路由正常**；若 404，说明插件没被加载（查 profile 的 `cordis.patch.yml`）。
2. 面板里的错误横幅就是宿主返回的 `error.message`，`error.code` 按上表定位。
3. 浏览器 console 里搜 `dsh-git-lite` —— 注册失败会打 `xx registration failed`。
4. 改了 `lib/index.js` **必须重启 `dsh web`**；只改 `lib/client.js` 刷新页面即可。**两者都改就要重启 + 刷新。**

## 改了之后到底要不要重启

`dsh-client-modules` 在**激活时**（宿主启动）用 `readFileSync` 把客户端 bundle 预读进内存，对外以
`/plugins/??<id>/client.js&rev=<内容哈希>` 提供，并配 `cache-control: max-age=31536000, immutable`。
`rev` 是内容哈希，所以**浏览器缓存本身是安全的**（内容变了 URL 就变）。

但服务器端是另一回事，两侧的行为不同：

| 改了 | 生效方式 |
|---|---|
| `lib/index.js`（宿主半区） | **必须重启 `dsh web`** —— 宿主半区在进程启动时加载 |
| `lib/client.js`（浏览器半区） | 本机实测**有 HMR watch 生效**：`install.sh` 写入文件即触发 `rebuilt()`，插件在页面里原地重载（依据：一次页面会话里出现过两个不同的 `rev`）。最稳妥仍是**完整刷新页面** |

**完整刷新页面**还有个额外好处：它会清掉任何一代遗留的注册（比如上面那条「已注册」的
历史遗留），从干净状态重新来一遍。

## 测试

纯 JS，无构建步骤。宿主半区 `lib/index.js`，浏览器半区 `lib/client.js`。

```sh
node --check lib/index.js
node --check lib/client.js
node tests/host-smoke.mjs     # 40 项：porcelain v2 解析、配置、鉴权拒绝面、包含关系回退、log/show 解析、路由装配、LLM 消息契约与终止分片
node tests/client-smoke.mjs   # 49 项：注册点与 disposer + 注册冲突重试 + 胶囊状态机 + clamp + 日期分组 + 渲染层检查
npm test                      # 两个都跑
```

两个冒烟测试都不需要 DSH 运行时：host 侧只验证纯函数与插件装配形状，client 侧用 `vm`
模拟 `window.__ModuleLoader__` 与 React。
