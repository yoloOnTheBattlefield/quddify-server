const logger = require("../utils/logger").child({ module: "telegramNotifier" });
const { decrypt } = require("../utils/crypto");

/**
 * Look up which IG sender account messaged an outbound lead.
 * Returns the sender's ig_username or null.
 */
async function resolveSenderUsername(outboundLeadId) {
  try {
    const CampaignLead = require("../models/CampaignLead");
    const SenderAccount = require("../models/SenderAccount");
    const cl = await CampaignLead.findOne({
      outbound_lead_id: outboundLeadId,
      sender_id: { $ne: null },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (!cl?.sender_id) return null;
    const sender = await SenderAccount.findById(cl.sender_id).lean();
    return sender?.ig_username || null;
  } catch {
    return null;
  }
}

/**
 * Send a Telegram message when a new inbound lead is created.
 *
 * Highlights when the inbound lead is linked to an outbound lead,
 * includes the lead's username and the IG sender account that reached them.
 */
async function notifyNewLead(account, lead, outboundLead) {
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

  // Resolve sender account if we have a linked outbound lead
  let senderUsername = null;
  if (outboundLead?._id) {
    senderUsername = await resolveSenderUsername(outboundLead._id);
  }

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

  if (outboundLead) {
    lines.push("");
    lines.push("⚡ *Linked to Outbound Lead*");
    lines.push(`*Outbound Username:* @${escapeMarkdown(outboundLead.username || "unknown")}`);
    if (outboundLead.source) {
      lines.push(`*Outbound Source:* ${escapeMarkdown(outboundLead.source)}`);
    }
    if (outboundLead.promptLabel) {
      lines.push(`*Prompt:* ${escapeMarkdown(outboundLead.promptLabel)}`);
    }
    if (senderUsername) {
      lines.push(`*IG Sender:* @${escapeMarkdown(senderUsername)}`);
    }
  }

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
