/**
 * Predefined tag vocabulary for image tagging and slide matching.
 * Constraining tags to a fixed set ensures the tagger and selector speak the same language.
 */

const TAG_VOCABULARY = {
  emotion: [
    "confident", "bold", "intense", "powerful", "determined",
    "focused", "serious", "thoughtful", "calm", "relaxed",
    "happy", "smiling", "joyful", "excited", "energetic",
    "vulnerable", "raw", "reflective", "tired", "frustrated",
    "stressed", "overwhelmed", "defeated", "anxious",
    "proud", "accomplished", "inspired", "grateful",
    "friendly", "warm", "approachable", "inviting",
  ],
  context: [
    "gym", "home", "outdoors", "office", "car", "studio",
    "stage", "restaurant", "cafe", "beach", "park", "street",
    "rooftop", "hotel", "airport", "classroom", "kitchen",
    "living_room", "bedroom", "bathroom", "garage", "pool",
  ],
  body_language: [
    "standing_tall", "arms_crossed", "leaning_in", "pointing",
    "hands_on_hips", "sitting", "walking", "running",
    "gesturing", "relaxed_posture", "power_pose", "hunched",
    "looking_away", "looking_at_camera", "profile", "back_turned",
  ],
  facial_expression: [
    "smiling", "serious", "determined", "neutral", "laughing",
    "frowning", "surprised", "pensive", "squinting", "intense_gaze",
    "soft_smile", "no_face_visible",
  ],
  setting: [
    "indoor", "outdoor", "studio_backdrop", "natural_environment",
    "urban", "rural", "professional_space", "casual_space",
    "luxury", "minimalist", "cluttered", "clean",
  ],
  clothing: [
    "athletic", "casual", "formal", "business_casual", "streetwear",
    "tank_top", "hoodie", "suit", "dress", "shirtless",
    "branded", "plain", "colorful", "dark_tones", "light_tones",
  ],
  activity: [
    "lifting", "exercising", "speaking", "presenting", "walking",
    "sitting", "eating", "cooking", "working", "typing",
    "posing", "stretching", "meditating", "driving", "reading",
    "filming", "taking_selfie", "laughing", "talking",
  ],
  vibe: [
    "authority", "aspirational", "motivational", "educational",
    "professional", "casual_lifestyle", "luxury", "raw_authentic",
    "vulnerable", "bold", "edgy", "clean_minimal", "warm",
    "high_energy", "peaceful", "gritty", "polished",
  ],
  lighting: [
    "natural_daylight", "golden_hour", "studio", "harsh",
    "soft", "dramatic", "backlit", "overhead", "dim",
    "neon", "fluorescent", "ring_light",
  ],
  color_palette: [
    "warm_tones", "cool_tones", "neutral_earth", "black_white",
    "vibrant_saturated", "muted_desaturated", "dark_moody",
    "bright_airy", "high_contrast", "monochromatic",
    "pastel", "neon_pop",
  ],
  composition: [
    "close_up", "medium_shot", "full_body", "wide_angle",
    "overhead_bird_eye", "low_angle", "symmetrical", "rule_of_thirds",
    "centered_subject", "negative_space", "cropped_tight", "environmental",
  ],
};

/**
 * Maps slide roles to preferred image traits.
 * Uses the 8-slide structure: hook, tension, conflict, pattern_interrupt,
 * turning_point, transformation, identity_shift, cta.
 */
