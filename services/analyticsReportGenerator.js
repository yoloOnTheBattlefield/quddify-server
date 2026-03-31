const mongoose = require("mongoose");
const OutboundLead = require("../models/OutboundLead");
const CampaignLead = require("../models/CampaignLead");
const Campaign = require("../models/Campaign");
const SenderAccount = require("../models/SenderAccount");
const AnalyticsReport = require("../models/AnalyticsReport");
const { getClaudeClient } = require("../utils/aiClients");
const logger = require("../utils/logger").child({ module: "analyticsReportGenerator" });

// ── Filter Builders ──────────────────────────────────────

function buildOutboundFilter(accountId, { startDate, endDate, campaignLeadIds }) {
  const filter = { account_id: new mongoose.Types.ObjectId(accountId), isMessaged: true };

  if (startDate || endDate) {
    filter.dmDate = {};
    if (startDate) filter.dmDate.$gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate) filter.dmDate.$lte = new Date(`${endDate}T23:59:59.999Z`);
  }

  if (campaignLeadIds) {
    filter._id = { $in: campaignLeadIds };
  }

  return filter;
}

async function getCampaignLeadIds(campaignId) {
  if (!campaignId) return null;
  const leads = await CampaignLead.find({ campaign_id: campaignId }).select("outbound_lead_id").lean();
  return leads.map((l) => l.outbound_lead_id);
}

// ── Data Gathering ───────────────────────────────────────

async function gatherAnalyticsData(accountId, { startDate, endDate, campaignId }) {
  const campaignLeadIds = await getCampaignLeadIds(campaignId);
  const obFilter = buildOutboundFilter(accountId, { startDate, endDate, campaignLeadIds });

  const [funnel, messages, senders, campaigns, followerTiers, promptLabels, timeOfDay, aiModels, industryData] =
    await Promise.all([
      gatherFunnel(obFilter),
      gatherMessages(obFilter),
      gatherSenders(accountId, { startDate, endDate, campaignId }),
      gatherCampaigns(accountId, { startDate, endDate }),
      gatherFollowerTiers(obFilter),
      gatherPromptLabels(obFilter),
      gatherTimeOfDay(accountId, { startDate, endDate, campaignId }),
      gatherAIModels(accountId, obFilter, { startDate, endDate, campaignId }),
      gatherIndustryData(obFilter),
    ]);

  return { funnel, messages, senders, campaigns, followerTiers, promptLabels, timeOfDay, aiModels, industryData };
}

