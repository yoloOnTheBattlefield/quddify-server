const express = require("express");
const Lead = require("../models/Lead");

const router = express.Router();

// get all leads (optionally filter by account_id/ghl, status, date range, search, and paginate)
router.get("/", async (req, res) => {
  const { status, start_date, end_date, search, page, limit } = req.query;
  const filter = {};
  if (req.account.ghl) filter.account_id = req.account.ghl;
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

  // Pagination
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;
  const skip = (pageNum - 1) * limitNum;

  const [leads, total] = await Promise.all([
    Lead.find(filter).sort({ date_created: -1 }).skip(skip).limit(limitNum).lean(),
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
      link_sent = 0,
      booked = 0,
      ghosted = 0,
      follow_up = 0,
      days_back = 30,
    } = req.body;

    const ghl = req.account.ghl;
    if (!ghl) {
      return res.status(400).json({ error: "Account has no GHL location ID" });
    }

    if (booked > link_sent) {
      return res.status(400).json({ error: "booked cannot exceed link_sent" });
    }
    if (link_sent + ghosted > total) {
      return res.status(400).json({ error: "link_sent + ghosted cannot exceed total" });
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
      breakdown: { link_sent, booked, ghosted, follow_up },
    });
  } catch (error) {
    console.error("Generate leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
