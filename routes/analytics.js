const logger = require("../utils/logger").child({ module: "analytics" });
const express = require("express");
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Account = require("../models/Account");
const Booking = require("../models/Booking");

const router = express.Router();

// Cache analytics responses for 2 minutes (browser + shared caches)
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "private, max-age=120");
  next();
});

// Helper: Calculate median of an array
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Helper: Calculate average of an array
function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

// Helper: Round to 2 decimal places
function round2(num) {
  return Math.round(num * 100) / 100;
}

// Helper: Get date string (YYYY-MM-DD) from ISO timestamp or Date object
function toDateString(dateValue) {
  if (!dateValue) return null;
  if (dateValue instanceof Date) {
    return dateValue.toISOString().slice(0, 10);
  }
  if (typeof dateValue === "string") {
    return dateValue.slice(0, 10);
  }
  return null;
}

// Helper: Calculate hours between two ISO timestamps
function hoursBetween(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return (endDate - startDate) / (1000 * 60 * 60);
}

// Helper: Calculate days between two ISO timestamps
function daysBetween(start, end) {
  return hoursBetween(start, end) / 24;
}

// Helper: Generate array of dates between start and end
function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Helper: an admin-supplied account_id must be an Account ObjectId, the form
// Lead.account_id was migrated to on 2026-04-02. Returns null otherwise.
async function resolveAdminAccountId(rawValue) {
  if (!rawValue) return null;
  if (mongoose.isValidObjectId(rawValue) && String(new mongoose.Types.ObjectId(rawValue)) === rawValue) {
    return rawValue;
  }
  return null;
}

