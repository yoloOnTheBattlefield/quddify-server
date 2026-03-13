const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const { getBuffer, upload, getFilePath } = require("../storageService");
const { parseCubeFile, applyLutToBuffer } = require("../lutParser");
const Client = require("../../models/Client");
const ClientImage = require("../../models/ClientImage");
const ClientLut = require("../../models/ClientLut");
const CarouselTemplate = require("../../models/CarouselTemplate");
const logger = require("../../utils/logger").child({ module: "slideRenderer" });

const SLIDE_WIDTH = 1080;
const SLIDE_HEIGHT = 1350;

// ── Shared helpers ──────────────────────────────────────

function formatCopy(copy) {
  return (copy || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<span class="line">${l}</span>`)
    .join("");
}

function imgCSS(base64, mime) {
  if (!base64) return "";
  return `background-image: url(data:${mime || "image/jpeg"};base64,${base64}); background-size: cover; background-position: center;`;
}

function fontLinks(fontHeading, fontBody) {
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=${fontHeading.replace(/ /g, "+")}:wght@400;600;800&family=${fontBody.replace(/ /g, "+")}:wght@400;600;700&display=swap" rel="stylesheet">`;
}

function sharedCSS(brandKit, textStyle, fontHeading, fontBody) {
  const bk = brandKit || {};
  const accentColor = bk.accent_color || "#e94560";
  const textLight = bk.text_color_light || "#ffffff";
  const fontSize = { large: "64px", medium: "48px", small: "36px" }[textStyle.size || "medium"];
  const fontWeight = { bold: "800", semibold: "600", normal: "400" }[textStyle.weight || "bold"];
  const textTransform = textStyle.case === "uppercase" ? "uppercase" : "none";

  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; overflow: hidden; font-family: '${fontBody}', sans-serif; }
    .slide { width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; position: relative; overflow: hidden; }
    .overlay { position: absolute; inset: 0; z-index: 1; }
    .text-container { position: relative; z-index: 2; padding: 60px 80px; display: flex; flex-direction: column; gap: 16px; }
    .line { display: block; font-family: '${fontHeading}', sans-serif; font-size: ${fontSize}; font-weight: ${fontWeight}; text-transform: ${textTransform}; color: ${textLight}; line-height: 1.2; letter-spacing: -0.02em; margin-bottom: 12px; }
    .slide-number { position: absolute; bottom: 40px; right: 50px; font-family: '${fontBody}', sans-serif; font-size: 20px; color: rgba(255,255,255,0.4); z-index: 2; }
    .accent-bar { width: 60px; height: 5px; background: ${accentColor}; border-radius: 3px; margin-bottom: 20px; }
    .cta-badge { display: inline-block; background: ${accentColor}; color: ${textLight}; font-family: '${fontBody}', sans-serif; font-size: 28px; font-weight: 700; padding: 16px 40px; border-radius: 12px; margin-top: 24px; text-align: center; }
  `;
}

function wrap(head, body, slide) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${body}<div class="slide-number">${slide.position}</div></body></html>`;
}

// ── Composition builders ──────────────────────────────────────

function buildSingleHero(slide, brandKit, vs, images, fontHeading, fontBody) {
  const bk = brandKit || {};
  const primaryColor = bk.primary_color || "#1a1a2e";
  const secondaryColor = bk.secondary_color || "#16213e";
  const accentColor = bk.accent_color || "#e94560";
  const overlayOpacity = vs.overlay_opacity ?? 0.55;
  const textPosition = vs.text_position || "center";
  const textStyle = vs.text_style || {};
  const textAlign = textStyle.alignment || "center";
  const img = images[0];

  const posMap = {
    center: "align-items: center; justify-content: center;",
    top: "align-items: flex-start; justify-content: center; padding-top: 120px;",
    bottom: "align-items: flex-end; justify-content: center; padding-bottom: 120px;",
    left: "align-items: center; justify-content: flex-start; padding-left: 80px;",
    right: "align-items: center; justify-content: flex-end; padding-right: 80px;",
  };

  const hookBar = slide.role === "hook"
    ? `<div class="accent-bar" style="margin: 0 ${textAlign === "center" ? "auto" : "0"} 20px;"></div>`
    : "";
  const ctaBadge = slide.role === "cta" ? '<div class="cta-badge">Get Started</div>' : "";

  return wrap(
    `${fontLinks(fontHeading, fontBody)}<style>
      ${sharedCSS(brandKit, textStyle, fontHeading, fontBody)}
      .slide { display: flex; flex-direction: column; ${posMap[textPosition] || posMap.center}
        ${img ? imgCSS(img.base64, img.mime) : `background: linear-gradient(135deg, ${primaryColor} 0%, ${secondaryColor} 100%);`} }
      .text-container { text-align: ${textAlign}; }
    </style>`,
    `<div class="slide">
      ${img ? `<div class="overlay" style="background: rgba(0,0,0,${overlayOpacity});"></div>` : ""}
      <div class="text-container">${hookBar}${formatCopy(slide.copy)}${ctaBadge}</div>
    </div>`,
    slide,
  );
}

