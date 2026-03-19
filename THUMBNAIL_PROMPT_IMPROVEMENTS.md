# Thumbnail Prompt Improvements

These are tested improvements to add incrementally to the thumbnail generation prompts. Each was validated against generated outputs. Add them one at a time to the prompt template in `services/thumbnailService.js`.

## Status: Not yet applied (reverted to original skill template)

---

## 1. No infographic overlays
**Problem:** AI generates emoji icons, charts, UI elements, clock circles, arrows, percentage graphics.
**Instruction:**
```
Limit graphic elements. Avoid infographic style icons, charts, or UI elements. Use at most 1 strong visual idea with minimal overlays.
```

## 2. Realistic backgrounds
**Problem:** Backgrounds look like AI blur plates — too clean, smooth, no noise.
**Instruction:**
```
Background should look like a real photo environment with natural imperfections such as uneven lighting, clutter, texture, or environmental noise. For gyms: include towels, water bottles, chalk, scuff marks.
```

## 3. One concept per frame
**Problem:** Each thumbnail tries to tell multiple stories with too many elements.
**Instruction:**
```
Focus on one clear visual concept per image. Do not combine multiple ideas in one frame.
```

## 4. No template compositions
**Problem:** Panel C always does the classic dark-side-vs-bright-side diagonal split.
**Instruction:**
```
Avoid template style comparisons like diagonal split transformations unless it looks like a real photo comparison.
```

## 5. Tighter framing
**Problem:** Subjects placed too safely, centered, full-body compositions.
**Instruction:**
```
Frame the subject like a real YouTube thumbnail. Slightly off-center, tighter crop, more face emphasis. Face or upper torso should dominate the frame.
```

## 6. Natural expressions
**Problem:** Exaggerated symmetrical stock reactions, empty shock faces.
**Instruction:**
```
Facial expressions should look natural and imperfect. Avoid exaggerated symmetrical reactions. Use subtle emotion with slight asymmetry.
```

## 7. Realistic lighting
**Problem:** Studio-perfect controlled lighting, no imperfections.
**Instruction:**
```
Use realistic photography lighting. Avoid glow effects, rim outlines, or artificial studio halos. Lighting should feel natural and imperfect, like a real camera shot.
```

## 8. Imperfect typography
**Problem:** Text perfectly aligned, perfectly spaced, too clean.
**Instruction:**
```
Typography should feel bold and slightly imperfect like real YouTube thumbnails. Not perfectly aligned or spaced.
```

## 9. No pure black backgrounds
**Problem:** Pure black backgrounds are a common AI signal.
**Instruction:**
```
Avoid pure black backgrounds. Include subtle environmental context or depth.
```

---

## Texture-level improvements (more subtle)

## 10. Skin texture
**Problem:** Skin too uniform, even color, no pores, clean gradients.
**Instruction:**
```
Skin must include visible pores, micro texture, slight redness, and natural uneven tone. No smooth airbrushed skin.
```

## 11. Sweat/shine for gym contexts
**Problem:** Skin too dry and perfect for workout imagery.
**Instruction:**
```
Add subtle natural skin shine or sweat appropriate for a gym environment.
```

## 12. Tattoo imperfections
**Problem:** Tattoo edges too crisp, uniform color.
**Instruction:**
```
Tattoos should show slight ink bleeding, uneven density, and faded spots like real healed tattoos.
```

## 13. Facial asymmetry
**Problem:** Faces still slightly too balanced/symmetrical.
**Instruction:**
```
Facial structure should include subtle natural asymmetry — one eyebrow slightly higher, small mouth asymmetry, uneven eye alignment.
```

## 14. Realistic depth of field
**Problem:** Background blur is uniform, synthetic looking.
**Instruction:**
```
Use realistic camera depth of field with varied blur. Objects at different distances should blur differently, not uniform background blur.
```

## 15. Natural eyes
**Problem:** Eyes overly sharp and reflective.
**Instruction:**
```
Eyes should look natural with soft reflections, not hyper sharp.
```

---

## Compositing approach (attempted, needs refinement)

We tried generating scenes WITHOUT a person and compositing the real headshot via Sharp. Issues:
- Lighting mismatch between subject and environment
- Clean cutout edges
- Color grading inconsistency
- No shadow interaction
- Depth of field mismatch

The Sharp-based color matching (sampling scene colors, adjusting headshot brightness/tint, adding directional shadow) partially worked but needs more sophistication. Consider revisiting with a proper background removal library or Gemini's native inpainting.

---

## YouTube Thumbnail Conversion System (reference)

Key principles from the conversion playbook:

### 3-Step Click Decision (1-2 seconds)
1. **Visual Stun Gun** — stops the scroll
2. **Title Value Hunt** — viewer reads title for value
3. **Visual Validation** — viewer looks back at thumbnail to confirm

### Simple Formula
Face + Big Text + Visual Object = most winning thumbnails

### 7 Stun Gun Triggers
1. Color contrast
2. Large face with emotion
3. Visually striking graphic
4. Large text or numbers
5. Arrows or circles
6. Aesthetic imagery
7. Collage layout

### Rules
- Maximum 3 elements
- Text complements title, never repeats it
- Green = good, Red = bad
- Avoid bottom-right (timestamp)
- Design for 1/16 phone size
- Test multiple thumbnails
