import { createHash } from "node:crypto";

export interface LeadKeyInput {
  email?: string | null;
  phone?: string | null;
  source: string;
}

// Детерминированный ключ лида: md5(lower(email) + (phone ?? '') + source).
// Тот же ключ, что ложится в leads.idempotency_key и в кастомное поле external_key
// сделки Pipedrive. Без побочных эффектов — одинаковый вход даёт одинаковый выход.
export function leadKey(input: LeadKeyInput): string {
  const email = (input.email ?? "").toLowerCase();
  const phone = input.phone ?? "";
  return createHash("md5").update(`${email}${phone}${input.source}`).digest("hex");
}