function buildTextOnly(slide, brandKit, vs, _images, fontHeading, fontBody) {
  const bk = brandKit || {};
  const primaryColor = bk.primary_color || "#1a1a2e";
  const secondaryColor = bk.secondary_color || "#16213e";
  const accentColor = bk.accent_color || "#e94560";
  const textStyle = vs.text_style || {};

  return wrap(
    `${fontLinks(fontHeading, fontBody)}<style>
      ${sharedCSS(brandKit, textStyle, fontHeading, fontBody)}
      .slide { display: flex; flex-direction: column; align-items: center; justify-content: center;
        background: linear-gradient(135deg, ${primaryColor} 0%, ${secondaryColor} 100%); }
      .text-container { text-align: center; max-width: 900px; }
      .line { font-size: 72px; font-weight: 800; }
      .accent-line { width: 80px; height: 6px; background: ${accentColor}; border-radius: 3px; margin: 0 auto 30px; }
    </style>`,
    `<div class="slide">
      <div class="text-container"><div class="accent-line"></div>${formatCopy(slide.copy)}</div>
    </div>`,
    slide,
  );
}

function buildSplitCollage(slide, brandKit, vs, images, fontHeading, fontBody) {
  const bk = brandKit || {};
  const primaryColor = bk.primary_color || "#1a1a2e";
  const overlayOpacity = vs.overlay_opacity ?? 0.55;
  const textStyle = vs.text_style || {};
  const mainImg = images[0];
  const insets = images.slice(1, 4);

  const insetHTML = insets.length > 0
    ? insets.map((img) => `<div class="inset" style="${imgCSS(img.base64, img.mime)}"></div>`).join("")
    : '<div class="inset"></div><div class="inset"></div><div class="inset"></div>';

  return wrap(
    `${fontLinks(fontHeading, fontBody)}<style>
      ${sharedCSS(brandKit, textStyle, fontHeading, fontBody)}
      .slide { display: flex; ${mainImg ? imgCSS(mainImg.base64, mainImg.mime) : `background: ${primaryColor};`} }
      .overlay { background: rgba(0,0,0,${overlayOpacity}); }
      .left-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; z-index: 2; }
      .text-container { text-align: left; padding: 60px 40px 60px 60px; }
      .right-col { width: 320px; display: flex; flex-direction: column; gap: 4px; padding: 4px; z-index: 2; }
      .inset { flex: 1; background-color: #222; background-size: cover; background-position: center; border: 3px solid #000; border-radius: 4px; }
    </style>`,
    `<div class="slide">
      ${mainImg ? '<div class="overlay"></div>' : ""}
      <div class="left-col"><div class="text-container">${formatCopy(slide.copy)}</div></div>
      <div class="right-col">${insetHTML}</div>
    </div>`,
    slide,
  );
}

function buildGrid2x2(slide, brandKit, vs, images, fontHeading, fontBody) {
  const bk = brandKit || {};
  const primaryColor = bk.primary_color || "#1a1a2e";
  const overlayOpacity = vs.overlay_opacity ?? 0.6;
  const textStyle = vs.text_style || {};

  const cells = [0, 1, 2, 3].map((i) => {
    const img = images[i];
    return `<div class="cell" style="${img ? imgCSS(img.base64, img.mime) : `background: ${primaryColor};`}"></div>`;
  }).join("");

  return wrap(
    `${fontLinks(fontHeading, fontBody)}<style>
      ${sharedCSS(brandKit, textStyle, fontHeading, fontBody)}
      .slide { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
      .cell { background-size: cover; background-position: center; }
      .overlay { background: rgba(0,0,0,${overlayOpacity}); }
      .text-container { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; z-index: 2; padding: 80px; }
    </style>`,
    `<div class="slide">
      ${cells}
      <div class="overlay"></div>
      <div class="text-container">${formatCopy(slide.copy)}</div>
    </div>`,
    slide,
  );
}

