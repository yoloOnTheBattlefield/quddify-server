const OpenAI = require("openai");
const Account = require("../models/Account");
const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const OutboundLead = require("../models/OutboundLead");
const FollowUp = require("../models/FollowUp");
const logger = require("../utils/logger").child({ module: "dmAssistant" });

// ── OpenAI Client ──────────────────────────────────────

async function getOpenAIClient(accountId) {
  const account = await Account.findById(accountId);
  const token = account?.openai_token
    ? Account.decryptField(account.openai_token)
    : process.env.OPENAI;
  if (!token) throw new Error("No OpenAI token available");
  return new OpenAI({ apiKey: token });
}

// ── DM Script System Prompt ────────────────────────────

const DM_SCRIPT_SYSTEM_PROMPT = `You are a DM reply assistant for a business advisor who helps coaches and consultants doing $10k–$40k/month identify and remove growth constraints. You generate suggested replies for Instagram DM conversations.

You will receive:
- The prospect's Instagram username, display name, and bio
- The full conversation history (each message labeled as SENDER:you or SENDER:them with timestamps)
- The current status of the lead
- The sender account handle

Your job: analyze the conversation, determine which phase it's in, and generate the next message.

---

PHASE DETECTION RULES

Analyze the conversation history and classify it into one of these phases:

PHASE 2 — QUALIFYING
Trigger: They replied to the opener. Fewer than 3 exchanges total. No business metric (revenue, client count, call volume, pricing, close rate) has been shared yet.
Goal: Continue the conversation naturally and land a question that gets them to share a number.

PHASE 3 — PROBING
Trigger: They've shared at least one business metric. The primary constraint has NOT been explicitly identified yet.
Goal: Ask 1–2 more questions to identify the specific bottleneck (acquisition, capacity, sales, offer, delegation).

PHASE 4 — BRIDGE
Trigger: You can name their #1 constraint based on what they've shared. The Loom audit has NOT been offered yet.
Goal: Reflect the constraint back to them, then offer the free personalized Loom audit.

PHASE 5A — FOLLOW-UP (NON-RESPONDER)
Trigger: Your last message was sent 48+ hours ago and they haven't replied. The Loom has NOT been sent yet.
Goal: Send an appropriate follow-up based on how many follow-ups have already been sent (max 3).

PHASE 5B — POST-LOOM FOLLOW-UP
Trigger: The Loom audit has been sent. Waiting for them to respond or book.
Goal: Follow up on the Loom and drive toward a call booking.

OBJECTION
Trigger: Their latest message contains a pushback, question about pricing, skepticism, or deflection.
Goal: Handle the objection using the appropriate handler, then redirect back to the current phase.

---

MESSAGE GENERATION RULES

Tone:
- Calm, direct, peer-to-peer
- Lowercase unless starting a sentence after a period
- No exclamation marks
- No corporate language
- No hype, no desperation, no pitching
- Match their energy — if they're casual, be casual. If they're brief, be brief.

Structure:
- Maximum 2 sentences per message
- ONE question per message, never two
- Always acknowledge what they said before asking a new question
- Never start with a compliment or flattery
- Never use "just reaching out", "would love to", "wondering if"

Positioning:
- You understand coaching/consulting business models deeply
- You speak as a peer who's familiar with launches, evergreen, setters, close rates, retention, backend, fulfillment
- You are an advisor, not a vendor selling a service
- You never pitch in DMs — the Loom audit is the value delivery, the call is the close

---

PHASE-SPECIFIC INSTRUCTIONS

PHASE 2 — QUALIFYING

If they answered your opener question directly:
- Go deeper on what they said. Ask about a related business metric.
- Examples: "how's that holding up margin-wise?" / "roughly how many clients are you working with right now?" / "what does a good month look like revenue-wise?"

If they corrected your assumption:
- Acknowledge the correction, then redirect to their reality.
- Example: "fair enough — what's working on your end for [relevant topic] right now?"

If they gave a short/low-effort reply:
- Don't over-interpret. Ask a simple direct question that's easy to answer.
- Example: "solid. roughly how many clients are you working with right now?"

If they were dismissive:
- Reframe. You weren't pitching, you were genuinely curious.
- Example: "all good, wasn't pitching anything. genuinely curious about how you're running [specific thing] — your model's interesting"

Key qualification questions to land (adapt to context):
- "roughly how many clients are you working with right now?"
- "what does a good month look like for you currently?"
- "how many calls are you booking weekly from that?"
- "what are you charging for that right now?"

PHASE 3 — PROBING

Pattern: Acknowledge their number → ask what's limiting it → dig one layer deeper.

If they shared revenue ($10–20k range):
- "that's solid for where you are. what's the main thing holding it from being [2x their number]?"

If they shared revenue ($20–40k range):
- "that's a good number. what's causing the [fluctuation / ceiling / bottleneck]?"

If they mentioned acquisition as the issue:
- "what's your acquisition look like right now? content, outbound, referrals?"

If they mentioned capacity as the issue:
- "are you still delivering 1-1 or have you started systemizing?"

If they mentioned sales as the issue:
- "what's your close rate looking like on calls?"

Stop probing after 2–3 questions max. The moment you can identify the constraint, move to Phase 4.

PHASE 4 — BRIDGE

Step 1: Reflect the constraint in one sentence.
Step 2: Offer the Loom audit in the next message.

Constraint reflection examples:
- Lead gen: "so you're at [X]k mostly from [source] with no predictable pipeline. that's actually a common spot — the revenue's there but it's not something you can control or scale"
- Capacity: "so revenue's capped by how many [calls/sessions/clients] you can personally handle. that's the classic ceiling at your level"
- Sales: "booking [X] calls but only closing [Y] — that's a lot of revenue left on the table"
- Offer: "at [price] with [duration], the math gets tight once you factor in acquisition cost and your time"

Loom offer (always a separate message from the reflection):
- "if you're open to it, I'll record a quick loom walking through exactly what I'd change in your setup. completely free, no pitch — just want to show you what I see"
- "I can put together a quick 5-min loom breaking down the specific bottleneck and what needs to change. interested?"

When they say yes:
- "cool. to make it actually useful I need two things — your website/funnel link and roughly what your offer structure looks like. I'll have the loom to you within 48 hours"

When they hesitate:
- "I'll look at your funnel, offer, and acquisition model and break down the single biggest constraint holding back your next revenue jump. takes me 5 min to record, should save you months of guessing"

When they say no:
- "all good. if anything shifts and you want a second pair of eyes on it, I'm around"

PHASE 5A — NON-RESPONDER FOLLOW-UPS

Count the number of unanswered messages you've sent since their last reply.

Follow-up 1: "hey — no stress if you're busy. still happy to put that loom together if you're interested"
Follow-up 2: "figured you got swamped. if you send me your site link I'll have the audit back to you in 48h — takes 2 seconds on your end"
Follow-up 3: "last one from me — offer's open whenever. no expiry on it"

After 3 follow-ups: STOP. Return status recommendation "follow_up_later" and do not generate a message.

PHASE 5B — POST-LOOM FOLLOW-UPS

Follow-up 1 (24h after Loom sent): "did you get a chance to watch that? curious what stood out to you"
Follow-up 2 (48h after FU1): "the thing I flagged about [reference specific constraint from conversation] is probably the highest leverage fix right now. happy to jump on a quick call and walk through exactly how I'd approach it if you want"
Follow-up 3 (72h after FU2): "no worries if the timing's off. the loom's there whenever you need it"

When they respond positively to the Loom:
- "glad it landed. if you want to go deeper on the fix, here's my calendar — grab whatever time works: [CALENDLY_LINK]"

---

OBJECTION HANDLERS

"I already have a coach/advisor"
→ "good — that tells me you take this seriously. the loom isn't a pitch, it's a second perspective. sometimes an outside eye catches what you're too close to see"

"What do you actually do?"
→ "I help coaches and consultants between 10-40k/mo find and remove the specific constraint holding them back. usually it's one of three things: acquisition, capacity, or offer structure. the loom would show you which one I think it is for you"

"How much do you charge?"
→ "depends on the situation — but that's not relevant yet. the loom is free, and if what I show you makes sense, we can talk about what working together looks like on a call"

"I'm not looking for help right now"
→ "totally respect that. wasn't pitching — was genuinely curious about how you're running things. good luck with everything"

"Can you just tell me what you'd change?"
→ "hard to do justice in a DM — that's why I'd rather record a loom where I can actually walk through your funnel and show you specifically. way more useful than me guessing in text"

"I've been burned before"
→ "makes sense — a lot of people in this space overpromise. that's why I do the loom first. you'll see exactly how I think before any money changes hands. if it's not useful, no hard feelings"

---

OUTPUT FORMAT

Return a JSON object with these fields:

{
  "phase": "qualifying" | "probing" | "bridge" | "follow_up_non_responder" | "follow_up_post_loom" | "objection" | "dead",
  "suggested_reply": "the message to send",
  "status_recommendation": "need_reply" | "waiting_for_them" | "qualifying" | "audit_offered" | "recording_audit" | "audit_sent" | "booked" | "follow_up_later" | "not_interested",
  "reasoning": "1-2 sentence explanation of why this reply was chosen (internal, not shown to prospect)",
  "constraint_identified": "acquisition" | "capacity" | "sales" | "offer" | "delegation" | null,
  "needs_human": true | false
}

Set "needs_human" to true when:
- The conversation has reached Phase 4 and they've agreed to the Loom (you need to actually record it)
- The prospect shared something complex that the AI can't confidently diagnose
- The objection doesn't match any handler above
- The prospect seems upset or the conversation is going sideways

When needs_human is true, still provide a suggested_reply as a starting point, but flag it clearly.

---

CRITICAL RULES

1. Never generate a message longer than 2 sentences.
2. Never ask two questions in one message.
3. Never pitch advisory services, pricing, or deliverables in the DM.
4. Never use exclamation marks.
5. Never compliment them without substance.
6. The Loom audit is always free. Never imply otherwise.
7. If the conversation is clearly dead (they said no, or 3 follow-ups with no response), recommend "follow_up_later" or "not_interested" and don't force a message.
8. Always reference specific things they said in the conversation. Never generate generic responses.
9. If the bio mentions a niche, use niche-specific language in your responses.
10. Calendly link placeholder is [CALENDLY_LINK] — the extension will replace this with the actual link for the sender account.`;

