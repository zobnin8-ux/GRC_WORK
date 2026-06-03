// Единый отправитель сообщений в Telegram. Используется worker / healthcheck /
// reconcile (один отправитель на всех, без дублей). Если TELEGRAM_BOT_TOKEN или
// TELEGRAM_CHAT_ID не заданы — тихий no-op. Никаких секретов в коде — только из Deno.env.

export type AlertLevel = "warn" | "crit";

// Низкоуровневая отправка. Возвращает true, если сообщение отправлено; false —
// если канал не сконфигурирован (no-op). Бросает исключение при HTTP/сетевой ошибке,
// чтобы вызывающий job мог уйти в ретрай.
export async function sendTelegram(text: string): Promise<boolean> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    return false; // канал не сконфигурирован — тихо выходим
  }

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
    throw new Error(`telegram HTTP ${res.status} ${body}`);
  }
  return true;
}

// Алерт — best-effort: его сбой не должен ломать вызывающую функцию.
export async function sendAlert(level: AlertLevel, message: string): Promise<void> {
  try {
    await sendTelegram(`GRC ${level.toUpperCase()}\n${message}`);
  } catch (err) {
    console.error(`sendAlert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