async function gatherFunnel(obFilter) {
  const [messaged, replied, link_sent, booked, contractAgg] = await Promise.all([
    OutboundLead.countDocuments(obFilter),
    OutboundLead.countDocuments({ ...obFilter, replied: true }),
    OutboundLead.countDocuments({ ...obFilter, link_sent: true }),
    OutboundLead.countDocuments({ ...obFilter, booked: true }),
    OutboundLead.aggregate([
      { $match: { ...obFilter, contract_value: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$contract_value" }, count: { $sum: 1 } } },
    ]),
  ]);

  const contracts = contractAgg[0]?.count || 0;
  const contract_value = contractAgg[0]?.total || 0;
  const reply_rate = messaged > 0 ? round2((replied / messaged) * 100) : 0;
  const book_rate = replied > 0 ? round2((booked / replied) * 100) : 0;

  return { messaged, replied, link_sent, booked, contracts, contract_value, reply_rate, book_rate };
}

async function gatherMessages(obFilter) {
  return OutboundLead.aggregate([
    { $match: { ...obFilter, message: { $nin: [null, ""] } } },
    {
      $group: {
        _id: "$message",
        sent: { $sum: 1 },
        replied: { $sum: { $cond: ["$replied", 1, 0] } },
        booked: { $sum: { $cond: ["$booked", 1, 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        message: { $substrCP: ["$_id", 0, 200] },
        sent: 1,
        replied: 1,
        booked: 1,
        reply_rate: {
          $cond: [{ $gt: ["$sent", 0] }, { $round: [{ $multiply: [{ $divide: ["$replied", "$sent"] }, 100] }, 1] }, 0],
        },
        book_rate: {
          $cond: [{ $gt: ["$replied", 0] }, { $round: [{ $multiply: [{ $divide: ["$booked", "$replied"] }, 100] }, 1] }, 0],
        },
      },
    },
    { $sort: { sent: -1 } },
    { $limit: 20 },
  ]);
}

async function gatherSenders(accountId, { startDate, endDate, campaignId }) {
  const match = { sender_id: { $ne: null } };
  if (campaignId) match.campaign_id = new mongoose.Types.ObjectId(campaignId);
  else {
    const accountCampaigns = await Campaign.find({ account_id: accountId }).select("_id").lean();
    match.campaign_id = { $in: accountCampaigns.map((c) => c._id) };
  }
  if (startDate || endDate) {
    match.sent_at = {};
    if (startDate) match.sent_at.$gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate) match.sent_at.$lte = new Date(`${endDate}T23:59:59.999Z`);
  }

  const senderGroups = await CampaignLead.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$sender_id",
        sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "replied"]] }, 1, 0] } },
        outbound_lead_ids: {
          $push: { $cond: [{ $in: ["$status", ["sent", "delivered", "replied"]] }, "$outbound_lead_id", "$$REMOVE"] },
        },
      },
    },
  ]);

  const results = await Promise.all(
    senderGroups.slice(0, 15).map(async (s) => {
      const sender = await SenderAccount.findById(s._id).select("ig_username status").lean();
      const [replied, booked] = await Promise.all([
        OutboundLead.countDocuments({ _id: { $in: s.outbound_lead_ids }, replied: true }),
        OutboundLead.countDocuments({ _id: { $in: s.outbound_lead_ids }, booked: true }),
      ]);
      return {
        ig_username: sender?.ig_username || "Unknown",
        status: sender?.status || "unknown",
        sent: s.sent,
        replied,
        booked,
        reply_rate: s.sent > 0 ? round2((replied / s.sent) * 100) : 0,
        book_rate: replied > 0 ? round2((booked / replied) * 100) : 0,
      };
    })
  );

  return results.sort((a, b) => b.sent - a.sent);
}

async function gatherCampaigns(accountId, { startDate, endDate }) {
  const campaigns = await Campaign.find({ account_id: accountId })
    .select("name status stats")
    .sort({ createdAt: -1 })
    .lean();

  const clDateFilter = {};
  if (startDate || endDate) {
    clDateFilter.sent_at = {};
    if (startDate) clDateFilter.sent_at.$gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate) clDateFilter.sent_at.$lte = new Date(`${endDate}T23:59:59.999Z`);
  }

  const results = await Promise.all(
    campaigns.slice(0, 10).map(async (c) => {
      const sentLeads = await CampaignLead.find({
        campaign_id: c._id,
        status: { $in: ["sent", "delivered", "replied"] },
        ...clDateFilter,
      })
        .select("outbound_lead_id")
        .lean();
      const outboundIds = sentLeads.map((l) => l.outbound_lead_id);
      const sent = sentLeads.length;

      const [replied, booked] = await Promise.all([
        OutboundLead.countDocuments({ _id: { $in: outboundIds }, replied: true }),
        OutboundLead.countDocuments({ _id: { $in: outboundIds }, booked: true }),
      ]);

      return {
        name: c.name,
        status: c.status,
        sent,
        replied,
        booked,
        reply_rate: sent > 0 ? round2((replied / sent) * 100) : 0,
        book_rate: replied > 0 ? round2((booked / replied) * 100) : 0,
      };
    })
  );

  return results;
}

