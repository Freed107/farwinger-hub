// perdimi-creator-portal - Worker entry: HTTP routes, queue consumer, cron.
import {
  json, err, sha256, randomId, sixDigits, safeEqual, isoIn, audit, ensurePeople, createSession,
  currentPerson, readCookie, SESSION_COOKIE, budgetStatus, getSetting, setSetting, parseJsonArray,
} from './lib.js';
import { answerThread } from './claude.js';
import { createRender, applyEstimate, notifyThread, renderView } from './renders.js';

const MAX_SIMPLE_UPLOAD = 20 * 1024 * 1024; // images, previews, short clips in one request
const route = (method, pattern) => ({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      console.error(e);
      return err(500, 'Something went wrong. Try again.');
    }
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      await answerThread(env, msg.body.thread_id); // throws -> queue retries
      msg.ack();
    }
  },

  // Safety net: any thread stuck "busy" (crash, outage) or with an unanswered message gets re-queued.
  async scheduled(_event, env) {
    const { results } = await env.DB.prepare(
      `SELECT t.id FROM threads t
       WHERE (t.busy = 1 AND t.updated_at < datetime('now','-4 minutes'))
          OR (t.busy = 0 AND (SELECT kind FROM messages m WHERE m.thread_id = t.id AND m.kind IN ('user','api') ORDER BY m.id DESC LIMIT 1) = 'user'
              AND t.updated_at < datetime('now','-2 minutes'))`
    ).all();
    for (const t of results) {
      await env.DB.prepare(`UPDATE threads SET busy = 1, updated_at = datetime('now') WHERE id = ?`).bind(t.id).run();
      await env.CHAT_QUEUE.send({ thread_id: t.id });
    }
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') return json({ ok: true });

  // ---- runner + pull API (bearer token, no session) ----
  if (path.startsWith('/api/runner/') || path === '/api/pull/tasks') {
    const auth = request.headers.get('authorization') || '';
    if (!env.RUNNER_TOKEN || !safeEqual(auth, `Bearer ${env.RUNNER_TOKEN}`)) return err(401, 'unauthorised');
    return runnerApi(request, env, url);
  }

  // ---- sign-in ----
  if (path === '/api/login/start' && method === 'POST') return loginStart(request, env);
  if (path === '/api/login/verify' && method === 'POST') return loginVerify(request, env);

  if (path === '/admin.html') return Response.redirect(new URL('/admin', url), 302);

  // ---- static app shell (the login screen is part of it) ----
  if (!path.startsWith('/api/') && !path.startsWith('/media/') && path !== '/admin') {
    return env.ASSETS.fetch(request);
  }

  const person = await currentPerson(env, request);
  if (!person) {
    if (path === '/admin') return Response.redirect(new URL('/', url), 302);
    return err(401, 'signed out');
  }

  if (path === '/admin') {
    if (person.role !== 'owner') return Response.redirect(new URL('/', url), 302);
    return env.ASSETS.fetch(new Request(new URL('/admin.html', url), request));
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (path.startsWith('/media/')) return serveMedia(request, env, person, path);
  if (path.startsWith('/api/admin/')) {
    if (person.role !== 'owner') return err(403, 'owner only');
    return adminApi(request, env, url, person);
  }
  return appApi(request, env, url, person, ctx);
}

// ================================================================== sign-in

async function loginStart(request, env) {
  await ensurePeople(env);
  const { email } = await request.json().catch(() => ({}));
  const addr = String(email || '').trim().toLowerCase();
  const person = await env.DB.prepare('SELECT * FROM people WHERE email = ? AND revoked_at IS NULL').bind(addr).first();
  // Same answer whether or not the address is allowed: the page never reveals who has access.
  if (person) {
    const code = sixDigits();
    await env.DB.prepare(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`
    ).bind(addr, await sha256(addr + ':' + code), isoIn(30 * 60e3)).run();
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [addr],
          subject: `PERDIMI Studio code: ${code}`,
          text: `Your PERDIMI Studio sign-in code is ${code}\n\nIt works for 30 minutes. Type it into the studio app.\nIf you did not ask for it, ignore this e-mail.`,
        }),
      });
      if (!r.ok) await audit(env, person.id, 'login.mail_failed', `${r.status}`);
    }
    await audit(env, person.id, 'login.code_sent', null);
  }
  return json({ ok: true });
}

async function loginVerify(request, env) {
  const { email, code } = await request.json().catch(() => ({}));
  const addr = String(email || '').trim().toLowerCase();
  const c = String(code || '').replace(/\D/g, '');
  const row = await env.DB.prepare(`SELECT * FROM login_codes WHERE email = ? AND expires_at > datetime('now')`).bind(addr).first();
  if (!row || row.attempts >= 6) return err(400, 'That code has expired. Ask for a new one.');
  if (row.code_hash !== (await sha256(addr + ':' + c))) {
    await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(addr).run();
    return err(400, 'Wrong code. Check the e-mail and try again.');
  }
  const person = await env.DB.prepare('SELECT * FROM people WHERE email = ? AND revoked_at IS NULL').bind(addr).first();
  if (!person) return err(400, 'This address no longer has access.');
  await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(addr).run();
  const { cookie } = await createSession(env, person.id);
  await audit(env, person.id, 'login.ok', null);
  return json({ ok: true, role: person.role }, 200, { 'set-cookie': cookie });
}

// ================================================================== app API (signed in)

async function appApi(request, env, url, person, ctx) {
  const path = url.pathname;
  const method = request.method;
  const m = (r) => { const x = r.re.exec(path); return x && method === r.method ? (x.groups || {}) : null; };
  let p;

  if (path === '/api/me' && method === 'GET') {
    return json({
      name: person.name, role: person.role,
      budget: await budgetStatus(env, person.id),
      links: JSON.parse(await getSetting(env, 'links', '[]')),
    });
  }

  // ---- threads + messages ----
  if (path === '/api/threads' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, title, updated_at, busy FROM threads WHERE person_id = ? ORDER BY updated_at DESC LIMIT 50')
      .bind(person.id).all();
    return json({ threads: results });
  }
  if (path === '/api/threads' && method === 'POST') {
    const t = await env.DB.prepare(`INSERT INTO threads (person_id) VALUES (?) RETURNING id, title, updated_at, busy`).bind(person.id).first();
    return json({ thread: t });
  }

  if (path === '/api/sync' && method === 'GET') {
    const threadId = parseInt(url.searchParams.get('thread') || '0', 10);
    const after = parseInt(url.searchParams.get('after') || '0', 10);
    const thread = await ownThread(env, person, threadId);
    if (!thread) return err(404, 'no such conversation');
    const { results } = await env.DB.prepare(
      `SELECT id, client_id, kind, body, media_ids, created_at FROM messages
       WHERE thread_id = ? AND id > ? AND kind IN ('user','assistant','note') ORDER BY id LIMIT 200`
    ).bind(threadId, after).all();
    return json({ messages: results.map((r) => ({ ...r, media_ids: parseJsonArray(r.media_ids) })), busy: !!thread.busy });
  }

  if (path === '/api/messages' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const thread = await ownThread(env, person, parseInt(b.thread_id, 10));
    if (!thread) return err(404, 'no such conversation');
    const body = String(b.body || '').slice(0, 20000);
    const media = parseJsonArray(JSON.stringify(b.media_ids || [])).slice(0, 8).map(String);
    if (!body.trim() && !media.length) return err(400, 'empty message');
    const clientId = String(b.client_id || randomId(8)).slice(0, 64);
    const ins = await env.DB.prepare(
      `INSERT INTO messages (client_id, thread_id, kind, body, media_ids) VALUES (?, ?, 'user', ?, ?)
       ON CONFLICT(client_id) DO NOTHING RETURNING id`
    ).bind(clientId, thread.id, body, JSON.stringify(media)).first();
    if (ins) {
      // first message names the conversation
      if (thread.title === 'New conversation' && body.trim())
        await env.DB.prepare('UPDATE threads SET title = ? WHERE id = ?').bind(body.trim().slice(0, 60), thread.id).run();
      await env.DB.prepare(`UPDATE threads SET busy = 1, updated_at = datetime('now') WHERE id = ?`).bind(thread.id).run();
      ctx.waitUntil(env.CHAT_QUEUE.send({ thread_id: thread.id }));
      return json({ ok: true, id: ins.id });
    }
    const existing = await env.DB.prepare('SELECT id FROM messages WHERE client_id = ?').bind(clientId).first();
    return json({ ok: true, id: existing?.id, duplicate: true }); // resend from a flaky line: already have it
  }

  // ---- uploads (from her phone) ----
  if (path === '/api/media' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const kind = ['image', 'video'].includes(b.kind) ? b.kind : 'file';
    const id = randomId(12);
    const ext = (String(b.name || '').match(/\.(\w{1,5})$/) || [, kind === 'video' ? 'mp4' : 'jpg'])[1].toLowerCase();
    await env.DB.prepare(
      `INSERT INTO media (id, kind, mime, r2_key, bytes, source, uploaded_by, caption) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)`
    ).bind(id, kind, String(b.mime || 'application/octet-stream').slice(0, 100), `u/${id}/full.${ext}`,
      parseInt(b.bytes || 0, 10) || null, person.id, b.caption ? String(b.caption).slice(0, 500) : null).run();
    return json({ id });
  }
  if ((p = m(route('PUT', '/api/media/:id/:part')))) {
    const media = await ownMedia(env, person, p.id);
    if (!media) return err(404, 'no such upload');
    if (!['full', 'preview'].includes(p.part)) return err(400, 'bad part');
    const len = parseInt(request.headers.get('content-length') || '0', 10);
    if (len > MAX_SIMPLE_UPLOAD) return err(413, 'too big for one request; use chunked upload');
    const key = p.part === 'full' ? media.r2_key : `u/${media.id}/preview.jpg`;
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: p.part === 'full' ? media.mime : 'image/jpeg' } });
    if (p.part === 'preview') await env.DB.prepare('UPDATE media SET preview_key = ? WHERE id = ?').bind(key, media.id).run();
    return json({ ok: true });
  }
  // chunked (videos): create -> parts (retry any part) -> complete
  if ((p = m(route('POST', '/api/media/:id/chunks')))) {
    const media = await ownMedia(env, person, p.id);
    if (!media) return err(404, 'no such upload');
    const up = await env.MEDIA.createMultipartUpload(media.r2_key, { httpMetadata: { contentType: media.mime } });
    return json({ upload_id: up.uploadId });
  }
  if ((p = m(route('PUT', '/api/media/:id/chunks/:n')))) {
    const media = await ownMedia(env, person, p.id);
    if (!media) return err(404, 'no such upload');
    const up = env.MEDIA.resumeMultipartUpload(media.r2_key, url.searchParams.get('upload_id'));
    const part = await up.uploadPart(parseInt(p.n, 10), request.body);
    return json({ part });
  }
  if ((p = m(route('POST', '/api/media/:id/chunks/complete')))) {
    const media = await ownMedia(env, person, p.id);
    if (!media) return err(404, 'no such upload');
    const b = await request.json();
    const up = env.MEDIA.resumeMultipartUpload(media.r2_key, b.upload_id);
    await up.complete(b.parts);
    return json({ ok: true });
  }
  if (path === '/api/media' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, mime, source, quality, render_id, caption, created_at, preview_key IS NOT NULL AS has_preview
       FROM media ORDER BY created_at DESC LIMIT 120`
    ).all();
    return json({ media: results });
  }

  // ---- renders ----
  if (path === '/api/renders' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM renders WHERE requested_by = ? OR ? = \'owner\' ORDER BY id DESC LIMIT 60')
      .bind(person.id, person.role).all();
    return json({ renders: results.map(renderView), budget: await budgetStatus(env, person.id) });
  }
  if ((p = m(route('POST', '/api/renders/:id/verdict')))) {
    const b = await request.json().catch(() => ({}));
    if (!['keep', 'discard'].includes(b.verdict)) return err(400, 'keep or discard');
    const r = await env.DB.prepare(
      `UPDATE renders SET verdict = ?, updated_at = datetime('now') WHERE id = ? AND requested_by = ? AND status = 'done' RETURNING id`
    ).bind(b.verdict, p.id, person.id).first();
    return r ? json({ ok: true }) : err(400, 'Only your finished renders can be marked.');
  }
  if ((p = m(route('POST', '/api/renders/:id/final')))) {
    const draft = await env.DB.prepare('SELECT * FROM renders WHERE id = ? AND requested_by = ?').bind(p.id, person.id).first();
    if (!draft) return err(404, 'no such render');
    const r = await createRender(env, person, {
      kind: draft.kind, quality: 'final', prompt: draft.prompt, aspect: draft.aspect, seconds: draft.seconds,
      ref_media: parseJsonArray(draft.ref_media), parent_id: draft.id, thread_id: draft.thread_id,
    });
    return r.error ? err(400, r.error) : json(r);
  }
  if ((p = m(route('POST', '/api/renders/:id/cancel')))) {
    const r = await env.DB.prepare(
      `UPDATE renders SET status = 'cancelled', updated_at = datetime('now')
       WHERE id = ? AND requested_by = ? AND status IN ('estimating','awaiting_owner','approved') RETURNING id`
    ).bind(p.id, person.id).first();
    return r ? json({ ok: true }) : err(400, 'Too late to cancel: it is already rendering or finished.');
  }

  // ---- posts ----
  if (path === '/api/posts' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT * FROM posts ORDER BY id DESC LIMIT 60`).all();
    return json({ posts: results.map((r) => ({ ...r, media_ids: parseJsonArray(r.media_ids) })) });
  }
  if ((p = m(route('POST', '/api/posts/:id')))) {
    const b = await request.json().catch(() => ({}));
    if (!['posted', 'dropped', 'ready'].includes(b.status)) return err(400, 'bad status');
    await env.DB.prepare(
      `UPDATE posts SET status = ?, url = COALESCE(?, url), posted_at = CASE WHEN ? = 'posted' THEN datetime('now') ELSE posted_at END WHERE id = ?`
    ).bind(b.status, b.url ? String(b.url).slice(0, 500) : null, b.status, p.id).run();
    await audit(env, person.id, `post.${b.status}`, `#${p.id} ${b.url || ''}`);
    return json({ ok: true });
  }

  // ---- site ideas + tasks ----
  if (path === '/api/suggestions' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM suggestions ORDER BY id DESC LIMIT 60').all();
    return json({ suggestions: results });
  }
  if (path === '/api/suggestions' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!b.title || !b.detail) return err(400, 'title and detail please');
    const r = await env.DB.prepare(`INSERT INTO suggestions (title, detail, page, media_ids, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id`)
      .bind(String(b.title).slice(0, 200), String(b.detail).slice(0, 8000), b.page || null, JSON.stringify(b.media_ids || []), person.id).first();
    return json({ id: r.id });
  }
  if (path === '/api/tasks' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, team, title, detail, urgency, created_at, done_at, reply FROM tasks ORDER BY id DESC LIMIT 60').all();
    return json({ tasks: results });
  }

  return err(404, 'not found');
}

