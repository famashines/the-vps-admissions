alter table events add column published_at timestamptz;
create index events_unpublished on events (occurred_at, aggregate_version) where published_at is null;
