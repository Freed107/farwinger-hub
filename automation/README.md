# Automation (scheduled tasks) — index

Everything that runs on a schedule for the Farwinger hub lives in **Claude → Scheduled tasks** (claude.ai).
The prompts are versioned here so a change is a normal commit, then a paste into the task.

| Task | When (Europe/London) | Connectors | Prompt file | Status |
|---|---|---|---|---|
| LinkedIn inbox sweep | Mon–Fri 08:20 and 15:20 | Gmail, Google Calendar | [linkedin/sweep.prompt.md](linkedin/sweep.prompt.md) | **to create** in claude.ai → Scheduled tasks (see linkedin/README.md → Install) |
| LinkedIn Monday review | Mon 08:40 | Gmail, Google Calendar | [linkedin/weekly.prompt.md](linkedin/weekly.prompt.md) | **to create** in claude.ai → Scheduled tasks (see linkedin/README.md → Install) |
| Pankaj accountant inbox — draft & notify | Mon–Fri 07,09,11,13,15,17 | Gmail, Drive, Calendar | (prompt lives in the task) | **disabled** since 2026-09-15 |
| Event Square QT-000130 — chase or call it dead | Mon 08:12 | Gmail, Calendar | (prompt lives in the task) | **disabled**; quote expired 2026-09-17 — delete when convenient |

Not scheduled, by design (runs in the browser whenever the hub is open): international-order phone requests
(`checkAndDraftPhoneRequests`), ShipStation/Zoho/SendCloud/eBay refresh, the LinkedIn card refresh (every 15 min).

## Why the LinkedIn tasks are not created from Claude Code
A scheduled task created from a Claude Code session carries no connectors in this organisation, so its runs would have no
Gmail or Calendar and fail. Tasks created in the claude.ai Scheduled tasks UI do carry connectors (the two older tasks above
prove it). Create them there, from the prompt files.

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
