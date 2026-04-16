const logger = require("../utils/logger").child({ module: "bookings" });
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const OutboundLead = require("../models/OutboundLead");
const Lead = require("../models/Lead");

/**
 * Normalize a utm_source value to a display-friendly channel name.
 */
function normalizeChannel(utmSource) {
  if (!utmSource) return null;
  const val = utmSource.trim().toLowerCase();
  const map = {
    ig: "Instagram",
    instagram: "Instagram",
    li: "LinkedIn",
    linkedin: "LinkedIn",
    yt: "YouTube",
    youtube: "YouTube",
    fb: "Facebook",
    facebook: "Facebook",
    tw: "Twitter",
    twitter: "Twitter",
    tiktok: "TikTok",
    tt: "TikTok",
    email: "Email",
  };
  return map[val] || utmSource.charAt(0).toUpperCase() + utmSource.slice(1);
}

// GET /api/bookings/stats — aggregate stats
router.get("/stats", async (req, res) => {
  try {
    const accountId = req.account._id;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [statusCounts, todayCount] = await Promise.all([
      Booking.aggregate([
        { $match: { account_id: accountId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Booking.countDocuments({
        account_id: accountId,
        booking_date: { $gte: todayStart, $lte: todayEnd },
      }),
    ]);

    const stats = { total: 0, scheduled: 0, completed: 0, no_show: 0, cancelled: 0, today_count: todayCount };
    for (const s of statusCounts) {
      stats[s._id] = s.count;
      stats.total += s.count;
    }

    res.json(stats);
  } catch (err) {
    logger.error({ err }, "Failed to fetch booking stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/bookings/analytics — close rate, show-up rate, avg cash, over time, source distribution
router.get("/analytics", async (req, res) => {
  try {
    const accountId = req.account._id;
    const { start_date, end_date } = req.query;

    const filter = { account_id: accountId };
    if (start_date || end_date) {
      filter.booking_date = {};
      if (start_date) filter.booking_date.$gte = new Date(`${start_date}T00:00:00.000Z`);
      if (end_date) filter.booking_date.$lte = new Date(`${end_date}T23:59:59.999Z`);
    }

    const bookings = await Booking.find(filter).lean();

    const totalNonCancelled = bookings.filter((b) => b.status !== "cancelled").length;
    const completed = bookings.filter((b) => b.status === "completed").length;
    const noShow = bookings.filter((b) => b.status === "no_show").length;
    const showUpDenominator = completed + noShow;

    const cashValues = bookings.filter((b) => b.cash_collected > 0).map((b) => b.cash_collected);
    const avgCashCollected = cashValues.length > 0 ? Math.round((cashValues.reduce((s, v) => s + v, 0) / cashValues.length) * 100) / 100 : 0;

    // Bookings over time (group by date)
    const dailyMap = {};
    for (const b of bookings) {
      const dateStr = b.booking_date.toISOString().slice(0, 10);
      dailyMap[dateStr] = (dailyMap[dateStr] || 0) + 1;
    }
    const over_time = Object.entries(dailyMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Source distribution
    const sourceMap = {};
    for (const b of bookings) {
      const src = b.source || "outbound";
      sourceMap[src] = (sourceMap[src] || 0) + 1;
    }
    const source_distribution = Object.entries(sourceMap).map(([source, count]) => ({ source, count }));

    // Channel breakdown (by utm_source → normalized channel name)
    const channelMap = {};
    for (const b of bookings) {
      const channel = normalizeChannel(b.utm_source) || (b.source === "inbound" ? "Direct" : "Outbound DM");
      if (!channelMap[channel]) channelMap[channel] = [];
      channelMap[channel].push(b);
    }
    const by_channel = Object.entries(channelMap)
      .map(([channel, group]) => {
        const nonCancelled = group.filter((b) => b.status !== "cancelled");
        const comp = group.filter((b) => b.status === "completed");
        const ns = group.filter((b) => b.status === "no_show");
        const showDenom = comp.length + ns.length;
        const rev = group.reduce((s, b) => s + (b.cash_collected || 0), 0);
        return {
          channel,
          bookings: group.length,
          completed: comp.length,
          no_show: ns.length,
          show_rate: showDenom > 0 ? Math.round((comp.length / showDenom) * 10000) / 100 : 0,
          close_rate: nonCancelled.length > 0 ? Math.round((comp.length / nonCancelled.length) * 10000) / 100 : 0,
          revenue: Math.round(rev * 100) / 100,
        };
      })
      .sort((a, b) => b.bookings - a.bookings);

    res.json({
      total: bookings.length,
      close_rate: totalNonCancelled > 0 ? Math.round((completed / totalNonCancelled) * 10000) / 100 : 0,
      show_up_rate: showUpDenominator > 0 ? Math.round((completed / showUpDenominator) * 10000) / 100 : 0,
      avg_cash_collected: avgCashCollected,
      over_time,
      source_distribution,
      by_channel,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch booking analytics");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/bookings — paginated list with filters
router.get("/", async (req, res) => {
  try {
    const accountId = req.account._id;
    const { status, start_date, end_date, source, search, sort, today, page, limit } = req.query;

    const matchFilter = { account_id: accountId };

    if (status && status !== "all") matchFilter.status = status;
    if (source) matchFilter.source = source;

    if (today === "true") {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      matchFilter.booking_date = { $gte: todayStart, $lte: todayEnd };
    } else if (start_date || end_date) {
      matchFilter.booking_date = {};
      if (start_date) matchFilter.booking_date.$gte = new Date(`${start_date}T00:00:00.000Z`);
      if (end_date) matchFilter.booking_date.$lte = new Date(`${end_date}T23:59:59.999Z`);
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    let sortObj = { createdAt: -1 };
    if (sort === "booking_date") sortObj = { booking_date: -1 };

    const pipeline = [
      { $match: matchFilter },
      { $sort: sortObj },
      {
        $lookup: {
          from: "outbound_leads",
          localField: "outbound_lead_id",
          foreignField: "_id",
          as: "outbound_lead",
        },
      },
      { $unwind: { path: "$outbound_lead", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "leads",
          localField: "lead_id",
          foreignField: "_id",
          as: "lead",
        },
      },
      { $unwind: { path: "$lead", preserveNullAndEmptyArrays: true } },
    ];

    if (search && search.trim()) {
      const regex = { $regex: search.trim(), $options: "i" };
      pipeline.push({
        $match: {
          $or: [
            { contact_name: regex },
            { ig_username: regex },
            { email: regex },
            { "outbound_lead.username": regex },
            { "outbound_lead.fullName": regex },
            { "lead.full_name": regex },
          ],
        },
      });
    }

    pipeline.push({
      $facet: {
        data: [{ $skip: skip }, { $limit: limitNum }],
        totalCount: [{ $count: "count" }],
      },
    });

    const [result] = await Booking.aggregate(pipeline);
    const bookings = result.data;
    const total = result.totalCount[0]?.count || 0;

    res.json({
      bookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to list bookings");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/bookings/:id — single booking with populated lead data
router.get("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;

    const [booking] = await Booking.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(req.params.id), account_id: accountId } },
      {
        $lookup: {
          from: "outbound_leads",
          localField: "outbound_lead_id",
          foreignField: "_id",
          as: "outbound_lead",
        },
      },
      { $unwind: { path: "$outbound_lead", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "leads",
          localField: "lead_id",
          foreignField: "_id",
          as: "lead",
        },
      },
      { $unwind: { path: "$lead", preserveNullAndEmptyArrays: true } },
    ]);

    if (!booking) return res.status(404).json({ error: "Booking not found" });

    res.json(booking);
  } catch (err) {
    logger.error({ err }, "Failed to fetch booking");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/bookings — create booking
router.post("/", async (req, res) => {
  try {
    const accountId = req.account._id;
    const {
      lead_id, outbound_lead_id, source, contact_name, ig_username,
      email, booking_date, status, cash_collected, contract_value, notes, score,
      utm_source, utm_medium,
    } = req.body;

    if (!booking_date) {
      return res.status(400).json({ error: "booking_date is required" });
    }

    const booking = await Booking.create({
      account_id: accountId,
      lead_id: lead_id ? new mongoose.Types.ObjectId(lead_id) : null,
      outbound_lead_id: outbound_lead_id ? new mongoose.Types.ObjectId(outbound_lead_id) : null,
      source: source || "outbound",
      contact_name: contact_name || "",
      ig_username: ig_username || null,
      email: email || null,
      booking_date: new Date(booking_date),
      status: status || "scheduled",
      cash_collected: cash_collected ?? null,
      contract_value: contract_value ?? null,
      notes: notes || "",
      score: score ?? null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
    });

    // Backfill outbound_lead_id onto the Lead so conversation lookup works
    if (booking.lead_id && booking.outbound_lead_id) {
      await Lead.findByIdAndUpdate(booking.lead_id, { $set: { outbound_lead_id: booking.outbound_lead_id } });
    }

    logger.info({ bookingId: booking._id }, "Booking created");
    res.status(201).json(booking);
  } catch (err) {
    logger.error({ err }, "Failed to create booking");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/bookings/:id — update booking
router.patch("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;
    const updates = { ...req.body };

    // Auto-set timestamps on status changes
    if (updates.status === "completed" && !updates.completed_at) {
      updates.completed_at = new Date();
    }
    if (updates.status === "cancelled" && !updates.cancelled_at) {
      updates.cancelled_at = new Date();
    }

    // Convert date strings
    if (updates.booking_date) updates.booking_date = new Date(updates.booking_date);

    const booking = await Booking.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(req.params.id), account_id: accountId },
      { $set: updates },
      { new: true },
    );

    if (!booking) return res.status(404).json({ error: "Booking not found" });

    logger.info({ bookingId: req.params.id }, "Booking updated");
    res.json(booking);
  } catch (err) {
    logger.error({ err }, "Failed to update booking");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/bookings/:id — delete booking
router.delete("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;
    const booking = await Booking.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(req.params.id),
      account_id: accountId,
    });

    if (!booking) return res.status(404).json({ error: "Booking not found" });

    logger.info({ bookingId: req.params.id }, "Booking deleted");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete booking");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/bookings/import — bulk import bookings from CSV/XLSX (parsed client-side)
router.post("/import", async (req, res) => {
  try {
    const accountId = req.account._id;
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const results = { imported: 0, skipped: 0, errors: [] };

    const docs = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 for 1-indexed + header row

      // booking_date is required
      if (!row.booking_date) {
        results.errors.push({ row: rowNum, reason: "Missing booking date" });
        results.skipped++;
        continue;
      }

      const bookingDate = new Date(row.booking_date);
      if (isNaN(bookingDate.getTime())) {
        results.errors.push({ row: rowNum, reason: `Invalid date: ${row.booking_date}` });
        results.skipped++;
        continue;
      }

      // Derive status from Calendly fields:
      // - "canceled" column (Yes/No) → cancelled
      // - "no_show" column (Yes/No) → no_show
      // - "status" column (Active/Canceled/etc.) as fallback
      // - past bookings without cancellation/no-show → completed
      let status = "scheduled";
      const isCanceled = row.canceled && String(row.canceled).toLowerCase().trim() === "yes";
      const isNoShow = row.no_show && String(row.no_show).toLowerCase().trim() === "yes";

      if (isCanceled) {
        status = "cancelled";
      } else if (isNoShow) {
        status = "no_show";
      } else if (row.status) {
        const s = String(row.status).toLowerCase().trim();
        if (s === "active" || s === "scheduled") status = "scheduled";
        else if (s === "completed") status = "completed";
        else if (s === "canceled" || s === "cancelled") status = "cancelled";
        else if (s === "no_show" || s === "no-show" || s === "no show") status = "no_show";
      } else if (bookingDate < new Date()) {
        status = "completed";
      }

      // Build notes from event_type + notes
      const notesParts = [row.event_type, row.notes].filter(Boolean);

      docs.push({
        account_id: accountId,
        contact_name: row.contact_name || row.invitee_name || "",
        email: row.email || null,
        booking_date: bookingDate,
        status,
        source: row.source || "inbound",
        notes: notesParts.join(" — ") || "",
        cash_collected: row.cash_collected ? Number(row.cash_collected) : null,
        contract_value: row.contract_value ? Number(row.contract_value) : null,
        utm_source: row.utm_source || null,
        utm_medium: row.utm_medium || null,
        ig_username: row.ig_username || null,
      });
    }

    if (docs.length > 0) {
      await Booking.insertMany(docs, { ordered: false });
      results.imported = docs.length;
    }

    logger.info({ imported: results.imported, skipped: results.skipped }, "Bookings imported");
    res.json(results);
  } catch (err) {
    logger.error({ err }, "Failed to import bookings");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/bookings/sync — create booking records for leads that don't have one yet
router.post("/sync", async (req, res) => {
  try {
    const accountId = req.account._id;

    // Find all outbound leads with booked=true that don't have a Booking yet
    const bookedOutbound = await OutboundLead.find({
      account_id: accountId,
      booked: true,
    }).lean();

    // Find existing booking outbound_lead_ids
    const existingOutbound = await Booking.find(
      { account_id: accountId, outbound_lead_id: { $ne: null } },
      { outbound_lead_id: 1 },
    ).lean();
    const existingOutboundSet = new Set(existingOutbound.map((b) => b.outbound_lead_id.toString()));

    const newOutboundBookings = bookedOutbound
      .filter((lead) => !existingOutboundSet.has(lead._id.toString()))
      .map((lead) => ({
        account_id: accountId,
        outbound_lead_id: lead._id,
        source: "outbound",
        contact_name: lead.fullName || lead.username || "",
        ig_username: lead.username || null,
        email: lead.email || null,
        booking_date: lead.booked_at || lead.updatedAt || new Date(),
        status: "scheduled",
        contract_value: lead.contract_value || null,
        utm_source: "ig",
      }));

    // Find all inbound leads with booked_at that don't have a Booking yet
    const bookedInbound = await Lead.find({
      account_id: accountId,
      booked_at: { $ne: null },
    }).lean();

    const existingInbound = await Booking.find(
      { account_id: accountId, lead_id: { $ne: null } },
      { lead_id: 1 },
    ).lean();
    const existingInboundSet = new Set(existingInbound.map((b) => b.lead_id.toString()));

    // Collect outbound_lead_ids that are linked to inbound leads with bookings,
    // so we don't create duplicate outbound bookings for the same person
    const linkedOutboundIds = new Set(
      bookedInbound
        .filter((lead) => lead.outbound_lead_id)
        .map((lead) => lead.outbound_lead_id.toString()),
    );

    // Filter out outbound bookings where the outbound lead is already linked to an inbound lead
    const dedupedOutboundBookings = newOutboundBookings.filter(
      (b) => !linkedOutboundIds.has(b.outbound_lead_id.toString()),
    );

    const newInboundBookings = bookedInbound
      .filter((lead) => !existingInboundSet.has(lead._id.toString()))
      .map((lead) => ({
        account_id: accountId,
        lead_id: lead._id,
        outbound_lead_id: lead.outbound_lead_id || null,
        source: "inbound",
        contact_name: lead.full_name || "",
        email: lead.email || null,
        booking_date: lead.booked_at || lead.updatedAt || new Date(),
        status: "scheduled",
        utm_source: lead.utm_source || null,
        utm_medium: lead.utm_medium || null,
      }));

    const allNew = [...dedupedOutboundBookings, ...newInboundBookings];

    if (allNew.length > 0) {
      await Booking.insertMany(allNew, { ordered: false });
    }

    logger.info({ synced: allNew.length }, "Bookings synced");
    res.json({ synced: allNew.length });
  } catch (err) {
    logger.error({ err }, "Failed to sync bookings");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
