const express = require("express");
const Lead = require("../models/Lead");

const router = express.Router();

// POST /calendly - Calendly webhook
router.post("/", async (req, res) => {
  try {
    const { event, payload } = req.body;

    // Only handle invitee.created events
    if (event !== "invitee.created") {
      return res.json({ success: true, message: "Event ignored" });
    }

    const contactId = payload?.tracking?.utm_medium;
    const email = payload?.email;

    if (!contactId) {
      return res.status(400).json({ error: "Missing utm_medium (contact_id)" });
    }

    // Find lead by contact_id and update booked_at and email
    const lead = await Lead.findOneAndUpdate(
      { contact_id: contactId },
      {
        booked_at: new Date(),
        ...(email && { email }),
      },
      { new: true },
    );

    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    res.json({ success: true, lead });
  } catch (error) {
    console.error("Calendly webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
