const express = require("express");
const mongoose = require("mongoose");
const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const {
  resolveTemplate,
  isWithinActiveHours,
  calculateDelay,
} = require("../services/campaignScheduler");

const router = express.Router();

// GET /api/manual-campaigns/next?sender_id=&campaign_id= (campaign_id optional)
router.get("/next", async (req, res) => {
  try {
    const { campaign_id, sender_id, test_mode } = req.query;
    const isTestMode = test_mode === "true";

    if (!sender_id || !mongoose.Types.ObjectId.isValid(sender_id)) {
      return res.status(400).json({ error: "Valid sender_id is required" });
    }

    let campaign;

    if (campaign_id) {
      if (!mongoose.Types.ObjectId.isValid(campaign_id)) {
        return res.status(400).json({ error: "Invalid campaign_id" });
      }
      campaign = await Campaign.findOne({
        _id: campaign_id,
        account_id: req.account._id,
        mode: "manual",
        status: "active",
      });
    } else {
      // Auto-detect: find active manual campaign that includes this sender
      campaign = await Campaign.findOne({
        account_id: req.account._id,
        mode: "manual",
        status: "active",
        sender_ids: sender_id,
      });
    }

    if (!campaign) {
      return res.json({ status: "idle", reason: "No active manual campaign for this sender" });
    }

    // In test mode, skip active hours, daily limit, and cooldown checks
    if (!isTestMode) {
      // Check active hours
      if (!isWithinActiveHours(campaign.schedule)) {
        return res.json({
          status: "idle",
          reason: "Outside active hours",
          schedule: {
            start: campaign.schedule.active_hours_start,
            end: campaign.schedule.active_hours_end,
            timezone: campaign.schedule.timezone,
          },
        });
      }

      // Check daily limit for this sender
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const sentToday = await CampaignLead.countDocuments({
        campaign_id: campaign._id,
        sender_id,
        status: "sent",
        sent_at: { $gte: todayStart },
      });

      const dailyLimit = campaign.daily_limit_per_sender || 50;
      if (sentToday >= dailyLimit) {
        return res.json({
          status: "idle",
          reason: "Daily limit reached",
          sent: sentToday,
          limit: dailyLimit,
        });
      }

      // Check cooldown
      const delaySec = calculateDelay(campaign, 1);
      if (campaign.last_sent_at) {
        const elapsed = (Date.now() - campaign.last_sent_at.getTime()) / 1000;
        if (elapsed < delaySec) {
          const wait = Math.ceil(delaySec - elapsed);
          return res.json({ status: "wait", wait_seconds: wait });
        }
      }
    }

    // Atomically lock the next pending lead
    const campaignLead = await CampaignLead.findOneAndUpdate(
      { campaign_id: campaign._id, status: "pending" },
      {
        $set: {
          status: "queued",
          sender_id,
          queued_at: new Date(),
        },
      },
      { sort: { _id: 1 }, new: true },
    );

    if (!campaignLead) {
      // Check if there are still queued leads (being processed by another VA)
      const queuedCount = await CampaignLead.countDocuments({
        campaign_id: campaign._id,
        status: "queued",
      });

      if (queuedCount === 0) {
        campaign.status = "completed";
        await campaign.save();
      }

      return res.json({ status: "done" });
    }

    // Fetch outbound lead data
    const outboundLead = await OutboundLead.findById(campaignLead.outbound_lead_id).lean();
    if (!outboundLead) {
      await CampaignLead.findByIdAndUpdate(campaignLead._id, {
        $set: { status: "skipped", error: "Outbound lead not found" },
      });
      await Campaign.findByIdAndUpdate(campaign._id, {
        $inc: { "stats.queued": -1, "stats.skipped": 1, "stats.pending": -1 },
      });
      return res.json({ status: "skipped", reason: "Lead not found" });
    }

    // Check if already messaged
    if (outboundLead.isMessaged) {
      await CampaignLead.findByIdAndUpdate(campaignLead._id, {
        $set: { status: "skipped", error: "Lead already messaged" },
      });
      await Campaign.findByIdAndUpdate(campaign._id, {
        $inc: { "stats.queued": -1, "stats.skipped": 1, "stats.pending": -1 },
      });
      return res.json({ status: "skipped", reason: "Already messaged" });
    }

    // Resolve message template (round-robin)
    const messageIndex = (campaign.last_message_index || 0) % campaign.messages.length;
    const template = campaign.messages[messageIndex];
    const message = resolveTemplate(template, outboundLead);

    // Update campaign tracking
    campaign.last_message_index = (messageIndex + 1) % campaign.messages.length;
    campaign.stats.pending -= 1;
    campaign.stats.queued += 1;
    await campaign.save();

    // Store the message and template index on the campaign lead
    await CampaignLead.findByIdAndUpdate(campaignLead._id, {
      $set: { message_used: message, template_index: messageIndex },
    });

    res.json({
      status: "lead",
      lead: {
        campaignLeadId: campaignLead._id,
        campaign_id: campaign._id,
        campaign_name: campaign.name,
        username: outboundLead.username,
        fullName: outboundLead.fullName,
        bio: outboundLead.bio,
        profileLink: outboundLead.profileLink,
        message,
      },
    });
  } catch (err) {
    console.error("Manual campaign next error:", err);
    res.status(500).json({ error: "Failed to get next lead" });
  }
});

