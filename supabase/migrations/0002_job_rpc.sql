-- 0002_job_rpc.sql — RPC очереди job для воркера
-- Атомарный захват, завершение и провал job (backoff / dead-letter).
-- Применять в Supabase → SQL Editor или через CLI. Схему 0001 не трогаем.
-- Идемпотентно: create or replace, повторный запуск безопасен.

-- Атомарный захват одной готовой job через FOR UPDATE SKIP LOCKED.
-- attempts инкрементится здесь, при захвате. Возвращает строку jobs или NULL.
create or replace function claim_job(p_types text[] default null)
returns jobs
language sql
as $$
  update jobs
  set status = 'processing',
      locked_at = now(),
      attempts = attempts + 1,
      updated_at = now()
  where id = (
    select id from jobs
    where status in ('pending', 'failed')
      and next_run_at <= now()
      and attempts < max_attempts
      and (p_types is null or type = any(p_types))
    order by next_run_at
    for update skip locked
    limit 1
  )
  returning *;
$$;

-- Успешное завершение job.
create or replace function complete_job(p_id uuid)
returns void
language sql
as $$
  update jobs
  set status = 'done',
      locked_at = null,
      updated_at = now()
  where id = p_id;
$$;

-- Провал job: экспоненциальный backoff или dead-letter.
-- attempts уже инкрементнут при захвате, поэтому сравниваем напрямую.
create or replace function fail_job(p_id uuid, p_error text)
returns void
language sql
as $$
  update jobs
  set status = case when attempts >= max_attempts then 'dead' else 'failed' end,
      next_run_at = now() + (interval '30 seconds') * pow(2, attempts),
      last_error = p_error,
      locked_at = null,
      updated_at = now()
  where id = p_id;
$$;
