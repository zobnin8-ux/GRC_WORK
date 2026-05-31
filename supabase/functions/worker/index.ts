import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  createDeal,
  createPerson,
  findPersonByEmail,
  updateDeal,
} from "../../../lib/pipedrive.ts";
import { sendAlert } from "../../../lib/alert.ts";

// Один захваченный job (подмножество таблицы jobs, нужное воркеру).
interface Job {
  id: string;
  type: string;
  lead_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

// Лид в том виде, в каком его читают обработчики.
interface Lead {
  id: string;
  idempotency_key: string;
  source: string;
  email: string | null;
  phone: string | null;
  pipedrive_deal_id: number | null;
  status: string;
}

interface HandlerResult {
  service: string;
}

type JobHandler = (job: Job, supabase: SupabaseClient) => Promise<HandlerResult>;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function loadLead(supabase: SupabaseClient, leadId: string): Promise<Lead> {
  const { data, error } = await supabase
    .from("leads")
    .select("id, idempotency_key, source, email, phone, pipedrive_deal_id, status")
    .eq("id", leadId)
    .single();
  if (error || !data) {
    throw new Error(`load lead ${leadId} failed: ${error?.message ?? "not found"}`);
  }
  return data as Lead;
}

// Идемпотентная постановка job в очередь: ON CONFLICT (type, idempotency_key) DO NOTHING.
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

// Диспетчер по job.type. Новый тип добавляется одной строкой.
const handlers: Record<string, JobHandler> = {
  // Лёгкое обогащение: нормализуем контакты, помечаем enriched, ставим CRM-синк.
  // Реальное обогащение (внешние источники) — позже.
  enrich: async (job, supabase) => {
    if (!job.lead_id) {
      throw new Error("enrich: job has no lead_id");
    }
    const lead = await loadLead(supabase, job.lead_id);
    const email = lead.email ? lead.email.trim().toLowerCase() : null;
    const phone = lead.phone ? lead.phone.replace(/[^\d+]/g, "") : null;

    const { error } = await supabase
      .from("leads")
      .update({ email, phone, status: "enriched", updated_at: new Date().toISOString() })
      .eq("id", lead.id);
    if (error) {
      throw new Error(`enrich update failed: ${error.message}`);
    }

    await enqueue(supabase, "pipedrive_upsert", lead.id, lead.id);
    return { service: "internal" };
  },

  // Идемпотентный upsert сделки в Pipedrive по external_key.
  pipedrive_upsert: async (job, supabase) => {
    if (!job.lead_id) {
      throw new Error("pipedrive_upsert: job has no lead_id");
    }
    const lead = await loadLead(supabase, job.lead_id);
    const externalKeyField = requireEnv("PIPEDRIVE_EXTERNAL_KEY_FIELD");

    let dealId = lead.pipedrive_deal_id;

    if (dealId) {
      // ГВАРД: сделка уже привязана — обновляем, никакого повторного create.
      await updateDeal(dealId, { [externalKeyField]: lead.idempotency_key });
    } else {
      if (!lead.email) {
        throw new Error("pipedrive_upsert: lead has no email");
      }
      let personId = await findPersonByEmail(lead.email);
      if (personId === null) {
        personId = await createPerson({
          name: lead.email,
          email: lead.email,
          phone: lead.phone,
        });
      }
      dealId = await createDeal({
        title: `GRC lead — ${lead.email} (${lead.source})`,
        personId,
        externalKey: lead.idempotency_key,
      });
    }

    // Шаг 5: записать deal_id и статус synced.
    const { error } = await supabase
      .from("leads")
      .update({
        pipedrive_deal_id: dealId,
        status: "synced",
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead.id);
    if (error) {
      throw new Error(`lead sync update failed: ${error.message}`);
    }

    // Шаг 6: поставить first_touch (идемпотентно, ключ = lead_id).
    await enqueue(supabase, "first_touch", lead.id, lead.id);

    return { service: "pipedrive" };
  },

  // Заглушки — реальная логика в ТЗ №4.
  vapi_call: (job) => {
    console.log(`[vapi_call] job=${job.id} lead=${job.lead_id}`);
    return Promise.resolve({ service: "vapi" });
  },
  send_email: (job) => {
    console.log(`[send_email] job=${job.id} lead=${job.lead_id}`);
    return Promise.resolve({ service: "smtp" });
  },
};

const MAX_ITERATIONS = 25;

async function processJob(supabase: SupabaseClient, job: Job): Promise<boolean> {
  const startedAt = Date.now();
  const handler = handlers[job.type];

  try {
    if (!handler) {
      throw new Error(`No handler for job type: ${job.type}`);
    }
    const result = await handler(job, supabase);

    await supabase.from("job_runs").insert({
      job_id: job.id,
      attempt: job.attempts,
      status: "ok",
      service: result.service,
      latency_ms: Date.now() - startedAt,
      error: null,
      finished_at: new Date().toISOString(),
    });

    const { error } = await supabase.rpc("complete_job", { p_id: job.id });
    if (error) {
      throw new Error(`complete_job failed: ${error.message}`);
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const service = serviceForType(job.type);

    await supabase.from("job_runs").insert({
      job_id: job.id,
      attempt: job.attempts,
      status: "error",
      service,
      latency_ms: Date.now() - startedAt,
      error: message,
      finished_at: new Date().toISOString(),
    });

    const { error: failErr } = await supabase.rpc("fail_job", { p_id: job.id, p_error: message });

    // Алерт только при фактическом переходе в dead (исчерпаны ретраи). Dead-job
    // больше не захватывается claim_job, поэтому событие отрабатывает один раз.
    if (!failErr) {
      const { data: after } = await supabase
        .from("jobs")
        .select("status")
        .eq("id", job.id)
        .single();
      if ((after as { status?: string } | null)?.status === "dead") {
        await sendAlert(
          "crit",
          `job dead · type=${job.type} lead=${job.lead_id ?? "—"} attempts=${job.attempts + 1}/${job.max_attempts}\n${message}`,
        );
      }
    }
    return false;
  }
}

// Сервис для job_runs (нужен и на ветке ошибки, когда handler не вернул результат).
function serviceForType(type: string): string | null {
  switch (type) {
    case "pipedrive_upsert":
      return "pipedrive";
    case "vapi_call":
      return "vapi";
    case "send_email":
      return "smtp";
    case "enrich":
      return "internal";
    default:
      return null;
  }
}

Deno.serve(async (): Promise<Response> => {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { data, error } = await supabase.rpc("claim_job", { p_types: null });
    if (error) {
      console.error(`claim_job failed: ${error.message}`);
      break;
    }

    // claim_job (returns jobs) может вернуть не SQL NULL, а пустую строку
    // (все поля null), когда очередь пуста — поэтому проверяем и job.id,
    // иначе воркер крутит фантомный job до MAX_ITERATIONS.
    const job = data as Job | null;
    if (!job || !job.id) {
      break;
    }

    const ok = await processJob(supabase, job);
    if (ok) {
      processed += 1;
    } else {
      failed += 1;
    }
  }

  return new Response(JSON.stringify({ processed, failed }), {
    headers: { "content-type": "application/json" },
  });
});
