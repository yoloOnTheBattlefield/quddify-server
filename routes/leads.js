const escapeRegex = require("../utils/escapeRegex");
const logger = require("../utils/logger").child({ module: "leads" });
const express = require("express");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const LeadNote = require("../models/LeadNote");
const LeadTask = require("../models/LeadTask");
const validate = require("../middleware/validate");
const { leadCreateSchema, leadUpdateSchema } = require("../schemas/leads");
const { notifyNewLead } = require("../services/telegramNotifier");

const router = express.Router();

// get all leads (optionally filter by account_id/ghl, status, date range, search, and paginate)
router.get("/", async (req, res) => {
  try {
    const { status, start_date, end_date, search, page, limit, account_id, sort_by, sort_order } = req.query;
    const filter = {};
    // Admins (role 0) can pass account_id="all" to see everything; otherwise always scoped
    if (account_id === "all" && req.user?.role === 0) {
      // No filter — admin viewing all accounts
    } else if (account_id && req.user?.role === 0) {
      filter.account_id = account_id;
    } else {
      filter.account_id = req.account.ghl || req.account._id.toString();
    }
    if (search) filter.first_name = { $regex: escapeRegex(search), $options: "i" };
    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(",");
      // Build mutually exclusive stage conditions matching the frontend pipeline priority:
      // ghosted > closed > booked > follow_up > link_sent > new
      const stageConditions = {
        new: { link_sent_at: null, follow_up_at: null, booked_at: null, closed_at: null, ghosted_at: null },
        link_sent: { link_sent_at: { $ne: null }, follow_up_at: null, booked_at: null, closed_at: null, ghosted_at: null },
        follow_up: { follow_up_at: { $ne: null }, booked_at: null, closed_at: null, ghosted_at: null },
        booked: { booked_at: { $ne: null }, closed_at: null, ghosted_at: null },
        closed: { closed_at: { $ne: null }, ghosted_at: null },
        ghosted: { ghosted_at: { $ne: null } },
      };
      const statusConditions = statuses
        .map((s) => stageConditions[s])
        .filter(Boolean);
      if (statusConditions.length > 0) {
        filter.$or = statusConditions;
      }
    }
    if (start_date || end_date) {
      filter.date_created = {};
      if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
      if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
    }
    if (req.query.exclude_linked === "true") {
      filter.outbound_lead_id = null;
    }

    // Sorting
    const allowedSortFields = ["date_created", "link_sent_at", "booked_at"];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : "date_created";
    const sortDir = sort_order === "asc" ? 1 : -1;

    // Pagination
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [leads, total] = await Promise.all([
      Lead.find(filter).sort({ [sortField]: sortDir }).skip(skip).limit(limitNum).lean(),
      Lead.countDocuments(filter),
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
  } catch (error) {
    logger.error("List leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// get lead by id
router.get("/:id", async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, account_id: req.account.ghl }).lean();
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (error) {
    logger.error("Get lead error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// create lead
router.post("/", validate(leadCreateSchema), async (req, res) => {
  try {
    const lead = await Lead.create(req.body);

    // Telegram notification (fire-and-forget)
    const outbound = lead.outbound_lead_id
      ? await OutboundLead.findById(lead.outbound_lead_id).lean()
      : null;
    notifyNewLead(req.account, lead, outbound).catch((err) =>
      logger.error({ err }, "Telegram notify error"),
    );

    res.status(201).json(lead);
  } catch (error) {
    logger.error("Create lead error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// update lead
router.patch("/:id", validate(leadUpdateSchema), async (req, res) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account.ghl },
      req.body,
      { new: true },
    ).lean();

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

    res.json(lead);
  } catch (error) {
    logger.error("Update lead error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /leads/import — bulk import leads from Calendly CSV (parsed client-side)
router.post("/import", async (req, res) => {
  try {
    const accountId = req.account.ghl;
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const results = { imported: 0, updated: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      if (!row.first_name && !row.last_name && !row.email) {
        results.errors.push({ row: rowNum, reason: "Missing name and email" });
        results.skipped++;
        continue;
      }

      // Parse booking date
      let bookedAt = null;
      if (row.booking_date) {
        const parsed = new Date(row.booking_date);
        if (!isNaN(parsed.getTime())) bookedAt = parsed;
      }

      // Derive status from canceled/no-show columns
      const isCanceled = row.canceled && String(row.canceled).toLowerCase().trim() === "yes";
      const isNoShow = row.no_show && String(row.no_show).toLowerCase().trim() === "yes";

      let ghostedAt = null;
      let closedAt = null;
      if (isCanceled) {
        ghostedAt = bookedAt || new Date();
        bookedAt = null; // cancelled bookings aren't really booked
      }

      // Parse questions and answers (Q1/R1 through Q7/R7)
      const questionsAndAnswers = [];
      for (let q = 1; q <= 7; q++) {
        const question = row[`question_${q}`];
        const response = row[`response_${q}`];
        if (question && response) {
          questionsAndAnswers.push({ position: q, question, answer: response });
        }
      }

      // Parse contract value from event price
      const contractValue = row.contract_value ? Number(row.contract_value) : null;

      const leadData = {
        first_name: row.first_name || null,
        last_name: row.last_name || null,
        email: row.email || null,
        account_id: accountId,
        source: row.source || "calendly",
        date_created: bookedAt ? bookedAt.toISOString() : new Date().toISOString(),
        booked_at: isCanceled ? null : bookedAt,
        ghosted_at: ghostedAt,
        closed_at: closedAt,
        contract_value: isNaN(contractValue) ? null : contractValue,
        utm_source: row.utm_source || null,
        utm_medium: row.utm_medium || null,
        utm_campaign: row.utm_campaign || null,
        ...(questionsAndAnswers.length > 0 && { questions_and_answers: questionsAndAnswers }),
        ...(isNoShow && { summary: "No-show" }),
        ...(row.cancellation_reason && { summary: `Cancelled: ${row.cancellation_reason}` }),
      };

      try {
        // Deduplicate by email + account_id if email exists
        if (row.email) {
          const { date_created, ...updateData } = leadData;
          const result = await Lead.findOneAndUpdate(
            { email: row.email, account_id: accountId },
            { $set: updateData, $setOnInsert: { date_created } },
            { upsert: true, new: true, rawResult: true },
          );
          if (result.lastErrorObject?.upserted) {
            results.imported++;
          } else {
            results.updated++;
          }
        } else {
          await Lead.create(leadData);
          results.imported++;
        }
      } catch (err) {
        results.errors.push({ row: rowNum, reason: err.message });
        results.skipped++;
      }
    }

    logger.info({ imported: results.imported, updated: results.updated, skipped: results.skipped }, "Leads imported");
    res.json(results);
  } catch (err) {
    logger.error({ err }, "Failed to import leads");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /leads/sync-outbound — backfill outbound leads with inbound funnel status
router.post("/sync-outbound", async (req, res) => {
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
    res.json({ total: linked.length, updated });
  } catch (error) {
    logger.error("Sync outbound error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// delete lead
router.delete("/:id", async (req, res) => {
  try {
    const lead = await Lead.findOneAndDelete({ _id: req.params.id, account_id: req.account.ghl });
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // Clean up related data
    await Promise.all([
      LeadNote.deleteMany({ lead_id: req.params.id }),
      LeadTask.deleteMany({ lead_id: req.params.id }),
    ]);

    res.json({ deleted: true });
  } catch (error) {
    logger.error("Delete lead error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /leads/generate - Generate mock leads
router.post("/generate", async (req, res) => {
  try {
    const {
      total = 100,
      days_back = 30,
      mode = "raw",
      randomize = false,
    } = req.body;

    let {
      link_sent = 0,
      booked = 0,
      ghosted = 0,
      follow_up = 0,
      closed = 0,
      contract_value_min = null,
      contract_value_max = null,
      score_min = null,
      score_max = null,
    } = req.body;

    const ghl = req.account.ghl;
    if (!ghl) {
      return res.status(400).json({ error: "Account has no GHL location ID" });
    }

    // Randomize mode — generate realistic funnel distributions
    if (randomize) {
      link_sent = Math.round(total * (0.25 + Math.random() * 0.20));
      booked = Math.round(link_sent * (0.20 + Math.random() * 0.20));
      ghosted = Math.round(total * (0.10 + Math.random() * 0.15));
      follow_up = Math.round(total * (0.05 + Math.random() * 0.10));
      closed = Math.round(booked * (0.30 + Math.random() * 0.30));
      if (link_sent + ghosted > total) ghosted = total - link_sent;
      contract_value_min = 1000;
      contract_value_max = 5000;
      score_min = 1;
      score_max = 10;
    }

    // Percentage mode — convert percentages to raw counts
    if (mode === "percentage" && !randomize) {
      link_sent = Math.round((total * link_sent) / 100);
      booked = Math.round((total * booked) / 100);
      ghosted = Math.round((total * ghosted) / 100);
      follow_up = Math.round((total * follow_up) / 100);
      closed = Math.round((total * closed) / 100);
    }

    // Validation
    if (booked > link_sent) {
      return res.status(400).json({ error: "booked cannot exceed link_sent" });
    }
    if (link_sent + ghosted > total) {
      return res.status(400).json({ error: "link_sent + ghosted cannot exceed total" });
    }
    if (closed > booked) {
      return res.status(400).json({ error: "closed cannot exceed booked" });
    }
    if (contract_value_min != null && contract_value_max != null && contract_value_min > contract_value_max) {
      return res.status(400).json({ error: "contract_value_min cannot exceed contract_value_max" });
    }
    if (score_min != null && score_max != null) {
      if (score_min < 1 || score_max > 10 || score_min > score_max) {
        return res.status(400).json({ error: "score_min/score_max must be between 1-10 and min <= max" });
      }
    }
    if (closed > 0 && (contract_value_min == null || contract_value_max == null)) {
      return res.status(400).json({ error: "contract_value_min and contract_value_max are required when closed > 0" });
    }

    const firstNames = [
      "James", "Emma", "Liam", "Olivia", "Noah", "Ava", "Lucas", "Sophia",
      "Mason", "Isabella", "Ethan", "Mia", "Logan", "Charlotte", "Aiden",
      "Amelia", "Jackson", "Harper", "Sebastian", "Evelyn", "Caleb", "Abigail",
      "Owen", "Emily", "Daniel", "Ella", "Matthew", "Scarlett", "Henry", "Grace",
      "Alexander", "Chloe", "Michael", "Victoria", "William", "Riley", "David",
      "Aria", "Joseph", "Lily", "Carter", "Aubrey", "Luke", "Zoey", "Dylan",
      "Penelope", "Jack", "Layla", "Ryan", "Nora",
    ];

    const lastNames = [
      "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
      "Davis", "Rodriguez", "Martinez", "Anderson", "Taylor", "Thomas", "Moore",
      "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark",
      "Lewis", "Robinson", "Walker", "Hall", "Young", "Allen", "King", "Wright",
      "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell",
      "Roberts", "Carter", "Phillips", "Evans", "Turner", "Torres", "Parker",
      "Collins", "Edwards", "Stewart", "Morris", "Murphy", "Cook",
    ];

    const igHandles = [
      "fit_james", "gains_daily", "coach_emma", "iron_will", "flex_nation",
      "pump_life", "shred_mode", "lift_heavy", "beast_mode", "grind_hard",
      "no_excuses", "train_insane", "muscle_up", "cardio_king", "sweat_equity",
    ];

    const investAnswers = [
      "Yes, I'm ready to invest in myself",
      "Yes I am, but I dont really have the funds to invest in myself right now",
      "I need to think about it first",
      "Absolutely, let's do this",
      "I'm interested but need more details on pricing",
      "Yes, health is my top priority right now",
      "Not sure yet, depends on the cost",
    ];

    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const randId = () =>
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);
    const randHours = (min, max) => min + Math.random() * (max - min);

    const now = Date.now();
    const msPerDay = 86400000;

    const leads = [];

    for (let i = 0; i < total; i++) {
      const firstName = pick(firstNames);
      const lastName = pick(lastNames);
      const createdAt = new Date(now - Math.random() * days_back * msPerDay);

      const lead = {
        first_name: firstName,
        last_name: lastName,
        contact_id: randId(),
        account_id: ghl,
        date_created: createdAt.toISOString(),
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 99)}@email.com`,
        link_sent_at: null,
        booked_at: null,
        ghosted_at: null,
        follow_up_at: null,
        closed_at: null,
        contract_value: null,
        score: null,
        low_ticket: null,
        summary: null,
        questions_and_answers: [],
      };

      // Funnel: booked ⊂ link_sent (first indices get furthest)
      if (i < link_sent) {
        lead.link_sent_at = new Date(createdAt.getTime() + randHours(1, 24) * 3600000);

        if (i < booked) {
          lead.booked_at = new Date(lead.link_sent_at.getTime() + randHours(2, 48) * 3600000);
        }
      } else if (i >= link_sent && i < link_sent + ghosted) {
        lead.ghosted_at = new Date(createdAt.getTime() + randHours(24, 120) * 3600000);
      }

      // Closed leads = first `closed` indices within booked leads
      if (i < closed && lead.booked_at) {
        lead.closed_at = new Date(lead.booked_at.getTime() + randHours(24, 168) * 3600000);
        lead.contract_value = Math.round(
          contract_value_min + Math.random() * (contract_value_max - contract_value_min),
        );
      }

      // Score for leads that progressed past link_sent
      if (lead.link_sent_at && score_min != null && score_max != null) {
        lead.score = Math.round(score_min + Math.random() * (score_max - score_min));
      }

      // Booked leads get Calendly-style Q&A
      if (lead.booked_at) {
        lead.questions_and_answers = [
          {
            answer: `${pick(igHandles)}${Math.floor(Math.random() * 99)}`,
            position: 0,
            question: "Whats your Instagram username?",
          },
          {
            answer: pick(investAnswers),
            position: 1,
            question: "If accepted into my coaching program, are you ready to financially invest in your health?",
          },
        ];
      }

      // Follow-ups on the first N eligible non-booked leads
      if (i < follow_up && !lead.booked_at) {
        const base = lead.ghosted_at || createdAt;
        lead.follow_up_at = new Date(base.getTime() + randHours(12, 72) * 3600000);
      }

      leads.push(lead);
    }

    await Lead.insertMany(leads);

    res.json({
      success: true,
      created: leads.length,
      breakdown: {
        link_sent,
        booked,
        ghosted,
        follow_up,
        closed,
        total_revenue: leads.reduce((sum, l) => sum + (l.contract_value || 0), 0),
      },
    });
  } catch (error) {
    logger.error("Generate leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
