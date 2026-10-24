// family_share schema (SQLite). Applied idempotently at startup by openDb().
// Kept as a TS string so it survives bundling.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS family (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  aliases      TEXT NOT NULL DEFAULT '[]',          -- JSON string[]
  role         TEXT NOT NULL CHECK (role IN ('adult', 'kid', 'relative')),
  language     TEXT NOT NULL DEFAULT 'zh-CN',
  quiet_start  TEXT NOT NULL DEFAULT '22:00',
  quiet_end    TEXT NOT NULL DEFAULT '07:30',
  digest_time  TEXT DEFAULT '07:30',
  color        TEXT NOT NULL DEFAULT '#6b7280',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash   TEXT PRIMARY KEY,                    -- sha256 hex of the raw token
  member_id    TEXT NOT NULL REFERENCES members(id),
  created_by   TEXT REFERENCES members(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,                                -- first use
  use_count    INTEGER NOT NULL DEFAULT 0,          -- invites are reusable (max 5) until expiry: iOS home-screen apps have separate storage from Safari
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,                    -- sha256 hex of the cookie value
  member_id    TEXT NOT NULL REFERENCES members(id),
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('task', 'request', 'idea', 'reminder')),
  title            TEXT NOT NULL,
  details          TEXT,
  status           TEXT NOT NULL CHECK (status IN ('open', 'pending', 'accepted', 'declined', 'in_progress', 'blocked', 'done', 'dropped')),
  owner_id         TEXT REFERENCES members(id),
  created_by       TEXT NOT NULL REFERENCES members(id),
  requested_by     TEXT REFERENCES members(id),
  due_at           TEXT,
  due_date         TEXT,
  snoozed_until    TEXT,
  snooze_count     INTEGER NOT NULL DEFAULT 0,
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  parent_id        TEXT REFERENCES items(id),
  tags             TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT,
  responded_at     TEXT,
  last_activity_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id, status);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('member', 'ai', 'system')),
  member_id   TEXT REFERENCES members(id),
  text        TEXT NOT NULL,
  utterance_id TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_item ON notes(item_id);

CREATE TABLE IF NOT EXISTS utterances (
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL REFERENCES members(id),
  source          TEXT NOT NULL CHECK (source IN ('text', 'voice', 'clarification', 'wechat', 'whatsapp')),
  text            TEXT NOT NULL,
  reply           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('processing', 'done', 'clarify', 'error', 'undone')),
  clarification   TEXT,                             -- JSON Clarification | null
  reply_to        TEXT REFERENCES utterances(id),
  error           TEXT,
  audio_path      TEXT,
  model           TEXT,
  usage           TEXT,                             -- JSON token usage summary
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utterances_created ON utterances(created_at);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT REFERENCES items(id),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('member', 'ai', 'system')),
  member_id     TEXT REFERENCES members(id),
  type          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',         -- JSON
  utterance_id  TEXT REFERENCES utterances(id),
  undone        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
CREATE INDEX IF NOT EXISTS idx_events_utterance ON events(utterance_id);

-- Outbox for every notification (immediate or future). The scheduler delivers rows whose fire_at has passed.
CREATE TABLE IF NOT EXISTS notifications (
  id                  TEXT PRIMARY KEY,
  member_id           TEXT NOT NULL REFERENCES members(id),
  item_id             TEXT REFERENCES items(id),
  kind                TEXT NOT NULL,
  fire_at             TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  url                 TEXT NOT NULL,
  actions             TEXT NOT NULL DEFAULT '[]',   -- JSON NotificationAction[]
  dedupe_key          TEXT NOT NULL UNIQUE,
  respect_quiet_hours INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled', 'failed', 'skipped')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  sent_at             TEXT,
  last_error          TEXT,
  utterance_id        TEXT REFERENCES utterances(id),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(status, fire_at);
CREATE INDEX IF NOT EXISTS idx_notifications_item ON notifications(item_id);

-- Per-channel delivery log (one notification can go out on several channels)
CREATE TABLE IF NOT EXISTS deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id  TEXT NOT NULL REFERENCES notifications(id),
  channel          TEXT NOT NULL,
  ok               INTEGER NOT NULL,
  error            TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id               TEXT PRIMARY KEY,
  member_id        TEXT NOT NULL REFERENCES members(id),
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT,
  created_at       TEXT NOT NULL,
  last_success_at  TEXT,
  failure_count    INTEGER NOT NULL DEFAULT 0
);

-- Non-push channels per member (ntfy topic, wxpusher uid, ...)
CREATE TABLE IF NOT EXISTS member_channels (
  member_id   TEXT NOT NULL REFERENCES members(id),
  channel     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config      TEXT NOT NULL DEFAULT '{}',           -- JSON
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (member_id, channel)
);

-- Small key/value store for scheduler bookkeeping (e.g. last digest run)
CREATE TABLE IF NOT EXISTS kv (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- One-time codes to bind an external account (e.g. a WeChat openid) to a member: member sends "绑定 123456"
CREATE TABLE IF NOT EXISTS bind_codes (
  code        TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id),
  channel     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

-- Inbound WeChat message dedupe (WeChat retries after 5 s, up to 3 times)
CREATE TABLE IF NOT EXISTS wechat_inbound (
  msg_id      TEXT PRIMARY KEY,
  openid      TEXT NOT NULL,
  msg_type    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`
