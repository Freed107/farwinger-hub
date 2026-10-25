# Automation (scheduled tasks) — index

Everything that runs on a schedule for the Farwinger hub lives in **Claude → Scheduled tasks** (claude.ai).
The prompts are versioned here so a change is a normal commit, then a paste into the task.

| Task | When (Europe/London) | Connectors | Prompt file | Status |
|---|---|---|---|---|
| LinkedIn inbox sweep | Mon–Fri 08:20 and 15:20 | Gmail, Google Calendar | [linkedin/sweep.prompt.md](linkedin/sweep.prompt.md) | enabled 2026-10-25, fires into the Claude Code session that built it |
| LinkedIn Monday review | Mon 08:40 | Gmail, Google Calendar | [linkedin/weekly.prompt.md](linkedin/weekly.prompt.md) | enabled 2026-10-25, fires into the Claude Code session that built it |
| Pankaj accountant inbox — draft & notify | Mon–Fri 07,09,11,13,15,17 | Gmail, Drive, Calendar | (prompt lives in the task) | **disabled** since 2026-09-15 |
| Event Square QT-000130 — chase or call it dead | Mon 08:12 | Gmail, Calendar | (prompt lives in the task) | **disabled**; quote expired 2026-09-17 — delete when convenient |

Not scheduled, by design (runs in the browser whenever the hub is open): international-order phone requests
(`checkAndDraftPhoneRequests`), ShipStation/Zoho/SendCloud/eBay refresh, the LinkedIn card refresh (every 15 min).

## How the LinkedIn tasks run
A task that starts a fresh session gets no connectors when created from Claude Code in this organisation. So both LinkedIn
tasks fire into the Claude Code session that built them, which already has Gmail and Google Calendar. Their run summaries
appear in that session. To move them to standalone tasks, create them in claude.ai → Scheduled tasks with the Gmail and
Google Calendar connectors and paste the prompt files, then delete the session-bound ones.

## Rules every task follows
- Read-only on third-party platforms. Gmail: drafts only, never send. One calendar event per run at most.
- A task that cannot reach a tool ends quietly instead of retrying in a loop.
- Dashboard state goes through the Cloudflare KV proxy (`farwinger-proxy.fredwalkers.workers.dev`, keys below).
  The cloud environment's network policy must allow that host or the write is skipped (the task says so in its summary).

## KV keys used by the dashboard
| Key | Written by | Read by | Shape |
|---|---|---|---|
| `linkedin_inbox` | LinkedIn sweep, and the dashboard itself | dashboard | `{updated, source, items:[…]}` — see linkedin/README.md |
| `linkedin_done` | dashboard only | dashboard | `{ "<item id>": "<ISO when dismissed>" }` |
| `linkedin_posts` | LinkedIn Monday review | dashboard | `{updated, posts:[{id,text,created}]}` |
| `fulfilStages`, production checks | dashboard | dashboard | pre-existing |
