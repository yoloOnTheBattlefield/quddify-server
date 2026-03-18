const logger = require("../utils/logger").child({ module: "advisory-clients" });
const express = require("express");
const AdvisoryClient = require("../models/AdvisoryClient");
const AdvisorySession = require("../models/AdvisorySession");
const AdvisoryMetric = require("../models/AdvisoryMetric");
const escapeRegex = require("../utils/escapeRegex");
const validate = require("../middleware/validate");
const {
  createClientSchema,
  updateClientSchema,
} = require("../schemas/advisory-schemas");

const router = express.Router();

// GET / — paginated list, filterable by status and health, searchable by name
router.get("/", async (req, res) => {
  try {
    const { status, health, search, page, limit } = req.query;
    const filter = { account_id: req.account._id };

    if (status) filter.status = status;
    if (health) filter.health = health;
    if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [clients, total] = await Promise.all([
      AdvisoryClient.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AdvisoryClient.countDocuments(filter),
    ]);

    res.json({
      clients,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    logger.error("List advisory clients error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — single client with latest session and latest metric
router.get("/:id", async (req, res) => {
  try {
    const client = await AdvisoryClient.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();
    if (!client) return res.status(404).json({ error: "Not found" });

    const [latestSession, latestMetric] = await Promise.all([
      AdvisorySession.findOne({
        client_id: client._id,
        account_id: req.account._id,
      })
        .sort({ session_date: -1 })
        .lean(),
      AdvisoryMetric.findOne({
        client_id: client._id,
        account_id: req.account._id,
      })
        .sort({ month: -1 })
        .lean(),
    ]);

    res.json({ ...client, latest_session: latestSession, latest_metric: latestMetric });
  } catch (error) {
    logger.error("Get advisory client error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — create client
router.post("/", validate(createClientSchema), async (req, res) => {
  try {
    const client = await AdvisoryClient.create({
      ...req.body,
      account_id: req.account._id,
    });
    res.status(201).json(client);
  } catch (error) {
    logger.error("Create advisory client error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id — update any field
router.patch("/:id", validate(updateClientSchema), async (req, res) => {
  try {
    const client = await AdvisoryClient.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      req.body,
      { new: true },
    ).lean();
    if (!client) return res.status(404).json({ error: "Not found" });
    res.json(client);
  } catch (error) {
    logger.error("Update advisory client error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id — soft delete (set status to "churned")
router.delete("/:id", async (req, res) => {
  try {
    const client = await AdvisoryClient.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { status: "churned" },
      { new: true },
    ).lean();
    if (!client) return res.status(404).json({ error: "Not found" });
    res.json(client);
  } catch (error) {
    logger.error("Delete advisory client error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
