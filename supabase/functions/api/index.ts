// Supabase Edge Function: api
// 前端只持有「区域密钥」或「管理员密钥」，数据库 / Storage 完全不对匿名开放。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-area-key, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const AREAS: Record<string, string> = { grade7: '七年级', primary: '小学' };
const BUCKET = Deno.env.get('PHOTO_BUCKET') ?? 'photos';
const SIGNED_TTL = 60 * 60 * 6;          // 图片签名链接有效期（秒）
const MAX_AUTHOR = 16;
const MAX_CAPTION = 60;
const MIN_KEY_LEN = 4;
const MAX_KEY_LEN = 64;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PEPPER = Deno.env.get('AREA_PEPPER') ?? 'photo-wall-pepper';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Row = Record<string, unknown>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
const fail = (msg: string, status = 400) => json({ ok: false, error: msg }, status);

/* HMAC-SHA256(pepper, value) → hex，与 tools/hash-key.sh 保持一致 */
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

/* 简单限速：同一 IP 10 分钟内最多试错 10 次 */
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

/* ---------------- 鉴权 ---------------- */
async function authorizeArea(area: string, key: string) {
  if (!AREAS[area] || !key) return false;
  const { data, error } = await db
    .from('area_keys').select('key_hash').eq('area', area).maybeSingle();
  if (error || !data?.key_hash) return false;
  return safeEqual(data.key_hash, await hmacHex(key));
}

async function authorizeAdmin(key: string) {
  if (!key) return false;
  const { data, error } = await db
    .from('admin_auth').select('key_hash').eq('id', 1).maybeSingle();
  if (error || !data?.key_hash) return false;
  return safeEqual(data.key_hash, await hmacHex(key));
}

/* ---------------- Storage / 数据 ---------------- */
async function areaStats() {
  const stats: Record<string, number> = {};
  for (const a of Object.keys(AREAS)) {
    const { count } = await db
      .from('photos').select('id', { count: 'exact', head: true }).eq('area', a);
    stats[a] = count ?? 0;
  }
  return stats;
}

async function withUrls(rows: Row[]) {
  const urls = new Map<string, string>();
  if (rows.length) {
    const { data: signed } = await db.storage
      .from(BUCKET)
      .createSignedUrls(rows.map((r) => String(r.storage_path)), SIGNED_TTL);
    for (const s of signed ?? []) {
      if (s?.path && s?.signedUrl) urls.set(s.path, s.signedUrl);
    }
  }
  return rows
    .filter((r) => urls.has(String(r.storage_path)))
    .map((r) => ({
      id: r.id,
      area: r.area,
      areaName: AREAS[String(r.area)] ?? '',
      author: r.author,
      caption: r.caption,
      width: r.width,
      height: r.height,
      created_at: r.created_at,
      url: urls.get(String(r.storage_path)),
    }));
}

const PHOTO_COLS = 'id,area,storage_path,author,caption,width,height,created_at';

async function removeObjects(paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
  }
}

const intOrNull = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 20000 ? Math.round(n) : null;
};

function checkNewKey(v: unknown) {
  const s = String(v ?? '').trim();
  if (s.length < MIN_KEY_LEN) return { error: `新密钥至少 ${MIN_KEY_LEN} 位` };
  if (s.length > MAX_KEY_LEN) return { error: `新密钥最长 ${MAX_KEY_LEN} 位` };
  return { key: s };
}

