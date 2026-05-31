# GRC — система автоматизации лидов и продаж

Автоматизация полного пути лида для сервисного бизнеса (ремонт/восстановление), выходящего на рынок США:
**приём → обогащение → CRM → первое касание → outreach → AI-эстимейт.**

Главный принцип — **надёжная инфраструктура, а не happy-path**: идемпотентность, очередь с ретраями, dead-letter, реконсиляция, наблюдаемость. Падение любого компонента не приводит к потере лида.

> Полный контекст проекта — в [`PROJECT.md`](./PROJECT.md). Это README — краткий снимок состояния на текущий момент.

---

## Статус проекта

🟡 **Стадия: старт / проектирование.** Заложена структура и правила; код модулей ещё не написан.

| Что есть | Что ещё нет |
|---|---|
| `PROJECT.md` — источник правды | `docs/` со спеками (`grc-reliability-layer.md` и др.) |
| Правила Cursor в `.cursor/rules/` | Миграции схемы Supabase |
| `.gitignore` | Edge Functions (worker, healthcheck, reconcile) |
| Этот README | Next.js приложение (intake, дашборд) |

---

## Архитектура

Четыре слоя с чётким разделением ответственности:

- **Vercel** (Next.js, App Router, TypeScript strict) — веб-слой: лендинги, edge-endpoint приёма лидов, внутренний дашборд.
- **Supabase / Postgres** — несущая конструкция: состояние, очередь job, аудит, Edge Functions (Deno/TS), `pg_cron`, `pgvector`.
- **n8n** — дирижёр оркестрации. Вызывает внешние сервисы, но **НЕ хранит состояние**.
- **Внешние сервисы** — Pipedrive (CRM), Vapi (голос), транзакционный SMTP, OpenAI/Anthropic (AI), Instantly/Smartlead (outreach), Telegram (алерты).

Каждый шаг конвейера — атомарный **job** в очереди Supabase. n8n и Edge Functions только *исполняют* jobs; правда о состоянии — всегда в БД.

---

## Принципы-инварианты (нарушать нельзя)

1. **Состояние — в Supabase**, не в n8n и не во фронте.
2. **Каждая внешняя операция идемпотентна** — детерминированный ключ, никаких дублей.
3. **Отказ — норма**: ретраи с экспоненциальным backoff → исчерпание → dead-letter, не потеря.
4. **Приём лида терять нельзя**; точка входа максимально простая и независимая.
5. **Секреты только в env vars** — никогда в коде, репозитории, логах.
6. **Наблюдаемость обязательна**: каждое исполнение пишется в `job_runs`; что краснеет на дашборде — то же летит в Telegram.

---

## Стек

| Слой | Технология |
|---|---|
| Веб / хостинг | Vercel (Next.js, App Router), TypeScript strict |
| БД / бэкенд | Supabase (Postgres, Edge Functions на Deno/TS, `pg_cron`, `pgvector`) |
| Оркестрация | n8n (self-host предпочтительно) |
| CRM | Pipedrive |
| Голос | Vapi.ai (за абстракцией — заменяемо) |
| Почта | транзакционный SMTP (системные) + Instantly/Smartlead (outreach) |
| AI | OpenAI / Anthropic API |
| Скрейпинг | Playwright |
| Алерты | Telegram Bot API |

---

## Модель данных (Supabase)

| Таблица | Назначение |
|---|---|
| `leads` | канонические лиды, dedup по `idempotency_key`. Статусы: `new → enriched → synced → contacted → orphaned \| dead` |
| `jobs` | очередь работ. Статусы: `pending → processing → done \| failed → dead` |
| `job_runs` | append-only аудит каждого исполнения (статус, сервис, latency, ошибка) |
| `health_checks` | состояние внешних сервисов (circuit breaker + дашборд) |
| `reconciliation_log` | расхождения, найденные ночной сверкой |

---

## Модули

