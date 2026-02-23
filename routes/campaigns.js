const express = require("express");
const mongoose = require("mongoose");
const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const SenderAccount = require("../models/SenderAccount");
const { isWithinActiveHours, calculateDelay } = require("../services/campaignScheduler");
const router = express.Router();

// GET /api/campaigns — list campaigns
router.get("/", async (req, res) => {
  try {
    const { status, page, limit } = req.query;
    const filter = { account_id: req.account._id };

    if (status) filter.status = status;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Campaign.countDocuments(filter),
    ]);

    res.json({
      campaigns,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("List campaigns error:", err);
    res.status(500).json({ error: "Failed to list campaigns" });
  }
});

// GET /api/campaigns/:id/next-send — estimate next send time
router.get("/:id/next-send", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.status !== "active") {
      return res.json({
        status: campaign.status,
        next_send_at: null,
        delay_seconds: null,
        last_sent_at: campaign.last_sent_at || null,
        reason: `Campaign is ${campaign.status}`,
      });
    }

    // Check active hours
    const withinHours = isWithinActiveHours(campaign.schedule);

    // Count senders linked to this campaign
    const senders = await SenderAccount.find({
      outbound_account_id: { $in: campaign.outbound_account_ids },
    }).lean();

    const onlineSenders = senders.filter((s) => s.status === "online");
    const isTestMode = onlineSenders.some((s) => s.test_mode);

    if (senders.length === 0) {
      return res.json({
        status: "active",
        next_send_at: null,
        delay_seconds: null,
        last_sent_at: campaign.last_sent_at || null,
        within_active_hours: withinHours,
        online_senders: 0,
        total_senders: 0,
        reason: "No sender accounts linked",
      });
    }

    // Use base delay without jitter so the estimate is stable across polls
    const activeHours =
      (campaign.schedule.active_hours_end || 21) - (campaign.schedule.active_hours_start || 9);
    const totalDailyMessages =
      (campaign.daily_limit_per_sender || 50) * Math.max(senders.length, 1);
    const delaySec = isTestMode ? 30 : Math.max(Math.round((activeHours * 3600) / totalDailyMessages), 30);

    let nextSendAt = null;
    let reason = null;

    if (!isTestMode && !withinHours) {
      reason = "Outside active hours";
    } else if (onlineSenders.length === 0) {
      reason = "No senders online";
    } else if (campaign.stats.pending === 0) {
      reason = "No pending leads";
    } else if (campaign.last_sent_at) {
      const elapsed = (Date.now() - new Date(campaign.last_sent_at).getTime()) / 1000;
      const remaining = isTestMode ? 0 : Math.max(0, delaySec - elapsed);
      nextSendAt = new Date(Date.now() + remaining * 1000).toISOString();
    } else {
      // Never sent — next tick will send
      nextSendAt = new Date().toISOString();
    }

    const burstOnBreak = campaign.burst_break_until ? new Date(campaign.burst_break_until) > new Date() : false;

    res.json({
      status: "active",
      next_send_at: nextSendAt,
      delay_seconds: delaySec,
      last_sent_at: campaign.last_sent_at || null,
      within_active_hours: isTestMode || withinHours,
      online_senders: onlineSenders.length,
      total_senders: senders.length,
      pending_leads: campaign.stats.pending,
      reason: burstOnBreak ? "Burst group break" : reason,
      test_mode: isTestMode,
      burst_enabled: campaign.schedule?.burst_enabled || false,
      burst_sent_in_group: campaign.burst_sent_in_group || 0,
      burst_on_break: burstOnBreak,
      burst_break_remaining: campaign.burst_break_until
        ? Math.max(0, Math.round((new Date(campaign.burst_break_until).getTime() - Date.now()) / 1000))
        : null,
    });
  } catch (err) {
    console.error("Next send estimate error:", err);
    res.status(500).json({ error: "Failed to compute next send estimate" });
  }
});

// GET /api/campaigns/:id — single campaign
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json(campaign);
  } catch (err) {
    console.error("Get campaign error:", err);
    res.status(500).json({ error: "Failed to get campaign" });
  }
});

