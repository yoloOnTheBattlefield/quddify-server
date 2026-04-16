const puppeteer = require("puppeteer");
const { getBuffer, upload } = require("../storageService");
const { parseCubeFile, applyLutToBuffer } = require("../lutParser");
const Client = require("../../models/Client");
const ClientImage = require("../../models/ClientImage");
const ClientLut = require("../../models/ClientLut");
const logger = require("../../utils/logger").child({ module: "slideRenderer" });

const SLIDE_WIDTH = 420;
const SLIDE_HEIGHT = 525;
const SCALE = 1080 / 420;

// ── Color system ──────────────────────────────────────

function hexToHSL(hex) {
  hex = (hex || "#e94560").replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

function derivePalette(primaryHex) {
  const hsl = hexToHSL(primaryHex);
  const isWarm = hsl.h < 60 || hsl.h > 300;
  return {
    primary: primaryHex || "#e94560",
    light: hslToHex(hsl.h, Math.min(hsl.s, 70), Math.min(hsl.l + 20, 80)),
    dark: hslToHex(hsl.h, Math.min(hsl.s + 10, 90), Math.max(hsl.l - 30, 15)),
    lightBg: isWarm ? "#FAF8F5" : "#F5F7FA",
    lightBorder: isWarm ? "#EDE9E3" : "#E2E6EC",
    darkBg: isWarm ? "#1A1918" : "#0F172A",
  };
}

// ── Background ──────────────────────────────────────

function getSlideBg(slide, index) {
  // Use AI-specified bg if available
  const bg = (slide.bg || "").toLowerCase();
  if (bg === "light" || bg === "dark" || bg === "gradient") return bg;
  // Fallback by role
  const role = (slide.role || "").toLowerCase().replace(/\s+/g, "_");
  const map = { hook: "light", problem: "dark", pain: "dark", tension: "dark", solution: "gradient", features: "light", details: "dark", "how-to": "light", steps: "light", cta: "gradient" };
  return map[role] || (index % 2 === 0 ? "light" : "dark");
}

function getBgCSS(bgType, palette) {
  if (bgType === "light") return `background:${palette.lightBg};`;
  if (bgType === "dark") return `background:${palette.darkBg};`;
  return `background:linear-gradient(165deg,${palette.dark} 0%,${palette.primary} 50%,${palette.light} 100%);`;
}

function getColors(bgType) {
  if (bgType === "light") return { heading: "var(--dark-bg)", body: "#8A8580", tag: "var(--primary)", border: "var(--light-border)" };
  return { heading: "#fff", body: "rgba(255,255,255,0.65)", tag: bgType === "dark" ? "var(--light)" : "rgba(255,255,255,0.6)", border: "rgba(255,255,255,0.08)" };
}

// ── Component HTML builders ──────────────────────────

function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function progressBarHTML(index, total, bgType) {
  const pct = ((index + 1) / total) * 100;
  const isLight = bgType === "light";
  const track = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)";
  const fill = isLight ? "var(--primary)" : "#fff";
  const label = isLight ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.4)";
  return `<div class="progress-bar"><div class="progress-track" style="background:${track}"><div class="progress-fill" style="width:${pct}%;background:${fill}"></div></div><span class="progress-label" style="color:${label}">${index + 1}/${total}</span></div>`;
}

