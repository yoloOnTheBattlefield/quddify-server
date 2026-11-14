const logger = require("../utils/logger").child({ module: "telegramNotifier" });
const { decrypt } = require("../utils/crypto");

/**
 * Send a Telegram message when a new inbound lead is created.
 */
async function notifyNewLead(account, lead) {
  const encryptedToken = account.telegram_bot_token;
  const chatId = account.telegram_chat_id;
  if (!encryptedToken || !chatId) return;

  let botToken;
  try {
    botToken = decrypt(encryptedToken);
  } catch {
    logger.error("Failed to decrypt Telegram bot token");
    return;
  }
  if (!botToken) return;

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown";
  const igUsername = lead.ig_username || null;
  const source = lead.source || "unknown";

  const lines = [];
  lines.push("🔔 *New Inbound Lead*");
  lines.push("");
  lines.push(`*Name:* ${escapeMarkdown(name)}`);
  if (lead.email) lines.push(`*Email:* ${escapeMarkdown(lead.email)}`);
  if (igUsername) lines.push(`*IG:* @${escapeMarkdown(igUsername)}`);
  lines.push(`*Source:* ${escapeMarkdown(source)}`);

  const text = lines.join("\n");

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      logger.error({ status: res.status, err }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.error({ err }, "Telegram notification error");
  }
}

/** Escape Markdown V1 special chars */
function escapeMarkdown(str) {
  if (!str) return "";
  return String(str).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

module.exports = { notifyNewLead };
