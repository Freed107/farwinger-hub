# LinkedIn automation

**Goal:** nothing on LinkedIn that needs a human reply goes unseen, with zero LinkedIn API, zero tokens and one place to look: the
**LinkedIn · needs your reply** card at the top of the Order Hub's Overview tab (`index.html`, block marked `LINKEDIN`).

## How it works (one picture)

```
LinkedIn ──notification email──▶ Gmail (administrator@farwinger.com)
                                   │
          ┌────────────────────────┼─────────────────────────────┐
          ▼                        ▼                             ▼
 Order Hub (browser)      Scheduled task "LinkedIn inbox sweep"   Scheduled task "LinkedIn Monday review"
 reads Gmail worker       Mon–Fri 08:20 / 15:20                   Mon 08:40
 /inbox?q=from:linkedin   • classifies with the same rules        • lists items > 5 days old (likely unanswered)
 classifies client-side   • reads bodies → exact thread links     • writes 3 post ideas → KV linkedin_posts
 (LINKEDIN.rules)         • Gmail DRAFT reply for InMails         • 1 calendar event
          │               • writes KV linkedin_inbox
          │               • 1 calendar event only if NEW items
          ▼                        │
     merge by Gmail id ◀───────────┘      "Done" → KV linkedin_done (hidden on every device)
          ▼
   card on Overview: Open ↗ (LinkedIn deep link) · Gmail · Done · Post ↗ (composer pre-filled)
```

Why email? LinkedIn exposes no inbox API. Every message, InMail, connection request and Services-Marketplace lead already
arrives as an email, and InMail emails carry `Reply-To: <token>@reply.linkedin.com`, so a reply sent from Gmail lands in the
LinkedIn thread. Posting uses LinkedIn's own composer URL (`/feed/?shareActive=true&text=…`) — no OAuth to expire.

## What counts as actionable (the only thing you normally maintain)

Edit `LINKEDIN.rules` in `index.html` (first match wins) and mirror the wording in `sweep.prompt.md` STEP 1.

| kind | label | sender / subject pattern | urgent | shown for |
|---|---|---|---|---|
| message | Message | `messaging-digest-noreply@linkedin.com`, "X just messaged you" | yes | 30 days |
| inmail | InMail | `hit-reply@linkedin.com` (reply by email works) | yes | 30 days |
| lead | Lead | `notifications-noreply@`, "… request from NAME … are available. Show Requests." | yes | 14 days |
| lead | Lead? | "… opportunities may be available. Check requests." | no | 7 days |
| invite | Invitation | `invitations@linkedin.com`, "I want to connect" / "… is waiting for your response" | no | 14 days |
| invite | Invitations | "You have N new invitation(s)" digest | no | 10 days |

Noise that is deliberately ignored: "you may know", "is popular in your network", "are hiring", "accepted your invitation",
"role hired", "career trends", newsletters. Two LinkedIn accounts land in this mailbox and are labelled on the card:
`friedemann@farwinger.com` → **Friedemann**, `vincenzo.luccivo@luccivo.com` → **Vincenzo** (`LINKEDIN.accounts`).
Drafts are only ever written for Friedemann's InMails.

## Data contract (KV key `linkedin_inbox`)

```json
{ "updated": "2026-10-25T08:21:00Z", "source": "sweep|dash",
  "items": [ { "id": "<gmail message id>", "threadId": "<gmail thread id>",
               "kind": "message|inmail|lead|invite", "label": "Message|InMail|Lead|Lead?|Invitation|Invitations",
               "urgent": true, "account": "Friedemann|Vincenzo", "who": "Name — headline",
               "preview": "≤160 chars of what they wrote", "url": "https://www.linkedin.com/…",
               "replyable": false, "received": "<ISO>", "draft": "<gmail draft id, optional>" } ] }
```
The card merges this with what it classifies itself; for the same `id` the sweep's copy wins (it has read the body).
`linkedin_done` is `{ "<id>": "<ISO>" }` and is written by the card only. Dismissals are forgotten after 90 days.

## Install status

Both tasks were created on 2026-10-25 and are enabled. They fire into the Claude Code session that built this, because
tasks created from Claude Code that start a fresh session get no connectors in this organisation. That session has Gmail
and Google Calendar, so the runs work; their summaries show up in that session.

Optional, for standalone tasks: in claude.ai → Scheduled tasks → New, use the schedule above (`20 8,15 * * 1-5` and
`40 8 * * 1`, Europe/London), add the Gmail and Google Calendar connectors, paste the prompt files' bodies, then delete
the session-bound tasks so nothing runs twice.

Until the sweep exists, the card still works: it reads Gmail through the Gmail worker whenever the hub is open (worker secret
set once via the API Key button). What you lose without the sweep: exact thread links, InMail draft replies, calendar alerts.

## Day-to-day

- **Reply to a message/lead/invite:** click **Open ↗** (goes to the thread / requests page / invitation manager), answer on
  LinkedIn, click **Done**.
- **Reply to an InMail:** the sweep has usually left a draft in Gmail ("draft ready" pill). Open Gmail, check it, pick
  `friedemann@farwinger.com` in the From dropdown if it is not already selected (LinkedIn accepts replies from the address
  it emailed), send. Then **Done**.
- **Post:** Monday's three ideas appear under the list. **Post ↗** opens LinkedIn with the text filled in; you still press
  Post there. **Dismiss** hides an idea.
- **Nothing shows and the footer says "gmail worker secret not set":** click **API Key** on the Customer Service tab and
  enter the Gmail worker secret once per browser. The card then self-populates from Gmail without any scheduled task.
- **Footer says "no cloud list yet" for days:** the scheduled task cannot reach the KV proxy. Fix: cloud environment
  → Edit → Network access → add `farwinger-proxy.fredwalkers.workers.dev` under Allowed domains. Until then the card
  still works from Gmail; only the exact thread links and "draft ready" pills come from the sweep.

## Changing things

| I want to… | Do this |
|---|---|
| change cadence | Claude → Scheduled tasks → "LinkedIn inbox sweep" → schedule (cron is `CRON_TZ=Europe/London 20 8,15 * * 1-5`). Keep the "previous run" wording in STEP 5 of the prompt in sync. |
| stop the calendar alerts | delete STEP 5 from `sweep.prompt.md`, paste into the task. The card is unaffected. |
| add a new kind of LinkedIn email | add a row to `LINKEDIN.rules` (test + who + maxAgeDays) and a bullet to STEP 1 of the sweep prompt. |
| change the reply voice | STEP 4 of `sweep.prompt.md`. |
| turn off drafting | delete STEP 4. |
| post automatically instead of via the composer | connect a LinkedIn account on the Zapier MCP (the LinkedIn app with the "share" action is already enabled there; claude.ai → Settings → Connectors → Zapier) and add a Zapier step to the Monday prompt. Not done on purpose: unreviewed posting is the one thing that can embarrass. |

## Known limits (honest list)
- The card's own Gmail path depends on the `farwinger-gmail` worker's `/inbox` endpoint returning LinkedIn mail (it passes
  `?q=from:linkedin.com newer_than:30d`; if the worker ignores `q`, the default inbox feed is filtered client-side).
  The worker source is not in this repo, so this could not be tested from the build environment.
- Gmail labels could not be created with the current Gmail connector permissions, so the sweep dedupes by time window,
  not by label. Reconnect Gmail with label permissions if you want a `LinkedIn/needs-reply` label too.
- "Done" is manual. LinkedIn does not email you when you reply, so the card cannot tell on its own.
