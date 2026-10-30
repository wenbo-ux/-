-- 2026-10-31 新增：文字贴、点赞、回复
-- 在 Supabase SQL Editor 里整段运行（或在本地 psql 执行）

-- 1) photos 表升级成「帖子表」：kind = photo | text
alter table public.photos add column if not exists kind text not null default 'photo';
alter table public.photos add column if not exists body text not null default '';
alter table public.photos alter column storage_path drop not null;

-- 2) 点赞（一台设备一个人，用 client_id 去重）
create table if not exists public.likes (
  post_id    uuid not null references public.photos(id) on delete cascade,
  client_id  text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, client_id)
);

-- 3) 回复
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.photos(id) on delete cascade,
  author     text not null default '匿名',
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists comments_post_idx on public.comments (post_id, created_at);
create index if not exists likes_post_idx    on public.likes (post_id);

-- 4) 同样零 policy：只有 Edge Function 的 service_role 能读写
alter table public.likes    enable row level security;
alter table public.comments enable row level security;
