const express = require("express");
const Lead = require("../models/Lead");

const router = express.Router();

// POST /calendly - Calendly webhook
router.post("/", async (req, res) => {
  try {
    console.log("Calendly webhook received:", JSON.stringify(req.body, null, 2));

    const { event, payload } = req.body;

    console.log("Event type:", event);

    // Only handle invitee.created events
    if (event !== "invitee.created") {
      console.log("Event ignored:", event);
      return res.json({ success: true, message: "Event ignored" });
    }

    const contactId = payload?.tracking?.utm_medium;
    const email = payload?.email;

    console.log("Extracted data:", { contactId, email });
    console.log("Full tracking:", payload?.tracking);

    if (!contactId) {
      console.log("Missing utm_medium");
      return res.status(400).json({ error: "Missing utm_medium (contact_id)" });
    }

    // Find lead by contact_id and update booked_at and email
    console.log("Searching for lead with contact_id:", contactId);

    const lead = await Lead.findOneAndUpdate(
      { contact_id: contactId },
      {
        booked_at: new Date(),
        ...(email && { email }),
      },
      { new: true },
    );

    console.log("Update result:", lead);

    if (!lead) {
      console.log("Lead not found for contact_id:", contactId);
      return res.status(404).json({ error: "Lead not found" });
    }

    console.log("Lead updated successfully:", lead._id);
    res.json({ success: true, lead });
  } catch (error) {
    console.error("Calendly webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
