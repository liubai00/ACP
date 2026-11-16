<#
.SYNOPSIS
  Register acp-link as a per-user Scheduled Task that runs `acp-link run` at logon.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Binary .\acp-link.exe
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Uninstall

.NOTES
  - No administrator rights needed: the task runs as the current user, only while logged on,
    so git credentials, ssh keys and the coding agent's own login all work.
  - The binary is copied to %LOCALAPPDATA%\acp-link\acp-link.exe. A small launcher
    (acp-link-service.ps1) runs it hidden and restarts it 30 seconds after a crash.
  - Config, token and logs stay in %USERPROFILE%\.acp-link.
#>
param(
    [string]$Binary = "",
    [string]$TaskName = "acp-link",
    [switch]$Uninstall,
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:LOCALAPPDATA "acp-link"
$exe = Join-Path $installDir "acp-link.exe"
$launcher = Join-Path $installDir "acp-link-service.ps1"

function Stop-AcpLink {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    Get-Process -Name "acp-link" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $exe } |
        ForEach-Object { Stop-Process -Id $_.Id -Force -Confirm:$false -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($launcher) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
    Stop-AcpLink
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Write-Host "已移除计划任务 $TaskName（配置与令牌保留在 $env:USERPROFILE\.acp-link，程序保留在 $installDir）"
    exit 0
}

if (-not $Binary) {
    foreach ($cand in @((Join-Path $PSScriptRoot "acp-link.exe"), (Join-Path $PSScriptRoot "..\..\dist\windows-amd64\acp-link.exe"))) {
        if (Test-Path $cand) { $Binary = $cand; break }
    }
}
if (-not $Binary -or -not (Test-Path $Binary)) { throw "找不到 acp-link.exe，请用 -Binary 指定" }
$Binary = (Resolve-Path $Binary).Path

Stop-AcpLink
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
if ($Binary -ne $exe) { Copy-Item -Path $Binary -Destination $exe -Force }
Unblock-File -Path $exe -ErrorAction SilentlyContinue

# Launcher: run hidden, restart after abnormal exit (exit code 0 = clean stop).
$launcherBody = @'
$exe = Join-Path $PSScriptRoot 'acp-link.exe'
while ($true) {
    & $exe run
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 30
}
'@
Set-Content -Path $launcher -Value $launcherBody -Encoding UTF8

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"" `
    -WorkingDirectory $env:USERPROFILE
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "ACP acp-link: 订阅平台派工并在本机运行编码 Agent" | Out-Null

if (-not $NoStart) { Start-ScheduledTask -TaskName $TaskName }

Write-Host "已安装：$exe"
Write-Host "计划任务：$TaskName（登录时自动启动，后台无窗口运行）"
Write-Host "日志：$env:USERPROFILE\.acp-link\logs\acp-link.log"
if (-not (Test-Path (Join-Path $env:USERPROFILE ".acp-link\config.yaml"))) {
    Write-Host "提示：还没有配置文件，先运行 `"$exe`" init，编辑后再 login"
} elseif (-not (Test-Path (Join-Path $env:USERPROFILE ".acp-link\credentials.json"))) {
    Write-Host "提示：还没有登录，运行 `"$exe`" login"
}
Write-Host "查看状态：`"$exe`" status"
