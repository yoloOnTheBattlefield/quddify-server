const logger = require("../utils/logger").child({ module: "follow-ups" });
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const FollowUp = require("../models/FollowUp");
const OutboundLead = require("../models/OutboundLead");
const CampaignLead = require("../models/CampaignLead");
const SenderAccount = require("../models/SenderAccount");

// GET /api/follow-ups — paginated list with outbound lead data
router.get("/", async (req, res) => {
  try {
    const {
      page,
      limit,
      status,
      search,
      sort,
      outbound_account_id,
    } = req.query;
    const accountId = req.account._id;

    const filter = { account_id: accountId };

    if (status && status !== "all") {
      filter.status = status;
    }

    if (outbound_account_id && outbound_account_id !== "all") {
      filter.outbound_account_id = new mongoose.Types.ObjectId(outbound_account_id);
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // Exclude terminal statuses from default view
    if (!filter.status) {
      filter.status = { $nin: ["booked", "not_interested"] };
    }

    // Priority-based sort: need_reply first, then hot_lead, then by last_activity ascending (oldest first)
    let sortObj = { createdAt: -1 };
    if (sort === "oldest") sortObj = { createdAt: 1 };
    else if (sort === "follow_up_date") sortObj = { follow_up_date: 1, createdAt: -1 };
    else if (sort === "priority") {
      // Custom priority order handled via addFields below
    }

    // Build aggregation pipeline to join with outbound lead data
    const pipeline = [
      { $match: filter },
    ];

    // Priority sort: need_reply > hot_lead > follow_up_later > waiting_for_them
    if (sort === "priority") {
      pipeline.push(
        {
          $addFields: {
            _priority: {
              $switch: {
                branches: [
                  { case: { $eq: ["$status", "need_reply"] }, then: 0 },
                  { case: { $eq: ["$status", "hot_lead"] }, then: 1 },
                  { case: { $eq: ["$status", "audit_offered"] }, then: 2 },
                  { case: { $eq: ["$status", "recording_audit"] }, then: 3 },
                  { case: { $eq: ["$status", "qualifying"] }, then: 4 },
                  { case: { $eq: ["$status", "audit_sent"] }, then: 5 },
                  { case: { $eq: ["$status", "follow_up_later"] }, then: 6 },
                  { case: { $eq: ["$status", "waiting_for_them"] }, then: 7 },
                  { case: { $eq: ["$status", "link_sent"] }, then: 8 },
                ],
                default: 4,
              },
            },
          },
        },
        { $sort: { _priority: 1, last_activity: 1, createdAt: -1 } },
      );
    } else {
      pipeline.push({ $sort: sortObj });
    }

    pipeline.push(
      {
        $lookup: {
          from: "outbound_leads",
          localField: "outbound_lead_id",
          foreignField: "_id",
          as: "lead",
        },
      },
      { $unwind: { path: "$lead", preserveNullAndEmptyArrays: true } },
    );

    // Search filter — applied after lookup so we can search lead fields
    if (search && search.trim()) {
      const q = search.trim();
      const regex = { $regex: q, $options: "i" };
      pipeline.push({
        $match: {
          $or: [
            { "lead.username": regex },
            { "lead.fullName": regex },
            { note: regex },
          ],
        },
      });
    }

    // Lookup outbound account username for display
    pipeline.push(
      {
        $lookup: {
          from: "outbound_accounts",
          localField: "outbound_account_id",
          foreignField: "_id",
          as: "outbound_account",
        },
      },
      { $unwind: { path: "$outbound_account", preserveNullAndEmptyArrays: true } },
    );

    // Facet for pagination
    pipeline.push({
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limitNum },
          {
            $project: {
              _id: 1,
              outbound_lead_id: 1,
              account_id: 1,
              outbound_account_id: 1,
              status: 1,
              follow_up_date: 1,
              note: 1,
              last_activity: 1,
              createdAt: 1,
              updatedAt: 1,
              "lead.username": 1,
              "lead.fullName": 1,
              "lead.followersCount": 1,
              "lead.profileLink": 1,
              "lead.isVerified": 1,
              "lead.replied_at": 1,
              "lead.dmDate": 1,
              "lead.message": 1,
              "lead.source_seeds": 1,
              "outbound_account.username": 1,
            },
          },
        ],
        totalCount: [{ $count: "count" }],
      },
    });

    const [result] = await FollowUp.aggregate(pipeline);
    const followUps = result.data;
    const total = result.totalCount[0]?.count || 0;

    res.json({
      followUps,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    logger.error("GET /api/follow-ups error:", err);
    res.status(500).json({ error: "Failed to fetch follow-ups" });
  }
});

