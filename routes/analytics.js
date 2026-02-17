const express = require("express");
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Account = require("../models/Account");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const SenderAccount = require("../models/SenderAccount");
const Campaign = require("../models/Campaign");

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
    const { start_date, end_date, source, account_id } = req.query;
    const dataSource = source || "all";

    // Build inbound filter using account's GHL location ID
    // Admins (role 0): no account_id = all accounts; with account_id = that account
    // Non-admins: always filter by their own account
    const isAdmin = req.user?.role === 0;
    const filter = {};
    if (isAdmin && account_id) {
      filter.account_id = account_id;
    } else if (!isAdmin && req.account.ghl) {
      filter.account_id = req.account.ghl;
    }
    if (start_date || end_date) {
      filter.date_created = {};
      if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
      if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
    }

    // Fetch inbound leads (skip if source=outbound)
    const leads = dataSource !== "outbound" ? await Lead.find(filter).lean() : [];

    // Fetch outbound leads (skip if source=inbound)
    let obLeads = [];
    if (dataSource !== "inbound") {
      const obFilter = { isMessaged: true };

      if (isAdmin && account_id) {
        // Admin filtering by specific account — resolve GHL to ObjectId
        const targetAccount = await Account.findOne({ ghl: account_id }).lean();
        if (targetAccount) obFilter.account_id = targetAccount._id;
      } else if (!isAdmin) {
        // Non-admin — always filter by own account
        obFilter.account_id = req.account._id;
      }
      // Admin with no account_id — no account filter = all outbound leads

      if (start_date || end_date) {
        obFilter.dmDate = {};
        if (start_date) obFilter.dmDate.$gte = new Date(`${start_date}T00:00:00.000Z`);
        if (end_date) obFilter.dmDate.$lte = new Date(`${end_date}T23:59:59.999Z`);
      }
      obLeads = await OutboundLead.find(obFilter).lean();
    }

    // Determine date range for daily metrics
    let rangeStart = start_date;
    let rangeEnd = end_date;
    if (!rangeStart || !rangeEnd) {
      const inboundDates = leads.map((l) => toDateString(l.date_created)).filter(Boolean);
      const outboundDates = obLeads.map((l) => toDateString(l.dmDate)).filter(Boolean);
      const allDates = [...inboundDates, ...outboundDates].filter((d) => d >= MIN_VALID_DATE);
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

    // Outbound funnel metrics
    const obMessaged = obLeads.length;
    const obReplied = obLeads.filter((l) => l.replied).length;
    const obBooked = obLeads.filter((l) => l.booked).length;
    const obContracts = obLeads.filter((l) => l.contract_value > 0).length;
    const obContractValue = obLeads.reduce((sum, l) => sum + (l.contract_value || 0), 0);
    const obReplyRate = obMessaged > 0 ? round2((obReplied / obMessaged) * 100) : 0;
    const obBookRate = obReplied > 0 ? round2((obBooked / obReplied) * 100) : 0;
    const obCloseRate = obBooked > 0 ? round2((obContracts / obBooked) * 100) : 0;

    // Combined metrics
    const combinedContacts = totalContacts + obMessaged;
    const combinedBooked = bookedCount + obBooked;
    const combinedBookedRate = combinedContacts > 0 ? round2((combinedBooked / combinedContacts) * 100) : 0;

    const funnel = {
      totalContacts,
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
      obMessaged,
      obReplied,
      obBooked,
      obContracts,
      obContractValue,
      obReplyRate,
      obBookRate,
      obCloseRate,
      combinedContacts,
      combinedBooked,
      combinedBookedRate,
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
        ob_messaged: 0,
        ob_replied: 0,
        ob_booked: 0,
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

    // Outbound daily volume
    obLeads.forEach((lead) => {
      const dmDate = toDateString(lead.dmDate);
      if (dmDate && dailyVolumeMap[dmDate]) {
        dailyVolumeMap[dmDate].ob_messaged++;
        if (lead.replied) dailyVolumeMap[dmDate].ob_replied++;
        if (lead.booked) dailyVolumeMap[dmDate].ob_booked++;
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
    const obBookingsByDate = {};
    dateRange.forEach((date) => {
      bookingsByDate[date] = 0;
      obBookingsByDate[date] = 0;
    });

    leads.forEach((lead) => {
      if (lead.booked_at) {
        const bookedDate = toDateString(lead.booked_at);
        if (bookedDate && bookingsByDate[bookedDate] !== undefined) {
          bookingsByDate[bookedDate]++;
        }
      }
    });

    obLeads.forEach((lead) => {
      if (lead.booked) {
        const dmDate = toDateString(lead.dmDate);
        if (dmDate && obBookingsByDate[dmDate] !== undefined) {
          obBookingsByDate[dmDate]++;
        }
      }
    });

    let runningTotal = 0;
    let obRunningTotal = 0;
    const cumulative = dateRange.map((date) => {
      runningTotal += bookingsByDate[date];
      obRunningTotal += obBookingsByDate[date];
      return {
        date,
        cumulative: runningTotal,
        ob_cumulative: obRunningTotal,
        combined_cumulative: runningTotal + obRunningTotal,
      };
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
      radarMap[key] = { leads: 0, link_sent: 0, booked: 0, ghosted: 0, follow_up: 0, ob_messaged: 0, ob_replied: 0, ob_booked: 0 };
    }

    for (const lead of leads) {
      const created = lead.date_created;
      if (!created) continue;
      const dateStr = String(created).slice(0, 10);
      if (dateStr < radarStart || dateStr > radarEnd) continue;
      const key = getRadarBucketKey(dateStr, grouping);
      if (!radarMap[key]) radarMap[key] = { leads: 0, link_sent: 0, booked: 0, ghosted: 0, follow_up: 0, ob_messaged: 0, ob_replied: 0, ob_booked: 0 };
      radarMap[key].leads++;
      if (lead.link_sent_at) radarMap[key].link_sent++;
      if (lead.booked_at) radarMap[key].booked++;
      if (lead.ghosted_at) radarMap[key].ghosted++;
      if (lead.follow_up_at) radarMap[key].follow_up++;
    }

    // Outbound radar
    for (const lead of obLeads) {
      const dmDate = lead.dmDate;
      if (!dmDate) continue;
      const dateStr = toDateString(dmDate);
      if (!dateStr || dateStr < radarStart || dateStr > radarEnd) continue;
      const key = getRadarBucketKey(dateStr, grouping);
      if (!radarMap[key]) radarMap[key] = { leads: 0, link_sent: 0, booked: 0, ghosted: 0, follow_up: 0, ob_messaged: 0, ob_replied: 0, ob_booked: 0 };
      radarMap[key].ob_messaged++;
      if (lead.replied) radarMap[key].ob_replied++;
      if (lead.booked) radarMap[key].ob_booked++;
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
        ob_messaged: counts.ob_messaged,
        ob_replied: counts.ob_replied,
        ob_booked: counts.ob_booked,
      }));

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
    });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to calculate analytics",
    });
  }
});

