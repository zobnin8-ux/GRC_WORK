-- 0006_dashboard_rpc.sql — RPC под первый экран дашборда (grc-dashboard-screen-1.md).
--
-- Операционные таблицы под RLS без политик → фронт с anon-ключом их напрямую не
-- читает. Поэтому каждая dash_*-функция:
--   * SECURITY DEFINER — выполняется от владельца, обходит RLS;
--   * set search_path = public — фиксируем схему (безопасность SECURITY DEFINER);
--   * GRANT EXECUTE ... TO anon, authenticated — доступна фронту;
--   * возвращает ТОЛЬКО агрегаты для виджетов, не сырые строки таблиц.
-- Сами таблицы остаются закрытыми. Пояс «за сегодня» — параметр (default LA).

-- 1. Здоровье сервисов
create or replace function dash_health()
returns table (service text, ok boolean, latency_ms int, checked_at timestamptz, stale boolean)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (service)
    service, ok, latency_ms, checked_at,
    (checked_at < now() - interval '5 minutes') as stale
  from health_checks
  order by service, checked_at desc;
$$;

-- 2. Реконсиляция (открыто)
create or replace function dash_recon()
returns table (kind text, open_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select kind, count(*) as open_count
  from reconciliation_log
  where resolved = false
  group by kind
  order by open_count desc;
$$;

-- 3. Dead jobs
create or replace function dash_dead()
returns table (type text, dead_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select type, count(*) as dead_count
  from jobs
  where status = 'dead'
  group by type
  order by dead_count desc;
$$;

-- 4. Воронка лидов сегодня
create or replace function dash_funnel(p_tz text default 'America/Los_Angeles')
returns table (status text, cnt bigint)
language sql
stable
security definer
set search_path = public
as $$
  select status, count(*) as cnt
  from leads
  where created_at >= (date_trunc('day', now() at time zone p_tz)) at time zone p_tz
  group by status
  order by array_position(
    array['new','enriched','synced','contacted','orphaned','dead'], status);
$$;

-- 5. Time-to-first-touch (медиана, сегодня)
create or replace function dash_ttft(p_tz text default 'America/Los_Angeles')
returns table (median_minutes numeric, touched_today bigint)
language sql
stable
security definer
set search_path = public
as $$
  with first_touch as (
    select j.lead_id, min(r.finished_at) as touched_at
    from jobs j
    join job_runs r on r.job_id = j.id
    where j.type = 'first_touch' and r.status = 'ok'
    group by j.lead_id
  )
  select
    round(percentile_cont(0.5) within group (
      order by extract(epoch from (ft.touched_at - l.created_at)) / 60
    )::numeric, 1) as median_minutes,
    count(*) as touched_today
  from leads l
  join first_touch ft on ft.lead_id = l.id
  where l.created_at >= (date_trunc('day', now() at time zone p_tz)) at time zone p_tz;
$$;

-- 6. Глубина очереди по типам
create or replace function dash_queue()
returns table (type text, pending bigint, retrying bigint, in_flight bigint)
language sql
stable
security definer
set search_path = public
as $$
  select type,
    count(*) filter (where status = 'pending')    as pending,
    count(*) filter (where status = 'failed')     as retrying,
    count(*) filter (where status = 'processing') as in_flight
  from jobs
  where status in ('pending','failed','processing')
  group by type
  order by pending desc;
$$;

-- 7. Error rate по сервисам за час
create or replace function dash_error_rate()
returns table (service text, runs bigint, errors bigint, error_pct numeric)
language sql
stable
security definer
set search_path = public
as $$
  select service,
    count(*) as runs,
    count(*) filter (where status = 'error') as errors,
    round(100.0 * count(*) filter (where status = 'error')
          / nullif(count(*), 0), 1) as error_pct
  from job_runs
  where started_at > now() - interval '1 hour'
    and service is not null
  group by service
  order by error_pct desc nulls last;
$$;

-- 8. Лиды по часам за 24ч
create or replace function dash_leads_hourly()
returns table (hour timestamptz, leads bigint)
language sql
stable
security definer
set search_path = public
as $$
  select date_trunc('hour', created_at) as hour, count(*) as leads
  from leads
  where created_at > now() - interval '24 hours'
  group by 1
  order by 1;
$$;

-- 9. Лента последних ошибок
create or replace function dash_errors_feed()
returns table (started_at timestamptz, service text, type text, lead_id uuid, attempts int, error text)
language sql
stable
security definer
set search_path = public
as $$
  select r.started_at, r.service, j.type, j.lead_id,
         j.attempts, r.error
  from job_runs r
  join jobs j on j.id = r.job_id
  where r.status = 'error'
  order by r.started_at desc
  limit 20;
$$;

-- Доступ фронту (anon) и залогиненным. Таблицы при этом остаются закрытыми.
grant execute on function
  dash_health(), dash_recon(), dash_dead(),
  dash_funnel(text), dash_ttft(text),
  dash_queue(), dash_error_rate(), dash_leads_hourly(), dash_errors_feed()
to anon, authenticated;
