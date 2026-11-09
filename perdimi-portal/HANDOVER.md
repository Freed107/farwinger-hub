# HANDOVER: PERDIMI creator portal, to deploy from Fred's PC

From cloud session `session_01XxfgGfPb3iLLQM8bB3oyr9` (9 Nov 2026). Branch `claude/perdimi-creator-portal-u3f8mc`.
Read `perdimi-portal/README.md` first. This file is the to-do list.

> **This repo is PUBLIC.** Do not commit Blessing's e-mail or phone, the price, canon text, account IDs, keys or tokens.
> Her e-mail and phone are in the chat history of the session above. Fred also has them. They go in as Worker secrets only.

## Status

| Part | State |
|---|---|
| Worker code (`src/`), D1 schema, phone app (`public/`), `/admin` | Built, committed, pushed |
| Strict reel order (talk → brief → storyboard → 480p → 720p) | Built. The server refuses anything out of order. |
| Local tests (wrangler dev): ~40 API checks, chat tool loop vs mock API, 27 reel checks, iPhone offline outbox | All passed, except one reel check that failed only because of a bug in the test itself; the data showed correct behaviour |
| Real Claude API, real Higgsfield, real deploy | **NOT tested. Nothing deployed.** |

## Do these in order

1. **Cloudflare.** Use the estate account that holds the perdimi.com zone. Use the estate token and account ID the way `deploy.ps1` does. A bare wrangler login can land in the wrong account (the known estate trap).
   ```
   cd perdimi-portal
   npm install
   npx wrangler d1 create perdimi-creator-portal        # put the id in wrangler.toml (database_id)
   npx wrangler r2 bucket create perdimi-creator-media
   npx wrangler queues create perdimi-creator-chat
   npm run db:init
   ```
2. **Secrets.** Use `npx wrangler secret put <NAME>` for each:
   - `ANTHROPIC_API_KEY`: from console.anthropic.com. Billed per use. Fred wants no spend cap.
   - `RESEND_API_KEY`: send.perdimi.com is already verified on Resend.
   - `CREATOR_EMAIL`: Blessing's address.
   - `CREATOR_PHONE`: her number, digits only with the country code. It powers the WhatsApp code button in /admin.
   - `RUNNER_TOKEN`: a new long random string. Put the same value in the runner env file (step 6).
3. **Deploy.** Run `npx wrangler deploy`, then open `https://<worker>.workers.dev/admin`. Sign in as administrator@farwinger.com: request a code by e-mail and type it in.
   - Optional: uncomment the `studio.perdimi.com` route in `wrangler.toml`, then redeploy.
4. **/admin settings.**
   - **£ per Higgsfield credit.** Until this is set, every render waits for Fred.
   - **Monthly allowance:** £30.
   - **Who approves reel steps:** Blessing (the default) or "Only me". Ask Fred which.
   - **Resource links** (JSON): the PERDIMI Drive folder and the Pinterest boards. The boards are under the vincenzoluccivo account: perdimi-venenvm, deadly-poison, social-design-2, fragrance, interior-furniture, perdimi-furniture. Check the URLs before adding them; they were inferred from board names.
5. **Brand knowledge** (/admin → Brand knowledge). Load a PERDIMI/VENENVM/LUCCIVO-only brief, built from "PERDIMI - CANON (read first).md" and the Style Book (LUCCIVO shared drive). Fred reviews it before it goes in.
   - Lines that mention the `LOCKED_TERMS` words are stripped automatically. Still remove anything personal, or about other companies, by hand.
   - Keep the canon rules in: the price is never in public copy, no conspiracy theories as fact, and no more than 3 poison stories in a row.
6. **Runner** on the H: machine: `runner/perdimi_portal_runner.py`.
   - Env file: `H:\Global-Vault\_OPERATIONS\_secrets\perdimi-portal.env`, containing `PORTAL`, `RUNNER_TOKEN`, `HF_COST_CMD`, `HF_RENDER_CMD` and `KNOWLEDGE_FILES`.
   - Point `HF_COST_CMD` / `HF_RENDER_CMD` at the estate's existing Higgsfield tooling:
     - a free cost preflight first;
     - render at exactly the job's `resolution` (480p / 720p), never upscaled;
     - the `--authorised-by` / `--max-usd` gate.
   - Test with `python perdimi_portal_runner.py renders --dry-run`, then schedule `... all` every 2–5 minutes as a Windows task.
   - The ledger personas in `TEAM_PERSONA` are guesses: seo=seona, marketing=tim, creative_director=rhoden, film_crew=nick. Check them.
7. **Smoke test before she gets the link:**
   - Sign in as the creator using the /admin WhatsApp code.
   - Send a chat message and get a real reply.
   - Ask about something locked (for example "Aichabelle") and check that it refuses.
   - Run one storyboard frame through the runner and check its cost and status.
8. **Fred's actions, outside the code:**
   - Give her a role on the PERDIMI Page and Instagram in Meta Business Suite, plus the TikTok @perdimi.parfum login or a Business Center seat.
   - Share ONE PERDIMI creator Drive folder with her as **Contributor** (can add and edit, cannot delete). Never share the whole LUCCIVO drive.
   - Send her the URL. On her iPhone: Safari → Share → Add to Home Screen.

## Open questions for Fred

- Fred allowed her to query LUCCIVO, but the canon (29 Oct) says PERDIMI was cut off from Luccivo. The build follows Fred's instruction. Confirm.
- "Verbal" was built as the talk step (typing or iPhone dictation). Real voice calls are not built.
- The Aichabelle salon portal's source was not on Drive (probably only on H:). If it turns up, compare it for anything worth reusing.
- No PR opened yet. Open one only if Fred asks.