// POST /api/campaigns — create campaign (starts as draft)
router.post("/", async (req, res) => {
  try {
    const { name, mode, messages, outbound_account_ids, schedule, daily_limit_per_sender } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Campaign name is required" });
    }

    if (mode && !["auto", "manual"].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'auto' or 'manual'" });
    }

    const campaign = await Campaign.create({
      account_id: req.account._id,
      name,
      mode: mode || "auto",
      messages: messages || [],
      outbound_account_ids: outbound_account_ids || [],
      schedule: schedule || {},
      daily_limit_per_sender: daily_limit_per_sender || 50,
    });

    res.status(201).json(campaign);
  } catch (err) {
    console.error("Create campaign error:", err);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

// PATCH /api/campaigns/:id — update settings (only draft/paused)
router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.status === "active") {
      return res.status(400).json({ error: "Pause the campaign before editing" });
    }

    const { name, mode, messages, outbound_account_ids, schedule, daily_limit_per_sender } = req.body;

    if (mode !== undefined && !["auto", "manual"].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'auto' or 'manual'" });
    }

    if (name !== undefined) campaign.name = name;
    if (mode !== undefined) campaign.mode = mode;
    if (messages !== undefined) campaign.messages = messages;
    if (outbound_account_ids !== undefined) campaign.outbound_account_ids = outbound_account_ids;
    if (schedule !== undefined) {
      if (schedule.messages_per_group !== undefined && schedule.messages_per_group < 1) {
        return res.status(400).json({ error: "messages_per_group must be >= 1" });
      }
      if (schedule.min_delay_seconds !== undefined && schedule.min_delay_seconds < 10) {
        return res.status(400).json({ error: "min_delay_seconds must be >= 10" });
      }
      if (schedule.max_delay_seconds !== undefined && schedule.min_delay_seconds !== undefined
          && schedule.max_delay_seconds < schedule.min_delay_seconds) {
        return res.status(400).json({ error: "max_delay_seconds must be >= min_delay_seconds" });
      }
      if (schedule.min_group_break_seconds !== undefined && schedule.max_group_break_seconds !== undefined
          && schedule.max_group_break_seconds < schedule.min_group_break_seconds) {
        return res.status(400).json({ error: "max_group_break_seconds must be >= min_group_break_seconds" });
      }
      Object.assign(campaign.schedule, schedule);
    }
    if (daily_limit_per_sender !== undefined) {
      campaign.daily_limit_per_sender = daily_limit_per_sender;
    }

    await campaign.save();
    res.json(campaign);
  } catch (err) {
    console.error("Update campaign error:", err);
    res.status(500).json({ error: "Failed to update campaign" });
  }
});

// DELETE /api/campaigns/:id — delete campaign + its leads
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.status === "active") {
      return res.status(400).json({ error: "Cannot delete an active campaign. Pause it first." });
    }

    await CampaignLead.deleteMany({ campaign_id: campaign._id });
    await Campaign.findByIdAndDelete(campaign._id);

    res.json({ deleted: true });
  } catch (err) {
    console.error("Delete campaign error:", err);
    res.status(500).json({ error: "Failed to delete campaign" });
  }
});

// POST /api/campaigns/:id/start — activate campaign
router.post("/:id/start", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.status === "active") {
      return res.status(400).json({ error: "Campaign is already active" });
    }

    if (campaign.status === "completed") {
      return res.status(400).json({ error: "Campaign is already completed" });
    }

    // Validate campaign has messages
    if (!campaign.messages || campaign.messages.length === 0) {
      return res.status(400).json({ error: "Campaign must have at least one message template" });
    }

    // Validate campaign has outbound accounts
    if (!campaign.outbound_account_ids || campaign.outbound_account_ids.length === 0) {
      return res.status(400).json({ error: "Campaign must have at least one outbound account assigned" });
    }

    // Validate campaign has leads
    const leadCount = await CampaignLead.countDocuments({
      campaign_id: campaign._id,
      status: "pending",
    });

    if (leadCount === 0) {
      return res.status(400).json({ error: "Campaign must have pending leads to start" });
    }

    campaign.status = "active";
    campaign.burst_sent_in_group = 0;
    campaign.burst_break_until = null;
    await campaign.save();

    res.json({ success: true, status: "active" });
  } catch (err) {
    console.error("Start campaign error:", err);
    res.status(500).json({ error: "Failed to start campaign" });
  }
});

// POST /api/campaigns/:id/pause — pause campaign
router.post("/:id/pause", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.status !== "active") {
      return res.status(400).json({ error: "Only active campaigns can be paused" });
    }

    campaign.status = "paused";
    campaign.burst_sent_in_group = 0;
    campaign.burst_break_until = null;
    await campaign.save();

    res.json({ success: true, status: "paused" });
  } catch (err) {
    console.error("Pause campaign error:", err);
    res.status(500).json({ error: "Failed to pause campaign" });
  }
});

