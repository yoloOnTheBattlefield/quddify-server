const logger = require("../utils/logger").child({ module: "lead-notes" });
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const LeadNote = require("../models/LeadNote");

// GET /api/lead-notes?lead_id=xxx or ?outbound_lead_id=xxx — list notes for a lead
router.get("/", async (req, res) => {
  try {
    const { lead_id, outbound_lead_id } = req.query;
    if (!lead_id && !outbound_lead_id) {
      return res.status(400).json({ error: "lead_id or outbound_lead_id is required" });
    }

    const accountId = req.account._id;
    const filter = { account_id: accountId };

    if (outbound_lead_id) {
      filter.outbound_lead_id = new mongoose.Types.ObjectId(outbound_lead_id);
    } else {
      filter.lead_id = new mongoose.Types.ObjectId(lead_id);
    }

    const notes = await LeadNote.find(filter).sort({ createdAt: -1 });

    res.json(notes);
  } catch (err) {
    logger.error({ err }, "Failed to list lead notes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/lead-notes — create a note
router.post("/", async (req, res) => {
  try {
    const { lead_id, outbound_lead_id, content } = req.body;
    if (!lead_id && !outbound_lead_id) {
      return res.status(400).json({ error: "lead_id or outbound_lead_id is required" });
    }
    if (!content?.trim()) {
      return res.status(400).json({ error: "content is required" });
    }

    const accountId = req.account._id;
    const noteData = {
      account_id: accountId,
      author_id: req.user._id || req.user.id,
      author_name: `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || req.user.email,
      content: content.trim(),
    };

    if (outbound_lead_id) {
      noteData.outbound_lead_id = new mongoose.Types.ObjectId(outbound_lead_id);
    }
    if (lead_id) {
      noteData.lead_id = new mongoose.Types.ObjectId(lead_id);
    }

    const note = await LeadNote.create(noteData);

    logger.info({ noteId: note._id, leadId: lead_id, outboundLeadId: outbound_lead_id }, "Note created");
    res.status(201).json(note);
  } catch (err) {
    logger.error({ err }, "Failed to create lead note");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/lead-notes/:id — delete a note
router.delete("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;
    const note = await LeadNote.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(req.params.id),
      account_id: accountId,
    });

    if (!note) return res.status(404).json({ error: "Note not found" });

    logger.info({ noteId: req.params.id }, "Note deleted");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete lead note");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
