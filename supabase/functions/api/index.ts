// Supabase Edge Function: api
// 零依赖版本：不 import 任何远程模块，直接调用 PostgREST / Storage REST 接口。
// 这样无论是 Dashboard 粘贴、CLI 还是 Management API 直接推源码都能跑起来。

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-area-key, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const AREAS: Record<string, string> = { grade7: '七年级', primary: '小学' };
const BUCKET = Deno.env.get('PHOTO_BUCKET') ?? 'photos';
const SIGNED_TTL = 60 * 60 * 6;
const MAX_AUTHOR = 16;
const MAX_CAPTION = 60;
const MAX_BODY = 500;
const MAX_COMMENT = 200;
const MIN_KEY_LEN = 4;
const MAX_KEY_LEN = 64;

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PEPPER = Deno.env.get('AREA_PEPPER') ?? 'photo-wall-pepper';

const AUTH: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY,
};

/* ---------------- 基础响应 ---------------- */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
const fail = (msg: string, status = 400) => json({ ok: false, error: msg }, status);

/* ---------------- PostgREST ---------------- */
type PgRes = { ok: boolean; status: number; data: any; headers: Headers };

async function pg(path: string, init: RequestInit = {}): Promise<PgRes> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...AUTH, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) },
  });
  const text = await res.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

