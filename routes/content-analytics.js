const logger = require("../utils/logger").child({ module: "content-analytics" });
const express = require("express");

const MediaInsight = require("../models/MediaInsight");
const CommentEvent = require("../models/CommentEvent");
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

    // Leads attributed to a post come from the comment events fired on it.
    const byMedia = await CommentEvent.aggregate([
      { $match: { account_id: req.account._id, media_id: { $ne: null } } },
      {
        $group: {
          _id: "$media_id",
          comments_matched: { $sum: 1 },
          dms_sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
          leads: { $addToSet: "$lead_id" },
        },
      },
    ]);

    const attribution = new Map(
      byMedia.map((row) => [
        row._id,
        {
          comments_matched: row.comments_matched,
          dms_sent: row.dms_sent,
          leads_generated: row.leads.filter(Boolean).length,
        },
      ]),
    );

    const rows = posts.map((post) => {
      const attr = attribution.get(post.media_id) || {
        comments_matched: 0,
        dms_sent: 0,
        leads_generated: 0,
      };

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
        likes: acc.likes + (r.likes || 0),
        comments: acc.comments + (r.comments || 0),
        shares: acc.shares + (r.shares || 0),
        saved: acc.saved + (r.saved || 0),
        leads_generated: acc.leads_generated + r.leads_generated,
      }),
      { posts: 0, views: 0, likes: 0, comments: 0, shares: 0, saved: 0, leads_generated: 0 },
    );

    res.json({ posts: rows, totals, days });
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