// GET /analytics/outbound — outbound funnel with optional campaign + date filter
router.get("/outbound", async (req, res) => {
  try {
    const { campaign_id, from, to } = req.query;
    const outboundFilter = { account_id: req.account._id, isMessaged: true };

    if (from || to) {
      outboundFilter.dmDate = {};
      if (from) outboundFilter.dmDate.$gte = new Date(from);
      if (to) outboundFilter.dmDate.$lte = new Date(to);
    }

    // Scope to specific campaign's leads
    if (campaign_id) {
      const campaignLeads = await CampaignLead.find({ campaign_id }).select("outbound_lead_id").lean();
      outboundFilter._id = { $in: campaignLeads.map((cl) => cl.outbound_lead_id) };
    }

    const totalFilter = { account_id: req.account._id };
    if (campaign_id) {
      totalFilter._id = outboundFilter._id;
    }

    const [total, messaged, replied, booked, contractAgg] = await Promise.all([
      OutboundLead.countDocuments(totalFilter),
      OutboundLead.countDocuments(outboundFilter),
      OutboundLead.countDocuments({ ...outboundFilter, replied: true }),
      OutboundLead.countDocuments({ ...outboundFilter, booked: true }),
      OutboundLead.aggregate([
        { $match: { ...outboundFilter, contract_value: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$contract_value" }, count: { $sum: 1 } } },
      ]),
    ]);

    const contractData = contractAgg[0] || { total: 0, count: 0 };

    res.json({
      total,
      messaged,
      replied,
      booked,
      contracts: contractData.count,
      contract_value: contractData.total,
      reply_rate: messaged > 0 ? round2((replied / messaged) * 100) : 0,
      book_rate: replied > 0 ? round2((booked / replied) * 100) : 0,
      close_rate: booked > 0 ? round2((contractData.count / booked) * 100) : 0,
    });
  } catch (err) {
    console.error("Outbound analytics error:", err);
    res.status(500).json({ error: "Failed to fetch outbound analytics" });
  }
});

// GET /analytics/messages — performance per message template
router.get("/messages", async (req, res) => {
  try {
    const { campaign_id } = req.query;
    const matchFilter = { status: "sent" };
    if (campaign_id) matchFilter.campaign_id = new mongoose.Types.ObjectId(campaign_id);

    // Group by campaign_id + template_index (the template identifier)
    // Falls back to message_used for legacy leads without template_index
    const messageSends = await CampaignLead.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: {
            campaign_id: "$campaign_id",
            template_index: "$template_index",
          },
          sent: { $sum: 1 },
          outbound_lead_ids: { $push: "$outbound_lead_id" },
          sample_message: { $first: "$message_used" },
        },
      },
    ]);

    // Look up campaign names and raw templates in bulk
    const campaignIds = [...new Set(messageSends.map((m) => m._id.campaign_id?.toString()).filter(Boolean))];
    const campaignDocs = await Campaign.find({ _id: { $in: campaignIds } }).lean();
    const campaignMap = {};
    for (const c of campaignDocs) {
      campaignMap[c._id.toString()] = c;
    }

    const results = await Promise.all(
      messageSends.map(async (msg) => {
        const [replied, booked, contractAgg] = await Promise.all([
          OutboundLead.countDocuments({ _id: { $in: msg.outbound_lead_ids }, replied: true }),
          OutboundLead.countDocuments({ _id: { $in: msg.outbound_lead_ids }, booked: true }),
          OutboundLead.aggregate([
            { $match: { _id: { $in: msg.outbound_lead_ids }, contract_value: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: "$contract_value" }, count: { $sum: 1 } } },
          ]),
        ]);

        const contractData = contractAgg[0] || { total: 0, count: 0 };
        const camp = campaignMap[msg._id.campaign_id?.toString()] || null;
        const templateIndex = msg._id.template_index;

        // Get raw template text from campaign.messages[template_index]
        let template = null;
        if (camp && templateIndex != null && camp.messages && camp.messages[templateIndex]) {
          template = camp.messages[templateIndex];
        }

        return {
          campaign_id: msg._id.campaign_id || null,
          campaign_name: camp ? camp.name : "Unknown",
          template_index: templateIndex,
          template: template || msg.sample_message || "(no template)",
          sent: msg.sent,
          replied,
          booked,
          contracts: contractData.count,
          contract_value: contractData.total,
          reply_rate: msg.sent > 0 ? round2((replied / msg.sent) * 100) : 0,
          book_rate: replied > 0 ? round2((booked / replied) * 100) : 0,
        };
      }),
    );

    results.sort((a, b) => b.reply_rate - a.reply_rate);
    res.json({ messages: results });
  } catch (err) {
    console.error("Message analytics error:", err);
    res.status(500).json({ error: "Failed to fetch message analytics" });
  }
});

