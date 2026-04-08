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

/**
 * Send a Telegram message when a campaign completes (no more leads to send).
 */
async function notifyCampaignCompleted(account, campaign, stats) {
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

  const lines = [];
  lines.push("📢 *Campaign Completed*");
  lines.push("");
  lines.push(`*Campaign:* ${escapeMarkdown(campaign.name)}`);
  lines.push(`*Reason:* No more leads to send`);

  if (stats) {
    lines.push("");
    lines.push("📊 *Stats*");
    if (stats.sent != null) lines.push(`*Sent:* ${stats.sent}`);
    if (stats.delivered != null) lines.push(`*Delivered:* ${stats.delivered}`);
    if (stats.replied != null) lines.push(`*Replied:* ${stats.replied}`);
    if (stats.failed != null) lines.push(`*Failed:* ${stats.failed}`);
    if (stats.skipped != null) lines.push(`*Skipped:* ${stats.skipped}`);
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
      logger.error({ status: res.status, err }, "Telegram campaign-completed notification failed");
    }
  } catch (err) {
    logger.error({ err }, "Telegram campaign-completed notification error");
  }
}

/**
 * Send a Telegram message when the DM Assistant marks a lead with a follow-up.
 *
 * Fires in two cases:
 *  - reason: "new"        → a brand-new FollowUp doc was created for this lead
 *  - reason: "follow_up_later" → existing follow-up transitioned into the
 *    "follow_up_later" status (conversation stalled / max follow-ups reached)
 */
async function notifyAiFollowUp(account, { lead, status, reason, outboundAccount }) {
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

  const username = lead?.username || "unknown";
  const fullName = lead?.fullName || null;

  const lines = [];
  if (reason === "follow_up_later") {
    lines.push("⏰ *AI moved lead to Follow-Up Later*");
  } else {
    lines.push("🆕 *AI created a new Follow-Up*");
  }
  lines.push("");
  lines.push(`*Lead:* @${escapeMarkdown(username)}`);
  if (fullName) lines.push(`*Name:* ${escapeMarkdown(fullName)}`);
  if (status) lines.push(`*Status:* ${escapeMarkdown(status)}`);
  if (outboundAccount?.username) {
    lines.push(`*IG Sender:* @${escapeMarkdown(outboundAccount.username)}`);
  }
  if (lead?.profileLink) {
    lines.push("");
    lines.push(`[View on Instagram](${lead.profileLink})`);
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
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      logger.error({ status: res.status, err }, "Telegram AI follow-up notification failed");
    }
  } catch (err) {
    logger.error({ err }, "Telegram AI follow-up notification error");
  }
}

module.exports = { notifyNewLead, notifyCampaignCompleted, notifyAiFollowUp };
