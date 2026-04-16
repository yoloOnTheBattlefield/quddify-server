const logger = require("../utils/logger").child({ module: "prospectProfiler" });
const ProspectProfile = require("../models/ProspectProfile");
const ClientImage = require("../models/ClientImage");
const { getClaudeClient } = require("../utils/aiClients");
const { emitToAccount } = require("./socketManager");

/**
 * Generate a structured prospect profile from scraped data.
 * Uses Claude Sonnet 4 to analyze captions, transcripts, bio, and image tags.
 */
async function generateProspectProfile(profileId, accountId) {
  const profile = await ProspectProfile.findById(profileId);
  if (!profile) throw new Error(`ProspectProfile ${profileId} not found`);

  try {
    const claude = await getClaudeClient({ accountId });

    // Build context from scraped data
    const captions = (profile.scraped_posts || [])
      .filter((p) => p.caption)
      .map((p) => ({
        caption: p.caption.slice(0, 500),
        likes: p.likes,
        comments: p.comments,
      }));

    const transcripts = (profile.scraped_reels || [])
      .filter((r) => r.transcript)
      .map((r) => ({
        transcript: r.transcript.slice(0, 1500),
        likes: r.likes,
        views: r.views,
      }));

    // Get image tag summaries for brand color inference
    const images = await ClientImage.find({
      prospect_profile_id: profileId,
      status: "ready",
    })
      .select("tags.color_palette tags.vibe tags.lighting quality_score")
      .lean();

    const imageTagSummary = images.map((img) => ({
      colors: img.tags?.color_palette || [],
      vibes: img.tags?.vibe || [],
      lighting: img.tags?.lighting || [],
    }));

    const systemPrompt = `You are an expert Instagram strategist analyzing a coach/creator's public profile to build a detailed profile for carousel content creation.

Analyze all provided data — bio, post captions with engagement metrics, reel transcripts with engagement, and image style tags — to build a comprehensive understanding of this person's brand, voice, and business.

Return ONLY valid JSON with this exact structure:
{
  "niche": "Specific niche description (e.g., 'MMA striking coach', 'online fitness coach for busy professionals')",
  "offer": "Their main product/program name. If multiple, pick the most promoted one. If unclear, say 'Unknown — needs manual input'",
  "audience": "One-line description of who they talk to (e.g., 'Amateur fighters who want to compete')",
  "core_message": "The recurring philosophy that runs through their content (e.g., 'Fight IQ beats brute force')",
  "voice_notes": "Detailed tone and style descriptors: sentence patterns, metaphors, energy level, communication style. Be specific enough to ghostwrite as this person.",
  "content_angles": ["Top 5 content themes/angles they use repeatedly"],
  "cta_style": {
    "mechanism": "comment_keyword" | "link_in_bio" | "dm_trigger" | "custom" | "uncertain",
    "detected_cta": "The exact CTA text they use (e.g., 'DM me READY', 'Link in bio')",
    "confidence": 0.0-1.0,
    "evidence": ["Specific captions/patterns that support this detection"]
  },
  "top_performing_angles": [
    { "angle": "Content angle description", "engagement_rate": 0.0 }
  ],
  "inferred_brand": {
    "primary_color": "#hexcode (dominant brand color from their feed aesthetic)",
    "secondary_color": "#hexcode",
    "accent_color": "#hexcode",
    "style_notes": "Visual style description (e.g., 'Dark, moody gym shots with high contrast')"
  }
}

CTA Detection Rules:
- "comment_keyword": They ask people to comment a specific word (e.g., "Comment FIRE below", "Drop a 🔥")
- "link_in_bio": They direct to a link in bio, landing page, or Linktree
- "dm_trigger": They ask for DMs (e.g., "DM me READY", "Send me a message")
- "custom": They have a unique CTA mechanism
- "uncertain": Can't confidently determine. Set confidence below 0.6.

Brand Color Rules:
- Infer from the overall visual aesthetic of their feed (image color palettes, moods)
- If their feed is dark/moody: dark primary, lighter accent
- If bright/clean: lighter primary, bold accent
- Default to black/white if truly unclear

Voice Notes Rules:
- Be extremely specific. Don't say "professional tone" — say "Direct, uses short declarative sentences, references specific fighters by name, combat metaphors, no-BS energy"
- Include: typical sentence length, vocabulary level, use of questions/commands, recurring phrases, emotional range`;

    const userPrompt = `PROSPECT: @${profile.ig_handle}
BIO: ${profile.ig_bio || "Not available"}
FOLLOWERS: ${profile.ig_followers_count || "Unknown"}

POST CAPTIONS (${captions.length} posts, sorted by engagement):
${captions
  .sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments))
  .map((c, i) => `[Post ${i + 1} — ${c.likes} likes, ${c.comments} comments]\n${c.caption}`)
  .join("\n\n")}

REEL TRANSCRIPTS (${transcripts.length} reels):
${transcripts
  .map((t, i) => `[Reel ${i + 1} — ${t.likes} likes, ${t.views} views]\n${t.transcript}`)
  .join("\n\n")}

IMAGE STYLE TAGS (from ${images.length} photos):
Color palettes: ${[...new Set(imageTagSummary.flatMap((i) => i.colors))].join(", ") || "N/A"}
Visual vibes: ${[...new Set(imageTagSummary.flatMap((i) => i.vibes))].join(", ") || "N/A"}
Lighting styles: ${[...new Set(imageTagSummary.flatMap((i) => i.lighting))].join(", ") || "N/A"}`;

    // Retry up to 3 times on transient errors (529 overloaded, 500, etc.)
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await claude.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          temperature: 0.3,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        });
        break;
      } catch (apiErr) {
        const status = apiErr.status || apiErr.statusCode;
        if ((status === 529 || status === 500 || status === 503) && attempt < 2) {
          logger.warn(`Claude API error (${status}), retrying in ${(attempt + 1) * 5}s... (attempt ${attempt + 1}/3)`);
          await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
          continue;
        }
        throw apiErr;
      }
    }

    let content = response.content?.[0]?.text;
    if (!content) throw new Error("Empty response from Claude");

    // Track Claude cost: Sonnet 4 = $3/1M input, $15/1M output
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const claudeCostUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

    content = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const result = JSON.parse(content);

    // Calculate generation time
    const generationTimeMs = profile.scrape_started_at
      ? Date.now() - new Date(profile.scrape_started_at).getTime()
      : null;

    // Add Claude cost to existing scrape costs
    const existingCost = (await ProspectProfile.findById(profileId).select("cost").lean())?.cost;
    const totalClaudeCost = (existingCost?.claude_usd || 0) + claudeCostUsd;

    await ProspectProfile.findByIdAndUpdate(profileId, {
      profile: {
        name: profile.profile?.name || profile.ig_handle,
        niche: result.niche,
        offer: result.offer,
        audience: result.audience,
        core_message: result.core_message,
        voice_notes: result.voice_notes,
        content_angles: result.content_angles || [],
        cta_style: result.cta_style || { mechanism: "uncertain", confidence: 0 },
        top_performing_angles: result.top_performing_angles || [],
      },
      inferred_brand: result.inferred_brand || {},
      generation_time_ms: generationTimeMs,
      "cost.claude_usd": Math.round(totalClaudeCost * 10000) / 10000,
      status: "ready",
      current_step: "complete",
      progress: 100,
    });

    logger.info(`Profile generation cost for @${profile.ig_handle}: Claude $${claudeCostUsd.toFixed(4)} (${inputTokens} in, ${outputTokens} out)`);

    emitToAccount(accountId, "outreach:scrape:progress", {
      profileId,
      step: "complete",
      progress: 100,
      message: "Profile ready",
    });

    logger.info(`Generated prospect profile for @${profile.ig_handle} in ${generationTimeMs}ms`);
    return result;
  } catch (err) {
    logger.error(`Profile generation failed for @${profile.ig_handle}:`, err);

    await ProspectProfile.findByIdAndUpdate(profileId, {
      status: "failed",
      error: err.message,
    });

    emitToAccount(accountId, "outreach:scrape:progress", {
      profileId,
      step: "failed",
      progress: 0,
      message: err.message,
    });

    throw err;
  }
}

module.exports = { generateProspectProfile };
