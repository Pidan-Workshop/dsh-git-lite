# dsh-git-lite

DSH Web（DeepSeek Harness）的**右侧栏原生 Git 面板**。只看该看的、只做该做的：查看改动与行内 diff、拉取、推送、提交、切分支、stash。

A native Git tab for the DeepSeek Harness Web right sidebar — changes, inline diff, pull, push, commit, branches and stash.

## 功能

| 类别 | 内容 |
|---|---|
| **查看** | 变更文件列表（状态码 `M/A/D/R/?` + 增删行数，分「已暂存 / 变更 / 未跟踪」三组）→ 点击任意文件看**单栏行内着色 diff**（新增绿、删除红、块头紫，元信息灰） |
| **历史** | **提交列表**（短 sha、提交信息、refs 徽标、作者、时间）→ 点开看该提交的**完整 patch** 与文件清单 → 再点文件看单文件 diff；底部「加载更早的 50 条」 |
| **同步** | **拉取**（默认 `--ff-only`，分叉时明确拒绝并给出可操作提示）、**抓取**（`fetch --all --prune`） |
| **推送** | **两阶段确认**：先看将推送的分支/上游/ahead 数/commit 列表，确认后才执行 |
| **提交** | 暂存 / 取消暂存（也可勾「全部暂存」）；两条提交路径见下 |
| **分支** | 下拉切换本地分支，脏工作区冲突时给出明确提示 |
| **暂存** | `git stash push` / `git stash pop` |
| **入口** | 右侧栏「Git」标签页 + 工作区启动卡 + **会话头部右对齐区的分支胶囊**（显示分支名、改动数、ahead/behind） |

界面语言跟随 DSH 的 locale（中文 / English），明暗主题跟随系统。

## 安装

### 方式 A：脚本（本机可用，推荐）

```sh
bash install.sh
```

把包拷进 `~/.dsh/profiles/web/node_modules/`，并往 profile 的 `cordis.patch.yml` 幂等追加加载器条目。指定其它 profile：

```sh
DSH_PROFILE_DIR=~/.dsh/profiles/dev bash install.sh
```

卸载：`bash uninstall.sh`（会保留 `.bak-git-lite` 备份）。

### 方式 B：官方 CLI（需要 pnpm）

```sh
dsh plugin --profile web add dsh-git-lite                 # npm 发布后
dsh plugin --profile web add link:/path/to/dsh-git-lite   # 链接安装，改完刷新页面即生效
```

> ⚠️ `dsh plugin` 底层转发给 pnpm。**当前这台机器 PATH 上没有 pnpm**（`dsh plugin` 会报
> `pnpm not found on PATH`），所以在本机请用方式 A。装好 pnpm 后方式 B 才可用。

### 都要重启

装完**重启 `dsh web`** 才生效。然后打开右侧栏，切到 **Git** 标签页（或点会话头部右侧那个带分支名的胶囊）。

> `pnpm install` 会清理手工放置的包，重装依赖后请重跑 `install.sh`。

### 运行环境

需要带官方右侧栏多标签框架 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 DSH Web。已在 **DSH `0.1.5-rc.2`** 上开发与验证。

## 两条提交路径（这是本插件的核心区分）

「AI 写的提交信息」和「你直接跟 agent 说提交一下」**不是一回事**，取决于走哪条路径：

### 1. `✨ 生成信息` + `提交`

宿主半区把 `git status` + `git diff` + 最近 10 条 commit subject 喂给会话默认模型，生成信息填进输入框，你改完再点「提交」。

- **能看到**：改了什么
- **看不到**：为什么改 —— 它没有对话上下文，只有 diff
- **风格**：由 prompt 约束（首行祈使句 ≤72 字符、可选 body、按最近提交的语言对齐）
- **代价**：快，不消耗会话轮次

### 2. `交给 Agent 提交`

通过官方 `ISession.prompt()` 往当前会话投一条用户消息，由会话 agent 用**完整对话上下文**自己暂存、写信息、提交。

- **与你在输入框里打字说「提交一下」走的是同一条路径**，因此信息质量与风格推断完全一致
- agent 会自己 `git log` 看仓库既有风格再跟
- 代价：异步（不是立刻填好一个框让你改），且消耗一个会话轮次；提交过程作为普通一轮出现在会话日志里，可审计、可中断

**建议**：日常小改动用路径 1；改动背后有「为什么」要说清楚时，用路径 2。

## 安全模型

这台插件把安全放在结构里，而不是放在字符串过滤里：

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

## 配置

全部可选，在 profile 的 `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- insert:
    - id: git-lite
      name: dsh-git-lite
      inject: [webServer, sessions, workspaceRegistry]
      config:
        pullMode: ff-only        # ff-only（默认）| merge
        maxDiffBytes: 262144     # diff 返回上限，超出截断并标记
        confirmTtlMs: 120000     # push 确认 token 有效期
        messagePrompt: ''        # 覆盖 AI 生成提交信息的 system prompt
        commitPrompt: ''         # 覆盖「交给 Agent 提交」注入的指令文本
```

## 开发

纯 JS，无构建步骤。宿主半区 `lib/index.js`，浏览器半区 `lib/client.js`。

```sh
node --check lib/index.js
node --check lib/client.js
node tests/host-smoke.mjs     # 34 项：porcelain v2 解析、配置、鉴权拒绝面、包含关系回退、log/show 解析、路由装配
node tests/client-smoke.mjs   # 43 项：注册点与 disposer 持有 + 浮层避让 + 胶囊状态机 + 分隔条 clamp + 时间格式化
npm test                      # 两个都跑
```

### 实现要点

