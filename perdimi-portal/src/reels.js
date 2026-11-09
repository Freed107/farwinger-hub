// Reels: one strict order, enforced here (Fred, 9 Nov):
//   1 talk        verbal discussion, bouncing ideas back and forth
//   2 brief       describe character and scene, determine story or action      -> approve
//   3 storyboard  a picture storyboard; the frames become the video's input   -> approve
//   4 video_480   the reel rendered at 480p                                    -> approve
//   5 video_720   the approved 480p rendered at 720p                           -> approve -> done
// No stage can be skipped. Going back is allowed (reopen); nothing is overwritten - every render stays as a version.
import { audit, getSetting, parseJsonArray } from './lib.js';
import { notifyThread } from './renders.js';

export const STAGES = ['talk', 'brief', 'storyboard', 'video_480', 'video_720', 'done'];
export const STAGE_LABEL = {
  talk: 'Talk', brief: 'Brief', storyboard: 'Storyboard', video_480: 'Video 480p', video_720: 'Video 720p', done: 'Done',
};

// Indicative only (playbook: 480p draft 5 s = 18 cr; Seedance 720p 8 s = 36 cr). The runner's free preflight is the real figure.
export const indicativeReelCredits = (stage, seconds = 8) =>
  stage === 'storyboard' ? 2 : stage === 'video_480' ? Math.ceil(3.6 * seconds) : Math.ceil(4.5 * seconds);

export async function getReel(env, id) {
  return env.DB.prepare('SELECT * FROM reels WHERE id = ?').bind(id).first();
}

export async function reelView(env, reel) {
  const { results } = await env.DB.prepare(
    `SELECT id, reel_stage, frame_no, resolution, prompt, status, verdict, result_media_id, est_credits, actual_credits, hold_reason, error, parent_id
     FROM renders WHERE reel_id = ? ORDER BY id`
  ).bind(reel.id).all();
  return {
    ...reel,
    frames: parseJsonArray(reel.frames_json),
    stage_label: STAGE_LABEL[reel.stage],
    renders: results,
    can_approve: (await approvalBlocker(env, reel)) === null,
    approve_blocker: await approvalBlocker(env, reel),
  };
}

export async function startReel(env, person, { title, thread_id, platform, seconds }) {
  const r = await env.DB.prepare(
    `INSERT INTO reels (thread_id, created_by, title, platform, seconds) VALUES (?, ?, ?, ?, ?) RETURNING *`
  ).bind(thread_id || null, person.id, String(title || 'Untitled reel').slice(0, 120), platform || null,
    Math.min(15, Math.max(3, parseInt(seconds || 8, 10)))).first();
  await audit(env, person.id, 'reel.start', `#${r.id}`);
  return r;
}

// Brief can be written during talk (moves it to brief) or edited during brief. Later stages must reopen first.
export async function saveBrief(env, person, reelId, { character, scene, story, seconds }) {
  const reel = await getReel(env, reelId);
  if (!reel) return { error: 'No such reel.' };
  if (!['talk', 'brief'].includes(reel.stage))
    return { error: `The brief is locked: this reel is at "${STAGE_LABEL[reel.stage]}". Reopen back to Brief to change it.` };
  await env.DB.prepare(
    `UPDATE reels SET character = COALESCE(?, character), scene = COALESCE(?, scene), story = COALESCE(?, story),
       seconds = COALESCE(?, seconds), stage = 'brief', updated_at = datetime('now') WHERE id = ?`
  ).bind(character || null, scene || null, story || null, seconds ? Math.min(15, Math.max(3, parseInt(seconds, 10))) : null, reelId).run();
  return { ok: true, stage: 'brief', next: 'She reads the brief in Studio > Reels and taps Approve brief. Then the storyboard.' };
}

