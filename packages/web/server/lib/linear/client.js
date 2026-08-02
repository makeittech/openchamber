import { getLinearAuth, setLinearAuth, isLinearAuthExpired, getLinearClientConfig } from './auth.js';
import { refreshAccessToken } from './oauth.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

class LinearApiError extends Error {
  constructor(message, { status = 0, graphQLErrors = null } = {}) {
    super(message);
    this.name = 'LinearApiError';
    this.status = status;
    this.graphQLErrors = graphQLErrors;
  }
}

const isAuthFailure = (error) => {
  if (error?.status === 401 || error?.status === 403) return true;
  const messages = Array.isArray(error?.graphQLErrors) ? error.graphQLErrors : [];
  return messages.some((entry) => typeof entry?.message === 'string'
    && /authentication|unauthorized|invalid token/i.test(entry.message));
};

const REQUEST_TIMEOUT_MS = 15_000;

// Linear personal API keys (`lin_api_…`) are sent as-is; OAuth access tokens
// require the Bearer scheme. Linear rejects keys sent with the wrong shape.
const buildAuthorizationHeader = (accessToken) => (
  accessToken.startsWith('lin_api_') ? accessToken : `Bearer ${accessToken}`
);

export const linearGraphQL = async ({ query, variables, accessToken, fetchImpl = fetch }) => {
  let response;
  try {
    response = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: buildAuthorizationHeader(accessToken),
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LinearApiError(`Linear API request failed: ${error?.message || error}`, { status: 0 });
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new LinearApiError(`Linear API request failed (${response.status})`, { status: response.status });
  }
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const message = body.errors
      .map((entry) => (typeof entry?.message === 'string' ? entry.message : 'Unknown error'))
      .join('; ');
    throw new LinearApiError(message, { status: response.status, graphQLErrors: body.errors });
  }
  if (!body || typeof body.data !== 'object' || body.data === null) {
    throw new LinearApiError('Linear API returned an empty response', { status: response.status });
  }
  return body.data;
};

// Returns a usable auth record, transparently refreshing the access token when
// it is expired and a refresh token is available. Returns null when no usable
// credentials exist (disconnected, or refresh rejected by Linear).
const getValidLinearAuth = async ({ fetchImpl = fetch } = {}) => {
  const auth = getLinearAuth();
  if (!auth) {
    return null;
  }
  if (!isLinearAuthExpired(auth)) {
    return auth;
  }
  if (!auth.refreshToken) {
    return null;
  }
  const { clientId, clientSecret, configured } = getLinearClientConfig();
  if (!configured) {
    return null;
  }
  try {
    const tokens = await refreshAccessToken({
      refreshToken: auth.refreshToken,
      clientId,
      clientSecret,
      fetchImpl,
    });
    return setLinearAuth({
      ...auth,
      ...tokens,
      createdAt: auth.createdAt,
    });
  } catch (error) {
    console.warn('[linear] token refresh failed:', error?.message || error);
    return null;
  }
};

export const graphqlWithStoredAuth = async ({ query, variables, fetchImpl = fetch }) => {
  const auth = await getValidLinearAuth({ fetchImpl });
  if (!auth) {
    const error = new LinearApiError('Linear is not connected', { status: 401 });
    error.code = 'LINEAR_NOT_CONNECTED';
    throw error;
  }
  try {
    return await linearGraphQL({ query, variables, accessToken: auth.accessToken, fetchImpl });
  } catch (error) {
    if (isAuthFailure(error) && auth.refreshToken) {
      const { clientId, clientSecret, configured } = getLinearClientConfig();
      if (configured) {
        try {
          const tokens = await refreshAccessToken({
            refreshToken: auth.refreshToken,
            clientId,
            clientSecret,
            fetchImpl,
          });
          const refreshed = setLinearAuth({ ...auth, ...tokens, createdAt: auth.createdAt });
          return await linearGraphQL({ query, variables, accessToken: refreshed.accessToken, fetchImpl });
        } catch {
          // fall through to the original error
        }
      }
    }
    throw error;
  }
};

const VIEWER_QUERY = `query OpenChamberViewer {
  viewer {
    id
    name
    displayName
    email
    avatarUrl
    organization { id name urlKey }
  }
}`;

export const fetchViewer = async ({ accessToken, fetchImpl = fetch }) => {
  const data = await linearGraphQL({ query: VIEWER_QUERY, accessToken, fetchImpl });
  return data.viewer ?? null;
};

// Same viewer lookup but using the already-stored connection, for callers
// that act on behalf of "me" after Linear is connected (e.g. self-assign).
export const fetchViewerWithStoredAuth = async ({ fetchImpl = fetch } = {}) => {
  const data = await graphqlWithStoredAuth({ query: VIEWER_QUERY, fetchImpl });
  return data.viewer ?? null;
};

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  createdAt
  updatedAt
  state { name type position }
  team { id key name }
  assignee { id name displayName avatarUrl }
  creator { id name displayName avatarUrl }
  labels { nodes { name color } }
  priority
  estimate
`;

export const ISSUE_BY_ID_QUERY = `query OpenChamberIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;

