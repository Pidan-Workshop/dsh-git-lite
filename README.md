# dsh-git-lite

DSH（DeepSeek Harness）右侧栏的轻量 Git 面板 —— **Web 版与桌面版通用**，**直接调用你本机的 `git`**，在侧边栏里看改动、行内 diff、拉取、推送、提交、切分支、stash，不用切到终端。

A lite Git tab for the DeepSeek Harness sidebar, for both the web and desktop builds, driven by your local git: changes, inline diff, pull, push, commit, branches and stash.

- 轻量：只做基础 Git 操作，不做 DAG 图、不做交互式 rebase。
- 原生行为：调用本机 `git` 二进制，遵守你的 `~/.gitconfig`、hooks 和凭据配置，不另存 token。
- 无依赖、无构建：纯 JS，`dependencies` 为空。
- 面向 **DSH `0.2.0-rc.2`**；Web 与桌面是同一套 Web 组合，所以同一份代码两边都能跑（差别只在装进哪个 profile，见「安装」）。

## 功能

| 类别 | 内容 |
|---|---|
| **查看改动** | 变更文件列表（状态码 `M/A/D/R/?` + 增删行数，按「**冲突** / 已暂存 / 变更 / 未跟踪」分组，冲突组只在有冲突时出现且排最前），点任意文件看**单栏行内着色 diff** |
| **提交历史** | 提交列表（短 sha、信息、refs 徽标、作者、时间，按日期分组）→ 点开看该提交完整 patch 与文件清单 → 再点文件看单文件 diff；「加载更早的 50 条」分页 |
| **同步** | **拉取**（默认 `--ff-only`，分叉时明确拒绝而不是悄悄产生合并提交）、**抓取**（`fetch --all --prune`） |
| **推送** | **两阶段确认**：先看将推送的分支 / 上游 / ahead 数 / commit 列表，确认后才真正执行 |
| **提交** | 暂存 / 取消暂存（可勾「全部暂存」）；两条提交路径见下 |
| **批量暂存** | 两个分组的**标题右端**各有一个动作：「变更 / 未跟踪」组头 = `全部暂存`（`git add -A`）、「已暂存」组头 = `全部取消暂存`（`git restore --staged`）—— **只动暂存区、不提交**，且不额外占一行高度（代价：组头不是吸顶的，列表滚下去时会跟着滚走） |
| **冲突** | 未解决冲突**单独成一组**排在列表最前（红色组头 + 文件行）。冲突行右侧是**不可点的 `!`**（不是 `−`/`+`：`git add` 会把冲突标记当成解决结果，而 `−` 正好会把它送进「变更」组拿到 `+`），详情区也不提供暂存 / 取消暂存。两条批量按钮同样**都拒绝执行**，唯一出路是「**Agent 解决冲突**」（只解决、不提交）。点开冲突文件能看到带 `<<<<<<<` 标记的差异；modify/delete 这类 git 不提供差异的冲突，面板会说明是哪种冲突以及两条出路。有冲突时**「提交」按钮也是禁用的** —— git 在存在未解决条目时一律拒绝提交 |
| **分支** | 下拉切换本地分支；工作区有冲突改动时给出明确提示 |
| **储藏** | `git stash push` / `git stash pop` |
| **入口** | 右侧栏「Git」标签页、工作区启动卡、以及会话头部右侧的**分支胶囊**（分支名 + 改动数 + ahead/behind） |

界面语言跟随 DSH 的 locale（中文 / English），配色取 DSH 设计令牌，因此**明暗主题与第三方主题包自动跟随**。

## 安装

> **profile 是分开的。** 桌面版读 `~/.dsh/profiles/desktop`，Web 版读 `~/.dsh/profiles/web`。
> 装到哪个 profile，插件就只出现在哪个版本里 —— 装进 `web` 却去桌面版找「Git」标签页，是找不到的。
>
> 桌面 profile 由桌面应用**独占管理**：用 PATH 上的普通 `dsh` 跑 `plugin --profile desktop`
> 会被直接拒绝（`error: profile "desktop" is managed exclusively by the Electron application`）。
> 必须用桌面安装目录里的 CLI（`<安装目录>\resources\runtime\cli\bin\dsh.cmd`）—— 下面的脚本会自动找到它。
> 装/卸之前请**完全退出** DeepSeek Harness（含托盘图标），装完再启动。