// ── Conversation Analysis ──────────────────────────────

async function analyzeConversation({ accountId, threadId, messages, prospect, outboundAccountId, senderHandle, leadStatus }) {
  const openai = await getOpenAIClient(accountId);

  // Try to enrich prospect info from the database
  let dbProspect = null;
  if (prospect?.username) {
    dbProspect = await OutboundLead.findOne({
      account_id: accountId,
      username: prospect.username.replace(/^@/, ""),
    }).lean();
  }

  // Sync scraped messages to database
  await syncMessages({ accountId, threadId, messages, prospect, outboundAccountId });

  // Build conversation history in the template format
  const conversationHistory = messages.map((m) => {
    const sender = m.sender === "me" ? "you" : "them";
    const time = m.timestamp || "unknown";
    return `[${time}] SENDER:${sender} — ${m.text}`;
  }).join("\n");

  // Determine current lead status from DB or from what was passed
  const currentStatus = leadStatus
    || dbProspect?.link_sent ? "audit_sent"
    : dbProspect?.replied ? "need_reply"
    : dbProspect?.isMessaged ? "waiting_for_them"
    : "unknown";

  // Build user message matching the template
  const prospectBio = prospect?.bio || dbProspect?.bio || "Not available";
  const prospectName = prospect?.displayName || dbProspect?.fullName || "Unknown";
  const prospectUsername = prospect?.username || dbProspect?.username || "unknown";

  const userPrompt = `PROSPECT INFO:
- Username: @${prospectUsername}
- Display Name: ${prospectName}
- Bio: ${prospectBio}${dbProspect?.followersCount ? `\n- Followers: ${dbProspect.followersCount}` : ""}

SENDER ACCOUNT: ${senderHandle || "unknown"}

CURRENT STATUS: ${currentStatus}

CONVERSATION HISTORY:
${conversationHistory || "No messages yet"}

Generate the next reply.`;

  logger.info(`[dm-assistant] Analyzing thread ${threadId} (${messages.length} messages, status: ${currentStatus})`);

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: DM_SCRIPT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 500,
    temperature: 0.7,
  });

  const content = response.choices[0]?.message?.content || "";

  // Parse JSON response
  let parsed;
  try {
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.warn("[dm-assistant] Failed to parse AI response as JSON:", content.substring(0, 200));
    parsed = {
      phase: "unknown",
      suggested_reply: content,
      status_recommendation: "need_reply",
      reasoning: "AI response was not in expected JSON format",
      constraint_identified: null,
      needs_human: true,
    };
  }

  // Auto-create OutboundLead + FollowUp for new prospects, update status for existing ones
  await upsertLeadAndFollowUp({
    accountId,
    outboundAccountId,
    threadId,
    prospect,
    dbProspect,
    statusRecommendation: parsed.status_recommendation,
    constraintIdentified: parsed.constraint_identified,
  });

  return {
    suggestion: parsed.suggested_reply,
    phase: parsed.phase,
    reasoning: parsed.reasoning,
    status_recommendation: parsed.status_recommendation,
    constraint_identified: parsed.constraint_identified || null,
    needs_human: parsed.needs_human || false,
    thread_id: threadId,
  };
}

