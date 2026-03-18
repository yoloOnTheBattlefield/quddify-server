const escapeRegex = require("../utils/escapeRegex");
const logger = require("../utils/logger").child({ module: "research" });
const express = require("express");
const ResearchPost = require("../models/ResearchPost");
const ResearchComment = require("../models/ResearchComment");

const router = express.Router();

// GET /api/research/overview-kpis
router.get("/overview-kpis", async (req, res) => {
  try {
    const accountId = req.account._id;

    const [postsTracked, commentStats, newPostsSinceLogin] = await Promise.all([
      ResearchPost.countDocuments({ account_id: accountId }),

      ResearchComment.aggregate([
        { $match: { account_id: accountId } },
        {
          $group: {
            _id: null,
            commentsAnalyzed: { $sum: 1 },
            uniqueCommenters: { $addToSet: "$commenter_username" },
          },
        },
        {
          $project: {
            commentsAnalyzed: 1,
            uniqueCommenters: { $size: "$uniqueCommenters" },
          },
        },
      ]),

      ResearchPost.countDocuments({
        account_id: accountId,
        scraped_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }),
    ]);

    const stats = commentStats[0] || {
      commentsAnalyzed: 0,
      uniqueCommenters: 0,
    };

    res.json({
      postsTracked,
      commentsAnalyzed: stats.commentsAnalyzed,
      uniqueCommenters: stats.uniqueCommenters,
      keywordSpikes: 0,
      leadMagnetPosts: 0,
      newPostsSinceLogin,
    });
  } catch (err) {
    logger.error("Research overview KPIs error:", err);
    res.status(500).json({ error: "Failed to fetch overview KPIs" });
  }
});

// GET /api/research/engagement-trend
router.get("/engagement-trend", async (req, res) => {
  try {
    const accountId = req.account._id;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const raw = await ResearchPost.aggregate([
      {
        $match: {
          account_id: accountId,
          posted_at: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            date: {
              $dateToString: { format: "%Y-%m-%d", date: "$posted_at" },
            },
            handle: "$competitor_handle",
          },
          totalComments: { $sum: "$comments_count" },
        },
      },
      { $sort: { "_id.date": 1 } },
    ]);

    // Pivot into { date, handleA: count, handleB: count, ... }
    const dateMap = {};
    for (const row of raw) {
      const { date, handle } = row._id;
      if (!dateMap[date]) dateMap[date] = { date };
      dateMap[date][handle] = row.totalComments;
    }

    // Fill missing dates in the 30-day window
    const result = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      result.push(dateMap[dateStr] || { date: dateStr });
    }

    res.json(result);
  } catch (err) {
    logger.error("Research engagement trend error:", err);
    res.status(500).json({ error: "Failed to fetch engagement trend" });
  }
});

// GET /api/research/top-posts
router.get("/top-posts", async (req, res) => {
  try {
    const accountId = req.account._id;
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit, 10) || 10),
    );

    const posts = await ResearchPost.find({ account_id: accountId })
      .sort({ comments_count: -1 })
      .limit(limit)
      .lean();

    res.json(
      posts.map((p) => ({
        id: p._id,
        competitorHandle: p.competitor_handle,
        caption: p.caption || "",
        postType: p.post_type,
        commentsCount: p.comments_count,
        likesCount: p.likes_count,
        postedAt: p.posted_at,
        reelUrl: p.reel_url,
      })),
    );
  } catch (err) {
    logger.error("Research top posts error:", err);
    res.status(500).json({ error: "Failed to fetch top posts" });
  }
});

// GET /api/research/competitors
router.get("/competitors", async (req, res) => {
  try {
    const accountId = req.account._id;

    const competitors = await ResearchPost.aggregate([
      { $match: { account_id: accountId } },
      {
        $group: {
          _id: "$competitor_handle",
          postsTracked: { $sum: 1 },
          avgComments: { $avg: "$comments_count" },
          lastPost: { $max: "$posted_at" },
        },
      },
      { $sort: { postsTracked: -1 } },
    ]);

    res.json(
      competitors.map((c) => ({
        id: c._id,
        handle: c._id,
        followers: 0,
        postsTracked: c.postsTracked,
        avgComments: Math.round(c.avgComments || 0),
        leadMagnetHitRate: 0,
        topKeyword: null,
        lastPost: c.lastPost,
        trackingStatus: "active",
      })),
    );
  } catch (err) {
    logger.error("Research competitors error:", err);
    res.status(500).json({ error: "Failed to fetch competitors" });
  }
});

