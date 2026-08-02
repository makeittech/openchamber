import { patchItem, listItems } from './store.js';
import { findDuplicateCandidates } from './dedup.js';
import { checkItemStaleness } from './staleness.js';

const BULK_CONCURRENCY = 3;

// Reasoning models (DeepSeek, Qwen, Kimi, …) spend output tokens on reasoning
// before emitting any answer, so a tight budget makes them return nothing at
// all ("spent the output budget on reasoning"). The first attempt already gets
// a generous budget, and the retry escalates rather than just re-asking.
const ANALYSIS_MAX_OUTPUT_TOKENS = 8_000;
const ANALYSIS_RETRY_MAX_OUTPUT_TOKENS = 16_000;

const isReasoningBudgetFailure = (error) => /output budget on reasoning/i.test(
  error instanceof Error ? error.message : String(error ?? ''),
);

const ANALYSIS_SYSTEM_PROMPT = `You are a senior engineer triaging a GitHub/Linear issue or pull request for another
engineer to pick up. Two sections below the issue itself may list REAL evidence gathered by the system — candidate
commits (either explicitly referencing this issue or picked from the repo's actual commit log as likely fixes) and
other open items that might describe the same problem. Only ever reference something from those lists by the exact
id/hash given; if neither section is present or nothing in it actually matches, leave the corresponding fields
null/empty — never invent a commit hash or item id.
Respond with ONLY a single JSON object, no markdown fences, no prose, matching exactly:
{
  "summary": string (2-4 sentences, plain language, what the task is and the likely root cause/approach),
  "complexity": "easy" | "medium" | "hard" | "huge",
  "priority": "critical" | "high" | "medium" | "low",
  "confidence": number (0-100, how confident you are in this analysis given the available context),
  "estimateMinutes": number (rough time to fix for an engineer already familiar with the codebase),
  "needsHeadless": boolean (true if reproducing/testing this needs a headless browser or CI-like environment),
  "needsBrowser": boolean (true if a real/interactive browser is needed to reproduce or verify),
  "needsDocker": boolean (true if local reproduction needs Docker or another local service),
  "generatedPrompt": string (a ready-to-send prompt an AI coding agent could start working from),
  "alreadySolved": boolean (true only if one of the listed candidate commits clearly already fixes this issue),
  "alreadySolvedHash": string | null (the exact hash of that commit from the list, or null),
  "duplicateOfId": string | null (the exact id of a listed candidate item that is the SAME underlying problem, or null),
  "duplicateReasoning": string (why it is/isn't a duplicate of the listed candidates; if it is, explain why that
    candidate — not this item — is the "parent": e.g. it was reported first, or it is better/more fully described)
}`;

// The issue body is the single most useful analysis input; without it the
// model only ever saw the title and produced near-useless guesses.
const BODY_PROMPT_MAX_LENGTH = 6000;

const formatDate = (value) => {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : 'unknown date';
};

const buildAnalysisPrompt = (item, { stalenessMatches = [], duplicateCandidates = [] } = {}) => {
  const lines = [
    `Type: ${item.type}`,
    `Source: ${item.source}${item.repo ? ` (${item.repo})` : ''}`,
    `Title: ${item.title}`,
    `Opened: ${formatDate(item.createdAt)}`,
    item.labels?.length ? `Labels: ${item.labels.join(', ')}` : null,
    item.url ? `URL: ${item.url}` : null,
    item.body ? `\nDescription:\n${item.body.slice(0, BODY_PROMPT_MAX_LENGTH)}` : null,
  ];

  if (stalenessMatches.length > 0) {
    lines.push(
      '\nCandidate commits already in the repo that reference this issue or closely match it (all taken from the repo\'s real commit log, not invented):',
      ...stalenessMatches.map((commit) => `- hash=${commit.hash} date=${formatDate(commit.date)} message="${commit.message}"`),
    );
  }

  if (duplicateCandidates.length > 0) {
    lines.push(
      '\nOther open items that might describe the same underlying problem (verified to currently exist, not a guess):',
      ...duplicateCandidates.map((candidate) => (
        `- id=${candidate.id} opened=${formatDate(candidate.createdAt)} descriptionLength=${candidate.bodyLength} title="${candidate.title}"`
      )),
    );
  }

  return lines.filter(Boolean).join('\n');
};

const parseAnalysisResponse = (text) => {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
};

