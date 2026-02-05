const express = require("express");
const Lead = require("../models/Lead");
const Account = require("../models/Account");

const router = express.Router();

// POST /calendly/add - Register Calendly webhook subscription
router.post("/add", async (req, res) => {
  try {
    const {
      token,
      user: { ghl: accountId },
    } = req.body;
    console.log(token, accountId);

    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    if (!accountId) {
      return res.status(400).json({ error: "Missing accountId" });
    }

    // Step 1: Get user info from Calendly
    const userResponse = await fetch("https://api.calendly.com/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!userResponse.ok) {
      const errorData = await userResponse.json();
      console.error("Calendly user fetch error:", errorData);
      return res
        .status(userResponse.status)
        .json({ error: "Failed to fetch Calendly user", details: errorData });
    }

    const userData = await userResponse.json();
    const organization = userData.resource.current_organization;
    const userUri = userData.resource.uri;

    console.log("Calendly user:", { organization, userUri });

    // Step 2: Create webhook subscription
    const webhookResponse = await fetch(
      "https://api.calendly.com/webhook_subscriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: "https://quddify-server.vercel.app/api/calendly",
          events: ["invitee.created"],
          organization: organization,
          scope: "user",
          user: userUri,
        }),
      },
    );

    const webhookData = await webhookResponse.json();

    if (!webhookResponse.ok) {
      console.error("Calendly webhook subscription error:", webhookData);
      return res.status(webhookResponse.status).json({
        error: "Failed to create webhook subscription",
        details: webhookData,
      });
    }

    console.log("Webhook subscription created:", webhookData);

    // Step 3: Save token to user's account
    await Account.findByIdAndUpdate(
      { ghl: accountId },
      { calendly_token: token },
    );

    res.json({ success: true, webhook: webhookData });
  } catch (error) {
    console.error("Calendly add error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /calendly - Calendly webhook
router.post("/", async (req, res) => {
  try {
    console.log(
      "Calendly webhook received:",
      JSON.stringify(req.body, null, 2),
    );

    const { event, payload } = req.body;

    console.log("Event type:", event);

    // Only handle invitee.created events
    if (event !== "invitee.created") {
      console.log("Event ignored:", event);
      return res.json({ success: true, message: "Event ignored" });
    }

    const contactId = payload?.tracking?.utm_medium;
    const email = payload?.email;
    const questionsAndAnswers = payload?.questions_and_answers || [];

    console.log("Extracted data:", { contactId, email, questionsAndAnswers });
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
        questions_and_answers: questionsAndAnswers,
      },
      { new: true },
    );

    console.log("Update result:", lead);

    if (!lead) {
      console.log("Lead not found for contact_id:", contactId);
      return res.status(404).json({ error: "Lead not found" });
    }

    console.log("Lead updated successfully:", lead._id);

    // Call external webhook with contact_id
    try {
      await fetch(
        "https://services.leadconnectorhq.com/hooks/prwfuJM2J2uvIWaTyhPd/webhook-trigger/af3a6920-6d6f-4053-bfbf-24b5f44e7ba2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id: contactId }),
        },
      );
      console.log("External webhook called with contact_id:", contactId);
    } catch (webhookError) {
      console.error("External webhook error:", webhookError);
    }

    res.json({ success: true, lead });
  } catch (error) {
    console.error("Calendly webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/test", async (req, res) => {
  try {
    console.log(
      "Calendly webhook received:",
      JSON.stringify(req.body, null, 2),
    );

    // Call external webhook with contact_id
    try {
      await fetch(
        "https://services.leadconnectorhq.com/hooks/prwfuJM2J2uvIWaTyhPd/webhook-trigger/af3a6920-6d6f-4053-bfbf-24b5f44e7ba2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id: "WF8mVUX8DAfOH6QF1uzO" }),
        },
      );
      console.log("External webhook called with contact_id:", contactId);
    } catch (webhookError) {
      console.error("External webhook error:", webhookError);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