// POST /api/manual-campaigns/confirm
router.post("/confirm", async (req, res) => {
  try {
    const { campaign_lead_id, sender_id } = req.body;

    if (!campaign_lead_id || !mongoose.Types.ObjectId.isValid(campaign_lead_id)) {
      return res.status(400).json({ error: "Valid campaign_lead_id is required" });
    }
    if (!sender_id || !mongoose.Types.ObjectId.isValid(sender_id)) {
      return res.status(400).json({ error: "Valid sender_id is required" });
    }

    const campaignLead = await CampaignLead.findById(campaign_lead_id);
    if (!campaignLead) {
      return res.status(404).json({ error: "Campaign lead not found" });
    }

    if (campaignLead.status !== "queued") {
      return res.status(400).json({ error: `Lead status is ${campaignLead.status}, expected queued` });
    }

    if (campaignLead.sender_id.toString() !== sender_id) {
      return res.status(403).json({ error: "Sender mismatch" });
    }

    // Update campaign lead
    campaignLead.status = "sent";
    campaignLead.sent_at = new Date();
    await campaignLead.save();

    // Mark outbound lead as messaged
    await OutboundLead.findByIdAndUpdate(campaignLead.outbound_lead_id, {
      $set: { isMessaged: true },
    });

    // Update campaign stats + last_sent_at
    const campaign = await Campaign.findById(campaignLead.campaign_id);
    if (campaign) {
      campaign.stats.queued -= 1;
      campaign.stats.sent += 1;
      campaign.last_sent_at = new Date();
      await campaign.save();

      // Auto-complete check
      const remaining = await CampaignLead.countDocuments({
        campaign_id: campaign._id,
        status: { $in: ["pending", "queued"] },
      });

      if (remaining === 0) {
        campaign.status = "completed";
        await campaign.save();
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Manual campaign confirm error:", err);
    res.status(500).json({ error: "Failed to confirm" });
  }
});

// POST /api/manual-campaigns/skip
router.post("/skip", async (req, res) => {
  try {
    const { campaign_lead_id, reason } = req.body;

    if (!campaign_lead_id || !mongoose.Types.ObjectId.isValid(campaign_lead_id)) {
      return res.status(400).json({ error: "Valid campaign_lead_id is required" });
    }

    const campaignLead = await CampaignLead.findById(campaign_lead_id);
    if (!campaignLead) {
      return res.status(404).json({ error: "Campaign lead not found" });
    }

    if (campaignLead.status !== "queued") {
      return res.status(400).json({ error: `Lead status is ${campaignLead.status}, expected queued` });
    }

    // Update campaign lead
    campaignLead.status = "skipped";
    campaignLead.error = reason || "Skipped by VA";
    await campaignLead.save();

    // Update campaign stats
    const campaign = await Campaign.findById(campaignLead.campaign_id);
    if (campaign) {
      campaign.stats.queued -= 1;
      campaign.stats.skipped += 1;
      await campaign.save();

      // Auto-complete check
      const remaining = await CampaignLead.countDocuments({
        campaign_id: campaign._id,
        status: { $in: ["pending", "queued"] },
      });

      if (remaining === 0) {
        campaign.status = "completed";
        await campaign.save();
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Manual campaign skip error:", err);
    res.status(500).json({ error: "Failed to skip" });
  }
});

module.exports = router;
