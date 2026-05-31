-- 0003_schedule_worker.sql — автозапуск воркера через pg_cron + pg_net.
-- Раз в минуту дёргаем Edge Function `worker`, чтобы очередь разбиралась сама,
-- без ручного вызова. Только бесплатное, всё внутри Supabase.
--
-- verify_jwt воркера НЕ трогаем: авторизуемся anon-ключом — его достаточно,
-- чтобы пройти verify_jwt=true; саму привилегированную работу worker делает
-- на service-role из собственного env.
--
-- ВАЖНО про секрет: anon-ключ НЕ хранится в репозитории. Он лежит в Supabase
-- Vault под именем `worker_invoke_key`. Перед применением миграции секрет
-- должен быть создан (одноразово, значение НЕ коммитим):
--
--     select vault.create_secret(
--       '<ANON_KEY>', 'worker_invoke_key',
--       'anon key used by pg_cron to invoke the worker edge function'
--     );
--
-- Если секрета нет — миграция падает ниже с понятной инструкцией.

-- 1. Расширения. pg_cron создаёт собственную схему `cron`, pg_net — схему `net`.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- 2. Гвард: ключ авторизации обязан существовать в Vault (а не в коде).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'worker_invoke_key') then
    raise exception
      'Vault secret "worker_invoke_key" is missing. Create it first (value is NOT stored in the repo): select vault.create_secret(''<ANON_KEY>'', ''worker_invoke_key'', ''anon key for cron worker invoke'');';
  end if;
end $$;

-- 3. Расписание: раз в минуту POST на worker с Bearer-ключом из Vault.
--    Имя job уникально; повторный cron.schedule с тем же именем — апсерт.
select cron.schedule(
  'run-worker',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://kuuxaubnbwbwjdttvhom.supabase.co/functions/v1/worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'worker_invoke_key')
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);
