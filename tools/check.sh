#!/bin/sh
# 后端自检：函数有没有部署、版本对不对、管理员密钥能不能用
# 用法: sh tools/check.sh https://<项目ref>.supabase.co [管理员密钥]
BASE="$1"
ADMIN="$2"
if [ -z "$BASE" ]; then
  echo "用法: sh tools/check.sh https://xxx.supabase.co [管理员密钥]"
  exit 1
fi
BASE=$(printf '%s' "$BASE" | sed 's:/*$::')
URL="$BASE/functions/v1/api"

post() {
  curl -sS --max-time 25 -X POST "$URL" \
    -H 'content-type: application/json' \
    -H 'apikey: none' \
    -d "$1" 2>&1
}

echo "目标: $URL"
echo

echo "① ping —— 函数是否部署、是不是新代码"
R=$(post '{"action":"ping"}')
echo "   $R"
case "$R" in
  *'"version":2'*) echo "   ✓ 函数已部署，且是最新代码" ;;
  *'"ok":true'*)   echo "   △ 函数在，但代码是旧的 —— 需要重新部署 index.ts" ;;
  *'Failed to fetch'*|*'Could not resolve'*) echo "   ✗ 域名解析失败，URL 写错了？" ;;
  *) echo "   ✗ 调不通 —— 检查函数名是不是 api、有没有部署成功" ;;
esac
echo

if [ -n "$ADMIN" ]; then
  echo "② admin-login —— 管理员密钥"
  R=$(post "{\"action\":\"admin-login\",\"adminKey\":\"$ADMIN\"}")
  echo "   $R"
  case "$R" in
    *'"ok":true'*) echo "   ✓ 管理员密钥正确，数据库也读得到" ;;
    *'管理员密钥不正确'*) echo "   ✗ 密钥不对：数据库里 admin_auth 的哈希和这个密钥不匹配" ;;
    *'429'*|*'太多'*) echo "   ! 触发限流了，等 10 分钟再试" ;;
    *) echo "   ✗ 失败 —— 多半是 admin_auth 表不存在，或 AREA_PEPPER 不一致" ;;
  esac
  echo
fi

echo "③ verify —— 用错误密钥测区域校验（预期「密钥不正确」）"
R=$(post '{"action":"verify","area":"grade7","key":"__probe__"}')
echo "   $R"
case "$R" in
  *'密钥不正确'*) echo "   ✓ 函数能读到 area_keys，只差密钥本身" ;;
  *'unknown'*|*'未知区域'*) echo "   ✗ 还在跑旧代码" ;;
  *) echo "   ✗ 异常，把上面这行发给开发者" ;;
esac
echo
echo "提示：连续测错 10 次会被限流 10 分钟，别狂点。"
