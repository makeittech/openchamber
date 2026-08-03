import { searchCommitsByReference, getLog } from '../git/service.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The similarity search offers the model the repo's N most recent commits
// (across all refs) so it can pick ones that look like fixes. Kept small
// enough for a single small-model call per item.
const SIMILAR_COMMIT_SEARCH_MAX = 60;
const SIMILAR_COMMIT_SEARCH_MAX_OUTPUT_TOKENS = 2_000;
const SIMILAR_BODY_MAX_LENGTH = 6000;

const formatDate = (value) => {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : 'unknown date';
};

const SIMILAR_COMMITS_SYSTEM_PROMPT = `You are searching a repository's commit history for commits that likely fix or directly
relate to an open issue. Below is the issue and a numbered list of REAL commits from the repo's log
(hash, date, message). Select only commits that plausibly address the same problem: a fix, a partial
fix, or a commit touching the same broken behavior. Purely cosmetic or unrelated commits must not be
selected.
Respond with ONLY a single JSON object, no markdown fences, no prose, matching exactly:
{
  "hashes": ["hash", ...]
}
The hashes must come verbatim from the list above. If nothing fits, return {"hashes": []}.
Never invent a hash.`;

const buildSimilarCommitSearchPrompt = (item, commits) => {
  const lines = [
    `Type: ${item.type}`,
    `Title: ${item.title}`,
    item.body ? `\nDescription:\n${item.body.slice(0, SIMILAR_BODY_MAX_LENGTH)}` : null,
    '\nRecent commits (from the repo log, all refs):',
    ...commits.map((commit, index) => (
      `${index + 1}. hash=${commit.hash} date=${formatDate(commit.date)} message="${commit.message}"`
    )),
  ];
  return lines.filter(Boolean).join('\n');
};

const parseSimilarCommitResponse = (text) => {
  const trimmed = String(text || '').trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.hashes)) return null;
    return parsed;
  } catch {
    return null;
  }
};

// AI-assisted half of the staleness check: when no commit explicitly
// references the item, ask the small model which commits from the repo's
// recent log look like they fix the same problem. Best-effort by contract —
// a failed log read or model call returns [] and never throws. A hash the
// model invents (absent from the fetched log) is dropped before it can
// reach any caller, mirroring the grounding rule of the analysis pass.
async function searchSimilarCommits(item, directory, generateSmallModelText) {
  try {
    const { all } = await getLog(directory, { all: true, maxCount: SIMILAR_COMMIT_SEARCH_MAX });
    const createdAt = typeof item.createdAt === 'number' && item.createdAt > 0 ? item.createdAt : 0;
    // Commits older than the issue itself cannot have fixed it; skip them so
    // the model is not asked to judge stale history.
    const commits = (all || []).filter((commit) => {
      if (!commit?.hash) return false;
      if (!createdAt) return true;
      const commitDate = Date.parse(commit.date);
      return !Number.isFinite(commitDate) || commitDate >= createdAt;
    });
    if (commits.length === 0) return [];

    const result = await generateSmallModelText({
      prompt: buildSimilarCommitSearchPrompt(item, commits),
      system: SIMILAR_COMMITS_SYSTEM_PROMPT,
      maxOutputTokens: SIMILAR_COMMIT_SEARCH_MAX_OUTPUT_TOKENS,
      directory,
    });

    const parsed = parseSimilarCommitResponse(result?.text);
    if (!parsed) return [];

    const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
    const seen = new Set();
    const matches = [];
    for (const hash of parsed.hashes) {
      if (typeof hash !== 'string' || seen.has(hash)) continue;
      const commit = byHash.get(hash);
      if (!commit) continue; // never trust an invented hash
      seen.add(hash);
      matches.push({ hash: commit.hash, date: commit.date, message: commit.message });
    }
    return matches;
  } catch (error) {
    console.warn('Failed to search similar commits:', error?.message || error);
    return [];
  }
}

// Advisory "is this already done?" signal for the AI analysis panel: search
// the repo's commit log for a reference to this item (source id or Linear
// identifier) and report how long the item has sat open. A match does not
// prove the issue is resolved — it is a prompt for the user to look, not an
// automatic close.
//
// When a `generateSmallModelText` callback is provided AND no commit directly
// references the item, the check broadens into an AI similarity search over
// the recent commit log (see searchSimilarCommits) so a fix that never
// mentioned the issue id can still surface. Direct references stay
// authoritative: the similarity search is skipped when one exists, so the
// strongest signal is never diluted by model guesses.
export async function checkItemStaleness(item, directory, { generateSmallModelText } = {}) {
  if (!directory) {
    return { checked: false, stale: false, matches: [], daysOpen: 0 };
  }

  const references = [item.sourceId, item.identifier].filter(Boolean);
  const seenHashes = new Set();
  const matches = [];
  for (const reference of references) {
    const found = await searchCommitsByReference(directory, reference, { maxCount: 5 });
    for (const commit of found) {
      if (seenHashes.has(commit.hash)) continue;
      seenHashes.add(commit.hash);
      matches.push(commit);
    }
  }

  if (matches.length === 0 && typeof generateSmallModelText === 'function') {
    const similar = await searchSimilarCommits(item, directory, generateSmallModelText);
    for (const commit of similar) {
      if (seenHashes.has(commit.hash)) continue;
      seenHashes.add(commit.hash);
      matches.push(commit);
    }
  }
  matches.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  const createdAt = typeof item.createdAt === 'number' && item.createdAt > 0 ? item.createdAt : Date.now();
  const daysOpen = Math.max(0, Math.round((Date.now() - createdAt) / MS_PER_DAY));

  return { checked: true, stale: matches.length > 0, matches: matches.slice(0, 5), daysOpen };
}
