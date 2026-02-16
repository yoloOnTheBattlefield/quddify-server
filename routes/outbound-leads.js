const express = require("express");
const multer = require("multer");
const OutboundLead = require("../models/OutboundLead");
const { parseXlsx } = require("../services/uploadService");
const { toNumber, toDate, toBoolean } = require("../utils/normalize");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// GET /outbound-leads — list with filters, search, pagination
router.get("/", async (req, res) => {
  const { source, qualified, isMessaged, replied, booked, search, promptId, promptLabel, page, limit } = req.query;
  const filter = { account_id: req.account._id };

  if (source) filter.source = source;
  if (qualified !== undefined) filter.qualified = qualified === "true";
  if (isMessaged !== undefined) {
    filter.isMessaged = isMessaged === "true" ? true : { $ne: true };
  }
  if (replied !== undefined) filter.replied = replied === "true";
  if (booked !== undefined) filter.booked = booked === "true";
  if (promptId) filter.promptId = promptId;
  if (promptLabel) filter.promptLabel = { $regex: promptLabel, $options: "i" };
  if (search) {
    filter.$or = [
      { username: { $regex: search, $options: "i" } },
      { fullName: { $regex: search, $options: "i" } },
    ];
  }

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;
  const skip = (pageNum - 1) * limitNum;

  const [leads, total] = await Promise.all([
    OutboundLead.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    OutboundLead.countDocuments(filter),
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

// GET /outbound-leads/stats — funnel counts
router.get("/stats", async (req, res) => {
  try {
    const af = { account_id: req.account._id };
    const [total, qualified, messaged, replied, booked, contractSum] = await Promise.all([
      OutboundLead.countDocuments(af),
      OutboundLead.countDocuments({ ...af, qualified: true }),
      OutboundLead.countDocuments({ ...af, isMessaged: true }),
      OutboundLead.countDocuments({ ...af, replied: true }),
      OutboundLead.countDocuments({ ...af, booked: true }),
      OutboundLead.aggregate([
        { $match: { ...af, contract_value: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$contract_value" }, count: { $sum: 1 } } },
      ]),
    ]);

    const contractData = contractSum[0] || { total: 0, count: 0 };

    res.json({
      total,
      qualified,
      messaged,
      replied,
      booked,
      contracts: contractData.count,
      contract_value: contractData.total,
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// POST /outbound-leads/import-xlsx — import pre-processed leads from XLSX
router.post("/import-xlsx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const rows = parseXlsx(req.file.buffer);
    const accountId = req.account._id;
    const now = new Date();

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const row of rows) {
      const username = String(row["Username"] || "").replace(/^@/, "").trim().toLowerCase();
      if (!username) {
        skipped++;
        continue;
      }

      const source = String(row["Source"] || "import").trim();
      const followingKey = `${username}::${source}`;

      try {
        await OutboundLead.findOneAndUpdate(
          { username, account_id: accountId },
          {
            $set: {
              followingKey,
              fullName: row["Full name"] || null,
              profileLink: row["Profile link"] || null,
              isVerified: toBoolean(row["Is verified"]),
              followersCount: toNumber(row["Followers count"]),
              bio: row["Biography"] || null,
              postsCount: toNumber(row["Posts count"]),
              externalUrl: row["External url"] || null,
              email: row["Email"] || null,
              source,
              scrapeDate: toDate(row["Scrape Date"]),
              ig: row["IG"] || null,
              qualified: toBoolean(row["Qualified"]) ?? false,
              isMessaged: toBoolean(row["Messaged?"]) ?? null,
              dmDate: toDate(row["DM Date"]),
              message: row["Message"] || null,
              metadata: {
                source: "xlsx-import",
                notion: row["Notion"] || null,
                syncedAt: now,
              },
            },
          },
          { upsert: true, new: true },
        );
        imported++;
      } catch (err) {
        if (err.code === 11000) {
          skipped++;
        } else {
          errors.push({ username, error: err.message });
          skipped++;
        }
      }
    }

    res.json({
      total: rows.length,
      imported,
      skipped,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    });
  } catch (err) {
    console.error("Import XLSX error:", err);
    res.status(500).json({ error: "Failed to import XLSX" });
  }
});

// GET /outbound-leads/:id
router.get("/:id", async (req, res) => {
  const lead = await OutboundLead.findById(req.params.id).lean();
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// PATCH /outbound-leads/:id
router.patch("/:id", async (req, res) => {
  const lead = await OutboundLead.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  }).lean();
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// DELETE /outbound-leads/:id
router.delete("/:id", async (req, res) => {
  await OutboundLead.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;
