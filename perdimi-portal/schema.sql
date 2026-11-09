-- PERDIMI creator portal - D1 schema. Idempotent: safe to run again.
-- wrangler d1 execute perdimi-creator-portal --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  role        TEXT NOT NULL CHECK (role IN ('owner','creator')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

-- One-time 6-digit sign-in codes (typed in, so the iPhone home-screen app gets the session, not Safari).
CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  title       TEXT NOT NULL DEFAULT 'New conversation',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  busy        INTEGER NOT NULL DEFAULT 0      -- 1 while Claude is answering
);

-- Every row is append-only. kind:
--   'user'       what she typed (+ media ids)                       visible
--   'assistant'  Claude's final text for a turn                      visible
--   'note'       system notice (render ready, approval, error)       visible
--   'api'        raw API turn (assistant content incl. thinking, or tool_result list) - replayed unchanged, never shown
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT UNIQUE,                    -- idempotency key from the phone's outbox
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  kind        TEXT NOT NULL CHECK (kind IN ('user','assistant','note','api')),
  api_role    TEXT,                           -- for kind='api': 'assistant' | 'user'
  body        TEXT,                           -- text, or JSON content for kind='api'
  media_ids   TEXT,                           -- JSON array
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);

CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,              -- random id
  kind         TEXT NOT NULL CHECK (kind IN ('image','video','file')),
  mime         TEXT NOT NULL,
  r2_key       TEXT NOT NULL,                 -- full file
  preview_key  TEXT,                          -- small jpeg (image preview / video poster)
  bytes        INTEGER,
  source       TEXT NOT NULL CHECK (source IN ('upload','render')),
  quality      TEXT CHECK (quality IN ('draft','final')),
  render_id    INTEGER,
  uploaded_by  INTEGER,
  caption      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Render jobs. Executed by the estate runner (runner/perdimi_portal_runner.py), never by the Worker.
-- status flow: estimating -> approved | awaiting_owner -> running -> done | failed
--              awaiting_owner -> approved | rejected ; any open state -> cancelled
CREATE TABLE IF NOT EXISTS renders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id        INTEGER,
  requested_by     INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('image','video')),
  quality          TEXT NOT NULL CHECK (quality IN ('draft','final')),
  prompt           TEXT NOT NULL,
  aspect           TEXT NOT NULL DEFAULT '9:16',
  seconds          INTEGER,
  ref_media        TEXT,                      -- JSON array of media ids
  parent_id        INTEGER,                   -- the kept draft a final is made from
  est_credits      REAL,
  est_gbp          REAL,
  actual_credits   REAL,
  actual_gbp       REAL,
  status           TEXT NOT NULL DEFAULT 'estimating',
  hold_reason      TEXT,                      -- why it waits for Fred
  verdict          TEXT CHECK (verdict IN ('keep','discard')),
  result_media_id  TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS renders_status ON renders(status);

-- Posts she prepares / logs for Meta (Instagram, Facebook) and TikTok.
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL CHECK (platform IN ('instagram','facebook','tiktok','threads')),
  media_ids   TEXT NOT NULL,                  -- JSON array
  caption     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','posted','dropped')),
  url         TEXT,
  created_by  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at   TEXT
);

-- Website ideas. Nothing on perdimi.com changes until Fred approves.
CREATE TABLE IF NOT EXISTS suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  page        TEXT,
  media_ids   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  owner_note  TEXT,
  created_by  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT
);

-- Jobs for the team (SEO, marketing, creative director, film crew, Fred). Same pull contract as the
-- Aichabelle salon portal: GET/POST /api/pull/tasks with the runner token, tasks.pulled_at marks them filed.
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team         TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  urgency      TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('urgent','soon','normal')),
  person_name  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  pulled_at    TEXT,
  ledger_id    TEXT,
  done_at      TEXT,
  reply        TEXT
);

-- Knowledge Claude may use (brand brief, style rules, resources). Written by Fred in /admin or by the runner.
-- Nothing outside PERDIMI / VENENVM / LUCCIVO belongs here - this is the real fence: Claude cannot leak what it never sees.
CREATE TABLE IF NOT EXISTS knowledge (
  key         TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  person_id  INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT
);
