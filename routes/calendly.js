const logger = require("../utils/logger").child({ module: "calendly" });
const express = require("express");
const Lead = require("../models/Lead");
const Account = require("../models/Account");
const { encrypt } = require("../utils/crypto");

const router = express.Router();

// POST /calendly/add - Register Calendly webhook subscription
router.post("/add", async (req, res) => {
  try {
    const {
      token,
      user: { ghl: accountId },
    } = req.body;
    logger.info(token, accountId);

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
      logger.error("Calendly user fetch error:", errorData);
      return res
        .status(userResponse.status)
        .json({ error: "Failed to fetch Calendly user", details: errorData });
    }

    const userData = await userResponse.json();
    const organization = userData.resource.current_organization;
    const userUri = userData.resource.uri;

    logger.info("Calendly user:", { organization, userUri });

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
      logger.error("Calendly webhook subscription error:", webhookData);
      return res.status(webhookResponse.status).json({
        error: "Failed to create webhook subscription",
        details: webhookData,
      });
    }

    logger.info("Webhook subscription created:", webhookData);

    // Step 3: Save token to user's account
    await Account.findOneAndUpdate(
      { ghl: accountId },
      { calendly_token: encrypt(token) },
    );

    res.json({ success: true, webhook: webhookData });
  } catch (error) {
    logger.error("Calendly add error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/calendly - Calendly webhook
router.post("/", async (req, res) => {
  try {
    logger.info(
      "Calendly webhook received:",
      JSON.stringify(req.body, null, 2),
    );

    const { event, payload } = req.body;

    logger.info("Event type:", event);

    // Only handle invitee.created events
    if (event !== "invitee.created") {
      logger.info("Event ignored:", event);
      return res.json({ success: true, message: "Event ignored" });
    }

    const contactId = payload?.tracking?.utm_medium;
    const email = payload?.email;
    const questionsAndAnswers = payload?.questions_and_answers || [];

    logger.info("Extracted data:", { contactId, email, questionsAndAnswers });
    logger.info("Full tracking:", payload?.tracking);

    if (!contactId) {
      logger.info("Missing utm_medium");
      return res.status(400).json({ error: "Missing utm_medium (contact_id)" });
    }

    // Find lead by contact_id and update booked_at and email
    logger.info("Searching for lead with contact_id:", contactId);

    const lead = await Lead.findOneAndUpdate(
      { contact_id: contactId },
      {
        booked_at: new Date(),
        ...(email && { email }),
        questions_and_answers: questionsAndAnswers,
      },
      { new: true },
    );

    logger.info("Update result:", lead);

    if (!lead) {
      logger.info("Lead not found for contact_id:", contactId);
      return res.status(404).json({ error: "Lead not found" });
    }

    logger.info("Lead updated successfully:", lead._id);

    // Fetch account to get dynamic webhook URL
    const account = await Account.findOne({ ghl: lead.account_id });

    if (!account) {
      logger.info("Account not found for account_id:", lead.account_id);
      return res.status(404).json({ error: "Account not found" });
    }

    const webhookUrl = account.ghl_lead_booked_webhook;

    if (!webhookUrl) {
      logger.info("No GHL webhook configured for account:", lead.account_id);
      return res.json({ success: true, lead, message: "Booked. No webhook configured." });
    }

    // Call account-specific GHL webhook with contact_id
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId }),
      });
      logger.info("GHL webhook called:", webhookUrl, "contact_id:", contactId);
    } catch (webhookError) {
      logger.error("GHL webhook error:", webhookError);
    }

    res.json({ success: true, lead });
  } catch (error) {
    logger.error("Calendly webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/test", async (req, res) => {
  try {
    logger.info(
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
      logger.info("External webhook called with contact_id:", contactId);
    } catch (webhookError) {
      logger.error("External webhook error:", webhookError);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