// GET /api/research/competitors/:handle
router.get("/competitors/:handle", async (req, res) => {
  try {
    const accountId = req.account._id;
    const handle = req.params.handle;

    const [compStats] = await ResearchPost.aggregate([
      { $match: { account_id: accountId, competitor_handle: handle } },
      {
        $group: {
          _id: "$competitor_handle",
          postsTracked: { $sum: 1 },
          avgComments: { $avg: "$comments_count" },
          lastPost: { $max: "$posted_at" },
        },
      },
    ]);

    if (!compStats) {
      return res.status(404).json({ error: "Competitor not found" });
    }

    res.json({
      id: compStats._id,
      handle: compStats._id,
      followers: 0,
      postsTracked: compStats.postsTracked,
      avgComments: Math.round(compStats.avgComments || 0),
      leadMagnetHitRate: 0,
      topKeyword: null,
      lastPost: compStats.lastPost,
      trackingStatus: "active",
    });
  } catch (err) {
    logger.error("Research competitor detail error:", err);
    res.status(500).json({ error: "Failed to fetch competitor" });
  }
});

// GET /api/research/posts
router.get("/posts", async (req, res) => {
  try {
    const accountId = req.account._id;
    const {
      competitor,
      post_type,
      search,
      sort_by = "newest",
      page = 1,
      limit = 10,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));

    const filter = { account_id: accountId };
    if (competitor) filter.competitor_handle = competitor;
    if (post_type) filter.post_type = post_type;
    if (search) {
      filter.caption = { $regex: escapeRegex(search.trim()), $options: "i" };
    }

    // Per-competitor averages for virality score
    const competitorAvgs = await ResearchPost.aggregate([
      { $match: { account_id: accountId } },
      {
        $group: {
          _id: "$competitor_handle",
          avgViews: { $avg: "$plays_count" },
          avgLikes: { $avg: "$likes_count" },
          avgComments: { $avg: "$comments_count" },
        },
      },
    ]);

    const avgMap = new Map();
    for (const c of competitorAvgs) {
      avgMap.set(c._id, c);
    }

    function viralityScore(post) {
      const avg = avgMap.get(post.competitor_handle) || {};
      return (
        0.5 * ((post.plays_count || 0) / Math.max(avg.avgViews || 1, 1)) +
        0.3 * ((post.likes_count || 0) / Math.max(avg.avgLikes || 1, 1)) +
        0.2 * ((post.comments_count || 0) / Math.max(avg.avgComments || 1, 1))
      );
    }

    let posts;
    let total;

    if (sort_by === "virality") {
      const allPosts = await ResearchPost.find(filter).lean();
      total = allPosts.length;
      const scored = allPosts
        .map((p) => ({ ...p, _vs: viralityScore(p) }))
        .sort((a, b) => b._vs - a._vs);
      posts = scored.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    } else {
      let sortObj = { posted_at: -1 };
      if (sort_by === "most_comments") sortObj = { comments_count: -1 };
      if (sort_by === "most_views") sortObj = { plays_count: -1 };

      [posts, total] = await Promise.all([
        ResearchPost.find(filter)
          .sort(sortObj)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean(),
        ResearchPost.countDocuments(filter),
      ]);
    }

    res.json({
      posts: posts.map((p) => ({
        id: p._id,
        competitorId: p.competitor_handle,
        competitorHandle: p.competitor_handle,
        caption: p.caption || "",
        postType: p.post_type,
        commentsCount: p.comments_count,
        likesCount: p.likes_count,
        playsCount: p.plays_count,
        viralityScore: Math.round(viralityScore(p) * 10) / 10,
        postedAt: p.posted_at,
        reelUrl: p.reel_url,
        hookPattern: null,
        hookStyle: null,
        ctaType: null,
        ctaKeyword: null,
        topicTags: [],
        hasLeadMagnetKeyword: false,
        leadMagnetKeyword: null,
        keywordDistribution: [],
      })),
      total,
      totalPages: Math.ceil(total / limitNum),
      page: pageNum,
    });
  } catch (err) {
    logger.error("Research posts error:", err);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// GET /api/research/commenters
router.get("/commenters", async (req, res) => {
  try {
    const accountId = req.account._id;

    const commenters = await ResearchComment.aggregate([
      { $match: { account_id: accountId } },
      {
        $group: {
          _id: "$commenter_username",
          commentCount: { $sum: 1 },
          lastActivity: { $max: "$scraped_at" },
        },
      },
      { $sort: { commentCount: -1 } },
      { $limit: 200 },
    ]);

    res.json(
      commenters.map((c) => ({
        id: c._id,
        username: c._id,
        commentCount: c.commentCount,
        keywordsUsed: [],
        mostCommentedCompetitor: null,
        lastActivity: c.lastActivity,
      })),
    );
  } catch (err) {
    logger.error("Research commenters error:", err);
    res.status(500).json({ error: "Failed to fetch commenters" });
  }
});

module.exports = router;
