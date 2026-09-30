#!/usr/bin/env pwsh
<#
.SYNOPSIS
  把 dsh-git-lite 装进一个 DSH profile。**桌面版与 Web 版都走同一条命令。**

.DESCRIPTION
  本脚本刻意**不自己拼 profile 的加载器条目**，而是把活交给官方 CLI
  （dsh plugin … add）。原因：一个「组合包（bundle）」要同时登记三处 ——
  profile 的 package.json dependencies、dsh.profile.bundles，以及
  cordis.patch.yml 的协调 —— 官方实现才是权威；手搓容易半对半错，
  而半错的症状（标签页不出现、或出现两次）很难查。

  桌面版要点（与本仓库 README 的说明一致）：
    · `desktop` profile 由桌面应用独占管理。用 PATH 上的普通 dsh 跑
      `plugin --profile desktop` 会被直接拒绝：
        error: profile "desktop" is managed exclusively by the Electron application
      必须用桌面安装目录里的 CLI，也就是本脚本找到的那个
      `<安装目录>\resources\runtime\cli\bin\dsh.cmd`。
    · 装之前请**完全退出** DeepSeek Harness（含托盘），装完再启动。
      桌面 CLI 会给 profile 的 package.json 上文件锁。
    · 该 CLI 自带 pnpm（`resources\runtime\pnpm`），所以不需要 PATH 上有 pnpm。

.PARAMETER Profile
  目标 profile 名，默认 desktop。Web 版传 web。

.PARAMETER Spec
  安装源，默认把本仓库以 link: 方式链进去（改完代码刷新页面即生效）。
  也可以传版本号/路径/tarball，例如 dsh-git-lite、./dsh-git-lite-0.2.0.tgz。

.PARAMETER Copy
  把默认的 link: 换成 file:（复制一份，而不是软链本仓库）。

.PARAMETER DshCli
  显式指定 dsh CLI。默认自动发现：PATH 上的 dsh → 桌面安装目录（读注册表）。

.PARAMETER DryRun
  只打印将要执行的命令，不真的安装。

.PARAMETER Force
  即使 DeepSeek Harness 正在运行也继续。官方建议是**先完全退出**（运行中的应用会
  在 profile 文件被改写时察觉，而且装完本来就要重启才生效），所以默认会拦下；
  只有你明确知道自己在做什么时才加它。

.EXAMPLE
  pwsh -File install.ps1
  pwsh -File install.ps1 -Profile web
  pwsh -File install.ps1 -Spec dsh-git-lite
#>
[CmdletBinding()]
param(
	[string]$Profile = 'desktop',
	[string]$Spec,
	[switch]$Copy,
	[string]$DshCli,
	[switch]$DryRun,
	[switch]$Force
)

$ErrorActionPreference = 'Stop'
$PkgName = 'dsh-git-lite'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$Message) {
	Write-Host "❌ $Message" -ForegroundColor Red
	exit 1
}

# ── 1) 找到桌面安装的 CLI（读卸载注册表项，别硬编码盘符）────────────
function Find-DesktopDsh {
	$roots = @(
		'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
		'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
		'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
	)
	foreach ($root in $roots) {
		$hit = Get-ItemProperty $root -ErrorAction SilentlyContinue |
			Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } |
			Select-Object -First 1
		if (-not $hit) { continue }
		$cli = Join-Path $hit.InstallLocation 'resources\runtime\cli\bin\dsh.cmd'
		if (Test-Path -LiteralPath $cli) {
			return [pscustomobject]@{ Path = $cli; Install = $hit.InstallLocation; Version = $hit.DisplayVersion }
		}
	}
	return $null
}

$desktop = Find-DesktopDsh
$cli = $null

if ($DshCli) {
	if (-not (Test-Path -LiteralPath $DshCli)) { Fail "找不到指定的 dsh CLI：$DshCli" }
	$cli = $DshCli
} else {
	# PATH 上的 dsh 只对非 desktop profile 可用（见文件头说明），所以桌面版优先用它自己的。
	if ($Profile -eq 'desktop' -and $desktop) {
		$cli = $desktop.Path
	} else {
		$onPath = Get-Command dsh -ErrorAction SilentlyContinue
		if ($onPath) { $cli = $onPath.Source }
		elseif ($desktop) { $cli = $desktop.Path }
	}
}

if (-not $cli) {
	$hint = if ($desktop) { "（已发现桌面安装：$($desktop.Install)）" } else { '（未在注册表里发现桌面安装）' }
	Fail "找不到可用的 dsh CLI $hint。请用 -DshCli 指定，例如：-DshCli 'D:\Apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'"
}

