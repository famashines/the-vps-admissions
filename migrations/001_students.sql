create table admission_counters (
  year int primary key,
  last int not null
);

create table students (
  student_id uuid primary key,
  admission_number text not null unique,
  first_name text not null,
  last_name text not null,
  date_of_birth date not null,
  gender text not null check (gender in ('female', 'male')),
  guardian_name text not null,
  guardian_relation text not null check (guardian_relation in ('father', 'mother', 'guardian')),
  guardian_phone text not null,
  registered_at timestamptz not null,
  registered_by uuid not null
);

create table events (
  event_id uuid primary key,
  event_type text not null,
  version int not null,
  aggregate_id uuid not null,
  aggregate_version int not null,
  occurred_at timestamptz not null,
  correlation_id uuid not null,
  causation_id uuid not null unique,
  issued_by uuid not null,
  payload jsonb not null,
  unique (aggregate_id, aggregate_version)
);
