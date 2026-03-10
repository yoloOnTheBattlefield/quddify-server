const Transcript = require("../../models/Transcript");
const logger = require("../../utils/logger").child({ module: "confidenceScorer" });

/**
 * Score the carousel across 11 confidence dimensions.
 * Returns a ConfidenceScore object matching the Carousel schema.
 *
 * @param {Object} opts
 * @param {Array} opts.slides - Generated slides with copy
 * @param {Array} opts.imageSelections - Image selection results
 * @param {string[]} opts.transcriptIds
 * @param {Object} opts.angle - The chosen angle from extractBestAngle
 * @param {string} opts.goal
 * @param {Object} opts.voiceProfile - Client voice profile
 * @param {Object} opts.ctaDefaults - Client CTA defaults
 * @param {Object} [opts.swipeFile] - Reference swipe file
 * @returns {Object} ConfidenceScore
 */
async function scoreCarousel({ slides, imageSelections, transcriptIds, angle, goal, voiceProfile, ctaDefaults, swipeFile }) {
  const scores = {};

  // 1. Transcript strength (0-100): How rich was the source material?
  const transcripts = await Transcript.find({ _id: { $in: transcriptIds } }).lean();
  const avgStrength = transcripts.reduce((sum, t) => sum + (t.extracted?.overall_strength || 0), 0) / (transcripts.length || 1);
  scores.transcript_strength = Math.round(avgStrength);

  // 2. Hook strength (0-100): Does the hook slide stop the scroll?
  const hookSlide = slides.find((s) => s.role === "hook");
  let hookScore = 50;
  if (hookSlide?.copy) {
    const copy = hookSlide.copy;
    // Short, punchy hooks score higher
    if (copy.length < 80) hookScore += 15;
    else if (copy.length < 120) hookScore += 5;
    // Questions hook well
    if (copy.includes("?")) hookScore += 10;
    // Numbers/specificity
    if (/\d/.test(copy)) hookScore += 10;
    // Strong opening words
    if (/^(stop|the|most|nobody|everyone|this|you|i |why|how|what)/i.test(copy)) hookScore += 10;
    // All caps words (emphasis)
    if (/\b[A-Z]{2,}\b/.test(copy)) hookScore += 5;
  }
  scores.hook_strength = Math.min(100, hookScore);

  // 3. Image-copy fit (0-100): How well do images match the slides?
  const matchedSlides = imageSelections.filter((s) => !s.needs_ai_image);
  const avgImageScore = matchedSlides.length > 0
    ? matchedSlides.reduce((sum, s) => sum + (s.score || 0), 0) / matchedSlides.length
    : 0;
  scores.image_copy_fit = Math.min(100, Math.round(avgImageScore));

  // 4. Brand fit (0-100): Is the voice profile well-defined?
  let brandScore = 40; // Base
  if (voiceProfile?.tone) brandScore += 15;
  if (voiceProfile?.vocabulary_level) brandScore += 10;
  if (voiceProfile?.phrases_to_use?.length) brandScore += 10;
  if (voiceProfile?.example_copy) brandScore += 15;
  if (voiceProfile?.personality_notes) brandScore += 10;
  scores.brand_fit = Math.min(100, brandScore);

  // 5. Style fit (0-100): Was a reference swipe file used?
  let styleScore = 50;
  if (swipeFile?.style_profile) {
    styleScore = 70;
    if (swipeFile.style_profile.slide_structure?.length) styleScore += 15;
    if (swipeFile.style_profile.hook_style) styleScore += 5;
    if (swipeFile.style_profile.pacing) styleScore += 5;
    if (swipeFile.engagement_score > 0) styleScore += 5;
  }
  scores.style_fit = Math.min(100, styleScore);

  // 6. Image quality average (0-100)
  const imagesWithScore = imageSelections.filter((s) => s.score > 0);
  scores.image_quality_avg = imagesWithScore.length > 0
    ? Math.round(imagesWithScore.reduce((sum, s) => sum + (s.score || 0), 0) / imagesWithScore.length)
    : 30;

  // 7. AI image ratio (0-100, higher = fewer AI images = better)
  const totalSlides = slides.length || 1;
  const aiImageCount = imageSelections.filter((s) => s.needs_ai_image || s.is_ai_generated).length;
  scores.ai_image_ratio = Math.round(((totalSlides - aiImageCount) / totalSlides) * 100);

  // 8. CTA fit (0-100)
  const ctaSlide = slides.find((s) => s.role === "cta");
  let ctaScore = 50;
  if (ctaSlide?.copy) {
    ctaScore = 65;
    if (ctaDefaults?.primary_cta && ctaSlide.copy.toLowerCase().includes(ctaDefaults.primary_cta.toLowerCase().substring(0, 10))) {
      ctaScore += 20;
    }
    // Has action words
    if (/\b(save|dm|comment|follow|click|tap|share|send|grab|get|join|start)\b/i.test(ctaSlide.copy)) {
      ctaScore += 15;
    }
  }
  scores.cta_fit = Math.min(100, ctaScore);

  // 9. Save potential (0-100): Based on goal alignment
  let saveScore = 50;
  if (goal === "saveable_educational") {
    const teachingSlides = slides.filter((s) => ["teaching", "solution", "proof"].includes(s.role));
    saveScore = 60 + Math.min(teachingSlides.length * 8, 30);
    if (slides.length >= 6) saveScore += 10; // Longer = more saveable
  } else if (goal === "emotional_story") {
    saveScore = 55;
  } else if (goal === "polarizing_authority") {
    saveScore = 60;
  }
  scores.save_potential = Math.min(100, saveScore);

  // 10. DM potential (0-100)
  let dmScore = 40;
  if (goal === "conversion_focused") {
    dmScore = 65;
    if (ctaSlide?.copy && /\b(dm|message|send)\b/i.test(ctaSlide.copy)) dmScore += 25;
  } else if (goal === "polarizing_authority") {
    dmScore = 55;
  }
  scores.dm_potential = Math.min(100, dmScore);

  // 11. Overall (weighted average)
  const weights = {
    transcript_strength: 0.10,
    hook_strength: 0.20,
    image_copy_fit: 0.10,
    brand_fit: 0.10,
    style_fit: 0.05,
    image_quality_avg: 0.10,
    ai_image_ratio: 0.05,
    cta_fit: 0.10,
    save_potential: 0.10,
    dm_potential: 0.10,
  };

  scores.overall = Math.round(
    Object.entries(weights).reduce((sum, [key, weight]) => sum + (scores[key] || 0) * weight, 0)
  );

  // Explanation
  const topDimensions = Object.entries(scores)
    .filter(([k]) => k !== "overall" && k !== "explanation")
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => k.replace(/_/g, " "));

  const weakDimensions = Object.entries(scores)
    .filter(([k]) => k !== "overall" && k !== "explanation")
    .sort(([, a], [, b]) => a - b)
    .slice(0, 2)
    .map(([k]) => k.replace(/_/g, " "));

  scores.explanation = `Overall ${scores.overall}/100. Strongest: ${topDimensions.join(", ")}. Could improve: ${weakDimensions.join(", ")}.`;

  logger.info(`Scored carousel: ${scores.overall}/100`);
  return scores;
}

module.exports = { scoreCarousel };