export const ISSUES_ASSIGNED_QUERY = `query OpenChamberAssignedIssues($first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["canceled"] } } }
    orderBy: updatedAt
  ) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const ISSUE_SEARCH_QUERY = `query OpenChamberIssueSearch($query: String!, $first: Int!, $after: String) {
  issueSearch(query: $query, first: $first, after: $after, includeArchived: false) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COMMENT_CREATE_MUTATION = `mutation OpenChamberCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id }
  }
}`;

const ATTACHMENT_CREATE_MUTATION = `mutation OpenChamberAttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
    attachment { id }
  }
}`;

export const createIssueComment = async ({ issueId, body, fetchImpl = fetch }) => {
  const data = await graphqlWithStoredAuth({
    query: COMMENT_CREATE_MUTATION,
    variables: { input: { issueId, body } },
    fetchImpl,
  });
  return data.commentCreate ?? null;
};

export const createIssueAttachment = async ({ issueId, title, url, subtitle, fetchImpl = fetch }) => {
  const data = await graphqlWithStoredAuth({
    query: ATTACHMENT_CREATE_MUTATION,
    variables: {
      input: {
        issueId,
        title,
        url,
        ...(subtitle ? { subtitle } : {}),
      },
    },
    fetchImpl,
  });
  return data.attachmentCreate ?? null;
};

const TEAM_STATES_QUERY = `query OpenChamberTeamStates($id: String!) {
  team(id: $id) {
    id
    states { nodes { id name type position } }
  }
}`;

const ISSUE_UPDATE_STATE_MUTATION = `mutation OpenChamberIssueUpdateState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id state { name type } }
  }
}`;

// Moves an issue to a workflow state of the requested type. When a team has
// several states of that type (e.g. "canceled" commonly covers both
// "Duplicate" and "Won't fix" as distinct named states), `preferNameMatch`
// picks the one whose name matches first; otherwise the lowest-position
// (first) state of that type is used, same as before. Returns
// { changed, stateName } or { changed: false, reason } when the team has no
// such state. Callers decide whether a transition is appropriate.
export const moveIssueToStateType = async ({ issueId, teamId, stateType, preferNameMatch, fetchImpl = fetch }) => {
  if (!issueId || !teamId || !stateType) {
    return { changed: false, reason: 'missing-arguments' };
  }
  const teamData = await graphqlWithStoredAuth({
    query: TEAM_STATES_QUERY,
    variables: { id: teamId },
    fetchImpl,
  });
  const states = Array.isArray(teamData?.team?.states?.nodes) ? teamData.team.states.nodes : [];
  const candidates = states
    .filter((state) => state && state.type === stateType && typeof state.id === 'string')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const target = (preferNameMatch instanceof RegExp
    ? candidates.find((state) => preferNameMatch.test(state.name || ''))
    : null) ?? candidates[0];
  if (!target) {
    return { changed: false, reason: 'no-matching-state' };
  }
  const updated = await graphqlWithStoredAuth({
    query: ISSUE_UPDATE_STATE_MUTATION,
    variables: { id: issueId, stateId: target.id },
    fetchImpl,
  });
  const payload = updated?.issueUpdate;
  if (!payload?.success) {
    return { changed: false, reason: 'update-failed' };
  }
  return { changed: true, stateName: payload.issue?.state?.name ?? target.name ?? '' };
};

const TEAMS_QUERY = `query OpenChamberTeams($first: Int!) {
  teams(first: $first) {
    nodes { id key name }
  }
}`;

// Lists teams visible to the connected account. Used to pick a default team
// when creating a brand-new Linear issue from a GitHub-sourced Work Queue
// item that has no team of its own.
export const fetchTeamsWithStoredAuth = async ({ fetchImpl = fetch } = {}) => {
  const data = await graphqlWithStoredAuth({ query: TEAMS_QUERY, variables: { first: 100 }, fetchImpl });
  return Array.isArray(data?.teams?.nodes) ? data.teams.nodes : [];
};

const ISSUE_CREATE_MUTATION = `mutation OpenChamberIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { ${ISSUE_FIELDS} }
  }
}`;

// Creates a new Linear issue, e.g. to mirror a GitHub-sourced Work Queue item
// into Linear the first time someone starts work on it. Returns the created
// issue (with its `identifier`) or throws on failure — callers treat this as
// best-effort and must not undo an already-applied local status change.
export const createIssue = async ({ teamId, title, description, fetchImpl = fetch }) => {
  if (!teamId || !title) {
    const error = new LinearApiError('teamId and title are required to create a Linear issue', { status: 400 });
    throw error;
  }
  const data = await graphqlWithStoredAuth({
    query: ISSUE_CREATE_MUTATION,
    variables: { input: { teamId, title, description: description || undefined } },
    fetchImpl,
  });
  const payload = data?.issueCreate;
  if (!payload?.success || !payload.issue) {
    throw new LinearApiError('Linear rejected issue creation', { status: 0 });
  }
  return payload.issue;
};

const ISSUE_UPDATE_ASSIGNEE_MUTATION = `mutation OpenChamberIssueUpdateAssignee($id: String!, $assigneeId: String!) {
  issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
    success
    issue { id assignee { id name displayName } }
  }
}`;

// Assigns an issue to the connected Linear account ("me"). Returns
// { changed, assigneeName } or { changed: false, reason } — callers treat
// this as best-effort and must not undo an already-applied local change.
export const assignIssueToViewer = async ({ issueId, fetchImpl = fetch }) => {
  if (!issueId) {
    return { changed: false, reason: 'missing-arguments' };
  }
  const viewer = await fetchViewerWithStoredAuth({ fetchImpl });
  if (!viewer?.id) {
    return { changed: false, reason: 'no-viewer' };
  }
  const updated = await graphqlWithStoredAuth({
    query: ISSUE_UPDATE_ASSIGNEE_MUTATION,
    variables: { id: issueId, assigneeId: viewer.id },
    fetchImpl,
  });
  const payload = updated?.issueUpdate;
  if (!payload?.success) {
    return { changed: false, reason: 'update-failed' };
  }
  const assignee = payload.issue?.assignee;
  return { changed: true, assigneeName: assignee?.displayName || assignee?.name || '' };
};
