// Render jobs: creation, the spend gate, and posting notices back into the chat.
import { budgetConfig, monthSpend, round2, audit, parseJsonArray } from './lib.js';

// Indicative credit costs (Higgsfield playbook: 480p draft 5 s = 18 cr, 1080p final = 80 cr).
// Only used to TALK about cost before the runner's free preflight returns the real figure.
export const INDICATIVE_CREDITS = {
  image: { draft: 2, final: 6 },
  video: { draft: 18, final: 80 },
};

export async function createRender(env, person, input) {
  const kind = input.kind === 'video' ? 'video' : 'image';
  const quality = input.quality === 'final' ? 'final' : 'draft';
  const prompt = String(input.prompt || '').trim();
  if (prompt.length < 10) return { error: 'Prompt is too short to render. Describe the shot.' };
  const refs = parseJsonArray(JSON.stringify(input.ref_media || [])).slice(0, 6).map(String);
  const seconds = kind === 'video' ? Math.min(15, Math.max(3, parseInt(input.seconds || 5, 10))) : null;
  const aspect = ['9:16', '4:5', '1:1', '16:9'].includes(input.aspect) ? input.aspect : '9:16';

  let parentId = input.parent_id ? parseInt(input.parent_id, 10) : null;
  let note = null;
  if (quality === 'final') {
    if (parentId) {
      const parent = await env.DB.prepare('SELECT * FROM renders WHERE id = ?').bind(parentId).first();
      if (!parent || parent.quality !== 'draft' || parent.status !== 'done')
        return { error: `Render #${parentId} is not a finished draft, so it cannot be finalised.` };
      if (parent.kind !== kind) return { error: 'A final must be the same kind (image/video) as its draft.' };
      if (parent.verdict !== 'keep') {
        await env.DB.prepare(`UPDATE renders SET verdict = 'keep', updated_at = datetime('now') WHERE id = ?`).bind(parentId).run();
      }
    } else {
      parentId = null;
      note = 'No low-quality draft first: this final goes to Fred for approval.';
    }
  }

  const r = await env.DB.prepare(
    `INSERT INTO renders (thread_id, requested_by, kind, quality, prompt, aspect, seconds, ref_media, parent_id, est_credits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    input.thread_id || null, person.id, kind, quality, prompt.slice(0, 4000), aspect, seconds,
    JSON.stringify(refs), parentId, INDICATIVE_CREDITS[kind][quality]
  ).first();
  await audit(env, person.id, 'render.request', `#${r.id} ${kind}/${quality}`);
  return { id: r.id, status: 'estimating', note };
}

// Called when the runner has the real (free) preflight cost. Decides: run now, or wait for Fred.
export async function applyEstimate(env, renderId, credits) {
  const job = await env.DB.prepare('SELECT r.*, p.role FROM renders r JOIN people p ON p.id = r.requested_by WHERE r.id = ?')
    .bind(renderId).first();
  if (!job) return { error: 'no such render' };
  if (job.status !== 'estimating') return { status: job.status };
  const cfg = await budgetConfig(env);
  const estGbp = cfg.perCredit != null ? round2(credits * cfg.perCredit) : null;

  let status = 'approved';
  let reason = null;
  if (job.role !== 'owner') {
    const spend = await monthSpend(env, job.requested_by);
    if (cfg.paused) reason = 'Renders are paused by Fred.';
    else if (estGbp == null) reason = 'The £ price of a credit is not set yet, so the spend cannot be checked.';
    else if (job.quality === 'final' && !job.parent_id) reason = 'Final quality without a kept low-quality draft first.';
    else if (spend.committed + estGbp > cfg.budget)
      reason = `Over the £${cfg.budget} monthly allowance (spent £${spend.committed}, this one ~£${estGbp}).`;
    if (reason) status = 'awaiting_owner';
  }
  await env.DB.prepare(
    `UPDATE renders SET est_credits = ?, est_gbp = ?, status = ?, hold_reason = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(credits, estGbp, status, reason, renderId).run();
  await notifyThread(env, job.thread_id,
    status === 'approved'
      ? `Render #${renderId} (${job.kind}, ${job.quality}) costs ~${credits} credits${estGbp != null ? ` (~£${estGbp})` : ''}. Rendering now.`
      : `Render #${renderId} is waiting for Fred: ${reason}`);
  return { status, est_gbp: estGbp, reason };
}

export async function notifyThread(env, threadId, text) {
  if (!threadId) return;
  await env.DB.prepare(`INSERT INTO messages (thread_id, kind, body) VALUES (?, 'note', ?)`).bind(threadId, text).run();
  await env.DB.prepare(`UPDATE threads SET updated_at = datetime('now') WHERE id = ?`).bind(threadId).run();
}

export function renderView(r) {
  return {
    id: r.id, kind: r.kind, quality: r.quality, prompt: r.prompt, aspect: r.aspect, seconds: r.seconds,
    parent_id: r.parent_id, status: r.status, hold_reason: r.hold_reason, verdict: r.verdict,
    est_credits: r.est_credits, est_gbp: r.est_gbp, actual_gbp: r.actual_gbp,
    result_media_id: r.result_media_id, error: r.error, created_at: r.created_at,
  };
}