// GET /api/follow-ups/stats — count per status + total
router.get("/stats", async (req, res) => {
  try {
    const accountId = req.account._id;
    const { outbound_account_id } = req.query;

    const matchFilter = { account_id: accountId };
    if (outbound_account_id && outbound_account_id !== "all") {
      matchFilter.outbound_account_id = new mongoose.Types.ObjectId(outbound_account_id);
    }

    const [stats] = await FollowUp.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$count" },
          statuses: { $push: { status: "$_id", count: "$count" } },
        },
      },
    ]);

    const counts = {
      total: 0,
      need_reply: 0,
      qualifying: 0,
      waiting_for_them: 0,
      audit_offered: 0,
      recording_audit: 0,
      audit_sent: 0,
      follow_up_later: 0,
      hot_lead: 0,
      link_sent: 0,
      booked: 0,
      not_interested: 0,
    };

    if (stats) {
      counts.total = stats.total;
      for (const s of stats.statuses) {
        if (s.status in counts) counts[s.status] = s.count;
      }
    }

    res.json(counts);
  } catch (err) {
    logger.error("GET /api/follow-ups/stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// POST /api/follow-ups/sync — upsert follow-up for every replied outbound lead
router.post("/sync", async (req, res) => {
  try {
    const accountId = req.account._id;

    // Find all outbound leads that have replied
    const repliedLeads = await OutboundLead.find(
      { account_id: accountId, replied: true },
      { _id: 1 },
    ).lean();

    if (repliedLeads.length === 0) {
      return res.json({ synced: 0 });
    }

    const repliedLeadIds = repliedLeads.map((l) => l._id);

    // Find which ones already have follow-up docs
    const existing = await FollowUp.find(
      { account_id: accountId, outbound_lead_id: { $in: repliedLeadIds } },
      { outbound_lead_id: 1 },
    ).lean();
    const existingSet = new Set(existing.map((e) => e.outbound_lead_id.toString()));

    const newLeadIds = repliedLeadIds.filter(
      (id) => !existingSet.has(id.toString()),
    );

    if (newLeadIds.length === 0) {
      return res.json({ synced: 0 });
    }

    // For each new lead, try to find the outbound account that sent the DM
    // via CampaignLead → SenderAccount → OutboundAccount
    const campaignLeads = await CampaignLead.find(
      { outbound_lead_id: { $in: newLeadIds }, status: { $in: ["sent", "delivered", "replied"] } },
      { outbound_lead_id: 1, sender_id: 1 },
    ).lean();

    // Map outbound_lead_id → sender_id
    const leadSenderMap = {};
    for (const cl of campaignLeads) {
      if (cl.sender_id) {
        leadSenderMap[cl.outbound_lead_id.toString()] = cl.sender_id;
      }
    }

    // Resolve sender_id → outbound_account_id
    const senderIds = [...new Set(Object.values(leadSenderMap).map((id) => id.toString()))];
    let senderAccountMap = {};
    if (senderIds.length > 0) {
      const senders = await SenderAccount.find(
        { _id: { $in: senderIds } },
        { outbound_account_id: 1 },
      ).lean();
      for (const s of senders) {
        if (s.outbound_account_id) {
          senderAccountMap[s._id.toString()] = s.outbound_account_id;
        }
      }
    }

    // Build follow-up docs
    const docs = newLeadIds.map((leadId) => {
      const senderId = leadSenderMap[leadId.toString()];
      const outboundAccountId = senderId
        ? senderAccountMap[senderId.toString()] || null
        : null;
      return {
        outbound_lead_id: leadId,
        account_id: accountId,
        outbound_account_id: outboundAccountId,
        status: "need_reply",
        last_activity: new Date(),
        note: "",
      };
    });

    await FollowUp.insertMany(docs, { ordered: false });

    res.json({ synced: docs.length });
  } catch (err) {
    logger.error("POST /api/follow-ups/sync error:", err);
    res.status(500).json({ error: "Failed to sync follow-ups" });
  }
});

// PATCH /api/follow-ups/:id — update status, follow_up_date, note
router.patch("/:id", async (req, res) => {
  try {
    const { status, follow_up_date, note } = req.body;
    const updates = {};

    if (status !== undefined) {
      updates.status = status;
      updates.last_activity = new Date();
    }
    if (follow_up_date !== undefined) updates.follow_up_date = follow_up_date;
    if (note !== undefined) updates.note = note;

    const followUp = await FollowUp.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: updates },
      { new: true },
    );

    if (!followUp) {
      return res.status(404).json({ error: "Follow-up not found" });
    }

    res.json(followUp);
  } catch (err) {
    logger.error("PATCH /api/follow-ups/:id error:", err);
    res.status(500).json({ error: "Failed to update follow-up" });
  }
});

module.exports = router;