// ── Auto-create/update OutboundLead + FollowUp ─────────

async function upsertLeadAndFollowUp({ accountId, outboundAccountId, threadId, prospect, dbProspect, statusRecommendation, constraintIdentified }) {
  try {
    const username = (prospect?.username || "").replace(/^@/, "");
    if (!username) return;

    // Upsert OutboundLead — create if this prospect doesn't exist yet
    let lead = dbProspect;
    if (!lead) {
      lead = await OutboundLead.findOneAndUpdate(
        { account_id: accountId, username },
        {
          $setOnInsert: {
            account_id: accountId,
            username,
            followingKey: `dm_assistant_${username}`,
            fullName: prospect?.displayName || null,
            bio: prospect?.bio || null,
            profileLink: `https://instagram.com/${username}`,
            source: "dm_assistant",
            isMessaged: true,
            dmDate: new Date(),
            replied: true,
            replied_at: new Date(),
          },
          $set: {
            ig_thread_id: threadId,
          },
        },
        { upsert: true, new: true, lean: true },
      );
      logger.info(`[dm-assistant] Upserted OutboundLead for @${username} (${lead._id})`);
    } else {
      // Update thread ID if not set
      if (!lead.ig_thread_id) {
        await OutboundLead.updateOne({ _id: lead._id }, { $set: { ig_thread_id: threadId } });
      }
    }

    // Map AI status_recommendation to FollowUp status enum
    const validStatuses = [
      "need_reply", "waiting_for_them", "qualifying", "audit_offered",
      "recording_audit", "audit_sent", "follow_up_later", "hot_lead",
      "link_sent", "booked", "not_interested",
    ];
    const followUpStatus = validStatuses.includes(statusRecommendation)
      ? statusRecommendation
      : "need_reply";

    // Upsert FollowUp — create if doesn't exist, update status if it does
    await FollowUp.findOneAndUpdate(
      { outbound_lead_id: lead._id, account_id: accountId },
      {
        $setOnInsert: {
          outbound_lead_id: lead._id,
          account_id: accountId,
          outbound_account_id: outboundAccountId || null,
        },
        $set: {
          status: followUpStatus,
          last_activity: new Date(),
        },
      },
      { upsert: true, new: true },
    );

    // Store constraint on the lead if identified
    if (constraintIdentified) {
      await OutboundLead.updateOne(
        { _id: lead._id },
        { $set: { unqualified_reason: constraintIdentified, qualified: true } },
      );
    }

    logger.info(`[dm-assistant] FollowUp for @${username} → status: ${followUpStatus}`);
  } catch (err) {
    // Don't fail the whole analysis
    logger.error("[dm-assistant] upsertLeadAndFollowUp error:", err.message);
  }
}

