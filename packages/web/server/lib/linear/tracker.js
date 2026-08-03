import { getLinearAuth, getLinearAutomationSettings } from './auth.js';
import { createIssueComment, moveIssueToStateType } from './client.js';
import { getSessionLink, updateSessionLink } from './links.js';

// Terminal lifecycle states: after one of these is reported to Linear, no
// further status comments are posted for the session.
const TERMINAL_STATUSES = new Set(['completed', 'error']);

const extractSessionId = (properties) => {
  if (!properties || typeof properties !== 'object') return '';
  const candidates = [
    properties.sessionID,
    properties.sessionId,
    properties.info?.id,
    properties.session?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
};

// Maps an OpenCode global event payload to the Linear lifecycle status it
// implies, or null when the event is not status-relevant.
export const mapPayloadToStatus = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const properties = payload.properties && typeof payload.properties === 'object'
    ? payload.properties
    : {};

  if (type === 'session.idle') {
    const sessionId = extractSessionId(properties);
    return sessionId ? { sessionId, status: 'completed' } : null;
  }

  if (type === 'session.status') {
    const statusInfo = properties.status && typeof properties.status === 'object' ? properties.status : {};
    const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
    const statusType = typeof statusInfo.type === 'string'
      ? statusInfo.type
      : (typeof info.type === 'string' ? info.type : '');
    if (statusType !== 'idle') {
      return null;
    }
    const sessionId = extractSessionId(properties);
    return sessionId ? { sessionId, status: 'completed' } : null;
  }

  if (type === 'session.error') {
    const sessionId = extractSessionId(properties);
    return sessionId ? { sessionId, status: 'error' } : null;
  }

  if (type === 'permission.asked' || type === 'question.asked') {
    const sessionId = extractSessionId(properties);
    return sessionId ? { sessionId, status: 'attention' } : null;
  }

  return null;
};

const buildStatusCommentBody = ({ link, status }) => {
  const title = link.sessionTitle || link.sessionId;
  const sessionRef = link.sessionUrl ? `[${title}](${link.sessionUrl})` : title;
  if (status === 'completed') {
    return `**OpenChamber session completed**: ${sessionRef}`;
  }
  if (status === 'error') {
    return `**OpenChamber session failed**: ${sessionRef}`;
  }
  return `**OpenChamber session needs attention** (waiting for input): ${sessionRef}`;
};

export const createLinearStatusTracker = ({ postComment, moveIssue, logger = console } = {}) => {
  const post = typeof postComment === 'function' ? postComment : createIssueComment;
  const move = typeof moveIssue === 'function' ? moveIssue : moveIssueToStateType;

  const maybeMoveToDone = async (link, status) => {
    if (status !== 'completed') return;
    if (!getLinearAutomationSettings().moveToDoneOnComplete) return;
    if (!link.teamId) return;
    try {
      await move({ issueId: link.issueId, teamId: link.teamId, stateType: 'completed' });
    } catch (error) {
      // A failed state transition must not lose the already-posted comment or
      // block the notification bookkeeping.
      logger.warn?.('[linear] failed to move issue to completed state:', error?.message || error);
    }
  };

  const notifyStatus = async (sessionId, status) => {
    const link = getSessionLink(sessionId);
    if (!link) {
      return { posted: false, reason: 'not-linked' };
    }
    const notified = Array.isArray(link.notifiedStatuses) ? link.notifiedStatuses : [];
    if (notified.some((entry) => TERMINAL_STATUSES.has(entry))) {
      return { posted: false, reason: 'terminal-already-notified' };
    }
    if (notified.includes(status)) {
      return { posted: false, reason: 'already-notified' };
    }
    if (!getLinearAuth()) {
      return { posted: false, reason: 'not-connected' };
    }

    try {
      await post({ issueId: link.issueId, body: buildStatusCommentBody({ link, status }) });
    } catch (error) {
      // The link record deliberately keeps its prior notification state so the
      // next matching event retries the comment instead of silently losing it.
      logger.warn?.('[linear] failed to post status comment:', error?.message || error);
      return { posted: false, reason: 'comment-failed', error: error?.message || String(error) };
    }

    updateSessionLink(sessionId, {
      status,
      statusUpdatedAt: Date.now(),
      notifiedStatuses: [...notified, status],
    });
    await maybeMoveToDone(getSessionLink(sessionId) ?? link, status);
    return { posted: true };
  };

  // Per-session serialization: OpenCode emits session.idle and
  // session.status{idle} back to back, and the file-backed link store is
  // check-then-act — without a queue two concurrent notifications for the same
  // status both pass the dedup guard and double-post to Linear.
  const inFlightBySession = new Map();

  const notifyStatusSerialized = (sessionId, status) => {
    const previous = inFlightBySession.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => notifyStatus(sessionId, status));
    // The stored chain never rejects, so a failed notification cannot wedge
    // later events for the same session; entries self-clean on settle.
    const tracked = next.catch(() => {}).finally(() => {
      if (inFlightBySession.get(sessionId) === tracked) {
        inFlightBySession.delete(sessionId);
      }
    });
    inFlightBySession.set(sessionId, tracked);
    return next;
  };

  const processPayload = (payload) => {
    const mapped = mapPayloadToStatus(payload);
    if (!mapped) {
      return false;
    }
    void notifyStatusSerialized(mapped.sessionId, mapped.status);
    return true;
  };

  return {
    processPayload,
    notifyStatus: notifyStatusSerialized,
  };
};

let sharedTracker = null;

export const getLinearStatusTracker = () => {
  if (!sharedTracker) {
    sharedTracker = createLinearStatusTracker();
  }
  return sharedTracker;
};
