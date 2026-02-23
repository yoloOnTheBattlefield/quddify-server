const express = require("express");
const multer = require("multer");
const OutboundLead = require("../models/OutboundLead");
const CampaignLead = require("../models/CampaignLead");
const Campaign = require("../models/Campaign");
const Prompt = require("../models/Prompt");
const { parseXlsx } = require("../services/uploadService");
const { toBoolean } = require("../utils/normalize");
const { applyColumnMapping, DEFAULT_COLUMN_MAPPING } = require("../utils/columnMapping");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// In-memory import job progress store
const importJobs = new Map();

// Clean up old jobs every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, job] of importJobs) {
    if (job.completedAt && job.completedAt < cutoff) {
      importJobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

async function processImportJob(jobId, rows, { promptDoc, campaign, accountId, columnMapping }) {
  const job = importJobs.get(jobId);
  if (!job) return;
  const now = new Date();
  const mapping = columnMapping || DEFAULT_COLUMN_MAPPING;

  try {
    job.step = "Importing leads...";
    job.status = "importing";

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const mapped = applyColumnMapping(row, mapping);

      const username = mapped.username || "";
      if (!username) {
        job.skipped++;
        job.processed = i + 1;
        continue;
      }

      const source = mapped.source || "import";
      const followingKey = `${username}::${source}`;
      const wasMessaged = mapped.isMessaged;
      const messageText = mapped.message || null;
      const dmDateVal = mapped.dmDate;

      try {
        const lead = await OutboundLead.findOneAndUpdate(
          { username, account_id: accountId },
          {
            $set: {
              followingKey,
              fullName: mapped.fullName || null,
              profileLink: mapped.profileLink || null,
              isVerified: mapped.isVerified,
              followersCount: mapped.followersCount,
              bio: mapped.bio || null,
              postsCount: mapped.postsCount,
              externalUrl: mapped.externalUrl || null,
              email: mapped.email || null,
              source,
              scrapeDate: mapped.scrapeDate,
              ig: mapped.ig || null,
              promptId: promptDoc ? promptDoc._id : null,
              promptLabel: promptDoc ? promptDoc.label : null,
              isMessaged: wasMessaged ?? null,
              dmDate: dmDateVal,
              message: messageText,
              metadata: {
                source: "xlsx-import",
                notion: row["Notion"] || null,
                syncedAt: now,
              },
            },
          },
          { upsert: true, new: true },
        );
        job.imported++;

        // Create CampaignLead for messaged leads
        if (campaign && wasMessaged && lead) {
          try {
            await CampaignLead.findOneAndUpdate(
              { campaign_id: campaign._id, outbound_lead_id: lead._id },
              {
                $setOnInsert: {
                  status: "sent",
                  sent_at: dmDateVal || now,
                  message_used: messageText,
                  sender_id: null,
                  task_id: null,
                  error: null,
                },
              },
              { upsert: true },
            );
            job.campaignLeadsCreated++;
          } catch (clErr) {
            if (clErr.code !== 11000) {
              console.error("CampaignLead create error:", clErr.message);
            }
          }
        }
      } catch (err) {
        if (err.code === 11000) {
          job.skipped++;
        } else {
          job.errors.push({ username, error: err.message });
          job.skipped++;
        }
      }

      job.processed = i + 1;

      // Yield to event loop every 25 rows so status endpoint can respond
      if ((i + 1) % 25 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }

    // Update campaign stats
    if (campaign && job.campaignLeadsCreated > 0) {
      job.step = "Updating campaign stats...";
      await Campaign.findByIdAndUpdate(campaign._id, {
        $inc: {
          "stats.total": job.campaignLeadsCreated,
          "stats.sent": job.campaignLeadsCreated,
        },
      });
    }

    job.status = "done";
    job.step = "Done";
    job.completedAt = Date.now();
  } catch (err) {
    console.error("Import job error:", err);
    job.status = "error";
    job.step = err.message || "Unknown error";
    job.completedAt = Date.now();
  }
}

// GET /outbound-leads — list with filters, search, pagination
router.get("/", async (req, res) => {
  const { source, isMessaged, replied, booked, search, promptId, promptLabel, qualified, minFollowers, maxFollowers, page, limit } = req.query;
  const filter = { account_id: req.account._id };

  // By default hide unqualified leads (low followers / AI rejected)
  if (qualified === "true") {
    filter.qualified = true;
  } else if (qualified === "false") {
    filter.qualified = false;
  } else if (qualified === "all") {
    // show everything, no filter
  } else {
    // Default: exclude explicitly unqualified leads
    filter.qualified = { $ne: false };
  }

  if (source) {
    // Match against source_seeds array (clean values) or legacy source field
    const cleanSource = source.replace(/^@+/, "");
    const sourceCondition = {
      $or: [
        { source_seeds: cleanSource },
        { source: cleanSource },
      ],
    };
    filter.$and = filter.$and || [];
    filter.$and.push(sourceCondition);
  }
  if (isMessaged !== undefined) {
    filter.isMessaged = isMessaged === "true" ? true : { $ne: true };
  }
  if (replied !== undefined) filter.replied = replied === "true";
  if (booked !== undefined) filter.booked = booked === "true";
  if (minFollowers || maxFollowers) {
    filter.followersCount = {};
    if (minFollowers) filter.followersCount.$gte = parseInt(minFollowers, 10);
    if (maxFollowers) filter.followersCount.$lte = parseInt(maxFollowers, 10);
  }
  if (promptId) filter.promptId = promptId;
  if (promptLabel) filter.promptLabel = { $regex: promptLabel, $options: "i" };
  if (search) {
    const searchCondition = {
      $or: [
        { username: { $regex: search, $options: "i" } },
        { fullName: { $regex: search, $options: "i" } },
      ],
    };
    filter.$and = filter.$and || [];
    filter.$and.push(searchCondition);
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

// GET /outbound-leads/sources — distinct source values
router.get("/sources", async (req, res) => {
  try {
    // Use source_seeds (clean individual usernames) for reliable distinct values
    const seeds = await OutboundLead.distinct("source_seeds", { account_id: req.account._id });
    const sources = await OutboundLead.distinct("source", { account_id: req.account._id });
    // Merge both fields: source_seeds has clean values, source may have values from file uploads
    const merged = new Set([...seeds.filter(Boolean), ...sources.filter(Boolean)]);
    // Normalize: strip leading @, split comma-separated values, deduplicate
    const normalized = new Set();
    for (const val of merged) {
      for (const part of val.split(",")) {
        const clean = part.trim().replace(/^@+/, "");
        if (clean) normalized.add(clean);
      }
    }
    res.json({ sources: [...normalized].sort() });
  } catch (err) {
    console.error("Sources error:", err);
    res.status(500).json({ error: "Failed to fetch sources" });
  }
});

// GET /outbound-leads/stats — funnel counts
router.get("/stats", async (req, res) => {
  try {
    const af = { account_id: req.account._id };
    const [total, messaged, replied, booked, contractSum] = await Promise.all([
      OutboundLead.countDocuments(af),
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

// POST /outbound-leads/import-xlsx — start import job, returns immediately
router.post("/import-xlsx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { promptId, campaignId } = req.body;
    const accountId = req.account._id;

    // Parse column mapping if provided
    let columnMapping = null;
    if (req.body.columnMapping) {
      try {
        columnMapping = JSON.parse(req.body.columnMapping);
      } catch (e) {
        return res.status(400).json({ error: "Invalid columnMapping JSON" });
      }
    }

    // Resolve prompt if provided
    let promptDoc = null;
    if (promptId) {
      promptDoc = await Prompt.findById(promptId).lean();
      if (!promptDoc) {
        return res.status(400).json({ error: "Prompt not found" });
      }
    }

    // Resolve campaign if provided (for message analytics)
    let campaign = null;
    if (campaignId) {
      campaign = await Campaign.findOne({ _id: campaignId, account_id: accountId }).lean();
      if (!campaign) {
        return res.status(400).json({ error: "Campaign not found" });
      }
    }

    // Parse file synchronously (fast) — return total + jobId immediately
    const rows = parseXlsx(req.file.buffer);
    const jobId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    importJobs.set(jobId, {
      status: "importing",
      step: "Parsing file...",
      total: rows.length,
      processed: 0,
      imported: 0,
      skipped: 0,
      campaignLeadsCreated: 0,
      errors: [],
      completedAt: null,
    });

    // Return immediately so the frontend can start polling
    res.status(202).json({ jobId, total: rows.length });

    // Process in background
    processImportJob(jobId, rows, { promptDoc, campaign, accountId, columnMapping });
  } catch (err) {
    console.error("Import XLSX error:", err);
    res.status(500).json({ error: "Failed to import XLSX" });
  }
});

// GET /outbound-leads/import-xlsx/status/:jobId — poll import progress
router.get("/import-xlsx/status/:jobId", (req, res) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json({
    status: job.status,
    step: job.step,
    total: job.total,
    processed: job.processed,
    imported: job.imported,
    skipped: job.skipped,
    campaignLeadsCreated: job.campaignLeadsCreated,
    errors: job.errors.length > 0 ? job.errors.slice(0, 10) : undefined,
  });
});

// POST /outbound-leads/bulk-delete — delete multiple leads by IDs or by filter
router.post("/bulk-delete", async (req, res) => {
  try {
    const { ids, all, filters } = req.body;
    const accountId = req.account._id;

    let deleteFilter;

    if (all && filters) {
      // Delete all leads matching the current filters
      deleteFilter = { account_id: accountId };
      if (filters.source) deleteFilter.source = filters.source;
      if (filters.replied !== undefined) deleteFilter.replied = filters.replied === "true";
      if (filters.booked !== undefined) deleteFilter.booked = filters.booked === "true";
      if (filters.promptLabel) deleteFilter.promptLabel = { $regex: filters.promptLabel, $options: "i" };
      if (filters.isMessaged !== undefined) {
        deleteFilter.isMessaged = filters.isMessaged === "true" ? true : { $ne: true };
      }
      if (filters.search) {
        deleteFilter.$or = [
          { username: { $regex: filters.search, $options: "i" } },
          { fullName: { $regex: filters.search, $options: "i" } },
        ];
      }
    } else if (ids && Array.isArray(ids) && ids.length > 0) {
      deleteFilter = { _id: { $in: ids }, account_id: accountId };
    } else {
      return res.status(400).json({ error: "Provide ids array or all+filters" });
    }

    const result = await OutboundLead.deleteMany(deleteFilter);

    // Also clean up any CampaignLead references
    if (result.deletedCount > 0) {
      if (ids) {
        await CampaignLead.deleteMany({ outbound_lead_id: { $in: ids } });
      }
    }

    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error("Bulk delete error:", err);
    res.status(500).json({ error: "Failed to delete leads" });
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
