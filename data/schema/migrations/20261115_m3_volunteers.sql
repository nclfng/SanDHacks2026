-- M3: volunteers. JOIN <zip> VOLUNTEER on Messenger sets volunteer_at; only volunteers get neighbors' help
-- requests and can take one. Additive and idempotent.
alter table subscribers add column if not exists volunteer_at timestamptz;
