const logger = require("../utils/logger").child({ module: "content-analytics" });
const express = require("express");

const MediaInsight = require("../models/MediaInsight");
const CommentEvent = require("../models/CommentEvent");
const Lead = require("../models/Lead");
const mongoose = require("mongoose");
const instagramInsights = require("../services/instagramInsights");

const router = express.Router();

// ─── GET /api/content-analytics ─────────────────────────────────────────────
// Cached post metrics joined with how many leads each post actually produced.
router.get("/", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    const since = new Date(Date.now() - days * 86400000);

    const posts = await MediaInsight.find({
      account_id: req.account._id,
      posted_at: { $gte: since },
    })
      .sort({ posted_at: -1 })
      .lean();

    // Leads attributed to a post come from the comment events fired on it,
    // counted inside the same window as the posts.
    const byMedia = await CommentEvent.aggregate([
      { $match: { account_id: req.account._id, media_id: { $ne: null }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$media_id",
          comments_matched: { $sum: 1 },
          dms_sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
          leads: { $addToSet: "$lead_id" },
        },
      },
    ]);

    const commentLeads = new Map(
      byMedia.map((row) => [
        row._id,
        {
          comments_matched: row.comments_matched,
          dms_sent: row.dms_sent,
          ids: new Set(row.leads.filter(Boolean).map(String)),
        },
      ]),
    );

    // Leads that reached us by DM and that the agent tied to a post.
    const accountIdStr = String(req.account._id);
    const mediaIds = posts.map((p) => p.media_id);
    const dmRows = mediaIds.length
      ? await Lead.aggregate([
          {
            $match: {
              account_id: accountIdStr,
              source_media_id: { $in: mediaIds },
              source_type: { $ne: "comment" },
            },
          },
          { $group: { _id: "$source_media_id", ids: { $addToSet: "$_id" } } },
        ])
      : [];
    const dmLeads = new Map(dmRows.map((row) => [row._id, new Set(row.ids.map(String))]));

    const attribution = new Map(
      mediaIds.map((id) => {
        const c = commentLeads.get(id);
        const d = dmLeads.get(id) || new Set();
        const cIds = c ? c.ids : new Set();
        const union = new Set([...cIds, ...d]);
        return [
          id,
          {
            comments_matched: c ? c.comments_matched : 0,
            dms_sent: c ? c.dms_sent : 0,
            comment_leads: cIds.size,
            dm_leads: d.size,
            leads_generated: union.size,
          },
        ];
      }),
    );

    // Every lead created in the window, grouped by where it came from.
    const sinceId = mongoose.Types.ObjectId.createFromTime(Math.floor(since.getTime() / 1000));
    const sourceRows = await Lead.aggregate([
      { $match: { account_id: accountIdStr, _id: { $gte: sinceId } } },
      {
        $group: {
          _id: { source_type: { $ifNull: ["$source_type", "unknown"] }, source_label: { $ifNull: ["$source_label", null] } },
          leads: { $sum: 1 },
          booked: { $sum: { $cond: [{ $ifNull: ["$booked_at", false] }, 1, 0] } },
          won: { $sum: { $cond: [{ $ifNull: ["$closed_at", false] }, 1, 0] } },
        },
      },
      { $sort: { leads: -1 } },
    ]);
    const by_source = sourceRows.map((r) => ({
      source_type: r._id.source_type,
      source_label: r._id.source_label,
      leads: r.leads,
      booked: r.booked,
      won: r.won,
    }));

    const rows = posts.map((post) => {
      const attr = attribution.get(post.media_id);

      return {
        media_id: post.media_id,
        permalink: post.permalink,
        thumbnail_url: post.thumbnail_url,
        caption: post.caption,
        media_product_type: post.media_product_type,
        posted_at: post.posted_at,
        views: post.views,
        reach: post.reach,
        likes: post.like_count,
        comments: post.comments_count,
        shares: post.shares,
        saved: post.saved,
        total_interactions: post.total_interactions,
        insights_error: post.insights_error,
        fetched_at: post.fetched_at,
        ...attr,
        // Leads per thousand views — comparable across posts of different size.
        leads_per_1k_views:
          post.views > 0 ? +((attr.leads_generated / post.views) * 1000).toFixed(2) : null,
      };
    });

    const totals = rows.reduce(
      (acc, r) => ({
        posts: acc.posts + 1,
        views: acc.views + (r.views || 0),
        reach: acc.reach + (r.reach || 0),
        likes: acc.likes + (r.likes || 0),
        comments: acc.comments + (r.comments || 0),
        shares: acc.shares + (r.shares || 0),
        saved: acc.saved + (r.saved || 0),
        comment_leads: acc.comment_leads + r.comment_leads,
        dm_leads: acc.dm_leads + r.dm_leads,
        leads_generated: acc.leads_generated + r.leads_generated,
      }),
      {
        posts: 0, views: 0, reach: 0, likes: 0, comments: 0, shares: 0, saved: 0,
        comment_leads: 0, dm_leads: 0, leads_generated: 0,
      },
    );

    res.json({ posts: rows, totals, by_source, days });
  } catch (err) {
    logger.error("[content-analytics] list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/content-analytics/sync — refresh from the Graph API ──────────
router.post("/sync", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days, 10) || 90, 365);
    const result = await instagramInsights.syncAccountInsights(req.account._id, { days });
    res.json(result);
  } catch (err) {
    if (err.code === "NO_META_CONNECTION") {
      return res.status(400).json({ error: err.message });
    }
    logger.error("[content-analytics] sync error:", err);
    res.status(502).json({ error: err.message || "Could not refresh Instagram metrics" });
  }
});

module.exports = router;
