const ClientImage = require("../../models/ClientImage");
const { ROLE_IMAGE_PROFILE, GOAL_VIBE_MAP } = require("./tagVocabulary");
const logger = require("../../utils/logger").child({ module: "imageSelector" });

/**
 * Score how well an image matches a slide's requirements.
 * Returns { score, reasons[] } for debugging/transparency.
 */
function scoreImageForSlide(image, slide, goal) {
  let score = 0;
  const reasons = [];

  const tags = image.tags || {};
  const role = slide.role || "";
  const profile = ROLE_IMAGE_PROFILE[role] || ROLE_IMAGE_PROFILE.hook;

  // ── Quality baseline (0-25) ──
  const qualityPts = (image.quality_score || 0) * 0.25;
  score += qualityPts;

  // ── Face visibility (0-15) ──
  if (profile.prefer_face) {
    const facePts = (image.face_visibility_score || 0) * 0.15;
    score += facePts;
    if (facePts >= 10) reasons.push("strong face visibility");
  }

  // ── Cover suitability for hook (0-10) ──
  if (profile.prefer_cover && image.suitable_as_cover) {
    score += 10;
    reasons.push("suitable as cover");
  }

  // ── Text safe zones (0-10) ──
  const zones = image.text_safe_zones || {};
  const safeZoneCount = [zones.top, zones.bottom, zones.left, zones.right].filter(Boolean).length;
  score += safeZoneCount * 2.5;
  if (safeZoneCount >= 2) reasons.push(`${safeZoneCount} text safe zones`);

  // ── Emotion matching (0-20) ──
  const emotionTags = tags.emotion || [];
  const targetEmotions = profile.emotions || [];
  const emotionMatches = emotionTags.filter((e) => targetEmotions.includes(e)).length;
  const emotionPts = Math.min(emotionMatches * 7, 20);
  score += emotionPts;
  if (emotionMatches > 0) {
    const matched = emotionTags.filter((e) => targetEmotions.includes(e));
    reasons.push(`emotion match: ${matched.join(", ")}`);
  }

  // ── Vibe matching for role (0-15) ──
  const vibeTags = tags.vibe || [];
  const targetVibes = profile.vibes || [];
  const vibeMatchesRole = vibeTags.filter((v) => targetVibes.includes(v)).length;
  const vibeRolePts = Math.min(vibeMatchesRole * 5, 15);
  score += vibeRolePts;
  if (vibeMatchesRole > 0) {
    const matched = vibeTags.filter((v) => targetVibes.includes(v));
    reasons.push(`vibe match (role): ${matched.join(", ")}`);
  }

  // ── Vibe matching for goal (0-10) ──
  const goalVibes = GOAL_VIBE_MAP[goal] || [];
  const vibeMatchesGoal = vibeTags.filter((v) => goalVibes.includes(v)).length;
  const vibeGoalPts = Math.min(vibeMatchesGoal * 3, 10);
  score += vibeGoalPts;
  if (vibeMatchesGoal > 0) {
    const matched = vibeTags.filter((v) => goalVibes.includes(v));
    reasons.push(`vibe match (goal): ${matched.join(", ")}`);
  }

  // ── Composition matching (0-10) ──
  const compositionTags = tags.composition || [];
  const targetCompositions = profile.compositions || [];
  const compMatches = compositionTags.filter((c) => targetCompositions.includes(c)).length;
  const compPts = Math.min(compMatches * 5, 10);
  score += compPts;
  if (compMatches > 0) {
    const matched = compositionTags.filter((c) => targetCompositions.includes(c));
    reasons.push(`composition match: ${matched.join(", ")}`);
  }

  // ── Energy level matching (0-10) ──
  const energyRange = profile.energy_range;
  if (energyRange && image.energy_level != null) {
    const [lo, hi] = energyRange;
    const energy = image.energy_level;
    if (energy >= lo && energy <= hi) {
      // Perfect range match
      score += 10;
      reasons.push(`energy ${energy} in range [${lo}-${hi}]`);
    } else {
      // Partial credit — deduct based on distance from range
      const dist = energy < lo ? lo - energy : energy - hi;
      const partial = Math.max(0, 10 - dist * 0.3);
      if (partial > 0) {
        score += partial;
      }
    }
  }

  // ── Activity/body language bonus (0-5) ──
  const activityTags = tags.activity || [];
  const bodyTags = tags.body_language || [];
  const allPhysical = [...activityTags, ...bodyTags];
  // Reward active/dynamic images for high-energy roles
  const dynamicRoles = ["hook", "transformation", "pattern_interrupt"];
  const dynamicActivities = ["lifting", "exercising", "speaking", "presenting", "power_pose", "standing_tall"];
  if (dynamicRoles.includes(role)) {
    const dynMatch = allPhysical.filter((t) => dynamicActivities.includes(t)).length;
    if (dynMatch > 0) {
      score += Math.min(dynMatch * 3, 5);
      reasons.push("dynamic pose/activity");
    }
  }

  // ── Portrait bonus (0-3) — carousels are 4:5 ──
  if (image.is_portrait) {
    score += 3;
  }

  // ── Reuse penalty (0 to -15) ──
  const uses = image.total_uses || 0;
  if (uses > 0) {
    score -= Math.min(uses * 3, 15);
    if (uses > 0) reasons.push(`used ${uses}x (penalty)`);
  }

  // ── Recency penalty (-5 if used in last 7 days) ──
  if (image.last_used_at) {
    const daysSinceUse = (Date.now() - new Date(image.last_used_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUse < 7) {
      score -= 5;
      reasons.push("used recently (penalty)");
    }
  }

  return { score: Math.max(0, score), reasons };
}

/**
 * Select the best image for each slide from the client's image library.
 * @param {Object} opts
 * @param {string} opts.clientId
 * @param {string} opts.accountId
 * @param {Array<{position, role, copy}>} opts.slides
 * @param {string} opts.goal
 * @param {string[]} [opts.excludeCarouselIds] - Carousel IDs to check for reuse
 * @returns {Array<{position, image_id, image_key, score, needs_ai_image}>}
 */
async function selectImages({ clientId, accountId, slides, goal, excludeCarouselIds = [] }) {
  // Fetch all ready images for this client
  const images = await ClientImage.find({
    client_id: clientId,
    account_id: accountId,
    status: "ready",
  }).lean();

  if (images.length === 0) {
    logger.warn(`No ready images found for client ${clientId}`);
    return slides.map((slide) => ({
      position: slide.position,
      image_id: null,
      image_key: null,
      score: 0,
      needs_ai_image: true,
    }));
  }

  const usedImageIds = new Set();
  const results = [];

  // Sort slides by importance: hook first, then CTA, then others
  const priorityOrder = { hook: 0, cta: 1 };
  const sortedSlides = [...slides].sort(
    (a, b) => (priorityOrder[a.role] ?? 5) - (priorityOrder[b.role] ?? 5)
  );

  for (const slide of sortedSlides) {
    const scored = images
      .filter((img) => !usedImageIds.has(img._id.toString()))
      .map((img) => {
        const { score, reasons } = scoreImageForSlide(img, slide, goal);
        return { image: img, score, reasons };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const MIN_SCORE = 15;

    if (best && best.score >= MIN_SCORE) {
      usedImageIds.add(best.image._id.toString());
      const reason = best.reasons.length > 0
        ? `Score ${Math.round(best.score)}: ${best.reasons.join(", ")}`
        : `Score ${Math.round(best.score)}`;
      results.push({
        position: slide.position,
        image_id: best.image._id,
        image_key: best.image.storage_key,
        thumbnail_key: best.image.thumbnail_key,
        score: best.score,
        needs_ai_image: false,
        image_selection_reason: reason,
      });
    } else {
      results.push({
        position: slide.position,
        image_id: null,
        image_key: null,
        score: 0,
        needs_ai_image: true,
        image_selection_reason: best
          ? `Best score ${Math.round(best.score)} below threshold (${MIN_SCORE})`
          : "No images available",
      });
    }
  }

  // Re-sort by position
  results.sort((a, b) => a.position - b.position);

  const matched = results.filter((r) => !r.needs_ai_image).length;
  const needsAi = results.filter((r) => r.needs_ai_image).length;
  logger.info(`Image selection: ${matched} matched, ${needsAi} need AI generation`);

  return results;
}

/**
 * Update image usage tracking after carousel is finalized.
 */
async function trackImageUsage(imageSelections, carouselId) {
  const updates = imageSelections
    .filter((s) => s.image_id)
    .map((s) =>
      ClientImage.findByIdAndUpdate(s.image_id, {
        $inc: { total_uses: 1 },
        $set: { last_used_at: new Date() },
        $addToSet: { used_in_carousels: carouselId },
      })
    );
  await Promise.all(updates);
}

module.exports = { selectImages, trackImageUsage, scoreImageForSlide };