// Helper: Get Monday of the week for a given date string
function getMonday(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

// Helper: Determine grouping based on range span
// Minimum valid date — anything before this is treated as corrupt data
const MIN_VALID_DATE = "2020-01-01";

function getRadarGrouping(rangeStart, rangeEnd) {
  const days = daysBetween(rangeStart, rangeEnd);
  if (days <= 14) return "day";
  if (days <= 90) return "week";
  return "month";
}

// Helper: Get bucket key for a date based on grouping
function getRadarBucketKey(dateStr, grouping) {
  if (grouping === "day") return dateStr.slice(0, 10);
  if (grouping === "week") return getMonday(dateStr);
  return dateStr.slice(0, 7);
}

// Helper: Generate all bucket keys for a range
function getRadarBucketRange(startDate, endDate, grouping) {
  if (grouping === "day") return getDateRange(startDate, endDate);

  if (grouping === "week") {
    const weeks = [];
    const current = new Date(getMonday(startDate) + "T00:00:00Z");
    const end = new Date(endDate + "T00:00:00Z");
    while (current <= end) {
      weeks.push(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 7);
    }
    return weeks;
  }

  // month
  const months = [];
  const current = new Date(startDate + "T00:00:00Z");
  current.setUTCDate(1);
  const end = new Date(endDate + "T00:00:00Z");
  while (current <= end) {
    months.push(current.toISOString().slice(0, 7));
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return months;
}

// GET /analytics
router.get("/", async (req, res) => {
  try {
    const { start_date, end_date, account_id } = req.query;

    // Admins (role 0): no account_id = all accounts; with account_id = that account
    // Non-admins: always filter by their own account
    const isAdmin = req.user?.role === 0;
    const filter = {};
    if (isAdmin && account_id) {
      const resolved = await resolveAdminAccountId(account_id);
      // If we couldn't resolve, fall back to the raw value (matches nothing
      // for legacy data, which is the previous behavior — at least obvious).
      filter.account_id = resolved || account_id;
    } else if (!isAdmin) {
      filter.account_id = req.account._id.toString();
    }
    if (start_date || end_date) {
      filter.date_created = {};
      if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
      if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
    }

    if (req.query.exclude_linked === "true") {
      filter.outbound_lead_id = null;
    }

    const leads = await Lead.find(filter).lean();

    // Determine date range for daily metrics
    let rangeStart = start_date;
    let rangeEnd = end_date;
    if (!rangeStart || !rangeEnd) {
      const inboundDates = leads.map((l) => toDateString(l.date_created)).filter(Boolean);
      const allDates = inboundDates.filter((d) => d >= MIN_VALID_DATE);
      if (allDates.length > 0) {
        allDates.sort();
        rangeStart = rangeStart || allDates[0];
        rangeEnd = rangeEnd || allDates[allDates.length - 1];
      } else {
        const today = new Date().toISOString().slice(0, 10);
        rangeStart = rangeStart || today;
        rangeEnd = rangeEnd || today;
      }
    }

    // 1. FUNNEL METRICS
    const totalContacts = leads.length;
    // Inbound "messaged" — the setter sent the first message (LinkedIn flow).
    const messagedCount = leads.filter((l) => l.messaged_at).length;
    const messagedRate =
      totalContacts > 0 ? round2((messagedCount / totalContacts) * 100) : 0;
    const repliedCount = leads.filter((l) => l.replied_at).length;
    const repliedRate =
      messagedCount > 0 ? round2((repliedCount / messagedCount) * 100) : 0;
    const linkSentCount = leads.filter((l) => l.link_sent_at).length;
    const linkSentRate =
      totalContacts > 0 ? round2((linkSentCount / totalContacts) * 100) : 0;
    const linkClickedCount = leads.filter((l) => l.link_clicked_at).length;
    const linkClickedRate =
      linkSentCount > 0 ? round2((linkClickedCount / linkSentCount) * 100) : 0;
    const bookedCount = leads.filter((l) => l.booked_at).length;
    const bookingRate =
      linkSentCount > 0 ? round2((bookedCount / linkSentCount) * 100) : 0;
    const ghostedCount = leads.filter(
      (l) => l.ghosted_at && !l.booked_at,
    ).length;
    const ghostRate =
      totalContacts > 0 ? round2((ghostedCount / totalContacts) * 100) : 0;
    const fupCount = leads.filter((l) => l.follow_up_at).length;
    const fupToBookedCount = leads.filter(
      (l) => l.follow_up_at && l.booked_at,
    ).length;
    const recoveryRate =
      fupCount > 0 ? round2((fupToBookedCount / fupCount) * 100) : 0;


    const funnel = {
      totalContacts,
      messagedCount,
      messagedRate,
      repliedCount,
      repliedRate,
      linkSentCount,
      linkSentRate,
      linkClickedCount,
      linkClickedRate,
      bookedCount,
      bookingRate,
      ghostedCount,
      ghostRate,
      fupCount,
      fupToBookedCount,
      recoveryRate,
    };

    // 2. VELOCITY METRICS
    const createdToLinkSentHours = leads
      .filter((l) => l.link_sent_at && l.date_created)
      .map((l) => hoursBetween(l.date_created, l.link_sent_at));

    const linkSentToBookedHours = leads
      .filter((l) => l.link_sent_at && l.booked_at)
      .map((l) => hoursBetween(l.link_sent_at, l.booked_at));

    const createdToGhostedHours = leads
      .filter((l) => l.ghosted_at && !l.booked_at && l.date_created)
      .map((l) => hoursBetween(l.date_created, l.ghosted_at));

    const velocity = {
      createdToLinkSent: {
        median: round2(median(createdToLinkSentHours)),
        average: round2(average(createdToLinkSentHours)),
      },
      linkSentToBooked: {
        median: round2(median(linkSentToBookedHours)),
        average: round2(average(linkSentToBookedHours)),
      },
      createdToGhosted: {
        median: round2(median(createdToGhostedHours)),
        average: round2(average(createdToGhostedHours)),
      },
    };

    // 3. DAILY VOLUME
    const dateRange = getDateRange(rangeStart, rangeEnd);
    const dailyVolumeMap = {};
    dateRange.forEach((date) => {
      dailyVolumeMap[date] = {
        created: 0,
        link_sent: 0,
        booked: 0,
        ghosted: 0,
      };
    });

    leads.forEach((lead) => {
      const createdDate = toDateString(lead.date_created);
      if (createdDate && dailyVolumeMap[createdDate]) {
        dailyVolumeMap[createdDate].created++;
      }

      const linkSentDate = toDateString(lead.link_sent_at);
      if (linkSentDate && dailyVolumeMap[linkSentDate]) {
        dailyVolumeMap[linkSentDate].link_sent++;
      }

      const bookedDate = toDateString(lead.booked_at);
      if (bookedDate && dailyVolumeMap[bookedDate]) {
        dailyVolumeMap[bookedDate].booked++;
      }

      // Only count as ghosted if not booked
      if (lead.ghosted_at && !lead.booked_at) {
        const ghostedDate = toDateString(lead.ghosted_at);
        if (ghostedDate && dailyVolumeMap[ghostedDate]) {
          dailyVolumeMap[ghostedDate].ghosted++;
        }
      }
    });

    const dailyVolume = dateRange.map((date) => ({
      date,
      ...dailyVolumeMap[date],
    }));

    // 4. GHOSTING BUCKETS
    const ghostedLeads = leads.filter((l) => l.ghosted_at && !l.booked_at);
    const ghostingBuckets = {
      "Same day": 0,
      "1 day": 0,
      "2-3 days": 0,
      "4+ days": 0,
    };

    ghostedLeads.forEach((lead) => {
      const days = daysBetween(lead.date_created, lead.ghosted_at);
      if (days < 1) {
        ghostingBuckets["Same day"]++;
      } else if (days < 2) {
        ghostingBuckets["1 day"]++;
      } else if (days < 4) {
        ghostingBuckets["2-3 days"]++;
      } else {
        ghostingBuckets["4+ days"]++;
      }
    });

    const totalGhosted = ghostedLeads.length;
    const ghosting = Object.entries(ghostingBuckets).map(([bucket, count]) => ({
      bucket,
      count,
      percentage: totalGhosted > 0 ? round2((count / totalGhosted) * 100) : 0,
    }));

    // 5. FOLLOW-UP EFFECTIVENESS
    const totalFup = leads.filter((l) => l.follow_up_at).length;
    const convertedToBooked = leads.filter(
      (l) => l.follow_up_at && l.booked_at,
    ).length;
    const conversionRate =
      totalFup > 0 ? round2((convertedToBooked / totalFup) * 100) : 0;
    const remainingInactive = totalFup - convertedToBooked;
    const inactiveRate =
      totalFup > 0 ? round2((remainingInactive / totalFup) * 100) : 0;

    const fup = {
      totalFup,
      convertedToBooked,
      conversionRate,
      remainingInactive,
      inactiveRate,
    };

    // 6. STAGE AGING
    const now = new Date();
    const nowISO = now.toISOString();

    // New (No Action) - no link_sent_at and no ghosted_at, idle > 1 day
    const newNoAction = leads
      .filter((l) => !l.link_sent_at && !l.ghosted_at && l.date_created)
      .map((l) => ({
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown",
        daysSinceAction: Math.floor(daysBetween(l.date_created, nowISO)),
      }))
      .filter((c) => c.daysSinceAction > 1)
      .sort((a, b) => b.daysSinceAction - a.daysSinceAction)
      .slice(0, 10);

    // Link Sent (Pending) - has link_sent_at but no booked_at and no ghosted_at
    const linkSentPending = leads
      .filter((l) => l.link_sent_at && !l.booked_at && !l.ghosted_at)
      .map((l) => ({
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown",
        daysSinceAction: Math.floor(daysBetween(l.link_sent_at, nowISO)),
      }))
      .filter((c) => c.daysSinceAction > 1)
      .sort((a, b) => b.daysSinceAction - a.daysSinceAction)
      .slice(0, 10);

    // In Follow-up - has follow_up_at but no booked_at
    const inFollowUp = leads
      .filter((l) => l.follow_up_at && !l.booked_at)
      .map((l) => ({
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown",
        daysSinceAction: Math.floor(daysBetween(l.follow_up_at, nowISO)),
      }))
      .filter((c) => c.daysSinceAction > 1)
      .sort((a, b) => b.daysSinceAction - a.daysSinceAction)
      .slice(0, 10);

    const aging = [
      {
        stage: "New (No Action)",
        contacts: newNoAction,
        count: newNoAction.length,
      },
      {
        stage: "Link Sent (Pending)",
        contacts: linkSentPending,
        count: linkSentPending.length,
      },
      {
        stage: "In Follow-up",
        contacts: inFollowUp,
        count: inFollowUp.length,
      },
    ];

    // 7. CUMULATIVE BOOKINGS
    const bookingsByDate = {};
    dateRange.forEach((date) => {
      bookingsByDate[date] = 0;
    });

    leads.forEach((lead) => {
      if (lead.booked_at) {
        const bookedDate = toDateString(lead.booked_at);
        if (bookedDate && bookingsByDate[bookedDate] !== undefined) {
          bookingsByDate[bookedDate]++;
        }
      }
    });

    let runningTotal = 0;
    const cumulative = dateRange.map((date) => {
      runningTotal += bookingsByDate[date];
      return { date, cumulative: runningTotal };
    });

    // 8. RADAR — leads & link_sent grouped dynamically (day/week/month)
    // For large ranges (> 12 months), cap to last 12 months so radar stays readable
    let radarStart = rangeStart < MIN_VALID_DATE ? MIN_VALID_DATE : rangeStart;
    const radarEnd = rangeEnd;
    const radarDays = daysBetween(radarStart, radarEnd);
    if (radarDays > 365) {
      const twelveMonthsAgo = new Date(radarEnd + "T00:00:00Z");
      twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);
      twelveMonthsAgo.setUTCDate(1);
      radarStart = twelveMonthsAgo.toISOString().slice(0, 10);
    }

    const grouping = getRadarGrouping(radarStart, radarEnd);
    const radarBuckets = getRadarBucketRange(radarStart, radarEnd, grouping);

    // Initialize all buckets with zeros
    const radarMap = {};
    for (const key of radarBuckets) {
      radarMap[key] = { leads: 0, link_sent: 0, booked: 0, ghosted: 0, follow_up: 0 };
    }

    for (const lead of leads) {
      const created = lead.date_created;
      if (!created) continue;
      const dateStr = String(created).slice(0, 10);
      if (dateStr < radarStart || dateStr > radarEnd) continue;
      const key = getRadarBucketKey(dateStr, grouping);
      if (!radarMap[key]) radarMap[key] = { leads: 0, link_sent: 0, booked: 0, ghosted: 0, follow_up: 0 };
      radarMap[key].leads++;
      if (lead.link_sent_at) radarMap[key].link_sent++;
      if (lead.booked_at) radarMap[key].booked++;
      if (lead.ghosted_at) radarMap[key].ghosted++;
      if (lead.follow_up_at) radarMap[key].follow_up++;
    }

    const radar = Object.entries(radarMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, counts]) => ({
        month,
        leads: counts.leads,
        link_sent: counts.link_sent,
        booked: counts.booked,
        ghosted: counts.ghosted,
        follow_up: counts.follow_up,
      }));

    // 8. SALES METRICS (from Booking model)
    const bookingFilter = {};
    if (isAdmin && account_id) {
      const resolved = await resolveAdminAccountId(account_id);
      if (resolved) bookingFilter.account_id = new mongoose.Types.ObjectId(resolved);
    } else if (!isAdmin) {
      bookingFilter.account_id = req.account._id;
    }
    if (start_date || end_date) {
      bookingFilter.booking_date = {};
      if (start_date) bookingFilter.booking_date.$gte = new Date(`${start_date}T00:00:00.000Z`);
      if (end_date) bookingFilter.booking_date.$lte = new Date(`${end_date}T23:59:59.999Z`);
    }

    const bookings = await Booking.find(bookingFilter).lean();

    const totalBookings = bookings.length;
    const nonCancelled = bookings.filter((b) => b.status !== "cancelled");
    const completedBookings = bookings.filter((b) => b.status === "completed");
    const noShowBookings = bookings.filter((b) => b.status === "no_show");
    const showUpDenom = completedBookings.length + noShowBookings.length;

    const overallCloseRate = nonCancelled.length > 0 ? round2((completedBookings.length / nonCancelled.length) * 100) : 0;
    const overallShowUpRate = showUpDenom > 0 ? round2((completedBookings.length / showUpDenom) * 100) : 0;

    const cashValues = bookings.filter((b) => b.cash_collected > 0);
    const totalRevenue = cashValues.reduce((s, b) => s + b.cash_collected, 0);
    const avgDealValue = cashValues.length > 0 ? round2(totalRevenue / cashValues.length) : 0;

    // Group by utm_source (derive for legacy bookings without utm_source)
    const sourceGroups = {};
    for (const b of bookings) {
      const src = b.utm_source || (b.source === "outbound" ? "ig" : "direct");
      if (!sourceGroups[src]) sourceGroups[src] = [];
      sourceGroups[src].push(b);
    }

    const bySource = Object.entries(sourceGroups).map(([source, group]) => {
      const nc = group.filter((b) => b.status !== "cancelled");
      const comp = group.filter((b) => b.status === "completed");
      const ns = group.filter((b) => b.status === "no_show");
      const sud = comp.length + ns.length;
      const rev = group.filter((b) => b.cash_collected > 0).reduce((s, b) => s + b.cash_collected, 0);
      return {
        source,
        bookings: group.length,
        completed: comp.length,
        close_rate: nc.length > 0 ? round2((comp.length / nc.length) * 100) : 0,
        show_up_rate: sud > 0 ? round2((comp.length / sud) * 100) : 0,
        revenue: rev,
      };
    }).sort((a, b) => b.bookings - a.bookings);

    // Group by utm_medium (top 10 by booking count)
    const mediumGroups = {};
    for (const b of bookings) {
      const med = b.utm_medium || "unknown";
      if (med === "unknown") continue;
      if (!mediumGroups[med]) mediumGroups[med] = { source: b.utm_source || (b.source === "outbound" ? "ig" : "direct"), items: [] };
      mediumGroups[med].items.push(b);
    }

    const byMedium = Object.entries(mediumGroups)
      .map(([medium, { source, items }]) => {
        const nc = items.filter((b) => b.status !== "cancelled");
        const comp = items.filter((b) => b.status === "completed");
        const rev = items.filter((b) => b.cash_collected > 0).reduce((s, b) => s + b.cash_collected, 0);
        return {
          medium,
          source,
          bookings: items.length,
          completed: comp.length,
          close_rate: nc.length > 0 ? round2((comp.length / nc.length) * 100) : 0,
          revenue: rev,
        };
      })
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 10);

    const sales = {
      total_bookings: totalBookings,
      overall_close_rate: overallCloseRate,
      overall_show_up_rate: overallShowUpRate,
      total_revenue: totalRevenue,
      avg_deal_value: avgDealValue,
      by_source: bySource,
      by_medium: byMedium,
    };

    // Return all metrics
    res.json({
      funnel,
      velocity,
      dailyVolume,
      ghosting,
      fup,
      aging,
      cumulative,
      radar,
      sales,
    });
  } catch (error) {
    logger.error("Analytics error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to calculate analytics",
    });
  }
});