// Grounds the model's "already solved" / "duplicate" claims against the real
// evidence it was given: a hash or item id the model didn't actually see is
// dropped rather than trusted, so a hallucinated reference can never reach
// the stored analysis. This is what lets the schema's contract ("only ever
// produced by the model or explicitly marked failed, never fabricated") hold
// even though these two fields are inherently guess-shaped.
const groundDuplicateAndStalenessClaims = (parsed, { stalenessMatches, duplicateCandidates }) => {
  const matchedCommit = typeof parsed.alreadySolvedHash === 'string'
    ? stalenessMatches.find((commit) => commit.hash === parsed.alreadySolvedHash)
    : null;
  const matchedCandidate = typeof parsed.duplicateOfId === 'string'
    ? duplicateCandidates.find((candidate) => candidate.id === parsed.duplicateOfId)
    : null;

  const { alreadySolvedHash: _alreadySolvedHash, duplicateOfId: _duplicateOfId, ...rest } = parsed;
  return {
    ...rest,
    alreadySolved: Boolean(parsed.alreadySolved) && Boolean(matchedCommit),
    alreadySolvedReference: matchedCommit
      ? { hash: matchedCommit.hash, message: matchedCommit.message, date: matchedCommit.date, url: '' }
      : null,
    duplicateOfId: matchedCandidate?.id || '',
    duplicateOfTitle: matchedCandidate?.title || '',
    duplicateOfUrl: matchedCandidate?.url || '',
    duplicateReasoning: typeof parsed.duplicateReasoning === 'string' ? parsed.duplicateReasoning : '',
  };
};

// Calls the small-model background LLM (no chat session created) and stores
// the parsed result on the item. One retry — with a larger output budget and a
// stricter nudge — covers both a malformed response and a reasoning model that
// consumed its whole budget before answering. A persistent failure is recorded
// with the real reason, never guessed.
//
// `allItems` (defaults to every stored item) feeds the duplicate prefilter,
// and `directory`, when a project is active, also drives a commit-log search
// for evidence this was already fixed (see staleness.js): commits referencing
// the item, plus — via the same `generateSmallModelText` model — a similarity
// pass over the recent log when no direct reference exists. Both are
// best-effort: a lookup failure just means the corresponding prompt section
// is omitted, it never fails the analysis.
export async function analyzeItem(item, { generateSmallModelText, directory, allItems } = {}) {
  // Pull requests are never AI-analyzed: their review signal is the automated
  // PR review workflow's comments, which the PR detail view shows instead.
  if (item.type === 'pr') {
    const error = new Error('Pull requests are not AI-analyzed');
    error.code = 'ANALYSIS_NOT_APPLICABLE';
    throw error;
  }

  const duplicateCandidates = findDuplicateCandidates(item, allItems || listItems());
  let stalenessMatches = [];
  if (directory) {
    try {
      const staleness = await checkItemStaleness(item, directory, { generateSmallModelText });
      stalenessMatches = staleness.matches;
    } catch {
      // Advisory only — a failed local commit search must not block analysis.
    }
  }

  const prompt = buildAnalysisPrompt(item, { stalenessMatches, duplicateCandidates });
  let text = '';
  let firstError = null;
  try {
    const result = await generateSmallModelText({
      prompt,
      system: ANALYSIS_SYSTEM_PROMPT,
      maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      directory,
    });
    text = result.text;
  } catch (error) {
    // A reasoning-budget exhaustion is retryable with more room; anything else
    // (auth, network, provider outage) is reported as-is without a retry.
    if (!isReasoningBudgetFailure(error)) {
      return patchItem(item.id, { aiAnalysisError: error?.message || 'Analysis request failed' });
    }
    firstError = error;
  }

  let parsed = parseAnalysisResponse(text);
  if (!parsed) {
    try {
      const retry = await generateSmallModelText({
        prompt: `${prompt}\n\nReturn ONLY the JSON object. Do not think out loud, do not explain.`,
        system: ANALYSIS_SYSTEM_PROMPT,
        maxOutputTokens: ANALYSIS_RETRY_MAX_OUTPUT_TOKENS,
        directory,
      });
      parsed = parseAnalysisResponse(retry.text);
    } catch (error) {
      firstError = firstError || error;
    }
  }

  if (!parsed) {
    return patchItem(item.id, {
      aiAnalysisError: firstError
        ? (firstError.message || 'Analysis request failed')
        : 'Model did not return valid analysis JSON',
    });
  }

  const grounded = groundDuplicateAndStalenessClaims(parsed, { stalenessMatches, duplicateCandidates });
  return patchItem(item.id, {
    aiAnalysis: { ...grounded, analyzedAt: Date.now() },
    aiAnalysisError: null,
  });
}

// Bulk pass over every not-yet-analyzed issue, with bounded concurrency so a
// few hundred items do not open a few hundred model requests at once. PRs are
// excluded by design. Resumable: an item that already has an analysis is
// skipped, so re-running only picks up what is still missing.
export async function analyzeAllPending({ generateSmallModelText, directory, concurrency = BULK_CONCURRENCY } = {}) {
  // One snapshot for the whole pass: every open item (not just the pending
  // ones) is a valid duplicate target, and re-reading the store per item
  // would be wasted work across a few hundred items.
  const allItems = listItems();
  const pending = allItems.filter((item) => item.type !== 'pr' && !item.aiAnalysis);

  let done = 0;
  let failed = 0;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= pending.length) return;
      const item = pending[index];
      try {
        const updated = await analyzeItem(item, { generateSmallModelText, directory, allItems });
        if (updated?.aiAnalysis) done += 1;
        else failed += 1;
      } catch {
        // analyzeItem already records the per-item error; one failed item must
        // not abort the remaining bulk work.
        failed += 1;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) || 0 }, () => worker()),
  );

  return { total: pending.length, done, failed };
}
