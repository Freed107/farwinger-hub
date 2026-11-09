/* PERDIMI Studio - phone app. Built for a slow, dropping connection:
   - every message goes into a local outbox first and is retried until the server confirms it (idempotent client ids)
   - photos are shrunk on the phone before upload; videos go up in chunks that retry one by one
   - media shows small previews; full quality only when asked
   - Claude answers server-side, so a dropped connection never loses a reply: the next sync picks it up */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ network
  let netState = 'ok';
  function setNet(state) {
    netState = state;
    const dot = $('#net .dot'); const label = $('#net-label');
    if (!dot) return;
    dot.className = 'dot' + (state === 'off' ? ' off' : state === 'slow' ? ' slow' : '');
    label.textContent = state === 'off' ? 'Offline' : state === 'slow' ? 'Slow' : 'Online';
  }
  async function api(path, opts = {}, timeoutMs = 25000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(path, {
        credentials: 'same-origin',
        ...opts,
        signal: ctl.signal,
        headers: opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json', ...(opts.headers || {}) } : opts.headers,
      });
      setNet(Date.now() - started > 6000 ? 'slow' : 'ok');
      if (res.status === 401) { showLogin(); throw Object.assign(new Error('signed out'), { status: 401 }); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
      return data;
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof TypeError) { setNet('off'); throw Object.assign(new Error('No connection'), { offline: true }); }
      throw e;
    } finally { clearTimeout(t); }
  }
  // retry with backoff for things that must get through
  async function persist(fn, tries = 8) {
    let delay = 1500;
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!e.offline && e.status && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
        if (i >= tries) throw e;
        await sleep(delay); delay = Math.min(delay * 2, 30000);
      }
    }
  }
  window.addEventListener('online', () => { setNet('ok'); flushOutbox(); kick(); });
  window.addEventListener('offline', () => setNet('off'));

  function toast(text, ms = 2600) {
    const t = $('#toast'); t.textContent = text; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ------------------------------------------------------------------ login
  function showLogin() {
    $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
    const email = store.get('email', '');
    $('#login-email').value = email;
    stopSync();
  }
  $('#have-code').onclick = (e) => { e.preventDefault(); const em = $('#login-email').value.trim(); if (!em) { $('#login-err').textContent = 'Type your e-mail first.'; return; } store.set('email', em); $('#code-to').textContent = em; $('#step-email').classList.add('hidden'); $('#step-code').classList.remove('hidden'); };
  $('#back-email').onclick = (e) => { e.preventDefault(); $('#step-code').classList.add('hidden'); $('#step-email').classList.remove('hidden'); };
  $('#btn-send-code').onclick = async () => {
    const email = $('#login-email').value.trim();
    if (!email) return;
    $('#login-err').textContent = ''; $('#btn-send-code').disabled = true;
    try {
      await persist(() => api('/api/login/start', { method: 'POST', body: JSON.stringify({ email }) }), 4);
      store.set('email', email); $('#code-to').textContent = email;
      $('#step-email').classList.add('hidden'); $('#step-code').classList.remove('hidden'); $('#login-code').focus();
    } catch (e) { $('#login-err').textContent = e.offline ? 'No connection. Try again when you have signal.' : e.message; }
    $('#btn-send-code').disabled = false;
  };
  $('#btn-verify').onclick = async () => {
    const email = store.get('email', $('#login-email').value.trim());
    const code = $('#login-code').value.trim();
    $('#login-err').textContent = ''; $('#btn-verify').disabled = true;
    try {
      await persist(() => api('/api/login/verify', { method: 'POST', body: JSON.stringify({ email, code }) }), 4);
      await boot();
    } catch (e) { $('#login-err').textContent = e.offline ? 'No connection. Try again when you have signal.' : e.message; }
    $('#btn-verify').disabled = false;
  };

  // ------------------------------------------------------------------ state
  const S = {
    me: null,
    threadId: store.get('thread', null),
    lastId: {},                      // thread -> last message id seen
    msgs: store.get('msgs', {}),     // thread -> cached messages (offline reading)
    busy: false,
    attach: [],                      // {local, media_id, status, progress, previewUrl, kind}
    tab: 'chat',
  };

  async function boot() {
    try {
      S.me = await api('/api/me');
    } catch (e) {
      if (e.status === 401) return;
      if (e.offline && store.get('me', null)) S.me = store.get('me', null); // open cached app offline
      else { showLogin(); return; }
    }
    store.set('me', S.me);
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    renderBudget(S.me.budget);
    await loadThreads();
    renderMessages();
    api('/api/media').then((r) => r.media.forEach((m) => (S.mediaKinds[m.id] = m.kind))).catch(() => {});
    startSync();
    flushOutbox();
  }

  function renderBudget(b) {
    if (!b) return;
    $('#budget-pill').textContent = `£${b.left_gbp.toFixed(2)} left`;
  }

  // ------------------------------------------------------------------ threads
  async function loadThreads() {
    let threads = store.get('threads', []);
    try { threads = (await api('/api/threads')).threads; store.set('threads', threads); } catch {}
    if (!threads.length) {
      try { const t = (await api('/api/threads', { method: 'POST' })).thread; threads = [t]; store.set('threads', threads); } catch {}
    }
    if (!S.threadId || !threads.some((t) => t.id === S.threadId)) S.threadId = threads[0]?.id || null;
    store.set('thread', S.threadId);
    $('#thread-select').innerHTML = threads.map((t) => `<option value="${t.id}"${t.id === S.threadId ? ' selected' : ''}>${esc(t.title)}</option>`).join('');
  }
  $('#thread-select').onchange = (e) => { S.threadId = parseInt(e.target.value, 10); store.set('thread', S.threadId); renderMessages(); kick(); };
  $('#btn-new-thread').onclick = async () => {
    try {
      const t = (await api('/api/threads', { method: 'POST' })).thread;
      S.threadId = t.id; store.set('thread', t.id); await loadThreads(); renderMessages();
      toast('New conversation');
    } catch { toast('No connection. Try again.'); }
  };

  // ------------------------------------------------------------------ messages
  function mdLite(s) {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const lines = h.split('\n'); let out = ''; let list = null;
    for (const line of lines) {
      const li = line.match(/^\s*(?:[-•]|\d+[.)])\s+(.*)$/);
      if (li) { if (!list) { list = /^\s*\d/.test(line) ? 'ol' : 'ul'; out += `<${list}>`; } out += `<li>${li[1]}</li>`; continue; }
      if (list) { out += `</${list}>`; list = null; }
      if (/^#{1,4}\s/.test(line)) { out += `<p><b>${line.replace(/^#{1,4}\s/, '')}</b></p>`; continue; }
      if (line.trim()) out += `<p>${line}</p>`;
    }
    if (list) out += `</${list}>`;
    return out;
  }
  function thumbs(ids) {
    if (!ids || !ids.length) return '';
    return `<div class="thumbs">${ids.map((id) => `<img loading="lazy" src="/media/${encodeURIComponent(id)}/preview" data-media="${esc(id)}" alt="">`).join('')}</div>`;
  }
  function renderMessages() {
    const box = $('#messages');
    const list = (S.msgs[S.threadId] || []);
    const pending = store.get('outbox', []).filter((o) => o.thread_id === S.threadId && !list.some((m) => m.client_id === o.client_id));
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let html = list.map((m) => `<div class="m ${m.kind}">${m.kind === 'user' ? thumbs(m.media_ids) : ''}${m.kind === 'note' ? esc(m.body) : mdLite(m.body || '')}</div>`).join('');
    html += pending.map((o) => `<div class="m user pending">${thumbs(o.media_ids)}${mdLite(o.body || '')}<div class="meta">${o.failed ? 'Not sent - will retry' : 'Sending…'}</div></div>`).join('');
    if (S.busy) html += '<div class="typing">PERDIMI Studio is thinking…</div>';
    if (!html) html = '<div class="empty">Ask anything about PERDIMI posts, ideas or the website.<br>Attach photos or videos with +.</div>';
    box.innerHTML = html;
    if (atBottom || pending.length) box.scrollTop = box.scrollHeight;
  }
  $('#messages').addEventListener('click', (e) => { const id = e.target?.dataset?.media; if (id) openViewer(id); });

  // ------------------------------------------------------------------ sync loop
  let syncTimer = null, syncing = false, failCount = 0;
  function startSync() { stopSync(); tick(); }
  function stopSync() { clearTimeout(syncTimer); syncTimer = null; }
  function kick() { clearTimeout(syncTimer); syncTimer = setTimeout(tick, 50); }
  async function tick() {
    if (syncing || !S.threadId) { syncTimer = setTimeout(tick, 3000); return; }
    syncing = true;
    try {
      const thread = S.threadId;
      const cached = S.msgs[thread] || [];
      const after = cached.length ? cached[cached.length - 1].id : 0;
      const r = await api(`/api/sync?thread=${thread}&after=${after}`);
      if (thread === S.threadId) {
        if (r.messages.length) {
          S.msgs[thread] = cached.concat(r.messages).slice(-300);
          store.set('msgs', S.msgs);
          if (r.messages.some((m) => m.kind === 'note')) refreshBudget();
        }
        const changed = r.messages.length || S.busy !== r.busy;
        S.busy = r.busy;
        if (changed) renderMessages();
      }
      failCount = 0;
    } catch { failCount++; }
    syncing = false;
    const hidden = document.visibilityState === 'hidden';
    const delay = hidden ? 60000 : failCount ? Math.min(30000, 3000 * 2 ** Math.min(failCount, 4)) : S.busy ? 2500 : 7000;
    syncTimer = setTimeout(tick, delay);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { kick(); flushOutbox(); } });
  async function refreshBudget() { try { S.me = await api('/api/me'); store.set('me', S.me); renderBudget(S.me.budget); } catch {} }

  // ------------------------------------------------------------------ outbox
  let flushing = false;
  async function flushOutbox() {
    if (flushing) return; flushing = true;
    try {
      for (;;) {
        const box = store.get('outbox', []);
        const next = box[0];
        if (!next) break;
        try {
          await api('/api/messages', { method: 'POST', body: JSON.stringify(next) });
          store.set('outbox', store.get('outbox', []).filter((o) => o.client_id !== next.client_id));
          S.busy = true; kick();
        } catch (e) {
          if (e.status && e.status < 500 && !e.offline) { // will never succeed: drop it and say so
            store.set('outbox', store.get('outbox', []).filter((o) => o.client_id !== next.client_id));
            toast('A message could not be sent: ' + e.message, 5000);
          } else {
            next.failed = true; const b = store.get('outbox', []); if (b[0]) { b[0].failed = true; store.set('outbox', b); }
            renderMessages();
            setTimeout(flushOutbox, 8000);
            break;
          }
        }
      }
    } finally { flushing = false; renderMessages(); }
  }

  const input = $('#input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; store.set('draft', input.value); });
  input.value = store.get('draft', '');
  $('#btn-send').onclick = send;
  async function send() {
    const body = input.value.trim();
    if (S.attach.some((a) => a.status !== 'done')) { toast('Still uploading - it will send when ready.'); waitThenSend(); return; }
    const media = S.attach.map((a) => a.media_id);
    if (!body && !media.length) return;
    const msg = { client_id: uid(), thread_id: S.threadId, body, media_ids: media };
    store.set('outbox', store.get('outbox', []).concat(msg));
    input.value = ''; store.set('draft', ''); input.style.height = 'auto';
    S.attach = []; renderAttach();
    renderMessages(); flushOutbox();
  }
  let waiting = false;
  async function waitThenSend() {
    if (waiting) return; waiting = true;
    while (S.attach.some((a) => a.status === 'uploading' || a.status === 'queued')) await sleep(800);
    waiting = false;
    if (S.attach.some((a) => a.status === 'error')) { toast('An upload failed. Remove it or try again.'); return; }
    send();
  }

  // ------------------------------------------------------------------ uploads
  $('#file').onchange = (e) => { for (const f of e.target.files) addFile(f); e.target.value = ''; };
  function renderAttach() {
    $('#attachments').innerHTML = S.attach.map((a, i) => `<div class="chip">${a.previewUrl ? `<img src="${a.previewUrl}" alt="">` : esc(a.kind)}${a.status !== 'done' ? `<span class="bar" style="width:${Math.round((a.progress || 0) * 100)}%"></span>` : ''}${a.status === 'error' ? '<span style="position:absolute;color:var(--bad)">!</span>' : ''}<button class="x" data-i="${i}">×</button></div>`).join('');
  }
  $('#attachments').addEventListener('click', (e) => { if (e.target.classList.contains('x')) { S.attach.splice(+e.target.dataset.i, 1); renderAttach(); } });

  async function shrinkImage(file, maxSide, quality) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch {
      bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    }
    const w = bmp.width, h = bmp.height, s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  }
  async function videoPoster(file) {
    return new Promise((resolve) => {
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'metadata';
      const done = (blob) => { URL.revokeObjectURL(v.src); resolve(blob); };
      const timer = setTimeout(() => done(null), 8000);
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { clearTimeout(timer); done(null); } };
      v.onseeked = () => {
        try {
          const s = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement('canvas'); c.width = v.videoWidth * s; c.height = v.videoHeight * s;
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.toBlob((b) => { clearTimeout(timer); done(b); }, 'image/jpeg', 0.7);
        } catch { clearTimeout(timer); done(null); }
      };
      v.onerror = () => { clearTimeout(timer); done(null); };
      v.src = URL.createObjectURL(file);
    });
  }
  function putBlob(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open('PUT', url); x.withCredentials = true; x.timeout = 120000;
      if (blob.type) x.setRequestHeader('content-type', blob.type);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => x.status < 300 ? resolve(JSON.parse(x.responseText || '{}')) : reject(Object.assign(new Error('upload ' + x.status), { status: x.status }));
      x.onerror = x.ontimeout = () => reject(Object.assign(new Error('No connection'), { offline: true }));
      x.send(blob);
    });
  }
  async function addFile(file) {
    const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : 'file';
    const a = { kind, status: 'queued', progress: 0 };
    S.attach.push(a); renderAttach();
    try {
      a.status = 'uploading';
      let full = file, preview = null;
      if (kind === 'image') {
        full = await shrinkImage(file, 1600, 0.82);   // ~300-600 KB instead of 3-5 MB
        preview = await shrinkImage(file, 512, 0.7);  // ~40 KB
      } else if (kind === 'video') {
        preview = await videoPoster(file);
      }
      if (preview) a.previewUrl = URL.createObjectURL(preview);
      renderAttach();
      const { id } = await persist(() => api('/api/media', { method: 'POST', body: JSON.stringify({ kind, mime: full.type || file.type, bytes: full.size, name: file.name }) }));
      a.media_id = id;
      if (preview) await persist(() => putBlob(`/api/media/${id}/preview`, preview));
      if (full.size <= 18 * 1024 * 1024) {
        await persist(() => putBlob(`/api/media/${id}/full`, full, (p) => { a.progress = p; renderAttach(); }));
      } else {
        const CH = 6 * 1024 * 1024; // R2 parts must be >= 5 MB except the last
        const { upload_id } = await persist(() => api(`/api/media/${id}/chunks`, { method: 'POST' }));
        const parts = []; const n = Math.ceil(full.size / CH);
        for (let i = 0; i < n; i++) {
          const blob = full.slice(i * CH, Math.min(full.size, (i + 1) * CH));
          const r = await persist(() => putBlob(`/api/media/${id}/chunks/${i + 1}?upload_id=${encodeURIComponent(upload_id)}`, blob, (p) => { a.progress = (i + p) / n; renderAttach(); }), 12);
          parts.push(r.part);
        }
        await persist(() => api(`/api/media/${id}/chunks/complete`, { method: 'POST', body: JSON.stringify({ upload_id, parts }) }));
      }
      a.status = 'done'; a.progress = 1;
    } catch (e) {
      a.status = 'error'; toast('Upload failed: ' + e.message, 4000);
    }
    renderAttach();
  }

  // ------------------------------------------------------------------ viewer
  let viewing = null;
  async function openViewer(id) {
    viewing = id;
    $('#vbody').innerHTML = `<img src="/media/${encodeURIComponent(id)}/preview" alt="">`;
    $('#v-dl').href = `/media/${encodeURIComponent(id)}/full?download=1`;
    $('#viewer').classList.remove('hidden');
  }
  $('#v-full').onclick = () => {
    if (!viewing) return;
    const src = `/media/${encodeURIComponent(viewing)}/full`;
    const isVideo = (S.mediaKinds || {})[viewing] === 'video';
    $('#vbody').innerHTML = isVideo ? `<video src="${src}" controls playsinline autoplay></video>` : `<img src="${src}" alt="">`;
  };
  $('#v-close').onclick = () => { $('#viewer').classList.add('hidden'); $('#vbody').innerHTML = ''; viewing = null; };

  // ------------------------------------------------------------------ tabs
  $$('nav button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  function showTab(tab) {
    S.tab = tab;
    $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + tab));
    if (tab === 'studio') loadStudio();
    if (tab === 'post') loadPosts();
    if (tab === 'site') loadSite();
    if (tab === 'more') loadMore();
  }

  const STATUS = {
    estimating: ['Checking cost', 'warn'], approved: ['Queued', 'warn'], running: ['Rendering', 'warn'],
    awaiting_owner: ['Waiting for Fred', 'warn'], done: ['Ready', 'ok'], failed: ['Failed (free)', 'bad'],
    rejected: ['Fred said no', 'bad'], cancelled: ['Cancelled', ''],
  };
  S.mediaKinds = {};

  async function loadStudio() {
    const v = $('#view-studio');
    v.innerHTML = '<div class="empty">Loading…</div>';
    let r, media;
    try { [r, media] = await Promise.all([api('/api/renders'), api('/api/media')]); }
    catch { v.innerHTML = '<div class="empty">No connection. Pull down later to retry.</div>'; return; }
    media.media.forEach((m) => (S.mediaKinds[m.id] = m.kind));
    const b = r.budget; renderBudget(b);
    const pct = Math.min(100, (b.spent_gbp / b.budget_gbp) * 100 || 0);
    let html = `<h2>Render allowance · this month</h2><div class="card">
      <div class="top"><span>£${b.spent_gbp.toFixed(2)} of £${b.budget_gbp.toFixed(2)}</span><b>£${b.left_gbp.toFixed(2)} left</b></div>
      <div class="meter"><i style="width:${pct}%"></i></div>
      <div class="sub">Spent on discarded renders: £${b.discarded_gbp.toFixed(2)}${b.final_without_draft_gbp ? ` · finals without a draft: £${b.final_without_draft_gbp.toFixed(2)}` : ''}</div>
      ${!b.gbp_per_credit_known ? '<div class="sub" style="margin-top:6px;color:var(--warn)">Credit price not set yet: every render waits for Fred.</div>' : ''}
      ${b.renders_paused ? '<div class="sub" style="margin-top:6px;color:var(--warn)">Renders are paused by Fred.</div>' : ''}
      <div class="sub" style="margin-top:6px">Rule: cheap draft first, then make the kept one final.</div></div>`;
    html += '<h2>Renders</h2>';
    if (!r.renders.length) html += '<div class="empty">No renders yet. Ask in Chat, e.g. "draft an image of…"</div>';
    for (const x of r.renders) {
      const [label, cls] = STATUS[x.status] || [x.status, ''];
      const cost = x.actual_gbp != null ? `£${x.actual_gbp.toFixed(2)}` : x.est_gbp != null ? `~£${x.est_gbp.toFixed(2)}` : x.est_credits ? `~${x.est_credits} cr` : '';
      const mediaHtml = x.result_media_id
        ? `<img class="media" loading="lazy" src="/media/${encodeURIComponent(x.result_media_id)}/preview" data-media="${esc(x.result_media_id)}" alt="">`
        : '';
      html += `<div class="card" data-id="${x.id}">
        <div class="top"><span>#${x.id} · ${x.kind} · <b>${x.quality}</b>${x.parent_id ? ` (from #${x.parent_id})` : ''}</span><span class="tag ${cls}">${label}</span></div>
        ${mediaHtml}
        <div class="sub" style="margin-top:8px">${esc(x.prompt.slice(0, 180))}${x.prompt.length > 180 ? '…' : ''}</div>
        <div class="sub">${cost}${x.hold_reason ? ' · ' + esc(x.hold_reason) : ''}${x.error ? ' · ' + esc(x.error) : ''}${x.verdict ? ' · ' + (x.verdict === 'keep' ? 'Kept' : 'Discarded') : ''}</div>
        <div class="actions">
          ${x.status === 'done' && x.verdict !== 'keep' ? '<button class="btn small" data-act="keep">Keep</button>' : ''}
          ${x.status === 'done' && x.verdict !== 'discard' ? '<button class="btn small" data-act="discard">Discard</button>' : ''}
          ${x.status === 'done' && x.quality === 'draft' ? '<button class="btn small primary" data-act="final">Make final (HD)</button>' : ''}
          ${['estimating', 'approved', 'awaiting_owner'].includes(x.status) ? '<button class="btn small" data-act="cancel">Cancel</button>' : ''}
          ${x.result_media_id ? `<a class="btn small" href="/media/${encodeURIComponent(x.result_media_id)}/full?download=1">Save</a>` : ''}
        </div></div>`;
    }
    const uploads = media.media.filter((m) => m.source === 'upload' && m.has_preview);
    if (uploads.length) {
      html += '<h2>Uploads</h2><div class="grid">' + uploads.map((m) => `<img loading="lazy" src="/media/${encodeURIComponent(m.id)}/preview" data-media="${esc(m.id)}" alt="">`).join('') + '</div>';
    }
    v.innerHTML = html;
  }
  $('#view-studio').addEventListener('click', async (e) => {
    const id = e.target?.dataset?.media; if (id) return openViewer(id);
    const act = e.target?.dataset?.act; if (!act) return;
    const rid = e.target.closest('.card').dataset.id;
    try {
      if (act === 'keep' || act === 'discard') await api(`/api/renders/${rid}/verdict`, { method: 'POST', body: JSON.stringify({ verdict: act }) });
      if (act === 'final') {
        if (!confirm('Make this draft final in high quality? This costs more credits (a video final is about 4x a draft).')) return;
        const r = await api(`/api/renders/${rid}/final`, { method: 'POST' });
        toast(`Final #${r.id} requested. Cost is checked before it runs.`);
      }
      if (act === 'cancel') await api(`/api/renders/${rid}/cancel`, { method: 'POST' });
      loadStudio();
    } catch (err) { toast(err.message); }
  });

  async function loadPosts() {
    const v = $('#view-post');
    v.innerHTML = '<div class="empty">Loading…</div>';
    let r; try { r = await api('/api/posts'); } catch { v.innerHTML = '<div class="empty">No connection.</div>'; return; }
    const ready = r.posts.filter((p) => p.status === 'ready'), done = r.posts.filter((p) => p.status !== 'ready');
    const app = { instagram: 'https://www.instagram.com/', facebook: 'https://www.facebook.com/', tiktok: 'https://www.tiktok.com/', threads: 'https://www.threads.net/' };
    const card = (p) => `<div class="card" data-id="${p.id}">
      <div class="top"><span><b>${esc(p.platform)}</b> · #${p.id}</span><span class="tag ${p.status === 'posted' ? 'ok' : ''}">${p.status}</span></div>
      <div class="thumbs">${p.media_ids.map((id) => `<img loading="lazy" src="/media/${encodeURIComponent(id)}/preview" data-media="${esc(id)}" alt="">`).join('')}</div>
      <div class="caption">${esc(p.caption)}</div>
      <div class="actions">
        <button class="btn small" data-act="copy">Copy caption</button>
        ${p.media_ids.map((id, i) => `<a class="btn small" href="/media/${encodeURIComponent(id)}/full?download=1">Save ${p.media_ids.length > 1 ? i + 1 : 'media'}</a>`).join('')}
        ${p.status === 'ready' ? `<a class="btn small" href="${app[p.platform]}" target="_blank" rel="noopener">Open ${esc(p.platform)}</a><button class="btn small primary" data-act="posted">Mark posted</button><button class="btn small" data-act="dropped">Drop</button>` : ''}
        ${p.url ? `<a class="btn small" href="${esc(p.url)}" target="_blank" rel="noopener">View post</a>` : ''}
      </div></div>`;
    v.innerHTML = `<h2>Ready to post</h2>${ready.length ? ready.map(card).join('') : '<div class="empty">Nothing ready. Ask in Chat: "prepare this for Instagram".</div>'}
      ${done.length ? '<h2>Posted</h2>' + done.map(card).join('') : ''}
      <div class="sub" style="padding:6px 2px">How to post: Save the media to Photos, Copy caption, open the app, paste. Then Mark posted and paste the post link.</div>`;
    v._posts = r.posts;
  }
  $('#view-post').addEventListener('click', async (e) => {
    const id = e.target?.dataset?.media; if (id) return openViewer(id);
    const act = e.target?.dataset?.act; if (!act) return;
    const pid = +e.target.closest('.card').dataset.id;
    const post = ($('#view-post')._posts || []).find((p) => p.id === pid);
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(post.caption); toast('Caption copied'); }
      catch { const t = document.createElement('textarea'); t.value = post.caption; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast('Caption copied'); }
      return;
    }
    let url = null;
    if (act === 'posted') { url = prompt('Paste the link to the post (optional):') || null; }
    try { await api(`/api/posts/${pid}`, { method: 'POST', body: JSON.stringify({ status: act, url }) }); loadPosts(); } catch (err) { toast(err.message); }
  });

  async function loadSite() {
    const v = $('#view-site');
    v.innerHTML = `<h2>Website ideas</h2>
      <div class="card"><div class="sub" style="margin-bottom:8px">Suggest anything for perdimi.com. Nothing goes live until Fred approves it.</div>
      <input class="field" id="sg-title" placeholder="Short title">
      <input class="field" id="sg-page" placeholder="Which page (optional)" style="margin-top:8px">
      <textarea class="field" id="sg-detail" placeholder="What should change and why?" style="margin-top:8px"></textarea>
      <button class="btn primary" id="sg-send" style="margin-top:8px;width:100%">Send to Fred</button></div><div id="sg-list"><div class="empty">Loading…</div></div>`;
    $('#sg-detail').value = store.get('sg-draft', '');
    $('#sg-detail').oninput = (e) => store.set('sg-draft', e.target.value);
    $('#sg-send').onclick = async () => {
      const body = { title: $('#sg-title').value.trim(), page: $('#sg-page').value.trim(), detail: $('#sg-detail').value.trim() };
      if (!body.title || !body.detail) return toast('Add a title and what should change.');
      try { await persist(() => api('/api/suggestions', { method: 'POST', body: JSON.stringify(body) }), 4); store.set('sg-draft', ''); toast('Sent to Fred'); loadSite(); }
      catch (e) { toast(e.offline ? 'No connection - your text is saved, try again.' : e.message); }
    };
    try {
      const r = await api('/api/suggestions');
      const tag = { pending: ['Waiting for Fred', 'warn'], approved: ['Approved', 'ok'], rejected: ['Not now', 'bad'] };
      $('#sg-list').innerHTML = r.suggestions.length ? r.suggestions.map((s) => `<div class="card"><div class="top"><b>${esc(s.title)}</b><span class="tag ${tag[s.status][1]}">${tag[s.status][0]}</span></div>
        <div class="sub">${esc(s.page || '')}</div><div style="font-size:14px;margin-top:6px;white-space:pre-wrap">${esc(s.detail)}</div>
        ${s.owner_note ? `<div class="caption">Fred: ${esc(s.owner_note)}</div>` : ''}</div>`).join('') : '<div class="empty">No ideas sent yet.</div>';
    } catch { $('#sg-list').innerHTML = '<div class="empty">No connection.</div>'; }
  }

  async function loadMore() {
    const v = $('#view-more');
    const links = (S.me && S.me.links) || [];
    v.innerHTML = `<h2>Resources</h2><div class="card list">${links.length ? links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('') : '<div class="sub">Fred has not added links yet.</div>'}</div>
      <h2>Team requests</h2><div id="tasks"><div class="empty">Loading…</div></div>
      <h2>App</h2><div class="card">
        <div class="sub">Install: in Safari tap Share, then "Add to Home Screen". The app then opens full screen and remembers you.</div>
        <div class="actions"><button class="btn small" id="btn-refresh">Reload app</button><button class="btn small" id="btn-logout">Sign out</button></div></div>`;
    $('#btn-refresh').onclick = () => location.reload();
    $('#btn-logout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); } catch {} localStorage.clear(); showLogin(); };
    try {
      const r = await api('/api/tasks');
      const team = { seo: 'SEO team', marketing: 'Marketing', creative_director: 'Creative director', film_crew: 'Film crew', fred: 'Fred' };
      $('#tasks').innerHTML = r.tasks.length ? r.tasks.map((t) => `<div class="card"><div class="top"><b>${esc(t.title)}</b><span class="tag ${t.done_at ? 'ok' : ''}">${t.done_at ? 'Done' : esc(team[t.team] || t.team)}</span></div>
        ${t.detail ? `<div class="sub">${esc(t.detail)}</div>` : ''}${t.reply ? `<div class="caption">${esc(t.reply)}</div>` : ''}</div>`).join('') : '<div class="empty">Ask in Chat to brief the SEO team, marketing, the creative director or the film crew.</div>';
    } catch { $('#tasks').innerHTML = '<div class="empty">No connection.</div>'; }
  }

  // ------------------------------------------------------------------ start
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  boot();
})();