# 桌面 CLI 会给 desktop profile 上锁并独占管理它；PATH 上的 dsh 一定不是它。
if ($Profile -eq 'desktop' -and -not $DshCli -and -not $desktop) {
	Fail '目标 profile 是 desktop，但没有发现桌面安装。请用 -DshCli 指定桌面自带的 dsh.cmd（普通 dsh 会被拒绝管理 desktop profile）。'
}

# ── 2) 前置检查 ────────────────────────────────────────────────────
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"

if ($Profile -ne 'desktop' -and -not (Test-Path -LiteralPath $profileDir)) {
	Write-Host "ℹ️  profile 目录还不存在，CLI 会首次创建：$profileDir" -ForegroundColor DarkGray
}
if ($Profile -eq 'desktop' -and -not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
	Fail "desktop profile 尚未初始化（$profileDir\package.json 不存在）。请先启动一次 DeepSeek Harness，再完全退出，然后重跑本脚本。"
}

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue

$spec = if ($Spec) {
	$Spec
} elseif ($Copy) {
	"file:$Here"
} else {
	"link:$Here"
}

if ($desktop) { Write-Host "桌面安装：$($desktop.Install)  (DSH $($desktop.Version))" -ForegroundColor DarkGray }
Write-Host "CLI      ：$cli" -ForegroundColor DarkGray
Write-Host "profile  ：$Profile  ($profileDir)" -ForegroundColor DarkGray
Write-Host "安装源   ：$spec" -ForegroundColor DarkGray

$arguments = @('plugin', '--profile', $Profile, 'add', $spec)
if ($DryRun) {
	Write-Host ''
	Write-Host "（DryRun）将执行：& '$cli' $($arguments -join ' ')" -ForegroundColor Cyan
	exit 0
}

# 只有 desktop profile 是「运行中的应用独占并会察觉改写」的那个 —— DSH 自己的
# runPlugin 也只对 desktop 加 package.json 文件锁。别的 profile（web 等）应用
# 根本不碰，所以运行中装它是安全的，不该被这条护栏拦住。
if ($running -and $Profile -eq 'desktop' -and -not $Force) {
	Write-Host ''
	Write-Host "⚠️  DeepSeek Harness 正在运行（PID $($running.Id -join ', ')）。" -ForegroundColor Yellow
	Write-Host '   官方建议先完全退出（含托盘图标）再装：运行中的应用会在 profile 被改写时察觉。' -ForegroundColor Yellow
	Write-Host '   确认要继续（装完仍需重启才生效）请加 -Force。' -ForegroundColor Yellow
	exit 1
}
if ($running -and $Profile -eq 'desktop') {
	Write-Host ''
	Write-Host "⚠️  应用正在运行（PID $($running.Id -join ', ')），按 -Force 继续。装完**必须重启应用**才生效。" -ForegroundColor Yellow
}
if ($running -and $Profile -ne 'desktop') {
	Write-Host ''
	Write-Host "ℹ️  $Profile profile 不受运行中的应用影响（DSH 也只对 desktop profile 加锁），现在装是安全的。" -ForegroundColor DarkGray
	Write-Host '   要看到效果，需要一个实例在跑这个 profile，例如：' -ForegroundColor DarkGray
	Write-Host "     & '$cli' --profile $Profile" -ForegroundColor DarkGray
}

# ── 3) 交给官方 CLI ────────────────────────────────────────────────
Write-Host ''
& $cli @arguments
$code = $LASTEXITCODE
if ($code -ne 0) {
	Write-Host ''
	Write-Host "❌ 安装失败（exit=$code）。常见原因：" -ForegroundColor Red
	Write-Host "   · 版本不兼容 → 按提示跑：& '$cli' plugin --profile $Profile allow-version $PkgName@x.y.z --dsh-version <精确版本> --accept-risk"
	Write-Host "   · 目标 profile 未初始化 / 应用没退干净"
	Write-Host "   · 网络或 registry 不可达"
	exit $code
}

Write-Host ''
Write-Host '✅ 已装入。' -ForegroundColor Green
Write-Host '   下一步：重新启动 DeepSeek Harness，然后在右侧栏切到「Git」标签页'
Write-Host '   （或点会话头部右侧带分支名的胶囊）。'
if ($Profile -eq 'desktop') {
	Write-Host '   注意：桌面版改动 lib/client.js 后刷新页面即可；改 lib/index.js 需要重启应用。' -ForegroundColor DarkGray
}
