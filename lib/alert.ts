// Единый отправитель алертов в Telegram. Используется worker / healthcheck /
// reconcile (один отправитель на всех, без дублей). Если TELEGRAM_BOT_TOKEN или
// TELEGRAM_CHAT_ID не заданы — тихий no-op: не роняем вызывающий код. Никаких
// секретов в коде — только из Deno.env.

export type AlertLevel = "warn" | "crit";

export async function sendAlert(level: AlertLevel, message: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    return; // канал не сконфигурирован — тихо выходим
  }

  const text = `GRC ${level.toUpperCase()}\n${message}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`sendAlert: telegram HTTP ${res.status} ${body}`);
    }
  } catch (err) {
    // Алерт — best-effort: его сбой не должен ломать вызывающую функцию.
    console.error(`sendAlert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