// GET /api/campaigns/:id/stats — campaign stats
router.get("/:id/stats", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json(campaign.stats);
  } catch (err) {
    console.error("Campaign stats error:", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// POST /api/campaigns/:id/recalc-stats — recompute stats from actual CampaignLead statuses
router.post("/:id/recalc-stats", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const counts = await CampaignLead.aggregate([
      { $match: { campaign_id: campaign._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const stats = { total: 0, pending: 0, queued: 0, sent: 0, delivered: 0, replied: 0, failed: 0, skipped: 0 };
    for (const c of counts) {
      if (stats.hasOwnProperty(c._id)) stats[c._id] = c.count;
      stats.total += c.count;
    }

    campaign.stats = stats;
    await campaign.save();

    res.json(stats);
  } catch (err) {
    console.error("Campaign recalc-stats error:", err);
    res.status(500).json({ error: "Failed to recalculate stats" });
  }
});

// POST /api/campaigns/:id/leads/retry — retry failed/skipped leads
router.post("/:id/leads/retry", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const { lead_ids } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: "lead_ids array is required" });
    }

    // Count how many are failed vs skipped before updating
    const counts = await CampaignLead.aggregate([
      {
        $match: {
          _id: { $in: lead_ids.map((id) => new mongoose.Types.ObjectId(id)) },
          campaign_id: campaign._id,
          status: { $in: ["failed", "skipped"] },
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const failedCount = counts.find((c) => c._id === "failed")?.count || 0;
    const skippedCount = counts.find((c) => c._id === "skipped")?.count || 0;
    const totalRetried = failedCount + skippedCount;

    if (totalRetried === 0) {
      return res.json({ retried: 0 });
    }

    // Reset leads to pending
    await CampaignLead.updateMany(
      {
        _id: { $in: lead_ids },
        campaign_id: campaign._id,
        status: { $in: ["failed", "skipped"] },
      },
      {
        $set: { status: "pending", sender_id: null, queued_at: null, task_id: null, error: null, message_used: null, template_index: null },
      },
    );

    // Adjust stats accurately
    const statsInc = { "stats.pending": totalRetried };
    if (failedCount > 0) statsInc["stats.failed"] = -failedCount;
    if (skippedCount > 0) statsInc["stats.skipped"] = -skippedCount;
    const update = { $inc: statsInc };

    // If campaign was completed, move it back to paused so user can re-activate
    if (campaign.status === "completed") {
      update.$set = { status: "paused" };
    }

    await Campaign.findByIdAndUpdate(campaign._id, update);

    res.json({ retried: totalRetried, statusChanged: campaign.status === "completed" ? "paused" : null });
  } catch (err) {
    console.error("Retry campaign leads error:", err);
    res.status(500).json({ error: "Failed to retry leads" });
  }
});

// PATCH /api/campaigns/:id/leads/:leadId/status — manual status override
router.patch("/:id/leads/:leadId/status", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.params.leadId)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const { status } = req.body;
    const allowedStatuses = ["pending", "sent", "delivered", "replied", "failed", "skipped"];
    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(", ")}` });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const lead = await CampaignLead.findOne({
      _id: req.params.leadId,
      campaign_id: campaign._id,
    });
    if (!lead) {
      return res.status(404).json({ error: "Campaign lead not found" });
    }

    const oldStatus = lead.status;
    if (oldStatus === status) {
      return res.json(lead);
    }

    // Build update
    const update = {
      status,
      manually_overridden: true,
      overridden_by: req.account._id,
      overridden_at: new Date(),
    };

    // Set sent_at if moving to sent/delivered and not already set
    if ((status === "sent" || status === "delivered") && !lead.sent_at) {
      update.sent_at = new Date();
    }

    // Clear error if moving away from failed
    if (oldStatus === "failed" && status !== "failed") {
      update.error = null;
    }

    await CampaignLead.findByIdAndUpdate(lead._id, { $set: update });

    // Adjust campaign stats
    await Campaign.findByIdAndUpdate(campaign._id, {
      $inc: {
        [`stats.${oldStatus}`]: -1,
        [`stats.${status}`]: 1,
      },
    });

    // Mark outbound lead as messaged if moving to sent/delivered
    if ((status === "sent" || status === "delivered") && lead.outbound_lead_id) {
      await OutboundLead.findByIdAndUpdate(lead.outbound_lead_id, {
        $set: { isMessaged: true },
      });
    }

    const updated = await CampaignLead.findById(lead._id)
      .populate("outbound_lead_id", "username fullName bio followersCount profileLink")
      .populate("sender_id", "ig_username display_name")
      .lean();

    res.json(updated);
  } catch (err) {
    console.error("Manual status override error:", err);
    res.status(500).json({ error: "Failed to update lead status" });
  }
});

// POST /api/campaigns/:id/leads — add outbound lead IDs to campaign
router.post("/:id/leads", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const { lead_ids } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: "lead_ids array is required" });
    }

    // Build docs, using ordered:false to skip duplicates via unique index
    const docs = lead_ids.map((id) => ({
      campaign_id: campaign._id,
      outbound_lead_id: id,
      status: "pending",
    }));

    let inserted = 0;
    try {
      const result = await CampaignLead.insertMany(docs, { ordered: false });
      inserted = result.length;
    } catch (err) {
      // BulkWriteError with duplicates — partial insert succeeded
      if (err.code === 11000 || err.insertedDocs) {
        inserted = err.insertedDocs?.length || 0;
      } else {
        throw err;
      }
    }

    // Update campaign stats + move completed → paused so user can re-activate
    const update = { $inc: { "stats.total": inserted, "stats.pending": inserted } };
    if (inserted > 0 && campaign.status === "completed") {
      update.$set = { status: "paused" };
    }
    await Campaign.findByIdAndUpdate(campaign._id, update);

    res.status(201).json({ added: inserted, duplicates_skipped: lead_ids.length - inserted });
  } catch (err) {
    console.error("Add campaign leads error:", err);
    res.status(500).json({ error: "Failed to add leads" });
  }
});

// DELETE /api/campaigns/:id/leads — remove pending leads
router.delete("/:id/leads", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const result = await CampaignLead.deleteMany({
      campaign_id: campaign._id,
      status: "pending",
    });

    // Update stats
    await Campaign.findByIdAndUpdate(campaign._id, {
      $inc: {
        "stats.total": -result.deletedCount,
        "stats.pending": -result.deletedCount,
      },
    });

    res.json({ removed: result.deletedCount });
  } catch (err) {
    console.error("Remove campaign leads error:", err);
    res.status(500).json({ error: "Failed to remove leads" });
  }
});

// GET /api/campaigns/:id/leads — list campaign leads with filters
router.get("/:id/leads", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const { status, page, limit } = req.query;
    const filter = { campaign_id: campaign._id };

    if (status) filter.status = status;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const skip = (pageNum - 1) * limitNum;

    const [leads, total] = await Promise.all([
      CampaignLead.find(filter)
        .populate("outbound_lead_id", "username fullName bio followersCount profileLink")
        .populate("sender_id", "ig_username display_name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignLead.countDocuments(filter),
    ]);

    res.json({
      leads,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("List campaign leads error:", err);
    res.status(500).json({ error: "Failed to list leads" });
  }
});

// POST /api/campaigns/:id/duplicate — duplicate a campaign with optional lead copy
router.post("/:id/duplicate", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const source = await Campaign.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();

    if (!source) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // lead_filter: "none" | "all" | "pending" | "failed" | "skipped" | "sent"
    const { lead_filter = "none" } = req.body;
    const validFilters = ["none", "all", "pending", "failed", "skipped", "sent"];
    if (!validFilters.includes(lead_filter)) {
      return res.status(400).json({ error: `Invalid lead_filter. Must be one of: ${validFilters.join(", ")}` });
    }

    // Create the new campaign (draft, reset tracking fields)
    const newCampaign = await Campaign.create({
      account_id: req.account._id,
      name: `${source.name} (Copy)`,
      mode: source.mode,
      status: "draft",
      messages: source.messages,
      outbound_account_ids: source.outbound_account_ids,
      schedule: source.schedule,
      daily_limit_per_sender: source.daily_limit_per_sender,
      stats: { total: 0, pending: 0, queued: 0, sent: 0, failed: 0, skipped: 0 },
    });

    let leadsCopied = 0;

    if (lead_filter !== "none") {
      const leadQuery = { campaign_id: source._id };
      if (lead_filter !== "all") {
        leadQuery.status = lead_filter;
      }

      const sourceLeads = await CampaignLead.find(leadQuery).lean();

      if (sourceLeads.length > 0) {
        const docs = sourceLeads.map((l) => ({
          campaign_id: newCampaign._id,
          outbound_lead_id: l.outbound_lead_id,
          status: "pending",
        }));

        try {
          const result = await CampaignLead.insertMany(docs, { ordered: false });
          leadsCopied = result.length;
        } catch (err) {
          if (err.code === 11000 || err.insertedDocs) {
            leadsCopied = err.insertedDocs?.length || 0;
          } else {
            throw err;
          }
        }

        // Update stats on new campaign
        await Campaign.findByIdAndUpdate(newCampaign._id, {
          $set: { "stats.total": leadsCopied, "stats.pending": leadsCopied },
        });
      }
    }

    res.status(201).json({
      campaign: { ...newCampaign.toObject(), stats: { total: leadsCopied, pending: leadsCopied, queued: 0, sent: 0, failed: 0, skipped: 0 } },
      leads_copied: leadsCopied,
    });
  } catch (err) {
    console.error("Duplicate campaign error:", err);
    res.status(500).json({ error: "Failed to duplicate campaign" });
  }
});

module.exports = router;
