#!/usr/bin/env bash
# 只读取路由设置；模型密钥由网关在运行时读取，不写入生成的 YAML。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
get_value() {
  awk -v k="$1=" 'index($0, k) == 1 {v=substr($0, length(k)+1)} END {sub(/\r$/, "", v); print v}' .env
}
fail() { printf '%s\n' "$1" >&2; exit 1; }
issuer="$(get_value ACP_PUBLIC_URL)"; issuer="${issuer%/}"
provider="$(get_value LLM_PROVIDER)"; provider="${provider:-openAI}"
model="$(get_value ACP_LLM_MODEL)"; model="${model:-gpt-4o-mini}"
upstream="$(get_value LLM_UPSTREAM_HOST)"
[[ "$issuer" =~ ^https?://.+$ && "$issuer" != *[[:space:][:cntrl:]]* && "$issuer" != *'"'* && "$issuer" != *'\'* ]] \
  || fail 'ACP_PUBLIC_URL 不是有效的 HTTP(S) 地址'
[[ "$provider" == openAI || "$provider" == anthropic ]] || fail 'LLM_PROVIDER 须为 openAI 或 anthropic'
[[ "$model" =~ ^[a-zA-Z0-9._:/-]+$ ]] || fail 'ACP_LLM_MODEL 包含无效字符'
label='[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?'
[[ -z "$upstream" || ( ${#upstream} -le 253 && "$upstream" =~ ^${label}([.]${label})*$ ) ]] \
  || fail 'LLM_UPSTREAM_HOST 只接受 HTTPS 主机名，不含协议、端口或路径'

tmp="$(mktemp agentgateway/config.yaml.XXXXXX)"
trap 'rm -f -- "$tmp"' EXIT
awk -v issuer="$issuer" -v provider="$provider" -v model="$model" -v host="$upstream" '
  /# CUSTOM_HTTPS_UPSTREAM/ {
    if (host != "") {
      print "          hostOverride: \"" host ":443\""
      print "          policies:"
      print "            backendTLS:"
      print "              hostname: \"" host "\""
    }
    next
  }
  {
    if (p=index($0, "__ISSUER__")) $0=substr($0,1,p-1) issuer substr($0,p+10)
    sub(/__LLM_PROVIDER__/, provider)
    sub(/__LLM_MODEL__/, model)
    print
  }
' agentgateway/config.yaml.tmpl > "$tmp"
chmod 644 "$tmp"
mv -f -- "$tmp" agentgateway/config.yaml
