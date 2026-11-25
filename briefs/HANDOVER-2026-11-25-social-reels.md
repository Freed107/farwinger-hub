# HANDOVER — social reels, 2026-11-25 (paste the block below into Claude Code on the PC)

Cloud session could not reach the PC (no Remote Control folder shared) and Supermetrics Instagram is not
logged in, so nothing below has been run. Every number has to be read fresh on the PC.

---------------------------------------------------------------- PASTE FROM HERE
You are working on Fred's PC. Do two jobs from the farwinger-hub repo, branch
`claude/social-media-posting-strategy-yjhn87` (git fetch it; read both briefs in `briefs/` in full first):

JOB 0 — URGENT: Facebook
The channel plan has NO facebook:farwinger or facebook:woodenballsco lane (only instagram x2, tiktok:wbc, youtube:wbc).
Fred wants both on Facebook now. Confirm the Facebook Pages exist and are linked to the Business portfolio, then add
facebook:farwinger (same clips and cadence as instagram:farwinger) and facebook:woodenballsco (same as instagram:woodenballsco)
as Graph API Page video_reels lanes using the existing System User token (add pages_manage_posts if it's missing).
Post one test reel to each, read it back, and record the permalinks. Add both lanes to the heartbeat and the analyst.

JOB 1 — @woodenballsco re-edits + reel analyst
Brief: briefs/2026-11-25_WBC-reedit-and-reel-analyst.md
Vault: H:\Farwinger-Vault\_OPERATIONS\shortform\  (queue: _OPERATIONS\monitoring\shortform-queue.json,
channel plan with instagram:farwinger / instagram:woodenballsco, shortform_dupe_check.py, shortform-repost-compare.py)
1. ANALYZE first: run shortform-repost-compare.py, and pull day-3 / day-7 views for every reel on
   @farwinger and @woodenballsco since 2 Oct. Report the medians per account and the repost-vs-original pairs.
   If the numbers do NOT show WBC reposts underperforming, say so before going further.
2. @farwinger: change nothing (spec, cadence MON-FRI 17:00, one-take 8-12 s cuts).
3. @woodenballsco: stop posting A/B/G clips (undo the 20 Nov "daily 19:00 Farwinger winners" change).
   Nick cuts W## clips: 18-24 s, 3-5 shots from 2+ takes of the SAME scene in process order
   (action from frame 0 -> rough -> shape -> finish -> finished object for the last 3-4 s), hard cuts,
   continuous native audio with 4-6 frame crossfades, 1080x1920 native, `parts` field in the queue.
   Start with the scenes behind @farwinger's best performers. Cut at least 5 before WBC posts again;
   WBC drops to MON/WED/FRI if fewer than 5 W clips are queued.
4. Gate: instagram:woodenballsco accepts W## only. Register the W clips in shortform_dupe_check.py.
5. Install Windows scheduled task `Shortform-Analyst` (Mon + Thu 08:00, read-only): reads Graph API insights for
   both accounts, writes _OPERATIONS\monitoring\shortform-analyst-YYYY-MM-DD.md (<=15 lines) and one calendar popup
   "Reels: FW median N / WBC median N". Run it once now and show the output.
6. Success test: after 10 W clips are 7 days old, WBC median on W must be >= 2x WBC median on reposts.

JOB 2 — PERDIMI audience demographics on the Estate Board
Brief: briefs/2026-11-25_PERDIMI-reel-demographics-on-estate-board.md
1. Verify, against the live APIs, what exists: Instagram Graph API has NO per-media age/gender/country, only
   account-level reached_audience_demographics / engaged_audience_demographics (100+ accounts threshold).
   Check whether the PERDIMI TikTok is a Business account with per-video audience data. Report what you found.
2. "Successful reel" = views >= 2x the platform's 30-day median, or top 3 on that platform this month.
3. Extend the 07:20 PERDIMI reader to store demographics per qualifying reel, with scope "reel" or
   "account-window" (account audience for the 7 days after posting), n, and read date.
4. Add the "Who watched" strip to the local dashboard AND the online Estate Board: one card per qualifying
   reel (thumbnail, views, xN-median badge, female/male/unknown stacked bar, 7 age bars, top 3 countries + top 3
   cities with the existing flag images, scope + n footer, greyed "<100 reached" state), plus a 30-day PERDIMI
   baseline card above, with buckets that differ by 10+ pts marked.
5. No browser scraping of Instagram insights without Fred's explicit yes.
6. Send Fred one screenshot of the strip.

Rules: never post or delete anything outside the jobs above; commit on the vault repo as usual; finish with a
short summary in capitals first, then what was done, what failed, and what needs Fred.
---------------------------------------------------------------- PASTE TO HERE

## So the cloud can do it next time

- Remote Control: on the PC, open Claude Desktop → Settings → Claude Code → Remote Control and add
  `H:\Farwinger-Vault` (it must not be the home folder or a hidden folder), or run `claude remote-control` in a
  terminal inside that folder. A cloud session can then ask to attach it. This session saw no shared folders.
- Supermetrics Instagram: log in at
  https://gcp1-api-default.supermetrics.com/v2/datasource/login/renew/8nu7pab6tm12u9lu7h0yjgnd
  in a desktop browser, using the Facebook account that manages @farwinger, @woodenballsco and @perdimi.parfum.
  That gives cloud sessions read access to Instagram insights (not to the vault, the queue or the dashboards).
