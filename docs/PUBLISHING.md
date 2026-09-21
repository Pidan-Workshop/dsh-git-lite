# 发布到 npm

`dsh-git-lite` 以**非 scoped**名字发布，所以谁发布、名字就归谁的 npm 账号所有
（不是 GitHub org —— org 只影响仓库，不影响包名归属）。首次 `npm publish` 即占用该名字。

## 发布前检查（可在无登录状态下完成）

```sh
npm test                 # host 40 项 + client 49 项
npm pack --dry-run       # 看 tarball 里到底有哪些文件
```

`npm pack --dry-run` 的预期内容（6 个文件）：

```
LICENSE.md  README.md  cordis.patch.yml  package.json
lib/client.js  lib/index.js
```

`tests/`、`docs/`、`install.sh`、`uninstall.sh`、`.gitignore` **不进包**，这是有意的：
测试与维护者文档只服务于仓库开发，两个脚本只服务于源码安装路径。
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
git tag -a v0.1.0 -m 'dsh-git-lite v0.1.0'
git push origin v0.1.0
```

### 6. 发布后验证

```sh
npm view dsh-git-lite version dist.tarball
npm view dsh-git-lite readme | head -20     # 确认 README 渲染正常、无坏链接
```

装回来验证一遍（需要 pnpm；若本机仍没有 pnpm，见下方「已知缺口」）：

```sh
dsh plugin --profile web add dsh-git-lite
```

## 版本号怎么走

`0.x` 阶段按语义化版本的最小可用规则推进即可：

| 改动 | 版本 |
|---|---|
| 修 bug、改文案、内部重构 | `0.1.1` |
| 新增功能 / 新增配置项 | `0.2.0` |
| 配置项语义变更、行为不兼容 | `0.3.0`（`0.x` 里 breaking 也升 minor） |

```sh
npm version patch   # 或 minor / major；会顺手打一个 git commit + tag
```

## 出错了怎么办

- **发错版本**：优先用 `npm deprecate dsh-git-lite@0.1.0 "说明"` 标记，而不是撤销。
  按 npm 现行规则，`npm unpublish` 有 72 小时窗口、且该版本号**不能再次发布**，
  名字占用与下载统计都不可逆。
- **包内容不对**：改完重新 `npm version patch` 再发，不要试图覆盖已发布的版本号。

## 已知缺口

- **本机没有 pnpm**（`which pnpm` 为空），所以 `dsh plugin --profile web add ...`
  这条路径无法在本机验证；发版后的「装回来」那一步要么先 `npm i -g pnpm`，
  要么换一台有 pnpm 的机器。源码安装路径（`bash install.sh`）不受影响。
- `docs/PUBLISHING.md` 本身不在 `package.json` 的 `files` 里，因此不会随包发布 ——
  它是给维护者看的，放仓库就够。
