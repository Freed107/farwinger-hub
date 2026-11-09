// Shared helpers: responses, crypto, sessions, budget.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const err = (status, message) => json({ error: message }, status);

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomId(bytes = 16) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sixDigits() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

// Constant-time compare for bearer tokens.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const isoIn = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);

export async function audit(env, personId, action, detail) {
  await env.DB.prepare('INSERT INTO audit (person_id, action, detail) VALUES (?, ?, ?)')
    .bind(personId ?? null, action, detail == null ? null : String(detail).slice(0, 2000))
    .run();
}

// Make sure the owner and the creator exist as people. Emails come from vars/secrets, never from code.
export async function ensurePeople(env) {
  const rows = [[env.OWNER_EMAIL, 'owner', 'Fred']];
  if (env.CREATOR_EMAIL) rows.push([env.CREATOR_EMAIL, 'creator', 'Blessing']);
  for (const [email, role, name] of rows) {
    if (!email) continue;
    await env.DB.prepare('INSERT OR IGNORE INTO people (email, role, name) VALUES (?, ?, ?)')
      .bind(email.trim().toLowerCase(), role, name)
      .run();
  }
}

const SESSION_DAYS = 180; // long: re-signing in on a flaky line is the thing to avoid
export const SESSION_COOKIE = 'pcp_s';

export async function createSession(env, personId) {
  const token = randomId(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, person_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), personId, isoIn(SESSION_DAYS * 864e5))
    .run();
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
  return { token, cookie };
}

export function readCookie(request, name) {
  const h = request.headers.get('cookie') || '';
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export async function currentPerson(env, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT p.*, s.token_hash FROM sessions s JOIN people p ON p.id = s.person_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND p.revoked_at IS NULL`
  ).bind(await sha256(token)).first();
  if (!row) return null;
  // touch at most every ~10 min to keep D1 writes low
  await env.DB.prepare(
    `UPDATE sessions SET last_seen = datetime('now') WHERE token_hash = ? AND last_seen < datetime('now','-10 minutes')`
  ).bind(row.token_hash).run();
  return row;
}

export async function getSetting(env, key, fallback = null) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : fallback;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}

// Effective config: a value Fred set in /admin wins over the wrangler var.
export async function budgetConfig(env) {
  const budget = parseFloat(await getSetting(env, 'creator_budget_gbp', env.CREATOR_BUDGET_GBP || '30'));
  const perCreditRaw = await getSetting(env, 'gbp_per_credit', env.GBP_PER_CREDIT || '');
  const perCredit = perCreditRaw === '' || perCreditRaw == null ? null : parseFloat(perCreditRaw);
  const paused = (await getSetting(env, 'renders_paused', 'false')) === 'true';
  return { budget: isFinite(budget) ? budget : 30, perCredit: isFinite(perCredit) ? perCredit : null, paused };
}

// Spend this calendar month (UTC). Real cost where the runner reported it, estimate otherwise.
// Failed / rejected / cancelled jobs cost nothing (Higgsfield does not charge failed generations).
export async function monthSpend(env, personId) {
  const r = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(COALESCE(actual_gbp, est_gbp, 0)), 0) AS committed,
       COALESCE(SUM(CASE WHEN verdict = 'discard' THEN COALESCE(actual_gbp, est_gbp, 0) ELSE 0 END), 0) AS discarded,
       COALESCE(SUM(CASE WHEN quality = 'final' AND parent_id IS NULL THEN COALESCE(actual_gbp, est_gbp, 0) ELSE 0 END), 0) AS final_without_draft,
       COUNT(*) AS jobs
     FROM renders
     WHERE requested_by = ?
       AND status IN ('approved','running','done')
       AND created_at >= strftime('%Y-%m-01 00:00:00','now')`
  ).bind(personId).first();
  return {
    committed: round2(r.committed),
    discarded: round2(r.discarded),
    finalWithoutDraft: round2(r.final_without_draft),
    jobs: r.jobs,
  };
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function budgetStatus(env, personId) {
  const cfg = await budgetConfig(env);
  const spend = await monthSpend(env, personId);
  return {
    budget_gbp: cfg.budget,
    spent_gbp: spend.committed,
    left_gbp: round2(Math.max(0, cfg.budget - spend.committed)),
    discarded_gbp: spend.discarded,
    final_without_draft_gbp: spend.finalWithoutDraft,
    jobs_this_month: spend.jobs,
    gbp_per_credit_known: cfg.perCredit != null,
    renders_paused: cfg.paused,
  };
}

export function parseJsonArray(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
