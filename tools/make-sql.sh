#!/bin/sh
# 生成「只更新密钥」的 SQL（表结构由 supabase/migrations 自动部署，不需要这个脚本）
# 用法: sh tools/make-sql.sh "七年级密钥" "小学密钥" ["管理员密钥，默认 0124"] ["pepper，默认随机生成"]
# 输出: supabase/keys.sql  + 打印 AREA_PEPPER（要填到 Edge Function Secrets）
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

OUT=supabase/keys.sql
cat > "$OUT" <<SQL
-- 只改密钥：Supabase → SQL Editor → 整段运行
-- 生成时间 $(date '+%Y-%m-%d %H:%M')
insert into public.area_keys (area, key_hash) values
  ('grade7',  '$(h "$A7")'),
  ('primary', '$(h "$AP")')
on conflict (area) do update set key_hash = excluded.key_hash, updated_at = now();

insert into public.admin_auth (id, key_hash) values (1, '$(h "$ADMIN")')
on conflict (id) do update set key_hash = excluded.key_hash, updated_at = now();
SQL

cat <<TXT
已生成 $OUT

Edge Function Secrets:
  AREA_PEPPER = $PEPPER
  PHOTO_BUCKET = photos

明文密钥：
  七年级   : $A7
  小学     : $AP
  管理员   : $ADMIN
TXT