async function buildInboundFilter(req) {
  const { start_date, end_date } = req.query;
  const isAdmin = req.user?.role === 0;
  const filter = {};
  if (isAdmin && req.query.account_id) {
    const resolved = await resolveAdminAccountId(req.query.account_id);
    filter.account_id = resolved || req.query.account_id;
  } else if (!isAdmin) {
    filter.account_id = req.account._id.toString();
  }
  if (start_date || end_date) {
    filter.date_created = {};
    if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
    if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
  }
  if (req.query.exclude_linked === "true") {
    filter.outbound_lead_id = null;
  }
  return filter;
}

// GET /analytics/inbound — overview KPIs + source breakdown
router.get("/inbound", async (req, res) => {
  try {
    const filter = await buildInboundFilter(req);
    const leads = await Lead.find(filter).lean();

    const total = leads.length;
    const booked = leads.filter((l) => l.booked_at).length;
    const closed = leads.filter((l) => l.closed_at).length;
    const revenue = leads.reduce((sum, l) => sum + (l.contract_value || 0), 0);
    const crossChannel = leads.filter((l) => l.outbound_lead_id).length;

    const sourceMap = {};
    for (const lead of leads) {
      const src = lead.source || "unknown";
      if (!sourceMap[src]) sourceMap[src] = { source: src, total: 0, booked: 0, closed: 0, revenue: 0 };
      sourceMap[src].total++;
      if (lead.booked_at) sourceMap[src].booked++;
      if (lead.closed_at) sourceMap[src].closed++;
      sourceMap[src].revenue += lead.contract_value || 0;
    }
    const sources = Object.values(sourceMap).sort((a, b) => b.total - a.total);

    res.json({
      total,
      booked,
      closed,
      book_rate: total > 0 ? round2((booked / total) * 100) : 0,
      close_rate: booked > 0 ? round2((closed / booked) * 100) : 0,
      revenue,
      cross_channel: crossChannel,
      cross_channel_rate: total > 0 ? round2((crossChannel / total) * 100) : 0,
      sources,
    });
  } catch (err) {
    logger.error("Inbound analytics error:", err);
    res.status(500).json({ error: "Failed to fetch inbound analytics" });
  }
});

