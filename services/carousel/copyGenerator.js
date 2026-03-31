const Client = require("../../models/Client");
const SwipeFile = require("../../models/SwipeFile");
const CarouselTemplate = require("../../models/CarouselTemplate");
const { extractBestAngle } = require("./transcriptAnalyzer");
const { getPlaybook } = require("./copyPlaybook");
const { getClaudeClient, getOpenAIClient } = require("../../utils/aiClients");
const logger = require("../../utils/logger").child({ module: "copyGenerator" });

// ── Model config ──────────────────────────────────────────

const MODEL_MAP = {
  "claude-sonnet": { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  "claude-opus": { provider: "anthropic", model: "claude-opus-4-20250514" },
  "gpt-4o": { provider: "openai", model: "gpt-4o" },
};

// ── Prompt builders ──────────────────────────────────────

function buildSlideStructurePrompt(template) {
  if (!template?.content_structure?.slides?.length) {
    return `Generate a carousel with as many slides as needed to tell the story properly (up to 20 slides). Do NOT compress the story into fewer slides just to be brief. Each slide should contain one moment, one thought, or one beat. If a story needs 12 slides, use 12. If it needs 18, use 18. Short slides are fine — a single sentence on a slide is powerful.

The carousel MUST follow this emotional structure (expand each section with as many slides as needed):

HOOK (1-2 slides): Curiosity loop — moment or tension, NOT a lesson. Must leave an unresolved question.
TENSION (2-4 slides): Relatable struggle — build recognition. The reader should think "that's me." Use specific details, internal dialogue, sensory moments. Don't rush this section.
CONFLICT (2-4 slides): Deepen the pain — show what it cost them. Repeated failures, broken promises, the weight of staying stuck.
PATTERN INTERRUPT (1 slide): 3-7 words max, single short sentence that breaks rhythm. Still use an image (single_hero) — the short copy over a striking photo is more powerful than text-only.
TURNING POINT (1-2 slides): What shifted — a realization, decision, or moment of change.
TRANSFORMATION (2-4 slides): Proof it worked — use specific numbers, timelines, tangible results. Show both the external change and the internal feeling.
IDENTITY SHIFT (1-2 slides): Bridge from "I" to "you" — make the reader reflect on their own identity.
CTA (1 slide): Clear call to action.

Each slide should have 5-25 words. One idea per slide. Never compress two moments into one slide.`;
  }

  const slides = template.content_structure.slides
    .sort((a, b) => a.position - b.position)
    .map((s) => `Slide ${s.position}: ${s.role.toUpperCase()} — ${s.copy_instruction || "Write compelling copy for this slide"}${s.tone_note ? ` (tone: ${s.tone_note})` : ""}`)
    .join("\n");

  let prompt = `Generate a ${template.content_structure.slide_count}-slide carousel:\n${slides}`;
  if (template.content_structure.hook_formula) {
    prompt += `\n\nHook formula to follow: ${template.content_structure.hook_formula}`;
  }
  if (template.content_structure.cta_formula) {
    prompt += `\nCTA formula to follow: ${template.content_structure.cta_formula}`;
  }
  return prompt;
}

function buildStylePrompt(swipeFile) {
  if (!swipeFile?.style_profile) return "";

  const sp = swipeFile.style_profile;
  const parts = [];
  if (sp.hook_style) parts.push(`Hook style: ${sp.hook_style}`);
  if (sp.text_density) parts.push(`Text density: ${sp.text_density}`);
  if (sp.pacing) parts.push(`Pacing: ${sp.pacing}`);
  if (sp.headline_format) parts.push(`Headline format: ${sp.headline_format}`);
  if (sp.layout_rhythm) parts.push(`Layout rhythm: ${sp.layout_rhythm}`);
  if (sp.cta_pattern) parts.push(`CTA pattern: ${sp.cta_pattern}`);

  return parts.length ? `\n\nReference style guidelines:\n${parts.join("\n")}` : "";
}

// ── AI callers ──────────────────────────────────────────

async function callClaude({ accountId, clientId }, modelId, systemPrompt, userPrompt) {
  const claude = await getClaudeClient({ accountId, clientId });
  const response = await claude.messages.create({
    model: modelId,
    max_tokens: 2048,
    temperature: 0.4,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  let content = response.content?.[0]?.text;
  if (!content) throw new Error(`Empty response from Claude (${modelId})`);

  // Claude may wrap JSON in ```json ... ``` — strip it
  content = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(content);
}

async function callOpenAI({ accountId, clientId }, modelId, systemPrompt, userPrompt) {
  const openai = await getOpenAIClient({ accountId, clientId });
  const response = await openai.chat.completions.create({
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.4,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`Empty response from ${modelId}`);
  return JSON.parse(content);
}

// ── Main ──────────────────────────────────────────

/**
 * Generate carousel slide copy + caption.
 * @param {Object} opts
 * @param {string} opts.accountId
 * @param {string} opts.clientId
 * @param {string[]} opts.transcriptIds
 * @param {string} opts.goal
 * @param {string} [opts.swipeFileId]
 * @param {string} [opts.templateId]
 * @param {string} [opts.copyModel] - "claude-sonnet" | "claude-opus" | "gpt-4o"
 * @returns {{ slides: Array<{position, role, copy, why}>, caption, hashtags, strategy_notes, angle }}
 */
async function generateCopy({ accountId, clientId, transcriptIds, goal, swipeFileId, templateId, copyModel, stylePrompt: externalStylePrompt, layoutPreset }) {
  const modelKey = copyModel || "claude-sonnet";
  const modelConfig = MODEL_MAP[modelKey];
  if (!modelConfig) throw new Error(`Unknown copy model: ${modelKey}`);

  const [client, template, swipeFile] = await Promise.all([
    Client.findById(clientId),
    templateId ? CarouselTemplate.findById(templateId) : null,
    swipeFileId ? SwipeFile.findById(swipeFileId) : null,
  ]);

  if (!client) throw new Error(`Client ${clientId} not found`);

  // Extract best angle from transcripts (always GPT-4o — cheap and fast for angle picking)
  const clientNiche = client.niche || "fitness";
  const angle = await extractBestAngle(
    transcriptIds,
    client.voice_profile?.raw_text ? "as described in voice profile" : "confident and direct",
    clientNiche
  );

  const structurePrompt = buildSlideStructurePrompt(template);
  const stylePrompt = buildStylePrompt(swipeFile);

  const voiceProfile = client.voice_profile || {};
  const voiceInstructions = voiceProfile.raw_text || "";

  const ctaDefaults = client.cta_defaults || {};
  const ctaInstructions = ctaDefaults.cta_enabled !== false
    ? `Primary CTA: "${ctaDefaults.primary_cta || "Save this for later"}"${ctaDefaults.secondary_cta ? `\nSecondary CTA: "${ctaDefaults.secondary_cta}"` : ""}`
    : "No explicit CTA needed.";

  const goalDescriptions = {
    saveable_educational: "Maximize saves. Make it highly educational — give real value people want to bookmark.",
    polarizing_authority: "Be boldly opinionated. Take a strong stance that sparks debate and positions authority.",
    emotional_story: "Tell a compelling emotional story. Connect deeply through vulnerability and transformation.",
    conversion_focused: "Drive DMs and conversions. Agitate the problem, present the solution, make the next step obvious.",
  };

  const playbook = getPlaybook(goal);

  const systemPrompt = `You are an elite Instagram carousel copywriter trained by the best direct-response copywriters in the world. You don't write generic AI content — you write copy that stops scrolls, earns swipes, and drives action.

CRITICAL: You are ghostwriting as ${client.name}. All copy must be written in FIRST PERSON ("I", "my", "me"). Never refer to ${client.name} in third person. The audience must feel like ${client.name} wrote this themselves.

NICHE: ${clientNiche}. All content MUST be relevant to this niche. Do not generate content about other niches or topics outside of ${clientNiche}.

${playbook}

${voiceInstructions ? `\nCLIENT VOICE (match this exactly):\n${voiceInstructions}` : ""}${externalStylePrompt ? `\n\nCAROUSEL STYLE GUIDE (follow this exactly — it overrides default slide structure, pacing, and visual direction):\n${externalStylePrompt}` : ""}`;

  const userPrompt = `GOAL: ${goalDescriptions[goal] || goal}

CHOSEN ANGLE:
${angle.chosen_angle}
Type: ${angle.angle_type}
Why: ${angle.why_this_angle}

SUPPORTING CONTENT:
${angle.supporting_excerpts?.map((e) => `- "${e}"`).join("\n") || "No specific excerpts"}

HOOK OPTIONS (pick or improve the best one):
${angle.hook_options?.map((h, i) => `${i + 1}. ${h}`).join("\n") || "Generate hooks from the angle"}

${structurePrompt}${stylePrompt}

CTA:
${ctaInstructions}
${client.niche_playbook ? `\nNICHE-SPECIFIC PLAYBOOK (use this for niche-authentic language, pain points, and examples):\n${client.niche_playbook}` : ""}

AVAILABLE COMPOSITION TYPES:
- "single_hero" — one full-bleed portrait image, text overlaid. Most common.
- "split_collage" — main background image + 2-3 stacked inset photos on the right side
- "grid_2x2" — four equal quadrant images with text centered overlay
- "before_after" — two images split vertically, side by side
- "lifestyle_grid" — 4-photo grid showing success markers with text overlay
- "text_only" — bold text on solid/gradient background, no image. Use sparingly — only when the slide has zero visual context needed.

${layoutPreset?.mode === "uniform" ? `LAYOUT CONSTRAINT: You MUST use "${layoutPreset.default_composition || "single_hero"}" as the composition for ALL slides. Do not use any other composition type.` : layoutPreset?.mode === "sequence" && layoutPreset.sequence?.length ? `LAYOUT CONSTRAINT: You MUST use the following compositions for each slide position:\n${layoutPreset.sequence.map((s) => `- Slide ${s.position}: "${s.composition}"`).join("\n")}\nFor any slide positions not listed above, choose the best composition.` : `If a CAROUSEL STYLE GUIDE is provided above, use its composition recommendations. Otherwise default to "single_hero" for all slides, including pattern interrupts.`}

Return ONLY valid JSON (no markdown fencing, no extra text):
{
  "slides": [
    { "position": 1, "role": "hook", "composition": "single_hero", "copy": "...", "why": "Brief explanation of the copywriting technique used and why" },
    { "position": 2, "role": "pain", "composition": "single_hero", "copy": "...", "why": "e.g. 'Uses pain mirror to validate their struggle before offering the shift'" }
  ],
  "caption": "Full Instagram caption with line breaks. Include relevant hashtags inline or at the end.",
  "hashtags": ["relevant", "hashtags", "without_hash_symbol"],
  "strategy_notes": "2-3 sentences explaining the overall copywriting strategy: which hook formula was used, how slides create swipe momentum, and why this approach fits the goal."
}`;

  // Call the selected model
  let result;
  if (modelConfig.provider === "anthropic") {
    result = await callClaude({ accountId, clientId }, modelConfig.model, systemPrompt, userPrompt);
  } else {
    result = await callOpenAI({ accountId, clientId }, modelConfig.model, systemPrompt, userPrompt);
  }

  logger.info(`Generated copy for carousel: ${result.slides?.length} slides (${modelKey})`);

  return {
    slides: result.slides || [],
    caption: result.caption || "",
    hashtags: result.hashtags || [],
    strategy_notes: result.strategy_notes || "",
    angle,
  };
}

module.exports = { generateCopy };
