# dsh-git-lite

DSH Web（DeepSeek Harness）的**右侧栏原生 Git 面板**。只看该看的、只做该做的：查看改动与行内 diff、拉取、推送、提交、切分支、stash。

A native Git tab for the DeepSeek Harness Web right sidebar — changes, inline diff, pull, push, commit, branches and stash.

## 功能

| 类别 | 内容 |
|---|---|
| **查看** | 变更文件列表（状态码 `M/A/D/R/?` + 增删行数，分「已暂存 / 变更 / 未跟踪」三组）→ 点击任意文件看**单栏行内着色 diff**（新增绿、删除红、块头紫，元信息灰） |
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
node tests/host-smoke.mjs     # 22 项：porcelain v2 解析、配置归一化、鉴权拒绝面、路由装配
node tests/client-smoke.mjs   # 19 项：三个注册点 + 浮层避让几何
npm test                      # 两个都跑
```

### 实现要点

- **宿主**：`inject: [webServer, sessions, workspaceRegistry]`，在 `ctx.webServer` 上挂 `/git-lite/*` 同源 JSON 路由；`llm` 与 `agentDefaultModel` 走**可选注入**，缺了它们插件其余功能照常工作。
- **浏览器**：`window.__ModuleLoader__.load({ id, factory })`，导出 `apply(ctx)` / `inject`。三个注册点：`sidebarRightTabs.register`（tab 类型）、`sidebar.right.pane.tab`（tab 主体，keyed seat，key = tab type id）、`conversation.session.header.utilities`（分支胶囊）。

  关于入口位置：胶囊曾放在 `conversation.input.dock`（输入框上方），但那里会额外占一行高度；改到会话头部右对齐的 `utilities` 区后，复用了头部本来空着的右侧空间。头部四个 seat 的分工是：`actions` 紧邻标题、`utilities` 右对齐、`corner` 最右角落且**仅容一个**控件（已被右侧栏的收回按钮占用）、`lineage` 替换面包屑标题。想改成紧邻标题，把槽位名换成 `conversation.session.header.actions` 即可。
- diff 由宿主返回 unified diff 文本，**浏览器侧解析着色** —— 宿主不做渲染，职责清晰。
- 未跟踪文件的 diff 由宿主按行合成，不依赖 `/dev/null`（跨平台）。
- 状态用 `git status --porcelain=v2 --branch -z`，重命名的原路径是独立 token，路径不被引号包裹。

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

## 已知坑与排查

真机首跑踩到的两个坑，都已修复并补了回归测试，记在这里免得重犯：

| 症状 | 根因 | 修法 |
|---|---|---|
| 面板显示 `this session has no working directory` | **`Session` 类没有顶层 `cwd`**。创建元数据挂在 `session.header.cwd` 上，所以 `session.cwd` 恒为 `undefined` | 读 `session.header.cwd`，并加 `clientCwd` 兜底（同样过工作区闸门） |
| 分支胶囊不出现 | **下游症状**，不是独立 bug。`BranchChip` 在 `/status` 失败时返回 `null`，所以只要 cwd 解析失败，胶囊就静默消失 | 修好 cwd 即同时消失 |

排查顺序建议：

1. `POST /git-lite/status` 带一个假 sessionId —— 若返回 `session-unknown`，说明**宿主半区已加载且路由正常**；若 404，说明插件没被加载（查 profile 的 `cordis.patch.yml`）。
2. 面板里的错误横幅就是宿主返回的 `error.message`，`error.code` 决定它属于哪一类（`no-workspace` / `workspace-unknown` / `not-a-repo` / `outside-workspace`）。
3. 浏览器 console 里搜 `dsh-git-lite` —— 注册失败会打 `sidebar tab registration failed`。
4. **改了 `lib/index.js` 必须重启 `dsh web`**（宿主半区在进程启动时加载）；只改 `lib/client.js` 刷新页面即可。

## License

MIT
