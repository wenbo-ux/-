-- ============================================================
-- 我们的相册 · Supabase 初始化脚本（表结构 + 私有 bucket + 初始密钥哈希）
-- ============================================================
-- 这份文件会被 Supabase 的 GitHub 集成自动执行（建项目的第一次同步）。
-- 里面的密钥哈希是最终值；要改密钥请用 admin.html 后台，或 tools/make-sql.sh。
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

-- 5) 写入两个区域的密钥哈希（HMAC-SHA256，pepper 只存在函数 Secrets 里）
--    明文不写在仓库里（存在本地备份文件）。改密钥不用动这个文件：进 admin.html 后台改。
insert into public.area_keys (area, key_hash) values
  ('grade7',  'e05085508801af269d505f2fab46abd117e41828dd4b2f29783755f569e20a21'),
  ('primary', 'e8547428a38b9b7c57b2793381eef3429289ff5012a26e9b63c7668b6c47e6c5')
on conflict (area) do update set key_hash = excluded.key_hash, updated_at = now();

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

insert into public.admin_auth (id, key_hash) values (1, '22e6cf4f7323f2e19f9de6d2b8ac673b2eb500b37abe18a0397c74e467c1673f')
on conflict (id) do update set key_hash = excluded.key_hash, updated_at = now();
