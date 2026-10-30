#!/bin/sh
# 用法: sh tools/hash-key.sh "密钥明文" ["pepper（默认 photo-wall-pepper）"]
# 输出 64 位十六进制 HMAC-SHA256，填进 supabase/setup.sql 的 key_hash
KEY="$1"
PEPPER="${2:-photo-wall-pepper}"
if [ -z "$KEY" ]; then echo "用法: sh tools/hash-key.sh \"密钥\"" >&2; exit 1; fi
printf '%s' "$KEY" | openssl dgst -sha256 -hmac "$PEPPER" -r | cut -d' ' -f1