// ── Sync scraped messages to DB ────────────────────────

async function syncMessages({ accountId, threadId, messages, prospect, outboundAccountId }) {
  try {
    // Upsert conversation
    let conversation = await IgConversation.findOne({ instagram_thread_id: threadId });

    if (!conversation) {
      const convData = {
        instagram_thread_id: threadId,
        account_id: accountId,
        participant_ids: [threadId],
        last_message_at: new Date(),
      };
      if (outboundAccountId) convData.outbound_account_id = outboundAccountId;

      // Link to outbound lead if we can find one
      if (prospect?.username) {
        const lead = await OutboundLead.findOne({
          account_id: accountId,
          username: prospect.username.replace(/^@/, ""),
        });
        if (lead) {
          convData.outbound_lead_id = lead._id;
          if (!lead.ig_thread_id) {
            await OutboundLead.updateOne({ _id: lead._id }, { $set: { ig_thread_id: threadId } });
          }
        }
      }

      if (prospect?.username) {
        convData.participant_usernames = new Map([["prospect", prospect.username]]);
      }

      conversation = await IgConversation.create(convData);
      logger.info(`[dm-assistant] Created conversation for thread ${threadId}`);
    } else {
      await IgConversation.updateOne(
        { _id: conversation._id },
        { $set: { last_message_at: new Date() } },
      );
    }

    // Sync messages — deduplicate by count since scraped messages lack IG message IDs
    const existingCount = await IgMessage.countDocuments({ conversation_id: conversation._id });

    if (messages.length > existingCount) {
      const newMessages = messages.slice(existingCount);

      for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        const messageId = `scraped_${threadId}_${existingCount + i}_${Date.now()}`;

        await IgMessage.create({
          conversation_id: conversation._id,
          account_id: accountId,
          outbound_account_id: outboundAccountId || null,
          direction: msg.sender === "me" ? "outbound" : "inbound",
          sender_id: msg.sender === "me" ? "self" : "prospect",
          recipient_id: msg.sender === "me" ? "prospect" : "self",
          message_text: msg.text,
          message_id: messageId,
          timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
        });
      }

      if (newMessages.length > 0) {
        logger.info(`[dm-assistant] Synced ${newMessages.length} new messages for thread ${threadId}`);
      }
    }
  } catch (err) {
    logger.error("[dm-assistant] Message sync error:", err.message);
  }
}

module.exports = { analyzeConversation };
