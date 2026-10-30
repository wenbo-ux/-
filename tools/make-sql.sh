#!/bin/sh
# 一条命令生成可直接粘贴到 Supabase 的 SQL（含真实哈希）
# 用法:
#   sh tools/make-sql.sh "七年级密钥" "小学密钥" ["管理员密钥，默认 0124"] ["pepper，默认随机生成"]
# 输出:
#   supabase/setup-ready.sql  ← 整段贴进 Supabase SQL Editor
#   以及需要填到 Edge Function 环境变量里的 AREA_PEPPER
set -e
A7="$1"; AP="$2"; ADMIN="${3:-0124}"; PEPPER="$4"
if [ -z "$A7" ] || [ -z "$AP" ]; then
  echo "用法: sh tools/make-sql.sh \"七年级密钥\" \"小学密钥\" [管理员密钥] [pepper]" >&2
  exit 1
fi
if [ -z "$PEPPER" ]; then
  PEPPER=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-20)
fi
h() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$PEPPER" -r | cut -d' ' -f1; }

H7=$(h "$A7"); HP=$(h "$AP"); HA=$(h "$ADMIN")
OUT=supabase/setup-ready.sql
sed -e "s/REPLACE_ME_GRADE7_HASH/$H7/" \
    -e "s/REPLACE_ME_PRIMARY_HASH/$HP/" \
    -e "s/REPLACE_ME_ADMIN_HASH/$HA/" \
    -e "s/on conflict (area) do nothing;/on conflict (area) do update set key_hash = excluded.key_hash, updated_at = now();/" \
    -e "s/on conflict (id) do nothing;/on conflict (id) do update set key_hash = excluded.key_hash, updated_at = now();/" \
    supabase/migrations/20261030000000_init.sql > "$OUT"

cat >> "$OUT" <<'SQL'

-- 跑完看一眼这张表：hash_len 必须是 64，is_placeholder 必须是 false
select 'area_keys' as tbl, area as k, length(key_hash) as hash_len,
       (position('REPLACE_ME' in key_hash) > 0) as is_placeholder
from public.area_keys
union all
select 'admin_auth', 'admin', length(key_hash),
       (position('REPLACE_ME' in key_hash) > 0)
from public.admin_auth;
SQL

cat <<TXT
已生成 $OUT （整段贴进 Supabase → SQL Editor → Run）

Edge Function 的环境变量（Secrets）：
  AREA_PEPPER = $PEPPER
  PHOTO_BUCKET = photos

请自己记好这些明文密钥（只存哈希，丢了没法找回）：
  七年级   : $A7
  小学     : $AP
  管理员   : $ADMIN

⚠ 以后换密钥不用改 SQL：直接进 admin.html 后台改，或重跑本脚本 + update 语句。
TXT
