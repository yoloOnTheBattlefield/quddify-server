const express = require("express");
const Lead = require("../models/Lead");

const router = express.Router();

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

// GET /analytics
router.get("/", async (req, res) => {
  try {
    const { ghl, account_id, start_date, end_date } = req.query;

    // Build filter
    const filter = {};
    if (ghl) filter.account_id = ghl;
    else if (account_id) filter.account_id = account_id;
    if (start_date || end_date) {
      filter.date_created = {};
      if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
      if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
    }

    console.log(req.query);

    // Fetch all filtered leads
    const leads = await Lead.find(filter).lean();

    // Determine date range for daily metrics
    let rangeStart = start_date;
    let rangeEnd = end_date;
    if (!rangeStart || !rangeEnd) {
      // If no date range provided, use min/max from data
      const dates = leads
        .map((l) => toDateString(l.date_created))
        .filter(Boolean);
      if (dates.length > 0) {
        dates.sort();
        rangeStart = rangeStart || dates[0];
        rangeEnd = rangeEnd || dates[dates.length - 1];
      } else {
        // No data, use today
        const today = new Date().toISOString().slice(0, 10);
        rangeStart = rangeStart || today;
        rangeEnd = rangeEnd || today;
      }
    }

    // 1. FUNNEL METRICS
    const totalContacts = leads.length;
    const qualifiedCount = leads.filter((l) => l.qualified_at).length;
    const qualificationRate =
      totalContacts > 0 ? round2((qualifiedCount / totalContacts) * 100) : 0;
    const linkSentCount = leads.filter((l) => l.link_sent_at).length;
    const linkSentRate =
      qualifiedCount > 0 ? round2((linkSentCount / qualifiedCount) * 100) : 0;
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
      qualifiedCount,
      qualificationRate,
      linkSentCount,
      linkSentRate,
      bookedCount,
      bookingRate,
      ghostedCount,
      ghostRate,
      fupCount,
      fupToBookedCount,
      recoveryRate,
    };

    // 2. VELOCITY METRICS
    const createdToQualifiedHours = leads
      .filter((l) => l.qualified_at && l.date_created)
      .map((l) => hoursBetween(l.date_created, l.qualified_at));

    const qualifiedToBookedHours = leads
      .filter((l) => l.qualified_at && l.booked_at)
      .map((l) => hoursBetween(l.qualified_at, l.booked_at));

    const createdToGhostedHours = leads
      .filter((l) => l.ghosted_at && !l.booked_at && l.date_created)
      .map((l) => hoursBetween(l.date_created, l.ghosted_at));

    const velocity = {
      createdToQualified: {
        median: round2(median(createdToQualifiedHours)),
        average: round2(average(createdToQualifiedHours)),
      },
      qualifiedToBooked: {
        median: round2(median(qualifiedToBookedHours)),
        average: round2(average(qualifiedToBookedHours)),
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
        qualified: 0,
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

      const qualifiedDate = toDateString(lead.qualified_at);
      if (qualifiedDate && dailyVolumeMap[qualifiedDate]) {
        dailyVolumeMap[qualifiedDate].qualified++;
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

    // New (No Action) - no qualified_at and no ghosted_at, idle > 1 day
    const newNoAction = leads
      .filter((l) => !l.qualified_at && !l.ghosted_at && l.date_created)
      .map((l) => ({
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown",
        daysSinceAction: Math.floor(daysBetween(l.date_created, nowISO)),
      }))
      .filter((c) => c.daysSinceAction > 1)
      .sort((a, b) => b.daysSinceAction - a.daysSinceAction)
      .slice(0, 10);

    // Qualified (Pending) - has qualified_at but no link_sent_at and no ghosted_at
    const qualifiedPending = leads
      .filter((l) => l.qualified_at && !l.link_sent_at && !l.ghosted_at)
      .map((l) => ({
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown",
        daysSinceAction: Math.floor(daysBetween(l.qualified_at, nowISO)),
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
        stage: "Qualified (Pending)",
        contacts: qualifiedPending,
        count: qualifiedPending.length,
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

    // Return all metrics
    res.json({
      funnel,
      velocity,
      dailyVolume,
      ghosting,
      fup,
      aging,
      cumulative,
    });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to calculate analytics",
    });
  }
});

module.exports = router;
