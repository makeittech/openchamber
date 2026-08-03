import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'workqueue-items.json');
const MAX_ITEMS = 2000;

const ITEM_STATUSES = ['backlog', 'todo', 'in_progress', 'done'];
const ITEM_SOURCES = ['github', 'linear'];
const ITEM_TYPES = ['issue', 'pr'];

// Descriptions and review comments are persisted to a local JSON file that
// holds up to MAX_ITEMS entries, so each field is capped to keep the store
// from growing unbounded on repos with very long issue/PR bodies.
const BODY_MAX_LENGTH = 20_000;
const REVIEW_COMMENTS_MAX = 20;
const REVIEW_COMMENT_MAX_LENGTH = 20_000;

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

const normalizeAnalysis = (analysis) => {
  if (!analysis || typeof analysis !== 'object') return null;
  const summary = typeof analysis.summary === 'string' ? analysis.summary : '';
  if (!summary) return null;
  return {
    summary,
    complexity: ['easy', 'medium', 'hard', 'huge'].includes(analysis.complexity) ? analysis.complexity : 'medium',
    priority: ['critical', 'high', 'medium', 'low'].includes(analysis.priority) ? analysis.priority : 'medium',
    confidence: typeof analysis.confidence === 'number'
      ? Math.max(0, Math.min(100, analysis.confidence))
      : 0,
    estimateMinutes: typeof analysis.estimateMinutes === 'number' && analysis.estimateMinutes > 0
      ? analysis.estimateMinutes
      : null,
    needsHeadless: Boolean(analysis.needsHeadless),
    needsBrowser: Boolean(analysis.needsBrowser),
    needsDocker: Boolean(analysis.needsDocker),
    generatedPrompt: typeof analysis.generatedPrompt === 'string' ? analysis.generatedPrompt : '',
    // "Already solved?" signal: only ever set from an actual commit match
    // found in the repo's log (see staleness.js) — never a model guess with
    // no evidence attached.
    alreadySolved: Boolean(analysis.alreadySolved) && Boolean(analysis.alreadySolvedReference),
    alreadySolvedReference: analysis.alreadySolvedReference && typeof analysis.alreadySolvedReference === 'object'
      ? {
        hash: typeof analysis.alreadySolvedReference.hash === 'string' ? analysis.alreadySolvedReference.hash : '',
        message: typeof analysis.alreadySolvedReference.message === 'string' ? analysis.alreadySolvedReference.message : '',
        url: typeof analysis.alreadySolvedReference.url === 'string' ? analysis.alreadySolvedReference.url : '',
        date: typeof analysis.alreadySolvedReference.date === 'string' ? analysis.alreadySolvedReference.date : '',
      }
      : null,
    // Possible-duplicate signal: the candidate's identity is denormalized
    // here (not just an id) so the card keeps showing where it points even
    // if the candidate item is later archived/finished.
    duplicateOfId: typeof analysis.duplicateOfId === 'string' ? analysis.duplicateOfId : '',
    duplicateOfTitle: typeof analysis.duplicateOfTitle === 'string' ? analysis.duplicateOfTitle : '',
    duplicateOfUrl: typeof analysis.duplicateOfUrl === 'string' ? analysis.duplicateOfUrl : '',
    duplicateReasoning: typeof analysis.duplicateReasoning === 'string' ? analysis.duplicateReasoning : '',
    analyzedAt: typeof analysis.analyzedAt === 'number' ? analysis.analyzedAt : Date.now(),
  };
};