- **宿主**：`inject: [webServer, sessions, workspaceRegistry]`，在 `ctx.webServer` 上挂 `/git-lite/*` 同源 JSON 路由；`llm` 与 `agentDefaultModel` 走**可选注入**，缺了它们插件其余功能照常工作。
- **浏览器**：`window.__ModuleLoader__.load({ id, factory })`，导出 `apply(ctx)` / `inject`。三个注册点：`sidebarRightTabs.register`（tab 类型）、`sidebar.right.pane.tab`（tab 主体，keyed seat，key = tab type id）、`conversation.session.header.utilities`（分支胶囊）。

  关于入口位置：胶囊曾放在 `conversation.input.dock`（输入框上方），但那里会额外占一行高度；改到会话头部右对齐的 `utilities` 区后，复用了头部本来空着的右侧空间。头部四个 seat 的分工是：`actions` 紧邻标题、`utilities` 右对齐、`corner` 最右角落且**仅容一个**控件（已被右侧栏的收回按钮占用）、`lineage` 替换面包屑标题。想改成紧邻标题，把槽位名换成 `conversation.session.header.actions` 即可。
- diff 由宿主返回 unified diff 文本，**浏览器侧解析着色** —— 宿主不做渲染，职责清晰。
- 未跟踪文件的 diff 由宿主按行合成，不依赖 `/dev/null`（跨平台）。
- 状态用 `git status --porcelain=v2 --branch -z`，重命名的原路径是独立 token，路径不被引号包裹。

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

## 面板布局

从上到下五段，固定段与弹性段分开：

| 段 | 伸缩 | 说明 |
|---|---|---|
| 分支下拉 + ahead/behind | `0 0 auto` | 固定 |
| 操作条（拉取/抓取/推送/刷新/stash） | `0 0 auto` | 固定 |
| 提示行（错误/成功） | `0 0 auto` | 固定，仅在有内容时出现 |
| **变更列表 ↔ diff** | `1 1 auto` | **中间用可拖拽分隔条分配** |
| 提交区 | `0 0 auto` | 固定，含避开第三方浮层的动态内缩 |

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

夹取逻辑抽成纯函数 `clampListHeight(next, bodyHeight, listMin, diffMin)` 并单测 6 项——
**clamp 边界写错会让某一侧塌成 0 高度，看起来像"内容不见了"**，这是真机上最难自查的一类布局
bug，所以它值得有测试钉住。空间实在不够时（`容器高 < 列表最小值 + diff 最小值`）优先保住
diff 的最小可读高度，且绝不返回负数。

## 与第三方浮动按钮共存

其它插件常往视口右下角钉一个 `position: fixed` 的悬浮按钮（例如 `dsh-godot-play`
的「▶ 试玩游戏」：`right: 14px; bottom: 14px; z-index: 2147483000`）。本插件的提交区
恰好也在面板底部，两者可能撞上。

**不做硬编码留白**，而是实测后按需让位（`useOverlayInset`）：

- 只检查 `document.body` 的**直接子元素**中 `position` 计算值为 `fixed` 的元素 ——
  悬浮按钮几乎总是挂在 body 下，这样避免遍历整棵树并逐节点取 computed style
- 横向用**按钮的实际视觉跨度**（子元素并集），不是容器宽度。容器是 `flex-wrap`
  的整行、宽度永远撑满面板；按容器算的话，全屏时按钮明明挤在左边、右侧全是空白，
  也会误判为相交
- 高度超过视口 40% 的浮层跳过：那是整块面板而不是悬浮按钮，盖住时本来也点不到
- 纵向基准是**提交区的外底边**，不是操作行自身。给提交区加 `padding-bottom` 不会
  移动这条边，所以测量与结果不会互相反馈、不会振荡
- 触发时机：挂载、窗口 resize、`document.body` 的 childList 变化（`MutationObserver`，
  覆盖「浮层后出现 / 后消失」）
- 内缩上限 240px，避免全屏浮层把操作区挤没

净效果：全屏宽面板下按钮在左边、浮层在右边，**不让位**；侧边栏收窄到按钮换行铺满
宽度、真的会被压住时才让位。几何判断抽成了纯函数 `computeOverlayInset` 并单测
（8 项），因为这段逻辑只在浏览器里生效、却最容易写错。

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

设计取舍：

- **一次往返拿全**：`/show` 在打开整条提交时同时返回 patch 与文件清单（`--name-status` 与
  `--numstat` 两次调用合并），避免下钻时先请求清单再请求 patch。
- **不做提交 DAG 泳道图**：那是 `dsh-git-panel` 花 4000 行做的事，与本插件「基础功能」的定位不符。
- **分页而不是无限滚动**：`git log -n 51 --skip=N` 多取一条用于判断 `hasMore`；大仓库上无限滚动
  容易卡顿。
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
| Git 标签页显示「这类内容还没有可用的查看方式。」（`tab.unavailable`） | **客户端 HMR 热重载会重跑 `apply()`**。我丢弃了 `sidebarRightTabs.register` 返回的 disposer —— 而它的契约原文是 *"The caller holds the returned disposer inside its own `ctx.effect`, so a type's registration lives exactly as long as the plugin that contributed it."* 注册因此活过本代插件，重载后撞上 `tab type id "git-lite" is already registered`；旧代码的**单个 try/catch** 吞掉这一抛并**跳过了后面的主体与标题注册**，两个 seat 同时缺失 | 每个注册各自 `ctx.effect(..., label)` 持有 disposer，且四次注册互不连累。两条回归测试：disposer 是否被持有、单点失败是否仍注册其余 |
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

### 改了之后到底要不要重启

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

## License

MIT
