CREATE TABLE notification_devices (
  id text PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('customer','rider','admin')),
  owner_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web','android')),
  fid text NOT NULL,
  device_key text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','invalid')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(platform,fid), UNIQUE(platform,device_key)
);
CREATE INDEX notification_devices_owner_idx ON notification_devices(owner_type,owner_id,status);

CREATE TABLE notification_preferences (
  owner_type text NOT NULL CHECK (owner_type IN ('customer','rider','admin')),
  owner_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('order_updates','payments','referrals_rewards','promotions','announcements')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(owner_type,owner_id,category)
);

CREATE TABLE notification_templates (
  event_type text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  in_app_enabled boolean NOT NULL DEFAULT true,
  push_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL,
  updated_by text,
  data jsonb NOT NULL
);

CREATE TABLE notification_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('customer','rider','admin')),
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX notification_events_owner_created_idx ON notification_events(owner_type,owner_id,created_at DESC);

CREATE TABLE notification_outbox (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES notification_events(event_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  owner_type text NOT NULL CHECK (owner_type IN ('customer','rider','admin')),
  owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','processing','accepted','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL,
  processed_at timestamptz,
  data jsonb NOT NULL,
  UNIQUE(event_id,owner_type,owner_id)
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox(status,next_attempt_at,created_at);

CREATE TABLE notification_campaigns (
  id text PRIMARY KEY,
  title text NOT NULL,
  category text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app','push','both')),
  target jsonb NOT NULL,
  destination text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','scheduled','queued','processing','accepted','partial','recorded','no_devices','failed','cancelled')),
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  processed_at timestamptz,
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  data jsonb NOT NULL
);
CREATE INDEX notification_campaigns_due_idx ON notification_campaigns(status,scheduled_at);
CREATE INDEX notification_campaigns_history_idx ON notification_campaigns(created_at DESC);

CREATE TABLE notification_delivery_logs (
  id text PRIMARY KEY,
  campaign_id text REFERENCES notification_campaigns(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  event_id text,
  owner_type text NOT NULL CHECK (owner_type IN ('customer','rider','admin')),
  owner_id text NOT NULL,
  device_id text,
  status text NOT NULL CHECK (status IN ('queued','accepted','failed','invalid_device','skipped')),
  attempted_at timestamptz NOT NULL,
  provider_message_id text,
  error_code text,
  data jsonb NOT NULL
);
CREATE INDEX notification_delivery_logs_campaign_idx ON notification_delivery_logs(campaign_id,attempted_at DESC);
CREATE INDEX notification_delivery_logs_recipient_idx ON notification_delivery_logs(owner_type,owner_id,attempted_at DESC);

CREATE TABLE rider_notifications (
  id text PRIMARY KEY,
  rider_id text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX rider_notifications_owner_idx ON rider_notifications(rider_id,created_at DESC);
