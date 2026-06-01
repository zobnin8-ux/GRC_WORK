# GRC — полный технический отчёт (handoff)

Состояние на 31 мая 2026. Вся бесплатная база **Б1–Б6 собрана, задеплоена, протестирована и в проде.**

---

## 1. Что это за система
Конвейер автоматизации лидов с упором на надёжность. Лид принимается → обогащается → синкается в CRM (Pipedrive) → ставится в очередь на первое касание. Поверх — очередь задач с ретраями, dead-letter, реконсиляция, health-check, дашборд и Telegram-алерты.

**Принципы надёжности:** идемпотентность на каждом шаге, ретраи с экспоненциальным backoff, dead-letter, регулярная сверка (reconciliation), health-мониторинг, алерты на смену состояния.

**Поток лида:**
`intake → enrich → pipedrive_upsert → first_touch(заглушка)`
статусы лида: `new → enriched → synced → contacted | orphaned | dead`.

---

## 2. Инфраструктура / координаты
| Что | Значение |
|---|---|
| Repo | `github.com/zobnin8-ux/GRC_WORK`, ветка `main` |
| Supabase project ref | `kuuxaubnbwbwjdttvhom` |
| Supabase URL | `https://kuuxaubnbwbwjdttvhom.supabase.co` |
| Frontend | Vercel hobby, `grc-work.vercel.app` (`/` → `/dashboard`) |
| CRM | Pipedrive, кастомное поле сделки `external_key` (hash `612b77e2ccea2f5602b0b9a1549898e6482daebc`) |
| Alerts | Telegram bot «GRC» |

---

## 3. Модель данных (миграция `0001_reliability.sql`)
RLS включён на всех таблицах, **политик нет** (закрыты). Доступ: Edge Functions — через service-role; фронт — только через `SECURITY DEFINER` функции `dash_*`.

- **leads**(id, idempotency_key UNIQUE = `md5(lower(email)||phone||source)`, source, email, phone, raw jsonb, pipedrive_deal_id, status, created_at, updated_at)
- **jobs**(id, type, lead_id→leads, payload, idempotency_key, status [pending|processing|done|failed|dead], attempts, max_attempts=5, next_run_at, locked_at, last_error, …, **UNIQUE(type, idempotency_key)**)
- **job_runs**(id, job_id→jobs, attempt, status [ok|error], service, latency_ms, error, started_at, finished_at)
- **health_checks**(id, service, ok, latency_ms, detail, checked_at)
- **reconciliation_log**(id, kind [orphaned_deal|lead_no_touch|stuck_job], ref_id, detail jsonb, resolved, created_at)

---

## 4. Миграции
| Файл | Содержимое |
|---|---|
| `0001_reliability.sql` | схема (5 таблиц, индексы, RLS) |
| `0002_job_rpc.sql` | RPC очереди: `claim_job` (FOR UPDATE SKIP LOCKED → processing), `complete_job` (→done), `fail_job` (attempts++, backoff `next_run_at`, →dead при attempts≥max) |
| `0003_schedule_worker.sql` | pg_cron + pg_net; cron `run-worker` `* * * * *`; гвард на Vault-секрет |
| `0004_schedule_reconcile.sql` | cron `run-reconcile` `*/5 * * * *` |
| `0005_schedule_healthcheck.sql` | cron `run-healthcheck` `*/2 * * * *` |
| `0006_dashboard_rpc.sql` | 9 функций `dash_*` (SECURITY DEFINER, search_path=public, GRANT EXECUTE TO anon, authenticated) |

Все cron дёргают Edge Functions через `net.http_post` с `Authorization: Bearer <anon>` из **Vault** (`worker_invoke_key`).

---

## 5. Edge Functions (Supabase, Deno/TS)
| Функция | verify_jwt | Версия | Роль |
|---|---|---|---|
| `intake` | **false** (публичная, защита `X-Intake-Token`) | v1 | приём лида, идемпотентный upsert в `leads`, enqueue `enrich` |
| `worker` | true | **v7** | claim→handler→job_runs→complete/fail; handlers: `enrich`, `pipedrive_upsert`, `vapi_call`(stub), `send_email`(stub); алерт crit при `dead` |
| `reconcile` | true | **v3** | `stuck_job` (processing>10м → reset в pending) + `lead_no_touch` (synced/enriched>30м без done first_touch); алерты warn/crit на новые записи |
| `healthcheck` | true | **v3** | пинг `supabase` всегда; `pipedrive`/`openai`/`vapi`/`smtp` только если есть креды; пишет в `health_checks`; алерт crit при `ok→down` |

