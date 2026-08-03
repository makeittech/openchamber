import { listItems, getItem, patchItem } from './store.js';
import { syncAll, resolveDefaultLinearTeam } from './sources.js';
import { analyzeItem, analyzeAllPending } from './analysis.js';
import { checkItemStaleness } from './staleness.js';
import { finishItem } from './finish.js';
import { getCursorApiVersion, isCursorApiVersionConfiguredViaEnv, setCursorApiVersion, getTrackedRepos, setTrackedRepos } from './settings.js';
import { columnToLinearStateType } from './columns.js';
import { moveIssueToStateType, assignIssueToViewer, createIssue } from '../linear/client.js';
import { getGitHubAuth } from '../github/auth.js';
import { getOctokitOrNull } from '../github/octokit.js';
import { getLinearAuth } from '../linear/auth.js';
import { getCursorApiKey, setCursorApiKey, clearCursorApiKey, isCursorConfiguredViaEnv } from './cursor/auth.js';
import {
  launchCursorAgent,
  getCursorAgent,
  verifyCursorApiKey,
  normalizeCursorAgent,
  mapTestSurfaceForCursor,
  CursorApiError,
} from './cursor/client.js';

const DEFAULT_CURSOR_MODEL = 'default';

// The dispatch prompt the user reviews before sending: prior AI analysis when
// there is one, the issue itself, the cloud agent's supported test surface,
// and a mandatory instruction to link the resulting PR back to the issue.
const buildCloudAgentPrompt = (item) => {
  const surface = mapTestSurfaceForCursor(item.aiAnalysis);
  const sections = [
    item.aiAnalysis?.generatedPrompt || '',
    item.aiAnalysis?.summary && !item.aiAnalysis?.generatedPrompt ? item.aiAnalysis.summary : '',
    !item.aiAnalysis ? `${item.title}\n\n${item.body || ''}`.trim() : '',
    '',
    '---',
    `Issue: ${item.sourceId}`,
    item.url ? `URL: ${item.url}` : '',
    surface
      ? `Testing: ${surface}`
      : 'Testing: the cloud agent environment is limited to web, desktop-linux, and headless. If this task needs anything else, implement what you can verify headlessly and state in the PR what still needs manual checking.',
    '',
    `REQUIRED: the pull request must be linked to ${item.sourceId} (for example "Closes ${item.sourceId}" in the PR description).`,
  ];
  return sections.filter((section) => section !== '').join('\n');
};