function swipeArrowHTML(bgType) {
  const isLight = bgType === "light";
  const bg = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)";
  const stroke = isLight ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.35)";
  return `<div class="swipe-arrow" style="background:linear-gradient(to right,transparent,${bg})"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
}

function tagLabelHTML(text, colors, hasImage) {
  if (!text) return "";
  const shadow = hasImage ? "text-shadow:1px 1px 6px rgba(0,0,0,0.8);" : "";
  return `<div class="tag-label" style="color:${colors.tag};${shadow}">${esc(text)}</div>`;
}

function logoLockupHTML(name, bgType) {
  const initial = (name || "B")[0].toUpperCase();
  const nameColor = bgType === "light" ? "var(--dark-bg)" : "#fff";
  return `<div class="logo-lockup"><div class="logo-circle"><span>${initial}</span></div><span class="logo-name" style="color:${nameColor}">${esc(name)}</span></div>`;
}

function featuresHTML(features, colors) {
  if (!features || !features.length) return "";
  return `<div class="features">${features.map((f, i) =>
    `<div class="feature-row" style="border-bottom:${i < features.length - 1 ? `1px solid ${colors.border}` : "none"}">
      <span class="feature-icon" style="color:var(--primary)">${f.icon || "•"}</span>
      <div class="feature-text"><span class="feature-label" style="color:${colors.heading}">${esc(f.label)}</span><span class="feature-desc" style="color:${colors.body}">${esc(f.description || "")}</span></div>
    </div>`
  ).join("")}</div>`;
}

function stepsHTML(steps, colors) {
  if (!steps || !steps.length) return "";
  return `<div class="steps">${steps.map((s, i) =>
    `<div class="step-row" style="border-bottom:${i < steps.length - 1 ? `1px solid ${colors.border}` : "none"}">
      <span class="step-num">${String(i + 1).padStart(2, "0")}</span>
      <div class="step-text"><span class="step-title" style="color:${colors.heading}">${esc(s.title)}</span><span class="step-desc" style="color:${colors.body}">${esc(s.description || "")}</span></div>
    </div>`
  ).join("")}</div>`;
}

function pillsHTML(pills, bgType, hasImage) {
  if (!pills || !pills.length) return "";
  const isLight = bgType === "light";
  return `<div class="pills">${pills.map((p) => {
    if (p.strikethrough) {
      const border = hasImage ? "rgba(255,255,255,0.2)" : (isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)");
      const color = hasImage ? "rgba(255,255,255,0.6)" : (isLight ? "#8A8580" : "#6B6560");
      const bg = hasImage ? "rgba(0,0,0,0.4)" : "transparent";
      return `<span class="pill" style="background:${bg};border:1px solid ${border};color:${color};text-decoration:line-through;">${esc(p.label)}</span>`;
    }
    const bg = hasImage ? "rgba(0,0,0,0.4)" : (isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.06)");
    const color = hasImage ? "#fff" : (isLight ? "var(--primary)" : "var(--light)");
    return `<span class="pill" style="background:${bg};color:${color}">${esc(p.label)}</span>`;
  }).join("")}</div>`;
}

function quoteBoxHTML(quote, bgType, hasImage) {
  if (!quote) return "";
  const isLight = bgType === "light";
  const bg = hasImage ? "rgba(0,0,0,0.45)" : (isLight ? "rgba(0,0,0,0.04)" : "rgba(0,0,0,0.15)");
  const border = hasImage ? "rgba(255,255,255,0.15)" : (isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)");
  const labelColor = hasImage ? "rgba(255,255,255,0.5)" : (isLight ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.5)");
  const textColor = hasImage ? "#fff" : (isLight ? "#1a1a1a" : "#fff");
  return `<div class="quote-box" style="background:${bg};border:1px solid ${border}">
    <div class="quote-label" style="color:${labelColor}">${esc(quote.label || "")}</div>
    <div class="quote-text" style="color:${textColor}">&ldquo;${esc(quote.text)}&rdquo;</div>
  </div>`;
}

function ctaButtonHTML(text) {
  if (!text) return "";
  return `<div class="cta-wrap"><div class="cta-btn">${esc(text)}</div></div>`;
}

function bodyTextHTML(text, colors, hasImage) {
  if (!text) return "";
  const shadow = hasImage ? "text-shadow:1px 1px 4px rgba(0,0,0,0.6);" : "";
  return `<div class="body-text" style="color:${colors.body};${shadow}">${esc(text)}</div>`;
}

// ── Main slide builder ──────────────────────────────

function buildSlideHTML(slide, index, total, palette, brandName, imageData) {
  const bgType = getSlideBg(slide, index);
  const isLast = index === total - 1;
  const isFirst = index === 0;
  const isCTA = (slide.role || "").toLowerCase() === "cta";
  const isHook = (slide.role || "").toLowerCase() === "hook";
  const colors = getColors(bgType);
  const hFont = palette._headingFont;
  const bFont = palette._bodyFont;

  const isCenter = isHook || isCTA || bgType === "gradient";
  const hasStructured = slide.features || slide.steps;
  const justify = hasStructured ? "flex-end" : (isCenter ? "center" : "flex-end");

  // Background
  let bgCSS = getBgCSS(bgType, palette);
  let overlayHTML = "";
  const hasImage = imageData && slide.composition !== "text_only";
  if (hasImage) {
    bgCSS = `background-image:url(data:${imageData.mime};base64,${imageData.base64});background-size:cover;background-position:center;`;
    overlayHTML = `<div class="overlay"></div>`;
  }

  // Effective colors when image is present
  const effectiveBg = hasImage ? "dark" : bgType;
  const effectiveColors = hasImage ? getColors("dark") : colors;
  const headingColor = hasImage ? "#fff" : colors.heading;
  const textShadow = hasImage ? "text-shadow:2px 2px 8px rgba(0,0,0,0.8);" : "";

  // Build content blocks
  let content = "";
  if ((isFirst || isCTA) && brandName) content += logoLockupHTML(brandName, effectiveBg);
  const tagColors = hasImage ? { ...effectiveColors, tag: "rgba(255,255,255,0.85)" } : effectiveColors;
  content += tagLabelHTML(slide.tag, tagColors, hasImage);
  // Headline
  const copyLines = (slide.copy || "").split("\n").filter((l) => l.trim());
  content += copyLines.map((line) => `<div class="headline" style="color:${headingColor};${textShadow}">${esc(line)}</div>`).join("");
  // Body
  const bodyColors = hasImage ? { ...effectiveColors, body: "rgba(255,255,255,0.85)" } : effectiveColors;
  content += bodyTextHTML(slide.body, bodyColors, hasImage);
  // Rich content
  content += featuresHTML(slide.features, effectiveColors);
  content += stepsHTML(slide.steps, effectiveColors);
  content += pillsHTML(slide.pills, effectiveBg, hasImage);
  content += quoteBoxHTML(slide.quote, effectiveBg, hasImage);
  // CTA button
  if (isCTA) content += ctaButtonHTML(slide.cta_text || "Get Started");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(hFont)}:wght@300;400;600;700&family=${encodeURIComponent(bFont)}:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --primary:${palette.primary}; --light:${palette.light}; --dark:${palette.dark}; --light-bg:${palette.lightBg}; --light-border:${palette.lightBorder}; --dark-bg:${palette.darkBg}; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${SLIDE_WIDTH}px; height:${SLIDE_HEIGHT}px; overflow:hidden; font-family:'${bFont}',sans-serif; }
  .slide { width:${SLIDE_WIDTH}px; height:${SLIDE_HEIGHT}px; position:relative; overflow:hidden; ${bgCSS} }
  .overlay { position:absolute; inset:0; background:linear-gradient(to bottom,rgba(0,0,0,0.3) 0%,rgba(0,0,0,0.45) 40%,rgba(0,0,0,0.7) 100%); z-index:1; }
  .content { position:absolute; inset:0; z-index:5; display:flex; flex-direction:column; padding:36px 36px 52px; justify-content:${justify}; }

  /* Typography */
  .headline { font-family:'${hFont}',serif; font-size:28px; font-weight:600; letter-spacing:-0.4px; line-height:1.12; margin-bottom:6px; }
  .body-text { font-size:14px; font-weight:400; line-height:1.52; margin-top:10px; }
  .tag-label { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; margin-bottom:16px; }

  /* Logo lockup */
  .logo-lockup { display:flex; align-items:center; gap:12px; margin-bottom:20px; }
  .logo-circle { width:40px; height:40px; border-radius:50%; background:var(--primary); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .logo-circle span { color:#fff; font-size:18px; font-weight:600; }
  .logo-name { font-size:13px; font-weight:600; letter-spacing:0.5px; }

  /* Progress bar */
  .progress-bar { position:absolute; bottom:0; left:0; right:0; padding:16px 28px 20px; z-index:10; display:flex; align-items:center; gap:10px; }
  .progress-track { flex:1; height:3px; border-radius:2px; overflow:hidden; }
  .progress-fill { height:100%; border-radius:2px; }
  .progress-label { font-size:11px; font-weight:500; }

  /* Swipe arrow */
  .swipe-arrow { position:absolute; right:0; top:0; bottom:0; width:48px; z-index:9; display:flex; align-items:center; justify-content:center; }

  /* Features */
  .features { margin-top:16px; width:100%; }
  .feature-row { display:flex; align-items:flex-start; gap:14px; padding:10px 0; }
  .feature-icon { font-size:15px; width:18px; text-align:center; flex-shrink:0; line-height:22px; }
  .feature-text { display:flex; flex-direction:column; }
  .feature-label { font-size:14px; font-weight:600; }
  .feature-desc { font-size:12px; margin-top:2px; }

  /* Steps */
  .steps { margin-top:16px; width:100%; }
  .step-row { display:flex; align-items:flex-start; gap:16px; padding:14px 0; }
  .step-num { font-family:'${hFont}',serif; font-size:26px; font-weight:300; color:var(--primary); min-width:34px; line-height:1; flex-shrink:0; }
  .step-text { display:flex; flex-direction:column; }
  .step-title { font-size:14px; font-weight:600; }
  .step-desc { font-size:12px; margin-top:2px; }

  /* Pills */
  .pills { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
  .pill { font-size:11px; padding:5px 12px; border-radius:20px; white-space:nowrap; }

  /* Quote box */
  .quote-box { padding:16px; border-radius:12px; margin-top:16px; }
  .quote-label { font-size:13px; margin-bottom:6px; }
  .quote-text { font-family:'${hFont}',serif; font-size:15px; font-style:italic; line-height:1.4; }

  /* CTA button */
  .cta-wrap { display:flex; justify-content:center; margin-top:24px; }
  .cta-btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:12px 28px; background:var(--light-bg); color:var(--dark); font-weight:600; font-size:14px; border-radius:28px; text-align:center; }
</style>
</head><body>
<div class="slide">
  ${overlayHTML}
  <div class="content">${content}</div>
  ${progressBarHTML(index, total, hasImage ? "dark" : bgType)}
  ${!isLast ? swipeArrowHTML(hasImage ? "dark" : bgType) : ""}
</div>
</body></html>`;
}

