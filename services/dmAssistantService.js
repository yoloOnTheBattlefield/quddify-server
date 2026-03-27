const OpenAI = require("openai");
const Account = require("../models/Account");
const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const OutboundLead = require("../models/OutboundLead");
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

const DM_SCRIPT_SYSTEM_PROMPT = `You are an expert Instagram DM sales assistant. Your job is to analyze the current conversation between a business owner (the sender, marked as "me") and a prospect (marked as "them"), determine the conversation phase, and suggest the next message the sender should send.

## CONVERSATION PHASES

**Phase 1 — Opener (Cold outreach)**
The first message has been sent. No reply yet.
- If no reply after 3+ days, suggest a casual follow-up (not pushy)
- If no reply after 7+ days, suggest a value-add follow-up (free insight, compliment on recent post)

**Phase 2 — Qualification (They replied)**
The prospect has responded to the opener. Goal: determine if they're a fit.
- Ask about their current situation, goals, or challenges
- Keep it conversational — short messages, one question at a time
- Mirror their energy and message length
- Look for signals: business type, revenue range, team size, current struggles

**Phase 3 — Probing (2-4 exchanges deep)**
You're in a back-and-forth. Goal: identify the core constraint/pain point.
- Ask deeper questions about what's holding them back
- Reference specific things they've mentioned
- Look for: time constraints, lack of systems, inconsistent results, scaling problems
- When they mention a number (revenue, clients, followers), probe deeper on it

**Phase 4 — Bridge (Constraint identified)**
A clear pain point or constraint has been identified. Goal: bridge to the Loom audit / call.
- Acknowledge their specific challenge
- Briefly mention how you/your team have solved this before
- Offer a free Loom audit or quick call — position it as "let me show you what I'd change"
- Keep it low-pressure: "No pitch, just want to show you what I'm seeing"

**Phase 5 — Booking (They're interested in the audit/call)**
They've expressed interest. Goal: lock in the booking.
- Send the booking link or ask for their preferred time
- Create gentle urgency without being pushy
- Confirm the details

## EDGE CASE HANDLING

**Short/low-effort replies** (e.g., "thanks", "ok", "interesting"):
- Don't match their low energy — slightly elevate it
- Ask a specific question to re-engage
- Reference something from their profile/bio if available

**Objections** (e.g., "I'm not interested", "I don't have time", "too expensive"):
- Acknowledge without being defensive
- Ask a clarifying question: "Totally fair — just curious, what's your current approach to [topic]?"
- If they're firm, exit gracefully

**Ghosting** (no reply in 3+ days after active conversation):
- Send a casual bump: reference the last topic, add new value
- After 2 ghosting follow-ups, suggest a "break-up" message

**They ask questions** (about pricing, process, results):
- Answer briefly but redirect to the call/audit for details
- Use social proof: "We just helped [type of client] achieve [result]"

**Corrections/misunderstandings**:
- Apologize briefly and correct course
- Don't over-explain

## OUTPUT FORMAT

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "phase": "Phase N — Name",
  "phase_reasoning": "Brief explanation of why this phase was detected",
  "suggestion": "The suggested message to send",
  "alternatives": ["Alternative message 1", "Alternative message 2"],
  "notes": "Any relevant notes for the sender (optional)"
}

## RULES
- Keep suggested messages SHORT (1-3 sentences max for DMs)
- Sound human, not corporate. No "I hope this message finds you well."
- Match the prospect's communication style (casual if they're casual, professional if they're professional)
- Never suggest sending links in the first few messages
- Never be pushy or salesy in early phases
- If prospect info (bio, name) is provided, use it naturally — don't force it
- If the conversation is clearly dead (firm rejection), suggest closing gracefully
- Always suggest ONE primary message and provide 2 shorter alternatives`;

// ── Conversation Analysis ──────────────────────────────

async function analyzeConversation({ accountId, threadId, messages, prospect, outboundAccountId }) {
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

  // Build conversation context for OpenAI
  const conversationText = messages.map((m) => {
    const sender = m.sender === "me" ? "ME" : "THEM";
    const time = m.timestamp ? ` [${m.timestamp}]` : "";
    return `${sender}${time}: ${m.text}`;
  }).join("\n");

  const prospectContext = [];
  if (prospect?.username) prospectContext.push(`Username: @${prospect.username}`);
  if (prospect?.displayName) prospectContext.push(`Display name: ${prospect.displayName}`);
  if (prospect?.bio) prospectContext.push(`Bio: ${prospect.bio}`);
  if (dbProspect?.bio) prospectContext.push(`Bio (from database): ${dbProspect.bio}`);
  if (dbProspect?.followersCount) prospectContext.push(`Followers: ${dbProspect.followersCount}`);
  if (dbProspect?.fullName && !prospect?.displayName) prospectContext.push(`Full name: ${dbProspect.fullName}`);

  const userPrompt = [
    "## PROSPECT INFO",
    prospectContext.length > 0 ? prospectContext.join("\n") : "No prospect info available",
    "",
    "## CONVERSATION HISTORY",
    conversationText || "No messages yet (conversation just opened)",
    "",
    "## CURRENT STATE",
    `Total messages: ${messages.length}`,
    `Last message by: ${messages.length > 0 ? messages[messages.length - 1].sender : "N/A"}`,
    messages.length > 0 && messages[messages.length - 1].timestamp
      ? `Last message time: ${messages[messages.length - 1].timestamp}`
      : "",
    "",
    "Analyze the conversation and suggest the next message.",
  ].join("\n");

  logger.info(`[dm-assistant] Analyzing thread ${threadId} (${messages.length} messages)`);

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: DM_SCRIPT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 1024,
    temperature: 0.7,
  });

  const content = response.choices[0]?.message?.content || "";

  // Parse JSON response
  let parsed;
  try {
    // Strip potential markdown code fences
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.warn("[dm-assistant] Failed to parse AI response as JSON, returning raw:", content.substring(0, 200));
    parsed = {
      phase: "Unknown",
      suggestion: content,
      alternatives: [],
      notes: "AI response was not in expected JSON format",
    };
  }

  return {
    suggestion: parsed.suggestion,
    phase: parsed.phase,
    phase_reasoning: parsed.phase_reasoning,
    alternatives: parsed.alternatives || [],
    notes: parsed.notes || null,
    thread_id: threadId,
  };
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
          // Also store the thread ID on the lead if not already set
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
      // Update last_message_at
      await IgConversation.updateOne(
        { _id: conversation._id },
        { $set: { last_message_at: new Date() } },
      );
    }

    // Sync messages — use a combination of text + approximate position as dedup key
    // since scraped messages don't have Instagram message IDs
    const existingCount = await IgMessage.countDocuments({ conversation_id: conversation._id });

    if (messages.length > existingCount) {
      // Only insert truly new messages (ones beyond what we already have)
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
    // Don't fail the whole analysis if sync fails
    logger.error("[dm-assistant] Message sync error:", err.message);
  }
}

module.exports = { analyzeConversation };
