/**
 * Master Copywriting Playbook
 *
 * Loads copywriting expertise from markdown files in the playbooks/ directory.
 * Edit the markdown files to update the AI's copywriting knowledge
 * without touching any code.
 */

const fs = require("fs");
const path = require("path");

const PLAYBOOKS_DIR = path.join(__dirname, "playbooks");

// Cache loaded playbooks in memory (loaded once at startup)
const cache = {};

function loadPlaybook(name) {
  if (cache[name]) return cache[name];
  const filePath = path.join(PLAYBOOKS_DIR, `${name}.md`);
  cache[name] = fs.readFileSync(filePath, "utf-8");
  return cache[name];
}

/**
 * Returns all playbooks combined for injection into system prompts.
 * Loads: carousel-copy.md (content strategy) + hooks-and-storytelling.md (craft) + writing-style.md (anti-AI rules)
 */
function getPlaybook() {
  const strategy = loadPlaybook("carousel-copy");
  const craft = loadPlaybook("hooks-and-storytelling");
  const writingStyle = loadPlaybook("writing-style");
  return `${strategy}\n\n---\n\n${craft}\n\n---\n\n${writingStyle}`;
}

module.exports = { getPlaybook, loadPlaybook };