function buildBeforeAfter(slide, brandKit, vs, images, fontHeading, fontBody) {
  const bk = brandKit || {};
  const primaryColor = bk.primary_color || "#1a1a2e";
  const textLight = bk.text_color_light || "#ffffff";
  const textStyle = vs.text_style || {};
  const imgLeft = images[0];
  const imgRight = images[1] || images[0];

  return wrap(
    `${fontLinks(fontHeading, fontBody)}<style>
      ${sharedCSS(brandKit, textStyle, fontHeading, fontBody)}
      .slide { display: flex; flex-direction: column; background: ${primaryColor}; }
      .images { display: flex; flex: 1; gap: 4px; padding: 4px 4px 0; }
      .half { flex: 1; background-size: cover; background-position: center; border-radius: 4px; position: relative; }
      .half-label { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.6); color: ${textLight}; font-family: '${fontHeading}', sans-serif; font-size: 22px; font-weight: 700; padding: 8px 20px; border-radius: 6px; text-transform: uppercase; }
      .text-container { text-align: center; padding: 30px 60px 50px; }
      .line { font-size: 40px; }
    </style>`,
    `<div class="slide">
      <div class="images">
        <div class="half" style="${imgLeft ? imgCSS(imgLeft.base64, imgLeft.mime) : ''}"><div class="half-label">Before</div></div>
        <div class="half" style="${imgRight ? imgCSS(imgRight.base64, imgRight.mime) : ''}"><div class="half-label">After</div></div>
      </div>
      <div class="text-container">${formatCopy(slide.copy)}</div>
    </div>`,
    slide,
  );
}

function buildLifestyleGrid(slide, brandKit, vs, images, fontHeading, fontBody) {
  const bk = brandKit || {};
  const primaryColor = bk.primary_color || "#1a1a2e";
  const overlayOpacity = vs.overlay_opacity ?? 0.55;
  const textStyle = vs.text_style || {};

  const cells = [0, 1, 2, 3].map((i) => {
    const img = images[i];
    return `<div class="cell" style="${img ? imgCSS(img.base64, img.mime) : `background: ${primaryColor};`}"></div>`;
  }).join("");

  return wrap(
    `${fontLinks(fontHeading, fontBody)}<style>
      ${sharedCSS(brandKit, textStyle, fontHeading, fontBody)}
      .slide { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 4px; padding: 4px; background: #000; }
      .cell { background-size: cover; background-position: center; border-radius: 4px; }
      .overlay { background: rgba(0,0,0,${overlayOpacity}); border-radius: 0; }
      .text-container { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; z-index: 2; padding: 80px; }
    </style>`,
    `<div class="slide">
      ${cells}
      <div class="overlay"></div>
      <div class="text-container">${formatCopy(slide.copy)}</div>
    </div>`,
    slide,
  );
}

const COMPOSITION_BUILDERS = {
  single_hero: buildSingleHero,
  text_only: buildTextOnly,
  split_collage: buildSplitCollage,
  grid_2x2: buildGrid2x2,
  before_after: buildBeforeAfter,
  lifestyle_grid: buildLifestyleGrid,
};

const IMAGES_NEEDED = {
  single_hero: 1,
  text_only: 0,
  split_collage: 4,
  grid_2x2: 4,
  before_after: 2,
  lifestyle_grid: 4,
};

// ── Image loading ──────────────────────────────────────

async function loadImage(key, lutData, lutSize) {
  let buffer = await getBuffer(key);
  let mime = key.endsWith(".png") ? "image/png" : "image/jpeg";

  if (lutData && lutSize) {
    try {
      buffer = await applyLutToBuffer(buffer, lutData, lutSize);
      mime = "image/png";
    } catch (err) {
      logger.warn(`LUT application failed for ${key}: ${err.message}`);
    }
  }

  return { base64: buffer.toString("base64"), mime };
}