// GET /analytics/senders — performance per sender account
router.get("/senders", async (req, res) => {
  try {
    const { campaign_id } = req.query;
    const matchFilter = { sender_id: { $ne: null } };
    if (campaign_id) matchFilter.campaign_id = new mongoose.Types.ObjectId(campaign_id);

    const senderSends = await CampaignLead.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: "$sender_id",
          sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ["$status", "skipped"] }, 1, 0] } },
          outbound_lead_ids: {
            $push: { $cond: [{ $eq: ["$status", "sent"] }, "$outbound_lead_id", "$$REMOVE"] },
          },
        },
      },
    ]);

    const senderIds = senderSends.map((s) => s._id);
    const senders = await SenderAccount.find({ _id: { $in: senderIds } })
      .select("ig_username display_name status restricted_until restriction_reason")
      .lean();

    const senderMap = {};
    for (const s of senders) senderMap[s._id.toString()] = s;

    const results = await Promise.all(
      senderSends.map(async (s) => {
        const sender = senderMap[s._id.toString()] || {};
        const [replied, booked, contractAgg] = await Promise.all([
          OutboundLead.countDocuments({ _id: { $in: s.outbound_lead_ids }, replied: true }),
          OutboundLead.countDocuments({ _id: { $in: s.outbound_lead_ids }, booked: true }),
          OutboundLead.aggregate([
            { $match: { _id: { $in: s.outbound_lead_ids }, contract_value: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: "$contract_value" }, count: { $sum: 1 } } },
          ]),
        ]);

        const contractData = contractAgg[0] || { total: 0, count: 0 };

        return {
          sender_id: s._id,
          ig_username: sender.ig_username || "unknown",
          display_name: sender.display_name || null,
          status: sender.status || "offline",
          restricted_until: sender.restricted_until || null,
          sent: s.sent,
          failed: s.failed,
          skipped: s.skipped,
          replied,
          booked,
          contracts: contractData.count,
          contract_value: contractData.total,
          reply_rate: s.sent > 0 ? round2((replied / s.sent) * 100) : 0,
        };
      }),
    );

    results.sort((a, b) => b.sent - a.sent);
    res.json({ senders: results });
  } catch (err) {
    console.error("Sender analytics error:", err);
    res.status(500).json({ error: "Failed to fetch sender analytics" });
  }
});

