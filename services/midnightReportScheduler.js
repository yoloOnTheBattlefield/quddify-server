const cron = require("node-cron");
const logger = require("../utils/logger").child({
  module: "midnight-report",
});
const { decrypt } = require("../utils/crypto");

let scheduledTask = null;

/**
 * Build and send a daily Telegram report for every account
 * that has Telegram configured.
 */
async function sendReports() {
  const Account = require("../models/Account");
  const CampaignLead = require("../models/CampaignLead");
  const OutboundLead = require("../models/OutboundLead");
  const Lead = require("../models/Lead");
  const Booking = require("../models/Booking");

  const accounts = await Account.find({
    telegram_bot_token: { $ne: null },
    telegram_chat_id: { $ne: null },
  }).lean();

  logger.info(`Sending midnight reports for ${accounts.length} account(s)`);

  for (const account of accounts) {
    try {
      await sendReportForAccount(account, {
        CampaignLead,
        OutboundLead,
        Lead,
        Booking,
      });
    } catch (err) {
      logger.error({ err, accountId: account._id }, "Report failed");
    }
  }
}

async function sendReportForAccount(
  account,
  { CampaignLead, OutboundLead, Lead, Booking },
) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const accountFilter = { account_id: account._id };

  // Outbound: DMs sent today
  const dmsSent = await CampaignLead.countDocuments({
    ...accountFilter,
    status: { $in: ["sent", "delivered", "replied"] },
    sent_at: { $gte: todayStart, $lte: todayEnd },
  });

  // Outbound: replies today
  const outboundReplied = await OutboundLead.countDocuments({
    ...accountFilter,
    replied: true,
    replied_at: { $gte: todayStart, $lte: todayEnd },
  });

  // Outbound: booked today
  const outboundBooked = await OutboundLead.countDocuments({
    ...accountFilter,
    booked: true,
    booked_at: { $gte: todayStart, $lte: todayEnd },
  });

  // Inbound: new leads today
  const inboundLeads = await Lead.countDocuments({
    ...accountFilter,
    date_created: { $gte: todayStart, $lte: todayEnd },
  });

  // Inbound: booked today
  const inboundBooked = await Lead.countDocuments({
    ...accountFilter,
    booked_at: { $gte: todayStart, $lte: todayEnd },
  });

  // Inbound: closed today
  const inboundClosed = await Lead.countDocuments({
    ...accountFilter,
    closed_at: { $gte: todayStart, $lte: todayEnd },
  });

  // Bookings created today
  const bookingsToday = await Booking.countDocuments({
    ...accountFilter,
    createdAt: { $gte: todayStart, $lte: todayEnd },
  });

  // Revenue from bookings closed today
  const revenueAgg = await Booking.aggregate([
    {
      $match: {
        ...accountFilter,
        createdAt: { $gte: todayStart, $lte: todayEnd },
        cash_collected: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$cash_collected" } } },
  ]);
  const revenue = revenueAgg[0]?.total || 0;

  const replyRate =
    dmsSent > 0 ? ((outboundReplied / dmsSent) * 100).toFixed(1) : "0.0";

  const lines = [];
  lines.push("📊 *Daily Report*");
  lines.push("");
  lines.push("*Outbound*");
  lines.push(`  DMs Sent: *${dmsSent}*`);
  lines.push(`  Replies: *${outboundReplied}* \\(${replyRate}%\\)`);
  lines.push(`  Booked: *${outboundBooked}*`);
  lines.push("");
  lines.push("*Inbound*");
  lines.push(`  New Leads: *${inboundLeads}*`);
  lines.push(`  Booked: *${inboundBooked}*`);
  lines.push(`  Closed: *${inboundClosed}*`);
  lines.push("");
  lines.push(`*Total Bookings:* ${bookingsToday}`);
  if (revenue > 0) {
    lines.push(`*Revenue:* $${revenue.toLocaleString()}`);
  }

  const text = lines.join("\n");

  let botToken;
  try {
    botToken = decrypt(account.telegram_bot_token);
  } catch {
    logger.error({ accountId: account._id }, "Failed to decrypt bot token");
    return;
  }
  if (!botToken) return;

  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: account.telegram_chat_id,
        text,
        parse_mode: "Markdown",
      }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    logger.error(
      { status: res.status, err, accountId: account._id },
      "Telegram sendMessage failed",
    );
  } else {
    logger.info({ accountId: account._id }, "Midnight report sent");
  }
}

function start() {
  // Run every day at midnight UTC
  scheduledTask = cron.schedule("0 0 * * *", async () => {
    logger.info("Midnight report starting");
    try {
      await sendReports();
    } catch (err) {
      logger.error({ err }, "Midnight report scheduler error");
    }
  });

  logger.info("Midnight report scheduler started — runs daily at 00:00 UTC");
}

function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info("Midnight report scheduler stopped");
  }
}

module.exports = { start, stop, sendReports, sendReportForAccount };
