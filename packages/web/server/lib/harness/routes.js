import express from 'express';
import { detectAllHarnesses, detectHarness } from './detect.js';
import { isKnownHarnessId } from './registry.js';
import {
  getSessionBinding,
  initSessionBindings,
} from './session-bindings.js';
import {
  getOrCreateSessionCapabilities,
} from './session-capabilities.js';
import { createHarnessRouter } from './router.js';
import { mergeHarnessActiveIntoSessionStatuses } from './session-status.js';
import { mergeHarnessMessagesIntoSessionMessages } from './session-messages.js';
import {
  createOpenCodeSessionFactory,
  importClaudeSessions,
  listClaudeImportCandidates,
} from './translators/claude-code/import-from-disk.js';
import { createOpenCodeCommandResolver } from './translators/claude-code/opencode-command.js';
import { createOpenCodeAgentResolver } from './translators/claude-code/opencode-agents.js';
import { listClaudeAgents } from './translators/claude-code/claude-agents.js';

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

const queryString = (req, key) => (typeof req.query?.[key] === 'string' ? req.query[key] : '');

export function registerHarnessRoutes(app, deps = {}) {
  const dep = (name, fallback) => (typeof deps[name] === 'function' ? deps[name] : fallback);
  const getBroadcast = dep('getBroadcastGlobalUiEvent', () => null);
  const getOpenCodeReady = () => {
    if (typeof deps.getOpenCodeReady === 'function') return deps.getOpenCodeReady() !== false;
    if (typeof deps.getOpenCodeReady === 'boolean') return deps.getOpenCodeReady;
    return true;
  };
  const detectAll = dep('detectAll', detectAllHarnesses);
  const detectOne = dep('detectOne', detectHarness);
  const buildOpenCodeUrl = dep('buildOpenCodeUrl', null);
  const getOpenCodeAuthHeaders = dep('getOpenCodeAuthHeaders', () => ({}));
  const openCodeDeps = { buildOpenCodeUrl, getOpenCodeAuthHeaders };
  const resolveOpenCodeCommand = createOpenCodeCommandResolver(openCodeDeps);
  const resolveOpenCodeAgents = createOpenCodeAgentResolver(openCodeDeps);
  const router = deps.router || createHarnessRouter({
    getBroadcast,
    ...(resolveOpenCodeCommand ? { resolveOpenCodeCommand } : {}),
    ...(resolveOpenCodeAgents ? { resolveOpenCodeAgents } : {}),
  });

  if (deps.initBindings !== false) {
    initSessionBindings(deps.sessionBindings);
  }

  const json = express.json({ limit: '50mb' });

  /** Wraps a handler so thrown coded errors become the shared JSON error response. */
  const respond = (handler, status = 200) => async (req, res) => {
    try {
      res.status(status).json(await handler(req));
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('[harness]', error?.code || 'HARNESS_ERROR', error?.message || error);
      }
      res.status(statusCode).json({
        error: error?.message || 'Harness request failed',
        code: error?.code || 'HARNESS_ERROR',
        ...(error?.status ? { status: error.status } : {}),
      });
    }
  };

  if (buildOpenCodeUrl) {
    const getFromOpenCode = async (path, query) => {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value));
      const search = params.toString();
      const base = buildOpenCodeUrl(path, '');
      const response = await fetch(search ? `${base}?${search}` : base, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return response.json().catch(() => null);
    };

    app.get('/api/session/status', async (req, res, next) => {
      try {
        const directory = queryString(req, 'directory');
        const statuses = await getFromOpenCode('/session/status', { directory });
        if (statuses === null) return next();
        res.json(mergeHarnessActiveIntoSessionStatuses(statuses, directory));
      } catch {
        next();
      }
    });

    app.get('/api/session/:sessionId/message', async (req, res, next) => {
      try {
        const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
        if (!sessionId) return next();
        const messages = await getFromOpenCode(
          `/session/${encodeURIComponent(sessionId)}/message`,
          { directory: queryString(req, 'directory'), limit: queryString(req, 'limit') },
        );
        if (messages === null) {
          // Upstream failure must not clear the session: serve live harness state when we have it.
          const harnessOnly = mergeHarnessMessagesIntoSessionMessages([], sessionId);
          if (harnessOnly.length === 0) return next();
          res.json(harnessOnly);
          return;
        }
        res.json(mergeHarnessMessagesIntoSessionMessages(messages, sessionId));
      } catch {
        next();
      }
    });
  }

  app.get('/api/harness', respond(async () => ({
    catalogs: await detectAll({ openCodeReady: getOpenCodeReady() }),
  })));

  app.get('/api/harness/sessions/:sessionId', respond((req) => {
    const binding = getSessionBinding(req.params.sessionId);
    if (!binding) throw httpError(404, 'BINDING_NOT_FOUND', 'Session binding not found');
    return { binding };
  }));

  app.get('/api/harness/sessions/:sessionId/capabilities', respond((req) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!sessionId) throw httpError(400, 'PROMPT_INVALID', 'sessionId is required');
    return {
      sessionId,
      harnessId: getSessionBinding(sessionId)?.harnessId || 'claude-code',
      capabilities: getOrCreateSessionCapabilities(sessionId),
    };
  }));

  app.get('/api/harness/claude-code/agents', respond((req) => (
    dep('listClaudeAgents', listClaudeAgents)({ directory: queryString(req, 'directory') })
  )));

  app.get('/api/harness/claude-code/import/candidates', respond(() => (
    dep('listClaudeImportCandidates', listClaudeImportCandidates)()
  )));

  const createSession = dep('createOpenCodeSession', createOpenCodeSessionFactory(openCodeDeps));
  app.post('/api/harness/claude-code/import', json, respond((req) => {
    const sessions = req.body?.sessions;
    if (!Array.isArray(sessions)) throw httpError(400, 'IMPORT_INVALID', 'sessions array is required');
    return dep('importClaudeSessions', importClaudeSessions)({ sessions, createSession });
  }));

  const handleDetectOne = respond(async (req) => {
    const id = req.params.id;
    const catalog = isKnownHarnessId(id)
      ? await detectOne(id, { openCodeReady: getOpenCodeReady() })
      : null;
    if (!catalog) throw httpError(404, 'HARNESS_NOT_FOUND', 'Unknown harness');
    return catalog;
  });

  app.get('/api/harness/:id', handleDetectOne);
  app.post('/api/harness/:id/detect', handleDetectOne);

  app.post('/api/harness/prompt', json, respond((req) => router.prompt(req.body || {}), 202));
  app.post('/api/harness/abort', json, respond((req) => router.abort(req.body || {})));

  const replies = [
    ['permission', 'replyPermission', 'Permission', 'PERMISSION'],
    ['question', 'replyQuestion', 'Question', 'QUESTION'],
  ];
  for (const [path, method, label, code] of replies) {
    app.post(`/api/harness/${path}/reply`, json, respond((req) => {
      if (typeof router[method] !== 'function') {
        throw httpError(503, `${code}_UNAVAILABLE`, `${label} reply is unavailable`);
      }
      return router[method](req.body || {});
    }));
  }
}
