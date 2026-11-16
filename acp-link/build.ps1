# Cross-compile acp-link into dist\<os>-<arch>\ (Windows PowerShell 5.1+).
#   .\build.ps1                     # version from the VERSION file
#   .\build.ps1 -Version 0.2.0
#   .\build.ps1 -Go C:\go\bin\go.exe
param(
    [string]$Version = "",
    [string]$Go = ""
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not $Version) {
    if (Test-Path "VERSION") { $Version = (Get-Content "VERSION" -Raw).Trim() } else { $Version = "0.0.0-dev" }
}

$Commit = "unknown"
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $c = & git rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { $Commit = "$c".Trim() }
} catch { }
$ErrorActionPreference = $prev
$BuildDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

if (-not $Go) {
    $cmd = Get-Command go -ErrorAction SilentlyContinue
    if ($cmd) {
        $Go = $cmd.Source
    } else {
        $portable = Join-Path $PSScriptRoot "..\.local\tools\go\bin\go.exe"
        if (Test-Path $portable) {
            $Go = (Resolve-Path $portable).Path
            $tools = (Resolve-Path (Join-Path $PSScriptRoot "..\.local\tools")).Path
            # keep caches next to the portable toolchain
            if (-not $env:GOPATH) { $env:GOPATH = Join-Path $tools "gopath" }
            if (-not $env:GOMODCACHE) { $env:GOMODCACHE = Join-Path $tools "gopath\pkg\mod" }
            if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path $tools "gocache" }
        }
    }
}
if (-not $Go) { throw "build.ps1: go not found (install Go 1.23+ or pass -Go <path>)" }
if (-not $env:GOTOOLCHAIN) { $env:GOTOOLCHAIN = "local" }

$pkg = "acp/acp-link/internal/version"
$ldflags = "-s -w -X $pkg.Version=$Version -X $pkg.Commit=$Commit -X $pkg.BuildDate=$BuildDate"
$goVersion = & $Go version
Write-Host "acp-link $Version ($Commit) with $goVersion"

if (Test-Path "dist") { Remove-Item -Recurse -Force "dist" }
New-Item -ItemType Directory -Force "dist" | Out-Null

$targets = @("windows/amd64", "darwin/arm64", "darwin/amd64", "linux/amd64")
$saved = @{ GOOS = $env:GOOS; GOARCH = $env:GOARCH; CGO_ENABLED = $env:CGO_ENABLED }
try {
    foreach ($t in $targets) {
        $os, $arch = $t.Split("/")
        $out = "dist\$os-$arch\acp-link"
        if ($os -eq "windows") { $out = "$out.exe" }
        Write-Host "  -> $out"
        $env:GOOS = $os
        $env:GOARCH = $arch
        $env:CGO_ENABLED = "0"
        & $Go build -trimpath -ldflags $ldflags -o $out ./cmd/acp-link
        if ($LASTEXITCODE -ne 0) { throw "go build failed for $t" }
    }
} finally {
    $env:GOOS = $saved.GOOS
    $env:GOARCH = $saved.GOARCH
    $env:CGO_ENABLED = $saved.CGO_ENABLED
}

# 后台服务安装脚本一起放进 dist，平台的 /downloads/ 页可直接下载
Copy-Item -Recurse -Force "packaging" "dist\packaging"

$lines = Get-ChildItem -Path "dist" -Recurse -File -Filter "acp-link*" | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring((Resolve-Path "dist").Path.Length + 1).Replace("\", "/")
    "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $rel
}
Set-Content -Path "dist\SHA256SUMS" -Value $lines -Encoding Ascii

Write-Host "done:"
Get-ChildItem -Path "dist" -Recurse -File -Filter "acp-link*" | ForEach-Object {
    "{0,12:N0}  {1}" -f $_.Length, $_.FullName.Substring($PSScriptRoot.Length + 1)
}
