HANDOVER — social media, 25 Nov 2026. Execute on the PC.

Source: farwinger-hub repo, branch `claude/social-media-posting-strategy-yjhn87`, folder `briefs/`. Fetch it and read the
three briefs named below in full before starting. Shortform vault: `H:\Farwinger-Vault\_OPERATIONS\shortform\`
(queue `_OPERATIONS\monitoring\shortform-queue.json`, channel plan, shortform_dupe_check.py, shortform-repost-compare.py).
Nothing below has been run yet. Read every number fresh.

== JOB 0 — URGENT: Facebook auto-posting (none exists)
The channel plan has no Facebook lanes: only instagram:farwinger, instagram:woodenballsco, tiktok:woodenballsco, youtube:woodenballsco.
1. Confirm the Farwinger and woodenballsco Facebook Pages exist and are in the Business portfolio.
2. Add `facebook:farwinger` (same clips and cadence as instagram:farwinger) and `facebook:woodenballsco` (same as
   instagram:woodenballsco) as Graph API Page reels lanes on the existing System User token. Add pages_manage_posts if it's missing.
3. Post one test reel to each Page, read it back, record the permalinks. Add both lanes to the heartbeat and the analyst.

== JOB 1 — @woodenballsco: stop reposts, new edits, analyst
Brief: `briefs/2026-11-25_WBC-reedit-and-reel-analyst.md`
1. Run shortform-repost-compare.py and pull day-3 / day-7 views for every reel on both accounts since 2 Oct. Report the medians.
   If the numbers do NOT show the WBC reposts underperforming, say so before going further.
2. @farwinger: no change.
3. @woodenballsco: no clip ever posted on @farwinger. Undo the 20 Nov "daily 19:00 Farwinger winners" change.
   A/B test, 10 posts each, alternating, 3 a week, as Trial Reels:
   A = W## edits, 18–24 s, 3–5 shots from 2+ takes of the same scene in process order, ending on the finished ball (Nick, spec in the brief).
   B = 8–12 s single takes never posted on @farwinger.
   Last seconds of both: finished product, size and wood, "shop link in bio".
4. Gate: instagram:woodenballsco (and facebook:woodenballsco) accept only W## and never-posted B clips. Register them in shortform_dupe_check.py.
5. Install scheduled task `Shortform-Analyst`, Mon + Thu 08:00, read-only. It covers every lane incl. Facebook, writes
   `_OPERATIONS\monitoring\shortform-analyst-YYYY-MM-DD.md` (15 lines max) and one calendar popup "Reels: FW median N / WBC median N".
   Run it once now and show the output.
6. Decide after 10 A + 10 B are 7 days old: the winner's day-7 median becomes the WBC format.

== JOB 2 — PERDIMI: audience per successful reel on the Estate Board
Brief: `briefs/2026-11-25_PERDIMI-reel-demographics-on-estate-board.md`
1. Instagram API has no per-reel age/gender/country; the Instagram app does (reel → View insights → Audience).
   Check whether TikTok is a Business account with per-video audience data.
2. Successful reel = views ≥ 2× the platform's 30-day median, or top 3 that month.
3. Build the "Who watched" cards on the local dashboard AND the online Estate Board, as specified in the brief: gender bar, age bars,
   top countries and cities, scope + n footer, 30-day baseline card. Add a manual "paste audience" form, plus `posted_from` and
   `visual_tags` per reel.
4. Seed the board with Fred's app data from section 5 of the brief (3 reels, all posted from Turkey).
5. Also seed the Facebook vs Instagram views Fred read on 25 Nov:
   car park girl IG 435 / FB 245; Harrods four IG 169 / FB 4 (check whether FB "Needs review" is holding it);
   "Coming to get you" IG 59 / FB 304; Case File I IG 2,270 (find out whether it was boosted).
6. No browser scraping of Instagram insights without Fred's yes. Send Fred one screenshot.

== JOB 3 — PERDIMI pigs reel (Fred approved the concept)
Script: `briefs/PERDIMI-reel-pigs-script.md` (19 s, 23 shots, hook at 2.0 s). File it with the PERDIMI reels. Don't produce or
generate it until Fred says which route (real shoot or generated).

== Rules
Never delete anything. Post only the test reels in Job 0. Commit to the vault repo as usual.
Report back: first a short summary in capitals, then done / failed / needs Fred, in as few words as possible.