// ── Image loading ──────────────────────────────────────

async function loadImage(key, lutData, lutSize) {
  let buffer = await getBuffer(key);
  let mime = key.endsWith(".png") ? "image/png" : "image/jpeg";
  if (lutData && lutSize) {
    try { buffer = await applyLutToBuffer(buffer, lutData, lutSize); mime = "image/png"; }
    catch (err) { logger.warn(`LUT failed for ${key}: ${err.message}`); }
  }
  return { base64: buffer.toString("base64"), mime };
}

// ── Puppeteer rendering ──────────────────────────────

async function renderSlideToBuffer(browser, html) {
  const page = await browser.newPage();
  await page.setViewport({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, deviceScaleFactor: SCALE });
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]));
  const buffer = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT } });
  await page.close();
  return buffer;
}

// ── Main ──────────────────────────────────────

async function renderSlides({ carouselId, clientId, accountId, slides, imageSelections, templateId, lutId, showBrandName = false, brandKitOverride }) {
  const [client, lutDoc] = await Promise.all([
    brandKitOverride ? null : Client.findById(clientId),
    lutId ? ClientLut.findById(lutId) : null,
  ]);

  let lutData = null, lutSize = 0;
  if (lutDoc) {
    try {
      const lutBuffer = await getBuffer(lutDoc.storage_key);
      const parsed = parseCubeFile(lutBuffer.toString("utf-8"));
      lutData = parsed.data; lutSize = parsed.size;
    } catch (err) { logger.warn(`Could not load LUT ${lutId}: ${err.message}`); }
  }

  const brandKit = brandKitOverride || client?.brand_kit || {};
  const palette = derivePalette(brandKit.primary_color);
  palette._headingFont = brandKit.font_heading || "Playfair Display";
  palette._bodyFont = brandKit.font_body || "DM Sans";
  const brandName = showBrandName ? (brandKitOverride?.name || client?.name || "") : "";

  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
    const results = [];

    for (const slide of slides) {
      const selection = imageSelections.find((s) => s.position === slide.position);
      const index = slide.position - 1;

      let imageData = null;
      if (selection?.image_key && slide.composition !== "text_only") {
        try { imageData = await loadImage(selection.image_key, lutData, lutSize); }
        catch (err) { logger.warn(`Could not load image for slide ${slide.position}: ${err.message}`); }
      }

      const html = buildSlideHTML(slide, index, slides.length, palette, brandName, imageData);
      const pngBuffer = await renderSlideToBuffer(browser, html);
      const key = `carousels/${carouselId}/slide-${slide.position}.png`;
      await upload(key, pngBuffer, "image/png");
      results.push({ position: slide.position, rendered_key: key, size: pngBuffer.length });
      logger.info(`Rendered slide ${slide.position} [${slide.role}] (${pngBuffer.length} bytes)`);
    }
    return results;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { renderSlides };
