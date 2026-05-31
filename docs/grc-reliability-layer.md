# GRC — слой надёжности

Архитектура «взрослого» исполнения для GRC: n8n как дирижёр, Supabase как единственный источник правды, каждая операция идемпотентна, наблюдаема и переисполняема.

---

## 0. Принципы

1. **Состояние живёт в Supabase, не в n8n.** n8n хранит только текущий контекст исполнения. Упал воркфлоу — ничего не потеряно, всё восстанавливается из БД.
2. **Каждый шаг пайплайна — это job.** Не «один длинный воркфлоу», а очередь мелких атомарных операций. Падение одного шага не валит цепочку.
3. **Идемпотентность по умолчанию.** Любую операцию можно прогнать повторно без побочных эффектов (дублей сделок, повторных писем, двойных звонков).
4. **Отказ — норма.** Ретраи, backoff, dead-letter, circuit breaker — не «на потом», а часть базовой схемы.
5. **Всё измеримо.** Нет метрики — нет надёжности.

---

## 1. Слой состояния (Supabase / Postgres)

```sql
-- Канонические лиды
create table leads (
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

-- Очередь работ: каждый шаг пайплайна = job
create table jobs (
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

-- Аудит каждого исполнения (append-only, никогда не перезаписывается)
create table job_runs (
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

-- Состояние внешних сервисов (для circuit breaker и дашборда)
create table health_checks (
  id         bigserial primary key,
  service    text not null,
  ok         boolean not null,
  latency_ms int,
  detail     text,
  checked_at timestamptz default now()
);

-- Расхождения, найденные реконсиляцией
create table reconciliation_log (
  id         bigserial primary key,
  kind       text not null,                       -- orphaned_deal | lead_no_touch | stuck_job
  ref_id     text,
  detail     jsonb,
  resolved   boolean default false,
  created_at timestamptz default now()
);

create index on jobs (status, next_run_at);
create index on leads (status);
```

---

## 2. Идемпотентность

**На входе.** Любой лид перед записью получает детерминированный ключ:

```
idempotency_key = md5(lower(email) || coalesce(phone,'') || source)
```

Вставка через `on conflict do nothing` — повторный вебхук от формы или Vapi не создаёт второй лид.

**В Pipedrive.** Ключ кладётся в кастомное поле сделки (`external_key`). Перед созданием — поиск по нему: нашли → update, не нашли → create. Это переживает любой ретрай n8n: повторный `pipedrive_upsert` не плодит сделки.

**В рассылке.** `jobs(type='send_email')` уникален по `(type, idempotency_key)`, где ключ = `lead_id + кампания`. Один и тот же прогон не отправит письмо дважды.

---

## 3. Жизненный цикл job

```
pending ──claim──▶ processing ──ok──▶ done
   ▲                   │
   │                   └──error & attempts<max──▶ failed ──(next_run_at)──┐
   │                                                                       │
   └───────────────────────────────────────────────────────────────────┘
                       error & attempts>=max ──▶ dead  (dead-letter)
```

**Захват работы (безопасно при нескольких воркерах):**

```sql
update jobs
set status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
where id = (
  select id from jobs
  where status in ('pending','failed')
    and next_run_at <= now()
    and attempts < max_attempts
  order by next_run_at
  for update skip locked
  limit 1
)
returning *;
```

`skip locked` гарантирует, что два параллельных тика не возьмут одну задачу.

---

## 4. Ретраи, backoff, circuit breaker

**Backoff** при ошибке (экспоненциальный, 30с → 1м → 2м → 4м → 8м):

```sql
update jobs
set status = case when attempts >= max_attempts then 'dead' else 'failed' end,
    next_run_at = now() + (interval '30 seconds') * pow(2, attempts),
    last_error = $error,
    locked_at = null
where id = $job_id;
```

**Dead-letter.** Всё со `status='dead'` остаётся в `jobs` для ручного или автоматического разбора — данные не теряются никогда.

**Circuit breaker.** Перед обработкой job смотрим последние health-check'и его сервиса. Если последние 3 проверки `ok=false` — задачи этого типа не захватываются (остаются `pending`), чтобы не выжигать очередь в стену. Как только health-check вернул `ok` — обработка возобновляется автоматически.

---

## 5. Saga для Intake (самый критичный модуль)

