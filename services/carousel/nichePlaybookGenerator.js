const OpenAI = require("openai");
const Account = require("../../models/Account");
const Client = require("../../models/Client");
const logger = require("../../utils/logger").child({ module: "nichePlaybookGenerator" });

async function getOpenAIClient(accountId) {
  const account = await Account.findById(accountId);
  const token = account?.openai_token
    ? Account.decryptField(account.openai_token)
    : process.env.OPENAI;
  if (!token) throw new Error("No OpenAI token available");
  return new OpenAI({ apiKey: token });
}

const NICHE_PLAYBOOK_PROMPT = `You are a content strategist who adapts copywriting frameworks to specific niches.

Given a niche, generate a niche-specific playbook that a copywriter can use when writing Instagram carousel content for this niche.

Return the playbook as plain text (not JSON). Include these sections:

1. NICHE CONTEXT
- Who the target audience is
- What they care about most
- What language/slang they use
- What emotions drive their decisions

2. PAIN POINTS (list 10-15 common pain points specific to this niche)

3. DESIRES (list 10-15 specific desires/goals people in this niche have)

4. OBJECTIONS (list 8-10 common objections or resistance points)

5. UNIQUE MECHANISM EXAMPLES
- 5 examples of how a coach/expert in this niche might frame their unique method
- Use niche-specific language

6. HOOK EXAMPLES
- Write 10 high-performing hook examples specific to this niche
- Each hook should use the Context Lean → Scroll Stop → Contrarian Snapback formula
- Use niche-specific scenarios and language

7. STORY ANGLES
- 5 story angle templates specific to this niche
- Include the emotional beats that would resonate

8. CONTENT TOPICS
- 15 carousel topic ideas specific to this niche
- Each should have a pain/desire it targets

9. FORBIDDEN GENERIC PHRASES
- List phrases that are overused in this niche and should be avoided
- These are niche-specific cliches

10. NICHE VOCABULARY
- Words and phrases that feel authentic in this niche
- Slang, technical terms, and insider language that builds credibility

Be extremely specific to the niche. Do not use generic marketing language. Every example should feel like it was written by someone who lives and breathes this niche.`;

/**
 * Generate a niche-specific playbook for a client and save it to their profile.
 * Uses GPT-4o to create niche-adapted examples, pain points, hooks, etc.
 *
 * @param {string} clientId
 * @param {string} accountId
 * @returns {string} The generated niche playbook text
 */
async function generateNichePlaybook(clientId, accountId) {
  const client = await Client.findById(clientId);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const niche = client.niche || "fitness";
  const openai = await getOpenAIClient(accountId);

  logger.info(`Generating niche playbook for "${niche}" (client: ${client.name})`);

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: NICHE_PLAYBOOK_PROMPT },
      {
        role: "user",
        content: `Generate a niche-specific playbook for: ${niche}\n\nClient name: ${client.name}\n${client.voice_profile?.raw_text ? `Voice profile context: ${client.voice_profile.raw_text}` : ""}`,
      },
    ],
    max_tokens: 4096,
    temperature: 0.5,
  });

  const playbook = response.choices[0]?.message?.content;
  if (!playbook) throw new Error("Empty response from GPT-4o niche playbook generation");

  await Client.findByIdAndUpdate(clientId, { niche_playbook: playbook });

  logger.info(`Niche playbook generated for "${niche}" — ${playbook.length} chars`);
  return playbook;
}

module.exports = { generateNichePlaybook };
