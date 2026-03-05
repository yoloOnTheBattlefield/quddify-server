const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const IgAttachment = require("../models/IgAttachment");
const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");

// ─── Signature verification ─────────────────────────────────────────────────
function verifySignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("[ig-webhook] Missing x-hub-signature-256");
    return res.status(401).json({ error: "Missing signature" });
  }

  // Meta signs webhooks with the Facebook App Secret, not the Instagram App Secret
  const appSecret = process.env.FB_APP_SECRET || process.env.IG_APP_SECRET;
  if (!appSecret) {
    console.error("[ig-webhook] FB_APP_SECRET/IG_APP_SECRET not configured");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    console.warn("[ig-webhook] Invalid signature");
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
    console.log("[ig-webhook] Verification successful");
    return res.type("text/plain").status(200).send(challenge);
  }

  console.warn("[ig-webhook] Verification failed", { mode, token });
  return res.status(403).json({ error: "Verification failed" });
});

// ─── POST /instagram-webhook — receive events ───────────────────────────────
router.post("/", verifySignature, (req, res) => {
  console.log("[ig-webhook] POST received:", JSON.stringify(req.body, null, 2));

  // Always respond 200 to Meta immediately
  res.status(200).json({ status: "ok" });

  // Process async
  processWebhookEvent(req.body).catch((err) => {
    console.error("[ig-webhook] Processing error:", err);
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
        console.log("[ig-webhook] Delivery event:", event.delivery?.mids);
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
    console.warn(`[ig-webhook] Failed to resolve username for ${igScopedId}:`, err.message);
    return null;
  }
}

// ─── Find page access token for an IG user ID (recipient) ───────────────────
async function findPageAccessToken(igUserId) {
  // Check main accounts first
  const account = await Account.findOne({ "ig_oauth.ig_user_id": igUserId });
  if (account?.ig_oauth?.page_access_token) return account.ig_oauth.page_access_token;

  // Check outbound accounts
  const outbound = await OutboundAccount.findOne({ "ig_oauth.ig_user_id": igUserId });
  if (outbound?.ig_oauth?.page_access_token) return outbound.ig_oauth.page_access_token;

  return null;
}

// ─── Handle incoming/outgoing message ────────────────────────────────────────
async function handleMessage(event, senderId, recipientId) {
  const msg = event.message;
  const threadId = buildThreadId(senderId, recipientId);
  const messageTimestamp = new Date(parseInt(event.timestamp, 10));

  // Upsert conversation
  const conversation = await IgConversation.findOneAndUpdate(
    { instagram_thread_id: threadId },
    {
      $set: { last_message_at: messageTimestamp },
      $addToSet: { participant_ids: { $each: [senderId, recipientId] } },
      $setOnInsert: { instagram_thread_id: threadId },
    },
    { upsert: true, new: true },
  );

  // Resolve participant usernames if not already known
  const knownUsernames = conversation.participant_usernames || new Map();
  const unknownIds = [senderId, recipientId].filter((id) => !knownUsernames.get(id));

  if (unknownIds.length > 0) {
    const pageAccessToken = await findPageAccessToken(recipientId) || await findPageAccessToken(senderId);
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
        console.log("[ig-webhook] Resolved usernames:", usernameUpdates);
      }
    }
  }

  // Deduplicate on message_id
  const existing = await IgMessage.findOne({ message_id: msg.mid });
  if (existing) {
    console.log("[ig-webhook] Duplicate message skipped:", msg.mid);
    return;
  }

  // Insert message
  const newMessage = await IgMessage.create({
    conversation_id: conversation._id,
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

  console.log(
    `[ig-webhook] Message stored: ${msg.mid} in thread ${threadId}`,
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
    console.log(
      `[ig-webhook] Marked ${result.modifiedCount} message(s) as read in ${threadId}`,
    );
  }
}

module.exports = router;
