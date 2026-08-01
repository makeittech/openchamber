// Detects a Linear issue identifier referenced from a GitHub issue/PR body,
// e.g. "Closes OPE-123" or a linear.app issue URL. The team-key prefix is
// whatever the connected Linear workspace uses — never hardcoded.
const KEYWORD_REF_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*([A-Z][A-Z0-9]{1,9}-\d+)\b/i;
const URL_REF_RE = /linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d+)/i;

export function extractLinearRef(body) {
  if (typeof body !== 'string' || !body) return null;
  const keywordMatch = body.match(KEYWORD_REF_RE);
  if (keywordMatch) return keywordMatch[1].toUpperCase();
  const urlMatch = body.match(URL_REF_RE);
  if (urlMatch) return urlMatch[1].toUpperCase();
  return null;
}
