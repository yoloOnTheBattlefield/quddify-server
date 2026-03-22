const escapeRegex = require("../utils/escapeRegex");
const logger = require("../utils/logger").child({ module: "leadController" });
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const LeadNote = require("../models/LeadNote");
const LeadTask = require("../models/LeadTask");

/**
 * GET /leads
 * List leads with filtering, search, pagination.
 */
async function listLeads(req, res, next) {
  try {
    const { status, start_date, end_date, search, page, limit, account_id, sort_by, sort_order } = req.query;
    const filter = {};

    if (account_id === "all" && req.user?.role === 0) {
      // Admin viewing all accounts
    } else if (account_id && req.user?.role === 0) {
      filter.account_id = account_id;
    } else {
      filter.account_id = req.account.ghl || req.account._id.toString();
    }

    if (search) filter.first_name = { $regex: escapeRegex(search), $options: "i" };

    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(",");
      const stageConditions = {
        new: { link_sent_at: null, follow_up_at: null, booked_at: null, closed_at: null, ghosted_at: null },
        link_sent: { link_sent_at: { $ne: null }, follow_up_at: null, booked_at: null, closed_at: null, ghosted_at: null },
        follow_up: { follow_up_at: { $ne: null }, booked_at: null, closed_at: null, ghosted_at: null },
        booked: { booked_at: { $ne: null }, closed_at: null, ghosted_at: null },
        closed: { closed_at: { $ne: null }, ghosted_at: null },
        ghosted: { ghosted_at: { $ne: null } },
      };
      const statusConditions = statuses.map((s) => stageConditions[s]).filter(Boolean);
      if (statusConditions.length > 0) filter.$or = statusConditions;
    }

    if (start_date || end_date) {
      filter.date_created = {};
      if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
      if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
    }

    if (req.query.exclude_linked === "true") {
      filter.outbound_lead_id = null;
    }

    const allowedSortFields = ["date_created", "link_sent_at", "booked_at"];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : "date_created";
    const sortDir = sort_order === "asc" ? 1 : -1;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [leads, total] = await Promise.all([
      Lead.find(filter).sort({ [sortField]: sortDir }).skip(skip).limit(limitNum).lean(),
      Lead.countDocuments(filter),
    ]);

    res.json({
      data: leads,
      meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /leads/:id
 */
async function getLead(req, res, next) {
  try {
    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json({ data: lead });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /leads
 */
async function createLead(req, res, next) {
  try {
    const lead = await Lead.create(req.body);
    res.status(201).json({ data: lead });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /leads/:id
 */
async function updateLead(req, res, next) {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
    if (!lead) return res.status(404).json({ error: "Not found" });

    // Sync funnel status to outbound lead when linked
    if (lead.outbound_lead_id) {
      const outboundUpdate = {};
      if (lead.link_sent_at) {
        outboundUpdate.link_sent = true;
        outboundUpdate.link_sent_at = lead.link_sent_at;
      }
      if (lead.booked_at) {
        outboundUpdate.booked = true;
        outboundUpdate.booked_at = lead.booked_at;
      }
      if (Object.keys(outboundUpdate).length > 0) {
        await OutboundLead.findByIdAndUpdate(lead.outbound_lead_id, outboundUpdate);
      }
    }

    res.json({ data: lead });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /leads/:id
 */
async function deleteLead(req, res, next) {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    await Promise.all([
      LeadNote.deleteMany({ lead_id: req.params.id }),
      LeadTask.deleteMany({ lead_id: req.params.id }),
    ]);

    res.json({ data: { deleted: true } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /leads/sync-outbound
 */
async function syncOutbound(req, res, next) {
  try {
    const linked = await Lead.find({
      outbound_lead_id: { $ne: null },
      $or: [{ link_sent_at: { $ne: null } }, { booked_at: { $ne: null } }],
    }).lean();

    let updated = 0;
    for (const lead of linked) {
      const update = {};
      if (lead.link_sent_at) {
        update.link_sent = true;
        update.link_sent_at = lead.link_sent_at;
      }
      if (lead.booked_at) {
        update.booked = true;
        update.booked_at = lead.booked_at;
      }
      const result = await OutboundLead.findByIdAndUpdate(lead.outbound_lead_id, update);
      if (result) updated++;
    }

    logger.info(`[sync-outbound] Synced ${updated}/${linked.length} outbound leads`);
    res.json({ data: { total: linked.length, updated } });
  } catch (error) {
    next(error);
  }
}

module.exports = { listLeads, getLead, createLead, updateLead, deleteLead, syncOutbound };