async function gatherFollowerTiers(obFilter) {
  return OutboundLead.aggregate([
    { $match: obFilter },
    {
      $addFields: {
        tier: {
          $switch: {
            branches: [
              { case: { $or: [{ $eq: ["$followersCount", null] }, { $lt: ["$followersCount", 1000] }] }, then: "<1K" },
              { case: { $lt: ["$followersCount", 10000] }, then: "1K-10K" },
              { case: { $lt: ["$followersCount", 100000] }, then: "10K-100K" },
            ],
            default: "100K+",
          },
        },
      },
    },
    {
      $group: {
        _id: "$tier",
        sent: { $sum: 1 },
        replied: { $sum: { $cond: ["$replied", 1, 0] } },
        booked: { $sum: { $cond: ["$booked", 1, 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        tier: "$_id",
        sent: 1,
        replied: 1,
        booked: 1,
        reply_rate: {
          $cond: [{ $gt: ["$sent", 0] }, { $round: [{ $multiply: [{ $divide: ["$replied", "$sent"] }, 100] }, 1] }, 0],
        },
        book_rate: {
          $cond: [{ $gt: ["$replied", 0] }, { $round: [{ $multiply: [{ $divide: ["$booked", "$replied"] }, 100] }, 1] }, 0],
        },
      },
    },
    { $sort: { sent: -1 } },
  ]);
}

async function gatherPromptLabels(obFilter) {
  return OutboundLead.aggregate([
    { $match: obFilter },
    {
      $group: {
        _id: { $ifNull: ["$promptLabel", "No Label"] },
        sent: { $sum: 1 },
        replied: { $sum: { $cond: ["$replied", 1, 0] } },
        booked: { $sum: { $cond: ["$booked", 1, 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        label: "$_id",
        sent: 1,
        replied: 1,
        booked: 1,
        reply_rate: {
          $cond: [{ $gt: ["$sent", 0] }, { $round: [{ $multiply: [{ $divide: ["$replied", "$sent"] }, 100] }, 1] }, 0],
        },
        book_rate: {
          $cond: [{ $gt: ["$replied", 0] }, { $round: [{ $multiply: [{ $divide: ["$booked", "$replied"] }, 100] }, 1] }, 0],
        },
      },
    },
    { $sort: { sent: -1 } },
  ]);
}

async function gatherTimeOfDay(accountId, { startDate, endDate, campaignId }) {
  const match = { status: { $in: ["sent", "delivered", "replied"] } };

  if (campaignId) {
    match.campaign_id = new mongoose.Types.ObjectId(campaignId);
  } else {
    const accountCampaigns = await Campaign.find({ account_id: accountId }).select("_id").lean();
    match.campaign_id = { $in: accountCampaigns.map((c) => c._id) };
  }

  if (startDate || endDate) {
    match.sent_at = {};
    if (startDate) match.sent_at.$gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate) match.sent_at.$lte = new Date(`${endDate}T23:59:59.999Z`);
  }
  if (!match.sent_at) match.sent_at = { $ne: null };
  else match.sent_at.$ne = null;

  const hourGroups = await CampaignLead.aggregate([
    { $match: match },
    { $group: { _id: { $hour: "$sent_at" }, sent: { $sum: 1 }, outbound_lead_ids: { $push: "$outbound_lead_id" } } },
  ]);

  const results = await Promise.all(
    hourGroups.map(async (h) => {
      const replied = await OutboundLead.countDocuments({ _id: { $in: h.outbound_lead_ids }, replied: true });
      return {
        hour: h._id,
        sent: h.sent,
        replied,
        reply_rate: h.sent > 0 ? round2((replied / h.sent) * 100) : 0,
      };
    })
  );

  return results.sort((a, b) => a.hour - b.hour);
}

async function gatherAIModels(accountId, obFilter, { startDate, endDate, campaignId }) {
  const match = { ...obFilter, ai_provider: { $ne: null } };

  return OutboundLead.aggregate([
    { $match: match },
    { $addFields: { resolved_model: { $ifNull: ["$ai_model", "$ai_provider"] } } },
    {
      $group: {
        _id: "$resolved_model",
        ai_provider: { $first: "$ai_provider" },
        messages_sent: { $sum: 1 },
        replied: { $sum: { $cond: [{ $eq: ["$replied", true] }, 1, 0] } },
        booked: { $sum: { $cond: [{ $eq: ["$booked", true] }, 1, 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        model: "$_id",
        ai_provider: 1,
        messages_sent: 1,
        replied: 1,
        booked: 1,
        reply_rate: {
          $cond: [
            { $gt: ["$messages_sent", 0] },
            { $round: [{ $multiply: [{ $divide: ["$replied", "$messages_sent"] }, 100] }, 1] },
            0,
          ],
        },
        book_rate: {
          $cond: [
            { $gt: ["$replied", 0] },
            { $round: [{ $multiply: [{ $divide: ["$booked", "$replied"] }, 100] }, 1] },
            0,
          ],
        },
      },
    },
    { $sort: { messages_sent: -1 } },
  ]);
}

async function gatherIndustryData(obFilter) {
  // Extract niche keywords from bios and compute performance per keyword
  const NICHE_KEYWORDS = [
    "fitness", "coach", "trainer", "gym", "yoga", "pilates", "crossfit",
    "realtor", "real estate", "property", "mortgage",
    "dentist", "dental", "chiropractor", "therapist", "clinic", "doctor", "health", "wellness", "med spa", "medspa",
    "restaurant", "chef", "food", "cafe", "bakery", "catering",
    "salon", "beauty", "hair", "barber", "nails", "skincare", "esthetician", "lash",
    "photographer", "videographer", "wedding", "events",
    "lawyer", "attorney", "law firm", "legal",
    "accountant", "financial", "finance", "insurance", "tax",
    "agency", "marketing", "social media", "seo", "branding",
    "ecommerce", "shopify", "dropshipping", "amazon",
    "music", "dj", "producer", "artist",
    "construction", "plumber", "electrician", "hvac", "roofing", "landscaping",
    "auto", "car", "mechanic", "detailing",
    "pet", "vet", "grooming", "dog", "cat",
    "education", "tutor", "school", "course", "mentor",
    "tech", "software", "developer", "saas", "startup",
    "travel", "hotel", "airbnb", "tourism",
    "fashion", "clothing", "jewelry", "boutique",
    "disney",
  ];

  const results = await OutboundLead.aggregate([
    { $match: { ...obFilter, bio: { $nin: [null, ""] } } },
    {
      $project: {
        bio_lower: { $toLower: "$bio" },
        replied: 1,
        booked: 1,
      },
    },
    {
      $addFields: {
        matched_niches: {
          $filter: {
            input: NICHE_KEYWORDS,
            as: "kw",
            cond: { $gte: [{ $indexOfCP: ["$bio_lower", "$$kw"] }, 0] },
          },
        },
      },
    },
    { $unwind: "$matched_niches" },
    {
      $group: {
        _id: "$matched_niches",
        sent: { $sum: 1 },
        replied: { $sum: { $cond: ["$replied", 1, 0] } },
        booked: { $sum: { $cond: ["$booked", 1, 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        niche: "$_id",
        sent: 1,
        replied: 1,
        booked: 1,
        reply_rate: {
          $cond: [{ $gt: ["$sent", 0] }, { $round: [{ $multiply: [{ $divide: ["$replied", "$sent"] }, 100] }, 1] }, 0],
        },
        book_rate: {
          $cond: [{ $gt: ["$replied", 0] }, { $round: [{ $multiply: [{ $divide: ["$booked", "$replied"] }, 100] }, 1] }, 0],
        },
      },
    },
    { $match: { sent: { $gte: 3 } } }, // Only niches with meaningful sample size
    { $sort: { sent: -1 } },
    { $limit: 25 },
  ]);

  return results;
}

// ── AI Report Generation ─────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Instagram DM outreach analyst. You analyze outbound messaging performance data and generate actionable reports.

Your reports must be:
- Data-driven: every claim must reference specific numbers from the data
- Actionable: every recommendation must be specific and implementable
- Comparative: highlight what's working vs what's not, and why
- Honest: if data is insufficient for a conclusion, say so

You respond with valid JSON only, no markdown or explanation outside the JSON.`;

function buildUserPrompt(data, dateRange) {
  return `Analyze this Instagram DM outreach data for the period ${dateRange.start} to ${dateRange.end} and generate a comprehensive report.

## DATA

### Overall Funnel
${JSON.stringify(data.funnel, null, 2)}

### Per-Sender Performance (top 15)
${JSON.stringify(data.senders, null, 2)}

### Per-Message Performance (top 20 by volume)
${JSON.stringify(data.messages, null, 2)}

### Per-Campaign Performance
${JSON.stringify(data.campaigns, null, 2)}

### Industry/Niche Performance (extracted from bios)
${JSON.stringify(data.industryData, null, 2)}

### Follower Tier Performance
${JSON.stringify(data.followerTiers, null, 2)}

### Prompt Label Performance
${JSON.stringify(data.promptLabels, null, 2)}

### Time of Day Performance (hour 0-23 UTC)
${JSON.stringify(data.timeOfDay, null, 2)}

### AI Model Performance
${JSON.stringify(data.aiModels, null, 2)}

## REQUIRED OUTPUT FORMAT

Respond with a JSON object matching this exact structure:
{
  "executive_summary": "2-3 sentence overview of overall performance and the single most important finding",
  "overall_health": "green" | "yellow" | "red",
  "sender_analysis": {
    "summary": "1-2 sentence summary",
    "rankings": [{ "sender": "username", "rating": "strong" | "average" | "weak", "reason": "why" }],
    "recommendations": ["specific actionable recommendation"]
  },
  "message_strategy": {
    "summary": "1-2 sentence summary",
    "top_performers": [{ "preview": "first 100 chars of message", "why_it_works": "analysis" }],
    "worst_performers": [{ "preview": "first 100 chars of message", "why_it_fails": "analysis" }],
    "recommendations": ["specific actionable recommendation"]
  },
  "industry_analysis": {
    "summary": "1-2 sentence summary",
    "best_niches": [{ "niche": "name", "reply_rate": number, "reason": "why they respond well" }],
    "worst_niches": [{ "niche": "name", "reply_rate": number, "reason": "why they don't respond" }],
    "recommendations": ["specific actionable recommendation"]
  },
  "campaign_analysis": {
    "summary": "1-2 sentence summary",
    "highlights": ["key finding about campaigns"],
    "recommendations": ["specific actionable recommendation"]
  },
  "timing_analysis": {
    "best_times": "description of best performing hours",
    "worst_times": "description of worst performing hours",
    "recommendations": ["specific actionable recommendation"]
  },
  "action_items": [
    { "priority": "high" | "medium" | "low", "action": "specific thing to do", "expected_impact": "what improvement to expect" }
  ]
}`;
}

async function generateReport(accountId, { startDate, endDate, campaignId }) {
  const data = await gatherAnalyticsData(accountId, { startDate, endDate, campaignId });

  // Skip if no data
  if (data.funnel.messaged === 0) {
    return {
      report: {
        executive_summary: "No outbound messages were sent in this date range. There is no data to analyze.",
        overall_health: "red",
        sender_analysis: { summary: "No data", rankings: [], recommendations: ["Start sending outbound messages to generate data for analysis."] },
        message_strategy: { summary: "No data", top_performers: [], worst_performers: [], recommendations: [] },
        industry_analysis: { summary: "No data", best_niches: [], worst_niches: [], recommendations: [] },
        campaign_analysis: { summary: "No data", highlights: [], recommendations: [] },
        timing_analysis: { best_times: "No data", worst_times: "No data", recommendations: [] },
        action_items: [{ priority: "high", action: "Launch your first outbound campaign", expected_impact: "Begin generating leads and data for optimization" }],
      },
      token_usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const claude = await getClaudeClient({ accountId });
  const dateRange = { start: startDate || "all time", end: endDate || "today" };

  const response = await claude.messages.create({
    model: "claude-opus-4-20250514",
    max_tokens: 4096,
    temperature: 0.3,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(data, dateRange) }],
  });

  const text = response.content[0].text;
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    // Try extracting JSON from response if it contains extra text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      report = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error("Failed to parse AI response as JSON");
    }
  }

  return {
    report,
    token_usage: {
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0,
    },
  };
}

// ── Main Entry Point ─────────────────────────────────────

async function generateAndSaveReport(reportId) {
  const reportDoc = await AnalyticsReport.findById(reportId);
  if (!reportDoc) throw new Error(`Report ${reportId} not found`);

  try {
    const startDate = reportDoc.date_range.start?.toISOString().slice(0, 10);
    const endDate = reportDoc.date_range.end?.toISOString().slice(0, 10);

    const { report, token_usage } = await generateReport(reportDoc.account_id, {
      startDate,
      endDate,
      campaignId: reportDoc.campaign_id,
    });

    reportDoc.report = report;
    reportDoc.token_usage = token_usage;
    reportDoc.status = "completed";
    await reportDoc.save();

    logger.info({ reportId, token_usage }, "AI analytics report generated successfully");
  } catch (err) {
    logger.error({ reportId, err: err.message }, "AI analytics report generation failed");
    reportDoc.status = "failed";
    reportDoc.error = err.message;
    await reportDoc.save();
  }
}

// ── Helpers ──────────────────────────────────────────────

function round2(num) {
  return Math.round(num * 100) / 100;
}

module.exports = { generateAndSaveReport, generateReport, gatherAnalyticsData };
