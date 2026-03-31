const Transcript = require("../../models/Transcript");
const Client = require("../../models/Client");
const { getClaudeClient, getOpenAIClient } = require("../../utils/aiClients");
const logger = require("../../utils/logger").child({ module: "transcriptAnalyzer" });

// ── Speaker detection ────────────────────────────────────

/**
 * Detect speakers from Fathom transcript format.
 * Fathom uses: @0:00 - Speaker Name (email)
 * Uses the client's sales_rep_name to identify who is the coach vs. the prospect.
 * Returns { coach, lead } with detected names, or null if not found.
 */
function detectSpeakers(rawText, salesRepName = "Jorden") {
  const speakerMatches = rawText.match(/@[\d:]+ - ([^\n(]+)/g);
  if (!speakerMatches) return { coach: salesRepName, lead: null };

  const speakers = new Set();
  for (const match of speakerMatches) {
    const name = match.replace(/@[\d:]+ - /, "").replace(/\(.*\)/, "").trim();
    speakers.add(name);
  }

  const speakerList = [...speakers];
  const coach = speakerList.find((s) => s.toLowerCase().includes(salesRepName.toLowerCase())) || salesRepName;
  const lead = speakerList.find((s) => s !== coach) || null;

  return { coach, lead };
}

// ── Prompts ──────────────────────────────────────────────

function buildCleanupPrompt(coach, lead) {
  return `You are a transcript preprocessor. Clean up this raw call transcript.

SPEAKER IDENTIFICATION (CRITICAL):
- The COACH is "${coach}". He is asking questions and guiding the conversation.
- The LEAD/PROSPECT is "${lead || "the other person"}". They are answering questions and describing their situation.
- Keep speaker labels in the output so the next stage knows who said what.

Cleanup rules:
1. Remove filler words (um, uh, like, you know, sort of, kind of)
2. Remove off-topic chatter (greetings, small talk, scheduling, "can you hear me?")
3. Remove repeated/redundant sentences
4. Keep ALL substantive content from BOTH speakers — we need the coach's questions for context
5. Preserve the lead's authentic language and word choices exactly
6. Keep speaker labels (e.g., "@0:00 - Name") so we can tell who said what

Return ONLY the cleaned transcript text, nothing else. No commentary.`;
}

function buildExtractionPrompt(niche, coach, lead) {
  return `You are an expert content strategist who extracts Instagram carousel ideas from call transcripts.

CLIENT NICHE: ${niche}

SPEAKER IDENTIFICATION (CRITICAL):
- The COACH is "${coach}". He asks questions, shares his own stories/frameworks, and presents offers. IGNORE his personal stories, experiences, and pain points. They are NOT content for the carousel.
- The LEAD/PROSPECT is "${lead || "the other person"}". They describe their situation, struggles, desires, and objections. ALL extraction must come from what the LEAD said.
- When ${coach} shares a personal anecdote or story, do NOT extract it. It is rapport-building, not carousel content.
- Only extract from the lead's statements. The coach's questions can provide context but should never be the source of pain points, quotes, or stories.

Analyze this transcript and extract all content FROM THE LEAD that could be turned into high-performing Instagram carousels FOR THE ${niche.toUpperCase()} NICHE.

CRITICAL: Only extract content that is relevant to ${niche}. If the transcript contains content about multiple topics, prioritize and score ${niche}-related content higher. Ignore content about unrelated niches unless it can be reframed for ${niche}.

Return ONLY valid JSON with this exact structure:
{
  "lead_name": "${lead || "unknown"}",
  "pain_points": [{ "text": "description of the pain point", "strength": 1-10 }],
  "desires": [{ "text": "what they want to achieve", "strength": 1-10 }],
  "objections": [{ "text": "objection or resistance expressed", "strength": 1-10 }],
  "quotes": [{ "text": "exact notable quote from the LEAD only", "speaker": "${lead || "lead"}", "strength": 1-10 }],
  "story_moments": [{ "text": "story or anecdote THE LEAD told (not ${coach})", "emotional_weight": 1-10 }],
  "teaching_moments": [{ "text": "lesson or insight from the lead's experience", "clarity": 1-10 }],
  "cta_opportunities": [{ "text": "natural opportunity for a call-to-action", "fit": 1-10 }],
  "emotional_peaks": [{ "text": "moment of high emotion FROM THE LEAD", "emotion": "name of emotion", "intensity": 1-10 }],
  "topic_clusters": [{ "topic": "theme name", "excerpts": ["relevant excerpt from LEAD 1", "excerpt 2"], "strength": 1-10 }],
  "overall_strength": 0-100
}

Rules:
- EVERY quote, pain point, story, and emotional peak must come from ${lead || "the lead"}, NEVER from ${coach}
- Strength/intensity scores should reflect how usable the content is for ${niche} Instagram carousels
- Score content higher when it directly relates to ${niche} pain points, transformations, and experiences
- Score content lower when it is generic or off-niche
- Quotes should be word-for-word from the lead when possible
- Topic clusters should group related ideas that could form a single carousel
- overall_strength is your assessment of how much strong ${niche} carousel content this transcript contains (100 = goldmine, 0 = nothing usable)
- Be aggressive about finding content. Even weak transcripts usually have something
- Focus on content that would drive saves, DMs, and engagement on Instagram
- Prioritize pain points, objections, and teaching moments — these make the best carousels`;
}

// ── Stage 1: Cleanup via GPT-4o-mini (cheap) ────────────

async function cleanupTranscript(openai, rawText, callType, coach, lead) {
  const text = rawText.length > 120000
    ? rawText.slice(0, 120000) + "\n\n[TRUNCATED]"
    : rawText;

  const cleanupPrompt = buildCleanupPrompt(coach, lead);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: cleanupPrompt },
      { role: "user", content: `Call type: ${callType}\n\n--- RAW TRANSCRIPT ---\n\n${text}` },
    ],
    max_tokens: 8000,
    temperature: 0.1,
  });

  const cleaned = response.choices[0]?.message?.content;
  if (!cleaned) throw new Error("Empty response from GPT-4o-mini cleanup");

  const reduction = Math.round((1 - cleaned.length / rawText.length) * 100);
  logger.info(`Transcript cleanup: ${rawText.length} → ${cleaned.length} chars (${reduction}% reduction)`);

  return cleaned;
}

