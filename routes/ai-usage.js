const logger = require("../utils/logger").child({ module: "ai-usage" });
const express = require("express");
const { decrypt } = require("../utils/crypto");

const router = express.Router();

// GET /api/ai-usage — fetch usage/billing from OpenAI, Anthropic, and Google
router.get("/", async (req, res) => {
  try {
    const account = req.account;
    const openaiKey = decrypt(account.openai_token) || null;
    const claudeKey = decrypt(account.claude_token) || null;
    const geminiKey = decrypt(account.gemini_token) || null;

    const results = {};

    // Fetch all in parallel
    const [openaiResult, claudeResult, geminiResult] = await Promise.all([
      openaiKey ? fetchOpenAIUsage(openaiKey) : Promise.resolve(null),
      claudeKey ? fetchAnthropicUsage(claudeKey) : Promise.resolve(null),
      geminiKey ? fetchGeminiUsage(geminiKey) : Promise.resolve(null),
    ]);

    if (openaiKey) results.openai = openaiResult;
    if (claudeKey) results.claude = claudeResult;
    if (geminiKey) results.gemini = geminiResult;

    res.json(results);
  } catch (err) {
    logger.error("AI usage fetch error:", err);
    res.status(500).json({ error: "Failed to fetch AI usage" });
  }
});

// ── OpenAI ──
async function fetchOpenAIUsage(apiKey) {
  try {
    // Try the organization costs endpoint (works with admin/org keys)
    const now = Math.floor(Date.now() / 1000);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const startEpoch = Math.floor(startOfMonth.getTime() / 1000);

    const res = await fetch(
      `https://api.openai.com/v1/organization/costs?start_time=${startEpoch}&end_time=${now}&bucket_width=1mo`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const buckets = data.data || [];
      let totalCents = 0;
      for (const bucket of buckets) {
        for (const result of bucket.results || []) {
          totalCents += result.amount?.value ?? 0;
        }
      }
      return {
        totalUsageUsd: totalCents / 100,
        period: "current month",
        source: "organization",
      };
    }

    // If org endpoint fails, try the billing credit grants endpoint
    const creditRes = await fetch(
      "https://api.openai.com/v1/dashboard/billing/credit_grants",
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (creditRes.ok) {
      const creditData = await creditRes.json();
      return {
        totalGranted: creditData.total_granted ?? null,
        totalUsed: creditData.total_used ?? null,
        totalAvailable: creditData.total_available ?? null,
        period: "lifetime",
        source: "credits",
      };
    }

    return { error: "Unable to fetch usage — key may not have billing permissions" };
  } catch (err) {
    logger.warn("OpenAI usage fetch failed:", err.message);
    return { error: "Failed to connect to OpenAI API" };
  }
}

// ── Anthropic (Claude) ──
async function fetchAnthropicUsage(apiKey) {
  try {
    // Try the organization usage endpoint
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = startOfMonth.toISOString().split("T")[0];
    const endDate = now.toISOString().split("T")[0];

    const res = await fetch(
      `https://api.anthropic.com/v1/usage?start_date=${startDate}&end_date=${endDate}`,
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (res.ok) {
      const data = await res.json();
      return {
        totalUsageUsd: data.total_usage_usd ?? null,
        inputTokens: data.total_input_tokens ?? null,
        outputTokens: data.total_output_tokens ?? null,
        period: "current month",
        source: "usage",
      };
    }

    // Anthropic doesn't expose billing via regular API keys
    return { error: "Usage data not available — Anthropic requires an Admin API key for billing access" };
  } catch (err) {
    logger.warn("Anthropic usage fetch failed:", err.message);
    return { error: "Failed to connect to Anthropic API" };
  }
}

// ── Google Gemini ──
async function fetchGeminiUsage(apiKey) {
  try {
    // Google AI Studio doesn't expose a billing/usage API for API keys
    // We can at least verify the key works by listing models
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(10000) },
    );

    if (res.ok) {
      return { error: "Usage tracking not available — Google AI does not provide a billing API for API keys" };
    }

    return { error: "Invalid API key or unable to reach Google AI API" };
  } catch (err) {
    logger.warn("Gemini usage fetch failed:", err.message);
    return { error: "Failed to connect to Google AI API" };
  }
}

module.exports = router;
