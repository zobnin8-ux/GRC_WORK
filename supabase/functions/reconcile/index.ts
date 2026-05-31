import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Reconcile — регулярная сверка целостности. Чистые операции по нашим таблицам,
// никаких внешних/платных вызовов. Запускается по расписанию (pg_cron, см.
// 0004_schedule_reconcile.sql). Идемпотентен по журналу: пока есть незакрытая
// (resolved=false) запись по тому же (kind, ref_id) — новую не плодит.

const STUCK_AFTER_MIN = 10; // job в processing дольше этого срока считается зависшей
const NO_TOUCH_AFTER_MIN = 30; // лид без касания дольше этого срока попадает в журнал

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Идемпотентная запись в reconciliation_log: не создаём дубль, если по этому
// (kind, ref_id) уже висит незакрытая запись.
async function logIfNew(
  supabase: SupabaseClient,
  kind: string,
  refId: string,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const { data: existing, error: selErr } = await supabase
    .from("reconciliation_log")
    .select("id")
    .eq("kind", kind)
    .eq("ref_id", refId)
    .eq("resolved", false)
    .limit(1);
  if (selErr) {
    throw new Error(`reconciliation_log lookup failed: ${selErr.message}`);
  }
  if (existing && existing.length > 0) {
    return false;
  }
  const { error: insErr } = await supabase
    .from("reconciliation_log")
    .insert({ kind, ref_id: refId, detail, resolved: false });
  if (insErr) {
    throw new Error(`reconciliation_log insert failed: ${insErr.message}`);
  }
  return true;
}

// 1. stuck_job — воркер умер на полпути: job в processing дольше N минут.
// Сбрасываем в pending (locked_at=null), фиксируем в журнал.
async function reconcileStuckJobs(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MIN * 60_000).toISOString();
  const { data: stuck, error } = await supabase
    .from("jobs")
    .select("id")
    .eq("status", "processing")
    .lt("locked_at", cutoff);
  if (error) {
    throw new Error(`stuck_job scan failed: ${error.message}`);
  }

  let reset = 0;
  for (const job of stuck ?? []) {
    const jobId = job.id as string;
    await logIfNew(supabase, "stuck_job", jobId, { reason: `processing > ${STUCK_AFTER_MIN}m` });
    const { error: updErr } = await supabase
      .from("jobs")
      .update({ status: "pending", locked_at: null, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (updErr) {
      throw new Error(`stuck_job reset failed for ${jobId}: ${updErr.message}`);
    }
    reset += 1;
  }
  return reset;
}

// 2. lead_no_touch — лид в synced/enriched старше N минут без выполненного first_touch.
// Лид НЕ меняем, только фиксируем в журнал (идемпотентно).
async function reconcileLeadNoTouch(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - NO_TOUCH_AFTER_MIN * 60_000).toISOString();
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id")
    .in("status", ["synced", "enriched"])
    .lt("created_at", cutoff);
  if (error) {
    throw new Error(`lead_no_touch scan failed: ${error.message}`);
  }

  const leadIds = (leads ?? []).map((l) => l.id as string);
  if (leadIds.length === 0) {
    return 0;
  }

  // Лиды, у которых first_touch уже выполнен.
  const { data: touched, error: touchErr } = await supabase
    .from("jobs")
    .select("lead_id")
    .eq("type", "first_touch")
    .eq("status", "done")
    .in("lead_id", leadIds);
  if (touchErr) {
    throw new Error(`first_touch scan failed: ${touchErr.message}`);
  }
  const touchedSet = new Set((touched ?? []).map((j) => j.lead_id as string));

  let logged = 0;
  for (const leadId of leadIds) {
    if (touchedSet.has(leadId)) {
      continue;
    }
    const created = await logIfNew(supabase, "lead_no_touch", leadId, {
      reason: `no done first_touch after ${NO_TOUCH_AFTER_MIN}m`,
    });
    if (created) {
      logged += 1;
    }
  }
  return logged;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  try {
    const stuckJobsReset = await reconcileStuckJobs(supabase);
    const leadNoTouchLogged = await reconcileLeadNoTouch(supabase);
    return new Response(
      JSON.stringify({ ok: true, stuck_jobs_reset: stuckJobsReset, lead_no_touch_logged: leadNoTouchLogged }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`reconcile failed: ${message}`);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
