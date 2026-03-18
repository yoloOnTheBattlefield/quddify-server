const express = require("express");
const router = express.Router();
const ThumbnailTemplate = require("../models/ThumbnailTemplate");
const logger = require("../utils/logger").child({ module: "thumbnail-templates" });

// Seed system defaults on first request
let seeded = false;
async function ensureSystemDefaults() {
  if (seeded) return;
  seeded = true;
  const count = await ThumbnailTemplate.countDocuments({ is_system: true });
  if (count > 0) return;

  const defaults = [
    {
      name: "Transformation Split",
      description: "Before/after with two faces, center text stack, arrow. Classic transformation result template.",
      is_system: true,
      layout: {
        person_position: "split",
        person_crop: "shoulders",
        person_frame_pct: 70,
        split: {
          enabled: true,
          left_expression: "neutral or slightly unhappy, representing the starting point or problem",
          right_expression: "smiling, confident, representing the result or outcome",
          arrow: true,
        },
        text_position: "center",
        text_stack: {
          enabled: true,
          top_line: "Small setup text (starting point)",
          middle_line: "The main result — biggest element, large bold number",
          bottom_line: "Time constraint or method",
        },
        background_style: "gradient",
        color_direction: "Red or dark gradient for urgency and contrast",
      },
      prompt_instructions: `LAYOUT: Transformation split thumbnail.

LEFT SIDE: Show the person with a neutral or slightly unhappy expression. This represents the starting point or problem. Crop at shoulders, face large and clear.

RIGHT SIDE: Show the same person with a confident, happy expression. This represents the result or outcome. Crop at shoulders, face large and clear.

Both faces should take about 70% of the thumbnail width total. Faces must be large enough to read on mobile.

CENTER TEXT (between the two faces): Use a 3-part text stack:
- Top line: small setup text (the starting point, e.g. "$0 TO" or "SKINNY")
- Middle line: THE MAIN RESULT in the biggest, boldest text. This is the most important element. (e.g. "$30K" or "JACKED")
- Bottom line: time constraint or method in smaller text (e.g. "IN 90 DAYS" or "16 WEEKS")

Add a small arrow or visual cue pointing from the left (problem) to the right (result).

BACKGROUND: Simple dark gradient or bold color (red creates urgency). High contrast with white text.

COMPOSITION: Simple. No extra objects. No clutter. Clear story in one second: problem → result.
White text on dark/red background for maximum mobile readability.`,
    },
    {
      name: "Face + Text Right",
      description: "Classic layout — large face on right, bold text on left with dark environment background.",
      is_system: true,
      layout: {
        person_position: "right",
        person_crop: "shoulders",
        person_frame_pct: 40,
        split: { enabled: false },
        text_position: "left",
        text_stack: { enabled: false },
        background_style: "dark-environment",
        color_direction: "Dark moody environment with accent colors",
      },
      prompt_instructions: `LAYOUT: Person on the right, text on the left.

PERSON: Place them on the right side of the frame, taking up approximately 40% of the width. Shoulders-up crop. Dramatic, natural lighting on their face.

TEXT (left side): 2-3 bold words in large, white, heavy sans-serif font. High contrast against the dark background. Text should trigger desire or curiosity — complement the title, never repeat it.

BACKGROUND: Dark, moody, cinematic real-world environment relevant to the topic. Not a solid void — real environmental detail and depth.

COMPOSITION: Person + text + background only. No graphic overlays or extra objects.`,
    },
    {
      name: "Big Number",
      description: "Dominant number/stat with face — number is the hero element.",
      is_system: true,
      layout: {
        person_position: "right",
        person_crop: "shoulders",
        person_frame_pct: 35,
        split: { enabled: false },
        text_position: "left",
        text_stack: { enabled: false },
        background_style: "dark-environment",
        color_direction: "Cool tones, high contrast",
      },
      prompt_instructions: `LAYOUT: Big number/stat as the dominant visual, person on the right.

PERSON: Place them on the right side, about 35% of frame width. Shoulders-up. Expression should match the emotion of the stat (excited for positive, concerned for negative).

TEXT (left side): A single large, bold number or stat that creates urgency or curiosity. This should be the BIGGEST element in the thumbnail. Use white or bright colored text. Heavy sans-serif font.

BACKGROUND: Dark environment. High contrast so the number pops.

COMPOSITION: Person + big number + background only. The number is the hero. No other graphics.`,
    },
    {
      name: "Center Face",
      description: "Face dominates center frame with text overlay — maximum face emphasis.",
      is_system: true,
      layout: {
        person_position: "center",
        person_crop: "face",
        person_frame_pct: 60,
        split: { enabled: false },
        text_position: "upper-left",
        text_stack: { enabled: false },
        background_style: "dark-environment",
        color_direction: "Dark with high contrast accent",
      },
      prompt_instructions: `LAYOUT: Face-dominant center composition.

PERSON: Place them in the center of the frame. Very tight crop — face fills 60%+ of the frame. Strong emotion and expression. Dramatic directional lighting.

TEXT: 1-2 bold words placed where they don't overlap the face (upper-left or lower area). Large, white, high contrast.

BACKGROUND: Dark, moody environment. Subtle — the face is the star.

COMPOSITION: Face + minimal text only. Maximum face emphasis. No graphics, no clutter.`,
    },
  ];

  await ThumbnailTemplate.insertMany(defaults);
  logger.info(`Seeded ${defaults.length} system thumbnail templates`);
}

// GET /api/thumbnail-templates
router.get("/", async (req, res) => {
  try {
    await ensureSystemDefaults();
    const filter = {
      $or: [{ account_id: req.account._id }, { is_system: true }],
    };
    const templates = await ThumbnailTemplate.find(filter).sort({ is_system: -1, created_at: -1 });
    res.json(templates);
  } catch (err) {
    logger.error("Failed to list thumbnail templates:", err);
    res.status(500).json({ error: "Failed to list thumbnail templates" });
  }
});

// POST /api/thumbnail-templates
router.post("/", async (req, res) => {
  try {
    const template = await ThumbnailTemplate.create({
      ...req.body,
      account_id: req.account._id,
      is_system: false,
    });
    res.status(201).json(template);
  } catch (err) {
    logger.error("Failed to create thumbnail template:", err);
    res.status(500).json({ error: "Failed to create thumbnail template" });
  }
});

// PATCH /api/thumbnail-templates/:id
router.patch("/:id", async (req, res) => {
  try {
    const template = await ThumbnailTemplate.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id, is_system: false },
      req.body,
      { new: true },
    );
    if (!template) return res.status(404).json({ error: "Template not found or is a system default" });
    res.json(template);
  } catch (err) {
    logger.error("Failed to update thumbnail template:", err);
    res.status(500).json({ error: "Failed to update thumbnail template" });
  }
});

// DELETE /api/thumbnail-templates/:id
router.delete("/:id", async (req, res) => {
  try {
    const template = await ThumbnailTemplate.findOneAndDelete({
      _id: req.params.id,
      account_id: req.account._id,
      is_system: false,
    });
    if (!template) return res.status(404).json({ error: "Template not found or is a system default" });
    res.json({ deleted: true });
  } catch (err) {
    logger.error("Failed to delete thumbnail template:", err);
    res.status(500).json({ error: "Failed to delete thumbnail template" });
  }
});

module.exports = router;
