# GRC — дашборд, первый экран

Первый экран отвечает на один вопрос: **жива ли система сейчас и не теряем ли мы лиды.** Всё, что не про это, уходит на drill-down экраны (детализация по лиду, по job, по сервису).

Все запросы — read-only к Supabase. На Vercel-дашборде дёргаются через тонкий API-route или клиент Supabase, автообновление каждые 15–30 сек. Таблицы — из схемы слоя надёжности (`leads`, `jobs`, `job_runs`, `health_checks`, `reconciliation_log`).

> Часовой пояс в запросах «за сегодня» — `America/Los_Angeles`. Поменяй на пояс операций заказчика.

---

## Раскладка

```
┌─────────────────┬─────────────────┬─────────────────┐
│ 1. Здоровье     │ 2. Реконсиляция │ 3. Dead jobs    │   ← светофор
│    сервисов     │    (открыто)    │                 │
├─────────────────┴────────┬────────┴─────────────────┤
│ 4. Воронка лидов сегодня  │ 5. Time-to-first-touch   │   ← поток
├──────────────────────────┼──────────────────────────┤
│ 6. Глубина очереди        │ 7. Error rate / 1ч       │   ← нагрузка
├──────────────────────────┴──────────────────────────┤
│ 8. Лиды по часам, 24ч (бар)                          │   ← динамика
├──────────────────────────────────────────────────────┤
│ 9. Лента последних ошибок                            │   ← триаж
└──────────────────────────────────────────────────────┘
```

---

## 1. Здоровье сервисов

**Что:** последний статус каждого внешнего сервиса. Зелёный/красный + latency.
**Тревога:** красный, если `ok = false` или `checked_at` старше 5 мин (health-check умер).

```sql
select distinct on (service)
  service, ok, latency_ms, checked_at,
  (checked_at < now() - interval '5 minutes') as stale
from health_checks
order by service, checked_at desc;
```

## 2. Реконсиляция (открыто)

**Что:** незакрытые расхождения по типам. Это и есть «тихие потери».
**Тревога:** жёлтый при любом `> 0`, красный при `orphaned_deal > 0` или сумме `> 10`.

```sql
select kind, count(*) as open_count
from reconciliation_log
where resolved = false
group by kind
order by open_count desc;
```

## 3. Dead jobs

**Что:** задачи, исчерпавшие ретраи и осевшие в dead-letter.
**Тревога:** жёлтый при `> 0` (требует разбора), красный при росте за час.

```sql
select type, count(*) as dead_count
from jobs
where status = 'dead'
group by type
order by dead_count desc;
```

## 4. Воронка лидов сегодня

**Что:** сколько лидов на каждой стадии за сегодня. Главный индикатор «доходят ли до contacted».
**Тревога:** красный, если `orphaned + dead > 0`; жёлтый, если доля `contacted` от всех принятых заметно ниже обычной.

```sql
select status, count(*) as cnt
from leads
where created_at >= (date_trunc('day', now() at time zone 'America/Los_Angeles'))
                    at time zone 'America/Los_Angeles'
group by status
order by
  array_position(array['new','enriched','synced','contacted','orphaned','dead'], status);
```

## 5. Time-to-first-touch (медиана, сегодня)

**Что:** медиана минут от приёма лида до первого успешного касания. SLA-метрика.
**Тревога:** жёлтый при медиане `> 15` мин, красный при `> 30`.

```sql
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
where l.created_at >= (date_trunc('day', now() at time zone 'America/Los_Angeles'))
                      at time zone 'America/Los_Angeles';
```

## 6. Глубина очереди по типам

**Что:** сколько работы висит и сколько в полёте, по типам job. Растёт backlog → не успеваем.
**Тревога:** жёлтый при `pending > 50` по любому типу, красный при устойчивом росте.

```sql
select type,
  count(*) filter (where status = 'pending')    as pending,
  count(*) filter (where status = 'failed')     as retrying,
  count(*) filter (where status = 'processing') as in_flight
from jobs
where status in ('pending','failed','processing')
group by type
order by pending desc;
```

## 7. Error rate по сервисам за час

**Что:** доля упавших вызовов по каждому внешнему сервису (после ретраев это видно как ошибки в `job_runs`).
**Тревога:** жёлтый при `error_pct > 5`, красный при `> 10`.

```sql
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
```

## 8. Лиды по часам за 24ч

**Что:** бар-чарт притока лидов. Видно провалы (приём сломался) и пики.
**Тревога:** визуальная — пустой час там, где обычно поток.

```sql
select date_trunc('hour', created_at) as hour, count(*) as leads
from leads
where created_at > now() - interval '24 hours'
group by 1
order by 1;
```

## 9. Лента последних ошибок

**Что:** последние 20 падений с сервисом, типом, ошибкой и номером попытки. Точка входа в триаж.
**Тревога:** не метрика — рабочий список. Клик по строке → drill-down по job.

```sql
select r.started_at, r.service, j.type, j.lead_id,
       j.attempts, r.error
from job_runs r
join jobs j on j.id = r.job_id
where r.status = 'error'
order by r.started_at desc
limit 20;
```

---

## Цветовая логика (общая)

| Цвет | Значит |
|------|--------|
| Зелёный | в пределах SLA, действий не требуется |
| Жёлтый | деградация, посмотреть в ближайший час |
| Красный | инцидент, разбирать сейчас + алерт в Telegram (пороги из слоя надёжности, п.6) |

Дашборд и алерты кормятся из одних и тех же запросов: то, что красное на экране, одновременно улетает в Telegram. Экран — для тебя, когда ты смотришь; алерт — чтобы не пропустить, когда не смотришь.

---

## Что НЕ кладём на первый экран

Чтобы «одно стекло» не превратилось в шум — это на вкладки второго уровня:

- детализация по конкретному лиду (его job-цепочка, все run'ы, payload);
- история по одному сервису (latency-тренд, аптайм за неделю);
- разбор dead-letter с кнопкой «переотправить»;
- очередь реконсиляции с действиями «закрыть / добрать руками».
