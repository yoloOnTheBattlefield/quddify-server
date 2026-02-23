const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const SenderAccount = require("../models/SenderAccount");
const OutboundAccount = require("../models/OutboundAccount");
const WarmupLog = require("../models/WarmupLog");
const Task = require("../models/Task");
const { emitToAccount, emitToSender } = require("./socketManager");

let tickInterval = null;

function resolveTemplate(template, lead) {
  const fullName = lead.fullName || lead.username || "";
  const firstName = fullName.split(/\s+/)[0] || "";
  return template
    .replace(/\{\{username\}\}/g, lead.username || "")
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{name\}\}/g, fullName)
    .replace(/\{\{bio\}\}/g, lead.bio || "");
}

function isWithinActiveHours(schedule) {
  const tz = schedule.timezone || "America/New_York";
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  const currentHour = parseInt(formatter.format(now), 10);
  return currentHour >= schedule.active_hours_start && currentHour < schedule.active_hours_end;
}

// Calculate seconds between each message based on REMAINING quota and REMAINING time.
// This ensures the daily limit is always reached — if the campaign starts late or
// tasks get stuck, subsequent sends speed up to compensate.
function calculateDelay(campaign, numSenders, sentToday) {
  const tz = campaign.schedule.timezone || "America/New_York";
  const endHour = campaign.schedule.active_hours_end || 21;
  const startHour = campaign.schedule.active_hours_start || 9;
  const totalDailyMessages =
    (campaign.daily_limit_per_sender || 50) * Math.max(numSenders, 1);

  // Calculate remaining time in active window (in seconds)
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const currentHour = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const currentMin = parseInt(parts.find((p) => p.type === "minute").value, 10);
  const currentTimeInSeconds = currentHour * 3600 + currentMin * 60;
  const endTimeInSeconds = endHour * 3600;
  const remainingSeconds = Math.max(endTimeInSeconds - currentTimeInSeconds, 1800); // min 30 min buffer

  // Calculate remaining messages to send
  const alreadySent = sentToday || 0;
  const remainingMessages = Math.max(totalDailyMessages - alreadySent, 1);

  // Spread remaining messages across remaining time
  const baseDelay = remainingSeconds / remainingMessages;

  // Add ±20% jitter so it doesn't look robotic
  const jitter = baseDelay * 0.2;
  const delay = baseDelay + (Math.random() * 2 - 1) * jitter;

  // Floor: full-window spread (never slower than if we had all day)
  const fullWindowDelay = ((endHour - startHour) * 3600) / totalDailyMessages;

  return Math.max(Math.round(Math.min(delay, fullWindowDelay)), 30); // min 30 seconds
}

function calculateBurstDelay(campaign) {
  const minDelay = campaign.schedule.min_delay_seconds || 60;
  const maxDelay = campaign.schedule.max_delay_seconds || 180;
  return Math.round(minDelay + Math.random() * (maxDelay - minDelay));
}

function calculateGroupBreak(campaign) {
  const minBreak = campaign.schedule.min_group_break_seconds || 600;
  const maxBreak = campaign.schedule.max_group_break_seconds || 1200;
  return Math.round(minBreak + Math.random() * (maxBreak - minBreak));
}

// Check if an outbound account is on a mandatory rest day
function isAccountResting(outboundAcct) {
  if (!outboundAcct.streak_rest_until) return false;
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  return todayMidnight < outboundAcct.streak_rest_until;
}

// Update sending streak after a DM is queued (called once per day per account)
async function updateSendingStreak(outboundAccountId) {
  const acct = await OutboundAccount.findById(outboundAccountId);
  if (!acct) return;

  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);

  // Check if already counted today
  if (acct.streak_last_send_date) {
    const lastMidnight = new Date(acct.streak_last_send_date);
    lastMidnight.setHours(0, 0, 0, 0);
    if (lastMidnight.getTime() === todayMidnight.getTime()) return; // already counted
  }

  let newStreak;

  if (acct.streak_rest_until) {
    // Coming back from enforced rest — continue streak from where it was
    newStreak = (acct.sending_streak || 0) + 1;
  } else if (acct.streak_last_send_date) {
    const yesterdayMidnight = new Date(todayMidnight.getTime() - 86400000);
    const lastMidnight = new Date(acct.streak_last_send_date);
    lastMidnight.setHours(0, 0, 0, 0);

    if (lastMidnight.getTime() === yesterdayMidnight.getTime()) {
      // Sent yesterday — continue streak
      newStreak = (acct.sending_streak || 0) + 1;
    } else {
      // Gap (campaign was paused, etc.) — reset streak
      newStreak = 1;
    }
  } else {
    // First ever send
    newStreak = 1;
  }

  const update = {
    sending_streak: newStreak,
    streak_last_send_date: new Date(),
    streak_rest_until: null, // clear expired rest
  };

  // Check if rest is needed
  if (newStreak >= 10) {
    // 2 days rest after 10 consecutive sending days, then reset cycle
    update.streak_rest_until = new Date(todayMidnight.getTime() + 3 * 86400000);
    update.sending_streak = 0;
    console.log(`[scheduler] Account ${acct.username} hit 10-day streak — resting 2 days (until ${update.streak_rest_until.toISOString().split("T")[0]})`);
  } else if (newStreak === 5) {
    // 1 day rest after 5 consecutive sending days (streak continues through rest)
    update.streak_rest_until = new Date(todayMidnight.getTime() + 2 * 86400000);
    console.log(`[scheduler] Account ${acct.username} hit 5-day streak — resting 1 day (until ${update.streak_rest_until.toISOString().split("T")[0]})`);
  }

  await OutboundAccount.findByIdAndUpdate(outboundAccountId, { $set: update });
}

