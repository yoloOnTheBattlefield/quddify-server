const express = require("express");
const Lead = require("../models/Lead");

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

    const ghl = req.account.ghl;
    const firstName =
      first_name || (full_name ? full_name.split(" ")[0] : null);
    const lastName =
      last_name ||
      (full_name && full_name.includes(" ")
        ? full_name.split(" ").slice(1).join(" ")
        : null);

    const lead = await Lead.findOneAndUpdate(
      { ig_username: username, account_id: ghl },
      {
        $set: {
          first_name: firstName,
          last_name: lastName,
          source: `manychat:${trigger_type || "unknown"}`,
        },
        $setOnInsert: {
          date_created: new Date().toISOString(),
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
      ig_username: lead.ig_username,
    });
  } catch (err) {
    console.error("[manychat] Webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
