const express = require("express");
const Lead = require("../models/Lead");

const router = express.Router();

// get all leads (optionally filter by account_id/ghl, status, date range, search, and paginate)
router.get("/", async (req, res) => {
  const { status, start_date, end_date, search, page, limit, account_id, sort_by, sort_order } = req.query;
  const filter = {};
  // Admins (role 0) can filter by any account or see all; others see only their own
  if (account_id && req.user?.role === 0) {
    if (account_id !== "all") {
      filter.account_id = account_id;
    }
    // account_id === "all" → no filter = all accounts
  } else if (req.account.ghl) {
    filter.account_id = req.account.ghl;
  }
  if (search) filter.first_name = { $regex: search, $options: "i" };
  if (status) {
    const statuses = Array.isArray(status) ? status : status.split(",");
    const statusConditions = statuses.map((s) => {
      const field = `${s}_at`;
      return { [field]: { $ne: null } };
    });
    filter.$or = statusConditions;
  }
  if (start_date || end_date) {
    filter.date_created = {};
    if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
    if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
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
});

// get lead by id
router.get("/:id", async (req, res) => {
  const lead = await Lead.findById(req.params.id).lean();
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// create lead
router.post("/", async (req, res) => {
  const lead = await Lead.create(req.body);
  res.status(201).json(lead);
});

// update lead
router.patch("/:id", async (req, res) => {
  const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  }).lean();

  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// delete lead
router.delete("/:id", async (req, res) => {
  await Lead.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
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
    console.error("Generate leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
