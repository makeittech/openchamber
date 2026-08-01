import { patchItem, listItems } from './store.js';

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
engineer to pick up. Respond with ONLY a single JSON object, no markdown fences, no prose, matching exactly:
{
  "summary": string (2-4 sentences, plain language, what the task is and the likely root cause/approach),
  "complexity": "easy" | "medium" | "hard" | "huge",
  "priority": "critical" | "high" | "medium" | "low",
  "confidence": number (0-100, how confident you are in this analysis given the available context),
  "estimateMinutes": number (rough time to fix for an engineer already familiar with the codebase),
  "needsHeadless": boolean (true if reproducing/testing this needs a headless browser or CI-like environment),
  "needsBrowser": boolean (true if a real/interactive browser is needed to reproduce or verify),
  "needsDocker": boolean (true if local reproduction needs Docker or another local service),
  "generatedPrompt": string (a ready-to-send prompt an AI coding agent could start working from)
}`;

// The issue body is the single most useful analysis input; without it the
// model only ever saw the title and produced near-useless guesses.
const BODY_PROMPT_MAX_LENGTH = 6000;

const buildAnalysisPrompt = (item) => {
  const lines = [
    `Type: ${item.type}`,
    `Source: ${item.source}${item.repo ? ` (${item.repo})` : ''}`,
    `Title: ${item.title}`,
    item.labels?.length ? `Labels: ${item.labels.join(', ')}` : null,
    item.url ? `URL: ${item.url}` : null,
    item.body ? `\nDescription:\n${item.body.slice(0, BODY_PROMPT_MAX_LENGTH)}` : null,
  ].filter(Boolean);
  return lines.join('\n');
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

// Calls the small-model background LLM (no chat session created) and stores
// the parsed result on the item. One retry — with a larger output budget and a
// stricter nudge — covers both a malformed response and a reasoning model that
// consumed its whole budget before answering. A persistent failure is recorded
// with the real reason, never guessed.
export async function analyzeItem(item, { generateSmallModelText, directory } = {}) {
  // Pull requests are never AI-analyzed: their review signal is the automated
  // PR review workflow's comments, which the PR detail view shows instead.
  if (item.type === 'pr') {
    const error = new Error('Pull requests are not AI-analyzed');
    error.code = 'ANALYSIS_NOT_APPLICABLE';
    throw error;
  }
  const prompt = buildAnalysisPrompt(item);
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

  return patchItem(item.id, {
    aiAnalysis: { ...parsed, analyzedAt: Date.now() },
    aiAnalysisError: null,
  });
}

// Bulk pass over every not-yet-analyzed issue, with bounded concurrency so a
// few hundred items do not open a few hundred model requests at once. PRs are
// excluded by design. Resumable: an item that already has an analysis is
// skipped, so re-running only picks up what is still missing.
export async function analyzeAllPending({ generateSmallModelText, directory, concurrency = BULK_CONCURRENCY } = {}) {
  const pending = listItems()
    .filter((item) => item.type !== 'pr' && !item.aiAnalysis);

  let done = 0;
  let failed = 0;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= pending.length) return;
      const item = pending[index];
      try {
        const updated = await analyzeItem(item, { generateSmallModelText, directory });
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
