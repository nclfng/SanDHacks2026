-- M3: neighbor blast. A help request is messaged to subscribers in the caller's zip; the first YES <id> takes it.
-- Additive and idempotent.
alter table requests add column if not exists neighbors_messaged int;
alter table requests add column if not exists volunteer_hash text;