async function ownThread(env, person, id) {
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM threads WHERE id = ? AND (person_id = ? OR ? = \'owner\')').bind(id, person.id, person.role).first();
}
async function ownMedia(env, person, id) {
  return env.DB.prepare(`SELECT * FROM media WHERE id = ? AND source = 'upload' AND uploaded_by = ?`).bind(id, person.id).first();
}

// Media for any signed-in person. Range requests so iPhone video playback works.
async function serveMedia(request, env, person, path) {
  const [, , id, which = 'preview'] = path.split('/');
  const media = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(id).first();
  if (!media) return err(404, 'not found');
  const key = which === 'full' ? media.r2_key : media.preview_key || media.r2_key;
  const range = request.headers.get('range');
  let obj;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.slice(6).split('-');
    const head = await env.MEDIA.head(key);
    if (!head) return err(404, 'not found');
    const start = s === '' ? Math.max(0, head.size - parseInt(e, 10)) : parseInt(s, 10);
    const end = s === '' || e === '' ? head.size - 1 : Math.min(parseInt(e, 10), head.size - 1);
    obj = await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return err(404, 'not found');
    return new Response(obj.body, {
      status: 206,
      headers: {
        'content-type': obj.httpMetadata?.contentType || media.mime,
        'content-range': `bytes ${start}-${end}/${head.size}`,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  }
  obj = await env.MEDIA.get(key);
  if (!obj) return err(404, 'not found');
  const headers = {
    'content-type': obj.httpMetadata?.contentType || media.mime,
    'content-length': String(obj.size),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
  };
  if (new URL(request.url).searchParams.has('download'))
    headers['content-disposition'] = `attachment; filename="perdimi-${media.id}.${media.r2_key.split('.').pop()}"`;
  return new Response(obj.body, { headers });
}

// ================================================================== admin (Fred)

async function adminApi(request, env, url, person) {
  const path = url.pathname;
  const method = request.method;
  const m = (r) => { const x = r.re.exec(path); return x && method === r.method ? (x.groups || {}) : null; };
  let p;

  if (path === '/api/admin/overview' && method === 'GET') {
    const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
    const creator = await env.DB.prepare(`SELECT id FROM people WHERE role = 'creator' ORDER BY id LIMIT 1`).first();
    return json({
      renders_waiting: (await q(`SELECT * FROM renders WHERE status = 'awaiting_owner' ORDER BY id`)).map(renderView),
      renders_recent: (await q(`SELECT * FROM renders ORDER BY id DESC LIMIT 30`)).map(renderView),
      suggestions: await q(`SELECT * FROM suggestions ORDER BY status = 'pending' DESC, id DESC LIMIT 40`),
      tasks: await q(`SELECT * FROM tasks ORDER BY done_at IS NOT NULL, id DESC LIMIT 40`),
      posts: await q(`SELECT * FROM posts ORDER BY id DESC LIMIT 30`),
      people: await q(`SELECT id, email, name, role, created_at, revoked_at,
                         (SELECT MAX(last_seen) FROM sessions s WHERE s.person_id = people.id) AS last_seen FROM people`),
      knowledge: await q(`SELECT key, length(body) AS chars, updated_at FROM knowledge ORDER BY key`),
      settings: Object.fromEntries((await q(`SELECT key, value FROM settings`)).map((r) => [r.key, r.value])),
      budget: creator ? await budgetStatus(env, creator.id) : null,
      audit: await q(`SELECT * FROM audit ORDER BY id DESC LIMIT 60`),
      whatsapp_ready: !!env.CREATOR_PHONE,
    });
  }

  if ((p = m(route('POST', '/api/admin/renders/:id')))) {
    const b = await request.json().catch(() => ({}));
    const job = await env.DB.prepare('SELECT * FROM renders WHERE id = ?').bind(p.id).first();
    if (!job || job.status !== 'awaiting_owner') return err(400, 'not waiting');
    const status = b.action === 'approve' ? 'approved' : 'rejected';
    await env.DB.prepare(`UPDATE renders SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, job.id).run();
    await notifyThread(env, job.thread_id, `Fred ${status} render #${job.id}.${b.note ? ' Note: ' + b.note : ''}${status === 'approved' ? ' Rendering now.' : ''}`);
    await audit(env, person.id, `render.${status}`, `#${job.id}`);
    return json({ ok: true });
  }

  if ((p = m(route('POST', '/api/admin/suggestions/:id')))) {
    const b = await request.json().catch(() => ({}));
    if (!['approved', 'rejected', 'pending'].includes(b.status)) return err(400, 'bad status');
    await env.DB.prepare(`UPDATE suggestions SET status = ?, owner_note = ?, decided_at = datetime('now') WHERE id = ?`)
      .bind(b.status, b.note || null, p.id).run();
    await audit(env, person.id, `site.${b.status}`, `#${p.id}`);
    return json({ ok: true });
  }

  if ((p = m(route('POST', '/api/admin/tasks/:id')))) {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(`UPDATE tasks SET reply = COALESCE(?, reply), done_at = CASE WHEN ? THEN datetime('now') ELSE done_at END WHERE id = ?`)
      .bind(b.reply || null, b.done ? 1 : 0, p.id).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/knowledge' && method === 'GET') {
    const key = url.searchParams.get('key');
    const r = await env.DB.prepare('SELECT * FROM knowledge WHERE key = ?').bind(key).first();
    return r ? json(r) : err(404, 'none');
  }
  if (path === '/api/admin/knowledge' && method === 'PUT') {
    const b = await request.json().catch(() => ({}));
    if (!b.key || typeof b.body !== 'string') return err(400, 'key and body');
    await env.DB.prepare(`INSERT INTO knowledge (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`)
      .bind(String(b.key).slice(0, 80), b.body.slice(0, 400000)).run();
    await audit(env, person.id, 'knowledge.set', b.key);
    return json({ ok: true });
  }
  if (path === '/api/admin/knowledge' && method === 'DELETE') {
    const key = url.searchParams.get('key');
    await env.DB.prepare('DELETE FROM knowledge WHERE key = ?').bind(key).run();
    await audit(env, person.id, 'knowledge.delete', key);
    return json({ ok: true });
  }

  if (path === '/api/admin/settings' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const allowed = ['creator_budget_gbp', 'gbp_per_credit', 'renders_paused', 'links'];
    for (const k of allowed) if (k in b) await setSetting(env, k, typeof b[k] === 'string' ? b[k] : JSON.stringify(b[k]));
    await audit(env, person.id, 'settings', Object.keys(b).join(','));
    return json({ ok: true });
  }

  if ((p = m(route('POST', '/api/admin/people/:id')))) {
    const b = await request.json().catch(() => ({}));
    if (b.action === 'revoke') {
      await env.DB.prepare(`UPDATE people SET revoked_at = datetime('now') WHERE id = ? AND role != 'owner'`).bind(p.id).run();
      await env.DB.prepare('DELETE FROM sessions WHERE person_id = ? AND person_id NOT IN (SELECT id FROM people WHERE role = \'owner\')').bind(p.id).run();
    } else if (b.action === 'restore') {
      await env.DB.prepare('UPDATE people SET revoked_at = NULL WHERE id = ?').bind(p.id).run();
    } else return err(400, 'revoke or restore');
    await audit(env, person.id, `person.${b.action}`, `#${p.id}`);
    return json({ ok: true });
  }

  // Fallback when e-mail does not arrive: Fred makes a code and sends it to her on WhatsApp.
  if (path === '/api/admin/login-code' && method === 'POST') {
    await ensurePeople(env);
    const creator = await env.DB.prepare(`SELECT * FROM people WHERE role = 'creator' AND revoked_at IS NULL ORDER BY id LIMIT 1`).first();
    if (!creator) return err(400, 'no active creator');
    const code = sixDigits();
    await env.DB.prepare(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`
    ).bind(creator.email, await sha256(creator.email + ':' + code), isoIn(24 * 3600e3)).run();
    await audit(env, person.id, 'login.code_made', `creator #${creator.id}`);
    const origin = new URL(request.url).origin;
    const text = `Your PERDIMI Studio code: ${code} (valid 24 h). Open ${origin} and sign in with your e-mail, then type the code.`;
    const phone = String(env.CREATOR_PHONE || '').replace(/\D/g, '');
    return json({ code, whatsapp: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null });
  }

  return err(404, 'not found');
}

// ================================================================== runner (estate machine)

async function runnerApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const m = (r) => { const x = r.re.exec(path); return x && method === r.method ? (x.groups || {}) : null; };
  let p;

  // Same contract as the Aichabelle salon portal pull (aichabelle_portal_pull.py).
  if (path === '/api/pull/tasks' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, team, title, detail, urgency, person_name, created_at FROM tasks WHERE pulled_at IS NULL ORDER BY id`
    ).all();
    return json({ tasks: results });
  }
  if (path === '/api/pull/tasks' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(`UPDATE tasks SET pulled_at = datetime('now'), ledger_id = ? WHERE id = ?`).bind(b.ledger_id ? String(b.ledger_id) : null, b.id).run();
    return json({ ok: true });
  }
  if ((p = m(route('POST', '/api/runner/tasks/:id/reply')))) {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(`UPDATE tasks SET reply = ?, done_at = CASE WHEN ? THEN datetime('now') ELSE done_at END WHERE id = ?`)
      .bind(String(b.reply || '').slice(0, 4000), b.done ? 1 : 0, p.id).run();
    return json({ ok: true });
  }

  if (path === '/api/runner/renders' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT r.*, (SELECT result_media_id FROM renders d WHERE d.id = r.parent_id) AS parent_media_id
       FROM renders r WHERE status IN ('estimating','approved') ORDER BY id`
    ).all();
    return json({ renders: results.map((r) => ({ ...r, ref_media: parseJsonArray(r.ref_media) })) });
  }
  if ((p = m(route('POST', '/api/runner/renders/:id/estimate')))) {
    const b = await request.json().catch(() => ({}));
    const credits = Number(b.credits);
    if (!isFinite(credits) || credits < 0) return err(400, 'credits');
    return json(await applyEstimate(env, parseInt(p.id, 10), credits));
  }
  if ((p = m(route('POST', '/api/runner/renders/:id/start')))) {
    const r = await env.DB.prepare(
      `UPDATE renders SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'approved' RETURNING id`
    ).bind(p.id).first();
    return r ? json({ ok: true }) : err(409, 'not approved (cancelled or already taken)');
  }
  if ((p = m(route('PUT', '/api/runner/renders/:id/result/:part')))) {
    const job = await env.DB.prepare('SELECT * FROM renders WHERE id = ?').bind(p.id).first();
    if (!job || job.status !== 'running') return err(409, 'not running');
    const mediaId = job.result_media_id || `r${job.id}${randomId(4)}`;
    const mime = request.headers.get('content-type') || (job.kind === 'video' ? 'video/mp4' : 'image/png');
    if (!job.result_media_id) {
      await env.DB.prepare(
        `INSERT INTO media (id, kind, mime, r2_key, source, quality, render_id) VALUES (?, ?, ?, ?, 'render', ?, ?)`
      ).bind(mediaId, job.kind, mime, `r/${job.id}/full.${job.kind === 'video' ? 'mp4' : mime.split('/')[1] || 'png'}`, job.quality, job.id).run();
      await env.DB.prepare('UPDATE renders SET result_media_id = ? WHERE id = ?').bind(mediaId, job.id).run();
    }
    const media = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(mediaId).first();
    const key = p.part === 'preview' ? `r/${job.id}/preview.jpg` : media.r2_key;
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: p.part === 'preview' ? 'image/jpeg' : mime } });
    if (p.part === 'preview') await env.DB.prepare('UPDATE media SET preview_key = ? WHERE id = ?').bind(key, mediaId).run();
    else await env.DB.prepare('UPDATE media SET mime = ? WHERE id = ?').bind(mime, mediaId).run();
    return json({ ok: true, media_id: mediaId });
  }
  if ((p = m(route('POST', '/api/runner/renders/:id/done')))) {
    const b = await request.json().catch(() => ({}));
    const job = await env.DB.prepare('SELECT * FROM renders WHERE id = ?').bind(p.id).first();
    if (!job || !job.result_media_id) return err(409, 'upload the result first');
    const perCreditRaw = await getSetting(env, 'gbp_per_credit', env.GBP_PER_CREDIT || '');
    const perCredit = perCreditRaw ? parseFloat(perCreditRaw) : null;
    const credits = b.actual_credits != null ? Number(b.actual_credits) : job.est_credits;
    await env.DB.prepare(
      `UPDATE renders SET status = 'done', actual_credits = ?, actual_gbp = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(credits, perCredit != null && credits != null ? Math.round(credits * perCredit * 100) / 100 : null, job.id).run();
    await notifyThread(env, job.thread_id,
      `Render #${job.id} is ready (${job.kind}, ${job.quality}). It's in Studio, media id ${job.result_media_id}. Keep it or discard it there${job.quality === 'draft' ? '; a kept draft can be made final' : ''}.`);
    return json({ ok: true });
  }
  if ((p = m(route('POST', '/api/runner/renders/:id/fail')))) {
    const b = await request.json().catch(() => ({}));
    const job = await env.DB.prepare('SELECT * FROM renders WHERE id = ?').bind(p.id).first();
    if (!job) return err(404, 'none');
    await env.DB.prepare(`UPDATE renders SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(String(b.error || 'failed').slice(0, 500), job.id).run();
    await notifyThread(env, job.thread_id, `Render #${job.id} failed (failed renders cost nothing): ${String(b.error || '').slice(0, 200)}`);
    return json({ ok: true });
  }
  if ((p = m(route('GET', '/api/runner/media/:id')))) {
    const media = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(p.id).first();
    if (!media) return err(404, 'none');
    const obj = await env.MEDIA.get(media.r2_key);
    if (!obj) return err(404, 'missing');
    return new Response(obj.body, { headers: { 'content-type': media.mime } });
  }
  if ((p = m(route('PUT', '/api/runner/knowledge/:key')))) {
    const body = await request.text();
    await env.DB.prepare(`INSERT INTO knowledge (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`)
      .bind(decodeURIComponent(p.key).slice(0, 80), body.slice(0, 400000)).run();
    return json({ ok: true });
  }

  return err(404, 'not found');
}
