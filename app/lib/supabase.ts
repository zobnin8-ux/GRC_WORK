import { createClient } from "@supabase/supabase-js";

// Фронтовый клиент на ANON-ключе (публично-безопасен). URL и ключ — из env.
// Сырые таблицы под RLS закрыты; данные читаем только через dash_* RPC.
//
// ВАЖНО: NEXT_PUBLIC_* инлайнятся на этапе СБОРКИ. Если их нет при build —
// createClient() с пустым URL бросает исключение и валит билд. Поэтому даём
// безопасные плейсхолдеры: билд проходит всегда, а реальные значения
// подставляются, когда заданы в env (Vercel / .env.local). Без реальных значений
// дашборд просто пустой (запросы уходят на несуществующий хост) — не падает.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.warn(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — dashboard will be empty until set at build time.",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false },
});
