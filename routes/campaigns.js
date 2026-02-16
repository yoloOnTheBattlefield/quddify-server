const express = require("express");
const mongoose = require("mongoose");
const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const SenderAccount = require("../models/SenderAccount");
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
    const { name, mode, messages, sender_ids, schedule, daily_limit_per_sender } = req.body;

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
      sender_ids: sender_ids || [],
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

    const { name, mode, messages, sender_ids, schedule, daily_limit_per_sender } = req.body;

    if (mode !== undefined && !["auto", "manual"].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'auto' or 'manual'" });
    }

    if (name !== undefined) campaign.name = name;
    if (mode !== undefined) campaign.mode = mode;
    if (messages !== undefined) campaign.messages = messages;
    if (sender_ids !== undefined) campaign.sender_ids = sender_ids;
    if (schedule !== undefined) {
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

    // Validate campaign has senders
    if (!campaign.sender_ids || campaign.sender_ids.length === 0) {
      return res.status(400).json({ error: "Campaign must have at least one sender assigned" });
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

    // Update campaign stats
    await Campaign.findByIdAndUpdate(campaign._id, {
      $inc: { "stats.total": inserted, "stats.pending": inserted },
    });

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

module.exports = router;
