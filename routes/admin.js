const express = require("express");
const mongoose = require("mongoose");

// Import schemas (not models — we'll register them on the target connection)
const PromptSchema = require("../models/Prompt").schema;
const ApifyTokenSchema = require("../models/ApifyToken").schema;
const DeepScrapeJobSchema = require("../models/DeepScrapeJob").schema;
const ResearchPostSchema = require("../models/ResearchPost").schema;
const ResearchCommentSchema = require("../models/ResearchComment").schema;
const OutboundLeadSchema = require("../models/OutboundLead").schema;
const OutboundAccountSchema = require("../models/OutboundAccount").schema;
const CampaignSchema = require("../models/Campaign").schema;
const CampaignLeadSchema = require("../models/CampaignLead").schema;

// Source models (for reading from current DB)
const Prompt = require("../models/Prompt");
const ApifyToken = require("../models/ApifyToken");
const DeepScrapeJob = require("../models/DeepScrapeJob");
const ResearchPost = require("../models/ResearchPost");
const ResearchComment = require("../models/ResearchComment");
const OutboundLead = require("../models/OutboundLead");
const OutboundAccount = require("../models/OutboundAccount");
const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");

const router = express.Router();

// Admin guard
function requireAdmin(req, res, next) {
  if (req.user?.role !== 0) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

router.use(requireAdmin);

// GET /api/admin/migration-counts — pre-migration document counts
router.post("/migration-counts", async (req, res) => {
  const { collections } = req.body;
  const sourceAccountId = req.account._id;
  const requested = new Set(collections || []);

  const counts = {};

  try {
    if (requested.has("prompts"))
      counts.prompts = await Prompt.countDocuments({ account_id: sourceAccountId });
    if (requested.has("apify_tokens"))
      counts.apify_tokens = await ApifyToken.countDocuments({ account_id: sourceAccountId });
    if (requested.has("deep_scrape_jobs"))
      counts.deep_scrape_jobs = await DeepScrapeJob.countDocuments({ account_id: sourceAccountId });
    if (requested.has("research_posts"))
      counts.research_posts = await ResearchPost.countDocuments({ account_id: sourceAccountId });
    if (requested.has("research_comments"))
      counts.research_comments = await ResearchComment.countDocuments({ account_id: sourceAccountId });
    if (requested.has("outbound_leads"))
      counts.outbound_leads = await OutboundLead.countDocuments({ account_id: sourceAccountId });
    if (requested.has("outbound_accounts"))
      counts.outbound_accounts = await OutboundAccount.countDocuments({ account_id: sourceAccountId });
    if (requested.has("campaigns")) {
      counts.campaigns = await Campaign.countDocuments({ account_id: sourceAccountId });
      counts.campaign_leads = await CampaignLead.countDocuments({
        campaign_id: { $in: await Campaign.find({ account_id: sourceAccountId }).distinct("_id") },
      });
    }

    res.json({ counts });
  } catch (err) {
    console.error("[admin] Migration counts failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/migrate-scrape-data
router.post("/migrate-scrape-data", async (req, res) => {
  const { target_mongo_uri, target_account_id, collections } = req.body;

  if (!target_account_id) {
    return res.status(400).json({ error: "target_account_id is required" });
  }

  if (!mongoose.Types.ObjectId.isValid(target_account_id)) {
    return res.status(400).json({ error: "Invalid target_account_id" });
  }

  const requested = new Set(collections || [
    "prompts", "apify_tokens", "deep_scrape_jobs",
    "research_posts", "research_comments", "outbound_leads",
  ]);

  const sourceAccountId = req.account._id;
  const targetAccountOid = new mongoose.Types.ObjectId(target_account_id);
  const useSameDb = !target_mongo_uri || !target_mongo_uri.trim();

  let targetConn = null;
  const summary = {};

  try {
    // Connect to target database (or reuse current connection)
    if (useSameDb) {
      targetConn = mongoose.connection;
    } else {
      targetConn = await mongoose.createConnection(target_mongo_uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10000,
      }).asPromise();
    }

    // Register models on target connection
    const TargetPrompt = useSameDb ? Prompt : targetConn.model("Prompt", PromptSchema, "prompts");
    const TargetApifyToken = useSameDb ? ApifyToken : targetConn.model("ApifyToken", ApifyTokenSchema, "apify_tokens");
    const TargetDeepScrapeJob = useSameDb ? DeepScrapeJob : targetConn.model("DeepScrapeJob", DeepScrapeJobSchema, "deep_scrape_jobs");
    const TargetResearchPost = useSameDb ? ResearchPost : targetConn.model("ResearchPost", ResearchPostSchema, "research_posts");
    const TargetResearchComment = useSameDb ? ResearchComment : targetConn.model("ResearchComment", ResearchCommentSchema, "research_comments");
    const TargetOutboundLead = useSameDb ? OutboundLead : targetConn.model("OutboundLead", OutboundLeadSchema, "outbound_leads");
    const TargetOutboundAccount = useSameDb ? OutboundAccount : targetConn.model("OutboundAccount", OutboundAccountSchema, "outbound_accounts");
    const TargetCampaign = useSameDb ? Campaign : targetConn.model("Campaign", CampaignSchema, "campaigns");
    const TargetCampaignLead = useSameDb ? CampaignLead : targetConn.model("CampaignLead", CampaignLeadSchema, "campaign_leads");

    // ID mappings built as we go
    const promptMap = new Map();  // oldId string → newId ObjectId
    const jobMap = new Map();
    const postMap = new Map();
    const outboundLeadMap = new Map();
    const outboundAccountMap = new Map();
    const campaignMap = new Map();

    // ── 1. Prompts ──
    if (requested.has("prompts")) {
      const docs = await Prompt.find({ account_id: sourceAccountId }).lean();
      const mapped = docs.map((doc) => {
        const newId = new mongoose.Types.ObjectId();
        promptMap.set(doc._id.toString(), newId);
        return {
          ...doc,
          _id: newId,
          account_id: targetAccountOid,
        };
      });
      if (mapped.length > 0) {
        await TargetPrompt.insertMany(mapped, { ordered: false }).catch(handleDuplicates);
      }
      summary.prompts = mapped.length;
    }

    // ── 2. ApifyTokens ──
    if (requested.has("apify_tokens")) {
      const docs = await ApifyToken.find({ account_id: sourceAccountId }).lean();
      const mapped = docs.map((doc) => ({
        ...doc,
        _id: new mongoose.Types.ObjectId(),
        account_id: targetAccountOid,
      }));
      if (mapped.length > 0) {
        await TargetApifyToken.insertMany(mapped, { ordered: false }).catch(handleDuplicates);
      }
      summary.apify_tokens = mapped.length;
    }

    // ── 3. DeepScrapeJobs ──
    if (requested.has("deep_scrape_jobs")) {
      const docs = await DeepScrapeJob.find({ account_id: sourceAccountId }).lean();

      // First pass: create all new IDs so parent_job_id can reference them
      for (const doc of docs) {
        jobMap.set(doc._id.toString(), new mongoose.Types.ObjectId());
      }

      const mapped = docs.map((doc) => {
        const newId = jobMap.get(doc._id.toString());
        return {
          ...doc,
          _id: newId,
          account_id: targetAccountOid,
          promptId: doc.promptId ? (promptMap.get(doc.promptId.toString()) || doc.promptId) : null,
          parent_job_id: doc.parent_job_id ? (jobMap.get(doc.parent_job_id.toString()) || doc.parent_job_id) : null,
        };
      });
      if (mapped.length > 0) {
        await TargetDeepScrapeJob.insertMany(mapped, { ordered: false }).catch(handleDuplicates);
      }
      summary.deep_scrape_jobs = mapped.length;
    }

    // ── 4. ResearchPosts ──
    if (requested.has("research_posts")) {
      const docs = await ResearchPost.find({ account_id: sourceAccountId }).lean();
      const mapped = docs.map((doc) => {
        const newId = new mongoose.Types.ObjectId();
        postMap.set(doc._id.toString(), newId);
        return {
          ...doc,
          _id: newId,
          account_id: targetAccountOid,
          deep_scrape_job_id: doc.deep_scrape_job_id
            ? (jobMap.get(doc.deep_scrape_job_id.toString()) || doc.deep_scrape_job_id)
            : null,
        };
      });
      if (mapped.length > 0) {
        // Insert in chunks to avoid memory issues with large datasets
        const CHUNK = 1000;
        for (let i = 0; i < mapped.length; i += CHUNK) {
          await TargetResearchPost.insertMany(mapped.slice(i, i + CHUNK), { ordered: false }).catch(handleDuplicates);
        }
      }
      summary.research_posts = mapped.length;
    }

    // ── 5. ResearchComments ──
    if (requested.has("research_comments")) {
      const docs = await ResearchComment.find({ account_id: sourceAccountId }).lean();
      const mapped = docs.map((doc) => ({
        ...doc,
        _id: new mongoose.Types.ObjectId(),
        account_id: targetAccountOid,
        deep_scrape_job_id: doc.deep_scrape_job_id
          ? (jobMap.get(doc.deep_scrape_job_id.toString()) || doc.deep_scrape_job_id)
          : null,
        research_post_id: doc.research_post_id
          ? (postMap.get(doc.research_post_id.toString()) || doc.research_post_id)
          : null,
      }));
      if (mapped.length > 0) {
        const CHUNK = 1000;
        for (let i = 0; i < mapped.length; i += CHUNK) {
          await TargetResearchComment.insertMany(mapped.slice(i, i + CHUNK), { ordered: false }).catch(handleDuplicates);
        }
      }
      summary.research_comments = mapped.length;
    }

    // ── 6. OutboundLeads ──
    if (requested.has("outbound_leads")) {
      const docs = await OutboundLead.find({ account_id: sourceAccountId }).lean();
      const mapped = docs.map((doc) => {
        const newId = new mongoose.Types.ObjectId();
        outboundLeadMap.set(doc._id.toString(), newId);
        const newDoc = {
          ...doc,
          _id: newId,
          account_id: targetAccountOid,
          promptId: doc.promptId ? (promptMap.get(doc.promptId.toString()) || doc.promptId) : null,
        };

        // Remap metadata.executionId (e.g. "deep-scrape-{oldJobId}" → "deep-scrape-{newJobId}")
        if (newDoc.metadata?.executionId) {
          const match = newDoc.metadata.executionId.match(/^deep-scrape-(.+)$/);
          if (match && jobMap.has(match[1])) {
            newDoc.metadata = {
              ...newDoc.metadata,
              executionId: `deep-scrape-${jobMap.get(match[1]).toString()}`,
            };
          }
        }

        return newDoc;
      });
      if (mapped.length > 0) {
        const CHUNK = 1000;
        for (let i = 0; i < mapped.length; i += CHUNK) {
          await TargetOutboundLead.insertMany(mapped.slice(i, i + CHUNK), { ordered: false }).catch(handleDuplicates);
        }
      }
      summary.outbound_leads = mapped.length;
    }

    // ── 7. OutboundAccounts ──
    if (requested.has("outbound_accounts")) {
      const docs = await OutboundAccount.find({ account_id: sourceAccountId }).lean();
      const mapped = docs.map((doc) => {
        const newId = new mongoose.Types.ObjectId();
        outboundAccountMap.set(doc._id.toString(), newId);
        const newDoc = { ...doc, _id: newId, account_id: targetAccountOid };
        // Strip browser sessions for security
        delete newDoc.browser_token;
        return newDoc;
      });
      if (mapped.length > 0) {
        await TargetOutboundAccount.insertMany(mapped, { ordered: false }).catch(handleDuplicates);
      }
      summary.outbound_accounts = mapped.length;
    }

    // ── 8. Campaigns + CampaignLeads ──
    if (requested.has("campaigns")) {
      const campaignDocs = await Campaign.find({ account_id: sourceAccountId }).lean();
      const mapped = campaignDocs.map((doc) => {
        const newId = new mongoose.Types.ObjectId();
        campaignMap.set(doc._id.toString(), newId);
        return {
          ...doc,
          _id: newId,
          account_id: targetAccountOid,
          status: "paused",
          // Remap sender references to migrated outbound accounts
          outbound_account_ids: (doc.outbound_account_ids || []).map((id) =>
            outboundAccountMap.get(id.toString()) || id
          ),
          // Reset runtime state
          last_sent_at: null,
          last_sender_index: 0,
          burst_sent_in_group: 0,
          burst_break_until: null,
          ai_personalization: {
            enabled: false,
            prompt: null,
            status: "idle",
            progress: 0,
            total: 0,
            error: null,
          },
        };
      });
      if (mapped.length > 0) {
        await TargetCampaign.insertMany(mapped, { ordered: false }).catch(handleDuplicates);
      }
      summary.campaigns = mapped.length;

      // Migrate campaign leads for all migrated campaigns
      let totalLeads = 0;
      for (const [oldCampaignId, newCampaignId] of campaignMap.entries()) {
        const leadDocs = await CampaignLead.find({ campaign_id: new mongoose.Types.ObjectId(oldCampaignId) }).lean();
        const mappedLeads = leadDocs.map((doc) => ({
          ...doc,
          _id: new mongoose.Types.ObjectId(),
          campaign_id: newCampaignId,
          outbound_lead_id: outboundLeadMap.get(doc.outbound_lead_id?.toString()) || doc.outbound_lead_id,
          sender_id: null, // Reset sender assignment
          status: "pending",
          sent_at: null,
          message_used: null,
          custom_message: null,
          error: null,
          queued_at: null,
          task_id: null,
          manually_overridden: false,
          overridden_by: null,
          overridden_at: null,
          failed_sender_ids: [],
        }));
        if (mappedLeads.length > 0) {
          const CHUNK = 1000;
          for (let i = 0; i < mappedLeads.length; i += CHUNK) {
            await TargetCampaignLead.insertMany(mappedLeads.slice(i, i + CHUNK), { ordered: false }).catch(handleDuplicates);
          }
        }
        totalLeads += mappedLeads.length;
      }
      summary.campaign_leads = totalLeads;

      // Recalculate stats for migrated campaigns
      for (const [, newCampaignId] of campaignMap.entries()) {
        const total = await TargetCampaignLead.countDocuments({ campaign_id: newCampaignId });
        await TargetCampaign.updateOne({ _id: newCampaignId }, {
          $set: {
            "stats.total": total,
            "stats.pending": total,
            "stats.queued": 0,
            "stats.sent": 0,
            "stats.delivered": 0,
            "stats.replied": 0,
            "stats.failed": 0,
            "stats.skipped": 0,
          },
        });
      }
    }

    res.json({ success: true, summary });
  } catch (err) {
    console.error("[admin] Migration failed:", err);
    res.status(500).json({ error: err.message, summary });
  } finally {
    if (targetConn && !useSameDb) {
      await targetConn.close().catch(() => {});
    }
  }
});

// Ignore duplicate key errors from insertMany (ordered: false)
function handleDuplicates(err) {
  if (err.code === 11000 || err.writeErrors?.every((e) => e.code === 11000)) {
    return; // duplicates are expected on re-runs
  }
  throw err;
}

module.exports = router;
