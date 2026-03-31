const Anthropic = require("@anthropic-ai/sdk").default;
const OpenAI = require("openai").default;
const { GoogleGenAI } = require("@google/genai");
const Account = require("../models/Account");
const Client = require("../models/Client");
const { decrypt } = require("./crypto");

/**
 * Resolves an AI token with fallback: client → account → env.
 * @param {{ accountId: string, clientId?: string }} ids
 * @param {"claude_token"|"openai_token"|"gemini_token"} field
 * @param {string} envVar - environment variable name fallback
 */
async function resolveToken({ accountId, clientId }, field, envVar) {
  // 1. Check client-level key
  if (clientId) {
    const client = await Client.findById(clientId).select(`ai_integrations.${field}`).lean();
    const val = client?.ai_integrations?.[field];
    if (val) return decrypt(val);
  }

  // 2. Check account-level key
  const account = await Account.findById(accountId).select(field).lean();
  const val = account?.[field];
  if (val) return Account.decryptField(val);

  // 3. Env fallback
  return process.env[envVar] || null;
}

async function getClaudeClient({ accountId, clientId }) {
  const token = await resolveToken({ accountId, clientId }, "claude_token", "CLAUDE");
  if (!token) throw new Error("No Claude token available — add CLAUDE to your .env, set it on the account, or on the client");
  return new Anthropic({ apiKey: token });
}

async function getOpenAIClient({ accountId, clientId }) {
  const token = await resolveToken({ accountId, clientId }, "openai_token", "OPENAI");
  if (!token) throw new Error("No OpenAI token available");
  return new OpenAI({ apiKey: token });
}

async function getGeminiClient({ accountId, clientId }) {
  const token = await resolveToken({ accountId, clientId }, "gemini_token", "GEMINI");
  if (!token) throw new Error("No Gemini token available");
  return new GoogleGenAI({ apiKey: token });
}

module.exports = { getClaudeClient, getOpenAIClient, getGeminiClient, resolveToken };
