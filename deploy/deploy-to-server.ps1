<#
.SYNOPSIS
  从这台 Windows 电脑把最新部署包传到云服务器并执行安装。密码由你在提示时自己输入。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\deploy-to-server.ps1 -Server <服务器IP> -Demo
  # 有域名时：
  powershell -ExecutionPolicy Bypass -File deploy\deploy-to-server.ps1 -Server <服务器IP> -Domain acp.example.com -Email you@example.com
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$User = "root",
  [int]$Port = 22,
  [string]$Domain = "",
  [string]$Email = "",
  [switch]$Demo,
  [switch]$CnMirror
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bundle = Get-ChildItem (Join-Path $root ".local\dist\acp-*.tar.gz") -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $bundle) { throw "没有找到部署包，请先在 Git Bash 里执行：bash deploy/make-bundle.sh" }
Write-Host "部署包：$($bundle.Name)"

$args = @()
if ($Domain) { $args += "--domain $Domain" } else { $args += "--host $Server" }
if ($Email) { $args += "--email $Email" }
if ($Demo) { $args += "--demo" }
if ($CnMirror) { $args += "--cn-mirror" }

Write-Host "1/2 上传（会提示输入 $User@$Server 的密码）..."
scp -P $Port $bundle.FullName "${User}@${Server}:/tmp/acp-bundle.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "上传失败。若连接被立即断开，检查本机代理（Clash 等）是否接管了 22 端口，给 $Server 加直连规则后重试。" }

Write-Host "2/2 解压并安装（再次输入密码）..."
$remote = "set -e; mkdir -p /opt/acp; tar xzf /tmp/acp-bundle.tar.gz -C /opt/acp; bash /opt/acp/deploy/install.sh $($args -join ' ')"
ssh -p $Port -t "${User}@${Server}" $remote
