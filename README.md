# 我们的相册 · 照片墙

前端静态站（Netlify）+ 后端 Supabase（Postgres + Storage + Edge Function）。
两个区域：**七年级 / 小学**，各自一把访问密钥；访问对方区域必须先输入对方密钥。
另有一个**管理后台**，只有管理员密钥能进，可删照片、换密钥、清空区域。

```
photo-wall/
├─ site/                            ← 这个目录才会发布到 Netlify
│  ├─ index.html                    前台（看照片 / 上传）
│  ├─ admin.html                    管理后台
│  └─ assets/{style.css,app.js,admin.js,config.js}
├─ supabase/
│  ├─ migrations/20261030000000_init.sql   建表 + RLS + 私有 bucket
│  ├─ functions/api/index.ts               Edge Function（所有读写都走它）
│  └─ config.toml
├─ tools/
│  ├─ make-sql.sh                   生成带真实哈希的 SQL（推荐）
│  ├─ check.sh                      后端自检（ping / 管理员 / 区域）
│  └─ hash-key.sh                   只算单个密钥的哈希
├─ .github/workflows/supabase-functions.yml  push 自动部署函数
├─ netlify.toml                     publish = "site"
└─ README.md
```

---

## 一、GitHub + Netlify + Supabase 怎么接

| 平台 | 能不能连仓库自动部署 | 做法 |
|---|---|---|
| **Netlify** | ✅ 原生支持 | 连 GitHub 仓库，push 自动发布 `site/` |
| **Supabase 数据库 SQL** | ❌ 不会自动跑 | 建库时手动跑一次（一次性，以后不用管） |
| **Supabase Edge Function** | ⚠️ 官方没有「连仓库部署函数」 | 用仓库里的 GitHub Actions 调 `supabase functions deploy` |

也就是说：**Netlify 连 GitHub 就够了；函数用 Actions；SQL 手动跑一次。**
（Supabase 面板里的 GitHub 集成只做「PR 预览分支」，付费功能，和部署函数无关。）

### 1. 推到 GitHub

```sh
cd photo-wall
git init && git add . && git commit -m "init"
git remote add origin git@github.com:你的账号/photo-wall.git
git push -u origin main
```

### 2. Netlify 连仓库

New site → Import from Git → 选仓库。
Build command 留空、Publish directory 填 `site`（`netlify.toml` 里已写好，Netlify 会自动读）。
以后 `git push` 就自动发布前端。

### 3. Supabase 建表（一次性）

```sh
sh tools/make-sql.sh "七年级密钥" "小学密钥" "0124"
#   参数3 = 管理员密钥（默认 0124），参数4 = pepper（不填随机生成）
```

把生成的 `supabase/setup-ready.sql` 整段贴进 Supabase → SQL Editor → Run。
脚本结尾的 `select` 会自检：`hash_len` 得是 64。

### 4. Supabase 函数

**首次部署**（Dashboard 最省事）：Edge Functions → 新建 `api` →
粘贴 `supabase/functions/api/index.ts` → 关闭 JWT 验证 →
Secrets 加 `AREA_PEPPER`（`make-sql.sh` 打印的那串）和 `PHOTO_BUCKET=photos`。

**之后自动部署**：仓库 Settings → Secrets and variables → Actions 里加两个 secret：

- `SUPABASE_ACCESS_TOKEN`：Supabase 头像 → Account → Access Tokens 新建
- `SUPABASE_PROJECT_ID`：项目 ref（`https://` 和 `.supabase.co` 中间那段）

以后只要 push 改动到 `supabase/functions/`，Actions 会自动部署，并顺手调一次
`{"action":"ping"}` 自检。也可以到 Actions 页面点 **Run workflow** 手动跑。

**配好之后跑一句自检**（会告诉你函数版本对不对、密钥是不是对不上）：

```sh
sh tools/check.sh https://<项目ref>.supabase.co 0124
```

### 5. 前端指向你的项目

`site/assets/config.js`：

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://你的项目ref.supabase.co',
  SUPABASE_ANON_KEY: '',        // 函数关了 JWT 校验就留空
  FUNCTION_PATH: '/functions/v1/api'
};
```

改完 push，Netlify 自动发布。

---

## 二、管理后台

- 地址：`https://你的站点.netlify.app/admin.html`
- 入口：首页**连续点左上角 logo 5 次**（不显眼，只有知道的人会点）
- 登录：管理员密钥（`make-sql.sh` 第 3 个参数，默认 `0124`）
- 登录卡下面有「检查连接」按钮：能看出后端是新代码还是旧代码、通不通

| 功能 | 说明 |
|---|---|
| 看所有照片 | 全部 / 七年级 / 小学 三个筛选，顶部显示各区张数 |
| 删单张 | 点缩略图右上角 ✕，记录和 Storage 原图一起删 |
| 清空某区域 | 必须手动输入「七年级」或「小学」确认 |
| 换区域密钥 | 保存后旧密钥立即失效 |
| 换管理员密钥 | 改完本机自动记住；忘了只能去 Supabase 改 `admin_auth` 表 |

> 管理员密钥和区域密钥完全独立。建议别用 4 位纯数字，记不住就写备忘录。

---

## 三、密钥与权限

- 密钥只在浏览器内存里（sessionStorage），关标签页即失效。
- 库里只存 `HMAC-SHA256(pepper, 密钥)`；数据库和 Storage 都开了 RLS 且**零 policy**，
  anon key 读不到任何东西；bucket 私有，只能拿到后端签发的 6 小时临时链接。
- 全部接口先校验密钥，不过就 401；同一 IP 10 分钟内错 10 次会被限流。

## 四、改代码重新部署，数据会丢吗？

**不会。** 数据在 Supabase，跟 Netlify / Actions 完全是两套东西：

| 你改了什么 | 重新部署后 |
|---|---|
| `site/` 里的前端文件 | Netlify 只替换静态文件，**数据库和原图全保留** |
| Edge Function 代码 | 只替换函数代码，表与 bucket 不受影响 |

真会丢数据的只有：删 Storage bucket、删整个项目、手写 `drop table`。
另外免费版项目连续 7 天无访问会暂停（数据不丢，控制台 Restore 即可）。
保险起见偶尔去 Storage 下载一次原图备份。

> ⚠️ `setup-ready.sql` 用的是 `on conflict do update`：**重跑会覆盖密钥**，
> 平时别重复执行；要改密钥请用管理后台。

## 五、常见问题

- **删不掉照片**：旧版用原生 `confirm()`，很多 iOS 内嵌浏览器会静默拦截并返回 false。
  现在前后台都是页面内自定义确认框，任何环境都能用。
- **登录一直提示密钥不正确**：先跑这段 SQL 看 `len` 是否为 64
  ```sql
  select 'area_keys' t, area, length(key_hash) len from public.area_keys
  union all select 'admin_auth','admin', length(key_hash) from public.admin_auth;
  ```
  不是 64 / 报 `relation does not exist` → 重新跑一次 `setup-ready.sql`；
  同时确认函数 Secrets 里的 `AREA_PEPPER` 和生成 SQL 时用的是同一串。
- **改了 css/js 页面没变**：把 `index.html` / `admin.html` 里的 `?v=N` 加一。