### 前置条件

- **DSH `0.2.0-rc.2`**。Web 版与桌面版跑的是同一套 Web 组合，所以两边行为一致，本版本两边都验证。
  插件依赖官方右侧栏框架 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 0.2.0 契约。
- 本机有 `git`（面板直接调用它）。**不需要 pnpm** —— 桌面自带的 CLI 内含 pnpm。

### 桌面版（Windows）

```powershell
# 1) 完全退出 DeepSeek Harness（含托盘图标）
# 2) 从源码链接安装：改完代码刷新页面即生效
.\install.cmd
# 3) 重新启动 DeepSeek Harness
```

`install.cmd` 只是 `install.ps1` 的薄包装。本机执行策略是 AllSigned，直接跑 `.ps1`
会报「未对文件进行数字签名」，包装脚本用**进程级** `-ExecutionPolicy Bypass` 绕开。
想先看它到底要执行什么，加 `-DryRun`：

```powershell
.\install.cmd -DryRun
# 桌面安装：E:\Application\DeepSeek Harness  (DSH 0.2.0-rc.2)
# CLI      ：…\resources\runtime\cli\bin\dsh.cmd
# profile  ：desktop  (C:\Users\<你>\.dsh\profiles\desktop)
# 安装源   ：link:E:\Game\Pidan-Workshop\dsh-git-lite
# （DryRun）将执行：& '…\dsh.cmd' plugin --profile desktop add link:E:\…\dsh-git-lite
```

脚本**不自己拼 profile 的加载器条目**，而是把活交给官方 CLI：一个组合包（bundle）
要同时登记 profile 的 `dependencies`、`dsh.profile.bundles` 与 `cordis.patch.yml` 三处，
官方实现才是权威，手搓很容易半对半错（症状是标签页不出现、或出现两次）。

也可以完全手打（脚本做的就是这件事）：

```powershell
& "$env:ProgramFiles\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add link:E:\path\to\dsh-git-lite
```

### Web 版

```sh
# 同版本的 dsh 在 PATH 上（npm i -g @deepseek-ai/dsh@0.2.0-rc.2）
dsh plugin --profile web add dsh-git-lite                    # npm 发布后
dsh plugin --profile web add /path/to/dsh-git-lite           # 本地目录
dsh plugin --profile web add link:/path/to/dsh-git-lite      # 链接安装，改完刷新即生效
```

桌面自带的 CLI 同样能装 web profile（它自带 pnpm，所以本机不需要另外装）：

```sh
dsh.cmd plugin --profile web add dsh-git-lite
```

### 装完重启

**重启 `dsh web` / DeepSeek Harness** 后生效。然后打开右侧栏切到 **Git** 标签页，
或直接点会话头部右侧那个带分支名的胶囊。

### 卸载

```powershell
.\uninstall.cmd                 # 桌面版
.\uninstall.cmd -Profile web    # Web 版
```

等价于 `dsh plugin --profile <profile> remove dsh-git-lite`。

### 版本不兼容会被拦下

`package.json` 对 `@deepseek-ai/dsh-client-ui-sidebar-right` 声明了 peer 范围
`^0.2.0-rc.2`。dsh 在**安装时与每次启动时**都会读它，运行时版本不满足会明确拒绝，
而不是让插件半死不活。确实要放行（自担崩溃与数据损坏风险）：

```sh
dsh plugin --profile desktop allow-version dsh-git-lite@0.2.0 --dsh-version <精确运行时版本> --accept-risk
```

### 从 0.1.5-rc.2 升级

0.2.0 的客户端半区有两处不兼容，本版本已迁移；**不支持 0.1.x**，升级前请先卸载旧版：

| 旧写法（0.1.5） | 新写法（0.2.0） |
|---|---|
| `sessions.list.getSnapshot().current` 取会话 id | 席位标准套件下发的 `props.sessionId` |
| `sessions.binding(id).session.prompt(...)` 发消息 | `ctx.sessions.scope(id).get('conversation').send(text)` |