const safeErrorMessage = (error, maxLength = 500) => {
  const raw = error instanceof Error ? (error.message || String(error)) : String(error ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) return 'Unknown error';
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

// Assigns a GitHub issue/PR to the connected account ("me"). Returns
// { changed, assigneeName } or { changed: false, reason } — best-effort,
// callers must not undo an already-applied local status change on failure.
async function assignGitHubIssueToViewer(octokit, repo, sourceId) {
  const [owner, repoName] = (repo || '').split('/');
  const issueNumber = Number(String(sourceId || '').split('#').pop());
  if (!owner || !repoName || !Number.isFinite(issueNumber)) {
    return { changed: false, reason: 'missing-arguments' };
  }
  let login = getGitHubAuth()?.user?.login;
  if (!login) {
    try {
      const { data } = await octokit.rest.users.getAuthenticated();
      login = data?.login;
    } catch {
      // fall through to no-viewer below
    }
  }
  if (!login) {
    return { changed: false, reason: 'no-viewer' };
  }
  await octokit.rest.issues.addAssignees({ owner, repo: repoName, issue_number: issueNumber, assignees: [login] });
  return { changed: true, assigneeName: login };
}

// Mirrors a GitHub-sourced item into Linear the first time someone starts
// work on it: GitHub items otherwise never show up in Linear at all, so
// "who's on this" was invisible outside OpenChamber. Creates a new Linear
// issue (best-effort default team resolution), assigns it to the connected
// viewer, and moves it to the team's first "started" state. Best-effort:
// failure is reported via a warning and must never undo the already-applied
// local status change. Returns `{ patch }` on success or `{ warning }`.
async function mirrorGithubItemToLinear(before) {
  const teamId = await resolveDefaultLinearTeam();
  if (!teamId) {
    return { warning: 'linear-team-unresolved' };
  }
  const description = [before.body || '', '', `GitHub: ${before.url}`].join('\n').trim();
  let issue;
  try {
    issue = await createIssue({ teamId, title: before.title, description });
  } catch (error) {
    console.warn('[workqueue] Linear issue creation failed:', error?.message || error);
    return { warning: 'linear-create-failed' };
  }
  const patch = {
    linkedLinearId: issue.id,
    linkedLinearUrl: issue.url || '',
    identifier: issue.identifier || '',
    // Reused by finish.js: a GitHub item with a linked Linear mirror needs
    // the team id to move that Linear issue's state on Finish, the same way
    // a Linear-sourced item already does via its own `team` field.
    team: teamId,
  };
  try {
    const assigned = await assignIssueToViewer({ issueId: issue.id });
    if (assigned.changed) patch.assignee = assigned.assigneeName;
  } catch (error) {
    console.warn('[workqueue] Linear assignee sync failed for a newly created issue:', error?.message || error);
  }
  try {
    await moveIssueToStateType({ issueId: issue.id, teamId, stateType: 'started' });
  } catch (error) {
    console.warn('[workqueue] Linear state sync failed for a newly created issue:', error?.message || error);
  }
  return { patch };
}

export function registerWorkQueueRoutes(app, { getSmallModelService }) {
  app.get('/api/workqueue/items', (req, res) => {
    const { status, repo, assignee, type, source } = req.query || {};
    const items = listItems({
      status: typeof status === 'string' ? status : undefined,
      repo: typeof repo === 'string' ? repo : undefined,
      assignee: typeof assignee === 'string' ? assignee : undefined,
      type: typeof type === 'string' ? type : undefined,
      source: typeof source === 'string' ? source : undefined,
    });
    res.json({ items });
  });

  app.get('/api/workqueue/items/:id', (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item });
  });

  app.post('/api/workqueue/sync', async (_req, res) => {
    try {
      const result = await syncAll();
      res.json(result);
    } catch (error) {
      console.error('[workqueue] sync failed:', error);
      res.status(500).json({ error: safeErrorMessage(error) });
    }
  });

  app.post('/api/workqueue/items/:id/analyze', async (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.type === 'pr') {
      return res.status(400).json({ error: 'Pull requests are not AI-analyzed' });
    }
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const updated = await analyzeItem(item, {
        generateSmallModelText,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : undefined,
        allItems: listItems(),
      });
      res.json({ item: updated });
    } catch (error) {
      console.error('[workqueue] analysis failed:', error);
      res.status(500).json({ error: safeErrorMessage(error) });
    }
  });

  // Advisory freshness check: searches the repo's commit log for a reference
  // to this item — and, when the small model is available, for commits that
  // merely look like fixes — and reports how long it has been open. Not
  // persisted — this is a point-in-time prompt for the user to look, not
  // authoritative state.
  app.post('/api/workqueue/items/:id/staleness', async (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const directory = typeof req.body?.directory === 'string' ? req.body.directory : '';
    if (!directory) {
      return res.status(400).json({ error: 'directory is required' });
    }
    try {
      // The AI similarity search is a bonus, never a requirement: when the
      // small model is unavailable the check still runs on exact references.
      let generateSmallModelText;
      try {
        ({ generateSmallModelText } = await getSmallModelService());
      } catch {
        generateSmallModelText = undefined;
      }
      const result = await checkItemStaleness(item, directory, { generateSmallModelText });
      res.json(result);
    } catch (error) {
      console.error('[workqueue] staleness check failed:', error);
      res.status(500).json({ error: safeErrorMessage(error) });
    }
  });

  // Bulk pass over every not-yet-analyzed issue. Long-running by nature; the
  // client shows the returned done/failed counts when it settles.
  app.post('/api/workqueue/analyze-bulk', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const result = await analyzeAllPending({
        generateSmallModelText,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : undefined,
      });
      res.json(result);
    } catch (error) {
      console.error('[workqueue] bulk analysis failed:', error);
      res.status(500).json({ error: safeErrorMessage(error) });
    }
  });

  app.patch('/api/workqueue/items/:id', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (typeof body.status === 'string') patch.status = body.status;
    if (typeof body.assignee === 'string') patch.assignee = body.assignee;
    if (typeof body.linkedSessionId === 'string') patch.linkedSessionId = body.linkedSessionId;
    if (typeof body.attachedPrUrl === 'string') patch.attachedPrUrl = body.attachedPrUrl;

    const before = getItem(req.params.id);
    if (!before) return res.status(404).json({ error: 'Item not found' });

    let updated = patchItem(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'Item not found' });

    // A column change on a Linear-sourced card is written back to Linear's
    // real workflow state so it reads back correctly on the next sync. This
    // is best-effort: a Linear failure must not undo the local move that
    // already succeeded, but it is surfaced to the client rather than
    // silently swallowed.
    let linearSyncWarning;
    if (patch.status && patch.status !== before.status && before.source === 'linear' && before.team) {
      const stateType = columnToLinearStateType(patch.status);
      if (stateType) {
        try {
          const moved = await moveIssueToStateType({ issueId: before.sourceId, teamId: before.team, stateType });
          if (!moved?.changed) {
            linearSyncWarning = 'linear-state-not-updated';
          }
        } catch (error) {
          console.warn('[workqueue] Linear state write-back failed:', error?.message || error);
          linearSyncWarning = 'linear-state-write-failed';
        }
      }
    }

    // Taking a card into progress without an assignee yet self-assigns it at
    // the source (GitHub issue/PR or Linear issue) so "who's on it" is visible
    // outside OpenChamber too. Best-effort: a failure here must not undo the
    // already-applied local status change.
    let assigneeSyncWarning;
    const startingWork = patch.status === 'in_progress' && before.status !== 'in_progress';
    if (startingWork && !patch.assignee && !before.assignee) {
      try {
        if (before.source === 'github' && before.repo) {
          const octokit = getOctokitOrNull();
          if (octokit) {
            const result = await assignGitHubIssueToViewer(octokit, before.repo, before.sourceId);
            if (result.changed) {
              updated = patchItem(req.params.id, { assignee: result.assigneeName }) || updated;
            } else {
              assigneeSyncWarning = 'assignee-not-set';
            }
          }
        } else if (before.source === 'linear') {
          const result = await assignIssueToViewer({ issueId: before.sourceId });
          if (result.changed) {
            updated = patchItem(req.params.id, { assignee: result.assigneeName }) || updated;
          } else {
            assigneeSyncWarning = 'assignee-not-set';
          }
        }
      } catch (error) {
        console.warn('[workqueue] assignee sync failed:', error?.message || error);
        assigneeSyncWarning = 'assignee-sync-failed';
      }
    }

    // A GitHub-sourced item has no Linear presence at all until now — taking
    // it into progress is the trigger to mirror it into Linear (create +
    // assign) so it is visible there too. Only runs once per item (skipped
    // once `linkedLinearId` is set) and only when Linear is actually
    // connected, so disconnected setups get no noisy warning.
    let linearCreateWarning;
    if (startingWork && before.source === 'github' && !before.linkedLinearId && getLinearAuth()) {
      const mirrored = await mirrorGithubItemToLinear(before);
      if (mirrored.patch) {
        updated = patchItem(req.params.id, mirrored.patch) || updated;
      } else if (mirrored.warning) {
        linearCreateWarning = mirrored.warning;
      }
    }

    res.json({
      item: updated,
      ...(linearSyncWarning ? { linearSyncWarning } : {}),
      ...(assigneeSyncWarning ? { assigneeSyncWarning } : {}),
      ...(linearCreateWarning ? { linearCreateWarning } : {}),
    });
  });

  app.post('/api/workqueue/items/:id/finish', async (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const closeReason = ['completed', 'duplicate', 'not_planned'].includes(req.body?.closeReason)
      ? req.body.closeReason
      : 'completed';
    const duplicateOfUrl = typeof req.body?.duplicateOfUrl === 'string' ? req.body.duplicateOfUrl.trim() : undefined;
    try {
      const result = await finishItem(item, { mergePr: req.body?.mergePr === true, closeReason, duplicateOfUrl });
      res.json(result);
    } catch (error) {
      console.error('[workqueue] finish failed:', error);
      res.status(500).json({ error: safeErrorMessage(error) });
    }
  });

  // What would be sent to Cursor, so the client can show and edit the prompt
  // and model before anything is dispatched.
  app.get('/api/workqueue/items/:id/cloud-agent/draft', (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.source !== 'github' || !item.repo) {
      return res.status(400).json({ error: 'Cloud agent requires a GitHub-sourced item' });
    }
    res.json({
      prompt: buildCloudAgentPrompt(item),
      model: DEFAULT_CURSOR_MODEL,
      repository: `https://github.com/${item.repo}`,
      connected: Boolean(getCursorApiKey()),
      apiVersion: getCursorApiVersion(),
    });
  });

  app.post('/api/workqueue/items/:id/cloud-agent', async (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.source !== 'github' || !item.repo) {
      return res.status(400).json({ error: 'Cloud agent requires a GitHub-sourced item' });
    }
    const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
      ? req.body.prompt.trim()
      : buildCloudAgentPrompt(item);
    if (!prompt) {
      return res.status(400).json({ error: 'No prompt available' });
    }
    const model = typeof req.body?.model === 'string' && req.body.model.trim()
      ? req.body.model.trim()
      : DEFAULT_CURSOR_MODEL;
    const repository = typeof req.body?.repository === 'string' && req.body.repository.trim()
      ? req.body.repository.trim()
      : `https://github.com/${item.repo}`;
    try {
      const launchApiVersion = getCursorApiVersion();
      const agent = await launchCursorAgent({ prompt, repoUrl: repository, model, apiVersion: launchApiVersion });
      const updated = patchItem(item.id, {
        cloudAgent: { ...normalizeCursorAgent(agent, launchApiVersion), model },
        // A dispatched agent is active work: surface it in the in-progress lane
        // rather than leaving the card sitting in todo.
        status: item.status === 'todo' ? 'in_progress' : item.status,
      });
      res.json({ item: updated });
    } catch (error) {
      if (error instanceof CursorApiError && error.code === 'CURSOR_NOT_CONNECTED') {
        return res.status(401).json({ error: 'Cursor is not connected' });
      }
      if (error instanceof CursorApiError && error.code === 'CURSOR_API_TIMEOUT') {
        console.warn('[workqueue] cloud agent launch timed out:', safeErrorMessage(error));
        return res.status(504).json({ error: safeErrorMessage(error) });
      }
      console.warn('[workqueue] cloud agent launch failed:', safeErrorMessage(error));
      res.status(502).json({ error: safeErrorMessage(error) });
    }
  });

  app.get('/api/workqueue/items/:id/cloud-agent/status', async (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.cloudAgent?.agentId) {
      return res.json({ cloudAgent: null });
    }
    try {
      const agent = await getCursorAgent(item.cloudAgent.agentId, {
        apiVersion: item.cloudAgent.apiVersion,
        runId: item.cloudAgent.runId,
        cloudAgent: item.cloudAgent,
      });
      const updated = patchItem(item.id, {
        cloudAgent: {
          ...item.cloudAgent,
          status: typeof agent?.status === 'string' ? agent.status : item.cloudAgent.status,
          url: typeof agent?.target?.url === 'string' ? agent.target.url : item.cloudAgent.url,
          branchName: typeof agent?.target?.branchName === 'string'
            ? agent.target.branchName
            : item.cloudAgent.branchName,
        },
      });
      res.json({ cloudAgent: updated.cloudAgent });
    } catch (error) {
      if (error instanceof CursorApiError && error.code === 'CURSOR_API_TIMEOUT') {
        console.warn('[workqueue] cloud agent status timed out:', safeErrorMessage(error));
        return res.status(504).json({ error: safeErrorMessage(error) });
      }
      console.warn('[workqueue] cloud agent status check failed:', safeErrorMessage(error));
      res.status(502).json({ error: safeErrorMessage(error) });
    }
  });

  app.get('/api/workqueue/settings/repos', (_req, res) => {
    res.json({ repos: getTrackedRepos() });
  });

  app.put('/api/workqueue/settings/repos', (req, res) => {
    const repos = Array.isArray(req.body?.repos) ? req.body.repos : [];
    res.json({ repos: setTrackedRepos(repos) });
  });

  app.get('/api/workqueue/settings/cursor-auth', (_req, res) => {
    const apiKey = getCursorApiKey();
    res.json({
      connected: Boolean(apiKey),
      configuredViaEnv: isCursorConfiguredViaEnv(),
      apiVersion: getCursorApiVersion(),
      versionConfiguredViaEnv: isCursorApiVersionConfiguredViaEnv(),
    });
  });

  app.put('/api/workqueue/settings/cursor-version', (req, res) => {
    const apiVersion = typeof req.body?.apiVersion === 'string' ? req.body.apiVersion.trim() : '';
    if (!['v0', 'v1'].includes(apiVersion)) {
      return res.status(400).json({ error: 'apiVersion must be "v0" or "v1"' });
    }
    try {
      setCursorApiVersion(apiVersion);
      res.json({ apiVersion: getCursorApiVersion() });
    } catch (error) {
      res.status(400).json({ error: safeErrorMessage(error) });
    }
  });

  app.post('/api/workqueue/settings/cursor-auth', async (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    try {
      setCursorApiKey(apiKey);
      await verifyCursorApiKey();
      res.json({ connected: true });
    } catch (error) {
      clearCursorApiKey();
      if (error instanceof CursorApiError && (error.status === 401 || error.status === 403)) {
        return res.status(401).json({ error: 'Cursor rejected the API key' });
      }
      console.warn('[workqueue] Cursor key validation failed:', safeErrorMessage(error));
      res.status(502).json({ error: safeErrorMessage(error) });
    }
  });

  app.delete('/api/workqueue/settings/cursor-auth', (_req, res) => {
    res.json({ removed: clearCursorApiKey() });
  });
}
