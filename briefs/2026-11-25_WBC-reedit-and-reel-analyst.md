# WBC re-edit + reel analyst — brief (Fred, 2026-11-25)

For: the PC-side shortform pipeline (Nick = editor, Tim = marketing/analyst, Stan = ops),
vault `H:\Farwinger-Vault\_OPERATIONS\shortform\`.

## 0. Decision (Fred, not a hypothesis)

- **@farwinger: no change.** Same spec, same cadence (MON–FRI 17:00), same one-take 8–12 s cuts. The recipe works.
- **@woodenballsco: stop reposting @farwinger files.** Fred's read: the reposts do not perform and @farwinger does.
  Working explanation: Instagram treats a re-upload of the same clip on a second account as non-original
  (fingerprint match) and limits its reach. A different edit is a different video; the same file is not.
- **WBC gets its own edits, target ~20 s (18–24 s), built from 2+ takes of the same scene.**

## 0b. Approved strategy (Fred, 2026-11-25)

1. Originals only on WBC: nothing ever posted on @farwinger.
2. Two formats, 10 posts each: **A** = 20 s multi-take W## edits (section 1); **B** = 8–12 s single takes never
   posted on @farwinger. B isolates "repost penalty" from "too short".
3. Retail framing: last seconds show the finished product, size and wood, then "shop link in bio". @farwinger stays the workshop.
4. 3 posts a week, alternating A/B, posted as Instagram Trial Reels (non-followers first).
5. After 10 of each: compare day-7 median views; the winner becomes the WBC format, then test hook or caption next.

## 1. Editor (Nick) — WBC cut spec

Every WBC reel is a NEW edit. Never upload a file that has been posted on @farwinger, trimmed or not.

1. **Group takes by scene first.** Fred records several bits per scene (same object, same lathe, same session):
   group the source files by shoot + object + date (EXIF time within ~2 h, same LOOK).
   That grouping is the material list; a single take is not enough for a WBC edit.
2. **Structure, 18–24 s, 3–5 shots:**
   - 0–2 s: action from frame 0 (spray / tool already cutting) — same hook rule as @farwinger.
   - middle: part 1 → part 2 → (part 3) of the SAME piece, in process order (rough → shape → finish).
   - last 3–4 s: the finished object (ball off the lathe, in hand, or on the table). The payoff must be visible.
3. Hard cuts on motion, no transitions, no zooms, no text animation. Native lathe audio continuous across cuts
   (crossfade 4–6 frames at each cut so it doesn't click).
4. 1080×1920, native portrait only, no upscaling from landscape.
5. Naming: `W##` (W for WBC edits) with a `parts` field in the queue listing each source file + in/out times,
   so the dupe gate can see which takes were used. A W-clip may reuse a take already posted on @farwinger
   **only if** the W-clip is ≥ 2× that clip's length and the take is ≤ 40 % of the W-clip.
6. If a scene has only one usable take: do not cut it for WBC. Log it as "single-take, skip".

Start with the scenes behind @farwinger's best performers (by views, age-matched) — those are proven subjects,
re-told as a longer story.

## 2. Gate changes (Stan)

- `instagram:woodenballsco` selector: only `W##` clips are eligible. A/B/G clips refused for this channel.
- Keep the WBC cadence as set on 2026-11-20 only if the W-queue holds ≥ 5 clips; otherwise drop to MON/WED/FRI
  rather than post reposts to fill slots.

## 3. Analyst (Tim) — scheduled, not on request

New scheduled task `Shortform-Analyst`, **Mondays 08:00 and Thursdays 08:00**, read-only:

1. Pull views, reach, avg watch time, % watched, shares, saves per reel for `instagram:farwinger` and
   `instagram:woodenballsco` (Graph API insights, same System User token as the poster).
2. Age-match: compare each reel at day 3 and day 7 only.
3. Report, ≤ 15 lines, to `_OPERATIONS\monitoring\shortform-analyst-YYYY-MM-DD.md` and a calendar popup titled
   `Reels: FW median N / WBC median N` with:
   - median views day 7, per account, last 4 weeks;
   - WBC repost (A/B/G) vs WBC re-edit (W) medians, once ≥ 5 W clips are 7 days old;
   - top 3 / bottom 3 of the week with one line on what differs (length, hook, shots, payoff shown);
   - one recommended change for next week, stated as a decision with the number behind it.
4. Never posts, never edits the queue. If insights can't be read, the popup says so — silence is not allowed.

## 4. Success test

After 10 W clips are 7 days old: WBC median day-7 views on W clips vs WBC median on reposts (A/B/G).
- W ≥ 2× reposts → keep, make W the only WBC format.
- W < 2× → Tim proposes the next variable (hook, length 15 vs 30 s, caption), one at a time.
