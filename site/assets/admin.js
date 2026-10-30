/* 管理后台逻辑 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var BASE = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  var FN_URL = BASE + (CFG.FUNCTION_PATH || '/functions/v1/api');
  var AREAS = { grade7: '七年级', primary: '小学' };

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    loginView: $('loginView'), panelView: $('panelView'), adminForm: $('adminForm'),
    adminKey: $('adminKey'), loginBtn: $('loginBtn'), logoutBtn: $('logoutBtn'),
    stats: $('stats'), seg: $('seg'), grid: $('admGrid'), empty: $('admEmpty'),
    toast: $('toast'), loginDebug: $('loginDebug'), diagBtn: $('diagBtn')
  };

  var state = { key: '', area: '', photos: [], busy: false };

  /* ---------- 工具 ---------- */
  var toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    el.toast.style.animation = 'none';
    void el.toast.offsetWidth;
    el.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }


  /* 页面内确认框：不依赖原生 confirm()，避免在 WebView 里被静默拦截 */
  function askConfirm(opts) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = '<div class="modal-card"><h3></h3><p></p>' +
        '<div class="modal-actions"><button class="cancel" type="button">取消</button>' +
        '<button class="ok" type="button"></button></div></div>';
      wrap.querySelector('h3').textContent = opts.title || '确认';
      wrap.querySelector('p').textContent = opts.text || '';
      var ok = wrap.querySelector('.ok');
      ok.textContent = opts.okText || '确定';
      if (opts.danger) ok.className = 'ok danger';
      function done(v) { wrap.remove(); resolve(v); }
      ok.addEventListener('click', function () { done(true); });
      wrap.querySelector('.cancel').addEventListener('click', function () { done(false); });
      wrap.addEventListener('click', function (e) { if (e.target === wrap) done(false); });
      document.body.appendChild(wrap);
      ok.focus();
    });
  }

  function timeAgo(iso) {
    var t = new Date(iso).getTime();
    if (!t) return '';
    var d = Math.floor((Date.now() - t) / 1000);
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 86400 * 2) return '昨天';
    if (d < 86400 * 7) return Math.floor(d / 86400) + ' 天前';
    var dt = new Date(t);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  function getKey() { try { return sessionStorage.getItem('pw.admin') || ''; } catch (e) { return ''; } }
  function setKey(k) { try { k ? sessionStorage.setItem('pw.admin', k) : sessionStorage.removeItem('pw.admin'); } catch (e) {} }

  function api(action, payload) {
    var body = { action: action, adminKey: state.key };
    for (var k in payload || {}) body[k] = payload[k];
    return fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': state.key },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) {
          j = { ok: false, error: '服务端返回的不是 JSON（HTTP ' + r.status + '）：' + String(t).slice(0, 100) };
        }
        j._status = r.status;
        return j;
      });
    }).catch(function (e) {
      return { ok: false, error: '网络错误：' + (e && e.message ? e.message : e), _status: 0 };
    });
  }

  /* ---------- 视图 ---------- */
  function renderStats(stats) {
    el.stats.innerHTML = '';
    var total = 0;
    (['grade7', 'primary']).forEach(function (a) {
      var n = (stats && stats[a]) || 0;
      total += n;
      var d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<b>' + n + '</b><span>' + AREAS[a] + '</span>';
      el.stats.appendChild(d);
    });
    var t = document.createElement('div');
    t.className = 'stat';
    t.innerHTML = '<b>' + total + '</b><span>共</span>';
    el.stats.appendChild(t);
  }

  function renderGrid() {
    el.grid.innerHTML = '';
    el.empty.hidden = state.photos.length > 0;
    state.photos.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'adm-photo';

      var img = document.createElement('img');
      img.src = p.url;
      img.alt = p.author || '';
      img.loading = 'lazy';
      card.appendChild(img);

      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = p.areaName || AREAS[p.area] || '';
      card.appendChild(tag);

      var del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.textContent = '✕';
      del.setAttribute('aria-label', '删除');
      del.onclick = function () { removeOne(p); };
      card.appendChild(del);

      var info = document.createElement('div');
      info.className = 'info';
      var who = document.createElement('span');
      who.textContent = p.author || '匿名';
      var when = document.createElement('span');
      when.textContent = timeAgo(p.created_at);
      info.appendChild(who); info.appendChild(when);
      card.appendChild(info);

      el.grid.appendChild(card);
    });
  }

  function showPanel(stats) {
    el.loginView.hidden = true;
    el.panelView.hidden = false;
    el.logoutBtn.hidden = false;
    if (stats) renderStats(stats);
    loadPhotos();
  }

  function showLogin() {
    el.panelView.hidden = true;
    el.loginView.hidden = false;
    el.logoutBtn.hidden = true;
    el.adminKey.value = '';
    if (el.loginDebug) el.loginDebug.textContent = '';
    setTimeout(function () { el.adminKey.focus(); }, 60);
  }

  function loadPhotos() {
    return api('admin-list', { area: state.area }).then(function (r) {
      if (!r || !r.ok) {
        if (/管理员密钥/.test(r && r.error || '')) { setKey(''); state.key = ''; showLogin(); }
        toast((r && r.error) || '加载失败');
        return;
      }
      state.photos = r.photos || [];
      renderGrid();
      renderStats(r.stats);
    });
  }

  /* ---------- 操作 ---------- */
  function removeOne(p) {
    askConfirm({
      title: '删除这张照片？',
      text: '「' + (p.author || '匿名') + '」上传的照片会被永久删除。',
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      api('admin-delete', { id: p.id }).then(function (r) {
        if (!r || !r.ok) { toast((r && r.error) || '删除失败'); return; }
        state.photos = state.photos.filter(function (x) { return x.id !== p.id; });
        renderGrid();
        renderStats(r.stats);
        toast('已删除');
      });
    });
  }

  function login(key) {
    state.key = key;
    el.loginBtn.disabled = true;
    el.loginBtn.textContent = '验证中…';
    return api('admin-login').then(function (r) {
      el.loginBtn.disabled = false;
      el.loginBtn.textContent = '进入后台';
      if (!r || !r.ok) {
        state.key = '';
        toast((r && r.error) || '登录失败');
        if (el.loginDebug) {
          el.loginDebug.textContent = '诊断：HTTP ' + ((r && r._status) || 0) + ' · ' + ((r && r.error) || '无返回');
        }
        return false;
      }
      setKey(key);
      showPanel(r.stats);
      return true;
    });
  }

  /* ---------- 事件 ---------- */
  el.adminForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var k = (el.adminKey.value || '').trim();
    if (!k) return;
    login(k);
  });

  el.diagBtn.addEventListener('click', function () {
    el.diagBtn.disabled = true;
    el.loginDebug.textContent = '正在检查…';
    api('ping').then(function (r) {
      el.diagBtn.disabled = false;
      if (!r || !r.ok) {
        el.loginDebug.textContent = '✗ 连不上后端：HTTP ' + ((r && r._status) || 0) + ' · ' + ((r && r.error) || '无返回');
        return;
      }
      var hasVersion = typeof r.version === 'number';
      el.loginDebug.textContent = (hasVersion
        ? '✓ 后端在线（v' + r.version + '）'
        : '△ 后端在线，但还是旧版本代码，需要重新部署 Edge Function');
    });
  });

  el.logoutBtn.addEventListener('click', function () {
    setKey('');
    state.key = '';
    state.photos = [];
    showLogin();
    toast('已退出');
  });

  el.seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.area = b.getAttribute('data-area') || '';
    var all = el.seg.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) all[i].className = all[i] === b ? 'on' : '';
    el.grid.innerHTML = '';
    loadPhotos();
  });

  document.querySelectorAll('form[data-set]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var area = form.getAttribute('data-set');
      var input = form.querySelector('input');
      var val = (input.value || '').trim();
      if (val.length < 4) { toast('新密钥至少 4 位'); return; }
      askConfirm({
        title: '更换「' + AREAS[area] + '」密钥？',
        text: '新密钥：' + val + '。旧密钥会立刻失效。',
        okText: '更换'
      }).then(function (ok) {
        if (!ok) return;
        api('admin-set-area-key', { area: area, newKey: val }).then(function (r) {
          if (!r || !r.ok) { toast((r && r.error) || '修改失败'); return; }
          input.value = '';
          toast(AREAS[area] + '的密钥已更新');
        });
      });
    });
  });

  $('adminKeyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('newAdminKey');
    var val = (input.value || '').trim();
    if (val.length < 4) { toast('新密钥至少 4 位'); return; }
    askConfirm({
      title: '更换管理员密钥？',
      text: '新密钥只在本机保存，请自己记牢。',
      okText: '更换'
    }).then(function (ok) {
      if (!ok) return;
      api('admin-set-admin-key', { newKey: val }).then(function (r) {
        if (!r || !r.ok) { toast((r && r.error) || '修改失败'); return; }
        input.value = '';
        setKey(val);
        state.key = val;
        toast('管理员密钥已更新（本机已保存新密钥）');
      });
    });
  });

  document.querySelectorAll('form[data-clear]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var area = form.getAttribute('data-clear');
      var input = form.querySelector('input');
      var typed = (input.value || '').trim();
      if (typed !== AREAS[area]) { toast('请输入「' + AREAS[area] + '」来确认'); return; }
      askConfirm({
        title: '清空「' + AREAS[area] + '」？',
        text: '这个区域的所有照片记录和原图都会被删除，无法恢复。',
        okText: '全部删除',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        api('admin-clear-area', { area: area, confirm: typed }).then(function (r) {
          if (!r || !r.ok) { toast((r && r.error) || '清空失败'); return; }
          input.value = '';
          toast('已删除 ' + (r.deleted || 0) + ' 张');
          loadPhotos();
        });
      });
    });
  });

  /* ---------- 启动 ---------- */
  (function boot() {
    if (!CFG.SUPABASE_URL || /YOUR-PROJECT/.test(CFG.SUPABASE_URL)) {
      var wrap = document.createElement('div');
      wrap.className = 'banner';
      wrap.innerHTML = '<div><b>还没配置 Supabase</b>：请先在 assets/config.js 填好 SUPABASE_URL。</div>';
      document.querySelector('main').before(wrap);
      return;
    }
    var saved = getKey();
    if (saved) {
      state.key = saved;
      api('admin-login').then(function (r) {
        if (r && r.ok) showPanel(r.stats);
        else { setKey(''); state.key = ''; showLogin(); }
      });
    } else {
      showLogin();
    }
  })();
})();