const ROLE_IMAGE_PROFILE = {
  hook: {
    emotions: ["confident", "bold", "intense", "powerful", "determined"],
    vibes: ["authority", "bold", "edgy", "aspirational"],
    compositions: ["close_up", "medium_shot", "centered_subject"],
    energy_range: [60, 100],
    prefer_face: true,
    prefer_cover: true,
  },
  tension: {
    emotions: ["frustrated", "stressed", "tired", "overwhelmed", "serious"],
    vibes: ["raw_authentic", "vulnerable", "gritty"],
    compositions: ["close_up", "medium_shot", "cropped_tight"],
    energy_range: [30, 60],
    prefer_face: true,
    prefer_cover: false,
  },
  conflict: {
    emotions: ["anxious", "defeated", "overwhelmed", "frustrated", "vulnerable"],
    vibes: ["vulnerable", "raw_authentic", "gritty"],
    compositions: ["close_up", "cropped_tight", "low_angle"],
    energy_range: [20, 55],
    prefer_face: true,
    prefer_cover: false,
  },
  pattern_interrupt: {
    emotions: ["bold", "intense", "serious", "determined"],
    vibes: ["bold", "edgy", "high_energy"],
    compositions: ["wide_angle", "low_angle", "full_body", "environmental"],
    energy_range: [70, 100],
    prefer_face: false,
    prefer_cover: false,
  },
  turning_point: {
    emotions: ["thoughtful", "reflective", "calm", "focused", "determined"],
    vibes: ["raw_authentic", "motivational", "warm"],
    compositions: ["medium_shot", "negative_space", "rule_of_thirds"],
    energy_range: [30, 65],
    prefer_face: true,
    prefer_cover: false,
  },
  transformation: {
    emotions: ["proud", "accomplished", "happy", "energetic", "confident"],
    vibes: ["aspirational", "motivational", "polished", "luxury"],
    compositions: ["full_body", "medium_shot", "wide_angle"],
    energy_range: [60, 100],
    prefer_face: true,
    prefer_cover: false,
  },
  identity_shift: {
    emotions: ["inspired", "warm", "friendly", "approachable", "grateful"],
    vibes: ["warm", "motivational", "aspirational", "casual_lifestyle"],
    compositions: ["medium_shot", "environmental", "rule_of_thirds"],
    energy_range: [40, 75],
    prefer_face: true,
    prefer_cover: false,
  },
  cta: {
    emotions: ["friendly", "warm", "approachable", "inviting", "smiling"],
    vibes: ["warm", "professional", "clean_minimal"],
    compositions: ["close_up", "medium_shot", "centered_subject", "negative_space"],
    energy_range: [40, 70],
    prefer_face: true,
    prefer_cover: false,
  },
  // Fallbacks for custom template roles
  pain: {
    emotions: ["frustrated", "stressed", "tired", "overwhelmed"],
    vibes: ["raw_authentic", "vulnerable", "gritty"],
    compositions: ["close_up", "cropped_tight"],
    energy_range: [20, 50],
    prefer_face: true,
    prefer_cover: false,
  },
  agitate: {
    emotions: ["anxious", "defeated", "exhausted", "confused"],
    vibes: ["vulnerable", "gritty"],
    compositions: ["close_up", "cropped_tight", "low_angle"],
    energy_range: [15, 45],
    prefer_face: true,
    prefer_cover: false,
  },
  solution: {
    emotions: ["confident", "determined", "focused"],
    vibes: ["authority", "professional", "clean_minimal"],
    compositions: ["medium_shot", "centered_subject"],
    energy_range: [50, 80],
    prefer_face: true,
    prefer_cover: false,
  },
  proof: {
    emotions: ["proud", "accomplished", "confident"],
    vibes: ["aspirational", "polished", "authority"],
    compositions: ["medium_shot", "full_body", "environmental"],
    energy_range: [55, 85],
    prefer_face: true,
    prefer_cover: false,
  },
  teaching: {
    emotions: ["focused", "thoughtful", "serious"],
    vibes: ["educational", "professional", "authority"],
    compositions: ["medium_shot", "close_up", "centered_subject"],
    energy_range: [35, 65],
    prefer_face: true,
    prefer_cover: false,
  },
  bridge: {
    emotions: ["warm", "friendly", "approachable"],
    vibes: ["casual_lifestyle", "warm", "raw_authentic"],
    compositions: ["medium_shot", "environmental", "rule_of_thirds"],
    energy_range: [35, 65],
    prefer_face: true,
    prefer_cover: false,
  },
};

/**
 * Maps carousel goals to preferred vibes.
 */
const GOAL_VIBE_MAP = {
  saveable_educational: ["professional", "educational", "clean_minimal", "authority"],
  polarizing_authority: ["bold", "authority", "edgy", "high_energy"],
  emotional_story: ["vulnerable", "raw_authentic", "warm", "gritty"],
  conversion_focused: ["aspirational", "polished", "luxury", "authority"],
};

module.exports = { TAG_VOCABULARY, ROLE_IMAGE_PROFILE, GOAL_VIBE_MAP };