async function pgCount(table: string, query: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&select=*`, {
    method: 'HEAD',
    headers: { ...AUTH, Prefer: 'count=exact' },
  });
  const range = res.headers.get('content-range') ?? '';
  const n = Number(range.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}

/* ---------------- Storage ---------------- */
async function storageSign(paths: string[]) {
  const map = new Map<string, string>();
  if (!paths.length) return map;
  // 分批，避免 URL / body 过大
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGNED_TTL, paths: chunk }),
    });
    if (!res.ok) continue;
    const list = await res.json().catch(() => []);
    for (const item of list ?? []) {
      if (item?.path && item?.signedURL) {
        map.set(item.path, item.signedURL.startsWith('http')
          ? item.signedURL
          : `${SUPABASE_URL}/storage/v1${item.signedURL}`);
      }
    }
  }
  return map;
}

async function storageSignedUpload(path: string) {
  const full = `${BUCKET}/${path}`.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${full}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ upsert: false }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.token) return null;
  return { token: String(data.token), path };
}

async function storageRemove(paths: string[]) {
  if (!paths.length) return;
  for (let i = 0; i < paths.length; i += 100) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }),
    });
  }
}

/* ---------------- 鉴权 ---------------- */
async function hmacHex(value: string) {
  const enc = new TextEncoder();
  const ck = await crypto.subtle.importKey(
    'raw', enc.encode(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const WINDOW = 10 * 60_000;
const LIMIT = 10;
const hits = new Map<string, { n: number; t: number }>();
function throttled(ip: string) {
  const b = hits.get(ip);
  return !!b && Date.now() - b.t < WINDOW && b.n >= LIMIT;
}
function noteFail(ip: string) {
  const now = Date.now();
  const b = hits.get(ip);
  if (!b || now - b.t > WINDOW) hits.set(ip, { n: 1, t: now });
  else b.n++;
}

async function authorizeArea(area: string, key: string) {
  if (!AREAS[area] || !key) return false;
  const r = await pg(`area_keys?select=key_hash&area=eq.${encodeURIComponent(area)}`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!row?.key_hash) return false;
  return safeEqual(String(row.key_hash), await hmacHex(key));
}

async function authorizeAdmin(key: string) {
  if (!key) return false;
  const r = await pg('admin_auth?select=key_hash&id=eq.1');
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!row?.key_hash) return false;
  return safeEqual(String(row.key_hash), await hmacHex(key));
}

/* ---------------- 工具 ---------------- */
const uuidOk = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const intOrNull = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 20000 ? Math.round(n) : null;
};
const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

function checkNewKey(v: unknown) {
  const s = String(v ?? '').trim();
  if (s.length < MIN_KEY_LEN) return { error: `新密钥至少 ${MIN_KEY_LEN} 位` };
  if (s.length > MAX_KEY_LEN) return { error: `新密钥最长 ${MAX_KEY_LEN} 位` };
  return { key: s };
}

const COLS = 'id,area,storage_path,author,caption,body,kind,width,height,created_at';

function shape(r: Record<string, unknown>, url: string | null) {
  return {
    id: r.id,
    area: r.area,
    areaName: AREAS[String(r.area)] ?? '',
    kind: r.kind ?? 'photo',
    author: r.author,
    caption: r.caption,
    body: r.body,
    width: r.width,
    height: r.height,
    created_at: r.created_at,
    url,
  };
}

type Row = Record<string, any>;

async function withUrls(rows: Row[]) {
  const paths = rows
    .filter((r) => r.kind !== 'text' && r.storage_path)
    .map((r) => String(r.storage_path));
  const urls = await storageSign(paths);
  return rows
    .map((r) => shape(r, r.storage_path ? urls.get(String(r.storage_path)) ?? null : null))
    .filter((p: Row) => p.kind === 'text' || p.url);
}

async function socialStats(ids: string[], clientId: string) {
  const likes = new Map<string, number>();
  const comments = new Map<string, number>();
  const mine = new Set<string>();
  if (!ids.length) return { likes, comments, mine };
  const inList = ids.map((i) => `"${i}"`).join(',');

  const [likeRes, cmtRes, mineRes] = await Promise.all([
    pg(`likes?select=post_id&post_id=in.(${inList})&limit=5000`),
    pg(`comments?select=post_id&post_id=in.(${inList})&limit=5000`),
    clientId
      ? pg(`likes?select=post_id&post_id=in.(${inList})&client_id=eq.${encodeURIComponent(clientId)}&limit=5000`)
      : Promise.resolve({ data: [] as Row[] } as PgRes),
  ]);

  for (const r of (likeRes.data ?? []) as Row[]) {
    const k = String(r.post_id);
    likes.set(k, (likes.get(k) ?? 0) + 1);
  }
  for (const r of (cmtRes.data ?? []) as Row[]) {
    const k = String(r.post_id);
    comments.set(k, (comments.get(k) ?? 0) + 1);
  }
  for (const r of (mineRes.data ?? []) as Row[]) mine.add(String(r.post_id));
  return { likes, comments, mine };
}

async function areaStats() {
  const stats: Record<string, number> = {};
  for (const a of Object.keys(AREAS)) {
    stats[a] = await pgCount('photos', `area=eq.${encodeURIComponent(a)}`);
  }
  return stats;
}

/* ---------------- 主入口 ---------------- */
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('仅支持 POST', 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return fail('服务端缺少 SUPABASE_URL / SERVICE_ROLE_KEY', 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail('请求体不是合法 JSON'); }

  const action = String(body.action ?? '');
  const area = String(body.area ?? '');
  const clientId = clip(body.clientId, 64);
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();

  /* ============ 管理员 ============ */
  if (action.startsWith('admin-')) {
    const adminKey = req.headers.get('x-admin-key') ?? String(body.adminKey ?? '');

    if (action === 'admin-login') {
      if (throttled(ip)) return fail('尝试次数太多，请 10 分钟后再试', 429);
      if (!(await authorizeAdmin(adminKey))) {
        noteFail(ip);
        return fail('管理员密钥不正确', 401);
      }
      hits.delete(ip);
      return json({ ok: true, stats: await areaStats() });
    }

    if (!(await authorizeAdmin(adminKey))) return fail('管理员密钥无效，请重新登录', 401);

    switch (action) {
      case 'admin-list': {
        const filter = AREAS[area] ? `&area=eq.${encodeURIComponent(area)}` : '';
        const r = await pg(`photos?select=${COLS}&order=created_at.desc${filter}&limit=500`);
        if (!r.ok) return fail('读取失败：' + String(r.data?.message ?? r.status), 500);
        const rows = (r.data ?? []) as Row[];
        const st = await socialStats(rows.map((x) => String(x.id)), '');
        return json({
          ok: true,
          photos: (await withUrls(rows)).map((p: Row) => ({
            ...p,
            likes: st.likes.get(String(p.id)) ?? 0,
            comments: st.comments.get(String(p.id)) ?? 0,
          })),
          stats: await areaStats(),
        });
      }

      case 'admin-delete': {
        const id = String(body.id ?? '');
        if (!uuidOk(id)) return fail('参数错误');
        const r = await pg(`photos?id=eq.${id}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=representation' },
        });
        if (!r.ok) return fail('删除失败：' + String(r.data?.message ?? r.status), 500);
        const row = (r.data ?? [])[0];
        if (!row) return fail('这条已经不在了（可能已被删除）', 404);
        if (row.storage_path) await storageRemove([String(row.storage_path)]);
        return json({ ok: true, stats: await areaStats() });
      }

      case 'admin-clear-area': {
        if (!AREAS[area]) return fail('未知区域');
        if (String(body.confirm ?? '') !== AREAS[area]) {
          return fail(`确认文字不对：请输入「${AREAS[area]}」以清空该区域`);
        }
        const q = await pg(`photos?select=id,storage_path&area=eq.${encodeURIComponent(area)}`);
        const rows = (q.data ?? []) as Row[];
        if (!rows.length) return json({ ok: true, deleted: 0, stats: await areaStats() });
        const del = await pg(`photos?area=eq.${encodeURIComponent(area)}`, { method: 'DELETE' });
        if (!del.ok) return fail('删除失败：' + String(del.data?.message ?? del.status), 500);
        await storageRemove(rows.map((x) => x.storage_path).filter(Boolean).map(String));
        return json({ ok: true, deleted: rows.length, stats: await areaStats() });
      }

      case 'admin-set-area-key': {
        if (!AREAS[area]) return fail('未知区域');
        const c = checkNewKey(body.newKey);
        if (c.error) return fail(c.error);
        const r = await pg('area_keys?on_conflict=area', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ area, key_hash: await hmacHex(c.key!), updated_at: new Date().toISOString() }),
        });
        if (!r.ok) return fail('修改失败：' + String(r.data?.message ?? r.status), 500);
        return json({ ok: true, area, areaName: AREAS[area] });
      }

      case 'admin-set-admin-key': {
        const c = checkNewKey(body.newKey);
        if (c.error) return fail(c.error);
        const r = await pg('admin_auth?on_conflict=id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ id: 1, key_hash: await hmacHex(c.key!), updated_at: new Date().toISOString() }),
        });
        if (!r.ok) return fail('修改失败：' + String(r.data?.message ?? r.status), 500);
        return json({ ok: true });
      }

      default:
        return fail('未知的管理操作');
    }
  }

  /* ============ 自检 ============ */
  if (action === 'ping') return json({ ok: true, version: 4, service: 'photo-wall' });

  if (!AREAS[area]) return fail('未知区域');
  const key = req.headers.get('x-area-key') ?? String(body.key ?? '');

  if (action === 'verify') {
    if (throttled(ip)) return fail('尝试次数太多，请 10 分钟后再试', 429);
    if (!(await authorizeArea(area, key))) { noteFail(ip); return fail('密钥不正确', 401); }
    hits.delete(ip);
    return json({ ok: true, area, areaName: AREAS[area] });
  }

  if (!(await authorizeArea(area, key))) return fail('密钥无效，请重新解锁', 401);

  switch (action) {
    case 'list': {
      const r = await pg(
        `photos?select=${COLS}&area=eq.${encodeURIComponent(area)}&order=created_at.desc&limit=300`,
      );
      if (!r.ok) return fail('读取失败：' + String(r.data?.message ?? r.status), 500);
      const rows = (r.data ?? []) as Row[];
      const items = await withUrls(rows);
      const st = await socialStats(items.map((p: Row) => String(p.id)), clientId);
      return json({
        ok: true,
        photos: items.map((p: Row) => ({
          ...p,
          likes: st.likes.get(String(p.id)) ?? 0,
          comments: st.comments.get(String(p.id)) ?? 0,
          liked: st.mine.has(String(p.id)),
        })),
      });
    }

    case 'sign-upload': {
      const path = `${area}/${Date.now()}-${crypto.randomUUID()}.jpg`;
      const signed = await storageSignedUpload(path);
      if (!signed) return fail('签发上传地址失败', 500);
      return json({ ok: true, path: signed.path, token: signed.token });
    }

    case 'commit': {
      const path = String(body.path ?? '');
      if (!path.startsWith(area + '/') || path.includes('..') || path.length > 200) {
        return fail('非法路径');
      }
      const author = clip(body.author, MAX_AUTHOR) || '匿名';
      const caption = clip(body.caption, MAX_CAPTION);
      const r = await pg('photos', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          area, kind: 'photo', storage_path: path, author, caption,
          width: intOrNull(body.width), height: intOrNull(body.height),
        }),
      });
      if (!r.ok) return fail('保存失败：' + String(r.data?.message ?? r.status), 500);
      return json({ ok: true });
    }

    case 'post-text': {
      const text = clip(body.body, MAX_BODY);
      if (!text) return fail('写点什么再发吧');
      const author = clip(body.author, MAX_AUTHOR) || '匿名';
      const r = await pg('photos?select=id', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          area, kind: 'text', storage_path: null, author, caption: '', body: text,
        }),
      });
      if (!r.ok) return fail('发布失败：' + String(r.data?.message ?? r.status), 500);
      return json({ ok: true, id: (r.data ?? [])[0]?.id ?? null });
    }

    case 'like': {
      const id = String(body.id ?? '');
      const like = body.like !== false;
      if (!uuidOk(id) || !clientId) return fail('参数错误');
      const r = like
        ? await pg('likes?on_conflict=post_id,client_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ post_id: id, client_id: clientId }),
          })
        : await pg(`likes?post_id=eq.${id}&client_id=eq.${encodeURIComponent(clientId)}`, { method: 'DELETE' });
      if (!r.ok) return fail('操作失败：' + String(r.data?.message ?? r.status), 500);
      const count = await pgCount('likes', `post_id=eq.${id}`);
      return json({ ok: true, likes: count, liked: like });
    }

    case 'comments': {
      const id = String(body.id ?? '');
      if (!uuidOk(id)) return fail('参数错误');
      const r = await pg(
        `comments?select=id,author,body,created_at&post_id=eq.${id}&order=created_at.asc&limit=300`,
      );
      if (!r.ok) return fail('读取失败：' + String(r.data?.message ?? r.status), 500);
      return json({ ok: true, comments: r.data ?? [] });
    }

    case 'comment': {
      const id = String(body.id ?? '');
      if (!uuidOk(id)) return fail('参数错误');
      const text = clip(body.body, MAX_COMMENT);
      if (!text) return fail('回复不能为空');
      const author = clip(body.author, MAX_AUTHOR) || '匿名';
      const r = await pg('comments?select=id,author,body,created_at', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ post_id: id, author, body: text }),
      });
      if (!r.ok) return fail('回复失败：' + String(r.data?.message ?? r.status), 500);
      return json({ ok: true, comment: (r.data ?? [])[0] ?? null });
    }

    case 'delete': {
      const id = String(body.id ?? '');
      if (!uuidOk(id)) return fail('参数错误');
      const r = await pg(`photos?id=eq.${id}&area=eq.${encodeURIComponent(area)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      if (!r.ok) return fail('删除失败：' + String(r.data?.message ?? r.status), 500);
      const row = (r.data ?? [])[0];
      if (!row) return fail('这条已经不在了（可能已被删除）', 404);
      if (row.storage_path) await storageRemove([String(row.storage_path)]);
      return json({ ok: true });
    }

    default:
      return fail('未知操作');
  }
});
