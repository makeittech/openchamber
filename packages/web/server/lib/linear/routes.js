import {
  getLinearAuth,
  setLinearAuth,
  clearLinearAuth,
  getLinearClientConfig,
  getLinearAutomationSettings,
  setLinearAutomationSettings,
} from './auth.js';
import {
  buildAuthorizeUrl,
  createOAuthState,
  consumeOAuthState,
  exchangeCodeForTokens,
} from './oauth.js';
import {
  graphqlWithStoredAuth,
  fetchViewer,
  createIssueComment,
  createIssueAttachment,
  moveIssueToStateType,
  ISSUE_BY_ID_QUERY,
  ISSUES_ASSIGNED_QUERY,
  ISSUE_SEARCH_QUERY,
} from './client.js';
import { addSessionLink, listSessionLinks } from './links.js';

const ISSUES_PAGE_SIZE = 20;

const safeErrorMessage = (error, maxLength = 500) => {
  const raw = error instanceof Error ? (error.message || String(error)) : String(error ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) return 'Unknown error';
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const isNotConnectedError = (error) => error?.code === 'LINEAR_NOT_CONNECTED' || error?.status === 401;

// Accepts a Linear issue UUID, a TEAM-123 identifier, or a full issue URL and
// returns the value the GraphQL `issue(id:)` query understands.
export const parseIssueRef = (input) => {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)(?:[/?#]|$)/i);
  if (urlMatch) {
    return urlMatch[1].toUpperCase();
  }

  if (/^[A-Za-z]+-\d+$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }

  return null;
};

const toIssueSummary = (issue) => {
  if (!issue || typeof issue !== 'object') return null;
  return {
    id: typeof issue.id === 'string' ? issue.id : '',
    identifier: typeof issue.identifier === 'string' ? issue.identifier : '',
    title: typeof issue.title === 'string' ? issue.title : '',
    url: typeof issue.url === 'string' ? issue.url : '',
    state: issue.state && typeof issue.state === 'object'
      ? { name: issue.state.name ?? '', type: issue.state.type ?? '' }
      : null,
    team: issue.team && typeof issue.team === 'object'
      ? { id: issue.team.id ?? '', key: issue.team.key ?? '', name: issue.team.name ?? '' }
      : null,
    assignee: issue.assignee && typeof issue.assignee === 'object'
      ? {
        id: issue.assignee.id ?? null,
        name: issue.assignee.name ?? null,
        displayName: issue.assignee.displayName ?? null,
        avatarUrl: issue.assignee.avatarUrl ?? null,
      }
      : null,
    labels: Array.isArray(issue.labels?.nodes)
      ? issue.labels.nodes
        .filter((label) => label && typeof label.name === 'string')
        .map((label) => ({ name: label.name, color: typeof label.color === 'string' ? label.color : undefined }))
      : [],
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : undefined,
  };
};

const getRequestOrigin = (req) => {
  const proto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : (req.protocol || 'http');
  const host = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : req.headers.host;
  if (!host) return null;
  return `${proto}://${host}`;
};

// The redirect URI must target this server's callback. A client-supplied value
// is accepted only when it matches the request origin (or the explicit env
// override used for tunnel deployments); Linear additionally enforces its own
// registered-redirect list, so mismatches fail at Linear, not here.
const resolveRedirectUri = (req, requested) => {
  const envOverride = typeof process.env.OPENCHAMBER_LINEAR_REDIRECT_URI === 'string'
    ? process.env.OPENCHAMBER_LINEAR_REDIRECT_URI.trim()
    : '';
  if (envOverride) {
    return envOverride;
  }
  const origin = getRequestOrigin(req);
  const fallback = origin ? `${origin}/api/linear/auth/callback` : null;
  if (typeof requested === 'string' && requested.trim()) {
    const candidate = requested.trim();
    if (fallback && candidate === fallback) {
      return candidate;
    }
    return { error: 'redirectUri does not match this server' };
  }
  return fallback;
};

const isValidSessionUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const trimmed = value.trim();
  if (trimmed.startsWith('/')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

export function registerLinearRoutes(app) {
  app.get('/api/linear/auth/status', async (_req, res) => {
    const { configured } = getLinearClientConfig();
    const auth = getLinearAuth();
    res.json({
      configured,
      connected: Boolean(auth?.accessToken),
      kind: auth?.kind ?? null,
      user: auth?.user ?? null,
      organization: auth?.organization ?? null,
      scope: auth?.scope ?? '',
      automation: getLinearAutomationSettings(),
    });
  });

  // Personal API keys are an alternative to the OAuth app flow (e.g. for
  // self-hosted setups without a registered Linear OAuth application). The
  // key is validated against the viewer query before being stored; it never
  // leaves the server and is persisted like OAuth tokens (0600, atomic).
  app.post('/api/linear/auth/apikey', async (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    if (!/^lin_api_[A-Za-z0-9]+$/.test(apiKey)) {
      return res.status(400).json({ error: 'Invalid Linear API key format' });
    }
    try {
      const viewer = await fetchViewer({ accessToken: apiKey });
      if (!viewer?.id) {
        return res.status(401).json({ error: 'Linear rejected the API key' });
      }
      setLinearAuth({
        accessToken: apiKey,
        kind: 'api_key',
        tokenType: 'Bearer',
        scope: '',
        user: {
          id: viewer.id ?? null,
          name: viewer.name ?? null,
          displayName: viewer.displayName ?? null,
          email: viewer.email ?? null,
          avatarUrl: viewer.avatarUrl ?? null,
        },
        organization: viewer.organization
          ? {
            id: viewer.organization.id ?? null,
            name: viewer.organization.name ?? null,
            urlKey: viewer.organization.urlKey ?? null,
          }
          : null,
      });
      return res.json({
        connected: true,
        kind: 'api_key',
        user: getLinearAuth()?.user ?? null,
        organization: getLinearAuth()?.organization ?? null,
        automation: getLinearAutomationSettings(),
      });
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        return res.status(401).json({ error: 'Linear rejected the API key' });
      }
      console.warn('[linear] API key validation failed:', safeErrorMessage(error));
      return res.status(502).json({ error: safeErrorMessage(error) });
    }
  });

  app.put('/api/linear/auth/settings', (req, res) => {
    const automation = setLinearAutomationSettings(req.body ?? {});
    res.json({ automation });
  });

  app.post('/api/linear/auth/start', (req, res) => {
    const { clientId, configured } = getLinearClientConfig();
    if (!configured) {
      return res.status(400).json({
        error: 'Linear OAuth client is not configured',
        configured: false,
      });
    }
    const redirectUri = resolveRedirectUri(req, req.body?.redirectUri);
    if (!redirectUri || typeof redirectUri !== 'string') {
      return res.status(400).json({ error: redirectUri?.error || 'Could not resolve the OAuth redirect URI' });
    }
    const state = createOAuthState({ redirectUri });
    const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });
    return res.json({ authorizeUrl });
  });

  // This route is exempt from the UI auth gate (see requireApiAuth in
  // core-routes.js): Linear's redirect is a cross-site top-level navigation,
  // so the SameSite=Strict session cookie is not attached. The single-use
  // OAuth state parameter is the credential for this request instead.
  app.get('/api/linear/auth/callback', async (req, res) => {
    const finish = (query) => {
      const params = new URLSearchParams(query);
      res.redirect(`/?${params.toString()}`);
    };

    const errorParam = typeof req.query?.error === 'string' ? req.query.error : '';
    if (errorParam) {
      return finish({ linearAuth: 'error', reason: errorParam });
    }

    const code = typeof req.query?.code === 'string' ? req.query.code : '';
    const state = typeof req.query?.state === 'string' ? req.query.state : '';
    const pending = consumeOAuthState(state);
    if (!code || !pending) {
      return finish({ linearAuth: 'error', reason: 'invalid_state' });
    }

    const { clientId, clientSecret, configured } = getLinearClientConfig();
    if (!configured) {
      return finish({ linearAuth: 'error', reason: 'not_configured' });
    }

    try {
      const tokens = await exchangeCodeForTokens({
        code,
        redirectUri: pending.redirectUri,
        clientId,
        clientSecret,
      });
      const viewer = await fetchViewer({ accessToken: tokens.accessToken }).catch(() => null);
      setLinearAuth({
        ...tokens,
        user: viewer
          ? {
            id: viewer.id ?? null,
            name: viewer.name ?? null,
            displayName: viewer.displayName ?? null,
            email: viewer.email ?? null,
            avatarUrl: viewer.avatarUrl ?? null,
          }
          : null,
        organization: viewer?.organization
          ? {
            id: viewer.organization.id ?? null,
            name: viewer.organization.name ?? null,
            urlKey: viewer.organization.urlKey ?? null,
          }
          : null,
      });
      return finish({ linearAuth: 'connected' });
    } catch (error) {
      console.warn('[linear] OAuth callback failed:', safeErrorMessage(error));
      return finish({ linearAuth: 'error', reason: 'exchange_failed' });
    }
  });

  app.delete('/api/linear/auth', (_req, res) => {
    const removed = clearLinearAuth();
    res.json({ removed });
  });

  app.get('/api/linear/issues', async (req, res) => {
    const query = typeof req.query?.query === 'string' ? req.query.query.trim() : '';
    const cursor = typeof req.query?.cursor === 'string' && req.query.cursor.trim()
      ? req.query.cursor.trim()
      : null;

    try {
      const data = query
        ? await graphqlWithStoredAuth({
          query: ISSUE_SEARCH_QUERY,
          variables: { query, first: ISSUES_PAGE_SIZE, after: cursor },
        })
        : await graphqlWithStoredAuth({
          query: ISSUES_ASSIGNED_QUERY,
          variables: { first: ISSUES_PAGE_SIZE, after: cursor },
        });
      const connection = query ? data.issueSearch : data.issues;
      const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
      res.json({
        connected: true,
        issues: nodes.map(toIssueSummary).filter(Boolean),
        hasMore: Boolean(connection?.pageInfo?.hasNextPage),
        endCursor: typeof connection?.pageInfo?.endCursor === 'string' ? connection.pageInfo.endCursor : null,
      });
    } catch (error) {
      if (isNotConnectedError(error)) {
        return res.json({ connected: false, issues: [], hasMore: false, endCursor: null });
      }
      console.warn('[linear] issues list failed:', safeErrorMessage(error));
      res.status(502).json({ error: safeErrorMessage(error) });
    }
  });

  app.get('/api/linear/issue', async (req, res) => {
    const ref = parseIssueRef(typeof req.query?.id === 'string' ? req.query.id : '');
    if (!ref) {
      return res.status(400).json({ error: 'Provide an issue identifier (TEAM-123), UUID, or Linear issue URL' });
    }

    try {
      const data = await graphqlWithStoredAuth({ query: ISSUE_BY_ID_QUERY, variables: { id: ref } });
      const issue = data.issue ?? null;
      if (!issue) {
        return res.json({ connected: true, issue: null });
      }
      const summary = toIssueSummary(issue);
      res.json({
        connected: true,
        issue: {
          ...summary,
          description: typeof issue.description === 'string' ? issue.description : '',
          creator: issue.creator && typeof issue.creator === 'object'
            ? {
              id: issue.creator.id ?? null,
              name: issue.creator.name ?? null,
              displayName: issue.creator.displayName ?? null,
              avatarUrl: issue.creator.avatarUrl ?? null,
            }
            : null,
          priority: typeof issue.priority === 'number' ? issue.priority : null,
          estimate: typeof issue.estimate === 'number' ? issue.estimate : null,
          createdAt: typeof issue.createdAt === 'string' ? issue.createdAt : undefined,
        },
      });
    } catch (error) {
      if (isNotConnectedError(error)) {
        return res.json({ connected: false, issue: null });
      }
      console.warn('[linear] issue fetch failed:', safeErrorMessage(error));
      res.status(502).json({ error: safeErrorMessage(error) });
    }
  });

  app.get('/api/linear/sessions', (req, res) => {
    const issueId = typeof req.query?.issueId === 'string' ? req.query.issueId.trim() : '';
    const sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!issueId && !sessionId) {
      return res.status(400).json({ error: 'issueId or sessionId is required' });
    }
    res.json({ links: listSessionLinks(issueId ? { issueId } : { sessionId }) });
  });

  // Links an already-created OpenChamber session to a Linear issue: records the
  // mapping, announces the session on the issue (comment + attachment), and
  // enrolls the session in lifecycle status tracking.
  app.post('/api/linear/sessions', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ref = parseIssueRef(typeof body.issue === 'string' ? body.issue : '');
    const session = body.session && typeof body.session === 'object' ? body.session : {};
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    if (!ref || !sessionId) {
      return res.status(400).json({ error: 'issue and session.id are required' });
    }

    let issue;
    try {
      const data = await graphqlWithStoredAuth({ query: ISSUE_BY_ID_QUERY, variables: { id: ref } });
      issue = data.issue ?? null;
    } catch (error) {
      if (isNotConnectedError(error)) {
        return res.status(401).json({ connected: false, error: 'Linear is not connected' });
      }
      console.warn('[linear] attach failed to load issue:', safeErrorMessage(error));
      return res.status(502).json({ error: safeErrorMessage(error) });
    }
    if (!issue) {
      return res.status(404).json({ error: 'Linear issue not found' });
    }

    const origin = getRequestOrigin(req);
    const sessionTitle = typeof session.title === 'string' && session.title.trim()
      ? session.title.trim()
      : `${issue.identifier ?? 'Linear'} session`;
    const sessionUrl = isValidSessionUrl(session.url)
      ? session.url.trim()
      : (origin ? `${origin}/?session=${encodeURIComponent(sessionId)}` : `/?session=${encodeURIComponent(sessionId)}`);

    const link = addSessionLink({
      issueId: issue.id,
      issueIdentifier: typeof issue.identifier === 'string' ? issue.identifier : '',
      issueTitle: typeof issue.title === 'string' ? issue.title : '',
      issueUrl: typeof issue.url === 'string' ? issue.url : '',
      teamId: typeof issue.team?.id === 'string' ? issue.team.id : '',
      sessionId,
      directory: typeof session.directory === 'string' ? session.directory : '',
      sessionTitle,
      sessionUrl,
      status: 'started',
      statusUpdatedAt: Date.now(),
    });

    // Best-effort fan-out: the link record is authoritative, so partial Linear
    // failures surface as flags instead of failing the whole attach.
    let commentPosted = false;
    try {
      const body = `**OpenChamber session started**: [${sessionTitle}](${sessionUrl})`;
      const result = await createIssueComment({ issueId: issue.id, body });
      commentPosted = Boolean(result?.success);
    } catch (error) {
      console.warn('[linear] failed to post start comment:', safeErrorMessage(error));
    }

    let attachmentPosted = false;
    try {
      const result = await createIssueAttachment({
        issueId: issue.id,
        title: `OpenChamber: ${sessionTitle}`.slice(0, 255),
        url: sessionUrl,
        subtitle: `Session for ${link.issueIdentifier || 'issue'}`,
      });
      attachmentPosted = Boolean(result?.success);
    } catch (error) {
      console.warn('[linear] failed to create attachment:', safeErrorMessage(error));
    }

    // Best-effort workflow transition: starting work moves the issue to the
    // team's first "started" state (e.g. In Progress) when it is still in an
    // untouched state. Only runs when enabled in the automation settings.
    let stateChanged = false;
    let stateName = null;
    const automation = getLinearAutomationSettings();
    const currentStateType = typeof issue.state?.type === 'string' ? issue.state.type : '';
    if (automation.moveToInProgressOnStart
      && link.teamId
      && ['triage', 'backlog', 'unstarted'].includes(currentStateType)) {
      try {
        const moved = await moveIssueToStateType({
          issueId: issue.id,
          teamId: link.teamId,
          stateType: 'started',
        });
        stateChanged = Boolean(moved?.changed);
        stateName = moved?.stateName ?? null;
      } catch (error) {
        console.warn('[linear] failed to move issue to started state:', safeErrorMessage(error));
      }
    }

    res.json({ link, commentPosted, attachmentPosted, stateChanged, stateName });
  });
}
