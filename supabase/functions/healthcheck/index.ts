import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { sendAlert } from "../../../lib/alert.ts";

// Health-check (каркас) — пингует доступные внешние сервисы и пишет по строке
// в health_checks. Только бесплатное. Сервис пингуется ТОЛЬКО если его креды
// заданы в env; незаданные сервисы пропускаем, чтобы не засорять здоровье
// «падениями» того, что ещё не подключено. Любая сетевая ошибка → ok=false + detail,
// функция не падает.

interface CheckResult {
  service: string;
  ok: boolean;
  latency_ms: number | null;
  detail: string;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// supabase — лёгкий запрос к собственной БД. Пингуем всегда.
async function checkSupabase(supabase: SupabaseClient): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const { error } = await supabase
      .from("leads")
      .select("id", { head: true, count: "exact" });
    const latency = Date.now() - t0;
    if (error) {
      return { service: "supabase", ok: false, latency_ms: latency, detail: error.message };
    }
    return { service: "supabase", ok: true, latency_ms: latency, detail: "db reachable" };
  } catch (err) {
    return {
      service: "supabase",
      ok: false,
      latency_ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// Универсальный HTTP-пинг для внешних сервисов.
async function httpPing(service: string, url: string, headers: Record<string, string>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers });
    const latency = Date.now() - t0;
    return {
      service,
      ok: res.ok,
      latency_ms: latency,
      detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return {
      service,
      ok: false,
      latency_ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// TCP-пинг для SMTP (HTTP-пинг неприменим): просто проверяем, что порт открыт.
async function tcpPing(service: string, host: string, port: number): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const conn = await Deno.connect({ hostname: host, port });
    conn.close();
    return { service, ok: true, latency_ms: Date.now() - t0, detail: `tcp ${host}:${port} open` };
  } catch (err) {
    return {
      service,
      ok: false,
      latency_ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// Собираем пинги только для тех сервисов, чьи креды есть в env.
async function runChecks(supabase: SupabaseClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // supabase — всегда.
  results.push(await checkSupabase(supabase));

  // pipedrive — только если есть токен (и домен).
  const pdToken = Deno.env.get("PIPEDRIVE_API_TOKEN");
  const pdDomain = Deno.env.get("PIPEDRIVE_DOMAIN");
  if (pdToken && pdDomain) {
    results.push(
      await httpPing(
        "pipedrive",
        `https://${pdDomain}.pipedrive.com/api/v1/users/me?api_token=${encodeURIComponent(pdToken)}`,
        {},
      ),
    );
  }

  // openai — только если есть ключ.
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (openaiKey) {
    results.push(
      await httpPing("openai", "https://api.openai.com/v1/models", {
        Authorization: `Bearer ${openaiKey}`,
      }),
    );
  }

  // vapi — только если есть ключ.
  const vapiKey = Deno.env.get("VAPI_API_KEY");
  if (vapiKey) {
    results.push(
      await httpPing("vapi", "https://api.vapi.ai/assistant?limit=1", {
        Authorization: `Bearer ${vapiKey}`,
      }),
    );
  }

  // smtp — только если задан хост (TCP-пинг порта).
  const smtpHost = Deno.env.get("SMTP_HOST");
  if (smtpHost) {
    const smtpPort = Number(Deno.env.get("SMTP_PORT") ?? "587");
    results.push(await tcpPing("smtp", smtpHost, smtpPort));
  }

  return results;
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
    const results = await runChecks(supabase);
    const checkedAt = new Date().toISOString();

    // Алерт на переход ok -> down: сравниваем с последней записью ДО вставки
    // новых строк. Был ok (или нет истории и сейчас down — не шлём), стал down — шлём один раз.
    for (const r of results) {
      if (r.ok) continue;
      const { data: prev } = await supabase
        .from("health_checks")
        .select("ok")
        .eq("service", r.service)
        .order("checked_at", { ascending: false })
        .limit(1);
      const wasOk = Array.isArray(prev) && prev.length > 0 && prev[0].ok === true;
      if (wasOk) {
        await sendAlert("crit", `service down · ${r.service}\n${r.detail}`);
      }
    }

    const { error } = await supabase.from("health_checks").insert(
      results.map((r) => ({
        service: r.service,
        ok: r.ok,
        latency_ms: r.latency_ms,
        detail: r.detail,
        checked_at: checkedAt,
      })),
    );
    if (error) {
      throw new Error(`health_checks insert failed: ${error.message}`);
    }

    return new Response(JSON.stringify({ ok: true, checks: results }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`healthcheck failed: ${message}`);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
