/* 我们的相册 — 前端逻辑（无框架、无构建） */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var BASE = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  var FN_URL = BASE + (CFG.FUNCTION_PATH || '/functions/v1/api');
  var AREAS = { grade7: '七年级', primary: '小学' };
  var MAX_MB = 20;

  var state = {
    area: localStorage.getItem('pw.area') === 'primary' ? 'primary' : 'grade7',
    queue: [],               // 待上传的 File
    photos: {},              // area -> [photo]
    loaded: {},              // area -> bool
    busy: false
  };

  /* ---------------- DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    tabs: $('tabs'), lockView: $('lockView'), areaView: $('areaView'),
    lockTitle: $('lockTitle'), lockHint: $('lockHint'), lockFoot: $('lockFoot'),
    keyForm: $('keyForm'), keyInput: $('keyInput'), keyBtn: $('keyBtn'),
    lockBtn: $('lockBtn'),
    nameInput: $('nameInput'), captionInput: $('captionInput'),
    pickBtn: $('pickBtn'), fileInput: $('fileInput'), queueBox: $('queue'),
    progress: $('progress'), progressBar: $('progress').firstElementChild,
    uploadBtn: $('uploadBtn'),
    gallery: $('gallery'), empty: $('empty'), count: $('count'), skeletons: $('skeletons'),
    lightbox: $('lightbox'), lbImg: $('lbImg'), lbAuthor: $('lbAuthor'), lbTime: $('lbTime'),
    lbClose: $('lbClose'), lbDel: $('lbDel'), toast: $('toast')
  };

  /* ---------------- 工具 ---------------- */
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

  function keyOf(area) { try { return sessionStorage.getItem('pw.key.' + area) || ''; } catch (e) { return ''; } }
  function setKey(area, k) { try { k ? sessionStorage.setItem('pw.key.' + area, k) : sessionStorage.removeItem('pw.key.' + area); } catch (e) {} }

  /* ---------------- 后端调用 ---------------- */
  function api(body) {
    var headers = { 'Content-Type': 'application/json' };
    if (CFG.SUPABASE_ANON_KEY) {
      headers.apikey = CFG.SUPABASE_ANON_KEY;
      headers.Authorization = 'Bearer ' + CFG.SUPABASE_ANON_KEY;
    }
    if (body.key) headers['x-area-key'] = body.key;
    return fetch(FN_URL, {
      method: 'POST', headers: headers, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: '服务返回异常（' + r.status + '）' }; });
    }).catch(function (e) {
      return { ok: false, error: '网络错误：' + (e && e.message ? e.message : e) };
    });
  }

  /* 直传 Storage 的签名地址（带进度） */
  function putSigned(path, token, blob, onProgress) {
    return new Promise(function (resolve, reject) {
      var url = BASE + '/storage/v1/object/upload/sign/' + path.split('/').map(encodeURIComponent).join('/') +
        '?token=' + encodeURIComponent(token);
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('x-upsert', 'true');
      if (CFG.SUPABASE_ANON_KEY) {
        xhr.setRequestHeader('apikey', CFG.SUPABASE_ANON_KEY);
        xhr.setRequestHeader('Authorization', 'Bearer ' + CFG.SUPABASE_ANON_KEY);
      }
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('上传失败（' + xhr.status + '）：' + String(xhr.responseText || '').slice(0, 160)));
      };
      xhr.onerror = function () { reject(new Error('上传网络错误')); };
      xhr.send(blob);
    });
  }

  /* ---------------- 界面状态 ---------------- */
  var verified = { grade7: false, primary: false };

  function renderTabs() {
    var btns = el.tabs.querySelectorAll('.tab');
    for (var i = 0; i < btns.length; i++) {
      var a = btns[i].getAttribute('data-area');
      btns[i].className = 'tab' + (a === state.area ? ' active' : '') + (verified[a] ? ' unlocked' : '');
    }
  }

  function renderView() {
    var area = state.area;
    el.lockBtn.hidden = !verified[area];
    if (verified[area]) {
      el.lockView.hidden = true;
      el.areaView.hidden = false;
      loadPhotos(area);
    } else {
      el.areaView.hidden = true;
      el.lockView.hidden = false;
      el.lockTitle.textContent = AREAS[area] + '区域';
      el.lockHint.textContent = '这里是' + AREAS[area] + '的合照，请输入访问密钥';
      el.keyInput.value = '';
      setTimeout(function () { el.keyInput.focus(); }, 60);
    }
    renderTabs();
  }

  function colCount() { return window.innerWidth >= 560 ? 3 : 2; }

  /* 把节点按“预估高度”分到若干列，做出瀑布流 */
  function layout(container, items) {
    container.innerHTML = '';
    var n = colCount(), cols = [], heights = [], i;
    for (i = 0; i < n; i++) {
      var c = document.createElement('div');
      c.className = 'gcol';
      container.appendChild(c);
      cols.push(c); heights.push(0);
    }
    items.forEach(function (node) {
      var ratio = parseFloat(node.getAttribute('data-ratio')) || 1;
      var idx = 0;
      for (var j = 1; j < n; j++) if (heights[j] < heights[idx] - 0.02) idx = j;
      cols[idx].appendChild(node);
      heights[idx] += ratio + 0.08;
    });
  }

  function skeleton(n) {
    var items = [], i;
    for (i = 0; i < n; i++) {
      var d = document.createElement('div');
      d.className = 'sk';
      d.setAttribute('data-ratio', String([1.25, 0.75, 1.5, 1][i % 4]));
      items.push(d);
    }
    layout(el.skeletons, items);
    el.skeletons.hidden = false;
  }

  function loadPhotos(area, force) {
    if (state.loaded[area] && !force) { renderGallery(area); return Promise.resolve(); }
    el.gallery.innerHTML = '';
    el.empty.hidden = true;
    skeleton(6);
    return api({ action: 'list', area: area, key: keyOf(area) }).then(function (r) {
      el.skeletons.hidden = true;
      if (!r || !r.ok) {
        if (r && /密钥/.test(r.error || '')) { verified[area] = false; setKey(area, ''); renderView(); }
        toast((r && r.error) || '加载失败');
        return;
      }
      state.photos[area] = r.photos || [];
      state.loaded[area] = true;
      if (area === state.area) renderGallery(area);
    });
  }

  function renderGallery(area) {
    var list = state.photos[area] || [];
    el.empty.hidden = list.length > 0;
    el.count.textContent = list.length ? list.length + ' 张' : '';
    var items = [];
    list.forEach(function (p, idx) {
      var card = document.createElement('figure');
      card.className = 'shot';
      card.setAttribute('data-ratio', p.width && p.height ? (p.height / p.width).toFixed(3) : '1');
      var img = document.createElement('img');
      img.src = p.url;
      img.alt = p.author + ' 上传的合照';
      img.loading = 'lazy';
      img.decoding = 'async';
      if (p.width && p.height) img.style.aspectRatio = p.width + ' / ' + p.height;
      img.addEventListener('click', function () { openLightbox(area, idx); });
      card.appendChild(img);
      if (p.caption) {
        var cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = p.caption;
        card.appendChild(cap);
      }
      var meta = document.createElement('div');
      meta.className = 'meta';
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = p.author || '匿名';
      var when = document.createElement('span');
      when.className = 'when';
      when.textContent = timeAgo(p.created_at);
      meta.appendChild(who); meta.appendChild(when);
      card.appendChild(meta);
      items.push(card);
    });
    layout(el.gallery, items);
  }

  /* ---------------- 大图 ---------------- */
  var lbState = { area: null, index: 0 };
  function openLightbox(area, idx) {
    var p = (state.photos[area] || [])[idx];
    if (!p) return;
    lbState.area = area; lbState.index = idx;
    el.lbImg.src = p.url;
    el.lbAuthor.textContent = p.author || '匿名';
    el.lbTime.textContent = timeAgo(p.created_at);
    el.lightbox.hidden = false;
  }
  function closeLightbox() { el.lightbox.hidden = true; el.lbImg.src = ''; }

  function deletePhoto() {
    var area = lbState.area;
    var p = (state.photos[area] || [])[lbState.index];
    if (!p) return;
    askConfirm({
      title: '删除这张照片？',
      text: '删除后无法恢复。',
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      el.lbDel.disabled = true;
      api({ action: 'delete', area: area, key: keyOf(area), id: p.id }).then(function (r) {
        el.lbDel.disabled = false;
        if (!r || !r.ok) { toast((r && r.error) || '删除失败'); return; }
        state.photos[area] = state.photos[area].filter(function (x) { return x.id !== p.id; });
        closeLightbox();
        renderGallery(area);
        toast('已删除');
      });
    });
  }

  /* ---------------- 选图 / 压缩 ---------------- */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
      img.src = url;
    });
  }

  function compress(file, maxEdge, quality) {
    maxEdge = maxEdge || 1800; quality = quality || 0.86;
    return loadImage(file).then(function (r) {
      var img = r.img;
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(r.url);
      return new Promise(function (resolve) {
        try {
          canvas.toBlob(function (blob) {
            if (!blob) { resolve({ blob: file, width: cw, height: ch }); return; }
            resolve({ blob: blob, width: cw, height: ch });
          }, 'image/jpeg', quality);
        } catch (e) {
          resolve({ blob: file, width: cw, height: ch });
        }
      });
    });
  }

  function addFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    arr.forEach(function (f) {
      if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp|gif|bmp)$/i.test(f.name)) {
        toast('「' + f.name + '」不是图片'); return;
      }
      if (f.size > MAX_MB * 1024 * 1024) { toast('「' + f.name + '」超过 ' + MAX_MB + 'MB'); return; }
      state.queue.push(f);
    });
    renderQueue();
  }

  function renderQueue() {
    el.queueBox.innerHTML = '';
    state.queue.forEach(function (f, i) {
      var d = document.createElement('div');
      d.className = 'qitem';
      var im = document.createElement('img');
      im.src = URL.createObjectURL(f);
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = '✕';
      b.onclick = function () { state.queue.splice(i, 1); renderQueue(); };
      d.appendChild(im); d.appendChild(b);
      el.queueBox.appendChild(d);
    });
    el.uploadBtn.hidden = state.queue.length === 0;
    el.uploadBtn.textContent = state.queue.length > 1
      ? '上传 ' + state.queue.length + ' 张'
      : '上传这张';
  }

  /* ---------------- 上传 ---------------- */
  function setProgress(done, total, partial) {
    var pct = Math.min(100, Math.round(((done + (partial || 0)) / total) * 100));
    el.progressBar.style.width = Math.max(4, pct) + '%';
  }

  function uploadAll() {
    if (state.busy) return;
    var area = state.area, key = keyOf(area);
    var name = (el.nameInput.value || '').trim().slice(0, 16);
    var caption = (el.captionInput.value || '').trim().slice(0, 60);
    if (!name) { toast('先写上你的名字吧'); el.nameInput.focus(); return; }
    if (!state.queue.length) return;
    try { localStorage.setItem('pw.name', name); } catch (e) {}

    state.busy = true;
    el.uploadBtn.disabled = true;
    el.pickBtn.disabled = true;
    el.progress.hidden = false;
    el.progressBar.style.width = '4%';

    var files = state.queue.slice();
    var total = files.length, done = 0, failed = 0;

    function step() {
      if (!files.length) return Promise.resolve();
      var f = files.shift();
      return compress(f).then(function (c) {
        return api({ action: 'sign-upload', area: area, key: key }).then(function (s) {
          if (!s || !s.ok) return s;
          return putSigned(s.path, s.token, c.blob, function (p) { setProgress(done, total, p); })
            .then(function () {
              return api({
                action: 'commit', area: area, key: key, path: s.path,
                author: name, caption: caption, width: c.width, height: c.height
              });
            });
        });
      }).then(function (r) {
        if (!r || !r.ok) {
          failed++;
          failed && toast((r && r.error) || '有一张上传失败');
        }
        done++; setProgress(done, total, 0);
        return step();
      }, function (e) {
        failed++;
        toast(e && e.message ? e.message : '上传出错');
        done++; setProgress(done, total, 0);
        return step();
      });
    }

    step().then(function () {
      state.busy = false;
      el.uploadBtn.disabled = false;
      el.pickBtn.disabled = false;
      state.queue = [];
      el.captionInput.value = '';
      renderQueue();
      setTimeout(function () { el.progress.hidden = true; el.progressBar.style.width = '0%'; }, 600);
      var okCount = total - failed;
      if (okCount > 0) toast('已上传 ' + okCount + ' 张 ✓');
      state.loaded[area] = false;
      loadPhotos(area, true);
    });
  }

  /* ---------------- 解锁 ---------------- */
  function shake() {
    var card = el.lockView;
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = 'pop .3s ease';
  }

  function tryUnlock(area, key) {
    el.keyBtn.disabled = true;
    el.keyBtn.textContent = '验证中…';
    return api({ action: 'verify', area: area, key: key }).then(function (r) {
      el.keyBtn.disabled = false;
      el.keyBtn.textContent = '解锁';
      if (!r || !r.ok) {
        toast((r && r.error) || '密钥不正确');
        el.keyInput.value = '';
        el.keyInput.focus();
        shake();
        return false;
      }
      setKey(area, key);
      verified[area] = true;
      state.loaded[area] = false;
      renderView();
      toast('已进入' + AREAS[area] + '区域');
      return true;
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  el.tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn) return;
    var a = btn.getAttribute('data-area');
    if (a === state.area) return;
    state.area = a;
    try { localStorage.setItem('pw.area', a); } catch (err) {}
    renderView();
  });

  el.keyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var k = (el.keyInput.value || '').trim();
    if (!k) { toast('请输入密钥'); return; }
    tryUnlock(state.area, k);
  });

  el.lockBtn.addEventListener('click', function () {
    var a = state.area;
    askConfirm({
      title: '锁定' + AREAS[a] + '区域？',
      text: '下次进入需要重新输入密钥。',
      okText: '锁定'
    }).then(function (ok) {
      if (!ok) return;
      setKey(a, '');
      verified[a] = false;
      state.loaded[a] = false;
      state.photos[a] = [];
      renderView();
      toast('已锁定');
    });
  });

  el.pickBtn.addEventListener('click', function () { el.fileInput.click(); });
  el.fileInput.addEventListener('change', function () {
    addFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    el.pickBtn.addEventListener(ev, function (e) { e.preventDefault(); el.pickBtn.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    el.pickBtn.addEventListener(ev, function (e) { e.preventDefault(); el.pickBtn.classList.remove('over'); });
  });
  el.pickBtn.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  el.uploadBtn.addEventListener('click', uploadAll);
  el.nameInput.addEventListener('input', function () {
    try { localStorage.setItem('pw.name', el.nameInput.value.trim()); } catch (e) {}
  });
  el.lbClose.addEventListener('click', closeLightbox);
  el.lbDel.addEventListener('click', deletePhoto);
  el.lightbox.addEventListener('click', function (e) {
    if (e.target === el.lightbox) closeLightbox();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.lightbox.hidden) closeLightbox();
  });

  /* 隐藏入口：连续点左上角 logo 5 次进入管理后台 */
  var logoTaps = 0, logoTimer;
  document.querySelector('.logo').addEventListener('click', function () {
    logoTaps++;
    clearTimeout(logoTimer);
    if (logoTaps >= 5) { location.href = 'admin.html'; return; }
    logoTimer = setTimeout(function () { logoTaps = 0; }, 1200);
  });

  /* ---------------- 启动 ---------------- */
  function banner() {
    if (CFG.SUPABASE_URL && !/YOUR-PROJECT/.test(CFG.SUPABASE_URL)) return;
    var wrap = document.createElement('div');
    wrap.className = 'banner';
    wrap.innerHTML = '<div><b>还没配置 Supabase</b>：请在 assets/config.js 里填好 SUPABASE_URL（和可选的 anon key），' +
      '再部署 Supabase 函数与数据表。</div>';
    document.querySelector('main').before(wrap);
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (verified[state.area]) renderGallery(state.area);
    }, 200);
  });

  function boot() {
    banner();
    try { el.nameInput.value = localStorage.getItem('pw.name') || ''; } catch (e) {}
    var areas = ['grade7', 'primary'];
    var chain = Promise.resolve();
    areas.forEach(function (a) {
      var k = keyOf(a);
      if (!k) return;
      chain = chain.then(function () {
        return api({ action: 'verify', area: a, key: k }).then(function (r) {
          if (r && r.ok) verified[a] = true; else setKey(a, '');
        });
      });
    });
    chain.then(renderView, renderView);
  }

  boot();
})();