/* ---------------- 主入口 ---------------- */
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('仅支持 POST', 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail('请求体不是合法 JSON'); }

  const action = String(body.action ?? '');
  const area = String(body.area ?? '');
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();

  /* ============ 管理员接口 ============ */
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
        let q = db.from('photos').select(PHOTO_COLS).order('created_at', { ascending: false }).limit(500);
        if (AREAS[area]) q = q.eq('area', area);
        const { data, error } = await q;
        if (error) return fail(error.message, 500);
        return json({ ok: true, photos: await withUrls(data ?? []), stats: await areaStats() });
      }

      case 'admin-delete': {
        const id = String(body.id ?? '');
        if (!/^[0-9a-f-]{36}$/i.test(id)) return fail('参数错误');
        const { data, error } = await db
          .from('photos').delete().eq('id', id).select('storage_path');
        if (error) return fail('删除失败：' + error.message, 500);
        const row = (data ?? [])[0];
        if (!row) return fail('这张照片已经不在了（可能已被删除）', 404);
        await db.storage.from(BUCKET).remove([row.storage_path]);
        return json({ ok: true, stats: await areaStats() });
      }

      case 'admin-clear-area': {
        if (!AREAS[area]) return fail('未知区域');
        if (String(body.confirm ?? '') !== AREAS[area]) {
          return fail(`确认文字不对：请输入「${AREAS[area]}」以清空该区域`);
        }
        const { data, error } = await db
          .from('photos').select('id,storage_path').eq('area', area);
        if (error) return fail(error.message, 500);
        const rows = data ?? [];
        if (!rows.length) return json({ ok: true, deleted: 0, stats: await areaStats() });
        const { error: delErr } = await db.from('photos').delete().eq('area', area);
        if (delErr) return fail(delErr.message, 500);
        await removeObjects(rows.map((r) => r.storage_path));
        return json({ ok: true, deleted: rows.length, stats: await areaStats() });
      }

      case 'admin-set-area-key': {
        if (!AREAS[area]) return fail('未知区域');
        const c = checkNewKey(body.newKey);
        if (c.error) return fail(c.error);
        const { error } = await db.from('area_keys').upsert({
          area,
          key_hash: await hmacHex(c.key!),
          updated_at: new Date().toISOString(),
        });
        if (error) return fail(error.message, 500);
        return json({ ok: true, area, areaName: AREAS[area] });
      }

      case 'admin-set-admin-key': {
        const c = checkNewKey(body.newKey);
        if (c.error) return fail(c.error);
        const { error } = await db.from('admin_auth').upsert({
          id: 1,
          key_hash: await hmacHex(c.key!),
          updated_at: new Date().toISOString(),
        });
        if (error) return fail(error.message, 500);
        return json({ ok: true });
      }

      default:
        return fail('未知的管理操作');
    }
  }

  /* ============ 普通区域接口 ============ */
  /* 自检接口：不带任何密钥也能调，用来确认部署的是不是最新代码 */
  if (action === 'ping') {
    return json({ ok: true, version: 2, service: 'photo-wall' });
  }

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
      const { data, error } = await db
        .from('photos').select(PHOTO_COLS).eq('area', area)
        .order('created_at', { ascending: false }).limit(500);
      if (error) return fail(error.message, 500);
      return json({ ok: true, photos: await withUrls(data ?? []) });
    }

    case 'sign-upload': {
      const path = `${area}/${Date.now()}-${crypto.randomUUID()}.jpg`;
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) return fail(error?.message ?? '签发上传地址失败', 500);
      return json({ ok: true, path, token: data.token });
    }

    case 'commit': {
      const path = String(body.path ?? '');
      if (!path.startsWith(area + '/') || path.includes('..') || path.length > 200) {
        return fail('非法路径');
      }
      const author = String(body.author ?? '').trim().slice(0, MAX_AUTHOR) || '匿名';
      const caption = String(body.caption ?? '').trim().slice(0, MAX_CAPTION);
      const { error } = await db.from('photos').insert({
        area,
        storage_path: path,
        author,
        caption,
        width: intOrNull(body.width),
        height: intOrNull(body.height),
      });
      if (error) return fail(error.message, 500);
      return json({ ok: true });
    }

    case 'delete': {
      const id = String(body.id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return fail('参数错误');
      const { data, error } = await db
        .from('photos').delete().eq('id', id).eq('area', area).select('storage_path');
      if (error) return fail('删除失败：' + error.message, 500);
      const row = (data ?? [])[0];
      if (!row) return fail('这张照片已经不在了（可能已被删除）', 404);
      await db.storage.from(BUCKET).remove([row.storage_path]);
      return json({ ok: true });
    }

    default:
      return fail('未知操作');
  }
});
