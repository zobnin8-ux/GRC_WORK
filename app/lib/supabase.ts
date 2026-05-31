import { createClient } from "@supabase/supabase-js";

// Фронтовый клиент на ANON-ключе (публично-безопасен). URL и ключ — из env.
// Сырые таблицы под RLS закрыты; данные читаем только через dash_* RPC.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!url || !anonKey) {
  // Не роняем рантайм жёстко, но подсвечиваем причину пустого дашборда.
  console.warn(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — dashboard will be empty.",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false },
});