async function checkStaleSenders() {
  const staleThreshold = new Date(Date.now() - 60 * 1000); // 60 seconds
  const stale = await SenderAccount.updateMany(
    { status: "online", last_seen: { $lt: staleThreshold } },
    { $set: { status: "offline", socket_id: null } },
  );
  if (stale.modifiedCount > 0) {
    console.log(`[scheduler] Marked ${stale.modifiedCount} stale sender(s) offline`);
  }

  // Auto-complete warmup for accounts past day 14
  const msPerDay = 86400000;
  const warmupCutoff = new Date(Date.now() - 14 * msPerDay);
  const warmupToComplete = await OutboundAccount.find({
    "warmup.enabled": true,
    "warmup.startDate": { $lte: warmupCutoff },
  }).lean();

  if (warmupToComplete.length > 0) {
    await OutboundAccount.updateMany(
      { _id: { $in: warmupToComplete.map((a) => a._id) } },
      { $set: { status: "ready", "warmup.enabled": false } },
    );
    // Create audit log entries
    const logEntries = warmupToComplete.map((a) => ({
      account_id: a.account_id,
      outbound_account_id: a._id,
      action: "warmup_completed",
      details: { username: a.username },
      performedBy: "system",
    }));
    await WarmupLog.insertMany(logEntries);
    console.log(`[scheduler] Auto-completed warmup for ${warmupToComplete.length} account(s)`);
  }

}

async function processDM({ campaign_id, campaign_lead_id, outbound_lead_id, sender_id, account_id, target, message, template_index }) {
  // Create the actual Task for the extension to pick up
  const task = await Task.create({
    account_id,
    type: "send_dm",
    target,
    message,
    outbound_lead_id,
    sender_id,
    campaign_id,
    campaign_lead_id,
    status: "pending",
  });

  // Update CampaignLead with task_id, message, and template index
  await CampaignLead.findByIdAndUpdate(campaign_lead_id, {
    $set: { task_id: task._id, message_used: message, template_index },
  });

  // Notify the specific sender's extension via websocket (not the whole account room)
  const delivered = emitToSender(sender_id, "task:new", task);

  if (!delivered) {
    console.warn(`[scheduler] No connected socket for sender ${sender_id} — task ${task._id} will be retried by stale cleanup`);
  }

  console.log(`[scheduler] Task created for ${target} → sender ${sender_id} (delivered: ${delivered})`);
}

