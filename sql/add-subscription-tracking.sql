-- Add subscription tracking columns to subscriptions table
-- This migration adds expiry tracking and status management for YouTube WebSub subscriptions

-- Add new columns if they don't exist
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS
  expires_at TIMESTAMPTZ,
  last_renewed_at TIMESTAMPTZ,
  renewal_attempts INT DEFAULT 0,
  status TEXT DEFAULT 'active',  -- 'active' | 'expiring' | 'expired' | 'failed'
  error_message TEXT;

-- Set initial expires_at for existing subscriptions (assume 18 days from subscribed_at)
-- YouTube WebSub subscriptions typically expire after ~18 days (432 hours)
UPDATE subscriptions
SET expires_at = subscribed_at + INTERVAL '18 days',
    status = CASE
      WHEN subscribed_at + INTERVAL '18 days' < NOW() THEN 'expired'
      WHEN subscribed_at + INTERVAL '18 days' < NOW() + INTERVAL '2 days' THEN 'expiring'
      ELSE 'active'
    END
WHERE expires_at IS NULL;

-- Create index for faster expiry queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at ON subscriptions(expires_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
