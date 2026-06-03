# GRC — система автоматизации лидов и продаж

Автоматизация полного пути лида для сервисного бизнеса (ремонт/восстановление), выходящего на рынок США:
**приём → обогащение → CRM → первое касание → outreach → AI-эстимейт.**

Главный принцип — **надёжная инфраструктура, а не happy-path**: идемпотентность, очередь с ретраями, dead-letter, реконсиляция, наблюдаемость. Падение любого компонента не приводит к потере лида.

> Полный контекст проекта — в [`PROJECT.md`](./PROJECT.md). Это README — краткий снимок состояния на текущий момент.

---

## Статус проекта

🟢 **Бесплатная база Б1–Б6 собрана, задеплоена и в проде. Сайт подключён — заявки с формы идут в систему.**

Конвейер `intake → enrich → pipedrive_upsert → first_touch` работает end-to-end: очередь с ретраями, dead-letter, реконсиляция, health-check, дашборд и Telegram-алерты.

| Что в проде | Где |
|---|---|
| intake endpoint | Edge Function `intake` (`verify_jwt=false`, `X-Intake-Token`) |
| очередь + worker | `worker` **v18** + `pg_cron` `run-worker` (1 мин) |
| reconciliation / health-check | `reconcile` (5 мин) · `healthcheck` (2 мин) |
| дашборд | 9 `dash_*` RPC + Next.js → `grc-work.vercel.app` |
| Telegram-алерты + first_touch | `lib/alert.ts` (`sendAlert` / `sendTelegram`) |
| сайт → система | форма `grc-eta.vercel.app/contact` → `/api/lead` → intake |

> Дальше — платная фаза: First-touch (Vapi-звонок + почта-автоответ), AI Estimator, Outreach. Полный технический отчёт — в [`docs/grc-handoff.md`](./docs/grc-handoff.md).

---

## Архитектура

Четыре слоя с чётким разделением ответственности:

- **Vercel** (Next.js, App Router, TypeScript) — веб-слой: (1) дашборд `grc-work.vercel.app` через `dash_*` RPC; (2) сайт `grc-eta.vercel.app` — форма `/contact` шлёт заявки через серверный роут `/api/lead` в `intake`.
- **Supabase / Postgres** — несущая конструкция: состояние, очередь job, аудит, Edge Functions (Deno/TS), `pg_cron` + `pg_net`, Vault.
- **n8n** — дирижёр оркестрации; **пока не задействован** — оркестрацию держат Edge Functions + `pg_cron`.
- **Внешние сервисы** — Pipedrive (CRM, live), Telegram (алерты + уведомления о лидах, live); Vapi, SMTP, OpenAI/Anthropic, Instantly/Smartlead — платная фаза.

Каждый шаг конвейера — атомарный **job** в очереди Supabase. Edge Functions только *исполняют* jobs; правда о состоянии — всегда в БД.

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
| **Сайт (форма)** | `/contact` → `/api/lead` (токен + honeypot) → intake | ✅ готово |
| **Intake** | приём лида → ключ → запись → постановка в очередь | ✅ готово |
| **Enrich** | нормализация контактов → enqueue CRM | ✅ готово |
| **CRM sync** | upsert в Pipedrive по `external_key`; имя/компания(org)/срочность в сделке | ✅ готово |
| **First-touch** | уведомление о лиде в Telegram + ссылка на сделку | ✅ готово (звонок/письмо — платная фаза) |
| **Outreach** | холодные кампании, ответы заворачиваются обратно в Intake | ⏳ платная фаза |
| **Estimator** | расчёт стоимости. У заказчика **свой estimator на Vercel** → интегрируемся по HTTP API | ⏳ ждёт контракт API |
| **Observability** | health-check, реконсиляция, дашборд, алерты | ✅ готово |

---

## Поток лида (end-to-end)

```
форма сайта (grc-eta → /api/lead) / outreach-ответ / vapi-inbound
        │
        ▼
[Intake]  insert lead (on conflict do nothing) ──▶ enqueue job 'enrich'
        ▼
[Enrich]  обогащение ──▶ enqueue 'pipedrive_upsert'
        ▼
[CRM]     upsert по external_key ──▶ pipedrive_deal_id, status=synced ──▶ enqueue 'first_touch'
        ▼
[First-touch]  Telegram-уведомление о лиде (+ссылка на сделку)
               звонок Vapi / письмо-автоответ ──▶ status=contacted — платная фаза
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

> Реализовано: `intake`, `worker`, `healthcheck`, `reconcile` (Edge Functions), миграции схемы + `dash_*` RPC, `lib/idempotency.ts` / `lib/pipedrive.ts` / `lib/alert.ts`, дашборд (`app/`), `docs/`. Форма сайта живёт в отдельном репозитории `zobnin8-ux/grc`.

---

## Интеграция с estimator заказчика

У заказчика есть **собственный estimator, задеплоенный на Vercel**. Мы его не строим заново, а интегрируемся:

- предпочтительно — **серверный HTTP-эндпоинт** (`POST /api/estimate`) с авторизацией по токену;
- вызов «сервер-сервер» по HTTPS, **не** через парсинг их фронтенда;
- их сервис ляжет как обычный внешний сервис за абстракцией: шаг `estimate` = job в очереди (ретраи, идемпотентность, аудит, circuit breaker).

Перед началом работ нужен **контракт интеграции** от создателей estimator: URL, аутентификация, форматы запрос/ответ, sync/async, поддержка `request_id` (idempotency), лимиты.

---

## План действий (roadmap)

- [x] **Этап 0 — фундамент:** каркас Next.js на Vercel, инициализация Supabase, `.env.example`.
- [x] **Этап 1 — ядро + Intake:** миграция схемы, `lib/idempotency.ts`, `intake`, worker очереди (backoff, dead-letter, `job_runs`).
- [x] **Этап 2 — конвейер:** Enrich → CRM sync (Pipedrive upsert); оркестрация на Edge Functions + `pg_cron` (n8n пока не нужен); saga-компенсации.
- [x] **Этап 3 — наблюдаемость:** функции `dash_*`, дашборд, `lib/alert.ts` (Telegram), health-check + реконсиляция через `pg_cron`.
- [x] **Этап 3.5 — сайт + first_touch:** форма `grc-eta.vercel.app` → `/api/lead` → intake; `first_touch` шлёт Telegram-уведомление; сделки Pipedrive с именем/компанией/срочностью.
- [ ] **Этап 4 — платная фаза:** First-touch (Vapi-звонок + почта-автоответ), AI Estimator, Outreach (Instantly/Smartlead).

---

## Локальная разработка

> Будет дополнено по мере появления кода. Секреты — только в `.env` (см. `.gitignore`), никогда в репозитории.

---

## Документы проекта

- [`docs/grc-handoff.md`](./docs/grc-handoff.md) — **полный технический отчёт по сделанному (Б1–Б6 + сайт).**
- [`PROJECT.md`](./PROJECT.md) — полный контекст: архитектура, инварианты, стек, модель данных, глоссарий.
- `obsidian/GRC — База знаний.md` — хаб проекта для Obsidian.
- `docs/grc-reliability-layer.md` — технический спек слоя надёжности (реализован).
- `docs/grc-dashboard-screen-1.md` — спека дашборда (реализована) · `docs/grc-dev-plan.md` — план разработки.
- `.cursor/rules/` — правила для AI-ассистента (контекст, SQL, edge-функции, фронтенд).
