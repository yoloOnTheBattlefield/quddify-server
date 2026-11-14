const logger = require("../utils/logger").child({ module: "instagram-webhook" });
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const IgAttachment = require("../models/IgAttachment");
const Account = require("../models/Account");
const { findIgOwner } = require("../utils/igOwner");
const Lead = require("../models/Lead");
const escapeRegex = require("../utils/escapeRegex");
const Notification = require("../models/Notification");
const socketManager = require("../services/socketManager");
const { sendPushToAccount } = require("../services/pushNotifications");
const commentAutomation = require("../services/commentAutomation");

// ─── Signature verification ─────────────────────────────────────────────────
function verifySignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    logger.warn("[ig-webhook] Missing x-hub-signature-256");
    return res.status(401).json({ error: "Missing signature" });
  }

  // Meta signs webhooks with the Facebook App Secret, not the Instagram App Secret
  const appSecret = process.env.FB_APP_SECRET || process.env.IG_APP_SECRET;
  if (!appSecret) {
    logger.error("[ig-webhook] FB_APP_SECRET/IG_APP_SECRET not configured");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    logger.warn("[ig-webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  next();
}

// ─── Helper: build thread ID from two participant IDs ────────────────────────
function buildThreadId(idA, idB) {
  return [idA, idB].sort().join("_");
}

// ─── Fire in-app + browser push notification ────────────────────────────────
async function fireLeadNotification(accountId, type, username) {
  try {
    const account = await Account.findById(accountId).select("push_notifications_enabled").lean();
    if (!account || account.push_notifications_enabled === false) return;

    const isNew = type === "new_lead";
    const title = isNew ? "New lead" : "Lead replied";
    const message = isNew
      ? `@${username} started a new conversation`
      : `@${username} replied to your DM`;

    const notification = await Notification.create({
      account_id: accountId,
      type,
      title,
      message,
    });

    socketManager.emitToAccount(accountId.toString(), "notification:lead", {
      notification: { _id: notification._id, type, title, message, read: false, created_at: notification.created_at },
    });

    await sendPushToAccount(accountId, { title, body: message, type });
  } catch (err) {
    logger.error("[ig-webhook] fireLeadNotification error:", err);
  }
}

// ─── GET  /instagram-webhook — Meta verification handshake ───────────────────
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.IG_VERIFY_TOKEN) {
    logger.info("[ig-webhook] Verification successful");
    return res.type("text/plain").status(200).send(challenge);
  }

  logger.warn("[ig-webhook] Verification failed", { mode, token });
  return res.status(403).json({ error: "Verification failed" });
});

// ─── POST /instagram-webhook — receive events ───────────────────────────────
router.post("/", verifySignature, (req, res) => {
  logger.info("[ig-webhook] POST received:", JSON.stringify(req.body, null, 2));

  // Always respond 200 to Meta immediately
  res.status(200).json({ status: "ok" });

  // Process async
  processWebhookEvent(req.body).catch((err) => {
    logger.error("[ig-webhook] Processing error:", err);
  });
});

async function processWebhookEvent(body) {
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    // Comment events arrive on `changes`, not `messaging`
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;
      try {
        await commentAutomation.handleCommentChange(change.value, entry.id);
      } catch (err) {
        logger.error("[ig-webhook] Comment automation error:", err);
      }
    }

    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const recipientId = event.recipient?.id;

      if (!senderId || !recipientId) continue;

      if (event.message) {
        await handleMessage(event, senderId, recipientId);
      } else if (event.read) {
        await handleReadReceipt(event, senderId, recipientId);
      } else if (event.delivery) {
        // Delivery receipts — logged but no DB action needed
        logger.info("[ig-webhook] Delivery event:", event.delivery?.mids);
      }
    }
  }
}