// GET /analytics/campaigns — performance per campaign
router.get("/campaigns", async (req, res) => {
  try {
    const campaigns = await Campaign.find({ account_id: req.account._id })
      .select("name status stats outbound_account_ids messages createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const results = await Promise.all(
      campaigns.map(async (c) => {
        const sentLeads = await CampaignLead.find({ campaign_id: c._id, status: "sent" })
          .select("outbound_lead_id")
          .lean();
        const outboundIds = sentLeads.map((l) => l.outbound_lead_id);

        const [replied, booked, contractAgg] = await Promise.all([
          OutboundLead.countDocuments({ _id: { $in: outboundIds }, replied: true }),
          OutboundLead.countDocuments({ _id: { $in: outboundIds }, booked: true }),
          OutboundLead.aggregate([
            { $match: { _id: { $in: outboundIds }, contract_value: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: "$contract_value" }, count: { $sum: 1 } } },
          ]),
        ]);

        const contractData = contractAgg[0] || { total: 0, count: 0 };

        return {
          _id: c._id,
          name: c.name,
          status: c.status,
          stats: c.stats,
          sender_count: c.outbound_account_ids.length,
          message_count: c.messages.length,
          replied,
          booked,
          contracts: contractData.count,
          contract_value: contractData.total,
          reply_rate: c.stats.sent > 0 ? round2((replied / c.stats.sent) * 100) : 0,
          createdAt: c.createdAt,
        };
      }),
    );

    res.json({ campaigns: results });
  } catch (err) {
    console.error("Campaign analytics error:", err);
    res.status(500).json({ error: "Failed to fetch campaign analytics" });
  }
});

module.exports = router;
