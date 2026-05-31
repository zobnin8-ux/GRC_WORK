import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Один захваченный job (подмножество таблицы jobs, нужное воркеру).
interface Job {
  id: string;
  type: string;
  lead_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

interface HandlerResult {
  service: string;
}

type JobHandler = (job: Job, supabase: SupabaseClient) => Promise<HandlerResult>;

// Диспетчер по job.type. Новый тип добавляется одной строкой.
// Пока заглушки: логируют и возвращают успех. Реальная логика — в следующих ТЗ.
const handlers: Record<string, JobHandler> = {
  enrich: (job) => {
    console.log(`[enrich] job=${job.id} lead=${job.lead_id}`);
    return Promise.resolve({ service: "internal" });
  },
  pipedrive_upsert: (job) => {
    console.log(`[pipedrive_upsert] job=${job.id} lead=${job.lead_id}`);
    return Promise.resolve({ service: "pipedrive" });
  },
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

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

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

    await supabase.from("job_runs").insert({
      job_id: job.id,
      attempt: job.attempts,
      status: "error",
      service: null,
      latency_ms: Date.now() - startedAt,
      error: message,
      finished_at: new Date().toISOString(),
    });

    await supabase.rpc("fail_job", { p_id: job.id, p_error: message });
    return false;
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

    const job = data as Job | null;
    if (!job) {
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
