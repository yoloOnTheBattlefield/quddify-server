const express = require("express");
const OutboundLead = require("../models/OutboundLead");

const router = express.Router();

// POST /api/manychat/webhook — ManyChat External Request webhook
router.post("/webhook", async (req, res) => {
  try {
    const {
      ig_username,
      first_name,
      last_name,
      full_name,
      trigger_type,
    } = req.body;

    if (!ig_username) {
      return res.status(400).json({ error: "Missing ig_username" });
    }

    const username = ig_username.replace(/^@/, "").trim();
    if (!username) {
      return res.status(400).json({ error: "Invalid ig_username" });
    }

    const accountId = req.account._id;
    const source = "manychat";
    const followingKey = `${username}::${source}`;
    const fullName =
      full_name || [first_name, last_name].filter(Boolean).join(" ") || null;
    const profileLink = `https://www.instagram.com/${username}/`;

    const lead = await OutboundLead.findOneAndUpdate(
      { username, account_id: accountId },
      {
        $set: {
          followingKey,
          fullName,
          profileLink,
          source,
          metadata: {
            source: "manychat",
            trigger_type: trigger_type || null,
            syncedAt: new Date(),
          },
        },
        $setOnInsert: {
          isMessaged: null,
          qualified: null,
          ai_processed: false,
        },
      },
      { upsert: true, new: true },
    );

    console.log(
      `[manychat] Lead upserted: ${username} (trigger: ${trigger_type || "unknown"})`,
    );

    res.json({
      success: true,
      lead_id: lead._id,
      username: lead.username,
      created:
        !lead.updatedAt ||
        lead.createdAt.getTime() === lead.updatedAt.getTime(),
    });
  } catch (err) {
    console.error("[manychat] Webhook error:", err);

    if (err.code === 11000) {
      return res.json({ success: true, message: "Lead already exists" });
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
