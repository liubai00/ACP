#!/usr/bin/env bash
# Cross-compile acp-link into dist/<os>-<arch>/ (macOS, Linux, Git Bash on Windows).
#   VERSION=0.2.0 ./build.sh        # version defaults to the VERSION file
#   GO=/path/to/go ./build.sh       # go defaults to PATH, then ../.local/tools/go
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${VERSION:-$(tr -d ' \r\n' < VERSION 2>/dev/null || echo 0.0.0-dev)}"
COMMIT="${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

GO="${GO:-}"
if [ -z "$GO" ]; then
  if command -v go >/dev/null 2>&1; then
    GO=go
  else
    for cand in ../.local/tools/go/bin/go ../.local/tools/go/bin/go.exe; do
      if [ -x "$cand" ]; then
        GO="$(cd "$(dirname "$cand")" && pwd)/$(basename "$cand")"
        tools="$(cd ../.local/tools && pwd)"
        # keep caches next to the portable toolchain
        export GOPATH="${GOPATH:-$tools/gopath}" GOMODCACHE="${GOMODCACHE:-$tools/gopath/pkg/mod}" GOCACHE="${GOCACHE:-$tools/gocache}"
        break
      fi
    done
  fi
fi
if [ -z "$GO" ]; then
  echo "build.sh: go not found (install Go 1.23+ or set GO=...)" >&2
  exit 1
fi
export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"

PKG=acp/acp-link/internal/version
LDFLAGS="-s -w -X ${PKG}.Version=${VERSION} -X ${PKG}.Commit=${COMMIT} -X ${PKG}.BuildDate=${BUILD_DATE}"

echo "acp-link ${VERSION} (${COMMIT}) with $("$GO" version)"
rm -rf dist
mkdir -p dist
for target in windows/amd64 darwin/arm64 darwin/amd64 linux/amd64; do
  os="${target%/*}"
  arch="${target#*/}"
  out="dist/${os}-${arch}/acp-link"
  [ "$os" = "windows" ] && out="${out}.exe"
  echo "  -> ${out}"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO" build -trimpath -ldflags "$LDFLAGS" -o "$out" ./cmd/acp-link
done
# 后台服务安装脚本一起放进 dist，平台的 /downloads/ 页可直接下载
cp -r packaging dist/packaging

(
  cd dist
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum */acp-link* > SHA256SUMS
  else
    shasum -a 256 */acp-link* > SHA256SUMS
  fi
)
echo "done:"
ls -l dist/*/acp-link*
