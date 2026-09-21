# dsh-git-lite

DSH Web（DeepSeek Harness）右侧栏的轻量 Git 面板 —— **直接调用你本机的 `git`**，在侧边栏里看改动、行内 diff、拉取、推送、提交、切分支、stash，不用切到终端。

A lite Git tab for the DeepSeek Harness Web sidebar, driven by your local git: changes, inline diff, pull, push, commit, branches and stash.

- 轻量：只做基础 Git 操作，不做 DAG 图、不做交互式 rebase。
- 原生行为：调用本机 `git` 二进制，遵守你的 `~/.gitconfig`、hooks 和凭据配置，不另存 token。
- 无依赖、无构建：纯 JS，`dependencies` 为空。

## 功能

| 类别 | 内容 |
|---|---|
| **查看改动** | 变更文件列表（状态码 `M/A/D/R/?` + 增删行数，分「已暂存 / 变更 / 未跟踪」三组），点任意文件看**单栏行内着色 diff** |
| **提交历史** | 提交列表（短 sha、信息、refs 徽标、作者、时间，按日期分组）→ 点开看该提交完整 patch 与文件清单 → 再点文件看单文件 diff；「加载更早的 50 条」分页 |
| **同步** | **拉取**（默认 `--ff-only`，分叉时明确拒绝而不是悄悄产生合并提交）、**抓取**（`fetch --all --prune`） |
| **推送** | **两阶段确认**：先看将推送的分支 / 上游 / ahead 数 / commit 列表，确认后才真正执行 |
| **提交** | 暂存 / 取消暂存（可勾「全部暂存」）；两条提交路径见下 |
| **分支** | 下拉切换本地分支；工作区有冲突改动时给出明确提示 |
| **暂存** | `git stash push` / `git stash pop` |
| **入口** | 右侧栏「Git」标签页、工作区启动卡、以及会话头部右侧的**分支胶囊**（分支名 + 改动数 + ahead/behind） |

界面语言跟随 DSH 的 locale（中文 / English），配色取 DSH 设计令牌，因此**明暗主题与第三方主题包自动跟随**。

## 安装

### 前置条件

- 一个带官方右侧栏多标签框架 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 **DSH Web**。
  本插件在 **DSH `0.1.5-rc.2`** 上开发与验证。
- 本机有 `git`（面板直接调用它）。

### 方式 A：从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-git-lite
```

> `dsh plugin` 把参数转发给 pnpm，因此需要 PATH 上有 **pnpm**；没有会报
> `pnpm not found on PATH`，那就改用方式 B。

### 方式 B：从源码安装（不需要 pnpm）

```sh
git clone https://github.com/Pidan-Workshop/dsh-git-lite.git
cd dsh-git-lite
bash install.sh
```

脚本做两件事：把包拷进 `~/.dsh/profiles/web/node_modules/`，并往该 profile 的
`cordis.patch.yml` **幂等**追加一行加载器条目（已存在则跳过，可重复执行）。

装到别的 profile：

```sh
DSH_PROFILE_DIR=~/.dsh/profiles/dev bash install.sh
```

在源码上改代码、想让改动立刻在页面里生效，用链接安装：

```sh
dsh plugin --profile web add link:/path/to/dsh-git-lite
```

### 装完重启

**重启 `dsh web`** 后生效。然后打开右侧栏切到 **Git** 标签页，或直接点会话头部右侧那个带分支名的胶囊。

### 卸载

用 CLI 装的：

```sh
dsh plugin --profile web remove dsh-git-lite
```

用脚本装的：

```sh
bash uninstall.sh
```

后者移除包本体与 `cordis.patch.yml` 里的加载器条目，并保留 `.bak-git-lite` 备份。

> ⚠️ 在 profile 里跑 `pnpm install` 会清理手工放置的包，重装依赖后请重跑 `install.sh`。

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

全部可选。在 profile 的 `cordis.patch.yml` 里给加载器条目加 `config`：

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

## 常见问题

**右侧栏没有「Git」标签页？**
先确认装完**重启过 `dsh web`**，再查 profile 的 `cordis.patch.yml` 里有没有 `id: git-lite` 那一行。

**胶囊一直是灰色「无仓库」？**
说明该会话的目录确实不是 git 仓库，或不在已注册工作区里。悬停看 tooltip，具体原因有四类：
`no-workspace`（没有工作目录或目录已不存在）、`workspace-unknown`（不在任何工作区里）、
`not-a-repo`（目录链上没有 `.git`）、`outside-workspace`（仓库根在工作区之外）。
这不是插件故障 —— 而是如实告诉你这里没有仓库可用。

**拉取报分叉错误？**
默认 `pullMode: ff-only`，本地与远端各有提交时会**拒绝**而不是替你造一个合并提交。
想让它自动合并，把 `pullMode` 改成 `merge`，或回终端处理。

**推送/拉取提示凭据错误？**
面板在无终端的 web 进程里运行，缺凭据时会**立刻失败**而不是挂住等输入。
先在本机终端里对该仓库跑一次 `git push`，让凭据助手记好，再回面板操作。

**改了代码什么时候要重启？**
改了 `lib/index.js`（宿主半区）**必须重启 `dsh web`**；只改 `lib/client.js`（浏览器半区）
刷新页面即可；两者都改就重启 + 刷新。

## 开发

纯 JS，无构建步骤。宿主半区 `lib/index.js`，浏览器半区 `lib/client.js`。

```sh
node --check lib/index.js
node --check lib/client.js
npm test                      # host 冒烟 40 项 + client 冒烟 49 项
```

两个冒烟测试都不需要 DSH 运行时。

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
