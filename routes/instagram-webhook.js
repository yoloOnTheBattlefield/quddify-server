const logger = require("../utils/logger").child({ module: "instagram-webhook" });
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const IgAttachment = require("../models/IgAttachment");
const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");
const { decrypt } = require("../utils/crypto");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");

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

// ─── Find the owning account/outbound for an IG user ID ─────────────────────
async function findOwner(igUserId) {
  const account = await Account.findOne({ "ig_oauth.ig_user_id": igUserId });
  if (account) {
    return {
      account_id: account._id,
      outbound_account_id: null,
      pageAccessToken: decrypt(account.ig_oauth?.page_access_token) || null,
    };
  }

  const outbound = await OutboundAccount.findOne({ "ig_oauth.ig_user_id": igUserId });
  if (outbound) {
    return {
      account_id: outbound.account_id,
      outbound_account_id: outbound._id,
      pageAccessToken: decrypt(outbound.ig_oauth?.page_access_token) || null,
    };
  }

  return null;
}

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
    if (owner.outbound_account_id) {
      conversationUpdate.$set.outbound_account_id = owner.outbound_account_id;
    }
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
  if (owner && !conversation.lead_id && !conversation.outbound_lead_id) {
    const contactIgId = ownerIgUserId === senderId ? recipientId : senderId;
    const updatedConv = await IgConversation.findById(conversation._id);
    const contactUsername = updatedConv?.participant_usernames?.get(contactIgId) || knownUsernames.get(contactIgId);

    if (contactUsername) {
      const leadUpdates = {};

      // Check OutboundLead first (more specific)
      const outboundLead = await OutboundLead.findOne({
        username: { $regex: new RegExp(`^${contactUsername}$`, "i") },
        account_id: owner.account_id,
      });
      if (outboundLead) {
        leadUpdates.outbound_lead_id = outboundLead._id;
        await OutboundLead.findByIdAndUpdate(outboundLead._id, {
          $set: { ig_thread_id: threadId },
        });
        // Mark replied if this is an inbound message (lead responded)
        if (direction === "inbound" && !outboundLead.replied) {
          await OutboundLead.findByIdAndUpdate(outboundLead._id, {
            $set: { replied: true, replied_at: messageTimestamp },
          });
          logger.info(`[ig-webhook] OutboundLead @${contactUsername} marked as replied`);
        }
      }

      // Check Lead
      const lead = await Lead.findOne({
        ig_username: { $regex: new RegExp(`^${contactUsername}$`, "i") },
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
      }
    }
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
    outbound_account_id: owner?.outbound_account_id || null,
    direction,
    sender_id: senderId,
    recipient_id: recipientId,
    message_text: msg.text || null,
    message_id: msg.mid,
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