前者的症状值得记一笔：`sessions.list` 还在，但它的 state 里**已经没有 `current`**，
于是旧代码拿到的永远是 `undefined`，面板发出的每个请求都缺 `sessionId`、宿主一律回
`bad-request` —— **不抛异常**，表现为「面板一直加载不出东西」，极易被误判成宿主的问题。

## 使用

### 两条提交路径（本插件的核心区分）

「让 AI 写一条提交信息」和「让 agent 帮你提交」**不是一回事**：

**① `✨ 生成信息` + `提交`**

宿主把 `git status` + `git diff` + 最近 10 条提交标题喂给模型，生成信息填进输入框，你改完再点「提交」。

- 能看到：改了什么；**看不到：为什么改**（它没有对话上下文，只有 diff）
- 快，且不消耗会话轮次

**② `交给 Agent 提交`**

往当前会话投一条消息，由会话 agent 用**完整对话上下文**自己暂存、写信息、提交。

- 与你在输入框里手打「提交一下」走的是**同一条路径**，信息质量与风格推断一致
- agent 会自己看仓库既有风格再跟
- 代价：异步、消耗一个会话轮次；提交过程作为普通一轮出现在会话日志里，可审计、可中断

**怎么选**：日常小改动用 ①；改动背后有「为什么」要说清楚时用 ②。

提交区三个按钮的顺序刻意是 `✨ 生成信息` → `交给 Agent 提交` → `提交`：辅助动作在前，
**你自己提交的按钮放最后**（主操作靠右）。三个按钮各带说明浮层。

### 推送为什么要点两次

推送是面板里唯一会改动远端的操作，所以做成两阶段：

1. 点「推送」→ 只返回**预览**：分支、上游、ahead 数、将要推送的 commit 列表。
2. 你确认后才执行。确认时会校验 token 未用过、未过期，且 **HEAD 与分支仍与预览时一致**（防止预览之后仓库又变了）。

另外，**force push 在结构上不可能**：推送命令的参数由宿主内部构造，只推当前分支到其上游，
客户端无法注入参数。

### 分支胶囊

会话头部右侧的胶囊显示当前分支、改动数、ahead/behind，点一下打开面板。

- 会话目录不是 git 仓库时，胶囊显示为**虚线弱化的「无仓库」**（而不是静默消失 —— 那样分不清「没仓库」和「插件坏了」），鼠标悬停看原因。
- 切会话时先清空再重新加载，所以不会把上一个会话的分支名短暂显示给你。

## 配置

全部可选。自定义 profile 的加载器条目时在 `cordis.patch.yml` 里给它加 `config`
（桌面版是 `~/.dsh/profiles/desktop/cordis.patch.yml`，Web 版是 `.../web/...`）：

```yaml
- insert:
    - id: git-lite
      name: dsh-git-lite
      inject: [webServer, sessions, workspaceRegistry]
      config:
        pullMode: ff-only        # ff-only（默认）| merge
        maxDiffBytes: 262144     # diff 返回上限，超出截断并标记
        confirmTtlMs: 120000     # push 确认 token 有效期（毫秒）
        messagePrompt: ''        # 覆盖「生成信息」用的 system prompt
        commitPrompt: ''         # 覆盖「交给 Agent 提交」注入的指令文本
```

> 用 `dsh plugin add` 装的话，条目由 bundle 自身的 `cordis.patch.yml` 提供；
> 上面这种写法是给"自己插加载器条目"的场景（例如已手工放进 `node_modules` 的包）
> 加配置用的。

### 插件页里的标题与描述

「设置 → 插件」页显示的**标题与描述跟随界面语言**（中文 / English），词典在
`locale/en.json` 与 `locale/zh.json`：

```jsonc
// locale/zh.json
{ "meta": { "title": "Git 面板", "description": "右侧栏的轻量 Git 面板，直接调用你本机的 git：…" } }
```

要给自己的 fork 再加一门语言，就往 `locale/` 里再放一个 `<语言 id>.json`
（例如 `ja.json`），字段同为 `meta.title` / `meta.description`。两条硬性要求：该文件必须靠
`package.json` 的 `exports` 放行（`"./locale/*.json"`）**并且**写进 `files` ——
否则 dsh 会**静默**退回成「显示裸包名、没有描述」，本地用 `link:` 开发时完全看不出问题。