| Модуль | Что делает | Статус |
|---|---|---|
| **Intake** | приём лида → ключ → запись → постановка в очередь | приоритет, строим первым |
| **Enrich** | обогащение лида | после ядра |
| **CRM sync** | upsert сделки в Pipedrive по `external_key` | после Enrich |
| **First-touch** | звонок (Vapi) или письмо, фиксация результата в CRM | после CRM |
| **Outreach** | холодные кампании, ответы заворачиваются обратно в Intake | warmup с дня 1 |
| **Estimator** | расчёт стоимости. У заказчика **свой estimator на Vercel** → интегрируемся по HTTP API | ждёт контракт API от заказчика |
| **Observability** | health-check, реконсиляция, дашборд, алерты | параллельно пайплайну |

---

## Поток лида (end-to-end)

```
форма / outreach-ответ / vapi-inbound
        │
        ▼
[Intake]  insert lead (on conflict do nothing) ──▶ enqueue job 'enrich'
        ▼
[Enrich]  обогащение ──▶ enqueue 'pipedrive_upsert'
        ▼
[CRM]     upsert по external_key ──▶ pipedrive_deal_id, status=synced ──▶ enqueue 'first_touch'
        ▼
[First-touch]  vapi_call | send_email ──▶ status=contacted, результат в CRM
```

Компенсации (saga): провал на любом шаге → ретраи → при dead-letter лид помечается и попадает в `reconciliation_log`. Никакого «полусогласованного» состояния.

---

## Структура репозитория (целевая)

```
.
├── README.md                   # этот файл
├── PROJECT.md                  # полный контекст проекта (источник правды)
├── .cursor/rules/              # правила Cursor (.mdc)
├── app/
│   ├── (site)/                 # лендинги
│   ├── api/intake/             # edge-endpoint приёма
│   └── dashboard/              # внутренний дашборд
├── lib/
│   ├── idempotency.ts          # генерация ключей
│   └── alert.ts                # Telegram-алерты
├── supabase/
│   ├── migrations/             # схема (DDL)
│   └── functions/              # worker, healthcheck, reconcile
└── docs/                       # reliability-layer, dashboard, dev-plan, budget
```

> На текущий момент реализованы только `PROJECT.md`, правила в `.cursor/rules/` и этот `README.md`. Остальное — целевая структура.

---

## Интеграция с estimator заказчика

У заказчика есть **собственный estimator, задеплоенный на Vercel**. Мы его не строим заново, а интегрируемся:

- предпочтительно — **серверный HTTP-эндпоинт** (`POST /api/estimate`) с авторизацией по токену;
- вызов «сервер-сервер» по HTTPS, **не** через парсинг их фронтенда;
- их сервис ляжет как обычный внешний сервис за абстракцией: шаг `estimate` = job в очереди (ретраи, идемпотентность, аудит, circuit breaker).

Перед началом работ нужен **контракт интеграции** от создателей estimator: URL, аутентификация, форматы запрос/ответ, sync/async, поддержка `request_id` (idempotency), лимиты.

---

## План действий (roadmap)

- **Этап 0 — фундамент:** каркас Next.js на Vercel, инициализация Supabase, `.env.example`.
- **Этап 1 — ядро + Intake:** миграция схемы, `lib/idempotency.ts`, `app/api/intake`, worker очереди (backoff, dead-letter, `job_runs`).
- **Этап 2 — конвейер:** Enrich → CRM sync (Pipedrive upsert) → First-touch (Vapi/email), оркестрация в n8n, saga-компенсации.
- **Этап 3 — наблюдаемость:** функции `dash_*`, дашборд, `lib/alert.ts` (Telegram), health-check + ночная реконсиляция через `pg_cron`.
- **Этап 4 — расширения:** Outreach (Instantly/Smartlead), интеграция estimator заказчика.

---

## Локальная разработка

> Будет дополнено по мере появления кода. Секреты — только в `.env` (см. `.gitignore`), никогда в репозитории.

---

## Документы проекта

- [`PROJECT.md`](./PROJECT.md) — полный контекст: архитектура, инварианты, стек, модель данных, глоссарий.
- `.cursor/rules/` — правила для AI-ассистента (контекст, SQL, edge-функции, фронтенд).
- _(планируется)_ `docs/grc-reliability-layer.md` — главный технический спек: DDL, жизненный цикл job, backoff, saga, реконсиляция.
- _(планируется)_ `docs/grc-dashboard-screen-1.md`, `docs/grc-dev-plan.md`.
