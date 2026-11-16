#!/usr/bin/env bash
# Install acp-link as a launchd user agent (starts at login, restarts on crash).
#
#   ./install-macos.sh --binary ./acp-link          # install / update
#   ./install-macos.sh --uninstall                  # remove the agent (keeps config and token)
#
# The binary is copied to ~/.local/bin/acp-link. Run `acp-link init`, edit the
# config and `acp-link login` before (or after) installing; the agent retries
# until it can connect.
set -euo pipefail

LABEL="com.acp.acp-link"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/com.acp.acp-link.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/acp-link"
LOG_DIR="$HOME/.acp-link/logs"
UID_NUM="$(id -u)"
SRC=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --binary) SRC="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install-macos.sh is for macOS" >&2
  exit 1
fi

stop_agent() {
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
}

if [ "$UNINSTALL" = 1 ]; then
  stop_agent
  rm -f "$PLIST"
  echo "已移除 launchd 服务 $LABEL（配置与令牌保留在 ~/.acp-link，二进制保留在 $BIN）"
  exit 0
fi

if [ -z "$SRC" ]; then
  for cand in "$SCRIPT_DIR/acp-link" "$SCRIPT_DIR/../../dist/darwin-$(uname -m | sed 's/x86_64/amd64/')/acp-link" "$(command -v acp-link || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then SRC="$cand"; break; fi
  done
fi
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "找不到 acp-link 二进制，请用 --binary 指定" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
if [ "$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")" != "$BIN" ]; then
  install -m 0755 "$SRC" "$BIN"
fi
# Downloaded binaries are quarantined by Gatekeeper; clear it for our copy.
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true

# Capture the current PATH so claude / codex / git / node installed via
# Homebrew or npm are found by launchd, plus common locations.
SVC_PATH="$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
SVC_PATH="$(printf '%s' "$SVC_PATH" | awk -v RS=: -v ORS=: '!seen[$0]++' | sed 's/:$//')"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
EXTRA=""
for var in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy ACP_LINK_CONFIG NODE_EXTRA_CA_CERTS; do
  val="${!var:-}"
  if [ -n "$val" ]; then
    EXTRA="$EXTRA    <key>$var</key>\n    <string>$(xml_escape "$val")</string>\n"
  fi
done

sed_escape() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
tmp="$(mktemp)"
sed -e "s|__LABEL__|$(sed_escape "$LABEL")|g" \
    -e "s|__BIN__|$(sed_escape "$(xml_escape "$BIN")")|g" \
    -e "s|__HOME__|$(sed_escape "$(xml_escape "$HOME")")|g" \
    -e "s|__PATH__|$(sed_escape "$(xml_escape "$SVC_PATH")")|g" \
    -e "s|__LOGDIR__|$(sed_escape "$(xml_escape "$LOG_DIR")")|g" \
    "$TEMPLATE" > "$tmp"
# Insert extra env lines (may be empty) from a file: BSD awk rejects newlines in -v values.
extra_file="$(mktemp)"
printf '%b' "$EXTRA" > "$extra_file"
awk -v f="$extra_file" '{ if ($0 == "__EXTRA_ENV__") { while ((getline line < f) > 0) print line } else print }' "$tmp" > "$PLIST"
rm -f "$tmp" "$extra_file"
plutil -lint "$PLIST" >/dev/null

stop_agent
launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

echo "已安装：$BIN"
echo "launchd 服务：$PLIST（登录时自动启动，异常退出 30 秒后重启）"
echo "日志：$LOG_DIR/acp-link.log"
if [ ! -f "$HOME/.acp-link/config.yaml" ]; then
  echo "提示：还没有配置文件，先运行 $BIN init，编辑后 $BIN login"
elif [ ! -f "$HOME/.acp-link/credentials.json" ]; then
  echo "提示：还没有登录，运行 $BIN login"
fi
echo "查看状态：$BIN status"
