const express = require("express");
const OutboundLead = require("../models/OutboundLead");

const router = express.Router();

// GET /api/reply-checks/pending
// Returns OutboundLeads that need reply checking:
//   - isMessaged = true
//   - ig_thread_id exists
//   - replied = false
//   - dmDate within last 14 days (no point checking ancient threads)
// Extension calls this periodically, checks each thread via IG API, then reports back.
router.get("/pending", async (req, res) => {
  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    const leads = await OutboundLead.find({
      account_id: req.account._id,
      isMessaged: true,
      ig_thread_id: { $ne: null, $exists: true },
      replied: false,
      dmDate: { $gte: fourteenDaysAgo },
    })
      .select("_id username ig_thread_id dmDate")
      .sort({ dmDate: -1 })
      .limit(limit)
      .lean();

    res.json({ leads, count: leads.length });
  } catch (err) {
    console.error("Reply checks pending error:", err);
    res.status(500).json({ error: "Failed to get pending reply checks" });
  }
});

// POST /api/reply-checks/results
// Body: { results: [ { lead_id, thread_id, has_reply, replied_at? } ] }
// Extension sends batch results after checking threads via IG API.
router.post("/results", async (req, res) => {
  try {
    const { results } = req.body;

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: "results array is required" });
    }

    let updated = 0;

    for (const r of results) {
      if (!r.lead_id || !r.has_reply) continue;

      const result = await OutboundLead.findOneAndUpdate(
        {
          _id: r.lead_id,
          account_id: req.account._id,
          replied: false,
        },
        {
          $set: {
            replied: true,
            replied_at: r.replied_at ? new Date(r.replied_at) : new Date(),
          },
        },
      );
      if (result) updated++;
    }

    res.json({ success: true, updated });
  } catch (err) {
    console.error("Reply checks results error:", err);
    res.status(500).json({ error: "Failed to update reply results" });
  }
});

module.exports = router;