async function processTick() {
  // Check for stale senders first
  await checkStaleSenders();

  // Stale lock cleanup for manual campaigns: reset queued leads older than 10 minutes
  const staleThresholdManual = new Date(Date.now() - 10 * 60 * 1000);
  const manualCampaigns = await Campaign.find({ mode: "manual", status: "active" }).lean();
  for (const mc of manualCampaigns) {
    // Atomic: only reset leads still in "queued" status (avoids race with confirm/skip)
    const result = await CampaignLead.updateMany(
      { campaign_id: mc._id, status: "queued", queued_at: { $lt: staleThresholdManual } },
      { $set: { status: "pending", sender_id: null, queued_at: null } },
    );
    if (result.modifiedCount > 0) {
      await Campaign.findByIdAndUpdate(mc._id, {
        $inc: { "stats.queued": -result.modifiedCount, "stats.pending": result.modifiedCount },
      });
      console.log(`[scheduler] Reset ${result.modifiedCount} stale queued lead(s) for manual campaign ${mc.name}`);
    }
  }

  // Stale lock cleanup for auto campaigns: reset queued leads older than 5 minutes
  const staleThresholdAuto = new Date(Date.now() - 5 * 60 * 1000);
  const autoCampaigns = await Campaign.find({ mode: { $ne: "manual" }, status: "active" }).lean();
  for (const ac of autoCampaigns) {
    const result = await CampaignLead.updateMany(
      { campaign_id: ac._id, status: "queued", queued_at: { $lt: staleThresholdAuto } },
      { $set: { status: "pending", sender_id: null, queued_at: null } },
    );
    if (result.modifiedCount > 0) {
      await Campaign.findByIdAndUpdate(ac._id, {
        $inc: { "stats.queued": -result.modifiedCount, "stats.pending": result.modifiedCount },
      });
      console.log(`[scheduler] Reset ${result.modifiedCount} stale queued lead(s) for auto campaign ${ac.name}`);
    }
  }

  // Stale task cleanup: auto-fail tasks stuck in pending/in_progress for over 2 minutes
  const staleTaskThreshold = new Date(Date.now() - 2 * 60 * 1000);
  const staleTasks = await Task.find({
    status: { $in: ["pending", "in_progress"] },
    createdAt: { $lt: staleTaskThreshold },
  }).lean();

  for (const staleTask of staleTasks) {
    await Task.findByIdAndUpdate(staleTask._id, {
      $set: {
        status: "failed",
        error: "Task timed out — extension did not pick up or complete in time",
        failedAt: new Date(),
      },
    });

    // Reset the associated campaign lead back to pending — only if still queued
    if (staleTask.campaign_lead_id) {
      const resetResult = await CampaignLead.findOneAndUpdate(
        { _id: staleTask.campaign_lead_id, status: "queued" },
        { $set: { status: "pending", sender_id: null, queued_at: null, task_id: null } },
      );

      if (resetResult && staleTask.campaign_id) {
        await Campaign.findByIdAndUpdate(staleTask.campaign_id, {
          $inc: { "stats.queued": -1, "stats.pending": 1 },
        });
      }
    }

    console.log(`[scheduler] Auto-failed stale task ${staleTask._id} (created ${staleTask.createdAt})`);
  }

  const campaigns = await Campaign.find({ status: "active", mode: { $ne: "manual" } });

  for (const campaign of campaigns) {
    try {

      // Burst mode: reset group counter if last send was a different day
      if (campaign.schedule.burst_enabled && campaign.last_sent_at) {
        const lastSendDay = new Date(campaign.last_sent_at);
        lastSendDay.setHours(0, 0, 0, 0);
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        if (lastSendDay.getTime() < todayMidnight.getTime()) {
          await Campaign.findByIdAndUpdate(campaign._id, {
            $set: { burst_sent_in_group: 0, burst_break_until: null },
          });
          campaign.burst_sent_in_group = 0;
          campaign.burst_break_until = null;
        }
      }

      // Get ALL senders linked to this campaign's outbound accounts (for round-robin order)
      const allSenders = await SenderAccount.find({
        outbound_account_id: { $in: campaign.outbound_account_ids },
      }).lean();

      if (allSenders.length === 0) continue;

      // Count only online senders for delay calculation — avoids
      // cramming messages when some senders are offline
      const onlineSenders = allSenders.filter((s) => s.status === "online");
      if (onlineSenders.length === 0) continue;

      // Test mode: any online sender with test_mode skips all pacing/limit checks
      const isTestMode = onlineSenders.some((s) => s.test_mode);

      // Check time window (skip in test mode)
      if (!isTestMode && !isWithinActiveHours(campaign.schedule)) continue;

      // Burst mode: check if we're on a group break
      if (!isTestMode && campaign.schedule.burst_enabled && campaign.burst_break_until) {
        if (new Date() < new Date(campaign.burst_break_until)) {
          continue; // still on break
        }
        // Break expired — reset for next group
        await Campaign.findByIdAndUpdate(campaign._id, {
          $set: { burst_sent_in_group: 0, burst_break_until: null },
        });
        campaign.burst_sent_in_group = 0;
        campaign.burst_break_until = null;
      }

      // Count how many have been sent today (across all senders for this campaign)
      const todayStartForDelay = new Date();
      todayStartForDelay.setHours(0, 0, 0, 0);
      const sentTodayTotal = await CampaignLead.countDocuments({
        campaign_id: campaign._id,
        status: { $in: ["sent", "queued"] },
        updatedAt: { $gte: todayStartForDelay },
      });

      // Calculate how long to wait between sends
      const delaySec = campaign.schedule.burst_enabled
        ? calculateBurstDelay(campaign)
        : calculateDelay(campaign, onlineSenders.length, sentTodayTotal);

      // Check if enough time has passed since last send (skip in test mode)
      if (!isTestMode && campaign.last_sent_at) {
        const elapsed = (Date.now() - campaign.last_sent_at.getTime()) / 1000;
        if (elapsed < delaySec * 0.8) continue; // not yet time (0.8 to account for tick drift)
      }

      // Round-robin: pick next sender
      let senderIndex = campaign.last_sender_index || 0;
      let sender = null;
      let attempts = 0;

      // Try each sender in round-robin order until we find one that's online + under limit
      while (attempts < allSenders.length) {
        const candidate = allSenders[senderIndex % allSenders.length];

        if (candidate.status === "online") {
          // In test mode, skip warmup/daily limit checks
          if (isTestMode) {
            // Only check no pending task exists
            const existingTask = await Task.findOne({
              sender_id: candidate._id,
              campaign_id: campaign._id,
              status: { $in: ["pending", "in_progress"] },
            }).lean();

            if (!existingTask) {
              sender = candidate;
              break;
            }
          } else {
            // Check warmup cap (global across all campaigns)
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            const outboundAcct = candidate.outbound_account_id
              ? await OutboundAccount.findById(candidate.outbound_account_id).lean()
              : null;

            // Check sending streak rest days (5 days on → 1 off, 10 days on → 2 off)
            if (outboundAcct && isAccountResting(outboundAcct)) {
              senderIndex++;
              attempts++;
              continue;
            }

            if (outboundAcct?.warmup?.enabled) {
              const msPerDay = 86400000;
              const warmupDay = Math.floor(
                (Date.now() - new Date(outboundAcct.warmup.startDate).getTime()) / msPerDay,
              ) + 1;
              const scheduleEntry = (outboundAcct.warmup.schedule || []).find(
                (s) => s.day === warmupDay,
              );
              const warmupCap = scheduleEntry ? scheduleEntry.cap : null;

              if (warmupCap === 0) {
                senderIndex++;
                attempts++;
                continue;
              }

              if (warmupCap !== null) {
                const totalSentToday = await CampaignLead.countDocuments({
                  sender_id: candidate._id,
                  status: { $in: ["sent", "queued"] },
                  updatedAt: { $gte: todayStart },
                });

                if (totalSentToday >= warmupCap) {
                  senderIndex++;
                  attempts++;
                  continue;
                }
              }
            }

            // Check daily limit
            const sentToday = await CampaignLead.countDocuments({
              campaign_id: campaign._id,
              sender_id: candidate._id,
              status: { $in: ["sent", "queued"] },
              updatedAt: { $gte: todayStart },
            });

            const dailyLimit = campaign.daily_limit_per_sender || candidate.daily_limit || 50;
            if (sentToday < dailyLimit) {
              const existingTask = await Task.findOne({
                sender_id: candidate._id,
                campaign_id: campaign._id,
                status: { $in: ["pending", "in_progress"] },
              }).lean();

              if (!existingTask) {
                sender = candidate;
                break;
              }
            }
          }
        }

        senderIndex++;
        attempts++;
      }

      if (!sender) continue; // no available sender right now

      // Pick next pending lead (atomic)
      const campaignLead = await CampaignLead.findOneAndUpdate(
        { campaign_id: campaign._id, status: "pending" },
        { $set: { status: "queued", sender_id: sender._id, queued_at: new Date() } },
        { sort: { createdAt: 1 }, new: true },
      );

      if (!campaignLead) {
        // No more pending leads — check if campaign should complete
        const remaining = await CampaignLead.countDocuments({
          campaign_id: campaign._id,
          status: { $in: ["pending", "queued"] },
        });

        if (remaining === 0) {
          campaign.status = "completed";
          await campaign.save();
          console.log(`[scheduler] Campaign ${campaign.name} completed — no pending leads`);
        }
        continue;
      }

      // Fetch outbound lead for template resolution
      const outboundLead = await OutboundLead.findById(campaignLead.outbound_lead_id).lean();
      if (!outboundLead) {
        await CampaignLead.findByIdAndUpdate(campaignLead._id, {
          $set: { status: "skipped", error: "Outbound lead not found" },
        });
        await Campaign.findByIdAndUpdate(campaign._id, {
          $inc: { "stats.skipped": 1, "stats.pending": -1 },
        });
        continue;
      }

      // Check if lead was already messaged
      if (outboundLead.isMessaged) {
        await CampaignLead.findByIdAndUpdate(campaignLead._id, {
          $set: { status: "skipped", error: "Lead already messaged" },
        });
        await Campaign.findByIdAndUpdate(campaign._id, {
          $inc: { "stats.skipped": 1, "stats.pending": -1 },
        });
        continue;
      }

      // Check for AI-personalized custom message first, fall back to template rotation
      let message;
      let messageIndex;
      let nextMessageIndex;
      if (campaignLead.custom_message) {
        message = campaignLead.custom_message;
        messageIndex = null;
        nextMessageIndex = campaign.last_message_index || 0; // don't advance
      } else {
        messageIndex = (campaign.last_message_index || 0) % campaign.messages.length;
        const template = campaign.messages[messageIndex];
        message = resolveTemplate(template, outboundLead);
        nextMessageIndex = (messageIndex + 1) % campaign.messages.length;
      }

      // Advance round-robin indexes
      const nextSenderIndex = (senderIndex + 1) % allSenders.length;

      // Update campaign tracking (atomic to avoid race with task completion)
      const trackingUpdate = {
        $inc: { "stats.pending": -1, "stats.queued": 1 },
        $set: {
          last_sent_at: new Date(),
          last_sender_index: nextSenderIndex,
          last_message_index: nextMessageIndex,
        },
      };

      // Burst mode: increment group counter
      if (campaign.schedule.burst_enabled) {
        trackingUpdate.$inc.burst_sent_in_group = 1;
      }

      await Campaign.findByIdAndUpdate(campaign._id, trackingUpdate);

      // Burst mode: check if group is complete and schedule a break
      if (campaign.schedule.burst_enabled) {
        const newGroupCount = (campaign.burst_sent_in_group || 0) + 1;
        const groupSize = campaign.schedule.messages_per_group || 10;

        if (newGroupCount >= groupSize) {
          // Check if there are more pending leads and daily limit not yet hit
          const pendingLeft = await CampaignLead.countDocuments({
            campaign_id: campaign._id,
            status: "pending",
          });

          if (pendingLeft > 0) {
            const breakSeconds = calculateGroupBreak(campaign);
            await Campaign.findByIdAndUpdate(campaign._id, {
              $set: {
                burst_sent_in_group: 0,
                burst_break_until: new Date(Date.now() + breakSeconds * 1000),
              },
            });
            console.log(`[scheduler] Campaign ${campaign.name} burst group done (${groupSize} msgs) — breaking for ${breakSeconds}s`);
          }
        }
      }

      // Process DM directly (no Redis queue needed)
      await processDM({
        campaign_id: campaign._id.toString(),
        campaign_lead_id: campaignLead._id.toString(),
        outbound_lead_id: outboundLead._id.toString(),
        sender_id: sender._id.toString(),
        account_id: campaign.account_id.toString(),
        target: outboundLead.username,
        message,
        template_index: messageIndex,
      });

      // Update sending streak for this outbound account (idempotent per day)
      if (sender.outbound_account_id) {
        await updateSendingStreak(sender.outbound_account_id).catch((err) =>
          console.error("[scheduler] Streak update error:", err.message),
        );
      }

      // Tell each sender when their next task will come (staggered per round-robin position)
      const pendingRemaining = await CampaignLead.countDocuments({
        campaign_id: campaign._id,
        status: "pending",
      });
      const baseEta = isTestMode ? 30 : delaySec;

      // Emit per-sender ETAs based on round-robin position
      for (let i = 0; i < onlineSenders.length; i++) {
        const rrIndex = (nextSenderIndex + i) % allSenders.length;
        const targetSender = allSenders[rrIndex];
        if (targetSender.status !== "online") continue;

        // Position 0 = next sender in round-robin, position 1 = sender after that, etc.
        const senderEta = baseEta * (i + 1);
        emitToSender(targetSender._id.toString(), "campaign:eta", {
          nextInSeconds: senderEta,
          pendingLeads: pendingRemaining,
          campaignName: campaign.name,
        });
      }

      console.log(
        `[scheduler] Queued DM to ${outboundLead.username} via ${sender.ig_username} (next in ~${baseEta}s, ${pendingRemaining} remaining)${isTestMode ? " [TEST MODE]" : ""}`,
      );
    } catch (err) {
      console.error(`[scheduler] Error processing campaign ${campaign._id}:`, err);
    }
  }
}

function start() {
  // Tick every 30 seconds using setInterval (no Redis needed)
  tickInterval = setInterval(async () => {
    try {
      await processTick();
    } catch (err) {
      console.error("[scheduler] Tick failed:", err);
    }
  }, 30000);

  console.log("[scheduler] Campaign scheduler started");
}

function stop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  console.log("[scheduler] Campaign scheduler stopped");
}

module.exports = { start, stop, resolveTemplate, isWithinActiveHours, calculateDelay, isAccountResting, updateSendingStreak };
