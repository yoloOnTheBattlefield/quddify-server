const logger = require("../utils/logger").child({ module: "advisory-sessions" });
const express = require("express");
const AdvisorySession = require("../models/AdvisorySession");
const escapeRegex = require("../utils/escapeRegex");
const validate = require("../middleware/validate");
const {
  createSessionSchema,
  updateSessionSchema,
} = require("../schemas/advisory-schemas");

const router = express.Router();

// GET / — paginated, filterable by client_id, sorted by session_date desc
router.get("/", async (req, res) => {
  try {
    const { client_id, page, limit } = req.query;
    const filter = { account_id: req.account._id };

    if (client_id) filter.client_id = client_id;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [sessions, total] = await Promise.all([
      AdvisorySession.find(filter)
        .sort({ session_date: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AdvisorySession.countDocuments(filter),
    ]);

    res.json({
      sessions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    logger.error("List advisory sessions error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — single session
router.get("/:id", async (req, res) => {
  try {
    const session = await AdvisorySession.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json(session);
  } catch (error) {
    logger.error("Get advisory session error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — create session with action items
router.post("/", validate(createSessionSchema), async (req, res) => {
  try {
    const session = await AdvisorySession.create({
      ...req.body,
      account_id: req.account._id,
    });
    res.status(201).json(session);
  } catch (error) {
    logger.error("Create advisory session error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id — update session or toggle action item completion
router.patch("/:id", validate(updateSessionSchema), async (req, res) => {
  try {
    const session = await AdvisorySession.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });
    if (!session) return res.status(404).json({ error: "Not found" });

    const { action_items, ...rest } = req.body;
    Object.assign(session, rest);

    if (action_items) {
      session.action_items = action_items;
    }

    await session.save();
    res.json(session.toObject());
  } catch (error) {
    logger.error("Update advisory session error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id — hard delete
router.delete("/:id", async (req, res) => {
  try {
    const session = await AdvisorySession.findOneAndDelete({
      _id: req.params.id,
      account_id: req.account._id,
    });
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json({ deleted: true });
  } catch (error) {
    logger.error("Delete advisory session error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
