const ClientImage = require("../../models/ClientImage");
const { ROLE_IMAGE_PROFILE, GOAL_VIBE_MAP } = require("./tagVocabulary");
const logger = require("../../utils/logger").child({ module: "imageSelector" });

/**
 * Weighted random pick from scored candidates.
 * Higher-scored images are more likely to be chosen but not guaranteed,
 * giving variety while still favoring quality.
 */
function weightedRandomPick(candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const totalScore = candidates.reduce((sum, c) => sum + c.score, 0);
  let rand = Math.random() * totalScore;
  for (const candidate of candidates) {
    rand -= candidate.score;
    if (rand <= 0) return candidate;
  }
  return candidates[0];
}

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

  // ── Untagged images (e.g. prospect scrape without tagging) get a baseline ──
  const isUntagged = !image.quality_score && (!tags.emotion || tags.emotion.length === 0);
  if (isUntagged) {
    // Give a flat score so they pass MIN_SCORE and are selected round-robin
    score = 20;
    if (image.is_portrait) { score += 5; reasons.push("portrait"); }
    reasons.push("untagged — baseline score");
    // Jitter + recency/reuse penalties applied below (fall through)
  }

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

  // ── Reuse penalty (0 to -30) ──
  const uses = image.total_uses || 0;
  if (uses > 0) {
    score -= Math.min(uses * 5, 30);
    reasons.push(`used ${uses}x (penalty)`);
  }

  // ── Recency penalty (graduated — stronger the more recent) ──
  if (image.last_used_at) {
    const daysSinceUse = (Date.now() - new Date(image.last_used_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUse < 3) {
      score -= 25;
      reasons.push("used in last 3 days (heavy penalty)");
    } else if (daysSinceUse < 7) {
      score -= 15;
      reasons.push("used in last 7 days (penalty)");
    } else if (daysSinceUse < 14) {
      score -= 8;
      reasons.push("used in last 14 days (light penalty)");
    }
  }

  // ── Random jitter so equally-scored images rotate (0-8) ──
  score += Math.random() * 8;

  return { score: Math.max(0, score), reasons };
}

// How many images each composition type needs
const IMAGES_NEEDED = {
  single_hero: 1,
  text_only: 0,
  split_collage: 4,
  grid_2x2: 4,
  before_after: 2,
  lifestyle_grid: 4,
};

/**
 * Select the best image(s) for each slide from the client's image library.
 * For multi-image compositions, selects additional scored images.
 * @param {Object} opts
 * @param {string} opts.clientId
 * @param {string} opts.accountId
 * @param {Array<{position, role, copy, composition}>} opts.slides
 * @param {string} opts.goal
 * @param {string[]} [opts.excludeCarouselIds] - Carousel IDs to check for reuse
 * @returns {Array<{position, image_id, image_key, score, needs_ai_image, extra_image_ids, extra_image_keys}>}
 */
async function selectImages({ clientId, accountId, slides, goal, excludeCarouselIds = [], imageFilter }) {
  // Fetch all ready images — use custom filter for outreach (prospect images) or default to client images
  const filter = imageFilter || {
    client_id: clientId,
    account_id: accountId,
    status: "ready",
    source: { $ne: "prospect_scrape" },
  };
  const images = await ClientImage.find(filter).lean();

  if (images.length === 0) {
    logger.warn(`No ready images found for client ${clientId}`);
    return slides.map((slide) => ({
      position: slide.position,
      image_id: null,
      image_key: null,
      extra_image_ids: [],
      extra_image_keys: [],
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
    const composition = slide.composition || "single_hero";
    const needed = IMAGES_NEEDED[composition] || 1;

    // Text-only slides don't need images
    if (composition === "text_only") {
      results.push({
        position: slide.position,
        image_id: null,
        image_key: null,
        extra_image_ids: [],
        extra_image_keys: [],
        score: 100,
        needs_ai_image: false,
        image_selection_reason: "Text-only composition — no image needed",
      });
      continue;
    }

    const scored = images
      .filter((img) => !usedImageIds.has(img._id.toString()))
      .map((img) => {
        const { score, reasons } = scoreImageForSlide(img, slide, goal);
        return { image: img, score, reasons };
      })
      .sort((a, b) => b.score - a.score);

    // Pick from top candidates weighted by score instead of always taking #1
    const MIN_SCORE = 15;
    const topCandidates = scored.filter((s) => s.score >= MIN_SCORE).slice(0, 5);
    const best = weightedRandomPick(topCandidates);

    if (best && best.score >= MIN_SCORE) {
      usedImageIds.add(best.image._id.toString());
      const reason = best.reasons.length > 0
        ? `Score ${Math.round(best.score)}: ${best.reasons.join(", ")}`
        : `Score ${Math.round(best.score)}`;

      // Select extra images for multi-image compositions
      const extraImageIds = [];
      const extraImageKeys = [];
      if (needed > 1) {
        const extraCandidates = scored.slice(1).filter((s) => s.score >= MIN_SCORE && !usedImageIds.has(s.image._id.toString()));
        const extraCount = Math.min(needed - 1, extraCandidates.length);
        for (let i = 0; i < extraCount; i++) {
          usedImageIds.add(extraCandidates[i].image._id.toString());
          extraImageIds.push(extraCandidates[i].image._id);
          extraImageKeys.push(extraCandidates[i].image.storage_key);
        }
      }

      results.push({
        position: slide.position,
        image_id: best.image._id,
        image_key: best.image.storage_key,
        thumbnail_key: best.image.thumbnail_key,
        extra_image_ids: extraImageIds,
        extra_image_keys: extraImageKeys,
        score: best.score,
        needs_ai_image: false,
        image_selection_reason: reason,
      });
    } else {
      results.push({
        position: slide.position,
        image_id: null,
        image_key: null,
        extra_image_ids: [],
        extra_image_keys: [],
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