Потеря заявки = потеря сделки, поэтому Intake собран как цепочка компенсируемых шагов:

| Шаг | Job | Успех | Компенсация при провале |
|-----|-----|-------|-------------------------|
| 1 | `lead.insert` | лид в БД, status=new | — (идемпотентно) |
| 2 | `enrich` | обогащён, status=enriched | повтор, при dead → enrich пропускается, идём дальше |
| 3 | `pipedrive_upsert` | deal_id записан, status=synced | dead → lead.status=orphaned + reconciliation_log |
| 4 | `first_touch` (vapi/email) | status=contacted | dead → reconciliation_log(lead_no_touch) |

Никакого «полусогласованного» состояния: либо лид доходит до contacted, либо он явно помечен и попадает в отчёт реконсиляции на ручной добор.

---

## 6. Observability

**Источник** — таблица `job_runs` (каждое исполнение со статусом, сервисом, latency, ошибкой).

Ключевые запросы для дашборда:

```sql
-- Error rate за час
select service,
       round(100.0 * count(*) filter (where status='error') / count(*), 1) as err_pct,
       count(*) as runs
from job_runs where started_at > now() - interval '1 hour'
group by service;

-- Глубина очереди
select type, status, count(*) from jobs
where status in ('pending','failed','dead') group by type, status;

-- Time-to-first-touch (медиана, минуты)
select percentile_cont(0.5) within group (
  order by extract(epoch from (contacted_at - created_at))/60
) from leads_with_touch_ts;  -- вьюшка по job_runs first_touch
```

**Алерты в Telegram** при: error_rate > 10% за 15 мин; dead-jobs появились; queue depth выше порога; любой сервис `ok=false` 3 раза подряд.

---

## 7. Health-check loop

Тик раз в 1–2 мин (pg_cron или n8n schedule):

- пинг Pipedrive (лёгкий `GET /users/me`), Vapi (`GET` статус), OpenAI (минимальный запрос), SMTP/почтовый провайдер;
- запись результата в `health_checks`;
- при переходе сервиса из ok в not-ok — алерт.

Эта же таблица кормит circuit breaker (п.4) и дашборд.

---

## 8. Reconciliation loop (ночной)

Ловит то, что утекло между системами:

```sql
-- 1. Осиротевшие сделки: deal в Pipedrive есть, лида в синке нет
--    (сверка external_key из Pipedrive с leads.idempotency_key)

-- 2. Лиды без первого касания дольше 30 мин
insert into reconciliation_log (kind, ref_id, detail)
select 'lead_no_touch', id::text, jsonb_build_object('source', source)
from leads
where status in ('synced','enriched')
  and created_at < now() - interval '30 minutes'
  and id not in (select lead_id from jobs where type='first_touch' and status='done');

-- 3. Залипшие job (в processing дольше 10 мин — воркер умер)
update jobs set status='pending', locked_at=null
where status='processing' and locked_at < now() - interval '10 minutes';
```

---

## 9. SLA — что обещаем и меряем

| Метрика | Цель |
|---------|------|
| Лиды, успешно принятые и записанные | 100% (потеря = инцидент) |
| Лиды, дошедшие до first-touch | ≥ 99% за сутки |
| Time-to-first-touch (медиана) | < 15 мин |
| Error rate внешних вызовов (после ретраев) | < 1% |
| Незакрытых записей в reconciliation_log на утро | 0 |

---

## 10. Раскладка по компонентам

| Слой | Технология | Роль |
|------|------------|------|
| Приём | Vercel (edge endpoint) + n8n webhook | принять лид, посчитать ключ, `insert ... on conflict` |
| Состояние и очередь | Supabase Postgres | leads, jobs, job_runs, health, reconciliation |
| Воркер / тики | Supabase Edge Functions + pg_cron | захват job, backoff, health-check, реконсиляция |
| Оркестрация внешних вызовов | n8n | Pipedrive, Vapi, OpenAI, рассылка — только дирижирование |
| Дашборд | Vercel | живые метрики из Supabase |
| Алерты | Telegram | пороги из п.6 |

**Главный сдвиг от текущей схемы:** n8n перестаёт быть несущей конструкцией и становится дирижёром. Несущая конструкция — Postgres-очередь с идемпотентностью, аудитом и реконсиляцией. Это и есть разница между «работает у меня» и «тысячи повторов с безупречной надёжностью».
