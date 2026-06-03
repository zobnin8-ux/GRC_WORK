// Тонкий клиент Pipedrive API v1. Только то, что нужно обработчику pipedrive_upsert.
// Креды и идентификатор кастомного поля — строго из Deno.env, никаких секретов в коде.
// Любая ошибка API выбрасывается наружу — воркер сам поймает и направит job в fail_job.

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

interface SearchResponse {
  items: Array<{ item: { id: number } }>;
}

// Низкоуровневый запрос к Pipedrive. Бросает при сетевой ошибке, не-2xx или success=false.
async function pdRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const domain = requireEnv("PIPEDRIVE_DOMAIN");
  const token = requireEnv("PIPEDRIVE_API_TOKEN");
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://${domain}.pipedrive.com/api/v1${path}${sep}api_token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: unknown; error?: string }
    | null;

  if (!res.ok || json === null || json.success === false) {
    const detail = json?.error ?? res.statusText;
    throw new Error(`Pipedrive ${method} ${path} failed: HTTP ${res.status} ${detail}`);
  }

  return json.data as T;
}

export async function findPersonByEmail(email: string): Promise<number | null> {
  const path =
    `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true&limit=1`;
  const data = await pdRequest<SearchResponse>("GET", path);
  return data.items.length > 0 ? data.items[0].item.id : null;
}

export async function createOrganization(name: string): Promise<number> {
  const data = await pdRequest<{ id: number }>("POST", "/organizations", { name });
  return data.id;
}

export async function createPerson(
  input: { name: string; email: string; phone?: string | null; orgId?: number },
): Promise<number> {
  const body: Record<string, unknown> = {
    name: input.name,
    email: [input.email],
  };
  if (input.phone) {
    body.phone = [input.phone];
  }
  if (input.orgId) {
    body.org_id = input.orgId;
  }
  const data = await pdRequest<{ id: number }>("POST", "/persons", body);
  return data.id;
}

export async function findDealByExternalKey(key: string): Promise<number | null> {
  const path =
    `/deals/search?term=${encodeURIComponent(key)}&fields=custom_fields&exact_match=true&limit=1`;
  const data = await pdRequest<SearchResponse>("GET", path);
  return data.items.length > 0 ? data.items[0].item.id : null;
}

export async function createDeal(
  input: { title: string; personId: number; externalKey: string; orgId?: number },
): Promise<number> {
  const field = requireEnv("PIPEDRIVE_EXTERNAL_KEY_FIELD");
  const body: Record<string, unknown> = {
    title: input.title,
    person_id: input.personId,
    [field]: input.externalKey,
  };
  if (input.orgId) {
    body.org_id = input.orgId;
  }
  const data = await pdRequest<{ id: number }>("POST", "/deals", body);
  return data.id;
}

export async function updateDeal(
  dealId: number,
  fields: Record<string, unknown>,
): Promise<void> {
  await pdRequest("PUT", `/deals/${dealId}`, fields);
}
