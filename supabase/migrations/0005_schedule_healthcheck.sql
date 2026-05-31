-- 0005_schedule_healthcheck.sql — расписание для health-check.
-- Каждые 2 минуты дёргаем Edge Function `healthcheck` через pg_net. Авторизация —
-- anon-ключом из Supabase Vault (`worker_invoke_key`), как в 0003/0004. Ключа в
-- репозитории нет. verify_jwt функции НЕ трогаем.
--
-- Расширения pg_cron/pg_net включены миграцией 0003. Секрет Vault создаётся
-- одноразово (см. 0003). Если его нет — падаем с понятной инструкцией.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'worker_invoke_key') then
    raise exception
      'Vault secret "worker_invoke_key" is missing. Create it first (value is NOT stored in the repo): select vault.create_secret(''<ANON_KEY>'', ''worker_invoke_key'', ''anon key for cron worker invoke'');';
  end if;
end $$;

select cron.schedule(
  'run-healthcheck',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := 'https://kuuxaubnbwbwjdttvhom.supabase.co/functions/v1/healthcheck',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'worker_invoke_key')
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);