// ─── Resolve IG username from scoped user ID ────────────────────────────────
async function resolveUsername(igScopedId, pageAccessToken) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${igScopedId}?fields=name,username&access_token=${pageAccessToken}`,
    );
    const data = await r.json();
    return data.username || data.name || null;
  } catch (err) {
    logger.warn(`[ig-webhook] Failed to resolve username for ${igScopedId}:`, err.message);
    return null;
  }
}

// ─── Find the owning account for an IG user ID ─────────────────────
// Shared with services/commentAutomation.js so both paths resolve ownership
// (and decrypt the page token) identically.
const findOwner = findIgOwner;

// ─── Handle incoming/outgoing message ────────────────────────────────────────
async function handleMessage(event, senderId, recipientId) {
  const msg = event.message;
  const threadId = buildThreadId(senderId, recipientId);
  const messageTimestamp = new Date(parseInt(event.timestamp, 10));

  // Resolve which account owns this conversation (sender or recipient is our IG account)
  const recipientOwner = await findOwner(recipientId);
  const senderOwner = recipientOwner ? null : await findOwner(senderId);
  const owner = recipientOwner || senderOwner;
  const ownerIgUserId = owner ? (recipientOwner ? recipientId : senderId) : null;

  // direction: "inbound" = someone DM'd our account, "outbound" = our account sent a DM
  const direction = owner && ownerIgUserId === senderId ? "outbound" : "inbound";

  // Upsert conversation
  const conversationUpdate = {
    $set: { last_message_at: messageTimestamp },
    $addToSet: { participant_ids: { $each: [senderId, recipientId] } },
    $setOnInsert: { instagram_thread_id: threadId },
  };

  // Set account ownership on first insert or if missing
  if (owner) {
    conversationUpdate.$set.account_id = owner.account_id;
    conversationUpdate.$set.owner_ig_user_id = ownerIgUserId;
  }

  const conversation = await IgConversation.findOneAndUpdate(
    { instagram_thread_id: threadId },
    conversationUpdate,
    { upsert: true, new: true },
  );

  // Resolve participant usernames if not already known
  const knownUsernames = conversation.participant_usernames || new Map();
  const unknownIds = [senderId, recipientId].filter((id) => !knownUsernames.get(id));

  if (unknownIds.length > 0) {
    const pageAccessToken = owner?.pageAccessToken || null;
    if (pageAccessToken) {
      const usernameUpdates = {};
      for (const id of unknownIds) {
        const username = await resolveUsername(id, pageAccessToken);
        if (username) {
          usernameUpdates[`participant_usernames.${id}`] = username;
        }
      }
      if (Object.keys(usernameUpdates).length > 0) {
        await IgConversation.findByIdAndUpdate(conversation._id, { $set: usernameUpdates });
        logger.info("[ig-webhook] Resolved usernames:", usernameUpdates);
      }
    }
  }

  // Link conversation to leads (match the non-owner participant's username)
  if (owner && !conversation.lead_id) {
    const contactIgId = ownerIgUserId === senderId ? recipientId : senderId;
    const updatedConv = await IgConversation.findById(conversation._id);
    const contactUsername = updatedConv?.participant_usernames?.get(contactIgId) || knownUsernames.get(contactIgId);

    if (contactUsername) {
      const leadUpdates = {};

      // Check Lead
      const lead = await Lead.findOne({
        ig_username: { $regex: new RegExp(`^${escapeRegex(contactUsername)}$`, "i") },
        account_id: String(owner.account_id),
      });
      if (lead) {
        leadUpdates.lead_id = lead._id;
        await Lead.findByIdAndUpdate(lead._id, {
          $set: { ig_thread_id: threadId },
        });
      }

      if (Object.keys(leadUpdates).length > 0) {
        await IgConversation.findByIdAndUpdate(conversation._id, { $set: leadUpdates });
        logger.info(`[ig-webhook] Linked conversation to leads:`, leadUpdates);

        // Fire new_lead notification when an inbound Lead first contacts us
        if (direction === "inbound" && leadUpdates.lead_id) {
          await fireLeadNotification(owner.account_id, "new_lead", contactUsername);
        }
      }
    }
  }

  // Every inbound DM gets a contact: match by IG id if the username lookup
  // found nothing, otherwise create one. Never for our own account's id.
  if (owner && direction === "inbound") {
    await ensureInboundContact({
      owner,
      conversationId: conversation._id,
      contactIgId: senderId,
      ownerIgUserId,
      threadId,
      messageTimestamp,
      zernioConversationId: event.zernio_conversation_id || null,
    });
  } else if (event.zernio_conversation_id) {
    await IgConversation.updateOne(
      { _id: conversation._id, zernio_conversation_id: null },
      { $set: { zernio_conversation_id: event.zernio_conversation_id } },
    );
  }

  // Deduplicate on message_id
  const existing = await IgMessage.findOne({ message_id: msg.mid });
  if (existing) {
    logger.info("[ig-webhook] Duplicate message skipped:", msg.mid);
    return;
  }

  // Insert message
  await IgMessage.create({
    conversation_id: conversation._id,
    account_id: owner?.account_id || null,
    direction,
    sender_id: senderId,
    recipient_id: recipientId,
    message_text: msg.text || null,
    message_id: msg.mid,
    sent_by: direction === "inbound" ? "lead" : null,
    timestamp: messageTimestamp,
    raw_payload: event,
  });

  // Handle attachments
  if (msg.attachments && msg.attachments.length > 0) {
    const attachmentDocs = msg.attachments.map((att) => ({
      conversation_id: conversation._id,
      message_id: msg.mid,
      type: att.type,
      payload_url: att.payload?.url || null,
    }));
    await IgAttachment.insertMany(attachmentDocs);
  }

  logger.info(
    `[ig-webhook] Message stored: ${msg.mid} in thread ${threadId} (${direction}, account: ${owner?.account_id || "unknown"})`,
  );
}

// ─── Inbound contact bookkeeping ─────────────────────────────────────────────
async function ensureInboundContact({
  owner,
  conversationId,
  contactIgId,
  ownerIgUserId,
  threadId,
  messageTimestamp,
  zernioConversationId,
}) {
  if (!contactIgId || contactIgId === ownerIgUserId) return;
  const accountId = String(owner.account_id);

  try {
    const conv = await IgConversation.findById(conversationId);
    let lead = conv?.lead_id ? await Lead.findOne({ _id: conv.lead_id, account_id: accountId }) : null;
    if (!lead) lead = await Lead.findOne({ account_id: accountId, ig_user_id: contactIgId });

    let created = false;
    if (!lead) {
      const username = conv?.participant_usernames?.get(contactIgId) || null;
      if (username) {
        lead = await Lead.findOne({
          account_id: accountId,
          ig_username: { $regex: new RegExp(`^${escapeRegex(username)}$`, "i") },
        });
      }
      if (!lead) {
        lead = await Lead.create({
          account_id: accountId,
          platform: "instagram",
          ig_username: username,
          ig_user_id: contactIgId,
          source: "ig_dm",
          stage: "new",
          ig_thread_id: threadId,
          date_created: new Date().toISOString(),
          first_conversation_at: messageTimestamp,
          ...(zernioConversationId ? { zernio_conversation_id: zernioConversationId } : {}),
        });
        created = true;
        logger.info(`[ig-webhook] Created contact ${lead._id} for IG user ${contactIgId}`);
      }
    }

    const set = {};
    if (!lead.ig_user_id) set.ig_user_id = contactIgId;
    if (!lead.ig_thread_id) set.ig_thread_id = threadId;
    if (zernioConversationId && !lead.zernio_conversation_id) set.zernio_conversation_id = zernioConversationId;
    if (!lead.first_conversation_at) set.first_conversation_at = messageTimestamp;
    await Lead.updateOne(
      { _id: lead._id },
      { $max: { last_inbound_at: messageTimestamp, last_conversation_at: messageTimestamp }, ...(Object.keys(set).length ? { $set: set } : {}) },
    );

    const convSet = {};
    if (!conv?.lead_id) convSet.lead_id = lead._id;
    if (zernioConversationId && !conv?.zernio_conversation_id) convSet.zernio_conversation_id = zernioConversationId;
    if (Object.keys(convSet).length) await IgConversation.updateOne({ _id: conversationId }, { $set: convSet });

    if (created) {
      await fireLeadNotification(owner.account_id, "new_lead", lead.ig_username || contactIgId);
    }
  } catch (err) {
    logger.error("[ig-webhook] ensureInboundContact failed:", err);
  }
}

// ─── Handle read receipt ─────────────────────────────────────────────────────
async function handleReadReceipt(event, senderId, recipientId) {
  const watermark = parseInt(event.read.watermark, 10);
  const threadId = buildThreadId(senderId, recipientId);

  const conversation = await IgConversation.findOne({
    instagram_thread_id: threadId,
  });
  if (!conversation) return;

  // Mark all messages before the watermark as read
  // (only messages NOT sent by the reader — the reader is the sender of the read event)
  const result = await IgMessage.updateMany(
    {
      conversation_id: conversation._id,
      sender_id: { $ne: senderId }, // messages sent TO the reader
      timestamp: { $lte: new Date(watermark) },
      read_at: null,
    },
    { $set: { read_at: new Date() } },
  );

  if (result.modifiedCount > 0) {
    logger.info(
      `[ig-webhook] Marked ${result.modifiedCount} message(s) as read in ${threadId}`,
    );
  }
}

module.exports = router;
// Zernio normalizes its events into this same Meta envelope, so its webhook
// route reuses this processor rather than duplicating the handling.
module.exports.processWebhookEvent = processWebhookEvent;
