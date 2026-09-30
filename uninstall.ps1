#!/usr/bin/env pwsh
<#
.SYNOPSIS
  从 DSH profile 里卸载 dsh-git-lite。

.DESCRIPTION
  与 install.ps1 对称：把活交给官方 CLI（dsh plugin … remove），由它负责
  撤掉 dependencies、dsh.profile.bundles 与 cordis.patch.yml 三处登记。

  桌面版同样需要**完全退出** DeepSeek Harness 再执行。

.PARAMETER Profile
  目标 profile 名，默认 desktop。

.PARAMETER DshCli
  显式指定 dsh CLI；默认自动发现（PATH 上的 dsh → 桌面安装目录）。
#>
[CmdletBinding()]
param(
	[string]$Profile = 'desktop',
	[string]$DshCli,
	[switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PkgName = 'dsh-git-lite'

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
		if (Test-Path -LiteralPath $cli) { return $cli }
	}
	return $null
}

$desktop = Find-DesktopDsh
$cli = $null
if ($DshCli) {
	$cli = $DshCli
} elseif ($Profile -eq 'desktop' -and $desktop) {
	$cli = $desktop
} else {
	$onPath = Get-Command dsh -ErrorAction SilentlyContinue
	if ($onPath) { $cli = $onPath.Source } elseif ($desktop) { $cli = $desktop }
}

if (-not $cli -or -not (Test-Path -LiteralPath $cli)) {
	Write-Host "❌ 找不到可用的 dsh CLI。请用 -DshCli 指定桌面自带的 dsh.cmd。" -ForegroundColor Red
	exit 1
}

$arguments = @('plugin', '--profile', $Profile, 'remove', $PkgName)
if ($DryRun) {
	Write-Host "（DryRun）将执行：& '$cli' $($arguments -join ' ')" -ForegroundColor Cyan
	exit 0
}

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
	Write-Host "⚠️  DeepSeek Harness 正在运行，请完全退出后再卸载。" -ForegroundColor Yellow
	exit 1
}

& $cli @arguments
$code = $LASTEXITCODE
if ($code -ne 0) {
	Write-Host "❌ 卸载失败（exit=$code）。" -ForegroundColor Red
	exit $code
}
Write-Host '✅ 已卸载。重启 DeepSeek Harness 后生效。' -ForegroundColor Green