// GET /analytics/inbound/posts — post performance table
router.get("/inbound/posts", async (req, res) => {
  try {
    const filter = await buildInboundFilter(req);
    const leads = await Lead.find(filter).lean();

    const postMap = {};
    for (const lead of leads) {
      const url = lead.post_url || "unknown";
      if (!postMap[url]) postMap[url] = { post_url: url, total: 0, booked: 0, closed: 0, revenue: 0 };
      postMap[url].total++;
      if (lead.booked_at) postMap[url].booked++;
      if (lead.closed_at) postMap[url].closed++;
      postMap[url].revenue += lead.contract_value || 0;
    }

    const posts = Object.values(postMap)
      .map((p) => ({
        ...p,
        book_rate: p.total > 0 ? round2((p.booked / p.total) * 100) : 0,
        close_rate: p.booked > 0 ? round2((p.closed / p.booked) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    res.json({ posts });
  } catch (err) {
    logger.error("Inbound posts analytics error:", err);
    res.status(500).json({ error: "Failed to fetch inbound posts analytics" });
  }
});

// GET /analytics/inbound/daily — daily volume
router.get("/inbound/daily", async (req, res) => {
  try {
    const filter = await buildInboundFilter(req);
    const leads = await Lead.find(filter).lean();

    const dailyMap = {};
    for (const lead of leads) {
      const dateStr = toDateString(lead.date_created);
      if (!dateStr) continue;
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { date: dateStr, created: 0, booked: 0, closed: 0 };
      dailyMap[dateStr].created++;
    }
    for (const lead of leads) {
      const bookedDate = toDateString(lead.booked_at);
      if (bookedDate) {
        if (!dailyMap[bookedDate]) dailyMap[bookedDate] = { date: bookedDate, created: 0, booked: 0, closed: 0 };
        dailyMap[bookedDate].booked++;
      }
      const closedDate = toDateString(lead.closed_at);
      if (closedDate) {
        if (!dailyMap[closedDate]) dailyMap[closedDate] = { date: closedDate, created: 0, booked: 0, closed: 0 };
        dailyMap[closedDate].closed++;
      }
    }

    const days = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ days });
  } catch (err) {
    logger.error("Inbound daily analytics error:", err);
    res.status(500).json({ error: "Failed to fetch inbound daily analytics" });
  }
});

module.exports = router;
