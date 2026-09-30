# 发布到 npm

`dsh-git-lite` 以**非 scoped**名字发布，所以谁发布、名字就归谁的 npm 账号所有
（不是 GitHub org —— org 只影响仓库，不影响包名归属）。首次 `npm publish` 即占用该名字。

## 发布前检查（可在无登录状态下完成）

```sh
npm test                 # host 49 项 + client 62 项
npm pack --dry-run       # 看 tarball 里到底有哪些文件
```

`npm pack --dry-run` 的预期内容（**8 个文件**）：

```
LICENSE.md  README.md  cordis.patch.yml  package.json
lib/client.js  lib/index.js
locale/en.json  locale/zh.json
```

`locale/*.json` 是「设置 → 插件」页里标题与描述的本地化词典（机制见
[DESIGN](https://github.com/Pidan-Workshop/dsh-git-lite/blob/main/docs/DESIGN.md)）。
**别把它们从 `files` 里删掉** —— 本地开发用 `link:` 直读仓库，漏了也看不出问题，
只有 npm 装回来才会发现插件页退化成裸包名 `dsh-git-lite` 且没有描述。

`tests/`、`docs/`、`install.sh`、`install.ps1`、`install.cmd`、`uninstall.*`、`.gitignore`
**不进包**，这是有意的：测试与维护者文档只服务于仓库开发，那几个脚本只服务于源码安装路径
（npm 安装路径由 `dsh plugin add dsh-git-lite` 自己完成，不需要脚本）。
README 里指向 `docs/DESIGN.md` 的链接用的是**绝对 GitHub 地址**，所以在 npm 页面上照样能点。

> **本机注意**：`~/.npm` 在工作区之外，DSH 沙箱会拦掉对它的写入，报成
> `EPERM ... _cacache`（npm 那句「root-owned files」提示是误报，`~/.npm` 其实归你所有）。
> 绕开办法是把缓存与日志指到临时目录：
>
> ```sh
> TMPC=$(mktemp -d)
> npm pack --dry-run --cache "$TMPC/cache" --logs-dir "$TMPC/logs"
> rm -rf "$TMPC"
> ```

## 发布步骤

### 1. 登录（必须你本人操作）

```sh
npm login          # 浏览器授权 + 可能的 OTP
npm whoami         # 应输出你的 npm 用户名
```

### 2. 确认名字仍可用

```sh
npm view dsh-git-lite version     # 首次发布应为 E404 Not Found
```

### 3. 真实打包并冒烟

不要只信 `--dry-run`：把真包解出来，确认 `main` / `exports` 指向的文件确实在包里。

```sh
TMPC=$(mktemp -d)
npm pack --pack-destination "$TMPC" --cache "$TMPC/cache" --logs-dir "$TMPC/logs"
cd "$TMPC" && tar -xzf dsh-git-lite-*.tgz
node --input-type=module -e "
  const m = await import('$TMPC/package/lib/index.js')
  console.log('入口可加载，导出：', Object.keys(m).join(', '))
"
```

### 4. 发布

```sh
npm publish --dry-run     # 最后一次确认
npm publish               # prepublishOnly 会先自动跑 npm test
```

### 5. 打 tag 并推送

```sh
git tag -a v0.2.0 -m 'dsh-git-lite v0.2.0 — DSH 0.2.0-rc.2（Web + 桌面）'
git push origin v0.2.0
```

### 6. 发布后验证

```sh
npm view dsh-git-lite version dist.tarball
npm view dsh-git-lite readme | head -20     # 确认 README 渲染正常、无坏链接
```

装回来验证一遍。桌面版用桌面自带的 CLI（它自带 pnpm，本机不需要另装）：

```powershell
# 完全退出 DeepSeek Harness 之后
.\uninstall.cmd                    # 先把 link: 装的卸掉，避免与 npm 版并存
.\install.cmd -Spec dsh-git-lite   # 从 npm 装
# 重启应用，确认 Git 标签页与分支胶囊都在
```

Web 版：`dsh plugin --profile web add dsh-git-lite`。

## 版本号怎么走

`0.x` 阶段按语义化版本的最小可用规则推进即可：

| 改动 | 版本 |
|---|---|
| 修 bug、改文案、内部重构 | `0.2.1` |
| 新增功能 / 新增配置项 | `0.3.0` |
| 配置项语义变更、行为不兼容 | `0.4.0`（`0.x` 里 breaking 也升 minor） |

**与 DSH 目标版本解耦**：本包版本号跟自己的改动走，不跟 dsh 的版本号对齐。
"支持哪个 dsh"由 `peerDependencies` 的 `@deepseek-ai/dsh-client-ui-sidebar-right` 范围表达
（当前 `^0.2.0-rc.2`），dsh 会在安装与启动时校验它。升 dsh 目标版本时改这个范围。

```sh
npm version patch   # 或 minor / major；会顺手打一个 git commit + tag
```

## 出错了怎么办

- **发错版本**：优先用 `npm deprecate dsh-git-lite@0.2.0 "说明"` 标记，而不是撤销。
  按 npm 现行规则，`npm unpublish` 有 72 小时窗口、且该版本号**不能再次发布**，
  名字占用与下载统计都不可逆。
- **包内容不对**：改完重新 `npm version patch` 再发，不要试图覆盖已发布的版本号。

## 已知缺口

- **本机没有独立的 `dsh`**（PATH 上没有，也没有全局安装），所以
  `dsh plugin --profile web add ...` 这条 **Web** 路径无法在本机验证 —— 桌面版路径可以，
  因为桌面自带 `resources/runtime/cli/bin/dsh.cmd` 且它自带 pnpm。
  要验 Web 路径，先 `npm i -g @deepseek-ai/dsh@0.2.0-rc.2`（**必须是同一个 0.2.0-rc.2**，
  否则 web profile 会按另一个 anchor 解析 bundle，行为与桌面版不一致）。
- `docs/PUBLISHING.md` 本身不在 `package.json` 的 `files` 里，因此不会随包发布 ——
  它是给维护者看的，放仓库就够。
