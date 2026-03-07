/**
 * Escape special regex characters in a string to prevent ReDoS attacks.
 * Use this before passing user input into MongoDB $regex queries.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = escapeRegex;