async function insertReelRender(env, person, reel, f) {
  const r = await env.DB.prepare(
    `INSERT INTO renders (thread_id, requested_by, kind, quality, prompt, aspect, seconds, ref_media, parent_id, est_credits,
                          reel_id, reel_stage, frame_no, resolution)
     VALUES (?, ?, ?, ?, ?, '9:16', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(reel.thread_id, person.id, f.kind, f.quality, f.prompt.slice(0, 4000), f.seconds ?? null, JSON.stringify(f.refs || []),
    f.parent_id ?? null, indicativeReelCredits(f.stage, reel.seconds), reel.id, f.stage, f.frame_no ?? null, f.resolution ?? null).first();
  await audit(env, person.id, 'render.request', `reel #${reel.id} ${f.stage} render #${r.id}`);
  return r.id;
}

// Storyboard frames: images, only while the reel is at storyboard (i.e. the brief is approved).
export async function renderStoryboard(env, person, reelId, frames) {
  const reel = await getReel(env, reelId);
  if (!reel) return { error: 'No such reel.' };
  if (reel.stage !== 'storyboard')
    return { error: `Not allowed: storyboard frames are made only at the Storyboard stage. This reel is at "${STAGE_LABEL[reel.stage]}"${reel.stage === 'brief' || reel.stage === 'talk' ? ' - the brief must be approved first' : ''}.` };
  const list = (frames || []).filter((f) => f && String(f.prompt || '').trim().length >= 10).slice(0, 12);
  if (!list.length) return { error: 'Give at least one frame with a full prompt.' };
  const ids = [];
  for (const [i, f] of list.entries()) {
    ids.push(await insertReelRender(env, person, reel, {
      stage: 'storyboard', kind: 'image', quality: 'draft', prompt: String(f.prompt),
      frame_no: parseInt(f.frame_no || i + 1, 10), refs: (f.ref_media || []).map(String).slice(0, 6),
    }));
  }
  return { render_ids: ids, indicative_credits_each: indicativeReelCredits('storyboard') };
}

// Reel video: 480p only after the storyboard is approved; 720p only from the approved 480p.
export async function renderReelVideo(env, person, reelId, { prompt }) {
  const reel = await getReel(env, reelId);
  if (!reel) return { error: 'No such reel.' };
  const frames = parseJsonArray(reel.frames_json);
  const motion = String(prompt || '').trim() || `${reel.story || ''}`;
  if (reel.stage === 'video_480') {
    return {
      render_id: await insertReelRender(env, person, reel, {
        stage: 'video_480', kind: 'video', quality: 'draft', resolution: '480p', seconds: reel.seconds,
        prompt: `${motion}\n\nCharacter: ${reel.character}\nScene: ${reel.scene}`,
        refs: frames.map((f) => f.media_id),
      }),
      resolution: '480p', indicative_credits: indicativeReelCredits('video_480', reel.seconds),
    };
  }
  if (reel.stage === 'video_720') {
    const base = await env.DB.prepare('SELECT * FROM renders WHERE id = ?').bind(reel.v480_render_id).first();
    if (!base) return { error: 'The approved 480p render is missing.' };
    return {
      render_id: await insertReelRender(env, person, reel, {
        stage: 'video_720', kind: 'video', quality: 'final', resolution: '720p', seconds: reel.seconds,
        prompt: base.prompt, refs: frames.map((f) => f.media_id), parent_id: base.id,
      }),
      resolution: '720p', indicative_credits: indicativeReelCredits('video_720', reel.seconds),
    };
  }
  return { error: `Not allowed: this reel is at "${STAGE_LABEL[reel.stage]}". Videos come after the storyboard is approved (480p), and 720p only after the 480p is approved.` };
}

// What stops the current stage being approved (null = can approve).
async function approvalBlocker(env, reel) {
  const q = (stage) => env.DB.prepare(
    `SELECT * FROM renders WHERE reel_id = ? AND reel_stage = ? ORDER BY id DESC`
  ).bind(reel.id, stage).all().then((r) => r.results);
  switch (reel.stage) {
    case 'talk': return 'Talk it through first, then write the brief (character, scene, story/action).';
    case 'brief':
      return reel.character && reel.scene && reel.story ? null : 'The brief needs the character, the scene and the story/action.';
    case 'storyboard': {
      const rs = await q('storyboard');
      if (rs.some((r) => ['estimating', 'approved', 'running', 'awaiting_owner'].includes(r.status))) return 'Frames are still rendering or waiting.';
      return rs.some((r) => r.status === 'done' && r.verdict !== 'discard') ? null : 'No finished storyboard frames yet.';
    }
    case 'video_480':
    case 'video_720': {
      const rs = await q(reel.stage);
      const v = rs.find((r) => r.status === 'done' && r.verdict !== 'discard');
      return v ? null : `No finished ${reel.stage === 'video_480' ? '480p' : '720p'} video yet.`;
    }
    default: return 'This reel is done.';
  }
}

export async function approveStage(env, person, reelId) {
  const reel = await getReel(env, reelId);
  if (!reel) return { error: 'No such reel.' };
  const approver = await getSetting(env, 'reel_approver', 'creator'); // 'creator' or 'owner'
  if (person.role !== 'owner' && (approver === 'owner' || reel.created_by !== person.id))
    return { error: 'Only Fred can approve this stage.' };
  const blocker = await approvalBlocker(env, reel);
  if (blocker) return { error: blocker };

  let next, extra = {};
  if (reel.stage === 'brief') next = 'storyboard';
  if (reel.stage === 'storyboard') {
    // the approved storyboard = the latest kept/undiscarded finished frame per frame number, in order
    const { results } = await env.DB.prepare(
      `SELECT * FROM renders WHERE reel_id = ? AND reel_stage = 'storyboard' AND status = 'done' AND (verdict IS NULL OR verdict != 'discard') ORDER BY frame_no, id DESC`
    ).bind(reel.id).all();
    const byFrame = new Map();
    for (const r of results) if (!byFrame.has(r.frame_no)) byFrame.set(r.frame_no, r);
    const frames = [...byFrame.values()].map((r) => ({ frame_no: r.frame_no, media_id: r.result_media_id, render_id: r.id }));
    extra.frames_json = JSON.stringify(frames);
    next = 'video_480';
  }
  if (reel.stage === 'video_480' || reel.stage === 'video_720') {
    const r = await env.DB.prepare(
      `SELECT id FROM renders WHERE reel_id = ? AND reel_stage = ? AND status = 'done' AND (verdict IS NULL OR verdict != 'discard') ORDER BY id DESC LIMIT 1`
    ).bind(reel.id, reel.stage).first();
    await env.DB.prepare(`UPDATE renders SET verdict = 'keep' WHERE id = ?`).bind(r.id).run();
    if (reel.stage === 'video_480') { extra.v480_render_id = r.id; next = 'video_720'; }
    else { extra.v720_render_id = r.id; next = 'done'; }
  }
  const sets = ['stage = ?', "updated_at = datetime('now')", ...Object.keys(extra).map((k) => `${k} = ?`)];
  await env.DB.prepare(`UPDATE reels SET ${sets.join(', ')} WHERE id = ?`).bind(next, ...Object.values(extra), reel.id).run();
  await audit(env, person.id, 'reel.approve', `#${reel.id} ${reel.stage} -> ${next}`);
  await notifyThread(env, reel.thread_id, `Reel #${reel.id} "${reel.title}": ${STAGE_LABEL[reel.stage]} approved. Next: ${STAGE_LABEL[next]}.`);
  return { ok: true, stage: next };
}

// Step back one stage to change something. Earlier renders stay (versions are never overwritten).
export async function reopenStage(env, person, reelId) {
  const reel = await getReel(env, reelId);
  if (!reel) return { error: 'No such reel.' };
  if (person.role !== 'owner' && reel.created_by !== person.id) return { error: 'Not your reel.' };
  const i = STAGES.indexOf(reel.stage);
  if (i <= 1) return { error: 'Already at the start.' };
  const prev = STAGES[i - 1];
  const clear = { storyboard: [], video_480: ['frames_json'], video_720: ['v480_render_id'], done: ['v720_render_id'] }[reel.stage] || [];
  await env.DB.prepare(`UPDATE reels SET stage = ?, ${clear.map((c) => `${c} = NULL, `).join('')}updated_at = datetime('now') WHERE id = ?`)
    .bind(prev, reel.id).run();
  await audit(env, person.id, 'reel.reopen', `#${reel.id} ${reel.stage} -> ${prev}`);
  await notifyThread(env, reel.thread_id, `Reel #${reel.id} "${reel.title}" moved back to ${STAGE_LABEL[prev]}.`);
  return { ok: true, stage: prev };
}
