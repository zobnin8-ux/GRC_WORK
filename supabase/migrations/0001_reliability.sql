-- 0001_reliability.sql — GRC слой надёжности
-- Состояние, очередь работ, аудит, health-check и реконсиляция.
-- Применять в Supabase → SQL Editor (проект GRC_WORK) или положить в
-- supabase/migrations/ и прогнать через CLI. Идемпотентно: повторный
-- запуск не падает. gen_random_uuid() в Postgres 17 встроен.

create table if not exists leads (
  id                uuid primary key default gen_random_uuid(),
  idempotency_key   text unique not null,        -- md5(lower(email) || phone || source)
  source            text not null,               -- web_form | cold_email | vapi_inbound | referral
  email             text,
  phone             text,
  raw               jsonb not null,              -- сырой payload как пришёл
  pipedrive_deal_id bigint,                       -- заполняется после синка
  status            text not null default 'new', -- new | enriched | synced | contacted | orphaned | dead
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists jobs (
  id              uuid primary key default gen_random_uuid(),
  type            text not null,                  -- enrich | pipedrive_upsert | vapi_call | send_email | estimate
  lead_id         uuid references leads(id),
  payload         jsonb not null default '{}',
  idempotency_key text not null,                  -- type + натуральный ключ операции
  status          text not null default 'pending',-- pending | processing | done | failed | dead
  attempts        int  not null default 0,
  max_attempts    int  not null default 5,
  next_run_at     timestamptz default now(),
  locked_at       timestamptz,
  last_error      text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (type, idempotency_key)                  -- защита от дублей на уровне БД
);

create table if not exists job_runs (
  id          bigserial primary key,
  job_id      uuid references jobs(id),
  attempt     int  not null,
  status      text not null,                      -- ok | error
  service     text,                               -- pipedrive | vapi | openai | smtp
  latency_ms  int,
  error       text,
  started_at  timestamptz default now(),
  finished_at timestamptz
);

create table if not exists health_checks (
  id         bigserial primary key,
  service    text not null,
  ok         boolean not null,
  latency_ms int,
  detail     text,
  checked_at timestamptz default now()
);

create table if not exists reconciliation_log (
  id         bigserial primary key,
  kind       text not null,                       -- orphaned_deal | lead_no_touch | stuck_job
  ref_id     text,
  detail     jsonb,
  resolved   boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_jobs_status_next on jobs (status, next_run_at);
create index if not exists idx_leads_status    on leads (status);