const normalizeItem = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const source = ITEM_SOURCES.includes(entry.source) ? entry.source : null;
  const sourceId = typeof entry.sourceId === 'string' ? entry.sourceId : '';
  if (!source || !sourceId) return null;
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomBytes(8).toString('hex'),
    source,
    sourceId,
    repo: typeof entry.repo === 'string' ? entry.repo : '',
    team: typeof entry.team === 'string' ? entry.team : '',
    type: ITEM_TYPES.includes(entry.type) ? entry.type : 'issue',
    title: typeof entry.title === 'string' ? entry.title : '',
    // Source-owned description, synced from GitHub/Linear so the detail
    // Overview has real content immediately, before any AI analysis runs.
    body: typeof entry.body === 'string' ? entry.body.slice(0, BODY_MAX_LENGTH) : '',
    url: typeof entry.url === 'string' ? entry.url : '',
    author: typeof entry.author === 'string' ? entry.author : '',
    labels: Array.isArray(entry.labels) ? entry.labels.filter((label) => typeof label === 'string') : [],
    // Automated PR review comments (openchamber-bot). PRs are never AI-analyzed;
    // this is what the PR detail view shows instead.
    reviewComments: Array.isArray(entry.reviewComments)
      ? entry.reviewComments
        .filter((comment) => comment && typeof comment === 'object' && typeof comment.body === 'string')
        .slice(0, REVIEW_COMMENTS_MAX)
        .map((comment) => ({
          body: comment.body.slice(0, REVIEW_COMMENT_MAX_LENGTH),
          url: typeof comment.url === 'string' ? comment.url : '',
          author: typeof comment.author === 'string' ? comment.author : '',
          createdAt: typeof comment.createdAt === 'number' ? comment.createdAt : 0,
        }))
      : [],
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
    status: ITEM_STATUSES.includes(entry.status) ? entry.status : 'backlog',
    // Linear issue identifier (e.g. "OPE-123"), used to detect a GitHub
    // issue/PR that references the same underlying task so it isn't shown
    // as a second, duplicate card.
    identifier: typeof entry.identifier === 'string' ? entry.identifier : '',
    // Set on a Linear-sourced item when a GitHub issue/PR referencing it was
    // found and merged into this card instead of shown separately.
    linkedGithubUrl: typeof entry.linkedGithubUrl === 'string' ? entry.linkedGithubUrl : '',
    // Set on a GitHub-sourced item once a Linear issue was auto-created for
    // it (on first "take into progress"), so it mirrors into Linear without
    // ever appearing as a second, separate card on the next Linear sync.
    linkedLinearId: typeof entry.linkedLinearId === 'string' ? entry.linkedLinearId : '',
    linkedLinearUrl: typeof entry.linkedLinearUrl === 'string' ? entry.linkedLinearUrl : '',
    // A PR the user manually attached from the AI analysis panel as evidence
    // this item is already done — set via PATCH, never inferred.
    attachedPrUrl: typeof entry.attachedPrUrl === 'string' ? entry.attachedPrUrl : '',
    assignee: typeof entry.assignee === 'string' ? entry.assignee : '',
    aiAnalysis: normalizeAnalysis(entry.aiAnalysis),
    aiAnalysisError: typeof entry.aiAnalysisError === 'string' ? entry.aiAnalysisError : null,
    cloudAgent: entry.cloudAgent && typeof entry.cloudAgent === 'object'
      ? {
        agentId: typeof entry.cloudAgent.agentId === 'string' ? entry.cloudAgent.agentId : '',
        runId: typeof entry.cloudAgent.runId === 'string' ? entry.cloudAgent.runId : '',
        apiVersion: typeof entry.cloudAgent.apiVersion === 'string' && entry.cloudAgent.apiVersion === 'v1'
          ? 'v1'
          : 'v0',
        status: typeof entry.cloudAgent.status === 'string' ? entry.cloudAgent.status : 'unknown',
        url: typeof entry.cloudAgent.url === 'string' ? entry.cloudAgent.url : '',
        branchName: typeof entry.cloudAgent.branchName === 'string' ? entry.cloudAgent.branchName : '',
        name: typeof entry.cloudAgent.name === 'string' ? entry.cloudAgent.name : '',
        model: typeof entry.cloudAgent.model === 'string' ? entry.cloudAgent.model : '',
        createdAt: typeof entry.cloudAgent.createdAt === 'number' ? entry.cloudAgent.createdAt : 0,
      }
      : null,
    linkedSessionId: typeof entry.linkedSessionId === 'string' ? entry.linkedSessionId : '',
    finishedAt: typeof entry.finishedAt === 'number' ? entry.finishedAt : null,
    archivedAt: typeof entry.archivedAt === 'number' ? entry.archivedAt : null,
    // How the card was closed via the Finish action — mirrors GitHub's own
    // close reasons plus a Linear-style "duplicate" state. Never set outside
    // finish.js.
    closeReason: ['completed', 'duplicate', 'not_planned'].includes(entry.closeReason) ? entry.closeReason : null,
  };
};

