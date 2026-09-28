CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount_usdt REAL NOT NULL,
  network TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT UNIQUE,
  from_address TEXT,
  block_number INTEGER,
  verified_at INTEGER,
  subscription_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status,expires_at);
