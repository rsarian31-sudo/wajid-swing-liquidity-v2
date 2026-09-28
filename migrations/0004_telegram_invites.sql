CREATE TABLE IF NOT EXISTS telegram_invites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  invite_link TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  joined_chat_id TEXT,
  joined_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telegram_invites_user ON telegram_invites(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_invites_expiry ON telegram_invites(expires_at);