## 常见问题

**右侧栏没有「Git」标签页？**
按顺序查三件事：

1. **装到哪个 profile 了？** 桌面版读 `desktop`，Web 版读 `web`，两者互不相通。
   查 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-git-lite`。
2. **重启过应用吗？** 装/卸都需要重启才生效。
3. **启动被告知版本不兼容了吗？** `package.json` 的 peer 范围是 `^0.2.0-rc.2`；
   运行时不是 0.2.x 时 dsh 会明确拒绝加载，而不是静默。按 README「版本不兼容会被拦下」处理。

**胶囊一直是灰色「无仓库」？**
说明该会话的目录确实不是 git 仓库，或不在已注册工作区里。悬停看 tooltip，具体原因有四类：
`no-workspace`（没有工作目录或目录已不存在）、`workspace-unknown`（不在任何工作区里）、
`not-a-repo`（目录链上没有 `.git`）、`outside-workspace`（仓库根在工作区之外）。
这不是插件故障 —— 而是如实告诉你这里没有仓库可用。

**面板一直加载不出东西，或提示 `sessionId is required`？**
那是 0.2.0 之前「拿不到会话身份」的症状。本版本已改为从席位标准套件取
`props.sessionId`；若你在自己的 fork 里看到它，说明回退到了读 `sessions.list.current`
的旧写法（该字段在 0.2.0 已被移除）。`npm test` 里有一条回归闸门专门钉这个。

**拉取报分叉错误？**
默认 `pullMode: ff-only`，本地与远端各有提交时会**拒绝**而不是替你造一个合并提交。
想让它自动合并，把 `pullMode` 改成 `merge`，或回终端处理。

**推送/拉取提示凭据错误？**
面板在无终端的 web 进程里运行，缺凭据时会**立刻失败**而不是挂住等输入。
先在本机终端里对该仓库跑一次 `git push`，让凭据助手记好，再回面板操作。

**改了代码什么时候要重启？**
改了 `lib/index.js`（宿主半区）**必须重启应用**；只改 `lib/client.js`（浏览器半区）
刷新页面即可；两者都改就重启 + 刷新。

## 开发

纯 JS，无构建步骤。宿主半区 `lib/index.js`，浏览器半区 `lib/client.js`。

```sh
node --check lib/index.js
node --check lib/client.js
npm test                      # host 冒烟 49 项 + client 冒烟 62 项
```

两个冒烟测试都不需要 DSH 运行时，但 host 冒烟会**真的调用本机 git**（`resolveRepo`
的仓库解析用例），所以需要一个能正常 spawn 子进程的环境。

> **Windows 检出注意**：仓库里按 `.editorconfig` 存的是 LF，而 `core.autocrlf=true`
> 会把它检成 CRLF。以前有几条用例硬编码了 `\n` 与 POSIX 的 `/tmp`，在 Windows 上会
> **假红**；现在 client 冒烟先归一化行尾，host 冒烟用 `os.tmpdir()` 当"存在但不是仓库"
> 的样本，两个平台都能过。

设计取舍、安全模型细节、以及真机迭代踩过的坑（含每个 bug 的根因与回归测试），
都在 **[docs/DESIGN.md](https://github.com/Pidan-Workshop/dsh-git-lite/blob/main/docs/DESIGN.md)**
（npm 页面上相对链接会失效，所以这里用绝对地址）。

## 安全

- **工作目录由宿主解析**：客户端只发 sessionId，不传路径。目录要依次通过 `realpath` 解析、
  已注册工作区校验、以及「git 仓库根仍在该工作区内」三道闸门，所以不存在「让宿主在任意目录跑 git」这条路。
- **参数由宿主构造**：`argv` 一律以数组传给 `execFile`，绝不由客户端拼接，不存在 shell 注入面；
  路径参数拒绝绝对路径与 `..` 逃逸，分支名以 `-` 开头直接拒绝。
- **推送需二次确认**，且 force push 结构上不可能。

## License

MIT © Pidan Workshop
