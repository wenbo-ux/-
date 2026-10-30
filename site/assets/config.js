/* ============================================================
 * 配置：把下面两项换成你自己的 Supabase 项目信息
 *  - SUPABASE_URL      形如 https://abcdefgh.supabase.co
 *  - SUPABASE_ANON_KEY 项目公开的 anon key（Edge Function 若关掉 JWT 校验可留空）
 *  - FUNCTION_PATH     Edge Function 路径，默认 /functions/v1/api
 * 注意：这里只能放 anon key，绝对不要把 service_role key 写进前端。
 * ============================================================ */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: '',
  FUNCTION_PATH: '/functions/v1/api'
};
