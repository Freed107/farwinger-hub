# PERDIMI Studio: creator portal

This is Blessing Francis's portal for making PERDIMI social media. It runs on one Cloudflare Worker, with D1 for data, R2 for media and a Queue for the chat. Claude runs server-side.

> **This repository is PUBLIC.** Nothing private belongs in `perdimi-portal/`: no e-mails, phone numbers, prices, canon text, keys or tokens. Those live in Worker secrets, in D1 rows (brand knowledge) or in the estate env file.

## What she gets (iPhone, flaky connection)

| Tab | What it does |
|---|---|
| **Chat** | An instant chat with Claude (`claude-opus-5-5`, no spend cap). She can attach photos and videos. Claude guides her, but she can overrule it. Claude acts through tools: renders, posts, site ideas and team tasks. |
| **Studio** | Her renders, with status, cost, Keep / Discard / **Make final (HD)** / Cancel, and her monthly £ allowance. It also shows how much she has spent on discarded renders. |
| **Post** | Posts that are ready to go: Save the media, Copy the caption, open Instagram / Facebook / TikTok / Threads, then *Mark posted* with the link. |
| **Site** | Website ideas for perdimi.com. **Nothing changes on the site until Fred approves the idea in /admin.** |
| **More** | Resource links (Drive folder, Pinterest boards), replies from the team (SEO, marketing, creative director, film crew, Fred), and sign-out. |

How it copes with a bad connection:
- Every message goes into an on-phone outbox first. It is retried until the server confirms it. Resends are harmless, because each message carries a client id.
- Claude answers from a queue, not inside her request. If her signal drops mid-answer, the reply is still saved and appears on the next sync.
- Photos are shrunk on the phone before upload (about 1600 px for the full image, about 512 px for the preview). Videos upload in 6 MB chunks, and each chunk retries on its own.
- Media shows as small previews. Full quality loads only when she taps *Load full quality*. Previews are cached on the phone, so scrolling back costs no data.
- Sign-in is a 6-digit code she types in, so the session lands in the home-screen app and not in Safari. Sessions last 180 days.
- If e-mail doesn't arrive, Fred taps **Make a sign-in code → Send on WhatsApp** in `/admin`.

## Fred's rules, enforced in code

These are not just prompt text.

- **Low quality first.** A `final` render needs a draft she has kept. A final made without one goes to Fred for approval.
- **£30 a month without asking** (`CREATOR_BUDGET_GBP`, which can be changed in /admin). The real cost comes from the runner's **free** Higgsfield preflight *before* anything is spent. Above the allowance, the job waits for Fred.
- **Unknown credit price means everything waits for Fred.** Set *£ per Higgsfield credit* in /admin. This is the fail-safe default.
- **Website changes need Fred's approval.** Site ideas only go into a queue that only Fred can decide on.
- **Scope lock (PERDIMI, VENENVM, LUCCIVO only).**
  - The real fence is data. Claude only ever sees the knowledge Fred loads.
  - Any knowledge line that mentions a `LOCKED_TERMS` word (Aichabelle, Farwinger, Stillroom, …) is removed before Claude sees it.
  - The system prompt refuses everything else.
  - Do not paste personal or other-company material into knowledge.
- **Claude has no spending limit.** Only renders are budgeted.

## First deploy (estate Cloudflare account, the one holding perdimi.com)

```bash
cd perdimi-portal
npm install
npx wrangler d1 create perdimi-creator-portal          # paste the id into wrangler.toml
npx wrangler r2 bucket create perdimi-creator-media
npx wrangler queues create perdimi-creator-chat
npm run db:init
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY                  # send.perdimi.com is already verified
npx wrangler secret put CREATOR_EMAIL                   # Blessing's address
npx wrangler secret put CREATOR_PHONE                   # digits with country code, for the WhatsApp fallback
npx wrangler secret put RUNNER_TOKEN                    # long random string; same value in the runner env file
npx wrangler deploy
```

Optional: uncomment the `studio.perdimi.com` route in `wrangler.toml` and redeploy.

Then, in `https://<worker>/admin`, signed in as `OWNER_EMAIL`:
1. **Settings:**
   - Set *£ per Higgsfield credit* (until you do, every render waits for you).
   - Add the resource links as JSON, e.g. `[{"label":"PERDIMI shared Drive folder","url":"…"},{"label":"Pinterest: perdimi-venenvm","url":"…"}]`.
2. **Brand knowledge:** paste a cleaned PERDIMI brief, or let the runner push the canon and style book (`knowledge` command).
3. **Sign-in:** tell Blessing the URL. She enters her e-mail and types the code. If the code doesn't arrive, use the WhatsApp code.

## Runner (estate machine)

`runner/perdimi_portal_runner.py` is the estate side, following the same pattern as `aichabelle_portal_pull.py`:
- `renders`: runs the free cost preflight, reports it to the portal (which then approves or holds the job), renders the approved jobs, and uploads the full file plus a 640 px preview.
- `tasks`: files her team requests into the ledger (venture `perdimi`) and marks them pulled.
- `knowledge`: pushes the files listed in `KNOWLEDGE_FILES`.

Schedule `python perdimi_portal_runner.py all` every 2–5 minutes.

Env file (default `H:\Global-Vault\_OPERATIONS\_secrets\perdimi-portal.env`):

```
PORTAL=https://perdimi-creator-portal.<account>.workers.dev
RUNNER_TOKEN=...
HF_COST_CMD=<command printing {"credits": N} for the job JSON at {job}>
HF_RENDER_CMD=<command printing {"file": "<path>", "credits": N} for the job JSON at {job}>
KNOWLEDGE_FILES=<path to PERDIMI canon .md>;<path to style book .md>
```

**The Higgsfield calls are deliberately not hard-coded.** Plug in the estate's existing Higgsfield tooling (its free preflight, its draft/final flow, and its `--authorised-by` / `--max-usd` gate) through these two templates. The job JSON contains `kind`, `quality`, `prompt`, `aspect`, `seconds`, `ref_files` (downloaded refs) and `parent_media_id` (the kept draft, for a final).

## Not done here: these need Fred

- **Meta and TikTok access:**
  - Meta: give her a role on the PERDIMI Page and Instagram in Business Suite.
  - TikTok: give her the @perdimi.parfum login or a Business Center seat.
  - The portal prepares posts. She publishes them from the apps on her phone. Auto-publishing through the Graph or TikTok APIs is not built.
- **Drive:** share the PERDIMI creator folder with her as **Contributor**. In a shared drive, Contributors can add and edit but **cannot delete**. Share that one folder, not the whole LUCCIVO drive: the drive holds material outside her scope.
- **The Aichabelle salon portal's source was not on Google Drive** (it is probably only on H:). This portal is a fresh build. It keeps the same pull contract (`GET/POST /api/pull/tasks`), owner/creator roles, revoke-ends-sessions behaviour and `/admin`.

## Local development and tests

```bash
cp .dev.vars.example .dev.vars   # dummy values
npx wrangler d1 execute perdimi-creator-portal --local --file=schema.sql
npx wrangler dev --local
npm run check                    # syntax check
```

Setting `ANTHROPIC_BASE_URL` in `.dev.vars` points Claude at a mock API for tests.
