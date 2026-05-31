import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { leadKey } from "../../../lib/idempotency.ts";

// Intake — публичная входная дверь системы. Принимает лид по HTTP,
// идемпотентно кладёт в leads и ставит job enrich. Платных сервисов здесь нет —
// дальше по цепочке (enrich → pipedrive_upsert → first_touch) работает worker.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-intake-token, authorization",
  "Access-Control-Max-Age": "86400",
};

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

// Идемпотентная постановка job: ON CONFLICT (type, idempotency_key) DO NOTHING.
// Тот же контракт, что и enqueue в воркере (ТЗ №3): повтор не плодит job.
async function enqueue(
  supabase: SupabaseClient,
  type: string,
  leadId: string,
  idempotencyKey: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .upsert(
      { type, lead_id: leadId, idempotency_key: idempotencyKey, payload },
      { onConflict: "type,idempotency_key", ignoreDuplicates: true },
    );
  if (error) {
    throw new Error(`enqueue ${type} failed: ${error.message}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight — без токена и без тела.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  // Мягкая защита от спама: проверяем X-Intake-Token только если INTAKE_TOKEN задан.
  // Если переменной нет — пропускаем всех (фаза базы).
  const expectedToken = Deno.env.get("INTAKE_TOKEN");
  if (expectedToken && req.headers.get("x-intake-token") !== expectedToken) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return json({ ok: false, error: "body must be a JSON object" }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const source = typeof body.source === "string" ? body.source.trim() : "";
  const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
  const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
  const email = emailRaw.length > 0 ? emailRaw : null;
  const phone = phoneRaw.length > 0 ? phoneRaw : null;

  // Валидация: обязателен source И хотя бы одно из email/phone.
  if (!source || (!email && !phone)) {
    return json(
      { ok: false, error: "source and at least one of email/phone are required" },
      400,
    );
  }

  const idempotencyKey = leadKey({ email, phone, source });

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  // Вставка лида: ON CONFLICT (idempotency_key) DO NOTHING.
  // Новый лид -> вернётся строка (deduped=false). Конфликт -> пустой результат.
  const { data: inserted, error: insertError } = await supabase
    .from("leads")
    .upsert(
      { idempotency_key: idempotencyKey, source, email, phone, raw: body, status: "new" },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    )
    .select("id");
  if (insertError) {
    return json({ ok: false, error: `lead insert failed: ${insertError.message}` }, 500);
  }

  let leadId: string;
  let deduped: boolean;

  if (inserted && inserted.length > 0) {
    leadId = inserted[0].id as string;
    deduped = false;
  } else {
    // Конфликт — лид уже был. Находим существующий по ключу.
    const { data: existing, error: selectError } = await supabase
      .from("leads")
      .select("id")
      .eq("idempotency_key", idempotencyKey)
      .single();
    if (selectError || !existing) {
      return json(
        { ok: false, error: `lead lookup after conflict failed: ${selectError?.message ?? "not found"}` },
        500,
      );
    }
    leadId = existing.id as string;
    deduped = true;
  }

  // Поставить enrich (идемпотентно, ключ = id лида). На дубль-лиде второй enrich не появится.
  try {
    await enqueue(supabase, "enrich", leadId, leadId, { lead_id: leadId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 500);
  }

  return json({ ok: true, lead_id: leadId, deduped }, 200);
});