async function fetchExtraImages(clientId, count, excludeKeys, lutData, lutSize) {
  if (count <= 0) return [];

  const filter = { client_id: clientId, status: "ready" };
  if (excludeKeys.length > 0) {
    filter.storage_key = { $nin: excludeKeys };
  }

  const extras = await ClientImage.find(filter).sort({ quality_score: -1 }).limit(count).lean();

  const loaded = [];
  for (const img of extras) {
    try {
      loaded.push(await loadImage(img.storage_key, lutData, lutSize));
    } catch (err) {
      logger.warn(`Could not load extra image ${img.storage_key}: ${err.message}`);
    }
  }
  return loaded;
}

// ── Puppeteer rendering ──────────────────────────────────────

async function renderSlideToBuffer(browser, html) {
  const page = await browser.newPage();
  await page.setViewport({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() =>
    Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))])
  );
  const buffer = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT } });
  await page.close();
  return buffer;
}

// ── Main ──────────────────────────────────────

async function renderSlides({ carouselId, clientId, accountId, slides, imageSelections, templateId, lutId }) {
  const [client, template, lutDoc] = await Promise.all([
    Client.findById(clientId),
    templateId ? CarouselTemplate.findById(templateId) : null,
    lutId ? ClientLut.findById(lutId) : null,
  ]);

  let lutData = null;
  let lutSize = 0;
  if (lutDoc) {
    try {
      const lutBuffer = await getBuffer(lutDoc.storage_key);
      const parsed = parseCubeFile(lutBuffer.toString("utf-8"));
      lutData = parsed.data;
      lutSize = parsed.size;
      logger.info(`Loaded LUT "${lutDoc.name}" (${lutSize}x${lutSize}x${lutSize})`);
    } catch (err) {
      logger.warn(`Could not load LUT ${lutId}: ${err.message}`);
    }
  }

  const brandKit = client?.brand_kit || {};
  const visualStructure = template?.visual_structure || {};
  const fontHeading = brandKit.font_heading || "Montserrat";
  const fontBody = brandKit.font_body || "Inter";

  const usedImageKeys = new Set();
  imageSelections.forEach((s) => { if (s.image_key) usedImageKeys.add(s.image_key); });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const results = [];

    for (const slide of slides) {
      const selection = imageSelections.find((s) => s.position === slide.position);
      const composition = slide.composition || "single_hero";
      const needed = IMAGES_NEEDED[composition] || 1;

      // Load primary image
      const slideImages = [];
      if (selection?.image_key && needed > 0) {
        try {
          slideImages.push(await loadImage(selection.image_key, lutData, lutSize));
        } catch (err) {
          logger.warn(`Could not load image for slide ${slide.position}: ${err.message}`);
        }
      }

      // Load pre-selected extra images first (from imageSelector)
      const preSelectedExtras = selection?.extra_image_keys || [];
      for (const extraKey of preSelectedExtras) {
        if (slideImages.length >= needed) break;
        try {
          slideImages.push(await loadImage(extraKey, lutData, lutSize));
          usedImageKeys.add(extraKey);
        } catch (err) {
          logger.warn(`Could not load pre-selected extra image ${extraKey}: ${err.message}`);
        }
      }

      // Fetch remaining extra images if still needed (fallback to random high-quality)
      if (needed > slideImages.length && composition !== "text_only") {
        const extras = await fetchExtraImages(
          clientId,
          needed - slideImages.length,
          [...usedImageKeys],
          lutData,
          lutSize,
        );
        slideImages.push(...extras);
      }

      const builder = COMPOSITION_BUILDERS[composition] || COMPOSITION_BUILDERS.single_hero;
      const html = builder(slide, brandKit, visualStructure, slideImages, fontHeading, fontBody);
      const pngBuffer = await renderSlideToBuffer(browser, html);

      const key = `carousels/${carouselId}/slide-${slide.position}.png`;
      await upload(key, pngBuffer, "image/png");

      results.push({ position: slide.position, rendered_key: key, size: pngBuffer.length });
      logger.info(`Rendered slide ${slide.position} [${composition}] (${pngBuffer.length} bytes)`);
    }

    return results;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { renderSlides, COMPOSITION_BUILDERS };
