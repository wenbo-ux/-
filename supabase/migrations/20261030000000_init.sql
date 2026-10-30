-- ============================================================
-- 我们的相册 · Supabase 初始化脚本
-- 在 Supabase 控制台 → SQL Editor 里整段运行一次即可。
-- ============================================================

-- 1) 区域密钥表（只存 HMAC 哈希，永远不存明文密钥）
create table if not exists public.area_keys (
  area       text primary key check (area in ('grade7', 'primary')),
  key_hash   text not null,
  updated_at timestamptz not null default now()
);

-- 2) 照片表
create table if not exists public.photos (
  id           uuid primary key default gen_random_uuid(),
  area         text not null check (area in ('grade7', 'primary')),
  storage_path text not null unique,
  author       text not null default '匿名',
  caption      text not null default '',
  width        int,
  height       int,
  created_at   timestamptz not null default now()
);

create index if not exists photos_area_created_idx
  on public.photos (area, created_at desc);

-- 3) 开启 RLS，并且【故意不建任何 policy】
--    这样 anon key 完全读不到数据；只有 Edge Function 用的 service_role 能读写。
alter table public.area_keys enable row level security;
alter table public.photos    enable row level security;

-- 4) 私有 Storage bucket（图片只通过后端签发的临时链接访问）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 26214400,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 26214400,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- 5) 写入两个区域的密钥哈希
--    先在本地算哈希： sh tools/hash-key.sh "你的密钥"
--    然后把下面的 REPLACE_ME_xxx 换成算出来的 64 位十六进制串。
--    模板里用 do nothing：重复执行不会覆盖已生效的密钥。
--    （tools/make-sql.sh 生成的 setup-ready.sql 会改成 do update，用来强制写新密钥）
insert into public.area_keys (area, key_hash) values
  ('grade7',  'REPLACE_ME_GRADE7_HASH'),
  ('primary', 'REPLACE_ME_PRIMARY_HASH')
on conflict (area) do nothing;

-- 6) 换密钥 / 首次写入（把哈希换成 sh tools/hash-key.sh "新密钥" 的结果，旧密钥立即失效）
-- update public.area_keys set key_hash = '新的哈希', updated_at = now() where area = 'grade7';

-- 7) 清理：删除某区域全部照片（先删库记录，再用控制台清 Storage）
-- delete from public.photos where area = 'grade7';

-- ============================================================
-- 8) 管理员（只有站长自己用）
--    先算哈希： sh tools/hash-key.sh "你的管理员密钥"
--    （和区域密钥用同一个 pepper）
-- ============================================================
create table if not exists public.admin_auth (
  id         int primary key default 1 check (id = 1),
  key_hash   text not null,
  updated_at timestamptz not null default now()
);

alter table public.admin_auth enable row level security;
-- 同样不建 policy：只有 Edge Function 的 service_role 能读

insert into public.admin_auth (id, key_hash) values (1, 'REPLACE_ME_ADMIN_HASH')
on conflict (id) do nothing;