// ── Stage 2: Extraction via chosen model ─────────────────

async function extractWithOpenAI(openai, model, cleanedText, callType, niche, coach, lead) {
  const extractionPrompt = buildExtractionPrompt(niche, coach, lead);
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: extractionPrompt },
      { role: "user", content: `Call type: ${callType}\n\n--- TRANSCRIPT ---\n\n${cleanedText}` },
    ],
    max_tokens: 4096,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`Empty response from ${model}`);
  return JSON.parse(content);
}

async function extractWithClaude(claude, cleanedText, callType, niche, coach, lead) {
  const extractionPrompt = buildExtractionPrompt(niche, coach, lead);
  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${extractionPrompt}\n\n--- TRANSCRIPT ---\n\nCall type: ${callType}\n\n${cleanedText}`,
      },
    ],
  });

  const content = response.content[0]?.text;
  if (!content) throw new Error("Empty response from Claude");

  let jsonStr = content;
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1];
  return JSON.parse(jsonStr.trim());
}

// ── Main entry point ─────────────────────────────────────

/**
 * Analyze a transcript with a 2-stage pipeline:
 *   1. GPT-4o-mini cleans/condenses the raw text (cheap, fast)
 *   2. Chosen model does deep extraction on cleaner input
 *
 * @param {string} transcriptId
 * @param {string} [modelOverride] - "gpt-4o" | "gpt-4o-mini" | "claude-sonnet"
 */
async function analyzeTranscript(transcriptId, modelOverride) {
  const transcript = await Transcript.findById(transcriptId);
  if (!transcript) throw new Error(`Transcript ${transcriptId} not found`);

  const model = modelOverride || transcript.ai_model || "gpt-4o";

  try {
    await Transcript.findByIdAndUpdate(transcriptId, { status: "processing" });

    // Look up client for niche + sales rep name
    const client = await Client.findById(transcript.client_id);
    const niche = client?.niche || "fitness";
    const salesRepName = client?.sales_rep_name || "Jorden";

    // Detect speakers from Fathom format using client's sales rep name
    const { coach, lead } = detectSpeakers(transcript.raw_text, salesRepName);
    logger.info(`Detected speakers — Coach: "${coach}", Lead: "${lead || "unknown"}"`);

    // Stage 1: Always use GPT-4o-mini for cleanup (~$0.001)
    const openai = await getOpenAIClient({ accountId: transcript.account_id });
    const cleanedText = await cleanupTranscript(openai, transcript.raw_text, transcript.call_type, coach, lead);

    // Stage 2: Extract with chosen model (niche-aware, speaker-aware)
    let result;
    if (model === "claude-sonnet") {
      const claude = await getClaudeClient({ accountId: transcript.account_id });
      result = await extractWithClaude(claude, cleanedText, transcript.call_type, niche, coach, lead);
    } else {
      // "gpt-4o" or "gpt-4o-mini"
      result = await extractWithOpenAI(openai, model, cleanedText, transcript.call_type, niche, coach, lead);
    }

    await Transcript.findByIdAndUpdate(transcriptId, {
      $set: {
        extracted: {
          pain_points: result.pain_points || [],
          desires: result.desires || [],
          objections: result.objections || [],
          quotes: result.quotes || [],
          story_moments: result.story_moments || [],
          teaching_moments: result.teaching_moments || [],
          cta_opportunities: result.cta_opportunities || [],
          emotional_peaks: result.emotional_peaks || [],
          topic_clusters: result.topic_clusters || [],
        },
        overall_strength: result.overall_strength || 0,
        ai_model: model,
        status: "ready",
      },
    });

    logger.info(`Analyzed transcript ${transcriptId} with ${model}: strength=${result.overall_strength}`);
    return result;
  } catch (err) {
    logger.error(`Failed to analyze transcript ${transcriptId}:`, err);
    await Transcript.findByIdAndUpdate(transcriptId, { status: "failed" });
    throw err;
  }
}

// ── Best angle extraction (used during carousel generation) ──

async function extractBestAngle(transcriptIds, clientVoice, clientNiche) {
  const transcripts = await Transcript.find({ _id: { $in: transcriptIds }, status: "ready" });
  if (transcripts.length === 0) throw new Error("No ready transcripts found");

  const allPainPoints = transcripts.flatMap((t) => t.extracted?.pain_points || []);
  const allQuotes = transcripts.flatMap((t) => t.extracted?.quotes || []);
  const allObjections = transcripts.flatMap((t) => t.extracted?.objections || []);
  const allTeaching = transcripts.flatMap((t) => t.extracted?.teaching_moments || []);
  const allTopics = transcripts.flatMap((t) => t.extracted?.topic_clusters || []);
  const allStories = transcripts.flatMap((t) => t.extracted?.story_moments || []);

  const insightsSummary = JSON.stringify({
    pain_points: allPainPoints.sort((a, b) => b.strength - a.strength).slice(0, 10),
    quotes: allQuotes.sort((a, b) => b.strength - a.strength).slice(0, 8),
    objections: allObjections.sort((a, b) => b.strength - a.strength).slice(0, 8),
    teaching_moments: allTeaching.sort((a, b) => b.clarity - a.clarity).slice(0, 8),
    topic_clusters: allTopics.sort((a, b) => b.strength - a.strength).slice(0, 5),
    story_moments: allStories.sort((a, b) => b.emotional_weight - a.emotional_weight).slice(0, 5),
  }, null, 2);

  const prompt = `You are choosing the single best angle for an Instagram carousel.

Client niche: ${clientNiche}
Client voice: ${clientVoice}

Here are the extracted insights from their transcripts:

${insightsSummary}

Choose ONE strong carousel angle. Return JSON:
{
  "chosen_angle": "the specific angle/topic for the carousel",
  "angle_type": "pain_point|objection|teaching|story|quote",
  "supporting_excerpts": ["excerpt 1", "excerpt 2", "excerpt 3"],
  "hook_options": ["hook option 1", "hook option 2", "hook option 3"],
  "why_this_angle": "2 sentences on why this will perform well on Instagram"
}

Pick the angle most likely to drive saves and DMs. Be specific, not generic.`;

  // Use GPT-4o for angle extraction (always available via OPENAI env var)
  const accountId = transcripts[0].account_id;
  const openai = await getOpenAIClient({ accountId });

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1500,
    temperature: 0.3,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from GPT-4o angle extraction");
  return JSON.parse(content);
}

module.exports = { analyzeTranscript, extractBestAngle };