function readStore() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.items) ? parsed.items : [];
    return list.map(normalizeItem).filter(Boolean);
  } catch (error) {
    console.error('[workqueue] Failed to read item store:', error?.message || error);
    return [];
  }
}

function writeStore(items) {
  ensureStorageDir();
  // Archived items are dropped first when the store exceeds MAX_ITEMS so
  // active work is never pruned ahead of already-finished cards.
  const sorted = items.slice().sort((a, b) => {
    const archivedDiff = Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt));
    if (archivedDiff !== 0) return archivedDiff;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  const pruned = sorted.slice(0, MAX_ITEMS);
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ items: pruned }, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

export function listItems({ status, repo, assignee, type, source } = {}) {
  let items = readStore().filter((item) => !item.archivedAt);
  if (status) items = items.filter((item) => item.status === status);
  if (repo) items = items.filter((item) => item.repo === repo);
  if (assignee) items = items.filter((item) => item.assignee === assignee);
  if (type) items = items.filter((item) => item.type === type);
  if (source) items = items.filter((item) => item.source === source);
  return items;
}

export function getItem(id) {
  if (typeof id !== 'string' || !id) return null;
  return readStore().find((item) => item.id === id) ?? null;
}

// Looks up a stored item (including archived ones) by its source key,
// regardless of the current list/board filters.
export function findItem(source, sourceId) {
  if (!source || !sourceId) return null;
  return readStore().find((item) => item.source === source && item.sourceId === sourceId) ?? null;
}

// Upserts sync results by source+sourceId. Fields the user or the analysis
// pass has already set (status, assignee, aiAnalysis) are preserved across a
// re-sync: a sync only introduces new items or refreshes source-owned fields
// (title, labels, url) on ones it already knows about.
export function upsertSyncedItems(incoming) {
  const items = readStore();
  const byKey = new Map(items.map((item) => [`${item.source}:${item.sourceId}`, item]));
  let added = 0;
  let updated = 0;
  for (const raw of incoming) {
    const normalized = normalizeItem(raw);
    if (!normalized) continue;
    const key = `${normalized.source}:${normalized.sourceId}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        title: normalized.title,
        body: normalized.body,
        url: normalized.url,
        author: normalized.author,
        labels: normalized.labels,
        repo: normalized.repo,
        team: normalized.team,
        // Stable source-owned identifier — always refreshed so items synced
        // before dedup existed become dedup-eligible on their next sync.
        identifier: normalized.identifier || existing.identifier,
        // Review comments only refresh when the sync actually fetched them;
        // a fetch that failed must not erase previously synced comments.
        reviewComments: normalized.reviewComments.length > 0
          ? normalized.reviewComments
          : existing.reviewComments,
        updatedAt: Date.now(),
      });
      updated += 1;
    } else {
      byKey.set(key, normalized);
      added += 1;
    }
  }
  writeStore(Array.from(byKey.values()));
  return { added, updated };
}

export function patchItem(id, patch) {
  const items = readStore();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const current = items[index];
  const next = normalizeItem({
    ...current,
    ...patch,
    id: current.id,
    source: current.source,
    sourceId: current.sourceId,
    updatedAt: Date.now(),
  });
  items[index] = next;
  writeStore(items);
  return next;
}

export const WORKQUEUE_ITEMS_FILE = STORAGE_FILE;
