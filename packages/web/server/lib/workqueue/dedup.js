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

// Words too common to carry any signal about whether two titles describe the
// same underlying problem.
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'is',
  'are', 'be', 'with', 'when', 'not', 'does', 'do', 'this', 'that', 'it', 'as',
]);

function titleTokens(title) {
  return new Set(
    (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !TITLE_STOPWORDS.has(word)),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Prefilters likely-duplicate candidates for the AI analysis prompt using
// cheap lexical similarity (title token overlap). This is deliberately not
// the final "is it a duplicate" verdict — that judgment (and picking the
// "parent" among candidates) is left to the model, which sees each
// candidate's age and description length alongside the score. Only ever
// compares against other open, non-PR, non-archived items.
const DUPLICATE_CANDIDATE_MIN_SCORE = 0.3;
const DUPLICATE_CANDIDATE_LIMIT = 5;

export function findDuplicateCandidates(item, allItems) {
  const selfTokens = titleTokens(item.title);
  if (selfTokens.size === 0) return [];

  return allItems
    .filter((candidate) => (
      candidate.id !== item.id
      && candidate.type !== 'pr'
      && !candidate.archivedAt
      && !(candidate.source === item.source && candidate.sourceId === item.sourceId)
    ))
    .map((candidate) => ({ candidate, score: jaccard(selfTokens, titleTokens(candidate.title)) }))
    .filter(({ score }) => score >= DUPLICATE_CANDIDATE_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, DUPLICATE_CANDIDATE_LIMIT)
    .map(({ candidate, score }) => ({
      id: candidate.id,
      sourceId: candidate.sourceId,
      identifier: candidate.identifier,
      title: candidate.title,
      url: candidate.url,
      createdAt: candidate.createdAt,
      bodyLength: candidate.body?.length || 0,
      score,
    }));
}
