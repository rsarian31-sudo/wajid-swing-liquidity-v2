ALTER TABLE users ADD COLUMN telegram_connect_token TEXT;
ALTER TABLE users ADD COLUMN telegram_connect_expires_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_connect_token ON users(telegram_connect_token);