**Деплой shared-кода:** функции импортят `../../../lib/*.ts`; деплоятся через MCP с `entrypoint_path=supabase/functions/<fn>/index.ts` и файлами с полными repo-путями (`lib/alert.ts`, `lib/pipedrive.ts`), чтобы относительные импорты резолвились.

---

## 6. Общий код `lib/` (Deno)
- **`idempotency.ts`** — `leadKey({email,phone,source})` → md5.
- **`pipedrive.ts`** — тонкий клиент Pipedrive v1: `findPersonByEmail`, `createPerson`, `findDealByExternalKey`, `createDeal`, `updateDeal`. Креды строго из `Deno.env`.
- **`alert.ts`** — `sendAlert(level:'warn'|'crit', message)` → Telegram `sendMessage`. Без `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` — **тихий no-op**; сбой отправки не роняет вызывающий код. Единственный отправитель на всех.

---

## 7. Дашборд `dash_*` RPC (миграция 0006)
9 функций, точно по `docs/grc-dashboard-screen-1.md`, возвращают только агрегаты:
`dash_health`, `dash_recon`, `dash_dead`, `dash_funnel(p_tz)`, `dash_ttft(p_tz)`, `dash_queue`, `dash_error_rate`, `dash_leads_hourly`, `dash_errors_feed`.
Все `SECURITY DEFINER` + `GRANT EXECUTE TO anon, authenticated` → фронт читает по anon-ключу при закрытых таблицах. Пояс «за сегодня» = параметр (default `America/Los_Angeles`).

---

## 8. Фронтенд (Next.js 14 App Router, TS)
- `app/layout.tsx` — Geist/Geist Mono через `next/font` (пакет `geist`), CSS-переменные.
- `app/page.tsx` — redirect `/` → `/dashboard`.
- `app/dashboard/page.tsx` — хост.
- `app/dashboard/GRCDashboard.tsx` — порт исходного `.jsx` **как есть** (тёмная ops-консоль, 9 виджетов, пороги `lvl` в одном месте). Мок заменён на `supabase.rpc('dash_*')`, **прогрессивный рендер** (`Promise.allSettled` + посрезовый `setData`), автообновление 30с.
- `app/lib/supabase.ts` — anon-клиент; **толерантен к отсутствию env** (плейсхолдеры, чтобы билд не падал на `createClient`).
- `package.json` (next 14.2, react 18, recharts 2, geist, @supabase/supabase-js), `next.config.mjs`, `tsconfig.json` (**exclude `supabase/`, `lib/`** — Deno-код не ломает сборку), `next-env.d.ts`.

---

## 9. Секреты (где что лежит)
**Supabase → Edge Functions → Secrets:** `PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_DOMAIN`, `PIPEDRIVE_EXTERNAL_KEY_FIELD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (+ авто `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
**Supabase → Vault:** `worker_invoke_key` (anon-ключ для cron).
**Vercel → Env:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (и больше ничего).

---

## 10. Что протестировано
- Очередь: claim/complete/fail, backoff, переход в `dead` (исправлен баг «фантомного job» от `claim_job`).
- Pipedrive: идемпотентный upsert по `external_key`, без дублей.
- `intake`: CORS, валидация, дедуп, enqueue.
- cron: worker (1м), reconcile (5м), healthcheck (2м) — зарегистрированы и тикают.
- `healthcheck`: `supabase`+`pipedrive` ok, незаданные сервисы пропускаются.
- `dash_*`: шейпы сверены; anon вызывает RPC, прямое чтение таблиц = 0 (RLS закрыт).
- **Б6**: dead job → `GRC CRIT · job dead` пришёл в Telegram; без переменных — no-op без падений (подтверждено диагностикой `hasToken=false`).
- Фронт: билд на Vercel зелёный, дашборд живой, статус OPERATIONAL.

---

## 11. Хвосты / known issues
- **`app/lib/supabase.ts`** (толерантность к пустому env) — убедиться, что закоммичен/запушен (фикс билда; локально сделан).
- Мусорный секрет **`GRC_WORK`** в Edge Functions Secrets — удалить (не используется).
- recharts 2.x — deprecation warning (не критично).
- Терминал агента в сессии сборки не работал → git-операции делались вручную; MCP Supabase работал штатно.

---

## 12. Дальше — платная фаза
ТЗ собирать при подключении платных сервисов:
1. **`first_touch`** — Vapi-звонок + e-mail (SMTP). Сейчас заглушка в worker.
2. **AI Estimator** — оценка через OpenAI.
3. **Outreach** — последующие касания.

Их ключи пойдут в **Supabase Edge Functions Secrets** (не в Vercel). Заглушки `vapi_call`/`send_email` в `worker` — точки расширения.
